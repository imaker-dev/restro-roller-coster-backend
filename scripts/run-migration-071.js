/**
 * Migration 071: Add qr_url to tables
 * Run: node scripts/run-migration-071.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const dbConfig = require('../src/config/database.config');

async function run() {
  console.log('\n🚀 Migration 071: Add qr_url to tables\n');
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port, database: dbConfig.database,
    user: dbConfig.user, password: dbConfig.password, multipleStatements: true
  });
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '../src/database/migrations/071_add_qr_url_to_tables.sql'), 'utf8'
    );
    await conn.query(sql);
    console.log('✅  qr_url column added to tables');

    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tables' AND COLUMN_NAME = 'qr_url'`,
      [dbConfig.database]
    );
    if (cols.length > 0) {
      console.log(`✅  Verified: ${cols[0].COLUMN_NAME} ${cols[0].DATA_TYPE}(${cols[0].CHARACTER_MAXIMUM_LENGTH})`);
    } else {
      console.log('⚠️  Column not found — may already exist or migration failed');
    }
    console.log('\n✅ Migration 071 completed!\n');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}
run();
