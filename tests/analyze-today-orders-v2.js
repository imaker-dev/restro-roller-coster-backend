/**
 * Analyze today's order listing Excel — handles header rows
 */
const XLSX = require('xlsx');
const path = require('path');

const file = path.join(__dirname, 'Order_Listing_2026_04_08_01_01_51.xlsx');
const wb = XLSX.readFile(file);
const ws = wb.Sheets[wb.SheetNames[0]];

// Read as array of arrays to see raw structure
const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

console.log('Raw rows (first 15):');
for (let i = 0; i < Math.min(15, raw.length); i++) {
  console.log(`  Row ${i}: ${JSON.stringify(raw[i]).slice(0, 250)}`);
}

// Find the header row (contains "Order No" or similar)
let headerIdx = -1;
for (let i = 0; i < raw.length; i++) {
  const row = raw[i].map(c => String(c || '').toLowerCase());
  if (row.some(c => c.includes('order no') || c.includes('order_no'))) {
    headerIdx = i;
    break;
  }
}

if (headerIdx === -1) {
  console.log('\nCould not find header row. Showing all rows:');
  raw.forEach((r, i) => console.log(`  ${i}: ${JSON.stringify(r)}`));
  process.exit(0);
}

console.log(`\nHeader row found at index ${headerIdx}:`);
const headers = raw[headerIdx].map(h => String(h || '').trim());
console.log(`  ${JSON.stringify(headers)}`);

// Parse data rows
const data = [];
for (let i = headerIdx + 1; i < raw.length; i++) {
  const row = raw[i];
  if (!row || row.length === 0 || !row[0]) continue;
  // Skip summary/total rows
  if (String(row[0]).toLowerCase().includes('total') || String(row[0]).toLowerCase().includes('count')) continue;
  
  const obj = {};
  headers.forEach((h, idx) => { if (h) obj[h] = row[idx] !== undefined ? row[idx] : ''; });
  data.push(obj);
}

console.log(`\nParsed ${data.length} data rows`);
console.log(`\nColumns: ${headers.filter(h => h).join(' | ')}`);

// Show first 3 data rows
console.log('\nSample data:');
for (let i = 0; i < Math.min(3, data.length); i++) {
  console.log(`  Row ${i+1}:`, JSON.stringify(data[i]).slice(0, 300));
}

// Show all unique values for key columns
const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));

// Find columns
const findCol = (keywords) => headers.find(c => keywords.some(k => c.toLowerCase().replace(/[_.\s]/g, '').includes(k)));
const statusCol = findCol(['status', 'orderstatus']);
const totalCol = findCol(['totalamount', 'billamount', 'grandtotal', 'netamount']);
const orderNoCol = findCol(['orderno', 'ordernumber']);
const typeCol = findCol(['ordertype']);
const discountCol = findCol(['discount']);
const ncCol = findCol(['ncamount']);
const isNcCol = findCol(['isnc', 'nc']);
const subtotalCol = findCol(['subtotal', 'itemtotal']);
const taxCol = findCol(['taxamount', 'gst', 'tax']);
const dateCol = findCol(['date', 'createdat', 'orderdate', 'datetime']);
const paidCol = findCol(['paidamount', 'paid']);
const dueCol = findCol(['dueamount', 'due', 'balance']);
const adjCol = findCol(['adjustment']);

console.log(`\nColumn mapping:`);
console.log(`  Status: "${statusCol}"`);
console.log(`  Total: "${totalCol}"`);
console.log(`  Order No: "${orderNoCol}"`);
console.log(`  Type: "${typeCol}"`);
console.log(`  Discount: "${discountCol}"`);
console.log(`  NC: "${ncCol}" / isNC: "${isNcCol}"`);
console.log(`  Subtotal: "${subtotalCol}"`);
console.log(`  Tax: "${taxCol}"`);
console.log(`  Date: "${dateCol}"`);
console.log(`  Paid: "${paidCol}"`);
console.log(`  Due: "${dueCol}"`);

