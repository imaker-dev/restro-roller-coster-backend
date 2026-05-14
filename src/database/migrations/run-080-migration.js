/**
 * Migration 080: Fix pricing unique key constraints
 * Run: node src/database/migrations/run-080-migration.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../../config/database.config');

async function runMigration() {
  console.log('Running migration 080: Fix pricing unique key constraints...\n');

  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
  });

  try {
    const connection = await pool.getConnection();

    // ─── outlet_pricing_override ───
    console.log('--- outlet_pricing_override ---');

    const [[opoBadUk]] = await connection.query(
      `SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'outlet_pricing_override' AND INDEX_NAME = 'uk_outlet_active'`,
      [dbConfig.database]
    );

    if (!opoBadUk) {
      console.log('✅ outlet_pricing_override already fixed — uk_outlet_active not found.');
    } else {
      // Deduplicate: keep latest row per outlet (by updated_at, then id)
      const [dedupOpo] = await connection.query(`
        DELETE opo1 FROM outlet_pricing_override opo1
        INNER JOIN outlet_pricing_override opo2
          ON opo1.outlet_id = opo2.outlet_id
          AND (opo1.updated_at < opo2.updated_at OR (opo1.updated_at = opo2.updated_at AND opo1.id < opo2.id))
      `);
      console.log(`- Deduplicated outlet_pricing_override (${dedupOpo.affectedRows || 0} rows removed)`);

      // Drop broken composite unique key
      await connection.query(`ALTER TABLE outlet_pricing_override DROP INDEX uk_outlet_active`);
      console.log('- Dropped uk_outlet_active');

      // Add proper unique key on outlet_id only
      await connection.query(`ALTER TABLE outlet_pricing_override ADD UNIQUE KEY uk_outlet_id (outlet_id)`);
      console.log('- Added uk_outlet_id (outlet_id)');

      // Ensure regular index for fast lookups
      try {
        await connection.query(`ALTER TABLE outlet_pricing_override ADD INDEX idx_outlet_pricing_outlet (outlet_id, is_active)`);
        console.log('- Added idx_outlet_pricing_outlet');
      } catch (err) {
        if (err.message.includes('Duplicate')) {
          console.log('- idx_outlet_pricing_outlet already exists, skipping');
        } else {
          throw err;
        }
      }
    }

    // ─── super_admin_pricing ───
    console.log('\n--- super_admin_pricing ---');

    const [[sapBadUk]] = await connection.query(
      `SELECT 1 FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'super_admin_pricing' AND INDEX_NAME = 'uk_sa_user_active'`,
      [dbConfig.database]
    );

    if (!sapBadUk) {
      console.log('✅ super_admin_pricing already fixed — uk_sa_user_active not found.');
    } else {
      // Deduplicate: keep latest row per user (by updated_at, then id)
      const [dedupSap] = await connection.query(`
        DELETE sap1 FROM super_admin_pricing sap1
        INNER JOIN super_admin_pricing sap2
          ON sap1.user_id = sap2.user_id
          AND (sap1.updated_at < sap2.updated_at OR (sap1.updated_at = sap2.updated_at AND sap1.id < sap2.id))
      `);
      console.log(`- Deduplicated super_admin_pricing (${dedupSap.affectedRows || 0} rows removed)`);

      // Drop broken composite unique key
      await connection.query(`ALTER TABLE super_admin_pricing DROP INDEX uk_sa_user_active`);
      console.log('- Dropped uk_sa_user_active');

      // Add proper unique key on user_id only
      await connection.query(`ALTER TABLE super_admin_pricing ADD UNIQUE KEY uk_sa_user_id (user_id)`);
      console.log('- Added uk_sa_user_id (user_id)');

      // Ensure regular index for fast lookups
      try {
        await connection.query(`ALTER TABLE super_admin_pricing ADD INDEX idx_sa_pricing_user (user_id, is_active)`);
        console.log('- Added idx_sa_pricing_user');
      } catch (err) {
        if (err.message.includes('Duplicate')) {
          console.log('- idx_sa_pricing_user already exists, skipping');
        } else {
          throw err;
        }
      }
    }

    connection.release();
    await pool.end();

    console.log('\n✅ Migration 080 completed successfully!');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    await pool.end();
    process.exit(1);
  }
}

runMigration();
