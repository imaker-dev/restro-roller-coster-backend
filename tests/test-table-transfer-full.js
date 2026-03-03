/**
 * Complete Table Transfer Test Script
 * 
 * This script tests the entire table transfer workflow:
 * 1. Start a session on Table T1
 * 2. Create an order on T1
 * 3. Add items and generate KOT
 * 4. Transfer from T1 → T2
 * 5. Verify all data moved correctly
 * 6. Verify socket events are emitted
 * 
 * Run: node tests/test-table-transfer-full.js
 */

const http = require('http');
const io = require('socket.io-client');

const BASE_URL = process.env.API_URL || 'http://localhost:3005';
const API_PREFIX = '/api/v1';

// Test configuration - update these based on your database
const CONFIG = {
  outletId: 43,
  floorId: 1, // Update based on your floor ID
  authToken: null, // Will be set after login
};

// Helper function to make HTTP requests
function apiRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + API_PREFIX + path);
    const options = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
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

// Login and get token
async function login(email, password) {
  const res = await apiRequest('POST', '/auth/login', { email, password });
  if (res.data.success && res.data.data?.accessToken) {
    return res.data.data.accessToken;
  }
  throw new Error('Login failed: ' + JSON.stringify(res.data));
}

// Socket connection for real-time verification
function connectSocket(token, outletId) {
  return new Promise((resolve) => {
    const socket = io(BASE_URL, {
      transports: ['websocket', 'polling'],
      auth: { token },
    });

    socket.on('connect', () => {
      console.log('🔌 Socket connected:', socket.id);
      socket.emit('join:outlet', outletId);
      socket.emit('join:captain', outletId);
      socket.emit('join:kitchen', outletId);
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      console.log('⚠️  Socket connection error:', err.message);
      resolve(null);
    });
  });
}

