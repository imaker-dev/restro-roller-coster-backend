/**
 * Migration runner: 073 — Subscription System
 * Creates subscription_pricing, outlet_subscriptions, subscription_payments, subscription_notifications
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

async function run() {
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    multipleStatements: true,
  });

  try {
    const sqlPath = path.join(__dirname, '../src/database/migrations/073_subscription_system.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Running migration 073: Subscription System...');
    await connection.query(sql);
    console.log('Migration 073 completed successfully.');
  } catch (error) {
    console.error('Migration 073 failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

run();
