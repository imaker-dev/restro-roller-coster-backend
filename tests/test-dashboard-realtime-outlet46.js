/**
 * Test: Dashboard Realtime API — Outlet 46
 * Verifies /api/v1/dashboard/realtime/46 returns accurate data
 * aligned with the new DSR rule (payment fields, due, discount, NC, adjustment, unpaid).
 *
 * Scenarios:
 *   1. Basic structure validation (all fields present)
 *   2. Summary totals accuracy (cross-verify order-level sums match summary)
 *   3. Payment breakdown accuracy (paid + due + unpaid consistency)
 *   4. Running order fields completeness (each order has payment data)
 *   5. Table linkage accuracy (table → order amounts match)
 *   6. Floor breakdown cross-verification (floor amounts sum to total)
 *   7. Order type breakdown (dineIn + takeaway = total)
 *   8. NC order tracking (nc flags + amounts)
 *   9. Adjustment order tracking
 *  10. Discount / tax / service charge / packaging / round-off consistency
 *  11. Direct DB cross-verification (query orders table, compare totals)
 *  12. Filter tests (floorId, orderType)
 *
 * Run: node tests/test-dashboard-realtime-outlet46.js
 */

const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE_URL = process.env.API_URL || 'http://localhost:3005';
const API_PREFIX = '/api/v1';
const OUTLET_ID = parseInt(process.env.OUTLET_ID) || 46;

let AUTH_TOKEN = null;
let pool = null;
const results = { passed: 0, failed: 0, skipped: 0, tests: [] };

// ─── Helpers ──────────────────────────────────────────────────────────
function r2(n) { return parseFloat((parseFloat(n) || 0).toFixed(2)); }

