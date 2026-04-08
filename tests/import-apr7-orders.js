/**
 * IMPORT Apr 7 orders from Excel into DB (outlet 46)
 * 
 * Rules:
 *   - Exclude Zomato/delivery orders
 *   - Map table names from "Dine In (XXX)" to DB table IDs
 *   - BAR tables → floor_id=38 (First Floor), created_by=201 (Aditya)
 *   - A/B tables → floor_id=39 (Third Floor), created_by=205 (Shiv)
 *   - All orders: status='completed'
 *   - "Due Payment" → payment_status='partial', paid_amount=0, due_amount=grand_total
 *   - All others → payment_status='completed', full payment record
 *   - FULL TRANSACTION: rollback on ANY error
 * 
 * DRY RUN first, then actual import with --execute flag
 * 
 * Usage:
 *   node tests/import-apr7-orders.js              # DRY RUN (no DB changes)
 *   node tests/import-apr7-orders.js --execute     # ACTUAL IMPORT
 */

const XLSX = require('xlsx');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const OUTLET_ID = 46;
const file = path.join(__dirname, 'Order_Listing_2026_04_08_01_01_51.xlsx');
const EXECUTE = process.argv.includes('--execute');

const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
const uuid = () => crypto.randomUUID();

// Floor mapping: Excel Sub Order Type → DB floor_id + cashier_id
const FLOOR_MAP = {
  'BAR':       { floor_id: 38, cashier_id: 201 },  // First Floor → Aditya
  'Resturant': { floor_id: 39, cashier_id: 205 },  // Third Floor → Shiv
  'Roof Top':  { floor_id: 39, cashier_id: 205 },  // Third Floor → Shiv
};

// Payment mode mapping: Excel Payment Type → DB payment_mode
const PAY_MAP = {
  'Cash':          'cash',
  'Other [UPI]':   'upi',
  'Card':          'card',
  'Due Payment':   null,  // No payment record, order is partial
};

