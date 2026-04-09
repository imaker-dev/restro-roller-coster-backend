const XLSX = require('xlsx');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

async function main() {
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
  const gt = (row) => r2(row['Grand Total (\u20B9)'] || row['Grand Total (Γé╣)'] || 0);
  // Find the actual grand total column name
  const gtCol = headers.find(h => h.includes('Grand Total'));
  const myAmtCol = headers.find(h => h.includes('My Amount'));
  const discCol = headers.find(h => h.includes('Total Discount'));
  const taxCol = headers.find(h => h.includes('Total Tax'));
  const roundCol = headers.find(h => h.includes('Round Off'));
  const delCol = headers.find(h => h.includes('Delivery Charge'));
  const contCol = headers.find(h => h.includes('Container Charge'));
  const itemsCol = 'Items';

  console.log('Grand Total col: "' + gtCol + '"');
  console.log('Total rows: ' + allRows.length);

  // 1. Show rows with EMPTY Sub Order Type
  console.log('\n=== EMPTY Sub Order Type rows ===');
  allRows.filter(r => !String(r['Sub Order Type'] || '').trim()).forEach(r => {
    console.log('  #' + r['Order No.'] + ' | OrderType: ' + r['Order Type'] + ' | Pay: ' + r['Payment Type'] + ' | GrandTotal: ' + r2(r[gtCol]) + ' | Created: ' + r['Created'] + ' | Items: ' + String(r[itemsCol] || '').substring(0, 80));
  });

  // 2. Show "Part Payment" rows
  console.log('\n=== Part Payment rows ===');
  allRows.filter(r => String(r['Payment Type'] || '').trim() === 'Part Payment').forEach(r => {
    console.log('  #' + r['Order No.'] + ' | SubType: ' + r['Sub Order Type'] + ' | GrandTotal: ' + r2(r[gtCol]) + ' | MyAmt: ' + r2(r[myAmtCol]) + ' | PayDesc: ' + r['Payment Description'] + ' | Created: ' + r['Created']);
  });

  // 3. Show "Not Paid" rows
  console.log('\n=== Not Paid rows ===');
  allRows.filter(r => String(r['Payment Type'] || '').trim() === 'Not Paid').forEach(r => {
    console.log('  #' + r['Order No.'] + ' | SubType: ' + r['Sub Order Type'] + ' | OrderType: ' + r['Order Type'] + ' | GrandTotal: ' + r2(r[gtCol]) + ' | Status: ' + r['Status'] + ' | Created: ' + r['Created']);
  });

  // 4. Show "Pick Up" and "Delivery" rows
  console.log('\n=== Pick Up / Delivery rows ===');
  allRows.filter(r => {
    const sub = String(r['Sub Order Type'] || '').trim();
    const ot = String(r['Order Type'] || '').trim();
    return sub === 'Pick Up' || ot === 'Delivery' || ot === 'Pick Up';
  }).forEach(r => {
    console.log('  #' + r['Order No.'] + ' | OrderType: ' + r['Order Type'] + ' | SubType: ' + r['Sub Order Type'] + ' | Pay: ' + r['Payment Type'] + ' | GrandTotal: ' + r2(r[gtCol]) + ' | Created: ' + r['Created']);
  });

  // 5. Show Zomato/Swiggy/Online rows
  console.log('\n=== Zomato / Swiggy / Online rows ===');
  allRows.filter(r => {
    const sub = String(r['Sub Order Type'] || '').toLowerCase();
    const pay = String(r['Payment Type'] || '').toLowerCase();
    return sub.includes('zomato') || sub.includes('swiggy') || pay === 'online';
  }).forEach(r => {
    console.log('  #' + r['Order No.'] + ' | OrderType: ' + r['Order Type'] + ' | SubType: ' + r['Sub Order Type'] + ' | Pay: ' + r['Payment Type'] + ' | GrandTotal: ' + r2(r[gtCol]));
  });

  // 6. Items analysis
  console.log('\n=== ITEMS ANALYSIS ===');
  const allItemNames = new Set();
  allRows.forEach(r => {
    const items = String(r[itemsCol] || '');
    if (items) {
      items.split(',').forEach(i => allItemNames.add(i.trim()));
    }
  });
  console.log('Unique item names found in Excel: ' + allItemNames.size);
  const sortedItems = [...allItemNames].sort();
  sortedItems.forEach(i => console.log('  - ' + i));

  // 7. DB: Check order_items structure
  const pool = mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  const [oiCols] = await pool.query('SHOW COLUMNS FROM order_items');
  console.log('\n=== order_items TABLE COLUMNS ===');
  oiCols.forEach(c => console.log('  ' + c.Field + ' | ' + c.Type + ' | ' + (c.Null === 'YES' ? 'NULL' : 'NOT NULL') + ' | Default: ' + c.Default));

  // 8. DB: Check if menu_items or products table exists
  const [menuTables] = await pool.query("SHOW TABLES LIKE '%menu%'");
  const [prodTables] = await pool.query("SHOW TABLES LIKE '%product%'");
  const [itemTables] = await pool.query("SHOW TABLES LIKE '%item%'");
  console.log('\n=== Item/Menu/Product related tables ===');
  [...menuTables, ...prodTables, ...itemTables].forEach(t => console.log('  ' + Object.values(t)[0]));

  // 9. DB: Get menu items for outlet 46 — find matching items
  const [menuItems] = await pool.query(
    `SELECT mi.id, mi.name, mi.category_id, mi.price, mc.name as category_name
     FROM menu_items mi 
     LEFT JOIN menu_categories mc ON mi.category_id = mc.id
     WHERE mi.outlet_id = 46 AND mi.is_active = 1
     ORDER BY mi.name`
  );
  console.log('\n=== MENU ITEMS (outlet 46, active) ===');
  console.log('Total: ' + menuItems.length);

  // Try to match Excel items to DB menu items
  console.log('\n=== ITEM MATCHING ===');
  let matched = 0, unmatched = 0;
  const menuMap = {};
  menuItems.forEach(mi => { menuMap[mi.name.toLowerCase().trim()] = mi; });

  for (const excelItem of sortedItems) {
    const key = excelItem.toLowerCase().trim();
    if (menuMap[key]) {
      matched++;
      console.log('  MATCH: "' + excelItem + '" -> id=' + menuMap[key].id + ' price=' + menuMap[key].price + ' cat=' + menuMap[key].category_name);
    } else {
      unmatched++;
      // Try partial match
      const partial = menuItems.filter(mi => mi.name.toLowerCase().includes(key.split('(')[0].trim().toLowerCase()));
      if (partial.length > 0) {
        console.log('  PARTIAL: "' + excelItem + '" -> possible: ' + partial.map(p => p.name + '(id=' + p.id + ')').join(', '));
      } else {
        console.log('  NO MATCH: "' + excelItem + '"');
      }
    }
  }
  console.log('\nMatched: ' + matched + ', Unmatched: ' + unmatched);

  // 10. Check existing Apr 8 orders in DB
  const [existing] = await pool.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
     FROM orders WHERE outlet_id = 46 AND created_at BETWEEN '2026-04-08 00:00:00' AND '2026-04-08 23:59:59'`
  );
  console.log('\n=== EXISTING APR 8 ORDERS IN DB ===');
  console.log('Count: ' + existing[0].cnt + ', Total: ' + parseFloat(existing[0].total));

  // 11. Check existing shifts for Apr 8
  const [shifts] = await pool.query(
    `SELECT ds.id, ds.floor_id, ds.cashier_id, ds.session_date, ds.opening_time, ds.closing_time, ds.total_sales, u.name
     FROM day_sessions ds LEFT JOIN users u ON ds.cashier_id = u.id
     WHERE ds.outlet_id = 46 AND ds.session_date = '2026-04-08'`
  );
  console.log('\n=== EXISTING APR 8 SHIFTS ===');
  shifts.forEach(s => console.log('  Shift ' + s.id + ' | Floor ' + s.floor_id + ' | ' + s.name + ' | Sales: ' + parseFloat(s.total_sales)));

  // 12. Date range analysis
  console.log('\n=== DATE RANGE IN EXCEL ===');
  const dates = allRows.map(r => String(r['Created'] || '')).filter(Boolean);
  dates.sort();
  console.log('Earliest: ' + dates[0]);
  console.log('Latest: ' + dates[dates.length - 1]);

  // Show count by date
  const byDate = {};
  allRows.forEach(r => {
    const created = String(r['Created'] || '').trim();
    const d = new Date(created);
    if (!isNaN(d.getTime())) {
      const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (!byDate[ds]) byDate[ds] = 0;
      byDate[ds]++;
    }
  });
  console.log('Orders by date:');
  for (const [d, c] of Object.entries(byDate)) console.log('  ' + d + ': ' + c + ' orders');

  // 13. Show IMPORTABLE orders (excluding Zomato/Swiggy/Online)
  const importable = allRows.filter(r => {
    const sub = String(r['Sub Order Type'] || '').toLowerCase();
    const pay = String(r['Payment Type'] || '').toLowerCase();
    return !sub.includes('zomato') && !sub.includes('swiggy') && pay !== 'online';
  });
  console.log('\n=== IMPORTABLE ORDERS (excl Zomato/Swiggy/Online) ===');
  console.log('Count: ' + importable.length);
  let importTotal = 0;
  importable.forEach(r => importTotal += r2(r[gtCol]));
  console.log('Grand Total: ' + r2(importTotal));

  // Breakdown
  const impByFloor = {};
  importable.forEach(r => {
    const sub = String(r['Sub Order Type'] || '').trim() || 'EMPTY';
    if (!impByFloor[sub]) impByFloor[sub] = { count: 0, total: 0 };
    impByFloor[sub].count++;
    impByFloor[sub].total += r2(r[gtCol]);
  });
  console.log('By Sub Order Type:');
  for (const [k, v] of Object.entries(impByFloor)) {
    console.log('  ' + k + ': ' + v.count + ' orders, total=' + r2(v.total));
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
