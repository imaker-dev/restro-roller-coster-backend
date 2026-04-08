/**
 * COMPREHENSIVE TEST: All 4 Accurate Reports must match each other
 * 
 * Tests:
 *   1. accurate-dashboard (today)
 *   2. accurate-running-dashboard (single day & range)
 *   3. accurate-day-end-summary (single day & range)
 *   4. accurate-dsr (single day & range)
 *   5. Cross-check: all 4 must agree on total_sale, total_orders
 *   6. Compare vs old APIs (dashboard, running-dashboard, day-end-summary) — show diff
 *   7. Direct DB verification
 *
 * Run: node tests/test-accurate-reports.js
 */
const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE = 'http://localhost:3005/api/v1';
const OUTLET = 46;
const START_DATE = '2026-04-01';
const END_DATE = '2026-04-06';
const SINGLE_DATE = '2026-04-05'; // a day with decent data

let token = null;
let passed = 0, failed = 0, total = 0;

function r2(n) { return parseFloat((parseFloat(n) || 0).toFixed(2)); }

function record(name, pass, detail) {
  total++;
  if (pass) { passed++; console.log(`  PASS ${name}` + (detail ? ` — ${detail}` : '')); }
  else { failed++; console.log(`  FAIL ${name}` + (detail ? ` — ${detail}` : '')); }
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getDbConnection() {
  return mysql.createConnection({
    host: dbCfg.host, port: dbCfg.port, user: dbCfg.user,
    password: dbCfg.password, database: dbCfg.database
  });
}

async function login() {
  const res = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  token = res.data.accessToken;
  console.log('  Logged in as admin');
}

async function run() {
  console.log('='.repeat(90));
  console.log('  ACCURATE REPORTS — COMPREHENSIVE TEST');
  console.log('  Outlet: ' + OUTLET + ', Range: ' + START_DATE + ' to ' + END_DATE);
  console.log('='.repeat(90));

  await login();
  const c = await getDbConnection();

  // ══════════════════════════════════════════════════════
  // PHASE 1: Direct DB truth
  // ══════════════════════════════════════════════════════
  console.log('\n── PHASE 1: DB GROUND TRUTH ──');

  const [dbOverall] = await c.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as total_sale,
            SUM(COALESCE(discount_amount,0)) as disc, SUM(CASE WHEN is_nc=1 THEN COALESCE(nc_amount,0) ELSE 0 END) as nc,
            SUM(COALESCE(paid_amount,0)) as paid, SUM(COALESCE(due_amount,0)) as due,
            SUM(COALESCE(adjustment_amount,0)) as adj,
            COUNT(CASE WHEN order_type='dine_in' THEN 1 END) as dine_in,
            COUNT(CASE WHEN order_type='takeaway' THEN 1 END) as takeaway,
            COUNT(CASE WHEN order_type='delivery' THEN 1 END) as delivery
     FROM orders WHERE outlet_id=? AND status='completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET, START_DATE + ' 04:00:00', '2026-04-07 04:00:00']
  );
  const db = dbOverall[0];
  console.log(`  DB: ${db.cnt} orders, total_sale=${r2(db.total_sale)}, disc=${r2(db.disc)}, nc=${r2(db.nc)}, paid=${r2(db.paid)}, due=${r2(db.due)}, adj=${r2(db.adj)}`);

  // Per-day DB (CAST to CHAR to avoid JS UTC timezone shift)
  const [dbPerDay] = await c.query(
    `SELECT CAST(DATE(DATE_SUB(created_at, INTERVAL 4 HOUR)) AS CHAR) as bd,
            COUNT(*) as cnt, SUM(total_amount) as total_sale
     FROM orders WHERE outlet_id=? AND status='completed'
       AND created_at >= ? AND created_at < ?
     GROUP BY bd ORDER BY bd`,
    [OUTLET, START_DATE + ' 04:00:00', '2026-04-07 04:00:00']
  );
  const dbPerDayMap = {};
  for (const d of dbPerDay) {
    const dk = String(d.bd).slice(0,10);
    dbPerDayMap[dk] = { cnt: d.cnt, sale: r2(d.total_sale) };
    console.log(`    ${dk}: ${d.cnt} orders, sale=${r2(d.total_sale)}`);
  }

  // ══════════════════════════════════════════════════════
  // PHASE 2: Call all 4 new APIs (range)
  // ══════════════════════════════════════════════════════
  console.log('\n── PHASE 2: CALL ALL ACCURATE APIs (range) ──');

  const dsr = await api('GET', `/reports/accurate-dsr?outletId=${OUTLET}&startDate=${START_DATE}&endDate=${END_DATE}`);
  const runDash = await api('GET', `/reports/accurate-running-dashboard?outletId=${OUTLET}&startDate=${START_DATE}&endDate=${END_DATE}`);
  const dayEnd = await api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET}&startDate=${START_DATE}&endDate=${END_DATE}`);

  const dsrD = dsr.data;
  const rdD = runDash.data;
  const deD = dayEnd.data;

  console.log(`  DSR:           total_sale=${dsrD.summary.total_sale}, orders=${dsrD.summary.total_orders}`);
  console.log(`  RunDashboard:  total_sale=${rdD.summary.total_sale}, orders=${rdD.summary.total_orders}`);
  console.log(`  DayEndSummary: total_sale=${deD.grandTotal.total_sale}, orders=${deD.grandTotal.total_orders}`);

  // ══════════════════════════════════════════════════════
  // PHASE 3: Cross-verify all APIs match DB
  // ══════════════════════════════════════════════════════
  console.log('\n── PHASE 3: ALL APIs vs DB ──');

  record('DSR total_sale = DB total', Math.abs(dsrD.summary.total_sale - r2(db.total_sale)) < 0.01,
    `api=${dsrD.summary.total_sale}, db=${r2(db.total_sale)}`);
  record('DSR total_orders = DB count', dsrD.summary.total_orders === db.cnt,
    `api=${dsrD.summary.total_orders}, db=${db.cnt}`);
  record('RunDash total_sale = DB total', Math.abs(rdD.summary.total_sale - r2(db.total_sale)) < 0.01,
    `api=${rdD.summary.total_sale}, db=${r2(db.total_sale)}`);
  record('RunDash total_orders = DB count', rdD.summary.total_orders === db.cnt,
    `api=${rdD.summary.total_orders}, db=${db.cnt}`);
  record('DayEnd total_sale = DB total', Math.abs(deD.grandTotal.total_sale - r2(db.total_sale)) < 0.01,
    `api=${deD.grandTotal.total_sale}, db=${r2(db.total_sale)}`);
  record('DayEnd total_orders = DB count', deD.grandTotal.total_orders === db.cnt,
    `api=${deD.grandTotal.total_orders}, db=${db.cnt}`);

  // ══════════════════════════════════════════════════════
  // PHASE 4: All 3 APIs match EACH OTHER
  // ══════════════════════════════════════════════════════
  console.log('\n── PHASE 4: APIs MATCH EACH OTHER ──');

  record('DSR.total_sale = RunDash.total_sale', Math.abs(dsrD.summary.total_sale - rdD.summary.total_sale) < 0.01,
    `dsr=${dsrD.summary.total_sale}, rd=${rdD.summary.total_sale}`);
  record('DSR.total_sale = DayEnd.total_sale', Math.abs(dsrD.summary.total_sale - deD.grandTotal.total_sale) < 0.01,
    `dsr=${dsrD.summary.total_sale}, de=${deD.grandTotal.total_sale}`);
  record('DSR.total_orders = RunDash.total_orders', dsrD.summary.total_orders === rdD.summary.total_orders,
    `dsr=${dsrD.summary.total_orders}, rd=${rdD.summary.total_orders}`);
  record('DSR.total_orders = DayEnd.total_orders', dsrD.summary.total_orders === deD.grandTotal.total_orders,
    `dsr=${dsrD.summary.total_orders}, de=${deD.grandTotal.total_orders}`);

  // Discount
  record('DSR.discount = RunDash.discount', Math.abs(dsrD.summary.discount_amount - rdD.summary.discount_amount) < 0.01,
    `dsr=${dsrD.summary.discount_amount}, rd=${rdD.summary.discount_amount}`);
  record('DSR.discount = DayEnd.discount', Math.abs(dsrD.summary.discount_amount - deD.grandTotal.discount_amount) < 0.01,
    `dsr=${dsrD.summary.discount_amount}, de=${deD.grandTotal.discount_amount}`);

  // NC
  record('DSR.nc = RunDash.nc', Math.abs(dsrD.summary.nc_amount - rdD.summary.nc_amount) < 0.01,
    `dsr=${dsrD.summary.nc_amount}, rd=${rdD.summary.nc_amount}`);
  record('DSR.nc = DayEnd.nc', Math.abs(dsrD.summary.nc_amount - deD.grandTotal.nc_amount) < 0.01,
    `dsr=${dsrD.summary.nc_amount}, de=${deD.grandTotal.nc_amount}`);

  // Due
  record('DSR.due = RunDash.due', Math.abs(dsrD.summary.total_due_amount - rdD.summary.total_due_amount) < 0.01,
    `dsr=${dsrD.summary.total_due_amount}, rd=${rdD.summary.total_due_amount}`);
  record('DSR.due = DayEnd.due', Math.abs(dsrD.summary.total_due_amount - deD.grandTotal.due_amount) < 0.01,
    `dsr=${dsrD.summary.total_due_amount}, de=${deD.grandTotal.due_amount}`);

  // Paid
  record('DSR.paid = RunDash.paid', Math.abs(dsrD.summary.total_paid_amount - rdD.summary.total_paid_amount) < 0.01,
    `dsr=${dsrD.summary.total_paid_amount}, rd=${rdD.summary.total_paid_amount}`);
  record('DSR.paid = DayEnd.paid', Math.abs(dsrD.summary.total_paid_amount - deD.grandTotal.paid_amount) < 0.01,
    `dsr=${dsrD.summary.total_paid_amount}, de=${deD.grandTotal.paid_amount}`);

  // Adjustment
  record('DSR.adj = RunDash.adj', Math.abs(dsrD.summary.adjustment_amount - rdD.summary.adjustment_amount) < 0.01,
    `dsr=${dsrD.summary.adjustment_amount}, rd=${rdD.summary.adjustment_amount}`);
  record('DSR.adj = DayEnd.adj', Math.abs(dsrD.summary.adjustment_amount - deD.grandTotal.adjustment_amount) < 0.01,
    `dsr=${dsrD.summary.adjustment_amount}, de=${deD.grandTotal.adjustment_amount}`);

  // total_collection = total_sale
  record('DSR.collection = DSR.total_sale', Math.abs(dsrD.summary.total_collection - dsrD.summary.total_sale) < 0.01);
  record('RunDash.collection = RunDash.total_sale', Math.abs(rdD.summary.total_collection - rdD.summary.total_sale) < 0.01);
  record('DayEnd.collection = DayEnd.total_sale', Math.abs(deD.grandTotal.total_collection - deD.grandTotal.total_sale) < 0.01);

  // Cross-verification flags
  record('DSR crossVerification.match', dsrD.crossVerification.match);
  record('RunDash crossVerification.match', rdD.crossVerification.match);
  record('DayEnd crossVerification.match', deD.crossVerification.match);

  // ══════════════════════════════════════════════════════
  // PHASE 5: Per-day consistency (DayEnd days vs DSR daily vs DB)
  // ══════════════════════════════════════════════════════
  console.log('\n── PHASE 5: PER-DAY CONSISTENCY ──');

  const dsrDailyMap = {};
  for (const d of dsrD.daily) dsrDailyMap[d.date] = d;

  const deDaysMap = {};
  for (const d of deD.days) deDaysMap[d.date] = d;

  // Compare using API dates (both DSR & DayEnd use same date keys)
  const allDates = new Set([...Object.keys(dsrDailyMap), ...Object.keys(deDaysMap)]);
  for (const dk of [...allDates].sort()) {
    const dsrDay = dsrDailyMap[dk];
    const deDay = deDaysMap[dk];
    const dbDay = dbPerDayMap[dk];

    if (dsrDay && deDay) {
      if (dbDay) {
        record(`${dk} DSR=DayEnd=DB sale`, 
          Math.abs(dsrDay.total_sale - dbDay.sale) < 0.01 && Math.abs(deDay.total_sale - dbDay.sale) < 0.01,
          `dsr=${dsrDay.total_sale}, de=${deDay.total_sale}, db=${dbDay.sale}`);
        record(`${dk} DSR=DayEnd=DB orders`,
          dsrDay.total_orders === deDay.total_orders && dsrDay.total_orders === dbDay.cnt,
          `dsr=${dsrDay.total_orders}, de=${deDay.total_orders}, db=${dbDay.cnt}`);
      } else {
        // DSR & DayEnd match each other even if DB date key differs
        record(`${dk} DSR=DayEnd sale`, 
          Math.abs(dsrDay.total_sale - deDay.total_sale) < 0.01,
          `dsr=${dsrDay.total_sale}, de=${deDay.total_sale}`);
        record(`${dk} DSR=DayEnd orders`,
          dsrDay.total_orders === deDay.total_orders,
          `dsr=${dsrDay.total_orders}, de=${deDay.total_orders}`);
      }
    } else {
      record(`${dk} day present in both DSR & DayEnd`, false, `dsr=${!!dsrDay}, de=${!!deDay}`);
    }
  }

  // ══════════════════════════════════════════════════════
  // PHASE 6: Single day test (accurate-dashboard)
  // ══════════════════════════════════════════════════════
  console.log('\n── PHASE 6: SINGLE DAY — ALL APIs + DASHBOARD ──');

  const dashRes = await api('GET', `/reports/accurate-dashboard?outletId=${OUTLET}`);
  const dsrSingle = await api('GET', `/reports/accurate-dsr?outletId=${OUTLET}&startDate=${SINGLE_DATE}&endDate=${SINGLE_DATE}`);
  const rdSingle = await api('GET', `/reports/accurate-running-dashboard?outletId=${OUTLET}&startDate=${SINGLE_DATE}&endDate=${SINGLE_DATE}`);
  const deSingle = await api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET}&startDate=${SINGLE_DATE}&endDate=${SINGLE_DATE}`);

  // DB for single date
  const [dbSingle] = await c.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as total_sale
     FROM orders WHERE outlet_id=? AND status='completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET, SINGLE_DATE + ' 04:00:00', '2026-04-06 04:00:00']
  );
  const dbS = dbSingle[0];

  const dsrS = dsrSingle.data.summary;
  const rdS = rdSingle.data.summary;
  const deS = deSingle.data.grandTotal;

  console.log(`  DB:  ${dbS.cnt} orders, ${r2(dbS.total_sale)}`);
  console.log(`  DSR: ${dsrS.total_orders} orders, ${dsrS.total_sale}`);
  console.log(`  RD:  ${rdS.total_orders} orders, ${rdS.total_sale}`);
  console.log(`  DE:  ${deS.total_orders} orders, ${deS.total_sale}`);

  record(`Single ${SINGLE_DATE}: DSR=DB`, Math.abs(dsrS.total_sale - r2(dbS.total_sale)) < 0.01);
  record(`Single ${SINGLE_DATE}: RD=DB`, Math.abs(rdS.total_sale - r2(dbS.total_sale)) < 0.01);
  record(`Single ${SINGLE_DATE}: DE=DB`, Math.abs(deS.total_sale - r2(dbS.total_sale)) < 0.01);
  record(`Single ${SINGLE_DATE}: DSR=RD=DE`, 
    Math.abs(dsrS.total_sale - rdS.total_sale) < 0.01 && Math.abs(dsrS.total_sale - deS.total_sale) < 0.01);

  // Dashboard is TODAY so we can't compare with SINGLE_DATE, but verify it has correct structure
  if (dashRes.data && dashRes.data.sales) {
    const dashSales = dashRes.data.sales;
    record('Dashboard has total_sale field', dashSales.total_sale !== undefined);
    record('Dashboard total_collection = total_sale', Math.abs(dashSales.total_collection - dashSales.total_sale) < 0.01);
    record('Dashboard has businessDay info', !!dashRes.data.businessDay);
    console.log(`  Dashboard (today ${dashRes.data.date}): ${dashSales.total_orders} orders, sale=${dashSales.total_sale}`);
  }

  // ══════════════════════════════════════════════════════
  // PHASE 7: COMPARE NEW vs OLD APIs — show differences
  // ══════════════════════════════════════════════════════
  console.log('\n── PHASE 7: NEW vs OLD API COMPARISON ──');

  // Old APIs
  const oldDash = await api('GET', `/reports/dashboard?outletId=${OUTLET}`);
  const oldRD = await api('GET', `/reports/running-dashboard?outletId=${OUTLET}&startDate=${START_DATE}&endDate=${END_DATE}`);
  const oldDE = await api('GET', `/reports/day-end-summary?outletId=${OUTLET}&startDate=${START_DATE}&endDate=${END_DATE}`);

  // Old Dashboard
  if (oldDash.data && oldDash.data.sales) {
    const oldS = oldDash.data.sales;
    const newD = dashRes.data.sales;
    console.log(`\n  DASHBOARD (today):`);
    console.log(`    OLD net_sales (sub-disc):    ${r2(oldS.net_sales)}`);
    console.log(`    NEW total_sale (total_amt):  ${newD.total_sale}`);
    console.log(`    DIFFERENCE:                  ${r2(newD.total_sale - r2(oldS.net_sales))}`);
    console.log(`    WHY: Old uses subtotal-discount of non-cancelled. New uses total_amount of completed only.`);
  }

  // Old Running Dashboard
  if (oldRD.data && oldRD.data.summary) {
    const oldS = oldRD.data.summary;
    console.log(`\n  RUNNING DASHBOARD (${START_DATE} to ${END_DATE}):`);
    console.log(`    OLD totalSales (net):   ${oldS.totalSales}`);
    console.log(`    OLD grossSales:         ${oldS.grossSales}`);
    console.log(`    OLD grandTotal:         ${oldS.grandTotal}`);
    console.log(`    NEW total_sale:         ${rdD.summary.total_sale}`);
    console.log(`    DIFF (new - old net):   ${r2(rdD.summary.total_sale - oldS.totalSales)}`);
    console.log(`    DIFF (new - old grand): ${r2(rdD.summary.total_sale - oldS.grandTotal)}`);
    console.log(`    OLD orders:             ${oldS.orderCount}`);
    console.log(`    NEW orders:             ${rdD.summary.total_orders}`);
    console.log(`    DIFF orders:            ${rdD.summary.total_orders - oldS.orderCount}`);
  }

  // Old Day End Summary
  if (oldDE.data && oldDE.data.grandTotal) {
    const oldG = oldDE.data.grandTotal;
    console.log(`\n  DAY END SUMMARY (${START_DATE} to ${END_DATE}):`);
    console.log(`    OLD totalSales (net):   ${oldG.totalSales}`);
    console.log(`    OLD grossSales:         ${oldG.grossSales}`);
    console.log(`    OLD totalCollection:    ${oldG.totalCollection}`);
    console.log(`    NEW total_sale:         ${deD.grandTotal.total_sale}`);
    console.log(`    DIFF (new - old net):   ${r2(deD.grandTotal.total_sale - oldG.totalSales)}`);
    console.log(`    OLD orders:             ${oldG.totalOrders}`);
    console.log(`    OLD completedOrders:    ${oldG.completedOrders}`);
    console.log(`    NEW total_orders:       ${deD.grandTotal.total_orders}`);
    console.log(`    DIFF orders:            ${deD.grandTotal.total_orders - oldG.completedOrders}`);

    // Per-day comparison
    console.log(`\n  PER-DAY: Old DayEnd vs New DayEnd:`);
    console.log('    Date       | Old Net    | New Sale   | Diff       | Old Orders | New Orders | Diff');
    console.log('    ' + '-'.repeat(85));
    
    const oldDays = oldDE.data.days || [];
    const newDays = deD.days || [];
    const oldDayMap = {};
    for (const d of oldDays) oldDayMap[d.date] = d;

    for (const nd of newDays) {
      const od = oldDayMap[nd.date];
      if (od) {
        const saleDiff = r2(nd.total_sale - od.totalSales);
        const orderDiff = nd.total_orders - od.completedOrders;
        console.log(`    ${nd.date} | ${String(od.totalSales).padStart(10)} | ${String(nd.total_sale).padStart(10)} | ${String(saleDiff).padStart(10)} | ${String(od.completedOrders).padStart(10)} | ${String(nd.total_orders).padStart(10)} | ${String(orderDiff).padStart(4)}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // PHASE 8: RunDash channel totals = total_sale
  // ══════════════════════════════════════════════════════
  console.log('\n── PHASE 8: CHANNEL SUM VERIFICATION ──');
  const channelSum = rdD.summary.channels.reduce((s, c) => s + c.amount, 0);
  record('RunDash channel sum = total_sale', Math.abs(r2(channelSum) - rdD.summary.total_sale) < 0.01,
    `channels=${r2(channelSum)}, total_sale=${rdD.summary.total_sale}`);

  // DayEnd per-day ordersByType sum
  for (const d of deD.days) {
    const typeSum = d.ordersByType.dine_in + d.ordersByType.takeaway + d.ordersByType.delivery;
    record(`${d.date} orderType sum = total_orders`, typeSum === d.total_orders,
      `type_sum=${typeSum}, total=${d.total_orders}`);
  }

  // ══════════════════════════════════════════════════════
  // RESULTS
  // ══════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed (${total} total)`);
  console.log('='.repeat(90));

  await c.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Error:', err); process.exit(1); });
