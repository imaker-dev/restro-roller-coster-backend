/**
 * Test: POS User Shift & Order Access
 * 
 * Verifies that pos_user has the same access as cashier for:
 * 1. Cash drawer open/close/status (shift management)
 * 2. Order history (viewAllFloorOrders)
 * 3. Bills (pending, captain bills)
 * 4. Takeaway orders
 * 
 * Run: node tests/_verify_pos_user_shift_access.js
 */

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

// Read route file
const routesPath = path.join(__dirname, '../src/routes/order.routes.js');
const routesContent = fs.readFileSync(routesPath, 'utf8');

// Read controller file
const controllerPath = path.join(__dirname, '../src/controllers/order.controller.js');
const controllerContent = fs.readFileSync(controllerPath, 'utf8');

// Read billing service file
const billingServicePath = path.join(__dirname, '../src/services/billing.service.js');
const billingServiceContent = fs.readFileSync(billingServicePath, 'utf8');

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  POS USER SHIFT & ORDER ACCESS VERIFICATION');
console.log('═══════════════════════════════════════════════════════════════\n');

// ═══════════════════════════════════════════════════════════════
// TEST 1: Cash Drawer Routes
// ═══════════════════════════════════════════════════════════════
console.log('── TEST 1: Cash Drawer Routes ──');

// Check cash-drawer/open has pos_user
const openMatch = routesContent.match(/cash-drawer.*open.*authorize\([^)]+\)/s);
ok(openMatch && openMatch[0].includes('pos_user'), 'cash-drawer/:outletId/open has pos_user');

// Check cash-drawer/close has pos_user
const closeMatch = routesContent.match(/cash-drawer.*close.*authorize\([^)]+\)/s);
ok(closeMatch && closeMatch[0].includes('pos_user'), 'cash-drawer/:outletId/close has pos_user');

// Check cash-drawer/status has pos_user
const statusMatch = routesContent.match(/cash-drawer.*status.*authorize\([^)]+\)/s);
ok(statusMatch && statusMatch[0].includes('pos_user'), 'cash-drawer/:outletId/status has pos_user');

// ═══════════════════════════════════════════════════════════════
// TEST 2: Captain Bills Route
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 2: Captain Bills Route ──');

const captainBillsMatch = routesContent.match(/captain\/bills.*authorize\([^)]+\)/s);
ok(captainBillsMatch && captainBillsMatch[0].includes('pos_user'), 'captain/bills/:outletId has pos_user');

// ═══════════════════════════════════════════════════════════════
// TEST 3: Captain Order History Route
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 3: Captain Order History Route ──');

const captainHistoryMatch = routesContent.match(/captain\/history.*authorize\([^)]+\)/s);
ok(captainHistoryMatch && captainHistoryMatch[0].includes('pos_user'), 'captain/history/:outletId has pos_user');

// ═══════════════════════════════════════════════════════════════
// TEST 4: Captain Stats Route
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 4: Captain Stats Route ──');

const captainStatsMatch = routesContent.match(/captain\/stats.*authorize\([^)]+\)/s);
ok(captainStatsMatch && captainStatsMatch[0].includes('pos_user'), 'captain/stats/:outletId has pos_user');

// ═══════════════════════════════════════════════════════════════
// TEST 5: Captain Detail Route
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 5: Captain Detail Route ──');

const captainDetailMatch = routesContent.match(/captain\/detail.*authorize\([^)]+\)/s);
ok(captainDetailMatch && captainDetailMatch[0].includes('pos_user'), 'captain/detail/:orderId has pos_user');

// ═══════════════════════════════════════════════════════════════
// TEST 6: Pending Bills Route
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 6: Pending Bills Route ──');

const pendingBillsMatch = routesContent.match(/bills\/pending.*authorize\([^)]+\)/s);
ok(pendingBillsMatch && pendingBillsMatch[0].includes('pos_user'), 'bills/pending/:outletId has pos_user');

// ═══════════════════════════════════════════════════════════════
// TEST 7: Takeaway Routes
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 7: Takeaway Routes ──');

const takeawayPendingMatch = routesContent.match(/takeaway\/pending.*authorize\([^)]+\)/s);
ok(takeawayPendingMatch && takeawayPendingMatch[0].includes('pos_user'), 'takeaway/pending/:outletId has pos_user');

const takeawayDetailMatch = routesContent.match(/takeaway\/detail.*authorize\([^)]+\)/s);
ok(takeawayDetailMatch && takeawayDetailMatch[0].includes('pos_user'), 'takeaway/detail/:id has pos_user');

// ═══════════════════════════════════════════════════════════════
// TEST 8: Controller - isCashier includes pos_user
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 8: Controller isCashier Logic ──');

// Check getCaptainBills controller
const billsControllerMatch = controllerContent.match(/getCaptainBills[\s\S]*?isCashier\s*=\s*[^;]+/);
ok(billsControllerMatch && billsControllerMatch[0].includes('pos_user'), 'getCaptainBills: isCashier includes pos_user');

// Check getCaptainOrderHistory controller
const historyControllerMatch = controllerContent.match(/getCaptainOrderHistory[\s\S]*?isCashier\s*=\s*[^;]+/);
ok(historyControllerMatch && historyControllerMatch[0].includes('pos_user'), 'getCaptainOrderHistory: isCashier includes pos_user');

// ═══════════════════════════════════════════════════════════════
// TEST 9: Billing Service - viewAllFloorOrders support
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 9: Billing Service viewAllFloorOrders ──');

const billingServiceMatch = billingServiceContent.match(/getCaptainBills[\s\S]*?viewAllFloorOrders/);
ok(billingServiceMatch, 'getCaptainBills service supports viewAllFloorOrders');

// ═══════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ✅ Passed: ${pass}   │   ❌ Failed: ${fail}`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (fail > 0) {
  console.log('❌ Some tests failed!\n');
  process.exit(1);
} else {
  console.log('✅ All POS user access tests passed!\n');
  process.exit(0);
}
