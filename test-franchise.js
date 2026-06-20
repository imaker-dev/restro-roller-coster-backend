/**
 * Quick test script to verify franchise endpoints work
 */
require('dotenv').config();
const { initializeDatabase, getPool } = require('./src/database');

async function test() {
  try {
    await initializeDatabase();
    console.log('DB connected');

    const pool = getPool();

    // Test 1: Check if table exists
    const [tables] = await pool.query(`
      SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'franchises'
    `);
    console.log('Table exists:', tables.length > 0);

    if (tables.length === 0) {
      console.log('ERROR: franchises table does not exist!');
      return;
    }

    // Test 2: Count rows
    const [count] = await pool.query('SELECT COUNT(*) AS total FROM franchises');
    console.log('Franchise rows:', count[0].total);

    // Test 3: Run the actual list query
    const [rows] = await pool.query(`
      SELECT id, name, slug, category, short_description, logo_url, cover_image_url,
             investment_min, investment_max, expected_roi, break_even_months,
             outlets_live, established_year, tags, location_city, location_state, is_featured,
             created_at
      FROM franchises
      WHERE status = 'active'
      ORDER BY is_featured DESC, created_at DESC
      LIMIT 12 OFFSET 0
    `);
    console.log('Query returned', rows.length, 'rows');
    if (rows.length > 0) {
      console.log('First row:', JSON.stringify(rows[0], null, 2));
    }

    // Test 4: Check route exports
    const routes = require('./src/routes/franchise.routes.js');
    console.log('Route loaded OK, type:', typeof routes);

    // Test 5: Check controller exports
    const ctrl = require('./src/controllers/franchise.controller.js');
    console.log('Controller exports:', Object.keys(ctrl));

    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

test();
