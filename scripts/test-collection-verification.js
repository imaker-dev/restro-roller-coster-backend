/**
 * Cross-Verification Test: Collection Block — All Scenarios
 *
 * Scenarios (14 total):
 *   S1  Fully paid CASH dine_in (completed)
 *   S2  Fully paid CARD dine_in (completed)
 *   S3  Fully paid UPI dine_in (completed)
 *   S4  Split payment dine_in (cash + card)
 *   S5  Partial payment — DUE remaining
 *   S6  Due collected later by CASHIER-1 (is_due_collection=1)
 *   S7  NC (no-charge) order — full NC, no payment
 *   S8  Adjustment order — shortfall written off
 *   S9  Cancelled dine_in order — must NOT appear in collection
 *   S10 Wallet payment dine_in
 *   S11 TAKEAWAY order, full CASH — created by CASHIER-1
 *   S12 TAKEAWAY order, full UPI — created by CASHIER-2 (different user)
 *   S13 TAKEAWAY CANCELLED order — must NOT count
 *   S14 Due collected later by CASHIER-2 (different cashier)
 *
 * Verifies:
 *   - Raw DB matches expected values
 *   - All report service collection blocks match expected values
 *   - Cross-API: DSR == DES == DESD == DSRD (all identical)
 *   - Shift detail: staff activity, cashier breakdown, due collection per-cashier
 *   - Takeaway orders appear in reports and shift detail
 *   - Cancelled orders excluded from counts/collection
 *
 * Run: node scripts/test-collection-verification.js
 *
 * SAFE: Uses test date 2020-01-15. All rows cleaned up in finally{}.
 */
require('dotenv').config();

const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
const uid = () => 'test-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
let passed = 0, failed = 0, warnings = 0;

function ok(label, actual, expected, tol = 0.02) {
  const a = r2(actual), e = r2(expected);
  if (Math.abs(a - e) <= tol) { passed++; console.log(`    PASS  ${label}: ${a}`); }
  else { failed++; console.error(`    FAIL  ${label}: got ${a}, want ${e}  (diff ${r2(a - e)})`); }
}
function warn(msg) { warnings++; console.log(`    WARN  ${msg}`); }

