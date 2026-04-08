/**
 * Analyze today's order listing Excel + cross-reference with DB
 * The Excel "Status" = print status (all "Printed"), NOT order status.
 * We need to check our DB for the actual order status.
 */
const XLSX = require('xlsx');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const file = path.join(__dirname, 'Order_Listing_2026_04_08_01_01_51.xlsx');
const OUTLET_ID = 46;
const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));

async function run() {
  // Parse Excel
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // Find header row
  let headerIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].some(c => String(c).includes('Order No'))) { headerIdx = i; break; }
  }
  const headers = raw[headerIdx].map(h => String(h || '').trim());
  const data = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || !row[0]) continue;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = row[idx] !== undefined ? row[idx] : ''; });
    data.push(obj);
  }

  // Column mapping for this Excel
  const COL = {
    orderNo: 'Order No.',
    type: 'Order Type',
    subType: 'Sub Order Type',
    items: 'Items',
    myAmount: 'My Amount (₹)',        // subtotal before tax
    discount: 'Total Discount (₹)',
    deliveryCharge: 'Delivery Charge (₹)',
    containerCharge: 'Container Charge (₹)',
    tax: 'Total Tax (₹)',
    roundOff: 'Round Off (₹)',
    grandTotal: 'Grand Total (₹)',     // final bill amount
    paymentType: 'Payment Type',
    paymentDesc: 'Payment Description',
    printStatus: 'Status',             // this is print status, NOT order status
    created: 'Created',
    customer: 'Customer Name'
  };

  console.log(`Excel: ${data.length} orders found\n`);

  // Connect to DB to get actual order statuses
  const pool = await mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  // Get all order numbers from Excel
  const orderNos = data.map(r => r[COL.orderNo]).filter(Boolean);

  // Query DB for these orders
  const [dbRows] = await pool.query(
    `SELECT id, order_number, status, total_amount, subtotal, discount_amount, tax_amount,
            round_off, service_charge, is_nc, nc_amount, is_adjustment, adjustment_amount,
            due_amount, paid_amount, order_type, payment_status, created_at
     FROM orders WHERE outlet_id = ? AND order_number IN (${orderNos.map(() => '?').join(',')})`,
    [OUTLET_ID, ...orderNos]
  );

  const dbMap = {};
  dbRows.forEach(r => { dbMap[r.order_number] = r; });

  // Merge Excel + DB data
  const merged = data.map(r => {
    const orderNo = r[COL.orderNo];
    const db = dbMap[orderNo] || null;
    return {
      orderNo,
      excelGrandTotal: r2(r[COL.grandTotal]),
      excelMyAmount: r2(r[COL.myAmount]),
      excelDiscount: r2(r[COL.discount]),
      excelTax: r2(r[COL.tax]),
      excelRoundOff: r2(r[COL.roundOff]),
      excelPaymentType: r[COL.paymentType],
      excelType: r[COL.type],
      excelSubType: r[COL.subType],
      excelCreated: r[COL.created],
      excelItems: r[COL.items],
      excelCustomer: r[COL.customer],
      // DB fields
      dbStatus: db ? db.status : '(not in DB)',
      dbTotalAmount: db ? r2(db.total_amount) : 0,
      dbSubtotal: db ? r2(db.subtotal) : 0,
      dbDiscount: db ? r2(db.discount_amount) : 0,
      dbTax: db ? r2(db.tax_amount) : 0,
      dbIsNC: db ? db.is_nc : 0,
      dbNCAmount: db ? r2(db.nc_amount) : 0,
      dbDueAmount: db ? r2(db.due_amount) : 0,
      dbPaidAmount: db ? r2(db.paid_amount) : 0,
      dbPaymentStatus: db ? db.payment_status : '',
      dbOrderType: db ? db.order_type : ''
    };
  });

  // ================================================================
  // GROUP BY DB STATUS
  // ================================================================
  const byStatus = {};
  merged.forEach(r => {
    const st = r.dbStatus;
    if (!byStatus[st]) byStatus[st] = [];
    byStatus[st].push(r);
  });

  console.log('═'.repeat(90));
  console.log('  ORDER STATUS BREAKDOWN (from DB, not Excel print status)');
  console.log('═'.repeat(90));
  for (const [st, orders] of Object.entries(byStatus).sort((a,b) => b[1].length - a[1].length)) {
    const sum = orders.reduce((s, r) => s + r.dbTotalAmount, 0);
    const excelSum = orders.reduce((s, r) => s + r.excelGrandTotal, 0);
    console.log(`\n  ${st.toUpperCase()}: ${orders.length} orders`);
    console.log(`    DB total_amount:  ₹${r2(sum)}`);
    console.log(`    Excel Grand Total: ₹${r2(excelSum)}`);
  }

  // ================================================================
  // BIFURCATION
  // ================================================================
  const completed = merged.filter(r => r.dbStatus === 'completed');
  const cancelled = merged.filter(r => r.dbStatus === 'cancelled');
  const active = merged.filter(r => r.dbStatus !== 'completed' && r.dbStatus !== 'cancelled');

  const totalSale = completed.reduce((s, r) => s + r.dbTotalAmount, 0);
  const totalDiscount = completed.reduce((s, r) => s + r.dbDiscount, 0);
  const totalTax = completed.reduce((s, r) => s + r.dbTax, 0);
  const totalSubtotal = completed.reduce((s, r) => s + r.dbSubtotal, 0);
  const cancelledAmt = cancelled.reduce((s, r) => s + r.dbTotalAmount, 0);
  const activeAmt = active.reduce((s, r) => s + r.dbTotalAmount, 0);

  // NC orders
  const ncOrders = completed.filter(r => r.dbIsNC === 1);
  const ncAmount = completed.reduce((s, r) => s + r.dbNCAmount, 0);

  // Due amounts
  const totalDue = completed.reduce((s, r) => s + r.dbDueAmount, 0);
  const totalPaid = completed.reduce((s, r) => s + r.dbPaidAmount, 0);

  // Payment type breakdown (from Excel)
  const byPayment = {};
  completed.forEach(r => {
    const pt = r.excelPaymentType || 'unknown';
    if (!byPayment[pt]) byPayment[pt] = { count: 0, amount: 0 };
    byPayment[pt].count++;
    byPayment[pt].amount += r.dbTotalAmount;
  });

  // Order type breakdown
  const byType = {};
  completed.forEach(r => {
    const t = r.excelSubType || r.dbOrderType || 'unknown';
    if (!byType[t]) byType[t] = { count: 0, amount: 0 };
    byType[t].count++;
    byType[t].amount += r.dbTotalAmount;
  });

  console.log('\n\n' + '═'.repeat(90));
  console.log('  BIFURCATION REPORT (per Accurate DSR rules)');
  console.log('═'.repeat(90));

  console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║  📊 SALES (Completed Orders = What Customers Were Billed)   ║');
  console.log('  ╠══════════════════════════════════════════════════════════════╣');
  console.log(`  ║  Total Sale:          ₹${String(r2(totalSale)).padEnd(38)}║`);
  console.log(`  ║  Total Collection:    ₹${String(r2(totalSale)).padEnd(38)}║`);
  console.log(`  ║  Completed Orders:    ${String(completed.length).padEnd(39)}║`);
  console.log('  ╚══════════════════════════════════════════════════════════════╝');

  console.log(`\n  Subtotal:             ₹${r2(totalSubtotal)}`);
  console.log(`  Discount:             ₹${r2(totalDiscount)} (already deducted before completion)`);
  console.log(`  Tax (GST):            ₹${r2(totalTax)}`);

  console.log('\n  ── Bifurcation (tracked separately, NOT excluded from sale) ──');
  console.log(`  NC Amount:            ₹${r2(ncAmount)} (${ncOrders.length} NC orders — food given free, total_amount=0)`);
  console.log(`  Due (unpaid balance):  ₹${r2(totalDue)}`);
  console.log(`  Paid Amount:          ₹${r2(totalPaid)}`);

  if (Object.keys(byPayment).length > 0) {
    console.log('\n  ── Payment Mode Breakdown (completed orders) ──');
    for (const [pt, d] of Object.entries(byPayment).sort((a,b) => b[1].amount - a[1].amount)) {
      console.log(`    ${pt.padEnd(25)} ${String(d.count).padStart(3)} orders   ₹${r2(d.amount)}`);
    }
  }

  if (Object.keys(byType).length > 0) {
    console.log('\n  ── Floor/Type Breakdown (completed orders) ──');
    for (const [t, d] of Object.entries(byType).sort((a,b) => b[1].amount - a[1].amount)) {
      console.log(`    ${t.padEnd(25)} ${String(d.count).padStart(3)} orders   ₹${r2(d.amount)}`);
    }
  }

  console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║  ❌ NOT IN SALES                                             ║');
  console.log('  ╠══════════════════════════════════════════════════════════════╣');
  console.log(`  ║  Cancelled:       ${String(cancelled.length + ' orders → ₹' + r2(cancelledAmt)).padEnd(43)}║`);
  console.log(`  ║  Active/other:    ${String(active.length + ' orders → ₹' + r2(activeAmt)).padEnd(43)}║`);
  console.log('  ╚══════════════════════════════════════════════════════════════╝');

  if (cancelled.length > 0) {
    console.log('\n  ── Cancelled Order Details ──');
    for (const r of cancelled) {
      console.log(`    #${r.orderNo}: ₹${r.dbTotalAmount} | ${r.excelType} | ${r.excelPaymentType} | ${r.excelCreated}`);
      console.log(`      Items: ${String(r.excelItems).slice(0, 80)}`);
    }
  }

  if (active.length > 0) {
    console.log('\n  ── Active/In-Progress Order Details (NOT yet in sales) ──');
    for (const r of active) {
      console.log(`    #${r.orderNo}: ₹${r.dbTotalAmount} | status: ${r.dbStatus} | ${r.excelType} | ${r.excelPaymentType} | ${r.excelCreated}`);
    }
  }

  if (ncOrders.length > 0) {
    console.log('\n  ── NC Order Details ──');
    for (const r of ncOrders) {
      console.log(`    #${r.orderNo}: total=₹${r.dbTotalAmount}, nc=₹${r.dbNCAmount} | ${r.excelType}`);
    }
  }

  // Complete order listing
  console.log('\n\n' + '═'.repeat(90));
  console.log('  COMPLETE ORDER LISTING');
  console.log('═'.repeat(90));
  console.log(`  ${'#'.padEnd(7)} ${'Status'.padEnd(12)} ${'DB ₹'.padEnd(10)} ${'Excel ₹'.padEnd(10)} ${'Payment'.padEnd(18)} ${'Type'.padEnd(15)} Created`);
  console.log('  ' + '─'.repeat(88));
  for (const r of merged.sort((a,b) => b.orderNo - a.orderNo)) {
    const match = Math.abs(r.dbTotalAmount - r.excelGrandTotal) < 1 ? '✅' : '⚠️';
    console.log(`  ${match} ${String(r.orderNo).padEnd(6)} ${r.dbStatus.padEnd(12)} ${String(r.dbTotalAmount).padEnd(10)} ${String(r.excelGrandTotal).padEnd(10)} ${(r.excelPaymentType || '').padEnd(18)} ${(r.excelSubType || '').padEnd(15)} ${r.excelCreated}`);
  }

  console.log('\n' + '═'.repeat(90));
  console.log(`  TOTAL SALE = ₹${r2(totalSale)} (${completed.length} completed orders)`);
  console.log(`  This is what the APIs show as total_sale = total_collection`);
  console.log('═'.repeat(90));

  await pool.end();
}

run().catch(err => { console.error(err); process.exit(1); });
