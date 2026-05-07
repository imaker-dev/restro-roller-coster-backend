/**
 * Migration runner: 076 — Registration offline_annual support + outlet linkage
 * 1. Adds 'offline_annual' to plan_interest ENUM
 * 2. Adds outlet_id, offline_token, token_generated_at to restaurant_registrations
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
    const sqlPath = path.join(__dirname, '../src/database/migrations/076_registration_offline_annual.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('Running migration 076: Registration offline_annual support...');
    await connection.query(sql);
    console.log('Migration 076 completed successfully.');
  } catch (error) {
    console.error('Migration 076 failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

run();
