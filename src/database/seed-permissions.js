/**
 * Permission System Seeder
 * Seeds feature-based permissions for Admin/Manager/Captain
 */

const { getPool } = require('./index');

// Feature-based permissions organized by category
const PERMISSIONS = [
  // Table Management
  { slug: 'TABLE_VIEW', name: 'View Tables', module: 'table', category: 'tables', order: 1 },
  { slug: 'TABLE_CREATE', name: 'Create Tables', module: 'table', category: 'tables', order: 2 },
  { slug: 'TABLE_EDIT', name: 'Edit Tables', module: 'table', category: 'tables', order: 3 },
  { slug: 'TABLE_DELETE', name: 'Delete Tables', module: 'table', category: 'tables', order: 4 },
  { slug: 'TABLE_MERGE', name: 'Merge Tables', module: 'table', category: 'tables', order: 5 },
  { slug: 'TABLE_TRANSFER', name: 'Transfer Tables', module: 'table', category: 'tables', order: 6 },
  
  // Order Management
  { slug: 'ORDER_VIEW', name: 'View Orders', module: 'order', category: 'orders', order: 1 },
  { slug: 'ORDER_CREATE', name: 'Create Orders', module: 'order', category: 'orders', order: 2 },
  { slug: 'ORDER_MODIFY', name: 'Modify Orders', module: 'order', category: 'orders', order: 3 },
  { slug: 'ORDER_CANCEL', name: 'Cancel Orders', module: 'order', category: 'orders', order: 4 },
  { slug: 'ORDER_VOID', name: 'Void Orders', module: 'order', category: 'orders', order: 5 },
  { slug: 'ORDER_REOPEN', name: 'Reopen Closed Orders', module: 'order', category: 'orders', order: 6 },
  
  // KOT Management
  { slug: 'KOT_SEND', name: 'Send KOT', module: 'kot', category: 'kitchen', order: 1 },
  { slug: 'KOT_MODIFY', name: 'Modify KOT', module: 'kot', category: 'kitchen', order: 2 },
  { slug: 'KOT_CANCEL', name: 'Cancel KOT', module: 'kot', category: 'kitchen', order: 3 },
  { slug: 'KOT_REPRINT', name: 'Reprint KOT', module: 'kot', category: 'kitchen', order: 4 },
  
  // Billing
  { slug: 'BILL_VIEW', name: 'View Bills', module: 'billing', category: 'billing', order: 1 },
  { slug: 'BILL_GENERATE', name: 'Generate Bill', module: 'billing', category: 'billing', order: 2 },
  { slug: 'BILL_REPRINT', name: 'Reprint Bill', module: 'billing', category: 'billing', order: 3 },
  { slug: 'BILL_CANCEL', name: 'Cancel Bill', module: 'billing', category: 'billing', order: 4 },
  
  // Payment
  { slug: 'PAYMENT_COLLECT', name: 'Collect Payment', module: 'payment', category: 'billing', order: 5 },
  { slug: 'PAYMENT_REFUND', name: 'Process Refund', module: 'payment', category: 'billing', order: 6 },
  { slug: 'PAYMENT_SPLIT', name: 'Split Payment', module: 'payment', category: 'billing', order: 7 },
  
  // Discounts & Charges
  { slug: 'DISCOUNT_APPLY', name: 'Apply Discount', module: 'discount', category: 'pricing', order: 1 },
  { slug: 'DISCOUNT_REMOVE', name: 'Remove Discount', module: 'discount', category: 'pricing', order: 2 },
  { slug: 'DISCOUNT_CUSTOM', name: 'Apply Custom Discount', module: 'discount', category: 'pricing', order: 3 },
  { slug: 'TAX_MODIFY', name: 'Modify Tax', module: 'tax', category: 'pricing', order: 4 },
  { slug: 'SERVICE_CHARGE_MODIFY', name: 'Modify Service Charge', module: 'charge', category: 'pricing', order: 5 },
  { slug: 'TIP_ADD', name: 'Add Tips', module: 'tip', category: 'pricing', order: 6 },
  
  // Item Management
  { slug: 'ITEM_VIEW', name: 'View Menu Items', module: 'item', category: 'menu', order: 1 },
  { slug: 'ITEM_CREATE', name: 'Create Menu Items', module: 'item', category: 'menu', order: 2 },
  { slug: 'ITEM_EDIT', name: 'Edit Menu Items', module: 'item', category: 'menu', order: 3 },
  { slug: 'ITEM_DELETE', name: 'Delete Menu Items', module: 'item', category: 'menu', order: 4 },
  { slug: 'ITEM_CANCEL', name: 'Cancel Order Items', module: 'item', category: 'menu', order: 5 },
  { slug: 'ITEM_PRICING', name: 'Modify Item Pricing', module: 'item', category: 'menu', order: 6 },
  { slug: 'ITEM_AVAILABILITY', name: 'Toggle Item Availability', module: 'item', category: 'menu', order: 7 },
  
  // Category Management
  { slug: 'CATEGORY_VIEW', name: 'View Categories', module: 'category', category: 'menu', order: 10 },
  { slug: 'CATEGORY_CREATE', name: 'Create Categories', module: 'category', category: 'menu', order: 11 },
  { slug: 'CATEGORY_EDIT', name: 'Edit Categories', module: 'category', category: 'menu', order: 12 },
  { slug: 'CATEGORY_DELETE', name: 'Delete Categories', module: 'category', category: 'menu', order: 13 },
  
  // Inventory
  { slug: 'INVENTORY_VIEW', name: 'View Inventory', module: 'inventory', category: 'inventory', order: 1 },
  { slug: 'INVENTORY_EDIT', name: 'Edit Inventory', module: 'inventory', category: 'inventory', order: 2 },
  { slug: 'INVENTORY_ADJUST', name: 'Adjust Stock', module: 'inventory', category: 'inventory', order: 3 },
  { slug: 'INVENTORY_TRANSFER', name: 'Transfer Stock', module: 'inventory', category: 'inventory', order: 4 },
  { slug: 'PURCHASE_ORDER', name: 'Create Purchase Orders', module: 'inventory', category: 'inventory', order: 5 },
  
  // Staff Management
  { slug: 'STAFF_VIEW', name: 'View Staff', module: 'staff', category: 'staff', order: 1 },
  { slug: 'STAFF_CREATE', name: 'Create Staff', module: 'staff', category: 'staff', order: 2 },
  { slug: 'STAFF_EDIT', name: 'Edit Staff', module: 'staff', category: 'staff', order: 3 },
  { slug: 'STAFF_DELETE', name: 'Delete Staff', module: 'staff', category: 'staff', order: 4 },
  { slug: 'STAFF_PERMISSIONS', name: 'Manage Staff Permissions', module: 'staff', category: 'staff', order: 5 },
  
  // Reports
  { slug: 'REPORT_VIEW', name: 'View Reports', module: 'report', category: 'reports', order: 1 },
  { slug: 'REPORT_SALES', name: 'View Sales Reports', module: 'report', category: 'reports', order: 2 },
  { slug: 'REPORT_INVENTORY', name: 'View Inventory Reports', module: 'report', category: 'reports', order: 3 },
  { slug: 'REPORT_STAFF', name: 'View Staff Reports', module: 'report', category: 'reports', order: 4 },
  { slug: 'REPORT_EXPORT', name: 'Export Reports', module: 'report', category: 'reports', order: 5 },
  
  // Outlet Management
  { slug: 'OUTLET_VIEW', name: 'View Outlets', module: 'outlet', category: 'admin', order: 1 },
  { slug: 'OUTLET_CREATE', name: 'Create Outlets', module: 'outlet', category: 'admin', order: 2 },
  { slug: 'OUTLET_EDIT', name: 'Edit Outlets', module: 'outlet', category: 'admin', order: 3 },
  { slug: 'OUTLET_DELETE', name: 'Delete Outlets', module: 'outlet', category: 'admin', order: 4 },
  { slug: 'OUTLET_SETTINGS', name: 'Manage Outlet Settings', module: 'outlet', category: 'admin', order: 5 },
  
  // Floor/Section Management
  { slug: 'FLOOR_VIEW', name: 'View Floors', module: 'floor', category: 'layout', order: 1 },
  { slug: 'FLOOR_CREATE', name: 'Create Floors', module: 'floor', category: 'layout', order: 2 },
  { slug: 'FLOOR_EDIT', name: 'Edit Floors', module: 'floor', category: 'layout', order: 3 },
  { slug: 'FLOOR_DELETE', name: 'Delete Floors', module: 'floor', category: 'layout', order: 4 },
  { slug: 'SECTION_VIEW', name: 'View Sections', module: 'section', category: 'layout', order: 5 },
  { slug: 'SECTION_MANAGE', name: 'Manage Sections', module: 'section', category: 'layout', order: 6 },
  
  // Printer Management
  { slug: 'PRINTER_VIEW', name: 'View Printers', module: 'printer', category: 'settings', order: 1 },
  { slug: 'PRINTER_MANAGE', name: 'Manage Printers', module: 'printer', category: 'settings', order: 2 },
  
  // Settings
  { slug: 'SETTINGS_VIEW', name: 'View Settings', module: 'settings', category: 'settings', order: 10 },
  { slug: 'SETTINGS_EDIT', name: 'Edit Settings', module: 'settings', category: 'settings', order: 11 },
];

