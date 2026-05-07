/**
 * Migration runner: 074 — Hierarchical Subscription Pricing
 * Creates super_admin_pricing, outlet_pricing_override tables
 * Adds pricing_source columns to outlet_subscriptions and subscription_payments
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'restro',
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
