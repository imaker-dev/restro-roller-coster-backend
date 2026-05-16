/**
 * Item Service
 * Handles menu items with variants, addons, quantity rules, and visibility
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_TTL = 1800;

const itemService = {
  // ========================
  // ITEM CRUD
  // ========================

  async create(data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const {
        outletId, categoryId, sku, name, shortName, description,
        itemType = 'veg', basePrice, costPrice = 0, taxGroupId, taxEnabled = true,
        imageUrl, preparationTimeMins = 15, spiceLevel = 0,
        calories, allergens, tags,
        isCustomizable = false, hasVariants = false, hasAddons = false,
        allowSpecialNotes = true, minQuantity = 1, maxQuantity, stepQuantity = 1,
        isAvailable = true, isRecommended = false, isBestseller = false, isNew = false,
        displayOrder = 0, isActive = true, isGlobal = false, isOpenItem = false,
        kitchenStationId, counterId,
        // Visibility rules
        floorIds = [], sectionIds = [], timeSlotIds = [],
        // Variants
        variants = [],
        // Addon groups
        addonGroupIds = []
      } = data;

      const itemSlug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const itemSku = sku || `ITM${Date.now()}`;

      const [result] = await connection.query(
        `INSERT INTO items (
          outlet_id, category_id, sku, name, short_name, slug, description,
          item_type, base_price, cost_price, tax_group_id, tax_enabled,
          image_url, preparation_time_mins, spice_level, calories, allergens, tags,
          is_customizable, has_variants, has_addons, allow_special_notes,
          min_quantity, max_quantity, step_quantity,
          is_available, is_recommended, is_bestseller, is_new,
          display_order, is_active, is_global, is_open_item, kitchen_station_id, counter_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          outletId, categoryId, itemSku, name, shortName, itemSlug, description,
          itemType, basePrice, costPrice, taxGroupId || null, taxEnabled ? 1 : 0,
          imageUrl, preparationTimeMins, spiceLevel, calories, allergens, tags,
          isCustomizable, hasVariants, hasAddons, allowSpecialNotes,
          minQuantity, maxQuantity, stepQuantity,
          isAvailable, isRecommended, isBestseller, isNew,
          displayOrder, isActive, isGlobal, isOpenItem, kitchenStationId, counterId
        ]
      );

      const itemId = result.insertId;

      // Add variants
      for (const variant of variants) {
        await connection.query(
          `INSERT INTO variants (item_id, name, sku, price, cost_price, tax_group_id, is_default, inventory_multiplier, display_order, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [itemId, variant.name, variant.sku, variant.price, variant.costPrice || 0, variant.taxGroupId, variant.isDefault || false, variant.inventoryMultiplier || 1, variant.displayOrder || 0]
        );
      }

      // Add addon group mappings
      for (let i = 0; i < addonGroupIds.length; i++) {
        const groupId = addonGroupIds[i];
        await connection.query(
          `INSERT INTO item_addon_groups (item_id, addon_group_id, display_order, is_active)
           VALUES (?, ?, ?, 1)`,
          [itemId, groupId, i]
        );
      }

      // Add floor visibility
      for (const floorId of floorIds) {
        await connection.query(
          `INSERT INTO item_floors (item_id, floor_id, is_available) VALUES (?, ?, 1)`,
          [itemId, floorId]
        );
      }

      // Add section visibility
      for (const sectionId of sectionIds) {
        await connection.query(
          `INSERT INTO item_sections (item_id, section_id, is_available) VALUES (?, ?, 1)`,
          [itemId, sectionId]
        );
      }

      // Add time slot visibility
      for (const timeSlotId of timeSlotIds) {
        await connection.query(
          `INSERT INTO item_time_slots (item_id, time_slot_id, is_available) VALUES (?, ?, 1)`,
          [itemId, timeSlotId]
        );
      }

      // Add kitchen station mapping
      if (kitchenStationId) {
        await connection.query(
          `INSERT INTO item_kitchen_stations (item_id, kitchen_station_id, is_primary) VALUES (?, ?, 1)`,
          [itemId, kitchenStationId]
        );
      }

      // Add counter mapping
      if (counterId) {
        await connection.query(
          `INSERT INTO item_counters (item_id, counter_id, is_primary) VALUES (?, ?, 1)`,
          [itemId, counterId]
        );
      }

      await connection.commit();
      await this.invalidateCache(outletId);

      return this.getById(itemId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async getByCategory(categoryId, includeInactive = false) {
    const pool = getPool();
    let query = `
      SELECT i.*, c.name as category_name, tg.name as tax_group_name, tg.total_rate as tax_rate,
             ks.name as kitchen_station_name, ks.code as kitchen_station_code
      FROM items i
      JOIN categories c ON i.category_id = c.id
      LEFT JOIN tax_groups tg ON i.tax_group_id = tg.id
      LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
      WHERE i.category_id = ? AND i.deleted_at IS NULL
    `;
    const params = [categoryId];

    // if (!includeInactive) {
    //   query += ' AND i.is_active = 1 AND i.is_available = 1';
    // }
    query += ' ORDER BY i.display_order, i.name';

    const [items] = await pool.query(query, params);
    for (const item of items) {
      item.isOpenItem = !!item.is_open_item;
    }
    return items;
  },

  async getByOutlet(outletId, filters = {}) {
    const pool = getPool();
    
    // Base query for counting
    let countQuery = `
      SELECT COUNT(*) as total
      FROM items i
      JOIN categories c ON i.category_id = c.id
      WHERE i.outlet_id = ? AND i.deleted_at IS NULL
    `;
    const countParams = [outletId];
    
    // Base query for data
    let query = `
      SELECT i.*, c.name as category_name, tg.name as tax_group_name, tg.total_rate as tax_rate,
             ks.name as kitchen_station_name, ks.code as kitchen_station_code
      FROM items i
      JOIN categories c ON i.category_id = c.id
      LEFT JOIN tax_groups tg ON i.tax_group_id = tg.id
      LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
      WHERE i.outlet_id = ? AND i.deleted_at IS NULL
    `;
    const params = [outletId];

    // Build WHERE conditions
    let whereConditions = '';
    
    // if (!filters.includeInactive) {
    //   whereConditions += ' AND i.is_active = 1';
    // }
    if (filters.categoryId) {
      whereConditions += ' AND i.category_id = ?';
      params.push(parseInt(filters.categoryId));
      countParams.push(parseInt(filters.categoryId));
    }
    if (filters.itemType) {
      whereConditions += ' AND i.item_type = ?';
      params.push(filters.itemType);
      countParams.push(filters.itemType);
    }
    if (filters.search) {
      whereConditions += ' AND (i.name LIKE ? OR i.sku LIKE ? OR i.short_name LIKE ?)';
      const searchTerm = `%${filters.search}%`;
      params.push(searchTerm, searchTerm, searchTerm);
      countParams.push(searchTerm, searchTerm, searchTerm);
    }
    if (filters.isBestseller) {
      whereConditions += ' AND i.is_bestseller = 1';
    }
    if (filters.isRecommended) {
      whereConditions += ' AND i.is_recommended = 1';
    }
    if (filters.serviceType && ['restaurant', 'bar', 'both'].includes(filters.serviceType)) {
      whereConditions += ' AND (i.service_type = ? OR i.service_type = ?)';
      params.push(filters.serviceType, 'both');
      countParams.push(filters.serviceType, 'both');
    }

    query += whereConditions;
    countQuery += whereConditions;
    
    query += ' ORDER BY c.display_order, i.display_order, i.name';

    // Pagination
    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 50;
    const offset = (page - 1) * limit;
    
    // Get total count for pagination
    const [countResult] = await pool.query(countQuery, countParams);
    const total = countResult[0].total;
    
    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [items] = await pool.query(query, params);

    // Batch-load variants for all returned items
    const itemIds = items.map(i => i.id);
    let variantMap = {};
    if (itemIds.length > 0) {
      const [allVariants] = await pool.query(
        `SELECT v.*, tg.name as tax_group_name, tg.total_rate as tax_rate
         FROM variants v
         LEFT JOIN tax_groups tg ON v.tax_group_id = tg.id
         WHERE v.item_id IN (${itemIds.map(() => '?').join(',')}) AND v.is_active = 1
         ORDER BY v.display_order, v.name`,
        itemIds
      );
      for (const v of allVariants) {
        if (!variantMap[v.item_id]) variantMap[v.item_id] = [];
        variantMap[v.item_id].push(v);
      }
    }

    // Attach variants and computed fields to each item
    for (const item of items) {
      item.variants = variantMap[item.id] || [];
      item.isOpenItem = !!item.is_open_item;
    }

    // Return with pagination metadata
    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    };
  },

  async getById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT i.*, c.name as category_name, tg.name as tax_group_name, tg.total_rate as tax_rate, tg.is_inclusive as tax_inclusive,
              ks.name as kitchen_station_name, ks.code as kitchen_station_code
       FROM items i
       JOIN categories c ON i.category_id = c.id
       LEFT JOIN tax_groups tg ON i.tax_group_id = tg.id
       LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
       WHERE i.id = ? AND i.deleted_at IS NULL`,
      [id]
    );
    const item = rows[0] || null;
    if (item) item.isOpenItem = !!item.is_open_item;
    return item;
  },

  async getFullDetails(id) {
    const item = await this.getById(id);
    if (!item) return null;

    const pool = getPool();

    // Get variants
    const [variants] = await pool.query(
      `SELECT v.*, tg.name as tax_group_name, tg.total_rate as tax_rate
       FROM variants v
       LEFT JOIN tax_groups tg ON v.tax_group_id = tg.id
       WHERE v.item_id = ? AND v.is_active = 1
       ORDER BY v.display_order, v.name`,
      [id]
    );

    // Get addon groups with addons
    const [addonGroups] = await pool.query(
      `SELECT ag.*, iag.is_required as item_required
       FROM item_addon_groups iag
       JOIN addon_groups ag ON iag.addon_group_id = ag.id
       WHERE iag.item_id = ? AND iag.is_active = 1 AND ag.is_active = 1
       ORDER BY iag.display_order`,
      [id]
    );

    for (const group of addonGroups) {
      const [addons] = await pool.query(
        `SELECT * FROM addons WHERE addon_group_id = ? AND is_active = 1 ORDER BY display_order, name`,
        [group.id]
      );
      group.addons = addons;
    }

    // Get visibility rules
    const [floors] = await pool.query(
      `SELECT f.id, f.name, if_.is_available, if_.price_override
       FROM item_floors if_
       JOIN floors f ON if_.floor_id = f.id
       WHERE if_.item_id = ?`,
      [id]
    );

    const [sections] = await pool.query(
      `SELECT s.id, s.name, s.section_type, is_.is_available, is_.price_override
       FROM item_sections is_
       JOIN sections s ON is_.section_id = s.id
       WHERE is_.item_id = ?`,
      [id]
    );

    const [timeSlots] = await pool.query(
      `SELECT ts.id, ts.name, ts.start_time, ts.end_time, its.is_available, its.price_override
       FROM item_time_slots its
       JOIN time_slots ts ON its.time_slot_id = ts.id
       WHERE its.item_id = ?`,
      [id]
    );

    // Get kitchen station
    const [stations] = await pool.query(
      `SELECT ks.* FROM item_kitchen_stations iks
       JOIN kitchen_stations ks ON iks.kitchen_station_id = ks.id
       WHERE iks.item_id = ?`,
      [id]
    );

    // Get counter
    const [counters] = await pool.query(
      `SELECT c.* FROM item_counters ic
       JOIN counters c ON ic.counter_id = c.id
       WHERE ic.item_id = ?`,
      [id]
    );

    // Get recipe details with ingredients
    let recipes = [];
    const [recipeRows] = await pool.query(
      `SELECT r.id, r.name, r.variant_id, r.portion_size,
        r.is_current, r.is_active, r.created_at
       FROM recipes r
       WHERE r.menu_item_id = ? AND r.is_active = 1
       ORDER BY r.is_current DESC, r.created_at DESC`,
      [id]
    );
    for (const recipe of recipeRows) {
      const [ingredients] = await pool.query(
        `SELECT ri.id as recipe_ingredient_id, ri.quantity, ri.unit_id,
          ri.wastage_percentage as ri_wastage_pct,
          ing.id as ingredient_id, ing.name as ingredient_name,
          ing.wastage_percentage, ing.yield_percentage,
          ii.id as inventory_item_id, ii.name as inventory_item_name,
          ii.current_stock, ii.average_price,
          COALESCE(pu.abbreviation, bu.abbreviation) as unit_abbreviation,
          COALESCE(pu.conversion_factor, 1) as purchase_conversion_factor,
          ru.abbreviation as recipe_unit_abbreviation,
          ru.conversion_factor as recipe_unit_cf
         FROM recipe_ingredients ri
         JOIN ingredients ing ON ri.ingredient_id = ing.id
         LEFT JOIN inventory_items ii ON ing.inventory_item_id = ii.id
         LEFT JOIN units bu ON ii.base_unit_id = bu.id
         LEFT JOIN units pu ON ii.purchase_unit_id = pu.id
         LEFT JOIN units ru ON ri.unit_id = ru.id
         WHERE ri.recipe_id = ?
         ORDER BY ing.name`,
        [recipe.id]
      );

      recipes.push({
        id: recipe.id,
        name: recipe.name,
        variantId: recipe.variant_id || null,
        portionSize: recipe.portion_size || null,
        isCurrent: !!recipe.is_current,
        ingredients: ingredients.map(ing => {
          const cf = parseFloat(ing.purchase_conversion_factor) || 1;
          const recipeUnitCf = parseFloat(ing.recipe_unit_cf) || 1;
          const qty = parseFloat(ing.quantity) || 0;
          const avgPrice = parseFloat(ing.average_price) || 0;
          const stock = parseFloat(ing.current_stock) || 0;
          const wastage = parseFloat(ing.ri_wastage_pct) || parseFloat(ing.wastage_percentage) || 0;
          const yieldPct = parseFloat(ing.yield_percentage) || 100;
          const effectiveQty = qty * recipeUnitCf * (1 + wastage / 100) * (100 / yieldPct);
          const costPerPortion = effectiveQty * avgPrice;

          return {
            ingredientId: ing.ingredient_id,
            ingredientName: ing.ingredient_name,
            inventoryItemId: ing.inventory_item_id,
            inventoryItemName: ing.inventory_item_name,
            quantity: qty,
            recipeUnit: ing.recipe_unit_abbreviation || ing.unit_abbreviation,
            effectiveQtyBase: parseFloat(effectiveQty.toFixed(4)),
            displayQty: parseFloat((effectiveQty / cf).toFixed(4)),
            displayUnit: ing.unit_abbreviation,
            wastagePercentage: wastage,
            yieldPercentage: yieldPct,
            costPerPortion: parseFloat(costPerPortion.toFixed(2)),
            currentStock: parseFloat((stock / cf).toFixed(4)),
            stockUnit: ing.unit_abbreviation
          };
        }),
        totalCostPerPortion: parseFloat(
          ingredients.reduce((sum, ing) => {
            const recipeUnitCf = parseFloat(ing.recipe_unit_cf) || 1;
            const qty = parseFloat(ing.quantity) || 0;
            const avgPrice = parseFloat(ing.average_price) || 0;
            const wastage = parseFloat(ing.ri_wastage_pct) || parseFloat(ing.wastage_percentage) || 0;
            const yieldPct = parseFloat(ing.yield_percentage) || 100;
            const effectiveQty = qty * recipeUnitCf * (1 + wastage / 100) * (100 / yieldPct);
            return sum + effectiveQty * avgPrice;
          }, 0).toFixed(2)
        )
      });
    }

    return {
      ...item,
      variants,
      addonGroups,
      visibility: { floors, sections, timeSlots },
      kitchenStations: stations,
      counters,
      recipes
    };
  },

  async update(id, data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const fields = [];
      const values = [];

      const fieldMap = {
        categoryId: 'category_id', sku: 'sku', name: 'name', shortName: 'short_name',
        description: 'description', itemType: 'item_type', basePrice: 'base_price',
        costPrice: 'cost_price', taxGroupId: 'tax_group_id', taxEnabled: 'tax_enabled',
        imageUrl: 'image_url', preparationTimeMins: 'preparation_time_mins', spiceLevel: 'spice_level',
        calories: 'calories', allergens: 'allergens', tags: 'tags',
        isCustomizable: 'is_customizable', hasVariants: 'has_variants', hasAddons: 'has_addons',
        allowSpecialNotes: 'allow_special_notes', minQuantity: 'min_quantity',
        maxQuantity: 'max_quantity', stepQuantity: 'step_quantity',
        isAvailable: 'is_available', isRecommended: 'is_recommended',
        isBestseller: 'is_bestseller', isNew: 'is_new',
        displayOrder: 'display_order', isActive: 'is_active', isGlobal: 'is_global',
        isOpenItem: 'is_open_item', kitchenStationId: 'kitchen_station_id', counterId: 'counter_id'
      };

      for (const [key, column] of Object.entries(fieldMap)) {
        if (data[key] !== undefined) {
          fields.push(`${column} = ?`);
          // Convert empty string to null for taxGroupId
          if (key === 'taxGroupId' && (data[key] === '' || data[key] === 0)) {
            values.push(null);
          } else {
            values.push(data[key]);
          }
        }
      }

      if (fields.length > 0) {
        values.push(id);
        await connection.query(`UPDATE items SET ${fields.join(', ')} WHERE id = ?`, values);
      }

      // Update visibility rules
      if (data.floorIds !== undefined) {
        await connection.query('DELETE FROM item_floors WHERE item_id = ?', [id]);
        for (const floorId of data.floorIds) {
          await connection.query(
            `INSERT INTO item_floors (item_id, floor_id, is_available) VALUES (?, ?, 1)`,
            [id, floorId]
          );
        }
      }

      if (data.sectionIds !== undefined) {
        await connection.query('DELETE FROM item_sections WHERE item_id = ?', [id]);
        for (const sectionId of data.sectionIds) {
          await connection.query(
            `INSERT INTO item_sections (item_id, section_id, is_available) VALUES (?, ?, 1)`,
            [id, sectionId]
          );
        }
      }

      if (data.timeSlotIds !== undefined) {
        await connection.query('DELETE FROM item_time_slots WHERE item_id = ?', [id]);
        for (const timeSlotId of data.timeSlotIds) {
          await connection.query(
            `INSERT INTO item_time_slots (item_id, time_slot_id, is_available) VALUES (?, ?, 1)`,
            [id, timeSlotId]
          );
        }
      }

      if (data.addonGroupIds !== undefined) {
        await connection.query('DELETE FROM item_addon_groups WHERE item_id = ?', [id]);
        for (let i = 0; i < data.addonGroupIds.length; i++) {
          await connection.query(
            `INSERT INTO item_addon_groups (item_id, addon_group_id, display_order, is_active) VALUES (?, ?, ?, 1)`,
            [id, data.addonGroupIds[i], i]
          );
        }
      }

      await connection.commit();

      const item = await this.getById(id);
      if (item) await this.invalidateCache(item.outlet_id);
      return item;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async delete(id) {
    const pool = getPool();
    const item = await this.getById(id);
    if (!item) return false;

    await pool.query('UPDATE items SET deleted_at = NOW(), is_active = 0 WHERE id = ?', [id]);
    await this.invalidateCache(item.outlet_id);
    return true;
  },

  // ========================
  // VARIANTS
  // ========================

  async addVariant(itemId, data) {
    const pool = getPool();
    const {
      name, sku, price, costPrice = 0, taxGroupId,
      isDefault = false, inventoryMultiplier = 1, displayOrder = 0
    } = data;

    // If setting as default, unset other defaults
    if (isDefault) {
      await pool.query('UPDATE variants SET is_default = 0 WHERE item_id = ?', [itemId]);
    }

    const [result] = await pool.query(
      `INSERT INTO variants (item_id, name, sku, price, cost_price, tax_group_id, is_default, inventory_multiplier, display_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [itemId, name, sku, price, costPrice, taxGroupId, isDefault, inventoryMultiplier, displayOrder]
    );

    // Update item to have variants
    await pool.query('UPDATE items SET has_variants = 1 WHERE id = ?', [itemId]);

    const item = await this.getById(itemId);
    if (item) await this.invalidateCache(item.outlet_id);

    return { id: result.insertId, itemId, ...data };
  },

  async getVariants(itemId) {
    const pool = getPool();
    const [variants] = await pool.query(
      `SELECT v.*, tg.name as tax_group_name, tg.total_rate as tax_rate
       FROM variants v
       LEFT JOIN tax_groups tg ON v.tax_group_id = tg.id
       WHERE v.item_id = ? AND v.is_active = 1
       ORDER BY v.display_order, v.name`,
      [itemId]
    );
    return variants;
  },

  async updateVariant(variantId, data) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.sku !== undefined) { fields.push('sku = ?'); values.push(data.sku); }
    if (data.price !== undefined) { fields.push('price = ?'); values.push(data.price); }
    if (data.costPrice !== undefined) { fields.push('cost_price = ?'); values.push(data.costPrice); }
    if (data.taxGroupId !== undefined) { fields.push('tax_group_id = ?'); values.push(data.taxGroupId); }
    if (data.isDefault !== undefined) { fields.push('is_default = ?'); values.push(data.isDefault); }
    if (data.inventoryMultiplier !== undefined) { fields.push('inventory_multiplier = ?'); values.push(data.inventoryMultiplier); }
    if (data.displayOrder !== undefined) { fields.push('display_order = ?'); values.push(data.displayOrder); }
    if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive); }

    if (fields.length === 0) return null;
    values.push(variantId);

    await pool.query(`UPDATE variants SET ${fields.join(', ')} WHERE id = ?`, values);

    const [rows] = await pool.query('SELECT * FROM variants WHERE id = ?', [variantId]);
    if (rows[0]) {
      const item = await this.getById(rows[0].item_id);
      if (item) await this.invalidateCache(item.outlet_id);
    }
    return rows[0] || null;
  },

  async deleteVariant(variantId) {
    const pool = getPool();
    const [rows] = await pool.query('SELECT item_id FROM variants WHERE id = ?', [variantId]);
    if (!rows[0]) return false;

    await pool.query('UPDATE variants SET is_active = 0 WHERE id = ?', [variantId]);

    const item = await this.getById(rows[0].item_id);
    if (item) await this.invalidateCache(item.outlet_id);
    return true;
  },

  // ========================
  // VISIBILITY & PRICING
  // ========================

  async getVisibleItems(outletId, context = {}) {
    const { categoryId, floorId, sectionId, timeSlotId, serviceType } = context;
    const pool = getPool();

    let query = `
      SELECT DISTINCT i.*, c.name as category_name, tg.name as tax_group_name, tg.total_rate as tax_rate
      FROM items i
      JOIN categories c ON i.category_id = c.id
      LEFT JOIN tax_groups tg ON i.tax_group_id = tg.id
      WHERE i.outlet_id = ? AND i.is_active = 1 AND i.is_available = 1 AND i.deleted_at IS NULL
    `;
    const params = [outletId];

    if (categoryId) {
      query += ' AND i.category_id = ?';
      params.push(categoryId);
    }

    // Service type filter (restaurant/bar/both)
    if (serviceType && serviceType !== 'all') {
      query += ` AND i.service_type = ?`;
      params.push(serviceType);
    }

    // Floor filter - skip if item is global
    if (floorId) {
      query += `
        AND (
          i.is_global = 1
          OR NOT EXISTS (SELECT 1 FROM item_floors if_ WHERE if_.item_id = i.id)
          OR EXISTS (SELECT 1 FROM item_floors if_ WHERE if_.item_id = i.id AND if_.floor_id = ? AND if_.is_available = 1)
        )
      `;
      params.push(floorId);
    }

    // Section filter - skip if item is global
    if (sectionId) {
      query += `
        AND (
          i.is_global = 1
          OR NOT EXISTS (SELECT 1 FROM item_sections is_ WHERE is_.item_id = i.id)
          OR EXISTS (SELECT 1 FROM item_sections is_ WHERE is_.item_id = i.id AND is_.section_id = ? AND is_.is_available = 1)
        )
      `;
      params.push(sectionId);
    }

    // Time slot filter - skip if item is global
    if (timeSlotId) {
      query += `
        AND (
          i.is_global = 1
          OR NOT EXISTS (SELECT 1 FROM item_time_slots its WHERE its.item_id = i.id)
          OR EXISTS (SELECT 1 FROM item_time_slots its WHERE its.item_id = i.id AND its.time_slot_id = ? AND its.is_available = 1)
        )
      `;
      params.push(timeSlotId);
    }

    query += ' ORDER BY c.display_order, i.display_order, i.name';

    const [items] = await pool.query(query, params);
    return items;
  },

  /**
   * Get effective price for an item considering floor/section/time overrides
   * NOTE: Price overrides are currently disabled — returns base price only.
   * To re-enable, uncomment the override logic below.
   */
  async getEffectivePrice(itemId, variantId = null, context = {}) {
    const pool = getPool();

    // ── Price overrides DISABLED — return base price only ──
    let price;
    if (variantId) {
      const [variants] = await pool.query('SELECT price FROM variants WHERE id = ?', [variantId]);
      price = variants[0]?.price;
    } else {
      const [items] = await pool.query('SELECT base_price FROM items WHERE id = ?', [itemId]);
      price = items[0]?.base_price;
    }

    if (!price) return null;
    return parseFloat(price);

    /* ── ORIGINAL OVERRIDE LOGIC (disabled) ──
    const { floorId, sectionId, timeSlotId } = context;

    // Check for floor price override
    if (floorId) {
      const [floorOverride] = await pool.query(
        `SELECT price_override FROM item_floors WHERE item_id = ? AND floor_id = ? AND price_override IS NOT NULL`,
        [itemId, floorId]
      );
      if (floorOverride[0]?.price_override) {
        price = floorOverride[0].price_override;
      }
    }

    // Check for section price override
    if (sectionId) {
      const [sectionOverride] = await pool.query(
        `SELECT price_override FROM item_sections WHERE item_id = ? AND section_id = ? AND price_override IS NOT NULL`,
        [itemId, sectionId]
      );
      if (sectionOverride[0]?.price_override) {
        price = sectionOverride[0].price_override;
      }
    }

    // Check for time slot price override
    if (timeSlotId) {
      const [timeOverride] = await pool.query(
        `SELECT price_override FROM item_time_slots WHERE item_id = ? AND time_slot_id = ? AND price_override IS NOT NULL`,
        [itemId, timeSlotId]
      );
      if (timeOverride[0]?.price_override) {
        price = timeOverride[0].price_override;
      }
    }

    return parseFloat(price);
    */
  },

  async invalidateCache(outletId) {
    await cache.del(`items:${outletId}`);
    await cache.del(`menu:${outletId}`);
  }
};

module.exports = itemService;
