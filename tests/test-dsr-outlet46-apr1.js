/**
 * DSR Cross-Verification Script — Outlet 46, April 1 2026
 * Business Day: 4:00 AM Apr 1 → 3:59:59 AM Apr 2
 * Shifts: #140, #141
 * 
 * Goal: Explain exactly how 75609, 76280, and 151889 are derived,
 *       cross-verify every single order, and produce a full A-to-Z report.
 */

const mysql = require('mysql2/promise');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

// ── Config ──
const OUTLET_ID = 46;
const BD_START = '2026-04-01 04:00:00';  // business day start
const BD_END   = '2026-04-02 04:00:00';  // business day end (exclusive)
const SHIFT_IDS = [140, 141];
const BASE_URL = 'http://localhost:3005';
const API_PREFIX = '/api/v1';

const r2 = n => parseFloat((parseFloat(n) || 0).toFixed(2));

// ── HTTP helper ──
function api(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE_URL + API_PREFIX + url);
    const opts = {
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d)); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function line(ch = '─', len = 90) { return ch.repeat(len); }
function section(title) { console.log('\n' + line('═')); console.log('  ' + title); console.log(line('═')); }
function sub(title) { console.log('\n  ' + line('─', 70)); console.log('  ' + title); console.log('  ' + line('─', 70)); }

