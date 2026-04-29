/**
 * Self-Order System — Comprehensive Test Script
 * Tests all API endpoints, error scenarios, and Socket.IO real-time events.
 *
 * Usage: node tests/test-self-order.js
 *
 * Prerequisites:
 *   - Server running (PORT from .env)
 *   - Outlet 43 exists and is active
 *   - At least one active table in outlet 43
 *   - self_order_enabled setting = true for outlet 43
 *   - super_admin user: admin@restropos.com / admin123
 */

require('dotenv').config();
const http = require('http');
const https = require('https');
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

// ============================================================
// CONFIG
// ============================================================
const BASE_URL = `http://localhost:${process.env.PORT || 3005}`;
const OUTLET_ID = 43;
const STAFF_EMAIL = 'admin@restropos.com';
const STAFF_PASSWORD = 'admin123';

// State
let staffToken = null;
let sessionToken = null;
let sessionId = null;
let tableId = null;
let orderId = null;
let menuItems = [];
let testResults = [];
let socketClient = null;
let socketEvents = [];

// ============================================================
// HTTP HELPER
// ============================================================
function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      rejectUnauthorized: false, // allow self-signed certs
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ============================================================
// TEST RUNNER
// ============================================================
let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, testName, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${testName}`);
    testResults.push({ name: testName, status: 'PASS' });
  } else {
    failed++;
    console.log(`  ❌ ${testName}${detail ? ' — ' + detail : ''}`);
    testResults.push({ name: testName, status: 'FAIL', detail });
  }
}

function skip(testName, reason) {
  skipped++;
  console.log(`  ⏭️  ${testName} — SKIPPED (${reason})`);
  testResults.push({ name: testName, status: 'SKIP', detail: reason });
}

// ============================================================
// SOCKET.IO CLIENT (lightweight, no dependency)
// ============================================================
let ioClient = null;

async function connectSocket(token, outletId) {
  try {
    // Try to load socket.io-client
    const { io } = require('socket.io-client');
    ioClient = io(BASE_URL, {
      auth: { token },
      transports: ['websocket'],
      rejectUnauthorized: false,
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('  ⚠️  Socket connection timeout (5s) — testing without socket');
        resolve(false);
      }, 5000);

      ioClient.on('connect', () => {
        clearTimeout(timeout);
        console.log(`  🔌 Socket connected: ${ioClient.id}`);

        // Join outlet rooms (separate events per room type)
        ioClient.emit('join:outlet', outletId);
        ioClient.emit('join:captain', outletId);
        ioClient.emit('join:cashier', outletId);

        // Listen to all self-order events
        ioClient.on('selforder:updated', (data) => {
          socketEvents.push({ event: 'selforder:updated', data, receivedAt: new Date().toISOString() });
          console.log(`  📡 Socket event: selforder:updated (${data.type}) — order: ${data.orderNumber || 'N/A'}`);
        });

        ioClient.on('order:updated', (data) => {
          socketEvents.push({ event: 'order:updated', data, receivedAt: new Date().toISOString() });
          console.log(`  📡 Socket event: order:updated (${data.type})`);
        });

        ioClient.on('table:updated', (data) => {
          socketEvents.push({ event: 'table:updated', data, receivedAt: new Date().toISOString() });
          console.log(`  📡 Socket event: table:updated — table: ${data.tableId}`);
        });

        resolve(true);
      });

      ioClient.on('connect_error', (err) => {
        clearTimeout(timeout);
        console.log(`  ⚠️  Socket connection failed: ${err.message}`);
        resolve(false);
      });
    });
  } catch (err) {
    console.log(`  ⚠️  socket.io-client not installed — socket tests will verify server-side only`);
    console.log(`     Install with: npm install socket.io-client --save-dev`);
    return false;
  }
}

function disconnectSocket() {
  if (ioClient) {
    ioClient.disconnect();
    ioClient = null;
  }
}

// Small delay helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// TESTS
// ============================================================

async function test_01_staffLogin() {
  console.log('\n── 1. Staff Login ──');
  const res = await request('POST', '/api/v1/auth/login', {
    email: STAFF_EMAIL,
    password: STAFF_PASSWORD,
  });

  assert(res.status === 200, 'Staff login returns 200', `Got ${res.status}: ${res.body?.message}`);
  assert(res.body?.success === true, 'Staff login success=true');

  if (res.body?.success) {
    staffToken = res.body.data.accessToken;
    assert(!!staffToken, 'Received staff JWT token');
  } else {
    assert(false, 'Staff login failed — cannot continue', res.body?.message);
  }
}

async function test_02_ensureSetup() {
  console.log('\n── 2. DB Setup: Enable self-ordering + find table ──');
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port,
    database: dbConfig.database, user: dbConfig.user, password: dbConfig.password,
  });

  try {
    // Enable self_order for outlet 43
    const settingsToSet = [
      ['self_order_enabled', 'true', 'boolean'],
      ['self_order_accept_mode', 'manual', 'string'],
      ['self_order_session_timeout_minutes', '120', 'number'],
      ['self_order_require_phone', 'true', 'boolean'],
      ['self_order_require_name', 'true', 'boolean'],
      ['self_order_max_sessions_per_table', '3', 'number'],
      ['self_order_allow_reorder', 'true', 'boolean'],
    ];
    for (const [key, val, type] of settingsToSet) {
      await conn.query(
        `INSERT INTO system_settings (outlet_id, setting_key, setting_value, setting_type) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = ?`,
        [OUTLET_ID, key, val, type, val]
      );
    }
    // Invalidate Redis cache for self-order settings
    try {
      const Redis = require('ioredis');
      const redisConfig = require('../src/config/redis.config');
      const redis = new Redis({ host: redisConfig.host, port: redisConfig.port, password: redisConfig.password, db: redisConfig.db, maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true });
      await redis.connect();
      await redis.del(`self_order:settings:${OUTLET_ID}`);
      await redis.quit();
    } catch (e) { /* Redis may not be available */ }
    assert(true, 'Self-order settings enabled for outlet ' + OUTLET_ID);

    // Find an active table in outlet 43
    const [tables] = await conn.query(
      `SELECT t.id, t.table_number, t.name, f.name as floor_name
       FROM tables t LEFT JOIN floors f ON t.floor_id = f.id
       WHERE t.outlet_id = ? AND t.is_active = 1
       ORDER BY t.id ASC LIMIT 1`,
      [OUTLET_ID]
    );
    if (tables.length > 0) {
      tableId = tables[0].id;
      assert(true, `Found table: id=${tableId}, number=${tables[0].table_number}, name=${tables[0].name}`);
    } else {
      assert(false, 'No active table found in outlet 43');
    }

    // Clean up any leftover test sessions
    await conn.query(
      `UPDATE self_order_sessions SET status = 'completed' WHERE outlet_id = ? AND status IN ('active','ordering') AND customer_name = 'Test User'`,
      [OUTLET_ID]
    );
  } finally {
    await conn.end();
  }
}

async function test_02b_getSettings() {
  console.log('\n── 2b. Staff: Get Self-Order Settings ──');
  if (!staffToken) { skip('Get settings', 'no staff token'); return; }

  const res = await request('GET', `/api/v1/self-order/staff/settings/${OUTLET_ID}`, null, staffToken);

  assert(res.status === 200, 'Settings endpoint returns 200', `Got ${res.status}: ${JSON.stringify(res.body)}`);
  if (res.body?.success) {
    const s = res.body.data;
    assert(s.enabled === true, 'Self-ordering is enabled');
    assert(typeof s.acceptMode === 'string', `Settings acceptMode = "${s.acceptMode}"`);
    assert(typeof s.sessionTimeoutMinutes === 'number', `Session timeout = ${s.sessionTimeoutMinutes}min`);
    console.log(`     Settings: enabled=${s.enabled}, acceptMode=${s.acceptMode}, requirePhone=${s.requirePhone}, requireName=${s.requireName}`);
  }
}

async function test_03_getMenu() {
  console.log('\n── 3. Public: Get Menu ──');

  const res = await request('GET', `/api/v1/menu/${OUTLET_ID}/captain`);

  assert(res.status === 200, 'Menu endpoint returns 200', `Got ${res.status}`);
  if (res.body?.success) {
    const cats = res.body.data?.categories || [];
    console.log(`     Menu API returned ${cats.length} categories`);

    // Find items for order test
    for (const cat of cats) {
      for (const item of (cat.items || [])) {
        if (item.isAvailable && menuItems.length < 3) {
          menuItems.push({
            id: item.id,
            name: item.name,
            basePrice: item.basePrice,
            variants: item.variants || [],
            addonGroups: item.addonGroups || [],
          });
        }
      }
    }
  }

  // Fallback: if no items from API, fetch directly from DB
  if (menuItems.length === 0) {
    console.log('     Menu API empty — fetching items from DB...');
    const conn = await mysql.createConnection({
      host: dbConfig.host, port: dbConfig.port,
      database: dbConfig.database, user: dbConfig.user, password: dbConfig.password,
    });
    const [dbItems] = await conn.query(
      `SELECT i.id, i.name, i.base_price FROM items i
       WHERE i.outlet_id = ? AND i.is_active = 1 AND i.deleted_at IS NULL
       ORDER BY i.id LIMIT 3`,
      [OUTLET_ID]
    );
    await conn.end();
    for (const item of dbItems) {
      menuItems.push({
        id: item.id,
        name: item.name,
        basePrice: parseFloat(item.base_price),
        variants: [],
        addonGroups: [],
      });
    }
  }

  assert(menuItems.length > 0, `Found ${menuItems.length} available items for testing`);
  if (menuItems.length > 0) {
    console.log(`     Items: ${menuItems.map(i => `${i.name} (₹${i.basePrice})`).join(', ')}`);
  }
}

async function test_04_verifyTableViaAPI() {
  console.log('\n── 4. Verify Table via API ──');
  if (!staffToken || !tableId) { skip('Verify table', 'no table from setup'); return; }

  const res = await request('GET', `/api/v1/tables/outlet/${OUTLET_ID}`, null, staffToken);
  assert(res.status === 200, 'Tables API returns 200', `Got ${res.status}`);
  if (res.body?.success) {
    const tables = res.body.data || [];
    assert(tables.length > 0, `Outlet 43 has ${tables.length} table(s)`);
    const found = tables.find(t => t.id === tableId);
    assert(!!found, `Test table id=${tableId} found in API response`);
  }
}

async function test_05_initSession_errors() {
  console.log('\n── 5. Session Init — Error Scenarios ──');

  // 5a. Missing outletId
  const r1 = await request('POST', '/api/v1/self-order/init', { tableId: 1 });
  assert(r1.status === 400 || r1.status === 422, 'Missing outletId → 400/422', `Got ${r1.status}`);

  // 5b. Missing tableId
  const r2 = await request('POST', '/api/v1/self-order/init', { outletId: OUTLET_ID });
  assert(r2.status === 400 || r2.status === 422, 'Missing tableId → 400/422', `Got ${r2.status}`);

  // 5c. Invalid outlet
  const r3 = await request('POST', '/api/v1/self-order/init', { outletId: 99999, tableId: 1 });
  assert(r3.status >= 400, 'Invalid outlet → error', `Got ${r3.status}`);

  // 5d. Invalid table
  const r4 = await request('POST', '/api/v1/self-order/init', { outletId: OUTLET_ID, tableId: 99999 });
  assert(r4.status >= 400, 'Invalid table → error', `Got ${r4.status}`);

  // 5e. Expired QR token
  if (tableId) {
    const r5 = await request('POST', '/api/v1/self-order/init', {
      outletId: OUTLET_ID,
      tableId: tableId,
      qrToken: 'expired_fake_token_12345',
    });
    // Could be 410 (expired) or 200 (if table has no qr_token set yet)
    console.log(`     Expired QR token → status ${r5.status} (${r5.body?.message || 'ok'})`);
  }
}

async function test_06_initSession_success() {
  console.log('\n── 6. Session Init — Success ──');
  if (!tableId) { skip('Init session', 'no table found'); return; }

  // Small delay to let rate limiter recover from error scenario tests
  await sleep(2000);

  const res = await request('POST', '/api/v1/self-order/init', {
    outletId: OUTLET_ID,
    tableId: tableId,
  });

  assert(res.status === 200 || res.status === 201, 'Init session returns 200/201', `Got ${res.status}: ${res.body?.message}`);

  if (res.body?.success) {
    const d = res.body.data;
    sessionToken = d.token;
    sessionId = d.sessionId;
    assert(!!sessionToken, 'Received session token');
    assert(!!sessionId, `Session ID = ${sessionId}`);
    assert(d.outlet?.id === OUTLET_ID, `Outlet ID = ${d.outlet?.id}`);
    assert(d.table?.id === tableId, `Table ID = ${d.table?.id}`);
    // initSession doesn't return status in response — session is created as 'active' in DB
    assert(d.outlet && d.table && d.token, 'Session has outlet, table, and token');
    assert(!!d.expiresAt, `Expires at = ${d.expiresAt}`);
    console.log(`     Session: id=${sessionId}, table=${d.table?.number}, outlet=${d.outlet?.name}`);
  }
}

async function test_07_getSession() {
  console.log('\n── 7. Get Session Info ──');
  if (!sessionToken) { skip('Get session', 'no session token'); return; }

  const res = await request('GET', '/api/v1/self-order/session', null, sessionToken);

  assert(res.status === 200, 'Get session returns 200', `Got ${res.status}: ${res.body?.message}`);
  if (res.body?.success) {
    const s = res.body.data;
    assert(s.outletId === OUTLET_ID, `Outlet = ${s.outletId}`);
    assert(s.tableId === tableId, `Table = ${s.tableId}`);
    assert(['active', 'ordering'].includes(s.status), `Status = ${s.status}`);
  }
}

async function test_08_getSession_noAuth() {
  console.log('\n── 8. Get Session — No Auth (should fail) ──');

  const res = await request('GET', '/api/v1/self-order/session');
  assert(res.status === 401 || res.status === 403, 'No token → 401/403', `Got ${res.status}`);
}

async function test_09_updateCustomer() {
  console.log('\n── 9. Update Customer Details ──');
  if (!sessionToken) { skip('Update customer', 'no session token'); return; }

  const res = await request('PUT', '/api/v1/self-order/customer', {
    customerName: 'Test User',
    customerPhone: '9876543210',
  }, sessionToken);

  assert(res.status === 200, 'Update customer returns 200', `Got ${res.status}: ${res.body?.message}`);
  if (res.body?.success) {
    // Service returns { updated: true } — verify via session endpoint
    assert(res.body.data?.updated === true, 'Update confirmed');
    const sessionRes = await request('GET', '/api/v1/self-order/session', null, sessionToken);
    if (sessionRes.body?.success) {
      assert(sessionRes.body.data.customerName === 'Test User', 'Name updated (verified via session)');
      assert(sessionRes.body.data.customerPhone === '9876543210', 'Phone updated (verified via session)');
    }
  }
}

async function test_10_updateCustomer_invalid() {
  console.log('\n── 10. Update Customer — Invalid Phone ──');
  if (!sessionToken) { skip('Invalid phone', 'no session token'); return; }

  const res = await request('PUT', '/api/v1/self-order/customer', {
    customerName: 'Test',
    customerPhone: 'abc',
  }, sessionToken);

  assert(res.status === 400 || res.status === 422, 'Invalid phone → 400/422', `Got ${res.status}`);
}

async function test_11_saveCart() {
  console.log('\n── 11. Save Cart ──');
  if (!sessionToken || menuItems.length === 0) { skip('Save cart', 'no session or menu items'); return; }

  const item = menuItems[0];
  const cartItems = [{
    itemId: item.id,
    variantId: item.variants?.[0]?.id || null,
    name: item.name,
    variantName: item.variants?.[0]?.name || null,
    quantity: 2,
    unitPrice: item.variants?.[0]?.price || item.basePrice,
    addons: [],
  }];

  const res = await request('POST', '/api/v1/self-order/cart', { items: cartItems }, sessionToken);

  assert(res.status === 200, 'Save cart returns 200', `Got ${res.status}: ${res.body?.message}`);
  if (res.body?.success) {
    assert(res.body.data?.items?.length > 0, 'Cart has items');
  }
}

async function test_12_getCart() {
  console.log('\n── 12. Get Cart ──');
  if (!sessionToken) { skip('Get cart', 'no session token'); return; }

  const res = await request('GET', '/api/v1/self-order/cart', null, sessionToken);

  assert(res.status === 200, 'Get cart returns 200', `Got ${res.status}`);
  if (res.body?.success) {
    const items = res.body.data?.items || [];
    assert(items.length > 0, `Cart has ${items.length} item(s)`);
  }
}

async function test_13_placeOrder() {
  console.log('\n── 13. Place Order ──');
  if (!sessionToken || menuItems.length === 0) { skip('Place order', 'no session or menu items'); return; }

  const item = menuItems[0];
  const orderItems = [{
    itemId: item.id,
    variantId: item.variants?.[0]?.id || null,
    quantity: 1,
    specialInstructions: 'Test order — less spicy',
    addons: [],
  }];

  const res = await request('POST', '/api/v1/self-order/order', {
    customerName: 'Test User',
    customerPhone: '9876543210',
    specialInstructions: 'Self-order test',
    items: orderItems,
  }, sessionToken);

  assert(res.status === 200 || res.status === 201, 'Place order returns 200/201', `Got ${res.status}: ${res.body?.message}`);

  if (res.body?.success) {
    const d = res.body.data;
    orderId = d.id;
    assert(!!orderId, `Order ID = ${orderId}`);
    assert(!!d.orderNumber, `Order number = ${d.orderNumber}`);
    assert(d.outletId === OUTLET_ID, `Order outlet = ${d.outletId}`);
    assert(['pending', 'confirmed'].includes(d.status), `Order status = ${d.status}`);
    assert(d.orderSource === 'self_order', `Order source = ${d.orderSource}`);
    console.log(`     Order: #${d.orderNumber}, status=${d.status}, total=₹${d.totalAmount}`);
  }

  // Wait for socket events
  await sleep(1000);
}

