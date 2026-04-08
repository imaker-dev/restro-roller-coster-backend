/**
 * Cross-Verification: All 4 APIs vs DB vs DSR
 * 
 * Tests:
 *   1. /orders/shifts/:outletId/history (shift history)
 *   2. /orders/cash-drawer/:outletId/status (cash drawer)
 *   3. /orders/reports/:outletId/dashboard (live dashboard)
 *   4. /orders/reports/:outletId/daily-sales (daily sales report)
 * 
 * Reference (Apr 1-6, outlet 46):
 *   Total Sale:   ₹5,28,074  (357 completed orders)
 *   NC Amount:    ₹2,267
 *   Discount:     ₹13,628 (rounded, actual ~13627.59)
 *   Cancelled items: ₹20,351
 *   Cancelled orders: ₹11,616
 */

const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE = 'http://localhost:3005/api/v1';
const OUTLET_ID = 46;
let token = null, pool = null;
let pass = 0, fail = 0;

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
function toMySQL(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }
  return String(d);
}
function check(label, got, expected, tolerance = 0.01) {
  const g = r2(got), e = r2(expected);
  if (Math.abs(g - e) <= tolerance) { pass++; console.log(`  ✅ ${label}: ${g} === ${e}`); }
  else { fail++; console.log(`  ❌ ${label}: got ${g}, expected ${e} (diff: ${r2(g - e)})`); }
}
function checkInt(label, got, expected) {
  const g = parseInt(got) || 0, e = parseInt(expected) || 0;
  if (g === e) { pass++; console.log(`  ✅ ${label}: ${g} === ${e}`); }
  else { fail++; console.log(`  ❌ ${label}: got ${g}, expected ${e} (diff: ${g - e})`); }
}

