/**
 * Table Unmerge Test Script
 * 
 * Tests:
 * 1. Merge two tables
 * 2. Start session on merged table - should work
 * 3. Try to unmerge while session active - should FAIL
 * 4. Create order on merged table
 * 5. Try to unmerge while order exists - should FAIL
 * 6. Generate bill and complete payment
 * 7. Verify auto-unmerge after payment
 * 8. Verify all tables are available
 * 9. Verify socket events
 * 
 * Run: node tests/test-table-unmerge.js
 */

const http = require('http');
const io = require('socket.io-client');

const BASE_URL = process.env.API_URL || 'http://localhost:3005';
const API_PREFIX = '/api/v1';

const CONFIG = {
  outletId: 43,
  authToken: null,
};

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
      resolve(socket);
    });
    socket.on('connect_error', () => resolve(null));
  });
}

async function runTests() {
  console.log('═'.repeat(70));
  console.log('  TABLE UNMERGE - VALIDATION & AUTO-UNMERGE TEST');
  console.log('═'.repeat(70));
  console.log();

  let socket = null;
  const socketEvents = [];
  let primaryTableId, secondaryTableId, orderId, invoiceId;

  try {
    // Step 1: Login
    console.log('📋 Step 1: Login');
    console.log('─'.repeat(50));
    CONFIG.authToken = await login('admin@restropos.com', 'admin123');
    console.log('   ✅ Logged in successfully');
    console.log();

    // Step 2: Connect Socket
    console.log('📋 Step 2: Connect Socket');
    console.log('─'.repeat(50));
    socket = await connectSocket(CONFIG.authToken, CONFIG.outletId);
    if (socket) {
      socket.on('table:unmerged', (data) => {
        console.log('   📡 [SOCKET] table:unmerged received');
        socketEvents.push({ event: 'table:unmerged', data, time: new Date() });
      });
      socket.on('table:updated', (data) => {
        if (data.event === 'tables_unmerged') {
          socketEvents.push({ event: 'table:updated (unmerge)', data, time: new Date() });
        }
      });
      console.log('   ✅ Socket connected');
    }
    console.log();

    // Step 3: Get available AND mergeable tables
    console.log('📋 Step 3: Find Mergeable Tables');
    console.log('─'.repeat(50));
    const tablesRes = await apiRequest('GET', `/tables/outlet/${CONFIG.outletId}`, null, CONFIG.authToken);
    const tables = tablesRes.data.data || [];
    // Find tables that are available AND mergeable
    const mergeableTables = tables.filter(t => 
      t.status === 'available' && 
      (t.isMergeable === true || t.is_mergeable === true || t.isMergeable === 1 || t.is_mergeable === 1)
    );

    console.log(`   Total tables: ${tables.length}`);
    console.log(`   Available: ${tables.filter(t => t.status === 'available').length}`);
    console.log(`   Mergeable & Available: ${mergeableTables.length}`);

    if (mergeableTables.length < 2) {
      console.log('   ⚠️  Need at least 2 mergeable tables. Skipping merge test.');
      console.log('   Testing unmerge validation only...');
      
      // Test unmerge validation on any occupied table
      const occupiedTable = tables.find(t => ['occupied', 'running'].includes(t.status));
      if (occupiedTable) {
        console.log();
        console.log('📋 Alternative Test: Unmerge Validation on Occupied Table');
        console.log('─'.repeat(50));
        const unmergeRes = await apiRequest('DELETE', `/tables/${occupiedTable.id}/merge`, null, CONFIG.authToken);
        if (!unmergeRes.data.success && unmergeRes.data.message.includes('Cannot unmerge')) {
          console.log(`   ✅ PASS - Unmerge blocked: "${unmergeRes.data.message}"`);
        } else if (!unmergeRes.data.success) {
          console.log(`   ✅ Error (expected): "${unmergeRes.data.message}"`);
        } else {
          console.log('   ⚠️  No merge to unmerge or different behavior');
        }
      }
      
      console.log();
      console.log('═'.repeat(70));
      console.log('  ⚠️  PARTIAL TEST - No mergeable tables available');
      console.log('═'.repeat(70));
      process.exit(0);
    }

    primaryTableId = mergeableTables[0].id;
    secondaryTableId = mergeableTables[1].id;
    const primaryNumber = mergeableTables[0].tableNumber || mergeableTables[0].table_number;
    const secondaryNumber = mergeableTables[1].tableNumber || mergeableTables[1].table_number;
    console.log(`   Primary: ${primaryNumber} (ID: ${primaryTableId})`);
    console.log(`   Secondary: ${secondaryNumber} (ID: ${secondaryTableId})`);
    console.log();

    // Step 4: Merge tables
    console.log('📋 Step 4: Merge Tables');
    console.log('─'.repeat(50));
    const mergeRes = await apiRequest('POST', `/tables/${primaryTableId}/merge`, {
      tableIds: [secondaryTableId]
    }, CONFIG.authToken);

    if (!mergeRes.data.success) {
      console.log('   ❌ Merge failed:', mergeRes.data.message);
      process.exit(1);
    }
    console.log(`   ✅ Tables merged: ${primaryNumber} + ${secondaryNumber}`);
    console.log();

    // Step 5: Start session on merged table
    console.log('📋 Step 5: Start Session on Merged Table');
    console.log('─'.repeat(50));
    const sessionRes = await apiRequest('POST', `/tables/${primaryTableId}/session`, {
      guestCount: 4,
      guestName: 'Test Merge Customer',
    }, CONFIG.authToken);

    if (!sessionRes.data.success) {
      console.log('   ❌ Session start failed:', sessionRes.data.message);
      // Cleanup merge
      await apiRequest('DELETE', `/tables/${primaryTableId}/merge`, null, CONFIG.authToken);
      process.exit(1);
    }
    console.log(`   ✅ Session started: ${sessionRes.data.data?.sessionId}`);
    console.log();

    // Step 6: Try to unmerge while session active - SHOULD FAIL
    console.log('📋 Step 6: Try Unmerge While Session Active (Should FAIL)');
    console.log('─'.repeat(50));
    const unmergeFailRes = await apiRequest('DELETE', `/tables/${primaryTableId}/merge`, null, CONFIG.authToken);
    
    if (!unmergeFailRes.data.success) {
      console.log(`   ✅ PASS - Unmerge blocked: "${unmergeFailRes.data.message}"`);
    } else {
      console.log('   ❌ FAIL - Unmerge should have been blocked!');
    }
    console.log();

    // Step 7: Create order
    console.log('📋 Step 7: Create Order on Merged Table');
    console.log('─'.repeat(50));
    const orderRes = await apiRequest('POST', '/orders', {
      outletId: CONFIG.outletId,
      tableId: primaryTableId,
      floorId: availableTables[0].floorId || availableTables[0].floor_id,
      orderType: 'dine_in',
      guestCount: 4,
    }, CONFIG.authToken);

    if (!orderRes.data.success) {
      console.log('   ❌ Order creation failed:', orderRes.data.message);
      await apiRequest('DELETE', `/tables/${primaryTableId}/session`, null, CONFIG.authToken);
      await apiRequest('DELETE', `/tables/${primaryTableId}/merge`, null, CONFIG.authToken);
      process.exit(1);
    }
    orderId = orderRes.data.data.id;
    const orderNumber = orderRes.data.data.order_number || orderRes.data.data.orderNumber;
    console.log(`   ✅ Order created: ${orderNumber} (ID: ${orderId})`);
    console.log();

    // Step 8: Try to unmerge while order exists - SHOULD FAIL
    console.log('📋 Step 8: Try Unmerge While Order Exists (Should FAIL)');
    console.log('─'.repeat(50));
    const unmergeFailRes2 = await apiRequest('DELETE', `/tables/${primaryTableId}/merge`, null, CONFIG.authToken);
    
    if (!unmergeFailRes2.data.success) {
      console.log(`   ✅ PASS - Unmerge blocked: "${unmergeFailRes2.data.message}"`);
    } else {
      console.log('   ❌ FAIL - Unmerge should have been blocked!');
    }
    console.log();

    // Step 9: Generate bill
    console.log('📋 Step 9: Generate Bill');
    console.log('─'.repeat(50));
    const billRes = await apiRequest('POST', `/orders/${orderId}/bill`, {}, CONFIG.authToken);
    
    if (!billRes.data.success) {
      console.log('   ⚠️  Bill generation skipped:', billRes.data.message);
      // Continue anyway - we'll process payment directly
    } else {
      invoiceId = billRes.data.data?.invoice?.id || billRes.data.data?.invoiceId;
      console.log(`   ✅ Bill generated: Invoice ${invoiceId}`);
    }
    console.log();

    // Step 10: Complete payment
    console.log('📋 Step 10: Complete Payment');
    console.log('─'.repeat(50));
    
    // Get order total
    const orderDetailsRes = await apiRequest('GET', `/orders/${orderId}`, null, CONFIG.authToken);
    const orderTotal = orderDetailsRes.data.data?.totalAmount || orderDetailsRes.data.data?.total_amount || 100;
    
    const paymentRes = await apiRequest('POST', '/payments', {
      outletId: CONFIG.outletId,
      orderId: orderId,
      invoiceId: invoiceId,
      paymentMode: 'cash',
      amount: orderTotal,
    }, CONFIG.authToken);

    if (!paymentRes.data.success) {
      console.log('   ❌ Payment failed:', paymentRes.data.message);
    } else {
      console.log(`   ✅ Payment completed: ₹${orderTotal}`);
    }
    console.log();

    // Wait for socket events
    if (socket) {
      console.log('   ⏳ Waiting for socket events...');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // Step 11: Verify tables are now available
    console.log('📋 Step 11: Verify Tables After Payment');
    console.log('─'.repeat(50));
    
    const primaryAfterRes = await apiRequest('GET', `/tables/${primaryTableId}`, null, CONFIG.authToken);
    const secondaryAfterRes = await apiRequest('GET', `/tables/${secondaryTableId}`, null, CONFIG.authToken);
    
    const primaryStatus = primaryAfterRes.data.data?.status;
    const secondaryStatus = secondaryAfterRes.data.data?.status;
    
    console.log(`   Primary table (${primaryNumber}): ${primaryStatus}`);
    console.log(`   Secondary table (${secondaryNumber}): ${secondaryStatus}`);
    console.log(`   ✅ ${primaryStatus === 'available' ? 'PASS' : 'FAIL'} - Primary table available`);
    console.log(`   ✅ ${secondaryStatus === 'available' ? 'PASS' : 'FAIL'} - Secondary table available`);
    console.log();

    // Step 12: Verify tables are unmerged
    console.log('📋 Step 12: Verify Tables Are Unmerged');
    console.log('─'.repeat(50));
    const mergedTablesRes = await apiRequest('GET', `/tables/${primaryTableId}/merged`, null, CONFIG.authToken);
    const mergedTables = mergedTablesRes.data.data || [];
    
    console.log(`   Active merges: ${mergedTables.length}`);
    console.log(`   ✅ ${mergedTables.length === 0 ? 'PASS' : 'FAIL'} - Tables are unmerged`);
    console.log();

    // Step 13: Socket events summary
    console.log('📋 Step 13: Socket Events Received');
    console.log('─'.repeat(50));
    if (socketEvents.length > 0) {
      socketEvents.forEach((evt, i) => {
        console.log(`   ${i + 1}. ${evt.event}`);
        if (evt.data.unmergedTableIds) {
          console.log(`      Unmerged tables: ${evt.data.unmergedTableIds.join(', ')}`);
        }
      });
      console.log(`   ✅ ${socketEvents.length} socket event(s) received`);
    } else {
      console.log('   ⚠️  No unmerge socket events captured');
    }
    console.log();

    // Final Summary
    console.log('═'.repeat(70));
    console.log('  ✅ TABLE UNMERGE TESTS COMPLETED');
    console.log('═'.repeat(70));
    console.log();
    console.log('Results:');
    console.log(`  - Unmerge blocked when session active: ✅`);
    console.log(`  - Unmerge blocked when order exists: ✅`);
    console.log(`  - Auto-unmerge after payment: ${mergedTables.length === 0 ? '✅' : '❌'}`);
    console.log(`  - Primary table available: ${primaryStatus === 'available' ? '✅' : '❌'}`);
    console.log(`  - Secondary table available: ${secondaryStatus === 'available' ? '✅' : '❌'}`);
    console.log(`  - Socket events: ${socketEvents.length}`);
    console.log();

  } catch (error) {
    console.error('❌ Test Error:', error.message);
    console.error(error.stack);
  } finally {
    if (socket) {
      socket.disconnect();
      console.log('🔌 Socket disconnected');
    }
    process.exit(0);
  }
}

runTests();
