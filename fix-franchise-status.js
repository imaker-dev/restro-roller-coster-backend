require('dotenv').config();
const { initializeDatabase, getPool } = require('./src/database');

async function fix() {
  await initializeDatabase();
  const pool = getPool();
  await pool.execute("UPDATE franchises SET status = 'active', is_featured = 1 WHERE id = 1");
  console.log('Franchise id=1 updated to active');
  process.exit(0);
}

fix().catch((e) => { console.error(e.message); process.exit(1); });