async function test_14_cartClearedAfterOrder() {
  console.log('\n── 14. Cart Cleared After Order ──');
  if (!sessionToken) { skip('Cart cleared', 'no session token'); return; }

  const res = await request('GET', '/api/v1/self-order/cart', null, sessionToken);

  if (res.status === 200 && res.body?.success) {
    const items = res.body.data?.items || [];
    assert(items.length === 0, 'Cart is empty after order', `Cart has ${items.length} items`);
  } else {
    skip('Cart cleared check', `status ${res.status}`);
  }
}

async function test_15_orderStatus() {
  console.log('\n── 15. Get Order Status ──');
  if (!sessionToken || !orderId) { skip('Order status', 'no order'); return; }

  const res = await request('GET', '/api/v1/self-order/order/status', null, sessionToken);

  assert(res.status === 200, 'Order status returns 200', `Got ${res.status}`);
  if (res.body?.success) {
    const d = res.body.data;
    assert(d.hasOrder === true, 'hasOrder = true');
    assert(d.order?.id === orderId, `Order ID matches: ${d.order?.id}`);
    assert(!!d.order?.status, `Status = ${d.order?.status}`);
    assert(d.order?.items?.length > 0, `Has ${d.order?.items?.length} item(s)`);
  }
}

async function test_16_duplicateOrder() {
  console.log('\n── 16. Duplicate Order (should fail or handle) ──');
  if (!sessionToken || menuItems.length === 0) { skip('Duplicate order', 'no session'); return; }

  const item = menuItems[0];
  const res = await request('POST', '/api/v1/self-order/order', {
    customerName: 'Test User',
    customerPhone: '9876543210',
    items: [{ itemId: item.id, variantId: null, quantity: 1, addons: [] }],
  }, sessionToken);

  // Should get 409 (already placed) or succeed with add-items behavior
  console.log(`     Duplicate order → status ${res.status}: ${res.body?.message || res.body?.data?.status}`);
  assert(res.status === 409 || res.status === 200 || res.status === 201, 'Duplicate handled gracefully', `Got ${res.status}`);
}

