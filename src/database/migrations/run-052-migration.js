#!/usr/bin/env node
/**
 * Migration Runner: 052_payment_adjustments.sql
 * Adds payment_adjustments table and adjustment columns to orders/invoices/payments.
 *
 * Usage:
 *   node src/database/migrations/run-052-migration.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dbConfig = require('../../config/database.config');

async function runMigration() {
  console.log('\n🚀 Running migration 052: Payment Adjustments...\n');

  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    multipleStatements: true
  });

  try {
    console.log(`✓ Connected to database: ${dbConfig.database}\n`);

    const sqlPath = path.join(__dirname, '052_payment_adjustments.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Strip comment-only lines then split on semicolons
    const stripped = sql
      .split('\n')
      .filter(line => !line.trim().startsWith('--') && line.trim().length > 0)
      .join('\n');
    const statements = stripped
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    console.log(`📋 Found ${statements.length} SQL statements to execute\n`);

    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const stmt of statements) {
      let operation = 'Execute';
      if (stmt.toUpperCase().includes('CREATE TABLE')) {
        const match = stmt.match(/CREATE TABLE.*?(\w+)\s*\(/i);
        operation = match ? `Create table: ${match[1]}` : 'Create table';
      } else if (stmt.toUpperCase().includes('ALTER TABLE')) {
        const match = stmt.match(/ALTER TABLE\s+(\w+)\s+ADD.*?(\w+)\s+(DECIMAL|TINYINT|VARCHAR|INT)/i);
        operation = match ? `Add column: ${match[1]}.${match[2]}` : 'Alter table';
      }

      try {
        await connection.query(stmt);
        console.log(`  ✓ ${operation}`);
        successCount++;
      } catch (err) {
        if (err.code === 'ER_TABLE_EXISTS_ERROR') {
          console.log(`  ⊘ ${operation} (already exists)`);
          skipCount++;
        } else if (err.code === 'ER_DUP_FIELDNAME' || err.message.includes('Duplicate column')) {
          console.log(`  ⊘ ${operation} (column already exists)`);
          skipCount++;
        } else if (err.code === 'ER_DUP_KEYNAME') {
          console.log(`  ⊘ ${operation} (index already exists)`);
          skipCount++;
        } else {
          console.log(`  ✗ ${operation}`);
          console.log(`    Error: ${err.message}`);
          errorCount++;
        }
      }
    }

    // Verification
    console.log('\n' + '─'.repeat(60));
    console.log('  VERIFICATION');
    console.log('─'.repeat(60));

    try {
      const [cols] = await connection.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'payment_adjustments'
         ORDER BY ORDINAL_POSITION`,
        [dbConfig.database]
      );
      console.log(`  payment_adjustments table: ${cols.length} columns`);
      console.log(`    Columns: ${cols.map(c => c.COLUMN_NAME).join(', ')}`);
    } catch (e) {
      console.log('  payment_adjustments table: NOT FOUND');
    }

    // Check orders.adjustment_amount
    try {
      const [cols] = await connection.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND COLUMN_NAME IN ('adjustment_amount', 'is_adjustment')`,
        [dbConfig.database]
      );
      console.log(`  orders adjustment columns: ${cols.map(c => c.COLUMN_NAME).join(', ') || 'MISSING'}`);
    } catch (e) { /* ignore */ }

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('  MIGRATION SUMMARY');
    console.log('═'.repeat(60));
    console.log(`  ✓ Successful: ${successCount}`);
    console.log(`  ⊘ Skipped:    ${skipCount}`);
    console.log(`  ✗ Errors:     ${errorCount}`);
    console.log('═'.repeat(60));

    if (errorCount === 0) {
      console.log('\n✅ Migration 052 completed successfully!\n');
    } else {
      console.log('\n⚠️  Migration completed with errors. Please review above.\n');
    }

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
