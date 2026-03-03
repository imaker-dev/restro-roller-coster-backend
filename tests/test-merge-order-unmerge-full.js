/**
 * Complete Table Merge → Order → Unmerge Test
 * 
 * Full workflow test:
 * 1. Make tables mergeable (if needed)
 * 2. Merge two tables (T1 + T2)
 * 3. Start session on merged table
 * 4. Create order with items
 * 5. Create KOT
 * 6. Try to unmerge - SHOULD FAIL
 * 7. Generate bill
 * 8. Complete payment
 * 9. Verify auto-unmerge
 * 10. Verify KOT served
 * 11. Verify session completed
 * 12. Verify all tables available
 * 13. Verify all socket events
 * 
 * Run: node tests/test-merge-order-unmerge-full.js
 */

const http = require('http');
const io = require('socket.io-client');

const BASE_URL = process.env.API_URL || 'http://localhost:3005';
const API_PREFIX = '/api/v1';

const CONFIG = {
  outletId: 43,
  authToken: null,
};

// Test results tracking
const testResults = {
  passed: 0,
  failed: 0,
  tests: []
};

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
      socket.emit('join:captain', outletId);
      socket.emit('join:cashier', outletId);
      socket.emit('join:kitchen', outletId);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      console.log('   ⚠️  Socket error:', err.message);
      resolve(null);
    });
  });
}

