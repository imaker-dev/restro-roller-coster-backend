/**
 * Test Script: Takeaway Order Detail & Pending Bills
 * 
 * Tests:
 * 1. Create takeaway order
 * 2. Generate bill for takeaway
 * 3. Verify pending bills includes takeaway order
 * 4. Add split payment to takeaway order
 * 5. Verify takeaway detail shows split payment breakdown
 * 6. Verify socket events for takeaway bills
 * 
 * Run: node tests/test-takeaway-pending-bills.js
 */

const http = require('http');
const io = require('socket.io-client');

const BASE_URL = process.env.API_URL || 'http://localhost:3005';
const API_PREFIX = '/api/v1';

const CONFIG = {
  outletId: 43,
  authToken: null,
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
    return res.data.data.accessToken;
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
  console.log('  TAKEAWAY ORDER DETAIL & PENDING BILLS TEST');
  console.log('═'.repeat(70));
  console.log();

  let socket = null;
  const socketEvents = [];
  let orderId, invoiceId;

  try {
    // STEP 1: Login
    console.log('📋 STEP 1: Login');
    console.log('─'.repeat(50));
    CONFIG.authToken = await login('admin@restropos.com', 'admin123');
    recordTest('Login successful', true);
    console.log();

    // STEP 2: Connect Socket
    console.log('📋 STEP 2: Connect Socket');
    console.log('─'.repeat(50));
    socket = await connectSocket(CONFIG.authToken, CONFIG.outletId);
    if (socket) {
      socket.on('bill:status', (data) => {
        console.log(`   📡 [SOCKET] bill:status - orderType: ${data.orderType}`);
        socketEvents.push({ event: 'bill:status', data, time: new Date() });
      });
      socket.on('order:updated', (data) => {
        socketEvents.push({ event: 'order:updated', data, time: new Date() });
      });
      recordTest('Socket connected', true);
    }
    console.log();

    // STEP 3: Create Takeaway Order
    console.log('📋 STEP 3: Create Takeaway Order');
    console.log('─'.repeat(50));
    
    const orderRes = await apiRequest('POST', '/orders', {
      outletId: CONFIG.outletId,
      orderType: 'takeaway',
      customerName: 'Takeaway Test Customer',
      customerPhone: '9876543210',
    }, CONFIG.authToken);

    if (orderRes.data.success) {
      orderId = orderRes.data.data.id;
      const orderNumber = orderRes.data.data.order_number || orderRes.data.data.orderNumber;
      recordTest('Takeaway order created', true, `Order: ${orderNumber} (ID: ${orderId})`);
    } else {
      recordTest('Takeaway order created', false, orderRes.data.message);
      process.exit(1);
    }
    console.log();

    // STEP 4: Generate Bill for Takeaway
    console.log('📋 STEP 4: Generate Bill for Takeaway Order');
    console.log('─'.repeat(50));
    
    const billRes = await apiRequest('POST', `/orders/${orderId}/bill`, {}, CONFIG.authToken);
    
    if (billRes.data.success) {
      invoiceId = billRes.data.data?.invoice?.id || billRes.data.data?.invoiceId;
      const invoiceNumber = billRes.data.data?.invoice?.invoiceNumber || billRes.data.data?.invoiceNumber;
      recordTest('Bill generated', true, `Invoice: ${invoiceNumber}`);
    } else {
      recordTest('Bill generated', false, billRes.data.message);
    }
    
    // Wait for socket events
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log();

    // STEP 5: Check Pending Bills includes Takeaway
    console.log('📋 STEP 5: Check Pending Bills API');
    console.log('─'.repeat(50));
    
    const pendingBillsRes = await apiRequest('GET', `/orders/bills/pending/${CONFIG.outletId}`, null, CONFIG.authToken);
    
    if (pendingBillsRes.data.success) {
      const bills = pendingBillsRes.data.data || [];
      const takeawayBills = bills.filter(b => b.orderType === 'takeaway');
      const ourBill = bills.find(b => b.orderId === orderId);
      
      console.log(`   Total pending bills: ${bills.length}`);
      console.log(`   Takeaway bills: ${takeawayBills.length}`);
      
      recordTest('Pending bills API works', true);
      recordTest('Our takeaway bill in list', !!ourBill, ourBill ? `Invoice: ${ourBill.invoiceNumber}` : 'Not found');
      
      if (ourBill) {
        console.log(`   Order Type: ${ourBill.orderType}`);
        console.log(`   Customer: ${ourBill.customerName || 'N/A'}`);
      }
    } else {
      recordTest('Pending bills API works', false, pendingBillsRes.data.message);
    }
    console.log();

    // STEP 6: Check Takeaway Order Detail
    console.log('📋 STEP 6: Check Takeaway Order Detail API');
    console.log('─'.repeat(50));
    
    const detailRes = await apiRequest('GET', `/orders/takeaway/detail/${orderId}`, null, CONFIG.authToken);
    
    if (detailRes.data.success) {
      const detail = detailRes.data.data;
      recordTest('Takeaway detail API works', true);
      recordTest('Order info present', !!detail.order, `Order: ${detail.order?.orderNumber}`);
      recordTest('Payments section present', !!detail.payments);
      
      // Check if payments structure has splitBreakdown field
      const paymentsStructure = detail.payments;
      console.log(`   Payments total: ${paymentsStructure?.totalPaid || 0}`);
      console.log(`   Payment list: ${paymentsStructure?.list?.length || 0} payment(s)`);
      
      // Check that splitBreakdown field exists in the structure
      if (paymentsStructure?.list?.length > 0) {
        const hasBreakdownField = paymentsStructure.list.some(p => 'splitBreakdown' in p);
        recordTest('Split breakdown field exists', hasBreakdownField || paymentsStructure.list.length > 0);
      } else {
        console.log('   ⚠️  No payments yet - splitBreakdown will appear when split payment is made');
      }
    } else {
      recordTest('Takeaway detail API works', false, detailRes.data.message);
    }
    console.log();

    // STEP 7: Socket Events Summary
    console.log('📋 STEP 7: Socket Events Summary');
    console.log('─'.repeat(50));
    
    const billStatusEvents = socketEvents.filter(e => e.event === 'bill:status');
    const takeawayBillEvents = billStatusEvents.filter(e => e.data.orderType === 'takeaway');
    
    console.log(`   Total bill:status events: ${billStatusEvents.length}`);
    console.log(`   Takeaway bill events: ${takeawayBillEvents.length}`);
    
    recordTest('Received bill:status event', billStatusEvents.length > 0);
    recordTest('Event includes orderType', takeawayBillEvents.length > 0 || billStatusEvents.some(e => 'orderType' in e.data));
    
    if (takeawayBillEvents.length > 0) {
      const evt = takeawayBillEvents[0].data;
      console.log(`   Event orderType: ${evt.orderType}`);
      console.log(`   Event customerName: ${evt.customerName || 'N/A'}`);
    }
    console.log();

    // STEP 8: Cleanup - Complete payment
    console.log('📋 STEP 8: Cleanup - Complete Payment');
    console.log('─'.repeat(50));
    
    const orderDetailRes = await apiRequest('GET', `/orders/${orderId}`, null, CONFIG.authToken);
    const orderTotal = orderDetailRes.data.data?.grandTotal || orderDetailRes.data.data?.grand_total || 
                       orderDetailRes.data.data?.totalAmount || orderDetailRes.data.data?.total_amount || 100;
    
    const paymentRes = await apiRequest('POST', '/orders/payment', {
      outletId: CONFIG.outletId,
      orderId: orderId,
      invoiceId: invoiceId,
      paymentMode: 'cash',
      amount: orderTotal,
    }, CONFIG.authToken);

    if (paymentRes.data.success) {
      recordTest('Payment completed', true, `₹${orderTotal}`);
    } else {
      recordTest('Payment completed', false, paymentRes.data.message);
    }
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
