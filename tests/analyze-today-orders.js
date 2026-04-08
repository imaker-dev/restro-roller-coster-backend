/**
 * Analyze today's order listing Excel and bifurcate per DSR rules:
 *   - Only completed orders = sales
 *   - total_sale = SUM(total_amount)
 *   - NC, discount, adjustment bifurcated but NOT excluded
 *   - Cancelled orders/items tracked separately
 *   - Due collections tracked separately
 */
const XLSX = require('xlsx');
const path = require('path');

const file = path.join(__dirname, 'Order_Listing_2026_04_08_01_01_51.xlsx');
const wb = XLSX.readFile(file);

const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));

// Parse each sheet
for (const sheetName of wb.SheetNames) {
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`SHEET: ${sheetName}`);
  console.log('═'.repeat(90));

  const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
  if (data.length === 0) { console.log('  (empty)'); continue; }

  // Show column names
  const cols = Object.keys(data[0]);
  console.log(`  Columns: ${cols.join(', ')}`);
  console.log(`  Total rows: ${data.length}`);

  // Try to identify key columns (flexible naming)
  const findCol = (keywords) => cols.find(c => keywords.some(k => c.toLowerCase().replace(/[_\s]/g, '').includes(k)));
  
  const statusCol = findCol(['status', 'orderstatus']);
  const totalCol = findCol(['totalamount', 'total_amount', 'billamount', 'amount', 'total']);
  const orderNoCol = findCol(['orderno', 'ordernumber', 'order_number', 'orderid']);
  const typeCol = findCol(['ordertype', 'order_type', 'type']);
  const discountCol = findCol(['discount', 'discountamount']);
  const ncCol = findCol(['ncamount', 'nc_amount', 'nc']);
  const isNcCol = findCol(['isnc', 'is_nc']);
  const subtotalCol = findCol(['subtotal', 'sub_total']);
  const taxCol = findCol(['taxamount', 'tax', 'tax_amount']);
  const adjCol = findCol(['adjustmentamount', 'adjustment_amount', 'adjustment']);
  const dueCol = findCol(['dueamount', 'due_amount', 'due']);
  const paidCol = findCol(['paidamount', 'paid_amount', 'paid']);
  const createdCol = findCol(['createdat', 'created_at', 'date', 'orderdate']);

  console.log(`\n  Key columns found:`);
  console.log(`    Status: ${statusCol || '(not found)'}`);
  console.log(`    Total Amount: ${totalCol || '(not found)'}`);
  console.log(`    Order No: ${orderNoCol || '(not found)'}`);
  console.log(`    Order Type: ${typeCol || '(not found)'}`);
  console.log(`    Discount: ${discountCol || '(not found)'}`);
  console.log(`    NC: ${ncCol || '(not found)'} / isNC: ${isNcCol || '(not found)'}`);
  console.log(`    Subtotal: ${subtotalCol || '(not found)'}`);
  console.log(`    Tax: ${taxCol || '(not found)'}`);
  console.log(`    Adjustment: ${adjCol || '(not found)'}`);
  console.log(`    Due: ${dueCol || '(not found)'}`);
  console.log(`    Created: ${createdCol || '(not found)'}`);

  // Show first 3 rows for debug
  console.log(`\n  Sample rows:`);
  for (let i = 0; i < Math.min(3, data.length); i++) {
    console.log(`    Row ${i+1}:`, JSON.stringify(data[i]).slice(0, 200));
  }

  if (!statusCol) {
    console.log('\n  ⚠️ Cannot find status column — showing all unique column values for first few cols');
    for (const c of cols.slice(0, 8)) {
      const vals = [...new Set(data.map(r => r[c]))];
      if (vals.length <= 20) console.log(`    ${c}: ${vals.join(', ')}`);
    }
    continue;
  }

  // ================================================================
  // BIFURCATION
  // ================================================================
  console.log('\n' + '─'.repeat(90));
  console.log('  BIFURCATION (per DSR rules)');
  console.log('─'.repeat(90));

  // Group by status
  const byStatus = {};
  data.forEach(r => {
    const st = String(r[statusCol] || '').toLowerCase().trim();
    if (!byStatus[st]) byStatus[st] = [];
    byStatus[st].push(r);
  });

  console.log('\n  Orders by Status:');
  for (const [st, orders] of Object.entries(byStatus)) {
    const sum = orders.reduce((s, r) => s + r2(r[totalCol]), 0);
    console.log(`    ${st}: ${orders.length} orders, ₹${r2(sum)}`);
  }

  // COMPLETED orders = SALES
  const completed = byStatus['completed'] || [];
  const cancelled = byStatus['cancelled'] || [];
  const nonCompletedNonCancelled = data.filter(r => {
    const st = String(r[statusCol] || '').toLowerCase().trim();
    return st !== 'completed' && st !== 'cancelled';
  });

  const totalSale = completed.reduce((s, r) => s + r2(r[totalCol]), 0);
  const totalDiscount = completed.reduce((s, r) => s + r2(r[discountCol]), 0);
  const totalTax = completed.reduce((s, r) => s + r2(r[taxCol]), 0);
  const totalSubtotal = completed.reduce((s, r) => s + r2(r[subtotalCol]), 0);

  // NC orders
  const ncOrders = completed.filter(r => {
    if (isNcCol) return r[isNcCol] === 1 || r[isNcCol] === true || r[isNcCol] === '1' || r[isNcCol] === 'yes';
    if (ncCol) return r2(r[ncCol]) > 0;
    return false;
  });
  const ncAmount = ncCol ? completed.reduce((s, r) => s + r2(r[ncCol]), 0) : 0;

  // Adjustment orders
  const adjOrders = adjCol ? completed.filter(r => r2(r[adjCol]) > 0) : [];
  const adjAmount = adjCol ? completed.reduce((s, r) => s + r2(r[adjCol]), 0) : 0;

  // Due amounts
  const totalDue = dueCol ? completed.reduce((s, r) => s + r2(r[dueCol]), 0) : 0;
  const totalPaid = paidCol ? completed.reduce((s, r) => s + r2(r[paidCol]), 0) : 0;

  // Cancelled orders total
  const cancelledAmount = cancelled.reduce((s, r) => s + r2(r[totalCol]), 0);

  // Active/in-progress orders
  const activeAmount = nonCompletedNonCancelled.reduce((s, r) => s + r2(r[totalCol]), 0);

  // Order type breakdown (completed only)
  const byType = {};
  completed.forEach(r => {
    const t = String(r[typeCol] || 'unknown').toLowerCase().trim();
    if (!byType[t]) byType[t] = { count: 0, amount: 0 };
    byType[t].count++;
    byType[t].amount += r2(r[totalCol]);
  });

  console.log('\n  ════════════════════════════════════════════════════════════');
  console.log('  📊 SALES (Completed Orders Only)');
  console.log('  ════════════════════════════════════════════════════════════');
  console.log(`  Total Sale (billed):        ₹${r2(totalSale)}  (${completed.length} completed orders)`);
  console.log(`  Total Collection:           ₹${r2(totalSale)}  (= Total Sale)`);
  if (subtotalCol) console.log(`  Subtotal:                   ₹${r2(totalSubtotal)}`);
  if (discountCol) console.log(`  Discount:                   ₹${r2(totalDiscount)}`);
  if (taxCol)      console.log(`  Tax:                        ₹${r2(totalTax)}`);

  console.log('\n  ── Bifurcation (NOT excluded from sale) ──');
  console.log(`  NC Amount:                  ₹${r2(ncAmount)}  (${ncOrders.length} NC orders)`);
  console.log(`  Adjustment Amount:          ₹${r2(adjAmount)}  (${adjOrders.length} orders)`);
  if (dueCol) console.log(`  Due Amount (unpaid):        ₹${r2(totalDue)}`);
  if (paidCol) console.log(`  Paid Amount:                ₹${r2(totalPaid)}`);

  console.log('\n  ── Order Type Breakdown (completed) ──');
  for (const [t, d] of Object.entries(byType)) {
    console.log(`  ${t.padEnd(20)} ${String(d.count).padStart(4)} orders   ₹${r2(d.amount)}`);
  }

  console.log('\n  ════════════════════════════════════════════════════════════');
  console.log('  ❌ NOT IN SALES');
  console.log('  ════════════════════════════════════════════════════════════');
  console.log(`  Cancelled orders:           ₹${r2(cancelledAmount)}  (${cancelled.length} orders — never completed)`);
  console.log(`  Active/in-progress:         ₹${r2(activeAmount)}  (${nonCompletedNonCancelled.length} orders — not yet completed)`);
  if (nonCompletedNonCancelled.length > 0) {
    const activeByStatus = {};
    nonCompletedNonCancelled.forEach(r => {
      const st = String(r[statusCol]).toLowerCase().trim();
      if (!activeByStatus[st]) activeByStatus[st] = { count: 0, amount: 0 };
      activeByStatus[st].count++;
      activeByStatus[st].amount += r2(r[totalCol]);
    });
    for (const [st, d] of Object.entries(activeByStatus)) {
      console.log(`    └─ ${st}: ${d.count} orders, ₹${r2(d.amount)}`);
    }
  }

  console.log('\n  ════════════════════════════════════════════════════════════');
  console.log('  📋 GRAND SUMMARY');
  console.log('  ════════════════════════════════════════════════════════════');
  console.log(`  All orders in file:         ${data.length}`);
  console.log(`  ├─ Completed (= SALE):      ${completed.length} → ₹${r2(totalSale)}`);
  console.log(`  ├─ Cancelled (not sale):     ${cancelled.length} → ₹${r2(cancelledAmount)}`);
  console.log(`  └─ Active/other (not sale):  ${nonCompletedNonCancelled.length} → ₹${r2(activeAmount)}`);
  console.log(`\n  Total Sale = ₹${r2(totalSale)} (only what was billed & completed)`);
  console.log(`  Total Collection = ₹${r2(totalSale)} (= Total Sale, per DSR rules)`);

  // NC detail if any
  if (ncOrders.length > 0 && orderNoCol) {
    console.log('\n  ── NC Order Details ──');
    for (const r of ncOrders) {
      console.log(`    Order #${r[orderNoCol]}: total=₹${r2(r[totalCol])}, nc_amount=₹${r2(r[ncCol])}`);
    }
  }
}
