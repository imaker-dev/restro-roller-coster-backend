/**
 * Migration 078: Add offline_exe platform to app_versions
 * Adds offline_exe to the platform ENUM for offline Windows EXE support
 * Run: node src/database/migrations/run-078-migration.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../../config/database.config');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  console.log('Running migration 078: App Versions offline_exe platform...\n');

  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    multipleStatements: true
  });

  try {
    const connection = await pool.getConnection();

    // Check if offline_exe already exists in the platform ENUM
    const [cols] = await connection.query(
      `SELECT COLUMN_TYPE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'app_versions' AND COLUMN_NAME = 'platform'`,
      [dbConfig.database]
    );

    if (cols.length === 0) {
      console.log('- app_versions.platform column not found — migration 050 must be run first');
      connection.release();
      await pool.end();
      process.exit(1);
    }

    const enumDef = cols[0].COLUMN_TYPE;
    if (enumDef.includes('offline_exe')) {
      console.log('- offline_exe already present in platform ENUM');
      connection.release();
      await pool.end();
      console.log('\n✅ Migration 078 already applied!');
      return;
    }

    // Execute each statement separately
    const sqlPath = path.join(__dirname, '078_app_versions_offline_exe_platform.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const statements = sql.split(';');

    for (const stmt of statements) {
      const clean = stmt.replace(/^--.*$/gm, '').trim();
      if (!clean) continue;
      try {
        await connection.query(clean);
      } catch (err) {
        if (err.message.includes('already exists') || err.message.includes('Duplicate')) {
          console.log(`  Skipped (already exists): ${err.message.substring(0, 80)}`);
        } else {
          throw err;
        }
      }
    }

    console.log('- Added offline_exe to platform ENUM');
    console.log('- Valid platforms: global, app_store, play_store, exe, mac_os, offline_exe');

    connection.release();
    await pool.end();

    console.log('\n✅ Migration 078 completed successfully!');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    await pool.end();
    process.exit(1);
  }
}

runMigration();
