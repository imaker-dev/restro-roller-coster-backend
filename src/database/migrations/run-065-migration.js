/**
 * Migration 065: Create dedicated self-order system user
 * 
 * Creates a user for self-order operations so orders have a proper created_by reference
 * instead of created_by=0. Also assigns the user to the outlet's role if needed.
 * 
 * Usage: node src/database/migrations/run-065-migration.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
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
    console.log('=== Migration 065: Create Self-Order System User ===\n');

    // Check if user already exists
    const [existing] = await connection.query(
      `SELECT id, name, email FROM users WHERE email = 'selforder@system.local'`
    );

    let userId;

    if (existing.length > 0) {
      userId = existing[0].id;
      console.log(`✓ Self-order user already exists: id=${userId}, name="${existing[0].name}"`);
    } else {
      // Create the user
      const uuid = uuidv4();
      const [result] = await connection.query(
        `INSERT INTO users (uuid, employee_code, name, email, phone, pin_hash, password_hash, is_active, is_verified, created_by)
         VALUES (?, 'SELF_ORDER', 'Self Order', 'selforder@system.local', '0000000000', '', '', 1, 1, 1)`,
        [uuid]
      );
      userId = result.insertId;
      console.log(`✓ Created self-order user: id=${userId}`);
    }

    // Get the 'cashier' role id (self-order system user acts as a virtual cashier)
    const [roles] = await connection.query(
      `SELECT id FROM roles WHERE slug = 'cashier' LIMIT 1`
    );

    if (roles.length > 0) {
      const roleId = roles[0].id;

      // Assign role for all outlets that have self-ordering enabled
      const [outlets] = await connection.query(`SELECT id FROM outlets WHERE is_active = 1`);

      for (const outlet of outlets) {
        const [existingRole] = await connection.query(
          `SELECT id FROM user_roles WHERE user_id = ? AND role_id = ? AND outlet_id = ?`,
          [userId, roleId, outlet.id]
        );

        if (existingRole.length === 0) {
          await connection.query(
            `INSERT INTO user_roles (user_id, role_id, outlet_id, is_active) VALUES (?, ?, ?, 1)`,
            [userId, roleId, outlet.id]
          );
          console.log(`  ✓ Assigned cashier role for outlet ${outlet.id}`);
        } else {
          console.log(`  ✓ Role already assigned for outlet ${outlet.id}`);
        }
      }
    }

    // Update existing self-orders that have created_by=0 to use the new user id
    const [updateResult] = await connection.query(
      `UPDATE orders SET created_by = ? WHERE order_source = 'self_order' AND created_by = 0`,
      [userId]
    );
    console.log(`\n✓ Updated ${updateResult.affectedRows} existing self-orders to use self-order user (id=${userId})`);

    // Update order_items created_by=0
    const [itemsResult] = await connection.query(
      `UPDATE order_items oi
       JOIN orders o ON oi.order_id = o.id
       SET oi.created_by = ?
       WHERE o.order_source = 'self_order' AND oi.created_by = 0`,
      [userId]
    );
    console.log(`✓ Updated ${itemsResult.affectedRows} existing self-order items`);

    console.log(`\n=== Migration 065 Complete ===`);
    console.log(`Self-Order User: id=${userId}, email=selforder@system.local, name=Self Order, phone=0000000000`);

  } catch (error) {
    console.error('Migration failed:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

run().catch(() => process.exit(1));
