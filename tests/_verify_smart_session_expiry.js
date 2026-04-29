/**
 * Test: Smart Self-Order Session Expiry
 * 
 * Rules tested:
 * 1. Session without order: expires after 20 minutes (idle timeout)
 * 2. Session with active order: stays active
 * 3. Session after order completion: expires after 5 minutes buffer
 * 
 * Run: node tests/_verify_smart_session_expiry.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const dbConfig = require('../src/config/database.config');
const { initializeDatabase } = require('../src/database');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

async function getConnection() {
  return mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port, database: dbConfig.database,
    user: dbConfig.user, password: dbConfig.password
  });
}

(async () => {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SMART SELF-ORDER SESSION EXPIRY TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Initialize database pool for selfOrderService
  await initializeDatabase();

  const conn = await getConnection();
  const OUTLET_ID = 43;
  const TABLE_ID = 67;

  // Cleanup
  await conn.query(`DELETE FROM self_order_sessions WHERE outlet_id = ? AND table_id = ?`, [OUTLET_ID, TABLE_ID]);

  // ═══════════════════════════════════════════════════════════════
  // TEST 1: Session without order expires after idle timeout
  // ═══════════════════════════════════════════════════════════════
  console.log('── TEST 1: Idle Session Expiry ──');
  
  // Create a session that was created 25 minutes ago (should expire)
  const token1 = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  await conn.query(`
    INSERT INTO self_order_sessions (token, outlet_id, table_id, device_id, status, idle_timeout_minutes, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'active', 20, NOW() - INTERVAL 25 MINUTE, NOW() + INTERVAL 2 HOUR)
  `, [token1, OUTLET_ID, TABLE_ID, uuidv4()]);

  // Run expiry check
  const selfOrderService = require('../src/services/selfOrder.service');
  const result1 = await selfOrderService.expireIdleSessions(OUTLET_ID, TABLE_ID);
  
  const [[session1]] = await conn.query(`SELECT status FROM self_order_sessions WHERE token = ?`, [token1]);
  ok(session1.status === 'expired', `Idle session (25 min old) expired: ${session1.status}`);
  ok(result1.expiredCount >= 1, `expireIdleSessions returned count: ${result1.expiredCount}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 2: Session without order within timeout stays active
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 2: Fresh Idle Session Stays Active ──');
  
  const token2 = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  await conn.query(`
    INSERT INTO self_order_sessions (token, outlet_id, table_id, device_id, status, idle_timeout_minutes, created_at, expires_at)
    VALUES (?, ?, ?, ?, 'active', 20, NOW() - INTERVAL 10 MINUTE, NOW() + INTERVAL 2 HOUR)
  `, [token2, OUTLET_ID, TABLE_ID, uuidv4()]);

  await selfOrderService.expireIdleSessions(OUTLET_ID, TABLE_ID);
  
  const [[session2]] = await conn.query(`SELECT status FROM self_order_sessions WHERE token = ?`, [token2]);
  ok(session2.status === 'active', `Fresh idle session (10 min old) stays active: ${session2.status}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 3: Session with active order stays active regardless of time
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 3: Session with Active Order Stays Active ──');
  
  // Create a mock order
  const orderUuid = uuidv4();
  const [orderResult] = await conn.query(`
    INSERT INTO orders (uuid, outlet_id, table_id, order_number, order_type, status, subtotal, total_amount, order_source)
    VALUES (?, ?, ?, 'TEST-EXPIRY-001', 'dine_in', 'confirmed', 100, 100, 'self_order')
  `, [orderUuid, OUTLET_ID, TABLE_ID]);
  const orderId = orderResult.insertId;

  const token3 = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  await conn.query(`
    INSERT INTO self_order_sessions (token, outlet_id, table_id, device_id, order_id, status, idle_timeout_minutes, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'ordering', 20, NOW() - INTERVAL 60 MINUTE, NOW() + INTERVAL 2 HOUR)
  `, [token3, OUTLET_ID, TABLE_ID, uuidv4(), orderId]);

  await selfOrderService.expireIdleSessions(OUTLET_ID, TABLE_ID);
  
  const [[session3]] = await conn.query(`SELECT status FROM self_order_sessions WHERE token = ?`, [token3]);
  ok(session3.status === 'ordering', `Session with active order (60 min old) stays active: ${session3.status}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 4: Session after order completion expires after buffer
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 4: Completed Order Session Expires After Buffer ──');
  
  const token4 = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  await conn.query(`
    INSERT INTO self_order_sessions (token, outlet_id, table_id, device_id, order_id, status, completion_buffer_minutes, order_completed_at, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'ordering', 5, NOW() - INTERVAL 10 MINUTE, NOW() - INTERVAL 60 MINUTE, NOW() + INTERVAL 2 HOUR)
  `, [token4, OUTLET_ID, TABLE_ID, uuidv4(), orderId]);

  await selfOrderService.expireIdleSessions(OUTLET_ID, TABLE_ID);
  
  const [[session4]] = await conn.query(`SELECT status FROM self_order_sessions WHERE token = ?`, [token4]);
  ok(session4.status === 'expired', `Completed session (10 min after completion) expired: ${session4.status}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 5: Completed session within buffer stays active
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 5: Completed Session Within Buffer Stays Active ──');
  
  const token5 = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  await conn.query(`
    INSERT INTO self_order_sessions (token, outlet_id, table_id, device_id, order_id, status, completion_buffer_minutes, order_completed_at, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'ordering', 5, NOW() - INTERVAL 2 MINUTE, NOW() - INTERVAL 60 MINUTE, NOW() + INTERVAL 2 HOUR)
  `, [token5, OUTLET_ID, TABLE_ID, uuidv4(), orderId]);

  await selfOrderService.expireIdleSessions(OUTLET_ID, TABLE_ID);
  
  const [[session5]] = await conn.query(`SELECT status FROM self_order_sessions WHERE token = ?`, [token5]);
  ok(session5.status === 'ordering', `Completed session (2 min after completion) stays active: ${session5.status}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 6: checkSessionExpiry method
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 6: checkSessionExpiry Method ──');
  
  // Get session IDs
  const [[s2]] = await conn.query(`SELECT id FROM self_order_sessions WHERE token = ?`, [token2]);
  const [[s3]] = await conn.query(`SELECT id FROM self_order_sessions WHERE token = ?`, [token3]);
  
  const check2 = await selfOrderService.checkSessionExpiry(s2.id);
  ok(!check2.expired, `Fresh idle session not expired: ${check2.reason}`);
  
  const check3 = await selfOrderService.checkSessionExpiry(s3.id);
  ok(!check3.expired, `Active order session not expired: ${check3.reason}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 7: markSessionOrderCompleted
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 7: markSessionOrderCompleted ──');
  
  // Update order to link to session3
  await conn.query(`UPDATE orders SET self_order_session_id = ? WHERE id = ?`, [s3.id, orderId]);
  
  const markResult = await selfOrderService.markSessionOrderCompleted(orderId);
  ok(markResult?.markedCompleted === true, `Session marked as order-completed`);
  
  const [[s3After]] = await conn.query(`SELECT order_completed_at FROM self_order_sessions WHERE id = ?`, [s3.id]);
  ok(s3After.order_completed_at !== null, `order_completed_at is set: ${s3After.order_completed_at}`);

  // Cleanup
  await conn.query(`DELETE FROM self_order_sessions WHERE outlet_id = ? AND table_id = ?`, [OUTLET_ID, TABLE_ID]);
  await conn.query(`DELETE FROM orders WHERE id = ?`, [orderId]);
  await conn.end();

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  ✅ Passed: ${pass}   │   ❌ Failed: ${fail}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (fail > 0) {
    console.log('❌ Some tests failed!\n');
    process.exit(1);
  } else {
    console.log('✅ All smart session expiry tests passed!\n');
    process.exit(0);
  }

})().catch(e => {
  console.error('ERROR:', e);
  process.exit(1);
});
