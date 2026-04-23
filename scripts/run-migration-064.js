#!/usr/bin/env node
/**
 * Run migration 064 — creates upgrade_payments table for Razorpay Pro upgrades.
 * Safe to re-run (CREATE TABLE IF NOT EXISTS).
 *
 * Usage:
 *   node scripts/run-migration-064.js
 */
require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const mysql    = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

const MIGRATION_FILE = path.join(__dirname, '..', 'src', 'database', 'migrations', '064_upgrade_payments_table.sql');

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
    console.log('\nRunning migration: 064_upgrade_payments_table.sql');
    await connection.query(sql);
    console.log('  ✔ Migration applied');

    const [tables] = await connection.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'upgrade_payments'`
    );
    if (tables.length) {
      const [cols] = await connection.query('SHOW COLUMNS FROM upgrade_payments');
      console.log(`  ✔ upgrade_payments table exists (${cols.length} columns)`);
    } else {
      console.error('  ✖ Table was not created');
      process.exit(1);
    }

    console.log('\n✔ Migration 064 complete.');

  } catch (err) {
    console.error('✖ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
})();
