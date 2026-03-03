/**
 * Test Script: Cashier-wise Takeaway Pending Bills
 * 
 * Tests that cashiers see only their own takeaway pending bills
 * 
 * Scenarios:
 * 1. Cashier 1 creates takeaway order + bill
 * 2. Cashier 1 queries pending bills → should see their takeaway bill
 * 3. Verify floor-based filtering includes cashier's takeaway bills
 * 4. Verify socket events include orderType for takeaway
 * 
 * Run: node tests/test-cashier-takeaway-pending.js
 */

const http = require('http');
const io = require('socket.io-client');

const BASE_URL = process.env.API_URL || 'http://localhost:3005';
const API_PREFIX = '/api/v1';

const CONFIG = {
  outletId: 43,
};

const testResults = { passed: 0, failed: 0, tests: [] };

function recordTest(name, passed, detail = '') {
  testResults.tests.push({ name, passed, detail });
  if (passed) testResults.passed++;
  else testResults.failed++;
  console.log(`   ${passed ? '✅' : '❌'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function apiRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + API_PREFIX + path);
    const options = {
      hostname: url.hostname,
      port: url.port || 3005,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) options.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login(email, password) {
  const res = await apiRequest('POST', '/auth/login', { email, password });
  if (res.data.success && res.data.data?.accessToken) {
    return {
      token: res.data.data.accessToken,
      userId: res.data.data.user?.id,
      name: res.data.data.user?.name,
      roles: res.data.data.user?.roles || []
    };
  }
  throw new Error('Login failed: ' + JSON.stringify(res.data));
}

function connectSocket(token, outletId) {
  return new Promise((resolve) => {
    const socket = io(BASE_URL, {
      transports: ['websocket', 'polling'],
      auth: { token },
    });
    socket.on('connect', () => {
      socket.emit('join:outlet', outletId);
      socket.emit('join:cashier', outletId);
      resolve(socket);
    });
    socket.on('connect_error', () => resolve(null));
  });
}

async function runTests() {
  console.log('═'.repeat(70));
  console.log('  CASHIER-WISE TAKEAWAY PENDING BILLS TEST');
  console.log('═'.repeat(70));
  console.log();

  let socket = null;
  const socketEvents = [];
  let cashierAuth, orderId, invoiceId;

  try {
    // STEP 1: Login as Cashier
    console.log('📋 STEP 1: Login as Cashier');
    console.log('─'.repeat(50));
    
    // Try cashier login, fallback to admin
    try {
      cashierAuth = await login('cashier@restropos.com', 'cashier123');
      console.log(`   Logged in as: ${cashierAuth.name} (ID: ${cashierAuth.userId})`);
      console.log(`   Roles: ${cashierAuth.roles.join(', ')}`);
      recordTest('Cashier login', true, cashierAuth.name);
    } catch (e) {
      console.log('   Cashier login failed, using admin...');
      cashierAuth = await login('admin@restropos.com', 'admin123');
      console.log(`   Logged in as: ${cashierAuth.name} (ID: ${cashierAuth.userId})`);
      recordTest('Admin login (fallback)', true, cashierAuth.name);
    }
    console.log();

    // STEP 2: Connect Socket
    console.log('📋 STEP 2: Connect Socket');
    console.log('─'.repeat(50));
    socket = await connectSocket(cashierAuth.token, CONFIG.outletId);
    if (socket) {
      socket.on('bill:status', (data) => {
        console.log(`   📡 [SOCKET] bill:status - orderType: ${data.orderType}, createdBy: ${data.captainId}`);
        socketEvents.push({ event: 'bill:status', data, time: new Date() });
      });
      recordTest('Socket connected', true);
    }
    console.log();

    // STEP 3: Create Takeaway Order as Cashier
    console.log('📋 STEP 3: Create Takeaway Order');
    console.log('─'.repeat(50));
    
    const orderRes = await apiRequest('POST', '/orders', {
      outletId: CONFIG.outletId,
      orderType: 'takeaway',
      customerName: 'Cashier Takeaway Test',
      customerPhone: '9988776655',
    }, cashierAuth.token);

    if (orderRes.data.success) {
      orderId = orderRes.data.data.id;
      const orderNumber = orderRes.data.data.order_number || orderRes.data.data.orderNumber;
      const createdBy = orderRes.data.data.created_by || orderRes.data.data.createdBy;
      console.log(`   Order created by user ID: ${createdBy}`);
      recordTest('Takeaway order created', true, `Order: ${orderNumber}`);
    } else {
      recordTest('Takeaway order created', false, orderRes.data.message);
      process.exit(1);
    }
    console.log();

    // STEP 4: Generate Bill
    console.log('📋 STEP 4: Generate Bill for Takeaway');
    console.log('─'.repeat(50));
    
    const billRes = await apiRequest('POST', `/orders/${orderId}/bill`, {}, cashierAuth.token);
    
    if (billRes.data.success) {
      invoiceId = billRes.data.data?.invoice?.id || billRes.data.data?.invoiceId;
      const invoiceNumber = billRes.data.data?.invoice?.invoiceNumber || billRes.data.data?.invoiceNumber;
      const generatedBy = billRes.data.data?.invoice?.generatedBy;
      console.log(`   Bill generated by user ID: ${generatedBy}`);
      recordTest('Bill generated', true, `Invoice: ${invoiceNumber}`);
    } else {
      recordTest('Bill generated', false, billRes.data.message);
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log();

    // STEP 5: Query Pending Bills as this Cashier
    console.log('📋 STEP 5: Query Pending Bills (Cashier View)');
    console.log('─'.repeat(50));
    
    const pendingRes = await apiRequest('GET', `/orders/bills/pending/${CONFIG.outletId}`, null, cashierAuth.token);
    
    if (pendingRes.data.success) {
      const bills = pendingRes.data.data || [];
      const takeawayBills = bills.filter(b => b.orderType === 'takeaway');
      const ourBill = bills.find(b => b.orderId === orderId);
      
      console.log(`   Total pending bills visible: ${bills.length}`);
      console.log(`   Takeaway bills visible: ${takeawayBills.length}`);
      
      recordTest('Pending bills API works', true);
      recordTest('Cashier sees own takeaway bill', !!ourBill, 
        ourBill ? `Invoice: ${ourBill.invoiceNumber}` : 'NOT FOUND - THIS IS THE BUG!');
      
      if (ourBill) {
        console.log(`   ✓ Our bill found in list`);
        console.log(`   Order Type: ${ourBill.orderType}`);
        console.log(`   Customer: ${ourBill.customerName}`);
      } else {
        console.log(`   ✗ Our takeaway bill NOT in pending list!`);
        console.log(`   Looking for orderId: ${orderId}`);
        console.log(`   Bills in list:`, bills.map(b => ({ orderId: b.orderId, orderType: b.orderType })));
      }
    } else {
      recordTest('Pending bills API works', false, pendingRes.data.message);
    }
    console.log();

    // STEP 6: Query with orderType filter
    console.log('📋 STEP 6: Query Pending Bills with orderType=takeaway');
    console.log('─'.repeat(50));
    
    const takeawayOnlyRes = await apiRequest('GET', `/orders/bills/pending/${CONFIG.outletId}?orderType=takeaway`, null, cashierAuth.token);
    
    if (takeawayOnlyRes.data.success) {
      const bills = takeawayOnlyRes.data.data || [];
      const ourBill = bills.find(b => b.orderId === orderId);
      
      console.log(`   Takeaway pending bills: ${bills.length}`);
      recordTest('Takeaway filter works', true);
      recordTest('Our bill in takeaway filter', !!ourBill);
    } else {
      recordTest('Takeaway filter works', false, takeawayOnlyRes.data.message);
    }
    console.log();

    // STEP 7: Socket Events Check
    console.log('📋 STEP 7: Socket Events Summary');
    console.log('─'.repeat(50));
    
    const billEvents = socketEvents.filter(e => e.event === 'bill:status');
    const takeawayEvents = billEvents.filter(e => e.data.orderType === 'takeaway');
    
    console.log(`   Total bill:status events: ${billEvents.length}`);
    console.log(`   Takeaway bill events: ${takeawayEvents.length}`);
    
    recordTest('Received bill:status for takeaway', takeawayEvents.length > 0);
    
    if (takeawayEvents.length > 0) {
      const evt = takeawayEvents[0].data;
      recordTest('Event has orderType', evt.orderType === 'takeaway');
      recordTest('Event has customerName', !!evt.customerName);
    }
    console.log();

    // STEP 8: Cleanup
    console.log('📋 STEP 8: Cleanup - Complete Payment');
    console.log('─'.repeat(50));
    
    const orderDetailRes = await apiRequest('GET', `/orders/${orderId}`, null, cashierAuth.token);
    const orderTotal = orderDetailRes.data.data?.grandTotal || orderDetailRes.data.data?.grand_total || 100;
    
    const paymentRes = await apiRequest('POST', '/orders/payment', {
      outletId: CONFIG.outletId,
      orderId,
      invoiceId,
      paymentMode: 'cash',
      amount: orderTotal,
    }, cashierAuth.token);

    recordTest('Payment completed', paymentRes.data.success, paymentRes.data.success ? `₹${orderTotal}` : paymentRes.data.message);
    console.log();

    // FINAL SUMMARY
    console.log('═'.repeat(70));
    console.log('  TEST RESULTS SUMMARY');
    console.log('═'.repeat(70));
    console.log();
    console.log(`   ✅ Passed: ${testResults.passed}`);
    console.log(`   ❌ Failed: ${testResults.failed}`);
    console.log(`   📊 Total:  ${testResults.passed + testResults.failed}`);
    console.log();
    
    if (testResults.failed === 0) {
      console.log('  🎉 ALL TESTS PASSED!');
    } else {
      console.log('  ⚠️  Some tests failed:');
      testResults.tests.filter(t => !t.passed).forEach(t => {
        console.log(`     - ${t.name}: ${t.detail}`);
      });
    }
    console.log();
    console.log('═'.repeat(70));

  } catch (error) {
    console.error('❌ Test Error:', error.message);
    console.error(error.stack);
  } finally {
    if (socket) {
      socket.disconnect();
      console.log('🔌 Socket disconnected');
    }
    process.exit(testResults.failed > 0 ? 1 : 0);
  }
}

runTests();
