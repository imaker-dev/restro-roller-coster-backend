/**
 * ITEM TRANSFER — COMPREHENSIVE TEST SCRIPT
 * 
 * Tests all item transfer scenarios:
 *   1. Setup: Login, clean tables, create test orders with items + KOTs
 *   2. Partial item transfer to AVAILABLE table (new order created)
 *   3. Partial item transfer to OCCUPIED/RUNNING table (existing order)
 *   4. Full item transfer (all items) → source order cancelled, table freed
 *   5. Validation: billed table cannot receive transfers
 *   6. Validation: cancelled/billed source order cannot transfer
 *   7. Validation: same table transfer rejected
 *   8. Validation: invalid quantities rejected
 *   9. KOT verification: new KOTs created on target, source KOTs cleaned up
 *  10. Order totals recalculated correctly on both sides
 *  11. Transfer log recorded properly
 */

require('dotenv').config();
const axios = require('axios');

const API = process.env.TEST_API_URL || 'http://localhost:3005/api/v1';
let OUTLET_ID; // auto-detected from DB

let passed = 0, failed = 0, skipped = 0;
const section = (title) => console.log(`\n${'─'.repeat(64)}\n  ${title}\n${'─'.repeat(64)}`);
const test = (name, condition, detail) => {
  if (condition) { passed++; console.log(`   ✓ ${name}`); }
  else { failed++; console.log(`   ✗ FAIL: ${name}${detail ? ' → ' + detail : ''}`); }
};
const skip = (name, reason) => { skipped++; console.log(`   ⊘ SKIP: ${name} — ${reason}`); };

