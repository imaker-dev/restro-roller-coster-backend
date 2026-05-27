#!/usr/bin/env node
/**
 * Run migration 075-bluetooth — Bluetooth Printer Support
 *
 * Changes:
 *   1. Adds bluetooth_address VARCHAR(17) to printers table
 *   2. Adds device_id VARCHAR(64) to printers table (for Socket.IO BT routing)
 *   3. Adds paper_width ENUM('58mm','80mm') to printers table
 *   4. Adds characters_per_line TINYINT to printers table
 *
 * Safe to re-run. Duplicate column errors are silently skipped.
 *
 * Usage:
 *   node scripts/run-migration-075-bluetooth.js
 */
require('dotenv').config();

const mysql    = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

(async () => {
  console.log('=== Migration 075-bluetooth: Bluetooth Printer Support ===');
  console.log(`  Host: ${dbConfig.host}:${dbConfig.port}`);
  console.log(`  Database: ${dbConfig.database}\n`);

  const connection = await mysql.createConnection({
    host:     dbConfig.host,
    port:     dbConfig.port,
    database: dbConfig.database,
    user:     dbConfig.user,
    password: dbConfig.password,
  });

  const skipCodes = ['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_CANT_DROP_FIELD_OR_KEY'];

  const run = async (label, sql) => {
    try {
      await connection.query(sql);
      console.log(`  ✔  ${label}`);
    } catch (e) {
      if (skipCodes.includes(e.code)) {
        console.log(`  ⚠  ${label} — already exists, skipped (${e.code})`);
      } else {
        throw e;
      }
    }
  };

  try {
    await run(
      'Add bluetooth_address column',
      `ALTER TABLE printers
       ADD COLUMN IF NOT EXISTS bluetooth_address VARCHAR(17) NULL
       COMMENT 'Bluetooth MAC address for SPP thermal printer, e.g. 00:1B:DC:0F:01:00'
       AFTER printer_name`
    );

    await run(
      'Add device_id column',
      `ALTER TABLE printers
       ADD COLUMN IF NOT EXISTS device_id VARCHAR(64) NULL
       COMMENT 'Flutter device id for Socket.IO BT room routing'
       AFTER bluetooth_address`
    );

    await run(
      'Add paper_width column',
      `ALTER TABLE printers
       ADD COLUMN IF NOT EXISTS paper_width ENUM('58mm','80mm') NOT NULL DEFAULT '80mm'
       COMMENT 'Thermal paper width'
       AFTER connection_type`
    );

    await run(
      'Add characters_per_line column',
      `ALTER TABLE printers
       ADD COLUMN IF NOT EXISTS characters_per_line TINYINT UNSIGNED NOT NULL DEFAULT 48
       COMMENT 'Characters per line for text formatting (32 for 58mm, 42-48 for 80mm)'
       AFTER paper_width`
    );

    // Verification
    console.log('\n--- Verifying ---');
    const checkCol = async (col) => {
      const [rows] = await connection.query(
        `SHOW COLUMNS FROM printers WHERE Field = ?`, [col]
      );
      console.log(`  ${col}: ${rows.length ? '✔ exists' : '✖ MISSING'}`);
      return rows.length > 0;
    };

    const ok = (await Promise.all([
      checkCol('bluetooth_address'),
      checkCol('device_id'),
      checkCol('paper_width'),
      checkCol('characters_per_line'),
    ])).every(Boolean);

    if (!ok) {
      console.error('\n✖ Verification FAILED — restart and check DB permissions.');
      process.exit(1);
    }

    console.log('\n✔ Migration 075-bluetooth complete. Restart the backend server.');

  } catch (err) {
    console.error('\n✖ Migration failed:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
})();
