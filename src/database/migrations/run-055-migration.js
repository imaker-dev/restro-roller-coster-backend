/**
 * Migration 055: Add composite index on table_sessions(table_id, status)
 * Optimizes peak-time table detail lookups
 * 
 * Usage: node src/database/migrations/run-055-migration.js
 */

require('dotenv').config();
const { initializeDatabase, getPool } = require('../index');

async function run() {
  console.log('Running migration 055: Add composite index on table_sessions...');
  
  await initializeDatabase();
  const pool = getPool();

  try {
    // Check if composite index already exists
    const [indexes] = await pool.query(
      `SHOW INDEX FROM table_sessions WHERE Key_name = 'idx_table_sessions_table_status'`
    );

    if (indexes.length > 0) {
      console.log('idx_table_sessions_table_status already exists. Skipping.');
    } else {
      await pool.query(
        'ALTER TABLE table_sessions ADD INDEX idx_table_sessions_table_status (table_id, status)'
      );
      console.log('idx_table_sessions_table_status added.');
    }

    console.log('Migration 055 complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }

  process.exit(0);
}

run();
