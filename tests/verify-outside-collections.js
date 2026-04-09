/**
 * Verification Script: Outside Collections Feature
 * Tests all CRUD operations, shift integration, and report integration.
 * 
 * Usage: node tests/verify-outside-collections.js
 * Requires: Server running on localhost:3000
 */

const http = require('http');

// ── Config ──
const BASE_URL = 'http://localhost:3005';
const OUTLET_ID = 43;
const FLOOR_BAR = 38;
const FLOOR_REST = 39;
const CASHIER_ID = 201; // Aditya

// You'll need a valid auth token — get one via login
let AUTH_TOKEN = '';

// ── HTTP helpers ──
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {})
      }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const get = (path) => request('GET', path);
const post = (path, body) => request('POST', path, body);
const put = (path, body) => request('PUT', path, body);
const del = (path) => request('DELETE', path);

function check(label, condition, detail = '') {
  const icon = condition ? '✅' : '❌';
  console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

let failures = [];
let createdIds = [];

async function login() {
  console.log('\n🔑 Logging in...');
  const res = await post('/api/v1/auth/login', { email: 'aditya@restro.com', password: 'password123' });
  if (res.status === 200 && res.data?.data?.token) {
    AUTH_TOKEN = res.data.data.token;
    console.log('  ✅ Login successful');
    return true;
  }
  // Try alternative login
  const res2 = await post('/api/v1/auth/login', { phone: '9999999999', password: 'password123' });
  if (res2.status === 200 && res2.data?.data?.token) {
    AUTH_TOKEN = res2.data.data.token;
    console.log('  ✅ Login successful (phone)');
    return true;
  }
  console.log('  ❌ Login failed — set AUTH_TOKEN manually');
  console.log('  Response:', JSON.stringify(res.data).slice(0, 200));
  return false;
}

// ══════════════════════════════════════════
// TEST 1: CRUD Operations
// ══════════════════════════════════════════
async function testCRUD() {
  console.log('\n═══ TEST 1: CRUD Operations ═══');

  // 1a. CREATE — cash collection
  console.log('\n  📝 Creating cash outside collection...');
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  
  const r1 = await post(`/api/v1/orders/outside-collections/${OUTLET_ID}`, {
    amount: 5000,
    paymentMode: 'cash',
    reason: 'Party Hall Collection',
    description: 'Test: Birthday party advance payment',
    collectionDate: dateStr,
    floorId: FLOOR_REST
  });
  check('CREATE cash collection', r1.status === 201 || r1.status === 200, `status=${r1.status}`);
  const id1 = r1.data?.data?.id;
  if (id1) createdIds.push(id1);
  console.log(`    Created ID: ${id1}`);

  // 1b. CREATE — UPI collection
  const r2 = await post(`/api/v1/orders/outside-collections/${OUTLET_ID}`, {
    amount: 3000,
    paymentMode: 'upi',
    reason: 'Kitty Party Advance',
    description: 'Test: Women kitty party booking',
    collectionDate: dateStr,
    floorId: FLOOR_BAR
  });
  check('CREATE UPI collection', r2.status === 201 || r2.status === 200, `status=${r2.status}`);
  const id2 = r2.data?.data?.id;
  if (id2) createdIds.push(id2);

  // 1c. CREATE — card collection (no floor)
  const r3 = await post(`/api/v1/orders/outside-collections/${OUTLET_ID}`, {
    amount: 2000,
    paymentMode: 'card',
    reason: 'Catering Deposit',
    collectionDate: dateStr
  });
  check('CREATE card collection (no floor)', r3.status === 201 || r3.status === 200, `status=${r3.status}`);
  const id3 = r3.data?.data?.id;
  if (id3) createdIds.push(id3);

  // 1d. LIST
  console.log('\n  📋 Listing outside collections...');
  const list = await get(`/api/v1/orders/outside-collections/${OUTLET_ID}?startDate=${dateStr}&endDate=${dateStr}`);
  check('LIST collections', list.status === 200, `status=${list.status}`);
  check('LIST returns items', Array.isArray(list.data?.data?.items), `count=${list.data?.data?.items?.length}`);
  check('LIST has ≥3 items', (list.data?.data?.items?.length || 0) >= 3);

  // 1e. GET by ID
  if (id1) {
    console.log('\n  🔍 Get collection by ID...');
    const single = await get(`/api/v1/orders/outside-collections/${OUTLET_ID}/${id1}`);
    check('GET by ID', single.status === 200, `amount=${single.data?.data?.amount}`);
    check('GET amount matches', parseFloat(single.data?.data?.amount) === 5000);
    check('GET reason matches', single.data?.data?.reason === 'Party Hall Collection');
  }

  // 1f. UPDATE
  if (id1) {
    console.log('\n  ✏️ Updating collection...');
    const updated = await put(`/api/v1/orders/outside-collections/${OUTLET_ID}/${id1}`, {
      amount: 5500,
      reason: 'Party Hall Collection (Updated)'
    });
    check('UPDATE', updated.status === 200, `status=${updated.status}`);
    
    const verify = await get(`/api/v1/orders/outside-collections/${OUTLET_ID}/${id1}`);
    check('UPDATE amount changed', parseFloat(verify.data?.data?.amount) === 5500);
    check('UPDATE reason changed', verify.data?.data?.reason === 'Party Hall Collection (Updated)');
  }

  // 1g. CANCEL
  if (id3) {
    console.log('\n  🗑️ Cancelling collection...');
    const cancelled = await del(`/api/v1/orders/outside-collections/${OUTLET_ID}/${id3}`);
    check('CANCEL', cancelled.status === 200, `status=${cancelled.status}`);

    const verify = await get(`/api/v1/orders/outside-collections/${OUTLET_ID}/${id3}`);
    check('CANCEL status=cancelled', verify.data?.data?.status === 'cancelled');
  }

  return { id1, id2, id3, dateStr };
}

// ══════════════════════════════════════════
// TEST 2: Cash Drawer Status Integration
// ══════════════════════════════════════════
async function testCashDrawerStatus() {
  console.log('\n═══ TEST 2: Cash Drawer Status Integration ═══');
  const res = await get(`/api/v1/orders/cash-drawer/${OUTLET_ID}/status`);
  check('Cash drawer status API', res.status === 200, `status=${res.status}`);
  
  const data = res.data?.data;
  if (data) {
    check('Has outsideCollections section', !!data.outsideCollections);
    check('outsideCollections has total', data.outsideCollections?.total !== undefined);
    check('outsideCollections has count', data.outsideCollections?.count !== undefined);
    check('outsideCollections has items', Array.isArray(data.outsideCollections?.items));
    check('outsideCollections has paymentBreakdown', !!data.outsideCollections?.paymentBreakdown);
    check('sales.outsideCollection field exists', data.sales?.outsideCollection !== undefined);
    check('collection.outsideCollection field exists', data.collection?.outsideCollection !== undefined);
    console.log(`    Total sales: ${data.totalSales}, Outside: ${data.outsideCollections?.total}, Collection: ${data.totalCollection}`);
  }
}

// ══════════════════════════════════════════
// TEST 3: Shift History Integration
// ══════════════════════════════════════════
async function testShiftHistory() {
  console.log('\n═══ TEST 3: Shift History Integration ═══');
  const res = await get(`/api/v1/orders/shifts/${OUTLET_ID}/history?limit=2`);
  check('Shift history API', res.status === 200, `status=${res.status}`);
  
  const shifts = res.data?.data?.shifts;
  if (shifts && shifts.length > 0) {
    const s = shifts[0];
    check('Shift has outsideCollections', !!s.outsideCollections);
    check('Shift has outsideCollections.total', s.outsideCollections?.total !== undefined);
    check('collection.outsideCollection exists', s.collection?.outsideCollection !== undefined);
    console.log(`    Shift ${s.id}: totalSales=${s.totalSales}, outsideColl=${s.outsideCollections?.total}`);
  }
}

// ══════════════════════════════════════════
// TEST 4: Shift Detail Integration
// ══════════════════════════════════════════
async function testShiftDetail() {
  console.log('\n═══ TEST 4: Shift Detail Integration ═══');
  // Get latest shift ID from history
  const hist = await get(`/api/v1/orders/shifts/${OUTLET_ID}/history?limit=1`);
  const shiftId = hist.data?.data?.shifts?.[0]?.id;
  if (!shiftId) {
    console.log('  ⚠️ No shifts found, skipping');
    return;
  }
  
  const res = await get(`/api/v1/orders/shifts/${shiftId}/detail`);
  check('Shift detail API', res.status === 200, `status=${res.status}`);
  
  const data = res.data?.data;
  if (data) {
    check('Has outsideCollections section', !!data.outsideCollections);
    check('outsideCollections has items array', Array.isArray(data.outsideCollections?.items));
    check('outsideCollections has paymentBreakdown', !!data.outsideCollections?.paymentBreakdown);
    check('collection.outsideCollection exists', data.collection?.outsideCollection !== undefined);
    check('collection.totalMoneyReceived includes outside', data.collection?.totalMoneyReceived !== undefined);
    console.log(`    Shift ${shiftId}: sales=${data.totalSales}, outsideColl=${data.outsideCollections?.total}, items=${data.outsideCollections?.items?.length}`);
  }
}

// ══════════════════════════════════════════
// TEST 5: Daily Sales Report Integration
// ══════════════════════════════════════════
async function testDailySalesReport(dateStr) {
  console.log('\n═══ TEST 5: Daily Sales Report Integration ═══');
  const res = await get(`/api/v1/orders/reports/${OUTLET_ID}/daily-sales?startDate=${dateStr}&endDate=${dateStr}`);
  check('Daily sales API', res.status === 200, `status=${res.status}`);
  
  const data = res.data?.data;
  if (data) {
    check('summary has outside_collection', data.summary?.outside_collection !== undefined);
    check('summary has outside_collection_count', data.summary?.outside_collection_count !== undefined);
    check('summary.collection has outsideCollection', data.summary?.collection?.outsideCollection !== undefined);
    if (data.daily?.length > 0) {
      const day = data.daily[0];
      check('daily item has outside_collection', day.outside_collection !== undefined);
      check('daily collection.outsideCollection exists', day.collection?.outsideCollection !== undefined);
      console.log(`    Day ${day.report_date}: total_collection=${day.total_collection}, outside=${day.outside_collection}`);
    }
    console.log(`    Summary: total_sale=${data.summary?.total_sale}, outside=${data.summary?.outside_collection}`);
  }
}

// ══════════════════════════════════════════
// TEST 6: Accurate DSR Integration
// ══════════════════════════════════════════
async function testAccurateDSR(dateStr) {
  console.log('\n═══ TEST 6: Accurate DSR Integration ═══');
  const res = await get(`/api/v1/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=${dateStr}&endDate=${dateStr}`);
  check('Accurate DSR API', res.status === 200, `status=${res.status}`);
  
  const data = res.data?.data;
  if (data) {
    check('summary has outside_collection', data.summary?.outside_collection !== undefined);
    check('summary has order_sale', data.summary?.order_sale !== undefined);
    check('crossVerification has outside_collection', data.crossVerification?.outside_collection !== undefined);
    if (data.daily?.length > 0) {
      const d = data.daily[0];
      check('daily has outside_collection', d.outside_collection !== undefined);
      check('daily has order_sale', d.order_sale !== undefined);
    }
    console.log(`    Summary: total=${data.summary?.total_sale}, orders=${data.summary?.order_sale}, outside=${data.summary?.outside_collection}`);
  }
}

// ══════════════════════════════════════════
// TEST 7: Accurate Running Dashboard
// ══════════════════════════════════════════
async function testAccurateRunningDashboard(dateStr) {
  console.log('\n═══ TEST 7: Accurate Running Dashboard ═══');
  const res = await get(`/api/v1/reports/accurate-running-dashboard?outletId=${OUTLET_ID}&startDate=${dateStr}&endDate=${dateStr}`);
  check('Running Dashboard API', res.status === 200, `status=${res.status}`);
  
  const data = res.data?.data;
  if (data) {
    check('summary has outside_collection', data.summary?.outside_collection !== undefined);
    check('summary has order_sale', data.summary?.order_sale !== undefined);
    check('crossVerification has outside_collection', data.crossVerification?.outside_collection !== undefined);
    console.log(`    Summary: total=${data.summary?.total_sale}, orders=${data.summary?.order_sale}, outside=${data.summary?.outside_collection}`);
  }
}

// ══════════════════════════════════════════
// TEST 8: Accurate Day End Summary
// ══════════════════════════════════════════
async function testAccurateDayEndSummary(dateStr) {
  console.log('\n═══ TEST 8: Accurate Day End Summary ═══');
  const res = await get(`/api/v1/reports/accurate-day-end-summary?outletId=${OUTLET_ID}&startDate=${dateStr}&endDate=${dateStr}`);
  check('Day End Summary API', res.status === 200, `status=${res.status}`);
  
  const data = res.data?.data;
  if (data) {
    check('grandTotal has outside_collection', data.grandTotal?.outside_collection !== undefined);
    check('grandTotal has order_sale', data.grandTotal?.order_sale !== undefined);
    check('crossVerification has outside_collection', data.crossVerification?.outside_collection !== undefined);
    if (data.days?.length > 0) {
      const d = data.days[0];
      check('day has outside_collection', d.outside_collection !== undefined);
      check('day has order_sale', d.order_sale !== undefined);
    }
    console.log(`    Grand: total=${data.grandTotal?.total_sale}, orders=${data.grandTotal?.order_sale}, outside=${data.grandTotal?.outside_collection}`);
  }
}

// ══════════════════════════════════════════
// CLEANUP
// ══════════════════════════════════════════
async function cleanup() {
  console.log('\n═══ CLEANUP: Cancelling test collections ═══');
  for (const id of createdIds) {
    try {
      await del(`/api/v1/orders/outside-collections/${OUTLET_ID}/${id}`);
      console.log(`  Cancelled ID ${id}`);
    } catch (e) {
      console.log(`  Failed to cancel ID ${id}: ${e.message}`);
    }
  }
}

// ══════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Outside Collections Feature Verifier    ║');
  console.log('╚══════════════════════════════════════════╝');

  const loggedIn = await login();
  if (!loggedIn) {
    console.log('\n⚠️  Cannot proceed without auth. Set AUTH_TOKEN manually and re-run.');
    return;
  }

  const { dateStr } = await testCRUD();
  await testCashDrawerStatus();
  await testShiftHistory();
  await testShiftDetail();
  await testDailySalesReport(dateStr);
  await testAccurateDSR(dateStr);
  await testAccurateRunningDashboard(dateStr);
  await testAccurateDayEndSummary(dateStr);
  await cleanup();

  // ── Summary ──
  console.log('\n╔══════════════════════════════════════════╗');
  if (failures.length === 0) {
    console.log('║  ✅ ALL TESTS PASSED                     ║');
  } else {
    console.log(`║  ❌ ${failures.length} TEST(S) FAILED                    ║`);
    failures.forEach(f => console.log(`║    - ${f}`));
  }
  console.log('╚══════════════════════════════════════════╝\n');
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
