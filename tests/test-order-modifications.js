/**
 * Self-Order Modification Tests — cancel, update qty, remove item, table conflict
 * Usage: node tests/test-order-modifications.js
 */
require('dotenv').config();
const http = require('http');
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

const PORT = process.env.PORT || 3005;
const TABLE_ID = 67;
const OUTLET_ID = 43;

// X-Forwarded-For spoofing to bypass per-IP rate limits in tests
let ipCounter = 0;
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.99.${Math.floor(ipCounter/256)}.${ipCounter % 256}` };
    ipCounter++;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ hostname: 'localhost', port: PORT, path, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

async function run() {
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port,
    database: dbConfig.database, user: dbConfig.user, password: dbConfig.password,
  });

  // Cleanup
  await conn.query('UPDATE tables SET status=? WHERE id=?', ['available', TABLE_ID]);
  await conn.query('UPDATE table_sessions SET status=?,ended_at=NOW() WHERE table_id=? AND status=?', ['completed', TABLE_ID, 'active']);
  await conn.query('UPDATE self_order_sessions SET status=?,updated_at=NOW() WHERE table_id=? AND status IN (?,?)', ['completed', TABLE_ID, 'active', 'ordering']);
  await conn.query('UPDATE orders SET status=? WHERE table_id=? AND status NOT IN (?,?,?)', ['cancelled', TABLE_ID, 'paid', 'completed', 'cancelled']);

  const login = await request('POST', '/api/v1/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  const jwt = login.body.data.accessToken;
  const [[item1]] = await conn.query('SELECT id FROM items WHERE outlet_id=? AND is_active=1 AND deleted_at IS NULL LIMIT 1', [OUTLET_ID]);
  const [[item2]] = await conn.query('SELECT id FROM items WHERE outlet_id=? AND is_active=1 AND deleted_at IS NULL AND id != ? LIMIT 1', [OUTLET_ID, item1.id]);

  // ============================================================
  // TEST 1: Customer cancel before preparation
  // ============================================================
  console.log('\n=== TEST 1: Customer Cancel Order ===');
  
  const init1 = await request('POST', '/api/v1/self-order/init', { outletId: OUTLET_ID, tableId: TABLE_ID });
  assert(init1.body.success, 'Init session');
  const t1 = init1.body.data.token;
  
  await request('PUT', '/api/v1/self-order/customer', { customerName: 'CancelTest', customerPhone: '9876543210' }, t1);
  
  const order1 = await request('POST', '/api/v1/self-order/order', { items: [{ itemId: item1.id, quantity: 2 }, { itemId: item2.id, quantity: 1 }] }, t1);
  assert(order1.body.success, `Order placed: ${order1.body.data?.orderNumber}`);
  const orderId1 = order1.body.data?.id;
  
  // Cancel (order is pending — should work)
  const cancel1 = await request('POST', '/api/v1/self-order/order/cancel', { reason: 'Changed my mind' }, t1);
  assert(cancel1.body.success, 'Cancel pending order');
  assert(cancel1.body.data?.status === 'cancelled', `Status = cancelled`);
  
  // Session should be reset — can place new order
  const order1b = await request('POST', '/api/v1/self-order/order', { items: [{ itemId: item1.id, quantity: 1 }] }, t1);
  assert(order1b.body.success, 'New order after cancel');

  // Cleanup
  const cancel1b = await request('POST', '/api/v1/self-order/order/cancel', {}, t1);
  assert(cancel1b.body.success, 'Cleanup cancel');

  await sleep(1000);

  // ============================================================
  // TEST 2: Cancel after accept (still before preparation)
  // ============================================================
  console.log('\n=== TEST 2: Cancel After Accept (confirmed) ===');
  
  const order2 = await request('POST', '/api/v1/self-order/order', { items: [{ itemId: item1.id, quantity: 1 }] }, t1);
  assert(order2.body.success, `Order placed: ${order2.body.data?.orderNumber}`);
  
  const acc2 = await request('POST', '/api/v1/self-order/staff/accept', { orderId: order2.body.data?.id }, jwt);
  assert(acc2.body.data?.status === 'confirmed', 'Accepted');
  
  const cancel2 = await request('POST', '/api/v1/self-order/order/cancel', { reason: 'Wrong items' }, t1);
  if (!cancel2.body.success) console.log('  DEBUG cancel2:', cancel2.status, cancel2.body.message);
  assert(cancel2.body.success, 'Cancel confirmed order (before preparation)');

  await sleep(1000);

  // ============================================================
  // TEST 3: Cancel after preparation starts (should fail)
  // ============================================================
  console.log('\n=== TEST 3: Cancel After Preparation (blocked) ===');
  
  await sleep(1000);
  const order3 = await request('POST', '/api/v1/self-order/order', { items: [{ itemId: item1.id, quantity: 1 }] }, t1);
  if (!order3.body.success) console.log('  DEBUG order3:', order3.status, order3.body.message);
  assert(order3.body.success, `Order placed`);
  const orderId3 = order3.body.data?.id;
  
  // Accept + simulate preparation
  await request('POST', '/api/v1/self-order/staff/accept', { orderId: orderId3 }, jwt);
  await conn.query('UPDATE orders SET status=? WHERE id=?', ['preparing', orderId3]);
  
  const cancel3 = await request('POST', '/api/v1/self-order/order/cancel', {}, t1);
  assert(!cancel3.body.success, 'Cancel blocked when preparing');
  assert(cancel3.body.message.includes('already being prepared'), `Correct message: ${cancel3.body.message.substring(0, 60)}`);

  // Cleanup
  await conn.query('UPDATE orders SET status=? WHERE id=?', ['cancelled', orderId3]);
  await conn.query('UPDATE self_order_sessions SET status=?,order_id=NULL WHERE token=?', ['active', t1]);

  // ============================================================
  // TEST 4: Update item quantity
  // ============================================================
  console.log('\n=== TEST 4: Update Item Quantity ===');
  
  await sleep(1000);
  const order4 = await request('POST', '/api/v1/self-order/order', { items: [{ itemId: item1.id, quantity: 2 }, { itemId: item2.id, quantity: 1 }] }, t1);
  assert(order4.body.success, `Order placed`);
  
  // Get items
  const status4 = await request('GET', '/api/v1/self-order/order/status', null, t1);
  const items4 = (status4.body.data?.order?.items || []).filter(i => i.status !== 'cancelled');
  assert(items4.length >= 2, `Has ${items4.length} items`);
  if (items4.length < 2) { console.log('  SKIP: not enough items'); await conn.end(); process.exit(1); }
  
  const firstItem = items4[0];
  
  // Update quantity from 2 → 3
  const update4 = await request('PUT', `/api/v1/self-order/order/item/${firstItem.id}`, { quantity: 3 }, t1);
  assert(update4.body.success, `Quantity updated to 3`);
  
  // Verify
  const status4b = await request('GET', '/api/v1/self-order/order/status', null, t1);
  const updatedItem = status4b.body.data?.order?.items?.find(i => i.id === firstItem.id);
  assert(updatedItem?.quantity === 3, `Verified quantity = ${updatedItem?.quantity}`);

  // ============================================================
  // TEST 5: Remove item
  // ============================================================
  console.log('\n=== TEST 5: Remove Item ===');
  
  const secondItem = items4[1];
  const remove5 = await request('DELETE', `/api/v1/self-order/order/item/${secondItem.id}`, null, t1);
  assert(remove5.body.success, `Item removed: ${remove5.body.data?.removedItem}`);
  
  // Verify
  const status5 = await request('GET', '/api/v1/self-order/order/status', null, t1);
  const activeItems5 = status5.body.data?.order?.items?.filter(i => i.status !== 'cancelled');
  assert(activeItems5?.length === 1, `Only 1 active item left`);

  // ============================================================
  // TEST 6: Cannot remove last item
  // ============================================================
  console.log('\n=== TEST 6: Cannot Remove Last Item ===');
  
  const lastItem = activeItems5[0];
  const remove6 = await request('DELETE', `/api/v1/self-order/order/item/${lastItem.id}`, null, t1);
  assert(!remove6.body.success, 'Remove last item blocked');
  assert(remove6.body.message.includes('last item'), `Correct message`);

  // Cleanup order
  await request('POST', '/api/v1/self-order/order/cancel', {}, t1);

  await sleep(1000);

  // ============================================================
  // TEST 7: Table conflict — Staff order blocks self-order
  // ============================================================
  console.log('\n=== TEST 7: Staff Order Blocks Self-Order ===');
  
  // Clean table state first
  await conn.query('UPDATE self_order_sessions SET status=? WHERE token=?', ['completed', t1]);
  await conn.query('UPDATE tables SET status=? WHERE id=?', ['available', TABLE_ID]);
  
  // Create POS order
  const posOrder = await request('POST', '/api/v1/orders', {
    outletId: OUTLET_ID, tableId: TABLE_ID, orderType: 'dine_in', guestCount: 2,
    items: [{ itemId: item1.id, quantity: 1 }]
  }, jwt);
  assert(posOrder.body.success || posOrder.body.data?.id, 'POS order created');
  
  const init7 = await request('POST', '/api/v1/self-order/init', { outletId: OUTLET_ID, tableId: TABLE_ID });
  assert(!init7.body.success, 'Self-order blocked');
  assert(init7.body.message.includes('managed by staff'), `Message: "${init7.body.message.substring(0, 50)}"`);
  
  // Cleanup POS order
  if (posOrder.body.data?.id) {
    await conn.query('UPDATE orders SET status=? WHERE id=?', ['cancelled', posOrder.body.data.id]);
    await conn.query('UPDATE tables SET status=? WHERE id=?', ['available', TABLE_ID]);
    await conn.query('UPDATE table_sessions SET status=?,ended_at=NOW() WHERE table_id=? AND status=?', ['completed', TABLE_ID, 'active']);
  }

  // ============================================================
  // TEST 8: Self-order running → re-scan resumes session
  // ============================================================
  console.log('\n=== TEST 8: Re-scan Resumes Session ===');
  
  const init8a = await request('POST', '/api/v1/self-order/init', { outletId: OUTLET_ID, tableId: TABLE_ID });
  assert(init8a.body.success, 'First init');
  const t8 = init8a.body.data.token;
  
  await request('PUT', '/api/v1/self-order/customer', { customerName: 'ResumeTest', customerPhone: '9876543211' }, t8);
  
  const order8 = await request('POST', '/api/v1/self-order/order', { items: [{ itemId: item1.id, quantity: 1 }] }, t8);
  assert(order8.body.success, 'Order placed');
  
  // Re-scan (same table, different "device" — init again)
  const init8b = await request('POST', '/api/v1/self-order/init', { outletId: OUTLET_ID, tableId: TABLE_ID });
  assert(init8b.body.success, 'Re-scan succeeds');
  assert(init8b.body.data?.resumed === true, `Session resumed: ${init8b.body.data?.resumed}`);
  assert(init8b.body.data?.sessionId === init8a.body.data?.sessionId, 'Same session ID');

  // Cleanup
  await request('POST', '/api/v1/self-order/order/cancel', {}, t8);
  await conn.query('UPDATE self_order_sessions SET status=? WHERE token=?', ['completed', t8]);

  await conn.end();

  console.log(`\n╔════════════════════════════════════════════════╗`);
  console.log(`║  Order Modification Test Results                ║`);
  console.log(`║  ✅ Passed: ${String(passed).padEnd(4)} │  ❌ Failed: ${String(failed).padEnd(4)}       ║`);
  console.log(`╚════════════════════════════════════════════════╝`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('ERROR:', e); process.exit(1); });
