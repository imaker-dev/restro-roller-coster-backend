/**
 * Menu Engine Service
 * Core service that builds dynamic menus based on context
 * (outlet, floor, section, time slot, captain view)
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');
const categoryService = require('./category.service');
const itemService = require('./item.service');
const addonService = require('./addon.service');
const priceRuleService = require('./priceRule.service');
const timeSlotService = require('./timeSlot.service');
const taxService = require('./tax.service');
const { prefixImageUrl } = require('../utils/helpers');

const CACHE_TTL = 900; // 15 minutes

// Liquor category keywords for filtering
const LIQUOR_KEYWORDS = ['whiskey', 'vodka', 'wine', 'beer', 'cocktail', 'rum', 'gin', 'brandy', 'liquor', 'alcohol', 'spirits', 'scotch', 'bourbon', 'tequila', 'champagne'];

/**
 * Check if a category is a liquor category based on name
 */
function isLiquorCategory(categoryName) {
  if (!categoryName) return false;
  const lowerName = categoryName.toLowerCase();
  return LIQUOR_KEYWORDS.some(keyword => lowerName.includes(keyword));
}

/**
 * Build SQL filter clause for item type filtering
 * @param {string} filter - 'veg', 'non_veg', or 'liquor'
 * @param {string} itemAlias - Table alias for items (default 'i')
 * @param {string} categoryAlias - Table alias for categories (default 'c')
 * @returns {object} { sql: string, params: array }
 */
function buildItemTypeFilter(filter, itemAlias = 'i', categoryAlias = 'c') {
  if (!filter) return { sql: '', params: [] };
  
  const filterLower = filter.toLowerCase();
  
  if (filterLower === 'veg') {
    // Veg items but NOT in liquor categories
    const liquorPattern = LIQUOR_KEYWORDS.map(() => `${categoryAlias}.name NOT LIKE ?`).join(' AND ');
    return {
      sql: ` AND ${itemAlias}.item_type IN ('veg', 'vegan') AND (${liquorPattern})`,
      params: LIQUOR_KEYWORDS.map(k => `%${k}%`)
    };
  } else if (filterLower === 'non_veg' || filterLower === 'nonveg') {
    // Non-veg items (including egg)
    return {
      sql: ` AND ${itemAlias}.item_type IN ('non_veg', 'egg')`,
      params: []
    };
  } else if (filterLower === 'liquor') {
    // Items in liquor categories
    const liquorPattern = LIQUOR_KEYWORDS.map(() => `${categoryAlias}.name LIKE ?`).join(' OR ');
    return {
      sql: ` AND (${liquorPattern})`,
      params: LIQUOR_KEYWORDS.map(k => `%${k}%`)
    };
  }
  
  return { sql: '', params: [] };
}

