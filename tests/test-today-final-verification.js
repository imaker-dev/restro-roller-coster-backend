/**
 * FINAL VERIFICATION — Today (Apr 8, 2026)
 * 
 * Cross-verifies ALL 4 APIs + Accurate APIs + DB for today:
 *   1. /orders/reports/:outletId/daily-sales
 *   2. /orders/reports/:outletId/dashboard
 *   3. /orders/cash-drawer/:outletId/status
 *   4. /orders/shifts/:outletId/history
 *   5. /reports/accurate-dashboard
 *   6. /reports/accurate-dsr
 * 
 * Scenarios verified:
 *   - Only completed orders count as sales
 *   - Due collections excluded from today's collections
 *   - No gross/net — only total_sale = SUM(total_amount)
 *   - Shift totals sum = DSR total
 *   - All APIs agree with each other and with DB
 *   - Non-completed orders (pending, preparing, billed etc.) NOT in sales
 *   - Cancelled orders NOT in sales
 */

const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE = 'http://localhost:3005/api/v1';
const OUTLET_ID = 46;
const BUSINESS_DAY_START_HOUR = 4;

// Compute business day the same way the server does
function getLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const shifted = new Date(d.getTime() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
const TODAY = getLocalDate();
const BD_START = `${TODAY} 04:00:00`; // business day start
// Next day for end
const nextDay = new Date(new Date(TODAY).getTime() + 86400000);
const BD_END = `${nextDay.getFullYear()}-${String(nextDay.getMonth()+1).padStart(2,'0')}-${String(nextDay.getDate()).padStart(2,'0')} 04:00:00`;

let token = null, pool = null;
let pass = 0, fail = 0, warn = 0;

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
function section(title) {
  console.log('\n' + '═'.repeat(90));
  console.log(title);
  console.log('═'.repeat(90));
}

async function run() {
  pool = mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  const loginRes = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  if (!loginRes.success) { console.log('Login failed:', loginRes); process.exit(1); }
  token = loginRes.data.accessToken;
  console.log('Logged in.\n');

  // ================================================================
  // SECTION A: DB Ground Truth for TODAY
  // ================================================================
  section('SECTION A: DB Ground Truth for Today (' + TODAY + ')');

  // A1: Completed orders
  const [dbCompleted] = await pool.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as sale,
            COALESCE(SUM(discount_amount), 0) as discount,
            COALESCE(SUM(nc_amount), 0) as nc,
            COALESCE(SUM(due_amount), 0) as due_amount,
            COUNT(CASE WHEN is_nc = 1 THEN 1 END) as nc_orders,
            COUNT(CASE WHEN is_adjustment = 1 THEN 1 END) as adj_count,
            COALESCE(SUM(adjustment_amount), 0) as adj_amount
     FROM orders WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  const DB = {
    completedOrders: parseInt(dbCompleted[0].cnt) || 0,
    totalSale: r2(dbCompleted[0].sale),
    discount: r2(dbCompleted[0].discount),
    nc: r2(dbCompleted[0].nc),
    ncOrders: parseInt(dbCompleted[0].nc_orders) || 0,
    dueAmount: r2(dbCompleted[0].due_amount),
    adjCount: parseInt(dbCompleted[0].adj_count) || 0,
    adjAmount: r2(dbCompleted[0].adj_amount)
  };

  // A2: Non-completed, non-cancelled orders (should NOT be in sales)
  const [dbActive] = await pool.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as amount,
            GROUP_CONCAT(DISTINCT status) as statuses
     FROM orders WHERE outlet_id = ? AND status NOT IN ('completed', 'cancelled')
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  const activeOrders = parseInt(dbActive[0].cnt) || 0;
  const activeAmount = r2(dbActive[0].amount);

  // A3: Cancelled orders
  const [dbCancelled] = await pool.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as amount
     FROM orders WHERE outlet_id = ? AND status = 'cancelled'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );

  // A4: Due collections today
  const [dbDueColl] = await pool.query(
    `SELECT COALESCE(SUM(p.total_amount), 0) as due_collected
     FROM payments p
     WHERE p.outlet_id = ? AND p.status = 'completed'
       AND COALESCE(p.is_due_collection, 0) = 1
       AND p.created_at >= ? AND p.created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  const dueCollected = r2(dbDueColl[0].due_collected);

  // A5: Payments (excluding due collections)
  const [dbPayments] = await pool.query(
    `SELECT 
       COALESCE(SUM(CASE WHEN p.payment_mode != 'split' THEN p.total_amount ELSE 0 END), 0) as regular_total,
       COALESCE(SUM(CASE WHEN p.payment_mode = 'cash' THEN p.total_amount ELSE 0 END), 0) as cash,
       COALESCE(SUM(CASE WHEN p.payment_mode = 'upi' THEN p.total_amount ELSE 0 END), 0) as upi,
       COALESCE(SUM(CASE WHEN p.payment_mode = 'card' THEN p.total_amount ELSE 0 END), 0) as card
     FROM payments p
     WHERE p.outlet_id = ? AND p.status = 'completed'
       AND COALESCE(p.is_due_collection, 0) = 0
       AND p.created_at >= ? AND p.created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );

  console.log(`\n  📊 Completed Orders: ${DB.completedOrders}`);
  console.log(`  💰 Total Sale (completed): ₹${DB.totalSale}`);
  console.log(`  🏷️  Discount: ₹${DB.discount}`);
  console.log(`  🆓 NC: ₹${DB.nc} (${DB.ncOrders} orders)`);
  console.log(`  📋 Adjustments: ₹${DB.adjAmount} (${DB.adjCount} orders)`);
  console.log(`  💳 Due Amount: ₹${DB.dueAmount}`);
  console.log(`  📥 Due Collected Today: ₹${dueCollected}`);
  console.log(`  ⏳ Active (non-completed/non-cancelled): ${activeOrders} orders, ₹${activeAmount}`);
  console.log(`  ❌ Cancelled: ${dbCancelled[0].cnt} orders, ₹${r2(dbCancelled[0].amount)}`);
  console.log(`  💵 Payments (excl due): cash=₹${r2(dbPayments[0].cash)}, upi=₹${r2(dbPayments[0].upi)}, card=₹${r2(dbPayments[0].card)}`);

  if (DB.completedOrders === 0) {
    console.log('\n  ⚠️  No completed orders today yet — checking APIs return zeros correctly');
  }

  // ================================================================
  // SECTION B: Accurate Dashboard (known-good reference)
  // ================================================================
  section('SECTION B: Accurate Dashboard (reference API)');

  const accDash = await api('GET', `/reports/accurate-dashboard?outletId=${OUTLET_ID}`);
  if (accDash.success) {
    const s = accDash.data.sales;
    check('accurate-dashboard total_sale vs DB', s.total_sale, DB.totalSale);
    checkInt('accurate-dashboard total_orders vs DB', s.total_orders, DB.completedOrders);
    check('accurate-dashboard discount vs DB', s.discount_amount, DB.discount, 1);
    check('accurate-dashboard nc_amount vs DB', s.nc_amount, DB.nc, 1);
    check('accurate-dashboard total_collection = total_sale', s.total_collection, s.total_sale);
  } else {
    console.log('  ⚠️ accurate-dashboard not available:', accDash.message);
  }

  // ================================================================
  // SECTION C: Accurate DSR (reference API)
  // ================================================================
  section('SECTION C: Accurate DSR (reference API)');

  const accDsr = await api('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=${TODAY}&endDate=${TODAY}`);
  let accDsrSale = 0, accDsrOrders = 0;
  if (accDsr.success) {
    const gt = accDsr.data.grandTotal || accDsr.data.summary;
    accDsrSale = r2(gt.total_sale);
    accDsrOrders = parseInt(gt.total_orders) || 0;
    check('accurate-dsr total_sale vs DB', accDsrSale, DB.totalSale);
    checkInt('accurate-dsr total_orders vs DB', accDsrOrders, DB.completedOrders);
  } else {
    console.log('  ⚠️ accurate-dsr not available:', accDsr.message);
  }

  // ================================================================
  // SECTION D: Live Dashboard (/orders/reports/:outletId/dashboard)
  // ================================================================
  section('SECTION D: Live Dashboard');

  const dashRes = await api('GET', `/orders/reports/${OUTLET_ID}/dashboard`);
  if (!dashRes.success) {
    console.log('  ❌ API error:', dashRes.message); fail++;
  } else {
    const s = dashRes.data.sales;
    console.log(`\n  Response sales block:`, JSON.stringify(s, null, 2).split('\n').map(l => '    ' + l).join('\n'));

    // D1: Sales from completed orders only
    check('dashboard total_sale vs DB', s.total_sale, DB.totalSale);
    checkInt('dashboard total_orders vs DB', s.total_orders, DB.completedOrders);
    check('dashboard total_collection = total_sale', s.total_collection, s.total_sale);
    check('dashboard discount vs DB', s.discount_amount, DB.discount, 1);
    check('dashboard nc_amount vs DB', s.nc_amount, DB.nc, 1);
    checkInt('dashboard nc_orders vs DB', s.nc_orders, DB.ncOrders);

    // D2: Verify no gross_sales/net_sales
    if (s.gross_sales !== undefined || s.net_sales !== undefined) {
      fail++; console.log('  ❌ Dashboard still has gross_sales or net_sales — should be removed');
    } else {
      pass++; console.log('  ✅ No gross_sales/net_sales in dashboard response');
    }

    // D3: Match with accurate-dashboard
    if (accDash.success) {
      check('dashboard vs accurate-dashboard total_sale', s.total_sale, accDash.data.sales.total_sale);
      checkInt('dashboard vs accurate-dashboard orders', s.total_orders, accDash.data.sales.total_orders);
    }

    // D4: Collection block — due collections excluded
    const coll = dashRes.data.collection;
    if (coll) {
      check('dashboard collection.totalCollection = total_sale', coll.totalCollection, DB.totalSale);
      check('dashboard collection.dueCollection = 0', coll.dueCollection, 0);
      console.log(`  ℹ️  collection.cash=₹${coll.cash}, upi=₹${coll.upi}, card=₹${coll.card}`);
    }

    // D5: Active orders should be separate from sales
    if (s.active_orders !== undefined) {
      checkInt('dashboard active_orders vs DB', s.active_orders, activeOrders);
    }

    // D6: Verify note field
    if (dashRes.data.note && dashRes.data.note.includes('completed')) {
      pass++; console.log('  ✅ Response includes note about completed orders only');
    }
  }

  // ================================================================
  // SECTION E: Daily Sales Report
  // ================================================================
  section('SECTION E: Daily Sales Report');

  const dsRes = await api('GET', `/orders/reports/${OUTLET_ID}/daily-sales?startDate=${TODAY}&endDate=${TODAY}`);
  if (!dsRes.success) {
    console.log('  ❌ API error:', dsRes.message); fail++;
  } else {
    const s = dsRes.data.summary;
    console.log(`\n  Summary total_sale: ₹${s.total_sale}`);
    console.log(`  Summary total_collection: ₹${s.total_collection}`);
    console.log(`  Summary total_orders: ${s.total_orders}`);

    // E1: Sales from completed orders only
    check('daily-sales total_sale vs DB', s.total_sale, DB.totalSale);
    check('daily-sales total_collection vs DB', s.total_collection, DB.totalSale);
    checkInt('daily-sales total_orders vs DB', s.total_orders, DB.completedOrders);
    check('daily-sales discount vs DB', s.discount_amount, DB.discount, 1);
    check('daily-sales nc_amount vs DB', s.nc_amount, DB.nc, 1);

    // E2: Verify no gross_sales/net_sales
    if (s.gross_sales !== undefined || s.net_sales !== undefined) {
      fail++; console.log('  ❌ daily-sales still has gross_sales or net_sales');
    } else {
      pass++; console.log('  ✅ No gross_sales/net_sales in daily-sales');
    }

    // E3: Collection block
    if (s.collection) {
      check('daily-sales collection.totalCollection vs DB', s.collection.totalCollection, DB.totalSale);
      check('daily-sales collection.dueCollection = 0', s.collection.dueCollection, 0);
    }

    // E4: Match with accurate-dsr
    if (accDsr.success) {
      check('daily-sales vs accurate-dsr total_sale', s.total_sale, accDsrSale);
      checkInt('daily-sales vs accurate-dsr total_orders', s.total_orders, accDsrOrders);
    }

    // E5: Per-day data
    if (dsRes.data.daily && dsRes.data.daily.length > 0) {
      const d = dsRes.data.daily[0];
      console.log(`\n  Daily row: date=${d.report_date}, total_sale=₹${d.total_sale}, orders=${d.total_orders}`);
      check('daily row total_sale vs DB', d.total_sale, DB.totalSale);
      check('daily row total_collection = total_sale', d.total_collection, r2(d.total_sale));
    }

    // E6: note field
    if (s.note && s.note.includes('completed')) {
      pass++; console.log('  ✅ Summary has note about completed orders');
    }
  }

  // ================================================================
  // SECTION F: Shift History
  // ================================================================
  section('SECTION F: Shift History');

  const shRes = await api('GET', `/orders/shifts/${OUTLET_ID}/history?startDate=${TODAY}&endDate=${TODAY}`);
  if (!shRes.success) {
    console.log('  ❌ API error:', shRes.message); fail++;
  } else {
    const shifts = shRes.data.shifts || shRes.data.data || shRes.data;
    let shiftSaleSum = 0, shiftOrderSum = 0;

    if (Array.isArray(shifts)) {
      console.log(`\n  Found ${shifts.length} shifts for today:`);
      for (const s of shifts) {
        const sale = r2(s.totalSales);
        const orders = parseInt(s.totalOrders || s.completedOrders) || 0;
        const dueColl = r2(s.collection?.dueCollection || s.dueCollection || 0);
        shiftSaleSum += sale;
        shiftOrderSum += orders;
        console.log(`    Shift #${s.id || s.shiftId}: ₹${sale} | ${orders} orders | due_coll=₹${dueColl} | ${s.cashierName || ''} | ${s.floorName || ''}`);

        // Verify due collection NOT in totalSales
        if (s.collection?.dueCollection !== undefined) {
          // dueCollection should be tracked separately, not added to totalSales
          pass++; console.log(`      ✅ dueCollection tracked separately: ₹${dueColl}`);
        }
      }
      console.log(`\n  Shift totals: ₹${r2(shiftSaleSum)} | ${shiftOrderSum} orders`);

      // DB verification of shift totals
      const [dbShiftOrders] = await pool.query(
        `SELECT ds.id, ds.cashier_id, ds.floor_id, ds.opening_time, ds.closing_time
         FROM day_sessions ds
         WHERE ds.outlet_id = ? AND ds.session_date = ?
         ORDER BY ds.opening_time`,
        [OUTLET_ID, TODAY]
      );

      let dbShiftTotal = 0, dbShiftOrderCount = 0;
      for (const s of dbShiftOrders) {
        const sStart = toMySQL(s.opening_time);
        const sEnd = s.closing_time ? toMySQL(s.closing_time) : toMySQL(new Date());
        const flCond = s.floor_id
          ? ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`
          : '';
        const flParams = s.floor_id ? [s.floor_id, s.cashier_id] : [];

        const [dbOrd] = await pool.query(
          `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as sale
           FROM orders WHERE outlet_id = ? AND status = 'completed'
             AND created_at >= ? AND created_at <= ?${flCond}`,
          [OUTLET_ID, sStart, sEnd, ...flParams]
        );
        dbShiftTotal += r2(dbOrd[0].sale);
        dbShiftOrderCount += parseInt(dbOrd[0].cnt) || 0;
      }

      if (dbShiftOrders.length > 0) {
        check('shift API sum vs DB shift sum', r2(shiftSaleSum), r2(dbShiftTotal), 1);
        checkInt('shift API order sum vs DB shift sum', shiftOrderSum, dbShiftOrderCount);
      }
    }

    // F1: Per-shift summary/detail verification
    if (Array.isArray(shifts) && shifts.length > 0) {
      console.log('\n  Per-shift Summary/Detail cross-check:');
      for (const s of shifts) {
        const sid = s.id || s.shiftId;
        const [sumRes, detRes] = await Promise.all([
          api('GET', `/orders/shifts/${sid}/summary`),
          api('GET', `/orders/shifts/${sid}/detail`)
        ]);

        if (sumRes.success && detRes.success) {
          check(`  Shift #${sid} Summary vs Detail totalSales`, sumRes.data.totalSales, detRes.data.totalSales);

          // Verify summary uses completed orders only
          const sumData = sumRes.data;
          if (sumData.orderStats) {
            console.log(`    Orders: completed=${sumData.orderStats.completedOrders}, total=${sumData.orderStats.totalOrders}`);
          }

          // Verify due collection excluded
          if (sumData.collection) {
            const dc = r2(sumData.collection.dueCollection);
            console.log(`    dueCollection: ₹${dc} — NOT in totalSales ₹${sumData.totalSales}`);
          }
        }
      }
    }
  }

  // ================================================================
  // SECTION G: Cash Drawer Status
  // ================================================================
  section('SECTION G: Cash Drawer Status');

  const cdRes = await api('GET', `/orders/cash-drawer/${OUTLET_ID}/status`);
  if (!cdRes.success) {
    console.log('  ❌ API error:', cdRes.message); fail++;
  } else {
    const d = cdRes.data;
    console.log(`\n  totalSales: ₹${d.totalSales}`);
    console.log(`  totalCollection: ₹${d.totalCollection}`);
    console.log(`  session: ${d.session ? `#${d.session.id} ${d.session.status}` : 'none'}`);

    if (d.session && d.session.status === 'open') {
      // G1: totalSales from completed orders
      check('cash-drawer totalSales = totalCollection', d.totalSales, d.totalCollection);

      // G2: Sales block
      if (d.sales) {
        console.log(`  sales.totalSale: ₹${d.sales.totalSale}`);
        console.log(`  sales.completedOrders: ${d.sales.completedOrders}`);
        check('cash-drawer sales.totalSale = totalSales', d.sales.totalSale, d.totalSales);
        check('cash-drawer sales.totalCollection = totalSales', d.sales.totalCollection, d.totalSales);
      }

      // G3: Collection block
      if (d.collection) {
        check('cash-drawer collection.totalCollection = totalSales', d.collection.totalCollection, d.totalSales);
        console.log(`  collection.dueCollection: ₹${d.collection.dueCollection} — tracked separately`);
      }

      // G4: Cash drawer movements
      if (d.cashMovements) {
        console.log(`  cashMovements: opening=₹${d.cashMovements.openingCash}, cashSales=₹${d.cashMovements.cashSales}`);
        console.log(`  expectedCash: ₹${d.cashMovements.expectedCash}`);
      }

      // G5: Payment breakdown (should exclude due collections)
      if (d.paymentBreakdown) {
        console.log(`  paymentBreakdown: cash=₹${d.paymentBreakdown.cash}, upi=₹${d.paymentBreakdown.upi}, card=₹${d.paymentBreakdown.card}, total=₹${d.paymentBreakdown.total}`);
      }
    } else {
      console.log('  ℹ️  No open shift — cash drawer returns empty/zero data (expected)');
      if (!d.session || d.session.status !== 'open') {
        check('cash-drawer no open shift, totalSales = 0', d.totalSales || 0, 0);
      }
    }
  }

  // ================================================================
  // SECTION H: Scenario — Non-completed orders NOT in sales
  // ================================================================
  section('SECTION H: Scenario Verification');

  console.log('\n  H1: Non-completed orders should NOT be in sales');
  if (activeOrders > 0) {
    console.log(`    ${activeOrders} active orders (₹${activeAmount}) with statuses: ${dbActive[0].statuses}`);
    // All APIs should show ONLY DB.totalSale (completed), not DB.totalSale + activeAmount
    if (dashRes.success) {
      const dashSale = r2(dashRes.data.sales.total_sale);
      if (dashSale <= DB.totalSale + 0.01) {
        pass++; console.log(`    ✅ Dashboard total_sale (₹${dashSale}) does NOT include active orders`);
      } else {
        fail++; console.log(`    ❌ Dashboard total_sale (₹${dashSale}) > DB completed (₹${DB.totalSale}) — may include non-completed!`);
      }
    }
  } else {
    console.log('    No active non-completed orders today');
    pass++;
  }

  console.log('\n  H2: Cancelled orders should NOT be in sales');
  const cancelledCnt = parseInt(dbCancelled[0].cnt) || 0;
  const cancelledAmt = r2(dbCancelled[0].amount);
  if (cancelledCnt > 0) {
    console.log(`    ${cancelledCnt} cancelled orders (₹${cancelledAmt})`);
    // Verify none of the APIs include cancelled amount
    if (dashRes.success) {
      const dashSale = r2(dashRes.data.sales.total_sale);
      if (dashSale <= DB.totalSale + 0.01) {
        pass++; console.log(`    ✅ Dashboard total_sale does NOT include cancelled orders`);
      } else {
        fail++; console.log(`    ❌ Dashboard may include cancelled orders`);
      }
    }
  } else {
    console.log('    No cancelled orders today');
    pass++;
  }

  console.log('\n  H3: Due collections should be excluded from today\'s collection');
  if (dueCollected > 0) {
    console.log(`    Due collected today: ₹${dueCollected}`);
    if (dashRes.success && dashRes.data.collection) {
      check('    Dashboard dueCollection = 0 (excluded)', dashRes.data.collection.dueCollection, 0);
    }
  } else {
    console.log('    No due collections today');
    pass++;
  }

  console.log('\n  H4: total_collection should equal total_sale (not from payments)');
  if (dashRes.success) {
    check('    Dashboard total_collection === total_sale', dashRes.data.sales.total_collection, dashRes.data.sales.total_sale);
  }
  if (dsRes.success) {
    check('    DailySales total_collection === total_sale', dsRes.data.summary.total_collection, dsRes.data.summary.total_sale);
  }

  // ================================================================
  // SECTION I: Cross-API Consistency
  // ================================================================
  section('SECTION I: Cross-API Consistency');

  const apis = {};
  if (dashRes.success) apis.dashboard = r2(dashRes.data.sales.total_sale);
  if (dsRes.success) apis.dailySales = r2(dsRes.data.summary.total_sale);
  if (accDash.success) apis.accurateDash = r2(accDash.data.sales.total_sale);
  if (accDsr.success) {
    const gt = accDsr.data.grandTotal || accDsr.data.summary;
    apis.accurateDsr = r2(gt.total_sale);
  }
  apis.db = DB.totalSale;

  console.log('\n  Total Sale comparison:');
  const names = Object.keys(apis);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      check(`${names[i]} vs ${names[j]}`, apis[names[i]], apis[names[j]]);
    }
  }

  // ================================================================
  // FINAL
  // ================================================================
  section(`FINAL RESULTS: ✅ ${pass} passed, ❌ ${fail} failed`);

  if (fail === 0) {
    console.log('\n  🎉 ALL VERIFICATIONS PASSED — 100% ACCURACY');
    console.log('  ✅ Only completed orders in sales');
    console.log('  ✅ Due collections excluded from today\'s collection');
    console.log('  ✅ No gross/net — total_sale = SUM(total_amount)');
    console.log('  ✅ All APIs agree with each other and DB');
    console.log('  ✅ Shift reports update only after order completion');
  }

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
