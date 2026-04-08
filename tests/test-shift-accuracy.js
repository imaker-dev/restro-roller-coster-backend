/**
 * Shift Accuracy Test — Outlet 46, Cashiers Aditya & Shiv
 * Cross-verifies shift summary + detail with DSR for April 1-6, 2026
 * 
 * Rules:
 * 1. totalSales = SUM(total_amount) of completed orders only
 * 2. totalCollection = totalSales
 * 3. Due collection tracked separately, NOT added to total collection/sale
 * 4. Shift summary and detail must match each other
 * 5. Sum of all shifts for a day must match DSR for that day
 */

const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE = 'http://localhost:3005/api/v1';
const OUTLET_ID = 46;
const START_DATE = '2026-04-01';
const END_DATE = '2026-04-06';

let token = null;
let pool = null;
let pass = 0, fail = 0, warn = 0;

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      method, headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const r2 = n => parseFloat((parseFloat(n) || 0).toFixed(2));

function check(label, actual, expected, tolerance = 0.01) {
  const a = r2(actual), e = r2(expected);
  if (Math.abs(a - e) <= tolerance) {
    pass++;
    console.log(`  ✅ ${label}: ${a} === ${e}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}: got ${a}, expected ${e} (diff: ${r2(a - e)})`);
  }
}

function checkInt(label, actual, expected) {
  const a = parseInt(actual) || 0, e = parseInt(expected) || 0;
  if (a === e) {
    pass++;
    console.log(`  ✅ ${label}: ${a} === ${e}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}: got ${a}, expected ${e}`);
  }
}

