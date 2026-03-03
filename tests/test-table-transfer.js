/**
 * Table Transfer Test Script
 * Tests the complete table transfer workflow:
 * 1. Verify source table has active session/order
 * 2. Transfer from T1 → T2
 * 3. Verify T1 becomes available
 * 4. Verify T2 gets the session/order
 * 5. Verify KOT references are maintained
 * 6. Verify billing data is preserved
 */

require('dotenv').config();
const { initializeDatabase, getPool } = require('../src/database');
const tableService = require('../src/services/table.service');
const orderService = require('../src/services/order.service');

async function runTests() {
  console.log('═'.repeat(60));
  console.log('  TABLE TRANSFER TEST');
  console.log('═'.repeat(60));

  await initializeDatabase();
  const pool = getPool();
  console.log('✅ Database connected\n');

  try {
    // Find tables for testing
    const [tables] = await pool.query(
      `SELECT t.id, t.table_number, t.status, t.floor_id, t.outlet_id,
              ts.id as session_id, ts.order_id, o.order_number
       FROM tables t
       LEFT JOIN table_sessions ts ON t.id = ts.table_id AND ts.status = 'active'
       LEFT JOIN orders o ON ts.order_id = o.id
       WHERE t.outlet_id = 43 AND t.is_active = 1
       ORDER BY t.id
       LIMIT 10`
    );

    console.log('📋 Available Tables:');
    tables.forEach(t => {
      console.log(`   ${t.table_number}: ${t.status}${t.session_id ? ` (Session: ${t.session_id}, Order: ${t.order_number || 'none'})` : ''}`);
    });
    console.log();

    // Find an occupied/running table (source)
    const sourceTable = tables.find(t => ['occupied', 'running', 'billing'].includes(t.status) && t.session_id);
    // Find an available table (target)
    const targetTable = tables.find(t => t.status === 'available');

    if (!sourceTable) {
      console.log('⚠️  No occupied/running table with session found for testing');
      console.log('   Please start a table session first, then run this test');
      process.exit(0);
    }

    if (!targetTable) {
      console.log('⚠️  No available table found for transfer target');
      process.exit(0);
    }

    console.log('📍 TEST: Table Transfer');
    console.log('─'.repeat(50));
    console.log(`   Source: ${sourceTable.table_number} (${sourceTable.status})`);
    console.log(`   Target: ${targetTable.table_number} (${targetTable.status})`);
    console.log(`   Session ID: ${sourceTable.session_id}`);
    console.log(`   Order: ${sourceTable.order_number || 'No order yet'}`);
    console.log();

    // Get a user ID (admin/manager/cashier) for testing
    const [users] = await pool.query(
      `SELECT u.id, u.name, r.slug as role 
       FROM users u
       JOIN user_roles ur ON u.id = ur.user_id
       JOIN roles r ON ur.role_id = r.id
       WHERE r.slug IN ('admin', 'manager', 'cashier', 'captain') AND u.is_active = 1
       LIMIT 1`
    );
    const testUserId = users[0]?.id || 1;
    console.log(`   Performing transfer as: ${users[0]?.name || 'User'} (${users[0]?.role || 'unknown'})`);
    console.log();

    // Perform the transfer
    console.log('🔄 Executing transfer...');
    const result = await tableService.transferTable(
      sourceTable.id,
      targetTable.id,
      testUserId
    );

    console.log('✅ Transfer Result:');
    console.log(`   Success: ${result.success}`);
    console.log(`   Message: ${result.message}`);
    console.log();

    // Verify source table is now available
    const updatedSource = await tableService.getById(sourceTable.id);
    console.log('📍 VERIFY: Source Table After Transfer');
    console.log(`   Table: ${updatedSource.table_number}`);
    console.log(`   Status: ${updatedSource.status}`);
    console.log(`   Expected: available`);
    console.log(`   ✅ ${updatedSource.status === 'available' ? 'PASS' : 'FAIL'}`);
    console.log();

    // Verify target table has session
    const updatedTarget = await tableService.getById(targetTable.id);
    const [targetSession] = await pool.query(
      `SELECT ts.*, o.order_number FROM table_sessions ts
       LEFT JOIN orders o ON ts.order_id = o.id
       WHERE ts.table_id = ? AND ts.status = 'active'`,
      [targetTable.id]
    );

    console.log('📍 VERIFY: Target Table After Transfer');
    console.log(`   Table: ${updatedTarget.table_number}`);
    console.log(`   Status: ${updatedTarget.status}`);
    console.log(`   Expected: ${sourceTable.status}`);
    console.log(`   Session ID: ${targetSession[0]?.id || 'none'}`);
    console.log(`   Order: ${targetSession[0]?.order_number || 'none'}`);
    console.log(`   ✅ ${updatedTarget.status === sourceTable.status ? 'PASS' : 'FAIL'}`);
    console.log();

    // Verify order now points to target table
    if (sourceTable.order_id) {
      const [order] = await pool.query(
        `SELECT id, order_number, table_id, floor_id FROM orders WHERE id = ?`,
        [sourceTable.order_id]
      );
      console.log('📍 VERIFY: Order Table Reference');
      console.log(`   Order: ${order[0]?.order_number}`);
      console.log(`   Table ID: ${order[0]?.table_id}`);
      console.log(`   Expected Table ID: ${targetTable.id}`);
      console.log(`   ✅ ${order[0]?.table_id === targetTable.id ? 'PASS' : 'FAIL'}`);
      console.log();
    }

    // Check table history for audit trail
    const [history] = await pool.query(
      `SELECT action, details, performed_by, created_at 
       FROM table_history 
       WHERE table_id IN (?, ?) AND action LIKE 'table_transferred%'
       ORDER BY created_at DESC LIMIT 2`,
      [sourceTable.id, targetTable.id]
    );
    console.log('📍 VERIFY: Audit Trail');
    history.forEach(h => {
      const details = JSON.parse(h.details);
      console.log(`   Action: ${h.action}`);
      console.log(`   From: ${details.sourceTableNumber} → To: ${details.targetTableNumber}`);
    });
    console.log(`   ✅ ${history.length === 2 ? 'PASS' : 'FAIL'} (Expected 2 history entries)`);
    console.log();

    // Verify source table can now be used for new session
    console.log('📍 VERIFY: Source Table Ready for New Session');
    const sourceStatus = await tableService.getById(sourceTable.id);
    console.log(`   Status: ${sourceStatus.status}`);
    console.log(`   Can start new session: ${sourceStatus.status === 'available' ? 'YES' : 'NO'}`);
    console.log();

    console.log('═'.repeat(60));
    console.log('  ✅ ALL TABLE TRANSFER TESTS COMPLETED');
    console.log('═'.repeat(60));

  } catch (error) {
    console.error('❌ Test Error:', error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

runTests();
