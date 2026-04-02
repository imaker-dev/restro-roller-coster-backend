#!/usr/bin/env node
/**
 * Migration Runner: 051_report_performance_indexes.sql
 * Adds composite indexes on report-related tables for query performance.
 *
 * Usage:
 *   node src/database/migrations/run-051-migration.js
 *
 * Safe to re-run — uses CREATE INDEX IF NOT EXISTS / graceful duplicate handling.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dbConfig = require('../../config/database.config');

async function runMigration() {
  console.log('\n🚀 Running migration 051: Report Performance Indexes...\n');

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

    // Read migration SQL file
    const sqlPath = path.join(__dirname, '051_report_performance_indexes.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Split into individual statements — strip comment-only lines first
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
      if (!stmt || stmt.startsWith('--')) continue;

      // Extract index/table name for logging
      let operation = 'Execute';
      if (stmt.toUpperCase().includes('CREATE INDEX')) {
        const match = stmt.match(/CREATE INDEX.*?(\w+)\s+ON\s+(\w+)/i);
        operation = match ? `Index: ${match[1]} on ${match[2]}` : 'Create index';
      }

      try {
        await connection.query(stmt);
        console.log(`  ✓ ${operation}`);
        successCount++;
      } catch (err) {
        if (err.code === 'ER_DUP_KEYNAME' || err.code === 'ER_DUP_INDEX') {
          console.log(`  ⊘ ${operation} (already exists)`);
          skipCount++;
        } else if (err.code === 'ER_NO_SUCH_TABLE') {
          console.log(`  ⊘ ${operation} (table not found — skipped)`);
          skipCount++;
        } else {
          console.log(`  ✗ ${operation}`);
          console.log(`    Error: ${err.message}`);
          errorCount++;
        }
      }
    }

    // Verification — list indexes on key tables
    console.log('\n' + '─'.repeat(60));
    console.log('  VERIFICATION — Composite indexes on key tables');
    console.log('─'.repeat(60));

    const tablesToCheck = ['orders', 'payments', 'invoices', 'kot_tickets', 'order_items'];
    for (const table of tablesToCheck) {
      try {
        const [indexes] = await connection.query(
          `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns
           FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME LIKE 'idx_%'
           GROUP BY INDEX_NAME`,
          [dbConfig.database, table]
        );
        if (indexes.length > 0) {
          console.log(`  ${table}:`);
          indexes.forEach(idx => console.log(`    ✓ ${idx.INDEX_NAME} (${idx.columns})`));
        }
      } catch (e) {
        // table may not exist yet
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
      console.log('\n✅ Migration 051 completed successfully!\n');
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
