/**
 * IMPORT Apr 8 orders from Excel into DB (outlet 46)
 * 
 * Rules:
 *   - Exclude Zomato/Swiggy/Online orders
 *   - Map table names from "Dine In (XXX)" to DB table IDs
 *   - BAR tables → floor_id=38 (First Floor), created_by=201 (Aditya)
 *   - Resturant/Roof Top → floor_id=39 (Third Floor), created_by=205 (Shiv)
 *   - Pick Up → order_type='takeaway', table_id=NULL, floor_id=NULL, created_by=205
 *   - All orders: status='completed'
 *   - "Due Payment"  → payment_status='partial', paid_amount=0, due_amount=grand_total
 *   - "Part Payment" → payment_status='completed', MULTIPLE payment records (split)
 *   - Others          → payment_status='completed', single payment record
 *   - Items: parse from "Items" column, insert order_items with proper item_id/variant_id
 *   - Unmatched items: create in items table as open items
 *   - Create day_sessions (shifts) for Apr 8
 *   - FULL TRANSACTION: rollback on ANY error
 * 
 * Usage:
 *   node tests/import-apr8-orders.js              # DRY RUN
 *   node tests/import-apr8-orders.js --execute     # ACTUAL IMPORT
 */

const XLSX = require('xlsx');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dbCfg = require('../src/config/database.config');

const OUTLET_ID = 46;
const file = path.join(__dirname, '8thApril-Order.xlsx');
const EXECUTE = process.argv.includes('--execute');

const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
const uuid = () => crypto.randomUUID();

// Floor mapping: Excel Sub Order Type → DB floor_id + cashier_id
const FLOOR_MAP = {
  'BAR':       { floor_id: 38, cashier_id: 201 },  // First Floor → Aditya
  'Resturant': { floor_id: 39, cashier_id: 205 },  // Third Floor → Shiv
  'Roof Top':  { floor_id: 39, cashier_id: 205 },  // Third Floor → Shiv
  'Pick Up':   { floor_id: null, cashier_id: 205 }, // Takeaway → Shiv
};

// Payment mode mapping
const PAY_MAP = {
  'Cash':          'cash',
  'Other [UPI]':   'upi',
  'Card':          'card',
  'Due Payment':   null,
  'Part Payment':  null, // Handled via sub-rows
};

const OPEN_ITEM_CATEGORY = 315; // "Open Item" category
const DEFAULT_TAX_GROUP = 4;    // GST 5%
const TAX_RATE = 5;             // 5%