const menuEngineService = {
  /**
   * Build complete menu for captain view
   * Returns categories with items, variants, addons, and calculated prices
   */
  async buildMenu(outletId, context = {}) {
    const { floorId, sectionId, tableId, time, includeDetails = true, skipTimeSlotFilter = false, serviceType } = context;
    const pool = getPool();

    // Get current time slot (skip if skipTimeSlotFilter is true)
    let timeSlotId = null;
    if (!skipTimeSlotFilter) {
      timeSlotId = context.timeSlotId;
      if (!timeSlotId) {
        const currentSlot = await timeSlotService.getCurrentSlot(outletId);
        timeSlotId = currentSlot?.id;
      }
    }

    const menuContext = { floorId, sectionId, timeSlotId, time, skipTimeSlotFilter, serviceType };

    // Parallel: fetch categories + ALL visible items in one go (instead of per-category)
    const [categories, allItems] = await Promise.all([
      categoryService.getVisibleCategories(outletId, menuContext),
      itemService.getVisibleItems(outletId, menuContext)
    ]);

    // Group items by category_id
    const itemsByCat = {};
    for (const item of allItems) {
      if (!itemsByCat[item.category_id]) itemsByCat[item.category_id] = [];
      itemsByCat[item.category_id].push(item);
    }

    // Batch fetch ALL variants + addon group mappings in parallel
    let variantsByItemId = {};
    let addonGroupsByItemId = {};
    let addonsByGroupId = {};

    if (includeDetails && allItems.length > 0) {
      const variantItemIds = allItems.filter(i => i.has_variants).map(i => i.id);
      const addonItemIds = allItems.filter(i => i.has_addons).map(i => i.id);

      const [variantRows, addonGroupRows] = await Promise.all([
        variantItemIds.length > 0 ? pool.query(
          `SELECT v.*, tg.name as tax_group_name, tg.total_rate as tax_rate
           FROM variants v
           LEFT JOIN tax_groups tg ON v.tax_group_id = tg.id
           WHERE v.item_id IN (?) AND v.is_active = 1
           ORDER BY v.display_order, v.name`,
          [variantItemIds]
        ).then(([r]) => r) : [],
        addonItemIds.length > 0 ? pool.query(
          `SELECT ag.*, iag.item_id, iag.is_required as item_required, iag.display_order as item_display_order
           FROM item_addon_groups iag
           JOIN addon_groups ag ON iag.addon_group_id = ag.id
           WHERE iag.item_id IN (?) AND iag.is_active = 1 AND ag.is_active = 1
           ORDER BY iag.display_order, ag.name`,
          [addonItemIds]
        ).then(([r]) => r) : []
      ]);

      // Build variant lookup
      for (const v of variantRows) {
        if (!variantsByItemId[v.item_id]) variantsByItemId[v.item_id] = [];
        variantsByItemId[v.item_id].push(v);
      }

      // Build addon group lookup + batch fetch ALL addons
      const addonGroupIds = [...new Set(addonGroupRows.map(g => g.id))];
      if (addonGroupIds.length > 0) {
        const [addonRows] = await pool.query(
          'SELECT * FROM addons WHERE addon_group_id IN (?) AND is_active = 1 ORDER BY display_order, name',
          [addonGroupIds]
        );
        for (const a of addonRows) {
          if (!addonsByGroupId[a.addon_group_id]) addonsByGroupId[a.addon_group_id] = [];
          addonsByGroupId[a.addon_group_id].push(a);
        }
      }
      for (const g of addonGroupRows) {
        if (!addonGroupsByItemId[g.item_id]) addonGroupsByItemId[g.item_id] = [];
        addonGroupsByItemId[g.item_id].push(g);
      }
    }

    // Build menu structure (pure in-memory — no more DB calls)
    const menu = [];

    for (const category of categories) {
      const items = itemsByCat[category.id];
      if (!items || items.length === 0) continue;

      const categoryItems = items.map(item => {
        // Price rules and effective price are currently disabled — use base_price directly
        const basePrice = parseFloat(item.base_price);
        const menuItem = {
          id: item.id,
          name: item.name,
          shortName: item.short_name,
          description: item.description,
          imageUrl: prefixImageUrl(item.image_url),
          itemType: item.item_type,
          basePrice: basePrice,
          price: Math.max(0, parseFloat(basePrice.toFixed(2))),
          hasDiscount: false,
          appliedRules: [],
          hasVariants: item.has_variants,
          hasAddons: item.has_addons,
          isRecommended: item.is_recommended,
          isBestseller: item.is_bestseller,
          isNew: item.is_new,
          spiceLevel: item.spice_level,
          preparationTime: item.preparation_time_mins,
          minQuantity: item.min_quantity,
          maxQuantity: item.max_quantity,
          stepQuantity: item.step_quantity,
          allowSpecialNotes: item.allow_special_notes,
          taxGroupId: item.tax_group_id,
          taxRate: item.tax_rate,
          taxInclusive: item.tax_inclusive,
          isOpenItem: !!item.is_open_item
        };

        // Include variants from batch lookup
        if (includeDetails && item.has_variants) {
          const variants = variantsByItemId[item.id];
          if (variants && variants.length > 0) {
            menuItem.variants = variants.map(v => {
              const vPrice = parseFloat(v.price);
              return {
                id: v.id,
                name: v.name,
                basePrice: vPrice,
                price: Math.max(0, parseFloat(vPrice.toFixed(2))),
                hasDiscount: false,
                isDefault: v.is_default,
                taxGroupId: v.tax_group_id || item.tax_group_id,
                taxRate: v.tax_rate || item.tax_rate
              };
            });
          }
        }

        // Include addon groups from batch lookup
        if (includeDetails && item.has_addons) {
          const groups = addonGroupsByItemId[item.id];
          if (groups && groups.length > 0) {
            menuItem.addonGroups = groups.map(g => ({
              ...g,
              addons: addonsByGroupId[g.id] || []
            }));
          }
        }

        return menuItem;
      });

      if (categoryItems.length > 0) {
        menu.push({
          id: category.id,
          name: category.name,
          description: category.description,
          imageUrl: prefixImageUrl(category.image_url),
          icon: category.icon,
          colorCode: category.color_code,
          itemCount: categoryItems.length,
          items: categoryItems
        });
      }
    }

    return {
      outletId,
      context: menuContext,
      timeSlot: timeSlotId ? await timeSlotService.getById(timeSlotId) : null,
      generatedAt: new Date().toISOString(),
      categories: menu,
      totalCategories: menu.length,
      totalItems: menu.reduce((sum, c) => sum + c.items.length, 0)
    };
  },

  /**
   * Get simplified menu for captain (clean, easy to use)
   * Structure: categories[] → items[] → variants[], addons[]
   * No time slot filtering - shows ALL items
   * Supports serviceType filter: 'restaurant', 'bar', or 'all'
   */
  async getCaptainMenu(outletId, context = {}) {
    const { filter, serviceType } = context;

    // Check cache first (5-minute TTL)
    const cacheKey = `menu:captain:${outletId}:${filter || 'all'}:${serviceType || 'all'}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
    
    // Skip time slot filtering for captain - show all items
    // Pass serviceType to filter categories at database level
    const menu = await this.buildMenu(outletId, { 
      ...context, 
      includeDetails: true,
      skipTimeSlotFilter: true,
      serviceType: serviceType || null
    });

    // Apply item type filter if specified (veg/non_veg/liquor)
    let filteredCategories = menu.categories;
    
    if (filter) {
      const filterLower = filter.toLowerCase();
      
      if (filterLower === 'liquor') {
        // Only liquor categories
        filteredCategories = menu.categories.filter(cat => isLiquorCategory(cat.name));
      } else if (filterLower === 'veg') {
        // Exclude liquor categories, then filter items to veg only
        filteredCategories = menu.categories
          .filter(cat => !isLiquorCategory(cat.name))
          .map(cat => ({
            ...cat,
            items: cat.items.filter(item => ['veg', 'vegan'].includes(item.itemType))
          }))
          .filter(cat => cat.items.length > 0);
      } else if (filterLower === 'non_veg' || filterLower === 'nonveg') {
        // Filter items to non-veg only
        filteredCategories = menu.categories
          .map(cat => ({
            ...cat,
            items: cat.items.filter(item => ['non_veg', 'egg'].includes(item.itemType))
          }))
          .filter(cat => cat.items.length > 0);
      }
    }

    // Recalculate totals
    const totalItems = filteredCategories.reduce((sum, cat) => sum + cat.items.length, 0);

    // Clean, flat structure for captain - easy to read and use
    const result = {
      outletId: menu.outletId,
      generatedAt: menu.generatedAt,
      filter: filter || null,
      serviceType: serviceType || 'all',
      summary: {
        categories: filteredCategories.length,
        items: totalItems
      },
      menu: filteredCategories.map(cat => ({
        id: cat.id,
        name: cat.name,
        description: cat.description || null,
        icon: cat.icon,
        color: cat.colorCode,
        serviceType: cat.service_type || 'both',
        img: cat.imageUrl || null,
        count: cat.items.length,
        items: cat.items.map(item => {
          const captainItem = {
            id: item.id,
            name: item.name,
            short: item.shortName || item.name.substring(0, 15),
            description: item.description || null,
            price: item.price,
            basePrice: item.basePrice,
            type: item.itemType,
            img: item.imageUrl,
            spiceLevel: item.spiceLevel || null,
            prepTime: item.preparationTime || null,
            taxGroupId: item.taxGroupId || null,
            taxRate: item.taxRate || null,
            taxInclusive: item.taxInclusive || false,
            isOpenItem: item.isOpenItem || false
          };

          // Add badges
          if (item.isBestseller) captainItem.bestseller = true;
          if (item.isRecommended) captainItem.recommended = true;
          if (item.isNew) captainItem.isNew = true;
          if (item.hasDiscount) captainItem.hasDiscount = true;

          // Quantity constraints
          if (item.minQuantity > 1) captainItem.minQty = item.minQuantity;
          if (item.maxQuantity) captainItem.maxQty = item.maxQuantity;
          if (item.stepQuantity > 1) captainItem.stepQty = item.stepQuantity;
          if (item.allowSpecialNotes) captainItem.allowNotes = true;

          // Variants (always include if has variants)
          if (item.hasVariants && item.variants?.length) {
            captainItem.variants = item.variants.map(v => ({
              id: v.id,
              name: v.name,
              price: v.price,
              basePrice: v.basePrice,
              isDefault: v.isDefault ? true : false,
              hasDiscount: v.hasDiscount || false,
              taxGroupId: v.taxGroupId || null,
              taxRate: v.taxRate || null
            }));
          }

          // Addons (always include if has addons)
          if (item.hasAddons && item.addonGroups?.length) {
            captainItem.addons = item.addonGroups.map(g => ({
              id: g.id,
              name: g.name,
              required: g.is_required || g.item_required || false,
              min: g.min_selection || 0,
              max: g.max_selection || 10,
              options: g.addons?.map(a => ({
                id: a.id,
                name: a.name,
                price: parseFloat(a.price) || 0,
                type: a.item_type || 'veg',
                img: prefixImageUrl(a.image_url)
              })) || []
            }));
          }

          return captainItem;
        })
      }))
    };

    // Store in cache (30-minute TTL = 1800 seconds)
    await cache.set(cacheKey, result, 1800);

    return result;
  },

  /**
   * Preview menu as admin would see it for a specific context
   */
  async previewMenu(outletId, floorId = null, sectionId = null, timeSlotId = null) {
    return this.buildMenu(outletId, { floorId, sectionId, timeSlotId, includeDetails: true });
  },

  /**
   * Get menu item with full details for ordering
   */
  async getItemForOrder(itemId, context = {}) {
    const pool = getPool();
    const item = await itemService.getFullDetails(itemId);
    if (!item) return null;

    const { floorId, sectionId, timeSlotId } = context;
    const menuContext = { floorId, sectionId, timeSlotId };

    // Calculate price with rules
    const priceResult = await priceRuleService.calculatePrice(
      item.base_price, item.outlet_id, item.id, null, menuContext
    );

    // Get tax calculation
    let taxInfo = null;
    if (item.tax_group_id) {
      taxInfo = await taxService.getTaxGroupById(item.tax_group_id);
    }

    return {
      ...item,
      effectivePrice: priceResult.finalPrice,
      priceBreakdown: priceResult,
      taxInfo,
      variants: item.variants ? await Promise.all(item.variants.map(async (v) => {
        const variantPrice = await priceRuleService.calculatePrice(
          v.price, item.outlet_id, item.id, v.id, menuContext
        );
        return {
          ...v,
          effectivePrice: variantPrice.finalPrice,
          priceBreakdown: variantPrice
        };
      })) : []
    };
  },

  /**
   * Calculate order item total with tax
   */
  async calculateItemTotal(itemId, variantId, quantity, addons = [], context = {}) {
    const pool = getPool();
    const { floorId, sectionId, timeSlotId } = context;
    const menuContext = { floorId, sectionId, timeSlotId };

    // Get item
    const item = await itemService.getById(itemId);
    if (!item) throw new Error('Item not found');

    // Get base price (variant or item)
    let basePrice;
    let taxGroupId = item.tax_group_id;
    let taxEnabled = item.tax_enabled !== 0 && item.tax_enabled !== false;

    if (variantId) {
      const [variants] = await pool.query('SELECT * FROM variants WHERE id = ?', [variantId]);
      if (!variants[0]) throw new Error('Variant not found');
      basePrice = variants[0].price;
      if (variants[0].tax_group_id) taxGroupId = variants[0].tax_group_id;
      // Variant can override item's tax_enabled setting
      if (variants[0].tax_enabled !== undefined && variants[0].tax_enabled !== null) {
        taxEnabled = variants[0].tax_enabled !== 0 && variants[0].tax_enabled !== false;
      }
    } else {
      basePrice = item.base_price;
    }

    // Apply price rules
    const priceResult = await priceRuleService.calculatePrice(
      basePrice, item.outlet_id, itemId, variantId, menuContext
    );

    // Calculate addon total
    let addonTotal = 0;
    const addonDetails = [];

    for (const addonId of addons) {
      const addon = await addonService.getAddonById(addonId);
      if (addon) {
        addonTotal += parseFloat(addon.price);
        addonDetails.push({
          id: addon.id,
          name: addon.name,
          price: parseFloat(addon.price)
        });
      }
    }

    const unitPrice = priceResult.finalPrice + addonTotal;
    const subtotal = unitPrice * quantity;

    // Calculate tax (only if tax is enabled for this item)
    let taxResult = { taxAmount: 0, breakdown: [] };
    if (taxGroupId && taxEnabled) {
      taxResult = await taxService.calculateTax(
        [{ price: unitPrice, quantity }],
        taxGroupId
      );
    }

    return {
      itemId,
      itemName: item.name,
      variantId,
      quantity,
      basePrice: priceResult.basePrice,
      unitPrice,
      addons: addonDetails,
      addonTotal,
      subtotal,
      taxGroupId,
      tax: taxResult,
      total: subtotal + (taxResult.isInclusive ? 0 : taxResult.taxAmount)
    };
  },

  /**
   * Get menu rules/visibility summary for admin
   */
  async getMenuRulesSummary(outletId) {
    const pool = getPool();

    // Get all items with their visibility rules
    const [items] = await pool.query(
      `SELECT i.id, i.name, i.sku, i.base_price,
        c.name as category_name,
        tg.name as tax_group_name, tg.total_rate as tax_rate,
        (SELECT GROUP_CONCAT(f.name) FROM item_floors if_ JOIN floors f ON if_.floor_id = f.id WHERE if_.item_id = i.id AND if_.is_available = 1) as visible_floors,
        (SELECT GROUP_CONCAT(s.name) FROM item_sections is_ JOIN sections s ON is_.section_id = s.id WHERE is_.item_id = i.id AND is_.is_available = 1) as visible_sections,
        (SELECT GROUP_CONCAT(ts.name) FROM item_time_slots its JOIN time_slots ts ON its.time_slot_id = ts.id WHERE its.item_id = i.id AND its.is_available = 1) as visible_time_slots
       FROM items i
       JOIN categories c ON i.category_id = c.id
       LEFT JOIN tax_groups tg ON i.tax_group_id = tg.id
       WHERE i.outlet_id = ? AND i.is_active = 1 AND i.deleted_at IS NULL
       ORDER BY c.display_order, i.display_order`,
      [outletId]
    );

    return items.map(item => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      category: item.category_name,
      basePrice: item.base_price,
      taxGroup: item.tax_group_name,
      taxRate: item.tax_rate,
      visibility: {
        floors: item.visible_floors ? item.visible_floors.split(',') : ['All'],
        sections: item.visible_sections ? item.visible_sections.split(',') : ['All'],
        timeSlots: item.visible_time_slots ? item.visible_time_slots.split(',') : ['All']
      }
    }));
  },

  /**
   * Search menu items - Global search across category, item, variant names
   * Returns matching items with full details (variants, addons)
   * Also returns matching categories with all their items
   */
  async searchItems(outletId, query, context = {}) {
    const pool = getPool();
    const { floorId, sectionId, timeSlotId, limit = 50, filter } = context;

    // Check cache first (5-minute TTL)
    const cacheKey = `menu:search:${outletId}:${query}:${filter || 'all'}:${floorId || 0}:${sectionId || 0}:${timeSlotId || 0}:${limit}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const searchTerm = `%${query}%`;
    
    // Build item type filter
    const typeFilter = buildItemTypeFilter(filter, 'i', 'c');

    // 1. Build category search SQL
    let catSql = `SELECT DISTINCT c.id, c.name, c.description, c.image_url, c.icon, c.color_code
       FROM categories c
       WHERE c.outlet_id = ? AND c.is_active = 1 AND c.deleted_at IS NULL
       AND c.name LIKE ?`;
    let catParams = [outletId, searchTerm];
    
    if (filter) {
      const filterLower = filter.toLowerCase();
      if (filterLower === 'liquor') {
        const liquorPattern = LIQUOR_KEYWORDS.map(() => 'c.name LIKE ?').join(' OR ');
        catSql += ` AND (${liquorPattern})`;
        catParams.push(...LIQUOR_KEYWORDS.map(k => `%${k}%`));
      } else if (filterLower === 'veg') {
        const liquorPattern = LIQUOR_KEYWORDS.map(() => 'c.name NOT LIKE ?').join(' AND ');
        catSql += ` AND (${liquorPattern})`;
        catParams.push(...LIQUOR_KEYWORDS.map(k => `%${k}%`));
      }
    }

    // Parallel: category search + variant match search (both independent)
    const [matchingCategories, variantMatches] = await Promise.all([
      pool.query(catSql, catParams).then(([r]) => r),
      pool.query(
        `SELECT DISTINCT i.id
         FROM items i
         JOIN variants v ON v.item_id = i.id
         WHERE i.outlet_id = ? AND i.is_active = 1 AND i.deleted_at IS NULL
         AND v.name LIKE ?`,
        [outletId, searchTerm]
      ).then(([r]) => r)
    ]);

    // 2. Build item search SQL (depends on variant matches)
    const variantItemIds = variantMatches.map(v => v.id);
    let itemSql = `
      SELECT DISTINCT i.id, i.name, i.short_name, i.description, i.base_price,
        i.image_url, i.item_type, i.has_variants, i.has_addons,
        i.is_bestseller, i.is_recommended, i.is_new, i.spice_level,
        i.preparation_time_mins, i.category_id, i.tax_group_id, i.is_open_item,
        c.name as category_name, c.id as cat_id
      FROM items i
      JOIN categories c ON i.category_id = c.id
      WHERE i.outlet_id = ? AND i.is_active = 1 AND i.is_available = 1 AND i.deleted_at IS NULL
      AND (i.name LIKE ? OR i.short_name LIKE ? OR i.sku LIKE ? OR i.tags LIKE ?
    `;
    let itemParams = [outletId, searchTerm, searchTerm, searchTerm, searchTerm];

    if (variantItemIds.length > 0) {
      itemSql += ` OR i.id IN (${variantItemIds.map(() => '?').join(',')})`;
      itemParams.push(...variantItemIds);
    }
    itemSql += ')';

    if (typeFilter.sql) {
      itemSql += typeFilter.sql;
      itemParams.push(...typeFilter.params);
    }

    if (floorId) {
      itemSql += `
        AND (
          NOT EXISTS (SELECT 1 FROM item_floors if_ WHERE if_.item_id = i.id)
          OR EXISTS (SELECT 1 FROM item_floors if_ WHERE if_.item_id = i.id AND if_.floor_id = ? AND if_.is_available = 1)
        )
      `;
      itemParams.push(floorId);
    }
    if (sectionId) {
      itemSql += `
        AND (
          NOT EXISTS (SELECT 1 FROM item_sections is_ WHERE is_.item_id = i.id)
          OR EXISTS (SELECT 1 FROM item_sections is_ WHERE is_.item_id = i.id AND is_.section_id = ? AND is_.is_available = 1)
        )
      `;
      itemParams.push(sectionId);
    }
    if (timeSlotId) {
      itemSql += `
        AND (
          NOT EXISTS (SELECT 1 FROM item_time_slots its WHERE its.item_id = i.id)
          OR EXISTS (SELECT 1 FROM item_time_slots its WHERE its.item_id = i.id AND its.time_slot_id = ? AND its.is_available = 1)
        )
      `;
      itemParams.push(timeSlotId);
    }

    itemSql += ' ORDER BY i.is_bestseller DESC, i.name LIMIT ?';
    itemParams.push(limit);

    // 3. Parallel: item search + category items queries
    const catItemQueries = matchingCategories.map(cat => {
      let catItemSql = `
        SELECT i.id, i.name, i.short_name, i.description, i.base_price,
          i.image_url, i.item_type, i.has_variants, i.has_addons,
          i.is_bestseller, i.is_recommended, i.is_new, i.spice_level,
          i.preparation_time_mins, i.tax_group_id, i.is_open_item
        FROM items i
        WHERE i.category_id = ? AND i.is_active = 1 AND i.is_available = 1 AND i.deleted_at IS NULL
      `;
      const catItemParams = [cat.id];
      if (floorId) {
        catItemSql += `
          AND (
            NOT EXISTS (SELECT 1 FROM item_floors if_ WHERE if_.item_id = i.id)
            OR EXISTS (SELECT 1 FROM item_floors if_ WHERE if_.item_id = i.id AND if_.floor_id = ? AND if_.is_available = 1)
          )
        `;
        catItemParams.push(floorId);
      }
      if (sectionId) {
        catItemSql += `
          AND (
            NOT EXISTS (SELECT 1 FROM item_sections is_ WHERE is_.item_id = i.id)
            OR EXISTS (SELECT 1 FROM item_sections is_ WHERE is_.item_id = i.id AND is_.section_id = ? AND is_.is_available = 1)
          )
        `;
        catItemParams.push(sectionId);
      }
      catItemSql += ' ORDER BY i.display_order, i.name';
      return pool.query(catItemSql, catItemParams).then(([r]) => r);
    });

    const [matchingItems, ...catItemResults] = await Promise.all([
      pool.query(itemSql, itemParams).then(([r]) => r),
      ...catItemQueries
    ]);

    // 4. Collect ALL unique items that need variant/addon details
    const allSearchItems = [...matchingItems];
    for (const catItems of catItemResults) {
      for (const item of catItems) {
        allSearchItems.push(item);
      }
    }
    const uniqueItemIds = [...new Set(allSearchItems.map(i => i.id))];

    // 5. Batch fetch ALL variants + addon groups + addons (3 queries instead of N+1 per item)
    const variantNeedIds = [...new Set(allSearchItems.filter(i => i.has_variants).map(i => i.id))];
    const addonNeedIds = [...new Set(allSearchItems.filter(i => i.has_addons).map(i => i.id))];

    const [batchVariants, batchAddonGroups] = await Promise.all([
      variantNeedIds.length > 0 ? pool.query(
        'SELECT id, item_id, name, price, is_default, tax_group_id FROM variants WHERE item_id IN (?) AND is_active = 1 ORDER BY display_order, name',
        [variantNeedIds]
      ).then(([r]) => r) : [],
      addonNeedIds.length > 0 ? pool.query(
        `SELECT ag.*, iag.item_id, iag.is_required as item_required, iag.display_order as item_display_order
         FROM item_addon_groups iag
         JOIN addon_groups ag ON iag.addon_group_id = ag.id
         WHERE iag.item_id IN (?) AND iag.is_active = 1 AND ag.is_active = 1
         ORDER BY iag.display_order, ag.name`,
        [addonNeedIds]
      ).then(([r]) => r) : []
    ]);

    // Batch fetch addons for all addon groups
    const addonGroupIds = [...new Set(batchAddonGroups.map(g => g.id))];
    let batchAddons = [];
    if (addonGroupIds.length > 0) {
      [batchAddons] = await pool.query(
        'SELECT * FROM addons WHERE addon_group_id IN (?) AND is_active = 1 ORDER BY display_order, name',
        [addonGroupIds]
      );
    }

    // Build lookup maps
    const variantsByItemId = {};
    for (const v of batchVariants) {
      if (!variantsByItemId[v.item_id]) variantsByItemId[v.item_id] = [];
      variantsByItemId[v.item_id].push(v);
    }
    const addonsByGroupId = {};
    for (const a of batchAddons) {
      if (!addonsByGroupId[a.addon_group_id]) addonsByGroupId[a.addon_group_id] = [];
      addonsByGroupId[a.addon_group_id].push(a);
    }
    const addonGroupsByItemId = {};
    for (const g of batchAddonGroups) {
      if (!addonGroupsByItemId[g.item_id]) addonGroupsByItemId[g.item_id] = [];
      addonGroupsByItemId[g.item_id].push(g);
    }

    // 6. Build matching items results (pure in-memory — no more DB calls)
    const itemsWithDetails = matchingItems.map(item => {
      const result = {
        id: item.id,
        name: item.name,
        short: item.short_name,
        description: item.description,
        price: parseFloat(item.base_price),
        type: item.item_type,
        img: prefixImageUrl(item.image_url),
        categoryId: item.category_id,
        categoryName: item.category_name,
        taxGroupId: item.tax_group_id,
        isOpenItem: !!item.is_open_item
      };

      if (item.is_bestseller) result.bestseller = true;
      if (item.is_recommended) result.recommended = true;
      if (item.is_new) result.isNew = true;
      if (item.spice_level) result.spiceLevel = item.spice_level;
      if (item.preparation_time_mins) result.prepTime = item.preparation_time_mins;

      if (item.has_variants) {
        const variants = variantsByItemId[item.id];
        if (variants && variants.length > 0) {
          result.variants = variants.map(v => ({
            id: v.id,
            name: v.name,
            price: parseFloat(v.price),
            isDefault: v.is_default ? true : false,
            taxGroupId: v.tax_group_id
          }));
        }
      }

      if (item.has_addons) {
        const groups = addonGroupsByItemId[item.id];
        if (groups && groups.length > 0) {
          result.addons = groups.map(g => ({
            id: g.id,
            name: g.name,
            required: g.is_required || g.item_required || false,
            min: g.min_selection || 0,
            max: g.max_selection || 10,
            options: (addonsByGroupId[g.id] || []).map(a => ({
              id: a.id,
              name: a.name,
              price: parseFloat(a.price) || 0,
              type: a.item_type || 'veg'
            }))
          }));
        }
      }

      return result;
    });

    // 7. Build category results (pure in-memory)
    const categoriesWithItems = matchingCategories.map((cat, idx) => {
      const catItems = catItemResults[idx] || [];

      const itemsDetail = catItems.map(item => {
        const result = {
          id: item.id,
          name: item.name,
          short: item.short_name,
          description: item.description,
          price: parseFloat(item.base_price),
          type: item.item_type,
          img: prefixImageUrl(item.image_url),
          taxGroupId: item.tax_group_id,
          isOpenItem: !!item.is_open_item
        };

        if (item.is_bestseller) result.bestseller = true;
        if (item.is_recommended) result.recommended = true;
        if (item.is_new) result.isNew = true;
        if (item.spice_level) result.spiceLevel = item.spice_level;
        if (item.preparation_time_mins) result.prepTime = item.preparation_time_mins;

        if (item.has_variants) {
          const variants = variantsByItemId[item.id];
          if (variants && variants.length > 0) {
            result.variants = variants.map(v => ({
              id: v.id,
              name: v.name,
              price: parseFloat(v.price),
              isDefault: v.is_default ? true : false
            }));
          }
        }

        if (item.has_addons) {
          const groups = addonGroupsByItemId[item.id];
          if (groups && groups.length > 0) {
            result.addons = groups.map(g => ({
              id: g.id,
              name: g.name,
              required: g.is_required || false,
              min: g.min_selection || 0,
              max: g.max_selection || 10,
              options: (addonsByGroupId[g.id] || []).map(a => ({
                id: a.id,
                name: a.name,
                price: parseFloat(a.price) || 0
              }))
            }));
          }
        }

        return result;
      });

      return {
        id: cat.id,
        name: cat.name,
        description: cat.description,
        icon: cat.icon,
        color: cat.color_code,
        img: prefixImageUrl(cat.image_url),
        matchType: 'category',
        itemCount: itemsDetail.length,
        items: itemsDetail
      };
    });

    const searchResult = {
      query,
      matchingCategories: categoriesWithItems,
      matchingItems: itemsWithDetails,
      totalCategories: categoriesWithItems.length,
      totalItems: itemsWithDetails.length
    };

    // Store in cache (30-minute TTL = 1800 seconds)
    await cache.set(cacheKey, searchResult, 1800);

    return searchResult;
  },

  /**
   * Get bestsellers and recommended items
   */
  async getFeaturedItems(outletId, context = {}) {
    const items = await itemService.getByOutlet(outletId, {
      ...context,
      limit: 20
    });

    return {
      bestsellers: items.filter(i => i.is_bestseller),
      recommended: items.filter(i => i.is_recommended),
      newItems: items.filter(i => i.is_new)
    };
  },

  /**
   * Invalidate menu cache
   */
  async invalidateCache(outletId) {
    await Promise.all([
      cache.del(`menu:${outletId}`),
      cache.delPattern(`menu:captain:${outletId}:*`),
      cache.delPattern(`menu:search:${outletId}:*`)
    ]);
  }
};

module.exports = menuEngineService;
