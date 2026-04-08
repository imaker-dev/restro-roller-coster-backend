/**
 * Cross-verification: /api/v1/orders/shifts/:id/detail for all outlet 46 shifts (Apr 1-6)
 * Checks each API field against direct DB queries
 */
const mysql = require('mysql2/promise');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dc = require('../src/config/database.config');

function api(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL('http://localhost:3005/api/v1' + url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } }); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const pool = await mysql.createPool({ host: dc.host, port: dc.port, user: dc.user, password: dc.password, database: dc.database });
  const lr = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  const token = lr.data.accessToken;

  const SHIFT_IDS = [140, 141, 143, 144, 145, 146, 149, 150, 151, 152, 153, 155];
  let grandPass = 0, grandFail = 0;
  const results = [];

  for (const sid of SHIFT_IDS) {
    const res = await api('GET', '/orders/shifts/' + sid + '/detail', null, token);
    const d = res.data;
    const S = d.openingTime, E = d.closingTime;
    const FID = d.floorId, CID = d.cashierId, OID = d.outletId;

    // Build floor filter conditions
    const ofc = FID ? 'AND (floor_id = ? OR (floor_id IS NULL AND order_type IN (?, ?) AND created_by = ?))' : '';
    const ofp = FID ? [FID, 'takeaway', 'delivery', CID] : [];
    const fc = FID ? 'AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != ? AND o.created_by = ?))' : '';
    const fp = FID ? [FID, 'dine_in', CID] : [];

    let pass = 0, fail = 0;
    const failures = [];
    const chk = (name, apiVal, dbVal) => {
      if (Math.abs(apiVal - dbVal) < 0.02) { pass++; }
      else { fail++; failures.push(`${name}: api=${apiVal} db=${dbVal} diff=${(apiVal - dbVal).toFixed(2)}`); }
    };

    // === 1. Order totals ===
    const [os] = await pool.query(
      `SELECT 
        SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as comp,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as canc,
        COUNT(*) as all_orders,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(discount_amount, 0) ELSE 0 END) as disc,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(subtotal, 0) ELSE 0 END) as sub,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(tax_amount, 0) ELSE 0 END) as tax,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(round_off, 0) ELSE 0 END) as roff,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(service_charge, 0) ELSE 0 END) as svc,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(packaging_charge, 0) ELSE 0 END) as pkg,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(paid_amount, 0) ELSE 0 END) as paid,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(due_amount, 0) ELSE 0 END) as due
       FROM orders WHERE outlet_id = ? AND created_at >= ? AND created_at <= ? ${ofc}`,
      [OID, S, E, ...ofp]
    );

    chk('totalSales', d.totalSales, parseFloat(os[0].total || 0));
    chk('totalOrders', d.totalOrders, parseInt(os[0].comp || 0));
    chk('totalDiscounts', d.totalDiscounts, parseFloat(os[0].disc || 0));
    chk('completedOrders', parseInt(d.orderStats.completedOrders), parseInt(os[0].comp || 0));
    chk('cancelledOrders', parseInt(d.orderStats.cancelledOrders), parseInt(os[0].canc || 0));
    chk('allOrders', parseInt(d.orderStats.totalOrders), parseInt(os[0].all_orders || 0));

    // === 2. Sale Bifurcation ===
    const sb = d.saleBifurcation;
    chk('subtotal', sb.subtotal, parseFloat(os[0].sub || 0));
    chk('discount', sb.discount, parseFloat(os[0].disc || 0));
    chk('tax', sb.tax, parseFloat(os[0].tax || 0));
    chk('roundOff', sb.roundOff, parseFloat(os[0].roff || 0));
    chk('serviceCharge', sb.serviceCharge, parseFloat(os[0].svc || 0));
    chk('packagingCharge', sb.packagingCharge, parseFloat(os[0].pkg || 0));
    chk('paidFromOrders', sb.totalPaidFromOrders, parseFloat(os[0].paid || 0));
    chk('dueFromOrders', sb.totalDue, parseFloat(os[0].due || 0));

    // Formula: sub - disc + tax + svc + pkg + roff = totalSale
    const calc = sb.subtotal - sb.discount + sb.tax + sb.serviceCharge + sb.packagingCharge + sb.roundOff;
    chk('formula=totalSale', parseFloat(calc.toFixed(2)), d.totalSales);

    // === 3. Payment Collection ===
    const [regPay] = await pool.query(
      `SELECT p.payment_mode, SUM(p.total_amount) as amt
       FROM payments p JOIN orders o ON p.order_id = o.id LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
         AND p.status = 'completed' AND p.payment_mode != 'split'
         AND COALESCE(p.is_due_collection, 0) = 0 ${fc}
       GROUP BY p.payment_mode`,
      [OID, S, E, ...fp]
    );
    const [splPay] = await pool.query(
      `SELECT sp.payment_mode, SUM(sp.amount) as amt
       FROM split_payments sp JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
         AND p.status = 'completed' AND p.payment_mode = 'split'
         AND COALESCE(p.is_due_collection, 0) = 0 ${fc}
       GROUP BY sp.payment_mode`,
      [OID, S, E, ...fp]
    );

    let dbCash = 0, dbCard = 0, dbUpi = 0, dbWallet = 0, dbCredit = 0;
    for (const p of regPay) {
      const amt = parseFloat(p.amt || 0);
      if (p.payment_mode === 'cash') dbCash += amt;
      else if (p.payment_mode === 'card') dbCard += amt;
      else if (p.payment_mode === 'upi') dbUpi += amt;
      else if (p.payment_mode === 'wallet') dbWallet += amt;
      else if (p.payment_mode === 'credit') dbCredit += amt;
    }
    for (const s of splPay) {
      const amt = parseFloat(s.amt || 0);
      if (s.payment_mode === 'cash') dbCash += amt;
      else if (s.payment_mode === 'card') dbCard += amt;
      else if (s.payment_mode === 'upi') dbUpi += amt;
      else if (s.payment_mode === 'wallet') dbWallet += amt;
      else if (s.payment_mode === 'credit') dbCredit += amt;
    }
    const dbFreshTotal = dbCash + dbCard + dbUpi + dbWallet + dbCredit;

    chk('pay.cash', d.collection.paymentBreakdown.cash, dbCash);
    chk('pay.card', d.collection.paymentBreakdown.card, dbCard);
    chk('pay.upi', d.collection.paymentBreakdown.upi, dbUpi);
    chk('freshPayTotal', d.collection.freshPaymentTotal, dbFreshTotal);
    chk('totalCollection=freshPay', d.totalCollection, d.collection.freshPaymentTotal);

    // === 4. Cash Drawer ===
    const expAmt = d.openingCash + d.collection.freshPaymentTotal;
    const expCash = d.openingCash + d.totalCashSales;
    chk('expectedAmount', d.expectedAmount, expAmt);
    chk('expectedCash', d.expectedCash, expCash);
    if (d.status === 'closed') {
      chk('cashVariance', d.cashVariance, d.closingCash - d.expectedCash);
    }

    // === 5. Cancellations ===
    const [cancDb] = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0) as canc_total
       FROM orders WHERE outlet_id = ? AND created_at >= ? AND created_at <= ? AND status = 'cancelled' ${ofc}`,
      [OID, S, E, ...ofp]
    );
    chk('totalCancellations', d.totalCancellations, parseFloat(cancDb[0].canc_total || 0));
    chk('cancTotal=orderStats', d.orderStats.cancelledTotal, parseFloat(cancDb[0].canc_total || 0));

    // === 6. Order-type bifurcation ===
    const otb = d.orderTypeBifurcation;
    const typeSum = otb.dineIn.sales + otb.takeaway.sales + otb.delivery.sales;
    chk('typeSales=totalSales', parseFloat(typeSum.toFixed(2)), d.totalSales);
    const typeOrdSum = otb.dineIn.orders + otb.takeaway.orders + otb.delivery.orders;
    chk('typeOrders=totalOrders', typeOrdSum, d.totalOrders);

    // === 7. Order list checks ===
    const compOrders = d.orders.filter(o => o.status === 'completed');
    const orderSum = compOrders.reduce((s, o) => s + o.totalAmount, 0);
    chk('ordersSum=totalSales', parseFloat(orderSum.toFixed(2)), d.totalSales);

    // Order-level formula: sub - disc + tax + svc + pkg + roff = total (for every order)
    let formulaPass = 0, formulaFail = 0;
    for (const o of d.orders) {
      const c = o.subtotal - o.discountAmount + o.taxAmount + o.serviceCharge + o.packagingCharge + o.roundOff;
      if (Math.abs(c - o.totalAmount) < 0.02) formulaPass++;
      else { formulaFail++; failures.push(`orderFormula ${o.orderNumber}: calc=${c.toFixed(2)} vs total=${o.totalAmount}`); }
    }
    if (formulaFail === 0) pass++; else fail++;

    // Order-level sums = top-level
    const discSum = compOrders.reduce((s, o) => s + o.discountAmount, 0);
    chk('orderDiscSum=totalDisc', parseFloat(discSum.toFixed(2)), d.totalDiscounts);
    const dueSum = compOrders.reduce((s, o) => s + o.dueAmount, 0);
    chk('orderDueSum=totalDue', parseFloat(dueSum.toFixed(2)), d.saleBifurcation.totalDue);
    const cancOrderSum = d.orders.filter(o => o.status === 'cancelled').reduce((s, o) => s + o.totalAmount, 0);
    chk('orderCancSum=totalCanc', parseFloat(cancOrderSum.toFixed(2)), d.totalCancellations);

    const st = fail === 0 ? '✅' : '❌';
    const tkInfo = otb.takeaway.orders > 0 ? ` takeaway=${otb.takeaway.orders}(${otb.takeaway.sales})` : '';
    console.log(`  Shift#${sid} (${d.floorName}, ${d.cashierName}): ${pass} pass, ${fail} fail ${st}`);
    console.log(`    totalSales=${d.totalSales} | freshPay=${d.collection.freshPaymentTotal} | disc=${d.totalDiscounts} | canc=${d.totalCancellations} | orders=${d.totalOrders}(${d.orderStats.completedOrders}c/${d.orderStats.cancelledOrders}x)${tkInfo}`);
    console.log(`    bifurcation: ${sb.subtotal} - ${sb.discount} + ${sb.tax} + ${sb.serviceCharge} + ${sb.packagingCharge} + ${sb.roundOff} = ${d.totalSales}`);
    console.log(`    types: dineIn=${otb.dineIn.sales} + takeaway=${otb.takeaway.sales} + delivery=${otb.delivery.sales} = ${typeSum}`);
    console.log(`    collection: cash=${d.collection.paymentBreakdown.cash} card=${d.collection.paymentBreakdown.card} upi=${d.collection.paymentBreakdown.upi} = ${d.collection.freshPaymentTotal}`);
    console.log(`    cashDrawer: open=${d.openingCash} + fresh=${d.collection.freshPaymentTotal} = exp=${d.expectedAmount} | cashExp=${d.expectedCash} close=${d.closingCash} var=${d.cashVariance}`);
    console.log(`    orderFormulas: ${formulaPass}/${d.orders.length} pass`);
    if (failures.length > 0) {
      for (const f of failures) console.log(`    ❌ ${f}`);
    }
    console.log();

    grandPass += pass;
    grandFail += fail;
    results.push({ sid, floorName: d.floorName, cashierName: d.cashierName, pass, fail, totalSales: d.totalSales });
  }

  console.log('═'.repeat(80));
  console.log('GRAND SUMMARY — All 12 shifts for outlet 46');
  console.log('═'.repeat(80));
  for (const r of results) {
    console.log(`  Shift#${r.sid} (${r.floorName}, ${r.cashierName}): ${r.pass} pass, ${r.fail} fail ${r.fail === 0 ? '✅' : '❌'} | sale=${r.totalSales}`);
  }
  console.log(`\n  TOTAL: ${grandPass} pass, ${grandFail} fail`);

  await pool.end();
  process.exit(grandFail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
