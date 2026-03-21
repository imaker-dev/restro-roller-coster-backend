/**
 * Run migration 045: Fix price precision (DECIMAL 4→6 decimals)
 * Fixes batch price rounding errors (e.g. 999.96 instead of 1000)
 * Usage: node src/database/migrations/run-045-migration.js
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

  console.log('Running migration 045: Fix price precision (4 → 6 decimals)...\n');

  try {
    // Step 1: ALTER columns to DECIMAL(12,6)
    console.log('Step 1: Increasing decimal precision on price columns...');

    const alters = [
      ['inventory_batches', 'purchase_price', 'DECIMAL(12, 6) NOT NULL DEFAULT 0'],
      ['inventory_items', 'average_price', 'DECIMAL(12, 6) DEFAULT 0'],
      ['inventory_items', 'latest_price', 'DECIMAL(12, 6) DEFAULT 0'],
      ['inventory_movements', 'unit_cost', 'DECIMAL(12, 6) DEFAULT 0'],
      ['purchase_items', 'price_per_base_unit', 'DECIMAL(12, 6) NOT NULL'],
    ];

    for (const [table, col, def] of alters) {
      try {
        await connection.query(`ALTER TABLE ${table} MODIFY COLUMN ${col} ${def}`);
        console.log(`   OK  ${table}.${col} → ${def}`);
      } catch (e) {
        console.log(`   SKIP  ${table}.${col}: ${e.message}`);
      }
    }

    // Step 2: Recalculate purchase_items.price_per_base_unit from original price
    console.log('\nStep 2: Recalculating price_per_base_unit from original prices...');
    const [piResult] = await connection.query(`
      UPDATE purchase_items pi
        JOIN units u ON pi.unit_id = u.id
        SET pi.price_per_base_unit = ROUND(pi.price_per_unit / u.conversion_factor, 6)
    `);
    console.log(`   Updated ${piResult.affectedRows} purchase_items`);

    // Step 3: Recalculate batch purchase_price from linked purchase_item
    console.log('\nStep 3: Recalculating batch purchase_price...');
    const [batchResult] = await connection.query(`
      UPDATE inventory_batches ib
        JOIN purchase_items pi ON ib.purchase_item_id = pi.id
        SET ib.purchase_price = pi.price_per_base_unit
    `);
    console.log(`   Updated ${batchResult.affectedRows} batches`);

    // Step 4: Recalculate inventory_items average_price & latest_price
    console.log('\nStep 4: Recalculating average_price & latest_price...');
    const [avgResult] = await connection.query(`
      UPDATE inventory_items ii
      SET average_price = COALESCE((
        SELECT ROUND(SUM(ib.remaining_quantity * ib.purchase_price) / NULLIF(SUM(ib.remaining_quantity), 0), 6)
        FROM inventory_batches ib
        WHERE ib.inventory_item_id = ii.id AND ib.remaining_quantity > 0 AND ib.is_active = 1
      ), ii.average_price),
      latest_price = COALESCE((
        SELECT ib2.purchase_price
        FROM inventory_batches ib2
        WHERE ib2.inventory_item_id = ii.id AND ib2.is_active = 1
        ORDER BY ib2.purchase_date DESC, ib2.id DESC LIMIT 1
      ), ii.latest_price)
    `);
    console.log(`   Updated ${avgResult.affectedRows} inventory_items`);

    // Step 5: Recalculate movement unit_cost
    console.log('\nStep 5: Recalculating movement unit_cost...');
    const [mvResult] = await connection.query(`
      UPDATE inventory_movements im
        JOIN inventory_batches ib ON im.inventory_batch_id = ib.id
        SET im.unit_cost = ib.purchase_price
        WHERE im.movement_type IN ('purchase', 'sale', 'wastage')
    `);
    console.log(`   Updated ${mvResult.affectedRows} movements`);

    // Step 6: Verify fix — show batches for the problematic item
    console.log('\nStep 6: Verification...');
    const [batches] = await connection.query(`
      SELECT ib.id, ib.inventory_item_id, ib.purchase_price as price_per_base,
        pi.price_per_unit as original_price, pi.price_per_base_unit as recalc_base_price,
        u.abbreviation as unit, u.conversion_factor as cf,
        ROUND(ib.purchase_price * u.conversion_factor, 2) as display_price
      FROM inventory_batches ib
      LEFT JOIN purchase_items pi ON ib.purchase_item_id = pi.id
      LEFT JOIN inventory_items ii ON ib.inventory_item_id = ii.id
      LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
      LEFT JOIN units u ON pi.unit_id = u.id
      ORDER BY ib.id DESC
      LIMIT 10
    `);
    
    if (batches.length > 0) {
      console.log('\n   Latest batches (after fix):');
      for (const b of batches) {
        console.log(`   Batch #${b.id} | item=${b.inventory_item_id} | original=₹${b.original_price}/${b.unit} | base=₹${b.price_per_base} | display=₹${b.display_price}`);
      }
    }

    console.log('\nMigration 045 completed!\n');
  } catch (error) {
    console.error('Migration failed:', error.message);
    console.error(error.stack);
  } finally {
    await connection.end();
  }
}

run();