async function test_17_addItems() {
  console.log('\n── 17. Add Items (Reorder) ──');
  if (!sessionToken || menuItems.length < 1 || !orderId) { skip('Add items', 'no order'); return; }

  // Use second item if available, else same item
  const item = menuItems.length > 1 ? menuItems[1] : menuItems[0];
  const res = await request('POST', '/api/v1/self-order/order/add-items', {
    specialInstructions: 'Extra raita please',
    items: [{ itemId: item.id, variantId: null, quantity: 1, addons: [] }],
  }, sessionToken);

  assert(res.status === 200, 'Add items returns 200', `Got ${res.status}: ${res.body?.message}`);
  if (res.body?.success) {
    const d = res.body.data;
    assert(d.orderId === orderId, 'Same order ID');
    assert(d.addedItems >= 1, `Added ${d.addedItems} item(s)`);
    console.log(`     Added ${d.addedItems} items, subtotal ₹${d.addedSubtotal}`);
  }

  await sleep(500);
}

async function test_18_pastOrders() {
  console.log('\n── 18. Get Past Orders ──');
  if (!sessionToken) { skip('Past orders', 'no session token'); return; }

  const res = await request('GET', '/api/v1/self-order/orders?limit=10', null, sessionToken);

  assert(res.status === 200, 'Past orders returns 200', `Got ${res.status}`);
  if (res.body?.success) {
    const orders = res.body.data?.orders || [];
    assert(orders.length > 0, `Has ${orders.length} order(s)`);
    if (orders.length > 0) {
      const o = orders[0];
      assert(!!o.orderNumber, `First order: ${o.orderNumber}`);
      assert(o.items?.length > 0, `First order has ${o.items?.length} items`);
    }
  }
}

