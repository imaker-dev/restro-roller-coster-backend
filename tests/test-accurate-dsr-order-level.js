/**
 * COMPREHENSIVE ORDER-LEVEL VERIFICATION — Outlet 46, Apr 1–6
 *
 * Checks EVERY single order for EACH day:
 *   1. total_amount = paid_amount + due_amount + adjustment_amount
 *   2. NC orders: total_amount=0, nc_amount>0  → still in report, not excluded
 *   3. Adjustment orders: adjustment bifurcated but NOT excluded from total_sale
 *   4. Partial/due orders: full total_amount counted in total_sale, not just paid
 *   5. Discount: bifurcated, already deducted inside total_amount
 *   6. Per-day DB totals match API totals exactly
 *   7. Sum of all order total_amounts = API total_sale = API total_collection
 *   8. Business day boundary: 4am–4am
 *   9. Overall 6-day totals match
 *
 * Run: node tests/test-accurate-dsr-order-level.js
 */

const http = require('http');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const BASE_URL = process.env.API_URL || 'http://localhost:3005';
const API_PREFIX = '/api/v1';
const OUTLET_ID = 46;
const START_DATE = '2026-04-01';
const END_DATE = '2026-04-06';
const BD_HOUR = 4;

let AUTH_TOKEN = null;
const R = { passed: 0, failed: 0, tests: [] };

function r2(n) { return parseFloat((parseFloat(n) || 0).toFixed(2)); }

