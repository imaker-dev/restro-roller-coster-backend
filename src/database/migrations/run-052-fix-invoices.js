/**
 * Fix script: Add missing is_adjustment column to invoices table
 * and backfill stale data from orders processed before the fix.
 * 
 * Run: node src/database/migrations/run-052-fix-invoices.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
const mysql = require('mysql2/promise');
const dbConfigBase = require('../../config/database.config');

const dbConfig = {
  host: dbConfigBase.host,
  port: dbConfigBase.port,
  user: dbConfigBase.user,
  password: dbConfigBase.password,
  database: dbConfigBase.database,
  multipleStatements: true
};

async function run() {
  console.log('Connecting to database...');
  const connection = await mysql.createConnection(dbConfig);

  try {
    // Step 1: Add is_adjustment column to invoices if missing
    console.log('\n1. Checking invoices.is_adjustment column...');
    const [cols] = await connection.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'invoices' AND COLUMN_NAME = 'is_adjustment'`,
      [dbConfig.database]
    );

    if (cols.length === 0) {
      console.log('   Adding is_adjustment column to invoices...');
      await connection.query(
        `ALTER TABLE invoices ADD COLUMN is_adjustment TINYINT(1) DEFAULT 0 AFTER adjustment_amount`
      );
      console.log('   Column added.');
    } else {
      console.log('   Column already exists.');
    }

    // Step 2: Fix stale orders — adjusted orders with wrong status
    console.log('\n2. Fixing adjusted orders with wrong payment_status/due_amount...');
    const [orderFix] = await connection.query(
      `UPDATE orders 
       SET due_amount = 0, payment_status = 'completed', status = 'completed'
       WHERE is_adjustment = 1 AND (due_amount > 0 OR payment_status != 'completed')`
    );
    console.log(`   Fixed ${orderFix.affectedRows} orders.`);

    // Step 3: Fix stale invoices — sync is_adjustment and due_amount from orders
    console.log('\n3. Fixing invoices missing is_adjustment flag...');
    const [invoiceFix] = await connection.query(
      `UPDATE invoices i
       JOIN orders o ON i.order_id = o.id
       SET i.is_adjustment = 1, 
           i.due_amount = 0,
           i.payment_status = 'paid',
           i.adjustment_amount = o.adjustment_amount
       WHERE o.is_adjustment = 1 
         AND (i.is_adjustment IS NULL OR i.is_adjustment = 0 OR i.due_amount > 0 OR i.payment_status != 'paid')`
    );
    console.log(`   Fixed ${invoiceFix.affectedRows} invoices.`);

    // Step 4: Fix stale customer due_balance — recalculate from actual orders
    console.log('\n4. Fixing customer due_balance from actual order dues...');
    const [custFix] = await connection.query(
      `UPDATE customers c
       LEFT JOIN (
         SELECT customer_id, COALESCE(SUM(due_amount), 0) as actual_due
         FROM orders
         WHERE status != 'cancelled' AND customer_id IS NOT NULL
         GROUP BY customer_id
       ) od ON od.customer_id = c.id
       SET c.due_balance = COALESCE(od.actual_due, 0)
       WHERE c.due_balance != COALESCE(od.actual_due, 0)`
    );
    console.log(`   Fixed ${custFix.affectedRows} customer balances.`);

    // Step 5: Verify
    console.log('\n5. Verification...');
    const [badOrders] = await connection.query(
      `SELECT COUNT(*) as cnt FROM orders WHERE is_adjustment = 1 AND (due_amount > 0 OR payment_status != 'completed')`
    );
    const [badInvoices] = await connection.query(
      `SELECT COUNT(*) as cnt FROM invoices i JOIN orders o ON i.order_id = o.id
       WHERE o.is_adjustment = 1 AND (i.is_adjustment = 0 OR i.is_adjustment IS NULL OR i.due_amount > 0)`
    );

    console.log(`   Adjusted orders with wrong status: ${badOrders[0].cnt}`);
    console.log(`   Invoices with wrong is_adjustment: ${badInvoices[0].cnt}`);

    if (badOrders[0].cnt === 0 && badInvoices[0].cnt === 0) {
      console.log('\n   ALL CLEAN — no stale data remaining.');
    } else {
      console.log('\n   WARNING — some records still need manual review.');
    }

    console.log('\nDone.');
  } catch (error) {
    console.error('Error:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

run().catch(err => {
  console.error('Migration fix failed:', err);
  process.exit(1);
});