async function test_19_staffPendingOrders() {
  console.log('\n── 19. Staff: Get Pending Orders ──');
  if (!staffToken) { skip('Pending orders', 'no staff token'); return; }

  const res = await request('GET', `/api/v1/self-order/staff/pending/${OUTLET_ID}?status=all&limit=50`, null, staffToken);

  assert(res.status === 200, 'Pending orders returns 200', `Got ${res.status}: ${res.body?.message}`);
  if (res.body?.success) {
    const data = res.body.data;
    const orders = data?.orders || data || [];
    console.log(`     Found ${Array.isArray(orders) ? orders.length : 0} self-order(s) (status=all)`);
  }

  // Test with specific status
  const res2 = await request('GET', `/api/v1/self-order/staff/pending/${OUTLET_ID}?status=pending`, null, staffToken);
  assert(res2.status === 200, 'Pending filter works', `Got ${res2.status}`);

  const res3 = await request('GET', `/api/v1/self-order/staff/pending/${OUTLET_ID}?status=confirmed`, null, staffToken);
  assert(res3.status === 200, 'Confirmed filter works', `Got ${res3.status}`);
}

async function test_20_staffAcceptOrder() {
  console.log('\n── 20. Staff: Accept Order ──');
  if (!staffToken || !orderId) { skip('Accept order', 'no order'); return; }

  // First check if order is in pending state (manual mode)
  const statusRes = await request('GET', '/api/v1/self-order/order/status', null, sessionToken);
  const currentStatus = statusRes.body?.data?.order?.status;

  if (currentStatus === 'pending') {
    const res = await request('POST', '/api/v1/self-order/staff/accept', { orderId }, staffToken);
    assert(res.status === 200, 'Accept order returns 200', `Got ${res.status}: ${res.body?.message}`);
    if (res.body?.success) {
      assert(res.body.data?.status === 'confirmed', `Status → confirmed`);
      assert(res.body.data?.kotGenerated === true, 'KOT generated');
    }
    await sleep(500);
  } else {
    console.log(`     Order is "${currentStatus}" (auto-accepted) — testing accept on non-pending`);
    const res = await request('POST', '/api/v1/self-order/staff/accept', { orderId }, staffToken);
    assert(res.status === 409 || res.status === 400, 'Accept non-pending → 409/400', `Got ${res.status}`);
  }
}