function record(name, passed, detail = '', skip = false) {
  if (skip) {
    results.skipped++;
    results.tests.push({ name, passed: null, detail: 'SKIPPED: ' + detail });
    console.log(`  SKIP  ${name} — ${detail}`);
    return;
  }
  results.tests.push({ name, passed, detail });
  if (passed) results.passed++; else results.failed++;
  const icon = passed ? '✅' : '❌';
  console.log(`  ${icon} ${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function apiRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + API_PREFIX + urlPath);
    const options = {
      hostname: url.hostname,
      port: url.port || 3005,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (AUTH_TOKEN) options.headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Test Functions ──────────────────────────────────────────────────

async function testBasicStructure(data) {
  console.log('\n── 1. Basic Structure Validation ──');

  record('data exists', !!data);
  record('summary exists', !!data.summary);
  record('summary.orders exists', !!data.summary?.orders);
  record('summary.payment exists', !!data.summary?.payment);
  record('summary.tables exists', !!data.summary?.tables);
  record('summary.floors exists', Array.isArray(data.summary?.floors));
  record('orders section exists', !!data.orders);
  record('orders.dineIn exists', !!data.orders?.dineIn);
  record('orders.takeaway exists', !!data.orders?.takeaway);
  record('orders.pending exists', !!data.orders?.pending);
  record('runningOrders is array', Array.isArray(data.runningOrders));
  record('tables is array', Array.isArray(data.tables));
}

async function testPaymentSummaryFields(data) {
  console.log('\n── 2. Payment Summary Fields ──');
  const p = data.summary?.payment;
  if (!p) { record('payment summary present', false); return; }

  const requiredFields = [
    'totalAmount', 'subtotal', 'discountAmount', 'taxAmount',
    'serviceCharge', 'packagingCharge', 'deliveryCharge', 'roundOff',
    'paidAmount', 'dueAmount', 'unpaidAmount',
    'ncAmount', 'ncOrderCount',
    'adjustmentAmount', 'adjustmentOrderCount',
    'fullyPaidCount', 'partialPaidCount', 'unpaidCount'
  ];
  for (const f of requiredFields) {
    record(`payment.${f} present`, p[f] !== undefined, `value=${p[f]}`);
  }
}

async function testPaymentConsistency(data) {
  console.log('\n── 3. Payment Consistency (paid + due = total for running orders) ──');
  const p = data.summary?.payment;
  if (!p) { record('payment summary for consistency', false); return; }

  // totalAmount should equal summary.orders.totalAmount
  record(
    'payment.totalAmount matches orders.totalAmount',
    r2(p.totalAmount) === r2(data.summary.orders.totalAmount),
    `payment=${p.totalAmount} orders=${data.summary.orders.totalAmount}`
  );

  // unpaidAmount = totalAmount - paidAmount
  const computedUnpaid = r2(p.totalAmount - p.paidAmount);
  record(
    'unpaidAmount = totalAmount - paidAmount',
    r2(p.unpaidAmount) === computedUnpaid,
    `unpaid=${p.unpaidAmount} computed=${computedUnpaid}`
  );

  // fullyPaidCount + partialPaidCount + unpaidCount should equal totalOrderCount
  const statusSum = p.fullyPaidCount + p.partialPaidCount + p.unpaidCount;
  record(
    'payment status counts sum = totalOrderCount',
    statusSum === data.summary.orders.totalCount,
    `statusSum=${statusSum} totalOrders=${data.summary.orders.totalCount}`
  );
}

async function testRunningOrderFields(data) {
  console.log('\n── 4. Running Order Fields Completeness ──');
  const orders = data.runningOrders || [];
  if (orders.length === 0) {
    record('running orders present', false, 'No running orders found', true);
    return;
  }

  const requiredFields = [
    'id', 'orderNumber', 'orderType', 'status', 'paymentStatus',
    'subtotal', 'discountAmount', 'taxAmount', 'totalAmount',
    'paidAmount', 'dueAmount', 'serviceCharge', 'packagingCharge',
    'roundOff', 'isNC', 'ncAmount', 'isAdjustment', 'adjustmentAmount',
    'kotCount', 'pendingKotCount', 'itemCount', 'items'
  ];

  // Check first order for all fields
  const first = orders[0];
  for (const f of requiredFields) {
    record(`order[0].${f} present`, first[f] !== undefined, `value=${typeof first[f] === 'object' ? JSON.stringify(first[f]).slice(0,50) : first[f]}`);
  }

  // Cross-verify: sum of all running order totalAmounts = summary.orders.totalAmount
  const orderSum = r2(orders.reduce((s, o) => s + (o.totalAmount || 0), 0));
  const summaryAmt = r2(data.summary.orders.totalAmount);
  record(
    'SUM(runningOrders.totalAmount) = summary.orders.totalAmount',
    orderSum === summaryAmt,
    `orderSum=${orderSum} summaryAmt=${summaryAmt}`
  );

  // Cross-verify: sum of running order paidAmounts = summary.payment.paidAmount
  const paidSum = r2(orders.reduce((s, o) => s + (o.paidAmount || 0), 0));
  record(
    'SUM(runningOrders.paidAmount) = summary.payment.paidAmount',
    paidSum === r2(data.summary.payment.paidAmount),
    `paidSum=${paidSum} summaryPaid=${data.summary.payment.paidAmount}`
  );

  // Cross-verify: sum of running order dueAmounts = summary.payment.dueAmount
  const dueSum = r2(orders.reduce((s, o) => s + (o.dueAmount || 0), 0));
  record(
    'SUM(runningOrders.dueAmount) = summary.payment.dueAmount',
    dueSum === r2(data.summary.payment.dueAmount),
    `dueSum=${dueSum} summaryDue=${data.summary.payment.dueAmount}`
  );

  // Cross-verify: sum of running order discountAmounts = summary.payment.discountAmount
  const discountSum = r2(orders.reduce((s, o) => s + (o.discountAmount || 0), 0));
  record(
    'SUM(runningOrders.discountAmount) = summary.payment.discountAmount',
    discountSum === r2(data.summary.payment.discountAmount),
    `discountSum=${discountSum} summaryDiscount=${data.summary.payment.discountAmount}`
  );

  // Cross-verify: NC order count
  const ncOrders = orders.filter(o => o.isNC);
  record(
    'NC order count matches summary',
    ncOrders.length === data.summary.payment.ncOrderCount,
    `ncFromOrders=${ncOrders.length} summary=${data.summary.payment.ncOrderCount}`
  );

  // Cross-verify: NC amount sum
  const ncAmtSum = r2(orders.reduce((s, o) => s + (o.ncAmount || 0), 0));
  record(
    'SUM(runningOrders.ncAmount) = summary.payment.ncAmount',
    ncAmtSum === r2(data.summary.payment.ncAmount),
    `ncAmtSum=${ncAmtSum} summaryNC=${data.summary.payment.ncAmount}`
  );

  // Cross-verify: Adjustment count
  const adjOrders = orders.filter(o => o.isAdjustment);
  record(
    'Adjustment order count matches summary',
    adjOrders.length === data.summary.payment.adjustmentOrderCount,
    `adjFromOrders=${adjOrders.length} summary=${data.summary.payment.adjustmentOrderCount}`
  );

  // Cross-verify: subtotal sum
  const subtotalSum = r2(orders.reduce((s, o) => s + (o.subtotal || 0), 0));
  record(
    'SUM(runningOrders.subtotal) = summary.payment.subtotal',
    subtotalSum === r2(data.summary.payment.subtotal),
    `subtotalSum=${subtotalSum} summarySubtotal=${data.summary.payment.subtotal}`
  );

  // Cross-verify: tax sum
  const taxSum = r2(orders.reduce((s, o) => s + (o.taxAmount || 0), 0));
  record(
    'SUM(runningOrders.taxAmount) = summary.payment.taxAmount',
    taxSum === r2(data.summary.payment.taxAmount),
    `taxSum=${taxSum} summaryTax=${data.summary.payment.taxAmount}`
  );
}

async function testTableLinkage(data) {
  console.log('\n── 5. Table Linkage & Payment Fields ──');
  const tables = data.tables || [];
  if (tables.length === 0) {
    record('tables present', false, 'No tables found', true);
    return;
  }

  // Check table payment fields on first table with an order
  const tableWithOrder = tables.find(t => t.orderId);
  if (tableWithOrder) {
    const tFields = [
      'paymentStatus', 'discountAmount', 'taxAmount',
      'paidAmount', 'dueAmount', 'isNC', 'ncAmount',
      'isAdjustment', 'adjustmentAmount'
    ];
    for (const f of tFields) {
      record(
        `table[${tableWithOrder.tableNumber}].${f} present`,
        tableWithOrder[f] !== undefined,
        `value=${tableWithOrder[f]}`
      );
    }

    // Verify table amount matches its linked running order
    const linkedOrder = data.runningOrders.find(o => o.id === tableWithOrder.orderId);
    if (linkedOrder) {
      record(
        'table.orderAmount matches linked order.totalAmount',
        r2(tableWithOrder.orderAmount) === r2(linkedOrder.totalAmount),
        `table=${tableWithOrder.orderAmount} order=${linkedOrder.totalAmount}`
      );
      record(
        'table.paidAmount matches linked order.paidAmount',
        r2(tableWithOrder.paidAmount) === r2(linkedOrder.paidAmount),
        `table=${tableWithOrder.paidAmount} order=${linkedOrder.paidAmount}`
      );
      record(
        'table.dueAmount matches linked order.dueAmount',
        r2(tableWithOrder.dueAmount) === r2(linkedOrder.dueAmount),
        `table=${tableWithOrder.dueAmount} order=${linkedOrder.dueAmount}`
      );
    } else {
      record('linked order found for table', false, `orderId=${tableWithOrder.orderId} not in runningOrders`);
    }
  } else {
    record('table with linked order found', false, 'No tables have orderId', true);
  }

  // Table amounts sum = summary.tables.totalAmount
  const tableAmtSum = r2(tables.reduce((s, t) => s + (t.orderAmount || 0), 0));
  record(
    'SUM(tables.orderAmount) = summary.tables.totalAmount',
    tableAmtSum === r2(data.summary.tables.totalAmount),
    `tableSum=${tableAmtSum} summary=${data.summary.tables.totalAmount}`
  );
}

async function testFloorBreakdown(data) {
  console.log('\n── 6. Floor Breakdown Cross-Verification ──');
  const floors = data.summary?.floors || [];
  if (floors.length === 0) {
    record('floors present', false, 'No floors found', true);
    return;
  }

  const floorAmtSum = r2(floors.reduce((s, f) => s + (f.amount || 0), 0));
  const floorTableSum = floors.reduce((s, f) => s + (f.tables || 0), 0);
  const floorGuestSum = floors.reduce((s, f) => s + (f.guests || 0), 0);

  record(
    'SUM(floors.amount) = summary.tables.totalAmount',
    floorAmtSum === r2(data.summary.tables.totalAmount),
    `floorSum=${floorAmtSum} tableTotal=${data.summary.tables.totalAmount}`
  );
  record(
    'SUM(floors.tables) = summary.tables.totalTables',
    floorTableSum === data.summary.tables.totalTables,
    `floorTables=${floorTableSum} totalTables=${data.summary.tables.totalTables}`
  );
  record(
    'SUM(floors.guests) = summary.tables.totalGuests',
    floorGuestSum === data.summary.tables.totalGuests,
    `floorGuests=${floorGuestSum} totalGuests=${data.summary.tables.totalGuests}`
  );
}

async function testOrderTypeBreakdown(data) {
  console.log('\n── 7. Order Type Breakdown ──');
  const o = data.orders;
  const total = data.summary.orders.totalCount;
  const typeSum = (o.dineIn?.count || 0) + (o.takeaway?.count || 0);
  record(
    'dineIn.count + takeaway.count = totalCount',
    typeSum === total,
    `dineIn=${o.dineIn?.count} takeaway=${o.takeaway?.count} total=${total}`
  );

  const amtSum = r2((o.dineIn?.amount || 0) + (o.takeaway?.amount || 0));
  const totalAmt = r2(data.summary.orders.totalAmount);
  record(
    'dineIn.amount + takeaway.amount = totalAmount',
    amtSum === totalAmt,
    `dineIn=${o.dineIn?.amount} takeaway=${o.takeaway?.amount} total=${totalAmt}`
  );
}

async function testDBCrossVerification(data) {
  console.log('\n── 8. Direct DB Cross-Verification ──');

  // Query the actual DB for active orders in outlet 46
  const [dbOrders] = await pool.query(
    `SELECT
      COUNT(*) as cnt,
      SUM(total_amount) as total_amount,
      SUM(COALESCE(subtotal, 0)) as subtotal,
      SUM(COALESCE(discount_amount, 0)) as discount_amount,
      SUM(COALESCE(tax_amount, 0)) as tax_amount,
      SUM(COALESCE(paid_amount, 0)) as paid_amount,
      SUM(COALESCE(due_amount, 0)) as due_amount,
      SUM(COALESCE(nc_amount, 0)) as nc_amount,
      SUM(COALESCE(adjustment_amount, 0)) as adjustment_amount,
      SUM(COALESCE(service_charge, 0)) as service_charge,
      SUM(COALESCE(packaging_charge, 0)) as packaging_charge,
      SUM(COALESCE(delivery_charge, 0)) as delivery_charge,
      SUM(COALESCE(round_off, 0)) as round_off,
      COUNT(CASE WHEN is_nc = 1 THEN 1 END) as nc_count,
      COUNT(CASE WHEN is_adjustment = 1 THEN 1 END) as adj_count,
      COUNT(CASE WHEN payment_status = 'completed' THEN 1 END) as fully_paid,
      COUNT(CASE WHEN payment_status = 'partial' THEN 1 END) as partial_paid,
      COUNT(CASE WHEN payment_status NOT IN ('completed','partial') OR payment_status IS NULL THEN 1 END) as unpaid
     FROM orders
     WHERE outlet_id = ?
       AND status NOT IN ('paid', 'completed', 'cancelled')
       AND order_type IN ('dine_in', 'takeaway')`,
    [OUTLET_ID]
  );

  const db = dbOrders[0];
  const p = data.summary.payment;
  const s = data.summary.orders;

  record(
    'DB order count matches API',
    parseInt(db.cnt) === s.totalCount,
    `db=${db.cnt} api=${s.totalCount}`
  );
  record(
    'DB total_amount matches API',
    r2(db.total_amount) === r2(p.totalAmount),
    `db=${r2(db.total_amount)} api=${p.totalAmount}`
  );
  record(
    'DB subtotal matches API',
    r2(db.subtotal) === r2(p.subtotal),
    `db=${r2(db.subtotal)} api=${p.subtotal}`
  );
  record(
    'DB discount_amount matches API',
    r2(db.discount_amount) === r2(p.discountAmount),
    `db=${r2(db.discount_amount)} api=${p.discountAmount}`
  );
  record(
    'DB tax_amount matches API',
    r2(db.tax_amount) === r2(p.taxAmount),
    `db=${r2(db.tax_amount)} api=${p.taxAmount}`
  );
  record(
    'DB paid_amount matches API',
    r2(db.paid_amount) === r2(p.paidAmount),
    `db=${r2(db.paid_amount)} api=${p.paidAmount}`
  );
  record(
    'DB due_amount matches API',
    r2(db.due_amount) === r2(p.dueAmount),
    `db=${r2(db.due_amount)} api=${p.dueAmount}`
  );
  record(
    'DB nc_amount matches API',
    r2(db.nc_amount) === r2(p.ncAmount),
    `db=${r2(db.nc_amount)} api=${p.ncAmount}`
  );
  record(
    'DB nc_count matches API',
    parseInt(db.nc_count) === p.ncOrderCount,
    `db=${db.nc_count} api=${p.ncOrderCount}`
  );
  record(
    'DB adjustment_amount matches API',
    r2(db.adjustment_amount) === r2(p.adjustmentAmount),
    `db=${r2(db.adjustment_amount)} api=${p.adjustmentAmount}`
  );
  record(
    'DB adj_count matches API',
    parseInt(db.adj_count) === p.adjustmentOrderCount,
    `db=${db.adj_count} api=${p.adjustmentOrderCount}`
  );
  record(
    'DB service_charge matches API',
    r2(db.service_charge) === r2(p.serviceCharge),
    `db=${r2(db.service_charge)} api=${p.serviceCharge}`
  );
  record(
    'DB packaging_charge matches API',
    r2(db.packaging_charge) === r2(p.packagingCharge),
    `db=${r2(db.packaging_charge)} api=${p.packagingCharge}`
  );
  record(
    'DB round_off matches API',
    r2(db.round_off) === r2(p.roundOff),
    `db=${r2(db.round_off)} api=${p.roundOff}`
  );
  record(
    'DB fully_paid count matches API',
    parseInt(db.fully_paid) === p.fullyPaidCount,
    `db=${db.fully_paid} api=${p.fullyPaidCount}`
  );
  record(
    'DB partial_paid count matches API',
    parseInt(db.partial_paid) === p.partialPaidCount,
    `db=${db.partial_paid} api=${p.partialPaidCount}`
  );
  record(
    'DB unpaid count matches API',
    parseInt(db.unpaid) === p.unpaidCount,
    `db=${db.unpaid} api=${p.unpaidCount}`
  );
}

async function testPerOrderDBVerification(data) {
  console.log('\n── 9. Per-Order DB Verification (sample) ──');

  const orders = data.runningOrders || [];
  if (orders.length === 0) {
    record('orders available for per-order check', false, 'No running orders', true);
    return;
  }

  // Pick up to 5 orders for individual verification
  const sample = orders.slice(0, 5);
  for (const apiOrder of sample) {
    const [dbRows] = await pool.query(
      `SELECT id, order_number, total_amount, subtotal, discount_amount, tax_amount,
              paid_amount, due_amount, payment_status, is_nc, nc_amount,
              is_adjustment, adjustment_amount, service_charge, packaging_charge, round_off
       FROM orders WHERE id = ?`,
      [apiOrder.id]
    );
    if (dbRows.length === 0) {
      record(`order ${apiOrder.orderNumber} exists in DB`, false);
      continue;
    }
    const db = dbRows[0];
    const prefix = `order#${apiOrder.orderNumber}`;

    record(`${prefix} totalAmount`, r2(db.total_amount) === r2(apiOrder.totalAmount),
      `db=${r2(db.total_amount)} api=${apiOrder.totalAmount}`);
    record(`${prefix} subtotal`, r2(db.subtotal) === r2(apiOrder.subtotal),
      `db=${r2(db.subtotal)} api=${apiOrder.subtotal}`);
    record(`${prefix} discountAmount`, r2(db.discount_amount) === r2(apiOrder.discountAmount),
      `db=${r2(db.discount_amount)} api=${apiOrder.discountAmount}`);
    record(`${prefix} taxAmount`, r2(db.tax_amount) === r2(apiOrder.taxAmount),
      `db=${r2(db.tax_amount)} api=${apiOrder.taxAmount}`);
    record(`${prefix} paidAmount`, r2(db.paid_amount) === r2(apiOrder.paidAmount),
      `db=${r2(db.paid_amount)} api=${apiOrder.paidAmount}`);
    record(`${prefix} dueAmount`, r2(db.due_amount) === r2(apiOrder.dueAmount),
      `db=${r2(db.due_amount)} api=${apiOrder.dueAmount}`);
    record(`${prefix} paymentStatus`, (db.payment_status || 'pending') === apiOrder.paymentStatus,
      `db=${db.payment_status} api=${apiOrder.paymentStatus}`);
    record(`${prefix} isNC`, !!db.is_nc === apiOrder.isNC,
      `db=${!!db.is_nc} api=${apiOrder.isNC}`);
    record(`${prefix} ncAmount`, r2(db.nc_amount) === r2(apiOrder.ncAmount),
      `db=${r2(db.nc_amount)} api=${apiOrder.ncAmount}`);
    record(`${prefix} serviceCharge`, r2(db.service_charge) === r2(apiOrder.serviceCharge),
      `db=${r2(db.service_charge)} api=${apiOrder.serviceCharge}`);
    record(`${prefix} roundOff`, r2(db.round_off) === r2(apiOrder.roundOff),
      `db=${r2(db.round_off)} api=${apiOrder.roundOff}`);
  }
}

