#!/usr/bin/env node
/**
 * Run migration 059 — adds nc_tax_amount column to invoices table.
 * Safe to run multiple times (ADD COLUMN IF NOT EXISTS).
 *
 * Usage:
 *   node scripts/run-migration-059.js
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

const MIGRATION_FILE = path.join(__dirname, '..', 'src', 'database', 'migrations', '059_add_nc_tax_amount_to_invoices.sql');

(async () => {
  console.log('Connecting to database...');
  console.log(`  Host: ${dbConfig.host}:${dbConfig.port}`);
  console.log(`  Database: ${dbConfig.database}`);

  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: true,
  });

  try {
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
    console.log('\nRunning migration: 059_add_nc_tax_amount_to_invoices.sql');

    await connection.query(sql);
    console.log('  ✔ Migration applied successfully');

    // Verify column exists
    const [cols] = await connection.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'invoices'
         AND COLUMN_NAME = 'nc_tax_amount'`
    );

    if (cols.length > 0) {
      console.log(`\n  ✔ invoices.nc_tax_amount — type: ${cols[0].COLUMN_TYPE}, default: ${cols[0].COLUMN_DEFAULT}`);
      console.log('\n✔ Migration 059 complete.');
    } else {
      console.error('\n⚠ WARNING: Column nc_tax_amount not found after migration.');
    }

  } catch (err) {
    console.error('✖ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
})();
