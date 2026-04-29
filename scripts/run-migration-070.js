/**
 * Migration 070: Add token_number to invoices
 * Run: node scripts/run-migration-070.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const dbConfig = require('../src/config/database.config');

async function run() {
  console.log('\n🚀 Migration 070: Add token_number to invoices\n');
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port, database: dbConfig.database,
    user: dbConfig.user, password: dbConfig.password, multipleStatements: true
  });
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '../src/database/migrations/070_add_token_number_to_invoices.sql'),
      'utf8'
    );
    await conn.query(sql);
    console.log('✅  token_number column added to invoices');

    // Verify
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'token_number'`,
      [dbConfig.database]
    );
    if (cols.length > 0) {
      console.log(`✅  Verified: ${cols[0].COLUMN_NAME} ${cols[0].DATA_TYPE} NULLABLE=${cols[0].IS_NULLABLE}`);
    }

    const [idxs] = await conn.query(
      `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'invoices' AND INDEX_NAME = 'idx_invoices_token'`,
      [dbConfig.database]
    );
    console.log(idxs.length > 0 ? '✅  Index idx_invoices_token created' : '⚠️  Index not found');

    console.log('\n✅ Migration 070 completed!\n');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}
run();
