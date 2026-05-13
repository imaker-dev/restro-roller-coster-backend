/**
 * Migration 079: Add versioning to super_admin_menu_templates
 * Run: node src/database/migrations/run-079-migration.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../../config/database.config');

async function runMigration() {
  console.log('Running migration 079: super_admin_menu_templates versioning...\n');

  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  });

  try {
    const connection = await pool.getConnection();

    // Check if version column already exists
    const [cols] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'super_admin_menu_templates' AND COLUMN_NAME = 'version'`,
      [dbConfig.database]
    );

    if (cols.length > 0) {
      console.log('✅ Migration 079 already applied — version column exists.');
      connection.release();
      await pool.end();
      return;
    }

    // Step 1: Add columns
    await connection.query(`
      ALTER TABLE super_admin_menu_templates
        ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER user_id,
        ADD COLUMN label VARCHAR(100) NULL AFTER version,
        ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 0 AFTER label
    `);
    console.log('- Added version, label, is_active columns');

    // Step 2: Mark existing rows as version 1, active
    await connection.query(`UPDATE super_admin_menu_templates SET version = 1, is_active = 1`);
    console.log('- Marked existing rows as version 1, is_active = 1');

    // Step 3: Drop old unique key
    try {
      await connection.query(`ALTER TABLE super_admin_menu_templates DROP INDEX uk_user_id`);
      console.log('- Dropped old unique key uk_user_id');
    } catch (err) {
      if (err.message.includes("Can't DROP")) {
        console.log('- uk_user_id index not found, skipping drop');
      } else {
        throw err;
      }
    }

    // Step 4: Add new indexes
    await connection.query(`ALTER TABLE super_admin_menu_templates ADD UNIQUE KEY uk_user_version (user_id, version)`);
    await connection.query(`ALTER TABLE super_admin_menu_templates ADD INDEX idx_user_active (user_id, is_active)`);
    console.log('- Added uk_user_version and idx_user_active indexes');

    connection.release();
    await pool.end();

    console.log('\n✅ Migration 079 completed successfully!');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    await pool.end();
    process.exit(1);
  }
}

runMigration();
