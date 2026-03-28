/**
 * Migration 049: Menu QR Codes
 * Adds menu_type to menu_media and creates menu_qr_codes table
 * Run: node src/database/migrations/run-049-migration.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../../config/database.config');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  console.log('Running migration 049: Menu QR Codes...\n');

  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    multipleStatements: true
  });

  try {
    const connection = await pool.getConnection();

    // Check if menu_type column already exists in menu_media
    const [cols] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'menu_media' AND COLUMN_NAME = 'menu_type'`,
      [dbConfig.database]
    );

    // Check if menu_qr_codes table already exists
    const [tables] = await connection.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'menu_qr_codes'`,
      [dbConfig.database]
    );

    if (cols.length > 0 && tables.length > 0) {
      console.log('- menu_type column already exists in menu_media');
      console.log('- menu_qr_codes table already exists');
      connection.release();
      await pool.end();
      console.log('\n✅ Migration 049 already applied!');
      return;
    }

    // Read and execute migration SQL
    const sqlPath = path.join(__dirname, '049_menu_qr_codes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Split by semicolon and execute each statement
    const statements = sql.split(';').filter(s => s.trim().length > 0);
    for (const stmt of statements) {
      try {
        await connection.query(stmt);
      } catch (err) {
        // Ignore "duplicate column" or "table exists" errors
        if (!err.message.includes('Duplicate column') && !err.message.includes('already exists')) {
          throw err;
        }
        console.log(`- Skipped (already exists): ${err.message.substring(0, 60)}...`);
      }
    }

    console.log('- Added menu_type column to menu_media table');
    console.log('- Created menu_qr_codes table');

    // Verify table structure
    const [qrCols] = await connection.query('DESCRIBE menu_qr_codes');
    console.log('- menu_qr_codes columns:', qrCols.map(c => c.Field).join(', '));

    connection.release();
    await pool.end();

    console.log('\n✅ Migration 049 completed successfully!');
    console.log('\nNew features:');
    console.log('  - menu_media now has menu_type (restaurant, bar, etc.)');
    console.log('  - menu_qr_codes stores one QR per outlet+menu_type');
    console.log('  - QR is auto-generated on first upload for each menu_type');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    await pool.end();
    process.exit(1);
  }
}

runMigration();
