/**
 * Test: Device-Based Self-Order Session Control
 * 
 * Scenarios tested:
 * 1. New session creation with deviceId
 * 2. Same device can resume session (refresh/re-scan)
 * 3. Different device is BLOCKED from accessing active session
 * 4. Same device can place order and add items
 * 5. Different device cannot place order or add items
 * 6. After session completes, new device can start fresh
 * 
 * Run: node tests/_verify_device_session_control.js
 */

require('dotenv').config();
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT = 3005;
const OUTLET_ID = 43;
const TABLE_ID = 67;

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'Content-Type': 'application/json', ...headers };
    const d = body ? JSON.stringify(body) : null;
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    
    const r = http.request({ hostname: 'localhost', port: PORT, path, method, headers: h }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ s: res.statusCode, b: JSON.parse(data) }); }
        catch { resolve({ s: res.statusCode, b: data }); }
      });
    });
    r.on('error', reject);
    if (d) r.write(d);
    r.end();
  });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

async function cleanupSessions() {
  // Clean up any existing sessions for the test table
  const mysql = require('mysql2/promise');
  const dbConfig = require('../src/config/database.config');
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port, database: dbConfig.database,
    user: dbConfig.user, password: dbConfig.password
  });
  await conn.query(
    `UPDATE self_order_sessions SET status = 'expired' WHERE table_id = ? AND outlet_id = ?`,
    [TABLE_ID, OUTLET_ID]
  );
  await conn.query(
    `UPDATE orders SET status = 'cancelled' WHERE table_id = ? AND outlet_id = ? AND status NOT IN ('paid', 'completed', 'cancelled')`,
    [TABLE_ID, OUTLET_ID]
  );
  await conn.end();
}