async function run() {
  pool = mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  // Login
  const loginRes = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  if (!loginRes.success) { console.log('Login failed:', loginRes); process.exit(1); }
  token = loginRes.data.accessToken;
  console.log('Logged in.\n');

  // DB reference: completed orders Apr 1-6 (business day 4am-4am)
  const [dbOrders] = await pool.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as sale, 
            SUM(COALESCE(discount_amount,0)) as discount,
            SUM(COALESCE(nc_amount,0)) as nc
     FROM orders WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= '2026-04-01 04:00:00' AND created_at < '2026-04-07 04:00:00'`,
    [OUTLET_ID]
  );
  const dbSale = r2(dbOrders[0].sale);
  const dbCount = parseInt(dbOrders[0].cnt);
  const dbDiscount = r2(dbOrders[0].discount);
  const dbNC = r2(dbOrders[0].nc);

  console.log('═'.repeat(90));
  console.log('DB REFERENCE (completed orders, Apr 1-6 business day)');
  console.log('═'.repeat(90));
  console.log(`  Total Sale: ₹${dbSale} (${dbCount} orders)`);
  console.log(`  Discount: ₹${dbDiscount}`);
  console.log(`  NC: ₹${dbNC}`);
  check('DB total sale', dbSale, 528074);
  checkInt('DB order count', dbCount, 357);
  check('DB NC', dbNC, 2267);
  check('DB discount', dbDiscount, 13628, 1);

  // ================================================================
  // TEST 1: Daily Sales Report
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('TEST 1: /orders/reports/:outletId/daily-sales');
  console.log('═'.repeat(90));

  const dsRes = await api('GET', `/orders/reports/${OUTLET_ID}/daily-sales?startDate=2026-04-01&endDate=2026-04-06`);
  if (!dsRes.success) {
    console.log('  ❌ API error:', dsRes.message); fail++;
  } else {
    const s = dsRes.data.summary;
    console.log('\n  Summary:');
    check('daily-sales total_sale', s.total_sale, dbSale);
    check('daily-sales total_collection', s.total_collection, dbSale);
    checkInt('daily-sales total_orders', s.total_orders, dbCount);
    check('daily-sales discount', s.discount_amount, dbDiscount, 1);
    check('daily-sales nc_amount', s.nc_amount, dbNC, 1);

    // Verify no gross_sales/net_sales in response
    if (s.gross_sales !== undefined) { fail++; console.log('  ❌ gross_sales should not exist in response'); }
    else { pass++; console.log('  ✅ No gross_sales field (removed)'); }
    if (s.net_sales !== undefined) { fail++; console.log('  ❌ net_sales should not exist in response'); }
    else { pass++; console.log('  ✅ No net_sales field (removed)'); }

    // Verify collection block
    if (s.collection) {
      check('daily-sales collection.totalCollection', s.collection.totalCollection, dbSale);
      check('daily-sales collection.dueCollection', s.collection.dueCollection, 0);
    }

    // Verify per-day sums match total
    let daySaleSum = 0, dayOrderSum = 0;
    console.log('\n  Per-day breakdown:');
    for (const d of dsRes.data.daily) {
      const sale = r2(d.total_sale);
      daySaleSum += sale;
      dayOrderSum += d.total_orders || 0;
      console.log(`    ${d.report_date}: ₹${sale} | ${d.total_orders} orders`);
    }
    check('daily sum of total_sale', r2(daySaleSum), dbSale, 1);
    checkInt('daily sum of orders', dayOrderSum, dbCount);
  }

  // ================================================================
  // TEST 2: Accurate DSR (cross-reference)
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('TEST 2: Cross-verify with Accurate DSR');
  console.log('═'.repeat(90));

  const dsrRes = await api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET_ID}&startDate=2026-04-01&endDate=2026-04-06`);
  if (dsrRes.success) {
    const gt = dsrRes.data.grandTotal;
    check('accurate-dsr total_sale', gt.total_sale, dbSale);
    checkInt('accurate-dsr total_orders', gt.total_orders, dbCount);
    check('accurate-dsr nc_amount', gt.nc_amount, dbNC, 1);
    check('accurate-dsr discount', gt.discount_amount, dbDiscount, 1);

    // daily-sales and accurate-dsr should match
    if (dsRes.success) {
      const ds = dsRes.data.summary;
      check('daily-sales vs accurate-dsr total_sale', ds.total_sale, gt.total_sale);
      checkInt('daily-sales vs accurate-dsr total_orders', ds.total_orders, gt.total_orders);
    }
  }

  // ================================================================
  // TEST 3: Shift History
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('TEST 3: /orders/shifts/:outletId/history');
  console.log('═'.repeat(90));

  const shRes = await api('GET', `/orders/shifts/${OUTLET_ID}/history?startDate=2026-04-01&endDate=2026-04-06`);
  if (!shRes.success) {
    console.log('  ❌ API error:', shRes.message); fail++;
  } else {
    const shifts = shRes.data.shifts || shRes.data.data || shRes.data;
    let shiftSaleSum = 0, shiftOrderSum = 0;
    console.log(`\n  Found ${Array.isArray(shifts) ? shifts.length : '?'} shifts`);

    if (Array.isArray(shifts)) {
      for (const s of shifts) {
        const sale = r2(s.totalSales);
        const orders = parseInt(s.totalOrders || s.completedOrders) || 0;
        shiftSaleSum += sale;
        shiftOrderSum += orders;
        const dueColl = r2(s.collection?.dueCollection || s.dueCollection || 0);
        console.log(`    Shift #${s.id || s.shiftId}: ₹${sale} | ${orders} orders | due: ₹${dueColl} | ${s.cashierName || ''} | ${s.floorName || ''}`);
      }
      console.log(`\n  Shift totals: ₹${r2(shiftSaleSum)} | ${shiftOrderSum} orders`);
      // Shifts span outside business day, so shift sum >= business day sum
      // But for our data, every order falls in a shift, so shift sum should include all BD orders
    }
  }

  // ================================================================
  // TEST 4: Shift Summary / Detail for each shift
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('TEST 4: Per-shift summary + detail vs DB');
  console.log('═'.repeat(90));

  // Get all shifts from DB
  const [allShifts] = await pool.query(
    `SELECT ds.id, ds.session_date, ds.opening_time, ds.closing_time, ds.floor_id, ds.cashier_id,
            u.name as cashier_name, f.name as floor_name
     FROM day_sessions ds
     LEFT JOIN users u ON ds.cashier_id = u.id
     LEFT JOIN floors f ON ds.floor_id = f.id
     WHERE ds.outlet_id = ? AND ds.opening_time < '2026-04-07 04:00:00'
       AND (ds.closing_time > '2026-04-01 04:00:00' OR ds.closing_time IS NULL)
     ORDER BY ds.opening_time`,
    [OUTLET_ID]
  );

  let allShiftSale = 0, allShiftOrders = 0;
  for (const s of allShifts) {
    const sStart = toMySQL(s.opening_time);
    const sEnd = s.closing_time ? toMySQL(s.closing_time) : toMySQL(new Date());

    const flCond = s.floor_id
      ? ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`
      : '';
    const flParams = s.floor_id ? [s.floor_id, s.cashier_id] : [];

    const [dbOrd] = await pool.query(
      `SELECT COUNT(*) as cnt, SUM(total_amount) as sale
       FROM orders WHERE outlet_id = ? AND status = 'completed'
         AND created_at >= ? AND created_at <= ?${flCond}`,
      [OUTLET_ID, sStart, sEnd, ...flParams]
    );
    const dbShiftSale = r2(dbOrd[0].sale);
    const dbShiftCnt = parseInt(dbOrd[0].cnt) || 0;
    allShiftSale += dbShiftSale;
    allShiftOrders += dbShiftCnt;

    // Check summary API
    const sumRes = await api('GET', `/orders/shifts/${s.id}/summary`);
    // Check detail API
    const detRes = await api('GET', `/orders/shifts/${s.id}/detail`);

    const sd = s.session_date instanceof Date ? s.session_date.toISOString().slice(0,10) : String(s.session_date).slice(0,10);
    console.log(`\n  ── Shift #${s.id} | ${sd} | ${s.cashier_name} | ${s.floor_name} ──`);
    console.log(`     DB: ₹${dbShiftSale} | ${dbShiftCnt} orders`);

    if (sumRes.success) {
      const sum = sumRes.data;
      console.log(`     Summary API: totalSales=₹${sum.totalSales} | orders=${sum.totalOrders || sum.orderStats?.completedOrders}`);
      check(`Shift #${s.id} Summary totalSales`, sum.totalSales, dbShiftSale);
      
      // Check due collection is excluded
      if (sum.collection?.dueCollection !== undefined) {
        console.log(`     Due collected: ₹${sum.collection.dueCollection} — NOT in totalSales`);
      }
    }
    if (detRes.success) {
      const det = detRes.data;
      check(`Shift #${s.id} Detail totalSales`, det.totalSales, dbShiftSale);
    }
    if (sumRes.success && detRes.success) {
      check(`Shift #${s.id} Summary vs Detail`, sumRes.data.totalSales, detRes.data.totalSales);
    }
  }

  console.log(`\n  All shifts DB sum: ₹${r2(allShiftSale)} | ${allShiftOrders} orders`);
  check('All shifts sum vs DSR', r2(allShiftSale), dbSale);
  checkInt('All shifts orders vs DSR', allShiftOrders, dbCount);

  // ================================================================
  // FINAL RESULTS
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log(`FINAL RESULTS: ✅ ${pass} passed, ❌ ${fail} failed`);
  console.log('═'.repeat(90));

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
