const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../src/config/database.config');

(async () => {
  const p = await mysql.createPool({ host: db.host, port: db.port, user: db.user, password: db.password, database: db.database });
  
  // Check order number format
  const [sample] = await p.query(
    `SELECT id, order_number, status, total_amount, order_type, created_at 
     FROM orders WHERE outlet_id = 46 
     ORDER BY id DESC LIMIT 10`
  );
  console.log('Latest 10 orders (any date):');
  sample.forEach(o => console.log(`  id=${o.id} order_number="${o.order_number}" status=${o.status} total=${o.total_amount} type=${o.order_type} created=${o.created_at}`));

  // Check for business day Apr 7 (4am Apr 7 to 4am Apr 8)
  const [bd7] = await p.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as total,
            GROUP_CONCAT(DISTINCT status) as statuses,
            MIN(order_number) as min_order, MAX(order_number) as max_order
     FROM orders WHERE outlet_id = 46 AND created_at >= '2026-04-07 04:00:00' AND created_at < '2026-04-08 04:00:00'`
  );
  console.log('\nBusiness day Apr 7 (4am-4am):');
  console.log(`  Count: ${bd7[0].cnt}, Total: ${bd7[0].total}, Statuses: ${bd7[0].statuses}`);
  console.log(`  Order range: ${bd7[0].min_order} to ${bd7[0].max_order}`);

  // List all orders from Apr 7 business day
  const [orders7] = await p.query(
    `SELECT id, order_number, status, total_amount, order_type, payment_status, created_at
     FROM orders WHERE outlet_id = 46 AND created_at >= '2026-04-07 04:00:00' AND created_at < '2026-04-08 04:00:00'
     ORDER BY created_at DESC`
  );
  console.log(`\n  All ${orders7.length} orders for Apr 7 business day:`);
  orders7.forEach(o => console.log(`    #${o.order_number} id=${o.id} ${o.status.padEnd(12)} ${String(o.total_amount).padEnd(10)} ${(o.order_type||'').padEnd(10)} pay=${o.payment_status} ${o.created_at}`));

  // Also check orders with order_number in 3212-3247 range
  const [excelRange] = await p.query(
    `SELECT id, order_number, status, total_amount, created_at
     FROM orders WHERE outlet_id = 46 AND (order_number BETWEEN 3212 AND 3247 OR order_number LIKE '%3212%' OR order_number LIKE '%3247%')
     ORDER BY order_number`
  );
  console.log(`\nOrders with order_number 3212-3247:`, excelRange.length);
  excelRange.forEach(o => console.log(`  #${o.order_number} id=${o.id} ${o.status} ${o.total_amount} ${o.created_at}`));

  await p.end();
})();
