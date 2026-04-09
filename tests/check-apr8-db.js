const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

(async () => {
  const p = mysql.createPool({ ...dbCfg });

  // Sample order_items from latest order
  const [latestOrder] = await p.query('SELECT id FROM orders WHERE outlet_id = 46 ORDER BY id DESC LIMIT 1');
  if (latestOrder.length > 0) {
    const [oi] = await p.query('SELECT * FROM order_items WHERE order_id = ? LIMIT 3', [latestOrder[0].id]);
    console.log('=== SAMPLE order_items (order ' + latestOrder[0].id + ') ===');
    if (oi.length > 0) console.log(JSON.stringify(oi[0], null, 2));
    else console.log('  No items found for this order');
  }

  // Existing Apr 8 orders
  const [ex] = await p.query('SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total FROM orders WHERE outlet_id = 46 AND order_number LIKE ?', ['ORD260408%']);
  console.log('\n=== EXISTING APR 8 ORDERS ===');
  console.log('Count:', ex[0].cnt, 'Total:', parseFloat(ex[0].total));

  // Apr 8 shifts
  const [sh] = await p.query('SELECT id, floor_id, cashier_id, session_date, opening_time, closing_time, total_sales FROM day_sessions WHERE outlet_id = 46 AND session_date = ?', ['2026-04-08']);
  console.log('\n=== APR 8 SHIFTS ===');
  sh.forEach(s => console.log('  Shift', s.id, '| floor', s.floor_id, '| cashier', s.cashier_id, '| open:', s.opening_time, '| close:', s.closing_time, '| sales:', parseFloat(s.total_sales)));

  // Tax group for outlet 46
  const [tg] = await p.query('SELECT tg.id, tg.name, tg.tax_rate FROM tax_groups tg WHERE tg.outlet_id = 46 LIMIT 5');
  console.log('\n=== TAX GROUPS ===');
  tg.forEach(t => console.log('  id=' + t.id, 'name=' + t.name, 'rate=' + t.tax_rate));

  // Check how items link to tax
  const [itemTax] = await p.query('SELECT i.id, i.name, i.base_price, i.tax_group_id, i.tax_enabled FROM items i WHERE i.outlet_id = 46 AND i.is_active = 1 LIMIT 5');
  console.log('\n=== SAMPLE ITEMS WITH TAX ===');
  itemTax.forEach(t => console.log('  id=' + t.id, 'name=' + t.name, 'price=' + t.base_price, 'taxGroup=' + t.tax_group_id, 'taxEnabled=' + t.tax_enabled));

  // Check variants table columns
  const [vcols] = await p.query('SHOW COLUMNS FROM variants');
  console.log('\n=== VARIANT COLUMNS ===');
  vcols.forEach(c => console.log('  ' + c.Field + ' | ' + c.Type));

  await p.end();
})();
