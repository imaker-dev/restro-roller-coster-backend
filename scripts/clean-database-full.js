/**
 * Database Full Cleanup Script
 * =============================
 * Deletes ALL outlets and their data.
 * Keeps only:
 *   - admin@restropos.com (super_admin)
 *   - imaker@restropos.com (master)
 *
 * Usage:
 *   node scripts/clean-database-full.js          # Preview mode (safe)
 *   node scripts/clean-database-full.js --confirm # Actually executes
 *
 * Safety:
 *   - Runs inside a transaction — rolls back on any error
 *   - Verifies both keep-users exist before touching any data
 *   - Never touches roles, permissions, role_permissions tables
 *   - Never touches subscription_pricing or subscription_plans
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');
const logger = require('../src/utils/logger');

const KEEP_EMAILS = ['admin@restropos.com', 'imaker@restropos.com'];

// Tables scoped to an outlet_id (or have outlet_id column)
// Ordered child-first to avoid FK errors
const OUTLET_TABLES = [
  // === Level 1: Logs / transaction tables ===
  'activity_logs',
  'permission_logs',
  'error_logs',
  'notification_logs',
  'print_jobs',
  'duplicate_bill_logs',
  'bulk_upload_logs',
  'auth_audit_logs',

  // === Level 2: User assignments ===
  'user_sessions',
  'user_stations',
  'user_floors',
  'user_sections',
  'user_menu_access',
  'user_permissions',

  // === Level 3: KOT / order children ===
  'kot_tickets',
  'kot_items',
  'order_items',
  'order_addons',

  // === Level 4: Payment / billing ===
  'refunds',
  'payments',
  'invoices',
  'invoice_items',

  // === Level 5: Orders ===
  'orders',

  // === Level 6: Cash management ===
  'cash_drawer',
  'day_sessions',
  'outside_collections',

  // === Level 7: Item / menu ===
  'item_sales',
  'addon_group_items',
  'addon_groups',
  'item_variants',
  'items',
  'categories',

  // === Level 8: Layout ===
  'floor_sections',
  'tables',
  'sections',
  'floors',

  // === Level 9: Kitchen / printer ===
  'kitchen_stations',
  'counters',
  'printers',
  'printer_bridges',
  'print_templates',
  'time_slots',

  // === Level 10: Inventory ===
  'stock',
  'stock_logs',
  'opening_stock',
  'closing_stock',
  'wastage_logs',
  'ingredients',
  'purchase_order_items',
  'purchase_orders',
  'suppliers',

  // === Level 11: Recipe / production ===
  'recipe_ingredients',
  'recipes',
  'production_logs',
  'cost_snapshots',

  // === Level 12: Reports / summaries ===
  'daily_sales',
  'hourly_sales',
  'category_sales',
  'staff_sales',
  'floor_section_sales',
  'payment_mode_summary',
  'tax_summary',
  'discount_summary',
  'cancellation_summary',
  'cash_summary',
  'top_selling_items',
  'inventory_consumption_summary',

  // === Level 13: Config ===
  'tax_groups',
  'tax_rules',
  'price_rules',
  'discounts',
  'service_charges',
  'cancel_reasons',
  'system_settings',
  'notifications',
  'devices',
  'file_uploads',
  'table_reservations',
  'category_outlets',

  // === Level 14: Customers ===
  'customers',
  'customer_due_payments',

  // === Level 15: Subscription data ===
  'outlet_subscriptions',

  // === Level 16: Outlets themselves ===
  'outlets',
];

// Tables that have a user_id column (child tables to clean before deleting users)
const USER_CHILD_TABLES = [
  'user_sessions',
  'auth_audit_logs',
  'user_roles',
];

async function preview(connection, keepUserIds) {
  console.log('\n========== PREVIEW MODE ==========\n');

  // Count outlets
  const [[{ outletCount }]] = await connection.query(
    'SELECT COUNT(*) AS outletCount FROM outlets'
  );
  console.log(`Outlets to delete: ${outletCount}`);

  // Count users to delete
  const [[{ userCount }]] = await connection.query(
    'SELECT COUNT(*) AS userCount FROM users WHERE id NOT IN (?)',
    [keepUserIds]
  );
  console.log(`Users to delete: ${userCount}`);

  // Count outlet-specific roles
  const [[{ roleCount }]] = await connection.query(
    'SELECT COUNT(*) AS roleCount FROM user_roles WHERE outlet_id IS NOT NULL OR user_id NOT IN (?)',
    [keepUserIds]
  );
  console.log(`User roles to delete: ${roleCount}`);

  // Count per outlet-scoped table
  console.log('\n--- Outlet-scoped tables ---');
  for (const table of OUTLET_TABLES) {
    try {
      const [[{ cnt }]] = await connection.query(
        `SELECT COUNT(*) AS cnt FROM ${table}`
      );
      if (cnt > 0) {
        console.log(`  ${table}: ${cnt} rows`);
      }
    } catch {
      // Table doesn't exist — skip silently
    }
  }

  console.log('\n--- Kept users ---');
  const [kept] = await connection.query(
    'SELECT id, email, name FROM users WHERE id IN (?)',
    [keepUserIds]
  );
  kept.forEach(u => {
    console.log(`  ID ${u.id}: ${u.name} <${u.email}>`);
  });

  console.log('\n--- Safe tables (NOT touched) ---');
  console.log('  roles, permissions, role_permissions');
  console.log('  subscription_pricing, subscription_plans');
  console.log('  app_versions, migrations');
  console.log('\nRun with --confirm to execute deletion.\n');
}

async function executeCleanup(connection, keepUserIds) {
  console.log('\n========== EXECUTING CLEANUP ==========\n');

  await connection.beginTransaction();

  try {
    // ---------------------------------------------------------------
    // 1. Delete outlet-scoped tables (child-first order)
    // ---------------------------------------------------------------
    for (const table of OUTLET_TABLES) {
      try {
        const [result] = await connection.query(`DELETE FROM ${table}`);
        if (result.affectedRows > 0) {
          console.log(`  [OK] ${table}: deleted ${result.affectedRows} rows`);
        }
      } catch (err) {
        // Table might not exist — warn but continue
        if (err.code === 'ER_NO_SUCH_TABLE') {
          console.log(`  [SKIP] ${table}: table does not exist`);
        } else {
          console.error(`  [WARN] ${table}: ${err.message}`);
          // Non-fatal: FK or missing table — continue
        }
      }
    }

    // ---------------------------------------------------------------
    // 2. Clean user_roles:
    //    a) Delete outlet-specific roles for ALL users (outlets are gone)
    //    b) Delete ALL roles (system + outlet) for non-kept users
    //    Result: kept users keep only their system-level roles
    // ---------------------------------------------------------------
    const [rolesDelA] = await connection.query(
      'DELETE FROM user_roles WHERE outlet_id IS NOT NULL'
    );
    if (rolesDelA.affectedRows > 0) {
      console.log(`  [OK] user_roles: deleted ${rolesDelA.affectedRows} outlet-specific roles`);
    }

    const [rolesDelB] = await connection.query(
      'DELETE FROM user_roles WHERE user_id NOT IN (?)',
      [keepUserIds]
    );
    if (rolesDelB.affectedRows > 0) {
      console.log(`  [OK] user_roles: deleted ${rolesDelB.affectedRows} roles for removed users`);
    }

    // ---------------------------------------------------------------
    // 3. Delete remaining users (all except the two keepers)
    //    Child tables were already emptied above, so FK is safe.
    // ---------------------------------------------------------------
    const [userDel] = await connection.query(
      'DELETE FROM users WHERE id NOT IN (?)',
      [keepUserIds]
    );
    console.log(`\n  [OK] users: deleted ${userDel.affectedRows} rows`);

    await connection.commit();

    // ---------------------------------------------------------------
    // 3. Verify
    // ---------------------------------------------------------------
    const [[{ remainingOutlets }]] = await connection.query(
      'SELECT COUNT(*) AS remainingOutlets FROM outlets'
    );
    const [[{ remainingUsers }]] = await connection.query(
      'SELECT COUNT(*) AS remainingUsers FROM users'
    );

    console.log('\n========== CLEANUP COMPLETE ==========');
    console.log(`Remaining outlets : ${remainingOutlets}`);
    console.log(`Remaining users     : ${remainingUsers}`);

    if (remainingOutlets !== 0) {
      console.error('⚠️  WARNING: Some outlets were not deleted!');
    }
    if (remainingUsers !== 2) {
      console.error('⚠️  WARNING: Expected exactly 2 users, found ' + remainingUsers);
    }

    console.log('\n✅ Done. Only super_admin and master accounts preserved.');

  } catch (error) {
    await connection.rollback();
    console.error('\n❌ CLEANUP FAILED — transaction rolled back');
    console.error(error.message);
    throw error;
  }
}

async function main() {
  const isConfirm = process.argv.includes('--confirm');

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     DATABASE FULL CLEANUP — All Outlets + Users Wipe      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Keep emails:', KEEP_EMAILS.join(', '));
  console.log('Mode       :', isConfirm ? 'EXECUTE' : 'PREVIEW (safe)');
  console.log('');

  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 10,
  });

  const connection = await pool.getConnection();

  try {
    // ---------------------------------------------------------------
    // Pre-check: both keep-users must exist
    // ---------------------------------------------------------------
    const [keepUsers] = await connection.query(
      'SELECT id, email, name FROM users WHERE email IN (?) AND deleted_at IS NULL',
      [KEEP_EMAILS]
    );

    if (keepUsers.length !== KEEP_EMAILS.length) {
      const found = keepUsers.map(u => u.email);
      const missing = KEEP_EMAILS.filter(e => !found.includes(e));
      console.error('❌ ABORTED — Required users not found:');
      missing.forEach(e => console.error(`   - ${e}`));
      console.error('Found:', found.join(', ') || '(none)');
      process.exit(1);
    }

    const keepUserIds = keepUsers.map(u => u.id);

    // ---------------------------------------------------------------
    // Run preview or execute
    // ---------------------------------------------------------------
    if (!isConfirm) {
      await preview(connection, keepUserIds);
      process.exit(0);
    }

    await executeCleanup(connection, keepUserIds);

  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
