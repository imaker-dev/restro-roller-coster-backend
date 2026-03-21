/**
 * Stock Deduction Service — Module 9
 * 
 * Deducts inventory stock when order items are added.
 * Reverses stock when order items or full orders are cancelled.
 * 
 * Flow:
 *   1. Order item added → load recipe → calculate ingredient qty × order qty
 *   2. Convert to base units → apply wastage/yield
 *   3. FIFO batch deduction (with FOR UPDATE lock) → record 1 movement PER batch (type: 'sale')
 *   4. Update inventory_items.current_stock (negative stock allowed)
 *   5. Mark order_item.stock_deducted = 1
 * 
 * Cancel Flow:
 *   1. Load sale movements for that order item (each has specific batch_id)
 *   2. Restore qty to SAME original batch → record reversal movements (type: 'sale_reversal')
 *   3. Update inventory_items.current_stock
 * 
 * Key Design Decisions:
 *   - 1 movement per batch deducted (not 1 per ingredient) → enables exact reversal
 *   - Reversal restores to SAME batch (no new REV- batches created)
 *   - FOR UPDATE on both inventory_items AND batches → prevents concurrency races
 *   - Negative stock allowed → orders are never blocked by insufficient stock
 * 
 * Golden Rule: ALL stock changes go through inventory_movements
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');
const inventoryService = require('./inventory.service');

const stockDeductionService = {

  /**
   * Deduct stock for a single order item (called inside transaction)
   * @param {object} connection - MySQL transaction connection
   * @param {object} params - { orderId, orderItemId, itemId, variantId, quantity, outletId, userId }
   * @returns {object|null} - deduction summary or null if no recipe
   */
  async deductForOrderItem(connection, { orderId, orderItemId, itemId, variantId, quantity, outletId, userId }) {
    try {
      // Check if auto_deduct_stock is enabled (default: enabled)
      try {
        const [[setting]] = await connection.query(
          "SELECT `value` FROM outlet_settings WHERE outlet_id = ? AND `key` = 'auto_deduct_stock'",
          [outletId]
        );
        if (setting && setting.value === 'false') {
          return null; // Stock deduction disabled
        }
      } catch (settingErr) {
        // Table may not exist yet — default to stock deduction enabled
        logger.debug('outlet_settings not available, defaulting to auto_deduct_stock=true');
      }

      // Find current recipe for this menu item / variant
      let recipeQuery, recipeParams;
      if (variantId) {
        recipeQuery = 'SELECT id FROM recipes WHERE menu_item_id = ? AND variant_id = ? AND is_current = 1 AND is_active = 1';
        recipeParams = [itemId, variantId];
      } else {
        recipeQuery = 'SELECT id FROM recipes WHERE menu_item_id = ? AND variant_id IS NULL AND is_current = 1 AND is_active = 1';
        recipeParams = [itemId];
      }

      const [[recipe]] = await connection.query(recipeQuery, recipeParams);
      if (!recipe) return null; // No recipe linked — skip deduction

      // Get recipe ingredients with inventory + unit info
      const [ingredients] = await connection.query(
        `SELECT ri.*, ing.name as ingredient_name, ing.yield_percentage, ing.wastage_percentage,
          ing.inventory_item_id,
          ii.current_stock, ii.average_price,
          ru.conversion_factor as recipe_unit_cf
         FROM recipe_ingredients ri
         JOIN ingredients ing ON ri.ingredient_id = ing.id
         JOIN inventory_items ii ON ing.inventory_item_id = ii.id
         LEFT JOIN units ru ON ri.unit_id = ru.id
         WHERE ri.recipe_id = ?`,
        [recipe.id]
      );

      if (ingredients.length === 0) return null;

      const deductions = [];
      let totalCostDeducted = 0;

      for (const ing of ingredients) {
        const recipeQty = parseFloat(ing.quantity) || 0;
        const recipeUnitCf = parseFloat(ing.recipe_unit_cf) || 1;

        // Convert to system base units (gram/ml/pcs)
        const qtyInBasePerPortion = recipeQty * recipeUnitCf;

        // Apply wastage + yield
        const wastage = parseFloat(ing.wastage_percentage) || 0;
        const yieldPct = parseFloat(ing.yield_percentage) || 100;
        const effectiveQtyPerPortion = qtyInBasePerPortion * (1 + wastage / 100) * (100 / yieldPct);

        // Multiply by order quantity
        const totalEffectiveQty = effectiveQtyPerPortion * quantity;

        const inventoryItemId = ing.inventory_item_id;

        // Lock inventory item for stock update (concurrency safe)
        const [[item]] = await connection.query(
          'SELECT current_stock, average_price FROM inventory_items WHERE id = ? FOR UPDATE',
          [inventoryItemId]
        );
        if (!item) {
          logger.warn(`Stock deduction: inventory item ${inventoryItemId} not found, skipping`);
          continue;
        }

        const currentStock = parseFloat(item.current_stock) || 0;
        const balanceBefore = currentStock;
        // Allow negative stock — never block the order
        const balanceAfter = currentStock - totalEffectiveQty;

        // FIFO batch deduction (with FOR UPDATE lock on batches)
        const batchDeductionDetails = await this._deductFromBatchesFIFO(
          connection, inventoryItemId, totalEffectiveQty
        );

        // Update inventory item stock (may go negative — that's OK)
        await connection.query(
          'UPDATE inventory_items SET current_stock = ? WHERE id = ?',
          [balanceAfter, inventoryItemId]
        );

        // Calculate cost from batch deduction (FIFO cost)
        const deductionCost = batchDeductionDetails.totalCost;
        totalCostDeducted += deductionCost;

        // Record ONE movement PER batch deducted (enables exact reversal to same batch)
        let runningBalance = balanceBefore;
        for (const bd of batchDeductionDetails.batches) {
          const batchBalanceBefore = runningBalance;
          runningBalance -= bd.qtyDeducted;
          await connection.query(
            `INSERT INTO inventory_movements (
              outlet_id, inventory_item_id, inventory_batch_id, movement_type,
              quantity, quantity_in_base, unit_cost, total_cost,
              balance_before, balance_after, reference_type, reference_id, notes, created_by
            ) VALUES (?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, 'order_item', ?, ?, ?)`,
            [outletId, inventoryItemId, bd.batchId,
             -bd.qtyDeducted, -bd.qtyDeducted, bd.pricePerUnit, bd.cost,
             batchBalanceBefore, runningBalance, orderItemId,
             `Order #${orderId}, ${ing.ingredient_name}: ${bd.qtyDeducted.toFixed(4)} from batch #${bd.batchId}`,
             userId]
          );
        }

        // If there was unbatched quantity (stock went negative beyond batches), record it too
        if (batchDeductionDetails.unbatchedQty > 0) {
          const avgPrice = parseFloat(item.average_price) || 0;
          const unbatchedCost = parseFloat((batchDeductionDetails.unbatchedQty * avgPrice).toFixed(2));
          const ubBalanceBefore = runningBalance;
          runningBalance -= batchDeductionDetails.unbatchedQty;
          await connection.query(
            `INSERT INTO inventory_movements (
              outlet_id, inventory_item_id, inventory_batch_id, movement_type,
              quantity, quantity_in_base, unit_cost, total_cost,
              balance_before, balance_after, reference_type, reference_id, notes, created_by
            ) VALUES (?, ?, NULL, 'sale', ?, ?, ?, ?, ?, ?, 'order_item', ?, ?, ?)`,
            [outletId, inventoryItemId,
             -batchDeductionDetails.unbatchedQty, -batchDeductionDetails.unbatchedQty,
             avgPrice, unbatchedCost,
             ubBalanceBefore, runningBalance, orderItemId,
             `Order #${orderId}, ${ing.ingredient_name}: ${batchDeductionDetails.unbatchedQty.toFixed(4)} (no batch, negative stock)`,
             userId]
          );
        }

        deductions.push({
          inventoryItemId,
          ingredientName: ing.ingredient_name,
          qtyDeducted: parseFloat(totalEffectiveQty.toFixed(4)),
          cost: parseFloat(deductionCost.toFixed(2)),
          batchDetails: batchDeductionDetails.batches,
          balanceBefore: parseFloat(balanceBefore.toFixed(4)),
          balanceAfter: parseFloat(balanceAfter.toFixed(4))
        });
      }

      // Mark order item as stock_deducted
      await connection.query(
        'UPDATE order_items SET stock_deducted = 1 WHERE id = ?',
        [orderItemId]
      );

      logger.info(`Stock deducted for order_item ${orderItemId}: ${deductions.length} ingredients, cost ₹${totalCostDeducted.toFixed(2)}`);

      return {
        orderItemId,
        recipeId: recipe.id,
        ingredientCount: deductions.length,
        totalCostDeducted: parseFloat(totalCostDeducted.toFixed(2)),
        deductions
      };
    } catch (error) {
      logger.error(`Stock deduction failed for order_item ${orderItemId}:`, error);
      // Stock deduction failure should not block order
      return null;
    }
  },

  /**
   * Reverse stock deduction for a single order item (on full cancel)
   * Uses NET remaining (sale - previous reversals) so full cancel after partial cancels is safe
   * Restores stock to the SAME original batches — no new batches created
   * @param {object} connection - MySQL transaction connection
   * @param {object} params - { orderItemId, outletId, userId, reason }
   */
  async reverseForOrderItem(connection, { orderItemId, outletId, userId, reason }) {
    try {
      // Get NET remaining deduction per (inventory_item, batch) accounting for previous partial reversals
      const [netMovements] = await connection.query(
        `SELECT inventory_item_id, inventory_batch_id,
                SUM(CASE WHEN movement_type = 'sale' THEN ABS(quantity) ELSE 0 END) as total_deducted,
                SUM(CASE WHEN movement_type = 'sale_reversal' THEN ABS(quantity) ELSE 0 END) as total_reversed,
                AVG(CASE WHEN movement_type = 'sale' THEN ABS(unit_cost) ELSE NULL END) as unit_cost
         FROM inventory_movements
         WHERE reference_type = 'order_item' AND reference_id = ?
           AND movement_type IN ('sale', 'sale_reversal')
         GROUP BY inventory_item_id, inventory_batch_id`,
        [orderItemId]
      );

      if (netMovements.length === 0) return null; // No stock was deducted

      // Group movements by inventory_item_id for stock update
      const itemRestorations = {}; // { inventoryItemId: totalQtyRestored }

      for (const mov of netMovements) {
        const inventoryItemId = mov.inventory_item_id;
        const batchId = mov.inventory_batch_id; // the ORIGINAL batch
        const qtyToRestore = parseFloat(mov.total_deducted) - parseFloat(mov.total_reversed);

        if (qtyToRestore <= 0) continue; // Already fully reversed by previous partial cancels

        const unitCost = parseFloat(mov.unit_cost) || 0;
        const totalCost = parseFloat((qtyToRestore * unitCost).toFixed(2));

        // Restore to the SAME original batch (if it exists)
        if (batchId) {
          await connection.query(
            `UPDATE inventory_batches SET remaining_quantity = remaining_quantity + ?,
             is_active = 1 WHERE id = ?`,
            [qtyToRestore, batchId]
          );
        }
        // If batchId is NULL (unbatched/negative stock deduction), no batch to restore to — just restore stock

        // Lock and get current stock for this inventory item
        if (!itemRestorations[inventoryItemId]) {
          const [[item]] = await connection.query(
            'SELECT current_stock, average_price FROM inventory_items WHERE id = ? FOR UPDATE',
            [inventoryItemId]
          );
          if (!item) continue;
          itemRestorations[inventoryItemId] = {
            currentStock: parseFloat(item.current_stock) || 0,
            avgPrice: parseFloat(item.average_price) || 0,
            totalRestored: 0,
            balanceBefore: parseFloat(item.current_stock) || 0
          };
        }

        const ir = itemRestorations[inventoryItemId];
        const balanceBefore = ir.currentStock + ir.totalRestored;
        const balanceAfter = balanceBefore + qtyToRestore;
        ir.totalRestored += qtyToRestore;

        // Record reversal movement pointing to the SAME batch
        await connection.query(
          `INSERT INTO inventory_movements (
            outlet_id, inventory_item_id, inventory_batch_id, movement_type,
            quantity, quantity_in_base, unit_cost, total_cost,
            balance_before, balance_after, reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, ?, 'sale_reversal', ?, ?, ?, ?, ?, ?, 'order_item', ?, ?, ?)`,
          [outletId, inventoryItemId, batchId,
           qtyToRestore, qtyToRestore, unitCost, totalCost,
           balanceBefore, balanceAfter, orderItemId,
           `Cancel reversal: ${reason || 'Order item cancelled'}`,
           userId]
        );
      }

      // Update inventory_items stock for each affected item
      const restorations = [];
      for (const [inventoryItemId, ir] of Object.entries(itemRestorations)) {
        const newStock = ir.currentStock + ir.totalRestored;
        await connection.query(
          'UPDATE inventory_items SET current_stock = ? WHERE id = ?',
          [newStock, inventoryItemId]
        );

        restorations.push({
          inventoryItemId: parseInt(inventoryItemId),
          qtyRestored: parseFloat(ir.totalRestored.toFixed(4)),
          balanceBefore: parseFloat(ir.balanceBefore.toFixed(4)),
          balanceAfter: parseFloat(newStock.toFixed(4))
        });
      }

      // Reset stock_deducted flag
      await connection.query(
        'UPDATE order_items SET stock_deducted = 0 WHERE id = ?',
        [orderItemId]
      );

      logger.info(`Stock reversed for order_item ${orderItemId}: ${restorations.length} items restored (net-based)`);

      return {
        orderItemId,
        restoredCount: restorations.length,
        restorations
      };
    } catch (error) {
      logger.error(`Stock reversal failed for order_item ${orderItemId}:`, error);
      return null;
    }
  },

  /**
   * Partial reverse: restore stock proportional to cancelled quantity
   * Uses NET remaining deduction (sale - previous reversals) to handle repeated partial cancels correctly
   * @param {object} connection - MySQL transaction connection
   * @param {object} params - { orderItemId, outletId, userId, reason, cancelQuantity, originalQuantity }
   */
  async partialReverseForOrderItem(connection, { orderItemId, outletId, userId, reason, cancelQuantity, originalQuantity }) {
    try {
      if (!cancelQuantity || !originalQuantity || cancelQuantity <= 0) return null;
      const ratio = cancelQuantity / originalQuantity;

      // Get NET remaining deduction per (inventory_item, batch) accounting for previous reversals
      const [netMovements] = await connection.query(
        `SELECT inventory_item_id, inventory_batch_id,
                SUM(CASE WHEN movement_type = 'sale' THEN ABS(quantity) ELSE 0 END) as total_deducted,
                SUM(CASE WHEN movement_type = 'sale_reversal' THEN ABS(quantity) ELSE 0 END) as total_reversed,
                AVG(CASE WHEN movement_type = 'sale' THEN ABS(unit_cost) ELSE NULL END) as unit_cost
         FROM inventory_movements
         WHERE reference_type = 'order_item' AND reference_id = ?
           AND movement_type IN ('sale', 'sale_reversal')
         GROUP BY inventory_item_id, inventory_batch_id`,
        [orderItemId]
      );

      if (netMovements.length === 0) return null;

      const itemRestorations = {};

      for (const mov of netMovements) {
        const inventoryItemId = mov.inventory_item_id;
        const batchId = mov.inventory_batch_id;
        const netRemaining = parseFloat(mov.total_deducted) - parseFloat(mov.total_reversed);

        if (netRemaining <= 0) continue; // Already fully reversed by previous partial cancels

        const qtyToRestore = parseFloat((netRemaining * ratio).toFixed(4));
        if (qtyToRestore <= 0) continue;

        const unitCost = parseFloat(mov.unit_cost) || 0;
        const totalCost = parseFloat((qtyToRestore * unitCost).toFixed(2));

        // Restore proportional qty to the SAME original batch
        if (batchId) {
          await connection.query(
            `UPDATE inventory_batches SET remaining_quantity = remaining_quantity + ?,
             is_active = 1 WHERE id = ?`,
            [qtyToRestore, batchId]
          );
        }

        if (!itemRestorations[inventoryItemId]) {
          const [[item]] = await connection.query(
            'SELECT current_stock, average_price FROM inventory_items WHERE id = ? FOR UPDATE',
            [inventoryItemId]
          );
          if (!item) continue;
          itemRestorations[inventoryItemId] = {
            currentStock: parseFloat(item.current_stock) || 0,
            totalRestored: 0,
            balanceBefore: parseFloat(item.current_stock) || 0
          };
        }

        const ir = itemRestorations[inventoryItemId];
        const balanceBefore = ir.currentStock + ir.totalRestored;
        const balanceAfter = balanceBefore + qtyToRestore;
        ir.totalRestored += qtyToRestore;

        // Record partial reversal movement pointing to SAME batch
        await connection.query(
          `INSERT INTO inventory_movements (
            outlet_id, inventory_item_id, inventory_batch_id, movement_type,
            quantity, quantity_in_base, unit_cost, total_cost,
            balance_before, balance_after, reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, ?, 'sale_reversal', ?, ?, ?, ?, ?, ?, 'order_item', ?, ?, ?)`,
          [outletId, inventoryItemId, batchId,
           qtyToRestore, qtyToRestore, unitCost, totalCost,
           balanceBefore, balanceAfter, orderItemId,
           `Partial cancel: ${cancelQuantity}/${originalQuantity} — ${reason || 'Quantity reduced'}`,
           userId]
        );
      }

      // Update inventory_items stock
      const restorations = [];
      for (const [inventoryItemId, ir] of Object.entries(itemRestorations)) {
        const newStock = ir.currentStock + ir.totalRestored;
        await connection.query(
          'UPDATE inventory_items SET current_stock = ? WHERE id = ?',
          [newStock, inventoryItemId]
        );

        restorations.push({
          inventoryItemId: parseInt(inventoryItemId),
          qtyRestored: parseFloat(ir.totalRestored.toFixed(4)),
          balanceAfter: parseFloat(newStock.toFixed(4))
        });
      }

      logger.info(`Partial stock reversed for order_item ${orderItemId}: ${cancelQuantity}/${originalQuantity}, ${restorations.length} ingredients (net-based)`);

      return {
        orderItemId,
        restoredCount: restorations.length,
        ratio,
        restorations
      };
    } catch (error) {
      logger.error(`Partial stock reversal failed for order_item ${orderItemId}:`, error);
      return null;
    }
  },

  /**
   * Determine whether a cancelled item should get stock reversal or wastage (spoilage).
   *
   * Logic:
   *   1. If user explicitly chose (stockAction = 'reverse' or 'wastage') → use that
   *   2. Otherwise auto-decide based on configurable time window only:
   *      - Cancel within window → REVERSE (stock restored)
   *      - Cancel after window  → WASTAGE / SPOILAGE (stock stays deducted)
   *
   * @param {object} connection - MySQL connection (or pool)
   * @param {object} item - order_item row (needs: created_at, outlet_id)
   * @param {string|null} userChoice - 'reverse', 'wastage', or null (auto)
   * @returns {{ action: 'reverse'|'wastage', auto: boolean, reason: string }}
   */
  async determineCancelStockAction(connection, item, userChoice = null) {
    // If user explicitly chose, honour it
    if (userChoice === 'reverse' || userChoice === 'wastage') {
      return { action: userChoice, auto: false, reason: `User chose: ${userChoice}` };
    }

    // Load configurable window from settings
    const settingsService = require('./settings.service');
    const windowMinutes = (await settingsService.get('cancel_reversal_window_minutes', item.outlet_id))?.value ?? 5;

    // Auto-decide based on time elapsed since item creation
    const createdAt = new Date(item.created_at);
    const now = new Date();
    const elapsedMinutes = (now - createdAt) / 60000;

    if (elapsedMinutes <= windowMinutes) {
      return {
        action: 'reverse',
        auto: true,
        reason: `Within ${windowMinutes}min window (${elapsedMinutes.toFixed(1)}min elapsed)`
      };
    }

    return {
      action: 'wastage',
      auto: true,
      reason: `${elapsedMinutes.toFixed(1)}min elapsed > ${windowMinutes}min window → spoilage`
    };
  },

  /**
   * Record wastage/spoilage for a cancelled order item (stock NOT reversed).
   * Uses the existing sale movements to know exactly what was deducted per ingredient,
   * then records wastage_logs + wastage movements for each.
   * Stock stays deducted — it becomes a loss.
   */
  async recordWastageForCancelledItem(connection, { orderItemId, orderId, outletId, userId, reason }) {
    try {
      // Get all sale movements for this order item
      const [movements] = await connection.query(
        `SELECT * FROM inventory_movements
         WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'sale'`,
        [orderItemId]
      );

      if (movements.length === 0) return null;

      const wastageRecords = [];
      const itemStocks = {}; // cache current stock per inventory item

      for (const mov of movements) {
        const inventoryItemId = mov.inventory_item_id;
        const batchId = mov.inventory_batch_id;
        const qtyWasted = Math.abs(parseFloat(mov.quantity));
        const unitCost = parseFloat(mov.unit_cost) || 0;
        const totalCost = Math.abs(parseFloat(mov.total_cost)) || 0;

        // Insert wastage_log entry with order reference
        const [logResult] = await connection.query(
          `INSERT INTO wastage_logs (
            outlet_id, inventory_item_id, inventory_batch_id, quantity, quantity_in_base,
            unit_id, unit_cost, total_cost, wastage_type, reason, reason_notes,
            reported_by, approved_by, order_id, order_item_id, wastage_date
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'spoilage', 'order_cancel', ?, ?, NULL, ?, ?, CURDATE())`,
          [outletId, inventoryItemId, batchId,
           qtyWasted, qtyWasted, unitCost, totalCost,
           reason || 'Item cancelled (beyond reversal window)',
           userId, orderId, orderItemId]
        );

        // Get current stock for balance fields (cache per item)
        if (itemStocks[inventoryItemId] === undefined) {
          const [[item]] = await connection.query(
            'SELECT current_stock FROM inventory_items WHERE id = ?',
            [inventoryItemId]
          );
          itemStocks[inventoryItemId] = parseFloat(item?.current_stock) || 0;
        }
        const currentStock = itemStocks[inventoryItemId];

        // Record sale_reversal movement (conceptual: undo the sale)
        // Stock doesn't actually change — this is a reclassification pair
        await connection.query(
          `INSERT INTO inventory_movements (
            outlet_id, inventory_item_id, inventory_batch_id, movement_type,
            quantity, quantity_in_base, unit_cost, total_cost,
            balance_before, balance_after, reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, ?, 'sale_reversal', ?, ?, ?, ?, ?, ?, 'order_cancel', ?, ?, ?)`,
          [outletId, inventoryItemId, batchId,
           qtyWasted, qtyWasted, unitCost, totalCost,
           currentStock, currentStock + qtyWasted,
           orderItemId,
           `Cancel reversal (spoilage reclassification): ${reason || 'Item cancelled'}`,
           userId]
        );

        // Record wastage movement (reclassify the deducted stock as spoilage)
        await connection.query(
          `INSERT INTO inventory_movements (
            outlet_id, inventory_item_id, inventory_batch_id, movement_type,
            quantity, quantity_in_base, unit_cost, total_cost,
            balance_before, balance_after, reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, ?, 'wastage', ?, ?, ?, ?, ?, ?, 'order_cancel', ?, ?, ?)`,
          [outletId, inventoryItemId, batchId,
           -qtyWasted, -qtyWasted, unitCost, totalCost,
           currentStock + qtyWasted, currentStock,
           orderItemId,
           `Spoilage: Order cancel — ${reason || 'Item cancelled (beyond reversal window)'}`,
           userId]
        );

        wastageRecords.push({
          wastageLogId: logResult.insertId,
          inventoryItemId,
          batchId,
          qtyWasted,
          unitCost,
          totalCost
        });
      }

      // Mark stock_deducted remains 1 (stock stays deducted, now counted as wastage)
      logger.info(
        `Wastage recorded for order_item ${orderItemId}: ${wastageRecords.length} ingredients, ` +
        `total cost ₹${wastageRecords.reduce((s, w) => s + w.totalCost, 0).toFixed(2)}`
      );

      return {
        orderItemId,
        action: 'wastage',
        wastageCount: wastageRecords.length,
        totalCost: parseFloat(wastageRecords.reduce((s, w) => s + w.totalCost, 0).toFixed(2)),
        records: wastageRecords
      };
    } catch (error) {
      logger.error(`Wastage recording failed for order_item ${orderItemId}:`, error);
      return null;
    }
  },

  /**
   * Record wastage for a partial cancel (proportional to cancelled qty).
   * Uses NET remaining deduction (sale - previous reversals) to handle repeated partial cancels correctly.
   */
  async recordWastageForPartialCancel(connection, { orderItemId, orderId, outletId, userId, reason, cancelQuantity, originalQuantity }) {
    try {
      if (!cancelQuantity || !originalQuantity || cancelQuantity <= 0) return null;
      const ratio = cancelQuantity / originalQuantity;

      // Get NET remaining deduction per (inventory_item, batch) accounting for previous reversals
      const [movements] = await connection.query(
        `SELECT inventory_item_id, inventory_batch_id,
                SUM(CASE WHEN movement_type = 'sale' THEN ABS(quantity) ELSE 0 END) as total_deducted,
                SUM(CASE WHEN movement_type = 'sale_reversal' THEN ABS(quantity) ELSE 0 END) as total_reversed,
                AVG(CASE WHEN movement_type = 'sale' THEN ABS(unit_cost) ELSE NULL END) as unit_cost
         FROM inventory_movements
         WHERE reference_type = 'order_item' AND reference_id = ?
           AND movement_type IN ('sale', 'sale_reversal')
         GROUP BY inventory_item_id, inventory_batch_id`,
        [orderItemId]
      );

      if (movements.length === 0) return null;

      const wastageRecords = [];
      const itemStocks = {}; // cache current stock per inventory item

      for (const mov of movements) {
        const inventoryItemId = mov.inventory_item_id;
        const batchId = mov.inventory_batch_id;
        const netRemaining = parseFloat(mov.total_deducted) - parseFloat(mov.total_reversed);
        if (netRemaining <= 0) continue; // Already fully reversed
        const qtyWasted = parseFloat((netRemaining * ratio).toFixed(4));
        if (qtyWasted <= 0) continue;
        const unitCost = parseFloat(mov.unit_cost) || 0;
        const totalCost = parseFloat((qtyWasted * unitCost).toFixed(2));

        const [logResult] = await connection.query(
          `INSERT INTO wastage_logs (
            outlet_id, inventory_item_id, inventory_batch_id, quantity, quantity_in_base,
            unit_id, unit_cost, total_cost, wastage_type, reason, reason_notes,
            reported_by, approved_by, order_id, order_item_id, wastage_date
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'spoilage', 'order_cancel', ?, ?, NULL, ?, ?, CURDATE())`,
          [outletId, inventoryItemId, batchId,
           qtyWasted, qtyWasted, unitCost, totalCost,
           reason || 'Partial cancel (beyond reversal window)',
           userId, orderId, orderItemId]
        );

        // Get current stock for balance fields (cache per item)
        if (itemStocks[inventoryItemId] === undefined) {
          const [[item]] = await connection.query(
            'SELECT current_stock FROM inventory_items WHERE id = ?',
            [inventoryItemId]
          );
          itemStocks[inventoryItemId] = parseFloat(item?.current_stock) || 0;
        }
        const currentStock = itemStocks[inventoryItemId];

        // Record sale_reversal movement (conceptual: undo the sale portion)
        await connection.query(
          `INSERT INTO inventory_movements (
            outlet_id, inventory_item_id, inventory_batch_id, movement_type,
            quantity, quantity_in_base, unit_cost, total_cost,
            balance_before, balance_after, reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, ?, 'sale_reversal', ?, ?, ?, ?, ?, ?, 'order_cancel', ?, ?, ?)`,
          [outletId, inventoryItemId, batchId,
           qtyWasted, qtyWasted, unitCost, totalCost,
           currentStock, currentStock + qtyWasted,
           orderItemId,
           `Partial cancel reversal (spoilage reclassification ${cancelQuantity}/${originalQuantity}): ${reason || 'Quantity reduced'}`,
           userId]
        );

        // Record wastage movement (reclassify as spoilage)
        await connection.query(
          `INSERT INTO inventory_movements (
            outlet_id, inventory_item_id, inventory_batch_id, movement_type,
            quantity, quantity_in_base, unit_cost, total_cost,
            balance_before, balance_after, reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, ?, 'wastage', ?, ?, ?, ?, ?, ?, 'order_cancel', ?, ?, ?)`,
          [outletId, inventoryItemId, batchId,
           -qtyWasted, -qtyWasted, unitCost, totalCost,
           currentStock + qtyWasted, currentStock,
           orderItemId,
           `Spoilage: Partial cancel (${cancelQuantity}/${originalQuantity}) — ${reason || 'Quantity reduced (beyond reversal window)'}`,
           userId]
        );

        wastageRecords.push({
          wastageLogId: logResult.insertId,
          inventoryItemId, batchId, qtyWasted, unitCost, totalCost
        });
      }

      logger.info(
        `Partial wastage recorded for order_item ${orderItemId}: ${cancelQuantity}/${originalQuantity}, ` +
        `${wastageRecords.length} ingredients`
      );

      return {
        orderItemId,
        action: 'wastage',
        ratio,
        wastageCount: wastageRecords.length,
        totalCost: parseFloat(wastageRecords.reduce((s, w) => s + w.totalCost, 0).toFixed(2)),
        records: wastageRecords
      };
    } catch (error) {
      logger.error(`Partial wastage recording failed for order_item ${orderItemId}:`, error);
      return null;
    }
  },

  /**
   * Reverse stock for ALL items in an order (on full order cancel)
   */
  async reverseForOrder(connection, { orderId, outletId, userId, reason }) {
    try {
      // Get all order items that had stock deducted
      const [items] = await connection.query(
        'SELECT id FROM order_items WHERE order_id = ? AND stock_deducted = 1',
        [orderId]
      );

      const results = [];
      for (const item of items) {
        const result = await this.reverseForOrderItem(connection, {
          orderItemId: item.id, outletId, userId, reason
        });
        if (result) results.push(result);
      }

      // Mark order as stock_reversed
      await connection.query(
        'UPDATE orders SET stock_reversed = 1 WHERE id = ?',
        [orderId]
      );

      logger.info(`Stock reversed for order ${orderId}: ${results.length} items reversed`);
      return results;
    } catch (error) {
      logger.error(`Stock reversal failed for order ${orderId}:`, error);
      return null;
    }
  },

  /**
   * FIFO batch deduction with cost tracking and concurrency locks
   * Locks batches with FOR UPDATE to prevent race conditions
   * Returns detailed per-batch breakdown for movement records
   */
  async _deductFromBatchesFIFO(connection, inventoryItemId, quantity) {
    // Lock ALL active batches for this item (prevents concurrent deduction races)
    const [batches] = await connection.query(
      `SELECT id, remaining_quantity, purchase_price FROM inventory_batches
       WHERE inventory_item_id = ? AND remaining_quantity > 0 AND is_active = 1
       ORDER BY purchase_date ASC, id ASC
       FOR UPDATE`,
      [inventoryItemId]
    );

    let remaining = quantity;
    let totalCost = 0;
    const batchDetails = [];

    for (const batch of batches) {
      if (remaining <= 0) break;

      const batchQty = parseFloat(batch.remaining_quantity);
      const batchPrice = parseFloat(batch.purchase_price);
      const deduct = Math.min(remaining, batchQty);

      await connection.query(
        'UPDATE inventory_batches SET remaining_quantity = remaining_quantity - ? WHERE id = ?',
        [deduct, batch.id]
      );

      const batchCost = deduct * batchPrice;
      totalCost += batchCost;

      batchDetails.push({
        batchId: batch.id,
        qtyDeducted: parseFloat(deduct.toFixed(4)),
        pricePerUnit: batchPrice,
        cost: parseFloat(batchCost.toFixed(2))
      });

      remaining -= deduct;
    }

    // If remaining > 0, stock insufficient in batches — allow negative stock
    // Use average price for the unbatched portion (no batch to deduct from)
    let unbatchedQty = 0;
    if (remaining > 0) {
      unbatchedQty = parseFloat(remaining.toFixed(4));
      const [[item]] = await connection.query(
        'SELECT average_price FROM inventory_items WHERE id = ?',
        [inventoryItemId]
      );
      const avgPrice = parseFloat(item?.average_price) || 0;
      totalCost += remaining * avgPrice;
      logger.info(`Stock deduction: item ${inventoryItemId} went negative by ${remaining.toFixed(4)} units (batches exhausted)`);
    }

    return {
      totalCost: parseFloat(totalCost.toFixed(2)),
      batches: batchDetails,
      unbatchedQty
    };
  }
};

module.exports = stockDeductionService;
