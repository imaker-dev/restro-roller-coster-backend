require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeDatabase, getPool } = require('../src/database');

(async () => {
  await initializeDatabase();
  const pool = getPool();

  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'database', 'migrations', '062_add_phone_to_token_log.sql'),
    'utf8'
  );

  const cleaned = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  const statements = cleaned
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    try {
      console.log(`Running: ${stmt.substring(0, 80)}...`);
      await pool.query(stmt);
      console.log('  ✅ OK');
    } catch (e) {
      if (e.code === 'ER_TABLE_EXISTS_ERROR' || e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_DUP_FIELDNAME') {
        console.log(`  ⚠️ Already exists, skipping`);
      } else {
        console.error(`  ❌ ${e.message}`);
      }
    }
  }

  console.log('\n✅ Migration 062 complete');
  process.exit(0);
})();
