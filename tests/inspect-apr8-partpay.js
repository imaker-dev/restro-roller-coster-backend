const XLSX = require('xlsx');
const path = require('path');

const file = path.join(__dirname, '8thApril-Order.xlsx');
const wb = XLSX.readFile(file);
const ws = wb.Sheets[wb.SheetNames[0]];
const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

let headerIdx = -1;
for (let i = 0; i < raw.length; i++) {
  if (raw[i].some(c => String(c).includes('Order No'))) { headerIdx = i; break; }
}
const headers = raw[headerIdx].map(h => String(h || '').trim());
const allRows = [];
for (let i = headerIdx + 1; i < raw.length; i++) {
  const row = raw[i];
  if (!row || !row[0]) continue;
  const obj = {};
  headers.forEach((h, idx) => { if (h) obj[h] = row[idx] !== undefined ? row[idx] : ''; });
  allRows.push(obj);
}

const r2 = n => Math.round((parseFloat(n) || 0) * 100) / 100;
const gtCol = headers.find(h => h.includes('Grand Total'));
const myAmtCol = headers.find(h => h.includes('My Amount'));
const discCol = headers.find(h => h.includes('Total Discount'));
const taxCol = headers.find(h => h.includes('Total Tax'));
const roundCol = headers.find(h => h.includes('Round Off'));
const delCol = headers.find(h => h.includes('Delivery Charge'));
const contCol = headers.find(h => h.includes('Container Charge'));

// Show ALL columns for Part Payment orders
console.log('=== PART PAYMENT ORDERS - ALL COLUMNS ===');
allRows.filter(r => String(r['Payment Type'] || '').trim() === 'Part Payment').forEach(r => {
  console.log('\nOrder #' + r['Order No.'] + ':');
  console.log('  OrderType: ' + r['Order Type']);
  console.log('  SubType:   ' + r['Sub Order Type']);
  console.log('  Items:     ' + r['Items']);
  console.log('  MyAmount:  ' + r2(r[myAmtCol]));
  console.log('  Discount:  ' + r2(r[discCol]));
  console.log('  DelCharge: ' + r2(r[delCol]));
  console.log('  ContChg:   ' + r2(r[contCol]));
  console.log('  Tax:       ' + r2(r[taxCol]));
  console.log('  RoundOff:  ' + r2(r[roundCol]));
  console.log('  GrandTotal:' + r2(r[gtCol]));
  console.log('  PayType:   ' + r['Payment Type']);
  console.log('  PayDesc:   ' + r['Payment Description']);
  console.log('  Status:    ' + r['Status']);
  console.log('  Created:   ' + r['Created']);
  
  // Calculate: myAmt - disc + tax + roundOff + del + cont
  const calc = r2(r2(r[myAmtCol]) - r2(r[discCol]) + r2(r[taxCol]) + r2(r[roundCol]) + r2(r[delCol]) + r2(r[contCol]));
  const payDescTotal = parseFloat((String(r['Payment Description'] || '').match(/Total\s*:\s*([\d.]+)/) || [0, 0])[1]);
  console.log('  Calculated:' + calc);
  console.log('  PayDescAmt:' + payDescTotal);
  console.log('  CalcMatch: ' + (Math.abs(calc - payDescTotal) <= 1 ? 'YES' : 'NO (diff=' + r2(calc - payDescTotal) + ')'));
});

// Show Due Payment orders
console.log('\n=== DUE PAYMENT ORDERS ===');
allRows.filter(r => String(r['Payment Type'] || '').trim() === 'Due Payment').forEach(r => {
  console.log('\nOrder #' + r['Order No.'] + ':');
  console.log('  Table:     ' + r['Order Type']);
  console.log('  SubType:   ' + r['Sub Order Type']);
  console.log('  MyAmount:  ' + r2(r[myAmtCol]));
  console.log('  GrandTotal:' + r2(r[gtCol]));
  console.log('  Created:   ' + r['Created']);
});

// Show "Pick Up" orders
console.log('\n=== PICK UP ORDERS ===');
allRows.filter(r => String(r['Sub Order Type'] || '').trim() === 'Pick Up').forEach(r => {
  console.log('  #' + r['Order No.'] + ' | ' + r['Order Type'] + ' | GrandTotal=' + r2(r[gtCol]) + ' | Pay=' + r['Payment Type'] + ' | Created=' + r['Created']);
});

// Final count summary
console.log('\n=== IMPORT SUMMARY ===');
// Group by orderNo
const groups = {};
allRows.forEach(r => {
  const no = String(r['Order No.']);
  if (!groups[no]) groups[no] = [];
  groups[no].push(r);
});

// Filter excluded
const excluded = new Set();
for (const [no, rows] of Object.entries(groups)) {
  const main = rows[0];
  const sub = String(main['Sub Order Type'] || '').toLowerCase();
  const pay = String(main['Payment Type'] || '').toLowerCase();
  if (sub.includes('zomato') || sub.includes('swiggy') || pay === 'online') {
    excluded.add(no);
  }
}

const importable = Object.entries(groups).filter(([no]) => !excluded.has(no));
console.log('Total unique orders: ' + Object.keys(groups).length);
console.log('Excluded (Zomato/Swiggy/Online): ' + excluded.size + ' -> ' + [...excluded].join(', '));
console.log('Importable: ' + importable.length);

let totalGrand = 0;
for (const [no, rows] of importable) {
  const main = rows[0];
  const payType = String(main['Payment Type'] || '').trim();
  let grand;
  if (payType === 'Part Payment') {
    const match = String(main['Payment Description'] || '').match(/Total\s*:\s*([\d.]+)/);
    grand = match ? parseFloat(match[1]) : 0;
  } else {
    grand = r2(main[gtCol]);
  }
  totalGrand += grand;
}
console.log('Total Grand Total (importable): ' + r2(totalGrand));

// By floor
const byFloor = {};
for (const [no, rows] of importable) {
  const main = rows[0];
  const sub = String(main['Sub Order Type'] || '').trim() || 'UNKNOWN';
  if (!byFloor[sub]) byFloor[sub] = { count: 0, total: 0 };
  byFloor[sub].count++;
  const payType = String(main['Payment Type'] || '').trim();
  let grand;
  if (payType === 'Part Payment') {
    const match = String(main['Payment Description'] || '').match(/Total\s*:\s*([\d.]+)/);
    grand = match ? parseFloat(match[1]) : 0;
  } else {
    grand = r2(main[gtCol]);
  }
  byFloor[sub].total += grand;
}
for (const [k, v] of Object.entries(byFloor)) {
  console.log('  ' + k + ': ' + v.count + ' orders, Rs ' + r2(v.total));
}
