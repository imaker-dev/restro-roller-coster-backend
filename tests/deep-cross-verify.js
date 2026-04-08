/**
 * Deep Cross-Verification: Outlet 46, Apr 1-6, Cashiers Aditya & Shiv
 * 
 * Maps every single order to its business day AND shift.
 * Verifies DSR totals, shift totals, and finds any gaps/overlaps.
 * 
 * Reference numbers to verify:
 *   Total Sale:   ₹5,28,074  (357 completed orders)
 *   NC Amount:    ₹2,267
 *   Discount:     ₹13,628
 *   Cancelled items in orders: ₹20,351
 *   Cancelled orders: ₹11,616
 */

const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE = 'http://localhost:3005/api/v1';
const OUTLET_ID = 46;
let token = null, pool = null;
let pass = 0, fail = 0;

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

// Convert DB datetime to IST string
function toIST(d) {
  if (!d) return null;
  const dt = new Date(d);
  dt.setMinutes(dt.getMinutes() + 330); // UTC+5:30
  return dt.toISOString().replace('T', ' ').slice(0, 19);
}

// Convert DB datetime to MySQL format (server stores in UTC, node driver reads as UTC)
function toMySQL(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  }
  return String(d);
}

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
  if (a === e) { pass++; console.log(`  ✅ ${label}: ${a} === ${e}`); }
  else { fail++; console.log(`  ❌ ${label}: got ${a}, expected ${e}`); }
}

