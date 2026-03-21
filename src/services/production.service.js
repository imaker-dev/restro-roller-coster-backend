/**
 * Production Service — Module 8
 * Manages production recipes (templates) and production runs
 * Flow: Raw Materials → Production → Semi-Finished Batch (Gravy, Sauce, Dough)
 * 
 * Golden Rule: Cost is ALWAYS derived from ingredients, never manually set
 * Golden Rule: Never change stock directly — always use movements
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');
const inventoryService = require('./inventory.service');

const productionService = {

  // ============================================================
  // PRODUCTION RECIPES (Templates)
  // ============================================================

  async listRecipes(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1, limit = 50, search, isActive,
      sortBy = 'name', sortOrder = 'ASC'
    } = options;

    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['name', 'created_at', 'updated_at'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'name';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let where = 'WHERE pr.outlet_id = ?';
    const params = [outletId];

    if (typeof isActive === 'boolean') {
      where += ' AND pr.is_active = ?';
      params.push(isActive ? 1 : 0);
    }
    if (search) {
      where += ' AND (pr.name LIKE ? OR oi.name LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM production_recipes pr
       LEFT JOIN inventory_items oi ON pr.output_inventory_item_id = oi.id
       ${where}`, params
    );

    const [rows] = await pool.query(
      `SELECT pr.*,
        oi.name as output_item_name, oi.sku as output_item_sku,
        ou.name as output_unit_name, ou.abbreviation as output_unit_abbreviation,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM production_recipe_ingredients pri WHERE pri.production_recipe_id = pr.id) as ingredient_count,
        (SELECT COUNT(*) FROM productions p WHERE p.production_recipe_id = pr.id AND p.status = 'completed') as production_count
       FROM production_recipes pr
       LEFT JOIN inventory_items oi ON pr.output_inventory_item_id = oi.id
       LEFT JOIN units ou ON pr.output_unit_id = ou.id
       LEFT JOIN users u ON pr.created_by = u.id
       ${where}
       ORDER BY pr.${safeSortBy} ${safeSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    return {
      recipes: rows.map(r => this._formatRecipe(r)),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) }
    };
  },

  async getRecipeById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT pr.*,
        oi.name as output_item_name, oi.sku as output_item_sku,
        oi.average_price as output_avg_price,
        ou.name as output_unit_name, ou.abbreviation as output_unit_abbreviation,
        ou.conversion_factor as output_unit_cf,
        obu.conversion_factor as output_base_unit_cf,
        u.name as created_by_name
       FROM production_recipes pr
       LEFT JOIN inventory_items oi ON pr.output_inventory_item_id = oi.id
       LEFT JOIN units ou ON pr.output_unit_id = ou.id
       LEFT JOIN units obu ON oi.base_unit_id = obu.id
       LEFT JOIN users u ON pr.created_by = u.id
       WHERE pr.id = ?`,
      [id]
    );
    if (!rows[0]) return null;

    const recipe = this._formatRecipe(rows[0]);

    // Get ingredients with live cost
    const [ingredients] = await pool.query(
      `SELECT pri.*,
        ii.name as item_name, ii.sku as item_sku,
        ii.average_price, ii.latest_price, ii.current_stock,
        ii.base_unit_id,
        iu.name as unit_name, iu.abbreviation as unit_abbreviation,
        iu.conversion_factor as ingredient_unit_cf,
        bu.conversion_factor as base_unit_cf,
        COALESCE(pu.conversion_factor, 1) as purchase_cf,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation
       FROM production_recipe_ingredients pri
       JOIN inventory_items ii ON pri.inventory_item_id = ii.id
       LEFT JOIN units iu ON pri.unit_id = iu.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       WHERE pri.production_recipe_id = ?
       ORDER BY pri.display_order, pri.id`,
      [id]
    );

    let totalInputCost = 0;
    recipe.ingredients = ingredients.map(ing => {
      const qty = parseFloat(ing.quantity) || 0;
      const ingUnitCf = parseFloat(ing.ingredient_unit_cf) || 1;
      // Convert to system base units (gram/ml/pcs) — matches how prices & stock are stored
      const qtyInBase = qty * ingUnitCf;
      const pricePerBase = parseFloat(ing.average_price) || 0;
      const cost = parseFloat((qtyInBase * pricePerBase).toFixed(2));
      totalInputCost += cost;

      const purchaseCf = parseFloat(ing.purchase_cf) || 1;

      return {
        id: ing.id,
        inventoryItemId: ing.inventory_item_id,
        itemName: ing.item_name,
        itemSku: ing.item_sku,
        quantity: qty,
        unitId: ing.unit_id,
        unitName: ing.unit_name,
        unitAbbreviation: ing.unit_abbreviation,
        currentStock: parseFloat(((parseFloat(ing.current_stock) || 0) / purchaseCf).toFixed(4)),
        stockUnitAbbreviation: ing.purchase_unit_abbreviation,
        liveCost: cost,
        displayOrder: ing.display_order || 0,
        notes: ing.notes || null
      };
    });

    recipe.totalInputCost = parseFloat(totalInputCost.toFixed(2));
    const outputQty = parseFloat(rows[0].output_quantity) || 1;
    recipe.costPerOutputUnit = parseFloat((totalInputCost / outputQty).toFixed(4));

    return recipe;
  },

  async createRecipe(outletId, data, userId = null) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const {
        name, description, outputInventoryItemId, outputQuantity,
        outputUnitId, preparationTimeMins = 0, instructions, ingredients = []
      } = data;

      if (!name) throw new Error('Recipe name is required');
      if (!outputInventoryItemId) throw new Error('outputInventoryItemId is required');
      if (!outputQuantity || outputQuantity <= 0) throw new Error('outputQuantity must be > 0');
      if (!outputUnitId) throw new Error('outputUnitId is required');

      // Verify output item exists
      const [[outputItem]] = await connection.query(
        'SELECT id FROM inventory_items WHERE id = ? AND outlet_id = ?',
        [outputInventoryItemId, outletId]
      );
      if (!outputItem) throw new Error('Output inventory item not found in this outlet');

      const [result] = await connection.query(
        `INSERT INTO production_recipes (outlet_id, name, description, output_inventory_item_id,
         output_quantity, output_unit_id, preparation_time_mins, instructions, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [outletId, name.trim(), description || null, outputInventoryItemId,
         outputQuantity, outputUnitId, preparationTimeMins, instructions || null, userId]
      );
      const recipeId = result.insertId;

      // Add ingredients
      for (let i = 0; i < ingredients.length; i++) {
        const ing = ingredients[i];
        if (!ing.inventoryItemId || !ing.quantity || !ing.unitId) {
          throw new Error(`Ingredient at index ${i}: inventoryItemId, quantity, and unitId are required`);
        }

        const [[item]] = await connection.query(
          'SELECT id FROM inventory_items WHERE id = ? AND outlet_id = ?',
          [ing.inventoryItemId, outletId]
        );
        if (!item) throw new Error(`Inventory item ${ing.inventoryItemId} not found`);

        await connection.query(
          `INSERT INTO production_recipe_ingredients (production_recipe_id, inventory_item_id, quantity, unit_id, display_order, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [recipeId, ing.inventoryItemId, ing.quantity, ing.unitId, ing.displayOrder || i, ing.notes || null]
        );
      }

      await connection.commit();
      return this.getRecipeById(recipeId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async updateRecipe(id, data, userId = null) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [[recipe]] = await connection.query('SELECT * FROM production_recipes WHERE id = ?', [id]);
      if (!recipe) throw new Error('Production recipe not found');

      const fields = [];
      const params = [];

      if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name.trim()); }
      if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description || null); }
      if (data.outputQuantity !== undefined) { fields.push('output_quantity = ?'); params.push(data.outputQuantity); }
      if (data.outputUnitId !== undefined) { fields.push('output_unit_id = ?'); params.push(data.outputUnitId); }
      if (data.preparationTimeMins !== undefined) { fields.push('preparation_time_mins = ?'); params.push(data.preparationTimeMins); }
      if (data.instructions !== undefined) { fields.push('instructions = ?'); params.push(data.instructions || null); }
      if (data.isActive !== undefined) { fields.push('is_active = ?'); params.push(data.isActive ? 1 : 0); }

      if (fields.length > 0) {
        params.push(id);
        await connection.query(`UPDATE production_recipes SET ${fields.join(', ')} WHERE id = ?`, params);
      }

      // Replace ingredients if provided
      if (data.ingredients) {
        await connection.query('DELETE FROM production_recipe_ingredients WHERE production_recipe_id = ?', [id]);
        for (let i = 0; i < data.ingredients.length; i++) {
          const ing = data.ingredients[i];
          if (!ing.inventoryItemId || !ing.quantity || !ing.unitId) {
            throw new Error(`Ingredient at index ${i}: inventoryItemId, quantity, unitId required`);
          }
          await connection.query(
            `INSERT INTO production_recipe_ingredients (production_recipe_id, inventory_item_id, quantity, unit_id, display_order, notes)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, ing.inventoryItemId, ing.quantity, ing.unitId, ing.displayOrder || i, ing.notes || null]
          );
        }
      }

      await connection.commit();
      return this.getRecipeById(id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ============================================================
  // PRODUCTION RUNS — execute a production
  // ============================================================

  /**
   * Execute a production run:
   * 1. Deduct raw materials (FIFO batch deduction + movements)
   * 2. Calculate total input cost
   * 3. Create output batch with derived cost
   * 4. Record all movements
   */
  async produce(outletId, data, userId = null) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const {
        productionRecipeId, outputQuantity: customOutputQty,
        notes, ingredients: customIngredients
      } = data;

      // Load recipe template (if provided)
      let recipeName, outputItemId, outputQty, outputUnitId, inputIngredients;

      if (productionRecipeId) {
        const [[recipe]] = await connection.query(
          'SELECT * FROM production_recipes WHERE id = ? AND outlet_id = ?',
          [productionRecipeId, outletId]
        );
        if (!recipe) throw new Error('Production recipe not found');
        if (!recipe.is_active) throw new Error('Production recipe is inactive');

        recipeName = recipe.name;
        outputItemId = recipe.output_inventory_item_id;
        outputQty = customOutputQty || parseFloat(recipe.output_quantity);
        outputUnitId = recipe.output_unit_id;

        // Scale ingredients if custom output quantity
        const scale = outputQty / parseFloat(recipe.output_quantity);

        if (customIngredients) {
          inputIngredients = customIngredients;
        } else {
          const [recipeIngs] = await connection.query(
            'SELECT * FROM production_recipe_ingredients WHERE production_recipe_id = ?',
            [productionRecipeId]
          );
          inputIngredients = recipeIngs.map(ri => ({
            inventoryItemId: ri.inventory_item_id,
            quantity: parseFloat((parseFloat(ri.quantity) * scale).toFixed(4)),
            unitId: ri.unit_id
          }));
        }
      } else {
        // Ad-hoc production (no template)
        if (!data.name || !data.outputInventoryItemId || !data.outputQuantity || !data.outputUnitId) {
          throw new Error('For ad-hoc production: name, outputInventoryItemId, outputQuantity, outputUnitId required');
        }
        if (!data.ingredients || data.ingredients.length === 0) {
          throw new Error('ingredients array is required for ad-hoc production');
        }
        recipeName = data.name;
        outputItemId = data.outputInventoryItemId;
        outputQty = data.outputQuantity;
        outputUnitId = data.outputUnitId;
        inputIngredients = data.ingredients;
      }

      // Validate output item
      const [[outputItem]] = await connection.query(
        `SELECT ii.id, ii.current_stock, ii.average_price, ii.base_unit_id,
                COALESCE(pu.conversion_factor, 1) as purchase_cf
         FROM inventory_items ii
         LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
         WHERE ii.id = ? AND ii.outlet_id = ?`,
        [outputItemId, outletId]
      );
      if (!outputItem) throw new Error('Output inventory item not found');

      // Get output unit conversion
      const [[outputUnit]] = await connection.query(
        'SELECT conversion_factor FROM units WHERE id = ?', [outputUnitId]
      );
      const [[outputBaseUnit]] = await connection.query(
        'SELECT conversion_factor FROM units WHERE id = ?', [outputItem.base_unit_id]
      );
      const outputUnitCf = parseFloat(outputUnit?.conversion_factor) || 1;
      // Convert to system base units (gram/ml/pcs) — matches how stock is stored
      const outputQtyInBase = outputQty * outputUnitCf;

      // Generate production number
      const productionNumber = await this._generateProductionNumber(outletId, connection);

      // Step 1: Deduct raw materials and calculate total input cost
      // Uses per-batch FIFO deduction with FOR UPDATE locks for concurrency safety
      // Creates 1 movement PER batch so reversal can restore to exact original batches
      let totalInputCost = 0;
      const inputRecords = [];

      for (const ing of inputIngredients) {
        if (!ing.inventoryItemId || !ing.quantity || !ing.unitId) {
          throw new Error('Each ingredient needs inventoryItemId, quantity, unitId');
        }

        // Get item and unit info
        const [[item]] = await connection.query(
          `SELECT ii.id, ii.current_stock, ii.average_price, ii.base_unit_id,
                  COALESCE(pu.conversion_factor, 1) as purchase_cf
           FROM inventory_items ii
           LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
           WHERE ii.id = ? AND ii.outlet_id = ? FOR UPDATE`,
          [ing.inventoryItemId, outletId]
        );
        if (!item) throw new Error(`Inventory item ${ing.inventoryItemId} not found`);

        const [[ingUnit]] = await connection.query(
          'SELECT conversion_factor FROM units WHERE id = ?', [ing.unitId]
        );
        const [[baseUnit]] = await connection.query(
          'SELECT conversion_factor FROM units WHERE id = ?', [item.base_unit_id]
        );
        const ingUnitCf = parseFloat(ingUnit?.conversion_factor) || 1;
        // Convert to system base units (gram/ml/pcs) — matches how stock is stored
        const qtyInBase = ing.quantity * ingUnitCf;

        const currentStock = parseFloat(item.current_stock) || 0;
        if (qtyInBase > currentStock + 0.01) {
          const purchaseCf = parseFloat(item.purchase_cf) || 1;
          throw new Error(
            `Insufficient stock for item ${ing.inventoryItemId}. ` +
            `Need: ${ing.quantity}, Available: ${(currentStock / purchaseCf).toFixed(4)}`
          );
        }

        const balanceBefore = currentStock;
        const balanceAfter = currentStock - qtyInBase;

        // Deduct from batches (FIFO) with per-batch tracking
        const [batches] = await connection.query(
          `SELECT id, remaining_quantity, purchase_price FROM inventory_batches
           WHERE inventory_item_id = ? AND remaining_quantity > 0 AND is_active = 1
           ORDER BY purchase_date ASC, id ASC
           FOR UPDATE`,
          [ing.inventoryItemId]
        );

        let remaining = qtyInBase;
        let ingCost = 0;
        let runningBalance = balanceBefore;

        for (const batch of batches) {
          if (remaining <= 0) break;
          const batchQty = parseFloat(batch.remaining_quantity);
          const batchPrice = parseFloat(batch.purchase_price);
          const deduct = Math.min(remaining, batchQty);

          await connection.query(
            'UPDATE inventory_batches SET remaining_quantity = remaining_quantity - ? WHERE id = ?',
            [deduct, batch.id]
          );

          const batchCost = parseFloat((deduct * batchPrice).toFixed(2));
          ingCost += batchCost;

          // Record per-batch PRODUCTION_OUT movement
          const batchBalanceBefore = runningBalance;
          runningBalance -= deduct;
          await connection.query(
            `INSERT INTO inventory_movements (
              outlet_id, inventory_item_id, inventory_batch_id, movement_type,
              quantity, quantity_in_base, unit_cost, total_cost,
              balance_before, balance_after, reference_type, reference_id, created_by
            ) VALUES (?, ?, ?, 'production_out', ?, ?, ?, ?, ?, ?, 'production', NULL, ?)`,
            [outletId, ing.inventoryItemId, batch.id,
             -deduct, -deduct, batchPrice, batchCost,
             batchBalanceBefore, runningBalance, userId]
          );

          remaining -= deduct;
        }

        // If remaining > 0, use avg price (insufficient batches)
        if (remaining > 0) {
          const avgPrice = parseFloat(item.average_price) || 0;
          const unbatchedCost = parseFloat((remaining * avgPrice).toFixed(2));
          ingCost += unbatchedCost;
          const ubBefore = runningBalance;
          runningBalance -= remaining;
          await connection.query(
            `INSERT INTO inventory_movements (
              outlet_id, inventory_item_id, inventory_batch_id, movement_type,
              quantity, quantity_in_base, unit_cost, total_cost,
              balance_before, balance_after, reference_type, reference_id, created_by
            ) VALUES (?, ?, NULL, 'production_out', ?, ?, ?, ?, ?, ?, 'production', NULL, ?)`,
            [outletId, ing.inventoryItemId,
             -remaining, -remaining, avgPrice, unbatchedCost,
             ubBefore, runningBalance, userId]
          );
        }

        ingCost = parseFloat(ingCost.toFixed(2));
        totalInputCost += ingCost;

        // Update stock
        await connection.query(
          'UPDATE inventory_items SET current_stock = ? WHERE id = ?',
          [balanceAfter, ing.inventoryItemId]
        );

        inputRecords.push({
          inventoryItemId: ing.inventoryItemId,
          quantity: ing.quantity,
          unitId: ing.unitId,
          qtyInBase,
          unitCost: parseFloat((ingCost / qtyInBase).toFixed(4)),
          totalCost: ingCost
        });
      }

      // Step 2: Calculate cost per output unit
      const costPerOutputUnit = parseFloat((totalInputCost / outputQtyInBase).toFixed(4));

      // Step 3: Create output batch
      const batchCode = `PROD-${productionNumber}`;
      const [batchResult] = await connection.query(
        `INSERT INTO inventory_batches (
          inventory_item_id, outlet_id, batch_code, quantity, remaining_quantity,
          purchase_price, purchase_date, notes, is_active
        ) VALUES (?, ?, ?, ?, ?, ?, CURDATE(), ?, 1)`,
        [outputItemId, outletId, batchCode, outputQtyInBase, outputQtyInBase,
         costPerOutputUnit, `Production: ${recipeName}`]
      );
      const outputBatchId = batchResult.insertId;

      // Step 4: Update output item stock and average price
      const outputCurrentStock = parseFloat(outputItem.current_stock) || 0;
      const outputOldAvg = parseFloat(outputItem.average_price) || 0;
      const newTotalQty = outputCurrentStock + outputQtyInBase;
      let newAvgPrice = costPerOutputUnit;
      if (newTotalQty > 0 && outputCurrentStock > 0) {
        newAvgPrice = ((outputCurrentStock * outputOldAvg) + (outputQtyInBase * costPerOutputUnit)) / newTotalQty;
      }
      newAvgPrice = parseFloat(newAvgPrice.toFixed(4));

      const outputBalanceBefore = outputCurrentStock;
      const outputBalanceAfter = outputCurrentStock + outputQtyInBase;

      await connection.query(
        `UPDATE inventory_items SET current_stock = ?, average_price = ?, latest_price = ? WHERE id = ?`,
        [outputBalanceAfter, newAvgPrice, costPerOutputUnit, outputItemId]
      );

      // Step 5: Record PRODUCTION_IN movement for output
      await connection.query(
        `INSERT INTO inventory_movements (
          outlet_id, inventory_item_id, inventory_batch_id, movement_type,
          quantity, quantity_in_base, unit_cost, total_cost,
          balance_before, balance_after, reference_type, reference_id, created_by
        ) VALUES (?, ?, ?, 'production_in', ?, ?, ?, ?, ?, ?, 'production', NULL, ?)`,
        [outletId, outputItemId, outputBatchId,
         outputQtyInBase, outputQtyInBase, costPerOutputUnit, totalInputCost,
         outputBalanceBefore, outputBalanceAfter, userId]
      );

      // Step 6: Insert production record
      const [prodResult] = await connection.query(
        `INSERT INTO productions (
          outlet_id, production_recipe_id, production_number, name, status,
          output_inventory_item_id, output_quantity, output_unit_id, output_batch_id,
          total_input_cost, cost_per_output_unit, notes, created_by
        ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [outletId, productionRecipeId || null, productionNumber, recipeName,
         outputItemId, outputQtyInBase, outputUnitId, outputBatchId,
         totalInputCost, costPerOutputUnit, notes || null, userId]
      );
      const productionId = prodResult.insertId;

      // Step 7: Insert production input records
      for (const inp of inputRecords) {
        await connection.query(
          `INSERT INTO production_inputs (production_id, inventory_item_id, quantity, unit_id, quantity_in_base, unit_cost, total_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [productionId, inp.inventoryItemId, inp.quantity, inp.unitId, inp.qtyInBase, inp.unitCost, inp.totalCost]
        );
      }

      // Update movement reference_id now that we have production ID
      await connection.query(
        `UPDATE inventory_movements SET reference_id = ?
         WHERE reference_type = 'production' AND reference_id IS NULL AND created_by = ?
         AND created_at >= NOW() - INTERVAL 5 SECOND`,
        [productionId, userId]
      );

      await connection.commit();

      logger.info(`Production ${productionNumber} completed: ${recipeName} → ${outputQty} units, cost: ₹${totalInputCost}`);

      return this.getProductionById(productionId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ============================================================
  // PRODUCTION HISTORY
  // ============================================================

  async listProductions(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1, limit = 50, search, status,
      productionRecipeId, outputItemId,
      startDate, endDate,
      sortBy = 'produced_at', sortOrder = 'DESC'
    } = options;

    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['produced_at', 'total_input_cost', 'output_quantity', 'name'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'produced_at';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let where = 'WHERE p.outlet_id = ?';
    const params = [outletId];

    if (status) { where += ' AND p.status = ?'; params.push(status); }
    if (productionRecipeId) { where += ' AND p.production_recipe_id = ?'; params.push(productionRecipeId); }
    if (outputItemId) { where += ' AND p.output_inventory_item_id = ?'; params.push(outputItemId); }
    if (startDate) { where += ' AND DATE(p.produced_at) >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND DATE(p.produced_at) <= ?'; params.push(endDate); }
    if (search) {
      where += ' AND (p.name LIKE ? OR p.production_number LIKE ? OR oi.name LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM productions p
       LEFT JOIN inventory_items oi ON p.output_inventory_item_id = oi.id
       ${where}`, params
    );

    const [rows] = await pool.query(
      `SELECT p.*,
        oi.name as output_item_name,
        ou.abbreviation as output_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_cf,
        u.name as created_by_name
       FROM productions p
       LEFT JOIN inventory_items oi ON p.output_inventory_item_id = oi.id
       LEFT JOIN units ou ON p.output_unit_id = ou.id
       LEFT JOIN units pu ON oi.purchase_unit_id = pu.id
       LEFT JOIN users u ON p.created_by = u.id
       ${where}
       ORDER BY p.${safeSortBy} ${safeSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    return {
      productions: rows.map(r => this._formatProduction(r)),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) }
    };
  },

  async getProductionById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT p.*,
        oi.name as output_item_name, oi.sku as output_item_sku,
        ou.abbreviation as output_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_cf,
        ib.batch_code as output_batch_code,
        ib.remaining_quantity as batch_remaining,
        u.name as created_by_name
       FROM productions p
       LEFT JOIN inventory_items oi ON p.output_inventory_item_id = oi.id
       LEFT JOIN units ou ON p.output_unit_id = ou.id
       LEFT JOIN units pu ON oi.purchase_unit_id = pu.id
       LEFT JOIN inventory_batches ib ON p.output_batch_id = ib.id
       LEFT JOIN users u ON p.created_by = u.id
       WHERE p.id = ?`,
      [id]
    );
    if (!rows[0]) return null;

    const production = this._formatProduction(rows[0]);
    production.outputBatchCode = rows[0].output_batch_code || null;
    production.batchRemaining = rows[0].batch_remaining != null
      ? parseFloat((parseFloat(rows[0].batch_remaining) / (parseFloat(rows[0].purchase_cf) || 1)).toFixed(4))
      : null;

    // Get input items
    const [inputs] = await pool.query(
      `SELECT pi.*,
        ii.name as item_name, ii.sku as item_sku,
        iu.abbreviation as unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_cf,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation
       FROM production_inputs pi
       JOIN inventory_items ii ON pi.inventory_item_id = ii.id
       LEFT JOIN units iu ON pi.unit_id = iu.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       WHERE pi.production_id = ?
       ORDER BY pi.id`,
      [id]
    );

    production.inputs = inputs.map(inp => {
      const purchaseCf = parseFloat(inp.purchase_cf) || 1;
      return {
        inventoryItemId: inp.inventory_item_id,
        itemName: inp.item_name,
        itemSku: inp.item_sku,
        quantity: parseFloat((parseFloat(inp.quantity_in_base) / purchaseCf).toFixed(4)),
        unitAbbreviation: inp.purchase_unit_abbreviation || inp.unit_abbreviation,
        unitCost: parseFloat((parseFloat(inp.unit_cost) * purchaseCf).toFixed(4)),
        totalCost: parseFloat(inp.total_cost)
      };
    });

    return production;
  },

  // ============================================================
  // PRODUCTION REVERSAL
  // ============================================================

  /**
   * Reverse a completed production:
   * 1. Restore raw materials to ORIGINAL batches (via production_out movements)
   * 2. Remove output → deactivate output batch + deduct output stock
   * 3. Recalculate average prices for all affected items
   * 4. Record all reversal movements
   * 5. Mark production as cancelled
   *
   * Key: Restores inputs to SAME batches they were taken from (no new REV- batches).
   *      Reverses BOTH inputs (ingredients) AND output (final item).
   */
  async reverseProduction(productionId, { reason, userId } = {}) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // 1. Load production with FOR UPDATE lock
      const [[production]] = await connection.query(
        'SELECT * FROM productions WHERE id = ? FOR UPDATE',
        [productionId]
      );
      if (!production) throw new Error('Production not found');
      if (production.status === 'cancelled') throw new Error('Production is already cancelled/reversed');

      const outletId = production.outlet_id;

      // 2. Get original production_out movements (these have the exact batch IDs)
      const [outMovements] = await connection.query(
        `SELECT * FROM inventory_movements
         WHERE reference_type = 'production' AND reference_id = ? AND movement_type = 'production_out'`,
        [productionId]
      );

      // 3. Restore each raw material to its ORIGINAL batch
      const restoredItems = [];
      const itemRestorations = {}; // group by inventory_item_id

      for (const mov of outMovements) {
        const inventoryItemId = mov.inventory_item_id;
        const batchId = mov.inventory_batch_id; // the ORIGINAL batch
        const qtyToRestore = Math.abs(parseFloat(mov.quantity));
        const unitCost = parseFloat(mov.unit_cost) || 0;
        const totalCost = Math.abs(parseFloat(mov.total_cost)) || 0;

        // Restore to the SAME original batch
        if (batchId) {
          await connection.query(
            `UPDATE inventory_batches SET remaining_quantity = remaining_quantity + ?,
             is_active = 1 WHERE id = ?`,
            [qtyToRestore, batchId]
          );
        }

        // Lock inventory item once per item
        if (!itemRestorations[inventoryItemId]) {
          const [[item]] = await connection.query(
            'SELECT current_stock, average_price FROM inventory_items WHERE id = ? FOR UPDATE',
            [inventoryItemId]
          );
          if (!item) {
            logger.warn(`Reversal: inventory item ${inventoryItemId} not found, skipping`);
            continue;
          }
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

        // Record reversal movement pointing to SAME original batch
        await connection.query(
          `INSERT INTO inventory_movements (
            outlet_id, inventory_item_id, inventory_batch_id, movement_type,
            quantity, quantity_in_base, unit_cost, total_cost,
            balance_before, balance_after, reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, ?, 'production_reversal', ?, ?, ?, ?, ?, ?, 'production', ?, ?, ?)`,
          [outletId, inventoryItemId, batchId,
           qtyToRestore, qtyToRestore, unitCost, totalCost,
           balanceBefore, balanceAfter, productionId,
           `Reversed production ${production.production_number}: raw material restored to original batch`,
           userId]
        );
      }

      // Update inventory_items stock for each restored input
      for (const [inventoryItemId, ir] of Object.entries(itemRestorations)) {
        const newStock = ir.currentStock + ir.totalRestored;
        await connection.query(
          'UPDATE inventory_items SET current_stock = ? WHERE id = ?',
          [newStock, inventoryItemId]
        );

        restoredItems.push({
          inventoryItemId: parseInt(inventoryItemId),
          qtyRestored: ir.totalRestored,
          balanceBefore: ir.balanceBefore,
          balanceAfter: newStock
        });
      }

      // 4. Remove output — deactivate output batch + deduct from output item
      const outputItemId = production.output_inventory_item_id;
      const outputBatchId = production.output_batch_id;

      // Lock output item
      const [[outputItem]] = await connection.query(
        'SELECT current_stock, average_price FROM inventory_items WHERE id = ? FOR UPDATE',
        [outputItemId]
      );

      let outputDeducted = 0;
      if (outputBatchId) {
        // Get how much remains in the output batch
        const [[outputBatch]] = await connection.query(
          'SELECT quantity, remaining_quantity FROM inventory_batches WHERE id = ? FOR UPDATE',
          [outputBatchId]
        );
        if (outputBatch) {
          outputDeducted = parseFloat(outputBatch.remaining_quantity) || 0;
          const originalQty = parseFloat(outputBatch.quantity) || 0;

          // Deactivate the batch
          await connection.query(
            'UPDATE inventory_batches SET remaining_quantity = 0, is_active = 0, notes = CONCAT(COALESCE(notes, ""), " [REVERSED]") WHERE id = ?',
            [outputBatchId]
          );

          if (outputDeducted < originalQty) {
            logger.warn(
              `Reversal: output batch ${outputBatchId} was partially consumed. ` +
              `Original: ${originalQty}, Remaining: ${outputDeducted}, Already used: ${originalQty - outputDeducted}`
            );
          }
        }
      }

      // Deduct output from inventory item stock
      if (outputItem && outputDeducted > 0) {
        const outputBalanceBefore = parseFloat(outputItem.current_stock) || 0;
        const outputBalanceAfter = outputBalanceBefore - outputDeducted;

        await connection.query(
          'UPDATE inventory_items SET current_stock = ? WHERE id = ?',
          [outputBalanceAfter, outputItemId]
        );

        // Recalculate average price from remaining active batches
        const [[avgResult]] = await connection.query(
          `SELECT
            COALESCE(SUM(remaining_quantity * purchase_price), 0) as total_value,
            COALESCE(SUM(remaining_quantity), 0) as total_qty
           FROM inventory_batches
           WHERE inventory_item_id = ? AND is_active = 1 AND remaining_quantity > 0`,
          [outputItemId]
        );
        const totalQty = parseFloat(avgResult.total_qty) || 0;
        const totalValue = parseFloat(avgResult.total_value) || 0;
        const recalcAvg = totalQty > 0 ? parseFloat((totalValue / totalQty).toFixed(4)) : 0;

        await connection.query(
          'UPDATE inventory_items SET average_price = ? WHERE id = ?',
          [recalcAvg, outputItemId]
        );

        // Record reversal movement (output removed)
        await connection.query(
          `INSERT INTO inventory_movements (
            outlet_id, inventory_item_id, inventory_batch_id, movement_type,
            quantity, quantity_in_base, unit_cost, total_cost,
            balance_before, balance_after, reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, ?, 'production_reversal', ?, ?, ?, ?, ?, ?, 'production', ?, ?, ?)`,
          [outletId, outputItemId, outputBatchId,
           -outputDeducted, -outputDeducted,
           parseFloat(production.cost_per_output_unit),
           parseFloat((outputDeducted * parseFloat(production.cost_per_output_unit)).toFixed(2)),
           outputBalanceBefore, outputBalanceAfter, productionId,
           `Reversed production ${production.production_number}: output batch deactivated`,
           userId]
        );
      }

      // 5. Mark production as cancelled
      await connection.query(
        `UPDATE productions SET status = 'cancelled', reversed_at = NOW(), reversed_by = ?, reversal_notes = ? WHERE id = ?`,
        [userId, reason || 'Production reversed', productionId]
      );

      await connection.commit();

      logger.info(`Production ${production.production_number} reversed by user ${userId}. Reason: ${reason || 'N/A'}`);

      // Return summary
      return {
        productionId,
        productionNumber: production.production_number,
        status: 'cancelled',
        reversedAt: new Date().toISOString(),
        reason: reason || 'Production reversed',
        restoredInputs: restoredItems.length,
        outputDeducted,
        outputBatchDeactivated: !!outputBatchId,
        partiallyConsumed: outputBatchId ? outputDeducted < parseFloat(production.output_quantity) : false,
        details: {
          inputsRestored: restoredItems,
          outputItemId,
          outputBatchId
        }
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ============================================================
  // HELPERS
  // ============================================================

  async _generateProductionNumber(outletId, connection) {
    const [[{ cnt }]] = await connection.query(
      `SELECT COUNT(*) as cnt FROM productions WHERE outlet_id = ? AND DATE(produced_at) = CURDATE()`,
      [outletId]
    );
    const seq = String(cnt + 1).padStart(3, '0');
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `PRD-${today}-${seq}`;
  },

  _formatRecipe(row) {
    if (!row) return null;
    return {
      id: row.id,
      outletId: row.outlet_id,
      name: row.name,
      description: row.description || null,
      outputInventoryItemId: row.output_inventory_item_id,
      outputItemName: row.output_item_name || null,
      outputItemSku: row.output_item_sku || null,
      outputQuantity: parseFloat(row.output_quantity),
      outputUnitId: row.output_unit_id,
      outputUnitName: row.output_unit_name || null,
      outputUnitAbbreviation: row.output_unit_abbreviation || null,
      preparationTimeMins: row.preparation_time_mins || 0,
      instructions: row.instructions || null,
      ingredientCount: row.ingredient_count || 0,
      productionCount: row.production_count || 0,
      isActive: !!row.is_active,
      createdBy: row.created_by || null,
      createdByName: row.created_by_name || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  },

  _formatProduction(row) {
    if (!row) return null;
    const purchaseCf = parseFloat(row.purchase_cf) || 1;
    return {
      id: row.id,
      outletId: row.outlet_id,
      productionRecipeId: row.production_recipe_id || null,
      productionNumber: row.production_number,
      name: row.name,
      status: row.status,
      outputInventoryItemId: row.output_inventory_item_id,
      outputItemName: row.output_item_name || null,
      outputQuantity: parseFloat((parseFloat(row.output_quantity) / purchaseCf).toFixed(4)),
      outputUnitAbbreviation: row.output_unit_abbreviation || null,
      outputBatchId: row.output_batch_id || null,
      totalInputCost: parseFloat(row.total_input_cost),
      costPerOutputUnit: parseFloat((parseFloat(row.cost_per_output_unit) * purchaseCf).toFixed(4)),
      notes: row.notes || null,
      producedAt: row.produced_at,
      createdBy: row.created_by || null,
      createdByName: row.created_by_name || null,
      createdAt: row.created_at
    };
  }
};

module.exports = productionService;
