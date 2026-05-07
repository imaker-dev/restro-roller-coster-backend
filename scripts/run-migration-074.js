/**
 * Migration runner: 074 — Hierarchical Subscription Pricing
 * Creates super_admin_pricing, outlet_pricing_override tables
 * Adds pricing_source columns to outlet_subscriptions and subscription_payments
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
    const sqlPath = path.join(__dirname, '../src/database/migrations/074_hierarchical_pricing.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Running migration 074: Hierarchical Subscription Pricing...');
    await connection.query(sql);
    console.log('Migration 074 completed successfully.');
  } catch (error) {
    console.error('Migration 074 failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

run();