async function run() {
  // ══════════════════════════════════════════════════════════════
  // 1. PARSE EXCEL
  // ══════════════════════════════════════════════════════════════
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  let headerIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].some(c => String(c).includes('Order No'))) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error('Header row not found');

  const headers = raw[headerIdx].map(h => String(h || '').trim());
  const gtCol = headers.find(h => h.includes('Grand Total'));
  const myAmtCol = headers.find(h => h.includes('My Amount'));
  const discCol = headers.find(h => h.includes('Total Discount'));
  const taxCol = headers.find(h => h.includes('Total Tax'));
  const roundCol = headers.find(h => h.includes('Round Off'));
  const delCol = headers.find(h => h.includes('Delivery Charge'));
  const contCol = headers.find(h => h.includes('Container Charge'));

  const allRows = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (!row || !row[0]) continue;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = row[idx] !== undefined ? row[idx] : ''; });
    allRows.push(obj);
  }

  // Group rows by Order No
  const groups = {};
  allRows.forEach(r => {
    const no = String(r['Order No.']);
    if (!groups[no]) groups[no] = [];
    groups[no].push(r);
  });

  // Filter out Zomato/Swiggy/Online
  const excludedNos = new Set();
  for (const [no, rows] of Object.entries(groups)) {
    const main = rows[0];
    const sub = String(main['Sub Order Type'] || '').toLowerCase();
    const pay = String(main['Payment Type'] || '').toLowerCase();
    if (sub.includes('zomato') || sub.includes('swiggy') || pay === 'online') {
      excludedNos.add(no);
    }
  }

  const importableGroups = Object.entries(groups).filter(([no]) => !excludedNos.has(no));
  console.log(`Excel: ${allRows.length} rows, ${Object.keys(groups).length} unique orders`);
  console.log(`Excluded (Zomato/Swiggy/Online): ${excludedNos.size} orders [${[...excludedNos].join(', ')}]`);
  console.log(`Importable: ${importableGroups.length} orders`);
  console.log(`Mode: ${EXECUTE ? '⚡ EXECUTE' : '🔍 DRY RUN'}\n`);

  // ══════════════════════════════════════════════════════════════
  // 2. CONNECT TO DB & BUILD MAPS
  // ══════════════════════════════════════════════════════════════
  const pool = await mysql.createPool({ host: dbCfg.host, port: dbCfg.port, user: dbCfg.user, password: dbCfg.password, database: dbCfg.database });

  // Table map
  const [dbTables] = await pool.query('SELECT id, name, floor_id FROM tables WHERE outlet_id = ?', [OUTLET_ID]);
  const tableMap = {};
  dbTables.forEach(t => { tableMap[t.name.toUpperCase()] = { id: t.id, floor_id: t.floor_id }; });

  // Item map (name → { id, price, item_type, tax_group_id, has_variants })
  const [dbItems] = await pool.query(
    `SELECT id, name, base_price, item_type, tax_group_id, tax_enabled, has_variants, category_id
     FROM items WHERE outlet_id = ? AND is_active = 1`, [OUTLET_ID]
  );
  const itemMap = {};
  dbItems.forEach(i => { itemMap[i.name.toLowerCase().trim()] = i; });

  // Variant map (name → { item_id, variant_id, price, variant_name })
  const [dbVariants] = await pool.query(
    `SELECT v.id, v.name, v.price, v.item_id, i.name as item_name, i.item_type, i.tax_group_id, i.tax_enabled
     FROM variants v JOIN items i ON v.item_id = i.id
     WHERE i.outlet_id = ? AND i.is_active = 1`, [OUTLET_ID]
  );
  const variantMap = {};
  dbVariants.forEach(v => {
    const key = (v.item_name + ' (' + v.name + ')').toLowerCase().trim();
    variantMap[key] = v;
  });

  // Sequence numbers
  const [existingOrders] = await pool.query(
    `SELECT order_number FROM orders WHERE outlet_id = ? AND order_number LIKE 'ORD260408%' ORDER BY order_number DESC LIMIT 1`, [OUTLET_ID]
  );
  let nextSeq = 1;
  if (existingOrders.length > 0) {
    nextSeq = parseInt(existingOrders[0].order_number.slice(-4)) + 1;
  }

  const [existingPay] = await pool.query(
    `SELECT payment_number FROM payments WHERE outlet_id = ? AND payment_number LIKE 'PAY260408%' ORDER BY payment_number DESC LIMIT 1`, [OUTLET_ID]
  );
  let nextPaySeq = 1;
  if (existingPay.length > 0) {
    nextPaySeq = parseInt(existingPay[0].payment_number.slice(-4)) + 1;
  }

  console.log(`Starting: ORD260408${String(nextSeq).padStart(4, '0')}, PAY260408${String(nextPaySeq).padStart(4, '0')}\n`);

  // ══════════════════════════════════════════════════════════════
  // 3. PARSE & VALIDATE EACH ORDER
  // ══════════════════════════════════════════════════════════════
  const ordersToInsert = [];
  const errors = [];
  const unmatchedItemNames = new Set();

  for (const [excelOrderNo, rows] of importableGroups) {
    const main = rows[0];
    const orderType = String(main['Order Type'] || '').trim();
    const subType = String(main['Sub Order Type'] || '').trim();
    const payType = String(main['Payment Type'] || '').trim();
    const created = String(main['Created'] || '').trim();
    const customerName = String(main['Customer Name'] || '').trim() || null;
    const customerPhone = main['Customer Phone'] ? String(main['Customer Phone']).trim() : null;
    const itemsStr = String(main['Items'] || '').trim();

    // Floor mapping
    const floorInfo = FLOOR_MAP[subType];
    if (!floorInfo) {
      errors.push(`Order #${excelOrderNo}: Floor "${subType}" not mapped`);
      continue;
    }

    // Table extraction
    let tableId = null, tableName = null, floorId = floorInfo.floor_id;
    const isPickUp = subType === 'Pick Up';
    const dbOrderType = isPickUp ? 'takeaway' : 'dine_in';

    if (!isPickUp) {
      const tableMatch = orderType.match(/\(([^)]+)\)/);
      tableName = tableMatch ? tableMatch[1].trim().toUpperCase() : null;
      if (!tableName) {
        errors.push(`Order #${excelOrderNo}: Cannot extract table name from "${orderType}"`);
        continue;
      }
      const tableInfo = tableMap[tableName];
      if (!tableInfo) {
        errors.push(`Order #${excelOrderNo}: Table "${tableName}" not found in DB`);
        continue;
      }
      tableId = tableInfo.id;
      floorId = tableInfo.floor_id; // Use table's actual floor
    }

    // Parse amounts
    const myAmount = r2(main[myAmtCol]);
    const discount = r2(main[discCol]);
    const tax = r2(main[taxCol]);
    const roundOff = r2(main[roundCol]);
    const deliveryChg = r2(main[delCol]);
    const containerChg = r2(main[contCol]);

    // Determine grand total
    let grandTotal;
    if (payType === 'Part Payment') {
      // Grand total from PayDesc: "Total : XXXX.00"
      const match = String(main['Payment Description'] || '').match(/Total\s*:\s*([\d.]+)/);
      if (!match) {
        errors.push(`Order #${excelOrderNo}: Part Payment but no total in PayDesc`);
        continue;
      }
      grandTotal = r2(parseFloat(match[1]));
    } else {
      grandTotal = r2(main[gtCol]);
    }

    // Validate amounts
    const calculated = r2(myAmount - discount + tax + roundOff + deliveryChg + containerChg);
    if (Math.abs(calculated - grandTotal) > 1) {
      errors.push(`Order #${excelOrderNo}: Amount mismatch! calc=${calculated} vs grand=${grandTotal} (diff=${r2(calculated - grandTotal)})`);
    }

    // Parse date
    const createdDate = new Date(created);
    if (isNaN(createdDate.getTime())) {
      errors.push(`Order #${excelOrderNo}: Cannot parse date "${created}"`);
      continue;
    }
    const createdAt = `${createdDate.getFullYear()}-${String(createdDate.getMonth()+1).padStart(2,'0')}-${String(createdDate.getDate()).padStart(2,'0')} ${String(createdDate.getHours()).padStart(2,'0')}:${String(createdDate.getMinutes()).padStart(2,'0')}:${String(createdDate.getSeconds()).padStart(2,'0')}`;

    // Determine payments
    const payments = [];
    if (payType === 'Due Payment') {
      // No payment record, order is partial
    } else if (payType === 'Part Payment') {
      // Multiple payments from sub-rows
      for (let i = 1; i < rows.length; i++) {
        const subRow = rows[i];
        const subPayType = String(subRow['Payment Type'] || '').trim();
        const subAmount = r2(subRow[gtCol]);
        if (subPayType === 'Not Paid' || subAmount === 0) continue;
        const subPayMode = PAY_MAP[subPayType];
        if (subPayMode === undefined) {
          errors.push(`Order #${excelOrderNo}: Unknown sub-payment type "${subPayType}"`);
          continue;
        }
        if (subPayMode) {
          payments.push({
            mode: subPayMode,
            amount: subAmount,
            upiId: subPayMode === 'upi' ? (String(subRow['Payment Description'] || '').trim() || null) : null
          });
        }
      }
      // Verify sub-payments sum to grand total
      const paySum = r2(payments.reduce((s, p) => s + p.amount, 0));
      if (Math.abs(paySum - grandTotal) > 1) {
        errors.push(`Order #${excelOrderNo}: Part Payment sum ${paySum} != grand total ${grandTotal}`);
      }
    } else {
      // Single payment
      const payMode = PAY_MAP[payType];
      if (payMode === undefined) {
        errors.push(`Order #${excelOrderNo}: Unknown payment type "${payType}"`);
        continue;
      }
      if (payMode) {
        const payDesc = String(main['Payment Description'] || '').trim();
        payments.push({
          mode: payMode,
          amount: grandTotal,
          upiId: payMode === 'upi' && payDesc ? payDesc : null
        });
      }
    }

    const isDue = payType === 'Due Payment';
    const isPaid = !isDue;

    // Parse items
    const parsedItems = [];
    if (itemsStr) {
      const itemNames = itemsStr.split(',').map(s => s.trim()).filter(Boolean);
      const countMap = {};
      itemNames.forEach(name => {
        countMap[name] = (countMap[name] || 0) + 1;
      });

      for (const [name, qty] of Object.entries(countMap)) {
        const key = name.toLowerCase().trim();
        // Try exact match, then variant match
        let itemInfo = null;
        if (variantMap[key]) {
          const v = variantMap[key];
          itemInfo = {
            item_id: v.item_id, variant_id: v.id, item_name: v.item_name,
            variant_name: v.name, unit_price: parseFloat(v.price),
            item_type: v.item_type, tax_group_id: v.tax_group_id, tax_enabled: v.tax_enabled
          };
        } else if (itemMap[key]) {
          const i = itemMap[key];
          itemInfo = {
            item_id: i.id, variant_id: null, item_name: i.name,
            variant_name: null, unit_price: parseFloat(i.base_price),
            item_type: i.item_type, tax_group_id: i.tax_group_id, tax_enabled: i.tax_enabled
          };
        } else {
          unmatchedItemNames.add(name);
          itemInfo = {
            item_id: null, variant_id: null, item_name: name,
            variant_name: null, unit_price: 0, // Will be estimated
            item_type: 'veg', tax_group_id: DEFAULT_TAX_GROUP, tax_enabled: 1,
            isUnmatched: true
          };
        }
        parsedItems.push({ ...itemInfo, quantity: qty });
      }
    }

    const orderNumber = `ORD260408${String(nextSeq).padStart(4, '0')}`;
    nextSeq++;

    ordersToInsert.push({
      excelOrderNo, orderNumber, tableId, tableName, floorId,
      cashierId: floorInfo.cashier_id, customerName, customerPhone,
      orderType: dbOrderType,
      subtotal: myAmount, discountAmount: discount, taxAmount: tax,
      roundOff, deliveryCharge: deliveryChg, containerCharge: containerChg,
      totalAmount: grandTotal,
      paidAmount: isDue ? 0 : grandTotal,
      dueAmount: isDue ? grandTotal : 0,
      paymentStatus: isDue ? 'partial' : 'completed',
      payments, isDue, createdAt, subType,
      items: parsedItems
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 4. REPORT
  // ══════════════════════════════════════════════════════════════
  if (errors.length > 0) {
    console.log('⚠️ VALIDATION ERRORS:');
    errors.forEach(e => console.log(`  ❌ ${e}`));
    console.log('');
  }

  console.log('═'.repeat(100));
  console.log('  ORDERS TO IMPORT');
  console.log('═'.repeat(100));

  let totalSale = 0, totalDiscount = 0, totalTax = 0;
  const byFloor = {}, byPay = {};

  for (const o of ordersToInsert) {
    totalSale += o.totalAmount;
    totalDiscount += o.discountAmount;
    totalTax += o.taxAmount;
    const fn = o.subType;
    if (!byFloor[fn]) byFloor[fn] = { count: 0, amount: 0 };
    byFloor[fn].count++;
    byFloor[fn].amount += o.totalAmount;
    const pm = o.isDue ? 'Due' : (o.payments.length > 1 ? 'Split' : (o.payments[0]?.mode || '?'));
    if (!byPay[pm]) byPay[pm] = { count: 0, amount: 0 };
    byPay[pm].count++;
    byPay[pm].amount += o.totalAmount;
  }

  console.log(`  Total orders: ${ordersToInsert.length}`);
  console.log(`  Total Sale:     Rs ${r2(totalSale)}`);
  console.log(`  Total Discount: Rs ${r2(totalDiscount)}`);
  console.log(`  Total Tax:      Rs ${r2(totalTax)}`);

  console.log('\n  By Floor:');
  for (const [f, d] of Object.entries(byFloor)) {
    console.log(`    ${f.padEnd(15)} ${d.count} orders   Rs ${r2(d.amount)}`);
  }
  console.log('\n  By Payment:');
  for (const [p, d] of Object.entries(byPay)) {
    console.log(`    ${p.padEnd(15)} ${d.count} orders   Rs ${r2(d.amount)}`);
  }

  if (unmatchedItemNames.size > 0) {
    console.log(`\n  ⚠️ Unmatched items (${unmatchedItemNames.size}) — will be created as open items:`);
    [...unmatchedItemNames].sort().forEach(n => console.log(`    - ${n}`));
  }

  console.log('\n  Order list:');
  for (const o of ordersToInsert) {
    const payInfo = o.isDue ? 'DUE' : (o.payments.length > 1 ? 'SPLIT(' + o.payments.map(p => p.mode).join('+') + ')' : (o.payments[0]?.mode || '?'));
    const itemCount = o.items.length;
    console.log(`    ${o.orderNumber} | Excel#${o.excelOrderNo} | ${(o.tableName || 'PICKUP').padEnd(6)} | Rs ${String(o.totalAmount).padStart(6)} | ${payInfo.padEnd(15)} | ${o.paymentStatus.padEnd(9)} | ${o.createdAt} | ${itemCount} items`);
  }

  if (!EXECUTE) {
    console.log('\n' + '═'.repeat(100));
    console.log('  🔍 DRY RUN COMPLETE — No changes made to DB');
    console.log('  To execute: node tests/import-apr8-orders.js --execute');
    console.log('═'.repeat(100));
    await pool.end();
    return;
  }

  // ══════════════════════════════════════════════════════════════
  // 5. EXECUTE IMPORT IN TRANSACTION
  // ══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(100));
  console.log('  ⚡ EXECUTING IMPORT...');
  console.log('═'.repeat(100));

  const conn = await pool.getConnection();
  await conn.beginTransaction();

  try {
    // 5a. Create unmatched items in items table
    const newItemIds = {};
    if (unmatchedItemNames.size > 0) {
      console.log('\n  Creating unmatched items in DB...');
      for (const name of unmatchedItemNames) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const [result] = await conn.query(
          `INSERT INTO items (outlet_id, category_id, name, slug, item_type, base_price, cost_price,
            tax_group_id, tax_enabled, is_available, is_active, is_open_item, service_type, has_variants,
            has_addons, is_customizable, allow_special_notes, display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'non_veg', 0, 0, ?, 1, 1, 1, 1, 'both', 0, 0, 0, 0, 999, NOW(), NOW())`,
          [OUTLET_ID, OPEN_ITEM_CATEGORY, name, slug, DEFAULT_TAX_GROUP]
        );
        newItemIds[name.toLowerCase().trim()] = result.insertId;
        console.log(`    Created item: "${name}" → id=${result.insertId}`);
      }
    }

    // 5b. Insert orders, order_items, payments
    const insertedOrderIds = [];
    const insertedPaymentIds = [];
    const insertedItemIds = [];
    let paySeq = nextPaySeq;

    for (const o of ordersToInsert) {
      const orderUuid = uuid();
      const [orderResult] = await conn.query(
        `INSERT INTO orders (
          uuid, outlet_id, order_number, order_type, source, table_id, floor_id,
          customer_name, customer_phone, guest_count, status,
          subtotal, discount_amount, tax_amount, service_charge, packaging_charge,
          delivery_charge, round_off, total_amount, paid_amount, due_amount,
          adjustment_amount, is_adjustment, payment_status,
          created_by, billed_by, billed_at, created_at, updated_at,
          is_nc, nc_amount, is_interstate, stock_reversed
        ) VALUES (?, ?, ?, ?, 'pos', ?, ?, ?, ?, 1, 'completed',
                  ?, ?, ?, 0, 0, ?, ?, ?, ?, ?,
                  0, 0, ?,
                  ?, ?, ?, ?, ?,
                  0, 0, 0, 0)`,
        [
          orderUuid, OUTLET_ID, o.orderNumber, o.orderType, o.tableId, o.floorId,
          o.customerName, o.customerPhone,
          o.subtotal, o.discountAmount, o.taxAmount,
          o.deliveryCharge, o.roundOff, o.totalAmount, o.paidAmount, o.dueAmount,
          o.paymentStatus,
          o.cashierId, o.cashierId, o.createdAt, o.createdAt, o.createdAt
        ]
      );
      const orderId = orderResult.insertId;
      insertedOrderIds.push(orderId);

      // Insert order_items
      if (o.items.length > 0) {
        // Calculate proportional amounts
        const knownItemsTotal = o.items.reduce((s, it) => {
          if (it.isUnmatched) return s;
          return s + (it.unit_price * it.quantity);
        }, 0);
        const unmatchedCount = o.items.filter(it => it.isUnmatched).length;
        const remainingForUnmatched = o.subtotal - knownItemsTotal;
        const perUnmatchedPrice = unmatchedCount > 0 ? Math.max(0, r2(remainingForUnmatched / unmatchedCount)) : 0;

        // Recalculate total of all items to proportionally distribute tax & discount
        let allItemsSubtotal = 0;
        const itemsWithPrices = o.items.map(it => {
          let price;
          if (it.isUnmatched) {
            const newId = newItemIds[it.item_name.toLowerCase().trim()];
            price = perUnmatchedPrice;
            return { ...it, item_id: newId, unit_price: price, totalPrice: r2(price * it.quantity) };
          } else {
            price = it.unit_price;
            return { ...it, totalPrice: r2(price * it.quantity) };
          }
        });
        allItemsSubtotal = itemsWithPrices.reduce((s, it) => s + it.totalPrice, 0);

        for (const it of itemsWithPrices) {
          const proportion = allItemsSubtotal > 0 ? it.totalPrice / allItemsSubtotal : (1 / itemsWithPrices.length);
          const itemTax = r2(o.taxAmount * proportion);
          const itemDiscount = r2(o.discountAmount * proportion);

          // Tax details JSON
          const halfRate = TAX_RATE / 2;
          const cgst = r2(itemTax / 2);
          const sgst = r2(itemTax - cgst);
          const taxDetails = JSON.stringify([
            { componentId: 1, componentName: `CGST ${halfRate}%`, componentCode: `CGST_${halfRate}`, rate: halfRate, amount: cgst },
            { componentId: 2, componentName: `SGST ${halfRate}%`, componentCode: `SGST_${halfRate}`, rate: halfRate, amount: sgst }
          ]);

          const [itemResult] = await conn.query(
            `INSERT INTO order_items (
              order_id, item_id, variant_id, item_name, variant_name, item_type,
              quantity, unit_price, base_price, discount_amount, tax_amount, total_price,
              tax_group_id, tax_details, status, is_complimentary, created_by,
              created_at, updated_at, is_nc, is_open_item, stock_deducted
            ) VALUES (?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?,
                      ?, ?, 'served', 0, ?,
                      ?, ?, 0, ?, 0)`,
            [
              orderId, it.item_id, it.variant_id, it.item_name, it.variant_name, it.item_type,
              it.quantity, it.unit_price, it.unit_price, itemDiscount, itemTax, it.totalPrice,
              it.tax_group_id || DEFAULT_TAX_GROUP, taxDetails, o.cashierId,
              o.createdAt, o.createdAt, it.isUnmatched ? 1 : 0
            ]
          );
          insertedItemIds.push(itemResult.insertId);
        }
      }

      // Insert payments
      for (const pay of o.payments) {
        const payUuid = uuid();
        const payNumber = `PAY260408${String(paySeq).padStart(4, '0')}`;
        paySeq++;

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
            payUuid, OUTLET_ID, orderId, payNumber, pay.mode,
            pay.amount, pay.amount,
            pay.upiId, o.cashierId,
            o.createdAt, o.createdAt
          ]
        );
        insertedPaymentIds.push(payResult.insertId);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 5c. Create day_sessions (shifts) for Apr 8
    // ══════════════════════════════════════════════════════════════
    console.log('\n  Creating day_sessions for Apr 8...');

    // Calculate per-floor stats
    const barOrders = ordersToInsert.filter(o => o.floorId === 38);
    const restOrders = ordersToInsert.filter(o => o.floorId === 39 || o.floorId === null);

    const barTotal = r2(barOrders.reduce((s, o) => s + o.totalAmount, 0));
    const restTotal = r2(restOrders.reduce((s, o) => s + o.totalAmount, 0));
    const barDisc = r2(barOrders.reduce((s, o) => s + o.discountAmount, 0));
    const restDisc = r2(restOrders.reduce((s, o) => s + o.discountAmount, 0));

    // Find earliest and latest order times per floor
    const barTimes = barOrders.map(o => o.createdAt).sort();
    const restTimes = restOrders.map(o => o.createdAt).sort();

    // Opening: 30 min before first order, Closing: 30 min after last order
    const adjustTime = (t, mins) => {
      const d = new Date(t.replace(' ', 'T'));
      d.setMinutes(d.getMinutes() + mins);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    };

    const shifts = [];
    if (barOrders.length > 0) {
      const barOpen = adjustTime(barTimes[0], -30);
      const barClose = adjustTime(barTimes[barTimes.length - 1], 30);
      // Cash payments for bar
      const barCash = r2(barOrders.reduce((s, o) => {
        return s + o.payments.filter(p => p.mode === 'cash').reduce((ps, p) => ps + p.amount, 0);
      }, 0));
      shifts.push({
        floor_id: 38, cashier_id: 201, session_date: '2026-04-08',
        opening_time: barOpen, closing_time: barClose,
        total_sales: barTotal, total_orders: barOrders.length,
        total_discounts: barDisc, opening_cash: 0, expected_cash: barCash,
        closing_cash: barCash, cash_variance: 0
      });
    }
    if (restOrders.length > 0) {
      const restOpen = adjustTime(restTimes[0], -30);
      const restClose = adjustTime(restTimes[restTimes.length - 1], 30);
      const restCash = r2(restOrders.reduce((s, o) => {
        return s + o.payments.filter(p => p.mode === 'cash').reduce((ps, p) => ps + p.amount, 0);
      }, 0));
      shifts.push({
        floor_id: 39, cashier_id: 205, session_date: '2026-04-08',
        opening_time: restOpen, closing_time: restClose,
        total_sales: restTotal, total_orders: restOrders.length,
        total_discounts: restDisc, opening_cash: 0, expected_cash: restCash,
        closing_cash: restCash, cash_variance: 0
      });
    }

    const insertedShiftIds = [];
    for (const sh of shifts) {
      const [shResult] = await conn.query(
        `INSERT INTO day_sessions (
          outlet_id, floor_id, cashier_id, session_date, opening_time, closing_time,
          opening_cash, closing_cash, expected_cash, cash_variance,
          total_sales, total_orders, total_discounts, total_refunds, total_cancellations,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?,
                  ?, ?, ?, 0, 0,
                  'closed', NOW(), NOW())`,
        [
          OUTLET_ID, sh.floor_id, sh.cashier_id, sh.session_date,
          sh.opening_time, sh.closing_time,
          sh.opening_cash, sh.closing_cash, sh.expected_cash, sh.cash_variance,
          sh.total_sales, sh.total_orders, sh.total_discounts
        ]
      );
      insertedShiftIds.push(shResult.insertId);
      const fl = sh.floor_id === 38 ? 'BAR' : 'REST';
      console.log(`    Shift #${shResult.insertId} | ${fl} | ${sh.cashier_id} | ${sh.opening_time} to ${sh.closing_time} | ${sh.total_orders} orders | Rs ${sh.total_sales}`);
    }

    // ══════════════════════════════════════════════════════════════
    // 5d. VERIFY BEFORE COMMIT
    // ══════════════════════════════════════════════════════════════
    console.log('\n  Verifying...');

    const [verifyOrders] = await conn.query(
      `SELECT COUNT(*) as cnt, SUM(total_amount) as total FROM orders WHERE id IN (${insertedOrderIds.join(',')}) AND status = 'completed'`
    );
    const [verifyPayments] = await conn.query(
      `SELECT COUNT(*) as cnt, SUM(total_amount) as total FROM payments WHERE id IN (${insertedPaymentIds.length > 0 ? insertedPaymentIds.join(',') : '0'}) AND status = 'completed'`
    );
    const [verifyItems] = await conn.query(
      `SELECT COUNT(*) as cnt FROM order_items WHERE id IN (${insertedItemIds.length > 0 ? insertedItemIds.join(',') : '0'})`
    );

    const dbOrderTotal = r2(verifyOrders[0].total);
    const dbOrderCount = parseInt(verifyOrders[0].cnt);
    const expectedTotal = r2(totalSale);
    const expectedPaidTotal = r2(ordersToInsert.filter(o => !o.isDue).reduce((s, o) => s + o.totalAmount, 0));
    const expectedPayCount = ordersToInsert.reduce((s, o) => s + o.payments.length, 0);

    console.log(`    Orders:   ${dbOrderCount} inserted, Rs ${dbOrderTotal} (expected: ${ordersToInsert.length}, Rs ${expectedTotal})`);
    console.log(`    Payments: ${verifyPayments[0].cnt} inserted, Rs ${r2(verifyPayments[0].total)} (expected: ${expectedPayCount}, Rs ${expectedPaidTotal})`);
    console.log(`    Items:    ${verifyItems[0].cnt} order_items inserted`);
    console.log(`    Shifts:   ${insertedShiftIds.length} created [${insertedShiftIds.join(', ')}]`);

    if (dbOrderCount !== ordersToInsert.length) {
      throw new Error(`Order count mismatch: ${dbOrderCount} vs ${ordersToInsert.length}`);
    }
    if (Math.abs(dbOrderTotal - expectedTotal) > 1) {
      throw new Error(`Order total mismatch: Rs ${dbOrderTotal} vs Rs ${expectedTotal}`);
    }

    // Verify shift totals match
    for (const sh of shifts) {
      const floorId = sh.floor_id;
      const [shOrders] = await conn.query(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as total
         FROM orders o LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ? AND o.status = 'completed'
           AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`,
        [OUTLET_ID, sh.opening_time, sh.closing_time, floorId, sh.cashier_id]
      );
      const fl = floorId === 38 ? 'BAR' : 'REST';
      const shTotal = r2(parseFloat(shOrders[0].total));
      if (Math.abs(shTotal - sh.total_sales) > 1) {
        console.log(`    ⚠️ Shift ${fl}: calculated=${shTotal} vs stored=${sh.total_sales}`);
      } else {
        console.log(`    ✅ Shift ${fl}: ${shTotal} matches stored ${sh.total_sales}`);
      }
    }

    // COMMIT
    await conn.commit();
    console.log('\n  ✅ COMMITTED SUCCESSFULLY');
    console.log(`  Order IDs: ${insertedOrderIds[0]} to ${insertedOrderIds[insertedOrderIds.length - 1]}`);
    console.log(`  Payment IDs: ${insertedPaymentIds.length > 0 ? insertedPaymentIds[0] + ' to ' + insertedPaymentIds[insertedPaymentIds.length - 1] : 'none'}`);
    console.log(`  OrderItem IDs: ${insertedItemIds[0]} to ${insertedItemIds[insertedItemIds.length - 1]}`);
    console.log(`  Shift IDs: ${insertedShiftIds.join(', ')}`);

    // POST-IMPORT VERIFICATION
    console.log('\n' + '═'.repeat(100));
    console.log('  POST-IMPORT VERIFICATION');
    console.log('═'.repeat(100));

    const [bdTotals] = await conn.query(
      `SELECT COUNT(*) as cnt, SUM(total_amount) as sale, SUM(discount_amount) as discount, SUM(tax_amount) as tax
       FROM orders WHERE outlet_id = ? AND status = 'completed'
         AND created_at >= '2026-04-08 00:00:00' AND created_at < '2026-04-09 04:00:00'`,
      [OUTLET_ID]
    );
    console.log(`\n  Apr 8 (completed orders):`);
    console.log(`    Orders: ${bdTotals[0].cnt}`);
    console.log(`    Sale: Rs ${r2(bdTotals[0].sale)}`);
    console.log(`    Discount: Rs ${r2(bdTotals[0].discount)}`);
    console.log(`    Tax: Rs ${r2(bdTotals[0].tax)}`);

    const [floorTotals] = await conn.query(
      `SELECT COALESCE(f.name, 'Takeaway') as name, COUNT(*) as cnt, SUM(o.total_amount) as sale
       FROM orders o LEFT JOIN floors f ON o.floor_id = f.id
       WHERE o.outlet_id = ? AND o.status = 'completed'
         AND o.created_at >= '2026-04-08 00:00:00' AND o.created_at < '2026-04-09 04:00:00'
       GROUP BY f.name`,
      [OUTLET_ID]
    );
    console.log('\n  By floor:');
    floorTotals.forEach(f => console.log(`    ${f.name}: ${f.cnt} orders, Rs ${r2(f.sale)}`));

    // Check items count per order
    const [itemCheck] = await conn.query(
      `SELECT o.id, o.order_number, COUNT(oi.id) as item_count
       FROM orders o LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.id IN (${insertedOrderIds.join(',')})
       GROUP BY o.id, o.order_number
       HAVING item_count = 0`
    );
    if (itemCheck.length > 0) {
      console.log(`\n  ⚠️ ${itemCheck.length} orders have NO items:`);
      itemCheck.forEach(o => console.log(`    ${o.order_number}`));
    } else {
      console.log(`\n  ✅ All ${insertedOrderIds.length} orders have items`);
    }

  } catch (err) {
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
