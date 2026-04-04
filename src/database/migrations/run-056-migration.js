require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initializeDatabase, getPool } = require('../index');

(async () => {
  await initializeDatabase();
  const pool = getPool();
  
  const sql = fs.readFileSync(
    path.join(__dirname, '056_hot_query_composite_indexes.sql'),
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
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log(`  ⚠️ Index already exists, skipping`);
      } else {
        console.error(`  ❌ ${e.message}`);
      }
    }
  }

  console.log('\nDone. Verifying with EXPLAIN...\n');

  // Verify the hot queries now use the new indexes
  const [e1] = await pool.query(`EXPLAIN SELECT ts.* FROM table_sessions ts WHERE ts.table_id = 1 AND ts.status IN ('active', 'billing') ORDER BY ts.started_at DESC LIMIT 1`);
  console.log('table_sessions:');
  e1.forEach(r => console.log(`  type=${r.type} key=${r.key} rows=${r.rows} Extra=${r.Extra}`));

  const [e2] = await pool.query(`EXPLAIN SELECT * FROM table_history WHERE table_id = 1 ORDER BY created_at DESC LIMIT 10`);
  console.log('table_history:');
  e2.forEach(r => console.log(`  type=${r.type} key=${r.key} rows=${r.rows} Extra=${r.Extra}`));

  const [e3] = await pool.query(`EXPLAIN SELECT oi.* FROM order_items oi WHERE oi.order_id = 1 ORDER BY oi.created_at`);
  console.log('order_items:');
  e3.forEach(r => console.log(`  type=${r.type} key=${r.key} rows=${r.rows} Extra=${r.Extra}`));

  const [e4] = await pool.query(`EXPLAIN SELECT kt.*, COUNT(ki.id) FROM kot_tickets kt LEFT JOIN kot_items ki ON ki.kot_id = kt.id WHERE kt.order_id = 1 GROUP BY kt.id ORDER BY kt.created_at`);
  console.log('kot_tickets:');
  e4.forEach(r => console.log(`  type=${r.type} key=${r.key} rows=${r.rows} Extra=${r.Extra}`));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
