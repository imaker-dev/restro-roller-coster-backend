/**
 * Comprehensive test for Cancel Stock Action (Reversal vs Wastage/Spoilage)
 *
 * Decision logic: TIME-BASED ONLY (configurable window, default 5 min)
 *   - Cancel within window → REVERSE (stock restored to original batches)
 *   - Cancel after window  → WASTAGE/SPOILAGE (stock stays deducted, logged as wastage)
 *   - User can override with stockAction='reverse' or 'wastage'
 *
 * Scenarios tested:
 *   1. Immediate cancel (within window) → auto REVERSE
 *   2. Late cancel (after window) → auto WASTAGE (spoilage)
 *   3. User explicit stockAction='reverse' overrides auto-wastage
 *   4. User explicit stockAction='wastage' overrides auto-reverse
 *   5. Partial cancel (within window) → proportional REVERSE
 *   6. Partial cancel (after window) → proportional WASTAGE
 *   7. Wastage logs created with order reference, type=spoilage, reason=order_cancel
 *   8. Cancel log stores stock_action + stock_action_auto flag
 *   9. Window=0 → always wastage
 *  10. No reason required (optional)
 *  11. Stock unchanged after wastage (no reversal movements)
 *
 * Usage: node scripts/test-cancel-stock-action.js
 */

require('dotenv').config();
const { initializeDatabase, getPool } = require('../src/database');
const { v4: uuidv4 } = require('uuid');

let pool;
let passed = 0, failed = 0;
const failures = [];

function ok(cond, name, detail = '') {
  if (cond) { passed++; console.log('  PASS: ' + name); }
  else { failed++; const m = '  FAIL: ' + name + (detail ? ' -- ' + detail : ''); console.log(m); failures.push(m); }
}

const OUTLET_ID = 43;
const USER_ID = 1;
const ITEM_ID = 1595;

// Helper: generate order number
async function genOrderNumber(conn) {
  const today = new Date();
  const datePrefix = today.toISOString().slice(2, 10).replace(/-/g, '');
  const prefix = `ORD${datePrefix}`;
  const [[maxSeq]] = await conn.query(
    `SELECT MAX(CAST(SUBSTRING(order_number, ?) AS UNSIGNED)) as max_seq
     FROM orders WHERE outlet_id = ? AND order_number LIKE CONCAT(?, '%')`,
    [prefix.length + 1, OUTLET_ID, prefix]
  );
  return `${prefix}${String((maxSeq.max_seq || 0) + 1).padStart(4, '0')}`;
}

// Helper: create order + item + deduct stock in one go
// minutesAgo controls how old the item's created_at is (via SQL INTERVAL)
async function createAndDeduct(minutesAgo = 0, qty = 2) {
  const conn = await pool.getConnection();
  await conn.beginTransaction();

  const orderNumber = await genOrderNumber(conn);
  const [orderResult] = await conn.query(
    `INSERT INTO orders (uuid, outlet_id, order_number, order_type, status, created_by)
     VALUES (?, ?, ?, 'takeaway', 'new', ?)`,
    [uuidv4(), OUTLET_ID, orderNumber, USER_ID]
  );
  const orderId = orderResult.insertId;

  const [oiResult] = await conn.query(
    `INSERT INTO order_items (order_id, item_id, item_name, quantity, unit_price, base_price, total_price, status)
     VALUES (?, ?, 'Test PBM', ?, 165, 165, ?, 'placed')`,
    [orderId, ITEM_ID, qty, 165 * qty]
  );
  const oiId = oiResult.insertId;

  // Backdate created_at using SQL to avoid timezone issues
  if (minutesAgo > 0) {
    await conn.query(
      `UPDATE order_items SET created_at = NOW() - INTERVAL ? MINUTE WHERE id = ?`,
      [minutesAgo, oiId]
    );
  }

  // Deduct stock
  const stockDeductionService = require('../src/services/stockDeduction.service');
  await stockDeductionService.deductForOrderItem(conn, {
    orderId, orderItemId: oiId, itemId: ITEM_ID, variantId: null,
    quantity: qty, outletId: OUTLET_ID, userId: USER_ID
  });

  await conn.commit();
  conn.release();
  return { orderId, oiId };
}

// Helper: get fresh item row (with outlet_id from orders)
async function getItem(oiId) {
  const [[item]] = await pool.query(
    `SELECT oi.*, o.outlet_id FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE oi.id = ?`,
    [oiId]
  );
  return item;
}

