#!/usr/bin/env node
/**
 * Run migration 075 — Offline Activation Token Support
 *
 * Changes:
 *   1. Extends token_generation_log.token_type enum to include 'offline_activation'
 *   2. Adds outlet_id BIGINT UNSIGNED column + index
 *   3. Adds subscription_expiry DATE column
 *   4. Adds device_hash VARCHAR(64) column
 *   5. Adds index on license_id (if missing)
 *
 * Safe to re-run. Duplicate column/index errors are silently skipped.
 *
 * Usage:
 *   node scripts/run-migration-075.js
 */
require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const mysql    = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

const MIGRATION_FILE = path.join(
  __dirname, '..', 'src', 'database', 'migrations', '075_offline_token_support.sql'
);

(async () => {
  console.log('=== Migration 075: Offline Token Support ===');
  console.log(`Connecting to database…`);
  console.log(`  Host: ${dbConfig.host}:${dbConfig.port}`);
  console.log(`  Database: ${dbConfig.database}`);

  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
  });

  try {
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');

    // Split by semicolons, strip comments, run each statement independently
    const statements = sql
      .split('\n')
      .filter(l => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      try {
        console.log(`\nRunning: ${stmt.substring(0, 100)}…`);
        await connection.query(stmt);
        console.log('  ✔ OK');
      } catch (e) {
        // MySQL 8.0.16+ returns warnings for IF NOT EXISTS; older versions throw.
        // Gracefully skip known "already exists" errors.
        const skipCodes = [
          'ER_DUP_FIELDNAME',   // column already exists
          'ER_DUP_KEYNAME',     // index already exists
          'ER_CANT_DROP_FIELD_OR_KEY', // DROP IF NOT EXISTS on missing item
        ];
        if (skipCodes.includes(e.code)) {
          console.log(`  ⚠ ${e.code} — already exists, skipping`);
        } else {
          throw e;
        }
      }
    }

    // ─── Verification ──────────────────────────────────────────────────────
    console.log('\n--- Verifying schema ---');

    // 1. token_type enum includes offline_activation
    const [cols] = await connection.query(
      `SHOW COLUMNS FROM token_generation_log WHERE Field = 'token_type'`
    );
    const hasOfflineActivation = cols.length > 0 &&
      String(cols[0].Type).includes('offline_activation');
    console.log(`  token_type enum has 'offline_activation': ${hasOfflineActivation ? '✔ YES' : '✖ NO'}`);

    // 2. outlet_id column exists
    const [outletCols] = await connection.query(
      `SHOW COLUMNS FROM token_generation_log WHERE Field = 'outlet_id'`
    );
    console.log(`  outlet_id column: ${outletCols.length ? '✔ YES' : '✖ NO'}`);

    // 3. subscription_expiry column exists
    const [subCols] = await connection.query(
      `SHOW COLUMNS FROM token_generation_log WHERE Field = 'subscription_expiry'`
    );
    console.log(`  subscription_expiry column: ${subCols.length ? '✔ YES' : '✖ NO'}`);

    // 4. device_hash column exists
    const [devCols] = await connection.query(
      `SHOW COLUMNS FROM token_generation_log WHERE Field = 'device_hash'`
    );
    console.log(`  device_hash column: ${devCols.length ? '✔ YES' : '✖ NO'}`);

    // 5. idx_outlet_id index exists
    const [idxRows] = await connection.query(
      `SHOW INDEX FROM token_generation_log WHERE Key_name = 'idx_outlet_id'`
    );
    console.log(`  idx_outlet_id index: ${idxRows.length ? '✔ YES' : '✖ NO'}`);

    if (!hasOfflineActivation || !outletCols.length || !subCols.length || !devCols.length) {
      console.error('\n✖ Verification FAILED — one or more expected changes are missing.');
      process.exit(1);
    }

    console.log('\n✔ Migration 075 complete.');

  } catch (err) {
    console.error('\n✖ Migration failed:', err.message);
    console.error(err.code ? `   MySQL error code: ${err.code}` : '');
    process.exit(1);
  } finally {
    await connection.end();
  }
})();
