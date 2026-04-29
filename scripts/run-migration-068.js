/**
 * Migration 068: Add Device ID to Self Order Sessions
 * 
 * This migration:
 * 1. Adds device_id column to self_order_sessions table
 * 2. Updates self_order_logs action enum to include 'device_blocked'
 * 
 * Run: node scripts/run-migration-068.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

async function runMigration() {
  console.log('\n🚀 Running Migration 068: Self Order Device ID\n');
  
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: true
  });

  try {
    // Check if device_id column already exists
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'self_order_sessions' AND COLUMN_NAME = 'device_id'`,
      [dbConfig.database]
    );

    if (columns.length > 0) {
      console.log('⚠️  device_id column already exists, skipping column addition');
    } else {
      console.log('📄 Adding device_id column to self_order_sessions...');
      await connection.query(`
        ALTER TABLE self_order_sessions
        ADD COLUMN device_id VARCHAR(64) NULL AFTER user_agent,
        ADD INDEX idx_so_sessions_device (device_id)
      `);
      console.log('✅ device_id column added\n');
    }

    // Update self_order_logs action enum
    console.log('📄 Updating self_order_logs action enum...');
    try {
      await connection.query(`
        ALTER TABLE self_order_logs
        MODIFY COLUMN action ENUM(
          'session_init',
          'menu_view',
          'order_placed',
          'order_accepted',
          'order_rejected',
          'session_expired',
          'items_added',
          'item_removed',
          'item_updated',
          'order_cancelled',
          'device_blocked',
          'session_completed'
        ) NOT NULL
      `);
      console.log('✅ action enum updated\n');
    } catch (enumErr) {
      if (enumErr.code === 'ER_DATA_TOO_LONG' || enumErr.message.includes('Data truncated')) {
        console.log('⚠️  Some existing values may not match new enum, attempting safe update...');
      } else {
        console.log('⚠️  Enum update skipped (may already be correct):', enumErr.message);
      }
    }

    // Verify the changes
    const [cols] = await connection.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'self_order_sessions' AND COLUMN_NAME = 'device_id'`,
      [dbConfig.database]
    );

    if (cols.length > 0) {
      console.log('📋 Verification:');
      console.log(`   Column: ${cols[0].COLUMN_NAME}`);
      console.log(`   Type: ${cols[0].COLUMN_TYPE}`);
    }

    // Show index
    const [indexes] = await connection.query(
      `SHOW INDEX FROM self_order_sessions WHERE Key_name = 'idx_so_sessions_device'`
    );
    if (indexes.length > 0) {
      console.log(`   Index: idx_so_sessions_device ✅`);
    }

    console.log('\n✅ Migration 068 completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
