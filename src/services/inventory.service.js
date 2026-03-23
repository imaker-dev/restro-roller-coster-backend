/**
 * Inventory Service
 * Handles inventory items, batches, movements, and stock management
 * Golden Rule: Never change stock directly — always use movements
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');
const unitService = require('./unit.service');

const inventoryService = {

  // ========================
  // INVENTORY CATEGORIES
  // ========================

  async listCategories(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1, limit = 50, search, isActive,
      sortBy = 'display_order', sortOrder = 'ASC'
    } = options;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['name', 'display_order', 'created_at', 'item_count'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'display_order';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let where = 'WHERE ic.outlet_id = ?';
    const params = [outletId];

    if (typeof isActive === 'boolean') {
      where += ' AND ic.is_active = ?';
      params.push(isActive ? 1 : 0);
    }
    if (search) {
      where += ' AND (ic.name LIKE ? OR ic.description LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM inventory_categories ic ${where}`, params
    );

    const orderClause = safeSortBy === 'item_count'
      ? `item_count ${safeSortOrder}, ic.name ASC`
      : `ic.${safeSortBy} ${safeSortOrder}, ic.name ASC`;

    const [rows] = await pool.query(
      `SELECT ic.*,
        (SELECT COUNT(*) FROM inventory_items ii WHERE ii.category_id = ic.id AND ii.is_active = 1) as item_count
       FROM inventory_categories ic ${where}
       ORDER BY ${orderClause}
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    return {
      categories: rows.map(r => ({
        id: r.id,
        outletId: r.outlet_id,
        name: r.name,
        description: r.description || null,
        displayOrder: r.display_order || 0,
        isActive: !!r.is_active,
        itemCount: parseInt(r.item_count) || 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit)
      }
    };
  },

  async createCategory(outletId, data) {
    const pool = getPool();
    if (!data.name) throw new Error('Category name is required');

    const [result] = await pool.query(
      `INSERT INTO inventory_categories (outlet_id, name, description, display_order)
       VALUES (?, ?, ?, ?)`,
      [outletId, data.name.trim(), data.description || null, data.displayOrder || 0]
    );

    return { id: result.insertId, outletId, name: data.name.trim(), description: data.description || null };
  },

  async updateCategory(id, data) {
    const pool = getPool();
    const fields = [];
    const params = [];

    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name.trim()); }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
    if (data.displayOrder !== undefined) { fields.push('display_order = ?'); params.push(data.displayOrder); }
    if (data.isActive !== undefined) { fields.push('is_active = ?'); params.push(data.isActive ? 1 : 0); }

    if (fields.length === 0) return null;

    params.push(id);
    await pool.query(`UPDATE inventory_categories SET ${fields.join(', ')} WHERE id = ?`, params);

    const [rows] = await pool.query('SELECT * FROM inventory_categories WHERE id = ?', [id]);
    return rows[0] || null;
  },

  async deleteCategory(id) {
    const pool = getPool();
    const [usage] = await pool.query(
      'SELECT COUNT(*) as count FROM inventory_items WHERE category_id = ?', [id]
    );
    if (usage[0].count > 0) {
      throw new Error('Cannot delete category with inventory items. Reassign or deactivate instead.');
    }
    await pool.query('DELETE FROM inventory_categories WHERE id = ?', [id]);
    return true;
  },

  // ========================
  // INVENTORY ITEMS
  // ========================

  async listItems(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1, limit = 50, search, categoryId, isActive,
      lowStock, sortBy = 'name', sortOrder = 'ASC'
    } = options;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['name', 'current_stock', 'average_price', 'latest_price', 'created_at'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'name';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let where = 'WHERE ii.outlet_id = ?';
    const params = [outletId];

    if (categoryId) {
      where += ' AND ii.category_id = ?';
      params.push(categoryId);
    }
    if (typeof isActive === 'boolean') {
      where += ' AND ii.is_active = ?';
      params.push(isActive ? 1 : 0);
    }
    if (search) {
      where += ' AND (ii.name LIKE ? OR ii.sku LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s);
    }
    if (lowStock) {
      // min_stock is in purchase unit (KG), current_stock is in base unit (grams)
      // Convert: current_stock <= min_stock * purchase_unit.conversion_factor
      where += ' AND ii.current_stock <= (ii.minimum_stock * COALESCE(pu_count.conversion_factor, 1)) AND ii.minimum_stock > 0';
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM inventory_items ii
       ${lowStock ? 'LEFT JOIN units pu_count ON ii.purchase_unit_id = pu_count.id' : ''}
       ${where}`, params
    );

    const [rows] = await pool.query(
      `SELECT ii.*, ic.name as category_name,
        bu.name as base_unit_name, bu.abbreviation as base_unit_abbreviation,
        COALESCE(pu.id, bu.id) as pu_id,
        COALESCE(pu.name, bu.name) as purchase_unit_name,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor,
        (SELECT COUNT(*) FROM inventory_batches ib WHERE ib.inventory_item_id = ii.id AND ib.remaining_quantity > 0 AND ib.is_active = 1) as active_batch_count
       FROM inventory_items ii
       LEFT JOIN inventory_categories ic ON ii.category_id = ic.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       ${where}
       ORDER BY ii.${safeSortBy} ${safeSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    // Fetch active batches for all returned items in one query
    const itemIds = rows.map(r => r.id);
    let batchMap = {};
    if (itemIds.length > 0) {
      const [allBatches] = await pool.query(
        `SELECT ib.*, v.name as vendor_name,
          COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
          COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor
         FROM inventory_batches ib
         LEFT JOIN vendors v ON ib.vendor_id = v.id
         LEFT JOIN inventory_items ii ON ib.inventory_item_id = ii.id
         LEFT JOIN units bu ON ii.base_unit_id = bu.id
         LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
         WHERE ib.inventory_item_id IN (${itemIds.map(() => '?').join(',')})
           AND ib.is_active = 1 AND ib.remaining_quantity > 0
         ORDER BY ib.purchase_date ASC, ib.id ASC`,
        itemIds
      );
      for (const b of allBatches) {
        if (!batchMap[b.inventory_item_id]) batchMap[b.inventory_item_id] = [];
        batchMap[b.inventory_item_id].push(this.formatBatch(b));
      }
    }

    // Summary stats — computed from ALL items in this outlet (unfiltered)
    const [[summary]] = await pool.query(
      `SELECT
        COUNT(*) as totalItems,
        COALESCE(SUM(CASE WHEN ii.is_active = 1 THEN 1 ELSE 0 END), 0) as activeItems,
        COALESCE(SUM(CASE WHEN ii.is_active = 0 THEN 1 ELSE 0 END), 0) as inactiveItems,
        COALESCE(SUM(CASE WHEN ii.current_stock <= 0 THEN 1 ELSE 0 END), 0) as zeroStockItems,
        COALESCE(SUM(CASE WHEN ii.minimum_stock > 0 AND ii.current_stock <= (ii.minimum_stock * COALESCE(pu_s.conversion_factor, 1)) THEN 1 ELSE 0 END), 0) as lowStockItems,
        COALESCE(SUM(ii.current_stock * ii.average_price), 0) as totalStockValue
       FROM inventory_items ii
       LEFT JOIN units pu_s ON ii.purchase_unit_id = pu_s.id
       WHERE ii.outlet_id = ?`,
      [outletId]
    );

    return {
      items: rows.map(r => ({
        ...this.formatItem(r),
        batches: batchMap[r.id] || []
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit)
      },
      summary: {
        totalItems: parseInt(summary.totalItems) || 0,
        activeItems: parseInt(summary.activeItems) || 0,
        inactiveItems: parseInt(summary.inactiveItems) || 0,
        zeroStockItems: parseInt(summary.zeroStockItems) || 0,
        lowStockItems: parseInt(summary.lowStockItems) || 0,
        totalStockValue: parseFloat(parseFloat(summary.totalStockValue).toFixed(2)) || 0
      }
    };
  },

  async getItemById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT ii.*, ic.name as category_name,
        bu.name as base_unit_name, bu.abbreviation as base_unit_abbreviation,
        bu.conversion_factor as base_unit_conversion_factor,
        COALESCE(pu.id, bu.id) as pu_id,
        COALESCE(pu.name, bu.name) as purchase_unit_name,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor,
        (SELECT COUNT(*) FROM inventory_batches ib WHERE ib.inventory_item_id = ii.id AND ib.remaining_quantity > 0 AND ib.is_active = 1) as active_batch_count
       FROM inventory_items ii
       LEFT JOIN inventory_categories ic ON ii.category_id = ic.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       WHERE ii.id = ?`,
      [id]
    );
    if (!rows[0]) return null;

    const item = this.formatItem(rows[0]);

    // Include active batches for detail view
    const [batches] = await pool.query(
      `SELECT ib.*, v.name as vendor_name,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor
       FROM inventory_batches ib
       LEFT JOIN vendors v ON ib.vendor_id = v.id
       LEFT JOIN inventory_items ii ON ib.inventory_item_id = ii.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       WHERE ib.inventory_item_id = ? AND ib.is_active = 1
       ORDER BY ib.purchase_date ASC, ib.id ASC`,
      [id]
    );

    const cf = parseFloat(rows[0].purchase_conversion_factor) || 1;
    const rawStock = parseFloat(rows[0].current_stock) || 0;
    const rawAvgPrice = parseFloat(rows[0].average_price) || 0;

    item.batches = batches.map(b => this.formatBatch(b));

    // Stock value summary
    const totalStockValue = parseFloat((rawStock * rawAvgPrice).toFixed(2));
    item.stockValue = {
      totalValue: totalStockValue,
      displayTotalValue: totalStockValue,
      activeBatches: item.batches.filter(b => !b.isExhausted).length,
      exhaustedBatches: item.batches.filter(b => b.isExhausted).length
    };

    // Internal pricing info (per system base unit — gram/ml/pcs)
    item.internalPricing = {
      baseUnitName: rows[0].base_unit_name,
      baseUnitAbbreviation: rows[0].base_unit_abbreviation,
      averagePricePerBaseUnit: rawAvgPrice,
      latestPricePerBaseUnit: parseFloat(rows[0].latest_price) || 0,
      currentStockInBaseUnit: rawStock,
      purchaseConversionFactor: cf
    };

    return item;
  },

  async createItem(outletId, data) {
    const pool = getPool();
    const {
      name, sku, categoryId, unitId, baseUnitId, minimumStock, maximumStock,
      description, isPerishable, shelfLifeDays
    } = data;

    if (!name) throw new Error('Item name is required');

    // unitId = the purchase/display unit (KG, L, pcs) — what the user selects
    // baseUnitId = legacy fallback (if unitId not provided)
    const purchaseUnitId = unitId || baseUnitId;
    if (!purchaseUnitId) throw new Error('Unit is required (unitId)');

    // Verify purchase unit exists
    const purchaseUnit = await unitService.getById(purchaseUnitId);
    if (!purchaseUnit) throw new Error('Invalid unit');

    // Auto-determine base unit (smallest unit of same type: gram for weight, ml for volume, pcs for count)
    let resolvedBaseUnitId;
    if (purchaseUnit.isBaseUnit) {
      // User selected a base unit directly (gram, ml, pcs)
      resolvedBaseUnitId = purchaseUnitId;
    } else {
      // Find the base unit of same unit_type for this outlet
      const [baseUnits] = await pool.query(
        'SELECT id FROM units WHERE outlet_id = ? AND unit_type = ? AND is_base_unit = 1 AND is_active = 1 LIMIT 1',
        [outletId, purchaseUnit.unitType]
      );
      if (!baseUnits[0]) throw new Error(`No base unit found for type "${purchaseUnit.unitType}". Seed default units first.`);
      resolvedBaseUnitId = baseUnits[0].id;
    }

    // Auto-generate SKU if not provided
    let generatedSku = sku || null;
    if (!generatedSku) {
      const date = new Date();
      const dateStr = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
      const randomSuffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      generatedSku = `SKU-${outletId}-${dateStr}-${randomSuffix}`;
    }

    // min/max stock stored in purchase unit as user entered (e.g., 10 KG, 100 KG)
    const [result] = await pool.query(
      `INSERT INTO inventory_items (
        outlet_id, name, sku, category_id, base_unit_id, purchase_unit_id,
        minimum_stock, maximum_stock, description, is_perishable, shelf_life_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outletId, name.trim(), generatedSku, categoryId || null,
        resolvedBaseUnitId, purchaseUnitId,
        minimumStock || 0, maximumStock || 0, description || null,
        isPerishable ? 1 : 0, shelfLifeDays || null
      ]
    );

    return this.getItemById(result.insertId);
  },

  async updateItem(id, data) {
    const pool = getPool();
    const fields = [];
    const params = [];

    // Handle unitId → updates both purchase_unit_id and base_unit_id
    if (data.unitId !== undefined) {
      const purchaseUnit = await unitService.getById(data.unitId);
      if (!purchaseUnit) throw new Error('Invalid unit');

      // Get item's outlet to find base unit
      const [[item]] = await pool.query('SELECT outlet_id FROM inventory_items WHERE id = ?', [id]);
      if (!item) throw new Error('Item not found');

      let resolvedBaseUnitId;
      if (purchaseUnit.isBaseUnit) {
        resolvedBaseUnitId = data.unitId;
      } else {
        const [baseUnits] = await pool.query(
          'SELECT id FROM units WHERE outlet_id = ? AND unit_type = ? AND is_base_unit = 1 AND is_active = 1 LIMIT 1',
          [item.outlet_id, purchaseUnit.unitType]
        );
        if (!baseUnits[0]) throw new Error(`No base unit found for type "${purchaseUnit.unitType}"`);
        resolvedBaseUnitId = baseUnits[0].id;
      }

      fields.push('purchase_unit_id = ?', 'base_unit_id = ?');
      params.push(data.unitId, resolvedBaseUnitId);
    }

    const fieldMap = {
      name: 'name', sku: 'sku', categoryId: 'category_id',
      minimumStock: 'minimum_stock', maximumStock: 'maximum_stock',
      description: 'description', isPerishable: 'is_perishable',
      shelfLifeDays: 'shelf_life_days', isActive: 'is_active'
    };

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = ?`);
        if (jsKey === 'isActive' || jsKey === 'isPerishable') {
          params.push(data[jsKey] ? 1 : 0);
        } else if (jsKey === 'name') {
          params.push(data[jsKey].trim());
        } else {
          params.push(data[jsKey]);
        }
      }
    }

    if (fields.length === 0) return this.getItemById(id);

    params.push(id);
    await pool.query(`UPDATE inventory_items SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.getItemById(id);
  },

  async deleteItem(id) {
    const pool = getPool();
    const item = await this.getItemById(id);
    if (!item) throw new Error('Item not found');
    if (item.currentStock > 0) {
      throw new Error('Cannot delete item with remaining stock. Adjust stock to 0 first.');
    }

    await pool.query('DELETE FROM inventory_items WHERE id = ?', [id]);
    return true;
  },

  // ========================
  // INVENTORY BATCHES
  // ========================

  async listBatches(inventoryItemId, options = {}) {
    const pool = getPool();
    const {
      activeOnly = false, page = 1, limit = 50,
      search, vendorId, startDate, endDate, expiringSoon, expired,
      sortBy = 'purchase_date', sortOrder = 'DESC'
    } = options;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['purchase_date', 'expiry_date', 'quantity', 'remaining_quantity', 'purchase_price', 'created_at'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'purchase_date';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let where = 'WHERE ib.inventory_item_id = ?';
    const params = [inventoryItemId];

    if (activeOnly) {
      where += ' AND ib.remaining_quantity > 0 AND ib.is_active = 1';
    }
    if (vendorId) {
      where += ' AND ib.vendor_id = ?';
      params.push(vendorId);
    }
    if (search) {
      where += ' AND (ib.batch_code LIKE ? OR v.name LIKE ? OR ib.notes LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (startDate) {
      where += ' AND ib.purchase_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND ib.purchase_date <= ?';
      params.push(endDate);
    }
    if (expiringSoon) {
      // Batches expiring within 7 days
      where += ' AND ib.expiry_date IS NOT NULL AND ib.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) AND ib.expiry_date >= CURDATE()';
    }
    if (expired) {
      where += ' AND ib.expiry_date IS NOT NULL AND ib.expiry_date < CURDATE()';
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM inventory_batches ib
       LEFT JOIN vendors v ON ib.vendor_id = v.id
       ${where}`, params
    );

    const [rows] = await pool.query(
      `SELECT ib.*, v.name as vendor_name,
        bu.abbreviation as unit_abbreviation,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor
       FROM inventory_batches ib
       LEFT JOIN vendors v ON ib.vendor_id = v.id
       LEFT JOIN inventory_items ii ON ib.inventory_item_id = ii.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       ${where}
       ORDER BY ib.${safeSortBy} ${safeSortOrder}, ib.id DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    return {
      batches: rows.map(r => this.formatBatch(r)),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) }
    };
  },

  async getBatchById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT ib.*, v.name as vendor_name,
        bu.abbreviation as unit_abbreviation,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor
       FROM inventory_batches ib
       LEFT JOIN vendors v ON ib.vendor_id = v.id
       LEFT JOIN inventory_items ii ON ib.inventory_item_id = ii.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       WHERE ib.id = ?`,
      [id]
    );
    return rows[0] ? this.formatBatch(rows[0]) : null;
  },

  /**
   * Create a batch and record purchase movement
   * Called internally by purchase service — not directly by API
   */
  async createBatch(connection, {
    inventoryItemId, outletId, batchCode, quantity, purchasePrice,
    purchaseDate, expiryDate, vendorId, purchaseItemId, userId
  }) {
    // Insert batch
    const [batchResult] = await connection.query(
      `INSERT INTO inventory_batches (
        inventory_item_id, outlet_id, batch_code, quantity, remaining_quantity,
        purchase_price, purchase_date, expiry_date, vendor_id, purchase_item_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        inventoryItemId, outletId, batchCode, quantity, quantity,
        purchasePrice, purchaseDate, expiryDate || null, vendorId || null, purchaseItemId || null
      ]
    );

    const batchId = batchResult.insertId;

    // Get current stock before update
    const [[item]] = await connection.query(
      'SELECT current_stock, average_price FROM inventory_items WHERE id = ? FOR UPDATE',
      [inventoryItemId]
    );
    const balanceBefore = parseFloat(item.current_stock) || 0;
    const oldAvgPrice = parseFloat(item.average_price) || 0;

    // Calculate new weighted average price
    // new_avg = ((old_qty × old_avg) + (new_qty × new_price)) / (old_qty + new_qty)
    const newTotalQty = balanceBefore + quantity;
    let newAvgPrice = purchasePrice;
    if (newTotalQty > 0 && balanceBefore > 0) {
      newAvgPrice = ((balanceBefore * oldAvgPrice) + (quantity * purchasePrice)) / newTotalQty;
    }
    newAvgPrice = parseFloat(newAvgPrice.toFixed(6));

    const balanceAfter = balanceBefore + quantity;

    // Update inventory item stock, average price, and latest price
    await connection.query(
      `UPDATE inventory_items SET
        current_stock = current_stock + ?,
        average_price = ?,
        latest_price = ?
       WHERE id = ?`,
      [quantity, newAvgPrice, purchasePrice, inventoryItemId]
    );

    // Record purchase movement
    await connection.query(
      `INSERT INTO inventory_movements (
        outlet_id, inventory_item_id, inventory_batch_id, movement_type,
        quantity, quantity_in_base, unit_cost, total_cost,
        balance_before, balance_after, reference_type, reference_id, created_by
      ) VALUES (?, ?, ?, 'purchase', ?, ?, ?, ?, ?, ?, 'purchase_item', ?, ?)`,
      [
        outletId, inventoryItemId, batchId,
        quantity, quantity, purchasePrice, parseFloat((quantity * purchasePrice).toFixed(2)),
        balanceBefore, balanceAfter, purchaseItemId || null, userId || null
      ]
    );

    return { batchId, balanceBefore, balanceAfter, newAvgPrice };
  },

  // ========================
  // INVENTORY MOVEMENTS
  // ========================

  async listMovements(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1, limit = 50, inventoryItemId, movementType,
      startDate, endDate, batchId, search, createdBy,
      sortBy = 'created_at', sortOrder = 'DESC'
    } = options;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['created_at', 'quantity', 'movement_type', 'balance_after'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'created_at';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let where = 'WHERE im.outlet_id = ?';
    const params = [outletId];

    if (inventoryItemId) {
      where += ' AND im.inventory_item_id = ?';
      params.push(inventoryItemId);
    }
    if (movementType) {
      where += ' AND im.movement_type = ?';
      params.push(movementType);
    }
    if (batchId) {
      where += ' AND im.inventory_batch_id = ?';
      params.push(batchId);
    }
    if (startDate) {
      where += ' AND DATE(im.created_at) >= ?';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND DATE(im.created_at) <= ?';
      params.push(endDate);
    }
    if (createdBy) {
      where += ' AND im.created_by = ?';
      params.push(createdBy);
    }
    if (search) {
      where += ' AND (ii.name LIKE ? OR ib.batch_code LIKE ? OR im.notes LIKE ? OR usr.name LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM inventory_movements im
       LEFT JOIN inventory_items ii ON im.inventory_item_id = ii.id
       LEFT JOIN inventory_batches ib ON im.inventory_batch_id = ib.id
       LEFT JOIN users usr ON im.created_by = usr.id
       ${where}`, params
    );

    const [rows] = await pool.query(
      `SELECT im.*, ii.name as item_name, bu.abbreviation as unit_abbreviation,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor,
        ib.batch_code, usr.name as created_by_name
       FROM inventory_movements im
       LEFT JOIN inventory_items ii ON im.inventory_item_id = ii.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       LEFT JOIN inventory_batches ib ON im.inventory_batch_id = ib.id
       LEFT JOIN users usr ON im.created_by = usr.id
       ${where}
       ORDER BY im.${safeSortBy} ${safeSortOrder}, im.id DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    // Summary stats — computed from ALL movements in this outlet
    // movement_type ENUM: purchase, sale, production, wastage, adjustment,
    //                      production_in, production_out, production_reversal, sale_reversal
    const [[movSummary]] = await pool.query(
      `SELECT
        COUNT(*) as totalMovements,
        COALESCE(SUM(CASE WHEN im.movement_type = 'purchase' THEN 1 ELSE 0 END), 0) as purchaseCount,
        COALESCE(SUM(CASE WHEN im.movement_type = 'sale' THEN 1 ELSE 0 END), 0) as saleCount,
        COALESCE(SUM(CASE WHEN im.movement_type = 'sale_reversal' THEN 1 ELSE 0 END), 0) as saleReversalCount,
        COALESCE(SUM(CASE WHEN im.movement_type = 'adjustment' THEN 1 ELSE 0 END), 0) as adjustmentCount,
        COALESCE(SUM(CASE WHEN im.movement_type = 'wastage' THEN 1 ELSE 0 END), 0) as wastageCount,
        COALESCE(SUM(CASE WHEN im.movement_type IN ('production', 'production_in', 'production_out', 'production_reversal') THEN 1 ELSE 0 END), 0) as productionCount,
        COALESCE(SUM(CASE WHEN im.quantity > 0 THEN im.quantity ELSE 0 END), 0) as totalInward,
        COALESCE(SUM(CASE WHEN im.quantity < 0 THEN ABS(im.quantity) ELSE 0 END), 0) as totalOutward
       FROM inventory_movements im
       WHERE im.outlet_id = ?`,
      [outletId]
    );

    return {
      movements: rows.map(r => this.formatMovement(r)),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
      summary: {
        totalMovements: parseInt(movSummary.totalMovements) || 0,
        purchaseCount: parseInt(movSummary.purchaseCount) || 0,
        saleCount: parseInt(movSummary.saleCount) || 0,
        saleReversalCount: parseInt(movSummary.saleReversalCount) || 0,
        adjustmentCount: parseInt(movSummary.adjustmentCount) || 0,
        wastageCount: parseInt(movSummary.wastageCount) || 0,
        productionCount: parseInt(movSummary.productionCount) || 0,
        totalInward: parseFloat(parseFloat(movSummary.totalInward).toFixed(4)) || 0,
        totalOutward: parseFloat(parseFloat(movSummary.totalOutward).toFixed(4)) || 0
      }
    };
  },

  /**
   * Record a stock adjustment (increase or decrease) on a SPECIFIC batch
   * Positive quantity = increase batch, negative = decrease batch
   * batchId is REQUIRED — user must specify which batch to adjust
   */
  async recordAdjustment(outletId, data, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const { inventoryItemId, batchId, quantity, reason } = data;
      if (!inventoryItemId || quantity === undefined || quantity === 0) {
        throw new Error('inventoryItemId and non-zero quantity are required');
      }
      if (!batchId) {
        throw new Error('batchId is required — you must specify which batch to adjust');
      }

      // Get item with purchase unit conversion factor
      const [[item]] = await connection.query(
        `SELECT ii.id, ii.current_stock, ii.purchase_unit_id, ii.base_unit_id,
                COALESCE(pu.conversion_factor, 1) as purchase_cf
         FROM inventory_items ii
         LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
         WHERE ii.id = ? AND ii.outlet_id = ? FOR UPDATE`,
        [inventoryItemId, outletId]
      );
      if (!item) throw new Error('Inventory item not found');

      // Verify batch belongs to this item
      const [[batch]] = await connection.query(
        `SELECT id, remaining_quantity, batch_code FROM inventory_batches
         WHERE id = ? AND inventory_item_id = ? AND is_active = 1 FOR UPDATE`,
        [batchId, inventoryItemId]
      );
      if (!batch) throw new Error('Batch not found or does not belong to this inventory item');

      const cf = parseFloat(item.purchase_cf) || 1;
      // User sends quantity in purchase unit (e.g., 5 KG) → convert to base (5000 g)
      const qtyInBase = quantity * cf;

      const batchRemaining = parseFloat(batch.remaining_quantity);
      const newBatchRemaining = batchRemaining + qtyInBase;

      // Validate batch won't go negative
      if (newBatchRemaining < 0) {
        const displayRemaining = parseFloat((batchRemaining / cf).toFixed(4));
        throw new Error(`Adjustment would result in negative batch quantity (batch ${batch.batch_code} has ${displayRemaining}, adjustment: ${quantity})`);
      }

      const balanceBefore = parseFloat(item.current_stock);
      const balanceAfter = balanceBefore + qtyInBase;

      // Validate total stock won't go negative
      if (balanceAfter < 0) {
        const displayBefore = parseFloat((balanceBefore / cf).toFixed(4));
        throw new Error(`Adjustment would result in negative stock (current: ${displayBefore}, adjustment: ${quantity})`);
      }

      // Update batch remaining quantity
      await connection.query(
        'UPDATE inventory_batches SET remaining_quantity = ? WHERE id = ?',
        [newBatchRemaining, batchId]
      );

      // Update item total stock (base unit)
      await connection.query(
        'UPDATE inventory_items SET current_stock = ? WHERE id = ?',
        [balanceAfter, inventoryItemId]
      );

      // Record movement (base unit internally)
      await connection.query(
        `INSERT INTO inventory_movements (
          outlet_id, inventory_item_id, inventory_batch_id, movement_type,
          quantity, quantity_in_base, balance_before, balance_after,
          notes, created_by
        ) VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, ?, ?)`,
        [outletId, inventoryItemId, batchId, qtyInBase, qtyInBase, balanceBefore, balanceAfter, reason || null, userId]
      );

      await connection.commit();

      // Return in purchase unit
      return {
        inventoryItemId,
        batchId,
        batchCode: batch.batch_code,
        adjustment: quantity,
        batchRemainingBefore: parseFloat((batchRemaining / cf).toFixed(4)),
        batchRemainingAfter: parseFloat((newBatchRemaining / cf).toFixed(4)),
        stockBefore: parseFloat((balanceBefore / cf).toFixed(4)),
        stockAfter: parseFloat((balanceAfter / cf).toFixed(4)),
        movementType: 'adjustment'
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Record wastage
   */
  async recordWastage(outletId, data, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const { inventoryItemId, quantity, reason, batchId: specificBatchId } = data;
      if (!inventoryItemId || !quantity || quantity <= 0) {
        throw new Error('inventoryItemId and positive quantity are required');
      }

      // Get item with purchase unit conversion factor
      const [[item]] = await connection.query(
        `SELECT ii.id, ii.current_stock, ii.purchase_unit_id, ii.base_unit_id,
                COALESCE(pu.conversion_factor, 1) as purchase_cf
         FROM inventory_items ii
         LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
         WHERE ii.id = ? AND ii.outlet_id = ? FOR UPDATE`,
        [inventoryItemId, outletId]
      );
      if (!item) throw new Error('Inventory item not found');

      const cf = parseFloat(item.purchase_cf) || 1;
      // User sends quantity in purchase unit (e.g., 2 KG) → convert to base (2000 g)
      const qtyInBase = quantity * cf;

      const balanceBefore = parseFloat(item.current_stock);
      if (qtyInBase > balanceBefore) {
        const displayBefore = parseFloat((balanceBefore / cf).toFixed(4));
        throw new Error(`Wastage quantity (${quantity}) exceeds current stock (${displayBefore})`);
      }

      const balanceAfter = balanceBefore - qtyInBase;

      // Deduct from specific batch or FIFO (base unit)
      let batchId = specificBatchId || null;
      if (specificBatchId) {
        await this._deductFromSpecificBatch(connection, specificBatchId, qtyInBase);
      } else {
        batchId = await this._deductFromBatches(connection, inventoryItemId, qtyInBase);
      }

      // Update stock (base unit)
      await connection.query(
        'UPDATE inventory_items SET current_stock = ? WHERE id = ?',
        [balanceAfter, inventoryItemId]
      );

      // Record movement (base unit internally)
      await connection.query(
        `INSERT INTO inventory_movements (
          outlet_id, inventory_item_id, inventory_batch_id, movement_type,
          quantity, quantity_in_base, balance_before, balance_after,
          notes, created_by
        ) VALUES (?, ?, ?, 'wastage', ?, ?, ?, ?, ?, ?)`,
        [outletId, inventoryItemId, batchId, -qtyInBase, -qtyInBase, balanceBefore, balanceAfter, reason || null, userId]
      );

      await connection.commit();

      // Return in purchase unit
      return {
        inventoryItemId,
        wastageQuantity: quantity,
        balanceBefore: parseFloat((balanceBefore / cf).toFixed(4)),
        balanceAfter: parseFloat((balanceAfter / cf).toFixed(4)),
        movementType: 'wastage'
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ========================
  // BATCH DEDUCTION (FIFO)
  // ========================

  /**
   * Deduct quantity from batches using FIFO (oldest first)
   * Returns the first batch ID used
   */
  async _deductFromBatches(connection, inventoryItemId, quantity) {
    const [batches] = await connection.query(
      `SELECT id, remaining_quantity FROM inventory_batches
       WHERE inventory_item_id = ? AND remaining_quantity > 0 AND is_active = 1
       ORDER BY purchase_date ASC, id ASC
       FOR UPDATE`,
      [inventoryItemId]
    );

    let remaining = quantity;
    let firstBatchId = null;

    for (const batch of batches) {
      if (remaining <= 0) break;

      const batchQty = parseFloat(batch.remaining_quantity);
      const deduct = Math.min(remaining, batchQty);

      if (!firstBatchId) firstBatchId = batch.id;

      await connection.query(
        'UPDATE inventory_batches SET remaining_quantity = remaining_quantity - ? WHERE id = ?',
        [deduct, batch.id]
      );

      remaining -= deduct;
    }

    // If remaining > 0, stock was insufficient in batches but we allow it
    // (stock might have been manually adjusted without batches)
    return firstBatchId;
  },

  /**
   * Deduct from a specific batch
   */
  async _deductFromSpecificBatch(connection, batchId, quantity) {
    const [[batch]] = await connection.query(
      'SELECT remaining_quantity FROM inventory_batches WHERE id = ?', [batchId]
    );
    if (!batch) throw new Error('Batch not found');
    if (parseFloat(batch.remaining_quantity) < quantity) {
      throw new Error(`Batch has only ${batch.remaining_quantity} remaining, cannot deduct ${quantity}`);
    }

    await connection.query(
      'UPDATE inventory_batches SET remaining_quantity = remaining_quantity - ? WHERE id = ?',
      [quantity, batchId]
    );
  },

  // ========================
  // STOCK SUMMARY / REPORTS
  // ========================

  async getStockSummary(outletId, options = {}) {
    const pool = getPool();
    const {
      categoryId, search, lowStockOnly, zeroStock, hasStock,
      sortBy = 'name', sortOrder = 'ASC'
    } = options;

    const allowedSort = ['name', 'current_stock', 'stock_value', 'average_price', 'category_name'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'name';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let where = 'WHERE ii.outlet_id = ? AND ii.is_active = 1';
    const params = [outletId];

    if (categoryId) {
      where += ' AND ii.category_id = ?';
      params.push(categoryId);
    }
    if (search) {
      where += ' AND (ii.name LIKE ? OR ii.sku LIKE ? OR ic.name LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    if (zeroStock) {
      where += ' AND ii.current_stock = 0';
    }
    if (hasStock) {
      where += ' AND ii.current_stock > 0';
    }

    const orderClause = safeSortBy === 'category_name'
      ? `ic.name ${safeSortOrder}, ii.name ASC`
      : safeSortBy === 'stock_value'
        ? `(ii.current_stock * ii.average_price) ${safeSortOrder}`
        : `ii.${safeSortBy} ${safeSortOrder}`;

    const [rows] = await pool.query(
      `SELECT ii.*, ic.name as category_name,
        bu.name as base_unit_name, bu.abbreviation as base_unit_abbreviation,
        COALESCE(pu.id, bu.id) as pu_id,
        COALESCE(pu.name, bu.name) as purchase_unit_name,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor,
        (SELECT COUNT(*) FROM inventory_batches ib WHERE ib.inventory_item_id = ii.id AND ib.remaining_quantity > 0 AND ib.is_active = 1) as active_batch_count,
        (ii.current_stock * ii.average_price) as stock_value
       FROM inventory_items ii
       LEFT JOIN inventory_categories ic ON ii.category_id = ic.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       ${where}
       ORDER BY ${orderClause}`,
      params
    );

    // Filter low stock items (needs conversion factor check)
    let filteredRows = rows;
    if (lowStockOnly) {
      filteredRows = rows.filter(r => {
        const cf = parseFloat(r.purchase_conversion_factor) || 1;
        const displayStock = (parseFloat(r.current_stock) || 0) / cf;
        const minStock = parseFloat(r.minimum_stock) || 0;
        return minStock > 0 && displayStock <= minStock;
      });
    }

    const totalItems = filteredRows.length;
    const totalStockValue = filteredRows.reduce((s, r) => s + (parseFloat(r.stock_value) || 0), 0);
    const lowStockItems = rows.filter(r => {
      const cf = parseFloat(r.purchase_conversion_factor) || 1;
      const displayStock = (parseFloat(r.current_stock) || 0) / cf;
      const minStock = parseFloat(r.minimum_stock) || 0;
      return minStock > 0 && displayStock <= minStock;
    });

    return {
      items: filteredRows.map(r => ({
        ...this.formatItem(r),
        stockValue: parseFloat((parseFloat(r.stock_value) || 0).toFixed(2))
      })),
      summary: {
        totalItems,
        totalStockValue: parseFloat(totalStockValue.toFixed(2)),
        lowStockCount: lowStockItems.length,
        lowStockItems: lowStockItems.map(r => {
          const cf = parseFloat(r.purchase_conversion_factor) || 1;
          return {
            id: r.id,
            name: r.name,
            currentStock: parseFloat(((parseFloat(r.current_stock) || 0) / cf).toFixed(4)),
            minimumStock: parseFloat(r.minimum_stock) || 0,
            unitAbbreviation: r.purchase_unit_abbreviation || r.base_unit_abbreviation
          };
        })
      }
    };
  },

  /**
   * Get stock ledger for a specific item (all movements)
   */
  async getStockLedger(inventoryItemId, options = {}) {
    const pool = getPool();
    const { startDate, endDate, page = 1, limit = 100 } = options;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(200, Math.max(1, parseInt(limit) || 100));
    const offset = (safePage - 1) * safeLimit;

    let where = 'WHERE im.inventory_item_id = ?';
    const params = [inventoryItemId];

    if (startDate) { where += ' AND DATE(im.created_at) >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND DATE(im.created_at) <= ?'; params.push(endDate); }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM inventory_movements im ${where}`, params
    );

    const [rows] = await pool.query(
      `SELECT im.*, ii.name as item_name,
        bu.abbreviation as unit_abbreviation,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor,
        ib.batch_code, usr.name as created_by_name
       FROM inventory_movements im
       LEFT JOIN inventory_items ii ON im.inventory_item_id = ii.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       LEFT JOIN inventory_batches ib ON im.inventory_batch_id = ib.id
       LEFT JOIN users usr ON im.created_by = usr.id
       ${where}
       ORDER BY im.created_at DESC, im.id DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    // Get item info
    const item = await this.getItemById(inventoryItemId);

    return {
      item,
      ledger: rows.map(r => this.formatMovement(r)),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) }
    };
  },

  // ========================
  // FORMAT HELPERS
  // ========================

  formatItem(row) {
    if (!row) return null;

    // conversion_factor: how many base units per 1 purchase unit (e.g., 1000 for KG→g)
    const cf = parseFloat(row.purchase_conversion_factor) || 1;
    const rawStock = parseFloat(row.current_stock) || 0;
    const rawAvgPrice = parseFloat(row.average_price) || 0;
    const rawLatestPrice = parseFloat(row.latest_price) || 0;
    const minStock = parseFloat(row.minimum_stock) || 0; // already in purchase unit

    // Convert base → purchase unit for display
    const displayStock = parseFloat((rawStock / cf).toFixed(4));
    const displayAvgPrice = parseFloat((rawAvgPrice * cf).toFixed(2));
    const displayLatestPrice = parseFloat((rawLatestPrice * cf).toFixed(2));

    return {
      id: row.id,
      outletId: row.outlet_id,
      name: row.name,
      sku: row.sku || null,
      categoryId: row.category_id || null,
      categoryName: row.category_name || null,
      unitId: row.pu_id || row.purchase_unit_id || row.base_unit_id,
      unitName: row.purchase_unit_name || row.base_unit_name || row.unit_name || null,
      unitAbbreviation: row.purchase_unit_abbreviation || row.base_unit_abbreviation || row.unit_abbreviation || null,
      currentStock: displayStock,
      latestPrice: displayLatestPrice,
      averagePrice: displayAvgPrice,
      minimumStock: minStock,
      maximumStock: parseFloat(row.maximum_stock) || 0,
      description: row.description || null,
      isPerishable: !!row.is_perishable,
      shelfLifeDays: row.shelf_life_days || null,
      isActive: !!row.is_active,
      activeBatchCount: parseInt(row.active_batch_count) || 0,
      isLowStock: minStock > 0 && displayStock <= minStock,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  },

  formatBatch(row) {
    if (!row) return null;
    // Convert batch quantities/prices from base to purchase unit
    const cf = parseFloat(row.purchase_conversion_factor) || 1;
    const rawQty = parseFloat(row.quantity) || 0;
    const rawRemaining = parseFloat(row.remaining_quantity) || 0;
    const rawPrice = parseFloat(row.purchase_price) || 0;

    return {
      id: row.id,
      inventoryItemId: row.inventory_item_id,
      outletId: row.outlet_id,
      batchCode: row.batch_code,
      quantity: parseFloat((rawQty / cf).toFixed(4)),
      remainingQuantity: parseFloat((rawRemaining / cf).toFixed(4)),
      purchasePrice: parseFloat((rawPrice * cf).toFixed(2)),
      purchaseDate: row.purchase_date,
      expiryDate: row.expiry_date || null,
      vendorId: row.vendor_id || null,
      vendorName: row.vendor_name || null,
      unitAbbreviation: row.purchase_unit_abbreviation || row.unit_abbreviation || null,
      purchaseItemId: row.purchase_item_id || null,
      notes: row.notes || null,
      isActive: !!row.is_active,
      isExhausted: rawRemaining <= 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  },

  formatMovement(row) {
    if (!row) return null;
    // Convert from base to purchase unit for display
    const cf = parseFloat(row.purchase_conversion_factor) || 1;
    const rawQty = parseFloat(row.quantity) || 0;
    const rawBefore = parseFloat(row.balance_before) || 0;
    const rawAfter = parseFloat(row.balance_after) || 0;
    const rawUnitCost = parseFloat(row.unit_cost) || 0;

    return {
      id: row.id,
      outletId: row.outlet_id,
      inventoryItemId: row.inventory_item_id,
      itemName: row.item_name || null,
      inventoryBatchId: row.inventory_batch_id || null,
      batchCode: row.batch_code || null,
      movementType: row.movement_type,
      quantity: parseFloat((rawQty / cf).toFixed(4)),
      unitAbbreviation: row.purchase_unit_abbreviation || row.unit_abbreviation || null,
      unitCost: parseFloat((rawUnitCost * cf).toFixed(2)),
      totalCost: parseFloat(row.total_cost) || 0,
      balanceBefore: parseFloat((rawBefore / cf).toFixed(4)),
      balanceAfter: parseFloat((rawAfter / cf).toFixed(4)),
      referenceType: row.reference_type || null,
      referenceId: row.reference_id || null,
      notes: row.notes || null,
      createdBy: row.created_by || null,
      createdByName: row.created_by_name || null,
      createdAt: row.created_at
    };
  }
};

module.exports = inventoryService;