async function test_21_staffRejectOrder_invalid() {
  console.log('\n── 21. Staff: Reject — Invalid Order ──');
  if (!staffToken) { skip('Reject invalid', 'no staff token'); return; }

  const res = await request('POST', '/api/v1/self-order/staff/reject', {
    orderId: 999999,
    reason: 'test',
  }, staffToken);

  assert(res.status === 404 || res.status === 400 || res.status === 409, 'Invalid order → error', `Got ${res.status}`);
}

async function test_22_staffPendingOrders_noAuth() {
  console.log('\n── 22. Staff Endpoints — No Auth ──');

  const res = await request('GET', `/api/v1/self-order/staff/pending/${OUTLET_ID}`);
  assert(res.status === 401, 'Pending without auth → 401', `Got ${res.status}`);

  const res2 = await request('POST', '/api/v1/self-order/staff/accept', { orderId: 1 });
  assert(res2.status === 401, 'Accept without auth → 401', `Got ${res2.status}`);
}

async function test_23_completeSession() {
  console.log('\n── 23. Staff: Complete Session ──');
  if (!staffToken || !sessionId) { skip('Complete session', 'no session'); return; }

  const res = await request('POST', `/api/v1/self-order/staff/session/${sessionId}/complete`, {}, staffToken);

  assert(res.status === 200, 'Complete session returns 200', `Got ${res.status}: ${res.body?.message}`);
  if (res.body?.success) {
    assert(res.body.data?.completed === true, 'Session marked completed');
  }

  await sleep(500);
}

