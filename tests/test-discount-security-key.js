/**
 * Test Script: Discount Security Key Validation
 * 
 * Tests:
 * 1. Apply discount WITHOUT security key → should fail
 * 2. Apply discount WITH INVALID security key → should fail
 * 3. Apply discount WITH VALID security key (132564556) → should succeed
 * 
 * Run: node tests/test-discount-security-key.js
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
  console.log('  DISCOUNT SECURITY KEY VALIDATION TEST');
  console.log('═'.repeat(70));
  console.log();

  let orderId;

  try {
    // STEP 1: Login
    console.log('📋 STEP 1: Login');
    console.log('─'.repeat(50));
    CONFIG.authToken = await login('admin@restropos.com', 'admin123');
    recordTest('Login successful', true);
    console.log();

    // STEP 2: Create Order for testing
    console.log('📋 STEP 2: Create Test Order');
    console.log('─'.repeat(50));
    
    const orderRes = await apiRequest('POST', '/orders', {
      outletId: CONFIG.outletId,
      orderType: 'takeaway',
      customerName: 'Discount Key Test',
      customerPhone: '9876543210',
    }, CONFIG.authToken);

    if (orderRes.data.success) {
      orderId = orderRes.data.data.id;
      recordTest('Order created', true, `Order ID: ${orderId}`);
    } else {
      recordTest('Order created', false, orderRes.data.message);
      process.exit(1);
    }
    console.log();

    // STEP 2b: Add item to order
    console.log('📋 STEP 2b: Add Item to Order');
    console.log('─'.repeat(50));
    
    // Get a menu item first
    const menuRes = await apiRequest('GET', `/menu/outlet/${CONFIG.outletId}?limit=1`, null, CONFIG.authToken);
    let menuItemId = null;
    if (menuRes.data.success && menuRes.data.data?.length > 0) {
      menuItemId = menuRes.data.data[0].id;
    }
    
    if (menuItemId) {
      const addItemRes = await apiRequest('POST', `/orders/${orderId}/items`, {
        items: [{ menuItemId, quantity: 2 }]
      }, CONFIG.authToken);
      
      if (addItemRes.data.success) {
        recordTest('Item added to order', true);
      } else {
        // Try alternative endpoint
        const kotRes = await apiRequest('POST', `/orders/${orderId}/kot`, {
          items: [{ menuItemId, quantity: 2 }]
        }, CONFIG.authToken);
        recordTest('Item added via KOT', kotRes.data.success);
      }
    } else {
      console.log('   ⚠️  No menu items found, will try discount anyway');
    }
    console.log();

    // STEP 3: Try to apply discount WITHOUT security key
    console.log('📋 STEP 3: Apply Discount WITHOUT Security Key');
    console.log('─'.repeat(50));
    
    const noKeyRes = await apiRequest('POST', `/orders/${orderId}/discount`, {
      discountName: 'Test Discount',
      discountType: 'percentage',
      discountValue: 10
      // No securityKey
    }, CONFIG.authToken);

    if (!noKeyRes.data.success) {
      recordTest('Rejected without security key', true, noKeyRes.data.message);
    } else {
      recordTest('Rejected without security key', false, 'Should have failed!');
    }
    console.log();

    // STEP 4: Try to apply discount WITH INVALID security key
    console.log('📋 STEP 4: Apply Discount WITH INVALID Security Key');
    console.log('─'.repeat(50));
    
    const wrongKeyRes = await apiRequest('POST', `/orders/${orderId}/discount`, {
      discountName: 'Test Discount',
      discountType: 'percentage',
      discountValue: 10,
      securityKey: '999999999'  // Wrong key
    }, CONFIG.authToken);

    if (!wrongKeyRes.data.success) {
      const errMsg = wrongKeyRes.data.message || '';
      const isInvalidKeyError = errMsg.includes('Invalid security key');
      recordTest('Rejected with invalid key', isInvalidKeyError, errMsg);
    } else {
      recordTest('Rejected with invalid key', false, 'Should have failed!');
    }
    console.log();

    // STEP 5: Apply discount WITH VALID security key
    console.log('📋 STEP 5: Apply Discount WITH VALID Security Key (132564556)');
    console.log('─'.repeat(50));
    
    const validKeyRes = await apiRequest('POST', `/orders/${orderId}/discount`, {
      discountName: 'Authorized Discount 10%',
      discountType: 'percentage',
      discountValue: 10,
      securityKey: '132564556'  // Correct key
    }, CONFIG.authToken);

    if (validKeyRes.data.success) {
      recordTest('Discount applied with valid key', true);
      console.log(`   Discount Amount: ₹${validKeyRes.data.data?.discountAmount || 0}`);
    } else {
      recordTest('Discount applied with valid key', false, validKeyRes.data.message);
    }
    console.log();

    // STEP 6: Verify discount was applied
    console.log('📋 STEP 6: Verify Discount Applied');
    console.log('─'.repeat(50));
    
    const discountsRes = await apiRequest('GET', `/orders/${orderId}/discounts`, null, CONFIG.authToken);
    
    if (discountsRes.data.success) {
      const discounts = discountsRes.data.data?.discounts || [];
      const discountCount = discountsRes.data.data?.discountCount || 0;
      
      console.log(`   Discount count: ${discountCount}`);
      recordTest('Discount exists on order', discountCount > 0);
      
      if (discounts.length > 0) {
        console.log(`   Discount name: ${discounts[0].discountName}`);
        console.log(`   Discount value: ${discounts[0].discountValue}%`);
      }
    } else {
      recordTest('Discount exists on order', false, discountsRes.data.message);
    }
    console.log();

    // STEP 7: Try applying flat discount with valid key
    console.log('📋 STEP 7: Apply Flat Discount WITH Valid Key');
    console.log('─'.repeat(50));
    
    const flatRes = await apiRequest('POST', `/orders/${orderId}/discount`, {
      discountName: 'Flat ₹50 Off',
      discountType: 'flat',
      discountValue: 50,
      securityKey: '132564556'
    }, CONFIG.authToken);

    if (flatRes.data.success) {
      recordTest('Flat discount applied', true, `₹${flatRes.data.data?.discountAmount}`);
    } else {
      recordTest('Flat discount applied', false, flatRes.data.message);
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
      console.log();
      console.log('  Security Key Validation Working:');
      console.log('  - ❌ No key → Rejected');
      console.log('  - ❌ Wrong key → Rejected');
      console.log('  - ✅ Key "132564556" → Accepted');
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
