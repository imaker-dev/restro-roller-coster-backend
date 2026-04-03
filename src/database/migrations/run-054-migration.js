/**
 * Migration 054: Add weight column to order_items
 * Weight is a string field (e.g., "500gm", "50ml", "1.5kg")
 * 
 * Usage: node src/database/migrations/run-054-migration.js
 */

require('dotenv').config();
const { initializeDatabase, getPool } = require('../index');

async function run() {
  console.log('🔧 Running migration 054: Add weight column to order_items...');
  
  await initializeDatabase();
  const pool = getPool();

  try {
    // Check if column already exists
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_items' AND COLUMN_NAME = 'weight'`
    );

    if (cols.length > 0) {
      const existing = cols[0];
      if (existing.DATA_TYPE === 'varchar') {
        console.log('✅ weight column already exists as VARCHAR. Skipping.');
      } else {
        // Column exists but wrong type (e.g., DECIMAL from previous migration) — alter it
        console.log(`⚠️  weight column exists as ${existing.DATA_TYPE}. Altering to VARCHAR(50)...`);
        await pool.query('ALTER TABLE order_items MODIFY COLUMN weight VARCHAR(50) DEFAULT NULL');
        console.log('✅ weight column altered to VARCHAR(50).');
      }
    } else {
      await pool.query('ALTER TABLE order_items ADD COLUMN weight VARCHAR(50) DEFAULT NULL AFTER quantity');
      console.log('✅ weight column added to order_items.');
    }

    console.log('✅ Migration 054 complete.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }

  process.exit(0);
}

run();
