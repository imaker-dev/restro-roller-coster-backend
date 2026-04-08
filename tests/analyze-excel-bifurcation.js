/**
 * Bifurcate today's Excel order listing per our DSR rules
 * (External POS report — order numbers don't match our DB)
 * 
 * Rules:
 *  - All "Printed" with payment = completed sale
 *  - Grand Total = total_sale (what customer was billed)
 *  - total_collection = total_sale
 *  - "Due Payment" orders = tracked separately (unpaid)
 *  - Discount already deducted from Grand Total
 *  - NC, discount, due — bifurcated but NOT excluded from sale
 */
const XLSX = require('xlsx');
const path = require('path');

const file = path.join(__dirname, 'Order_Listing_2026_04_08_01_01_51.xlsx');
const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));

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

// Column mapping
const C = {
  no: 'Order No.',
  type: 'Order Type',
  subType: 'Sub Order Type',
  customer: 'Customer Name',
  phone: 'Customer Phone',
  items: 'Items',
  myAmount: 'My Amount (₹)',
  discount: 'Total Discount (₹)',
  deliveryChg: 'Delivery Charge (₹)',
  containerChg: 'Container Charge (₹)',
  tax: 'Total Tax (₹)',
  roundOff: 'Round Off (₹)',
  grandTotal: 'Grand Total (₹)',
  payType: 'Payment Type',
  payDesc: 'Payment Description',
  status: 'Status',
  created: 'Created'
};

// All orders are "Printed" (billed) — these are today's sales
// Business day: orders from ~4pm Apr 7 to 12:11am Apr 8 = Apr 7 business day

console.log('═'.repeat(90));
console.log('  TODAY\'S ORDER REPORT BIFURCATION');
console.log(`  Source: Order_Listing_2026_04_08_01_01_51.xlsx`);
console.log(`  Orders: ${data.length} | Time range: ${data[data.length-1][C.created]} to ${data[0][C.created]}`);
console.log('═'.repeat(90));

// ================================================================
// TOTALS
// ================================================================
const allGrandTotal = data.reduce((s, r) => s + r2(r[C.grandTotal]), 0);
const allMyAmount = data.reduce((s, r) => s + r2(r[C.myAmount]), 0);
const allDiscount = data.reduce((s, r) => s + r2(r[C.discount]), 0);
const allTax = data.reduce((s, r) => s + r2(r[C.tax]), 0);
const allRoundOff = data.reduce((s, r) => s + r2(r[C.roundOff]), 0);
const allDelivery = data.reduce((s, r) => s + r2(r[C.deliveryChg]), 0);
const allContainer = data.reduce((s, r) => s + r2(r[C.containerChg]), 0);

console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
console.log('  ║  📊 TOTAL SALE (All Billed Orders)                          ║');
console.log('  ╠══════════════════════════════════════════════════════════════╣');
console.log(`  ║  Grand Total (Billed):   Rs ${String(r2(allGrandTotal)).padEnd(36)}║`);
console.log(`  ║  Total Collection:        Rs ${String(r2(allGrandTotal)).padEnd(36)}║`);
console.log(`  ║  Total Orders:            ${String(data.length).padEnd(36)}║`);
console.log('  ╚══════════════════════════════════════════════════════════════╝');

console.log(`\n  Breakdown:`);
console.log(`    Item Amount (My Amount):  Rs ${r2(allMyAmount)}`);
console.log(`    Discount:                 Rs ${r2(allDiscount)} (already deducted)`);
console.log(`    Tax (GST):                Rs ${r2(allTax)}`);
console.log(`    Round Off:                Rs ${r2(allRoundOff)}`);
console.log(`    Delivery Charge:          Rs ${r2(allDelivery)}`);
console.log(`    Container Charge:         Rs ${r2(allContainer)}`);
console.log(`    ─────────────────────────────────────`);
console.log(`    Verify: MyAmount - Discount + Tax + RoundOff + Delivery + Container`);
console.log(`           = ${r2(allMyAmount)} - ${r2(allDiscount)} + ${r2(allTax)} + ${r2(allRoundOff)} + ${r2(allDelivery)} + ${r2(allContainer)}`);
console.log(`           = Rs ${r2(allMyAmount - allDiscount + allTax + allRoundOff + allDelivery + allContainer)}`);
console.log(`    Grand Total from Excel: Rs ${r2(allGrandTotal)}`);

// ================================================================
// PAYMENT MODE BREAKDOWN
// ================================================================
console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
console.log('  ║  💳 PAYMENT MODE BREAKDOWN                                  ║');
console.log('  ╠══════════════════════════════════════════════════════════════╣');

