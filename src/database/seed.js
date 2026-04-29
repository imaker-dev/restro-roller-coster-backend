require('dotenv').config();

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const dbConfig = require('../config/database.config');

const getConnection = async () => {
  return mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
  });
};

const seedRoles = async (connection) => {
  console.log('→ Seeding roles...');
  
  const roles = [
    { name: 'Master', slug: 'master', description: 'Organization-level access, manages everything including super admins', is_system_role: true, priority: 200 },
    { name: 'Super Admin', slug: 'super_admin', description: 'Full system access', is_system_role: true, priority: 100 },
    { name: 'Admin', slug: 'admin', description: 'Outlet admin access', is_system_role: true, priority: 100 },
    { name: 'Manager', slug: 'manager', description: 'Manager level access', is_system_role: true, priority: 100 },
    { name: 'Captain', slug: 'captain', description: 'Captain/Waiter access', is_system_role: true, priority: 100 },
    { name: 'Cashier', slug: 'cashier', description: 'Cashier access', is_system_role: true, priority: 100 },
    { name: 'Kitchen', slug: 'kitchen', description: 'Kitchen display access', is_system_role: true, priority: 100 },
    { name: 'Bartender', slug: 'bartender', description: 'Bar access', is_system_role: true, priority: 100 },
    { name: 'POS User', slug: 'pos_user', description: 'POS User access — same as Cashier', is_system_role: true, priority: 100 },
    { name: 'Inventory', slug: 'inventory', description: 'Inventory management', is_system_role: true, priority: 100 },
  ];

  for (const role of roles) {
    await connection.query(
      `INSERT IGNORE INTO roles (name, slug, description, is_system_role, priority) VALUES (?, ?, ?, ?, ?)`,
      [role.name, role.slug, role.description, role.is_system_role, role.priority]
    );
  }
  
  console.log('  ✓ Roles seeded');
};

const seedPermissions = async (connection) => {
  console.log('→ Seeding permissions...');
  
  const modules = {
    outlet: ['view', 'create', 'update', 'delete', 'manage_settings'],
    floor: ['view', 'create', 'update', 'delete'],
    section: ['view', 'create', 'update', 'delete'],
    table: ['view', 'create', 'update', 'delete', 'manage_layout'],
    category: ['view', 'create', 'update', 'delete'],
    item: ['view', 'create', 'update', 'delete', 'manage_pricing'],
    variant: ['view', 'create', 'update', 'delete'],
    addon: ['view', 'create', 'update', 'delete'],
    order: ['view', 'create', 'update', 'cancel', 'void', 'transfer', 'merge'],
    kot: ['view', 'create', 'update', 'cancel', 'reprint'],
    billing: ['view', 'create', 'print', 'reprint', 'cancel'],
    payment: ['view', 'collect', 'refund', 'split'],
    discount: ['view', 'create', 'update', 'delete', 'apply', 'approve'],
    tax: ['view', 'create', 'update', 'delete'],
    inventory: ['view', 'create', 'update', 'delete', 'stock_in', 'stock_out', 'wastage'],
    report: ['view', 'export', 'daily', 'sales', 'inventory', 'tax', 'staff'],
    user: ['view', 'create', 'update', 'delete', 'manage_roles'],
    role: ['view', 'create', 'update', 'delete', 'assign'],
    settings: ['view', 'update'],
    printer: ['view', 'create', 'update', 'delete', 'test'],
  };

  for (const [module, actions] of Object.entries(modules)) {
    for (const action of actions) {
      const slug = `${module}.${action}`;
      const name = `${action.charAt(0).toUpperCase() + action.slice(1).replace('_', ' ')} ${module}`;
      await connection.query(
        `INSERT IGNORE INTO permissions (name, slug, module) VALUES (?, ?, ?)`,
        [name, slug, module]
      );
    }
  }
  
  console.log('  ✓ Permissions seeded');
};

const seedTaxTypes = async (connection) => {
  console.log('→ Seeding tax types...');
  
  const taxTypes = [
    { name: 'GST', code: 'GST', description: 'Goods and Services Tax' },
    { name: 'VAT', code: 'VAT', description: 'Value Added Tax' },
    { name: 'Service Tax', code: 'SERVICE', description: 'Service Tax' },
  ];

  for (const tax of taxTypes) {
    await connection.query(
      `INSERT IGNORE INTO tax_types (name, code, description) VALUES (?, ?, ?)`,
      [tax.name, tax.code, tax.description]
    );
  }
  
  console.log('  ✓ Tax types seeded');
};