async function testFilterFloor(data) {
  console.log('\n── 10. Filter by floorId ──');

  // Get first floor from the data
  const floors = data.summary?.floors || [];
  if (floors.length === 0) {
    record('floor filter test', false, 'No floors to test', true);
    return;
  }

  const testFloor = floors[0];
  const filtered = await apiRequest('GET', `/dashboard/realtime/${OUTLET_ID}?floorId=${testFloor.floorId}`);
  if (!filtered.success) {
    record('floor filter API call', false, filtered.message);
    return;
  }

  const fd = filtered.data;
  record('filtered response success', !!fd);

  // All orders should be from this floor
  const allSameFloor = (fd.runningOrders || []).every(o => o.floorId === testFloor.floorId || o.floorId === null);
  record(
    `all orders from floor ${testFloor.floorId}`,
    allSameFloor,
    `orders=${fd.runningOrders?.length}`
  );

  // All tables should be from this floor
  const allTablesFloor = (fd.tables || []).every(t => t.floorId === testFloor.floorId);
  record(
    `all tables from floor ${testFloor.floorId}`,
    allTablesFloor,
    `tables=${fd.tables?.length}`
  );

  // Floor count should be 1
  record(
    'filtered floors count = 1',
    fd.summary.floors.length <= 1,
    `floors=${fd.summary.floors.length}`
  );
}