const byPayment = {};
data.forEach(r => {
  const pt = r[C.payType] || 'Unknown';
  if (!byPayment[pt]) byPayment[pt] = { count: 0, amount: 0, orders: [] };
  byPayment[pt].count++;
  byPayment[pt].amount += r2(r[C.grandTotal]);
  byPayment[pt].orders.push(r);
});

// Map to standard categories
let cashTotal = 0, upiTotal = 0, cardTotal = 0, onlineTotal = 0, dueTotal = 0, otherTotal = 0;
for (const [pt, d] of Object.entries(byPayment).sort((a,b) => b[1].amount - a[1].amount)) {
  const ptLower = pt.toLowerCase();
  if (ptLower === 'cash') cashTotal += d.amount;
  else if (ptLower.includes('upi') || ptLower === 'other [upi]') upiTotal += d.amount;
  else if (ptLower === 'card') cardTotal += d.amount;
  else if (ptLower === 'online') onlineTotal += d.amount;
  else if (ptLower.includes('due')) dueTotal += d.amount;
  else otherTotal += d.amount;

  const pct = allGrandTotal > 0 ? ((d.amount / allGrandTotal) * 100).toFixed(1) : '0.0';
  console.log(`  ║  ${pt.padEnd(25)} ${String(d.count).padStart(3)} orders  Rs ${String(r2(d.amount)).padEnd(10)} (${pct}%)  ║`);
}
console.log('  ╚══════════════════════════════════════════════════════════════╝');

console.log('\n  Standardized Payment Summary:');
console.log(`    Cash:         Rs ${r2(cashTotal)}`);
console.log(`    UPI:          Rs ${r2(upiTotal)}`);
console.log(`    Card:         Rs ${r2(cardTotal)}`);
console.log(`    Online:       Rs ${r2(onlineTotal)}`);
console.log(`    Due (unpaid): Rs ${r2(dueTotal)} (tracked separately, included in sale)`);
if (otherTotal > 0) console.log(`    Other:        Rs ${r2(otherTotal)}`);
console.log(`    ─────────────────────────`);
console.log(`    TOTAL:        Rs ${r2(cashTotal + upiTotal + cardTotal + onlineTotal + dueTotal + otherTotal)}`);

// ================================================================
// FLOOR / SECTION BREAKDOWN
// ================================================================
console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
console.log('  ║  🏢 FLOOR / SECTION BREAKDOWN                               ║');
console.log('  ╠══════════════════════════════════════════════════════════════╣');

const byFloor = {};
data.forEach(r => {
  const floor = r[C.subType] || 'Unknown';
  if (!byFloor[floor]) byFloor[floor] = { count: 0, amount: 0, discount: 0, tax: 0 };
  byFloor[floor].count++;
  byFloor[floor].amount += r2(r[C.grandTotal]);
  byFloor[floor].discount += r2(r[C.discount]);
  byFloor[floor].tax += r2(r[C.tax]);
});

for (const [floor, d] of Object.entries(byFloor).sort((a,b) => b[1].amount - a[1].amount)) {
  const pct = allGrandTotal > 0 ? ((d.amount / allGrandTotal) * 100).toFixed(1) : '0.0';
  console.log(`  ║  ${floor.padEnd(18)} ${String(d.count).padStart(3)} orders  Rs ${String(r2(d.amount)).padEnd(10)} (${pct}%)  ║`);
}
console.log('  ╚══════════════════════════════════════════════════════════════╝');

// ================================================================
// DUE / CREDIT ORDERS (bifurcated)
// ================================================================
const dueOrders = data.filter(r => String(r[C.payType]).toLowerCase().includes('due'));
if (dueOrders.length > 0) {
  console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║  ⏳ DUE PAYMENT ORDERS (included in sale, payment pending)  ║');
  console.log('  ╠══════════════════════════════════════════════════════════════╣');
  for (const r of dueOrders) {
    console.log(`  ║  #${String(r[C.no]).padEnd(6)} Rs ${String(r2(r[C.grandTotal])).padEnd(10)} ${(r[C.customer] || 'N/A').padEnd(15)} ${r[C.created]}  ║`);
    console.log(`  ║    Items: ${String(r[C.items]).slice(0, 55).padEnd(55)}║`);
  }
  console.log(`  ║  TOTAL DUE: Rs ${String(r2(dueTotal)).padEnd(46)}║`);
  console.log('  ╚══════════════════════════════════════════════════════════════╝');
}

