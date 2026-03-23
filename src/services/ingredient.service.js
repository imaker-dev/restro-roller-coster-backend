/**
 * Ingredient Service — Module 5
 * Ingredients bridge inventory items to recipes
 * Each ingredient maps 1:1 to an inventory item with yield/wastage info
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');

const ingredientService = {

  // ========================
  // LIST
  // ========================

  async list(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1, limit = 50, search, isActive, categoryId,
      hasRecipes, sortBy = 'name', sortOrder = 'ASC'
    } = options;

    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['name', 'created_at', 'updated_at', 'yield_percentage'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'name';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let where = 'WHERE ing.outlet_id = ?';
    const params = [outletId];

    if (typeof isActive === 'boolean') {
      where += ' AND ing.is_active = ?';
      params.push(isActive ? 1 : 0);
    }
    if (categoryId) {
      where += ' AND (ii.category_id = ? OR ing.category = ?)';
      params.push(categoryId, categoryId);
    }
    if (search) {
      where += ' AND (ing.name LIKE ? OR ing.sku LIKE ? OR COALESCE(ii.name, \'\') LIKE ? OR COALESCE(ii.sku, \'\') LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    let havingClause = '';
    if (typeof hasRecipes === 'boolean') {
      havingClause = hasRecipes ? 'HAVING recipe_count > 0' : 'HAVING recipe_count = 0';
    }

    // Count query
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM (
        SELECT ing.id,
          (SELECT COUNT(DISTINCT ri.recipe_id) FROM recipe_ingredients ri WHERE ri.ingredient_id = ing.id) as recipe_count
        FROM ingredients ing
        LEFT JOIN inventory_items ii ON ing.inventory_item_id = ii.id
        ${where} ${havingClause}
      ) as filtered`, params
    );

    const [rows] = await pool.query(
      `SELECT ing.*,
        ii.name as inventory_item_name, ii.sku as inventory_item_sku,
        ii.category_id,
        ic.name as category_name,
        bu.name as base_unit_name, bu.abbreviation as base_unit_abbreviation,
        COALESCE(pu.name, bu.name) as purchase_unit_name,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        (SELECT COUNT(DISTINCT ri.recipe_id) FROM recipe_ingredients ri WHERE ri.ingredient_id = ing.id) as recipe_count
       FROM ingredients ing
       LEFT JOIN inventory_items ii ON ing.inventory_item_id = ii.id
       LEFT JOIN inventory_categories ic ON ii.category_id = ic.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       ${where}
       ${havingClause}
       ORDER BY ing.${safeSortBy} ${safeSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    // Summary stats — computed from ALL ingredients in this outlet
    // Use LEFT JOIN + COUNT(DISTINCT) instead of correlated EXISTS subqueries for accuracy
    const [[ingSummary]] = await pool.query(
      `SELECT
        COUNT(*) as totalIngredients,
        COALESCE(SUM(CASE WHEN ing.is_active = 1 THEN 1 ELSE 0 END), 0) as activeIngredients,
        COALESCE(SUM(CASE WHEN ing.is_active = 0 THEN 1 ELSE 0 END), 0) as inactiveIngredients,
        COALESCE(SUM(CASE WHEN ing.inventory_item_id IS NOT NULL THEN 1 ELSE 0 END), 0) as mappedToInventory,
        COALESCE(SUM(CASE WHEN ing.inventory_item_id IS NULL THEN 1 ELSE 0 END), 0) as unmappedToInventory
       FROM ingredients ing
       WHERE ing.outlet_id = ?`,
      [outletId]
    );
    // Separate query for recipe linkage (avoids double-counting from JOINs)
    const [[recipeLinkage]] = await pool.query(
      `SELECT
        COUNT(DISTINCT ri.ingredient_id) as linkedToRecipes
       FROM recipe_ingredients ri
       JOIN ingredients ing ON ri.ingredient_id = ing.id
       WHERE ing.outlet_id = ?`,
      [outletId]
    );
    const totalIng = parseInt(ingSummary.totalIngredients) || 0;
    const linked = parseInt(recipeLinkage.linkedToRecipes) || 0;

    return {
      ingredients: rows.map(r => this.format(r)),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) },
      summary: {
        totalIngredients: totalIng,
        activeIngredients: parseInt(ingSummary.activeIngredients) || 0,
        inactiveIngredients: parseInt(ingSummary.inactiveIngredients) || 0,
        linkedToRecipes: linked,
        notLinkedToRecipes: totalIng - linked,
        mappedToInventory: parseInt(ingSummary.mappedToInventory) || 0,
        unmappedToInventory: parseInt(ingSummary.unmappedToInventory) || 0
      }
    };
  },

  // ========================
  // GET BY ID
  // ========================

  async getById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT ing.*,
        ii.name as inventory_item_name, ii.sku as inventory_item_sku,
        ii.category_id,
        ic.name as category_name,
        bu.name as base_unit_name, bu.abbreviation as base_unit_abbreviation,
        COALESCE(pu.name, bu.name) as purchase_unit_name,
        COALESCE(pu.abbreviation, bu.abbreviation) as purchase_unit_abbreviation,
        (SELECT COUNT(DISTINCT ri.recipe_id) FROM recipe_ingredients ri WHERE ri.ingredient_id = ing.id) as recipe_count
       FROM ingredients ing
       LEFT JOIN inventory_items ii ON ing.inventory_item_id = ii.id
       LEFT JOIN inventory_categories ic ON ii.category_id = ic.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
       WHERE ing.id = ?`,
      [id]
    );
    return rows[0] ? this.format(rows[0]) : null;
  },

  // ========================
  // CREATE
  // ========================

  async create(outletId, data) {
    const pool = getPool();
    const {
      inventoryItemId, name, description,
      yieldPercentage = 100, wastagePercentage = 0, preparationNotes
    } = data;

    if (!inventoryItemId) throw new Error('inventoryItemId is required');

    // Verify inventory item exists and belongs to this outlet
    const [[item]] = await pool.query(
      'SELECT id, name FROM inventory_items WHERE id = ? AND outlet_id = ?',
      [inventoryItemId, outletId]
    );
    if (!item) throw new Error('Inventory item not found in this outlet');

    // Check for duplicate mapping
    const [[existing]] = await pool.query(
      'SELECT id FROM ingredients WHERE outlet_id = ? AND inventory_item_id = ?',
      [outletId, inventoryItemId]
    );
    if (existing) throw new Error('An ingredient already exists for this inventory item');

    const ingredientName = name || item.name;

    const [result] = await pool.query(
      `INSERT INTO ingredients (outlet_id, inventory_item_id, name, description, yield_percentage, wastage_percentage, preparation_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [outletId, inventoryItemId, ingredientName.trim(), description || null,
       yieldPercentage, wastagePercentage, preparationNotes || null]
    );

    return this.getById(result.insertId);
  },

  // ========================
  // UPDATE
  // ========================

  async update(id, data) {
    const pool = getPool();
    const fields = [];
    const params = [];

    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name.trim()); }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description || null); }
    if (data.yieldPercentage !== undefined) { fields.push('yield_percentage = ?'); params.push(data.yieldPercentage); }
    if (data.wastagePercentage !== undefined) { fields.push('wastage_percentage = ?'); params.push(data.wastagePercentage); }
    if (data.preparationNotes !== undefined) { fields.push('preparation_notes = ?'); params.push(data.preparationNotes || null); }
    if (data.isActive !== undefined) { fields.push('is_active = ?'); params.push(data.isActive ? 1 : 0); }

    if (fields.length === 0) throw new Error('No fields to update');

    params.push(id);
    await pool.query(`UPDATE ingredients SET ${fields.join(', ')} WHERE id = ?`, params);

    return this.getById(id);
  },

  // ========================
  // BULK CREATE — create ingredients from inventory items with per-item details
  // ========================

  async bulkCreateFromInventory(outletId, items) {
    const pool = getPool();
    const created = [];
    const skipped = [];

    for (let i = 0; i < items.length; i++) {
      const entry = items[i];
      // Support both { inventoryItemId, name, ... } objects and plain IDs
      const itemId = typeof entry === 'object' ? entry.inventoryItemId : entry;
      const details = typeof entry === 'object' ? entry : {};

      if (!itemId) {
        skipped.push({ index: i, reason: 'Missing inventoryItemId' });
        continue;
      }

      // Check duplicate
      const [[existing]] = await pool.query(
        'SELECT id FROM ingredients WHERE outlet_id = ? AND inventory_item_id = ?',
        [outletId, itemId]
      );
      if (existing) {
        skipped.push({ inventoryItemId: itemId, reason: 'Already mapped', existingIngredientId: existing.id });
        continue;
      }

      // Verify inventory item
      const [[invItem]] = await pool.query(
        'SELECT id, name FROM inventory_items WHERE id = ? AND outlet_id = ? AND is_active = 1',
        [itemId, outletId]
      );
      if (!invItem) {
        skipped.push({ inventoryItemId: itemId, reason: 'Inventory item not found or inactive' });
        continue;
      }

      const name = (details.name || invItem.name).trim();
      const yieldPct = details.yieldPercentage != null ? details.yieldPercentage : 100;
      const wastagePct = details.wastagePercentage != null ? details.wastagePercentage : 0;
      const desc = details.description || null;
      const notes = details.preparationNotes || null;

      const [result] = await pool.query(
        `INSERT INTO ingredients (outlet_id, inventory_item_id, name, description, yield_percentage, wastage_percentage, preparation_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [outletId, itemId, name, desc, yieldPct, wastagePct, notes]
      );
      created.push({ id: result.insertId, inventoryItemId: itemId, name });
    }

    return { created: created.length, skipped: skipped.length, ingredients: created, skippedDetails: skipped };
  },

  // ========================
  // FORMAT
  // ========================

  format(row) {
    if (!row) return null;

    return {
      id: row.id,
      outletId: row.outlet_id,
      inventoryItemId: row.inventory_item_id || null,
      inventoryItemName: row.inventory_item_name || null,
      inventoryItemSku: row.inventory_item_sku || null,
      categoryId: row.category_id || null,
      categoryName: row.category_name || row.category || null,
      name: row.name,
      description: row.description || null,
      yieldPercentage: parseFloat(row.yield_percentage) || 100,
      wastagePercentage: parseFloat(row.wastage_percentage) || 0,
      preparationNotes: row.preparation_notes || null,
      unitName: row.purchase_unit_name || row.base_unit_name || row.unit || null,
      unitAbbreviation: row.purchase_unit_abbreviation || row.base_unit_abbreviation || row.unit || null,
      baseUnitAbbreviation: row.base_unit_abbreviation || row.unit || null,
      recipeCount: row.recipe_count || 0,
      isActive: !!row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
};

module.exports = ingredientService;
