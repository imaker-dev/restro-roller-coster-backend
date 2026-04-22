require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeDatabase, getPool } = require('../src/database');

(async () => {
  await initializeDatabase();
  const pool = getPool();

  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'database', 'migrations', '059_add_nc_tax_amount_to_invoices.sql'),
    'utf8'
  );

  // Remove comment lines first, then split by semicolons
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

  console.log('\n✅ Migration 059 complete');
  process.exit(0);
})();
