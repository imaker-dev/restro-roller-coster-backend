/**
 * Migration 072: Mobile POS printer support
 * Adds device_id column + indexes to printers table
 * Run: node scripts/run-migration-072.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const dbConfig = require('../src/config/database.config');

async function run() {
  console.log('\n🚀 Migration 072: Mobile POS printer support\n');
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port, database: dbConfig.database,
    user: dbConfig.user, password: dbConfig.password, multipleStatements: true
  });
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '../src/database/migrations/072_mobile_pos_printer_support.sql'), 'utf8'
    );
    await conn.query(sql);
    console.log('✅  device_id column + indexes added to printers');

    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'printers' AND COLUMN_NAME = 'device_id'`,
      [dbConfig.database]
    );
    if (cols.length > 0) {
      console.log(`✅  Verified: ${cols[0].COLUMN_NAME} ${cols[0].DATA_TYPE}(${cols[0].CHARACTER_MAXIMUM_LENGTH})`);
    } else {
      console.log('⚠️  device_id not found — may already exist or migration failed');
    }
    console.log('\n✅ Migration 072 completed!\n');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}
run();