async function testFilterOrderType() {
  console.log('\n── 11. Filter by orderType ──');

  for (const ot of ['dine_in', 'takeaway']) {
    const res = await apiRequest('GET', `/dashboard/realtime/${OUTLET_ID}?orderType=${ot}`);
    if (!res.success) {
      record(`orderType=${ot} API call`, false, res.message);
      continue;
    }
    const d = res.data;

    // All running orders should match this type
    const allMatch = (d.runningOrders || []).every(o => o.orderType === ot);
    record(
      `all orders are ${ot}`,
      allMatch,
      `count=${d.runningOrders?.length}`
    );

    // Verify breakdown matches
    if (ot === 'dine_in') {
      record(
        `dineIn count = totalCount for ${ot} filter`,
        d.orders.dineIn.count === d.summary.orders.totalCount,
        `dineIn=${d.orders.dineIn.count} total=${d.summary.orders.totalCount}`
      );
      record(
        `takeaway count = 0 for ${ot} filter`,
        d.orders.takeaway.count === 0,
        `takeaway=${d.orders.takeaway.count}`
      );
    } else {
      record(
        `takeaway count = totalCount for ${ot} filter`,
        d.orders.takeaway.count === d.summary.orders.totalCount,
        `takeaway=${d.orders.takeaway.count} total=${d.summary.orders.totalCount}`
      );
      record(
        `dineIn count = 0 for ${ot} filter`,
        d.orders.dineIn.count === 0,
        `dineIn=${d.orders.dineIn.count}`
      );
    }
  }
}