// Default permissions for each role
const ROLE_PERMISSIONS = {
  // Admin has ALL permissions (handled specially - not stored individually)
  admin: [], // Empty - Admin is superuser
  
  // Manager - outlet-level control
  manager: [
    // Tables
    'TABLE_VIEW', 'TABLE_CREATE', 'TABLE_EDIT', 'TABLE_DELETE', 'TABLE_MERGE', 'TABLE_TRANSFER',
    // Orders
    'ORDER_VIEW', 'ORDER_CREATE', 'ORDER_MODIFY', 'ORDER_CANCEL', 'ORDER_VOID', 'ORDER_REOPEN',
    // KOT
    'KOT_SEND', 'KOT_MODIFY', 'KOT_CANCEL', 'KOT_REPRINT',
    // Billing
    'BILL_VIEW', 'BILL_GENERATE', 'BILL_REPRINT', 'BILL_CANCEL',
    // Payment
    'PAYMENT_COLLECT', 'PAYMENT_REFUND', 'PAYMENT_SPLIT',
    // Discounts
    'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'DISCOUNT_CUSTOM',
    'TAX_MODIFY', 'SERVICE_CHARGE_MODIFY', 'TIP_ADD',
    // Items
    'ITEM_VIEW', 'ITEM_CREATE', 'ITEM_EDIT', 'ITEM_DELETE', 'ITEM_CANCEL', 'ITEM_PRICING', 'ITEM_AVAILABILITY',
    // Categories
    'CATEGORY_VIEW', 'CATEGORY_CREATE', 'CATEGORY_EDIT', 'CATEGORY_DELETE',
    // Inventory
    'INVENTORY_VIEW', 'INVENTORY_EDIT', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER',
    // Staff (can manage captains)
    'STAFF_VIEW', 'STAFF_CREATE', 'STAFF_EDIT', 'STAFF_DELETE', 'STAFF_PERMISSIONS',
    // Reports
    'REPORT_VIEW', 'REPORT_SALES', 'REPORT_INVENTORY', 'REPORT_STAFF', 'REPORT_EXPORT',
    // Layout
    'FLOOR_VIEW', 'SECTION_VIEW',
    // Printers
    'PRINTER_VIEW',
    // Settings
    'SETTINGS_VIEW',
  ],
  
  // Captain - operational staff
  captain: [
    // Tables
    'TABLE_VIEW', 'TABLE_MERGE', 'TABLE_TRANSFER',
    // Orders
    'ORDER_VIEW', 'ORDER_CREATE', 'ORDER_MODIFY',
    // KOT
    'KOT_SEND', 'KOT_MODIFY', 'KOT_REPRINT',
    // Billing
    'BILL_VIEW', 'BILL_GENERATE', 'BILL_REPRINT',
    // Payment
    'PAYMENT_COLLECT', 'PAYMENT_SPLIT',
    // Discounts (limited)
    'DISCOUNT_APPLY', 'TIP_ADD',
    // Items
    'ITEM_VIEW', 'ITEM_CANCEL',
    // Categories
    'CATEGORY_VIEW',
    // Reports (limited)
    'REPORT_VIEW',
    // Layout
    'FLOOR_VIEW', 'SECTION_VIEW',
  ],
  
  // Waiter - basic operational
  waiter: [
    'TABLE_VIEW',
    'ORDER_VIEW', 'ORDER_CREATE', 'ORDER_MODIFY',
    'KOT_SEND',
    'BILL_VIEW',
    'ITEM_VIEW',
    'CATEGORY_VIEW',
    'FLOOR_VIEW', 'SECTION_VIEW',
  ],
  
  // Kitchen
  kitchen: [
    'ORDER_VIEW',
    'KOT_SEND', 'KOT_MODIFY',
    'ITEM_VIEW', 'ITEM_AVAILABILITY',
    'CATEGORY_VIEW',
    'INVENTORY_VIEW',
  ],
  
  // Bartender
  bartender: [
    'TABLE_VIEW',
    'ORDER_VIEW', 'ORDER_CREATE',
    'KOT_SEND',
    'ITEM_VIEW', 'ITEM_AVAILABILITY',
    'CATEGORY_VIEW',
    'INVENTORY_VIEW',
  ],
  
  // Cashier — Captain superset + full billing, payment, reports, cash drawer, discounts
  cashier: [
    // Tables (same as captain)
    'TABLE_VIEW', 'TABLE_MERGE', 'TABLE_TRANSFER',
    // Orders (captain + cancel)
    'ORDER_VIEW', 'ORDER_CREATE', 'ORDER_MODIFY', 'ORDER_CANCEL',
    // KOT (same as captain)
    'KOT_SEND', 'KOT_MODIFY', 'KOT_REPRINT',
    // Billing (full)
    'BILL_VIEW', 'BILL_GENERATE', 'BILL_REPRINT', 'BILL_CANCEL',
    // Payment (full collection)
    'PAYMENT_COLLECT', 'PAYMENT_SPLIT',
    // Discounts (full)
    'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'DISCOUNT_CUSTOM', 'TIP_ADD',
    // Items
    'ITEM_VIEW', 'ITEM_CANCEL', 'ITEM_AVAILABILITY',
    // Categories
    'CATEGORY_VIEW',
    // Reports (full view — day/week/month/hourly/tax/payment/staff/floor/cancellations)
    'REPORT_VIEW', 'REPORT_SALES', 'REPORT_STAFF',
    // Layout (floor & section scope)
    'FLOOR_VIEW', 'SECTION_VIEW',
  ],
  
  // POS User — identical to Cashier
  pos_user: [
    // Tables (same as captain)
    'TABLE_VIEW', 'TABLE_MERGE', 'TABLE_TRANSFER',
    // Orders (captain + cancel)
    'ORDER_VIEW', 'ORDER_CREATE', 'ORDER_MODIFY', 'ORDER_CANCEL',
    // KOT (same as captain)
    'KOT_SEND', 'KOT_MODIFY', 'KOT_REPRINT',
    // Billing (full)
    'BILL_VIEW', 'BILL_GENERATE', 'BILL_REPRINT', 'BILL_CANCEL',
    // Payment (full collection)
    'PAYMENT_COLLECT', 'PAYMENT_SPLIT',
    // Discounts (full)
    'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'DISCOUNT_CUSTOM', 'TIP_ADD',
    // Items
    'ITEM_VIEW', 'ITEM_CANCEL', 'ITEM_AVAILABILITY',
    // Categories
    'CATEGORY_VIEW',
    // Reports (full view — day/week/month/hourly/tax/payment/staff/floor/cancellations)
    'REPORT_VIEW', 'REPORT_SALES', 'REPORT_STAFF',
    // Layout (floor & section scope)
    'FLOOR_VIEW', 'SECTION_VIEW',
  ],

  // Inventory
  inventory: [
    'ITEM_VIEW',
    'CATEGORY_VIEW',
    'INVENTORY_VIEW', 'INVENTORY_EDIT', 'INVENTORY_ADJUST', 'INVENTORY_TRANSFER', 'PURCHASE_ORDER',
    'REPORT_VIEW', 'REPORT_INVENTORY',
  ],
};

