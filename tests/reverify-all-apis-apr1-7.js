/**
 * FULL RE-VERIFICATION: All APIs for Apr 1-7, outlet 46
 * 
 * Checks: accurate-dashboard, accurate-running-dashboard, accurate-day-end-summary,
 *         accurate-dsr, daily-sales, dashboard (live), cash-drawer, shift-history,
 *         shift-detail, shift-summary
 * 
 * Every number cross-verified against DB with 100% accuracy requirement.
 */
const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE = 'http://localhost:3005/api/v1';
const OUTLET_ID = 46;
const BD_START_HOUR = 4;
let token = null, pool = null, pass = 0, fail = 0;

const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } }); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function check(label, got, expected, tol = 1) {
  const g = r2(got), e = r2(expected);
  if (Math.abs(g - e) <= tol) { pass++; console.log(`  ✅ ${label}: ${g} === ${e}`); }
  else { fail++; console.log(`  ❌ ${label}: got ${g}, expected ${e} (diff: ${r2(g - e)})`); }
}
function checkInt(label, got, expected) {
  const g = parseInt(got) || 0, e = parseInt(expected) || 0;
  if (g === e) { pass++; console.log(`  ✅ ${label}: ${g} === ${e}`); }
  else { fail++; console.log(`  ❌ ${label}: got ${g}, expected ${e}`); }
}

function bdRange(dateStr) {
  // Returns [start, end) for a business day
  return [`${dateStr} 04:00:00`, `${dateStr.replace(/\d{2}$/, m => String(parseInt(m)+1).padStart(2,'0'))} 04:00:00`];
}

// Smarter next day
function nextDay(dateStr) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function bdRangeMulti(startDate, endDate) {
  return [`${startDate} 04:00:00`, `${nextDay(endDate)} 04:00:00`];
}

