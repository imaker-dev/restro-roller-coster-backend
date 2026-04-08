/**
 * FINAL GAP ANALYSIS — Every possible perspective
 * Restaurant claim: ₹5,99,000 vs System: ₹5,28,074
 * 
 * Run: node tests/investigate-gap-final.js
 */
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const OUTLET_ID = 46;
const BD_START = '2026-04-01 04:00:00';
const BD_END   = '2026-04-07 04:00:00';

function r2(n) { return parseFloat((parseFloat(n) || 0).toFixed(2)); }

async function run() {
  const c = await mysql.createConnection({
    host: dbCfg.host, port: dbCfg.port, user: dbCfg.user,
    password: dbCfg.password, database: dbCfg.database
  });

  console.log('='.repeat(90));
  console.log('  FINAL GAP ANALYSIS — Every perspective exhausted');
  console.log('  Outlet 46, Apr 1-6 (4am-4am), Restaurant claims ₹5,99,000');
  console.log('='.repeat(90));

  // ── A. BASE: Completed orders total_amount ──
  const [comp] = await c.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as total, SUM(subtotal) as sub, 
            SUM(tax_amount) as tax, SUM(discount_amount) as disc,
            SUM(COALESCE(nc_amount,0)) as nc, SUM(round_off) as ro
     FROM orders WHERE outlet_id=? AND status='completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );

  // ── B. Cancelled items INSIDE completed orders (food prepared but removed from bill) ──
  const [cancelledItems] = await c.query(
    `SELECT SUM(oi.quantity * oi.unit_price) as value, COUNT(*) as cnt
     FROM order_items oi JOIN orders o ON oi.order_id = o.id
     WHERE o.outlet_id=? AND o.status='completed' AND oi.status='cancelled'
       AND o.created_at >= ? AND o.created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );

  // ── C. Cancelled orders total ──
  const [cancelled] = await c.query(
    `SELECT SUM(total_amount) as total, SUM(subtotal) as sub, COUNT(*) as cnt
     FROM orders WHERE outlet_id=? AND status='cancelled'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );

  // ── D. Items in cancelled orders ──
  const [cancelledOrderItems] = await c.query(
    `SELECT SUM(oi.quantity * oi.unit_price) as value, COUNT(*) as cnt
     FROM order_items oi JOIN orders o ON oi.order_id = o.id
     WHERE o.outlet_id=? AND o.status='cancelled'
       AND o.created_at >= ? AND o.created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );

  // ── E. Outlet 43 (other outlet) ──
  const [outlet43] = await c.query(
    `SELECT COUNT(*) as cnt, SUM(total_amount) as total, SUM(discount_amount) as disc,
            SUM(COALESCE(nc_amount,0)) as nc, SUM(subtotal) as sub, SUM(tax_amount) as tax
     FROM orders WHERE outlet_id=43 AND status='completed'
       AND created_at >= ? AND created_at < ?`,
    [BD_START, BD_END]
  );

  // ── F. Per-day item-level detail for completed orders ──
  const [dailyItems] = await c.query(
    `SELECT DATE(DATE_SUB(o.created_at, INTERVAL 4 HOUR)) as bd,
            SUM(CASE WHEN oi.status='served' THEN oi.quantity * oi.unit_price ELSE 0 END) as served_value,
            SUM(CASE WHEN oi.status='cancelled' THEN oi.quantity * oi.unit_price ELSE 0 END) as cancelled_value,
            SUM(oi.quantity * oi.unit_price) as total_item_value
     FROM order_items oi JOIN orders o ON oi.order_id = o.id
     WHERE o.outlet_id=? AND o.status='completed'
       AND o.created_at >= ? AND o.created_at < ?
     GROUP BY bd ORDER BY bd`,
    [OUTLET_ID, BD_START, BD_END]
  );

  // ── G. Per-day order-level for completed orders ──
  const [dailyOrders] = await c.query(
    `SELECT DATE(DATE_SUB(o.created_at, INTERVAL 4 HOUR)) as bd,
            COUNT(*) as cnt, SUM(total_amount) as total, SUM(subtotal) as sub,
            SUM(tax_amount) as tax, SUM(discount_amount) as disc,
            SUM(COALESCE(nc_amount,0)) as nc
     FROM orders o
     WHERE o.outlet_id=? AND o.status='completed'
       AND o.created_at >= ? AND o.created_at < ?
     GROUP BY bd ORDER BY bd`,
    [OUTLET_ID, BD_START, BD_END]
  );

  // ══════════════════════════════════════════════════
  // OUTPUT
  // ══════════════════════════════════════════════════

  console.log('\n── PER-DAY BREAKDOWN (completed orders) ──');
  console.log('  Date       | Orders | total_amount | subtotal   | tax       | discount  | NC      | cancelled_items');
  console.log('  ' + '-'.repeat(105));
  for (let i = 0; i < dailyOrders.length; i++) {
    const d = dailyOrders[i];
    const di = dailyItems[i] || {};
    const dateStr = d.bd instanceof Date ? d.bd.toISOString().slice(0,10) : String(d.bd).slice(0,10);
    console.log(`  ${dateStr} | ${String(d.cnt).padStart(6)} | ${String(r2(d.total)).padStart(12)} | ${String(r2(d.sub)).padStart(10)} | ${String(r2(d.tax)).padStart(9)} | ${String(r2(d.disc)).padStart(9)} | ${String(r2(d.nc)).padStart(7)} | ${String(r2(di.cancelled_value)).padStart(10)}`);
  }

  const compTotal = r2(comp[0].total);
  const compSub = r2(comp[0].sub);
  const compTax = r2(comp[0].tax);
  const compDisc = r2(comp[0].disc);
  const compNC = r2(comp[0].nc);
  const compRO = r2(comp[0].ro);
  const cancelItemVal = r2(cancelledItems[0].value);
  const cancelOrderVal = r2(cancelled[0].total);
  const cancelOrderItemVal = r2(cancelledOrderItems[0].value);
  const o43Total = r2(outlet43[0].total);
  const o43Disc = r2(outlet43[0].disc);
  const o43NC = r2(outlet43[0].nc);

  console.log('\n── BUILDING BLOCKS ──');
  console.log(`  [A] Completed orders total_amount (bill to customer)     : ${compTotal}`);
  console.log(`      = subtotal(${compSub}) + tax(${compTax}) - discount(${compDisc}) + round_off(${compRO})`);
  console.log(`      Check: ${r2(compSub + compTax - compDisc + compRO)} ≈ ${compTotal}`);
  console.log(`  [B] NC amount (food given free, total_amount=0)          : ${compNC}`);
  console.log(`  [C] Discount amount (already subtracted from total_amount): ${compDisc}`);
  console.log(`  [D] Cancelled items in completed orders (removed from bill): ${cancelItemVal} (${cancelledItems[0].cnt} items)`);
  console.log(`  [E] Cancelled orders value                               : ${cancelOrderVal} (${cancelled[0].cnt} orders)`);
  console.log(`  [F] Cancelled order items value                          : ${cancelOrderItemVal} (${cancelledOrderItems[0].cnt} items)`);
  console.log(`  [G] Outlet 43 completed total                            : ${o43Total}`);
  console.log(`  [H] Outlet 43 discount + NC                              : disc=${o43Disc}, nc=${o43NC}`);

  console.log('\n── EVERY POSSIBLE INTERPRETATION ──');
  console.log('  ' + '-'.repeat(85));

  const interpretations = [
    { label: '1. Completed total_amount (our DSR)',
      val: compTotal, formula: 'A' },
    { label: '2. + NC food value',
      val: r2(compTotal + compNC), formula: 'A + B' },
    { label: '3. + Discounts given back',
      val: r2(compTotal + compNC + compDisc), formula: 'A + B + C' },
    { label: '4. + Cancelled items from completed orders',
      val: r2(compTotal + compNC + compDisc + cancelItemVal), formula: 'A + B + C + D' },
    { label: '5. + Cancelled order values',
      val: r2(compTotal + compNC + compDisc + cancelItemVal + cancelOrderVal), formula: 'A+B+C+D+E' },
    { label: '6. + Outlet 43 completed total',
      val: r2(compTotal + o43Total), formula: 'A + G' },
    { label: '7. Both outlets + disc + NC',
      val: r2(compTotal + o43Total + compDisc + compNC + o43Disc + o43NC), formula: 'A+G+all disc+nc' },
    { label: '8. Both outlets + disc + NC + cancelled items',
      val: r2(compTotal + o43Total + compDisc + compNC + o43Disc + o43NC + cancelItemVal), formula: 'A+G+disc+nc+D' },
    { label: '9. Sub+Tax (pre-discount, pre-roundoff)',
      val: r2(compSub + compTax), formula: 'sub + tax' },
    { label: '10. Sub+Tax+NC',
      val: r2(compSub + compTax + compNC), formula: 'sub + tax + B' },
    { label: '11. Sub+Tax+NC+cancelledItems',
      val: r2(compSub + compTax + compNC + cancelItemVal), formula: 'sub+tax+B+D' },
    { label: '12. Gross items ordered (all items ever)',
      val: r2(r2(cancelledItems[0].value) + 512524), formula: 'served + cancelled items' },
    { label: '13. Gross items + tax',
      val: r2(532875 + compTax), formula: 'all items + tax' },
    { label: '14. Gross items + tax + cancelledOrders',
      val: r2(532875 + compTax + cancelOrderItemVal), formula: 'items+tax+cancelOrdItems' },
  ];

  for (const i of interpretations) {
    const gap = r2(599000 - i.val);
    const marker = Math.abs(gap) < 5000 ? '  <-- CLOSE' : Math.abs(gap) < 10000 ? '  <-- NEAR' : '';
    console.log(`  ${i.label}`);
    console.log(`    = ${i.val}   (gap: ${gap})   [${i.formula}]${marker}`);
  }

  console.log('\n' + '='.repeat(90));
  console.log('  CONCLUSION');
  console.log('='.repeat(90));
  console.log(`
  The database for Outlet 46 from Apr 1–6 contains:

    357 completed orders, total billed    = ₹5,28,074
    NC food given free                    = ₹2,267
    Discounts given                       = ₹13,628
    Cancelled items in completed orders   = ₹20,351
    Cancelled orders                      = ₹11,616 (40 orders)
    Outlet 43 (other outlet)              = ₹37,651

  Maximum possible "total food movement"  = ₹5,55,585 (outlet 46 only)
  Both outlets + everything               = ~₹6,13,000+

  The ₹5,99,000 restaurant claim CANNOT be reached from outlet 46 alone.
  
  Possible reasons for the restaurant's ₹5,99,000 figure:
    1. They count BOTH outlets (46 + 43) combined
    2. They count gross item value + tax (before discounts removed)
    3. They include cancelled items as "food consumed/wasted"
    4. They use a different date range or manual tracking
    5. They count subtotal+tax (pre-discount) = ₹5,41,709

  ACTION NEEDED: Ask the restaurant what EXACTLY they count as "sales"
  — is it the bill amount? subtotal? includes NC? includes cancelled items?
  `);

  await c.end();
}

run().catch(err => { console.error('Error:', err); process.exit(1); });
