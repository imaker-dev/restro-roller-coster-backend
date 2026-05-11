/**
 * Migration 077: Create super_admin_menu_templates table
 *
 * Creates a table to store master menu templates uploaded by super_admin users.
 * All outlets under a super_admin will receive this template when downloading
 * the bulk-upload menu template.
 *
 * Usage: node src/database/migrations/run-077-migration.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const dbConfig = require('../../config/database.config');

async function run() {
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
  });

  try {
    console.log('=== Migration 077: Create Super Admin Menu Templates Table ===\n');

    // Check if table already exists
    const [existing] = await connection.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = ? AND table_name = 'super_admin_menu_templates'`,
      [dbConfig.database]
    );

    if (existing.length > 0) {
      console.log('✓ Table super_admin_menu_templates already exists');
    } else {
      const sqlPath = path.join(__dirname, '077_super_admin_menu_templates.sql');
      const sql = fs.readFileSync(sqlPath, 'utf-8');

      await connection.query(sql);
      console.log('✓ Created table: super_admin_menu_templates');
    }

    // Verify table structure
    const [columns] = await connection.query(
      `SELECT column_name, data_type, is_nullable, column_key, extra
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'super_admin_menu_templates'
       ORDER BY ordinal_position`,
      [dbConfig.database]
    );

    console.log('\nTable structure:');
    for (const col of columns) {
      console.log(`  ${col.column_name}: ${col.data_type}${col.is_nullable === 'NO' ? ' NOT NULL' : ''}${col.column_key ? ' ' + col.column_key : ''}${col.extra ? ' ' + col.extra : ''}`);
    }

    console.log('\n=== Migration 077 Complete ===');

  } catch (error) {
    console.error('Migration failed:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

run().catch(() => process.exit(1));