async function seedPermissions() {
  const pool = getPool();
  
  console.log('\n🔐 Seeding Permission System...\n');
  
  try {
    // 1. Insert all permissions
    console.log('📋 Creating permissions...');
    const permissionMap = {};
    
    for (const perm of PERMISSIONS) {
      const [existing] = await pool.query(
        'SELECT id FROM permissions WHERE slug = ?',
        [perm.slug]
      );
      
      if (existing.length > 0) {
        permissionMap[perm.slug] = existing[0].id;
        console.log(`  ⏭ ${perm.slug} (exists)`);
      } else {
        const [result] = await pool.query(
          `INSERT INTO permissions (name, slug, module, category, display_order, description)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [perm.name, perm.slug, perm.module, perm.category, perm.order, `Permission to ${perm.name.toLowerCase()}`]
        );
        permissionMap[perm.slug] = result.insertId;
        console.log(`  ✓ ${perm.slug}`);
      }
    }
    
    console.log(`\n   Total permissions: ${Object.keys(permissionMap).length}`);
    
    // 2. Assign permissions to roles
    console.log('\n👥 Assigning role permissions...');
    
    for (const [roleName, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      // Get role ID
      const [roleRows] = await pool.query(
        'SELECT id FROM roles WHERE slug = ?',
        [roleName]
      );
      
      if (roleRows.length === 0) {
        console.log(`  ⚠ Role '${roleName}' not found, skipping`);
        continue;
      }
      
      const roleId = roleRows[0].id;
      
      // Skip admin (superuser - has all permissions implicitly)
      if (roleName === 'admin' || roleName === 'super_admin') {
        console.log(`  ⏭ ${roleName} (superuser - all permissions)`);
        continue;
      }
      
      let added = 0;
      let skipped = 0;
      
      for (const permSlug of permissions) {
        const permId = permissionMap[permSlug];
        if (!permId) {
          console.log(`    ⚠ Permission '${permSlug}' not found`);
          continue;
        }
        
        // Check if already assigned
        const [existing] = await pool.query(
          'SELECT id FROM role_permissions WHERE role_id = ? AND permission_id = ?',
          [roleId, permId]
        );
        
        if (existing.length === 0) {
          await pool.query(
            'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
            [roleId, permId]
          );
          added++;
        } else {
          skipped++;
        }
      }
      
      console.log(`  ✓ ${roleName}: ${added} added, ${skipped} existing`);
    }
    
    console.log('\n✅ Permission system seeded successfully!\n');
    
    // Print summary
    console.log('📊 Summary:');
    console.log(`   Permissions: ${PERMISSIONS.length}`);
    console.log(`   Roles configured: ${Object.keys(ROLE_PERMISSIONS).length}`);
    console.log('\n   Role Permissions:');
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === 'admin') {
        console.log(`   - ${role}: ALL (superuser)`);
      } else {
        console.log(`   - ${role}: ${perms.length} permissions`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error seeding permissions:', error.message);
    throw error;
  }
}

// Export for use in main seeder
module.exports = { seedPermissions, PERMISSIONS, ROLE_PERMISSIONS };

// Run directly if executed as script
if (require.main === module) {
  seedPermissions()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
