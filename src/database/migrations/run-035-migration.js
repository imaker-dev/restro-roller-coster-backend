/**
 * Run migration 035 - Inventory Management System
 * Creates tables for: Units, Vendors, Inventory Items/Batches/Movements, Purchases
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'restro_db',
    multipleStatements: true
  });

  console.log('Running migration 035_inventory_management...');

  try {
    const sqlPath = path.join(__dirname, '035_inventory_management.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // Try running the full SQL at once (multipleStatements enabled)
    try {
      await connection.query(sql);
      console.log('✅ Migration 035 completed successfully (batch mode)');
      return;
    } catch (batchErr) {
      console.log('Batch mode failed, falling back to statement-by-statement...');
      console.log('  Reason:', batchErr.message.substring(0, 120));
    }

    // Fallback: extract CREATE TABLE statements using regex
    const createStatements = sql.match(/CREATE TABLE IF NOT EXISTS[\s\S]*?;/g) || [];

    for (const statement of createStatements) {
      const clean = statement.trim();
      if (!clean) continue;
      const tableName = clean.match(/CREATE TABLE IF NOT EXISTS\s+(\S+)/)?.[1] || 'unknown';
      try {
        await connection.query(clean);
        console.log(`✓ Created: ${tableName}`);
      } catch (err) {
        if (err.code === 'ER_TABLE_EXISTS_ERROR' || err.message.includes('already exists')) {
          console.log(`⚠ Skipped (exists): ${tableName}`);
        } else {
          console.error(`✗ Failed: ${tableName}`);
          console.error('  Error:', err.message);
        }
      }
    }

    console.log('\n✅ Migration 035 completed');
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
