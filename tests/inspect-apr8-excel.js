const XLSX = require('xlsx');
const path = require('path');

const file = path.join(__dirname, '8thApril-Order.xlsx');
const wb = XLSX.readFile(file);

console.log('=== SHEETS ===');
console.log(wb.SheetNames);

for (const sheetName of wb.SheetNames) {
  const ws = wb.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  console.log('\n=== SHEET: ' + sheetName + ' ===');
  console.log('Total rows: ' + raw.length);

  // Find header row
  let headerIdx = -1;
  for (let i = 0; i < Math.min(raw.length, 20); i++) {
    if (raw[i].some(c => String(c).includes('Order No'))) { headerIdx = i; break; }
  }

  if (headerIdx === -1) {
    console.log('No header row found with "Order No". First 5 rows:');
    for (let i = 0; i < Math.min(5, raw.length); i++) {
      console.log('  Row ' + i + ': ' + JSON.stringify(raw[i]));
    }
    continue;
  }

  const headers = raw[headerIdx].map(h => String(h || '').trim());
  console.log('\nHeaders (row ' + headerIdx + '): ');
  headers.forEach((h, i) => { if (h) console.log('  Col ' + i + ': "' + h + '"'); });

  // Parse data rows
  const allRows = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || !row[0]) continue;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = row[idx] !== undefined ? row[idx] : ''; });
    allRows.push(obj);
  }

  console.log('\nData rows: ' + allRows.length);

  // Unique values for key columns
  const uniq = (col) => [...new Set(allRows.map(r => String(r[col] || '').trim()))].filter(Boolean);

  console.log('\nUnique "Order Type": ' + JSON.stringify(uniq('Order Type')));
  console.log('Unique "Sub Order Type": ' + JSON.stringify(uniq('Sub Order Type')));
  console.log('Unique "Payment Type": ' + JSON.stringify(uniq('Payment Type')));
  console.log('Unique "Payment Description": ' + JSON.stringify(uniq('Payment Description')));
  console.log('Unique "Order Status": ' + JSON.stringify(uniq('Order Status')));

  // Check what table names are embedded in Order Type
  const tableNames = new Set();
  allRows.forEach(r => {
    const m = String(r['Order Type'] || '').match(/\(([^)]+)\)/);
    if (m) tableNames.add(m[1].trim().toUpperCase());
  });
  console.log('\nExtracted table names: ' + JSON.stringify([...tableNames].sort()));

  // Check for item-related columns
  const itemCols = headers.filter(h => h.toLowerCase().includes('item') || h.toLowerCase().includes('product') || h.toLowerCase().includes('menu'));
  console.log('\nItem-related columns: ' + JSON.stringify(itemCols));

  // Print first 3 rows as sample
  console.log('\nSample rows (first 3):');
  for (let i = 0; i < Math.min(3, allRows.length); i++) {
    console.log('  Row ' + i + ': ' + JSON.stringify(allRows[i]));
  }

  // Check amounts
  console.log('\nAmount columns present:');
  ['My Amount', 'Total Discount', 'Total Tax', 'Round Off', 'Grand Total', 'Delivery Charge', 'Container Charge', 'Service Charge', 'Packaging Charge'].forEach(col => {
    const fullCol = headers.find(h => h.includes(col));
    if (fullCol) console.log('  "' + fullCol + '" present');
    else console.log('  "' + col + '" NOT FOUND');
  });

  // Count by Sub Order Type
  console.log('\nBy Sub Order Type:');
  const bySub = {};
  allRows.forEach(r => {
    const s = String(r['Sub Order Type'] || '').trim();
    if (!bySub[s]) bySub[s] = { count: 0, total: 0 };
    bySub[s].count++;
    const gt = parseFloat(r['Grand Total (₹)'] || r['Grand Total'] || 0);
    bySub[s].total += gt;
  });
  for (const [k, v] of Object.entries(bySub)) {
    console.log('  ' + k + ': ' + v.count + ' orders, total=' + Math.round(v.total * 100) / 100);
  }

  // Count by Payment Type
  console.log('\nBy Payment Type:');
  const byPay = {};
  allRows.forEach(r => {
    const p = String(r['Payment Type'] || '').trim();
    if (!byPay[p]) byPay[p] = { count: 0, total: 0 };
    byPay[p].count++;
    const gt = parseFloat(r['Grand Total (₹)'] || r['Grand Total'] || 0);
    byPay[p].total += gt;
  });
  for (const [k, v] of Object.entries(byPay)) {
    console.log('  ' + k + ': ' + v.count + ' orders, total=' + Math.round(v.total * 100) / 100);
  }

  // Check for Swiggy/Zomato
  const zomatoCount = allRows.filter(r => String(r['Sub Order Type'] || '').toLowerCase().includes('zomato')).length;
  const swiggyCount = allRows.filter(r => String(r['Sub Order Type'] || '').toLowerCase().includes('swiggy')).length;
  const onlineCount = allRows.filter(r => String(r['Payment Type'] || '').toLowerCase().includes('online')).length;
  console.log('\nZomato orders: ' + zomatoCount);
  console.log('Swiggy orders: ' + swiggyCount);
  console.log('Online payment: ' + onlineCount);

  // Check for item details - look for a second sheet or item rows
  console.log('\nAll column headers: ' + JSON.stringify(headers));
}

// Check for additional sheets with item data
if (wb.SheetNames.length > 1) {
  for (let si = 1; si < wb.SheetNames.length; si++) {
    const ws = wb.Sheets[wb.SheetNames[si]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    console.log('\n=== SHEET: ' + wb.SheetNames[si] + ' ===');
    console.log('Total rows: ' + raw.length);
    for (let i = 0; i < Math.min(5, raw.length); i++) {
      console.log('  Row ' + i + ': ' + JSON.stringify(raw[i]));
    }
  }
}
