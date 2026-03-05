/**
 * Test Script: Day End Summary API Verification
 * 
 * Tests:
 * 1. GET /api/v1/reports/day-end-summary - Summary report
 * 2. GET /api/v1/reports/day-end-summary/detail - Comprehensive detail report
 * 3. Verify data accuracy and completeness
 * 
 * Run: node tests/test-day-end-summary.js
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
  console.log('  DAY END SUMMARY API VERIFICATION TEST');
  console.log('═'.repeat(70));
  console.log();

  try {
    // STEP 1: Login
    console.log('📋 STEP 1: Login');
    console.log('─'.repeat(50));
    CONFIG.authToken = await login('admin@restropos.com', 'admin123');
    recordTest('Login successful', true);
    console.log();

    // ══════════════════════════════════════════════════════════════
    // PART A: Test Day End Summary API
    // ══════════════════════════════════════════════════════════════
    console.log('═'.repeat(70));
    console.log('  PART A: DAY END SUMMARY API');
    console.log('═'.repeat(70));
    console.log();

    // STEP 2: Get Day End Summary
    console.log('📋 STEP 2: GET /api/v1/reports/day-end-summary');
    console.log('─'.repeat(50));
    
    const summaryRes = await apiRequest(
      'GET', 
      `/reports/day-end-summary?outletId=${CONFIG.outletId}`,
      null,
      CONFIG.authToken
    );

    if (summaryRes.data.success) {
      recordTest('API returns success', true);
      
      const data = summaryRes.data.data;
      
      // Check structure
      recordTest('Has dateRange', !!data.dateRange);
      recordTest('Has days array', Array.isArray(data.days));
      recordTest('Has grandTotal', !!data.grandTotal);
      recordTest('Has dayCount', typeof data.dayCount === 'number');
      
      if (data.days && data.days.length > 0) {
        const day = data.days[0];
        console.log();
        console.log('   📊 Today\'s Summary:');
        console.log(`      Date: ${day.date}`);
        console.log(`      Total Orders: ${day.totalOrders}`);
        console.log(`      Completed: ${day.completedOrders}`);
        console.log(`      Cancelled: ${day.cancelledOrders}`);
        console.log(`      Total Sales: ₹${day.totalSales}`);
        console.log(`      Gross Sales: ₹${day.grossSales}`);
        console.log(`      Total Discount: ₹${day.totalDiscount}`);
        console.log(`      Total Tax: ₹${day.totalTax}`);
        console.log(`      Service Charge: ₹${day.totalServiceCharge}`);
        console.log(`      Avg Order Value: ₹${day.avgOrderValue}`);
        console.log(`      Total Guests: ${day.totalGuests}`);
        
        // Check ordersByType
        if (day.ordersByType) {
          console.log(`      Orders by Type:`);
          console.log(`        - Dine-in: ${day.ordersByType.dineIn}`);
          console.log(`        - Takeaway: ${day.ordersByType.takeaway}`);
          console.log(`        - Delivery: ${day.ordersByType.delivery}`);
          recordTest('Has ordersByType breakdown', true);
          
          // Verify sum matches
          const typeSum = day.ordersByType.dineIn + day.ordersByType.takeaway + day.ordersByType.delivery;
          const nonCancelled = day.totalOrders - day.cancelledOrders;
          recordTest('Order type sum matches', typeSum === nonCancelled, `${typeSum} = ${nonCancelled}`);
        } else {
          recordTest('Has ordersByType breakdown', false);
        }
        
        // Check payments
        if (day.payments) {
          console.log(`      Payments: ${JSON.stringify(day.payments)}`);
          recordTest('Has payments breakdown', Object.keys(day.payments).length > 0);
        }
        
        // Check split payment breakdown
        if (day.splitPaymentBreakdown) {
          console.log(`      Split Payments: ${JSON.stringify(day.splitPaymentBreakdown)}`);
          recordTest('Has splitPaymentBreakdown', true);
        }
      }
      
      // Check grandTotal has ordersByType
      if (data.grandTotal?.ordersByType) {
        recordTest('Grand total has ordersByType', true);
      }
      
    } else {
      recordTest('API returns success', false, summaryRes.data.message);
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // PART B: Test Day End Summary Detail API
    // ══════════════════════════════════════════════════════════════
    console.log('═'.repeat(70));
    console.log('  PART B: DAY END SUMMARY DETAIL API');
    console.log('═'.repeat(70));
    console.log();

    // STEP 3: Get Day End Summary Detail
    console.log('📋 STEP 3: GET /api/v1/reports/day-end-summary/detail');
    console.log('─'.repeat(50));
    
    const detailRes = await apiRequest(
      'GET', 
      `/reports/day-end-summary/detail?outletId=${CONFIG.outletId}`,
      null,
      CONFIG.authToken
    );

    if (detailRes.data.success) {
      recordTest('Detail API returns success', true);
      
      const data = detailRes.data.data;
      
      // Check all sections exist
      recordTest('Has date', !!data.date);
      recordTest('Has summary', !!data.summary);
      recordTest('Has paymentBreakdown', !!data.paymentBreakdown);
      recordTest('Has hourlyBreakdown', Array.isArray(data.hourlyBreakdown));
      recordTest('Has categoryBreakdown', Array.isArray(data.categoryBreakdown));
      recordTest('Has topSellingItems', Array.isArray(data.topSellingItems));
      recordTest('Has staffPerformance', Array.isArray(data.staffPerformance));
      recordTest('Has floorBreakdown', Array.isArray(data.floorBreakdown));
      recordTest('Has discountsApplied', Array.isArray(data.discountsApplied));
      recordTest('Has refunds', Array.isArray(data.refunds));
      recordTest('Has cancelledOrders', Array.isArray(data.cancelledOrders));
      recordTest('Has orders', Array.isArray(data.orders));
      recordTest('Has orderCount', typeof data.orderCount === 'number');

      console.log();
      console.log('   📊 Detail Summary:');
      
      if (data.summary) {
        const s = data.summary;
        console.log(`      Date: ${data.date}`);
        console.log(`      Total Orders: ${s.totalOrders}`);
        console.log(`      Completed: ${s.completedOrders}`);
        console.log(`      Cancelled: ${s.cancelledOrders}`);
        console.log(`      Total Sales: ₹${s.totalSales}`);
        console.log(`      Net Sales: ₹${s.netSales}`);
        console.log(`      Avg Order: ₹${s.avgOrderValue?.toFixed(2)}`);
        console.log(`      Max Order: ₹${s.maxOrderValue}`);
        console.log(`      Min Order: ₹${s.minOrderValue}`);
        console.log(`      Total Refunds: ₹${s.totalRefunds}`);
        console.log(`      Total Discounts: ₹${s.totalDiscountsApplied}`);
        
        if (s.ordersByType) {
          console.log(`      Dine-in: ${s.ordersByType.dineIn}`);
          console.log(`      Takeaway: ${s.ordersByType.takeaway}`);
          console.log(`      Delivery: ${s.ordersByType.delivery}`);
        }
      }
      
      // Payment breakdown
      console.log();
      console.log('   💳 Payment Breakdown:');
      for (const [mode, info] of Object.entries(data.paymentBreakdown || {})) {
        console.log(`      ${mode}: ${info.count} transactions, ₹${info.amount}`);
      }
      
      // Hourly breakdown
      if (data.hourlyBreakdown && data.hourlyBreakdown.length > 0) {
        console.log();
        console.log('   ⏰ Hourly Breakdown (sample):');
        data.hourlyBreakdown.slice(0, 3).forEach(h => {
          console.log(`      ${h.timeSlot}: ${h.orderCount} orders, ₹${h.sales}`);
        });
        recordTest('Hourly breakdown has data', data.hourlyBreakdown.length > 0);
      }
      
      // Category breakdown
      if (data.categoryBreakdown && data.categoryBreakdown.length > 0) {
        console.log();
        console.log('   📁 Category Sales (top 3):');
        data.categoryBreakdown.slice(0, 3).forEach(c => {
          console.log(`      ${c.categoryName}: ${c.totalQuantity} items, ₹${c.totalSales}`);
        });
        recordTest('Category breakdown has data', data.categoryBreakdown.length > 0);
      }
      
      // Top selling items
      if (data.topSellingItems && data.topSellingItems.length > 0) {
        console.log();
        console.log('   🏆 Top Selling Items (top 3):');
        data.topSellingItems.slice(0, 3).forEach(i => {
          console.log(`      ${i.itemName}: ${i.quantitySold} qty, ₹${i.totalSales}`);
        });
        recordTest('Top items has data', data.topSellingItems.length > 0);
      }
      
      // Staff performance
      if (data.staffPerformance && data.staffPerformance.length > 0) {
        console.log();
        console.log('   👨‍💼 Staff Performance:');
        data.staffPerformance.forEach(s => {
          console.log(`      ${s.userName} (${s.roleName}): ${s.ordersHandled} orders, ₹${s.totalSales}`);
        });
        recordTest('Staff performance has data', data.staffPerformance.length > 0);
      }
      
      // Floor breakdown
      if (data.floorBreakdown && data.floorBreakdown.length > 0) {
        console.log();
        console.log('   🏢 Floor Breakdown:');
        data.floorBreakdown.forEach(f => {
          console.log(`      ${f.floorName} (${f.orderType}): ${f.orderCount} orders, ₹${f.sales}`);
        });
        recordTest('Floor breakdown has data', data.floorBreakdown.length > 0);
      }
      
      // Cancelled orders
      if (data.cancelledOrders && data.cancelledOrders.length > 0) {
        console.log();
        console.log(`   ❌ Cancelled Orders: ${data.cancelledOrders.length}`);
        data.cancelledOrders.slice(0, 2).forEach(c => {
          console.log(`      ${c.orderNumber}: ₹${c.totalAmount} - ${c.cancelReason || 'No reason'}`);
        });
      }
      
      // Orders list
      console.log();
      console.log(`   📋 Total Orders in Detail: ${data.orderCount}`);
      
    } else {
      recordTest('Detail API returns success', false, detailRes.data.message);
    }
    console.log();

    // ══════════════════════════════════════════════════════════════
    // PART C: Data Accuracy Verification
    // ══════════════════════════════════════════════════════════════
    console.log('═'.repeat(70));
    console.log('  PART C: DATA ACCURACY VERIFICATION');
    console.log('═'.repeat(70));
    console.log();

    // Compare summary and detail data
    console.log('📋 STEP 4: Cross-verify Summary vs Detail');
    console.log('─'.repeat(50));
    
    if (summaryRes.data.success && detailRes.data.success) {
      const summaryData = summaryRes.data.data.days[0] || {};
      const detailData = detailRes.data.data.summary || {};
      
      const checks = [
        ['totalOrders', summaryData.totalOrders, detailData.totalOrders],
        ['completedOrders', summaryData.completedOrders, detailData.completedOrders],
        ['cancelledOrders', summaryData.cancelledOrders, detailData.cancelledOrders],
        ['totalSales', summaryData.totalSales, detailData.totalSales],
        ['totalDiscount', summaryData.totalDiscount, detailData.totalDiscount],
        ['totalTax', summaryData.totalTax, detailData.totalTax],
      ];
      
      for (const [field, summaryVal, detailVal] of checks) {
        const match = summaryVal === detailVal;
        recordTest(`${field} matches`, match, `Summary: ${summaryVal}, Detail: ${detailVal}`);
      }
      
      // Verify ordersByType in both
      if (summaryData.ordersByType && detailData.ordersByType) {
        const dineInMatch = summaryData.ordersByType.dineIn === detailData.ordersByType.dineIn;
        const takeawayMatch = summaryData.ordersByType.takeaway === detailData.ordersByType.takeaway;
        const deliveryMatch = summaryData.ordersByType.delivery === detailData.ordersByType.delivery;
        
        recordTest('dineIn count matches', dineInMatch);
        recordTest('takeaway count matches', takeawayMatch);
        recordTest('delivery count matches', deliveryMatch);
      }
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
