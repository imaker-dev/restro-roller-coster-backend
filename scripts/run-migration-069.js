/**
 * Migration 069: Smart Session Expiry for Self-Order
 * 
 * Adds columns for intelligent session timeout:
 * - idle_timeout_minutes: Time before session expires if no order placed (default: 20)
 * - order_completed_at: Timestamp when order was completed/cancelled
 * - completion_buffer_minutes: Time after completion before session expires (default: 5)
 * 
 * Run: node scripts/run-migration-069.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

async function runMigration() {
  console.log('\n🚀 Running Migration 069: Smart Session Expiry\n');
  
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: true
  });

  try {
    // Check if columns already exist
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'self_order_sessions' 
       AND COLUMN_NAME IN ('idle_timeout_minutes', 'order_completed_at', 'completion_buffer_minutes')`,
      [dbConfig.database]
    );

    const existingCols = columns.map(c => c.COLUMN_NAME);

    if (!existingCols.includes('idle_timeout_minutes')) {
      console.log('📄 Adding idle_timeout_minutes column...');
      await connection.query(`
        ALTER TABLE self_order_sessions
        ADD COLUMN idle_timeout_minutes INT UNSIGNED DEFAULT 20 AFTER expires_at
      `);
      console.log('✅ idle_timeout_minutes added');
    } else {
      console.log('⚠️  idle_timeout_minutes already exists');
    }

    if (!existingCols.includes('order_completed_at')) {
      console.log('📄 Adding order_completed_at column...');
      await connection.query(`
        ALTER TABLE self_order_sessions
        ADD COLUMN order_completed_at DATETIME NULL AFTER idle_timeout_minutes
      `);
      console.log('✅ order_completed_at added');
    } else {
      console.log('⚠️  order_completed_at already exists');
    }

    if (!existingCols.includes('completion_buffer_minutes')) {
      console.log('📄 Adding completion_buffer_minutes column...');
      await connection.query(`
        ALTER TABLE self_order_sessions
        ADD COLUMN completion_buffer_minutes INT UNSIGNED DEFAULT 5 AFTER order_completed_at
      `);
      console.log('✅ completion_buffer_minutes added');
    } else {
      console.log('⚠️  completion_buffer_minutes already exists');
    }

    // Add index if not exists
    const [indexes] = await connection.query(
      `SHOW INDEX FROM self_order_sessions WHERE Key_name = 'idx_so_sessions_order_completed'`
    );
    if (indexes.length === 0) {
      console.log('📄 Adding index idx_so_sessions_order_completed...');
      await connection.query(`
        ALTER TABLE self_order_sessions
        ADD INDEX idx_so_sessions_order_completed (order_completed_at)
      `);
      console.log('✅ Index added');
    } else {
      console.log('⚠️  Index already exists');
    }

    // Update existing sessions
    console.log('📄 Setting default idle_timeout for existing sessions...');
    await connection.query(`
      UPDATE self_order_sessions SET idle_timeout_minutes = 20 WHERE idle_timeout_minutes IS NULL
    `);
    console.log('✅ Defaults applied');

    // Verify
    const [cols] = await connection.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'self_order_sessions' 
       AND COLUMN_NAME IN ('idle_timeout_minutes', 'order_completed_at', 'completion_buffer_minutes')`,
      [dbConfig.database]
    );

    console.log('\n📋 Verification:');
    cols.forEach(c => {
      console.log(`   ${c.COLUMN_NAME}: ${c.COLUMN_TYPE} (default: ${c.COLUMN_DEFAULT || 'NULL'})`);
    });

    console.log('\n✅ Migration 069 completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
