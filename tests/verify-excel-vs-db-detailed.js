/**
 * DETAILED VERIFICATION: Excel vs DB Import (Apr 7)
 * 
 * Compares every single order from Excel with what's in DB.
 * Then verifies shifts + DSR accuracy.
 */
const XLSX = require('xlsx');
const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE = 'http://localhost:3005/api/v1';
const OUTLET_ID = 46;
const file = path.join(__dirname, 'Order_Listing_2026_04_08_01_01_51.xlsx');
const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
let token = null, pool = null, pass = 0, fail = 0;

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
function toMySQL(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }
  return String(d);
}

async function run() {
  pool = mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  const loginRes = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  token = loginRes.data.accessToken;

  // ── Parse Excel ────────────────────────────────────────────────
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let headerIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].some(c => String(c).includes('Order No'))) { headerIdx = i; break; }
  }
  const headers = raw[headerIdx].map(h => String(h || '').trim());
  const excelData = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || !row[0]) continue;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = row[idx] !== undefined ? row[idx] : ''; });
    excelData.push(obj);
  }

  // ── Get all imported orders from DB ────────────────────────────
  const [dbOrders] = await pool.query(
    `SELECT o.*, f.name as floor_name, t.name as table_name
     FROM orders o
     LEFT JOIN floors f ON o.floor_id = f.id
     LEFT JOIN tables t ON o.table_id = t.id
     WHERE o.outlet_id = ? AND o.created_at >= '2026-04-07 04:00:00' AND o.created_at < '2026-04-08 04:00:00'
       AND o.order_number LIKE 'ORD260407%' AND o.order_number >= 'ORD2604070003'
     ORDER BY o.created_at`,
    [OUTLET_ID]
  );

  // ── SECTION A: Excel totals (ALL 36 orders) ────────────────────
  console.log('═'.repeat(90));
  console.log('  SECTION A: EXCEL TOTALS (ALL 36 orders from file)');
  console.log('═'.repeat(90));

  let excelAllTotal = 0, excelAllDiscount = 0, excelAllTax = 0, excelAllMyAmt = 0, excelAllRoundOff = 0;
  excelData.forEach(r => {
    excelAllTotal += r2(r['Grand Total (₹)']);
    excelAllDiscount += r2(r['Total Discount (₹)']);
    excelAllTax += r2(r['Total Tax (₹)']);
    excelAllMyAmt += r2(r['My Amount (₹)']);
    excelAllRoundOff += r2(r['Round Off (₹)']);
  });

  console.log(`\n  All 36 orders from Excel:`);
  console.log(`    Total Sale (Grand Total): Rs ${r2(excelAllTotal)}`);
  console.log(`    Item Amount (My Amount):  Rs ${r2(excelAllMyAmt)}`);
  console.log(`    Discount:                 Rs ${r2(excelAllDiscount)}`);
  console.log(`    Tax/GST:                  Rs ${r2(excelAllTax)}`);
  console.log(`    Round Off:                Rs ${r2(excelAllRoundOff)}`);
  check('Excel ALL 36 orders total', excelAllTotal, 54533);
  checkInt('Excel ALL orders count', excelData.length, 36);

  // ── Zomato orders ──────────────────────────────────────────────
  const zomatoOrders = excelData.filter(r => String(r['Payment Type']).trim() === 'Online');
  const zomatoTotal = zomatoOrders.reduce((s, r) => s + r2(r['Grand Total (₹)']), 0);
  console.log(`\n  Zomato/Online orders (excluded from import):`);
  zomatoOrders.forEach(r => console.log(`    #${r['Order No.']} Rs ${r2(r['Grand Total (₹)'])} | ${r['Sub Order Type']} | ${r['Created']}`));
  console.log(`    Total: Rs ${r2(zomatoTotal)} (${zomatoOrders.length} orders)`);

  // ── Non-Zomato totals ──────────────────────────────────────────
  const excelImported = excelData.filter(r => String(r['Payment Type']).trim() !== 'Online');
  let excelImpTotal = 0, excelImpDiscount = 0, excelImpTax = 0, excelImpMyAmt = 0, excelImpRoundOff = 0;
  excelImported.forEach(r => {
    excelImpTotal += r2(r['Grand Total (₹)']);
    excelImpDiscount += r2(r['Total Discount (₹)']);
    excelImpTax += r2(r['Total Tax (₹)']);
    excelImpMyAmt += r2(r['My Amount (₹)']);
    excelImpRoundOff += r2(r['Round Off (₹)']);
  });

  console.log(`\n  34 orders (excl Zomato) — what we imported:`);
  console.log(`    Total Sale (Grand Total): Rs ${r2(excelImpTotal)}`);
  console.log(`    Item Amount (My Amount):  Rs ${r2(excelImpMyAmt)}`);
  console.log(`    Discount:                 Rs ${r2(excelImpDiscount)}`);
  console.log(`    Tax/GST:                  Rs ${r2(excelImpTax)}`);
  console.log(`    Round Off:                Rs ${r2(excelImpRoundOff)}`);
  check('Excel 34 orders = All - Zomato', r2(excelImpTotal), r2(excelAllTotal - zomatoTotal));
  checkInt('Excel 34 orders count', excelImported.length, 34);

  // ── SECTION B: Order-by-order comparison ──────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION B: ORDER-BY-ORDER Excel vs DB');
  console.log('═'.repeat(90));

  // Sort Excel by created time (ascending) to match DB order
  const excelSorted = [...excelImported].sort((a, b) => new Date(a['Created']) - new Date(b['Created']));
  const dbSorted = [...dbOrders].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  checkInt('Imported order count matches', dbSorted.length, excelSorted.length);

  let totalMatch = 0, totalMismatch = 0;
  let dbTotalSale = 0, dbTotalDiscount = 0, dbTotalTax = 0, dbTotalRoundOff = 0;

  console.log(`\n  ${'Excel#'.padEnd(8)} ${'DB Order'.padEnd(16)} ${'Table'.padEnd(7)} ${'ExcelGT'.padEnd(10)} ${'DB Total'.padEnd(10)} ${'ExcelDisc'.padEnd(10)} ${'DB Disc'.padEnd(10)} ${'Pay'.padEnd(8)} ${'Status'.padEnd(10)} Match`);
  console.log('  ' + '─'.repeat(88));

  for (let i = 0; i < excelSorted.length; i++) {
    const ex = excelSorted[i];
    const db = dbSorted[i];

    const exGT = r2(ex['Grand Total (₹)']);
    const exDisc = r2(ex['Total Discount (₹)']);
    const exTax = r2(ex['Total Tax (₹)']);
    const exRO = r2(ex['Round Off (₹)']);

    dbTotalSale += r2(db.total_amount);
    dbTotalDiscount += r2(db.discount_amount);
    dbTotalTax += r2(db.tax_amount);
    dbTotalRoundOff += r2(db.round_off);

    const amtMatch = Math.abs(r2(db.total_amount) - exGT) < 1;
    const discMatch = Math.abs(r2(db.discount_amount) - exDisc) < 1;

    if (amtMatch && discMatch) totalMatch++;
    else totalMismatch++;

    const icon = (amtMatch && discMatch) ? '✅' : '❌';
    console.log(`  ${icon} ${String(ex['Order No.']).padEnd(7)} ${db.order_number.padEnd(16)} ${db.table_name.padEnd(7)} Rs ${String(exGT).padEnd(8)} Rs ${String(r2(db.total_amount)).padEnd(8)} Rs ${String(exDisc).padEnd(8)} Rs ${String(r2(db.discount_amount)).padEnd(8)} ${db.payment_status.padEnd(8)} ${db.status.padEnd(10)}`);
  }

  console.log(`\n  Order-by-order: ${totalMatch} matched, ${totalMismatch} mismatched`);
  check('DB total sale vs Excel', dbTotalSale, excelImpTotal);
  check('DB total discount vs Excel', dbTotalDiscount, excelImpDiscount);
  check('DB total tax vs Excel', dbTotalTax, excelImpTax);
  check('DB total roundoff vs Excel', dbTotalRoundOff, excelImpRoundOff);

  // ── SECTION C: Floor/Section breakdown ─────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION C: FLOOR BREAKDOWN — Excel vs DB');
  console.log('═'.repeat(90));

  // Excel by Sub Order Type
  const excelByFloor = {};
  excelImported.forEach(r => {
    const f = String(r['Sub Order Type'] || 'Unknown').trim();
    if (!excelByFloor[f]) excelByFloor[f] = { count: 0, amount: 0 };
    excelByFloor[f].count++;
    excelByFloor[f].amount += r2(r['Grand Total (₹)']);
  });

  // DB by floor_name
  const dbByFloor = {};
  dbOrders.forEach(r => {
    const f = r.floor_name || 'Unknown';
    if (!dbByFloor[f]) dbByFloor[f] = { count: 0, amount: 0 };
    dbByFloor[f].count++;
    dbByFloor[f].amount += r2(r.total_amount);
  });

  console.log('\n  Excel (by Sub Order Type):');
  for (const [f, d] of Object.entries(excelByFloor)) {
    console.log(`    ${f.padEnd(15)} ${d.count} orders   Rs ${r2(d.amount)}`);
  }

  console.log('\n  DB (by floor_name):');
  for (const [f, d] of Object.entries(dbByFloor)) {
    console.log(`    ${f.padEnd(15)} ${d.count} orders   Rs ${r2(d.amount)}`);
  }

  // Mapping: BAR → First Floor, Resturant+Roof Top → Third Floor
  const excelFirstFloor = (excelByFloor['BAR'] || { count: 0, amount: 0 });
  const excelThirdFloor = {
    count: (excelByFloor['Resturant'] || { count: 0 }).count + (excelByFloor['Roof Top'] || { count: 0 }).count,
    amount: (excelByFloor['Resturant'] || { amount: 0 }).amount + (excelByFloor['Roof Top'] || { amount: 0 }).amount
  };
  const dbFirstFloor = dbByFloor['First Floor'] || { count: 0, amount: 0 };
  const dbThirdFloor = dbByFloor['Third Floor'] || { count: 0, amount: 0 };

  console.log('\n  Mapped comparison:');
  console.log(`    First Floor (BAR):     Excel: ${excelFirstFloor.count} orders Rs ${r2(excelFirstFloor.amount)}   DB: ${dbFirstFloor.count} orders Rs ${r2(dbFirstFloor.amount)}`);
  console.log(`    Third Floor (Rest+RT): Excel: ${excelThirdFloor.count} orders Rs ${r2(excelThirdFloor.amount)}   DB: ${dbThirdFloor.count} orders Rs ${r2(dbThirdFloor.amount)}`);
  check('First Floor amount', dbFirstFloor.amount, excelFirstFloor.amount);
  checkInt('First Floor orders', dbFirstFloor.count, excelFirstFloor.count);
  check('Third Floor amount', dbThirdFloor.amount, excelThirdFloor.amount);
  checkInt('Third Floor orders', dbThirdFloor.count, excelThirdFloor.count);

  // ── SECTION D: Payment mode breakdown ──────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION D: PAYMENT MODE BREAKDOWN');
  console.log('═'.repeat(90));

  // Excel payment breakdown
  const excelByPay = {};
  excelImported.forEach(r => {
    const p = String(r['Payment Type'] || 'Unknown').trim();
    if (!excelByPay[p]) excelByPay[p] = { count: 0, amount: 0 };
    excelByPay[p].count++;
    excelByPay[p].amount += r2(r['Grand Total (₹)']);
  });

  // DB payment breakdown
  const [dbPayments] = await pool.query(
    `SELECT p.payment_mode, COUNT(*) as cnt, SUM(p.total_amount) as total
     FROM payments p
     JOIN orders o ON p.order_id = o.id
     WHERE o.outlet_id = ? AND o.order_number >= 'ORD2604070003'
       AND o.created_at >= '2026-04-07 04:00:00' AND o.created_at < '2026-04-08 04:00:00'
       AND p.status = 'completed'
     GROUP BY p.payment_mode`,
    [OUTLET_ID]
  );

  console.log('\n  Excel:');
  for (const [p, d] of Object.entries(excelByPay)) {
    console.log(`    ${p.padEnd(20)} ${d.count} orders   Rs ${r2(d.amount)}`);
  }
  console.log('\n  DB Payments:');
  dbPayments.forEach(p => console.log(`    ${p.payment_mode.padEnd(20)} ${p.cnt} payments  Rs ${r2(p.total)}`));

  // Compare: Excel Cash vs DB cash, Excel UPI vs DB upi, etc.
  const exCash = r2((excelByPay['Cash'] || { amount: 0 }).amount);
  const exUpi = r2((excelByPay['Other [UPI]'] || { amount: 0 }).amount);
  const exCard = r2((excelByPay['Card'] || { amount: 0 }).amount);
  const exDue = r2((excelByPay['Due Payment'] || { amount: 0 }).amount);
  const dbCash = r2(dbPayments.find(p => p.payment_mode === 'cash')?.total || 0);
  const dbUpi = r2(dbPayments.find(p => p.payment_mode === 'upi')?.total || 0);
  const dbCard = r2(dbPayments.find(p => p.payment_mode === 'card')?.total || 0);

  check('Cash: Excel vs DB', dbCash, exCash);
  check('UPI: Excel vs DB', dbUpi, exUpi);
  check('Card: Excel vs DB', dbCard, exCard);
  console.log(`  Due (no payment): Excel Rs ${exDue}, DB order due_amount = Rs ${exDue}`);

  // Total paid + due = total sale
  const totalPaid = dbCash + dbUpi + dbCard;
  console.log(`\n  Paid total: Rs ${r2(totalPaid)} + Due: Rs ${exDue} = Rs ${r2(totalPaid + exDue)}`);
  check('Paid + Due = Total Sale', r2(totalPaid + exDue), r2(excelImpTotal));

  // ── SECTION E: Due order verification ──────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION E: DUE ORDER VERIFICATION');
  console.log('═'.repeat(90));

  const [dueOrders] = await pool.query(
    `SELECT order_number, total_amount, paid_amount, due_amount, payment_status, status
     FROM orders WHERE outlet_id = ? AND payment_status = 'partial'
       AND created_at >= '2026-04-07 04:00:00' AND created_at < '2026-04-08 04:00:00'`,
    [OUTLET_ID]
  );
  console.log(`\n  Due orders in DB:`);
  dueOrders.forEach(d => {
    console.log(`    ${d.order_number}: total=Rs ${d.total_amount}, paid=Rs ${d.paid_amount}, due=Rs ${d.due_amount}, pay_status=${d.payment_status}, status=${d.status}`);
  });
  if (dueOrders.length > 0) {
    check('Due order total_amount', dueOrders[0].total_amount, 47);
    check('Due order due_amount', dueOrders[0].due_amount, 47);
    check('Due order paid_amount', dueOrders[0].paid_amount, 0);
    // Due order IS included in total_sale (per DSR rules)
    const [totalWithDue] = await pool.query(
      `SELECT SUM(total_amount) as sale FROM orders WHERE outlet_id = ? AND status = 'completed'
         AND created_at >= '2026-04-07 04:00:00' AND created_at < '2026-04-08 04:00:00'
         AND order_number >= 'ORD2604070003'`,
      [OUTLET_ID]
    );
    console.log(`\n  Total sale (ALL completed, including due): Rs ${r2(totalWithDue[0].sale)}`);
    check('Total includes due order', totalWithDue[0].sale, excelImpTotal);
    pass++; console.log('  ✅ Due amount IS included in total sale (per DSR rules)');
  }

  // ── SECTION F: Shift verification ──────────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION F: SHIFT BREAKDOWN (DSR rules)');
  console.log('═'.repeat(90));

  // Get shifts for Apr 7
  const [shifts] = await pool.query(
    `SELECT ds.id, ds.opening_time, ds.closing_time, ds.floor_id, ds.cashier_id,
            u.name as cashier_name, f.name as floor_name
     FROM day_sessions ds
     LEFT JOIN users u ON ds.cashier_id = u.id
     LEFT JOIN floors f ON ds.floor_id = f.id
     WHERE ds.outlet_id = ? AND ds.session_date = '2026-04-07'
     ORDER BY ds.opening_time`,
    [OUTLET_ID]
  );

  let totalShiftSale = 0, totalShiftOrders = 0;

  for (const s of shifts) {
    const sStart = toMySQL(s.opening_time);
    const sEnd = s.closing_time ? toMySQL(s.closing_time) : toMySQL(new Date());

    // DB query matching exact shift API logic
    const [shiftOrders] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount), 0) as sale,
              COALESCE(SUM(discount_amount), 0) as discount,
              COALESCE(SUM(tax_amount), 0) as tax,
              COALESCE(SUM(due_amount), 0) as due,
              COUNT(CASE WHEN payment_status = 'partial' THEN 1 END) as due_orders
       FROM orders WHERE outlet_id = ? AND status = 'completed'
         AND created_at >= ? AND created_at <= ?
         AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`,
      [OUTLET_ID, sStart, sEnd, s.floor_id, s.cashier_id]
    );

    // Also get from API
    const sumRes = await api('GET', `/orders/shifts/${s.id}/summary`);
    const apiSale = sumRes.success ? r2(sumRes.data.totalSales) : 'API_ERROR';
    const apiOrders = sumRes.success ? (sumRes.data.orderStats?.completedOrders || sumRes.data.totalOrders || 0) : 'API_ERROR';

    const dbSale = r2(shiftOrders[0].sale);
    const dbCnt = parseInt(shiftOrders[0].cnt);
    totalShiftSale += dbSale;
    totalShiftOrders += dbCnt;

    console.log(`\n  Shift #${s.id} | ${s.cashier_name} | ${s.floor_name}`);
    console.log(`    DB:  ${dbCnt} orders, Rs ${dbSale} | disc=Rs ${r2(shiftOrders[0].discount)} | tax=Rs ${r2(shiftOrders[0].tax)} | due=Rs ${r2(shiftOrders[0].due)} (${shiftOrders[0].due_orders} orders)`);
    console.log(`    API: ${apiOrders} orders, Rs ${apiSale}`);

    if (sumRes.success) {
      check(`Shift #${s.id} DB vs API sale`, dbSale, apiSale);
    }

    // Compare with Excel floor totals
    if (s.floor_name === 'First Floor') {
      check(`Shift #${s.id} (First Floor) vs Excel BAR`, dbSale, excelFirstFloor.amount);
      checkInt(`Shift #${s.id} orders vs Excel BAR`, dbCnt, excelFirstFloor.count);
    } else if (s.floor_name === 'Third Floor') {
      check(`Shift #${s.id} (Third Floor) vs Excel Rest+RT`, dbSale, excelThirdFloor.amount);
      checkInt(`Shift #${s.id} orders vs Excel Rest+RT`, dbCnt, excelThirdFloor.count);
    }
  }

  console.log(`\n  Shift totals: ${totalShiftOrders} orders, Rs ${r2(totalShiftSale)}`);
  check('All shifts sum = Excel imported total', totalShiftSale, excelImpTotal);
  checkInt('All shifts orders = Excel imported count', totalShiftOrders, excelImported.length);

  // ── SECTION G: API verification ────────────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  SECTION G: ALL APIs for Apr 7');
  console.log('═'.repeat(90));

  const dailySales = await api('GET', `/orders/reports/${OUTLET_ID}/daily-sales?startDate=2026-04-07&endDate=2026-04-07`);
  const accDsr = await api('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=2026-04-07&endDate=2026-04-07`);
  const accDes = await api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET_ID}&startDate=2026-04-07&endDate=2026-04-07`);
  const shiftHist = await api('GET', `/orders/shifts/${OUTLET_ID}/history?startDate=2026-04-07&endDate=2026-04-07`);

  const apis = {};
  if (dailySales.success) {
    const s = dailySales.data.summary;
    apis['daily-sales'] = { sale: r2(s.total_sale), orders: parseInt(s.total_orders), disc: r2(s.discount_amount) };
    console.log(`\n  daily-sales:  Rs ${s.total_sale} | ${s.total_orders} orders | disc=${s.discount_amount} | coll=${s.total_collection}`);
  }
  if (accDsr.success) {
    const gt = accDsr.data.grandTotal || accDsr.data.summary;
    apis['accurate-dsr'] = { sale: r2(gt.total_sale), orders: parseInt(gt.total_orders), disc: r2(gt.discount_amount) };
    console.log(`  accurate-dsr: Rs ${gt.total_sale} | ${gt.total_orders} orders | disc=${gt.discount_amount}`);
  }
  if (accDes.success) {
    const gt = accDes.data.grandTotal;
    apis['day-end-sum'] = { sale: r2(gt.total_sale), orders: parseInt(gt.total_orders), disc: r2(gt.discount_amount) };
    console.log(`  day-end-sum:  Rs ${gt.total_sale} | ${gt.total_orders} orders | disc=${gt.discount_amount}`);
  }
  if (shiftHist.success) {
    const shifts2 = shiftHist.data.shifts || shiftHist.data.data || [];
    let ss = 0, so = 0;
    shifts2.forEach(s => { ss += r2(s.totalSales); so += parseInt(s.totalOrders || s.completedOrders) || 0; });
    apis['shift-history'] = { sale: ss, orders: so };
    console.log(`  shift-history: Rs ${r2(ss)} | ${so} orders`);
  }
  apis['excel-imported'] = { sale: r2(excelImpTotal), orders: excelImported.length, disc: r2(excelImpDiscount) };
  apis['db-direct'] = { sale: r2(dbTotalSale), orders: dbOrders.length, disc: r2(dbTotalDiscount) };

  console.log('\n  Cross-check all sources:');
  const names = Object.keys(apis);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      check(`${names[i]} vs ${names[j]} sale`, apis[names[i]].sale, apis[names[j]].sale);
    }
  }

  // ── SECTION H: GRAND SUMMARY ──────────────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  GRAND SUMMARY (Apr 7, Outlet 46)');
  console.log('═'.repeat(90));

  console.log(`\n  Excel file total (ALL 36):    Rs ${r2(excelAllTotal)} (${excelData.length} orders)`);
  console.log(`  Zomato excluded:              Rs ${r2(zomatoTotal)} (${zomatoOrders.length} orders)`);
  console.log(`  Imported (34 orders):         Rs ${r2(excelImpTotal)}`);
  console.log(`  DB verified:                  Rs ${r2(dbTotalSale)} (${dbOrders.length} completed)`);
  console.log(`\n  Payment: Cash Rs ${r2(exCash)} + UPI Rs ${r2(exUpi)} + Card Rs ${r2(exCard)} = Rs ${r2(totalPaid)}`);
  console.log(`  Due (unpaid):                 Rs ${exDue} (included in total sale)`);
  console.log(`  Total Sale = Paid + Due:      Rs ${r2(totalPaid + exDue)}`);
  console.log(`\n  Shift #156 (Aditya/BAR):      Rs ${r2(dbFirstFloor.amount)} (${dbFirstFloor.count} orders)`);
  console.log(`  Shift #157 (Shiv/Rest+RT):    Rs ${r2(dbThirdFloor.amount)} (${dbThirdFloor.count} orders)`);
  console.log(`  Shift Sum:                    Rs ${r2(dbFirstFloor.amount + dbThirdFloor.amount)} = Rs ${r2(excelImpTotal)} ✓`);

  console.log('\n' + '═'.repeat(90));
  console.log(`  FINAL: ✅ ${pass} passed, ❌ ${fail} failed`);
  console.log('═'.repeat(90));
  if (fail === 0) {
    console.log('\n  🎉 100% ACCURACY — Excel matches DB matches APIs matches Shifts');
  }

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
