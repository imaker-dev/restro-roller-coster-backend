/**
 * FORENSIC INVESTIGATION: Where is the ₹70,926 gap?
 * Restaurant claims ₹5,99,000 but DSR shows ₹5,28,074
 *
 * Run: node tests/investigate-gap.js
 */
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const OUTLET_ID = 46;
const BD_START = '2026-04-01 04:00:00';
const BD_END   = '2026-04-07 04:00:00';
const RESTAURANT_CLAIM = 599000;

function r2(n) { return parseFloat((parseFloat(n) || 0).toFixed(2)); }

async function run() {
  const c = await mysql.createConnection({
    host: dbCfg.host, port: dbCfg.port, user: dbCfg.user,
    password: dbCfg.password, database: dbCfg.database
  });

  console.log('='.repeat(80));
  console.log('  FORENSIC INVESTIGATION — Where is the missing amount?');
  console.log('  Restaurant claims: ' + RESTAURANT_CLAIM);
  console.log('  Window: ' + BD_START + ' → ' + BD_END + ' (4am-4am)');
  console.log('='.repeat(80));

  // ═══════════════════════════════════════════════════
  // 1. ALL ORDER STATUSES
  // ═══════════════════════════════════════════════════
  console.log('\n── 1. ALL ORDER STATUSES ──');
  const [byStatus] = await c.query(
    `SELECT status, COUNT(*) as cnt, 
            SUM(total_amount) as total_amt, 
            SUM(subtotal) as sub,
            SUM(tax_amount) as tax,
            SUM(discount_amount) as disc,
            SUM(COALESCE(nc_amount,0)) as nc
     FROM orders WHERE outlet_id=? 
       AND created_at >= ? AND created_at < ?
     GROUP BY status ORDER BY status`,
    [OUTLET_ID, BD_START, BD_END]
  );
  let allTotal = 0, allSub = 0, allTax = 0, allDisc = 0, allNC = 0, allCnt = 0;
  for (const r of byStatus) {
    const t = r2(r.total_amt); allTotal += t; allSub += r2(r.sub); allTax += r2(r.tax); allDisc += r2(r.disc); allNC += r2(r.nc); allCnt += r.cnt;
    console.log(`  ${r.status.padEnd(12)}: ${String(r.cnt).padStart(4)} orders | total=${String(r2(r.total_amt)).padStart(10)} | sub=${String(r2(r.sub)).padStart(10)} | tax=${String(r2(r.tax)).padStart(9)} | disc=${String(r2(r.disc)).padStart(10)} | nc=${r2(r.nc)}`);
  }
  console.log(`  ${'ALL'.padEnd(12)}: ${String(allCnt).padStart(4)} orders | total=${String(r2(allTotal)).padStart(10)} | sub=${String(r2(allSub)).padStart(10)} | tax=${String(r2(allTax)).padStart(9)} | disc=${String(r2(allDisc)).padStart(10)} | nc=${r2(allNC)}`);

  // ═══════════════════════════════════════════════════
  // 2. EVERY POSSIBLE CALCULATION
  // ═══════════════════════════════════════════════════
  console.log('\n── 2. EVERY POSSIBLE TOTAL CALCULATION ──');
  const completedTotal = r2(byStatus.find(r => r.status === 'completed')?.total_amt || 0);
  const completedSub = r2(byStatus.find(r => r.status === 'completed')?.sub || 0);
  const completedTax = r2(byStatus.find(r => r.status === 'completed')?.tax || 0);
  const completedDisc = r2(byStatus.find(r => r.status === 'completed')?.disc || 0);
  const completedNC = r2(byStatus.find(r => r.status === 'completed')?.nc || 0);
  const cancelledTotal = r2(byStatus.find(r => r.status === 'cancelled')?.total_amt || 0);
  const cancelledSub = r2(byStatus.find(r => r.status === 'cancelled')?.sub || 0);

  const calcs = [
    ['A. completed total_amount (our DSR)',              completedTotal],
    ['B. completed total + nc_amount',                   r2(completedTotal + completedNC)],
    ['C. completed total + discount + nc (gross)',       r2(completedTotal + completedDisc + completedNC)],
    ['D. completed total + discount (no nc)',            r2(completedTotal + completedDisc)],
    ['E. completed subtotal (food value pre-tax)',       completedSub],
    ['F. completed sub + tax (pre-discount)',            r2(completedSub + completedTax)],
    ['G. completed sub + tax + nc',                      r2(completedSub + completedTax + completedNC)],
    ['H. ALL statuses total_amount',                     r2(allTotal)],
    ['I. ALL statuses subtotal',                         r2(allSub)],
    ['J. ALL sub + tax',                                 r2(allSub + allTax)],
    ['K. ALL total + disc + nc',                         r2(allTotal + allDisc + allNC)],
    ['L. completed total + cancelled total',             r2(completedTotal + cancelledTotal)],
    ['M. completed sub + cancelled sub',                 r2(completedSub + cancelledSub)],
  ];

  for (const [label, val] of calcs) {
    const diff = r2(RESTAURANT_CLAIM - val);
    const marker = Math.abs(diff) < 1000 ? ' <<<< CLOSE!' : '';
    console.log(`  ${label.padEnd(50)} = ${String(val).padStart(10)}  (gap: ${String(diff).padStart(8)})${marker}`);
  }

  // ═══════════════════════════════════════════════════
  // 3. INVOICES (might include different amounts)
  // ═══════════════════════════════════════════════════
  console.log('\n── 3. INVOICES TABLE ──');
  const [invData] = await c.query(
    `SELECT COUNT(*) as cnt, 
            SUM(grand_total) as grand, 
            SUM(subtotal) as sub, 
            SUM(total_tax) as tax,
            SUM(COALESCE(discount_amount,0)) as disc,
            SUM(COALESCE(nc_amount,0)) as nc,
            SUM(COALESCE(nc_tax_amount,0)) as nc_tax,
            SUM(COALESCE(payable_amount,0)) as payable,
            SUM(paid_amount) as paid,
            SUM(due_amount) as due
     FROM invoices 
     WHERE outlet_id=? AND (is_cancelled IS NULL OR is_cancelled=0)
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  const inv = invData[0];
  console.log(`  Invoices: ${inv.cnt}`);
  console.log(`  grand_total     = ${r2(inv.grand)}`);
  console.log(`  subtotal        = ${r2(inv.sub)}`);
  console.log(`  total_tax       = ${r2(inv.tax)}`);
  console.log(`  discount        = ${r2(inv.disc)}`);
  console.log(`  nc_amount       = ${r2(inv.nc)}`);
  console.log(`  nc_tax_amount   = ${r2(inv.nc_tax)}`);
  console.log(`  payable_amount  = ${r2(inv.payable)}`);
  console.log(`  paid_amount     = ${r2(inv.paid)}`);
  console.log(`  due_amount      = ${r2(inv.due)}`);
  console.log(`  grand + nc      = ${r2(r2(inv.grand) + r2(inv.nc))}`);
  console.log(`  grand + nc + nc_tax = ${r2(r2(inv.grand) + r2(inv.nc) + r2(inv.nc_tax))}`);
  console.log(`  sub + tax + nc + nc_tax = ${r2(r2(inv.sub) + r2(inv.tax) + r2(inv.nc) + r2(inv.nc_tax))}`);

  const invCalcs = [
    ['inv grand_total',                    r2(inv.grand)],
    ['inv grand + nc + nc_tax',            r2(r2(inv.grand) + r2(inv.nc) + r2(inv.nc_tax))],
    ['inv sub + tax (pre-disc)',           r2(r2(inv.sub) + r2(inv.tax))],
    ['inv sub + tax + nc + nc_tax',        r2(r2(inv.sub) + r2(inv.tax) + r2(inv.nc) + r2(inv.nc_tax))],
    ['inv payable_amount',                 r2(inv.payable)],
  ];
  console.log('\n  Invoice-based calculations vs restaurant claim:');
  for (const [label, val] of invCalcs) {
    const diff = r2(RESTAURANT_CLAIM - val);
    const marker = Math.abs(diff) < 1000 ? ' <<<< CLOSE!' : '';
    console.log(`    ${label.padEnd(40)} = ${String(val).padStart(10)}  (gap: ${String(diff).padStart(8)})${marker}`);
  }

  // ═══════════════════════════════════════════════════
  // 4. PAYMENTS TABLE (actual money flow)
  // ═══════════════════════════════════════════════════
  console.log('\n── 4. PAYMENTS TABLE (actual money received) ──');
  const [payments] = await c.query(
    `SELECT SUM(amount) as total, COUNT(*) as cnt 
     FROM payments WHERE outlet_id=? AND status='completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  console.log(`  Total payments received: ${r2(payments[0].total)} (${payments[0].cnt} payments)`);

  const [payByMode] = await c.query(
    `SELECT payment_mode, SUM(amount) as total, COUNT(*) as cnt 
     FROM payments WHERE outlet_id=? AND status='completed'
       AND created_at >= ? AND created_at < ?
     GROUP BY payment_mode`,
    [OUTLET_ID, BD_START, BD_END]
  );
  for (const p of payByMode) {
    console.log(`    ${p.payment_mode.padEnd(10)}: ${r2(p.total)} (${p.cnt})`);
  }

  // ═══════════════════════════════════════════════════
  // 5. WIDER DATE RANGES (maybe restaurant counts differently)
  // ═══════════════════════════════════════════════════
  console.log('\n── 5. WIDER DATE RANGES ──');
  
  // Midnight-midnight range
  const [midnight] = await c.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as total 
     FROM orders WHERE outlet_id=? AND status='completed'
       AND created_at >= '2026-04-01 00:00:00' AND created_at <= '2026-04-06 23:59:59'`,
    [OUTLET_ID]
  );
  console.log(`  Midnight range (Apr 1 00:00 - Apr 6 23:59): ${midnight[0].cnt} orders, total=${r2(midnight[0].total)}`);

  // Extended range (Mar 31 to Apr 7)
  const [extended] = await c.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as total 
     FROM orders WHERE outlet_id=? AND status='completed'
       AND created_at >= '2026-03-31 00:00:00' AND created_at < '2026-04-08 00:00:00'`,
    [OUTLET_ID]
  );
  console.log(`  Extended (Mar 31 - Apr 7 full):             ${extended[0].cnt} orders, total=${r2(extended[0].total)}`);

  // Apr 1 to Apr 7 (maybe they count 7 days not 6?)
  const [sevenDays] = await c.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as total 
     FROM orders WHERE outlet_id=? AND status='completed'
       AND created_at >= '2026-04-01 04:00:00' AND created_at < '2026-04-08 04:00:00'`,
    [OUTLET_ID]
  );
  console.log(`  7 days 4am-4am (Apr 1 - Apr 7):             ${sevenDays[0].cnt} orders, total=${r2(sevenDays[0].total)}`);

  // Apr 1 to Apr 7 including cancelled + nc
  const [sevenAll] = await c.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as total, SUM(COALESCE(nc_amount,0)) as nc
     FROM orders WHERE outlet_id=? AND status != 'cancelled'
       AND created_at >= '2026-04-01 04:00:00' AND created_at < '2026-04-08 04:00:00'`,
    [OUTLET_ID]
  );
  console.log(`  7 days non-cancelled:                        ${sevenAll[0].cnt} orders, total=${r2(sevenAll[0].total)}, total+nc=${r2(r2(sevenAll[0].total) + r2(sevenAll[0].nc))}`);

  // ═══════════════════════════════════════════════════
  // 6. ORDER ITEM LEVEL (actual food sold)
  // ═══════════════════════════════════════════════════
  console.log('\n── 6. ORDER ITEMS (actual food value) ──');
  const [items] = await c.query(
    `SELECT SUM(oi.quantity * oi.unit_price) as gross_item_value,
            SUM(oi.total_price) as total_item_price,
            SUM(oi.quantity) as total_qty,
            COUNT(*) as item_count
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     WHERE o.outlet_id=? AND o.status='completed'
       AND o.created_at >= ? AND o.created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  console.log(`  Gross item value (qty * unit_price): ${r2(items[0].gross_item_value)}`);
  console.log(`  Total item price (after item disc) : ${r2(items[0].total_item_price)}`);
  console.log(`  Items: ${items[0].item_count}, qty: ${items[0].total_qty}`);

  // Including cancelled
  const [itemsAll] = await c.query(
    `SELECT SUM(oi.quantity * oi.unit_price) as gross_item_value,
            SUM(oi.total_price) as total_item_price
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     WHERE o.outlet_id=? AND o.status != 'cancelled'
       AND o.created_at >= ? AND o.created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  console.log(`  All non-cancelled item gross value : ${r2(itemsAll[0].gross_item_value)}`);
  console.log(`  All non-cancelled item total_price : ${r2(itemsAll[0].total_item_price)}`);

  // NC order items
  const [ncItems] = await c.query(
    `SELECT SUM(oi.quantity * oi.unit_price) as gross_item_value,
            SUM(oi.total_price) as total_item_price
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     WHERE o.outlet_id=? AND o.status='completed' AND o.is_nc=1
       AND o.created_at >= ? AND o.created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  console.log(`  NC order items gross value         : ${r2(ncItems[0]?.gross_item_value)}`);

  // ═══════════════════════════════════════════════════
  // 7. CANCELLED ORDER DETAILS
  // ═══════════════════════════════════════════════════
  console.log('\n── 7. CANCELLED ORDERS DETAIL ──');
  const [cancelled] = await c.query(
    `SELECT id, order_number, total_amount, subtotal, paid_amount, cancel_reason, created_at
     FROM orders WHERE outlet_id=? AND status='cancelled'
       AND created_at >= ? AND created_at < ?
     ORDER BY created_at`,
    [OUTLET_ID, BD_START, BD_END]
  );
  let cancelTotal = 0;
  for (const o of cancelled) {
    cancelTotal += r2(o.total_amount);
    console.log(`  ${o.order_number}: total=${r2(o.total_amount)}, sub=${r2(o.subtotal)}, paid=${r2(o.paid_amount)}, reason=${o.cancel_reason || 'none'}`);
  }
  console.log(`  TOTAL CANCELLED: ${r2(cancelTotal)} (${cancelled.length} orders)`);

  // ═══════════════════════════════════════════════════
  // 8. KOT ITEMS (were items prepared but order cancelled?)
  // ═══════════════════════════════════════════════════
  console.log('\n── 8. DAILY_SALES TABLE (if aggregated) ──');
  try {
    const [ds] = await c.query(
      `SELECT * FROM daily_sales WHERE outlet_id=? AND report_date >= '2026-04-01' AND report_date <= '2026-04-06'`,
      [OUTLET_ID]
    );
    if (ds.length > 0) {
      let dsTotal = 0;
      for (const d of ds) {
        console.log(`  ${d.report_date}: total_sales=${r2(d.total_sales)}, orders=${d.total_orders}`);
        dsTotal += r2(d.total_sales);
      }
      console.log(`  TOTAL from daily_sales: ${r2(dsTotal)}`);
    } else {
      console.log('  No records in daily_sales table for this range.');
    }
  } catch(e) {
    console.log('  daily_sales table not found or error: ' + e.message);
  }

  // ═══════════════════════════════════════════════════
  // 9. SUMMARY
  // ═══════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('  SUMMARY — Possible explanations for gap');
  console.log('='.repeat(80));
  console.log(`  Restaurant claims         : ${RESTAURANT_CLAIM}`);
  console.log(`  Our completed total_amount: ${completedTotal}`);
  console.log(`  Gap                       : ${r2(RESTAURANT_CLAIM - completedTotal)}`);
  console.log();
  console.log('  Possible additions to bridge the gap:');
  console.log(`    + NC amount (food given free)  : ${completedNC}  → running total: ${r2(completedTotal + completedNC)}`);
  console.log(`    + Discount (given back)        : ${completedDisc} → running total: ${r2(completedTotal + completedNC + completedDisc)}`);
  console.log(`    + Cancelled order value        : ${cancelledTotal} → running total: ${r2(completedTotal + completedNC + completedDisc + cancelledTotal)}`);
  const everything = r2(completedTotal + completedNC + completedDisc + cancelledTotal);
  console.log(`    EVERYTHING combined            : ${everything}  (gap from claim: ${r2(RESTAURANT_CLAIM - everything)})`);

  // Check if 7 days matches
  console.log(`\n  If restaurant counts 7 days (Apr 1-7):`);
  console.log(`    completed total_amount: ${r2(sevenDays[0].total)} (gap: ${r2(RESTAURANT_CLAIM - r2(sevenDays[0].total))})`);
  const sAll = r2(sevenDays[0].total);
  const [sevenDisc] = await c.query(
    `SELECT SUM(discount_amount) as d, SUM(COALESCE(nc_amount,0)) as n FROM orders WHERE outlet_id=? AND status='completed' AND created_at >= '2026-04-01 04:00:00' AND created_at < '2026-04-08 04:00:00'`,
    [OUTLET_ID]
  );
  const s7disc = r2(sevenDisc[0].d);
  const s7nc = r2(sevenDisc[0].n);
  console.log(`    + disc(${s7disc}) + nc(${s7nc}): ${r2(sAll + s7disc + s7nc)} (gap: ${r2(RESTAURANT_CLAIM - r2(sAll + s7disc + s7nc))})`);

  console.log();
  await c.end();
}

run().catch(err => { console.error('Error:', err); process.exit(1); });