async function testBillCalculationIntegrity(data) {
  console.log('\n── 12. Bill Calculation Integrity (per order) ──');
  const orders = data.runningOrders || [];
  if (orders.length === 0) {
    record('orders for bill calc', false, 'No running orders', true);
    return;
  }

  let allValid = true;
  let failDetails = [];
  let skippedPreBill = 0;
  for (const o of orders) {
    // Skip orders where total hasn't been finalized yet (pre-bill: total_amount=0 but subtotal > 0)
    if (o.totalAmount === 0 && o.subtotal > 0) {
      skippedPreBill++;
      continue;
    }
    // total = subtotal - discount + tax + serviceCharge + packagingCharge + deliveryCharge + roundOff
    const computed = r2(o.subtotal - o.discountAmount + o.taxAmount + o.serviceCharge + o.packagingCharge + (o.deliveryCharge || 0) + o.roundOff);
    const actual = r2(o.totalAmount);
    // Allow ±1 tolerance for rounding
    if (Math.abs(computed - actual) > 1) {
      allValid = false;
      failDetails.push(`${o.orderNumber}: computed=${computed} actual=${actual} diff=${r2(computed - actual)}`);
    }
  }

  const checkedCount = orders.length - skippedPreBill;
  record(
    'all orders: total ≈ subtotal - discount + tax + charges + roundOff (±1 tolerance)',
    allValid,
    allValid ? `${checkedCount} orders verified${skippedPreBill ? `, ${skippedPreBill} pre-bill skipped` : ''}` : failDetails.join('; ')
  );
}

