/**
 * Examine DB schema for order import:
 * - orders table structure
 * - payments table structure
 * - floors, tables mapping for outlet 46
 * - order_items structure
 * - day_sessions (shifts) for Apr 7
 */
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../src/config/database.config');

(async () => {
  const pool = await mysql.createPool({ host: db.host, port: db.port, user: db.user, password: db.password, database: db.database });

  // 1. Orders table columns
  const [orderCols] = await pool.query(`DESCRIBE orders`);
  console.log('═══ ORDERS TABLE ═══');
  orderCols.forEach(c => console.log(`  ${c.Field.padEnd(25)} ${c.Type.padEnd(30)} ${c.Null} ${c.Default || ''}`));

  // 2. Payments table columns
  const [payCols] = await pool.query(`DESCRIBE payments`);
  console.log('\n═══ PAYMENTS TABLE ═══');
  payCols.forEach(c => console.log(`  ${c.Field.padEnd(25)} ${c.Type.padEnd(30)} ${c.Null} ${c.Default || ''}`));

  // 3. Order_items table columns
  const [itemCols] = await pool.query(`DESCRIBE order_items`);
  console.log('\n═══ ORDER_ITEMS TABLE ═══');
  itemCols.forEach(c => console.log(`  ${c.Field.padEnd(25)} ${c.Type.padEnd(30)} ${c.Null} ${c.Default || ''}`));

  // 4. Floors for outlet 46
  const [floors] = await pool.query(`SELECT * FROM floors WHERE outlet_id = 46 ORDER BY id`);
  console.log('\n═══ FLOORS (outlet 46) ═══');
  floors.forEach(f => console.log(`  id=${f.id} name="${f.name}"`, Object.keys(f).filter(k => k !== 'id' && k !== 'name').map(k => `${k}=${f[k]}`).join(' ')));

  // 5. Tables for outlet 46 
  const [tables] = await pool.query(
    `SELECT t.*, f.name as floor_name 
     FROM tables t 
     JOIN floors f ON t.floor_id = f.id 
     WHERE t.outlet_id = 46 
     ORDER BY f.name, t.name`
  );
  console.log('\n═══ TABLES (outlet 46) ═══');
  tables.forEach(t => console.log(`  id=${t.id} name="${t.name}" floor="${t.floor_name}" (floor_id=${t.floor_id})`));

  // 6. Day sessions (shifts) for Apr 7
  const [shifts] = await pool.query(
    `SELECT ds.id, ds.session_date, ds.opening_time, ds.closing_time, ds.floor_id, ds.cashier_id, u.name as cashier_name, f.name as floor_name
     FROM day_sessions ds
     LEFT JOIN users u ON ds.cashier_id = u.id
     LEFT JOIN floors f ON ds.floor_id = f.id
     WHERE ds.outlet_id = 46 AND ds.session_date = '2026-04-07'
     ORDER BY ds.opening_time`
  );
  console.log('\n═══ SHIFTS for Apr 7 ═══');
  shifts.forEach(s => console.log(`  id=${s.id} date=${s.session_date} floor="${s.floor_name}" cashier="${s.cashier_name}" open=${s.opening_time} close=${s.closing_time}`));

  // Also check if there are any shifts covering Apr 7 business day (session_date could be Apr 6 with closing after 4am Apr 7)
  const [shifts2] = await pool.query(
    `SELECT ds.id, ds.session_date, ds.opening_time, ds.closing_time, ds.floor_id, ds.cashier_id, u.name as cashier_name, f.name as floor_name
     FROM day_sessions ds
     LEFT JOIN users u ON ds.cashier_id = u.id
     LEFT JOIN floors f ON ds.floor_id = f.id
     WHERE ds.outlet_id = 46 AND (
       (ds.opening_time >= '2026-04-07 04:00:00' AND ds.opening_time < '2026-04-08 04:00:00')
       OR (ds.opening_time < '2026-04-07 04:00:00' AND (ds.closing_time > '2026-04-07 04:00:00' OR ds.closing_time IS NULL))
     )
     ORDER BY ds.opening_time`
  );
  console.log('\n═══ SHIFTS covering Apr 7 BD (4am-4am) ═══');
  shifts2.forEach(s => console.log(`  id=${s.id} date=${s.session_date} floor="${s.floor_name}" (${s.floor_id}) cashier="${s.cashier_name}" (${s.cashier_id}) open=${s.opening_time} close=${s.closing_time}`));

  // 7. Sample completed order to understand structure
  const [sampleOrder] = await pool.query(
    `SELECT * FROM orders WHERE outlet_id = 46 AND status = 'completed' ORDER BY id DESC LIMIT 1`
  );
  console.log('\n═══ SAMPLE COMPLETED ORDER ═══');
  if (sampleOrder.length > 0) {
    const o = sampleOrder[0];
    for (const [k, v] of Object.entries(o)) {
      console.log(`  ${k.padEnd(25)} = ${v}`);
    }
  }

  // 8. Sample payment
  const [samplePay] = await pool.query(
    `SELECT * FROM payments WHERE outlet_id = 46 AND status = 'completed' ORDER BY id DESC LIMIT 1`
  );
  console.log('\n═══ SAMPLE PAYMENT ═══');
  if (samplePay.length > 0) {
    const p = samplePay[0];
    for (const [k, v] of Object.entries(p)) {
      console.log(`  ${k.padEnd(25)} = ${v}`);
    }
  }

  // 9. Max order_number for outlet 46 to understand naming
  const [maxOrd] = await pool.query(
    `SELECT order_number FROM orders WHERE outlet_id = 46 ORDER BY id DESC LIMIT 5`
  );
  console.log('\n═══ LATEST ORDER NUMBERS ═══');
  maxOrd.forEach(o => console.log(`  ${o.order_number}`));

  // 10. Users (cashiers) for outlet 46
  const [users] = await pool.query(
    `SELECT id, name, role FROM users WHERE outlet_id = 46 AND role IN ('cashier','admin','manager') ORDER BY id`
  );
  console.log('\n═══ CASHIERS/STAFF ═══');
  users.forEach(u => console.log(`  id=${u.id} name="${u.name}" role=${u.role}`));

  await pool.end();
})();
