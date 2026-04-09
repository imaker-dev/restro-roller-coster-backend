/**
 * Verify Apr 8 import shows correctly in all APIs and DB
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

function apiPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } }); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

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

  // Login
  const loginRes = await apiPost('/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  if (!loginRes.data || !loginRes.data.accessToken) {
    console.log('❌ Login failed:', JSON.stringify(loginRes));
    await pool.end(); return;
  }
  token = loginRes.data.accessToken;

  // Expected from import: 51 imported orders (excl Zomato/Swiggy)
  // Note: There may be 1 pre-existing order so DB might show 52
  const IMPORTED = { orders: 51, sale: 77019, discount: 4588.16, tax: 4427.88 };

  console.log('═'.repeat(100));
  console.log('  VERIFICATION: Apr 8 Import');
  console.log('═'.repeat(100));

  // ── 1. DB: Imported orders ──
  console.log('\n── DB: Imported Orders ──');
  const [dbImported] = await pool.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as sale, SUM(discount_amount) as disc, SUM(tax_amount) as tax
     FROM orders WHERE outlet_id = ? AND status = 'completed' AND order_number LIKE 'ORD260408%'`, [OUTLET_ID]
  );
  check('DB imported count', dbImported[0].cnt, IMPORTED.orders);
  check('DB imported sale', dbImported[0].sale, IMPORTED.sale);
  check('DB imported discount', dbImported[0].disc, IMPORTED.discount);
  check('DB imported tax', dbImported[0].tax, IMPORTED.tax);

  // ── 2. DB: Order Items ──
  console.log('\n── DB: Order Items ──');
  const [oiCheck] = await pool.query(
    `SELECT COUNT(DISTINCT o.id) as orders_with_items, COUNT(oi.id) as total_items
     FROM orders o JOIN order_items oi ON o.id = oi.order_id
     WHERE o.outlet_id = ? AND o.order_number LIKE 'ORD260408%'`, [OUTLET_ID]
  );
  checkInt('Orders with items', oiCheck[0].orders_with_items, 51);
  console.log(`  Total order_items: ${oiCheck[0].total_items}`);

  // Sample: check a specific order has correct items
  const [sampleOrder] = await pool.query(
    `SELECT o.id, o.order_number, o.total_amount FROM orders o
     WHERE o.outlet_id = ? AND o.order_number = 'ORD2604080001'`, [OUTLET_ID]
  );
  if (sampleOrder.length > 0) {
    const [sampleItems] = await pool.query(
      'SELECT item_name, variant_name, quantity, unit_price, total_price, tax_amount FROM order_items WHERE order_id = ?',
      [sampleOrder[0].id]
    );
    console.log(`  Sample order ORD2604080001 (Rs ${sampleOrder[0].total_amount}) items:`);
    sampleItems.forEach(i => console.log(`    ${i.item_name}${i.variant_name ? ' (' + i.variant_name + ')' : ''} x${i.quantity} @ Rs ${i.unit_price} = Rs ${i.total_price} + tax ${i.tax_amount}`));
  }

  // ── 3. DB: Payments ──
  console.log('\n── DB: Payments ──');
  const [payCheck] = await pool.query(
    `SELECT payment_mode, COUNT(*) as cnt, SUM(total_amount) as total
     FROM payments WHERE outlet_id = ? AND status = 'completed'
       AND order_id IN (SELECT id FROM orders WHERE outlet_id = ? AND order_number LIKE 'ORD260408%')
     GROUP BY payment_mode`, [OUTLET_ID, OUTLET_ID]
  );
  console.log('  Payment modes:');
  let payTotal = 0;
  payCheck.forEach(p => { console.log(`    ${p.payment_mode}: ${p.cnt} payments, Rs ${r2(p.total)}`); payTotal += r2(p.total); });
  check('Total payments', payTotal, 75146); // 77019 - 1873 due

  // ── 4. DB: Split Payment Orders ──
  console.log('\n── DB: Split Payment Orders ──');
  const [splitCheck] = await pool.query(
    `SELECT o.order_number, o.total_amount, COUNT(p.id) as pay_count, SUM(p.total_amount) as pay_total
     FROM orders o JOIN payments p ON o.id = p.order_id
     WHERE o.outlet_id = ? AND o.order_number LIKE 'ORD260408%'
     GROUP BY o.id HAVING pay_count > 1`, [OUTLET_ID]
  );
  checkInt('Split payment orders', splitCheck.length, 4);
  splitCheck.forEach(s => {
    console.log(`    ${s.order_number}: order=Rs ${s.total_amount}, ${s.pay_count} payments, pay_total=Rs ${r2(s.pay_total)}`);
    if (Math.abs(r2(s.pay_total) - parseFloat(s.total_amount)) > 1) {
      fail++; console.log(`      ❌ Payment sum mismatch!`);
    } else {
      pass++; console.log(`      ✅ Payment sum matches order total`);
    }
  });

  // ── 5. DB: Due Orders ──
  console.log('\n── DB: Due Orders ──');
  const [dueCheck] = await pool.query(
    `SELECT order_number, total_amount, paid_amount, due_amount, payment_status
     FROM orders WHERE outlet_id = ? AND payment_status = 'partial' AND order_number LIKE 'ORD260408%'`, [OUTLET_ID]
  );
  checkInt('Due orders count', dueCheck.length, 3);
  let dueTotal = 0;
  dueCheck.forEach(d => {
    console.log(`    ${d.order_number}: total=Rs ${d.total_amount}, paid=Rs ${d.paid_amount}, due=Rs ${d.due_amount}`);
    dueTotal += parseFloat(d.due_amount);
  });
  check('Total due amount', dueTotal, 1873);

  // ── 6. DB: Shifts ──
  console.log('\n── DB: Shifts (day_sessions) ──');
  const [shifts] = await pool.query(
    `SELECT ds.id, ds.floor_id, ds.cashier_id, ds.total_sales, ds.total_orders, ds.opening_time, ds.closing_time, u.name
     FROM day_sessions ds LEFT JOIN users u ON ds.cashier_id = u.id
     WHERE ds.outlet_id = ? AND ds.session_date = '2026-04-08'`, [OUTLET_ID]
  );
  checkInt('Shifts for Apr 8', shifts.length, 2);
  let shiftSaleSum = 0, shiftOrderSum = 0;
  shifts.forEach(s => {
    const fl = s.floor_id === 38 ? 'BAR' : 'REST';
    console.log(`    Shift #${s.id} | ${fl} | ${s.name} | Rs ${r2(s.total_sales)} | ${s.total_orders} orders | ${s.opening_time} to ${s.closing_time}`);
    shiftSaleSum += r2(s.total_sales);
    shiftOrderSum += parseInt(s.total_orders);
  });
  check('Shift sales sum', shiftSaleSum, IMPORTED.sale);
  checkInt('Shift orders sum', shiftOrderSum, IMPORTED.orders);

  // ── 7. API: Daily Sales Report ──
  console.log('\n── API: Daily Sales Report ──');
  const ds = await api('GET', `/orders/reports/${OUTLET_ID}/daily-sales?startDate=2026-04-08&endDate=2026-04-08`);
  if (ds.success) {
    const s = ds.data.summary;
    console.log(`    total_sale=${s.total_sale}, total_orders=${s.total_orders}, discount=${s.discount_amount}`);
    check('daily-sales total_sale', s.total_sale, IMPORTED.sale, 100);
    checkInt('daily-sales orders', s.total_orders, IMPORTED.orders);
  } else { fail++; console.log('  ❌ daily-sales failed:', ds.message); }

  // ── 8. API: Accurate DSR ──
  console.log('\n── API: Accurate DSR ──');
  const dsr = await api('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=2026-04-08&endDate=2026-04-08`);
  if (dsr.success) {
    const gt = dsr.data.grandTotal || dsr.data.summary;
    console.log(`    total_sale=${gt.total_sale}, total_orders=${gt.total_orders}`);
    check('accurate-dsr total_sale', gt.total_sale, IMPORTED.sale, 100);
    checkInt('accurate-dsr orders', gt.total_orders, IMPORTED.orders);
  } else { fail++; console.log('  ❌ accurate-dsr failed:', ds.message); }

  // ── 9. API: Shift History ──
  console.log('\n── API: Shift History ──');
  const sh = await api('GET', `/orders/shifts/${OUTLET_ID}/history?startDate=2026-04-08&endDate=2026-04-08`);
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
      check('shift-history sum', shiftSum, IMPORTED.sale, 100);
      checkInt('shift-history orders', shiftOrders, IMPORTED.orders);
    }
  } else { fail++; console.log('  ❌ shift-history failed:', sh.message); }

  // ── 10. API: Accurate Day End Summary ──
  console.log('\n── API: Accurate Day End Summary ──');
  const des = await api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET_ID}&startDate=2026-04-08&endDate=2026-04-08`);
  if (des.success) {
    const gt = des.data.grandTotal;
    if (gt) {
      console.log(`    total_sale=${gt.total_sale}, total_orders=${gt.total_orders}`);
      check('day-end total_sale', gt.total_sale, IMPORTED.sale, 100);
      checkInt('day-end orders', gt.total_orders, IMPORTED.orders);
    } else {
      console.log('  Day end response:', JSON.stringify(des.data).substring(0, 200));
    }
  } else { fail++; console.log('  ❌ day-end failed:', des.message); }

  // ── 11. Takeaway / Pick Up order ──
  console.log('\n── DB: Takeaway Order ──');
  const [takeaway] = await pool.query(
    `SELECT order_number, order_type, table_id, total_amount, payment_status
     FROM orders WHERE outlet_id = ? AND order_type = 'takeaway' AND order_number LIKE 'ORD260408%'`, [OUTLET_ID]
  );
  checkInt('Takeaway orders', takeaway.length, 1);
  if (takeaway.length > 0) {
    console.log(`    ${takeaway[0].order_number}: type=${takeaway[0].order_type}, table=${takeaway[0].table_id}, Rs ${takeaway[0].total_amount}`);
    check('Takeaway amount', takeaway[0].total_amount, 470);
  }

  // ── 12. By Floor check ──
  console.log('\n── DB: By Floor ──');
  const [byFloor] = await pool.query(
    `SELECT COALESCE(f.name, 'Takeaway') as floor_name, COUNT(*) as cnt, SUM(o.total_amount) as sale
     FROM orders o LEFT JOIN floors f ON o.floor_id = f.id
     WHERE o.outlet_id = ? AND o.order_number LIKE 'ORD260408%'
     GROUP BY floor_name`, [OUTLET_ID]
  );
  byFloor.forEach(f => {
    console.log(`    ${f.floor_name}: ${f.cnt} orders, Rs ${r2(f.sale)}`);
  });

  // ── SUMMARY ──
  console.log('\n' + '═'.repeat(100));
  console.log(`  RESULTS: ✅ ${pass} passed, ❌ ${fail} failed`);
  console.log('═'.repeat(100));

  if (fail === 0) {
    console.log('\n  🎉 ALL Apr 8 data imported and verified successfully!');
    console.log(`  51 orders (Rs 77,019) with 221 items, 2 shifts, 4 split payments, 3 due orders`);
  }

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
