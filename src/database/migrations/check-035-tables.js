require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
  try {
    const tables = ['units', 'vendors', 'inventory_categories', 'inventory_items', 'inventory_batches', 'inventory_movements', 'purchases', 'purchase_items'];
    for (const t of tables) {
      const [r] = await c.query(`SHOW TABLES LIKE '${t}'`);
      console.log(`${t}: ${r.length > 0 ? 'EXISTS' : 'MISSING'}`);
    }
    // Show last error
    const [err] = await c.query('SHOW ENGINE INNODB STATUS');
    const status = err[0]?.Status || '';
    const fkMatch = status.match(/LATEST FOREIGN KEY ERROR[\s\S]*?---/);
    if (fkMatch) console.log('\nFK Error:', fkMatch[0].substring(0, 500));
  } finally {
    await c.end();
  }
})();
