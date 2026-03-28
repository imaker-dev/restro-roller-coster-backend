/**
 * Migration 050: App Versions Per-Platform Support
 * Adds platform column so each platform has its own independent version
 * Run: node src/database/migrations/run-050-migration.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../../config/database.config');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  console.log('Running migration 050: App Versions Per-Platform...\n');

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

    // Check if platform column already exists
    const [cols] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'app_versions' AND COLUMN_NAME = 'platform'`,
      [dbConfig.database]
    );

    if (cols.length > 0) {
      console.log('- platform column already exists in app_versions');
      connection.release();
      await pool.end();
      console.log('\n✅ Migration 050 already applied!');
      return;
    }

    // Execute each statement separately
    const sqlPath = path.join(__dirname, '050_app_versions_platform.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const statements = sql.split(';');

    for (const stmt of statements) {
      // Strip comment lines, then skip if nothing remains
      const clean = stmt.replace(/^--.*$/gm, '').trim();
      if (!clean) continue;
      try {
        await connection.query(clean);
      } catch (err) {
        if (err.message.includes('Duplicate column') || err.message.includes('already exists')) {
          console.log(`  Skipped (already exists): ${err.message.substring(0, 80)}`);
        } else {
          throw err;
        }
      }
    }

    console.log('- Added platform column (global, app_store, play_store, exe)');
    console.log('- Added download_url, min_version, sha256_hash columns');
    console.log('- Added idx_platform_channel_active index');
    console.log('- Existing rows remain as platform = global');

    connection.release();
    await pool.end();

    console.log('\n✅ Migration 050 completed successfully!');
    console.log('\nPlatform values:');
    console.log('  - global     : legacy / cross-platform record');
    console.log('  - app_store  : iOS App Store');
    console.log('  - play_store : Google Play Store');
    console.log('  - exe        : Windows installer (.exe)');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    await pool.end();
    process.exit(1);
  }
}

runMigration();
