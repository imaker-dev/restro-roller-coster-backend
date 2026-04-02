/**
 * Verification script for adjustment payment fix.
 * Pure source-code verification — no DB connection needed.
 * Tests that all APIs correctly handle adjustment vs due logic:
 * - If is_adjustment=1 and adjustment_amount>0 → fully paid, no due
 * - If is_adjustment=0 and paid_amount < total_amount → due
 * 
 * Run: node src/tests/verify-adjustment-fix.js
 */

const fs = require('fs');
const path = require('path');

const PASS = '\u2713 PASS';
const FAIL = '\u2717 FAIL';
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${PASS}: ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL}: ${label}`);
    failed++;
  }
}

function readSvc(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'services', name), 'utf8');
}

console.log('\n========================================');
console.log('  ADJUSTMENT FIX VERIFICATION');
console.log('========================================\n');

const paymentSrc = readSvc('payment.service.js');
const billingSrc = readSvc('billing.service.js');
const customerSrc = readSvc('customer.service.js');
const adjSrc = readSvc('adjustmentReport.service.js');
const orderSrc = readSvc('order.service.js');
const reportsSrc = readSvc('reports.service.js');

// ---- 1. processPayment / processSplitPayment ----
console.log('1. processPayment / processSplitPayment:');

// Invoice UPDATE must NOT have is_adjustment (column doesn't exist on invoices)
const invoiceUpdateLines = paymentSrc.match(/UPDATE invoices SET.*?WHERE id/gs) || [];
const brokenUpdates = invoiceUpdateLines.filter(l => l.includes('is_adjustment'));
assert(brokenUpdates.length === 0,
  'Invoice UPDATE does NOT reference is_adjustment column (column does not exist on invoices)');

// Invoice UPDATE DOES include adjustment_amount
const goodUpdates = invoiceUpdateLines.filter(l => l.includes('adjustment_amount'));
assert(goodUpdates.length >= 2,
  'Invoice UPDATE includes adjustment_amount in both functions');

// Orders UPDATE includes is_adjustment
const orderUpdateMatch = paymentSrc.match(/UPDATE orders SET[\s\S]*?is_adjustment[\s\S]*?WHERE id/g);
assert(orderUpdateMatch && orderUpdateMatch.length >= 2,
  'Orders UPDATE includes is_adjustment in both functions');

// Adjustment → paymentStatus = completed
assert(paymentSrc.includes("paymentStatus = 'completed'") && paymentSrc.includes("orderStatus = 'completed'"),
  'Adjustment sets paymentStatus=completed and orderStatus=completed');

// bill:status event includes isAdjustment
const billStatusAdjMatch = paymentSrc.match(/bill:status[\s\S]*?isAdjustment/g);
assert(billStatusAdjMatch && billStatusAdjMatch.length >= 2,
  'bill:status realtime event includes isAdjustment in both functions');

// payment_adjustments INSERT exists
assert(paymentSrc.includes('INSERT INTO payment_adjustments'),
  'processPayment creates payment_adjustments record');

// ---- 2. formatInvoice ----
console.log('\n2. formatInvoice (billing.service.js):');
assert(billingSrc.includes('isAdjustment: !!invoice.is_adjustment || (parseFloat(invoice.adjustment_amount) || 0) > 0'),
  'formatInvoice derives isAdjustment from column OR adjustment_amount > 0');
assert(billingSrc.includes('adjustmentAmount: parseFloat(invoice.adjustment_amount)'),
  'formatInvoice includes adjustmentAmount field');

// ---- 3. formatPaymentEntry ----
console.log('\n3. formatPaymentEntry (billing.service.js):');
assert(billingSrc.includes('isAdjustment: !!payment.is_adjustment'),
  'formatPaymentEntry includes isAdjustment field');
assert(billingSrc.includes('adjustmentAmount: parseFloat(payment.adjustment_amount)'),
  'formatPaymentEntry includes adjustmentAmount field');

// ---- 4. Captain detail ----
console.log('\n4. Captain detail (order.service.js):');
assert(orderSrc.includes('adjustmentSummary'),
  'Captain detail includes adjustmentSummary object');
assert(orderSrc.includes("isAdjustment: !!order.is_adjustment"),
  'adjustmentSummary has isAdjustment from order');
assert(orderSrc.includes('SELECT o.*') && orderSrc.includes('getCaptainOrderDetail'),
  'Captain detail uses SELECT o.* (includes all order columns)');

// ---- 5. Customer service ----
console.log('\n5. Customer service:');
assert(customerSrc.includes('o.is_adjustment, o.adjustment_amount'),
  'Customer order queries include is_adjustment and adjustment_amount');

const custAdjMap = customerSrc.match(/isAdjustment:.*!!o\.is_adjustment/g);
assert(custAdjMap && custAdjMap.length >= 2,
  'isAdjustment mapped in both getOrderHistory and getCustomerDetails');

assert(customerSrc.includes('dueBalance: parseFloat(r.total_due)'),
  'Customer list dueBalance from recalculated total_due');

assert(customerSrc.includes('dueBalance: parseFloat(customerRow.total_due)'),
  'Customer details dueBalance from recalculated total_due');

assert(customerSrc.includes("o.due_amount > 0 AND o.status != 'cancelled'"),
  'listWithDue filters orders with due_amount > 0 (excludes adjustments where due=0)');

// ---- 6. Shift detail + summary ----
console.log('\n6. Shift detail + summary:');
assert(paymentSrc.includes('isAdjustment: !!row.is_adjustment'),
  'Shift detail orders include isAdjustment');
assert(paymentSrc.includes('adjustmentAmount: parseFloat(row.adjustment_amount)'),
  'Shift detail orders include adjustmentAmount');

const adjCountMatch = paymentSrc.match(/adjustmentCount:.*parseInt.*adjustment_count/g);
assert(adjCountMatch && adjCountMatch.length >= 2,
  'Both shift detail and summary orderStats include adjustmentCount');

// ---- 7. Daily sales detail ----
console.log('\n7. Daily sales detail (reports.service.js):');
assert(reportsSrc.includes('o.adjustment_amount, o.is_adjustment'),
  'Daily sales detail SELECT includes adjustment fields');
assert(reportsSrc.includes("isAdjustment: !!o.is_adjustment") && reportsSrc.includes("adjustmentAmount: parseFloat(o.adjustment_amount)"),
  'Daily sales detail order formatter includes adjustment fields');

// ---- 8. Day-End Summary ----
console.log('\n8. Day-End Summary (reports.service.js):');
// Check the orders list query includes adjustment fields
const dayEndOrderQuery = reportsSrc.match(/o\.is_adjustment, o\.adjustment_amount[\s\S]*?created_by_name[\s\S]*?p\.payment_mode/);
assert(!!dayEndOrderQuery,
  'Day-End Summary orders query includes is_adjustment and adjustment_amount');

// Check the orders formatter includes adjustment fields  
assert(reportsSrc.includes("isAdjustment: !!o.is_adjustment") && reportsSrc.includes("adjustmentAmount: parseFloat(o.adjustment_amount)"),
  'Day-End Summary orders formatter includes adjustment fields');

// Check summary stats include adjustment counts
assert(reportsSrc.includes("adjustmentCount: parseInt(summary.adjustment_count)"),
  'Day-End Summary has adjustmentCount in summary');

// ---- 9. GET /api/v1/orders/:id (getOrderWithItems) ----
console.log('\n9. GET /api/v1/orders/:id (order.service.js):');
assert(orderSrc.includes('isAdjustment: !!order.is_adjustment'),
  'Order response includes isAdjustment field');
assert(orderSrc.includes('adjustmentAmount: parseFloat(order.adjustment_amount)'),
  'Order response includes adjustmentAmount field');
assert(orderSrc.includes('dueAmount: parseFloat(order.due_amount)'),
  'Order response includes dueAmount field');
assert(orderSrc.includes('isAdjustment: !!payment.is_adjustment'),
  'Payment entries include isAdjustment field');
assert(orderSrc.includes('isDueCollection: !!payment.is_due_collection'),
  'Payment entries include isDueCollection field');
assert(orderSrc.includes('adjustmentAmount: parseFloat(inv.adjustment_amount)'),
  'Invoice in order response includes adjustmentAmount');
assert(orderSrc.includes('dueAmount: parseFloat(inv.due_amount)'),
  'Invoice in order response includes dueAmount');

// ---- 10. Joi validation includes adjustment fields ----
console.log('\n10. Joi validation:');
const validationSrc = fs.readFileSync(path.join(__dirname, '..', 'validations', 'order.validation.js'), 'utf8');
assert(validationSrc.includes('adjustment:') && validationSrc.includes('adjustmentAmount:'),
  'processPayment validation includes adjustment and adjustmentAmount');
assert(validationSrc.includes('adjustmentReason:'),
  'processPayment validation includes adjustmentReason');
// Check splitPayment also has adjustment fields
const splitSection = validationSrc.substring(validationSrc.indexOf('splitPayment'));
assert(splitSection.includes('adjustment:') && splitSection.includes('adjustmentAmount:'),
  'splitPayment validation includes adjustment and adjustmentAmount');

// ---- 11. Due collection: only create due on first partial payment ----
console.log('\n11. Due collection logic:');
assert(paymentSrc.includes('previousDue <= 0'),
  'createDueTransaction only fires when previousDue <= 0 (first partial payment)');
const previousDueBeforeCreate = paymentSrc.match(/const previousDue[\s\S]*?createDueTransaction/g);
assert(previousDueBeforeCreate && previousDueBeforeCreate.length >= 2,
  'previousDue is read BEFORE createDueTransaction in both functions');

// ---- 12. isAdjustment hoisted before try block ----
console.log('\n12. Variable scoping:');
// In processPayment, the destructuring should be before try {, not inside it
const processPaymentBlock = paymentSrc.substring(
  paymentSrc.indexOf('async processPayment(data)'),
  paymentSrc.indexOf('async processSplitPayment(data)')
);
const tryIdx = processPaymentBlock.indexOf('try {');
const isAdjIdx = processPaymentBlock.indexOf('const isAdjustment =');
assert(isAdjIdx < tryIdx,
  'processPayment: isAdjustment declared BEFORE try block (accessible in event publishing)');

// ---- 13. Adjustment report service ----
console.log('\n13. Adjustment report service:');
assert(adjSrc.includes('FROM payment_adjustments pa'),
  'Adjustment report queries payment_adjustments table');
assert(adjSrc.includes('adjustmentAmount: parseFloat(r.adjustment_amount)'),
  'Adjustment report response includes adjustmentAmount');
assert(adjSrc.includes('exportAdjustments'),
  'Adjustment report has CSV export function');

// ---- Summary ----
console.log('\n========================================');
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) {
  console.log('FAILED CHECKS NEED ATTENTION!\n');
}

console.log('NEXT STEPS:');
console.log('  1. Server should auto-restart via nodemon');
console.log('  2. Test payment with adjustment=true on a billed order');
console.log('  3. Test partial payment (adjustment=false, amount < total)');
console.log('  4. Test second payment on a partial order (due collection)');
console.log('  5. Verify GET /api/v1/orders/:id includes adjustment + due fields');
console.log('  6. Check all report APIs show correct due data\n');

process.exit(failed > 0 ? 1 : 0);
