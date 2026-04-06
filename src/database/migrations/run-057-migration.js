require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeDatabase, getPool } = require('../index');

(async () => {
  await initializeDatabase();
  const pool = getPool();
  
  const sql = fs.readFileSync(
    path.join(__dirname, '057_item_transfer.sql'),
    'utf8'
  );

  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('--'));

  for (const stmt of statements) {
    try {
      console.log(`Running: ${stmt.substring(0, 80)}...`);
      await pool.query(stmt);
      console.log('  ✅ OK');
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_DUP_FIELDNAME') {
        console.log(`  ⚠️ Already exists, skipping`);
      } else {
        console.error(`  ❌ ${e.message}`);
      }
    }
  }

  console.log('\n✅ Migration 057 complete');
  process.exit(0);
})();
