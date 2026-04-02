#!/usr/bin/env node
/**
 * Migration Runner: 053_shift_report_optimization_indexes.sql
 * Adds composite indexes for shift detail, DSR, DNS query optimization.
 *
 * Usage:
 *   node src/database/migrations/run-053-migration.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dbConfig = require('../../config/database.config');

async function runMigration() {
  console.log('\n🚀 Running migration 053: Shift & Report Optimization Indexes...\n');

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

    const sqlPath = path.join(__dirname, '053_shift_report_optimization_indexes.sql');
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
      if (stmt.toUpperCase().includes('CREATE INDEX')) {
        const match = stmt.match(/CREATE INDEX.*?(\w+)\s+ON\s+(\w+)/i);
        operation = match ? `Create index: ${match[2]}.${match[1]}` : 'Create index';
      }

      try {
        await connection.query(stmt);
        console.log(`  ✓ ${operation}`);
        successCount++;
      } catch (err) {
        if (err.code === 'ER_DUP_KEYNAME' || err.message.includes('Duplicate key name')) {
          console.log(`  ⊘ ${operation} (already exists)`);
          skipCount++;
        } else if (err.code === 'ER_TABLE_EXISTS_ERROR') {
          console.log(`  ⊘ ${operation} (table already exists)`);
          skipCount++;
        } else {
          console.log(`  ✗ ${operation}`);
          console.log(`    Error: ${err.message}`);
          errorCount++;
        }
      }
    }

    // Verification — list all indexes created by this migration
    console.log('\n' + '─'.repeat(60));
    console.log('  VERIFICATION');
    console.log('─'.repeat(60));

    const indexNames = [
      'idx_day_sessions_outlet_date',
      'idx_day_sessions_outlet_status',
      'idx_payments_due_collection',
      'idx_orders_adjustment',
      'idx_user_floors_floor_outlet',
      'idx_user_roles_user_outlet',
      'idx_payment_adj_outlet_created',
      'idx_cdt_outlet_created'
    ];

    for (const idxName of indexNames) {
      try {
        const [rows] = await connection.query(
          `SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = ? AND INDEX_NAME = ?
           LIMIT 1`,
          [dbConfig.database, idxName]
        );
        if (rows.length > 0) {
          console.log(`  ✓ ${rows[0].TABLE_NAME}.${idxName}`);
        } else {
          console.log(`  ✗ ${idxName} — NOT FOUND`);
        }
      } catch (e) {
        console.log(`  ✗ ${idxName} — error checking`);
      }
    }

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('  MIGRATION SUMMARY');
    console.log('═'.repeat(60));
    console.log(`  ✓ Successful: ${successCount}`);
    console.log(`  ⊘ Skipped:    ${skipCount}`);
    console.log(`  ✗ Errors:     ${errorCount}`);
    console.log('═'.repeat(60));

    if (errorCount === 0) {
      console.log('\n✅ Migration 053 completed successfully!\n');
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