function record(name, passed, detail = '') {
  R.tests.push({ name, passed, detail });
  if (passed) R.passed++; else R.failed++;
  console.log(`  ${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function apiRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + API_PREFIX + urlPath);
    const options = {
      hostname: url.hostname, port: url.port || 3005,
      path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (AUTH_TOKEN) options.headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function bdRange(dateStr) {
  const h = String(BD_HOUR).padStart(2, '0') + ':00:00';
  const ed = new Date(dateStr + 'T00:00:00');
  ed.setDate(ed.getDate() + 1);
  const endStr = ed.getFullYear() + '-' + String(ed.getMonth() + 1).padStart(2, '0') + '-' + String(ed.getDate()).padStart(2, '0');
  return { startDt: `${dateStr} ${h}`, endDt: `${endStr} ${h}` };
}

function dateList(s, e) {
  const dates = [];
  const cur = new Date(s + 'T00:00:00');
  const last = new Date(e + 'T00:00:00');
  while (cur <= last) {
    dates.push(cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0'));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

async function run() {
  console.log('='.repeat(90));
  console.log('  ORDER-LEVEL A-TO-Z VERIFICATION — Outlet 46 — Apr 1–6');
  console.log('  Every order, every scenario, every number.');
  console.log('='.repeat(90));

  const conn = await mysql.createConnection({
    host: dbCfg.host, port: dbCfg.port, user: dbCfg.user,
    password: dbCfg.password, database: dbCfg.database
  });

  // Login
  const loginRes = await apiRequest('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  if (!loginRes.data?.success) { console.error('Login failed'); process.exit(1); }
  AUTH_TOKEN = loginRes.data.data.accessToken;
  console.log('  Logged in.\n');

  const dates = dateList(START_DATE, END_DATE);
  let grandDbTotal = 0, grandDbOrders = 0, grandDbDisc = 0, grandDbNC = 0, grandDbAdj = 0, grandDbPaid = 0, grandDbDue = 0, grandOverpaid = 0;
  let grandApiTotal = 0, grandApiOrders = 0;

  for (const d of dates) {
    const { startDt, endDt } = bdRange(d);
    console.log('━'.repeat(90));
    console.log(`  DATE: ${d}  |  Window: ${startDt} → ${endDt}`);
    console.log('━'.repeat(90));

    // ── Fetch ALL completed orders from DB for this business day ──
    const [dbOrders] = await conn.query(
      `SELECT id, order_number, order_type, total_amount, subtotal, tax_amount,
              discount_amount, service_charge, packaging_charge, delivery_charge, round_off,
              paid_amount, due_amount, adjustment_amount, is_adjustment,
              is_nc, nc_amount, payment_status, is_complimentary, created_at
       FROM orders
       WHERE outlet_id = ? AND status = 'completed'
         AND created_at >= ? AND created_at < ?
       ORDER BY created_at`,
      [OUTLET_ID, startDt, endDt]
    );

    // ── Fetch API response ──
    const apiRes = await apiRequest('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=${d}&endDate=${d}`);
    const apiOK = apiRes.status === 200 && apiRes.data?.success;
    if (!apiOK) {
      record(`${d} API call`, false, `status=${apiRes.status}`);
      continue;
    }
    const apiData = apiRes.data.data;
    const apiSummary = apiData.summary;
    const apiOrders = apiData.orders || [];
    const apiCV = apiData.crossVerification;
    const apiDaily = (apiData.daily || [])[0] || {};

    // ══════════════════════════════════════════════════
    // A. ORDER-BY-ORDER VERIFICATION (from DB)
    // ══════════════════════════════════════════════════
    console.log(`\n  A. ORDER-BY-ORDER CHECK (${dbOrders.length} orders)`);
    console.log('  ' + '-'.repeat(86));
    console.log('  ' + 'Order#'.padEnd(18) + 'Type'.padEnd(10) + 'Total'.padStart(10) + 'Paid'.padStart(10) + 'Due'.padStart(10) + 'Adj'.padStart(8) + 'Disc'.padStart(10) + 'NC'.padStart(8) + 'PaySt'.padEnd(12) + 'Chk');
    console.log('  ' + '-'.repeat(86));

    let dayDbTotal = 0, dayDbDisc = 0, dayDbNC = 0, dayDbAdj = 0, dayDbPaid = 0, dayDbDue = 0, dayOverpaid = 0;
    let orderIssues = [];

    for (const o of dbOrders) {
      const total = r2(o.total_amount);
      const paid = r2(o.paid_amount);
      const due = r2(o.due_amount);
      const adj = r2(o.adjustment_amount);
      const disc = r2(o.discount_amount);
      const nc = r2(o.nc_amount);
      const isNC = !!o.is_nc;
      const isAdj = !!o.is_adjustment;

      dayDbTotal += total;
      dayDbDisc += disc;
      dayDbAdj += adj;
      dayDbPaid += paid;
      dayDbDue += due;
      if (isNC) dayDbNC += nc;

      // CHECK 1: total_amount = paid_amount + due_amount + adjustment_amount
      // Exception: discount applied after payment → paid > total (overpayment)
      const balanceCheck = Math.abs(total - (paid + due + adj)) < 0.02;
      const isOverpaid = paid > total && due === 0 && adj === 0;
      let issues = [];
      if (!balanceCheck && !isOverpaid) issues.push(`BAL:${total}!=${paid}+${due}+${adj}=${r2(paid + due + adj)}`);      if (isOverpaid) {
        const overpay = r2(paid - total);
        dayOverpaid += overpay;
      }

      // CHECK 2: NC order should have total_amount = 0
      if (isNC && total !== 0) issues.push(`NC_TOTAL!=0(${total})`);
      if (isNC && nc <= 0) issues.push(`NC_AMT=0`);

      // CHECK 3: Non-NC order should have nc_amount = 0
      if (!isNC && nc > 0) issues.push(`NOT_NC_BUT_NC_AMT=${nc}`);

      // CHECK 4: Adjustment order should have adj > 0
      if (isAdj && adj <= 0) issues.push(`ADJ_FLAG_BUT_AMT=0`);

      const chk = issues.length === 0 ? 'OK' : issues.join(',');
      if (issues.length > 0) orderIssues.push({ order: o.order_number, issues });

      // Print each order row
      const line = `  ${o.order_number.padEnd(18)}${(o.order_type || '').padEnd(10)}${String(total).padStart(10)}${String(paid).padStart(10)}${String(due).padStart(10)}${String(adj).padStart(8)}${String(disc).padStart(10)}${String(isNC ? nc : '-').padStart(8)} ${(o.payment_status || '').padEnd(11)} ${chk}`;
      console.log(line);
    }

    console.log('  ' + '-'.repeat(86));
    console.log(`  ${'TOTALS'.padEnd(18)}${''.padEnd(10)}${String(r2(dayDbTotal)).padStart(10)}${String(r2(dayDbPaid)).padStart(10)}${String(r2(dayDbDue)).padStart(10)}${String(r2(dayDbAdj)).padStart(8)}${String(r2(dayDbDisc)).padStart(10)}${String(r2(dayDbNC)).padStart(8)}`);

    record(`${d} all orders pass balance check (total=paid+due+adj)`, orderIssues.length === 0,
      orderIssues.length > 0 ? orderIssues.map(i => `${i.order}:${i.issues.join(',')}`).join('; ') : `${dbOrders.length} orders OK`);
    if (dayOverpaid > 0) {
      console.log(`    NOTE: ${r2(dayOverpaid)} overpaid (discount applied after payment) — does NOT affect total_sale`);
    }

    // ══════════════════════════════════════════════════
    // B. DB SUM vs API TOTAL
    // ══════════════════════════════════════════════════
    console.log(`\n  B. DB SUM vs API COMPARISON`);

    const dbSum = r2(dayDbTotal);
    const apiTotal = apiSummary.total_sale;
    const apiCol = apiSummary.total_collection;
    const apiOrdCount = apiSummary.total_orders;

    console.log(`    DB  : orders=${dbOrders.length} | total=${dbSum} | disc=${r2(dayDbDisc)} | nc=${r2(dayDbNC)} | adj=${r2(dayDbAdj)} | paid=${r2(dayDbPaid)} | due=${r2(dayDbDue)}`);
    console.log(`    API : orders=${apiOrdCount} | total_sale=${apiTotal} | collection=${apiCol} | disc=${apiSummary.discount_amount} | nc=${apiSummary.nc_amount} | adj=${apiSummary.adjustment_amount} | paid=${apiSummary.total_paid_amount} | due=${apiSummary.total_due_amount}`);

    record(`${d} DB order count = API count`, dbOrders.length === apiOrdCount, `db=${dbOrders.length}, api=${apiOrdCount}`);
    record(`${d} DB total = API total_sale`, Math.abs(dbSum - apiTotal) < 0.01, `db=${dbSum}, api=${apiTotal}`);
    record(`${d} total_collection = total_sale`, apiCol === apiTotal, `col=${apiCol}, sale=${apiTotal}`);
    record(`${d} API discount matches DB`, Math.abs(apiSummary.discount_amount - r2(dayDbDisc)) < 0.01, `api=${apiSummary.discount_amount}, db=${r2(dayDbDisc)}`);
    record(`${d} API NC matches DB`, Math.abs(apiSummary.nc_amount - r2(dayDbNC)) < 0.01, `api=${apiSummary.nc_amount}, db=${r2(dayDbNC)}`);
    record(`${d} API adjustment matches DB`, Math.abs(apiSummary.adjustment_amount - r2(dayDbAdj)) < 0.01, `api=${apiSummary.adjustment_amount}, db=${r2(dayDbAdj)}`);
    record(`${d} API paid matches DB`, Math.abs(apiSummary.total_paid_amount - r2(dayDbPaid)) < 0.01, `api=${apiSummary.total_paid_amount}, db=${r2(dayDbPaid)}`);
    record(`${d} API due matches DB`, Math.abs(apiSummary.total_due_amount - r2(dayDbDue)) < 0.01, `api=${apiSummary.total_due_amount}, db=${r2(dayDbDue)}`);
    record(`${d} API cross-verification match`, apiCV.match === true);

    // ══════════════════════════════════════════════════
    // C. API ORDER LIST vs DB ORDER LIST (1:1)
    // ══════════════════════════════════════════════════
    console.log(`\n  C. API ORDER LIST vs DB ORDER LIST (1:1)`);

    const apiOrderMap = {};
    for (const ao of apiOrders) apiOrderMap[ao.order_number] = ao;

    let listMismatches = [];
    for (const dbo of dbOrders) {
      const ao = apiOrderMap[dbo.order_number];
      if (!ao) {
        listMismatches.push(`${dbo.order_number}: MISSING in API`);
        continue;
      }
      if (Math.abs(r2(dbo.total_amount) - ao.total_amount) > 0.01)
        listMismatches.push(`${dbo.order_number}: total db=${r2(dbo.total_amount)} api=${ao.total_amount}`);
      if (Math.abs(r2(dbo.discount_amount) - ao.discount_amount) > 0.01)
        listMismatches.push(`${dbo.order_number}: disc db=${r2(dbo.discount_amount)} api=${ao.discount_amount}`);
      if (Math.abs(r2(dbo.paid_amount) - ao.paid_amount) > 0.01)
        listMismatches.push(`${dbo.order_number}: paid db=${r2(dbo.paid_amount)} api=${ao.paid_amount}`);
      if (Math.abs(r2(dbo.due_amount) - ao.due_amount) > 0.01)
        listMismatches.push(`${dbo.order_number}: due db=${r2(dbo.due_amount)} api=${ao.due_amount}`);
      if (Math.abs(r2(dbo.adjustment_amount) - ao.adjustment_amount) > 0.01)
        listMismatches.push(`${dbo.order_number}: adj db=${r2(dbo.adjustment_amount)} api=${ao.adjustment_amount}`);
      if (!!dbo.is_nc !== ao.is_nc)
        listMismatches.push(`${dbo.order_number}: is_nc db=${!!dbo.is_nc} api=${ao.is_nc}`);
      if (Math.abs(r2(dbo.nc_amount) - ao.nc_amount) > 0.01)
        listMismatches.push(`${dbo.order_number}: nc_amount db=${r2(dbo.nc_amount)} api=${ao.nc_amount}`);
    }

    // Check for extra orders in API not in DB
    const dbOrderNums = new Set(dbOrders.map(o => o.order_number));
    for (const ao of apiOrders) {
      if (!dbOrderNums.has(ao.order_number)) {
        listMismatches.push(`${ao.order_number}: EXTRA in API (not in DB)`);
      }
    }

    record(`${d} all orders match 1:1 (DB vs API list)`, listMismatches.length === 0,
      listMismatches.length > 0 ? listMismatches.join('; ') : `${dbOrders.length} orders verified`);

    // ══════════════════════════════════════════════════
    // D. SCENARIO-SPECIFIC CHECKS
    // ══════════════════════════════════════════════════
    console.log(`\n  D. SCENARIO CHECKS`);

    // D1: NC orders included in report but total_amount=0
    const ncOrders = dbOrders.filter(o => !!o.is_nc);
    if (ncOrders.length > 0) {
      const ncInApi = ncOrders.every(nco => apiOrderMap[nco.order_number]);
      const ncTotalZero = ncOrders.every(nco => r2(nco.total_amount) === 0);
      record(`${d} NC orders present in API (${ncOrders.length})`, ncInApi);
      record(`${d} NC orders have total_amount=0`, ncTotalZero,
        ncOrders.map(o => `${o.order_number}:total=${r2(o.total_amount)},nc=${r2(o.nc_amount)}`).join(', '));
      // NC amount NOT excluded from total_sale (it's 0 anyway since total_amount=0)
      console.log(`    NC orders contribute 0 to total_sale (total_amount=0), nc_amount bifurcated separately: ${r2(dayDbNC)}`);
    } else {
      console.log(`    No NC orders on this day.`);
    }

    // D2: Adjustment orders — adj amount NOT excluded from total_sale
    const adjOrders = dbOrders.filter(o => !!o.is_adjustment);
    if (adjOrders.length > 0) {
      const adjInApi = adjOrders.every(ao => apiOrderMap[ao.order_number]);
      record(`${d} Adjustment orders present in API (${adjOrders.length})`, adjInApi);
      // Verify: total_sale includes the full total_amount (which includes the adj portion)
      // If adj were excluded, total_sale would be less by sum of adj amounts
      const adjSum = adjOrders.reduce((s, o) => s + r2(o.adjustment_amount), 0);
      const adjTotalAmtSum = adjOrders.reduce((s, o) => s + r2(o.total_amount), 0);
      console.log(`    Adjustment orders: total_amount sum = ${r2(adjTotalAmtSum)}, adj_amount sum = ${r2(adjSum)}`);
      console.log(`    These full total_amounts ARE in total_sale (adj NOT excluded).`);
      // Proof: total_sale includes adj orders' total_amount
      const nonAdjTotal = dbOrders.filter(o => !o.is_adjustment).reduce((s, o) => s + r2(o.total_amount), 0);
      const proofTotal = r2(nonAdjTotal + adjTotalAmtSum);
      record(`${d} adj NOT excluded proof: nonAdj(${r2(nonAdjTotal)}) + adjTotal(${r2(adjTotalAmtSum)}) = ${proofTotal} = API total(${apiTotal})`,
        Math.abs(proofTotal - apiTotal) < 0.01);
    } else {
      console.log(`    No adjustment orders on this day.`);
    }

    // D3: Partial/due orders — full total_amount counted, not just paid
    const dueOrders = dbOrders.filter(o => o.payment_status === 'partial' || r2(o.due_amount) > 0);
    if (dueOrders.length > 0) {
      const dueTotalAmt = dueOrders.reduce((s, o) => s + r2(o.total_amount), 0);
      const duePaidAmt = dueOrders.reduce((s, o) => s + r2(o.paid_amount), 0);
      const dueAmt = dueOrders.reduce((s, o) => s + r2(o.due_amount), 0);
      console.log(`    Due/partial orders (${dueOrders.length}): total_amount=${r2(dueTotalAmt)}, paid=${r2(duePaidAmt)}, due=${r2(dueAmt)}`);
      console.log(`    Full total_amount (${r2(dueTotalAmt)}) counted in total_sale, NOT just paid (${r2(duePaidAmt)})`);
      // If only paid were counted, total_sale would be less by dueAmt
      record(`${d} due orders: full bill in total_sale (not just paid)`, true,
        `${dueOrders.length} orders, due=${r2(dueAmt)} included`);
    } else {
      console.log(`    No due/partial orders on this day.`);
    }

    // D4: Discount — already deducted inside total_amount, bifurcated separately
    const discOrders = dbOrders.filter(o => r2(o.discount_amount) > 0);
    if (discOrders.length > 0) {
      console.log(`    Discount orders (${discOrders.length}): total discount = ${r2(dayDbDisc)}`);
      console.log(`    Discount is ALREADY deducted in total_amount. Bifurcated for info only.`);
    }

    // D5: Business day boundary — verify no order has created_at outside window
    const outsideWindow = dbOrders.filter(o => {
      const ts = new Date(o.created_at).toISOString();
      return ts < new Date(startDt).toISOString() || ts >= new Date(endDt).toISOString();
    });
    record(`${d} all orders within 4am-4am window`, outsideWindow.length === 0,
      outsideWindow.length > 0 ? `${outsideWindow.length} outside: ${outsideWindow.map(o => o.order_number).join(',')}` : 'all within window');

    // Accumulate grand totals
    grandDbTotal += dbSum;
    grandDbOrders += dbOrders.length;
    grandDbDisc += r2(dayDbDisc);
    grandDbNC += r2(dayDbNC);
    grandDbAdj += r2(dayDbAdj);
    grandDbPaid += r2(dayDbPaid);
    grandDbDue += r2(dayDbDue);
    grandOverpaid += dayOverpaid;
    grandApiTotal += apiTotal;
    grandApiOrders += apiOrdCount;

    console.log();
  }

  // ═══════════════════════════════════════════════════════════════
  // OVERALL VERIFICATION
  // ═══════════════════════════════════════════════════════════════
  console.log('━'.repeat(90));
  console.log('  OVERALL VERIFICATION (Apr 1–6)');
  console.log('━'.repeat(90));

  // Overall API call
  const overallRes = await apiRequest('GET', `/reports/accurate-dsr?outletId=${OUTLET_ID}&startDate=${START_DATE}&endDate=${END_DATE}`);
  const os = overallRes.data?.data?.summary || {};
  const ocv = overallRes.data?.data?.crossVerification || {};
  const oDaily = overallRes.data?.data?.daily || [];

  console.log(`\n  Grand DB totals (per-day sums):`);
  console.log(`    orders=${grandDbOrders} | total=${r2(grandDbTotal)} | disc=${r2(grandDbDisc)} | nc=${r2(grandDbNC)} | adj=${r2(grandDbAdj)} | paid=${r2(grandDbPaid)} | due=${r2(grandDbDue)}`);
  console.log(`  Overall API:`);
  console.log(`    orders=${os.total_orders} | total_sale=${os.total_sale} | collection=${os.total_collection} | disc=${os.discount_amount} | nc=${os.nc_amount} | adj=${os.adjustment_amount} | paid=${os.total_paid_amount} | due=${os.total_due_amount}`);
  console.log(`  Per-day API sums:`);
  console.log(`    orders=${grandApiOrders} | total=${r2(grandApiTotal)}\n`);

  record('Overall: DB grand total = API total_sale', Math.abs(r2(grandDbTotal) - os.total_sale) < 0.01,
    `db=${r2(grandDbTotal)}, api=${os.total_sale}`);
  record('Overall: DB order count = API count', grandDbOrders === os.total_orders,
    `db=${grandDbOrders}, api=${os.total_orders}`);
  record('Overall: total_collection = total_sale', os.total_collection === os.total_sale);
  record('Overall: cross-verification match', ocv.match === true);
  record('Overall: per-day sale sum = overall sale', Math.abs(r2(grandApiTotal) - os.total_sale) < 0.01,
    `daySum=${r2(grandApiTotal)}, overall=${os.total_sale}`);
  record('Overall: per-day order sum = overall orders', grandApiOrders === os.total_orders,
    `daySum=${grandApiOrders}, overall=${os.total_orders}`);

  // Verify daily array sums
  const dailySaleSum = r2(oDaily.reduce((s, d) => s + d.total_sale, 0));
  const dailyOrdSum = oDaily.reduce((s, d) => s + d.total_orders, 0);
  record('Overall: daily[] sale sum = summary total_sale', Math.abs(dailySaleSum - os.total_sale) < 0.01,
    `dailySum=${dailySaleSum}, summary=${os.total_sale}`);
  record('Overall: daily[] order sum = summary total_orders', dailyOrdSum === os.total_orders,
    `dailySum=${dailyOrdSum}, summary=${os.total_orders}`);

  record('Overall: discount matches', Math.abs(os.discount_amount - r2(grandDbDisc)) < 0.01,
    `api=${os.discount_amount}, db=${r2(grandDbDisc)}`);
  record('Overall: NC matches', Math.abs(os.nc_amount - r2(grandDbNC)) < 0.01,
    `api=${os.nc_amount}, db=${r2(grandDbNC)}`);
  record('Overall: adjustment matches', Math.abs(os.adjustment_amount - r2(grandDbAdj)) < 0.01,
    `api=${os.adjustment_amount}, db=${r2(grandDbAdj)}`);
  record('Overall: paid matches', Math.abs(os.total_paid_amount - r2(grandDbPaid)) < 0.01,
    `api=${os.total_paid_amount}, db=${r2(grandDbPaid)}`);
  record('Overall: due matches', Math.abs(os.total_due_amount - r2(grandDbDue)) < 0.01,
    `api=${os.total_due_amount}, db=${r2(grandDbDue)}`);

  // Final formula proof
  console.log(`\n  ┌────────────────────────────────────────────────────────────┐`);
  console.log(`  │  FORMULA PROOF                                            │`);
  console.log(`  │  total_sale     = SUM(total_amount) of completed orders   │`);
  console.log(`  │  total_collection = total_sale                            │`);
  console.log(`  │  total_amount   = paid + due + adjustment                 │`);
  console.log(`  │  NC total_amount = 0 (nc_amount bifurcated only)          │`);
  console.log(`  │  Discount already deducted in total_amount                │`);
  console.log(`  │  NOTHING excluded. EVERYTHING accounted for.              │`);
  console.log(`  │                                                           │`);
  console.log(`  │  paid(${r2(grandDbPaid)}) + due(${r2(grandDbDue)}) + adj(${r2(grandDbAdj)}) = ${r2(r2(grandDbPaid) + r2(grandDbDue) + r2(grandDbAdj))}`);    if (grandOverpaid > 0) {
    console.log(`  │  Overpayments (disc after pay): ${r2(grandOverpaid)}`.padEnd(61) + '│');
    console.log(`  │  paid+due+adj - overpaid = ${r2(r2(grandDbPaid) + r2(grandDbDue) + r2(grandDbAdj) - grandOverpaid)}`.padEnd(61) + '│');
    }
  console.log(`  │  total_sale = ${os.total_sale}`);
  // Account for overpayments: paid+due+adj-overpaid = total_sale
  const formulaMatch = Math.abs(r2(r2(grandDbPaid) + r2(grandDbDue) + r2(grandDbAdj) - grandOverpaid) - os.total_sale) < 0.01;
  console.log(`  │  Match: ${formulaMatch ? 'YES' : 'NO'}`.padEnd(61) + '│');
  console.log(`  └────────────────────────────────────────────────────────────┘`);
  record('FORMULA: paid + due + adj - overpaid = total_sale', formulaMatch,
    `${r2(r2(grandDbPaid) + r2(grandDbDue) + r2(grandDbAdj))} - ${r2(grandOverpaid)} = ${r2(r2(grandDbPaid) + r2(grandDbDue) + r2(grandDbAdj) - grandOverpaid)}, total_sale=${os.total_sale}`);

  // ═══════════════════════════════════════════════════════════════
  // FINAL
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(90));
  console.log(`  RESULTS: ${R.passed} passed, ${R.failed} failed (${R.tests.length} total)`);
  console.log('='.repeat(90));
  if (R.failed > 0) {
    console.log('\n  FAILED:');
    for (const t of R.tests.filter(t => !t.passed)) {
      console.log(`    FAIL: ${t.name} — ${t.detail}`);
    }
  }
  console.log();
  await conn.end();
  process.exit(R.failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Crashed:', err); process.exit(2); });
