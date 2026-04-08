/**
 * Test: Accurate DSR vs Old DSR — Outlet 46, Apr 1–6, per-day + overall
 * Business day: 4 AM to 4 AM
 *
 * Run: node tests/test-accurate-dsr-outlet46.js
 */

const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE_URL = process.env.API_URL || 'http://localhost:3005';
const API_PREFIX = '/api/v1';
const OUTLET_ID = 46;
const START_DATE = '2026-04-01';
const END_DATE = '2026-04-06';
const BD_HOUR = 4; // business day start

let AUTH_TOKEN = null;
const results = { passed: 0, failed: 0, tests: [] };

function r2(n) { return parseFloat((parseFloat(n) || 0).toFixed(2)); }

function record(name, passed, detail = '') {
  results.tests.push({ name, passed, detail });
  if (passed) results.passed++; else results.failed++;
  console.log(`  ${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

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

function bdRange(dateStr) {
  const h = String(BD_HOUR).padStart(2, '0') + ':00:00';
  const startDt = `${dateStr} ${h}`;
  const ed = new Date(dateStr + 'T00:00:00');
  ed.setDate(ed.getDate() + 1);
  const endStr = ed.getFullYear() + '-' + String(ed.getMonth() + 1).padStart(2, '0') + '-' + String(ed.getDate()).padStart(2, '0');
  return { startDt, endDt: `${endStr} ${h}` };
}

function dateList(start, end) {
  const dates = [];
  const cur = new Date(start + 'T00:00:00');
  const last = new Date(end + 'T00:00:00');
  while (cur <= last) {
    dates.push(cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0'));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

async function run() {
  console.log('='.repeat(80));
  console.log('  OUTLET 46 — ACCURATE DSR vs OLD DSR — Apr 1–6 (per-day + overall)');
  console.log('  Business day: 4 AM → 4 AM');
  console.log('='.repeat(80));

  // ── DB Connect ──
  const conn = await mysql.createConnection({
    host: dbCfg.host, port: dbCfg.port, user: dbCfg.user,
    password: dbCfg.password, database: dbCfg.database
  });

  const [outletRow] = await conn.query('SELECT name FROM outlets WHERE id = ?', [OUTLET_ID]);
  console.log(`\n  Outlet: ${outletRow[0]?.name || 'Unknown'} (id=${OUTLET_ID})`);
  console.log(`  Range : ${START_DATE} → ${END_DATE}\n`);

  // ── Login ──
  const loginRes = await apiRequest('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  if (!loginRes.data?.success || !loginRes.data?.data?.accessToken) {
    console.error('  Login failed'); process.exit(1);
  }
  AUTH_TOKEN = loginRes.data.data.accessToken;
  record('Login', true);
  console.log();

  const dates = dateList(START_DATE, END_DATE);

  // ═══════════════════════════════════════════════════════════════
  // PER-DAY COMPARISON
  // ═══════════════════════════════════════════════════════════════
  console.log('─'.repeat(80));
  console.log('  PER-DAY COMPARISON (DB + New API + Old API)');
  console.log('─'.repeat(80));

  const dbDailyTotals = [];
  const newApiDailyTotals = [];
  const oldApiDailyTotals = [];

  for (const d of dates) {
    const { startDt, endDt } = bdRange(d);
    console.log(`\n  ── ${d}  [${startDt} → ${endDt}] ──`);

    // ── DB: Completed only (new logic) ──
    const [dbCompleted] = await conn.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total,
              COALESCE(SUM(discount_amount),0) as disc,
              COALESCE(SUM(CASE WHEN is_nc=1 THEN nc_amount ELSE 0 END),0) as nc,
              COALESCE(SUM(paid_amount),0) as paid,
              COALESCE(SUM(due_amount),0) as due,
              COALESCE(SUM(adjustment_amount),0) as adj
       FROM orders WHERE outlet_id=? AND status='completed'
         AND created_at >= ? AND created_at < ?`,
      [OUTLET_ID, startDt, endDt]
    );

    // ── DB: All non-cancelled (old logic) ──
    const [dbAll] = await conn.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
       FROM orders WHERE outlet_id=? AND status != 'cancelled'
         AND created_at >= ? AND created_at < ?`,
      [OUTLET_ID, startDt, endDt]
    );

    // ── DB: In-progress orders (the gap) ──
    const [dbInProgress] = await conn.query(
      `SELECT status, COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
       FROM orders WHERE outlet_id=? AND status NOT IN ('completed','cancelled')
         AND created_at >= ? AND created_at < ?
       GROUP BY status`,
      [OUTLET_ID, startDt, endDt]
    );

    // ── DB: Payment status breakdown for completed orders ──
    const [dbPayStatus] = await conn.query(
      `SELECT payment_status, COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
       FROM orders WHERE outlet_id=? AND status='completed'
         AND created_at >= ? AND created_at < ?
       GROUP BY payment_status`,
      [OUTLET_ID, startDt, endDt]
    );

    const dbC = dbCompleted[0];
    dbDailyTotals.push({ date: d, orders: dbC.cnt, total: r2(dbC.total), disc: r2(dbC.disc), nc: r2(dbC.nc), paid: r2(dbC.paid), due: r2(dbC.due), adj: r2(dbC.adj) });

    console.log(`  DB (completed only) : ${dbC.cnt} orders | total_sale = ${r2(dbC.total)} | disc=${r2(dbC.disc)} | nc=${r2(dbC.nc)} | paid=${r2(dbC.paid)} | due=${r2(dbC.due)} | adj=${r2(dbC.adj)}`);
    console.log(`  DB (non-cancelled)  : ${dbAll[0].cnt} orders | total = ${r2(dbAll[0].total)}`);

    if (dbInProgress.length > 0) {
      const inProgStr = dbInProgress.map(r => `${r.status}:${r.cnt}(${r2(r.total)})`).join(', ');
      console.log(`  In-progress (gap)   : ${inProgStr}`);
    }

    const payStr = dbPayStatus.map(r => `${r.payment_status}:${r.cnt}(${r2(r.total)})`).join(', ');
    if (payStr) console.log(`  Payment status      : ${payStr}`);

    // ── New API ──
    const newRes = await apiRequest('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=${d}&endDate=${d}`);
    if (newRes.status === 200 && newRes.data?.success) {
      const s = newRes.data.data.summary;
      const cv = newRes.data.data.crossVerification;
      newApiDailyTotals.push({ date: d, orders: s.total_orders, total: s.total_sale, collection: s.total_collection, disc: s.discount_amount, nc: s.nc_amount, paid: s.total_paid_amount, due: s.total_due_amount });
      console.log(`  NEW API             : ${s.total_orders} orders | total_sale = ${s.total_sale} | collection = ${s.total_collection} | disc=${s.discount_amount} | nc=${s.nc_amount} | paid=${s.total_paid_amount} | due=${s.total_due_amount}`);

      // Verify new API matches DB
      const saleMatch = Math.abs(s.total_sale - r2(dbC.total)) < 0.01;
      const countMatch = s.total_orders === dbC.cnt;
      record(`${d} new API total matches DB`, saleMatch && countMatch,
        `api=${s.total_sale}/${s.total_orders}, db=${r2(dbC.total)}/${dbC.cnt}`);
      record(`${d} new API cross-verification`, cv.match === true);
    } else {
      console.log(`  NEW API             : FAILED (${newRes.status})`);
      record(`${d} new API call`, false);
    }

    // ── Old API ──
    const oldRes = await apiRequest('GET', `/reports/daily-sales?outletId=${OUTLET_ID}&startDate=${d}&endDate=${d}`);
    if (oldRes.status === 200 && oldRes.data?.success) {
      const os = oldRes.data.data.summary || {};
      const oldGross = parseFloat(os.gross_sales) || 0;
      const oldNet = parseFloat(os.net_sales) || 0;
      const oldCol = parseFloat(os.total_collection) || 0;
      const oldOrders = os.total_orders || 0;
      oldApiDailyTotals.push({ date: d, orders: oldOrders, gross: oldGross, net: oldNet, collection: oldCol });
      console.log(`  OLD API             : ${oldOrders} orders | gross = ${oldGross} | net = ${oldNet} | collection = ${oldCol}`);

      // Show diff
      const saleDiff = r2(r2(dbC.total) - oldNet);
      const colDiff = r2(r2(dbC.total) - oldCol);
      if (saleDiff !== 0 || colDiff !== 0 || dbC.cnt !== oldOrders) {
        console.log(`  >>> DIFF            : orders=${dbC.cnt - oldOrders} | new_total - old_net = ${saleDiff} | new_collection - old_collection = ${colDiff}`);
      }
    } else {
      console.log(`  OLD API             : FAILED (${oldRes.status})`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // OVERALL (Apr 1–6)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(80));
  console.log('  OVERALL COMPARISON (Apr 1–6)');
  console.log('─'.repeat(80));

  // DB overall
  const overallRange = bdRange(START_DATE);
  const overallEndRange = bdRange(END_DATE);
  const [dbOverall] = await conn.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total,
            COALESCE(SUM(discount_amount),0) as disc,
            COALESCE(SUM(CASE WHEN is_nc=1 THEN nc_amount ELSE 0 END),0) as nc,
            COALESCE(SUM(paid_amount),0) as paid,
            COALESCE(SUM(due_amount),0) as due,
            COALESCE(SUM(adjustment_amount),0) as adj
     FROM orders WHERE outlet_id=? AND status='completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, overallRange.startDt, overallEndRange.endDt]
  );

  const [dbOverallNonCancelled] = await conn.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
     FROM orders WHERE outlet_id=? AND status != 'cancelled'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, overallRange.startDt, overallEndRange.endDt]
  );

  const dbO = dbOverall[0];
  console.log(`\n  DB (completed only) : ${dbO.cnt} orders | total = ${r2(dbO.total)} | disc=${r2(dbO.disc)} | nc=${r2(dbO.nc)} | paid=${r2(dbO.paid)} | due=${r2(dbO.due)} | adj=${r2(dbO.adj)}`);
  console.log(`  DB (non-cancelled)  : ${dbOverallNonCancelled[0].cnt} orders | total = ${r2(dbOverallNonCancelled[0].total)}`);
  console.log(`  Gap (non-completed) : ${dbOverallNonCancelled[0].cnt - dbO.cnt} orders | diff = ${r2(r2(dbOverallNonCancelled[0].total) - r2(dbO.total))}`);

  // New API overall
  const newOverall = await apiRequest('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=${START_DATE}&endDate=${END_DATE}`);
  if (newOverall.status === 200 && newOverall.data?.success) {
    const ns = newOverall.data.data.summary;
    const ncv = newOverall.data.data.crossVerification;
    console.log(`\n  NEW API (overall)   : ${ns.total_orders} orders | total_sale = ${ns.total_sale} | collection = ${ns.total_collection}`);
    console.log(`                        disc=${ns.discount_amount} | nc=${ns.nc_amount} | paid=${ns.total_paid_amount} | due=${ns.total_due_amount} | adj=${ns.adjustment_amount}`);
    console.log(`                        avg_order = ${ns.average_order_value} | guests = ${ns.total_guests}`);
    console.log(`                        dine_in=${ns.dine_in_orders} | takeaway=${ns.takeaway_orders} | delivery=${ns.delivery_orders}`);

    record('Overall new API total matches DB', Math.abs(ns.total_sale - r2(dbO.total)) < 0.01,
      `api=${ns.total_sale}, db=${r2(dbO.total)}`);
    record('Overall new API count matches DB', ns.total_orders === dbO.cnt,
      `api=${ns.total_orders}, db=${dbO.cnt}`);
    record('Overall cross-verification', ncv.match === true);
    record('Overall total_collection = total_sale', ns.total_collection === ns.total_sale);

    // Verify per-day sums add up to overall
    const dailyData = newOverall.data.data.daily || [];
    const dailySaleSum = r2(dailyData.reduce((s, d) => s + d.total_sale, 0));
    const dailyOrderSum = dailyData.reduce((s, d) => s + d.total_orders, 0);
    record('Per-day totals sum to overall', Math.abs(dailySaleSum - ns.total_sale) < 0.01 && dailyOrderSum === ns.total_orders,
      `daySaleSum=${dailySaleSum}/${dailyOrderSum}, overall=${ns.total_sale}/${ns.total_orders}`);

    // Show daily breakdown from API
    console.log(`\n  Per-day from API:`);
    for (const dd of dailyData) {
      console.log(`    ${dd.date}: ${dd.total_orders} orders | sale=${dd.total_sale} | disc=${dd.discount_amount} | nc=${dd.nc_amount} | paid=${dd.total_paid_amount} | due=${dd.total_due_amount}`);
    }
  }

  // Old API overall
  const oldOverall = await apiRequest('GET', `/reports/daily-sales?outletId=${OUTLET_ID}&startDate=${START_DATE}&endDate=${END_DATE}`);
  if (oldOverall.status === 200 && oldOverall.data?.success) {
    const os = oldOverall.data.data.summary || {};
    console.log(`\n  OLD API (overall)   : ${os.total_orders} orders | gross = ${os.gross_sales} | net = ${os.net_sales} | collection = ${os.total_collection}`);

    // Show the diff
    const newTotal = r2(dbO.total);
    const oldNet = parseFloat(os.net_sales) || 0;
    const oldCol = parseFloat(os.total_collection) || 0;
    const oldOrders = os.total_orders || 0;
    console.log(`\n  ┌──────────────────────────────────────────────────────┐`);
    console.log(`  │  DISCREPANCY SUMMARY (Old vs Correct)               │`);
    console.log(`  ├──────────────────────────────────────────────────────┤`);
    console.log(`  │  Order count gap    : ${oldOrders - dbO.cnt} extra in old DSR`.padEnd(56) + '│');
    console.log(`  │  Sale diff (old net): ${r2(oldNet - newTotal)}`.padEnd(56) + '│');
    console.log(`  │  Collection diff    : ${r2(oldCol - newTotal)}`.padEnd(56) + '│');
    console.log(`  │  Correct total_sale : ${newTotal}`.padEnd(56) + '│');
    console.log(`  │  Correct collection : ${newTotal} (=total_sale)`.padEnd(56) + '│');
    console.log(`  └──────────────────────────────────────────────────────┘`);
  }

  // ═══════════════════════════════════════════════════════════════
  // FINAL RESULTS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log(`  RESULTS: ${results.passed} passed, ${results.failed} failed (${results.tests.length} total)`);
  console.log('='.repeat(80));
  if (results.failed > 0) {
    console.log('\n  FAILED:');
    for (const t of results.tests.filter(t => !t.passed)) {
      console.log(`    FAIL: ${t.name} — ${t.detail}`);
    }
  }
  console.log();
  await conn.end();
  process.exit(results.failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Test crashed:', err); process.exit(2); });