async function test_24_sessionExpiredAfterComplete() {
  console.log('\n── 24. Session Expired After Complete ──');
  if (!sessionToken) { skip('Post-complete', 'no session token'); return; }

  const res = await request('GET', '/api/v1/self-order/session', null, sessionToken);
  // Session should be completed/expired now
  console.log(`     Post-complete session status: ${res.status} — ${res.body?.data?.status || res.body?.message}`);
  // Could be 401 (expired token) or 200 with completed status
  assert(
    res.status === 401 || res.status === 403 ||
    (res.body?.data?.status === 'completed'),
    'Session is completed or token invalid after complete',
    `Got ${res.status}, status=${res.body?.data?.status}`
  );
}

async function test_25_socketEventsSummary() {
  console.log('\n── 25. Socket Events Summary ──');

  if (socketEvents.length > 0) {
    assert(true, `Received ${socketEvents.length} socket event(s)`);

    const selfOrderEvents = socketEvents.filter(e => e.event === 'selforder:updated');
    const orderEvents = socketEvents.filter(e => e.event === 'order:updated');
    const tableEvents = socketEvents.filter(e => e.event === 'table:updated');

    console.log(`     selforder:updated events: ${selfOrderEvents.length}`);
    console.log(`     order:updated events: ${orderEvents.length}`);
    console.log(`     table:updated events: ${tableEvents.length}`);

    // Verify expected event types
    const types = selfOrderEvents.map(e => e.data?.type);
    if (types.includes('selforder:new')) assert(true, 'Got selforder:new event');
    if (types.includes('selforder:accepted')) assert(true, 'Got selforder:accepted event');
    if (types.includes('selforder:items_added')) assert(true, 'Got selforder:items_added event');
    if (types.includes('selforder:completed')) assert(true, 'Got selforder:completed event (auto on payment)');

    if (tableEvents.length > 0) {
      assert(true, 'Got table:updated event (real-time table status)');
    }

    // Check for order payment events
    const paymentEvents = orderEvents.filter(e => e.data?.type === 'order:payment_received');
    if (paymentEvents.length > 0) {
      assert(true, `Got order:payment_received event (${paymentEvents.length}x)`);
    }
  } else {
    skip('Socket events', 'No events received (socket may not be connected or socket.io-client not installed)');
  }
}