const seedTaxComponents = async (connection) => {
  console.log('→ Seeding tax components...');
  
  const [gstType] = await connection.query(`SELECT id FROM tax_types WHERE code = 'GST'`);
  const [vatType] = await connection.query(`SELECT id FROM tax_types WHERE code = 'VAT'`);
  
  if (gstType.length > 0) {
    const gstId = gstType[0].id;
    const gstComponents = [
      { name: 'CGST 2.5%', code: 'CGST_2.5', rate: 2.5 },
      { name: 'SGST 2.5%', code: 'SGST_2.5', rate: 2.5 },
      { name: 'CGST 6%', code: 'CGST_6', rate: 6 },
      { name: 'SGST 6%', code: 'SGST_6', rate: 6 },
      { name: 'CGST 9%', code: 'CGST_9', rate: 9 },
      { name: 'SGST 9%', code: 'SGST_9', rate: 9 },
      { name: 'IGST 5%', code: 'IGST_5', rate: 5 },
      { name: 'IGST 12%', code: 'IGST_12', rate: 12 },
      { name: 'IGST 18%', code: 'IGST_18', rate: 18 },
    ];
    
    for (const comp of gstComponents) {
      await connection.query(
        `INSERT IGNORE INTO tax_components (tax_type_id, name, code, rate) VALUES (?, ?, ?, ?)`,
        [gstId, comp.name, comp.code, comp.rate]
      );
    }
  }
  
  if (vatType.length > 0) {
    const vatId = vatType[0].id;
    const vatComponents = [
      { name: 'VAT 5%', code: 'VAT_5', rate: 5 },
      { name: 'VAT 12.5%', code: 'VAT_12.5', rate: 12.5 },
      { name: 'VAT 14.5%', code: 'VAT_14.5', rate: 14.5 },
      { name: 'VAT 20%', code: 'VAT_20', rate: 20 },
    ];
    
    for (const comp of vatComponents) {
      await connection.query(
        `INSERT IGNORE INTO tax_components (tax_type_id, name, code, rate) VALUES (?, ?, ?, ?)`,
        [vatId, comp.name, comp.code, comp.rate]
      );
    }
  }
  
  console.log('  ✓ Tax components seeded');
};

const seedCancelReasons = async (connection) => {
  console.log('→ Seeding cancel reasons...');
  
  const reasons = [
    { type: 'order_cancel', reason: 'Customer cancelled', requires_approval: false },
    { type: 'order_cancel', reason: 'Customer left', requires_approval: false },
    { type: 'order_cancel', reason: 'Duplicate order', requires_approval: false },
    { type: 'order_cancel', reason: 'Item not available', requires_approval: false },
    { type: 'order_cancel', reason: 'Kitchen closed', requires_approval: false },
    { type: 'order_cancel', reason: 'Other', requires_approval: true },
    { type: 'item_cancel', reason: 'Customer changed mind', requires_approval: false },
    { type: 'item_cancel', reason: 'Wrong item ordered', requires_approval: false },
    { type: 'item_cancel', reason: 'Item out of stock', requires_approval: false },
    { type: 'item_cancel', reason: 'Quality issue', requires_approval: true },
    { type: 'item_cancel', reason: 'Preparation delay', requires_approval: false },
    { type: 'void', reason: 'Billing error', requires_approval: true },
    { type: 'void', reason: 'Price correction', requires_approval: true },
    { type: 'void', reason: 'Duplicate billing', requires_approval: true },
    { type: 'return', reason: 'Customer complaint', requires_approval: true },
    { type: 'return', reason: 'Wrong item served', requires_approval: false },
  ];

  for (let i = 0; i < reasons.length; i++) {
    const r = reasons[i];
    await connection.query(
      `INSERT IGNORE INTO cancel_reasons (reason_type, reason, requires_approval, display_order) VALUES (?, ?, ?, ?)`,
      [r.type, r.reason, r.requires_approval, i]
    );
  }
  
  console.log('  ✓ Cancel reasons seeded');
};

