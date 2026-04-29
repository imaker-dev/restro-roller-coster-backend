/**
 * Migration Runner: 061_master_role.sql
 * Adds the master role + default master user to the system
 * 
 * Usage: node src/database/migrations/run-061-migration.js
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const dbConfig = require('../../config/database.config');

async function runMigration() {
  console.log('\n🚀 Running Migration 061: Master Role + Default Master User\n');

  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: true,
  });

  try {
    // 1. Run SQL migration (role + raw_password column)
    const sqlPath = path.join(__dirname, '061_master_role.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await connection.query(sql);
    console.log('✅ Master role added + raw_password column added');

    const [roles] = await connection.query(
      `SELECT id, name, slug, priority FROM roles WHERE slug = 'master'`
    );
    if (roles.length > 0) {
      console.log(`   Role ID: ${roles[0].id}, Name: ${roles[0].name}, Priority: ${roles[0].priority}`);
    }

    // 2. Seed default master user: imaker@restropos.com / Master@123
    const masterEmail = 'imaker@restropos.com';
    const masterPassword = 'Master@123';
    const masterPin = '1234';

    const [existingUser] = await connection.query(
      `SELECT id FROM users WHERE email = ? AND deleted_at IS NULL`,
      [masterEmail]
    );

    if (existingUser.length > 0) {
      console.log(`⚠ Master user already exists (email: ${masterEmail}), skipping user creation.`);
      // Ensure master role is assigned
      if (roles.length > 0) {
        await connection.query(
          `INSERT IGNORE INTO user_roles (user_id, role_id, is_active) VALUES (?, ?, 1)`,
          [existingUser[0].id, roles[0].id]
        );
        console.log('   ✓ Master role assigned to existing user');
      }
    } else {
      const passwordHash = await bcrypt.hash(masterPassword, 10);
      const pinHash = await bcrypt.hash(masterPin, 10);
      const uuid = uuidv4();

      await connection.query(
        `INSERT INTO users (uuid, employee_code, name, email, password_hash, pin_hash, is_active, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
        [uuid, 'MASTER001', 'iMaker Admin', masterEmail, passwordHash, pinHash]
      );

      const [newUser] = await connection.query(`SELECT id FROM users WHERE email = ?`, [masterEmail]);

      if (newUser.length > 0 && roles.length > 0) {
        await connection.query(
          `INSERT IGNORE INTO user_roles (user_id, role_id, is_active) VALUES (?, ?, 1)`,
          [newUser[0].id, roles[0].id]
        );
      }

      console.log('✅ Default master user created:');
      console.log(`   Email:    ${masterEmail}`);
      console.log(`   Password: ${masterPassword}`);
      console.log(`   PIN:      ${masterPin}`);
    }

    console.log('\n✅ Migration 061 completed.\n');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