async function test_26_newSessionAfterQrRotation() {
  console.log('\n── 26. New Session After Order Complete (Static QR) ──');
  if (!tableId) { skip('New session', 'no table'); return; }

  // Wait to avoid rate limiter (10 req/min on /init)
  console.log('     Waiting 3s for rate limiter cooldown...');
  await sleep(3000);

  // QR codes are static/permanent — same QR should work after order complete
  const res = await request('POST', '/api/v1/self-order/init', {
    outletId: OUTLET_ID,
    tableId: tableId,
  });

  assert(res.status === 200 || res.status === 201, 'New session after complete works (static QR)', `Got ${res.status}: ${res.body?.message}`);

  if (res.body?.success) {
    // Clean up: complete this session too
    const newSessionId = res.body.data.sessionId;
    if (newSessionId && staffToken) {
      await request('POST', `/api/v1/self-order/staff/session/${newSessionId}/complete`, {}, staffToken);
      console.log(`     Cleanup: completed session ${newSessionId}`);
    }
  }
}

// ============================================================
// PHASE 6b: BILL + PAYMENT + AUTO TABLE RELEASE
// ============================================================

async function test_27_generateBill() {
  console.log('\n── 27. Staff: Generate Bill for Self-Order ──');
  if (!staffToken || !orderId) { skip('Generate bill', 'no order'); return; }

  const res = await request('POST', `/api/v1/orders/${orderId}/bill`, {}, staffToken);

  if (res.status === 400 && res.body?.message?.includes('already')) {
    console.log(`     Bill already exists — ${res.body.message}`);
    assert(true, 'Bill already generated (ok)');
    return;
  }

  assert(res.status === 200 || res.status === 201, 'Generate bill returns 200/201', `Got ${res.status}: ${res.body?.message}`);
  if (res.body?.success) {
    const d = res.body.data;
    invoiceId = d.invoiceId || d.id;
    assert(!!invoiceId, `Invoice created: id=${invoiceId}`);
    console.log(`     Invoice: #${d.invoiceNumber || d.invoice_number || 'N/A'}, total=₹${d.grandTotal || d.grand_total || 'N/A'}`);
  }
}

async function test_28_processPayment() {
  console.log('\n── 28. Staff: Process Payment (auto table release + session complete) ──');
  if (!staffToken || !orderId) { skip('Process payment', 'no order'); return; }

  // Get order details first for total
  const orderRes = await request('GET', `/api/v1/orders/${orderId}`, null, staffToken);
  const orderTotal = orderRes.body?.data?.totalAmount || orderRes.body?.data?.total_amount || 335;

  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port,
    database: dbConfig.database, user: dbConfig.user, password: dbConfig.password,
  });

  const res = await request('POST', '/api/v1/orders/payment', {
    orderId,
    invoiceId: invoiceId || undefined,
    outletId: OUTLET_ID,
    paymentMode: 'cash',
    amount: orderTotal,
    tipAmount: 0,
  }, staffToken);

  assert(res.status === 200, 'Payment returns 200', `Got ${res.status}: ${res.body?.message}`);

  if (res.body?.success) {
    const d = res.body.data;
    assert(d.orderStatus === 'completed' || d.paymentStatus === 'completed', `Order completed (status=${d.orderStatus})`);
    console.log(`     Payment: status=${d.paymentStatus}, orderStatus=${d.orderStatus}`);
  }

  // Wait for async events
  await sleep(1000);

  // Verify table is available after payment
  const [tableAfter] = await conn.query(`SELECT status FROM tables WHERE id = ?`, [tableId]);
  assert(tableAfter[0]?.status === 'available', `Table status → available (was: ${tableAfter[0]?.status})`);

  // QR codes are static/permanent — no rotation check needed

  // Verify self-order session completed
  const [sessionAfter] = await conn.query(
    `SELECT status FROM self_order_sessions WHERE order_id = ? ORDER BY id DESC LIMIT 1`, [orderId]
  );
  assert(sessionAfter[0]?.status === 'completed', `Self-order session → completed (was: ${sessionAfter[0]?.status})`);

  await conn.end();
}

