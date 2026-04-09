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
  const gtCol = headers.find(h => h.includes('Grand Total'));
  const myAmtCol = headers.find(h => h.includes('My Amount'));

  // Group rows by Order No to understand Part Payment / Not Paid structure
  console.log('=== ORDER GROUPING ANALYSIS ===');
  const groups = {};
  allRows.forEach(r => {
    const no = String(r['Order No.']);
    if (!groups[no]) groups[no] = [];
    groups[no].push(r);
  });

  const multiRowOrders = Object.entries(groups).filter(([k, v]) => v.length > 1);
  console.log('Total unique order numbers: ' + Object.keys(groups).length);
  console.log('Multi-row orders: ' + multiRowOrders.length);

  for (const [orderNo, rows] of multiRowOrders) {
    console.log('\n  Order #' + orderNo + ' (' + rows.length + ' rows):');
    rows.forEach((r, i) => {
      console.log('    Row ' + i + ': SubType="' + r['Sub Order Type'] + '" | OrderType="' + r['Order Type'] + '" | GrandTotal=' + r2(r[gtCol]) + ' | MyAmt=' + r2(r[myAmtCol]) + ' | Pay="' + r['Payment Type'] + '" | PayDesc="' + r['Payment Description'] + '" | Created="' + r['Created'] + '"');
    });
  }

  // DB: Check items table
  const pool = mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  const [itemsCols] = await pool.query('SHOW COLUMNS FROM items');
  console.log('\n=== items TABLE KEY COLUMNS ===');
  itemsCols.forEach(c => console.log('  ' + c.Field + ' | ' + c.Type));

  // Get all active items for outlet 46
  const [dbItems] = await pool.query(
    `SELECT i.id, i.name, i.base_price as price, i.item_type, i.has_variants, c.name as category_name
     FROM items i 
     LEFT JOIN categories c ON i.category_id = c.id
     WHERE i.outlet_id = 46 AND i.is_active = 1
     ORDER BY i.name`
  );
  console.log('\nActive items in outlet 46: ' + dbItems.length);

  // Check for variants
  const [variants] = await pool.query(
    `SELECT v.id, v.name, v.price, v.item_id, i.name as item_name
     FROM variants v 
     JOIN items i ON v.item_id = i.id
     WHERE i.outlet_id = 46 AND i.is_active = 1
     ORDER BY i.name, v.name`
  );
  console.log('Active variants: ' + variants.length);

  // Build match map: name -> item info (including variants)
  const matchMap = {};
  dbItems.forEach(i => { matchMap[i.name.toLowerCase().trim()] = { id: i.id, name: i.name, price: parseFloat(i.price), type: i.item_type, cat: i.category_name }; });
  // Also add "ItemName (VariantName)" format
  variants.forEach(v => {
    const key = (v.item_name + ' (' + v.name + ')').toLowerCase().trim();
    matchMap[key] = { id: v.item_id, variantId: v.id, name: v.item_name, variantName: v.name, price: parseFloat(v.price), type: null };
  });

  // Extract all unique items from Excel and try matching
  const allExcelItems = new Set();
  allRows.forEach(r => {
    const items = String(r['Items'] || '');
    if (items) items.split(',').forEach(i => allExcelItems.add(i.trim()));
  });

  console.log('\n=== ITEM MATCHING: Excel -> DB ===');
  let matched = 0, unmatched = 0;
  const unmatchedItems = [];
  for (const excelItem of [...allExcelItems].sort()) {
    const key = excelItem.toLowerCase().trim();
    if (matchMap[key]) {
      matched++;
      const m = matchMap[key];
      const vInfo = m.variantId ? ' variant=' + m.variantName + '(id=' + m.variantId + ')' : '';
      console.log('  OK: "' + excelItem + '" -> item_id=' + m.id + ' price=' + m.price + vInfo);
    } else {
      unmatched++;
      unmatchedItems.push(excelItem);
      console.log('  MISS: "' + excelItem + '"');
    }
  }
  console.log('\nMatched: ' + matched + '/' + allExcelItems.size + ', Unmatched: ' + unmatched);

  if (unmatchedItems.length > 0) {
    console.log('\n=== TRYING FUZZY MATCH FOR UNMATCHED ===');
    for (const item of unmatchedItems) {
      const parts = item.toLowerCase().split('(')[0].trim();
      const candidates = dbItems.filter(i => i.name.toLowerCase().includes(parts) || parts.includes(i.name.toLowerCase()));
      const varCandidates = variants.filter(v => {
        const fullName = (v.item_name + ' (' + v.name + ')').toLowerCase();
        return fullName.includes(parts) || parts.includes(v.item_name.toLowerCase());
      });
      if (candidates.length > 0 || varCandidates.length > 0) {
        console.log('  "' + item + '" -> possible:');
        candidates.forEach(c => console.log('    item: ' + c.name + ' (id=' + c.id + ', price=' + c.price + ')'));
        varCandidates.forEach(v => console.log('    variant: ' + v.item_name + ' (' + v.name + ') (item_id=' + v.item_id + ', var_id=' + v.id + ', price=' + v.price + ')'));
      } else {
        console.log('  "' + item + '" -> NO MATCH AT ALL');
      }
    }
  }

  // Check a sample order_items record to understand the pattern
  const [sampleOI] = await pool.query(
    `SELECT oi.*, i.name as db_item_name FROM order_items oi JOIN items i ON oi.item_id = i.id
     WHERE oi.order_id IN (SELECT id FROM orders WHERE outlet_id = 46 LIMIT 1) LIMIT 5`
  );
  console.log('\n=== SAMPLE order_items RECORD ===');
  if (sampleOI.length > 0) console.log(JSON.stringify(sampleOI[0], null, 2));

  // Check existing Apr 8 data
  const [existing] = await pool.query(
    `SELECT COUNT(*) as cnt FROM orders WHERE outlet_id = 46 AND order_number LIKE 'ORD260408%'`
  );
  console.log('\n=== EXISTING APR 8 ORDERS (ORD260408%) ===');
  console.log('Count: ' + existing[0].cnt);

  const [existingShifts] = await pool.query(
    `SELECT id, floor_id, cashier_id, session_date, opening_time, closing_time, total_sales
     FROM day_sessions WHERE outlet_id = 46 AND session_date = '2026-04-08'`
  );
  console.log('\n=== EXISTING APR 8 SHIFTS ===');
  existingShifts.forEach(s => console.log('  Shift ' + s.id + ' | Floor ' + s.floor_id + ' | Cashier ' + s.cashier_id + ' | Open: ' + s.opening_time + ' | Close: ' + s.closing_time + ' | Sales: ' + parseFloat(s.total_sales)));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