async function run() {
  // ── Parse Excel ──────────────────────────────────────────────────
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  
  let headerIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].some(c => String(c).includes('Order No'))) { headerIdx = i; break; }
  }
  const headers = raw[headerIdx].map(h => String(h || '').trim());
  const allRows = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || !row[0]) continue;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = row[idx] !== undefined ? row[idx] : ''; });
    allRows.push(obj);
  }

  // Filter out Zomato/delivery orders
  const excelOrders = allRows.filter(r => {
    const subType = String(r['Sub Order Type'] || '').trim();
    const payType = String(r['Payment Type'] || '').trim();
    return subType !== 'Zomato' && payType !== 'Online';
  });

  console.log(`Excel: ${allRows.length} total rows, ${excelOrders.length} after excluding Zomato`);
  console.log(`Mode: ${EXECUTE ? '⚡ EXECUTE (will write to DB)' : '🔍 DRY RUN (no DB changes)'}\n`);

  // ── Connect to DB ────────────────────────────────────────────────
  const pool = await mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  // Build table name → ID map
  const [dbTables] = await pool.query(
    `SELECT id, name, floor_id FROM tables WHERE outlet_id = ?`, [OUTLET_ID]
  );
  const tableMap = {};
  dbTables.forEach(t => { tableMap[t.name.toUpperCase()] = { id: t.id, floor_id: t.floor_id }; });

  // Get existing max order_number sequence for Apr 7
  const [existingOrders] = await pool.query(
    `SELECT order_number FROM orders WHERE outlet_id = ? AND order_number LIKE 'ORD260407%' ORDER BY order_number DESC LIMIT 1`,
    [OUTLET_ID]
  );
  let nextSeq = 3; // Default start from 003 (001 and 002 exist)
  if (existingOrders.length > 0) {
    const lastNum = parseInt(existingOrders[0].order_number.slice(-4));
    nextSeq = lastNum + 1;
  }
  console.log(`Starting order sequence: ORD260407${String(nextSeq).padStart(4, '0')}`);

  // Get max payment_number sequence for Apr 7
  const [existingPay] = await pool.query(
    `SELECT payment_number FROM payments WHERE outlet_id = ? AND payment_number LIKE 'PAY260407%' ORDER BY payment_number DESC LIMIT 1`,
    [OUTLET_ID]
  );
  let nextPaySeq = 1;
  if (existingPay.length > 0) {
    const lastPayNum = parseInt(existingPay[0].payment_number.slice(-4));
    nextPaySeq = lastPayNum + 1;
  }
  console.log(`Starting payment sequence: PAY260407${String(nextPaySeq).padStart(4, '0')}\n`);

  // ── Parse and validate each order ──────────────────────────────
  const ordersToInsert = [];
  const errors = [];

  for (const row of excelOrders) {
    const orderNo = row['Order No.'];
    const orderType = String(row['Order Type'] || '').trim();
    const subType = String(row['Sub Order Type'] || '').trim();
    const payType = String(row['Payment Type'] || '').trim();
    const payDesc = String(row['Payment Description'] || '').trim();
    const created = String(row['Created'] || '').trim();
    const customerName = String(row['Customer Name'] || '').trim() || null;
    const customerPhone = row['Customer Phone'] ? String(row['Customer Phone']).trim() : null;

    // Extract table name from "Dine In (BAR19)" format
    const tableMatch = orderType.match(/\(([^)]+)\)/);
    const tableName = tableMatch ? tableMatch[1].trim().toUpperCase() : null;

    if (!tableName) {
      errors.push(`Order #${orderNo}: Cannot extract table name from "${orderType}"`);
      continue;
    }

    const tableInfo = tableMap[tableName];
    if (!tableInfo) {
      errors.push(`Order #${orderNo}: Table "${tableName}" not found in DB`);
      continue;
    }

    const floorInfo = FLOOR_MAP[subType];
    if (!floorInfo) {
      errors.push(`Order #${orderNo}: Floor "${subType}" not mapped`);
      continue;
    }

    // Verify table is on the correct floor
    if (tableInfo.floor_id !== floorInfo.floor_id) {
      errors.push(`Order #${orderNo}: Table "${tableName}" is on floor ${tableInfo.floor_id}, but subType "${subType}" maps to floor ${floorInfo.floor_id}`);
      // Use table's actual floor, not the subType mapping
    }

    // Parse amounts
    const myAmount = r2(row['My Amount (₹)']);       // subtotal before discount
    const discount = r2(row['Total Discount (₹)']);
    const tax = r2(row['Total Tax (₹)']);
    const roundOff = r2(row['Round Off (₹)']);
    const grandTotal = r2(row['Grand Total (₹)']);
    const deliveryChg = r2(row['Delivery Charge (₹)']);
    const containerChg = r2(row['Container Charge (₹)']);

    // Verify: grandTotal should = myAmount - discount + tax + roundOff + deliveryChg + containerChg
    const calculated = r2(myAmount - discount + tax + roundOff + deliveryChg + containerChg);
    if (Math.abs(calculated - grandTotal) > 1) {
      errors.push(`Order #${orderNo}: Amount mismatch! calculated=${calculated} vs grandTotal=${grandTotal}`);
    }

    // Parse created_at: "7 Apr 2026 23:58:58" or "8 Apr 2026 00:11:42"
    const createdDate = new Date(created);
    if (isNaN(createdDate.getTime())) {
      errors.push(`Order #${orderNo}: Cannot parse date "${created}"`);
      continue;
    }
    // Format as MySQL datetime (local time, not UTC)
    const createdAt = `${createdDate.getFullYear()}-${String(createdDate.getMonth()+1).padStart(2,'0')}-${String(createdDate.getDate()).padStart(2,'0')} ${String(createdDate.getHours()).padStart(2,'0')}:${String(createdDate.getMinutes()).padStart(2,'0')}:${String(createdDate.getSeconds()).padStart(2,'0')}`;

    // Determine payment status
    const isDue = payType === 'Due Payment';
    const paymentMode = PAY_MAP[payType];
    if (paymentMode === undefined && !isDue) {
      errors.push(`Order #${orderNo}: Unknown payment type "${payType}"`);
      continue;
    }

    const orderNumber = `ORD260407${String(nextSeq).padStart(4, '0')}`;
    nextSeq++;

    // subtotal = myAmount (before discount, before tax)
    // In our DB: subtotal = item prices sum (before discount/tax)
    // total_amount = grandTotal = subtotal - discount + tax + round_off
    const subtotal = myAmount;

    ordersToInsert.push({
      excelOrderNo: orderNo,
      orderNumber,
      tableId: tableInfo.id,
      tableName,
      floorId: tableInfo.floor_id,
      cashierId: floorInfo.cashier_id,
      customerName,
      customerPhone,
      subtotal,
      discountAmount: discount,
      taxAmount: tax,
      roundOff,
      deliveryCharge: deliveryChg,
      containerCharge: containerChg,
      totalAmount: grandTotal,
      paidAmount: isDue ? 0 : grandTotal,
      dueAmount: isDue ? grandTotal : 0,
      paymentStatus: isDue ? 'partial' : 'completed',
      paymentMode: isDue ? null : paymentMode,
      payDesc,
      isDue,
      createdAt,
      subType
    });
  }

  // ── Report validation ──────────────────────────────────────────
  if (errors.length > 0) {
    console.log('⚠️ VALIDATION ERRORS:');
    errors.forEach(e => console.log(`  ❌ ${e}`));
    console.log('');
  }

  console.log('═'.repeat(90));
  console.log('  ORDERS TO IMPORT');
  console.log('═'.repeat(90));

  let totalSale = 0, totalDiscount = 0, totalTax = 0;
  const byFloor = {};
  const byPay = {};

  for (const o of ordersToInsert) {
    totalSale += o.totalAmount;
    totalDiscount += o.discountAmount;
    totalTax += o.taxAmount;
    const fn = o.subType;
    if (!byFloor[fn]) byFloor[fn] = { count: 0, amount: 0 };
    byFloor[fn].count++;
    byFloor[fn].amount += o.totalAmount;
    const pm = o.isDue ? 'Due' : o.paymentMode;
    if (!byPay[pm]) byPay[pm] = { count: 0, amount: 0 };
    byPay[pm].count++;
    byPay[pm].amount += o.totalAmount;
  }

  console.log(`\n  Total orders: ${ordersToInsert.length}`);
  console.log(`  Total Sale: Rs ${r2(totalSale)}`);
  console.log(`  Total Discount: Rs ${r2(totalDiscount)}`);
  console.log(`  Total Tax: Rs ${r2(totalTax)}`);

  console.log('\n  By Floor:');
  for (const [f, d] of Object.entries(byFloor)) {
    console.log(`    ${f.padEnd(15)} ${d.count} orders   Rs ${r2(d.amount)}`);
  }
  console.log('\n  By Payment:');
  for (const [p, d] of Object.entries(byPay)) {
    console.log(`    ${p.padEnd(15)} ${d.count} orders   Rs ${r2(d.amount)}`);
  }

  console.log('\n  Order list:');
  for (const o of ordersToInsert) {
    console.log(`    ${o.orderNumber} | Excel#${o.excelOrderNo} | ${o.tableName.padEnd(6)} | Rs ${String(o.totalAmount).padEnd(6)} | ${(o.paymentMode || 'DUE').padEnd(5)} | ${o.paymentStatus.padEnd(9)} | ${o.createdAt}`);
  }

  if (!EXECUTE) {
    console.log('\n' + '═'.repeat(90));
    console.log('  🔍 DRY RUN COMPLETE — No changes made to DB');
    console.log('  To execute: node tests/import-apr7-orders.js --execute');
    console.log('═'.repeat(90));
    await pool.end();
    return;
  }

  // ══════════════════════════════════════════════════════════════════
  // EXECUTE: Insert into DB with full transaction
  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  ⚡ EXECUTING IMPORT...');
  console.log('═'.repeat(90));

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    const insertedOrderIds = [];
    const insertedPaymentIds = [];
    let paySeq = nextPaySeq;

    for (const o of ordersToInsert) {
      // 1. Insert order
      const orderUuid = uuid();
      const billedAt = o.createdAt; // Use same time as created
      const updatedAt = o.createdAt;

      const [orderResult] = await conn.query(
        `INSERT INTO orders (
          uuid, outlet_id, order_number, order_type, source, table_id, floor_id,
          customer_name, customer_phone, guest_count, status,
          subtotal, discount_amount, tax_amount, service_charge, packaging_charge,
          delivery_charge, round_off, total_amount, paid_amount, due_amount,
          adjustment_amount, is_adjustment, payment_status,
          created_by, billed_by, billed_at, created_at, updated_at,
          is_nc, nc_amount, is_interstate, stock_reversed
        ) VALUES (?, ?, ?, 'dine_in', 'pos', ?, ?, ?, ?, 1, 'completed',
                  ?, ?, ?, 0, 0, ?, ?, ?, ?, ?,
                  0, 0, ?,
                  ?, ?, ?, ?, ?,
                  0, 0, 0, 0)`,
        [
          orderUuid, OUTLET_ID, o.orderNumber, o.tableId, o.floorId,
          o.customerName, o.customerPhone,
          o.subtotal, o.discountAmount, o.taxAmount,
          o.deliveryCharge, o.roundOff, o.totalAmount, o.paidAmount, o.dueAmount,
          o.paymentStatus,
          o.cashierId, o.cashierId, billedAt, o.createdAt, updatedAt
        ]
      );

      const orderId = orderResult.insertId;
      insertedOrderIds.push(orderId);

      // 2. Insert payment (if not due)
      if (!o.isDue && o.paymentMode) {
        const payUuid = uuid();
        const payNumber = `PAY260407${String(paySeq).padStart(4, '0')}`;
        paySeq++;

        const upiId = o.paymentMode === 'upi' && o.payDesc ? o.payDesc : null;

        const [payResult] = await conn.query(
          `INSERT INTO payments (
            uuid, outlet_id, order_id, payment_number, payment_mode,
            amount, tip_amount, total_amount, status,
            upi_id, received_by, is_due_collection, is_adjustment,
            adjustment_amount, due_amount, is_short_payment,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?,
                    ?, 0, ?, 'completed',
                    ?, ?, 0, 0,
                    0, 0, 0,
                    ?, ?)`,
          [
            payUuid, OUTLET_ID, orderId, payNumber, o.paymentMode,
            o.totalAmount, o.totalAmount,
            upiId, o.cashierId,
            o.createdAt, o.createdAt
          ]
        );
        insertedPaymentIds.push(payResult.insertId);
      }
    }

    // ── Verify before commit ────────────────────────────────────
    const [verifyOrders] = await conn.query(
      `SELECT COUNT(*) as cnt, SUM(total_amount) as total 
       FROM orders WHERE id IN (${insertedOrderIds.join(',')}) AND status = 'completed'`
    );
    const [verifyPayments] = await conn.query(
      `SELECT COUNT(*) as cnt, SUM(total_amount) as total 
       FROM payments WHERE id IN (${insertedPaymentIds.length > 0 ? insertedPaymentIds.join(',') : '0'}) AND status = 'completed'`
    );

    const dbOrderTotal = r2(verifyOrders[0].total);
    const dbOrderCount = parseInt(verifyOrders[0].cnt);
    const expectedTotal = r2(totalSale);
    const expectedPaidTotal = r2(ordersToInsert.filter(o => !o.isDue).reduce((s, o) => s + o.totalAmount, 0));

    console.log(`\n  Inserted: ${dbOrderCount} orders, total Rs ${dbOrderTotal}`);
    console.log(`  Expected: ${ordersToInsert.length} orders, total Rs ${expectedTotal}`);
    console.log(`  Payments: ${verifyPayments[0].cnt} payments, total Rs ${r2(verifyPayments[0].total)}`);
    console.log(`  Expected payments: Rs ${expectedPaidTotal}`);

    if (dbOrderCount !== ordersToInsert.length) {
      throw new Error(`Order count mismatch: inserted ${dbOrderCount}, expected ${ordersToInsert.length}`);
    }
    if (Math.abs(dbOrderTotal - expectedTotal) > 1) {
      throw new Error(`Order total mismatch: inserted Rs ${dbOrderTotal}, expected Rs ${expectedTotal}`);
    }

    // COMMIT
    await conn.commit();
    console.log('\n  ✅ COMMITTED SUCCESSFULLY');
    console.log(`  Order IDs: ${insertedOrderIds[0]} to ${insertedOrderIds[insertedOrderIds.length - 1]}`);
    console.log(`  Payment IDs: ${insertedPaymentIds.length > 0 ? insertedPaymentIds[0] + ' to ' + insertedPaymentIds[insertedPaymentIds.length - 1] : 'none (due only)'}`);

    // ── Post-import verification ──────────────────────────────
    console.log('\n' + '═'.repeat(90));
    console.log('  POST-IMPORT VERIFICATION');
    console.log('═'.repeat(90));

    // Check Apr 7 business day totals
    const [bdTotals] = await conn.query(
      `SELECT COUNT(*) as cnt, SUM(total_amount) as sale,
              SUM(discount_amount) as discount, SUM(tax_amount) as tax
       FROM orders WHERE outlet_id = ? AND status = 'completed'
         AND created_at >= '2026-04-07 04:00:00' AND created_at < '2026-04-08 04:00:00'`,
      [OUTLET_ID]
    );
    console.log(`\n  Apr 7 business day (completed orders):`);
    console.log(`    Orders: ${bdTotals[0].cnt}`);
    console.log(`    Total Sale: Rs ${r2(bdTotals[0].sale)}`);
    console.log(`    Discount: Rs ${r2(bdTotals[0].discount)}`);
    console.log(`    Tax: Rs ${r2(bdTotals[0].tax)}`);

    // Check by floor
    const [floorTotals] = await conn.query(
      `SELECT f.name, COUNT(*) as cnt, SUM(o.total_amount) as sale
       FROM orders o JOIN floors f ON o.floor_id = f.id
       WHERE o.outlet_id = ? AND o.status = 'completed'
         AND o.created_at >= '2026-04-07 04:00:00' AND o.created_at < '2026-04-08 04:00:00'
       GROUP BY f.name`,
      [OUTLET_ID]
    );
    console.log('\n  By floor:');
    floorTotals.forEach(f => console.log(`    ${f.name}: ${f.cnt} orders, Rs ${r2(f.sale)}`));

  } catch (err) {
    // ROLLBACK on any error
    await conn.rollback();
    console.log('\n  ❌ ERROR — ALL CHANGES ROLLED BACK');
    console.log(`  Error: ${err.message}`);
    console.log(err.stack);
  } finally {
    conn.release();
  }

  await pool.end();
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