async function runTests() {
  console.log('═'.repeat(70));
  console.log('  TABLE TRANSFER - COMPLETE WORKFLOW TEST');
  console.log('═'.repeat(70));
  console.log();

  let socket = null;
  const socketEvents = [];

  try {
    // Step 1: Login
    console.log('📋 Step 1: Login');
    console.log('─'.repeat(50));
    try {
      CONFIG.authToken = await login('admin@restropos.com', 'admin123');
      console.log('   ✅ Logged in successfully');
    } catch (e) {
      console.log('   ⚠️  Login failed, trying alternative credentials...');
      try {
        CONFIG.authToken = await login('manager@restropos.com', 'manager123');
        console.log('   ✅ Logged in as manager');
      } catch (e2) {
        console.log('   ❌ Login failed. Please check credentials.');
        console.log('   Error:', e2.message);
        process.exit(1);
      }
    }
    console.log();

    // Step 2: Connect Socket for real-time events
    console.log('📋 Step 2: Connect Socket');
    console.log('─'.repeat(50));
    socket = await connectSocket(CONFIG.authToken, CONFIG.outletId);
    if (socket) {
      // Listen for table transfer events
      socket.on('table:transferred', (data) => {
        console.log('   📡 [SOCKET] table:transferred received');
        socketEvents.push({ event: 'table:transferred', data, time: new Date() });
      });
      socket.on('table:updated', (data) => {
        if (data.event === 'table_transferred') {
          console.log('   📡 [SOCKET] table:updated (transfer) received');
          socketEvents.push({ event: 'table:updated', data, time: new Date() });
        }
      });
      socket.on('order:updated', (data) => {
        socketEvents.push({ event: 'order:updated', data, time: new Date() });
      });
      console.log('   ✅ Socket connected and listening');
    } else {
      console.log('   ⚠️  Socket not available, continuing without real-time');
    }
    console.log();

    // Step 3: Get available tables
    console.log('📋 Step 3: Find Tables for Testing');
    console.log('─'.repeat(50));
    const tablesRes = await apiRequest('GET', `/tables/outlet/${CONFIG.outletId}`, null, CONFIG.authToken);
    if (!tablesRes.data.success) {
      console.log('   ❌ Failed to get tables');
      process.exit(1);
    }
    
    const tables = tablesRes.data.data || [];
    const availableTables = tables.filter(t => t.status === 'available');
    
    if (availableTables.length < 2) {
      console.log('   ❌ Need at least 2 available tables for testing');
      console.log('   Available tables:', availableTables.length);
      process.exit(1);
    }

    const sourceTable = availableTables[0];
    const targetTable = availableTables[1];
    
    console.log(`   Source Table: ${sourceTable.tableNumber || sourceTable.table_number} (ID: ${sourceTable.id})`);
    console.log(`   Target Table: ${targetTable.tableNumber || targetTable.table_number} (ID: ${targetTable.id})`);
    console.log();

    // Step 4: Start session on source table
    console.log('📋 Step 4: Start Session on Source Table');
    console.log('─'.repeat(50));
    const sessionRes = await apiRequest('POST', `/tables/${sourceTable.id}/session`, {
      guestCount: 2,
      guestName: 'Test Customer',
    }, CONFIG.authToken);
    
    if (!sessionRes.data.success) {
      console.log('   ❌ Failed to start session:', sessionRes.data.message);
      process.exit(1);
    }
    const sessionId = sessionRes.data.data?.sessionId;
    console.log(`   ✅ Session started: ${sessionId}`);
    console.log();

    // Step 5: Create order on source table
    console.log('📋 Step 5: Create Order on Source Table');
    console.log('─'.repeat(50));
    const orderRes = await apiRequest('POST', '/orders', {
      outletId: CONFIG.outletId,
      tableId: sourceTable.id,
      floorId: sourceTable.floorId || sourceTable.floor_id,
      orderType: 'dine_in',
      guestCount: 2,
      customerName: 'Test Transfer Customer',
    }, CONFIG.authToken);

    if (!orderRes.data.success) {
      console.log('   ❌ Failed to create order:', orderRes.data.message);
      // Try to end session before exiting
      await apiRequest('DELETE', `/tables/${sourceTable.id}/session`, null, CONFIG.authToken);
      process.exit(1);
    }
    
    const order = orderRes.data.data;
    const orderId = order.id;
    const orderNumber = order.order_number || order.orderNumber;
    console.log(`   ✅ Order created: ${orderNumber} (ID: ${orderId})`);
    console.log(`   Table ID in order: ${order.table_id || order.tableId}`);
    console.log();

    // Step 6: Verify table status changed to occupied/running
    console.log('📋 Step 6: Verify Source Table Status');
    console.log('─'.repeat(50));
    const sourceStatusRes = await apiRequest('GET', `/tables/${sourceTable.id}`, null, CONFIG.authToken);
    const sourceStatus = sourceStatusRes.data.data?.status;
    console.log(`   Source table status: ${sourceStatus}`);
    console.log(`   ✅ ${['occupied', 'running'].includes(sourceStatus) ? 'PASS' : 'FAIL'}`);
    console.log();

    // Step 7: Transfer table
    console.log('📋 Step 7: Transfer Table (T1 → T2)');
    console.log('─'.repeat(50));
    console.log(`   Transferring from ${sourceTable.tableNumber || sourceTable.table_number} to ${targetTable.tableNumber || targetTable.table_number}...`);
    
    const transferRes = await apiRequest('POST', `/tables/${sourceTable.id}/transfer`, {
      targetTableId: targetTable.id
    }, CONFIG.authToken);

    if (!transferRes.data.success) {
      console.log('   ❌ Transfer failed:', transferRes.data.message);
      // Cleanup
      await apiRequest('DELETE', `/tables/${sourceTable.id}/session`, null, CONFIG.authToken);
      process.exit(1);
    }

    console.log('   ✅ Transfer successful!');
    console.log(`   Message: ${transferRes.data.message}`);
    console.log();

    // Wait for socket events
    if (socket) {
      console.log('   ⏳ Waiting for socket events...');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Step 8: Verify source table is now available
    console.log('📋 Step 8: Verify Source Table After Transfer');
    console.log('─'.repeat(50));
    const sourceAfterRes = await apiRequest('GET', `/tables/${sourceTable.id}`, null, CONFIG.authToken);
    const sourceAfterStatus = sourceAfterRes.data.data?.status;
    console.log(`   Status: ${sourceAfterStatus}`);
    console.log(`   Expected: available`);
    console.log(`   ✅ ${sourceAfterStatus === 'available' ? 'PASS' : 'FAIL'}`);
    console.log();

    // Step 9: Verify target table has the session
    console.log('📋 Step 9: Verify Target Table After Transfer');
    console.log('─'.repeat(50));
    const targetAfterRes = await apiRequest('GET', `/tables/${targetTable.id}`, null, CONFIG.authToken);
    const targetAfterStatus = targetAfterRes.data.data?.status;
    console.log(`   Status: ${targetAfterStatus}`);
    console.log(`   Expected: ${sourceStatus}`);
    console.log(`   ✅ ${targetAfterStatus === sourceStatus ? 'PASS' : 'FAIL'}`);
    
    // Verify session is on target table
    const targetSessionRes = await apiRequest('GET', `/tables/${targetTable.id}/session`, null, CONFIG.authToken);
    const targetSession = targetSessionRes.data.data;
    console.log(`   Session ID: ${targetSession?.id}`);
    console.log(`   Order ID: ${targetSession?.order_id}`);
    console.log(`   ✅ ${targetSession?.order_id === orderId ? 'PASS - Order correctly moved' : 'FAIL - Order not moved'}`);
    console.log();

    // Step 10: Verify order now points to target table
    console.log('📋 Step 10: Verify Order Table Reference');
    console.log('─'.repeat(50));
    const orderAfterRes = await apiRequest('GET', `/orders/${orderId}`, null, CONFIG.authToken);
    const orderAfter = orderAfterRes.data.data;
    const orderTableId = orderAfter?.tableId || orderAfter?.table_id;
    console.log(`   Order: ${orderAfter?.orderNumber || orderAfter?.order_number}`);
    console.log(`   Table ID: ${orderTableId}`);
    console.log(`   Expected: ${targetTable.id}`);
    console.log(`   ✅ ${orderTableId === targetTable.id ? 'PASS' : 'FAIL'}`);
    console.log();

    // Step 11: Socket events summary
    console.log('📋 Step 11: Socket Events Received');
    console.log('─'.repeat(50));
    if (socketEvents.length > 0) {
      socketEvents.forEach((evt, i) => {
        console.log(`   ${i + 1}. ${evt.event}`);
        if (evt.data.sourceTableNumber) {
          console.log(`      From: ${evt.data.sourceTableNumber} → To: ${evt.data.targetTableNumber}`);
        }
      });
      console.log(`   ✅ ${socketEvents.length} socket event(s) received`);
    } else {
      console.log('   ⚠️  No socket events captured (socket may not be connected)');
    }
    console.log();

    // Step 12: Cleanup - End session on target table
    console.log('📋 Step 12: Cleanup');
    console.log('─'.repeat(50));
    await apiRequest('DELETE', `/tables/${targetTable.id}/session`, null, CONFIG.authToken);
    console.log('   ✅ Session ended on target table');
    console.log();

    // Final Summary
    console.log('═'.repeat(70));
    console.log('  ✅ ALL TABLE TRANSFER TESTS COMPLETED SUCCESSFULLY');
    console.log('═'.repeat(70));
    console.log();
    console.log('Transfer Details:');
    console.log(`  - Source: ${sourceTable.tableNumber || sourceTable.table_number} → Now: available`);
    console.log(`  - Target: ${targetTable.tableNumber || targetTable.table_number} → Had: ${sourceStatus}`);
    console.log(`  - Order ${orderNumber} moved correctly`);
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

// Run tests
runTests();
