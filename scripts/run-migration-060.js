#!/usr/bin/env node
/**
 * Run migration 060 — adds module flags, user limits, and upgrade
 * tracking columns to activation_info; creates upgrade_history and
 * used_token_hashes tables.
 * Safe to run multiple times (CREATE TABLE IF NOT EXISTS + ALTER IF NOT EXISTS).
 *
 * Usage:
 *   node scripts/run-migration-060.js
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

const MIGRATION_FILE = path.join(__dirname, '..', 'src', 'database', 'migrations', '060_license_module_columns.sql');

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
    console.log('\nRunning migration: 060_license_module_columns.sql');

    // Split on semicolons and run statement-by-statement so
    // ER_DUP_FIELDNAME from ALTER TABLE (column already exists) is silently skipped.
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    let applied = 0;
    let skipped = 0;

    for (const stmt of statements) {
      try {
        await connection.query(stmt);
        applied++;
      } catch (err) {
        // 1060 = ER_DUP_FIELDNAME (column already exists) — expected on existing installs
        if (err.errno === 1060) {
          skipped++;
        } else {
          throw err;
        }
      }
    }

    console.log(`  ✔ Migration applied (${applied} statements, ${skipped} already-existing columns skipped)`);

    // Verify tables exist
    const [tables] = await connection.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN ('activation_info', 'upgrade_history', 'used_token_hashes')
       ORDER BY TABLE_NAME`
    );

    console.log('\nVerification — tables:');
    for (const t of tables) {
      const [cols] = await connection.query(`SHOW COLUMNS FROM ${t.TABLE_NAME}`);
      console.log(`  ✔ ${t.TABLE_NAME} (${cols.length} columns)`);
    }

    if (tables.length < 3) {
      console.warn('\n⚠ WARNING: Expected 3 tables but found', tables.length);
    } else {
      console.log('\n✔ Migration 060 complete.');
    }

  } catch (err) {
    console.error('✖ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
})();