(async () => {
  const pool = await mysql.createPool({
    host: dbCfg.host, port: dbCfg.port,
    user: dbCfg.user, password: dbCfg.password, database: dbCfg.database
  });

  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  DSR CROSS-VERIFICATION — Outlet 46, April 1 2026                          ║');
  console.log('║  Business Day: 4:00 AM Apr 1 → 3:59:59 AM Apr 2                            ║');
  console.log('║  Shifts: #140, #141                                                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');

  // ═══════════════════════════════════════════════════════════
  // SECTION 1: ALL ORDERS IN BUSINESS DAY
  // ═══════════════════════════════════════════════════════════
  section('1. ALL ORDERS IN BUSINESS DAY (4am Apr 1 → 4am Apr 2)');

  const [allOrders] = await pool.query(
    `SELECT o.id, o.order_number, o.order_type, o.status, o.payment_status,
            o.total_amount, o.subtotal, o.tax_amount, o.discount_amount,
            o.service_charge, o.packaging_charge, o.delivery_charge, o.round_off,
            o.paid_amount, o.due_amount,
            o.is_nc, o.nc_amount, o.is_adjustment, o.adjustment_amount,
            o.table_id, o.floor_id, o.guest_count, o.customer_name,
            o.created_at, o.billed_at,
            t.table_number, f.name as floor_name
     FROM orders o
     LEFT JOIN tables t ON o.table_id = t.id
     LEFT JOIN floors f ON o.floor_id = f.id
     WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at < ?
     ORDER BY o.created_at`,
    [OUTLET_ID, BD_START, BD_END]
  );

  const completed = allOrders.filter(o => o.status === 'completed');
  const cancelled = allOrders.filter(o => o.status === 'cancelled');
  const other = allOrders.filter(o => !['completed', 'cancelled'].includes(o.status));

  console.log(`  Total orders: ${allOrders.length}`);
  console.log(`  Completed: ${completed.length} | Cancelled: ${cancelled.length} | Other (running/billed/etc): ${other.length}`);

  // Print every order
  sub('1a. COMPLETE ORDER LIST');
  console.log('  ' + 'Order#'.padEnd(18) + 'Type'.padEnd(10) + 'Status'.padEnd(12) + 'PayStatus'.padEnd(12) +
    'Total'.padStart(10) + 'Paid'.padStart(10) + 'Due'.padStart(10) + 'Disc'.padStart(10) +
    'Table'.padStart(8) + '  Created');
  console.log('  ' + line('-', 120));

  for (const o of allOrders) {
    console.log('  ' +
      String(o.order_number).padEnd(18) +
      String(o.order_type).padEnd(10) +
      String(o.status).padEnd(12) +
      String(o.payment_status || '-').padEnd(12) +
      String(r2(o.total_amount)).padStart(10) +
      String(r2(o.paid_amount)).padStart(10) +
      String(r2(o.due_amount)).padStart(10) +
      String(r2(o.discount_amount)).padStart(10) +
      String(o.table_number || '-').padStart(8) +
      '  ' + new Date(o.created_at).toLocaleTimeString('en-IN', { hour12: false })
    );
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 2: COMPLETED ORDERS SUMMARY (DSR SOURCE)
  // ═══════════════════════════════════════════════════════════
  section('2. COMPLETED ORDERS SUMMARY (DSR = only completed)');

  const dineIn = completed.filter(o => o.order_type === 'dine_in');
  const takeaway = completed.filter(o => o.order_type === 'takeaway');
  const delivery = completed.filter(o => o.order_type === 'delivery');

  const sumTotal = r2(completed.reduce((s, o) => s + parseFloat(o.total_amount || 0), 0));
  const sumPaid = r2(completed.reduce((s, o) => s + parseFloat(o.paid_amount || 0), 0));
  const sumDue = r2(completed.reduce((s, o) => s + parseFloat(o.due_amount || 0), 0));
  const sumDisc = r2(completed.reduce((s, o) => s + parseFloat(o.discount_amount || 0), 0));
  const sumTax = r2(completed.reduce((s, o) => s + parseFloat(o.tax_amount || 0), 0));
  const sumSubtotal = r2(completed.reduce((s, o) => s + parseFloat(o.subtotal || 0), 0));
  const sumSvcCharge = r2(completed.reduce((s, o) => s + parseFloat(o.service_charge || 0), 0));
  const sumPkgCharge = r2(completed.reduce((s, o) => s + parseFloat(o.packaging_charge || 0), 0));
  const sumRoundOff = r2(completed.reduce((s, o) => s + parseFloat(o.round_off || 0), 0));
  const ncOrders = completed.filter(o => o.is_nc === 1);
  const sumNC = r2(ncOrders.reduce((s, o) => s + parseFloat(o.nc_amount || 0), 0));
  const adjOrders = completed.filter(o => o.is_adjustment === 1);
  const sumAdj = r2(adjOrders.reduce((s, o) => s + parseFloat(o.adjustment_amount || 0), 0));

  const fullyPaid = completed.filter(o => o.payment_status === 'completed');
  const partialPaid = completed.filter(o => o.payment_status === 'partial');
  const unpaid = completed.filter(o => ['pending', 'refunded'].includes(o.payment_status));

  console.log(`  total_sale (SUM total_amount)     = ${sumTotal}`);
  console.log(`  total_paid_amount                 = ${sumPaid}`);
  console.log(`  total_due_amount                  = ${sumDue}`);
  console.log(`  total_discount                    = ${sumDisc}`);
  console.log(`  total_tax                         = ${sumTax}`);
  console.log(`  subtotal                          = ${sumSubtotal}`);
  console.log(`  service_charge                    = ${sumSvcCharge}`);
  console.log(`  packaging_charge                  = ${sumPkgCharge}`);
  console.log(`  round_off                         = ${sumRoundOff}`);
  console.log(`  NC orders: ${ncOrders.length}, NC amount: ${sumNC}`);
  console.log(`  Adjustment orders: ${adjOrders.length}, Adj amount: ${sumAdj}`);
  console.log();
  console.log(`  By type: dine_in=${dineIn.length} (${r2(dineIn.reduce((s,o)=>s+parseFloat(o.total_amount||0),0))})`
    + ` | takeaway=${takeaway.length} (${r2(takeaway.reduce((s,o)=>s+parseFloat(o.total_amount||0),0))})`
    + ` | delivery=${delivery.length} (${r2(delivery.reduce((s,o)=>s+parseFloat(o.total_amount||0),0))})`);
  console.log(`  By pay status: fully_paid=${fullyPaid.length} | partial=${partialPaid.length} | unpaid=${unpaid.length}`);
  console.log();
  console.log(`  FORMULA CHECK: paid + due + adj = total_sale?`);
  console.log(`    ${sumPaid} + ${sumDue} + ${sumAdj} = ${r2(sumPaid + sumDue + sumAdj)}  vs  ${sumTotal}  →  ${Math.abs(sumPaid + sumDue + sumAdj - sumTotal) < 0.01 ? '✅ MATCH' : '❌ MISMATCH'}`);

  // ═══════════════════════════════════════════════════════════
  // SECTION 3: PAYMENTS BREAKDOWN (from payments table)
  // ═══════════════════════════════════════════════════════════
  section('3. PAYMENTS BREAKDOWN (payments table, for completed orders by o.created_at)');

  const [regularPay] = await pool.query(
    `SELECT p.id, p.order_id, p.payment_mode, p.total_amount, p.is_due_collection, p.created_at,
            o.order_number
     FROM payments p
     JOIN orders o ON p.order_id = o.id
     WHERE p.outlet_id = ? AND o.created_at >= ? AND o.created_at < ?
       AND p.status = 'completed' AND o.status = 'completed' AND p.payment_mode != 'split'
     ORDER BY p.created_at`,
    [OUTLET_ID, BD_START, BD_END]
  );

  const [splitPay] = await pool.query(
    `SELECT sp.id, sp.payment_id, sp.payment_mode, sp.amount, p.order_id, p.is_due_collection, p.created_at,
            o.order_number
     FROM split_payments sp
     JOIN payments p ON sp.payment_id = p.id
     JOIN orders o ON p.order_id = o.id
     WHERE p.outlet_id = ? AND o.created_at >= ? AND o.created_at < ?
       AND p.status = 'completed' AND o.status = 'completed' AND p.payment_mode = 'split'
     ORDER BY p.created_at`,
    [OUTLET_ID, BD_START, BD_END]
  );

  sub('3a. ALL REGULAR PAYMENTS');
  console.log('  ' + 'PayID'.padEnd(8) + 'Order#'.padEnd(18) + 'Mode'.padEnd(10) + 'Amount'.padStart(10) + '  DueColl  Created');
  for (const p of regularPay) {
    console.log('  ' +
      String(p.id).padEnd(8) +
      String(p.order_number).padEnd(18) +
      String(p.payment_mode).padEnd(10) +
      String(r2(p.total_amount)).padStart(10) +
      '  ' + (p.is_due_collection ? 'YES' : 'no ') +
      '      ' + new Date(p.created_at).toLocaleTimeString('en-IN', { hour12: false })
    );
  }

  sub('3b. ALL SPLIT PAYMENTS');
  if (splitPay.length === 0) {
    console.log('  (none)');
  } else {
    console.log('  ' + 'SplitID'.padEnd(8) + 'Order#'.padEnd(18) + 'Mode'.padEnd(10) + 'Amount'.padStart(10) + '  DueColl');
    for (const sp of splitPay) {
      console.log('  ' +
        String(sp.id).padEnd(8) +
        String(sp.order_number).padEnd(18) +
        String(sp.payment_mode).padEnd(10) +
        String(r2(sp.amount)).padStart(10) +
        '  ' + (sp.is_due_collection ? 'YES' : 'no ')
      );
    }
  }

  // Aggregate by mode
  const payModeMap = {};
  let dueCollTotal = 0;
  for (const p of regularPay) {
    payModeMap[p.payment_mode] = (payModeMap[p.payment_mode] || 0) + parseFloat(p.total_amount || 0);
    if (p.is_due_collection) dueCollTotal += parseFloat(p.total_amount || 0);
  }
  for (const sp of splitPay) {
    payModeMap[sp.payment_mode] = (payModeMap[sp.payment_mode] || 0) + parseFloat(sp.amount || 0);
    if (sp.is_due_collection) dueCollTotal += parseFloat(sp.amount || 0);
  }
  const payTotal = r2(Object.values(payModeMap).reduce((a, b) => a + b, 0));

  sub('3c. PAYMENT MODE SUMMARY');
  for (const [mode, amt] of Object.entries(payModeMap).sort()) {
    console.log(`    ${mode.padEnd(15)} = ${r2(amt)}`);
  }
  console.log(`    ${'TOTAL'.padEnd(15)} = ${payTotal}`);
  console.log(`    Due collections  = ${r2(dueCollTotal)}`);
  console.log();
  console.log(`  MATCH CHECK: payment_mode_total (${payTotal}) = total_paid_amount (${sumPaid})?  →  ${Math.abs(payTotal - sumPaid) < 0.01 ? '✅ MATCH' : '❌ MISMATCH (' + r2(payTotal - sumPaid) + ')'}`);

  // ═══════════════════════════════════════════════════════════
  // SECTION 4: SHIFT ANALYSIS (#140 and #141)
  // ═══════════════════════════════════════════════════════════
  section('4. SHIFT ANALYSIS');

  for (const shiftId of SHIFT_IDS) {
    sub(`Shift #${shiftId}`);

    const [sess] = await pool.query(
      `SELECT ds.*, u.name as cashier_name, f.name as floor_name
       FROM day_sessions ds
       LEFT JOIN users u ON ds.cashier_id = u.id
       LEFT JOIN floors f ON ds.floor_id = f.id
       WHERE ds.id = ?`, [shiftId]
    );

    if (!sess.length) { console.log('  Shift not found!'); continue; }
    const s = sess[0];
    console.log(`  Floor: ${s.floor_name} (id=${s.floor_id}) | Cashier: ${s.cashier_name}`);
    console.log(`  Status: ${s.status} | Opening: ${s.opening_cash}`);
    console.log(`  Open: ${s.opening_time} | Close: ${s.closing_time || 'STILL OPEN'}`);
    console.log(`  Stored: total_sales=${s.total_sales}, total_orders=${s.total_orders}`);
    console.log(`  Stored: cash=${s.total_cash_sales}, card=${s.total_card_sales}, upi=${s.total_upi_sales}`);
    console.log(`  Stored: expected_cash=${s.expected_cash}, closing_cash=${s.closing_cash}, variance=${s.cash_variance}`);

    const shiftStart = s.opening_time;
    const shiftEnd = s.closing_time || new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Orders in this shift window
    const [shiftOrders] = await pool.query(
      `SELECT o.id, o.order_number, o.order_type, o.status, o.payment_status,
              o.total_amount, o.paid_amount, o.due_amount, o.discount_amount,
              o.is_nc, o.nc_amount, o.is_adjustment, o.adjustment_amount,
              t.table_number, f.name as floor_name, o.floor_id
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ?
       ORDER BY o.created_at`,
      [OUTLET_ID, shiftStart, shiftEnd]
    );

    // Filter by floor if shift has a floor
    const floorOrders = s.floor_id
      ? shiftOrders.filter(o => o.floor_id === s.floor_id || o.floor_id === null)
      : shiftOrders;
    const floorCompleted = floorOrders.filter(o => o.status === 'completed');

    console.log(`\n  Orders during shift (all floors): ${shiftOrders.length}`);
    console.log(`  Orders on shift floor (${s.floor_name}): ${floorOrders.length}`);
    console.log(`  Completed on shift floor: ${floorCompleted.length}`);

    const shiftSale = r2(floorCompleted.reduce((sum, o) => sum + parseFloat(o.total_amount || 0), 0));
    const shiftPaid = r2(floorCompleted.reduce((sum, o) => sum + parseFloat(o.paid_amount || 0), 0));
    console.log(`  SUM total_amount (completed, floor): ${shiftSale}`);
    console.log(`  SUM paid_amount (completed, floor): ${shiftPaid}`);

    // Payments during shift
    const [shiftPayments] = await pool.query(
      `SELECT p.payment_mode, SUM(p.total_amount) as amount, COUNT(*) as cnt,
              SUM(CASE WHEN p.is_due_collection = 1 THEN p.total_amount ELSE 0 END) as due_coll
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
         AND p.status = 'completed' AND p.payment_mode != 'split'
         ${s.floor_id ? 'AND (t.floor_id = ? OR t.floor_id IS NULL OR o.table_id IS NULL)' : ''}
       GROUP BY p.payment_mode`,
      s.floor_id ? [OUTLET_ID, shiftStart, shiftEnd, s.floor_id] : [OUTLET_ID, shiftStart, shiftEnd]
    );
    const [shiftSplits] = await pool.query(
      `SELECT sp.payment_mode, SUM(sp.amount) as amount, COUNT(*) as cnt,
              SUM(CASE WHEN p.is_due_collection = 1 THEN sp.amount ELSE 0 END) as due_coll
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
         AND p.status = 'completed' AND p.payment_mode = 'split'
         ${s.floor_id ? 'AND (t.floor_id = ? OR t.floor_id IS NULL OR o.table_id IS NULL)' : ''}
       GROUP BY sp.payment_mode`,
      s.floor_id ? [OUTLET_ID, shiftStart, shiftEnd, s.floor_id] : [OUTLET_ID, shiftStart, shiftEnd]
    );

    console.log(`\n  Payment breakdown (during shift, on floor):`);
    let shiftPayTotal = 0, shiftCash = 0;
    for (const p of [...shiftPayments, ...shiftSplits]) {
      const amt = parseFloat(p.amount || 0);
      shiftPayTotal += amt;
      if (p.payment_mode === 'cash') shiftCash += amt;
      console.log(`    ${String(p.payment_mode).padEnd(15)} = ${r2(amt)} (${p.cnt} txns, due_coll=${r2(p.due_coll)})`);
    }
    console.log(`    TOTAL              = ${r2(shiftPayTotal)}`);

    // Cash drawer
    const [cdTxns] = await pool.query(
      `SELECT transaction_type, SUM(amount) as amount
       FROM cash_drawer
       WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?
         ${s.floor_id ? 'AND floor_id = ?' : ''}
       GROUP BY transaction_type`,
      s.floor_id ? [OUTLET_ID, shiftStart, shiftEnd, s.floor_id] : [OUTLET_ID, shiftStart, shiftEnd]
    );
    const cdMap = {};
    for (const t of cdTxns) cdMap[t.transaction_type] = parseFloat(t.amount || 0);

    console.log(`\n  Cash drawer movements:`);
    console.log(`    opening   = ${cdMap.opening || 0}`);
    console.log(`    cash_in   = ${cdMap.cash_in || 0}`);
    console.log(`    cash_out  = ${Math.abs(cdMap.cash_out || 0)}`);
    console.log(`    refund    = ${Math.abs(cdMap.refund || 0)}`);
    console.log(`    expense   = ${Math.abs(cdMap.expense || 0)}`);

    const expectedCash = (parseFloat(s.opening_cash) || 0) + shiftCash
      + (cdMap.cash_in || 0) - Math.abs(cdMap.cash_out || 0) - Math.abs(cdMap.refund || 0) - Math.abs(cdMap.expense || 0);
    console.log(`\n  Expected cash = opening(${s.opening_cash}) + cashPayments(${r2(shiftCash)}) + cashIn(${cdMap.cash_in || 0}) - cashOut(${Math.abs(cdMap.cash_out || 0)}) - refund(${Math.abs(cdMap.refund || 0)}) - expense(${Math.abs(cdMap.expense || 0)})`);
    console.log(`               = ${r2(expectedCash)}`);
    if (s.expected_cash) {
      console.log(`  Stored expected_cash = ${s.expected_cash}  →  ${Math.abs(expectedCash - parseFloat(s.expected_cash)) < 0.01 ? '✅ MATCH' : '❌ DIFF=' + r2(expectedCash - parseFloat(s.expected_cash))}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 5: THE KEY NUMBERS — 75609, 76280, 151889
  // ═══════════════════════════════════════════════════════════
  section('5. INVESTIGATING KEY NUMBERS: 75609, 76280, 151889');

  // Check if these are shift totals
  for (const shiftId of SHIFT_IDS) {
    const [sess] = await pool.query('SELECT * FROM day_sessions WHERE id = ?', [shiftId]);
    if (sess.length) {
      const s = sess[0];
      console.log(`\n  Shift #${shiftId}: total_sales=${s.total_sales}, total_cash_sales=${s.total_cash_sales}, total_card_sales=${s.total_card_sales}, total_upi_sales=${s.total_upi_sales}`);
      const shiftPaySum = parseFloat(s.total_cash_sales || 0) + parseFloat(s.total_card_sales || 0) + parseFloat(s.total_upi_sales || 0);
      console.log(`    cash+card+upi = ${r2(shiftPaySum)}`);
    }
  }

  // Check various sums
  console.log('\n  Possible interpretations:');
  console.log(`    SUM(total_amount) of ALL completed orders  = ${sumTotal}`);
  console.log(`    SUM(paid_amount) of ALL completed orders   = ${sumPaid}`);

  // Check if 151889 = shift1 + shift2
  const [s140] = await pool.query('SELECT total_sales FROM day_sessions WHERE id = 140');
  const [s141] = await pool.query('SELECT total_sales FROM day_sessions WHERE id = 141');
  const s140Sale = parseFloat(s140[0]?.total_sales || 0);
  const s141Sale = parseFloat(s141[0]?.total_sales || 0);
  console.log(`    Shift #140 total_sales + Shift #141 total_sales = ${r2(s140Sale)} + ${r2(s141Sale)} = ${r2(s140Sale + s141Sale)}`);

  // Also check floor-wise
  const [floors] = await pool.query('SELECT id, name FROM floors WHERE outlet_id = ?', [OUTLET_ID]);
  console.log('\n  Floor-wise completed order totals:');
  for (const fl of floors) {
    const floorTotal = r2(completed.filter(o => o.floor_id === fl.id).reduce((s, o) => s + parseFloat(o.total_amount || 0), 0));
    const floorPaid = r2(completed.filter(o => o.floor_id === fl.id).reduce((s, o) => s + parseFloat(o.paid_amount || 0), 0));
    const floorCount = completed.filter(o => o.floor_id === fl.id).length;
    console.log(`    ${fl.name.padEnd(20)} (id=${fl.id}): orders=${floorCount}, total_sale=${floorTotal}, paid=${floorPaid}`);
  }
  // Takeaway/no-floor
  const noFloor = completed.filter(o => !o.floor_id);
  if (noFloor.length) {
    console.log(`    (no floor/takeaway): orders=${noFloor.length}, total_sale=${r2(noFloor.reduce((s,o)=>s+parseFloat(o.total_amount||0),0))}, paid=${r2(noFloor.reduce((s,o)=>s+parseFloat(o.paid_amount||0),0))}`);
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 6: PER-ORDER DETAIL FOR COMPLETED ORDERS
  // ═══════════════════════════════════════════════════════════
  section('6. PER-ORDER DETAIL (every completed order)');

  console.log('  ' + '#'.padEnd(4) + 'Order#'.padEnd(18) + 'Type'.padEnd(10) + 'Table'.padEnd(8) + 'Floor'.padEnd(15) +
    'Subtotal'.padStart(10) + 'Disc'.padStart(8) + 'Tax'.padStart(8) + 'SvcChg'.padStart(8) +
    'RndOff'.padStart(8) + 'Total'.padStart(10) + 'Paid'.padStart(10) + 'Due'.padStart(8) + ' PaySt');
  console.log('  ' + line('-', 145));

  let runTotal = 0, runPaid = 0, runDue = 0;
  for (let i = 0; i < completed.length; i++) {
    const o = completed[i];
    runTotal += parseFloat(o.total_amount || 0);
    runPaid += parseFloat(o.paid_amount || 0);
    runDue += parseFloat(o.due_amount || 0);
    console.log('  ' +
      String(i + 1).padEnd(4) +
      String(o.order_number).padEnd(18) +
      String(o.order_type).padEnd(10) +
      String(o.table_number || '-').padEnd(8) +
      String(o.floor_name || '-').padEnd(15) +
      String(r2(o.subtotal)).padStart(10) +
      String(r2(o.discount_amount)).padStart(8) +
      String(r2(o.tax_amount)).padStart(8) +
      String(r2(o.service_charge)).padStart(8) +
      String(r2(o.round_off)).padStart(8) +
      String(r2(o.total_amount)).padStart(10) +
      String(r2(o.paid_amount)).padStart(10) +
      String(r2(o.due_amount)).padStart(8) +
      ' ' + (o.payment_status || '-')
    );
  }
  console.log('  ' + line('-', 145));
  console.log('  ' + 'TOTALS'.padEnd(55) +
    String(r2(sumSubtotal)).padStart(10) +
    String(r2(sumDisc)).padStart(8) +
    String(r2(sumTax)).padStart(8) +
    String(r2(sumSvcCharge)).padStart(8) +
    String(r2(sumRoundOff)).padStart(8) +
    String(r2(runTotal)).padStart(10) +
    String(r2(runPaid)).padStart(10) +
    String(r2(runDue)).padStart(8)
  );

  // ═══════════════════════════════════════════════════════════
  // SECTION 7: PER-ORDER PAYMENT DETAIL
  // ═══════════════════════════════════════════════════════════
  section('7. PER-ORDER PAYMENT DETAIL (which payment mode for each order)');

  for (const o of completed) {
    const [pays] = await pool.query(
      `SELECT p.id, p.payment_mode, p.total_amount, p.is_due_collection, p.created_at
       FROM payments p WHERE p.order_id = ? AND p.status = 'completed' ORDER BY p.created_at`,
      [o.id]
    );
    const [splits] = await pool.query(
      `SELECT sp.payment_mode, sp.amount, p.is_due_collection
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       WHERE p.order_id = ? AND p.status = 'completed'`,
      [o.id]
    );

    let detail = '';
    for (const p of pays) {
      if (p.payment_mode === 'split') {
        const splitDetail = splits.map(sp => `${sp.payment_mode}=${r2(sp.amount)}`).join('+');
        detail += `split(${splitDetail})${p.is_due_collection ? '[DUE_COLL]' : ''} `;
      } else {
        detail += `${p.payment_mode}=${r2(p.total_amount)}${p.is_due_collection ? '[DUE_COLL]' : ''} `;
      }
    }
    if (!pays.length) detail = '(no payments)';

    console.log(`  ${String(o.order_number).padEnd(18)} total=${String(r2(o.total_amount)).padStart(8)}  paid=${String(r2(o.paid_amount)).padStart(8)}  due=${String(r2(o.due_amount)).padStart(6)}  →  ${detail.trim()}`);
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 8: API CROSS-VERIFICATION
  // ═══════════════════════════════════════════════════════════
  section('8. API CROSS-VERIFICATION');

  const lr = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  const token = lr.data.accessToken;

  // Accurate DSR
  const dsrRes = await api('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=2026-04-01&endDate=2026-04-01`, null, token);
  const dsr = dsrRes.data;

  sub('8a. Accurate DSR API Response');
  if (dsr?.summary) {
    const ds = dsr.summary;
    console.log(`  API total_sale        = ${ds.total_sale}`);
    console.log(`  API total_paid_amount = ${ds.total_paid_amount}`);
    console.log(`  API total_due_amount  = ${ds.total_due_amount}`);
    console.log(`  API discount_amount   = ${ds.discount_amount}`);
    console.log(`  API nc_amount         = ${ds.nc_amount}`);
    console.log(`  API adjustment_amount = ${ds.adjustment_amount}`);
    console.log(`  API total_orders      = ${ds.total_orders}`);
    console.log();
    console.log(`  DB vs API check:`);
    console.log(`    total_sale:  DB=${sumTotal} API=${ds.total_sale}  →  ${Math.abs(sumTotal - ds.total_sale) < 0.01 ? '✅' : '❌'}`);
    console.log(`    paid:        DB=${sumPaid} API=${ds.total_paid_amount}  →  ${Math.abs(sumPaid - ds.total_paid_amount) < 0.01 ? '✅' : '❌'}`);
    console.log(`    due:         DB=${sumDue} API=${ds.total_due_amount}  →  ${Math.abs(sumDue - ds.total_due_amount) < 0.01 ? '✅' : '❌'}`);
    console.log(`    discount:    DB=${sumDisc} API=${ds.discount_amount}  →  ${Math.abs(sumDisc - ds.discount_amount) < 0.01 ? '✅' : '❌'}`);
    console.log(`    orders:      DB=${completed.length} API=${ds.total_orders}  →  ${completed.length === ds.total_orders ? '✅' : '❌'}`);
  } else {
    console.log('  DSR API returned no summary data');
    console.log('  Response:', JSON.stringify(dsrRes).slice(0, 500));
  }

  // Running Dashboard
  const rdRes = await api('GET', `/reports/accurate-running-dashboard?outletId=${OUTLET_ID}&startDate=2026-04-01&endDate=2026-04-01`, null, token);
  const rd = rdRes.data;

  sub('8b. Accurate Running Dashboard API Response');
  if (rd?.summary) {
    const rs = rd.summary;
    console.log(`  API total_sale        = ${rs.total_sale}`);
    console.log(`  API total_paid_amount = ${rs.total_paid_amount}`);
    console.log(`  API total_due_amount  = ${rs.total_due_amount}`);
    console.log(`  API due_collection    = ${rs.due_collection_amount}`);
    console.log(`  API adjustment        = ${rs.adjustment_amount}`);
    if (rd.payments) {
      console.log(`\n  Payment breakdown from API:`);
      for (const p of rd.payments) {
        console.log(`    ${p.name.padEnd(15)} = ${p.amount} (${p.percentage}%)`);
      }
    }
    if (rd.crossVerification) {
      console.log(`\n  Cross-verification:`);
      console.log(`    ${JSON.stringify(rd.crossVerification, null, 4).split('\n').join('\n    ')}`);
    }
  } else {
    console.log('  Running Dashboard API returned no summary');
    console.log('  Response:', JSON.stringify(rdRes).slice(0, 500));
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 9: CANCELLED ORDERS (for completeness)
  // ═══════════════════════════════════════════════════════════
  if (cancelled.length > 0) {
    section('9. CANCELLED ORDERS');
    for (const o of cancelled) {
      console.log(`  ${String(o.order_number).padEnd(18)} type=${o.order_type} total=${r2(o.total_amount)} table=${o.table_number || '-'} created=${new Date(o.created_at).toLocaleTimeString('en-IN', { hour12: false })}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 10: FINAL GRAND SUMMARY
  // ═══════════════════════════════════════════════════════════
  section('10. GRAND SUMMARY — HOW THE NUMBERS ADD UP');

  console.log(`
  Business Day: Apr 1 2026 (4:00 AM → 3:59:59 AM next day)
  Outlet: ${OUTLET_ID}

  ┌─────────────────────────────────────────────────────┐
  │  TOTAL ORDERS (completed)    = ${String(completed.length).padStart(6)}               │
  │  TOTAL SALE (SUM total_amt)  = ${String(sumTotal).padStart(10)}           │
  │                                                     │
  │  Subtotal                    = ${String(sumSubtotal).padStart(10)}           │
  │  (-) Discount                = ${String(sumDisc).padStart(10)}           │
  │  (+) Tax                     = ${String(sumTax).padStart(10)}           │
  │  (+) Service Charge          = ${String(sumSvcCharge).padStart(10)}           │
  │  (+) Packaging Charge        = ${String(sumPkgCharge).padStart(10)}           │
  │  (+) Round Off               = ${String(sumRoundOff).padStart(10)}           │
  │                                                     │
  │  PAID amount                 = ${String(sumPaid).padStart(10)}           │
  │  DUE amount (remaining)      = ${String(sumDue).padStart(10)}           │
  │  ADJUSTMENT amount           = ${String(sumAdj).padStart(10)}           │
  │  NC amount                   = ${String(sumNC).padStart(10)}           │
  │                                                     │
  │  paid + due + adj            = ${String(r2(sumPaid + sumDue + sumAdj)).padStart(10)}           │
  │  total_sale                  = ${String(sumTotal).padStart(10)}           │
  │  MATCH?                      = ${(Math.abs(sumPaid + sumDue + sumAdj - sumTotal) < 0.01 ? '✅ YES' : '❌ NO').padStart(10)}           │
  │                                                     │
  │  Payment mode total          = ${String(payTotal).padStart(10)}           │
  │  = total_paid_amount?        = ${(Math.abs(payTotal - sumPaid) < 0.01 ? '✅ YES' : '❌ NO').padStart(10)}           │
  │                                                     │
  │  Due collections (in paid)   = ${String(r2(dueCollTotal)).padStart(10)}           │
  └─────────────────────────────────────────────────────┘

  Numbers to investigate:
    75609  →  ?
    76280  →  ?
    151889 →  ?

  Possible mappings:
    Shift #140 total_sales = ${s140Sale}
    Shift #141 total_sales = ${s141Sale}
    Shift #140 + #141      = ${r2(s140Sale + s141Sale)}
    BD total_sale          = ${sumTotal}
    BD total_paid          = ${sumPaid}
  `);

  await pool.end();
  console.log('\n  Script complete.');
})().catch(e => { console.error(e); process.exit(1); });