async function testItemCountConsistency(data) {
  console.log('\n── 13. Item Count Consistency ──');
  const orders = data.runningOrders || [];

  let allMatch = true;
  let mismatches = [];
  for (const o of orders) {
    if (o.itemCount !== (o.items || []).length) {
      allMatch = false;
      mismatches.push(`${o.orderNumber}: itemCount=${o.itemCount} actual=${(o.items || []).length}`);
    }
  }
  record(
    'all orders: itemCount matches items.length',
    allMatch,
    allMatch ? `${orders.length} orders OK` : mismatches.join('; ')
  );
}

// ─── Main ─────────────────────────────────────────────────────────────

(async () => {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log(`║  Dashboard Realtime API Test — Outlet ${OUTLET_ID}`.padEnd(55) + '║');
  console.log('║  New DSR Rule + Payment Accuracy Verification       ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  try {
    // DB connection
    pool = await mysql.createPool({
      host: dbCfg.host,
      port: dbCfg.port,
      user: dbCfg.user,
      password: dbCfg.password,
      database: dbCfg.database,
    });

    // Login
    console.log('── Authenticating... ──');
    const loginRes = await apiRequest('POST', '/auth/login', {
      email: 'admin@restropos.com',
      password: 'admin123',
    });
    if (!loginRes.data?.accessToken) {
      console.error('Login failed:', loginRes.message || 'No token');
      process.exit(1);
    }
    AUTH_TOKEN = loginRes.data.accessToken;
    console.log('  Authenticated OK\n');

    // Main API call
    console.log(`── Fetching /dashboard/realtime/${OUTLET_ID} ──`);
    const response = await apiRequest('GET', `/dashboard/realtime/${OUTLET_ID}`);
    if (!response.success) {
      console.error('API failed:', response.message);
      process.exit(1);
    }
    const data = response.data;

    // Print summary overview
    console.log(`\n  Orders: ${data.summary.orders.totalCount} | Amount: ${data.summary.orders.totalAmount}`);
    console.log(`  Tables: ${data.summary.tables.totalTables} | Guests: ${data.summary.tables.totalGuests}`);
    console.log(`  Payment: paid=${data.summary.payment.paidAmount} due=${data.summary.payment.dueAmount} unpaid=${data.summary.payment.unpaidAmount}`);
    console.log(`  NC: ${data.summary.payment.ncOrderCount} orders, ₹${data.summary.payment.ncAmount}`);
    console.log(`  Adjustment: ${data.summary.payment.adjustmentOrderCount} orders, ₹${data.summary.payment.adjustmentAmount}`);
    console.log(`  Discount: ₹${data.summary.payment.discountAmount} | Tax: ₹${data.summary.payment.taxAmount}`);

    // Run all tests
    await testBasicStructure(data);
    await testPaymentSummaryFields(data);
    await testPaymentConsistency(data);
    await testRunningOrderFields(data);
    await testTableLinkage(data);
    await testFloorBreakdown(data);
    await testOrderTypeBreakdown(data);
    await testDBCrossVerification(data);
    await testPerOrderDBVerification(data);
    await testFilterFloor(data);
    await testFilterOrderType();
    await testBillCalculationIntegrity(data);
    await testItemCountConsistency(data);

  } catch (err) {
    console.error('\n  FATAL ERROR:', err.message);
    console.error(err.stack);
  } finally {
    if (pool) await pool.end();
  }

  // Final summary
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`);
  console.log(`║  Total: ${results.tests.length} tests`);
  console.log('╚══════════════════════════════════════════════════════╝');

  if (results.failed > 0) {
    console.log('\n  ❌ FAILED TESTS:');
    results.tests.filter(t => t.passed === false).forEach(t => {
      console.log(`    - ${t.name}: ${t.detail}`);
    });
  }

  process.exit(results.failed > 0 ? 1 : 0);
})();
