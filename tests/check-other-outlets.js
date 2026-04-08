const mysql = require('mysql2/promise');
(async () => {
  const p = mysql.createPool({ host: 'localhost', user: 'root', password: '', database: 'restro', dateStrings: true });
  
  const [r1] = await p.query(
    `SELECT o.outlet_id, ol.name as outlet_name, COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as total
     FROM orders o JOIN outlets ol ON o.outlet_id = ol.id
     WHERE o.outlet_id != 46 AND o.created_at BETWEEN '2026-04-01' AND '2026-04-07 23:59:59' AND o.status = 'completed'
     GROUP BY o.outlet_id, ol.name`
  );
  console.log('=== ORDERS IN OTHER OUTLETS (Apr 1-7) ===');
  if (r1.length === 0) console.log('  None');
  else r1.forEach(o => console.log('  Outlet ' + o.outlet_id + ' (' + o.outlet_name + '): ' + o.cnt + ' orders, total=' + parseFloat(o.total)));

  // Check if any orders were deleted/soft-deleted
  const [r2] = await p.query(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total FROM orders 
     WHERE outlet_id = 46 AND created_at BETWEEN '2026-04-01' AND '2026-04-07 23:59:59'`
  );
  console.log('\nTotal orders (ALL statuses) in outlet 46, Apr 1-7: ' + r2[0].cnt + ', total=' + parseFloat(r2[0].total));

  const [r3] = await p.query(
    `SELECT status, COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
     FROM orders WHERE outlet_id = 46 AND created_at BETWEEN '2026-04-01' AND '2026-04-07 23:59:59'
     GROUP BY status`
  );
  console.log('By status:');
  r3.forEach(o => console.log('  ' + o.status + ': ' + o.cnt + ' orders, total=' + parseFloat(o.total)));

  // Check day-wise total including ALL statuses
  console.log('\n=== DAY-WISE TOTAL (ALL statuses) ===');
  for (let d = 1; d <= 7; d++) {
    const ds = '2026-04-' + String(d).padStart(2, '0');
    const [r4] = await p.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ?`,
      [ds + ' 00:00:00', ds + ' 23:59:59']
    );
    console.log('  ' + ds + ': ' + r4[0].cnt + ' orders, total=' + parseFloat(r4[0].total));
  }

  // Check if there are KOT/bills that don't have corresponding orders
  // Check tables in DB related to billing
  const [tables] = await p.query("SHOW TABLES LIKE '%bill%'");
  console.log('\n=== BILLING-RELATED TABLES ===');
  tables.forEach(t => console.log('  ' + Object.values(t)[0]));

  const [tables2] = await p.query("SHOW TABLES LIKE '%invoice%'");
  tables2.forEach(t => console.log('  ' + Object.values(t)[0]));

  const [tables3] = await p.query("SHOW TABLES LIKE '%kot%'");
  tables3.forEach(t => console.log('  ' + Object.values(t)[0]));

  await p.end();
})();