// Helper: get stock levels for items used in deduction
async function getStockLevels(oiId) {
  const [movs] = await pool.query(
    `SELECT DISTINCT inventory_item_id FROM inventory_movements
     WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'sale'`, [oiId]
  );
  const levels = {};
  for (const m of movs) {
    const [[ii]] = await pool.query('SELECT current_stock FROM inventory_items WHERE id = ?', [m.inventory_item_id]);
    levels[m.inventory_item_id] = parseFloat(ii.current_stock);
  }
  return levels;
}

// Cleanup helper
async function cleanup(orderIds, itemIds) {
  for (const oiId of itemIds) {
    await pool.query('DELETE FROM wastage_logs WHERE order_item_id = ?', [oiId]);
    await pool.query(`DELETE FROM inventory_movements WHERE reference_type = 'order_item' AND reference_id = ?`, [oiId]);
    await pool.query('DELETE FROM order_item_costs WHERE order_item_id = ?', [oiId]);
  }
  for (const oid of orderIds) {
    await pool.query('DELETE FROM order_cancel_logs WHERE order_id = ?', [oid]);
    await pool.query('DELETE FROM order_items WHERE order_id = ?', [oid]);
    await pool.query('DELETE FROM orders WHERE id = ?', [oid]);
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  Cancel Stock Action: Reversal vs Wastage/Spoilage — Full Test  ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  await initializeDatabase();
  pool = getPool();

  const stockDeductionService = require('../src/services/stockDeduction.service');
  const settingsService = require('../src/services/settings.service');

  // Ensure window = 5 min
  await settingsService.update('cancel_reversal_window_minutes', 5, OUTLET_ID);

  const allOrderIds = [];
  const allItemIds = [];

  // ══════════════════════════════════════════════════════
  // SCENARIO 1: Immediate cancel (within window) → REVERSE
  // ══════════════════════════════════════════════════════
  console.log('══ SCENARIO 1: Immediate cancel (within 5 min window) → REVERSE ══');
  {
    const { orderId, oiId } = await createAndDeduct(0); // just created
    allOrderIds.push(orderId); allItemIds.push(oiId);

    const item = await getItem(oiId);
    const decision = await stockDeductionService.determineCancelStockAction(pool, item, null);
    ok(decision.action === 'reverse', `Auto-decision: ${decision.action}`);
    ok(decision.auto === true, 'Was auto-determined');
    ok(decision.reason.includes('Within'), `Reason: ${decision.reason}`);

    // Get stock before reversal
    const stockBefore = await getStockLevels(oiId);

    // Execute reversal
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await stockDeductionService.reverseForOrderItem(conn, {
      orderItemId: oiId, outletId: OUTLET_ID, userId: USER_ID, reason: 'Test cancel'
    });
    await conn.commit(); conn.release();

    // Verify stock restored
    const stockAfter = await getStockLevels(oiId);
    for (const [id, before] of Object.entries(stockBefore)) {
      ok(stockAfter[id] > before, `Item ${id} stock restored: ${before.toFixed(2)} → ${stockAfter[id].toFixed(2)}`);
    }

    // Verify reversal movements exist
    const [[revCnt]] = await pool.query(
      `SELECT COUNT(*) as cnt FROM inventory_movements
       WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'sale_reversal'`, [oiId]
    );
    ok(revCnt.cnt > 0, `${revCnt.cnt} reversal movements created`);

    // Verify NO wastage logs
    const [[wCnt]] = await pool.query('SELECT COUNT(*) as cnt FROM wastage_logs WHERE order_item_id = ?', [oiId]);
    ok(wCnt.cnt === 0, 'No wastage logs (reversed)');
  }

  // ══════════════════════════════════════════════════════
  // SCENARIO 2: Late cancel (after window) → WASTAGE/SPOILAGE
  // ══════════════════════════════════════════════════════
  console.log('\n══ SCENARIO 2: Late cancel (10 min > 5 min window) → WASTAGE ══');
  {
    const { orderId, oiId } = await createAndDeduct(10); // 10 min ago
    allOrderIds.push(orderId); allItemIds.push(oiId);

    const item = await getItem(oiId);
    const decision = await stockDeductionService.determineCancelStockAction(pool, item, null);
    ok(decision.action === 'wastage', `Auto-decision: ${decision.action}`);
    ok(decision.reason.includes('spoilage'), `Reason: ${decision.reason}`);

    // Get stock before wastage
    const stockBefore = await getStockLevels(oiId);

    // Execute wastage
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const wastResult = await stockDeductionService.recordWastageForCancelledItem(conn, {
      orderItemId: oiId, orderId, outletId: OUTLET_ID, userId: USER_ID,
      reason: 'Late cancel test'
    });
    await conn.commit(); conn.release();

    ok(wastResult !== null, `Wastage result: ${wastResult.wastageCount} ingredients, ₹${wastResult.totalCost}`);

    // Verify stock NOT changed (stays deducted)
    const stockAfter = await getStockLevels(oiId);
    for (const [id, before] of Object.entries(stockBefore)) {
      ok(Math.abs(stockAfter[id] - before) < 0.01,
        `Item ${id} stock unchanged: ${before.toFixed(2)} → ${stockAfter[id].toFixed(2)}`);
    }

    // Verify NO reversal movements
    const [[revCnt]] = await pool.query(
      `SELECT COUNT(*) as cnt FROM inventory_movements
       WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'sale_reversal'`, [oiId]
    );
    ok(revCnt.cnt === 0, 'No reversal movements');

    // Verify wastage_logs
    const [wastLogs] = await pool.query('SELECT * FROM wastage_logs WHERE order_item_id = ?', [oiId]);
    ok(wastLogs.length > 0, `${wastLogs.length} wastage_log entries`);
    ok(wastLogs[0].wastage_type === 'spoilage', `wastage_type = spoilage`);
    ok(wastLogs[0].reason === 'order_cancel', `reason ENUM = order_cancel`);
    ok(wastLogs[0].reason_notes === 'Late cancel test', `reason_notes = "${wastLogs[0].reason_notes}"`);
    ok(wastLogs[0].order_id === orderId, `order_id = ${orderId}`);
    ok(wastLogs[0].order_item_id === oiId, `order_item_id = ${oiId}`);
  }

  // ══════════════════════════════════════════════════════
  // SCENARIO 3: User explicit stockAction='reverse' overrides auto-wastage
  // ══════════════════════════════════════════════════════
  console.log('\n══ SCENARIO 3: User stockAction="reverse" overrides auto-wastage ══');
  {
    const { orderId, oiId } = await createAndDeduct(10); // after window
    allOrderIds.push(orderId); allItemIds.push(oiId);

    const item = await getItem(oiId);

    // Auto would say wastage
    const autoDecision = await stockDeductionService.determineCancelStockAction(pool, item, null);
    ok(autoDecision.action === 'wastage', `Auto would be: ${autoDecision.action}`);

    // User overrides to reverse
    const userDecision = await stockDeductionService.determineCancelStockAction(pool, item, 'reverse');
    ok(userDecision.action === 'reverse', `User override: ${userDecision.action}`);
    ok(userDecision.auto === false, 'Not auto');

    // Execute reversal
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await stockDeductionService.reverseForOrderItem(conn, {
      orderItemId: oiId, outletId: OUTLET_ID, userId: USER_ID, reason: 'User chose reverse'
    });
    await conn.commit(); conn.release();

    const [[revCnt]] = await pool.query(
      `SELECT COUNT(*) as cnt FROM inventory_movements
       WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'sale_reversal'`, [oiId]
    );
    ok(revCnt.cnt > 0, `Reversed: ${revCnt.cnt} movements`);
  }

  // ══════════════════════════════════════════════════════
  // SCENARIO 4: User explicit stockAction='wastage' overrides auto-reverse
  // ══════════════════════════════════════════════════════
  console.log('\n══ SCENARIO 4: User stockAction="wastage" overrides auto-reverse ══');
  {
    const { orderId, oiId } = await createAndDeduct(0); // within window
    allOrderIds.push(orderId); allItemIds.push(oiId);

    const item = await getItem(oiId);

    // Auto would say reverse
    const autoDecision = await stockDeductionService.determineCancelStockAction(pool, item, null);
    ok(autoDecision.action === 'reverse', `Auto would be: ${autoDecision.action}`);

    // User overrides to wastage
    const userDecision = await stockDeductionService.determineCancelStockAction(pool, item, 'wastage');
    ok(userDecision.action === 'wastage', `User override: ${userDecision.action}`);
    ok(userDecision.auto === false, 'Not auto');

    // Execute wastage
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await stockDeductionService.recordWastageForCancelledItem(conn, {
      orderItemId: oiId, orderId, outletId: OUTLET_ID, userId: USER_ID
    });
    await conn.commit(); conn.release();

    const [[wCnt]] = await pool.query('SELECT COUNT(*) as cnt FROM wastage_logs WHERE order_item_id = ?', [oiId]);
    ok(wCnt.cnt > 0, `Wastage recorded: ${wCnt.cnt} logs`);
  }

  // ══════════════════════════════════════════════════════
  // SCENARIO 5: Partial cancel (within window) → proportional REVERSE
  // ══════════════════════════════════════════════════════
  console.log('\n══ SCENARIO 5: Partial cancel within window → proportional REVERSE ══');
  {
    const { orderId, oiId } = await createAndDeduct(0, 4); // 4 qty, just created
    allOrderIds.push(orderId); allItemIds.push(oiId);

    const item = await getItem(oiId);
    const decision = await stockDeductionService.determineCancelStockAction(pool, item, null);
    ok(decision.action === 'reverse', `Auto-decision: ${decision.action}`);

    const stockBefore = await getStockLevels(oiId);

    // Partial reverse: cancel 2 of 4
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const result = await stockDeductionService.partialReverseForOrderItem(conn, {
      orderItemId: oiId, outletId: OUTLET_ID, userId: USER_ID,
      reason: 'Partial cancel test', cancelQuantity: 2, originalQuantity: 4
    });
    await conn.commit(); conn.release();

    ok(result !== null, `Partial reverse result: ratio=${result.ratio}`);
    ok(Math.abs(result.ratio - 0.5) < 0.01, `Ratio is 0.5 (50%)`);

    // Verify partial stock restored (should be ~50% of original deduction)
    const stockAfter = await getStockLevels(oiId);
    for (const [id, before] of Object.entries(stockBefore)) {
      ok(stockAfter[id] > before, `Item ${id} partially restored: ${before.toFixed(2)} → ${stockAfter[id].toFixed(2)}`);
    }

    // Cleanup: reverse remaining
    const conn2 = await pool.getConnection();
    await conn2.beginTransaction();
    await stockDeductionService.partialReverseForOrderItem(conn2, {
      orderItemId: oiId, outletId: OUTLET_ID, userId: USER_ID,
      reason: 'cleanup', cancelQuantity: 2, originalQuantity: 4
    });
    await conn2.commit(); conn2.release();
  }

  // ══════════════════════════════════════════════════════
  // SCENARIO 6: Partial cancel (after window) → proportional WASTAGE
  // ══════════════════════════════════════════════════════
  console.log('\n══ SCENARIO 6: Partial cancel after window → proportional WASTAGE ══');
  {
    const { orderId, oiId } = await createAndDeduct(10, 4); // 4 qty, 10 min ago
    allOrderIds.push(orderId); allItemIds.push(oiId);

    const item = await getItem(oiId);
    const decision = await stockDeductionService.determineCancelStockAction(pool, item, null);
    ok(decision.action === 'wastage', `Auto-decision: ${decision.action}`);

    const stockBefore = await getStockLevels(oiId);

    // Partial wastage: cancel 1 of 4
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const result = await stockDeductionService.recordWastageForPartialCancel(conn, {
      orderItemId: oiId, orderId, outletId: OUTLET_ID, userId: USER_ID,
      reason: 'Partial wastage test', cancelQuantity: 1, originalQuantity: 4
    });
    await conn.commit(); conn.release();

    ok(result !== null, `Partial wastage: ratio=${result.ratio}`);
    ok(Math.abs(result.ratio - 0.25) < 0.01, `Ratio is 0.25 (25%)`);

    // Verify stock NOT changed
    const stockAfter = await getStockLevels(oiId);
    for (const [id, before] of Object.entries(stockBefore)) {
      ok(Math.abs(stockAfter[id] - before) < 0.01,
        `Item ${id} stock unchanged: ${before.toFixed(2)} → ${stockAfter[id].toFixed(2)}`);
    }

    // Verify wastage logs for partial
    const [wastLogs] = await pool.query('SELECT * FROM wastage_logs WHERE order_item_id = ?', [oiId]);
    ok(wastLogs.length > 0, `${wastLogs.length} wastage logs for partial cancel`);
    ok(wastLogs[0].wastage_type === 'spoilage', `wastage_type = spoilage`);

    // Cleanup: reverse remaining stock
    const conn2 = await pool.getConnection();
    await conn2.beginTransaction();
    await stockDeductionService.reverseForOrderItem(conn2, {
      orderItemId: oiId, outletId: OUTLET_ID, userId: USER_ID, reason: 'cleanup'
    });
    await conn2.commit(); conn2.release();
  }

  // ══════════════════════════════════════════════════════
  // SCENARIO 7: Cancel log stores stock_action correctly
  // ══════════════════════════════════════════════════════
  console.log('\n══ SCENARIO 7: Cancel log stores stock_action + auto flag ══');
  {
    const { orderId, oiId } = await createAndDeduct(0);
    allOrderIds.push(orderId); allItemIds.push(oiId);

    const item = await getItem(oiId);
    const decision = await stockDeductionService.determineCancelStockAction(pool, item, null);

    await pool.query(
      `INSERT INTO order_cancel_logs (
        order_id, order_item_id, cancel_type, original_quantity,
        cancelled_quantity, reason_text, stock_action, stock_action_auto, cancelled_by
      ) VALUES (?, ?, 'full_item', 2, 2, 'Test', ?, ?, ?)`,
      [orderId, oiId, decision.action, decision.auto ? 1 : 0, USER_ID]
    );

    const [[log]] = await pool.query(
      'SELECT stock_action, stock_action_auto FROM order_cancel_logs WHERE order_item_id = ? ORDER BY id DESC LIMIT 1', [oiId]
    );
    ok(log.stock_action === decision.action, `Cancel log stock_action = ${log.stock_action}`);
    ok(log.stock_action_auto === (decision.auto ? 1 : 0), `Cancel log auto = ${log.stock_action_auto}`);

    // Reverse for cleanup
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await stockDeductionService.reverseForOrderItem(conn, {
      orderItemId: oiId, outletId: OUTLET_ID, userId: USER_ID, reason: 'cleanup'
    });
    await conn.commit(); conn.release();
  }

  // ══════════════════════════════════════════════════════
  // SCENARIO 8: Window=0 → always wastage (even just created)
  // ══════════════════════════════════════════════════════
  console.log('\n══ SCENARIO 8: Window=0 → always wastage ══');
  {
    await settingsService.update('cancel_reversal_window_minutes', 0, OUTLET_ID);

    const { orderId, oiId } = await createAndDeduct(0);
    allOrderIds.push(orderId); allItemIds.push(oiId);

    const item = await getItem(oiId);
    const decision = await stockDeductionService.determineCancelStockAction(pool, item, null);
    ok(decision.action === 'wastage', `Window=0 → ${decision.action}`);

    // Restore
    await settingsService.update('cancel_reversal_window_minutes', 5, OUTLET_ID);

    // Cleanup
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await stockDeductionService.reverseForOrderItem(conn, {
      orderItemId: oiId, outletId: OUTLET_ID, userId: USER_ID, reason: 'cleanup'
    });
    await conn.commit(); conn.release();
  }

  // ══════════════════════════════════════════════════════
  // SCENARIO 9: No reason required (optional)
  // ══════════════════════════════════════════════════════
  console.log('\n══ SCENARIO 9: Cancel with no reason (optional) ══');
  {
    const { orderId, oiId } = await createAndDeduct(10);
    allOrderIds.push(orderId); allItemIds.push(oiId);

    // Wastage with no reason
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const result = await stockDeductionService.recordWastageForCancelledItem(conn, {
      orderItemId: oiId, orderId, outletId: OUTLET_ID, userId: USER_ID,
      reason: null // no reason
    });
    await conn.commit(); conn.release();

    ok(result !== null, 'Wastage recorded without reason');

    const [[wLog]] = await pool.query(
      'SELECT reason_notes FROM wastage_logs WHERE order_item_id = ? LIMIT 1', [oiId]
    );
    ok(wLog.reason_notes.includes('cancelled'), `Default reason used: "${wLog.reason_notes}"`);
  }

  // ══════════════════════════════════════════════════════
  // SCENARIO 10: Large window (999 min) → always reverse
  // ══════════════════════════════════════════════════════
  console.log('\n══ SCENARIO 10: Window=999 → always reverse ══');
  {
    await settingsService.update('cancel_reversal_window_minutes', 999, OUTLET_ID);

    const { orderId, oiId } = await createAndDeduct(30); // 30 min ago, still within 999
    allOrderIds.push(orderId); allItemIds.push(oiId);

    const item = await getItem(oiId);
    const decision = await stockDeductionService.determineCancelStockAction(pool, item, null);
    ok(decision.action === 'reverse', `Window=999, 30min elapsed → ${decision.action}`);

    // Restore
    await settingsService.update('cancel_reversal_window_minutes', 5, OUTLET_ID);

    // Cleanup
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await stockDeductionService.reverseForOrderItem(conn, {
      orderItemId: oiId, outletId: OUTLET_ID, userId: USER_ID, reason: 'cleanup'
    });
    await conn.commit(); conn.release();
  }

  // ══════════════════════════════════════════════════════
  // CLEANUP
  // ══════════════════════════════════════════════════════
  console.log('\n══ CLEANUP ══');
  await cleanup(allOrderIds, allItemIds);
  console.log(`  Cleaned up ${allOrderIds.length} orders, ${allItemIds.length} items`);

  // ══════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL PASSED: ${passed} passed, ${failed} failed`);
  } else {
    console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
    console.log('\n  FAILURES:');
    failures.forEach(f => console.log(f));
  }
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
