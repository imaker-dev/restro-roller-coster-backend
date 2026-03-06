/**
 * Test Script: Unmerge Table & Shift Detail Takeaway Count
 * 
 * Tests:
 * 1. Unmerge table when status is 'merged' (secondary table)
 * 2. Shift detail includes takeaway order count
 * 
 * Run: node tests/test-unmerge-and-shift-detail.js
 */

const http = require('http');

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

async function runTests() {
  console.log('═'.repeat(70));
  console.log('  UNMERGE TABLE & SHIFT DETAIL TAKEAWAY COUNT TEST');
  console.log('═'.repeat(70));
  console.log();

  let orderId, invoiceId;

  try {
    // STEP 1: Login
    console.log('📋 STEP 1: Login');
    console.log('─'.repeat(50));
    CONFIG.authToken = await login('admin@restropos.com', 'admin123');
    recordTest('Login successful', true);
    console.log();

    // ══════════════════════════════════════════════════════════════
    // PART A: Test Shift Detail with Takeaway Orders
    // ══════════════════════════════════════════════════════════════
    console.log('═'.repeat(70));
    console.log('  PART A: SHIFT DETAIL TAKEAWAY COUNT');
    console.log('═'.repeat(70));
    console.log();

    // STEP 2: Create Takeaway Order
    console.log('📋 STEP 2: Create Takeaway Order');
    console.log('─'.repeat(50));
    
    const orderRes = await apiRequest('POST', '/orders', {
      outletId: CONFIG.outletId,
      orderType: 'takeaway',
      customerName: 'Shift Test Takeaway',
      customerPhone: '9876500001',
    }, CONFIG.authToken);

    if (orderRes.data.success) {
      orderId = orderRes.data.data.id;
      recordTest('Takeaway order created', true, `Order ID: ${orderId}`);
    } else {
      recordTest('Takeaway order created', false, orderRes.data.message);
    }
    console.log();

    // STEP 3: Generate Bill
    console.log('📋 STEP 3: Generate Bill');
    console.log('─'.repeat(50));
    
    const billRes = await apiRequest('POST', `/orders/${orderId}/bill`, {}, CONFIG.authToken);
    if (billRes.data.success) {
      invoiceId = billRes.data.data?.invoice?.id || billRes.data.data?.invoiceId;
      recordTest('Bill generated', true);
    } else {
      recordTest('Bill generated', false, billRes.data.message);
    }
    console.log();

    // STEP 4: Complete Payment
    console.log('📋 STEP 4: Complete Payment');
    console.log('─'.repeat(50));
    
    const paymentRes = await apiRequest('POST', '/orders/payment', {
      outletId: CONFIG.outletId,
      orderId,
      invoiceId,
      paymentMode: 'cash',
      amount: 100,
    }, CONFIG.authToken);
    recordTest('Payment completed', paymentRes.data.success);
    console.log();

    // STEP 5: Get Open Shifts
    console.log('📋 STEP 5: Get Open Shifts');
    console.log('─'.repeat(50));
    
    const shiftsRes = await apiRequest('GET', `/orders/shifts/outlet/${CONFIG.outletId}?status=open`, null, CONFIG.authToken);
    
    let shiftId = null;
    if (shiftsRes.data.success && shiftsRes.data.data?.length > 0) {
      shiftId = shiftsRes.data.data[0].id;
      recordTest('Found open shift', true, `Shift ID: ${shiftId}`);
    } else {
      // Try closed shifts
      const closedShiftsRes = await apiRequest('GET', `/orders/shifts/outlet/${CONFIG.outletId}?status=closed&limit=1`, null, CONFIG.authToken);
      if (closedShiftsRes.data.success && closedShiftsRes.data.data?.length > 0) {
        shiftId = closedShiftsRes.data.data[0].id;
        recordTest('Found closed shift', true, `Shift ID: ${shiftId}`);
      } else {
        recordTest('Found shift', false, 'No shifts available');
      }
    }
    console.log();

    // STEP 6: Get Shift Detail
    console.log('📋 STEP 6: Get Shift Detail & Check Takeaway Count');
    console.log('─'.repeat(50));
    
    if (shiftId) {
      const detailRes = await apiRequest('GET', `/orders/shifts/${shiftId}/detail`, null, CONFIG.authToken);
      
      if (detailRes.data.success) {
        const detail = detailRes.data.data;
        const stats = detail.orderStatistics || {};
        
        console.log(`   Total Orders: ${stats.totalOrders || 0}`);
        console.log(`   Completed: ${stats.completedOrders || 0}`);
        console.log(`   Dine-in: ${stats.dineInOrders || 0}`);
        console.log(`   Takeaway: ${stats.takeawayOrders || 0}`);
        console.log(`   Delivery: ${stats.deliveryOrders || 0}`);
        
        recordTest('Shift detail API works', true);
        recordTest('Takeaway count present', stats.takeawayOrders !== undefined);
        
        // Check if our takeaway order is counted (if it's today's shift)
        if (stats.takeawayOrders > 0) {
          recordTest('Takeaway orders counted', true, `Count: ${stats.takeawayOrders}`);
        } else {
          console.log('   ⚠️  No takeaway orders in this shift time range');
        }
      } else {
        recordTest('Shift detail API works', false, detailRes.data.message);
      }
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // PART B: Test Table Unmerge
    // ══════════════════════════════════════════════════════════════
    console.log('═'.repeat(70));
    console.log('  PART B: TABLE UNMERGE TEST');
    console.log('═'.repeat(70));
    console.log();

    // STEP 7: Find tables to merge
    console.log('📋 STEP 7: Find Mergeable Tables');
    console.log('─'.repeat(50));
    
    const tablesRes = await apiRequest('GET', `/tables/outlet/${CONFIG.outletId}`, null, CONFIG.authToken);
    let tables = tablesRes.data.data || [];
    let availableTables = tables.filter(t => t.status === 'available');
    
    // Make tables mergeable if needed
    let mergeableTables = availableTables.filter(t => 
      t.isMergeable === true || t.is_mergeable === true || 
      t.isMergeable === 1 || t.is_mergeable === 1
    );
    
    if (mergeableTables.length < 2 && availableTables.length >= 2) {
      console.log('   Making tables mergeable...');
      for (let i = 0; i < Math.min(2, availableTables.length); i++) {
        const table = availableTables[i];
        await apiRequest('PUT', `/tables/${table.id}`, {
          tableNumber: table.tableNumber || table.table_number,
          floorId: table.floorId || table.floor_id,
          capacity: table.capacity || 4,
          isMergeable: true
        }, CONFIG.authToken);
      }
      
      const refreshRes = await apiRequest('GET', `/tables/outlet/${CONFIG.outletId}`, null, CONFIG.authToken);
      tables = refreshRes.data.data || [];
      availableTables = tables.filter(t => t.status === 'available');
      mergeableTables = availableTables.filter(t => 
        t.isMergeable === true || t.is_mergeable === true || 
        t.isMergeable === 1 || t.is_mergeable === 1
      );
    }

    if (mergeableTables.length >= 2) {
      const primaryTable = mergeableTables[0];
      const secondaryTable = mergeableTables[1];
      const primaryId = primaryTable.id;
      const secondaryId = secondaryTable.id;
      const primaryNum = primaryTable.tableNumber || primaryTable.table_number;
      const secondaryNum = secondaryTable.tableNumber || secondaryTable.table_number;
      
      recordTest('Found mergeable tables', true, `${primaryNum}, ${secondaryNum}`);
      console.log();

      // STEP 8: Merge tables
      console.log('📋 STEP 8: Merge Tables');
      console.log('─'.repeat(50));
      
      const mergeRes = await apiRequest('POST', `/tables/${primaryId}/merge`, {
        tableIds: [secondaryId]
      }, CONFIG.authToken);

      if (mergeRes.data.success) {
        recordTest('Tables merged', true, `${primaryNum} + ${secondaryNum}`);
      } else {
        recordTest('Tables merged', false, mergeRes.data.message);
      }
      console.log();

      // STEP 9: Check secondary table status
      console.log('📋 STEP 9: Check Secondary Table Status');
      console.log('─'.repeat(50));
      
      const secondaryAfterMerge = await apiRequest('GET', `/tables/${secondaryId}`, null, CONFIG.authToken);
      const secondaryStatus = secondaryAfterMerge.data.data?.status;
      console.log(`   Secondary table status: ${secondaryStatus}`);
      recordTest('Secondary table is merged', secondaryStatus === 'merged');
      console.log();

      // STEP 10: Unmerge using secondary table ID (status = 'merged')
      console.log('📋 STEP 10: Unmerge Using Secondary Table (status=merged)');
      console.log('─'.repeat(50));
      console.log(`   Attempting to unmerge table ${secondaryNum} (status: ${secondaryStatus})...`);
      
      const unmergeRes = await apiRequest('DELETE', `/tables/${secondaryId}/merge`, null, CONFIG.authToken);
      
      if (unmergeRes.data.success) {
        recordTest('Unmerge via secondary table', true);
      } else {
        recordTest('Unmerge via secondary table', false, unmergeRes.data.message);
      }
      console.log();

      // STEP 11: Verify tables are available
      console.log('📋 STEP 11: Verify Tables Available After Unmerge');
      console.log('─'.repeat(50));
      
      const primaryAfterUnmerge = await apiRequest('GET', `/tables/${primaryId}`, null, CONFIG.authToken);
      const secondaryAfterUnmerge = await apiRequest('GET', `/tables/${secondaryId}`, null, CONFIG.authToken);
      
      const pStatus = primaryAfterUnmerge.data.data?.status;
      const sStatus = secondaryAfterUnmerge.data.data?.status;
      
      console.log(`   Primary (${primaryNum}): ${pStatus}`);
      console.log(`   Secondary (${secondaryNum}): ${sStatus}`);
      
      recordTest('Primary table available', pStatus === 'available');
      recordTest('Secondary table available', sStatus === 'available');
    } else {
      console.log('   ⚠️  Not enough mergeable tables to test unmerge');
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
    process.exit(testResults.failed > 0 ? 1 : 0);
  }
}

runTests();