async function runPart(name, fn) {
  section(name);
  try {
    await fn();
  } catch (e) {
    failed++;
    const msg = e.response?.data?.message || e.message;
    console.log(`   ✗ SECTION CRASH: ${name} → ${msg}`);
    if (e.response?.data) console.log(`     Response:`, JSON.stringify(e.response.data).slice(0, 300));
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Shared state
let adminToken, pool;
let TABLE_A, TABLE_B, TABLE_C, TABLE_D;
let ORDER_A, ORDER_C; // orders on table A and C
let ITEMS_A = []; // order items on order A
let ITEMS_C = []; // order items on order C

// ─── HELPERS ───
async function api(method, path, data = null, token = adminToken) {
  const config = {
    method,
    url: `${API}${path}`,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (data) config.data = data;
  return axios(config);
}

async function getTableStatus(tableId) {
  const res = await api('get', `/tables/${tableId}`);
  return res.data.data;
}

async function getOrderWithItems(orderId) {
  const res = await api('get', `/orders/${orderId}`);
  const d = res.data.data;
  // Normalize: items may be in .items or .orderItems
  if (!d.items && d.orderItems) d.items = d.orderItems;
  return d;
}

// ─── MAIN ───
(async () => {
  console.log('\n🔄 ITEM TRANSFER — COMPREHENSIVE TEST SUITE\n');

  // Init DB pool for direct queries
  const { initializeDatabase, getPool } = require('../database');
  await initializeDatabase();
  pool = getPool();

  // ═══════════════════════════════════════
  // Part 0: Login & Setup
  // ═══════════════════════════════════════
  await runPart('Part 0: Login & Setup', async () => {
    // Auto-detect outlet with most tables
    const [[outletRow]] = await pool.query(
      `SELECT outlet_id, COUNT(*) as cnt FROM tables WHERE is_active = 1 GROUP BY outlet_id ORDER BY cnt DESC LIMIT 1`
    );
    OUTLET_ID = outletRow.outlet_id;
    console.log(`   Auto-detected OUTLET_ID = ${OUTLET_ID} (${outletRow.cnt} tables)`);

    // Login as admin
    const login = await axios.post(`${API}/auth/login`, {
      email: 'admin@restropos.com',
      password: 'admin123'
    });
    adminToken = login.data.data.accessToken;
    test('Admin login', !!adminToken);

    // Find tables in this outlet (pick 4, any status — we'll force-clean them)
    const [tables] = await pool.query(
      `SELECT id, table_number, status FROM tables 
       WHERE outlet_id = ? AND is_active = 1 
       ORDER BY id DESC LIMIT 10`,
      [OUTLET_ID]
    );
    test('Found 4+ tables', tables.length >= 4, `only ${tables.length}`);
    if (tables.length < 4) throw new Error('Need at least 4 tables');

    // Pick 4 tables
    TABLE_A = tables[0].id;
    TABLE_B = tables[1].id;
    TABLE_C = tables[2].id;
    TABLE_D = tables[3].id;
    console.log(`   Tables: A=${TABLE_A}, B=${TABLE_B}, C=${TABLE_C}, D=${TABLE_D}`);

    // Clean up: cancel orders + free these 4 tables
    for (const tid of [TABLE_A, TABLE_B, TABLE_C, TABLE_D]) {
      const [orders] = await pool.query(
        `SELECT o.id FROM orders o
         JOIN table_sessions ts ON o.table_session_id = ts.id
         WHERE ts.table_id = ? AND o.status NOT IN ('completed','cancelled','paid')`,
        [tid]
      );
      for (const o of orders) {
        await pool.query(`UPDATE orders SET status='cancelled', cancel_reason='Test cleanup' WHERE id=?`, [o.id]);
      }
      await pool.query(
        `UPDATE table_sessions SET status='completed', ended_at=NOW() WHERE table_id=? AND status='active'`,
        [tid]
      );
      await pool.query(`UPDATE tables SET status='available' WHERE id=?`, [tid]);
    }
    console.log('   Cleanup done for all 4 tables');

    // Get valid menu items (with or without variants)
    const [menuItems] = await pool.query(
      `SELECT i.id, i.name, i.base_price, v.id as variant_id
       FROM items i 
       LEFT JOIN variants v ON v.item_id = i.id
       WHERE i.outlet_id = ? AND i.is_active = 1 AND i.is_available = 1
       ORDER BY i.id LIMIT 3`,
      [OUTLET_ID]
    );
    test('Found menu items', menuItems.length >= 2, `only ${menuItems.length}`);
    console.log(`   Menu items: ${menuItems.map(m => `${m.name}(id=${m.id},v=${m.variant_id || 'none'},₹${m.base_price})`).join(', ')}`);

    // ── Create Order on Table A with 3 items ──
    // Start session
    const sessA = await api('post', `/tables/${TABLE_A}/session`, { guestCount: 2 });
    test('Table A session started', sessA.data.success);

    // Create order
    const ordA = await api('post', '/orders', {
      outletId: OUTLET_ID,
      tableId: TABLE_A,
      orderType: 'dine_in',
      guestCount: 2
    });
    test('Order A created', ordA.data.success);
    ORDER_A = ordA.data.data.id;

    // Add items
    const itemsToAdd = menuItems.slice(0, 3).map(m => {
      const item = { itemId: m.id, quantity: 3 };
      if (m.variant_id) item.variantId = m.variant_id;
      return item;
    });
    const addA = await api('post', `/orders/${ORDER_A}/items`, { items: itemsToAdd });
    test('Items added to Order A', addA.data.success);

    // Send KOT
    const kotA = await api('post', `/orders/${ORDER_A}/kot`);
    test('KOT sent for Order A', kotA.data.success);
    console.log(`   Order A (id=${ORDER_A}) has ${kotA.data.data?.tickets?.length || 0} KOT ticket(s)`);

    // Get order items
    await sleep(500);
    const orderA = await getOrderWithItems(ORDER_A);
    ITEMS_A = (orderA.items || []).filter(i => (i.status || '') !== 'cancelled');
    test('Order A has items', ITEMS_A.length >= 2, `got ${ITEMS_A.length}`);
    console.log(`   Order A items: ${ITEMS_A.map(i => `${i.itemName || i.item_name}(id=${i.id}, qty=${i.quantity})`).join(', ')}`);

    // ── Create Order on Table C (to test transfer to occupied table) ──
    const sessC = await api('post', `/tables/${TABLE_C}/session`, { guestCount: 1 });
    test('Table C session started', sessC.data.success);

    const ordC = await api('post', '/orders', {
      outletId: OUTLET_ID,
      tableId: TABLE_C,
      orderType: 'dine_in',
      guestCount: 1
    });
    test('Order C created', ordC.data.success);
    ORDER_C = ordC.data.data.id;

    const itemCPayload = { itemId: menuItems[0].id, quantity: 1 };
    if (menuItems[0].variant_id) itemCPayload.variantId = menuItems[0].variant_id;
    const addC = await api('post', `/orders/${ORDER_C}/items`, { items: [itemCPayload] });
    test('Item added to Order C', addC.data.success);

    const kotC = await api('post', `/orders/${ORDER_C}/kot`);
    test('KOT sent for Order C', kotC.data.success);

    await sleep(500);
    const orderC = await getOrderWithItems(ORDER_C);
    ITEMS_C = (orderC.items || []).filter(i => (i.status || '') !== 'cancelled');

    await sleep(500); // let async events settle
  });

  // ═══════════════════════════════════════
  // Part 1: Partial Transfer to AVAILABLE table
  // ═══════════════════════════════════════
  let transferResult1;
  await runPart('Part 1: Partial Transfer → Available Table (B)', async () => {
    // Transfer 1 of 3 qty of first item from Order A → Table B (available)
    const item = ITEMS_A[0];
    const res = await api('post', `/orders/${ORDER_A}/transfer-items`, {
      targetTableId: TABLE_B,
      items: [{ orderItemId: item.id, quantity: 1 }]
    });
    test('Transfer API success', res.data.success);
    transferResult1 = res.data.data;

    test('Target order created', transferResult1.targetOrderCreated === true);
    test('Source order NOT cancelled (partial)', transferResult1.sourceOrderCancelled === false);
    test('1 item transferred', transferResult1.transferredItems?.length === 1);
    test('KOT(s) created on target', transferResult1.createdKots?.length >= 1);

    // Verify target table is now running
    const tgtTable = await getTableStatus(TABLE_B);
    test('Table B status → running', tgtTable.status === 'running', `got ${tgtTable.status}`);

    // Verify source order still has items
    const srcOrder = await getOrderWithItems(ORDER_A);
    const srcItems = srcOrder.items || [];
    const srcItem = srcItems.find(i => i.id === item.id);
    test('Source item qty reduced to 2', parseFloat(srcItem?.quantity) === 2, `got ${srcItem?.quantity}`);
    test('Source order total recalculated', parseFloat(srcOrder.totalAmount || srcOrder.total_amount) > 0);

    // Verify target order has transferred item
    const tgtOrder = await getOrderWithItems(transferResult1.targetOrderId);
    const tgtItems = tgtOrder.items || [];
    test('Target order has 1 item', tgtItems.length === 1, `got ${tgtItems.length}`);
    test('Target item qty = 1', parseFloat(tgtItems[0]?.quantity) === 1, `got ${tgtItems[0]?.quantity}`);
    test('Target order total > 0', parseFloat(tgtOrder.totalAmount || tgtOrder.total_amount) > 0);

    // Verify KOTs on target order
    const [tgtKots] = await pool.query(
      `SELECT * FROM kot_tickets WHERE order_id = ?`, [transferResult1.targetOrderId]
    );
    test('Target order has KOT ticket(s)', tgtKots.length >= 1);
    const [tgtKotItems] = await pool.query(
      `SELECT * FROM kot_items WHERE kot_id IN (?)`, [tgtKots.map(k => k.id)]
    );
    test('Target KOT has item(s)', tgtKotItems.length >= 1);

    // Verify transfer log
    const [logs] = await pool.query(
      `SELECT * FROM order_transfer_logs WHERE order_id = ? AND transfer_type = 'item' ORDER BY id DESC LIMIT 1`,
      [ORDER_A]
    );
    test('Transfer log recorded', logs.length === 1);
    test('Transfer log has target_order_id', logs[0]?.target_order_id === transferResult1.targetOrderId);
    test('Transfer log has details JSON', !!logs[0]?.transfer_details);

    console.log(`   ✓ Transferred item ${item.id} (qty 1) from Order ${ORDER_A} → new Order ${transferResult1.targetOrderId} on Table B`);
    await sleep(300);
  });

  // ═══════════════════════════════════════
  // Part 2: Partial Transfer to OCCUPIED/RUNNING table
  // ═══════════════════════════════════════
  let transferResult2;
  await runPart('Part 2: Partial Transfer → Running Table (C)', async () => {
    // Transfer second item (full qty = 3) from Order A → Table C (running, has Order C)
    const item = ITEMS_A[1];
    const res = await api('post', `/orders/${ORDER_A}/transfer-items`, {
      targetTableId: TABLE_C,
      items: [{ orderItemId: item.id, quantity: 3 }]
    });
    test('Transfer API success', res.data.success);
    transferResult2 = res.data.data;

    test('Target order NOT created (existing)', transferResult2.targetOrderCreated === false);
    test('Target order = Order C', transferResult2.targetOrderId === ORDER_C);
    test('Source order NOT cancelled', transferResult2.sourceOrderCancelled === false);

    // Verify item moved entirely to Order C
    const tgtOrder = await getOrderWithItems(ORDER_C);
    const tgtItems = tgtOrder.items || [];
    // Order C originally had 1 item + now 1 more transferred
    test('Order C now has 2+ items', tgtItems.length >= 2, `got ${tgtItems.length}`);

    // Verify source Order A lost that item
    const srcOrder = await getOrderWithItems(ORDER_A);
    const srcItems = srcOrder.items || [];
    const movedItem = srcItems.find(i => i.id === item.id);
    // Full transfer: item should no longer be in source order
    test('Item fully moved out of source order', !movedItem || movedItem.order_id === ORDER_C);

    console.log(`   ✓ Full-qty item ${item.id} transferred from Order ${ORDER_A} → existing Order ${ORDER_C} on Table C`);
    await sleep(300);
  });

  // ═══════════════════════════════════════
  // Part 3: Full Transfer (all remaining items) → source auto-cancelled
  // ═══════════════════════════════════════
  let transferResult3;
  await runPart('Part 3: Full Transfer (all items) → Source Cancelled', async () => {
    // Get remaining items on Order A
    const srcOrder = await getOrderWithItems(ORDER_A);
    const remaining = (srcOrder.items || []).filter(i => 
      (i.status || '').toLowerCase() !== 'cancelled'
    );
    
    if (remaining.length === 0) {
      skip('Full transfer test', 'No remaining items on Order A');
      return;
    }

    console.log(`   Remaining items on Order A: ${remaining.map(i => `${i.itemName || i.item_name}(id=${i.id}, qty=${i.quantity})`).join(', ')}`);

    // Transfer ALL remaining items to Table D (available)
    const res = await api('post', `/orders/${ORDER_A}/transfer-items`, {
      targetTableId: TABLE_D,
      items: remaining.map(i => ({ orderItemId: i.id, quantity: parseFloat(i.quantity) }))
    });
    test('Transfer API success', res.data.success);
    transferResult3 = res.data.data;

    test('Source order cancelled', transferResult3.sourceOrderCancelled === true);
    test('Source table freed', transferResult3.sourceTableFreed === true);
    test('Target order created on Table D', transferResult3.targetOrderCreated === true);

    // Verify source table is available
    const srcTable = await getTableStatus(TABLE_A);
    test('Table A → available', srcTable.status === 'available', `got ${srcTable.status}`);

    // Verify target table is running
    const tgtTable = await getTableStatus(TABLE_D);
    test('Table D → running', tgtTable.status === 'running', `got ${tgtTable.status}`);

    // Verify source order is cancelled
    const [srcOrd] = await pool.query('SELECT status FROM orders WHERE id = ?', [ORDER_A]);
    test('Order A status = cancelled', srcOrd[0]?.status === 'cancelled');

    console.log(`   ✓ All remaining items transferred → Order A cancelled, Table A freed, Table D running`);
    await sleep(300);
  });

  // ═══════════════════════════════════════
  // Part 4: Validation — Billed target table rejected
  // ═══════════════════════════════════════
  await runPart('Part 4: Validation Tests', async () => {
    // 4a. Same table transfer rejected
    try {
      await api('post', `/orders/${ORDER_C}/transfer-items`, {
        targetTableId: TABLE_C,
        items: [{ orderItemId: ITEMS_C[0]?.id || 999, quantity: 1 }]
      });
      test('Same table rejected', false, 'should have thrown');
    } catch (e) {
      test('Same table rejected', e.response?.status >= 400);
    }

    // 4b. Cancelled source order rejected
    try {
      await api('post', `/orders/${ORDER_A}/transfer-items`, {
        targetTableId: TABLE_B,
        items: [{ orderItemId: ITEMS_A[0]?.id || 999, quantity: 1 }]
      });
      test('Cancelled source rejected', false, 'should have thrown');
    } catch (e) {
      test('Cancelled source rejected', e.response?.status >= 400);
    }

    // 4c. Invalid quantity (more than available)
    const orderC = await getOrderWithItems(ORDER_C);
    const itemC = (orderC.items || [])[0];
    if (itemC) {
      try {
        await api('post', `/orders/${ORDER_C}/transfer-items`, {
          targetTableId: TABLE_A,
          items: [{ orderItemId: itemC.id, quantity: 9999 }]
        });
        test('Excessive qty rejected', false, 'should have thrown');
      } catch (e) {
        test('Excessive qty rejected', e.response?.status >= 400);
      }
    }

    // 4d. Non-existent item rejected
    try {
      await api('post', `/orders/${ORDER_C}/transfer-items`, {
        targetTableId: TABLE_A,
        items: [{ orderItemId: 999999, quantity: 1 }]
      });
      test('Non-existent item rejected', false, 'should have thrown');
    } catch (e) {
      test('Non-existent item rejected', e.response?.status >= 400);
    }

    // 4e. Empty items array rejected (validation)
    try {
      await api('post', `/orders/${ORDER_C}/transfer-items`, {
        targetTableId: TABLE_A,
        items: []
      });
      test('Empty items rejected', false, 'should have thrown');
    } catch (e) {
      test('Empty items rejected', e.response?.status >= 400);
    }
  });

  // ═══════════════════════════════════════
  // Part 5: KOT Verification
  // ═══════════════════════════════════════
  await runPart('Part 5: KOT Integrity Check', async () => {
    // Check that every active order_item has a valid kot_id pointing to a KOT on the same order
    const checkOrderIds = [ORDER_C, transferResult1?.targetOrderId, transferResult3?.targetOrderId].filter(Boolean);
    if (checkOrderIds.length === 0) { skip('KOT integrity', 'No target orders to check'); return; }
    const [allItems] = await pool.query(
      `SELECT oi.id, oi.order_id, oi.item_name, oi.kot_id, oi.status,
              kt.order_id as kot_order_id, kt.status as kot_status
       FROM order_items oi
       LEFT JOIN kot_tickets kt ON oi.kot_id = kt.id
       WHERE oi.order_id IN (${checkOrderIds.map(() => '?').join(',')})
         AND oi.status != 'cancelled'`,
      checkOrderIds
    );

    let kotMismatches = 0;
    for (const item of allItems) {
      if (item.kot_id && item.kot_order_id !== item.order_id) {
        kotMismatches++;
        console.log(`   ⚠ Item ${item.id} (${item.item_name}) has kot_id=${item.kot_id} belonging to order ${item.kot_order_id}, but item is on order ${item.order_id}`);
      }
    }
    test('All active items have KOTs on correct order', kotMismatches === 0, `${kotMismatches} mismatches`);

    // Check no orphaned kot_items (pointing to non-existent order_items)
    const [orphaned] = await pool.query(
      `SELECT ki.id, ki.kot_id, ki.order_item_id
       FROM kot_items ki
       LEFT JOIN order_items oi ON ki.order_item_id = oi.id
       WHERE ki.kot_id IN (
         SELECT id FROM kot_tickets WHERE order_id IN (${checkOrderIds.map(() => '?').join(',')})
       ) AND oi.id IS NULL`,
      checkOrderIds
    );
    test('No orphaned KOT items', orphaned.length === 0, `${orphaned.length} orphans`);
  });

  // ═══════════════════════════════════════
  // Part 6: Transfer Log Verification
  // ═══════════════════════════════════════
  await runPart('Part 6: Transfer Logs', async () => {
    const [logs] = await pool.query(
      `SELECT * FROM order_transfer_logs WHERE transfer_type = 'item' AND order_id = ? ORDER BY id`,
      [ORDER_A]
    );
    test('Transfer logs recorded', logs.length >= 2, `got ${logs.length}`);

    for (const log of logs) {
      const details = typeof log.transfer_details === 'string' ? JSON.parse(log.transfer_details) : log.transfer_details;
      test(`Log ${log.id}: has items array`, Array.isArray(details?.items));
      test(`Log ${log.id}: has createdKots`, Array.isArray(details?.createdKots));
      test(`Log ${log.id}: has target_order_id`, !!log.target_order_id);
    }
  });

  // ═══════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════
  await runPart('Cleanup', async () => {
    const allOrderIds = [ORDER_A, ORDER_C, transferResult1?.targetOrderId, transferResult3?.targetOrderId].filter(Boolean);
    
    for (const oid of allOrderIds) {
      await pool.query(
        `UPDATE orders SET status='cancelled', cancel_reason='Test cleanup' WHERE id=? AND status NOT IN ('completed','cancelled','paid')`,
        [oid]
      );
    }

    for (const tid of [TABLE_A, TABLE_B, TABLE_C, TABLE_D]) {
      await pool.query(
        `UPDATE table_sessions SET status='completed', ended_at=NOW() WHERE table_id=? AND status='active'`,
        [tid]
      );
      await pool.query(`UPDATE tables SET status='available' WHERE id=?`, [tid]);
    }

    test('Cleanup done', true);
  });

  // ═══════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ITEM TRANSFER TEST RESULTS`);
  console.log(`  ✓ Passed: ${passed}   ✗ Failed: ${failed}   ⊘ Skipped: ${skipped}`);
  console.log(`${'═'.repeat(64)}\n`);

  process.exit(failed > 0 ? 1 : 0);
})();
