/**
 * Migration 081: Franchise module tables
 * Run this script to create franchises and franchise_enquiries tables.
 */
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const sqlFile = path.join(__dirname, '..', 'src', 'database', 'migrations', '081_franchise_module.sql');

async function run() {
  const isProduction = process.env.NODE_ENV === 'production';

  const connection = await mysql.createConnection({
    host: isProduction ? (process.env.PROD_DB_HOST || '127.0.0.1') : (process.env.DB_HOST || 'localhost'),
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: isProduction ? (process.env.PROD_DB_USER || 'restro') : (process.env.DB_USER || 'root'),
    password: isProduction ? (process.env.PROD_DB_PASSWORD || '') : (process.env.DB_PASSWORD || ''),
    database: isProduction ? (process.env.PROD_DB_NAME || 'restro') : (process.env.DB_NAME || 'restropos'),
    multipleStatements: true,
  });

  try {
    console.log('Reading migration file:', sqlFile);
    const sql = fs.readFileSync(sqlFile, 'utf8');

    console.log('Running migration 081 (franchise module)...');
    await connection.query(sql);

    console.log('Migration 081 completed successfully.');
  } catch (err) {
    console.error('Migration 081 failed:', err.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

run();
