/**
 * DEEPER INVESTIGATION: Check other outlets, voided items, prior-due collections
 * Run: node tests/investigate-gap-2.js
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

  console.log('='.repeat(80));
  console.log('  DEEPER INVESTIGATION — Outlet 46');
  console.log('='.repeat(80));

  // ═══════════════════════════════════════════════════
  // 1. OTHER OUTLETS (same restaurant?)
  // ═══════════════════════════════════════════════════
  console.log('\n── 1. ALL OUTLETS ──');
  const [outlets] = await c.query('SELECT id, name, is_active FROM outlets ORDER BY id');
  for (const o of outlets) {
    const [oc] = await c.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total 
       FROM orders WHERE outlet_id=? AND status='completed'
         AND created_at >= ? AND created_at < ?`,
      [o.id, BD_START, BD_END]
    );
    if (oc[0].cnt > 0) {
      console.log(`  Outlet ${o.id}: ${o.name} (active=${o.is_active}) — ${oc[0].cnt} completed orders, total=${r2(oc[0].total)}`);
    }
  }

  // ═══════════════════════════════════════════════════
  // 2. VOIDED/CANCELLED ITEMS in COMPLETED orders
  // ═══════════════════════════════════════════════════
  console.log('\n── 2. ORDER ITEMS STATUS within completed orders ──');
  const [itemStatus] = await c.query(
    `SELECT oi.status, COUNT(*) as cnt, 
            SUM(oi.quantity * oi.unit_price) as gross_value,
            SUM(oi.total_price) as total_price
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     WHERE o.outlet_id=? AND o.status='completed'
       AND o.created_at >= ? AND o.created_at < ?
     GROUP BY oi.status`,
    [OUTLET_ID, BD_START, BD_END]
  );
  for (const r of itemStatus) {
    console.log(`  item status='${r.status}': ${r.cnt} items, gross=${r2(r.gross_value)}, total_price=${r2(r.total_price)}`);
  }

  // Check if there are cancelled/voided items WITHIN completed orders
  const [voidedItems] = await c.query(
    `SELECT oi.status, o.order_number, oi.item_name, oi.quantity, oi.unit_price, 
            oi.quantity * oi.unit_price as value
     FROM order_items oi
     JOIN orders o ON oi.order_id = o.id
     WHERE o.outlet_id=? AND o.status='completed'
       AND oi.status IN ('cancelled', 'voided', 'void', 'removed')
       AND o.created_at >= ? AND o.created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  if (voidedItems.length > 0) {
    console.log(`\n  VOIDED/CANCELLED items in completed orders: ${voidedItems.length}`);
    let voidTotal = 0;
    for (const v of voidedItems.slice(0, 10)) {
      console.log(`    ${v.order_number}: ${v.item_name} x${v.quantity} @ ${v.unit_price} = ${r2(v.value)}`);
      voidTotal += r2(v.value);
    }
    if (voidedItems.length > 10) console.log(`    ... and ${voidedItems.length - 10} more`);
    const totalVoid = voidedItems.reduce((s, v) => s + r2(v.value), 0);
    console.log(`    TOTAL voided item value: ${r2(totalVoid)}`);
  } else {
    console.log('  No voided/cancelled items within completed orders.');
  }

  // ═══════════════════════════════════════════════════
  // 3. KOT ITEMS (sent to kitchen but maybe removed from order)
  // ═══════════════════════════════════════════════════
  console.log('\n── 3. KOT ITEMS vs ORDER ITEMS ──');
  try {
    const [kotTotal] = await c.query(
      `SELECT SUM(ki.quantity * ki.unit_price) as kot_value, COUNT(*) as cnt
       FROM kot_items ki
       JOIN kots k ON ki.kot_id = k.id
       JOIN orders o ON k.order_id = o.id
       WHERE o.outlet_id=? AND o.status='completed'
         AND o.created_at >= ? AND o.created_at < ?`,
      [OUTLET_ID, BD_START, BD_END]
    );
    console.log(`  KOT items total value: ${r2(kotTotal[0].kot_value)} (${kotTotal[0].cnt} items)`);

    // KOT items that might not be in order_items
    const [kotStatus] = await c.query(
      `SELECT ki.status, COUNT(*) as cnt, SUM(ki.quantity * ki.unit_price) as value
       FROM kot_items ki
       JOIN kots k ON ki.kot_id = k.id
       JOIN orders o ON k.order_id = o.id
       WHERE o.outlet_id=? AND o.status='completed'
         AND o.created_at >= ? AND o.created_at < ?
       GROUP BY ki.status`,
      [OUTLET_ID, BD_START, BD_END]
    );
    for (const r of kotStatus) {
      console.log(`    kot item status='${r.status}': ${r.cnt} items, value=${r2(r.value)}`);
    }
  } catch(e) {
    console.log('  KOT tables not found: ' + e.message);
  }

  // ═══════════════════════════════════════════════════
  // 4. PAYMENTS FROM PREVIOUS ORDERS (due collections)
  // ═══════════════════════════════════════════════════
  console.log('\n── 4. DUE PAYMENTS COLLECTED (from orders BEFORE Apr 1) ──');
  const [dueCollections] = await c.query(
    `SELECT p.order_id, o.order_number, o.created_at as order_date, p.amount, p.payment_mode, p.created_at as pay_date
     FROM payments p
     JOIN orders o ON p.order_id = o.id
     WHERE p.outlet_id=? AND p.status='completed'
       AND p.created_at >= ? AND p.created_at < ?
       AND o.created_at < ?
     ORDER BY p.created_at`,
    [OUTLET_ID, BD_START, BD_END, BD_START]
  );
  let priorDueTotal = 0;
  if (dueCollections.length > 0) {
    console.log(`  ${dueCollections.length} payments for orders created BEFORE Apr 1:`);
    for (const p of dueCollections) {
      priorDueTotal += r2(p.amount);
      console.log(`    ${p.order_number} (created ${p.order_date}): paid ${r2(p.amount)} via ${p.payment_mode} on ${p.pay_date}`);
    }
    console.log(`  TOTAL prior-due collections: ${r2(priorDueTotal)}`);
  } else {
    console.log('  No prior-order due payments collected in this period.');
  }

  // ═══════════════════════════════════════════════════
  // 5. SPLIT PAYMENT DETAILS
  // ═══════════════════════════════════════════════════
  console.log('\n── 5. SPLIT PAYMENT CHECK ──');
  const [splitCheck] = await c.query(
    `SELECT p.id as payment_id, p.amount as payment_amount, 
            SUM(sp.amount) as split_total, COUNT(sp.id) as split_count
     FROM payments p
     LEFT JOIN split_payments sp ON sp.payment_id = p.id
     WHERE p.outlet_id=? AND p.status='completed' AND p.payment_mode='split'
       AND p.created_at >= ? AND p.created_at < ?
     GROUP BY p.id`,
    [OUTLET_ID, BD_START, BD_END]
  );
  let splitPayTotal = 0, splitSubTotal = 0;
  for (const s of splitCheck) {
    splitPayTotal += r2(s.payment_amount);
    splitSubTotal += r2(s.split_total);
    if (Math.abs(r2(s.payment_amount) - r2(s.split_total)) > 0.01) {
      console.log(`  MISMATCH! Payment ${s.payment_id}: amount=${r2(s.payment_amount)}, splits sum=${r2(s.split_total)}`);
    }
  }
  console.log(`  Split payments total: ${r2(splitPayTotal)}, splits detail total: ${r2(splitSubTotal)}`);

  // ═══════════════════════════════════════════════════
  // 6. IS THERE AN is_nc MISMATCH (items marked NC but order not?)
  // ═══════════════════════════════════════════════════
  console.log('\n── 6. NC MISMATCH CHECK ──');
  try {
    const [ncItemsNonNC] = await c.query(
      `SELECT o.order_number, o.is_nc, o.nc_amount, o.total_amount,
              SUM(oi.quantity * oi.unit_price) as item_value
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.outlet_id=? AND o.status='completed'
         AND o.created_at >= ? AND o.created_at < ?
         AND oi.is_nc = 1
       GROUP BY o.id`,
      [OUTLET_ID, BD_START, BD_END]
    );
    if (ncItemsNonNC.length > 0) {
      console.log(`  Orders with NC items:`);
      for (const r of ncItemsNonNC) {
        console.log(`    ${r.order_number}: order.is_nc=${r.is_nc}, order.nc_amount=${r2(r.nc_amount)}, order.total=${r2(r.total_amount)}, nc_item_value=${r2(r.item_value)}`);
      }
    } else {
      console.log('  No NC items found (or is_nc not on items).');
    }
  } catch(e) {
    console.log('  NC item check error: ' + e.message);
  }

  // ═══════════════════════════════════════════════════
  // 7. COMPLETE PICTURE
  // ═══════════════════════════════════════════════════
  console.log('\n── 7. COMPLETE PICTURE ──');

  // Total money that flowed through the system
  const [totalPayments] = await c.query(
    `SELECT SUM(amount) as total FROM payments 
     WHERE outlet_id=? AND status='completed'
       AND created_at >= ? AND created_at < ?`,
    [OUTLET_ID, BD_START, BD_END]
  );
  const totalMoney = r2(totalPayments[0].total);

  console.log(`  Money actually received (payments): ${totalMoney}`);
  console.log(`  + Outstanding dues (completed orders): 6720`);
  console.log(`  = Total accounted: ${r2(totalMoney + 6720)}`);
  console.log(`  + Prior-order due collections: ${r2(priorDueTotal)}`);
  console.log(`  Money IN - prior dues = current-period money: ${r2(totalMoney - priorDueTotal)}`);
  console.log();
  console.log(`  Completed order total_amount: 528074`);
  console.log(`  + NC food value:              2267`);
  console.log(`  + Discount given:             13627.59`);
  console.log(`  = Gross food movement:        ${r2(528074 + 2267 + 13627.59)}`);
  console.log(`  + Cancelled (with value):     11616`);
  console.log(`  = Total food movement:        ${r2(528074 + 2267 + 13627.59 + 11616)}`);

  console.log('\n  Restaurant claim: 599000');
  console.log(`  Gap even with everything: ${r2(599000 - 528074 - 2267 - 13627.59 - 11616)}`);
  console.log('\n  IMPORTANT: The restaurant might be counting ₹5,99,000 from a different');
  console.log('  source (manual register, POS terminal, or including bar/other outlet).');
  console.log('  Our database has exactly 357 completed orders = ₹5,28,074 for outlet 46.');

  await c.end();
}

run().catch(err => { console.error('Error:', err); process.exit(1); });