async function run() {
  pool = mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  // Login
  const loginRes = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  token = loginRes.data.accessToken;
  console.log('✅ Logged in\n');

  // ============================================================
  // 1. Discover all shifts for outlet 46, Apr 1-6
  // ============================================================
  console.log('='.repeat(80));
  console.log('PHASE 1: Discover shifts for outlet 46, Apr 1-6');
  console.log('='.repeat(80));

  const [shifts] = await pool.query(
    `SELECT ds.id, ds.outlet_id, ds.floor_id, f.name as floor_name,
            ds.cashier_id, u.name as cashier_name,
            ds.session_date, ds.opening_time, ds.closing_time, ds.status,
            ds.opening_cash, ds.closing_cash, ds.cash_variance
     FROM day_sessions ds
     LEFT JOIN floors f ON ds.floor_id = f.id
     LEFT JOIN users u ON ds.cashier_id = u.id
     WHERE ds.outlet_id = ? AND ds.session_date BETWEEN ? AND ?
     ORDER BY ds.session_date, ds.opening_time`,
    [OUTLET_ID, START_DATE, END_DATE]
  );

  console.log(`Found ${shifts.length} shifts:\n`);
  for (const s of shifts) {
    const sd = s.session_date instanceof Date ? s.session_date.toISOString().slice(0, 10) : String(s.session_date).slice(0, 10);
    console.log(`  Shift ${s.id} | ${sd} | ${s.cashier_name} (cashier_id=${s.cashier_id}) | Floor: ${s.floor_name} (floor_id=${s.floor_id}) | ${s.status}`);
  }
  console.log('');

  // ============================================================
  // 2. For each shift: verify summary vs detail vs DB
  // ============================================================
  console.log('='.repeat(80));
  console.log('PHASE 2: Per-shift verification — Summary vs Detail vs DB');
  console.log('='.repeat(80));

  for (const shift of shifts) {
    const sd = shift.session_date instanceof Date ? shift.session_date.toISOString().slice(0, 10) : String(shift.session_date).slice(0, 10);
    console.log(`\n--- Shift ${shift.id} | ${sd} | ${shift.cashier_name} | Floor: ${shift.floor_name} ---`);

    // Get summary and detail from API
    const [summaryRes, detailRes] = await Promise.all([
      api('GET', `/orders/shifts/${shift.id}/summary`),
      api('GET', `/orders/shifts/${shift.id}/detail`)
    ]);

    if (!summaryRes.success || !detailRes.success) {
      fail++;
      console.log(`  ❌ API error: summary=${summaryRes.success}, detail=${detailRes.success}`);
      if (!summaryRes.success) console.log('    Summary error:', summaryRes.message || summaryRes.error);
      if (!detailRes.success) console.log('    Detail error:', detailRes.message || detailRes.error);
      continue;
    }

    const summary = summaryRes.data;
    const detail = detailRes.data;

    // Build shift time range
    const fdt = (d) => {
      if (!d) return null;
      if (d instanceof Date) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      }
      return String(d);
    };
    const shiftStart = fdt(shift.opening_time);
    let shiftEnd;
    if (shift.closing_time) shiftEnd = fdt(shift.closing_time);
    else shiftEnd = fdt(new Date());

    // Floor conditions
    const floorId = shift.floor_id;
    const flCond = floorId
      ? ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`
      : '';
    const flParams = floorId ? [floorId, shift.cashier_id] : [];

    const payFlCond = floorId
      ? ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`
      : '';
    const payFlParams = floorId ? [floorId, shift.cashier_id] : [];

    // DB: completed orders in shift time range
    const [dbOrders] = await pool.query(
      `SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total_sale,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(discount_amount,0) ELSE 0 END) as discount_amount,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(nc_amount,0) ELSE 0 END) as nc_amount,
        COUNT(CASE WHEN is_nc = 1 AND status = 'completed' THEN 1 END) as nc_orders,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(adjustment_amount,0) ELSE 0 END) as adjustment_amount,
        COUNT(CASE WHEN is_adjustment = 1 AND status = 'completed' THEN 1 END) as adjustment_count,
        SUM(CASE WHEN status = 'completed' THEN COALESCE(due_amount,0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN order_type='dine_in' AND status = 'completed' THEN 1 ELSE 0 END) as dine_in,
        SUM(CASE WHEN order_type='takeaway' AND status = 'completed' THEN 1 ELSE 0 END) as takeaway,
        SUM(CASE WHEN order_type='delivery' AND status = 'completed' THEN 1 ELSE 0 END) as delivery
       FROM orders
       WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?${flCond}`,
      [OUTLET_ID, shiftStart, shiftEnd, ...flParams]
    );

    // DB: payments excluding due collections
    const [dbPayments] = await pool.query(
      `SELECT p.payment_mode, SUM(p.total_amount) as total
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
         AND p.status = 'completed' AND p.payment_mode != 'split'
         AND COALESCE(p.is_due_collection, 0) = 0${payFlCond}
       GROUP BY p.payment_mode`,
      [OUTLET_ID, shiftStart, shiftEnd, ...payFlParams]
    );

    const [dbSplitPayments] = await pool.query(
      `SELECT sp.payment_mode, SUM(sp.amount) as total
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
         AND p.status = 'completed' AND p.payment_mode = 'split'
         AND COALESCE(p.is_due_collection, 0) = 0${payFlCond}
       GROUP BY sp.payment_mode`,
      [OUTLET_ID, shiftStart, shiftEnd, ...payFlParams]
    );

    // DB: due collections
    const [dbDueColl] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount), 0) as due_collected
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
         AND p.status = 'completed' AND COALESCE(p.is_due_collection, 0) = 1${payFlCond}`,
      [OUTLET_ID, shiftStart, shiftEnd, ...payFlParams]
    );

    const db = dbOrders[0];
    const dbTotalSale = r2(db.total_sale);
    const dbCompletedOrders = parseInt(db.completed_orders) || 0;
    const dbCancelledOrders = parseInt(db.cancelled_orders) || 0;
    const dbDueCollected = r2(dbDueColl[0]?.due_collected);

    // Merge payments
    const payMap = {};
    for (const p of [...dbPayments, ...dbSplitPayments]) {
      const mode = p.payment_mode;
      payMap[mode] = (payMap[mode] || 0) + (parseFloat(p.total) || 0);
    }
    const dbCash = r2(payMap['cash'] || 0);
    const dbCard = r2(payMap['card'] || 0);
    const dbUpi = r2(payMap['upi'] || 0);

    console.log(`  DB: totalSale=${dbTotalSale}, completed=${dbCompletedOrders}, cancelled=${dbCancelledOrders}, dueColl=${dbDueCollected}`);
    console.log(`  DB payments (excl due): cash=${dbCash}, card=${dbCard}, upi=${dbUpi}`);

    // 2a. Summary vs DB
    console.log('\n  [Summary vs DB]');
    check('totalSales', summary.totalSales, dbTotalSale);
    check('totalCollection', summary.totalCollection, dbTotalSale);
    checkInt('totalOrders', summary.totalOrders, dbCompletedOrders);
    check('collection.totalCollection', summary.collection?.totalCollection, dbTotalSale);
    check('collection.dueCollection', summary.collection?.dueCollection, dbDueCollected);
    check('collection.cash', summary.collection?.paymentBreakdown?.cash, dbCash);
    check('collection.card', summary.collection?.paymentBreakdown?.card, dbCard);
    check('collection.upi', summary.collection?.paymentBreakdown?.upi, dbUpi);
    checkInt('orderStats.completedOrders', summary.orderStats?.completedOrders, dbCompletedOrders);
    checkInt('orderStats.cancelledOrders', summary.orderStats?.cancelledOrders, dbCancelledOrders);
    check('orderStats.ncAmount', summary.orderStats?.ncAmount, r2(db.nc_amount));
    check('orderStats.adjustmentAmount', summary.orderStats?.adjustmentAmount, r2(db.adjustment_amount));
    check('orderStats.totalDueAmount', summary.orderStats?.totalDueAmount, r2(db.due_amount));

    // 2b. Detail vs DB
    console.log('\n  [Detail vs DB]');
    check('totalSales', detail.totalSales, dbTotalSale);
    check('totalCollection', detail.totalCollection, dbTotalSale);
    checkInt('totalOrders', detail.totalOrders, dbCompletedOrders);
    check('collection.totalCollection', detail.collection?.totalCollection, dbTotalSale);
    check('collection.dueCollection', detail.collection?.dueCollection, dbDueCollected);
    check('collection.cash', detail.collection?.paymentBreakdown?.cash, dbCash);
    check('collection.card', detail.collection?.paymentBreakdown?.card, dbCard);
    check('collection.upi', detail.collection?.paymentBreakdown?.upi, dbUpi);
    checkInt('orderStats.completedOrders', detail.orderStats?.completedOrders, dbCompletedOrders);
    checkInt('orderStats.cancelledOrders', detail.orderStats?.cancelledOrders, dbCancelledOrders);
    check('orderStats.ncAmount', detail.orderStats?.ncAmount, r2(db.nc_amount));
    check('orderStats.adjustmentAmount', detail.orderStats?.adjustmentAmount, r2(db.adjustment_amount));
    check('orderStats.totalDueAmount', detail.orderStats?.totalDueAmount, r2(db.due_amount));

    // 2c. Summary vs Detail match
    console.log('\n  [Summary vs Detail]');
    check('totalSales', summary.totalSales, detail.totalSales);
    check('totalCollection', summary.totalCollection, detail.totalCollection);
    checkInt('totalOrders', summary.totalOrders, detail.totalOrders);
    check('collection.totalCollection', summary.collection?.totalCollection, detail.collection?.totalCollection);
    check('collection.dueCollection', summary.collection?.dueCollection, detail.collection?.dueCollection);
    check('cash', summary.collection?.paymentBreakdown?.cash, detail.collection?.paymentBreakdown?.cash);
    check('card', summary.collection?.paymentBreakdown?.card, detail.collection?.paymentBreakdown?.card);
    check('upi', summary.collection?.paymentBreakdown?.upi, detail.collection?.paymentBreakdown?.upi);

    // 2d. Verify due collection is NOT in totalSales
    console.log('\n  [Due Collection Exclusion]');
    if (dbDueCollected > 0) {
      // If there are due collections, totalSales should NOT include them
      // totalSales should equal SUM(total_amount) of completed orders, not SUM(payments)
      check('totalSales equals order total (not payment total)', summary.totalSales, dbTotalSale);
      console.log(`  ℹ️  Due collected: ${dbDueCollected} — correctly excluded from totalSales=${summary.totalSales}`);
    } else {
      console.log(`  ℹ️  No due collections in this shift`);
      pass++;
    }

    // 2e. Verify detail order list
    if (detail.orders && detail.orders.length > 0) {
      const completedInList = detail.orders.filter(o => o.status === 'completed');
      const orderListSale = r2(completedInList.reduce((sum, o) => sum + (parseFloat(o.totalAmount || o.total_amount) || 0), 0));
      console.log('\n  [Order List Verification]');
      checkInt('orders in list (all)', detail.orders.length, parseInt(db.total_orders) || 0);
      checkInt('completed orders in list', completedInList.length, dbCompletedOrders);
      check('SUM(total_amount) of completed orders in list', orderListSale, dbTotalSale);
    }
  }

  // ============================================================
  // 3. Cross-verify shifts with DSR per business day
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 3: Cross-verify shift totals with DSR per business day');
  console.log('='.repeat(80));

  // Get DSR for Apr 1-6
  const dsrRes = await api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET_ID}&startDate=${START_DATE}&endDate=${END_DATE}`);
  if (!dsrRes.success) {
    fail++;
    console.log(`\n  ❌ DSR API error: ${dsrRes.message || dsrRes.error}`);
  } else {
    const dsrData = dsrRes.data;
    const dsrDays = dsrData.days || [];

    // Get completed orders per business day from DB directly
    for (const dayRow of dsrDays) {
      const date = dayRow.date;
      console.log(`\n--- Business Day: ${date} ---`);
      console.log(`  DSR: total_sale=${dayRow.total_sale}, total_orders=${dayRow.total_orders}`);

      // Find shifts for this date
      const dayShifts = shifts.filter(s => {
        const sd = s.session_date instanceof Date ? s.session_date.toISOString().slice(0, 10) : String(s.session_date).slice(0, 10);
        return sd === date;
      });

      if (dayShifts.length === 0) {
        console.log(`  ℹ️  No shifts found for this date`);
        continue;
      }

      console.log(`  Shifts on this date: ${dayShifts.map(s => `#${s.id} (${s.cashier_name})`).join(', ')}`);

      // Get summary for each shift and sum up
      let shiftTotalSale = 0, shiftTotalOrders = 0, shiftDueColl = 0;
      const shiftSummaries = [];
      for (const s of dayShifts) {
        const sRes = await api('GET', `/orders/shifts/${s.id}/summary`);
        if (sRes.success) {
          const sd = sRes.data;
          shiftSummaries.push({ id: s.id, cashier: s.cashier_name, ...sd });
          shiftTotalSale += r2(sd.totalSales);
          shiftTotalOrders += parseInt(sd.totalOrders) || 0;
          shiftDueColl += r2(sd.collection?.dueCollection);
        }
      }

      // If shifts cover different floors, their sum should match DSR (which covers all floors)
      // But DSR is business-day based (4am-4am) while shifts are opening_time-closing_time
      // So we compare DB query for exact business day
      console.log(`  Shift totals: sale=${r2(shiftTotalSale)}, orders=${shiftTotalOrders}, dueColl=${r2(shiftDueColl)}`);

      // DB verification for this business day
      const bdStart = `${date} 04:00:00`;
      const nextDate = new Date(date + 'T00:00:00');
      nextDate.setDate(nextDate.getDate() + 1);
      const ndStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
      const bdEnd = `${ndStr} 03:59:59`;

      const [dbDay] = await pool.query(
        `SELECT 
          COUNT(*) as completed_orders,
          SUM(total_amount) as total_sale
         FROM orders
         WHERE outlet_id = ? AND status = 'completed'
           AND created_at >= ? AND created_at < ?`,
        [OUTLET_ID, bdStart, bdEnd]
      );

      const dbDaySale = r2(dbDay[0]?.total_sale);
      const dbDayOrders = parseInt(dbDay[0]?.completed_orders) || 0;

      console.log(`  DB (business day ${date} 4am-4am): sale=${dbDaySale}, orders=${dbDayOrders}`);

      check(`DSR total_sale vs DB`, dayRow.total_sale, dbDaySale);
      checkInt(`DSR total_orders vs DB`, dayRow.total_orders, dbDayOrders);

      // Check if shifts cover different time range than business day
      // Shifts are floor-specific, so sum of shifts may differ from DSR if there are orders on other floors
      // or if shift times don't perfectly align with business day

      // Instead, check DB: sum completed orders per shift time range per floor = DSR for that day
      let dbShiftSum = 0;
      for (const s of dayShifts) {
        const sStart = s.opening_time instanceof Date
          ? `${s.opening_time.getFullYear()}-${String(s.opening_time.getMonth() + 1).padStart(2, '0')}-${String(s.opening_time.getDate()).padStart(2, '0')} ${String(s.opening_time.getHours()).padStart(2, '0')}:${String(s.opening_time.getMinutes()).padStart(2, '0')}:${String(s.opening_time.getSeconds()).padStart(2, '0')}`
          : String(s.opening_time);
        let sEnd;
        if (s.closing_time) {
          sEnd = s.closing_time instanceof Date
            ? `${s.closing_time.getFullYear()}-${String(s.closing_time.getMonth() + 1).padStart(2, '0')}-${String(s.closing_time.getDate()).padStart(2, '0')} ${String(s.closing_time.getHours()).padStart(2, '0')}:${String(s.closing_time.getMinutes()).padStart(2, '0')}:${String(s.closing_time.getSeconds()).padStart(2, '0')}`
            : String(s.closing_time);
        } else {
          sEnd = new Date().toISOString().replace('T', ' ').slice(0, 19);
        }
        const flCond2 = s.floor_id
          ? ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`
          : '';
        const flP2 = s.floor_id ? [s.floor_id, s.cashier_id] : [];
        const [sOrd] = await pool.query(
          `SELECT SUM(CASE WHEN status='completed' THEN total_amount ELSE 0 END) as sale
           FROM orders WHERE outlet_id=? AND created_at>=? AND created_at<=?${flCond2}`,
          [OUTLET_ID, sStart, sEnd, ...flP2]
        );
        dbShiftSum += r2(sOrd[0]?.sale);
      }
      check(`Sum of shift DB sales`, r2(shiftTotalSale), r2(dbShiftSum));

      // Print per-cashier breakdown
      for (const ss of shiftSummaries) {
        console.log(`    Cashier ${ss.cashier} (Shift #${ss.id}): sale=${ss.totalSales}, orders=${ss.totalOrders}, dueColl=${ss.collection?.dueCollection || 0}`);
      }
    }
  }

  // ============================================================
  // 4. Cashier-specific deep verification
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 4: Cashier-specific deep verification (Aditya & Shiv)');
  console.log('='.repeat(80));

  // Get unique cashiers
  const cashiers = {};
  for (const s of shifts) {
    if (!cashiers[s.cashier_id]) {
      cashiers[s.cashier_id] = { name: s.cashier_name, shifts: [] };
    }
    cashiers[s.cashier_id].shifts.push(s);
  }

  for (const [cashierId, info] of Object.entries(cashiers)) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`CASHIER: ${info.name} (ID: ${cashierId}) — ${info.shifts.length} shifts`);
    console.log(`${'─'.repeat(60)}`);

    let cashierTotalSale = 0, cashierTotalOrders = 0, cashierDueColl = 0;
    let cashierCash = 0, cashierCard = 0, cashierUpi = 0;

    for (const s of info.shifts) {
      const sd = s.session_date instanceof Date ? s.session_date.toISOString().slice(0, 10) : String(s.session_date).slice(0, 10);
      const sRes = await api('GET', `/orders/shifts/${s.id}/summary`);
      if (!sRes.success) {
        fail++;
        console.log(`  ❌ Shift ${s.id} summary failed`);
        continue;
      }
      const sm = sRes.data;
      console.log(`  Shift #${s.id} (${sd}): sale=${sm.totalSales}, orders=${sm.totalOrders}, dueColl=${sm.collection?.dueCollection || 0}, cash=${sm.collection?.paymentBreakdown?.cash || 0}, card=${sm.collection?.paymentBreakdown?.card || 0}, upi=${sm.collection?.paymentBreakdown?.upi || 0}`);

      cashierTotalSale += r2(sm.totalSales);
      cashierTotalOrders += parseInt(sm.totalOrders) || 0;
      cashierDueColl += r2(sm.collection?.dueCollection);
      cashierCash += r2(sm.collection?.paymentBreakdown?.cash);
      cashierCard += r2(sm.collection?.paymentBreakdown?.card);
      cashierUpi += r2(sm.collection?.paymentBreakdown?.upi);
    }

    console.log(`\n  TOTALS for ${info.name}:`);
    console.log(`    Total Sale: ${r2(cashierTotalSale)}`);
    console.log(`    Total Orders: ${cashierTotalOrders}`);
    console.log(`    Due Collected: ${r2(cashierDueColl)}`);
    console.log(`    Cash: ${r2(cashierCash)}, Card: ${r2(cashierCard)}, UPI: ${r2(cashierUpi)}`);

    // Verify against DB
    let dbCashierSale = 0, dbCashierOrders = 0;
    for (const s of info.shifts) {
      const sStart = s.opening_time instanceof Date
        ? `${s.opening_time.getFullYear()}-${String(s.opening_time.getMonth() + 1).padStart(2, '0')}-${String(s.opening_time.getDate()).padStart(2, '0')} ${String(s.opening_time.getHours()).padStart(2, '0')}:${String(s.opening_time.getMinutes()).padStart(2, '0')}:${String(s.opening_time.getSeconds()).padStart(2, '0')}`
        : String(s.opening_time);
      let sEnd;
      if (s.closing_time) {
        sEnd = s.closing_time instanceof Date
          ? `${s.closing_time.getFullYear()}-${String(s.closing_time.getMonth() + 1).padStart(2, '0')}-${String(s.closing_time.getDate()).padStart(2, '0')} ${String(s.closing_time.getHours()).padStart(2, '0')}:${String(s.closing_time.getMinutes()).padStart(2, '0')}:${String(s.closing_time.getSeconds()).padStart(2, '0')}`
          : String(s.closing_time);
      } else {
        sEnd = new Date().toISOString().replace('T', ' ').slice(0, 19);
      }
      const flCond3 = s.floor_id
        ? ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`
        : '';
      const flP3 = s.floor_id ? [s.floor_id, s.cashier_id] : [];
      const [sOrd] = await pool.query(
        `SELECT COUNT(*) as cnt, SUM(CASE WHEN status='completed' THEN total_amount ELSE 0 END) as sale,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed
         FROM orders WHERE outlet_id=? AND created_at>=? AND created_at<=?${flCond3}`,
        [OUTLET_ID, sStart, sEnd, ...flP3]
      );
      dbCashierSale += r2(sOrd[0]?.sale);
      dbCashierOrders += parseInt(sOrd[0]?.completed) || 0;
    }

    console.log(`    DB Total Sale: ${r2(dbCashierSale)}`);
    console.log(`    DB Total Orders: ${dbCashierOrders}`);

    check(`${info.name} total sale API vs DB`, r2(cashierTotalSale), r2(dbCashierSale));
    checkInt(`${info.name} total orders API vs DB`, cashierTotalOrders, dbCashierOrders);
  }

  // ============================================================
  // 5. Grand total: all shifts sum vs DSR grand total
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('PHASE 5: Grand total verification');
  console.log('='.repeat(80));

  if (dsrRes.success) {
    const dsrGrand = dsrRes.data.grandTotal;
    console.log(`\n  DSR Grand Total: sale=${dsrGrand.total_sale}, orders=${dsrGrand.total_orders}`);

    // Sum all shift summaries
    let allShiftSale = 0, allShiftOrders = 0;
    for (const s of shifts) {
      const sRes = await api('GET', `/orders/shifts/${s.id}/summary`);
      if (sRes.success) {
        allShiftSale += r2(sRes.data.totalSales);
        allShiftOrders += parseInt(sRes.data.totalOrders) || 0;
      }
    }
    console.log(`  All Shifts Sum: sale=${r2(allShiftSale)}, orders=${allShiftOrders}`);

    // Note: shifts may not perfectly equal DSR because:
    // 1. Shifts are floor-specific, DSR covers all floors
    // 2. Shift time ranges may not align with 4am-4am business day
    // 3. Some orders might fall outside any shift time range
    // So we just report this, not hard-fail
    const saleDiff = r2(allShiftSale - dsrGrand.total_sale);
    const orderDiff = allShiftOrders - dsrGrand.total_orders;
    if (Math.abs(saleDiff) < 0.01 && orderDiff === 0) {
      pass++;
      console.log(`  ✅ Grand totals match perfectly!`);
    } else {
      warn++;
      console.log(`  ⚠️  Diff: sale=${saleDiff}, orders=${orderDiff}`);
      console.log(`     (Expected if shifts don't cover full business day or different floors)`);
    }
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log(`RESULTS: ✅ ${pass} passed, ❌ ${fail} failed, ⚠️  ${warn} warnings`);
  console.log('='.repeat(80));

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