(async () => {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  DEVICE-BASED SELF-ORDER SESSION CONTROL TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Setup: Clean any existing sessions
  console.log('🧹 Cleaning up existing sessions...\n');
  await cleanupSessions();

  // Generate two different device IDs
  const DEVICE_A = uuidv4();
  const DEVICE_B = uuidv4();
  console.log(`📱 Device A: ${DEVICE_A.substring(0, 8)}...`);
  console.log(`📱 Device B: ${DEVICE_B.substring(0, 8)}...\n`);

  let tokenA = null;

  // ═══════════════════════════════════════════════════════════════
  // TEST 1: New session creation with deviceId
  // ═══════════════════════════════════════════════════════════════
  console.log('── TEST 1: New Session Creation ──');
  const init1 = await req('POST', '/api/v1/self-order/init', {
    outletId: OUTLET_ID,
    tableId: TABLE_ID,
    deviceId: DEVICE_A
  });
  ok(init1.s === 200, `Init returns ${init1.s}`);
  ok(init1.b.data?.token, 'Got session token');
  tokenA = init1.b.data?.token;
  console.log(`  Token: ${tokenA?.substring(0, 16)}...`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 2: Same device can resume session (simulate refresh)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 2: Same Device Resume (Refresh) ──');
  const init2 = await req('POST', '/api/v1/self-order/init', {
    outletId: OUTLET_ID,
    tableId: TABLE_ID,
    deviceId: DEVICE_A
  });
  ok(init2.s === 200, `Resume returns ${init2.s}`);
  ok(init2.b.data?.token === tokenA, 'Same token returned (session resumed)');
  ok(init2.b.data?.resumed === true, 'Response indicates resumed=true');

  // ═══════════════════════════════════════════════════════════════
  // TEST 3: Different device is BLOCKED
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 3: Different Device BLOCKED ──');
  const init3 = await req('POST', '/api/v1/self-order/init', {
    outletId: OUTLET_ID,
    tableId: TABLE_ID,
    deviceId: DEVICE_B
  });
  ok(init3.s === 409, `Different device returns ${init3.s} (expected 409)`);
  ok(init3.b.message?.includes('another device'), `Error message mentions "another device"`);
  console.log(`  Message: "${init3.b.message}"`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 4: Same device can access menu
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 4: Same Device Can Access Menu ──');
  const menu = await req('GET', '/api/v1/self-order/menu', null, {
    'Authorization': `Bearer ${tokenA}`,
    'X-Device-Id': DEVICE_A
  });
  ok(menu.s === 200, `Menu access returns ${menu.s}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 5: Different device BLOCKED from menu (with stolen token)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 5: Different Device BLOCKED from Menu ──');
  const menu2 = await req('GET', '/api/v1/self-order/menu', null, {
    'Authorization': `Bearer ${tokenA}`,
    'X-Device-Id': DEVICE_B
  });
  ok(menu2.s === 403, `Different device menu returns ${menu2.s} (expected 403)`);
  ok(menu2.b.code === 'DEVICE_MISMATCH', `Error code is DEVICE_MISMATCH`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 6: Same device can place order
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 6: Same Device Can Place Order ──');
  
  // First get a valid item from menu
  const menuData = menu.b.data;
  let testItemId = null;
  if (menuData?.categories?.length > 0) {
    for (const cat of menuData.categories) {
      if (cat.items?.length > 0) {
        testItemId = cat.items[0].id;
        break;
      }
    }
  }

  if (testItemId) {
    const order = await req('POST', '/api/v1/self-order/order', {
      items: [{ itemId: testItemId, quantity: 1 }]
    }, {
      'Authorization': `Bearer ${tokenA}`,
      'X-Device-Id': DEVICE_A
    });
    ok(order.s === 200 || order.s === 201, `Place order returns ${order.s}`);
    if (order.b.data?.orderId) {
      console.log(`  Order ID: ${order.b.data.orderId}`);
    }
  } else {
    console.log('  ⚠️  No test item found, skipping order test');
  }

  // ═══════════════════════════════════════════════════════════════
  // TEST 7: Different device BLOCKED from placing order
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 7: Different Device BLOCKED from Order ──');
  if (testItemId) {
    const order2 = await req('POST', '/api/v1/self-order/order', {
      items: [{ itemId: testItemId, quantity: 1 }]
    }, {
      'Authorization': `Bearer ${tokenA}`,
      'X-Device-Id': DEVICE_B
    });
    ok(order2.s === 403, `Different device order returns ${order2.s} (expected 403)`);
  } else {
    console.log('  ⚠️  Skipped (no test item)');
  }

  // ═══════════════════════════════════════════════════════════════
  // TEST 8: Same device can add items (reorder)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 8: Same Device Can Add Items ──');
  if (testItemId) {
    const addItems = await req('POST', '/api/v1/self-order/order/add-items', {
      items: [{ itemId: testItemId, quantity: 1 }]
    }, {
      'Authorization': `Bearer ${tokenA}`,
      'X-Device-Id': DEVICE_A
    });
    ok(addItems.s === 200 || addItems.s === 201, `Add items returns ${addItems.s}`);
  } else {
    console.log('  ⚠️  Skipped (no test item)');
  }

  // ═══════════════════════════════════════════════════════════════
  // TEST 9: Different device BLOCKED from adding items
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 9: Different Device BLOCKED from Add Items ──');
  if (testItemId) {
    const addItems2 = await req('POST', '/api/v1/self-order/order/add-items', {
      items: [{ itemId: testItemId, quantity: 1 }]
    }, {
      'Authorization': `Bearer ${tokenA}`,
      'X-Device-Id': DEVICE_B
    });
    ok(addItems2.s === 403, `Different device add items returns ${addItems2.s} (expected 403)`);
  } else {
    console.log('  ⚠️  Skipped (no test item)');
  }

  // ═══════════════════════════════════════════════════════════════
  // TEST 10: After cleanup, new device can start fresh
  // ═══════════════════════════════════════════════════════════════
  console.log('\n── TEST 10: After Cleanup, New Device Can Start ──');
  await cleanupSessions();
  
  const init4 = await req('POST', '/api/v1/self-order/init', {
    outletId: OUTLET_ID,
    tableId: TABLE_ID,
    deviceId: DEVICE_B
  });
  ok(init4.s === 200, `New device after cleanup returns ${init4.s}`);
  ok(init4.b.data?.token, 'Got new session token');

  // Cleanup
  await cleanupSessions();

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
    console.log('✅ All device session control tests passed!\n');
    process.exit(0);
  }

})().catch(e => {
  console.error('ERROR:', e);
  process.exit(1);
});