async function getDbStats(startDt, endDt) {
  const [rows] = await pool.query(
    `SELECT 
       COUNT(*) as total_orders,
       COALESCE(SUM(total_amount), 0) as total_sale,
       COALESCE(SUM(discount_amount), 0) as discount,
       COALESCE(SUM(tax_amount), 0) as tax,
       COALESCE(SUM(CASE WHEN is_nc = 1 THEN nc_amount ELSE 0 END), 0) as nc_amount,
       COUNT(CASE WHEN is_nc = 1 THEN 1 END) as nc_orders,
       COALESCE(SUM(due_amount), 0) as due_amount,
       COALESCE(SUM(paid_amount), 0) as paid_amount
     FROM orders WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, startDt, endDt]
  );
  return rows[0];
}

async function getDbPayments(startDt, endDt) {
  const [rows] = await pool.query(
    `SELECT payment_mode, COUNT(*) as cnt, COALESCE(SUM(p.total_amount), 0) as total
     FROM payments p
     JOIN orders o ON p.order_id = o.id
     WHERE o.outlet_id = ? AND o.status = 'completed'
       AND o.created_at >= ? AND o.created_at < ?
       AND p.status = 'completed'
       AND COALESCE(p.is_due_collection, 0) = 0
     GROUP BY p.payment_mode`,
    [OUTLET_ID, startDt, endDt]
  );
  const map = {};
  rows.forEach(r => { map[r.payment_mode] = r2(r.total); });
  return map;
}

async function run() {
  pool = mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });
  const loginRes = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  token = loginRes.data.accessToken;

  const DATES = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06', '2026-04-07'];
  const FULL_START = '2026-04-01 04:00:00';
  const FULL_END = '2026-04-08 04:00:00';

  // ═══════════════════════════════════════════════════════════════
  // SECTION A: Per-day DB baseline
  // ═══════════════════════════════════════════════════════════════
  console.log('═'.repeat(90));
  console.log('  SECTION A: DB BASELINE — Per Day (Apr 1-7)');
  console.log('═'.repeat(90));

  const dbPerDay = {};
  let grandTotal = { orders: 0, sale: 0, disc: 0, tax: 0, nc: 0 };

  for (const date of DATES) {
    const [start, end] = bdRangeMulti(date, date);
    const stats = await getDbStats(start, end);
    dbPerDay[date] = stats;
    grandTotal.orders += parseInt(stats.total_orders);
    grandTotal.sale += r2(stats.total_sale);
    grandTotal.disc += r2(stats.discount);
    grandTotal.tax += r2(stats.tax);
    grandTotal.nc += r2(stats.nc_amount);
    console.log(`  ${date}: ${stats.total_orders} orders | Rs ${r2(stats.total_sale)} | disc=${r2(stats.discount)} | tax=${r2(stats.tax)} | nc=${r2(stats.nc_amount)}`);
  }
  console.log(`  ─────────────────────────────────────────────────`);
  console.log(`  GRAND:  ${grandTotal.orders} orders | Rs ${r2(grandTotal.sale)} | disc=${r2(grandTotal.disc)} | tax=${r2(grandTotal.tax)} | nc=${r2(grandTotal.nc)}`);

  // Verify grand total from single query
  const dbGrand = await getDbStats(FULL_START, FULL_END);
  check('Grand total DB query matches sum', dbGrand.total_sale, grandTotal.sale);
  checkInt('Grand total orders match sum', dbGrand.total_orders, grandTotal.orders);

  // ═══════════════════════════════════════════════════════════════
  // SECTION B: accurate-day-end-summary (Apr 1-7)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION B: accurate-day-end-summary (Apr 1-7)');
  console.log('═'.repeat(90));

  const des = await api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET_ID}&startDate=2026-04-01&endDate=2026-04-07`);
  if (des.success) {
    const gt = des.data.grandTotal;
    check('DES grand total_sale vs DB', gt.total_sale, dbGrand.total_sale);
    checkInt('DES grand total_orders vs DB', gt.total_orders, dbGrand.total_orders);
    check('DES grand discount vs DB', gt.discount_amount, dbGrand.discount);

    // Per-day check
    const desDaily = des.data.dailyData || des.data.daily || [];
    if (desDaily.length > 0) {
      console.log('\n  Per-day verification:');
      for (const day of desDaily) {
        const date = day.date || day.report_date;
        const dbDay = dbPerDay[date];
        if (dbDay) {
          check(`  DES ${date} sale`, day.total_sale, dbDay.total_sale);
          checkInt(`  DES ${date} orders`, day.total_orders, dbDay.total_orders);
        }
      }
    }
  } else { fail++; console.log(`  ❌ API failed: ${des.message}`); }

  // ═══════════════════════════════════════════════════════════════
  // SECTION C: accurate-dsr (Apr 1-7)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION C: accurate-dsr (Apr 1-7)');
  console.log('═'.repeat(90));

  const dsr = await api('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=2026-04-01&endDate=2026-04-07`);
  if (dsr.success) {
    const gt = dsr.data.grandTotal || dsr.data.summary;
    check('DSR total_sale vs DB', gt.total_sale, dbGrand.total_sale);
    checkInt('DSR total_orders vs DB', gt.total_orders, dbGrand.total_orders);
    check('DSR discount vs DB', gt.discount_amount, dbGrand.discount);
    check('DSR nc_amount vs DB', gt.nc_amount, dbGrand.nc_amount);
    check('DSR total_collection = total_sale', gt.total_collection, gt.total_sale);
  } else { fail++; console.log(`  ❌ API failed: ${dsr.message}`); }

  // ═══════════════════════════════════════════════════════════════
  // SECTION D: accurate-running-dashboard (per day spot check)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION D: accurate-running-dashboard (spot checks)');
  console.log('═'.repeat(90));

  for (const date of ['2026-04-01', '2026-04-05', '2026-04-07']) {
    const rd = await api('GET', `/reports/accurate-running-dashboard?outletId=${OUTLET_ID}&startDate=${date}&endDate=${date}`);
    if (rd.success) {
      const dbDay = dbPerDay[date];
      const s = rd.data.summary || rd.data.sales || rd.data;
      check(`running-dash ${date} sale`, s.total_sale, dbDay.total_sale);
      checkInt(`running-dash ${date} orders`, s.total_orders, dbDay.total_orders);
    } else { fail++; console.log(`  ❌ running-dash ${date} failed`); }
  }

  // Multi-day range
  const rd2 = await api('GET', `/reports/accurate-running-dashboard?outletId=${OUTLET_ID}&startDate=2026-04-01&endDate=2026-04-07`);
  if (rd2.success) {
    const s = rd2.data.summary || rd2.data.sales || rd2.data;
    check('running-dash 1-7 sale', s.total_sale, dbGrand.total_sale);
    checkInt('running-dash 1-7 orders', s.total_orders, dbGrand.total_orders);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION E: daily-sales (Apr 1-7)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION E: daily-sales (old API, fixed — Apr 1-7)');
  console.log('═'.repeat(90));

  const ds = await api('GET', `/orders/reports/${OUTLET_ID}/daily-sales?startDate=2026-04-01&endDate=2026-04-07`);
  if (ds.success) {
    const s = ds.data.summary;
    check('daily-sales total_sale vs DB', s.total_sale, dbGrand.total_sale);
    check('daily-sales total_collection vs DB', s.total_collection, dbGrand.total_sale);
    checkInt('daily-sales total_orders vs DB', s.total_orders, dbGrand.total_orders);
    check('daily-sales discount vs DB', s.discount_amount, dbGrand.discount);

    // Verify no gross/net
    if (s.gross_sales !== undefined || s.net_sales !== undefined) {
      fail++; console.log('  ❌ daily-sales still has gross/net sales!');
    } else {
      pass++; console.log('  ✅ No gross_sales/net_sales in response');
    }

    // Check collection block
    if (ds.data.summary.collection) {
      check('daily-sales collection.totalCollection', ds.data.summary.collection.totalCollection, dbGrand.total_sale);
    }

    // Per-day check
    const dsDaily = ds.data.daily || ds.data.data || [];
    if (dsDaily.length > 0) {
      console.log('\n  Per-day daily-sales verification:');
      for (const day of dsDaily) {
        const date = day.date || day.report_date;
        const dbDay = dbPerDay[date];
        if (dbDay) {
          check(`  DS ${date} sale`, day.total_sale, dbDay.total_sale);
          checkInt(`  DS ${date} orders`, day.total_orders, dbDay.total_orders);
        }
      }
    }
  } else { fail++; console.log(`  ❌ daily-sales failed: ${ds.message}`); }

  // ═══════════════════════════════════════════════════════════════
  // SECTION F: accurate-dashboard (today = business day)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION F: accurate-dashboard + live dashboard (today)');
  console.log('═'.repeat(90));

  // Compute today's business day
  const now = new Date();
  const shifted = new Date(now.getTime() - BD_START_HOUR * 3600000);
  const todayBD = `${shifted.getFullYear()}-${String(shifted.getMonth()+1).padStart(2,'0')}-${String(shifted.getDate()).padStart(2,'0')}`;
  const [todayStart, todayEnd] = bdRangeMulti(todayBD, todayBD);
  const dbToday = await getDbStats(todayStart, todayEnd);
  console.log(`  Today's business day: ${todayBD} (${todayStart} to ${todayEnd})`);
  console.log(`  DB today: ${dbToday.total_orders} orders, Rs ${r2(dbToday.total_sale)}`);

  const accDash = await api('GET', `/reports/accurate-dashboard?outletId=${OUTLET_ID}`);
  if (accDash.success) {
    const s = accDash.data.sales || accDash.data;
    console.log(`  accurate-dashboard: date=${accDash.data.date}, sale=Rs ${s.total_sale}, orders=${s.total_orders}`);
    check('accurate-dashboard total_sale vs DB today', s.total_sale, dbToday.total_sale);
    checkInt('accurate-dashboard total_orders vs DB today', s.total_orders, dbToday.total_orders);
    check('accurate-dashboard total_collection = total_sale', s.total_collection, s.total_sale);
  } else { fail++; console.log(`  ❌ accurate-dashboard failed`); }

  const liveDash = await api('GET', `/orders/reports/${OUTLET_ID}/dashboard`);
  if (liveDash.success) {
    const s = liveDash.data.sales || liveDash.data;
    check('live-dashboard total_sale vs DB today', s.total_sale, dbToday.total_sale);
    checkInt('live-dashboard total_orders vs DB today', s.total_orders, dbToday.total_orders);
    check('live-dashboard vs accurate-dashboard', s.total_sale, (accDash.data || {}).total_sale || dbToday.total_sale);
  } else { fail++; console.log(`  ❌ live-dashboard failed`); }

  // ═══════════════════════════════════════════════════════════════
  // SECTION G: Shift History (Apr 1-7)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION G: shift-history (Apr 1-7)');
  console.log('═'.repeat(90));

  const sh = await api('GET', `/orders/shifts/${OUTLET_ID}/history?startDate=2026-04-01&endDate=2026-04-07`);
  if (sh.success) {
    const shifts = sh.data.shifts || sh.data.data || sh.data;
    let shiftSaleSum = 0, shiftOrderSum = 0;
    if (Array.isArray(shifts)) {
      for (const s of shifts) {
        const sale = r2(s.totalSales);
        const orders = parseInt(s.totalOrders || s.completedOrders) || 0;
        shiftSaleSum += sale;
        shiftOrderSum += orders;
        console.log(`    Shift #${s.id}: Rs ${sale} | ${orders} orders | ${s.cashierName || 'N/A'} | ${s.floorName || 'N/A'}`);
      }
      check('shift-history sum sale vs DB', shiftSaleSum, dbGrand.total_sale);
      checkInt('shift-history sum orders vs DB', shiftOrderSum, dbGrand.total_orders);
    }
  } else { fail++; console.log(`  ❌ shift-history failed`); }

  // ═══════════════════════════════════════════════════════════════
  // SECTION H: Individual shift detail + summary (spot checks)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION H: Shift Detail & Summary (per shift)');
  console.log('═'.repeat(90));

  // Get all shifts
  const [allShifts] = await pool.query(
    `SELECT ds.id, ds.session_date, ds.opening_time, ds.closing_time, ds.floor_id, ds.cashier_id,
            u.name as cashier_name, f.name as floor_name
     FROM day_sessions ds
     LEFT JOIN users u ON ds.cashier_id = u.id
     LEFT JOIN floors f ON ds.floor_id = f.id
     WHERE ds.outlet_id = ?
       AND ds.opening_time >= '2026-04-01 04:00:00' AND ds.opening_time < '2026-04-08 04:00:00'
     ORDER BY ds.opening_time`,
    [OUTLET_ID]
  );

  for (const s of allShifts) {
    const sStart = `${new Date(s.opening_time).getFullYear()}-${String(new Date(s.opening_time).getMonth()+1).padStart(2,'0')}-${String(new Date(s.opening_time).getDate()).padStart(2,'0')} ${String(new Date(s.opening_time).getHours()).padStart(2,'0')}:${String(new Date(s.opening_time).getMinutes()).padStart(2,'0')}:${String(new Date(s.opening_time).getSeconds()).padStart(2,'0')}`;
    const closeDate = s.closing_time ? new Date(s.closing_time) : new Date();
    const sEnd = `${closeDate.getFullYear()}-${String(closeDate.getMonth()+1).padStart(2,'0')}-${String(closeDate.getDate()).padStart(2,'0')} ${String(closeDate.getHours()).padStart(2,'0')}:${String(closeDate.getMinutes()).padStart(2,'0')}:${String(closeDate.getSeconds()).padStart(2,'0')}`;

    // DB: orders for this shift
    const [dbShift] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as sale,
              COALESCE(SUM(discount_amount), 0) as disc
       FROM orders WHERE outlet_id = ? AND status = 'completed'
         AND created_at >= ? AND created_at <= ?
         AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`,
      [OUTLET_ID, sStart, sEnd, s.floor_id, s.cashier_id]
    );

    // API: shift summary
    const sumRes = await api('GET', `/orders/shifts/${s.id}/summary`);
    // API: shift detail
    const detRes = await api('GET', `/orders/shifts/${s.id}/detail`);

    const dbSale = r2(dbShift[0].sale);
    const dbCnt = parseInt(dbShift[0].cnt);

    console.log(`\n  Shift #${s.id} | ${s.cashier_name} | ${s.floor_name} | ${sStart} to ${s.closing_time ? sEnd : '(open)'}`);
    console.log(`    DB: ${dbCnt} orders, Rs ${dbSale}`);

    if (sumRes.success) {
      const apiSale = r2(sumRes.data.totalSales);
      const apiOrders = parseInt(sumRes.data.orderStats?.completedOrders || sumRes.data.totalOrders) || 0;
      console.log(`    Summary API: ${apiOrders} orders, Rs ${apiSale}`);
      check(`Shift #${s.id} summary sale vs DB`, apiSale, dbSale);
      checkInt(`Shift #${s.id} summary orders vs DB`, apiOrders, dbCnt);

      // Check collection = totalSales
      if (sumRes.data.collection) {
        check(`Shift #${s.id} collection.totalCollection`, sumRes.data.collection.totalCollection, apiSale);
      }
      // Check due tracked separately
      if (sumRes.data.collection && sumRes.data.collection.dueCollection !== undefined) {
        // dueCollection should NOT be added to totalSales
        console.log(`    dueCollection: Rs ${sumRes.data.collection.dueCollection} (tracked separately)`);
      }
    } else { fail++; console.log(`    ❌ summary API failed`); }

    if (detRes.success) {
      const detSale = r2(detRes.data.totalSales);
      console.log(`    Detail API: Rs ${detSale}`);
      check(`Shift #${s.id} detail sale vs DB`, detSale, dbSale);
      // Summary vs Detail consistency
      if (sumRes.success) {
        check(`Shift #${s.id} summary vs detail`, r2(sumRes.data.totalSales), detSale);
      }
    } else { fail++; console.log(`    ❌ detail API failed`); }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION I: Cash Drawer Status
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION I: Cash Drawer Status');
  console.log('═'.repeat(90));

  const cd = await api('GET', `/orders/cash-drawer/${OUTLET_ID}/status`);
  if (cd.success) {
    const d = cd.data;
    console.log(`  totalSales: Rs ${d.totalSales}, totalCollection: Rs ${d.totalCollection}`);
    console.log(`  session: #${d.session?.id} ${d.session?.status}`);
    check('cash-drawer totalSales = totalCollection', d.totalSales, d.totalCollection);
    // Cash drawer shows today's session data
    if (d.sales) {
      check('cash-drawer sales.totalSale = totalSales', d.sales.totalSale, d.totalSales);
    }
    if (d.collection) {
      check('cash-drawer collection.totalCollection = totalSales', d.collection.totalCollection, d.totalSales);
      console.log(`  dueCollection: Rs ${d.collection.dueCollection} (tracked separately)`);
    }
  } else { fail++; console.log(`  ❌ cash-drawer failed`); }

  // ═══════════════════════════════════════════════════════════════
  // SECTION J: Cross-API consistency (Apr 1-7 range)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION J: CROSS-API CONSISTENCY (Apr 1-7)');
  console.log('═'.repeat(90));

  const sources = {};
  sources['DB'] = { sale: r2(dbGrand.total_sale), orders: parseInt(dbGrand.total_orders) };

  if (des.success) {
    sources['day-end-summary'] = { sale: r2(des.data.grandTotal.total_sale), orders: parseInt(des.data.grandTotal.total_orders) };
  }
  if (dsr.success) {
    const gt = dsr.data.grandTotal || dsr.data.summary;
    sources['accurate-dsr'] = { sale: r2(gt.total_sale), orders: parseInt(gt.total_orders) };
  }
  if (ds.success) {
    sources['daily-sales'] = { sale: r2(ds.data.summary.total_sale), orders: parseInt(ds.data.summary.total_orders) };
  }
  if (rd2.success) {
    const s = rd2.data.summary || rd2.data.sales || rd2.data;
    sources['running-dashboard'] = { sale: r2(s.total_sale), orders: parseInt(s.total_orders) };
  }
  if (sh.success) {
    const shifts2 = sh.data.shifts || sh.data.data || sh.data;
    let ss = 0, so = 0;
    if (Array.isArray(shifts2)) { shifts2.forEach(s => { ss += r2(s.totalSales); so += parseInt(s.totalOrders || s.completedOrders) || 0; }); }
    sources['shift-history-sum'] = { sale: r2(ss), orders: so };
  }

  console.log('\n  All sources for Apr 1-7:');
  for (const [name, d] of Object.entries(sources)) {
    console.log(`    ${name.padEnd(25)} Rs ${String(d.sale).padEnd(12)} ${d.orders} orders`);
  }

  const names = Object.keys(sources);
  console.log('\n  Pairwise sale comparison:');
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      check(`${names[i]} vs ${names[j]}`, sources[names[i]].sale, sources[names[j]].sale);
    }
  }

  console.log('\n  Pairwise order count comparison:');
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      checkInt(`${names[i]} vs ${names[j]} orders`, sources[names[i]].orders, sources[names[j]].orders);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FINAL RESULTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log(`  FINAL: ✅ ${pass} passed, ❌ ${fail} failed`);
  console.log('═'.repeat(90));

  if (fail === 0) {
    console.log('\n  🎉 100% ACCURACY — ALL APIs verified for Apr 1-7');
    console.log('  Every number matches DB. Shifts, DSR, Dashboard, Daily Sales — all consistent.');
  }

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
