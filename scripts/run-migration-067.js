/**
 * Migration 067: Add POS User Role
 * 
 * This migration:
 * 1. Creates the 'pos_user' role in the roles table
 * 2. Copies all cashier permissions to pos_user
 * 
 * Run: node scripts/run-migration-067.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const dbConfig = require('../src/config/database.config');

async function runMigration() {
  console.log('\n🚀 Running Migration 067: POS User Role\n');
  
  const connection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: true
  });

  try {
    // Read and execute the migration SQL
    const migrationPath = path.join(__dirname, '../src/database/migrations/067_pos_user_role.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    console.log('📄 Executing migration SQL...');
    await connection.query(sql);
    console.log('✅ Migration SQL executed\n');

    // Verify the role was created
    const [roles] = await connection.query(
      'SELECT id, name, slug, description, is_system_role, priority FROM roles WHERE slug = ?',
      ['pos_user']
    );

    if (roles.length === 0) {
      throw new Error('pos_user role was not created');
    }

    console.log('📋 Role created:');
    console.log(`   ID: ${roles[0].id}`);
    console.log(`   Name: ${roles[0].name}`);
    console.log(`   Slug: ${roles[0].slug}`);
    console.log(`   Description: ${roles[0].description}`);
    console.log(`   System Role: ${roles[0].is_system_role ? 'Yes' : 'No'}`);
    console.log(`   Priority: ${roles[0].priority}\n`);

    // Verify permissions were copied
    const [permissions] = await connection.query(`
      SELECT COUNT(*) as count FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      WHERE r.slug = 'pos_user'
    `);

    const [cashierPerms] = await connection.query(`
      SELECT COUNT(*) as count FROM role_permissions rp
      JOIN roles r ON rp.role_id = r.id
      WHERE r.slug = 'cashier'
    `);

    console.log('🔐 Permissions:');
    console.log(`   POS User: ${permissions[0].count} permissions`);
    console.log(`   Cashier:  ${cashierPerms[0].count} permissions`);
    
    if (permissions[0].count === cashierPerms[0].count) {
      console.log('   ✅ Permissions match!\n');
    } else {
      console.log('   ⚠️  Permission count mismatch (may be OK if cashier has no permissions yet)\n');
    }

    // List all roles for verification
    const [allRoles] = await connection.query(
      'SELECT slug, name FROM roles WHERE is_active = 1 ORDER BY priority DESC, name ASC'
    );
    
    console.log('📝 All active roles:');
    allRoles.forEach(r => console.log(`   - ${r.slug} (${r.name})`));

    console.log('\n✅ Migration 067 completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
