/**
 * Static QR Code Test — verifies same QR works for multiple order cycles
 * Usage: node tests/test-static-qr.js
 */
require('dotenv').config();
const http = require('http');
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

const PORT = process.env.PORT || 3005;
const TABLE_ID = 67;
const OUTLET_ID = 43;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
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

async function run() {
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port,
    database: dbConfig.database, user: dbConfig.user, password: dbConfig.password,
  });

  // Cleanup table
  await conn.query('UPDATE tables SET status=? WHERE id=?', ['available', TABLE_ID]);
  await conn.query('UPDATE table_sessions SET status=?,ended_at=NOW() WHERE table_id=? AND status=?', ['completed', TABLE_ID, 'active']);
  await conn.query('UPDATE self_order_sessions SET status=?,updated_at=NOW() WHERE table_id=? AND status IN (?,?)', ['completed', TABLE_ID, 'active', 'ordering']);
  await conn.query('UPDATE orders SET status=? WHERE table_id=? AND status NOT IN (?,?,?)', ['cancelled', TABLE_ID, 'paid', 'completed', 'cancelled']);

  // Staff login
  const login = await request('POST', '/api/v1/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  const jwt = login.body.data.accessToken;

  // Get an item
  const [[item]] = await conn.query('SELECT id FROM items WHERE outlet_id=? AND is_active=1 AND deleted_at IS NULL LIMIT 1', [OUTLET_ID]);

  let passed = 0;
  let failed = 0;
  function assert(cond, msg) {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.log(`  ❌ ${msg}`); failed++; }
  }

  for (let cycle = 1; cycle <= 3; cycle++) {
    console.log(`\n=== CYCLE ${cycle}: Init → Order → Accept → Bill → Pay ===`);

    // Init session (no qrToken — static QR)
    const init = await request('POST', '/api/v1/self-order/init', { outletId: OUTLET_ID, tableId: TABLE_ID });
    assert(init.body.success, `Cycle ${cycle}: Init session OK (id=${init.body.data?.sessionId})`);
    if (!init.body.success) { console.log('  Blocked:', init.body.message); break; }

    const sessionToken = init.body.data.token;

    // Set customer
    await request('PUT', '/api/v1/self-order/customer', { customerName: `Cycle${cycle}`, customerPhone: `999888770${cycle}` }, sessionToken);

    // Place order
    const order = await request('POST', '/api/v1/self-order/order', { items: [{ itemId: item.id, quantity: 1 }] }, sessionToken);
    assert(order.body.success, `Cycle ${cycle}: Order placed (${order.body.data?.orderNumber})`);
    const orderId = order.body.data?.id;

    // Accept
    const acc = await request('POST', '/api/v1/self-order/staff/accept', { orderId }, jwt);
    assert(acc.body.data?.status === 'confirmed', `Cycle ${cycle}: Accepted`);

    // Bill
    const bill = await request('POST', `/api/v1/orders/${orderId}/bill`, {}, jwt);
    assert(bill.body.success, `Cycle ${cycle}: Bill generated`);
    const invoiceId = bill.body.data?.invoiceId || bill.body.data?.id;

    // Pay
    const pay = await request('POST', '/api/v1/orders/payment', {
      orderId, invoiceId, outletId: OUTLET_ID, paymentMode: 'cash',
      amount: bill.body.data?.grandTotal || 350,
    }, jwt);
    assert(pay.body.success, `Cycle ${cycle}: Payment OK`);

    await sleep(500);

    // Verify table is available
    const [[tbl]] = await conn.query('SELECT status FROM tables WHERE id=?', [TABLE_ID]);
    assert(tbl.status === 'available', `Cycle ${cycle}: Table available after payment`);
  }

  // Final: verify QR still works
  console.log('\n=== FINAL: Verify same QR still works ===');
  const finalInit = await request('POST', '/api/v1/self-order/init', { outletId: OUTLET_ID, tableId: TABLE_ID });
  assert(finalInit.body.success, `Final init: OK (session=${finalInit.body.data?.sessionId})`);

  // Cleanup
  if (finalInit.body.data?.sessionId) {
    await conn.query('UPDATE self_order_sessions SET status=? WHERE id=?', ['completed', finalInit.body.data.sessionId]);
  }

  await conn.end();

  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  Static QR Test Results            ║`);
  console.log(`║  ✅ Passed: ${String(passed).padEnd(4)} │  ❌ Failed: ${String(failed).padEnd(4)}║`);
  console.log(`╚════════════════════════════════════╝`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
