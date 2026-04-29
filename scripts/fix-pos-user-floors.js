/**
 * Fix POS User Floor Assignments
 * 
 * 1. Find all POS users for outlet 43
 * 2. Assign them to both floors (32 and 33)
 * 3. Close any shifts with floor_id = NULL
 * 
 * Run: node scripts/fix-pos-user-floors.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

async function run() {
  console.log('\n🚀 Fix POS User Floor Assignments\n');

  const conn = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password
  });

  try {
    // 1. Find POS users
    console.log('📋 Finding POS users...');
    const [posUsers] = await conn.query(`
      SELECT u.id, u.name, u.employee_code 
      FROM users u 
      JOIN user_roles ur ON u.id = ur.user_id 
      JOIN roles r ON ur.role_id = r.id 
      WHERE r.name = 'POS User'
    `);
    console.table(posUsers);

    if (posUsers.length === 0) {
      console.log('⚠️  No POS users found');
      return;
    }

    // 2. Get floors for outlet 43
    const [floors] = await conn.query('SELECT id, name FROM floors WHERE outlet_id = 43');
    console.log('\n📋 Floors for outlet 43:');
    console.table(floors);

    // 3. Assign POS users to all floors
    console.log('\n📋 Assigning POS users to floors...');
    for (const user of posUsers) {
      for (const floor of floors) {
        // Check if assignment already exists
        const [existing] = await conn.query(
          'SELECT id FROM user_floors WHERE user_id = ? AND floor_id = ? AND outlet_id = 43',
          [user.id, floor.id]
        );

        if (existing.length > 0) {
          console.log(`  ⏭️  ${user.name} already assigned to ${floor.name}`);
          continue;
        }

        // Insert new assignment
        await conn.query(
          `INSERT INTO user_floors (user_id, floor_id, outlet_id, is_primary, is_active)
           VALUES (?, ?, 43, 0, 1)`,
          [user.id, floor.id]
        );
        console.log(`  ✅ ${user.name} assigned to ${floor.name}`);
      }
    }

    // 4. Close any shifts with floor_id = NULL
    console.log('\n📋 Closing shifts with floor_id = NULL...');
    const [nullShifts] = await conn.query(
      `UPDATE day_sessions SET status = 'closed', closing_time = NOW()
       WHERE floor_id IS NULL AND status = 'open'`
    );
    console.log(`  ✅ Closed ${nullShifts.affectedRows} shift(s) with NULL floor_id`);

    // 5. Verify
    console.log('\n📋 Verification - User floor assignments:');
    const [assignments] = await conn.query(`
      SELECT uf.user_id, u.name, uf.floor_id, f.name as floor_name, uf.is_primary
      FROM user_floors uf
      JOIN users u ON uf.user_id = u.id
      LEFT JOIN floors f ON uf.floor_id = f.id
      WHERE uf.outlet_id = 43 AND uf.is_active = 1
      ORDER BY u.name, f.name
    `);
    console.table(assignments);

    console.log('\n📋 Open shifts for outlet 43:');
    const [openShifts] = await conn.query(
      'SELECT id, floor_id, status, session_date FROM day_sessions WHERE outlet_id = 43 AND status = \"open\"'
    );
    if (openShifts.length === 0) {
      console.log('  (No open shifts)');
    } else {
      console.table(openShifts);
    }

    console.log('\n✅ Done!\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

run();
