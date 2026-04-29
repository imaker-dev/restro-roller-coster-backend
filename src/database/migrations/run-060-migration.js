/**
 * Migration 060: Self-Order System
 * Creates self_order_sessions, self_order_logs, self_order_cart tables.
 * Adds order_source + self_order_session_id to orders table.
 * Adds qr_token to tables for URL rotation on session complete.
 * Run: node src/database/migrations/run-060-migration.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const dbConfig = require('../../config/database.config');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  console.log('Running migration 060: Self-Order System...\n');

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
    const db = dbConfig.database;

    // ── 1. Run SQL file (CREATE TABLE IF NOT EXISTS — safe to re-run) ──
    console.log('Step 1: Creating tables from SQL...');
    const sqlPath = path.join(__dirname, '060_self_order_system.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    const statements = sql.split(';');

    for (const stmt of statements) {
      const clean = stmt.replace(/^--.*$/gm, '').trim();
      if (!clean) continue;
      try {
        await connection.query(clean);
      } catch (err) {
        if (err.message.includes('already exists') || err.message.includes('Duplicate')) {
          console.log(`  Skipped: ${err.message.substring(0, 80)}`);
        } else {
          throw err;
        }
      }
    }
    console.log('  ✓ self_order_sessions table ready');
    console.log('  ✓ self_order_logs table ready');
    console.log('  ✓ self_order_cart table ready');

    // ── 2. Add order_source column to orders (idempotent) ──
    console.log('\nStep 2: Adding order_source to orders...');
    const [orderSourceCol] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'order_source'`,
      [db]
    );
    if (orderSourceCol.length === 0) {
      await connection.query(
        `ALTER TABLE orders
          ADD COLUMN order_source ENUM('pos', 'self_order', 'online', 'qr') DEFAULT 'pos' AFTER order_type`
      );
      console.log('  ✓ Added order_source column');
    } else {
      console.log('  - order_source already exists');
    }

    // ── 3. Add self_order_session_id column to orders (idempotent) ──
    const [sessionIdCol] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'self_order_session_id'`,
      [db]
    );
    if (sessionIdCol.length === 0) {
      await connection.query(
        `ALTER TABLE orders
          ADD COLUMN self_order_session_id BIGINT UNSIGNED AFTER order_source`
      );
      console.log('  ✓ Added self_order_session_id column');
    } else {
      console.log('  - self_order_session_id already exists');
    }

    // ── 4. Add index on order_source (idempotent) ──
    const [orderSourceIdx] = await connection.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_orders_source'`,
      [db]
    );
    if (orderSourceIdx.length === 0) {
      await connection.query(`ALTER TABLE orders ADD INDEX idx_orders_source (order_source)`);
      console.log('  ✓ Added idx_orders_source index');
    } else {
      console.log('  - idx_orders_source already exists');
    }

    // ── 5. Add qr_token to tables for URL rotation ──
    console.log('\nStep 3: Adding qr_token to tables...');
    const [qrTokenCol] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tables' AND COLUMN_NAME = 'qr_token'`,
      [db]
    );
    if (qrTokenCol.length === 0) {
      await connection.query(
        `ALTER TABLE tables ADD COLUMN qr_token VARCHAR(32) AFTER qr_code`
      );
      console.log('  ✓ Added qr_token column');
    } else {
      console.log('  - qr_token already exists');
    }

    // ── 6. Generate initial qr_token for all existing tables ──
    console.log('\nStep 4: Generating QR tokens for existing tables...');
    const [tables] = await connection.query(
      `SELECT id FROM tables WHERE qr_token IS NULL`
    );
    if (tables.length > 0) {
      for (const table of tables) {
        const token = crypto.randomBytes(16).toString('hex');
        await connection.query(`UPDATE tables SET qr_token = ? WHERE id = ?`, [token, table.id]);
      }
      console.log(`  ✓ Generated qr_token for ${tables.length} tables`);
    } else {
      console.log('  - All tables already have qr_tokens');
    }

    // ── 7. Verify ──
    console.log('\nVerification:');
    const [sosCols] = await connection.query('DESCRIBE self_order_sessions');
    console.log('  self_order_sessions columns:', sosCols.map(c => c.Field).join(', '));

    const [cartCols] = await connection.query('DESCRIBE self_order_cart');
    console.log('  self_order_cart columns:', cartCols.map(c => c.Field).join(', '));

    const [orderCols] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND COLUMN_NAME IN ('order_source', 'self_order_session_id')`,
      [db]
    );
    console.log('  orders new columns:', orderCols.map(c => c.COLUMN_NAME).join(', '));

    const [tblCols] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tables' AND COLUMN_NAME = 'qr_token'`,
      [db]
    );
    console.log('  tables.qr_token:', tblCols.length > 0 ? 'present' : 'MISSING');

    connection.release();
    await pool.end();

    console.log('\n✅ Migration 060 completed successfully!');
    console.log('\nSelf-Order tables created:');
    console.log('  - self_order_sessions (QR session tracking)');
    console.log('  - self_order_logs (activity audit)');
    console.log('  - self_order_cart (persistent cart)');
    console.log('  - orders.order_source (pos/self_order/online/qr)');
    console.log('  - orders.self_order_session_id');
    console.log('  - tables.qr_token (URL rotation on session complete)');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error.stack);
    await pool.end();
    process.exit(1);
  }
}

runMigration();
