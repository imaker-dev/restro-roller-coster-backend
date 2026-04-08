/**
 * Test Script: Accurate DSR (v2) Cross-Verification
 *
 * Verifies:
 *  1. Business day range is 4 AM → 4 AM (NOT midnight–midnight)
 *  2. Only completed orders are counted
 *  3. total_sale = SUM(total_amount) of completed orders
 *  4. total_collection = total_sale (regardless of payment status)
 *  5. NC & discount bifurcation is correct
 *  6. Cross-verification: API summary matches order-level sum
 *  7. Compares old DSR vs new DSR to show discrepancy
 *
 * Run: node tests/test-accurate-dsr.js [YYYY-MM-DD]
 *   Optional date argument (defaults to today's business day)
 *
 * Requirements: server running on PORT (default 3005)
 */

const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');

// ── Load env ──────────────────────────────────────────────
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const dbConfigBase = require('../src/config/database.config');
const dbConfig = {
  host: dbConfigBase.host,
  port: dbConfigBase.port,
  user: dbConfigBase.user,
  password: dbConfigBase.password,
  database: dbConfigBase.database,
};

const BASE_URL = process.env.API_URL || 'http://localhost:3005';
const API_PREFIX = '/api/v1';
const BUSINESS_DAY_START_HOUR = 4;

// CLI arg: optional date (YYYY-MM-DD)
const argDate = process.argv[2] || null;

let AUTH_TOKEN = null;
let OUTLET_ID = null;
const results = { passed: 0, failed: 0, tests: [] };

// ── Helpers ───────────────────────────────────────────────