async function runTests() {
  console.log('═'.repeat(70));
  console.log('  COMPLETE MERGE → ORDER → PAYMENT → AUTO-UNMERGE TEST');
  console.log('═'.repeat(70));
  console.log();

  let socket = null;
  const socketEvents = [];
  let primaryTableId, secondaryTableId, orderId, invoiceId, kotId;
  let primaryNumber, secondaryNumber;

  try {
    // ══════════════════════════════════════════════════════════════
    // STEP 1: LOGIN
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 1: Login');
    console.log('─'.repeat(50));
    CONFIG.authToken = await login('admin@restropos.com', 'admin123');
    recordTest('Login successful', true);
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 2: CONNECT SOCKET
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 2: Connect Socket for Real-time Events');
    console.log('─'.repeat(50));
    socket = await connectSocket(CONFIG.authToken, CONFIG.outletId);
    if (socket) {
      // Track all relevant events
      socket.on('table:unmerged', (data) => {
        console.log('   📡 [SOCKET] table:unmerged');
        socketEvents.push({ event: 'table:unmerged', data, time: new Date() });
      });
      socket.on('table:updated', (data) => {
        socketEvents.push({ event: 'table:updated', data, time: new Date() });
      });
      socket.on('order:updated', (data) => {
        socketEvents.push({ event: 'order:updated', data, time: new Date() });
      });
      socket.on('kot:updated', (data) => {
        socketEvents.push({ event: 'kot:updated', data, time: new Date() });
      });
      socket.on('bill:status', (data) => {
        socketEvents.push({ event: 'bill:status', data, time: new Date() });
      });
      socket.on('payment:updated', (data) => {
        socketEvents.push({ event: 'payment:updated', data, time: new Date() });
      });
      recordTest('Socket connected', true, socket.id);
    } else {
      recordTest('Socket connected', false, 'Connection failed');
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 3: FIND/PREPARE MERGEABLE TABLES
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 3: Find or Prepare Mergeable Tables');
    console.log('─'.repeat(50));
    
    const tablesRes = await apiRequest('GET', `/tables/outlet/${CONFIG.outletId}`, null, CONFIG.authToken);
    let tables = tablesRes.data.data || [];
    
    // Find available tables
    let availableTables = tables.filter(t => t.status === 'available');
    console.log(`   Total tables: ${tables.length}`);
    console.log(`   Available tables: ${availableTables.length}`);
    
    // Check for mergeable tables
    let mergeableTables = availableTables.filter(t => 
      t.isMergeable === true || t.is_mergeable === true || 
      t.isMergeable === 1 || t.is_mergeable === 1
    );
    console.log(`   Mergeable & Available: ${mergeableTables.length}`);

    // If no mergeable tables, try to make first 2 available tables mergeable
    if (mergeableTables.length < 2 && availableTables.length >= 2) {
      console.log('   Making tables mergeable...');
      
      for (let i = 0; i < Math.min(2, availableTables.length); i++) {
        const table = availableTables[i];
        const tableId = table.id;
        // Use PUT with full table data
        const updateRes = await apiRequest('PUT', `/tables/${tableId}`, {
          tableNumber: table.tableNumber || table.table_number,
          floorId: table.floorId || table.floor_id,
          capacity: table.capacity || 4,
          isMergeable: true
        }, CONFIG.authToken);
        
        if (updateRes.data.success) {
          console.log(`   ✅ Table ${table.tableNumber || table.table_number} set mergeable`);
        } else {
          console.log(`   ⚠️  Failed to update table: ${updateRes.data.message}`);
        }
      }
      
      // Refresh tables list
      const refreshRes = await apiRequest('GET', `/tables/outlet/${CONFIG.outletId}`, null, CONFIG.authToken);
      tables = refreshRes.data.data || [];
      availableTables = tables.filter(t => t.status === 'available');
      mergeableTables = availableTables.filter(t => 
        t.isMergeable === true || t.is_mergeable === true || 
        t.isMergeable === 1 || t.is_mergeable === 1
      );
    }

    if (mergeableTables.length < 2) {
      console.log('   ❌ Cannot find/create 2 mergeable tables');
      console.log('   Please manually set is_mergeable = 1 for at least 2 tables');
      process.exit(1);
    }

    primaryTableId = mergeableTables[0].id;
    secondaryTableId = mergeableTables[1].id;
    primaryNumber = mergeableTables[0].tableNumber || mergeableTables[0].table_number;
    secondaryNumber = mergeableTables[1].tableNumber || mergeableTables[1].table_number;
    
    recordTest('Found mergeable tables', true, `${primaryNumber}, ${secondaryNumber}`);
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 4: MERGE TABLES
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 4: Merge Tables');
    console.log('─'.repeat(50));
    console.log(`   Merging: ${primaryNumber} (primary) + ${secondaryNumber}`);
    
    const mergeRes = await apiRequest('POST', `/tables/${primaryTableId}/merge`, {
      tableIds: [secondaryTableId]
    }, CONFIG.authToken);

    if (mergeRes.data.success) {
      recordTest('Tables merged', true, `${primaryNumber} + ${secondaryNumber}`);
    } else {
      recordTest('Tables merged', false, mergeRes.data.message);
      console.log('   Continuing with primary table only...');
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 5: START SESSION ON MERGED TABLE
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 5: Start Session on Merged Table');
    console.log('─'.repeat(50));
    
    const sessionRes = await apiRequest('POST', `/tables/${primaryTableId}/session`, {
      guestCount: 4,
      guestName: 'Merge Test Customer',
    }, CONFIG.authToken);

    if (sessionRes.data.success) {
      const sessionId = sessionRes.data.data?.sessionId;
      recordTest('Session started', true, `Session ID: ${sessionId}`);
    } else {
      recordTest('Session started', false, sessionRes.data.message);
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 6: CREATE ORDER WITH ITEMS
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 6: Create Order with Items');
    console.log('─'.repeat(50));
    
    // Get a menu item
    const menuRes = await apiRequest('GET', `/menu/items?outletId=${CONFIG.outletId}&limit=1`, null, CONFIG.authToken);
    const menuItem = menuRes.data.data?.[0];
    
    const orderPayload = {
      outletId: CONFIG.outletId,
      tableId: primaryTableId,
      floorId: mergeableTables[0].floorId || mergeableTables[0].floor_id,
      orderType: 'dine_in',
      guestCount: 4,
      customerName: 'Merge Test Customer',
    };

    // Add items if menu item exists
    if (menuItem) {
      orderPayload.items = [{
        menuItemId: menuItem.id,
        quantity: 2,
        notes: 'Test order item'
      }];
    }

    const orderRes = await apiRequest('POST', '/orders', orderPayload, CONFIG.authToken);

    if (orderRes.data.success) {
      orderId = orderRes.data.data.id;
      const orderNumber = orderRes.data.data.order_number || orderRes.data.data.orderNumber;
      recordTest('Order created', true, `Order: ${orderNumber} (ID: ${orderId})`);
    } else {
      recordTest('Order created', false, orderRes.data.message);
      // Cleanup and exit
      await apiRequest('DELETE', `/tables/${primaryTableId}/session`, null, CONFIG.authToken);
      process.exit(1);
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 7: CREATE KOT (if items exist)
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 7: Create KOT');
    console.log('─'.repeat(50));
    
    if (menuItem) {
      const kotRes = await apiRequest('POST', `/orders/${orderId}/kot`, {}, CONFIG.authToken);
      if (kotRes.data.success) {
        kotId = kotRes.data.data?.kot?.id || kotRes.data.data?.id;
        const kotNumber = kotRes.data.data?.kot?.kotNumber || kotRes.data.data?.kotNumber;
        recordTest('KOT created', true, `KOT: ${kotNumber}`);
      } else {
        recordTest('KOT created', false, kotRes.data.message);
      }
    } else {
      console.log('   ⚠️  No menu items - skipping KOT');
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 8: TRY TO UNMERGE - SHOULD FAIL
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 8: Try Unmerge While Order Exists (Should FAIL)');
    console.log('─'.repeat(50));
    
    const unmergeFailRes = await apiRequest('DELETE', `/tables/${primaryTableId}/merge`, null, CONFIG.authToken);
    
    if (!unmergeFailRes.data.success) {
      recordTest('Unmerge blocked correctly', true, unmergeFailRes.data.message.substring(0, 50));
    } else {
      recordTest('Unmerge blocked correctly', false, 'Unmerge should have been blocked!');
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 9: GENERATE BILL
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 9: Generate Bill');
    console.log('─'.repeat(50));
    
    const billRes = await apiRequest('POST', `/orders/${orderId}/bill`, {}, CONFIG.authToken);
    
    if (billRes.data.success) {
      invoiceId = billRes.data.data?.invoice?.id || billRes.data.data?.invoiceId;
      const invoiceNumber = billRes.data.data?.invoice?.invoiceNumber || billRes.data.data?.invoiceNumber;
      recordTest('Bill generated', true, `Invoice: ${invoiceNumber || invoiceId}`);
    } else {
      recordTest('Bill generated', false, billRes.data.message);
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 10: TRY UNMERGE AGAIN - STILL SHOULD FAIL
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 10: Try Unmerge After Bill (Should Still FAIL)');
    console.log('─'.repeat(50));
    
    const unmergeFailRes2 = await apiRequest('DELETE', `/tables/${primaryTableId}/merge`, null, CONFIG.authToken);
    
    if (!unmergeFailRes2.data.success) {
      recordTest('Unmerge still blocked after bill', true);
    } else {
      recordTest('Unmerge still blocked after bill', false, 'Should still be blocked!');
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 11: COMPLETE PAYMENT
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 11: Complete Payment');
    console.log('─'.repeat(50));
    
    // Get order total
    const orderDetailsRes = await apiRequest('GET', `/orders/${orderId}`, null, CONFIG.authToken);
    const orderData = orderDetailsRes.data.data;
    const orderTotal = orderData?.grandTotal || orderData?.grand_total || 
                       orderData?.totalAmount || orderData?.total_amount || 100;
    
    console.log(`   Order Total: ₹${orderTotal}`);

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

    // Wait for socket events
    console.log('   ⏳ Waiting for real-time events...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 12: VERIFY AUTO-UNMERGE
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 12: Verify Auto-Unmerge After Payment');
    console.log('─'.repeat(50));
    
    const mergedTablesRes = await apiRequest('GET', `/tables/${primaryTableId}/merged`, null, CONFIG.authToken);
    const activeMerges = mergedTablesRes.data.data || [];
    
    recordTest('Tables auto-unmerged', activeMerges.length === 0, 
      `Active merges: ${activeMerges.length}`);
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 13: VERIFY TABLES AVAILABLE
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 13: Verify All Tables Available');
    console.log('─'.repeat(50));
    
    const primaryAfterRes = await apiRequest('GET', `/tables/${primaryTableId}`, null, CONFIG.authToken);
    const secondaryAfterRes = await apiRequest('GET', `/tables/${secondaryTableId}`, null, CONFIG.authToken);
    
    const primaryStatus = primaryAfterRes.data.data?.status;
    const secondaryStatus = secondaryAfterRes.data.data?.status;
    
    console.log(`   Primary (${primaryNumber}): ${primaryStatus}`);
    console.log(`   Secondary (${secondaryNumber}): ${secondaryStatus}`);
    
    recordTest('Primary table available', primaryStatus === 'available');
    recordTest('Secondary table available', secondaryStatus === 'available');
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 14: VERIFY SESSION COMPLETED
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 14: Verify Session Completed');
    console.log('─'.repeat(50));
    
    const sessionAfterRes = await apiRequest('GET', `/tables/${primaryTableId}/session`, null, CONFIG.authToken);
    const activeSession = sessionAfterRes.data.data;
    
    recordTest('Session ended', !activeSession || activeSession.status !== 'active',
      activeSession ? `Status: ${activeSession.status}` : 'No active session');
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 15: VERIFY ORDER COMPLETED
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 15: Verify Order Status');
    console.log('─'.repeat(50));
    
    const orderAfterRes = await apiRequest('GET', `/orders/${orderId}`, null, CONFIG.authToken);
    const orderStatus = orderAfterRes.data.data?.status;
    const paymentStatus = orderAfterRes.data.data?.paymentStatus || orderAfterRes.data.data?.payment_status;
    
    console.log(`   Order Status: ${orderStatus}`);
    console.log(`   Payment Status: ${paymentStatus}`);
    
    recordTest('Order completed', orderStatus === 'completed' || orderStatus === 'paid');
    recordTest('Payment status completed', paymentStatus === 'completed');
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 16: VERIFY KOT SERVED
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 16: Verify KOT Served');
    console.log('─'.repeat(50));
    
    if (kotId) {
      const kotAfterRes = await apiRequest('GET', `/kots/${kotId}`, null, CONFIG.authToken);
      const kotStatus = kotAfterRes.data.data?.status;
      console.log(`   KOT Status: ${kotStatus}`);
      recordTest('KOT marked served', kotStatus === 'served');
    } else {
      console.log('   ⚠️  No KOT to verify');
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // STEP 17: SOCKET EVENTS SUMMARY
    // ══════════════════════════════════════════════════════════════
    console.log('📋 STEP 17: Socket Events Summary');
    console.log('─'.repeat(50));
    
    // Group events by type
    const eventCounts = {};
    socketEvents.forEach(e => {
      eventCounts[e.event] = (eventCounts[e.event] || 0) + 1;
    });
    
    console.log(`   Total events received: ${socketEvents.length}`);
    Object.entries(eventCounts).forEach(([event, count]) => {
      console.log(`   - ${event}: ${count}`);
    });
    
    // Check for specific events
    const hasUnmergeEvent = socketEvents.some(e => e.event === 'table:unmerged');
    const hasBillStatus = socketEvents.some(e => e.event === 'bill:status');
    const hasOrderUpdate = socketEvents.some(e => e.event === 'order:updated');
    
    recordTest('Received table:unmerged event', hasUnmergeEvent);
    recordTest('Received bill:status event', hasBillStatus);
    recordTest('Received order:updated event', hasOrderUpdate);
    console.log();

    // ══════════════════════════════════════════════════════════════
    // FINAL SUMMARY
    // ══════════════════════════════════════════════════════════════
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
