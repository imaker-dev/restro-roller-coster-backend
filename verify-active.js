require('dotenv').config();
const { initializeDatabase, getPool } = require('./src/database');

async function verify() {
  await initializeDatabase();
  const pool = getPool();
  const [r] = await pool.query("SELECT COUNT(*) as total FROM franchises WHERE status='active'");
  console.log('Active franchises:', r[0].total);
  const [rows] = await pool.query("SELECT id, name, slug, status FROM franchises WHERE status='active' LIMIT 1");
  console.log('First active:', rows[0]);
  process.exit(0);
}

verify().catch((e) => { console.error(e.message); process.exit(1); });
