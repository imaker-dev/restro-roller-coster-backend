/**
 * Run the kitchen_stations fix for outlet 44
 * Usage: node src/database/migrations/run-fix-kitchen-stations.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function runFix() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'restro',
    multipleStatements: true
  });

  console.log('🔧 Fixing kitchen_stations for outlet 44...\n');

  try {
    // Step 1: Fix station_type based on station code/name
    console.log('Step 1: Fixing station_type values...');
    
    await connection.query(`UPDATE kitchen_stations SET station_type = 'main_kitchen' WHERE outlet_id = 44 AND UPPER(code) = 'KITCHEN'`);
    await connection.query(`UPDATE kitchen_stations SET station_type = 'dessert' WHERE outlet_id = 44 AND UPPER(code) = 'DESSERT'`);
    await connection.query(`UPDATE kitchen_stations SET station_type = 'tandoor' WHERE outlet_id = 44 AND UPPER(code) = 'TANDOOR'`);
    await connection.query(`UPDATE kitchen_stations SET station_type = 'bar' WHERE outlet_id = 44 AND UPPER(code) = 'BAR'`);
    
    console.log('   ✅ station_type values updated\n');

    // Step 2: Link printer_id — match kitchen_station name to printers.station
    console.log('Step 2: Linking printer_id...');

    // Get all printers for outlet 44
    const [printers] = await connection.query(
      `SELECT id, station, ip_address FROM printers WHERE outlet_id = 44 AND is_active = 1`
    );
    console.log(`   Found ${printers.length} active printers for outlet 44`);

    // Kitchen station → printer with station='kitchen' (or first available)
    const kitchenPrinter = printers.find(p => p.station === 'kitchen') || printers[0];
    const barPrinter = printers.find(p => p.station === 'bar') || kitchenPrinter;

    if (kitchenPrinter) {
      await connection.query(
        `UPDATE kitchen_stations SET printer_id = ? WHERE outlet_id = 44 AND UPPER(code) = 'KITCHEN'`,
        [kitchenPrinter.id]
      );
      await connection.query(
        `UPDATE kitchen_stations SET printer_id = ? WHERE outlet_id = 44 AND UPPER(code) = 'DESSERT'`,
        [kitchenPrinter.id]
      );
      await connection.query(
        `UPDATE kitchen_stations SET printer_id = ? WHERE outlet_id = 44 AND UPPER(code) = 'TANDOOR'`,
        [kitchenPrinter.id]
      );
      console.log(`   ✅ Kitchen/Dessert/Tandoor → printer ${kitchenPrinter.id} (${kitchenPrinter.station})`);
    }

    if (barPrinter) {
      await connection.query(
        `UPDATE kitchen_stations SET printer_id = ? WHERE outlet_id = 44 AND UPPER(code) = 'BAR'`,
        [barPrinter.id]
      );
      console.log(`   ✅ Bar → printer ${barPrinter.id} (${barPrinter.station})`);
    }

    // Step 3: Verify
    console.log('\nStep 3: Verifying changes...\n');
    const [result] = await connection.query(`
      SELECT ks.id, ks.name, ks.code, ks.station_type, ks.printer_id,
             p.name as printer_name, p.station as printer_station, p.ip_address
      FROM kitchen_stations ks
      LEFT JOIN printers p ON ks.printer_id = p.id
      WHERE ks.outlet_id = 44
    `);

    console.log('   Kitchen Stations for Outlet 44:');
    console.log('   ─────────────────────────────────────────────────────────────');
    for (const row of result) {
      console.log(`   ${row.name.padEnd(12)} | type: ${(row.station_type || 'NULL').padEnd(12)} | printer: ${row.printer_id || 'NULL'} (${row.printer_station || 'N/A'}) → ${row.ip_address || 'N/A'}`);
    }
    console.log('   ─────────────────────────────────────────────────────────────');

    console.log('\n✅ Fix completed successfully!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await connection.end();
  }
}

runFix();