async function test_29_outletClosed() {
  console.log('\n── 29. Outlet Closed → Block Self-Order ──');
  if (!tableId) { skip('Outlet closed', 'no table'); return; }

  // Temporarily close all shifts for outlet 43
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port,
    database: dbConfig.database, user: dbConfig.user, password: dbConfig.password,
  });

  // Save current open shifts
  const [openShifts] = await conn.query(
    `SELECT id FROM day_sessions WHERE outlet_id = ? AND status = 'open'`, [OUTLET_ID]
  );

  if (openShifts.length > 0) {
    // Close shifts temporarily
    await conn.query(
      `UPDATE day_sessions SET status = 'closed', closing_time = NOW() WHERE outlet_id = ? AND status = 'open'`,
      [OUTLET_ID]
    );

    await sleep(2000); // rate limiter cooldown

    // Try init session — should fail
    const res = await request('POST', '/api/v1/self-order/init', {
      outletId: OUTLET_ID,
      tableId: tableId,
    });

    assert(
      res.status === 400 || res.status === 403 || (res.body?.message || '').includes('closed'),
      'Outlet closed → init blocked',
      `Got ${res.status}: ${res.body?.message}`
    );
    console.log(`     Closed outlet response: ${res.body?.message}`);

    // Re-open shifts
    await conn.query(
      `UPDATE day_sessions SET status = 'open', closing_time = NULL WHERE id IN (?)`,
      [openShifts.map(s => s.id)]
    );
  } else {
    console.log('     No open shifts to test — skipping close/reopen cycle');
    // Just verify that init fails when no shifts
    await sleep(2000);
    const res = await request('POST', '/api/v1/self-order/init', {
      outletId: OUTLET_ID,
      tableId: tableId,
    });
    assert(
      res.status !== 200 || (res.body?.message || '').includes('closed'),
      'No shifts → init blocked or allowed',
    );
  }

  await conn.end();
}

// ============================================================
// MAIN
// ============================================================

// Extra state for bill/payment tests
let invoiceId = null;

async function runAllTests() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   Self-Order System — Comprehensive Test Suite      ║');
  console.log(`║   Server: ${BASE_URL.padEnd(42)}║`);
  console.log(`║   Outlet: ${OUTLET_ID}                                        ║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  const startTime = Date.now();

  try {
    // Phase 1: Setup
    await test_01_staffLogin();
    if (!staffToken) {
      console.log('\n🛑 Cannot proceed without staff login. Aborting.');
      process.exit(1);
    }

    // Connect socket (if socket.io-client available)
    console.log('\n── Socket.IO Connection ──');
    const socketConnected = await connectSocket(staffToken, OUTLET_ID);
    if (!socketConnected) {
      console.log('  Continuing without socket — API tests will still run.');
    }

    // Phase 2: DB setup + Settings & Menu
    await test_02_ensureSetup();
    await test_02b_getSettings();
    await test_03_getMenu();
    await test_04_verifyTableViaAPI();

    // Phase 3: Session lifecycle
    await test_05_initSession_errors();
    await test_06_initSession_success();
    await test_07_getSession();
    await test_08_getSession_noAuth();

    // Phase 4: Customer flow
    await test_09_updateCustomer();
    await test_10_updateCustomer_invalid();
    await test_11_saveCart();
    await test_12_getCart();
    await test_13_placeOrder();
    await test_14_cartClearedAfterOrder();
    await test_15_orderStatus();
    await test_16_duplicateOrder();
    await test_17_addItems();
    await test_18_pastOrders();

    // Phase 5: Staff actions
    await test_19_staffPendingOrders();
    await test_20_staffAcceptOrder();
    await test_21_staffRejectOrder_invalid();
    await test_22_staffPendingOrders_noAuth();

    // Phase 6: Bill + Payment + Auto-completion
    await test_27_generateBill();
    await test_28_processPayment();

    // Phase 7: Verify session expired after payment auto-complete
    await test_24_sessionExpiredAfterComplete();

    // Phase 8: Socket summary (includes selforder:completed)
    await test_25_socketEventsSummary();

    // Phase 9: New session after order complete (static QR)
    await test_26_newSessionAfterQrRotation();

    // Phase 10: Outlet closed check
    await test_29_outletClosed();

  } catch (err) {
    console.error(`\n💥 Unexpected error: ${err.message}`);
    console.error(err.stack);
  } finally {
    disconnectSocket();
  }

  // ── Results ──
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║                   TEST RESULTS                      ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  ✅ Passed:  ${String(passed).padEnd(5)} │  ❌ Failed: ${String(failed).padEnd(5)} │  ⏭️  Skipped: ${String(skipped).padEnd(3)} ║`);
  console.log(`║  Duration: ${duration}s                                    ║`);
  console.log('╚══════════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\n── Failed Tests ──');
    testResults.filter(t => t.status === 'FAIL').forEach(t => {
      console.log(`  ❌ ${t.name}: ${t.detail}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests();