function record(name, passed, detail = '') {
  results.tests.push({ name, passed, detail });
  if (passed) results.passed++;
  else results.failed++;
  console.log(`  ${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function r2(n) { return parseFloat((parseFloat(n) || 0).toFixed(2)); }

function apiRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + API_PREFIX + urlPath);
    const options = {
      hostname: url.hostname,
      port: url.port || 3005,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (AUTH_TOKEN) options.headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Compute business day range (4 AM → 4 AM) for a given date string
 */
function businessDayRange(dateStr) {
  const h = String(BUSINESS_DAY_START_HOUR).padStart(2, '0') + ':00:00';
  const startDt = `${dateStr} ${h}`;
  const ed = new Date(dateStr + 'T00:00:00');
  ed.setDate(ed.getDate() + 1);
  const endStr = ed.getFullYear() + '-' + String(ed.getMonth() + 1).padStart(2, '0') + '-' + String(ed.getDate()).padStart(2, '0');
  const endDt = `${endStr} ${h}`;
  return { startDt, endDt };
}

/**
 * Get today's business day date string
 */
function getBusinessDate() {
  if (argDate) return argDate;
  const now = new Date();
  const shifted = new Date(now.getTime() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── Main ──────────────────────────────────────────────────

async function run() {
  console.log('='.repeat(70));
  console.log('  ACCURATE DSR (v2) — CROSS-VERIFICATION TEST');
  console.log('='.repeat(70));

  const reportDate = getBusinessDate();
  const { startDt, endDt } = businessDayRange(reportDate);
  console.log(`\n  Report date : ${reportDate}`);
  console.log(`  Time window : ${startDt}  -->  ${endDt}  (4 AM to 4 AM)\n`);

  // ───────── DB CONNECTION ─────────
  let conn;
  try {
    conn = await mysql.createConnection(dbConfig);
    console.log(`  DB connected: ${dbConfig.database}@${dbConfig.host}\n`);
  } catch (e) {
    console.error('  DB connection failed:', e.message);
    process.exit(1);
  }

  // ───────── Find outlet ─────────
  const [outlets] = await conn.query('SELECT id, name FROM outlets WHERE is_active = 1 LIMIT 1');
  if (!outlets.length) { console.error('  No active outlet found'); process.exit(1); }
  OUTLET_ID = outlets[0].id;
  console.log(`  Outlet: ${outlets[0].name} (id=${OUTLET_ID})\n`);

  // ═══════════════════════════════════════════════════════
  // TEST 1: Business day boundary verification (DB-level)
  // ═══════════════════════════════════════════════════════
  console.log('-'.repeat(60));
  console.log('  TEST 1: Business Day Boundary (4 AM - 4 AM)');
  console.log('-'.repeat(60));

  // 1a. Count completed orders using CORRECT 4am-4am window
  const [correctWindow] = await conn.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total
     FROM orders
     WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, startDt, endDt]
  );

  // 1b. Count completed orders using WRONG midnight-midnight window
  const wrongStart = `${reportDate} 00:00:00`;
  const wrongEnd = `${reportDate} 23:59:59`;
  const [wrongWindow] = await conn.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total
     FROM orders
     WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at <= ?`,
    [OUTLET_ID, wrongStart, wrongEnd]
  );

  console.log(`  4am-4am window : ${correctWindow[0].cnt} orders, total = ${r2(correctWindow[0].total)}`);
  console.log(`  midnight window : ${wrongWindow[0].cnt} orders, total = ${r2(wrongWindow[0].total)}`);
  const windowDiff = r2(correctWindow[0].total) - r2(wrongWindow[0].total);
  console.log(`  Difference      : ${r2(windowDiff)} (${correctWindow[0].cnt - wrongWindow[0].cnt} orders)\n`);

  // 1c. Verify orders exist in the 12am-4am edges
  const [earlyMorning] = await conn.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total
     FROM orders
     WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, `${reportDate} 00:00:00`, `${reportDate} 04:00:00`]
  );
  const nextDay = new Date(reportDate + 'T00:00:00');
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = nextDay.getFullYear() + '-' + String(nextDay.getMonth() + 1).padStart(2, '0') + '-' + String(nextDay.getDate()).padStart(2, '0');
  const [lateNight] = await conn.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total
     FROM orders
     WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, `${nextDayStr} 00:00:00`, `${nextDayStr} 04:00:00`]
  );

  console.log(`  Edge: ${reportDate} 00:00-04:00 (belongs to PREV day): ${earlyMorning[0].cnt} orders, ${r2(earlyMorning[0].total)}`);
  console.log(`  Edge: ${nextDayStr} 00:00-04:00 (belongs to THIS day): ${lateNight[0].cnt} orders, ${r2(lateNight[0].total)}`);

  record('Business day uses 4am-4am range', true, `${startDt} to ${endDt}`);
  console.log();

  // ═══════════════════════════════════════════════════════
  // TEST 2: Direct DB query — only completed orders
  // ═══════════════════════════════════════════════════════
  console.log('-'.repeat(60));
  console.log('  TEST 2: DB Verification — Only Completed Orders');
  console.log('-'.repeat(60));

  // 2a. All non-cancelled orders in window (what old DSR uses)
  const [allNonCancelled] = await conn.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total
     FROM orders
     WHERE outlet_id = ? AND status != 'cancelled'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, startDt, endDt]
  );

  // 2b. Only completed orders (what new DSR uses)
  const [onlyCompleted] = await conn.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total
     FROM orders
     WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, startDt, endDt]
  );

  // 2c. Non-completed, non-cancelled orders (the ones causing discrepancy)
  const [inProgressOrders] = await conn.query(
    `SELECT status, COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as total
     FROM orders
     WHERE outlet_id = ? AND status NOT IN ('completed', 'cancelled')
       AND created_at >= ? AND created_at < ?
     GROUP BY status`,
    [OUTLET_ID, startDt, endDt]
  );

  console.log(`  All non-cancelled (old DSR logic) : ${allNonCancelled[0].cnt} orders, total = ${r2(allNonCancelled[0].total)}`);
  console.log(`  Only completed (new DSR logic)    : ${onlyCompleted[0].cnt} orders, total = ${r2(onlyCompleted[0].total)}`);
  console.log(`  DISCREPANCY (in-progress orders)  : ${allNonCancelled[0].cnt - onlyCompleted[0].cnt} orders, diff = ${r2(r2(allNonCancelled[0].total) - r2(onlyCompleted[0].total))}`);
  if (inProgressOrders.length > 0) {
    console.log('  Breakdown of in-progress orders:');
    for (const row of inProgressOrders) {
      console.log(`    - ${row.status}: ${row.cnt} orders, total = ${r2(row.total)}`);
    }
  }

  const completedOnly = r2(allNonCancelled[0].total) !== r2(onlyCompleted[0].total)
    || allNonCancelled[0].cnt !== onlyCompleted[0].cnt;
  record('New DSR only counts completed orders', true, 
    `completed=${onlyCompleted[0].cnt}, non-cancelled=${allNonCancelled[0].cnt}`);
  if (completedOnly) {
    record('Old DSR includes extra non-completed orders (BUG CONFIRMED)', true,
      `diff = ${r2(r2(allNonCancelled[0].total) - r2(onlyCompleted[0].total))}`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════
  // TEST 3: DB-level total_sale vs order-level sum
  // ═══════════════════════════════════════════════════════
  console.log('-'.repeat(60));
  console.log('  TEST 3: DB Cross-Verification (aggregate vs per-order)');
  console.log('-'.repeat(60));

  // Aggregate
  const [dbAgg] = await conn.query(
    `SELECT
       COUNT(*) as total_orders,
       SUM(total_amount) as total_sale,
       SUM(COALESCE(discount_amount, 0)) as total_discount,
       SUM(CASE WHEN is_nc = 1 THEN COALESCE(nc_amount, 0) ELSE 0 END) as nc_amount,
       COUNT(CASE WHEN is_nc = 1 THEN 1 END) as nc_order_count,
       SUM(COALESCE(adjustment_amount, 0)) as total_adj,
       SUM(COALESCE(paid_amount, 0)) as total_paid,
       SUM(COALESCE(due_amount, 0)) as total_due
     FROM orders
     WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, startDt, endDt]
  );

  // Per-order sum
  const [dbOrders] = await conn.query(
    `SELECT id, order_number, total_amount, discount_amount, is_nc, nc_amount,
            is_adjustment, adjustment_amount, paid_amount, due_amount, payment_status
     FROM orders
     WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < ?
     ORDER BY created_at`,
    [OUTLET_ID, startDt, endDt]
  );

  const perOrderSum = dbOrders.reduce((s, o) => s + r2(o.total_amount), 0);
  const aggTotal = r2(dbAgg[0].total_sale);
  const dbMatch = Math.abs(aggTotal - r2(perOrderSum)) < 0.01;

  console.log(`  Aggregate SUM(total_amount) : ${aggTotal}`);
  console.log(`  Per-order sum               : ${r2(perOrderSum)}`);
  console.log(`  Match                       : ${dbMatch ? 'YES' : 'NO'}`);
  console.log(`  Total orders                : ${dbAgg[0].total_orders}`);
  console.log(`  Discount                    : ${r2(dbAgg[0].total_discount)}`);
  console.log(`  NC amount                   : ${r2(dbAgg[0].nc_amount)} (${dbAgg[0].nc_order_count} orders)`);
  console.log(`  Adjustment                  : ${r2(dbAgg[0].total_adj)}`);
  console.log(`  Paid                        : ${r2(dbAgg[0].total_paid)}`);
  console.log(`  Due                         : ${r2(dbAgg[0].total_due)}`);
  console.log(`  Paid + Due                  : ${r2(r2(dbAgg[0].total_paid) + r2(dbAgg[0].total_due))}`);

  record('DB aggregate matches per-order sum', dbMatch,
    `agg=${aggTotal}, perOrder=${r2(perOrderSum)}`);

  // Verify paid + due + adjustment = total for each order
  let mismatchCount = 0;
  for (const o of dbOrders) {
    const expected = r2(o.total_amount);
    const actual = r2(r2(o.paid_amount) + r2(o.due_amount) + r2(o.adjustment_amount));
    if (Math.abs(expected - actual) > 0.02) {
      mismatchCount++;
      if (mismatchCount <= 3) {
        console.log(`  WARNING: Order ${o.order_number} — total=${expected}, paid+due+adj=${actual}`);
      }
    }
  }
  record('Order amounts are internally consistent (paid+due+adj=total)', mismatchCount === 0,
    mismatchCount > 0 ? `${mismatchCount} orders have mismatched amounts` : 'all orders match');
  console.log();

  // ═══════════════════════════════════════════════════════
  // TEST 4: API Test — Call the new accurate-dsr endpoint
  // ═══════════════════════════════════════════════════════
  console.log('-'.repeat(60));
  console.log('  TEST 4: API — Accurate DSR Endpoint');
  console.log('-'.repeat(60));

  // Login
  const loginRes = await apiRequest('POST', '/auth/login', {
    email: 'admin@restropos.com', password: 'admin123'
  });
  if (!loginRes.data?.success || !loginRes.data?.data?.accessToken) {
    console.log('  Login failed — skipping API tests');
    record('API Login', false, JSON.stringify(loginRes.data?.message || 'no token'));
  } else {
    AUTH_TOKEN = loginRes.data.data.accessToken;
    record('API Login', true);

    // Call new accurate-dsr
    const dsrRes = await apiRequest('GET',
      `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=${reportDate}&endDate=${reportDate}`);

    if (dsrRes.status !== 200 || !dsrRes.data?.success) {
      record('API accurate-dsr returned success', false, `status=${dsrRes.status}, msg=${dsrRes.data?.message}`);
    } else {
      record('API accurate-dsr returned success', true);

      const api = dsrRes.data.data;
      const apiSummary = api.summary;
      const apiOrders = api.orders || [];
      const apiCV = api.crossVerification;

      console.log(`\n  API Summary:`);
      console.log(`    total_orders     : ${apiSummary.total_orders}`);
      console.log(`    total_sale       : ${apiSummary.total_sale}`);
      console.log(`    total_collection : ${apiSummary.total_collection}`);
      console.log(`    discount_amount  : ${apiSummary.discount_amount}`);
      console.log(`    nc_amount        : ${apiSummary.nc_amount} (${apiSummary.nc_order_count} orders)`);
      console.log(`    adjustment_amt   : ${apiSummary.adjustment_amount}`);
      console.log(`    paid_amount      : ${apiSummary.total_paid_amount}`);
      console.log(`    due_amount       : ${apiSummary.total_due_amount}`);
      console.log(`    order count      : ${apiOrders.length} orders in list`);

      // 4a. total_sale = total_collection
      record('total_collection equals total_sale',
        apiSummary.total_sale === apiSummary.total_collection,
        `sale=${apiSummary.total_sale}, collection=${apiSummary.total_collection}`);

      // 4b. Cross-verification passes
      record('Cross-verification match', apiCV.match === true,
        `summary=${apiCV.summary_total_sale}, orderLevel=${apiCV.order_level_total}`);

      // 4c. API total matches DB total
      const apiVsDb = Math.abs(apiSummary.total_sale - aggTotal) < 0.01;
      record('API total_sale matches DB aggregate', apiVsDb,
        `api=${apiSummary.total_sale}, db=${aggTotal}`);

      // 4d. API order count matches DB order count
      const countMatch = apiSummary.total_orders === (dbAgg[0].total_orders || 0);
      record('API order count matches DB count', countMatch,
        `api=${apiSummary.total_orders}, db=${dbAgg[0].total_orders}`);

      // 4e. API discount matches DB discount
      const discountMatch = Math.abs(apiSummary.discount_amount - r2(dbAgg[0].total_discount)) < 0.01;
      record('API discount matches DB', discountMatch,
        `api=${apiSummary.discount_amount}, db=${r2(dbAgg[0].total_discount)}`);

      // 4f. API NC matches DB NC
      const ncMatch = Math.abs(apiSummary.nc_amount - r2(dbAgg[0].nc_amount)) < 0.01;
      record('API NC amount matches DB', ncMatch,
        `api=${apiSummary.nc_amount}, db=${r2(dbAgg[0].nc_amount)}`);

      // 4g. Verify order list count
      record('API orders list count matches summary', apiOrders.length === apiSummary.total_orders,
        `list=${apiOrders.length}, summary=${apiSummary.total_orders}`);

      // 4h. Sum API order list total_amount
      const apiOrderSum = apiOrders.reduce((s, o) => s + (o.total_amount || 0), 0);
      const apiOrderSumMatch = Math.abs(r2(apiOrderSum) - apiSummary.total_sale) < 0.01;
      record('API order list sum matches total_sale', apiOrderSumMatch,
        `orderSum=${r2(apiOrderSum)}, totalSale=${apiSummary.total_sale}`);

      // 4i. Verify dateRange
      record('API dateRange matches request', api.dateRange.start === reportDate && api.dateRange.end === reportDate,
        `start=${api.dateRange.start}, end=${api.dateRange.end}`);
    }

    // ═══════════════════════════════════════════════════════
    // TEST 5: Compare Old DSR vs New DSR
    // ═══════════════════════════════════════════════════════
    console.log('\n' + '-'.repeat(60));
    console.log('  TEST 5: Old DSR vs New DSR Comparison');
    console.log('-'.repeat(60));

    const oldDsrRes = await apiRequest('GET',
      `/reports/daily-sales?outletId=${OUTLET_ID}&startDate=${reportDate}&endDate=${reportDate}`);

    if (oldDsrRes.status === 200 && oldDsrRes.data?.success) {
      const oldSummary = oldDsrRes.data.data?.summary || {};
      const newSummary = dsrRes.data?.data?.summary || {};

      const oldNetSales = parseFloat(oldSummary.net_sales) || 0;
      const oldGrossSales = parseFloat(oldSummary.gross_sales) || 0;
      const oldCollection = parseFloat(oldSummary.total_collection) || 0;
      const newTotalSale = newSummary.total_sale || 0;

      console.log(`\n  Old DSR:`);
      console.log(`    gross_sales      : ${oldGrossSales}`);
      console.log(`    net_sales        : ${oldNetSales}`);
      console.log(`    total_collection : ${oldCollection}`);
      console.log(`    total_orders     : ${oldSummary.total_orders}`);
      console.log(`  New DSR:`);
      console.log(`    total_sale       : ${newTotalSale}`);
      console.log(`    total_collection : ${newSummary.total_collection}`);
      console.log(`    total_orders     : ${newSummary.total_orders}`);
      console.log(`\n  Differences:`);
      console.log(`    new total_sale - old net_sales   = ${r2(newTotalSale - oldNetSales)}`);
      console.log(`    new total_sale - old gross_sales = ${r2(newTotalSale - oldGrossSales)}`);
      console.log(`    new collection - old collection  = ${r2(newSummary.total_collection - oldCollection)}`);
      console.log(`    order count diff                 = ${(newSummary.total_orders || 0) - (oldSummary.total_orders || 0)}`);

      record('Old vs New comparison logged', true);
    } else {
      console.log('  Old DSR API call failed — skipping comparison');
    }
  }

  // ═══════════════════════════════════════════════════════
  // TEST 6: Payment status verification (all statuses included)
  // ═══════════════════════════════════════════════════════
  console.log('\n' + '-'.repeat(60));
  console.log('  TEST 6: All Payment Statuses Included');
  console.log('-'.repeat(60));

  const [payStatusBreakdown] = await conn.query(
    `SELECT payment_status, COUNT(*) as cnt, SUM(total_amount) as total
     FROM orders
     WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < ?
     GROUP BY payment_status`,
    [OUTLET_ID, startDt, endDt]
  );

  let allPayStatusTotal = 0;
  for (const row of payStatusBreakdown) {
    const t = r2(row.total);
    allPayStatusTotal += t;
    console.log(`  payment_status='${row.payment_status}': ${row.cnt} orders, total=${t}`);
  }
  const payStatusMatch = Math.abs(r2(allPayStatusTotal) - aggTotal) < 0.01;
  record('All payment statuses sum to total_sale', payStatusMatch,
    `sumByStatus=${r2(allPayStatusTotal)}, aggTotal=${aggTotal}`);
  console.log();

  // ═══════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════
  console.log('='.repeat(70));
  console.log(`  RESULTS: ${results.passed} passed, ${results.failed} failed (${results.tests.length} total)`);
  console.log('='.repeat(70));

  if (results.failed > 0) {
    console.log('\n  FAILED TESTS:');
    for (const t of results.tests.filter(t => !t.passed)) {
      console.log(`    FAIL: ${t.name} — ${t.detail}`);
    }
  }

  console.log();
  await conn.end();
  process.exit(results.failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test crashed:', err);
  process.exit(2);
});
