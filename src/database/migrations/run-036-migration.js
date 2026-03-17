/**
 * Run migration 036: Add purchase_unit_id to inventory_items
 * Usage: node src/database/migrations/run-036-migration.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'restro',
    multipleStatements: true
  });

  console.log('🔧 Running migration 036: Add purchase_unit_id...\n');

  try {
    // Check if column already exists
    const [cols] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_items' AND COLUMN_NAME = 'purchase_unit_id'`
    );

    if (cols.length > 0) {
      console.log('   ⚠️  Column purchase_unit_id already exists. Skipping ALTER.');
    } else {
      await connection.query(
        `ALTER TABLE inventory_items ADD COLUMN purchase_unit_id BIGINT UNSIGNED AFTER base_unit_id`
      );
      console.log('   ✅ Added purchase_unit_id column');

      // Add FK constraint (ignore if already exists)
      try {
        await connection.query(
          `ALTER TABLE inventory_items ADD CONSTRAINT fk_inv_items_purchase_unit FOREIGN KEY (purchase_unit_id) REFERENCES units(id)`
        );
        console.log('   ✅ Added foreign key constraint');
      } catch (e) {
        if (e.code === 'ER_FK_DUP_NAME' || e.code === 'ER_DUP_KEY') {
          console.log('   ⚠️  FK constraint already exists');
        } else {
          throw e;
        }
      }
    }

    // Backfill: set purchase_unit_id = base_unit_id for existing items
    const [result] = await connection.query(
      `UPDATE inventory_items SET purchase_unit_id = base_unit_id WHERE purchase_unit_id IS NULL`
    );
    console.log(`   ✅ Backfilled ${result.affectedRows} items (purchase_unit_id = base_unit_id)`);

    // Verify
    const [items] = await connection.query(
      `SELECT ii.id, ii.name, bu.abbreviation as base_unit, pu.abbreviation as purchase_unit
       FROM inventory_items ii
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       LIMIT 10`
    );
    if (items.length > 0) {
      console.log('\n   Verification (first 10 items):');
      for (const item of items) {
        console.log(`   - ${item.name}: base=${item.base_unit}, purchase=${item.purchase_unit}`);
      }
    }

    console.log('\n✅ Migration 036 completed!\n');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  } finally {
    await connection.end();
  }
}

run();
