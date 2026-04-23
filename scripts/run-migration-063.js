#!/usr/bin/env node
/**
 * Run migration 063 — adds gst_number, fssai_number, pan_number to restaurant_registrations.
 * Safe to re-run (IF NOT EXISTS).
 *
 * Usage:
 *   node scripts/run-migration-063.js
 */
require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const mysql    = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

const MIGRATION_FILE = path.join(__dirname, '..', 'src', 'database', 'migrations', '063_add_business_fields_to_registrations.sql');

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
  });

  try {
    const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');

    const statements = sql
      .split('\n')
      .filter(l => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      try {
        console.log(`\nRunning: ${stmt.substring(0, 80)}...`);
        await connection.query(stmt);
        console.log('  ✔ OK');
      } catch (e) {
        if (['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(e.code)) {
          console.log('  ⚠ Column/key already exists — skipping');
        } else {
          throw e;
        }
      }
    }

    const expected = ['gst_number', 'fssai_number', 'pan_number'];
    for (const col of expected) {
      const [rows] = await connection.query(
        `SHOW COLUMNS FROM restaurant_registrations LIKE '${col}'`
      );
      console.log(`  ${rows.length ? '✔' : '✖'} Column \`${col}\`: ${rows.length ? 'OK' : 'MISSING'}`);
    }

    console.log('\n✔ Migration 063 complete.');

  } catch (err) {
    console.error('✖ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
})();
