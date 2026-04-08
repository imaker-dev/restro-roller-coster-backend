/**
 * Verify Apr 7 import shows correctly in all APIs
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

function api(method, urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } }); });
    req.on('error', reject); req.end();
  });
}

const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
function check(label, got, expected, tolerance = 1) {
  const g = r2(got), e = r2(expected);
  if (Math.abs(g - e) <= tolerance) { pass++; console.log(`  ✅ ${label}: ${g} === ${e}`); }
  else { fail++; console.log(`  ❌ ${label}: got ${g}, expected ${e} (diff: ${r2(g - e)})`); }
}
function checkInt(label, got, expected) {
  const g = parseInt(got) || 0, e = parseInt(expected) || 0;
  if (g === e) { pass++; console.log(`  ✅ ${label}: ${g} === ${e}`); }
  else { fail++; console.log(`  ❌ ${label}: got ${g}, expected ${e}`); }
}

async function run() {
  pool = mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  const loginRes = await api('POST', '/auth/login');
  // Need body for login
  const loginRes2 = await new Promise((resolve, reject) => {
    const url = new URL(BASE + '/auth/login');
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(JSON.stringify({ email: 'admin@restropos.com', password: 'admin123' }));
    req.end();
  });
  token = loginRes2.data.accessToken;

  // Expected from Excel (34 orders, excl 2 Zomato)
  const EXPECTED = { orders: 34, sale: 53716, discount: 1831.43, tax: 3253.31 };

  // DB verification
  const [dbCheck] = await pool.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as sale, SUM(discount_amount) as disc, SUM(tax_amount) as tax
     FROM orders WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= '2026-04-07 04:00:00' AND created_at < '2026-04-08 04:00:00'`,
    [OUTLET_ID]
  );

  console.log('═'.repeat(90));
  console.log('  VERIFICATION: Apr 7 Import');
  console.log('═'.repeat(90));
  console.log(`\n  DB: ${dbCheck[0].cnt} completed orders, Rs ${r2(dbCheck[0].sale)}`);
  check('DB orders', dbCheck[0].cnt, EXPECTED.orders);
  check('DB sale', dbCheck[0].sale, EXPECTED.sale);
  check('DB discount', dbCheck[0].disc, EXPECTED.discount);
  check('DB tax', dbCheck[0].tax, EXPECTED.tax);

  // 1. Daily Sales Report
  console.log('\n── Daily Sales Report ──');
  const ds = await api('GET', `/orders/reports/${OUTLET_ID}/daily-sales?startDate=2026-04-07&endDate=2026-04-07`);
  if (ds.success) {
    const s = ds.data.summary;
    check('daily-sales total_sale', s.total_sale, EXPECTED.sale);
    check('daily-sales total_collection', s.total_collection, EXPECTED.sale);
    checkInt('daily-sales orders', s.total_orders, EXPECTED.orders);
    check('daily-sales discount', s.discount_amount, EXPECTED.discount);
  } else { fail++; console.log('  ❌ daily-sales failed:', ds.message); }

  // 2. Accurate DSR
  console.log('\n── Accurate DSR ──');
  const dsr = await api('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=2026-04-07&endDate=2026-04-07`);
  if (dsr.success) {
    const gt = dsr.data.grandTotal || dsr.data.summary;
    check('accurate-dsr total_sale', gt.total_sale, EXPECTED.sale);
    checkInt('accurate-dsr orders', gt.total_orders, EXPECTED.orders);
  } else { fail++; console.log('  ❌ accurate-dsr failed:', dsr.message); }

  // 3. Accurate Day End Summary
  console.log('\n── Accurate Day End Summary ──');
  const des = await api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET_ID}&startDate=2026-04-07&endDate=2026-04-07`);
  if (des.success) {
    const gt = des.data.grandTotal;
    check('day-end total_sale', gt.total_sale, EXPECTED.sale);
    checkInt('day-end orders', gt.total_orders, EXPECTED.orders);
  } else { fail++; console.log('  ❌ day-end failed:', des.message); }

  // 4. Shift History
  console.log('\n── Shift History ──');
  const sh = await api('GET', `/orders/shifts/${OUTLET_ID}/history?startDate=2026-04-07&endDate=2026-04-07`);
  if (sh.success) {
    const shifts = sh.data.shifts || sh.data.data || sh.data;
    let shiftSum = 0, shiftOrders = 0;
    if (Array.isArray(shifts)) {
      for (const s of shifts) {
        const sale = r2(s.totalSales);
        const orders = parseInt(s.totalOrders || s.completedOrders) || 0;
        shiftSum += sale;
        shiftOrders += orders;
        console.log(`    Shift #${s.id}: Rs ${sale} | ${orders} orders | ${s.cashierName} | ${s.floorName}`);
      }
      check('shift sum total_sale', shiftSum, EXPECTED.sale);
      checkInt('shift sum orders', shiftOrders, EXPECTED.orders);
    }
  } else { fail++; console.log('  ❌ shift-history failed:', sh.message); }

  // 5. Payment breakdown verification
  console.log('\n── Payment Breakdown ──');
  const [payCheck] = await pool.query(
    `SELECT payment_mode, COUNT(*) as cnt, SUM(total_amount) as total
     FROM payments WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= '2026-04-07 04:00:00' AND created_at < '2026-04-08 04:00:00'
       AND COALESCE(is_due_collection, 0) = 0
     GROUP BY payment_mode`,
    [OUTLET_ID]
  );
  console.log('  Payment modes:');
  let payTotal = 0;
  payCheck.forEach(p => { console.log(`    ${p.payment_mode}: ${p.cnt} payments, Rs ${r2(p.total)}`); payTotal += r2(p.total); });
  check('payments total (excl due)', payTotal, 53669); // 53716 - 47 due

  // 6. Due order check
  console.log('\n── Due Order Check ──');
  const [dueCheck] = await pool.query(
    `SELECT order_number, total_amount, paid_amount, due_amount, payment_status
     FROM orders WHERE outlet_id = ? AND payment_status = 'partial'
       AND created_at >= '2026-04-07 04:00:00' AND created_at < '2026-04-08 04:00:00'`,
    [OUTLET_ID]
  );
  if (dueCheck.length > 0) {
    dueCheck.forEach(d => console.log(`    ${d.order_number}: total=Rs ${d.total_amount}, paid=Rs ${d.paid_amount}, due=Rs ${d.due_amount}, status=${d.payment_status}`));
    check('due order amount', dueCheck[0].due_amount, 47);
    pass++; console.log('  ✅ Due order correctly set as partial');
  }

  // 7. Cross-check: daily-sales vs accurate-dsr
  console.log('\n── Cross-API Consistency ──');
  if (ds.success && dsr.success) {
    const dsSale = r2(ds.data.summary.total_sale);
    const dsrSale = r2((dsr.data.grandTotal || dsr.data.summary).total_sale);
    check('daily-sales vs accurate-dsr', dsSale, dsrSale);
  }

  console.log('\n' + '═'.repeat(90));
  console.log(`  RESULTS: ✅ ${pass} passed, ❌ ${fail} failed`);
  console.log('═'.repeat(90));

  if (fail === 0) {
    console.log('\n  🎉 ALL Apr 7 data imported and verified successfully!');
    console.log(`  34 orders (Rs 53,716) showing in all APIs for Apr 7`);
  }

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