if (statusCol) {
  const statuses = {};
  data.forEach(r => {
    const st = String(r[statusCol] || '').trim().toLowerCase();
    if (!statuses[st]) statuses[st] = { count: 0, amount: 0 };
    statuses[st].count++;
    statuses[st].amount += r2(r[totalCol]);
  });
  console.log('\nOrders by Status:');
  for (const [st, d] of Object.entries(statuses)) {
    console.log(`  ${st}: ${d.count} orders, ₹${r2(d.amount)}`);
  }
}

// Show all unique statuses
if (statusCol) {
  const uniqueStatuses = [...new Set(data.map(r => String(r[statusCol] || '').trim()))];
  console.log(`\nUnique statuses: ${uniqueStatuses.join(', ')}`);
}

// ================================================================
// BIFURCATION
// ================================================================
if (statusCol && totalCol) {
  const completed = data.filter(r => String(r[statusCol] || '').trim().toLowerCase() === 'completed');
  const cancelled = data.filter(r => String(r[statusCol] || '').trim().toLowerCase() === 'cancelled');
  const other = data.filter(r => {
    const st = String(r[statusCol] || '').trim().toLowerCase();
    return st !== 'completed' && st !== 'cancelled';
  });

  const totalSale = completed.reduce((s, r) => s + r2(r[totalCol]), 0);
  const totalDiscount = discountCol ? completed.reduce((s, r) => s + r2(r[discountCol]), 0) : 0;
  const totalTax = taxCol ? completed.reduce((s, r) => s + r2(r[taxCol]), 0) : 0;
  const totalSubtotal = subtotalCol ? completed.reduce((s, r) => s + r2(r[subtotalCol]), 0) : 0;
  const cancelledAmt = cancelled.reduce((s, r) => s + r2(r[totalCol]), 0);
  const otherAmt = other.reduce((s, r) => s + r2(r[totalCol]), 0);

  // NC
  const ncOrders = completed.filter(r => {
    if (isNcCol && isNcCol !== ncCol) return r[isNcCol] === 1 || r[isNcCol] === '1' || r[isNcCol] === true || String(r[isNcCol]).toLowerCase() === 'yes';
    if (ncCol) return r2(r[ncCol]) > 0;
    return false;
  });
  const ncAmount = ncCol ? completed.reduce((s, r) => s + r2(r[ncCol]), 0) : 0;

  // Adjustment
  const adjOrders = adjCol ? completed.filter(r => r2(r[adjCol]) > 0) : [];
  const adjAmount = adjCol ? completed.reduce((s, r) => s + r2(r[adjCol]), 0) : 0;

  // Due / Paid
  const totalDue = dueCol ? completed.reduce((s, r) => s + r2(r[dueCol]), 0) : 0;
  const totalPaid = paidCol ? completed.reduce((s, r) => s + r2(r[paidCol]), 0) : 0;

  // Order type breakdown
  const byType = {};
  if (typeCol) {
    completed.forEach(r => {
      const t = String(r[typeCol] || 'unknown').trim();
      if (!byType[t]) byType[t] = { count: 0, amount: 0 };
      byType[t].count++;
      byType[t].amount += r2(r[totalCol]);
    });
  }

  console.log('\n\n' + '═'.repeat(90));
  console.log('  BIFURCATION REPORT (per Accurate DSR rules)');
  console.log('═'.repeat(90));

  console.log('\n  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║  📊 SALES (Completed Orders = What Was Actually Billed) ║');
  console.log('  ╠══════════════════════════════════════════════════════════╣');
  console.log(`  ║  Total Sale:          ₹${String(r2(totalSale)).padEnd(12)} (${completed.length} completed orders) ║`);
  console.log(`  ║  Total Collection:    ₹${String(r2(totalSale)).padEnd(12)} (= Total Sale)          ║`);
  console.log('  ╚══════════════════════════════════════════════════════════╝');

  if (subtotalCol) console.log(`\n  Subtotal:             ₹${r2(totalSubtotal)}`);
  if (discountCol) console.log(`  Discount:             ₹${r2(totalDiscount)} (already deducted from total before completion)`);
  if (taxCol)      console.log(`  Tax (GST):            ₹${r2(totalTax)}`);

  console.log('\n  ── Bifurcation (included in sale, tracked separately) ──');
  console.log(`  NC Amount:            ₹${r2(ncAmount)} (${ncOrders.length} NC orders — food given free)`);
  if (adjCol) console.log(`  Adjustment:           ₹${r2(adjAmount)} (${adjOrders.length} orders)`);
  if (dueCol) console.log(`  Due (unpaid balance):  ₹${r2(totalDue)}`);
  if (paidCol) console.log(`  Paid Amount:          ₹${r2(totalPaid)}`);

  if (typeCol && Object.keys(byType).length > 0) {
    console.log('\n  ── Order Type Breakdown (completed only) ──');
    for (const [t, d] of Object.entries(byType).sort((a,b) => b[1].amount - a[1].amount)) {
      console.log(`    ${t.padEnd(20)} ${String(d.count).padStart(4)} orders   ₹${r2(d.amount)}`);
    }
  }

  console.log('\n  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║  ❌ NOT IN SALES                                        ║');
  console.log('  ╠══════════════════════════════════════════════════════════╣');
  console.log(`  ║  Cancelled orders:    ₹${String(r2(cancelledAmt)).padEnd(10)} (${cancelled.length} orders — never completed) ║`);
  console.log(`  ║  Active/in-progress:  ₹${String(r2(otherAmt)).padEnd(10)} (${other.length} orders — not yet done)   ║`);
  console.log('  ╚══════════════════════════════════════════════════════════╝');

  if (other.length > 0) {
    const activeByStatus = {};
    other.forEach(r => {
      const st = String(r[statusCol]).trim();
      if (!activeByStatus[st]) activeByStatus[st] = { count: 0, amount: 0 };
      activeByStatus[st].count++;
      activeByStatus[st].amount += r2(r[totalCol]);
    });
    for (const [st, d] of Object.entries(activeByStatus)) {
      console.log(`    └─ ${st}: ${d.count} orders, ₹${r2(d.amount)}`);
    }
  }

  if (cancelled.length > 0 && orderNoCol) {
    console.log('\n  ── Cancelled Order Details ──');
    for (const r of cancelled) {
      console.log(`    Order #${r[orderNoCol]}: ₹${r2(r[totalCol])} | ${r[typeCol] || ''} | ${r[dateCol] || ''}`);
    }
  }

  if (ncOrders.length > 0 && orderNoCol) {
    console.log('\n  ── NC Order Details ──');
    for (const r of ncOrders) {
      console.log(`    Order #${r[orderNoCol]}: total=₹${r2(r[totalCol])}, nc_amount=₹${r2(r[ncCol])} | ${r[typeCol] || ''}`);
    }
  }

  console.log('\n  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║  📋 GRAND SUMMARY                                       ║');
  console.log('  ╠══════════════════════════════════════════════════════════╣');
  console.log(`  ║  All orders in file:    ${String(data.length).padEnd(35)}║`);
  console.log(`  ║  ├─ Completed (SALE):   ${String(completed.length + ' → ₹' + r2(totalSale)).padEnd(35)}║`);
  console.log(`  ║  ├─ Cancelled:          ${String(cancelled.length + ' → ₹' + r2(cancelledAmt)).padEnd(35)}║`);
  console.log(`  ║  └─ Active/other:       ${String(other.length + ' → ₹' + r2(otherAmt)).padEnd(35)}║`);
  console.log('  ╠══════════════════════════════════════════════════════════╣');
  console.log(`  ║  TOTAL SALE = ₹${String(r2(totalSale)).padEnd(40)}║`);
  console.log(`  ║  (Only completed orders — what customers were billed)   ║`);
  console.log('  ╚══════════════════════════════════════════════════════════╝');
}