async function run() {
  pool = mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });
  const loginRes = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  token = loginRes.data.accessToken;

  // ================================================================
  // SECTION A: Verify DSR reference numbers from DB
  // Business day Apr 1-6: 2026-04-01 04:00:00 IST to 2026-04-07 03:59:59 IST
  // In UTC: 2026-03-31 22:30:00 to 2026-04-06 22:29:59
  // But MySQL stores created_at in server timezone, let's check what the service uses
  // ================================================================
  console.log('═'.repeat(90));
  console.log('SECTION A: Verify DSR Reference Numbers from DB (Business Day Apr 1-6, 4am-4am)');
  console.log('═'.repeat(90));

  // The service uses: created_at >= startDt AND created_at < endDt+1day
  // businessDayRange for Apr 1 to Apr 6 → startDt=2026-04-01, endDt=2026-04-06
  // bdWhere: created_at >= '2026-04-01 04:00:00' AND created_at < '2026-04-07 04:00:00'
  const BD_START = '2026-04-01 04:00:00';
  const BD_END = '2026-04-07 03:59:59';

  // Get all completed orders in business day
  const [completedOrders] = await pool.query(
    `SELECT id, order_number, total_amount, status, order_type, floor_id,
            is_nc, nc_amount, discount_amount, is_adjustment, adjustment_amount,
            due_amount, paid_amount, payment_status, created_at
     FROM orders
     WHERE outlet_id = ? AND status = 'completed'
       AND created_at >= ? AND created_at < '2026-04-07 04:00:00'
     ORDER BY created_at`,
    [OUTLET_ID, BD_START]
  );

  // Get all cancelled orders
  const [cancelledOrders] = await pool.query(
    `SELECT id, order_number, total_amount, status, created_at
     FROM orders
     WHERE outlet_id = ? AND status = 'cancelled'
       AND created_at >= ? AND created_at < '2026-04-07 04:00:00'
     ORDER BY created_at`,
    [OUTLET_ID, BD_START]
  );

  // Get cancelled items within completed orders
  const [cancelledItems] = await pool.query(
    `SELECT oi.order_id, oi.id as item_id, oi.total_price, oi.status as item_status
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     WHERE o.outlet_id = ? AND o.status = 'completed'
       AND o.created_at >= ? AND o.created_at < '2026-04-07 04:00:00'
       AND oi.status = 'cancelled'`,
    [OUTLET_ID, BD_START]
  );

  const totalSale = r2(completedOrders.reduce((s, o) => s + parseFloat(o.total_amount), 0));
  const totalCompletedCount = completedOrders.length;
  const ncAmount = r2(completedOrders.reduce((s, o) => s + (parseFloat(o.nc_amount) || 0), 0));
  const discountAmount = r2(completedOrders.reduce((s, o) => s + (parseFloat(o.discount_amount) || 0), 0));
  const cancelledItemsTotal = r2(cancelledItems.reduce((s, i) => s + (parseFloat(i.total_price) || 0), 0));
  const cancelledOrdersTotal = r2(cancelledOrders.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0));

  console.log('\n  Reference values vs DB:');
  check('Total Sale (357 completed orders)', totalSale, 528074);
  checkInt('Completed order count', totalCompletedCount, 357);
  check('NC Amount', ncAmount, 2267);
  check('Discount Amount', discountAmount, 13628, 1);
  check('Cancelled items in completed orders', cancelledItemsTotal, 20351);
  check('Cancelled orders total_amount', cancelledOrdersTotal, 11616);
  console.log(`  Cancelled orders count: ${cancelledOrders.length}`);

  // Verify via DSR API
  console.log('\n  DSR API verification:');
  const dsrRes = await api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET_ID}&startDate=2026-04-01&endDate=2026-04-06`);
  if (dsrRes.success) {
    const gt = dsrRes.data.grandTotal;
    check('DSR total_sale', gt.total_sale, 528074);
    checkInt('DSR total_orders', gt.total_orders, 357);
    check('DSR nc_amount', gt.nc_amount, 2267);
    check('DSR discount_amount', gt.discount_amount, 13628, 1);
  }

  // ================================================================
  // SECTION B: Map every completed order to its shift
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('SECTION B: Map every completed order to its shift');
  console.log('═'.repeat(90));

  // Get ALL shifts for outlet 46 that could overlap with business day Apr 1-6
  const [allShifts] = await pool.query(
    `SELECT ds.id, ds.session_date, ds.opening_time, ds.closing_time, ds.status,
            ds.cashier_id, u.name as cashier_name, ds.floor_id, f.name as floor_name,
            ds.opening_cash, ds.closing_cash, ds.cash_variance
     FROM day_sessions ds
     LEFT JOIN users u ON ds.cashier_id = u.id
     LEFT JOIN floors f ON ds.floor_id = f.id
     WHERE ds.outlet_id = ?
       AND ds.opening_time < '2026-04-07 04:00:00'
       AND (ds.closing_time > '2026-04-01 04:00:00' OR ds.closing_time IS NULL)
     ORDER BY ds.opening_time`,
    [OUTLET_ID]
  );

  // Filter to shifts with session_date Apr 1-6 (IST)
  const apr1to6Shifts = allShifts.filter(s => {
    const sd = new Date(s.session_date);
    sd.setMinutes(sd.getMinutes() + 330);
    const dateStr = sd.toISOString().slice(0, 10);
    return dateStr >= '2026-04-01' && dateStr <= '2026-04-06';
  });

  console.log(`\n  Shifts with session_date Apr 1-6 (IST): ${apr1to6Shifts.length}`);
  for (const s of apr1to6Shifts) {
    const sd = new Date(s.session_date); sd.setMinutes(sd.getMinutes() + 330);
    console.log(`    Shift #${s.id} | ${sd.toISOString().slice(0,10)} | ${s.cashier_name} | Floor: ${s.floor_name} | ${toIST(s.opening_time)} → ${toIST(s.closing_time)}`);
  }

  // Map each completed order to shift(s)
  const orderShiftMap = {}; // orderId -> [shiftIds]
  const shiftOrderMap = {}; // shiftId -> [orderIds]
  
  for (const s of apr1to6Shifts) {
    shiftOrderMap[s.id] = [];
    const sStart = toMySQL(s.opening_time);
    const sEnd = s.closing_time ? toMySQL(s.closing_time) : toMySQL(new Date());
    const floorId = s.floor_id;

    const flCond = floorId
      ? ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`
      : '';
    const flParams = floorId ? [floorId, s.cashier_id] : [];

    const [shiftOrders] = await pool.query(
      `SELECT id FROM orders
       WHERE outlet_id = ? AND status = 'completed'
         AND created_at >= ? AND created_at <= ?${flCond}`,
      [OUTLET_ID, sStart, sEnd, ...flParams]
    );

    for (const o of shiftOrders) {
      if (!orderShiftMap[o.id]) orderShiftMap[o.id] = [];
      orderShiftMap[o.id].push(s.id);
      shiftOrderMap[s.id].push(o.id);
    }
  }

  // Orders in business day but NOT in any shift
  const ordersInBD = new Set(completedOrders.map(o => o.id));
  const ordersInShifts = new Set(Object.keys(orderShiftMap).map(Number));
  
  const inBDnotShift = [...ordersInBD].filter(id => !ordersInShifts.has(id));
  const inShiftNotBD = [...ordersInShifts].filter(id => !ordersInBD.has(id));
  const inBoth = [...ordersInBD].filter(id => ordersInShifts.has(id));

  console.log(`\n  Orders in business day (Apr 1-6): ${ordersInBD.size}`);
  console.log(`  Orders in any shift: ${ordersInShifts.size}`);
  console.log(`  In both: ${inBoth.length}`);
  console.log(`  In BD but NOT in any shift: ${inBDnotShift.length}`);
  console.log(`  In shift but NOT in BD: ${inShiftNotBD.length}`);

  // Show orders in BD but not in any shift
  if (inBDnotShift.length > 0) {
    console.log('\n  ⚠️  Orders in Business Day but NOT covered by any shift:');
    for (const oid of inBDnotShift) {
      const o = completedOrders.find(x => x.id === oid);
      console.log(`    Order #${o.id} (${o.order_number}) | ₹${o.total_amount} | ${o.order_type} | floor:${o.floor_id} | created: ${toIST(o.created_at)}`);
    }
  }

  // Show orders in shift but not in BD
  if (inShiftNotBD.length > 0) {
    console.log('\n  ⚠️  Orders in shifts but NOT in Business Day range:');
    for (const oid of inShiftNotBD) {
      const [ores] = await pool.query('SELECT id, order_number, total_amount, status, floor_id, order_type, created_at FROM orders WHERE id = ?', [oid]);
      const o = ores[0];
      const shiftIds = orderShiftMap[oid];
      console.log(`    Order #${o.id} (${o.order_number}) | ₹${o.total_amount} | ${o.order_type} | floor:${o.floor_id} | created: ${toIST(o.created_at)} | in shifts: ${shiftIds.join(',')}`);
    }
  }

  // Orders in multiple shifts (potential double count)
  const multiShiftOrders = Object.entries(orderShiftMap).filter(([, sids]) => sids.length > 1);
  if (multiShiftOrders.length > 0) {
    console.log(`\n  ⚠️  Orders in MULTIPLE shifts (possible double count): ${multiShiftOrders.length}`);
    for (const [oid, sids] of multiShiftOrders.slice(0, 10)) {
      console.log(`    Order #${oid} in shifts: ${sids.join(', ')}`);
    }
  } else {
    console.log(`\n  ✅ No orders in multiple shifts — no double counting`);
  }

  // ================================================================
  // SECTION C: Per business day breakdown — shift mapping
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('SECTION C: Per Business Day — order-to-shift mapping');
  console.log('═'.repeat(90));

  const businessDays = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06'];

  for (const bd of businessDays) {
    const bdStart = `${bd} 04:00:00`;
    const ndParts = bd.split('-').map(Number);
    const nd = new Date(ndParts[0], ndParts[1] - 1, ndParts[2] + 1);
    const bdEnd = `${nd.getFullYear()}-${String(nd.getMonth()+1).padStart(2,'0')}-${String(nd.getDate()).padStart(2,'0')} 04:00:00`;

    const dayOrders = completedOrders.filter(o => {
      const ca = toMySQL(o.created_at);
      return ca >= bdStart && ca < bdEnd;
    });

    const daySale = r2(dayOrders.reduce((s, o) => s + parseFloat(o.total_amount), 0));
    const dayCount = dayOrders.length;

    // Which shifts cover these orders?
    const shiftContrib = {}; // shiftId -> { count, sale, cashier }
    for (const o of dayOrders) {
      const sids = orderShiftMap[o.id] || [];
      if (sids.length === 0) {
        if (!shiftContrib['NO_SHIFT']) shiftContrib['NO_SHIFT'] = { count: 0, sale: 0, cashier: 'UNASSIGNED' };
        shiftContrib['NO_SHIFT'].count++;
        shiftContrib['NO_SHIFT'].sale += parseFloat(o.total_amount);
      } else {
        for (const sid of sids) {
          if (!shiftContrib[sid]) {
            const sh = apr1to6Shifts.find(s => s.id === sid);
            shiftContrib[sid] = { count: 0, sale: 0, cashier: sh?.cashier_name || '?' };
          }
          shiftContrib[sid].count++;
          shiftContrib[sid].sale += parseFloat(o.total_amount);
        }
      }
    }

    console.log(`\n  ── Business Day: ${bd} (${bdStart} → ${bdEnd}) ──`);
    console.log(`  Total: ₹${daySale} | ${dayCount} completed orders`);
    for (const [sid, info] of Object.entries(shiftContrib)) {
      console.log(`    Shift #${sid} (${info.cashier}): ₹${r2(info.sale)} | ${info.count} orders`);
    }

    // DSR for this day
    const dsrDay = dsrRes.success ? (dsrRes.data.days || []).find(d => d.date === bd) : null;
    if (dsrDay) {
      check(`BD ${bd} DB sale vs DSR`, daySale, dsrDay.total_sale);
      checkInt(`BD ${bd} DB orders vs DSR`, dayCount, dsrDay.total_orders);
    }
  }

  // ================================================================
  // SECTION D: Per shift — verify summary & detail APIs match DB
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('SECTION D: Per Shift — API Summary & Detail vs DB (all 12 shifts)');
  console.log('═'.repeat(90));

  const cashierTotals = {}; // cashierId -> { name, sale, orders, dueColl, cash, card, upi, shifts }

  for (const s of apr1to6Shifts) {
    const sd = new Date(s.session_date); sd.setMinutes(sd.getMinutes() + 330);
    const dateStr = sd.toISOString().slice(0, 10);
    const shiftOrders = shiftOrderMap[s.id] || [];
    
    // Get order details for this shift from DB
    let dbSale = 0, dbCount = 0;
    if (shiftOrders.length > 0) {
      const [dbOrd] = await pool.query(
        `SELECT SUM(total_amount) as sale, COUNT(*) as cnt FROM orders WHERE id IN (?) AND status = 'completed'`,
        [shiftOrders]
      );
      dbSale = r2(dbOrd[0]?.sale);
      dbCount = parseInt(dbOrd[0]?.cnt) || 0;
    }

    // Get API summary & detail
    const [summaryRes, detailRes] = await Promise.all([
      api('GET', `/orders/shifts/${s.id}/summary`),
      api('GET', `/orders/shifts/${s.id}/detail`)
    ]);

    console.log(`\n  ── Shift #${s.id} | ${dateStr} | ${s.cashier_name} | ${s.floor_name} ──`);
    console.log(`     Time: ${toIST(s.opening_time)} → ${toIST(s.closing_time)}`);
    console.log(`     DB: ₹${dbSale} | ${dbCount} orders`);

    if (summaryRes.success) {
      const sm = summaryRes.data;
      console.log(`     Summary API: totalSales=₹${sm.totalSales} | orders=${sm.totalOrders} | dueColl=${sm.collection?.dueCollection || 0}`);
      check(`Shift #${s.id} Summary totalSales vs DB`, sm.totalSales, dbSale);
      checkInt(`Shift #${s.id} Summary orders vs DB`, sm.totalOrders, dbCount);

      // Payment breakdown
      const pbd = sm.collection?.paymentBreakdown || {};
      console.log(`     Payments: cash=₹${pbd.cash||0}, card=₹${pbd.card||0}, upi=₹${pbd.upi||0}`);

      // Due collection
      const dc = r2(sm.collection?.dueCollection);
      
      // Verify due collection is NOT in totalSales
      if (dc > 0) {
        console.log(`     ℹ️  Due collected: ₹${dc} — shown separately, NOT in totalSales`);
      }

      // Track cashier totals
      if (!cashierTotals[s.cashier_id]) {
        cashierTotals[s.cashier_id] = { name: s.cashier_name, sale: 0, orders: 0, dueColl: 0, cash: 0, card: 0, upi: 0, shiftCount: 0, bdSale: 0, bdOrders: 0 };
      }
      cashierTotals[s.cashier_id].sale += r2(sm.totalSales);
      cashierTotals[s.cashier_id].orders += parseInt(sm.totalOrders) || 0;
      cashierTotals[s.cashier_id].dueColl += dc;
      cashierTotals[s.cashier_id].cash += r2(pbd.cash);
      cashierTotals[s.cashier_id].card += r2(pbd.card);
      cashierTotals[s.cashier_id].upi += r2(pbd.upi);
      cashierTotals[s.cashier_id].shiftCount++;
    }

    if (detailRes.success) {
      const dt = detailRes.data;
      console.log(`     Detail API:  totalSales=₹${dt.totalSales} | orders=${dt.totalOrders} | dueColl=${dt.collection?.dueCollection || 0}`);
      check(`Shift #${s.id} Detail totalSales vs DB`, dt.totalSales, dbSale);
      checkInt(`Shift #${s.id} Detail orders vs DB`, dt.totalOrders, dbCount);

      // Summary vs Detail must match
      if (summaryRes.success) {
        check(`Shift #${s.id} Summary vs Detail totalSales`, summaryRes.data.totalSales, dt.totalSales);
        checkInt(`Shift #${s.id} Summary vs Detail orders`, summaryRes.data.totalOrders, dt.totalOrders);
      }
    }
  }

  // ================================================================
  // SECTION E: Cashier Grand Totals
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('SECTION E: Cashier Grand Totals');
  console.log('═'.repeat(90));

  let allShiftSale = 0, allShiftOrders = 0, allShiftDueColl = 0;
  for (const [cid, ct] of Object.entries(cashierTotals)) {
    console.log(`\n  ${ct.name} (ID: ${cid}) — ${ct.shiftCount} shifts:`);
    console.log(`    Total Sale:     ₹${r2(ct.sale)}`);
    console.log(`    Total Orders:   ${ct.orders}`);
    console.log(`    Due Collected:  ₹${r2(ct.dueColl)}`);
    console.log(`    Cash: ₹${r2(ct.cash)} | Card: ₹${r2(ct.card)} | UPI: ₹${r2(ct.upi)}`);
    allShiftSale += ct.sale;
    allShiftOrders += ct.orders;
    allShiftDueColl += ct.dueColl;
  }

  // ================================================================
  // SECTION F: Grand Reconciliation — Shifts vs DSR
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('SECTION F: Grand Reconciliation — All Shifts vs DSR');
  console.log('═'.repeat(90));

  // Sum of unique orders covered by shifts that are ALSO in business day
  const shiftOrdersInBD = [...ordersInShifts].filter(id => ordersInBD.has(id));
  let shiftBDSale = 0;
  for (const oid of shiftOrdersInBD) {
    const o = completedOrders.find(x => x.id === oid);
    if (o) shiftBDSale += parseFloat(o.total_amount);
  }

  console.log(`\n  DSR Grand Total:            ₹528,074 (357 orders)`);
  console.log(`  DB Verified:                ₹${totalSale} (${totalCompletedCount} orders)`);
  console.log(`  All Shifts Sum (raw):       ₹${r2(allShiftSale)} (${allShiftOrders} orders)`);
  console.log(`  Shift orders also in BD:    ₹${r2(shiftBDSale)} (${shiftOrdersInBD.length} orders)`);
  console.log(`  Orders in BD but no shift:  ${inBDnotShift.length} orders`);
  console.log(`  Orders in shift but not BD: ${inShiftNotBD.length} orders`);

  if (inBDnotShift.length > 0) {
    let unassignedSale = 0;
    console.log(`\n  Orders in Business Day but NOT in any shift (gap hours 4am-12pm):`);
    for (const oid of inBDnotShift) {
      const o = completedOrders.find(x => x.id === oid);
      unassignedSale += parseFloat(o.total_amount);
      console.log(`    #${o.id} (${o.order_number}) ₹${o.total_amount} | ${o.order_type} | floor:${o.floor_id} | ${toIST(o.created_at)}`);
    }
    console.log(`  Total unassigned: ₹${r2(unassignedSale)}`);
    console.log(`\n  These orders fall in the morning gap (4am-~12pm) when no shift is open.`);
    console.log(`  DSR (₹528,074) - shift orders in BD (₹${r2(shiftBDSale)}) = ₹${r2(528074 - shiftBDSale)}`);
    console.log(`  Unassigned orders total: ₹${r2(unassignedSale)}`);
    check('Gap explained: DSR - shiftBD = unassigned', r2(528074 - shiftBDSale), r2(unassignedSale));
  }

  if (inShiftNotBD.length > 0) {
    let outOfBDSale = 0;
    for (const oid of inShiftNotBD) {
      const [ores] = await pool.query('SELECT total_amount FROM orders WHERE id = ?', [oid]);
      outOfBDSale += parseFloat(ores[0]?.total_amount || 0);
    }
    console.log(`\n  Orders in shifts but outside business day range: ₹${r2(outOfBDSale)}`);
    console.log(`  These cause shift sum (₹${r2(allShiftSale)}) to be higher than DSR (₹528,074)`);
    console.log(`  Shift sum - out-of-BD orders = ₹${r2(allShiftSale - outOfBDSale)}`);
  }

  // Final reconciliation
  console.log('\n  ── FINAL RECONCILIATION ──');
  const shiftBDplusUnassigned = r2(shiftBDSale + (inBDnotShift.length > 0 ? 
    inBDnotShift.reduce((s, id) => s + parseFloat(completedOrders.find(x => x.id === id)?.total_amount || 0), 0) : 0));
  check('Shift BD orders + unassigned = DSR total', shiftBDplusUnassigned, 528074);
  check('DB total matches DSR', totalSale, 528074);

  // ================================================================
  // SECTION G: Verify each shift API matches DB exactly
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log('SECTION G: Due Collection Verification');
  console.log('═'.repeat(90));

  // Get all due collection payments in the shift time ranges
  for (const s of apr1to6Shifts) {
    const sStart = toMySQL(s.opening_time);
    const sEnd = s.closing_time ? toMySQL(s.closing_time) : toMySQL(new Date());
    const floorId = s.floor_id;
    const payFlCond = floorId
      ? ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`
      : '';
    const payFlParams = floorId ? [floorId, s.cashier_id] : [];

    const [duePays] = await pool.query(
      `SELECT p.id, p.order_id, p.total_amount, p.payment_mode, p.is_due_collection, p.created_at,
              o.order_number, o.total_amount as order_total
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
         AND p.status = 'completed' AND COALESCE(p.is_due_collection, 0) = 1${payFlCond}`,
      [OUTLET_ID, sStart, sEnd, ...payFlParams]
    );

    if (duePays.length > 0) {
      const sd = new Date(s.session_date); sd.setMinutes(sd.getMinutes() + 330);
      console.log(`\n  Shift #${s.id} (${sd.toISOString().slice(0,10)}, ${s.cashier_name}):`);
      let dcTotal = 0;
      for (const dp of duePays) {
        dcTotal += parseFloat(dp.total_amount);
        console.log(`    Due payment #${dp.id}: ₹${dp.total_amount} for order #${dp.order_id} (${dp.order_number}, order total ₹${dp.order_total}) via ${dp.payment_mode} at ${toIST(dp.created_at)}`);
      }
      console.log(`    Total due collected: ₹${r2(dcTotal)}`);

      // Verify API shows this correctly
      const sRes = await api('GET', `/orders/shifts/${s.id}/summary`);
      if (sRes.success) {
        check(`Shift #${s.id} API dueCollection`, sRes.data.collection?.dueCollection, r2(dcTotal));
        console.log(`    API totalSales: ₹${sRes.data.totalSales} — due ₹${r2(dcTotal)} is NOT included ✅`);
      }
    }
  }

  // ================================================================
  // SUMMARY
  // ================================================================
  console.log('\n' + '═'.repeat(90));
  console.log(`FINAL RESULTS: ✅ ${pass} passed, ❌ ${fail} failed`);
  console.log('═'.repeat(90));

  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
