#!/usr/bin/env node
/**
 * Run migration 061 — creates restaurant_registrations and token_generation_log tables.
 * Safe to run multiple times (CREATE TABLE IF NOT EXISTS).
 *
 * Usage:
 *   node scripts/run-migration-061.js
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

const MIGRATION_FILE = path.join(__dirname, '..', 'src', 'database', 'migrations', '061_registration_table.sql');

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
    console.log(`\nRunning migration: 061_registration_table.sql`);

    await connection.query(sql);
    console.log('  ✔ Migration applied successfully');

    // Verify tables exist
    const [tables] = await connection.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES 
       WHERE TABLE_SCHEMA = DATABASE() 
       AND TABLE_NAME IN ('restaurant_registrations', 'token_generation_log')
       ORDER BY TABLE_NAME`
    );

    console.log(`\nVerification — tables created:`);
    for (const t of tables) {
      const [cols] = await connection.query(`SHOW COLUMNS FROM ${t.TABLE_NAME}`);
      console.log(`  ✔ ${t.TABLE_NAME} (${cols.length} columns)`);
    }

    if (tables.length < 2) {
      console.error('\n⚠ WARNING: Expected 2 tables but found', tables.length);
    } else {
      console.log('\n✔ All tables verified. Migration 061 complete.');
    }

  } catch (err) {
    console.error('✖ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
})();