// ================================================================
// DISCOUNT ORDERS (bifurcated)
// ================================================================
const discOrders = data.filter(r => r2(r[C.discount]) > 0);
if (discOrders.length > 0) {
  console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║  🏷️  DISCOUNTED ORDERS (already deducted from Grand Total)  ║');
  console.log('  ╠══════════════════════════════════════════════════════════════╣');
  for (const r of discOrders) {
    console.log(`  ║  #${String(r[C.no]).padEnd(6)} Disc: Rs ${String(r2(r[C.discount])).padEnd(10)} Bill: Rs ${String(r2(r[C.grandTotal])).padEnd(8)} ${(r[C.subType]||'').padEnd(12)} ${r[C.payType]}  ║`);
  }
  console.log(`  ║  TOTAL DISCOUNT: Rs ${String(r2(allDiscount)).padEnd(41)}║`);
  console.log('  ╚══════════════════════════════════════════════════════════════╝');
}

// ================================================================
// DELIVERY / ONLINE ORDERS
// ================================================================
const deliveryOrders = data.filter(r => String(r[C.payType]).toLowerCase() === 'online' || String(r[C.type]).toLowerCase().includes('delivery'));
if (deliveryOrders.length > 0) {
  console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║  🛵 DELIVERY / ONLINE ORDERS                                ║');
  console.log('  ╠══════════════════════════════════════════════════════════════╣');
  for (const r of deliveryOrders) {
    console.log(`  ║  #${String(r[C.no]).padEnd(6)} Rs ${String(r2(r[C.grandTotal])).padEnd(10)} ${(r[C.subType]||'').padEnd(12)} ${r[C.payType].padEnd(10)} ${r[C.created]}  ║`);
  }
  const delTotal = deliveryOrders.reduce((s, r) => s + r2(r[C.grandTotal]), 0);
  console.log(`  ║  TOTAL DELIVERY/ONLINE: Rs ${String(r2(delTotal)).padEnd(34)}║`);
  console.log('  ╚══════════════════════════════════════════════════════════════╝');
}

// ================================================================
// COMPLETE ORDER LISTING
// ================================================================
console.log('\n' + '═'.repeat(90));
console.log('  COMPLETE ORDER LISTING');
console.log('═'.repeat(90));
console.log(`  ${'#'.padEnd(7)} ${'Grand Total'.padEnd(13)} ${'MyAmt'.padEnd(10)} ${'Disc'.padEnd(8)} ${'Tax'.padEnd(9)} ${'Payment'.padEnd(18)} ${'Floor'.padEnd(12)} Time`);
console.log('  ' + '─'.repeat(88));
for (const r of data) {
  console.log(`  ${String(r[C.no]).padEnd(7)} Rs ${String(r2(r[C.grandTotal])).padEnd(10)} Rs ${String(r2(r[C.myAmount])).padEnd(7)} Rs ${String(r2(r[C.discount])).padEnd(5)} Rs ${String(r2(r[C.tax])).padEnd(7)} ${(r[C.payType] || '').padEnd(18)} ${(r[C.subType] || '').padEnd(12)} ${r[C.created]}`);
}

// ================================================================
// GRAND SUMMARY
// ================================================================
console.log('\n' + '═'.repeat(90));
console.log('  GRAND SUMMARY');
console.log('═'.repeat(90));
console.log(`\n  Total Orders:         ${data.length}`);
console.log(`  Total Sale:           Rs ${r2(allGrandTotal)} (Grand Total of all billed orders)`);
console.log(`  Total Collection:     Rs ${r2(allGrandTotal)} (= Total Sale per DSR rules)`);
console.log(`\n  Item Amount:          Rs ${r2(allMyAmount)}`);
console.log(`  (-) Discount:         Rs ${r2(allDiscount)} (${discOrders.length} orders)`);
console.log(`  (+) Tax/GST:          Rs ${r2(allTax)}`);
console.log(`  (+/-) Round Off:      Rs ${r2(allRoundOff)}`);
console.log(`  (=) Grand Total:      Rs ${r2(allGrandTotal)}`);
console.log(`\n  Collection Breakdown:`);
console.log(`    Cash:               Rs ${r2(cashTotal)} (${(byPayment['Cash']||{count:0}).count} orders)`);
console.log(`    UPI:                Rs ${r2(upiTotal)} (${(byPayment['Other [UPI]']||{count:0}).count} orders)`);
console.log(`    Card:               Rs ${r2(cardTotal)} (${(byPayment['Card']||{count:0}).count} orders)`);
console.log(`    Online:             Rs ${r2(onlineTotal)} (${(byPayment['Online']||{count:0}).count} orders)`);
console.log(`    Due (unpaid):       Rs ${r2(dueTotal)} (${dueOrders.length} orders — tracked separately)`);
console.log(`\n  Avg Order Value:      Rs ${r2(allGrandTotal / data.length)}`);
console.log('═'.repeat(90));