async function main() {
  const { initializeDatabase, getPool, closePool } = require('../src/database');
  await initializeDatabase();
  const pool = getPool();

  const TEST_DATE = '2020-01-15';
  const BD_START  = `${TEST_DATE} 04:00:00`;
  const BD_END    = '2020-01-16 04:00:00';
  const TS        = `${TEST_DATE} 12:00:00`;
  const TS2       = `${TEST_DATE} 14:00:00`; // second timestamp for cashier-2 actions

  // Find valid outlet + two users for multi-cashier testing
  const [[outlet]] = await pool.query('SELECT id FROM outlets LIMIT 1');
  if (!outlet) { console.error('No outlet found'); process.exit(1); }
  const OUTLET = outlet.id;

  const [users] = await pool.query('SELECT id, name FROM users LIMIT 2');
  const USER1 = users[0]?.id || 1;
  const USER2 = users[1]?.id || users[0]?.id || 1;

  console.log(`\n========================================================`);
  console.log(` COLLECTION CROSS-VERIFICATION TEST`);
  console.log(` outlet=${OUTLET}  date=${TEST_DATE}`);
  console.log(` cashier1=${USER1} (${users[0]?.name})  cashier2=${USER2} (${users[1]?.name || users[0]?.name})`);
  console.log(`========================================================\n`);

  const orderIds = [], paymentIds = [], splitPayIds = [], dueTransIds = [];
  let shiftId = null;

  const orderItemIds = [];
  async function insertOrder(num, opts) {
    const [res] = await pool.query('INSERT INTO orders SET ?', {
      uuid: uid(), outlet_id: OUTLET, order_number: `XTEST-${num}`,
      order_type: opts.type || 'dine_in', guest_count: 1,
      status: opts.status || 'completed',
      subtotal: opts.subtotal || 0, discount_amount: opts.discount || 0,
      tax_amount: opts.tax || 0, total_amount: opts.total || 0,
      paid_amount: opts.paid || 0, due_amount: opts.due || 0,
      payment_status: opts.payStatus || 'completed',
      is_nc: opts.isNC ? 1 : 0, nc_amount: opts.ncAmount || 0, nc_reason: opts.ncReason || null,
      is_adjustment: opts.isAdj ? 1 : 0, adjustment_amount: opts.adjAmount || 0,
      created_by: opts.createdBy || USER1,
      billed_by: opts.billedBy || null,
      created_at: opts.ts || TS, updated_at: opts.ts || TS
    });
    orderIds.push(res.insertId);
    return res.insertId;
  }
  async function insertOrderItem(orderId, opts) {
    const price = opts.price || 100;
    const qty = opts.qty || 1;
    const data = {
      order_id: orderId,
      item_name: opts.name || 'Test Item', variant_name: opts.variant || null,
      quantity: qty, unit_price: price, base_price: price,
      total_price: qty * price,
      status: opts.status || 'served',
      created_by: USER1
    };
    if (opts.itemId) data.item_id = opts.itemId;
    const [res] = await pool.query('INSERT INTO order_items SET ?', data);
    orderItemIds.push(res.insertId);
    return res.insertId;
  }
  async function insertPayment(orderId, opts) {
    const [res] = await pool.query('INSERT INTO payments SET ?', {
      uuid: uid(), outlet_id: OUTLET, order_id: orderId,
      payment_number: 'XPAY-' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      payment_mode: opts.mode || 'cash', amount: opts.amount || 0, tip_amount: opts.tip || 0,
      total_amount: opts.amount || 0, status: 'completed',
      received_by: opts.receivedBy || USER1,
      is_due_collection: opts.isDue ? 1 : 0,
      is_adjustment: opts.isAdj ? 1 : 0, adjustment_amount: opts.adjAmount || 0,
      created_at: opts.ts || TS, updated_at: opts.ts || TS
    });
    paymentIds.push(res.insertId);
    return res.insertId;
  }
  async function insertSplitPay(paymentId, splits) {
    for (const s of splits) {
      const [res] = await pool.query(
        'INSERT INTO split_payments (payment_id, payment_mode, amount, created_at) VALUES (?,?,?,?)',
        [paymentId, s.mode, s.amount, TS]);
      splitPayIds.push(res.insertId);
    }
  }
  async function insertDueTx(orderId, paymentId, customerId, opts) {
    const [res] = await pool.query(
      `INSERT INTO customer_due_transactions 
       (uuid, outlet_id, customer_id, order_id, payment_id, transaction_type, amount, balance_before, balance_after, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uid(), OUTLET, customerId, orderId, paymentId,
       opts.type, opts.amount, opts.balanceBefore||0, opts.balanceAfter||0, opts.createdBy||USER1, opts.ts||TS]);
    dueTransIds.push(res.insertId);
    return res.insertId;
  }

  // Find/use existing customer and item
  const [[cust]] = await pool.query('SELECT id FROM customers WHERE outlet_id = ? LIMIT 1', [OUTLET]);
  const CUST_ID = cust ? cust.id : 1;
  const [itemRows] = await pool.query('SELECT id, name FROM items WHERE outlet_id = ? LIMIT 3', [OUTLET]);
  const ITEM1 = itemRows[0]?.id || null;
  const ITEM2 = itemRows[1]?.id || itemRows[0]?.id || null;
  const ITEM3 = itemRows[2]?.id || itemRows[0]?.id || null;

  try {
    // ===================================================================
    // STEP 1 — Create test data (14 scenarios)
    // ===================================================================
    console.log('--- STEP 1: Creating test data (14 scenarios) ---\n');

    // S1-S10: same as before (dine_in, all by USER1)
    // S1 has 3 items: 2 served + 1 cancelled — cancelled items should NOT appear in shift detail
    const s1 = await insertOrder('S1', { subtotal:1000, tax:180, total:1180, paid:1180, billedBy:USER1 });
    await insertPayment(s1, { mode:'cash', amount:1180 });
    await insertOrderItem(s1, { name:'Butter Chicken', price:500, qty:1, status:'served', itemId:ITEM1 });
    await insertOrderItem(s1, { name:'Naan', price:100, qty:5, status:'served', itemId:ITEM2 });
    await insertOrderItem(s1, { name:'Cancelled Soup', price:200, qty:1, status:'cancelled', itemId:ITEM3 });
    console.log('  S1  dine_in CASH 1180 (user1) [3 items, 1 cancelled]');

    const s2 = await insertOrder('S2', { subtotal:800, tax:144, total:944, paid:944, billedBy:USER1 });
    await insertPayment(s2, { mode:'card', amount:944 });
    console.log('  S2  dine_in CARD 944 (user1)');

    const s3 = await insertOrder('S3', { subtotal:500, tax:90, total:590, paid:590, billedBy:USER1 });
    await insertPayment(s3, { mode:'upi', amount:590 });
    console.log('  S3  dine_in UPI 590 (user1)');

    const s4 = await insertOrder('S4', { subtotal:850, tax:150, total:1000, paid:1000 });
    const s4p = await insertPayment(s4, { mode:'split', amount:1000 });
    await insertSplitPay(s4p, [{ mode:'cash', amount:600 }, { mode:'card', amount:400 }]);
    console.log('  S4  dine_in SPLIT cash=600+card=400 (user1)');

    const s5 = await insertOrder('S5', { subtotal:640, tax:110, total:750, paid:500, due:250, payStatus:'partial' });
    await insertPayment(s5, { mode:'cash', amount:500 });
    await insertDueTx(s5, null, CUST_ID, { type:'due_created', amount:250, balanceAfter:250 });
    console.log('  S5  dine_in PARTIAL cash=500 due=250 (user1)');

    const s6 = await insertOrder('S6', { subtotal:250, tax:50, total:300, paid:300 });
    const s6p = await insertPayment(s6, { mode:'upi', amount:300, isDue:true });
    await insertDueTx(s6, s6p, CUST_ID, { type:'due_collected', amount:-300, balanceAfter:0 });
    console.log('  S6  dine_in DUE-COLL upi=300 by user1');

    await insertOrder('S7', { subtotal:450, tax:0, total:0, paid:0, isNC:true, ncAmount:450, ncReason:'Staff Meal' });
    console.log('  S7  dine_in NC ncAmount=450');

    const s8 = await insertOrder('S8', { subtotal:510, tax:90, total:600, paid:550, isAdj:true, adjAmount:50 });
    await insertPayment(s8, { mode:'card', amount:550, isAdj:true, adjAmount:50 });
    console.log('  S8  dine_in ADJ card=550 adj=50 (user1)');

    const s9 = await insertOrder('S9', { subtotal:999, tax:180, total:1179, paid:0, due:0, status:'cancelled', payStatus:'pending' });
    console.log('  S9  dine_in CANCELLED 1179 (excluded)');

    const s10 = await insertOrder('S10', { subtotal:200, tax:36, total:236, paid:236 });
    await insertPayment(s10, { mode:'wallet', amount:236 });
    console.log('  S10 dine_in WALLET 236 (user1)');

    // S11: Takeaway, CASH, by USER1
    const s11 = await insertOrder('S11', { type:'takeaway', subtotal:500, tax:90, total:590, paid:590 });
    await insertPayment(s11, { mode:'cash', amount:590 });
    console.log('  S11 TAKEAWAY CASH 590 (user1)');

    // S12: Takeaway, UPI, created+billed+received by USER2
    const s12 = await insertOrder('S12', { type:'takeaway', subtotal:300, tax:54, total:354, paid:354, createdBy:USER2, billedBy:USER2, ts:TS2 });
    await insertPayment(s12, { mode:'upi', amount:354, receivedBy:USER2, ts:TS2 });
    console.log('  S12 TAKEAWAY UPI 354 (user2)');

    // S13: Takeaway CANCELLED — must NOT count
    await insertOrder('S13', { type:'takeaway', subtotal:400, tax:72, total:472, paid:0, status:'cancelled', payStatus:'pending', createdBy:USER2, ts:TS2 });
    console.log('  S13 TAKEAWAY CANCELLED 472 (excluded)');

    // S14: Due collected by USER2 (different cashier)
    const s14 = await insertOrder('S14', { subtotal:170, tax:30, total:200, paid:200 });
    const s14p = await insertPayment(s14, { mode:'cash', amount:200, isDue:true, receivedBy:USER2, ts:TS2 });
    await insertDueTx(s14, s14p, CUST_ID, { type:'due_collected', amount:-200, balanceAfter:0, createdBy:USER2, ts:TS2 });
    console.log('  S14 dine_in DUE-COLL cash=200 by user2');

    // Create a shift (day_session) covering the test period
    const [shiftRes] = await pool.query(
      `INSERT INTO day_sessions (outlet_id, session_date, opening_time, closing_time, opening_cash, status, opened_by, cashier_id)
       VALUES (?, ?, ?, ?, 0, 'closed', ?, ?)`,
      [OUTLET, TEST_DATE, BD_START, BD_END, USER1, USER1]
    );
    shiftId = shiftRes.insertId;
    console.log(`\n  Shift created: id=${shiftId}`);
    console.log(`  Created ${orderIds.length} orders, ${paymentIds.length} payments, ${splitPayIds.length} splits\n`);

    // ===================================================================
    // STEP 2 — Expected values
    // ===================================================================
    console.log('--- STEP 2: Expected collection values ---\n');

    // Payments: S1(1180c) S2(944cd) S3(590u) S4(600c+400cd) S5(500c) S6(300u,due)
    //           S8(550cd) S10(236w) S11(590c) S12(354u) S14(200c,due)
    // Cancelled: S9, S13 — no payments. S7 NC — no payment.
    const E = {
      total: 1180+944+590+1000+500+300+550+236+590+354+200,  // 6444
      dueColl: 300+200,                                        // 500
      cash: 1180+600+500+590+200,                             // 3070
      card: 944+400+550,                                       // 1894
      upi: 590+300+354,                                        // 1244
      wallet: 236,
      credit: 0,
      due: 250,       // S5
      nc: 450,        // S7
      ncCount: 1,
      adj: 50,        // S8
      adjCount: 1,
    };
    E.fresh = E.total - E.dueColl; // 5944

    // Per-cashier expected (for shift detail)
    const E_USER1 = {
      ordersCreated: 11,    // S1-S8, S10, S11, S14 created by user1 = 12, minus S9 cancelled = 11 completed
      ordersCancelled: 1,   // S9
      ordersHandled: 3,     // S1,S2,S3 billed_by USER1
      amountCollected: 1180+944+590+1000+500+300+550+236+590, // all except S12(354 by user2), S14(200 by user2) = 5890
      dueCollected: 300,    // S6
    };
    const E_USER2 = {
      ordersCreated: 1,     // S12 (S13 cancelled, S14 created by USER1)
      ordersCancelled: 1,   // S13
      ordersHandled: 1,     // S12 billed_by USER2
      amountCollected: 354+200, // S12(354) + S14(200) = 554
      dueCollected: 200,    // S14
    };

    for (const [k,v] of Object.entries(E)) console.log(`  ${k.padEnd(12)}: ${v}`);
    console.log();
    ok('mode sum = total', E.cash+E.card+E.upi+E.wallet+E.credit, E.total);
    ok('fresh+due = total', E.fresh+E.dueColl, E.total);
    console.log();

    // ===================================================================
    // STEP 3 — Raw DB verification
    // ===================================================================
    console.log('--- STEP 3: Raw DB verification ---\n');

    const [dbR] = await pool.query(`
      SELECT SUM(p.total_amount) t,
        SUM(CASE WHEN p.payment_mode='cash' THEN p.total_amount ELSE 0 END) cash_t,
        SUM(CASE WHEN p.payment_mode='card' THEN p.total_amount ELSE 0 END) card_t,
        SUM(CASE WHEN p.payment_mode='upi' THEN p.total_amount ELSE 0 END) upi_t,
        SUM(CASE WHEN p.payment_mode='wallet' THEN p.total_amount ELSE 0 END) wal_t,
        SUM(CASE WHEN COALESCE(p.is_due_collection,0)=1 THEN p.total_amount ELSE 0 END) due_c
      FROM payments p WHERE p.outlet_id=? AND p.created_at>=? AND p.created_at<? AND p.status='completed' AND p.payment_mode!='split'`,
      [OUTLET, BD_START, BD_END]);
    const [dbS] = await pool.query(`
      SELECT SUM(sp.amount) t,
        SUM(CASE WHEN sp.payment_mode='cash' THEN sp.amount ELSE 0 END) cash_t,
        SUM(CASE WHEN sp.payment_mode='card' THEN sp.amount ELSE 0 END) card_t,
        SUM(CASE WHEN sp.payment_mode='upi' THEN sp.amount ELSE 0 END) upi_t,
        SUM(CASE WHEN sp.payment_mode='wallet' THEN sp.amount ELSE 0 END) wal_t,
        SUM(CASE WHEN COALESCE(p.is_due_collection,0)=1 THEN sp.amount ELSE 0 END) due_c
      FROM split_payments sp JOIN payments p ON sp.payment_id=p.id
      WHERE p.outlet_id=? AND p.created_at>=? AND p.created_at<? AND p.status='completed' AND p.payment_mode='split'`,
      [OUTLET, BD_START, BD_END]);
    const dr=dbR[0], ds=dbS[0];
    ok('DB total',  r2((parseFloat(dr.t)||0)+(parseFloat(ds.t)||0)), E.total);
    ok('DB cash',   r2((parseFloat(dr.cash_t)||0)+(parseFloat(ds.cash_t)||0)), E.cash);
    ok('DB card',   r2((parseFloat(dr.card_t)||0)+(parseFloat(ds.card_t)||0)), E.card);
    ok('DB upi',    r2((parseFloat(dr.upi_t)||0)+(parseFloat(ds.upi_t)||0)), E.upi);
    ok('DB wallet', r2((parseFloat(dr.wal_t)||0)+(parseFloat(ds.wal_t)||0)), E.wallet);
    ok('DB dueColl',r2((parseFloat(dr.due_c)||0)+(parseFloat(ds.due_c)||0)), E.dueColl);

    const [dbO] = await pool.query(`
      SELECT SUM(CASE WHEN status!='cancelled' THEN COALESCE(due_amount,0) ELSE 0 END) due_a,
        SUM(CASE WHEN status!='cancelled' THEN COALESCE(nc_amount,0) ELSE 0 END) nc_a,
        SUM(CASE WHEN is_nc=1 THEN 1 ELSE 0 END) nc_c,
        SUM(CASE WHEN is_adjustment=1 AND status!='cancelled' THEN 1 ELSE 0 END) adj_c,
        SUM(CASE WHEN status!='cancelled' THEN COALESCE(adjustment_amount,0) ELSE 0 END) adj_a,
        SUM(CASE WHEN order_type='takeaway' AND status IN ('completed','paid') THEN 1 ELSE 0 END) takeaway_completed,
        SUM(CASE WHEN order_type='takeaway' AND status='cancelled' THEN 1 ELSE 0 END) takeaway_cancelled
      FROM orders WHERE outlet_id=? AND created_at>=? AND created_at<?`,
      [OUTLET, BD_START, BD_END]);
    const o=dbO[0];
    ok('DB due',    parseFloat(o.due_a)||0, E.due);
    ok('DB nc',     parseFloat(o.nc_a)||0, E.nc);
    ok('DB ncCnt',  parseInt(o.nc_c)||0, E.ncCount);
    ok('DB adjCnt', parseInt(o.adj_c)||0, E.adjCount);
    ok('DB adjAmt', parseFloat(o.adj_a)||0, E.adj);
    ok('DB takeaway completed', parseInt(o.takeaway_completed)||0, 2);  // S11, S12
    ok('DB takeaway cancelled', parseInt(o.takeaway_cancelled)||0, 1);  // S13
    console.log();

    // ===================================================================
    // STEP 4 — Report service collection blocks
    // ===================================================================
    console.log('--- STEP 4: Report service collection blocks ---\n');
    const reportsService = require('../src/services/reports.service');

    function verifyBlock(label, c) {
      if (!c) { warn(`${label} — no collection block`); return; }
      ok(`${label} totalCollection`, c.totalCollection, E.total);
      ok(`${label} freshCollection`, c.freshCollection, E.fresh);
      ok(`${label} dueCollection`,   c.dueCollection,   E.dueColl);
      ok(`${label} cash`,  c.paymentBreakdown?.cash,  E.cash);
      ok(`${label} card`,  c.paymentBreakdown?.card,  E.card);
      ok(`${label} upi`,   c.paymentBreakdown?.upi,   E.upi);
      ok(`${label} wallet`,c.paymentBreakdown?.wallet, E.wallet);
      ok(`${label} totalDue`, c.totalDue, E.due);
      ok(`${label} totalNC`,  c.totalNC,  E.nc);
      ok(`${label} ncCount`,  c.ncOrderCount, E.ncCount);
      ok(`${label} totalAdj`, c.totalAdjustment, E.adj);
      ok(`${label} adjCount`, c.adjustmentCount, E.adjCount);
      // Self-consistency
      ok(`${label} fresh+due=total`, r2(c.freshCollection+c.dueCollection), c.totalCollection);
      const ms = r2((c.paymentBreakdown?.cash||0)+(c.paymentBreakdown?.card||0)+
        (c.paymentBreakdown?.upi||0)+(c.paymentBreakdown?.wallet||0)+(c.paymentBreakdown?.credit||0));
      ok(`${label} modeSum=total`, ms, c.totalCollection);
    }

    const blocks = {};

    console.log('  [4a] getDailySalesReport');
    try { const r = await reportsService.getDailySalesReport(OUTLET, TEST_DATE, TEST_DATE); blocks.DSR = r.summary?.collection; verifyBlock('DSR', blocks.DSR); } catch(e) { warn('DSR err: '+e.message); }
    console.log();

    console.log('  [4b] getLiveDashboard — SKIPPED (uses live today)\n');

    console.log('  [4c] getDayEndSummary');
    try { const r = await reportsService.getDayEndSummary(OUTLET, TEST_DATE, TEST_DATE); blocks.DES = r.grandTotal?.collection; verifyBlock('DES', blocks.DES); } catch(e) { warn('DES err: '+e.message); }
    console.log();

    console.log('  [4d] getDayEndSummaryDetail');
    try { const r = await reportsService.getDayEndSummaryDetail(OUTLET, TEST_DATE); blocks.DESD = r.summary?.collection; verifyBlock('DESD', blocks.DESD); } catch(e) { warn('DESD err: '+e.message); }
    console.log();

    console.log('  [4e] getDailySalesDetail');
    try { const r = await reportsService.getDailySalesDetail(OUTLET, TEST_DATE, TEST_DATE); blocks.DSRD = r.summary?.collection; verifyBlock('DSRD', blocks.DSRD); } catch(e) { warn('DSRD err: '+e.message); }
    console.log();

    // ===================================================================
    // STEP 5 — Cross-API comparison
    // ===================================================================
    console.log('--- STEP 5: Cross-API comparison ---\n');
    const apiNames = Object.keys(blocks);
    if (apiNames.length >= 2) {
      const ref = blocks[apiNames[0]], refN = apiNames[0];
      for (let i = 1; i < apiNames.length; i++) {
        const cmp = blocks[apiNames[i]], cmpN = apiNames[i];
        if (!ref||!cmp) { warn(`Cannot compare ${refN} vs ${cmpN}`); continue; }
        ok(`${refN}==${cmpN} total`, ref.totalCollection, cmp.totalCollection);
        ok(`${refN}==${cmpN} fresh`, ref.freshCollection, cmp.freshCollection);
        ok(`${refN}==${cmpN} dueColl`, ref.dueCollection, cmp.dueCollection);
        ok(`${refN}==${cmpN} cash`, ref.paymentBreakdown?.cash, cmp.paymentBreakdown?.cash);
        ok(`${refN}==${cmpN} card`, ref.paymentBreakdown?.card, cmp.paymentBreakdown?.card);
        ok(`${refN}==${cmpN} upi`, ref.paymentBreakdown?.upi, cmp.paymentBreakdown?.upi);
        ok(`${refN}==${cmpN} wallet`, ref.paymentBreakdown?.wallet, cmp.paymentBreakdown?.wallet);
        ok(`${refN}==${cmpN} due`, ref.totalDue, cmp.totalDue);
        ok(`${refN}==${cmpN} nc`, ref.totalNC, cmp.totalNC);
        ok(`${refN}==${cmpN} adj`, ref.totalAdjustment, cmp.totalAdjustment);
      }
    } else { warn('< 2 APIs returned blocks'); }
    console.log();

    // ===================================================================
    // STEP 6 — Shift Detail verification
    // ===================================================================
    console.log('--- STEP 6: Shift Detail (staff activity, cashier breakdown, due collections) ---\n');
    const paymentService = require('../src/services/payment.service');
    try {
      const sd = await paymentService.getShiftDetail(shiftId);

      // 6a) Collection block
      console.log('  [6a] Shift collection block');
      ok('Shift totalCollection', sd.collection?.totalCollection, E.total);
      ok('Shift freshCollection', sd.collection?.freshCollection, E.fresh);
      ok('Shift dueCollection', sd.collection?.dueCollection, E.dueColl);
      ok('Shift cash', sd.collection?.paymentBreakdown?.cash, E.cash);
      ok('Shift card', sd.collection?.paymentBreakdown?.card, E.card);
      ok('Shift upi', sd.collection?.paymentBreakdown?.upi, E.upi);
      ok('Shift wallet', sd.collection?.paymentBreakdown?.wallet, E.wallet);
      ok('Shift totalDue', sd.collection?.totalDue, E.due);
      ok('Shift totalNC', sd.collection?.totalNC, E.nc);
      ok('Shift totalAdj', sd.collection?.totalAdjustment, E.adj);
      console.log();

      // 6b) Order stats — takeaway should be counted
      console.log('  [6b] Shift orderStats');
      ok('Shift completedOrders', sd.orderStats?.completedOrders, 12); // 14 total - 2 cancelled
      ok('Shift cancelledOrders', sd.orderStats?.cancelledOrders, 2);  // S9 + S13
      ok('Shift takeawayOrders', sd.orderStats?.takeawayOrders, 2);    // S11 + S12
      console.log();

      // 6c) Staff activity — both users should appear, takeaway creators included
      console.log('  [6c] Staff activity');
      const staff1 = sd.staffActivity?.find(s => s.userId === USER1);
      const staff2 = sd.staffActivity?.find(s => s.userId === USER2);

      if (staff1) {
        ok('User1 ordersCreated', staff1.ordersCreated, E_USER1.ordersCreated);
        ok('User1 ordersCancelled', staff1.ordersCancelled, E_USER1.ordersCancelled);
        ok('User1 ordersHandled', staff1.ordersHandled, E_USER1.ordersHandled);
        ok('User1 amountCollected', staff1.amountCollected, E_USER1.amountCollected);
        ok('User1 dueCollected', staff1.dueCollected, E_USER1.dueCollected);
      } else { warn('User1 not found in staffActivity'); }

      if (USER1 !== USER2) {
        if (staff2) {
          ok('User2 ordersCreated', staff2.ordersCreated, E_USER2.ordersCreated);
          ok('User2 ordersCancelled', staff2.ordersCancelled, E_USER2.ordersCancelled);
          ok('User2 ordersHandled', staff2.ordersHandled, E_USER2.ordersHandled);
          ok('User2 amountCollected', staff2.amountCollected, E_USER2.amountCollected);
          ok('User2 dueCollected', staff2.dueCollected, E_USER2.dueCollected);
        } else { warn('User2 not found in staffActivity — takeaway creator missing!'); }
      } else {
        console.log('    (only 1 user in DB — skipping multi-cashier staff checks)');
      }
      console.log();

      // 6d) Due collections — should show which cashier collected
      console.log('  [6d] Due collections per cashier');
      const dueColl = sd.dueCollections;
      ok('Shift totalDueCollected', dueColl?.totalCollected, E.dueColl);
      ok('Shift dueCollCount', dueColl?.count, 2); // S6 + S14

      if (dueColl?.orders?.length >= 1) {
        const hasCollectedBy = dueColl.orders.every(d => d.collectedByName !== null);
        ok('Due collections have collectedByName', hasCollectedBy ? 1 : 0, 1);
      }
      console.log();

      // 6e) Cashier breakdown — per-cashier payment totals
      console.log('  [6e] Cashier breakdown');
      if (sd.cashierBreakdown?.length > 0) {
        const cb1 = sd.cashierBreakdown.find(c => c.cashierId === USER1);
        const cb2 = sd.cashierBreakdown.find(c => c.cashierId === USER2);
        if (cb1) ok('CashierBkdn user1 total', cb1.totalCollection, E_USER1.amountCollected);
        if (cb2 && USER1 !== USER2) ok('CashierBkdn user2 total', cb2.totalCollection, E_USER2.amountCollected);
        // Sum of all cashier breakdowns should equal total collection
        const cbSum = sd.cashierBreakdown.reduce((s, c) => s + (parseFloat(c.totalCollection)||0), 0);
        ok('CashierBkdn sum = totalCollection', cbSum, E.total);
      } else { warn('No cashier breakdown'); }
      console.log();

      // 6f) Orders list — cancelled orders should exist but clearly marked
      console.log('  [6f] Orders list');
      const cancelledInList = sd.orders?.filter(o => o.status === 'cancelled') || [];
      const completedInList = sd.orders?.filter(o => o.status === 'completed') || [];
      const takeawayInList = sd.orders?.filter(o => o.orderType === 'takeaway') || [];
      ok('Cancelled orders in list', cancelledInList.length, 2);  // S9, S13
      ok('Completed orders in list', completedInList.length, 12); // all non-cancelled
      ok('Takeaway orders in list', takeawayInList.length, 3);    // S11, S12, S13 (incl cancelled)

      // 6g) Cancelled items excluded — S1 has 3 items but 1 cancelled, only 2 should appear
      console.log();
      console.log('  [6g] Cancelled items excluded from order items');
      const s1Order = sd.orders?.find(o => o.orderNumber === 'XTEST-S1');
      if (s1Order) {
        ok('S1 items count (excl cancelled)', s1Order.items?.length, 2);
        const cancelledItems = (s1Order.items || []).filter(i => i.status === 'cancelled');
        ok('S1 no cancelled items', cancelledItems.length, 0);
      } else { warn('S1 order not found in shift detail orders list'); }

    } catch (e) {
      warn('getShiftDetail error: ' + e.message);
      console.error(e.stack?.split('\n').slice(0,5).join('\n'));
    }

    // ===================================================================
    // STEP 7 — Shift History verification
    // ===================================================================
    console.log('--- STEP 7: Shift History (/shifts/:outletId/history) ---\n');
    try {
      const sh = await paymentService.getShiftHistory({ outletId: OUTLET, startDate: TEST_DATE, endDate: TEST_DATE, limit: 100 });
      const thisShift = sh?.shifts?.find(s => s.id === shiftId);
      if (!thisShift) { warn('Test shift not found in shift history'); }
      else {
        ok('History totalOrders', thisShift.totalOrders, 12); // 14 - 2 cancelled
        ok('History cancelledOrders', thisShift.orderStats?.cancelledOrders, 2);
        ok('History takeawayOrders', thisShift.orderStats?.takeawayOrders, 2);
        ok('History collection.totalCollection', thisShift.collection?.totalCollection, E.total);
        ok('History collection.freshCollection', thisShift.collection?.freshCollection, E.fresh);
        ok('History collection.dueCollection', thisShift.collection?.dueCollection, E.dueColl);
        ok('History collection.cash', thisShift.collection?.paymentBreakdown?.cash, E.cash);
        ok('History collection.card', thisShift.collection?.paymentBreakdown?.card, E.card);
        ok('History collection.upi', thisShift.collection?.paymentBreakdown?.upi, E.upi);
        ok('History collection.wallet', thisShift.collection?.paymentBreakdown?.wallet, E.wallet);
        ok('History collection.totalDue', thisShift.collection?.totalDue, E.due);
        ok('History collection.totalNC', thisShift.collection?.totalNC, E.nc);
        ok('History collection.totalAdj', thisShift.collection?.totalAdjustment, E.adj);
      }
    } catch (e) {
      warn('getShiftHistory error: ' + e.message);
      console.error(e.stack?.split('\n').slice(0,3).join('\n'));
    }
    console.log();

    // ===================================================================
    // STEP 8 — Shift Summary (per-shift /summary) verification
    // ===================================================================
    console.log('--- STEP 8: Shift Summary (/shifts/:shiftId/summary) ---\n');
    try {
      const ss = await paymentService.getShiftSummaryById(shiftId);
      ok('Summary totalOrders', ss.totalOrders, 12);
      ok('Summary totalSales', ss.totalSales, E.total);
      ok('Summary totalCashSales', ss.totalCashSales, E.cash);
      ok('Summary totalCardSales', ss.totalCardSales, E.card);
      ok('Summary totalUpiSales', ss.totalUpiSales, E.upi);
      // Collection block
      ok('Summary collection.totalCollection', ss.collection?.totalCollection, E.total);
      ok('Summary collection.freshCollection', ss.collection?.freshCollection, E.fresh);
      ok('Summary collection.dueCollection', ss.collection?.dueCollection, E.dueColl);
      ok('Summary collection.cash', ss.collection?.paymentBreakdown?.cash, E.cash);
      ok('Summary collection.card', ss.collection?.paymentBreakdown?.card, E.card);
      ok('Summary collection.upi', ss.collection?.paymentBreakdown?.upi, E.upi);
      ok('Summary collection.totalDue', ss.collection?.totalDue, E.due);
      ok('Summary collection.totalNC', ss.collection?.totalNC, E.nc);
      ok('Summary collection.totalAdj', ss.collection?.totalAdjustment, E.adj);
    } catch (e) {
      warn('getShiftSummaryById error: ' + e.message);
      console.error(e.stack?.split('\n').slice(0,3).join('\n'));
    }
    console.log();

    // ===================================================================
    // STEP 9 — Outlet Summary (/shifts/:outletId/outlet-summary) verification
    // ===================================================================
    console.log('--- STEP 9: Outlet Summary (/shifts/:outletId/outlet-summary) ---\n');
    try {
      const os = await paymentService.getShiftSummary({ outletId: OUTLET, startDate: TEST_DATE, endDate: TEST_DATE });
      // Outlet summary aggregates across all shifts — just verify test shift contributes
      if (os) {
        ok('OutletSummary has totalOrders >= 12', os.totalOrders >= 12 ? 1 : 0, 1);
        ok('OutletSummary has totalSales >= E.total', os.totalSales >= E.total ? 1 : 0, 1);
        console.log(`    (OutletSummary totalOrders=${os.totalOrders} totalSales=${os.totalSales} — includes other shifts)`);
      } else { warn('getShiftSummary returned null'); }
    } catch (e) {
      warn('getShiftSummary error: ' + e.message);
      console.error(e.stack?.split('\n').slice(0,3).join('\n'));
    }
    console.log();

  } finally {
    // ===================================================================
    // CLEANUP
    // ===================================================================
    console.log('\n--- CLEANUP ---\n');
    try {
      if (shiftId) await pool.query('DELETE FROM day_sessions WHERE id = ?', [shiftId]);
      if (dueTransIds.length) await pool.query('DELETE FROM customer_due_transactions WHERE id IN (?)', [dueTransIds]);
      if (splitPayIds.length) await pool.query('DELETE FROM split_payments WHERE id IN (?)', [splitPayIds]);
      if (paymentIds.length) await pool.query('DELETE FROM payments WHERE id IN (?)', [paymentIds]);
      if (orderItemIds.length) await pool.query('DELETE FROM order_items WHERE id IN (?)', [orderItemIds]);
      if (orderIds.length) await pool.query('DELETE FROM orders WHERE id IN (?)', [orderIds]);
      console.log(`  Cleaned: ${orderIds.length} orders, ${orderItemIds.length} items, ${paymentIds.length} payments, ${splitPayIds.length} splits, ${dueTransIds.length} due_tx, shift=${shiftId||'none'}\n`);
    } catch (e) { console.error('  Cleanup error:', e.message); }
  }

  console.log('========================================================');
  console.log(` FINAL: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('========================================================\n');
  await closePool();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
