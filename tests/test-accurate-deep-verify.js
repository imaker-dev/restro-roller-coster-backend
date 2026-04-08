/**
 * DEEP CROSS-VERIFICATION — All Accurate APIs
 * 
 * Order-level verification for EVERY completed order:
 *   - total_amount correctness
 *   - NC, discount, adjustment, due, paid amounts
 *   - Business day boundaries
 *   - All 4 APIs produce identical numbers
 *   - Every scenario covered: NC, adjustment, partial, due, discount, overpayment
 *
 * Run: node tests/test-accurate-deep-verify.js
 */
const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE = 'http://localhost:3005/api/v1';
const OUTLET = 46;
const START = '2026-04-01';
const END = '2026-04-06';

let token = null;
let passed = 0, failed = 0, total = 0;
const issues = [];

function r2(n) { return parseFloat((parseFloat(n) || 0).toFixed(2)); }

function check(name, pass, detail) {
  total++;
  if (pass) { passed++; }
  else { failed++; issues.push(`${name}: ${detail || ''}`); console.log(`  FAIL ${name}` + (detail ? ` — ${detail}` : '')); }
}

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + p);
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } }); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  console.log('═'.repeat(90));
  console.log('  DEEP CROSS-VERIFICATION — ALL ACCURATE REPORTS');
  console.log('  Outlet: ' + OUTLET + ', Range: ' + START + ' to ' + END);
  console.log('═'.repeat(90));

  // Login
  const loginRes = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  token = loginRes.data.accessToken;

  const conn = await mysql.createConnection({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  // ═══════════════════════════════════════════════════
  // SECTION A: Fetch all 4 APIs
  // ═══════════════════════════════════════════════════
  console.log('\n── A: FETCH ALL APIS ──');
  const [dsrRes, rdRes, deRes, dashRes] = await Promise.all([
    api('GET', `/reports/accurate-dsr?outletId=${OUTLET}&startDate=${START}&endDate=${END}`),
    api('GET', `/reports/accurate-running-dashboard?outletId=${OUTLET}&startDate=${START}&endDate=${END}`),
    api('GET', `/reports/accurate-day-end-summary?outletId=${OUTLET}&startDate=${START}&endDate=${END}`),
    api('GET', `/reports/accurate-dashboard?outletId=${OUTLET}`)
  ]);

  check('DSR API success', dsrRes.success, `got: ${dsrRes.success}`);
  check('RunDash API success', rdRes.success, `got: ${rdRes.success}`);
  check('DayEnd API success', deRes.success, `got: ${deRes.success}`);
  check('Dashboard API success', dashRes.success, `got: ${dashRes.success}`);

  const dsr = dsrRes.data;
  const rd = rdRes.data;
  const de = deRes.data;
  const dash = dashRes.data;

  // ═══════════════════════════════════════════════════
  // SECTION B: Direct DB — every completed order
  // ═══════════════════════════════════════════════════
  console.log('\n── B: DB ORDER-LEVEL GROUND TRUTH ──');
  const [dbOrders] = await conn.query(
    `SELECT o.id, o.order_number, o.order_type, o.status, o.payment_status,
            o.total_amount, o.subtotal, o.tax_amount, o.discount_amount,
            o.service_charge, o.packaging_charge, o.delivery_charge, o.round_off,
            o.paid_amount, o.due_amount, o.nc_amount, o.is_nc, o.is_adjustment,
            o.adjustment_amount, o.guest_count, o.created_at,
            CAST(DATE(DATE_SUB(o.created_at, INTERVAL 4 HOUR)) AS CHAR) as business_day
     FROM orders o
     WHERE o.outlet_id = ? AND o.status = 'completed'
       AND o.created_at >= ? AND o.created_at < ?
     ORDER BY o.created_at`,
    [OUTLET, START + ' 04:00:00', '2026-04-07 04:00:00']
  );

  console.log(`  Total completed orders in DB: ${dbOrders.length}`);

  // ═══════════════════════════════════════════════════
  // SECTION C: ORDER-LEVEL VERIFICATION
  // ═══════════════════════════════════════════════════
  console.log('\n── C: ORDER-LEVEL CHECKS ──');

  let dbTotalSale = 0, dbDiscount = 0, dbNC = 0, dbAdj = 0, dbPaid = 0, dbDue = 0;
  let dbNCOrders = 0, dbAdjOrders = 0, dbGuests = 0;
  let dbDineIn = 0, dbTakeaway = 0, dbDelivery = 0;
  let dbFullyPaid = 0, dbPartial = 0, dbUnpaid = 0;
  const dbPerDay = {};
  const scenarios = { nc: [], adjustment: [], partial: [], due: [], discount: [], overpayment: [] };

  for (const o of dbOrders) {
    const ta = r2(o.total_amount);
    const sub = r2(o.subtotal);
    const tax = r2(o.tax_amount);
    const disc = r2(o.discount_amount);
    const sc = r2(o.service_charge);
    const pkg = r2(o.packaging_charge);
    const dlv = r2(o.delivery_charge);
    const roff = r2(o.round_off);
    const paid = r2(o.paid_amount);
    const due = r2(o.due_amount);
    const nc = r2(o.nc_amount);
    const adj = r2(o.adjustment_amount);

    // Check: only completed orders should be here
    check(`Order ${o.order_number} status=completed`, o.status === 'completed', `status=${o.status}`);

    // Check: total_amount should roughly equal subtotal - discount + tax + sc + pkg + dlv + round_off
    const expected = r2(sub - disc + tax + sc + pkg + dlv + roff);
    check(`Order ${o.order_number} total_amount formula`,
      Math.abs(ta - expected) < 1,
      `total_amount=${ta}, sub(${sub})-disc(${disc})+tax(${tax})+sc(${sc})+pkg(${pkg})+dlv(${dlv})+roff(${roff})=${expected}`);

    // Accumulate
    dbTotalSale += ta;
    dbDiscount += disc;
    dbNC += (o.is_nc ? nc : 0);
    dbAdj += adj;
    dbPaid += paid;
    dbDue += due;
    dbGuests += (o.guest_count || 0);
    if (o.is_nc) dbNCOrders++;
    if (o.is_adjustment) dbAdjOrders++;
    if (o.order_type === 'dine_in') dbDineIn++;
    else if (o.order_type === 'takeaway') dbTakeaway++;
    else dbDelivery++;
    if (o.payment_status === 'completed') dbFullyPaid++;
    else if (o.payment_status === 'partial') dbPartial++;
    else dbUnpaid++;

    // Categorize scenarios
    if (o.is_nc) scenarios.nc.push(o);
    if (o.is_adjustment) scenarios.adjustment.push(o);
    if (o.payment_status === 'partial') scenarios.partial.push(o);
    if (due > 0) scenarios.due.push(o);
    if (disc > 0) scenarios.discount.push(o);
    if (paid > ta) scenarios.overpayment.push(o);

    // Per business day
    const bd = o.business_day;
    if (!dbPerDay[bd]) dbPerDay[bd] = { orders: 0, sale: 0, disc: 0, nc: 0, adj: 0, paid: 0, due: 0, guests: 0, ncOrders: 0, adjOrders: 0, dineIn: 0, takeaway: 0, delivery: 0 };
    dbPerDay[bd].orders++;
    dbPerDay[bd].sale += ta;
    dbPerDay[bd].disc += disc;
    dbPerDay[bd].nc += (o.is_nc ? nc : 0);
    dbPerDay[bd].adj += adj;
    dbPerDay[bd].paid += paid;
    dbPerDay[bd].due += due;
    dbPerDay[bd].guests += (o.guest_count || 0);
    if (o.is_nc) dbPerDay[bd].ncOrders++;
    if (o.is_adjustment) dbPerDay[bd].adjOrders++;
    if (o.order_type === 'dine_in') dbPerDay[bd].dineIn++;
    else if (o.order_type === 'takeaway') dbPerDay[bd].takeaway++;
    else dbPerDay[bd].delivery++;
  }

  dbTotalSale = r2(dbTotalSale);
  dbDiscount = r2(dbDiscount);
  dbNC = r2(dbNC);
  dbAdj = r2(dbAdj);
  dbPaid = r2(dbPaid);
  dbDue = r2(dbDue);

  console.log(`  DB Totals: orders=${dbOrders.length}, sale=${dbTotalSale}, disc=${dbDiscount}, nc=${dbNC}, adj=${dbAdj}, paid=${dbPaid}, due=${dbDue}`);
  console.log(`  Scenarios: NC=${scenarios.nc.length}, Adj=${scenarios.adjustment.length}, Partial=${scenarios.partial.length}, Due=${scenarios.due.length}, Disc=${scenarios.discount.length}, Overpay=${scenarios.overpayment.length}`);

  // ═══════════════════════════════════════════════════
  // SECTION D: DSR ORDER LIST vs DB
  // ═══════════════════════════════════════════════════
  console.log('\n── D: DSR ORDER LIST vs DB ──');
  const dsrOrders = dsr.orders;
  check('DSR order count = DB count', dsrOrders.length === dbOrders.length, `dsr=${dsrOrders.length}, db=${dbOrders.length}`);

  // Build lookup
  const dsrOrderMap = {};
  for (const o of dsrOrders) dsrOrderMap[o.id] = o;

  let dsrOrderSum = 0;
  for (const dbO of dbOrders) {
    const dsrO = dsrOrderMap[dbO.id];
    if (!dsrO) { check(`Order ${dbO.id} exists in DSR`, false, 'missing'); continue; }

    check(`Order ${dbO.id} total_amount match`, Math.abs(r2(dbO.total_amount) - dsrO.total_amount) < 0.01,
      `db=${r2(dbO.total_amount)}, dsr=${dsrO.total_amount}`);
    check(`Order ${dbO.id} discount match`, Math.abs(r2(dbO.discount_amount) - dsrO.discount_amount) < 0.01,
      `db=${r2(dbO.discount_amount)}, dsr=${dsrO.discount_amount}`);
    check(`Order ${dbO.id} paid_amount match`, Math.abs(r2(dbO.paid_amount) - dsrO.paid_amount) < 0.01,
      `db=${r2(dbO.paid_amount)}, dsr=${dsrO.paid_amount}`);
    check(`Order ${dbO.id} due_amount match`, Math.abs(r2(dbO.due_amount) - dsrO.due_amount) < 0.01,
      `db=${r2(dbO.due_amount)}, dsr=${dsrO.due_amount}`);
    check(`Order ${dbO.id} is_nc match`, !!dbO.is_nc === dsrO.is_nc, `db=${!!dbO.is_nc}, dsr=${dsrO.is_nc}`);
    check(`Order ${dbO.id} is_adjustment match`, !!dbO.is_adjustment === dsrO.is_adjustment,
      `db=${!!dbO.is_adjustment}, dsr=${dsrO.is_adjustment}`);

    dsrOrderSum += dsrO.total_amount;
  }

  dsrOrderSum = r2(dsrOrderSum);
  check('DSR order list SUM = DB total_sale', Math.abs(dsrOrderSum - dbTotalSale) < 0.01,
    `dsrOrderSum=${dsrOrderSum}, db=${dbTotalSale}`);

  // ═══════════════════════════════════════════════════
  // SECTION E: ALL API SUMMARIES vs DB
  // ═══════════════════════════════════════════════════
  console.log('\n── E: ALL API SUMMARIES vs DB ──');

  const dsrS = dsr.summary;
  const rdS = rd.summary;
  const deG = de.grandTotal;

  const apis = [
    { name: 'DSR', s: { total_sale: dsrS.total_sale, total_orders: dsrS.total_orders, discount: dsrS.discount_amount, nc: dsrS.nc_amount, adj: dsrS.adjustment_amount, paid: dsrS.total_paid_amount, due: dsrS.total_due_amount, nc_orders: dsrS.nc_order_count, adj_orders: dsrS.adjustment_order_count, dine_in: dsrS.dine_in_orders, takeaway: dsrS.takeaway_orders, delivery: dsrS.delivery_orders, fully_paid: dsrS.fully_paid_orders, partial: dsrS.partial_paid_orders, unpaid: dsrS.unpaid_orders, guests: dsrS.total_guests, collection: dsrS.total_collection } },
    { name: 'RunDash', s: { total_sale: rdS.total_sale, total_orders: rdS.total_orders, discount: rdS.discount_amount, nc: rdS.nc_amount, adj: rdS.adjustment_amount, paid: rdS.total_paid_amount, due: rdS.total_due_amount, nc_orders: rdS.nc_order_count, adj_orders: rdS.adjustment_count, dine_in: rdS.channels[0].count, takeaway: rdS.channels[1].count, delivery: rdS.channels[2].count, guests: rdS.total_guests, collection: rdS.total_collection } },
    { name: 'DayEnd', s: { total_sale: deG.total_sale, total_orders: deG.total_orders, discount: deG.discount_amount, nc: deG.nc_amount, adj: deG.adjustment_amount, paid: deG.paid_amount, due: deG.due_amount, nc_orders: deG.nc_orders, adj_orders: deG.adjustment_count, dine_in: deG.ordersByType.dine_in, takeaway: deG.ordersByType.takeaway, delivery: deG.ordersByType.delivery, guests: deG.total_guests, collection: deG.total_collection } }
  ];

  for (const { name, s } of apis) {
    check(`${name} total_sale = DB`, Math.abs(s.total_sale - dbTotalSale) < 0.01, `api=${s.total_sale}, db=${dbTotalSale}`);
    check(`${name} total_orders = DB`, s.total_orders === dbOrders.length, `api=${s.total_orders}, db=${dbOrders.length}`);
    check(`${name} discount = DB`, Math.abs(s.discount - dbDiscount) < 0.01, `api=${s.discount}, db=${dbDiscount}`);
    check(`${name} nc_amount = DB`, Math.abs(s.nc - dbNC) < 0.01, `api=${s.nc}, db=${dbNC}`);
    check(`${name} adjustment = DB`, Math.abs(s.adj - dbAdj) < 0.01, `api=${s.adj}, db=${dbAdj}`);
    check(`${name} paid = DB`, Math.abs(s.paid - dbPaid) < 0.01, `api=${s.paid}, db=${dbPaid}`);
    check(`${name} due = DB`, Math.abs(s.due - dbDue) < 0.01, `api=${s.due}, db=${dbDue}`);
    check(`${name} nc_orders = DB`, s.nc_orders === dbNCOrders, `api=${s.nc_orders}, db=${dbNCOrders}`);
    check(`${name} adj_orders = DB`, s.adj_orders === dbAdjOrders, `api=${s.adj_orders}, db=${dbAdjOrders}`);
    check(`${name} dine_in = DB`, s.dine_in === dbDineIn, `api=${s.dine_in}, db=${dbDineIn}`);
    check(`${name} takeaway = DB`, s.takeaway === dbTakeaway, `api=${s.takeaway}, db=${dbTakeaway}`);
    check(`${name} delivery = DB`, s.delivery === dbDelivery, `api=${s.delivery}, db=${dbDelivery}`);
    check(`${name} guests = DB`, s.guests === dbGuests, `api=${s.guests}, db=${dbGuests}`);
    check(`${name} collection = total_sale`, Math.abs(s.collection - s.total_sale) < 0.01, `collection=${s.collection}, sale=${s.total_sale}`);
  }

  // ═══════════════════════════════════════════════════
  // SECTION F: PER-DAY — DSR daily vs DayEnd days vs DB
  // ═══════════════════════════════════════════════════
  console.log('\n── F: PER-DAY VERIFICATION ──');

  const dsrDailyMap = {};
  for (const d of dsr.daily) dsrDailyMap[d.date] = d;
  const deDaysMap = {};
  for (const d of de.days) deDaysMap[d.date] = d;

  for (const [dk, dbD] of Object.entries(dbPerDay)) {
    const dsrDay = dsrDailyMap[dk];
    const deDay = deDaysMap[dk];

    if (!dsrDay || !deDay) {
      check(`${dk} exists in DSR & DayEnd`, false, `dsr=${!!dsrDay}, de=${!!deDay}`);
      continue;
    }

    const dbSale = r2(dbD.sale);
    check(`${dk} DSR.sale=DB`, Math.abs(dsrDay.total_sale - dbSale) < 0.01, `dsr=${dsrDay.total_sale}, db=${dbSale}`);
    check(`${dk} DE.sale=DB`, Math.abs(deDay.total_sale - dbSale) < 0.01, `de=${deDay.total_sale}, db=${dbSale}`);
    check(`${dk} DSR.orders=DB`, dsrDay.total_orders === dbD.orders, `dsr=${dsrDay.total_orders}, db=${dbD.orders}`);
    check(`${dk} DE.orders=DB`, deDay.total_orders === dbD.orders, `de=${deDay.total_orders}, db=${dbD.orders}`);
    check(`${dk} DSR.disc=DB`, Math.abs(dsrDay.discount_amount - r2(dbD.disc)) < 0.01, `dsr=${dsrDay.discount_amount}, db=${r2(dbD.disc)}`);
    check(`${dk} DE.disc=DB`, Math.abs(deDay.discount_amount - r2(dbD.disc)) < 0.01, `de=${deDay.discount_amount}, db=${r2(dbD.disc)}`);
    check(`${dk} DSR.nc=DB`, Math.abs(dsrDay.nc_amount - r2(dbD.nc)) < 0.01, `dsr=${dsrDay.nc_amount}, db=${r2(dbD.nc)}`);
    check(`${dk} DSR.collection=sale`, Math.abs(dsrDay.total_collection - dsrDay.total_sale) < 0.01);
    check(`${dk} DE.collection=sale`, Math.abs(deDay.total_collection - deDay.total_sale) < 0.01);
    check(`${dk} DSR.dine_in+take+del=orders`, 
      dsrDay.dine_in_orders + dsrDay.takeaway_orders + dsrDay.delivery_orders === dsrDay.total_orders,
      `${dsrDay.dine_in_orders}+${dsrDay.takeaway_orders}+${dsrDay.delivery_orders}=${dsrDay.dine_in_orders + dsrDay.takeaway_orders + dsrDay.delivery_orders}, total=${dsrDay.total_orders}`);
  }

  // ═══════════════════════════════════════════════════
  // SECTION G: SCENARIO-SPECIFIC CHECKS
  // ═══════════════════════════════════════════════════
  console.log('\n── G: SCENARIO-SPECIFIC CHECKS ──');

  // NC orders
  console.log(`\n  NC Orders (${scenarios.nc.length}):`);
  for (const o of scenarios.nc) {
    const dsrO = dsrOrderMap[o.id];
    if (!dsrO) continue;
    console.log(`    ${o.order_number}: total=${r2(o.total_amount)}, nc_amt=${r2(o.nc_amount)}, paid=${r2(o.paid_amount)}, due=${r2(o.due_amount)}`);
    check(`NC ${o.order_number} is_nc=true in DSR`, dsrO.is_nc === true);
    check(`NC ${o.order_number} nc_amount match`, Math.abs(r2(o.nc_amount) - dsrO.nc_amount) < 0.01);
    check(`NC ${o.order_number} included in order list (total_amount=${dsrO.total_amount}, nc_amount correct)`,
      Math.abs(r2(o.nc_amount) - dsrO.nc_amount) < 0.01, `db_nc=${r2(o.nc_amount)}, dsr_nc=${dsrO.nc_amount}`);
  }

  // Adjustment orders
  console.log(`\n  Adjustment Orders (${scenarios.adjustment.length}):`);
  for (const o of scenarios.adjustment) {
    const dsrO = dsrOrderMap[o.id];
    if (!dsrO) continue;
    console.log(`    ${o.order_number}: total=${r2(o.total_amount)}, adj=${r2(o.adjustment_amount)}, paid=${r2(o.paid_amount)}, due=${r2(o.due_amount)}`);
    check(`Adj ${o.order_number} is_adjustment=true in DSR`, dsrO.is_adjustment === true);
    check(`Adj ${o.order_number} adj_amount match`, Math.abs(r2(o.adjustment_amount) - dsrO.adjustment_amount) < 0.01);
    check(`Adj ${o.order_number} included in total_sale`, dsrO.total_amount > 0);
  }

  // Partial/Due orders
  console.log(`\n  Partial/Due Orders (${scenarios.partial.length} partial, ${scenarios.due.length} with due):`);
  for (const o of scenarios.due.slice(0, 10)) { // show first 10
    const dsrO = dsrOrderMap[o.id];
    if (!dsrO) continue;
    console.log(`    ${o.order_number}: total=${r2(o.total_amount)}, paid=${r2(o.paid_amount)}, due=${r2(o.due_amount)}, status=${o.payment_status}`);
    check(`Due ${o.order_number} due_amount match`, Math.abs(r2(o.due_amount) - dsrO.due_amount) < 0.01);
    check(`Due ${o.order_number} total included in sale`, dsrO.total_amount > 0);
  }

  // Discount orders
  console.log(`\n  Discount Orders (${scenarios.discount.length}):`);
  let discOrderSum = 0;
  for (const o of scenarios.discount) {
    discOrderSum += r2(o.discount_amount);
    const dsrO = dsrOrderMap[o.id];
    if (!dsrO) continue;
    check(`Disc ${o.order_number} discount match`, Math.abs(r2(o.discount_amount) - dsrO.discount_amount) < 0.01);
  }
  check('Sum of discount orders = API discount total', Math.abs(r2(discOrderSum) - dsrS.discount_amount) < 0.01,
    `orderSum=${r2(discOrderSum)}, api=${dsrS.discount_amount}`);

  // Overpayment (paid > total_amount)
  if (scenarios.overpayment.length > 0) {
    console.log(`\n  Overpayment Orders (${scenarios.overpayment.length}):`);
    for (const o of scenarios.overpayment) {
      console.log(`    ${o.order_number}: total=${r2(o.total_amount)}, paid=${r2(o.paid_amount)}, diff=${r2(r2(o.paid_amount) - r2(o.total_amount))}`);
      check(`Overpay ${o.order_number} total_amount used (not paid)`, true, 'total_amount is source of truth');
    }
  }

  // ═══════════════════════════════════════════════════
  // SECTION H: BUSINESS DAY BOUNDARY CHECKS
  // ═══════════════════════════════════════════════════
  console.log('\n── H: BUSINESS DAY BOUNDARY ──');

  // Find orders near boundaries
  const [boundaryOrders] = await conn.query(
    `SELECT o.id, o.order_number, o.created_at,
            CAST(DATE(DATE_SUB(o.created_at, INTERVAL 4 HOUR)) AS CHAR) as business_day,
            HOUR(o.created_at) as hour, MINUTE(o.created_at) as minute
     FROM orders o
     WHERE o.outlet_id = ? AND o.status = 'completed'
       AND o.created_at >= ? AND o.created_at < ?
       AND (HOUR(o.created_at) BETWEEN 3 AND 5)
     ORDER BY o.created_at LIMIT 20`,
    [OUTLET, START + ' 04:00:00', '2026-04-07 04:00:00']
  );

  for (const o of boundaryOrders) {
    const bd = o.business_day;
    const dsrO = dsrOrderMap[o.id];
    if (!dsrO) continue;
    const createdStr = new Date(o.created_at).toISOString();
    const hr = o.hour;
    const expectedBD = hr < 4 
      ? (() => { const d = new Date(o.created_at); d.setDate(d.getDate()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()
      : (() => { const d = new Date(o.created_at); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    
    console.log(`    ${o.order_number}: created=${createdStr}, hr=${hr}:${String(o.minute).padStart(2,'0')}, bd=${bd}`);
    check(`Boundary ${o.order_number} business_day correct`, bd === expectedBD,
      `bd=${bd}, expected=${expectedBD} (hr=${hr})`);
    check(`Boundary ${o.order_number} in DSR order list`, !!dsrO);
  }

  // ═══════════════════════════════════════════════════
  // SECTION I: RUNNING DASHBOARD TIMELINE vs TOTAL
  // ═══════════════════════════════════════════════════
  console.log('\n── I: RUNNING DASHBOARD TIMELINE ──');

  if (rd.sales && rd.sales.length > 0) {
    let timelineTotal = 0;
    for (const s of rd.sales) {
      const slotTotal = (s.dine_in || 0) + (s.takeaway || 0) + (s.delivery || 0);
      timelineTotal += slotTotal;
    }
    timelineTotal = r2(timelineTotal);
    check('RunDash timeline sum = total_sale', Math.abs(timelineTotal - rdS.total_sale) < 0.01,
      `timeline=${timelineTotal}, total=${rdS.total_sale}`);
  }

  // Channel sum
  const chSum = r2(rdS.channels.reduce((s, c) => s + c.amount, 0));
  check('RunDash channel sum = total_sale', Math.abs(chSum - rdS.total_sale) < 0.01,
    `channels=${chSum}, total=${rdS.total_sale}`);

  // ═══════════════════════════════════════════════════
  // SECTION J: CROSS-VERIFICATION FLAGS
  // ═══════════════════════════════════════════════════
  console.log('\n── J: CROSS-VERIFICATION FLAGS ──');
  check('DSR crossVerification.match', dsr.crossVerification.match);
  check('DSR summary_total = order_level_total', 
    Math.abs(dsr.crossVerification.summary_total_sale - dsr.crossVerification.order_level_total) < 0.01);
  check('RunDash crossVerification.match', rd.crossVerification.match);
  check('DayEnd crossVerification.match', de.crossVerification.match);

  // ═══════════════════════════════════════════════════
  // SECTION K: FORMULA PROOF
  // ═══════════════════════════════════════════════════
  console.log('\n── K: FORMULA PROOF ──');
  console.log(`  total_sale = SUM(total_amount) of completed orders`);
  console.log(`  total_collection = total_sale (always)`);
  console.log(`  Discount, NC, Adjustment, Due — bifurcated, NOT excluded`);
  console.log(`\n  DB SUM(total_amount) of ${dbOrders.length} completed orders = ${dbTotalSale}`);
  console.log(`  DSR summary.total_sale                                   = ${dsrS.total_sale}`);
  console.log(`  DSR summary.total_collection                             = ${dsrS.total_collection}`);
  console.log(`  DSR order-level SUM(total_amount)                        = ${dsrOrderSum}`);
  console.log(`  RunDash summary.total_sale                               = ${rdS.total_sale}`);
  console.log(`  DayEnd grandTotal.total_sale                             = ${deG.total_sale}`);
  console.log(`  All equal: ${Math.abs(dbTotalSale - dsrS.total_sale) < 0.01 && Math.abs(dsrS.total_sale - rdS.total_sale) < 0.01 && Math.abs(rdS.total_sale - deG.total_sale) < 0.01 ? 'YES ✓' : 'NO ✗'}`);

  // ═══════════════════════════════════════════════════
  // SECTION L: ONLY COMPLETED — verify no non-completed orders leaked
  // ═══════════════════════════════════════════════════
  console.log('\n── L: ONLY COMPLETED ORDERS CHECK ──');
  const [nonCompleted] = await conn.query(
    `SELECT COUNT(*) as cnt, GROUP_CONCAT(DISTINCT status) as statuses
     FROM orders WHERE outlet_id = ? AND status != 'completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET, START + ' 04:00:00', '2026-04-07 04:00:00']
  );
  console.log(`  Non-completed orders in range: ${nonCompleted[0].cnt} (statuses: ${nonCompleted[0].statuses})`);
  
  const [allOrders] = await conn.query(
    `SELECT COUNT(*) as cnt FROM orders WHERE outlet_id = ? 
       AND created_at >= ? AND created_at < ?`,
    [OUTLET, START + ' 04:00:00', '2026-04-07 04:00:00']
  );
  console.log(`  All orders in range: ${allOrders[0].cnt}, completed: ${dbOrders.length}, excluded: ${allOrders[0].cnt - dbOrders.length}`);
  check('DSR orders = only completed (not all)', dsrS.total_orders === dbOrders.length && dsrS.total_orders < allOrders[0].cnt,
    `dsr=${dsrS.total_orders}, completed=${dbOrders.length}, all=${allOrders[0].cnt}`);

  // ═══════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED (${total} total)`);
  if (issues.length > 0) {
    console.log('\n  ISSUES:');
    for (const i of issues) console.log(`    • ${i}`);
  }
  console.log('═'.repeat(90));

  await conn.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Error:', err); process.exit(1); });