const seedDefaultMaster = async (connection) => {
  console.log('→ Seeding default master user...');
  
  const passwordHash = await bcrypt.hash('Master@123', 10);
  const pinHash = await bcrypt.hash('1234', 10);
  const uuid = uuidv4();
  
  await connection.query(
    `INSERT IGNORE INTO users (uuid, employee_code, name, email, password_hash, pin_hash, is_active, is_verified) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid, 'MASTER001', 'iMaker Admin', 'imaker@restropos.com', passwordHash, pinHash, true, true]
  );
  
  // Assign master role
  const [users] = await connection.query(`SELECT id FROM users WHERE email = 'imaker@restropos.com'`);
  const [roles] = await connection.query(`SELECT id FROM roles WHERE slug = 'master'`);
  
  if (users.length > 0 && roles.length > 0) {
    await connection.query(
      `INSERT IGNORE INTO user_roles (user_id, role_id, is_active) VALUES (?, ?, ?)`,
      [users[0].id, roles[0].id, true]
    );
  }
  
  console.log('  ✓ Default master seeded (email: imaker@restropos.com, password: Master@123, pin: 1234)');
};

const seedDefaultAdmin = async (connection) => {
  console.log('→ Seeding default admin user...');
  
  const passwordHash = await bcrypt.hash('admin123', 10);
  const pinHash = await bcrypt.hash('1234', 10);
  const uuid = uuidv4();
  
  await connection.query(
    `INSERT IGNORE INTO users (uuid, employee_code, name, email, password_hash, pin_hash, is_active, is_verified) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid, 'ADMIN001', 'System Admin', 'admin@restropos.com', passwordHash, pinHash, true, true]
  );
  
  // Assign super_admin role
  const [users] = await connection.query(`SELECT id FROM users WHERE email = 'admin@restropos.com'`);
  const [roles] = await connection.query(`SELECT id FROM roles WHERE slug = 'super_admin'`);
  
  if (users.length > 0 && roles.length > 0) {
    await connection.query(
      `INSERT IGNORE INTO user_roles (user_id, role_id, is_active) VALUES (?, ?, ?)`,
      [users[0].id, roles[0].id, true]
    );
  }
  
  console.log('  ✓ Default admin seeded (email: admin@restropos.com, password: admin123, pin: 1234)');
};

const seedDefaultTimeSlots = async (connection, outletId) => {
  console.log('→ Seeding default time slots...');
  
  const timeSlots = [
    { name: 'Breakfast', code: 'BREAKFAST', start_time: '06:00:00', end_time: '11:00:00', display_order: 1 },
    { name: 'Lunch', code: 'LUNCH', start_time: '11:00:00', end_time: '16:00:00', display_order: 2 },
    { name: 'Snacks', code: 'SNACKS', start_time: '16:00:00', end_time: '19:00:00', display_order: 3 },
    { name: 'Dinner', code: 'DINNER', start_time: '19:00:00', end_time: '23:00:00', display_order: 4 },
    { name: 'Late Night', code: 'LATE_NIGHT', start_time: '23:00:00', end_time: '06:00:00', display_order: 5 },
    { name: 'Happy Hour', code: 'HAPPY_HOUR', start_time: '17:00:00', end_time: '20:00:00', display_order: 6 },
    { name: 'Bar Time', code: 'BAR_TIME', start_time: '18:00:00', end_time: '01:00:00', display_order: 7 },
  ];

  // Check if time_slots table exists
  const [tables] = await connection.query(`SHOW TABLES LIKE 'time_slots'`);
  if (tables.length === 0) {
    console.log('  ⚠ time_slots table not found (run migration 010 first)');
    return;
  }

  if (outletId) {
    for (const slot of timeSlots) {
      await connection.query(
        `INSERT IGNORE INTO time_slots (outlet_id, name, code, start_time, end_time, display_order) VALUES (?, ?, ?, ?, ?, ?)`,
        [outletId, slot.name, slot.code, slot.start_time, slot.end_time, slot.display_order]
      );
    }
    console.log('  ✓ Time slots seeded');
  } else {
    console.log('  ⚠ No outlet found, skipping time slots');
  }
};

const seedDefaultKitchenStations = async (connection, outletId) => {
  console.log('→ Seeding default kitchen stations...');
  
  const stations = [
    { name: 'Main Kitchen', code: 'MAIN', station_type: 'main_kitchen', display_order: 1 },
    { name: 'Tandoor', code: 'TANDOOR', station_type: 'tandoor', display_order: 2 },
  ];

  // Check if kitchen_stations table exists
  const [tables] = await connection.query(`SHOW TABLES LIKE 'kitchen_stations'`);
  if (tables.length === 0) {
    console.log('  ⚠ kitchen_stations table not found (run migration 010 first)');
    return;
  }

  if (outletId) {
    for (const station of stations) {
      await connection.query(
        `INSERT IGNORE INTO kitchen_stations (outlet_id, name, code, station_type, display_order) VALUES (?, ?, ?, ?, ?)`,
        [outletId, station.name, station.code, station.station_type, station.display_order]
      );
    }
    console.log('  ✓ Kitchen stations seeded');
  } else {
    console.log('  ⚠ No outlet found, skipping kitchen stations');
  }
};

const seedDefaultCounters = async (connection, outletId) => {
  console.log('→ Seeding default counters...');
  
  const counters = [
    { name: 'Main Bar', code: 'MAIN_BAR', counter_type: 'main_bar', display_order: 1 },
    { name: 'Mocktail Counter', code: 'MOCKTAIL', counter_type: 'mocktail', display_order: 2 },
    { name: 'Whisky Bar', code: 'WHISKY', counter_type: 'whisky', display_order: 3 },
    { name: 'Beer Station', code: 'BEER', counter_type: 'beer', display_order: 4 },
    { name: 'Wine Corner', code: 'WINE', counter_type: 'wine', display_order: 5 },
    { name: 'Coffee Station', code: 'COFFEE', counter_type: 'coffee', display_order: 6 },
  ];

  // Check if counters table exists
  const [tables] = await connection.query(`SHOW TABLES LIKE 'counters'`);
  if (tables.length === 0) {
    console.log('  ⚠ counters table not found (run migration 010 first)');
    return;
  }

  if (outletId) {
    for (const counter of counters) {
      await connection.query(
        `INSERT IGNORE INTO counters (outlet_id, name, code, counter_type, display_order) VALUES (?, ?, ?, ?, ?)`,
        [outletId, counter.name, counter.code, counter.counter_type, counter.display_order]
      );
    }
    console.log('  ✓ Counters seeded');
  } else {
    console.log('  ⚠ No outlet found, skipping counters');
  }
};

const seedSystemSettings = async (connection) => {
  console.log('→ Seeding system settings...');
  
  const settings = [
    { key: 'currency_symbol', value: '₹', type: 'string', description: 'Currency symbol' },
    { key: 'currency_code', value: 'INR', type: 'string', description: 'Currency code' },
    { key: 'decimal_places', value: '2', type: 'number', description: 'Decimal places for amounts' },
    { key: 'date_format', value: 'DD/MM/YYYY', type: 'string', description: 'Date format' },
    { key: 'time_format', value: 'HH:mm', type: 'string', description: 'Time format' },
    { key: 'timezone', value: 'Asia/Kolkata', type: 'string', description: 'Default timezone' },
    { key: 'round_off_enabled', value: 'true', type: 'boolean', description: 'Enable bill round off' },
    { key: 'round_off_to', value: '1', type: 'number', description: 'Round off to nearest value' },
    { key: 'kot_auto_print', value: 'true', type: 'boolean', description: 'Auto print KOT' },
    { key: 'bill_auto_print', value: 'false', type: 'boolean', description: 'Auto print bill' },
    { key: 'service_charge_enabled', value: 'false', type: 'boolean', description: 'Enable service charge' },
    { key: 'service_charge_percent', value: '10', type: 'number', description: 'Service charge percentage' },
    { key: 'gst_enabled', value: 'true', type: 'boolean', description: 'Enable GST' },
    { key: 'vat_enabled', value: 'false', type: 'boolean', description: 'Enable VAT' },
    { key: 'allow_negative_stock', value: 'false', type: 'boolean', description: 'Allow negative stock' },
    { key: 'low_stock_alert_enabled', value: 'true', type: 'boolean', description: 'Enable low stock alerts' },
  ];

  for (const setting of settings) {
    await connection.query(
      `INSERT IGNORE INTO system_settings (setting_key, setting_value, setting_type, description) VALUES (?, ?, ?, ?)`,
      [setting.key, setting.value, setting.type, setting.description]
    );
  }
  
  console.log('  ✓ System settings seeded');
};

const seedDefaultOutlet = async (connection) => {
  console.log('→ Seeding default outlet...');
  
  const uuid = uuidv4();
  
  await connection.query(
    `INSERT IGNORE INTO outlets (uuid, code, name, outlet_type, city, state, country, currency_code, is_active) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid, 'MAIN', 'Main Restaurant', 'restaurant', 'Mumbai', 'Maharashtra', 'India', 'INR', true]
  );
  
  const [outlets] = await connection.query(`SELECT id FROM outlets WHERE code = 'MAIN'`);
  
  if (outlets.length > 0) {
    console.log('  ✓ Default outlet seeded');
    return outlets[0].id;
  }
  
  return null;
};

const runSeeders = async () => {
  console.log('\n🌱 Running seeders...\n');
  
  const connection = await getConnection();
  
  try {
    await seedRoles(connection);
    await seedPermissions(connection);
    await seedTaxTypes(connection);
    await seedTaxComponents(connection);
    await seedCancelReasons(connection);
    await seedDefaultMaster(connection);
    await seedDefaultAdmin(connection);
    await seedSystemSettings(connection);
    
    // Seed outlet-dependent data
    const outletId = await seedDefaultOutlet(connection);
    await seedDefaultTimeSlots(connection, outletId);
    await seedDefaultKitchenStations(connection, outletId);
    await seedDefaultCounters(connection, outletId);
    
    console.log('\n✓ All seeders completed successfully\n');
    
  } catch (error) {
    console.error('\n✗ Seeding failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await connection.end();
  }
};

runSeeders();
