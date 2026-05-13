/**
 * Bulk Upload Service
 * Simplified CSV format for menu upload (Petpooja-style)
 * 
 * CSV FORMAT:
 * Type | Name | Category | Price | FoodType | GST | Station | Description
 * 
 * Types: CATEGORY, ITEM, VARIANT, ADDON_GROUP, ADDON
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');
const csv = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

const VALID_FOOD_TYPES = ['veg', 'nonveg', 'non_veg', 'egg', 'vegan'];
const VALID_ITEM_TYPES = ['veg', 'non_veg', 'egg', 'vegan'];
const VALID_SERVICE_TYPES = ['restaurant', 'bar', 'both'];
const GST_RATES = { '0': 0, '5': 5, '12': 12, '18': 18, '28': 28 };
const VAT_RATES = { '0': 0, '5': 5, '12': 12, '18': 18, '20': 20, '25': 25, '28': 28 };

// Normalize food type to database format
const normalizeFoodType = (type) => {
  if (!type) return 'veg';
  const t = type.toLowerCase().trim();
  if (t === 'non_veg' || t === 'nonveg' || t === 'non-veg') return 'non_veg';
  if (t === 'vegan') return 'vegan';
  if (t === 'egg') return 'egg';
  return 'veg';
};

const bulkUploadService = {
  /**
   * Parse CSV content
   */
  parseCSV(csvContent) {
    try {
      const records = csv.parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        cast: (value) => (value === '' ? null : value)
      });
      return { success: true, records };
    } catch (error) {
      return { success: false, error: `CSV Error: ${error.message}` };
    }
  },

  /**
   * Validate records before processing
   */
  async validateRecords(records, outletId) {
    const errors = [];
    const warnings = [];
    const pool = getPool();

    // Load existing data
    const [categories] = await pool.query(
      'SELECT id, name FROM categories WHERE outlet_id = ? AND deleted_at IS NULL',
      [outletId]
    );
    const [items] = await pool.query(
      'SELECT id, name, sku FROM items WHERE outlet_id = ? AND deleted_at IS NULL',
      [outletId]
    );
    const [addonGroups] = await pool.query(
      'SELECT id, name FROM addon_groups WHERE outlet_id = ? AND is_active = 1',
      [outletId]
    );

    const catMap = new Map(categories.map(c => [c.name.toLowerCase(), c]));
    const itemMap = new Map(items.map(i => [i.name.toLowerCase(), i]));
    const groupMap = new Map(addonGroups.map(a => [a.name.toLowerCase(), a]));

    const newCats = new Set();
    const newItems = new Set();
    const newGroups = new Set();

    let currentCat = null;
    let currentItem = null;
    let currentGroup = null;

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      const rowNum = i + 2;
      const type = (row.Type || row.type || '').toUpperCase().trim();

      if (!type) {
        errors.push({ row: rowNum, message: 'Type is required' });
        continue;
      }

      const validTypes = ['CATEGORY', 'ITEM', 'VARIANT', 'ADDON_GROUP', 'ADDON'];
      if (!validTypes.includes(type)) {
        errors.push({ row: rowNum, message: `Invalid Type: ${type}. Use: ${validTypes.join(', ')}` });
        continue;
      }

      const name = row.Name || row.name;

      switch (type) {
        case 'CATEGORY':
          if (!name) {
            errors.push({ row: rowNum, message: 'Category Name is required' });
          } else if (catMap.has(name.toLowerCase())) {
            warnings.push({ row: rowNum, message: `Category "${name}" exists - will skip` });
          } else {
            currentCat = name;
            newCats.add(name.toLowerCase());
          }
          // Validate ServiceType if provided
          const catServiceType = (row.ServiceType || row.servicetype || 'both').toLowerCase();
          if (!VALID_SERVICE_TYPES.includes(catServiceType)) {
            errors.push({ row: rowNum, message: `Invalid ServiceType: ${catServiceType}. Use: restaurant, bar, both` });
          }
          break;

        case 'ITEM':
          if (!name) {
            errors.push({ row: rowNum, message: 'Item Name is required' });
            break;
          }
          const itemCat = row.Category || row.category || currentCat;
          if (!itemCat) {
            errors.push({ row: rowNum, message: 'Category required for item' });
          } else if (!catMap.has(itemCat.toLowerCase()) && !newCats.has(itemCat.toLowerCase())) {
            errors.push({ row: rowNum, message: `Category "${itemCat}" not found` });
          }
          const price = parseFloat(row.Price || row.price);
          if (isNaN(price) || price < 0) {
            errors.push({ row: rowNum, message: 'Valid Price required' });
          }
          // Support both ItemType and FoodType columns (ItemType takes precedence)
          const itemType = row.ItemType || row.itemtype || row.FoodType || row.foodtype || 'veg';
          const normalizedItemType = normalizeFoodType(itemType);
          if (!VALID_ITEM_TYPES.includes(normalizedItemType)) {
            errors.push({ row: rowNum, message: `Invalid ItemType: ${itemType}. Use: veg, non_veg, egg, vegan` });
          }
          // Validate ServiceType for item if provided
          const itemServiceType = (row.ServiceType || row.servicetype || 'both').toLowerCase();
          if (!VALID_SERVICE_TYPES.includes(itemServiceType)) {
            errors.push({ row: rowNum, message: `Invalid ServiceType: ${itemServiceType}. Use: restaurant, bar, both` });
          }
          if (itemMap.has(name.toLowerCase())) {
            warnings.push({ row: rowNum, message: `Item "${name}" exists - will skip` });
          } else if (newItems.has(name.toLowerCase())) {
            errors.push({ row: rowNum, message: `Duplicate item "${name}" in CSV` });
          } else {
            currentItem = name;
            newItems.add(name.toLowerCase());
          }
          break;

        case 'VARIANT':
          if (!name) {
            errors.push({ row: rowNum, message: 'Variant Name required' });
            break;
          }
          if (!currentItem && !row.Item && !row.item) {
            errors.push({ row: rowNum, message: 'Variant needs an item (place after ITEM row)' });
          }
          const varPrice = parseFloat(row.Price || row.price);
          if (isNaN(varPrice) || varPrice < 0) {
            errors.push({ row: rowNum, message: 'Valid Price required for variant' });
          }
          break;

        case 'ADDON_GROUP':
          if (!name) {
            errors.push({ row: rowNum, message: 'Addon Group Name required' });
          } else if (groupMap.has(name.toLowerCase())) {
            warnings.push({ row: rowNum, message: `Addon group "${name}" exists - will skip` });
          } else {
            currentGroup = name;
            newGroups.add(name.toLowerCase());
          }
          break;

        case 'ADDON':
          if (!name) {
            errors.push({ row: rowNum, message: 'Addon Name required' });
            break;
          }
          if (!currentGroup && !row.Group && !row.group) {
            errors.push({ row: rowNum, message: 'Addon needs a group (place after ADDON_GROUP row)' });
          }
          break;
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      summary: {
        total: records.length,
        categories: records.filter(r => (r.Type || r.type || '').toUpperCase() === 'CATEGORY').length,
        items: records.filter(r => (r.Type || r.type || '').toUpperCase() === 'ITEM').length,
        variants: records.filter(r => (r.Type || r.type || '').toUpperCase() === 'VARIANT').length,
        addonGroups: records.filter(r => (r.Type || r.type || '').toUpperCase() === 'ADDON_GROUP').length,
        addons: records.filter(r => (r.Type || r.type || '').toUpperCase() === 'ADDON').length,
        errors: errors.length,
        warnings: warnings.length
      }
    };
  },

  /**
   * Process records and insert into database
   */
  async processRecords(records, outletId, userId) {
    const pool = getPool();
    const conn = await pool.getConnection();
    
    const result = {
      success: true,
      created: { categories: 0, items: 0, variants: 0, addonGroups: 0, addons: 0 },
      updated: { categories: 0, items: 0, variants: 0, addonGroups: 0, addons: 0 },
      skipped: { categories: 0, items: 0, variants: 0, addonGroups: 0, addons: 0 },
      errors: []
    };

    try {
      await conn.beginTransaction();

      // Load existing data with full details for comparison
      const [cats] = await conn.query('SELECT id, name, description, service_type, parent_id FROM categories WHERE outlet_id = ? AND deleted_at IS NULL', [outletId]);
      const [existingItems] = await conn.query('SELECT id, name, sku, category_id, base_price, item_type, description, short_name, kitchen_station_id, tax_group_id, service_type FROM items WHERE outlet_id = ? AND deleted_at IS NULL', [outletId]);
      const [groups] = await conn.query('SELECT id, name, selection_type, min_selection, max_selection, is_required FROM addon_groups WHERE outlet_id = ? AND is_active = 1', [outletId]);
      const [stations] = await conn.query('SELECT id, name FROM kitchen_stations WHERE outlet_id = ? AND is_active = 1', [outletId]);
      const [taxGroups] = await conn.query('SELECT id, total_rate FROM tax_groups WHERE (outlet_id = ? OR outlet_id IS NULL) AND is_active = 1', [outletId]);
      
      // Load existing variants and addons for duplicate checking
      const [existingVariants] = await conn.query(
        `SELECT v.id, v.item_id, v.name, v.price, v.sku, v.is_default, i.name as item_name 
         FROM variants v JOIN items i ON v.item_id = i.id 
         WHERE i.outlet_id = ? AND v.is_active = 1`, [outletId]
      );
      const [existingAddons] = await conn.query(
        `SELECT a.id, a.addon_group_id, a.name, a.price, a.item_type, ag.name as group_name 
         FROM addons a JOIN addon_groups ag ON a.addon_group_id = ag.id 
         WHERE ag.outlet_id = ? AND a.is_active = 1`, [outletId]
      );

      // Maps for quick lookup
      const catMap = new Map(cats.map(c => [c.name.toLowerCase(), c]));
      const itemMap = new Map(existingItems.map(i => [i.name.toLowerCase(), i]));
      const groupMap = new Map(groups.map(a => [a.name.toLowerCase(), a]));
      const stationMap = new Map(stations.map(s => [s.name.toLowerCase(), s.id]));
      const taxMap = new Map(taxGroups.map(t => [String(t.total_rate), t.id]));
      
      // Variant map: key = "itemname|variantname"
      const variantMap = new Map(existingVariants.map(v => [`${v.item_name.toLowerCase()}|${v.name.toLowerCase()}`, v]));
      // Addon map: key = "groupname|addonname"
      const addonMap = new Map(existingAddons.map(a => [`${a.group_name.toLowerCase()}|${a.name.toLowerCase()}`, a]));

      let currentCatId = null;
      let currentItemId = null;
      let currentGroupId = null;
      let order = 0;

      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const rowNum = i + 2;
        const type = (row.Type || row.type || '').toUpperCase().trim();
        const name = row.Name || row.name;

        try {
          switch (type) {
            case 'CATEGORY': {
              const nameLower = name.trim().toLowerCase();
              const description = row.Description || row.description || null;
              const serviceType = (row.ServiceType || row.servicetype || 'both').toLowerCase();
              let parentId = null;
              const parent = row.Parent || row.parent;
              if (parent) {
                const parentCat = catMap.get(parent.toLowerCase());
                parentId = parentCat ? parentCat.id : null;
              }
              
              if (catMap.has(nameLower)) {
                const existing = catMap.get(nameLower);
                currentCatId = existing.id;
                
                // Check if any data changed
                const hasChanges = 
                  (description && description !== existing.description) ||
                  (serviceType !== existing.service_type) ||
                  (parentId !== existing.parent_id);
                
                if (hasChanges) {
                  await conn.query(
                    `UPDATE categories SET description = COALESCE(?, description), service_type = ?, parent_id = ? WHERE id = ?`,
                    [description, serviceType, parentId, existing.id]
                  );
                  result.updated.categories++;
                } else {
                  result.skipped.categories++;
                }
              } else {
                const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const [r] = await conn.query(
                  `INSERT INTO categories (outlet_id, parent_id, name, slug, description, display_order, is_active, service_type) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
                  [outletId, parentId, name.trim(), slug, description, order++, serviceType]
                );
                catMap.set(nameLower, { id: r.insertId, name: name.trim(), description, service_type: serviceType, parent_id: parentId });
                currentCatId = r.insertId;
                result.created.categories++;
              }
              break;
            }

            case 'ITEM': {
              const nameLower = name.trim().toLowerCase();
              const catName = row.Category || row.category;
              const catEntry = catName ? catMap.get(catName.toLowerCase()) : null;
              const catId = catEntry ? catEntry.id : currentCatId;
              if (!catId) throw new Error(`Category not found for item "${name}"`);

              const price = parseFloat(row.Price || row.price) || 0;
              const rawItemType = row.ItemType || row.itemtype || row.FoodType || row.foodtype || 'veg';
              const itemType = normalizeFoodType(rawItemType);
              const serviceType = (row.ServiceType || row.servicetype || 'both').toLowerCase();
              const description = row.Description || row.description || null;
              const shortName = row.ShortName || row.shortname || null;
              
              const gst = row.GST || row.gst;
              const vat = row.VAT || row.vat;
              let taxGroupId = null;
              
              // VAT takes precedence for liquor items
              if (vat && VAT_RATES[vat] !== undefined) {
                const vatKey = `VAT_${vat}`;
                taxGroupId = taxMap.get(vatKey) || await this._getOrCreateVatGroup(conn, outletId, vat);
                if (taxGroupId) taxMap.set(vatKey, taxGroupId);
              } else if (gst && GST_RATES[gst] !== undefined) {
                taxGroupId = taxMap.get(gst) || await this._getOrCreateTaxGroup(conn, outletId, gst);
                if (taxGroupId) taxMap.set(gst, taxGroupId);
              }

              // Normalize station to Kitchen or Bar only
              let stationName = row.Station || row.station || '';
              // Bar items (liquor with VAT) go to Bar station, everything else to Kitchen
              if (serviceType === 'bar' || (vat && !gst)) {
                stationName = 'Bar';
              } else if (stationName.toLowerCase() !== 'bar') {
                // All food items (including Tandoor, Dessert, etc.) go to Kitchen
                stationName = 'Kitchen';
              }
              
              let stationId = null;
              if (stationName) {
                stationId = stationMap.get(stationName.toLowerCase());
                if (!stationId) {
                  const [sr] = await conn.query(
                    `INSERT INTO kitchen_stations (outlet_id, name, code, station_type, is_active) VALUES (?, ?, ?, 'main_kitchen', 1)`,
                    [outletId, stationName, stationName.toUpperCase().replace(/\s+/g, '_')]
                  );
                  stationId = sr.insertId;
                  stationMap.set(stationName.toLowerCase(), stationId);
                }
              }

              if (itemMap.has(nameLower)) {
                const existing = itemMap.get(nameLower);
                currentItemId = existing.id;
                
                // Check if any data changed
                const hasChanges = 
                  (catId !== existing.category_id) ||
                  (price !== parseFloat(existing.base_price)) ||
                  (itemType !== existing.item_type) ||
                  (serviceType !== existing.service_type) ||
                  (description && description !== existing.description) ||
                  (shortName && shortName !== existing.short_name) ||
                  (stationId && stationId !== existing.kitchen_station_id) ||
                  (taxGroupId && taxGroupId !== existing.tax_group_id);
                
                if (hasChanges) {
                  await conn.query(
                    `UPDATE items SET category_id = ?, base_price = ?, item_type = ?, service_type = ?, 
                     description = COALESCE(?, description), short_name = COALESCE(?, short_name),
                     kitchen_station_id = COALESCE(?, kitchen_station_id), tax_group_id = COALESCE(?, tax_group_id)
                     WHERE id = ?`,
                    [catId, price, itemType, serviceType, description, shortName, stationId, taxGroupId, existing.id]
                  );
                  result.updated.items++;
                } else {
                  result.skipped.items++;
                }
              } else {
                const sku = row.SKU || row.sku || `ITM${Date.now()}${Math.random().toString(36).substr(2, 4)}`;
                const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

                const [r] = await conn.query(
                  `INSERT INTO items (outlet_id, category_id, sku, name, short_name, slug, description, item_type, base_price, tax_group_id, kitchen_station_id, display_order, is_active, is_available, service_type)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
                  [outletId, catId, sku, name.trim(), shortName, slug, description, itemType, price, taxGroupId, stationId, order++, serviceType]
                );
                itemMap.set(nameLower, { id: r.insertId, name: name.trim(), category_id: catId, base_price: price, item_type: itemType, service_type: serviceType, description, short_name: shortName, kitchen_station_id: stationId, tax_group_id: taxGroupId });
                currentItemId = r.insertId;
                result.created.items++;
              }
              break;
            }

            case 'VARIANT': {
              const itemName = row.Item || row.item;
              let resolvedItemName = itemName;
              let itemId = null;
              
              if (itemName) {
                const itemEntry = itemMap.get(itemName.toLowerCase());
                itemId = itemEntry ? itemEntry.id : null;
                resolvedItemName = itemName;
              } else {
                // Use current item context
                const currentEntry = Array.from(itemMap.values()).find(i => i.id === currentItemId);
                itemId = currentItemId;
                resolvedItemName = currentEntry ? currentEntry.name : null;
              }
              
              if (!itemId) throw new Error(`Item not found for variant "${name}"`);

              const price = parseFloat(row.Price || row.price) || 0;
              const isDefault = (row.Default || row.default || '').toLowerCase() === 'yes';
              const variantKey = `${resolvedItemName.toLowerCase()}|${name.trim().toLowerCase()}`;
              
              if (variantMap.has(variantKey)) {
                const existing = variantMap.get(variantKey);
                
                // Check if data changed
                const hasChanges = 
                  (price !== parseFloat(existing.price)) ||
                  (isDefault !== (existing.is_default === 1));
                
                if (hasChanges) {
                  await conn.query(
                    `UPDATE variants SET price = ?, is_default = ? WHERE id = ?`,
                    [price, isDefault, existing.id]
                  );
                  result.updated.variants++;
                } else {
                  result.skipped.variants++;
                }
              } else {
                const sku = row.SKU || row.sku || `VAR${Date.now()}${Math.random().toString(36).substr(2, 4)}`;
                
                await conn.query(
                  `INSERT INTO variants (item_id, name, sku, price, is_default, display_order, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)`,
                  [itemId, name.trim(), sku, price, isDefault, order++]
                );
                await conn.query('UPDATE items SET has_variants = 1 WHERE id = ?', [itemId]);
                variantMap.set(variantKey, { id: null, item_id: itemId, name: name.trim(), price, is_default: isDefault ? 1 : 0 });
                result.created.variants++;
              }
              break;
            }

            case 'ADDON_GROUP': {
              const nameLower = name.trim().toLowerCase();
              const selType = (row.SelectionType || row.selectiontype || 'multiple').toLowerCase();
              const minSel = parseInt(row.Min || row.min) || 0;
              const maxSel = parseInt(row.Max || row.max) || 10;
              const required = (row.Required || row.required || '').toLowerCase() === 'yes';
              
              if (groupMap.has(nameLower)) {
                const existing = groupMap.get(nameLower);
                currentGroupId = existing.id;
                
                // Check if data changed
                const hasChanges = 
                  (selType !== existing.selection_type) ||
                  (minSel !== existing.min_selection) ||
                  (maxSel !== existing.max_selection) ||
                  (required !== (existing.is_required === 1));
                
                if (hasChanges) {
                  await conn.query(
                    `UPDATE addon_groups SET selection_type = ?, min_selection = ?, max_selection = ?, is_required = ? WHERE id = ?`,
                    [selType, minSel, maxSel, required, existing.id]
                  );
                  result.updated.addonGroups++;
                } else {
                  result.skipped.addonGroups++;
                }
              } else {
                const [r] = await conn.query(
                  `INSERT INTO addon_groups (outlet_id, name, selection_type, min_selection, max_selection, is_required, display_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                  [outletId, name.trim(), selType, minSel, maxSel, required, order++]
                );
                groupMap.set(nameLower, { id: r.insertId, name: name.trim(), selection_type: selType, min_selection: minSel, max_selection: maxSel, is_required: required ? 1 : 0 });
                currentGroupId = r.insertId;
                result.created.addonGroups++;
              }
              break;
            }

            case 'ADDON': {
              const groupName = row.Group || row.group;
              let resolvedGroupName = groupName;
              let groupId = null;
              
              if (groupName) {
                const groupEntry = groupMap.get(groupName.toLowerCase());
                groupId = groupEntry ? groupEntry.id : null;
                resolvedGroupName = groupName;
              } else {
                // Use current group context
                const currentEntry = Array.from(groupMap.values()).find(g => g.id === currentGroupId);
                groupId = currentGroupId;
                resolvedGroupName = currentEntry ? currentEntry.name : null;
              }
              
              if (!groupId) throw new Error(`Addon group not found for addon "${name}"`);

              const price = parseFloat(row.Price || row.price) || 0;
              const foodType = normalizeFoodType(row.ItemType || row.itemtype || row.FoodType || row.foodtype || 'veg');
              const addonKey = `${resolvedGroupName.toLowerCase()}|${name.trim().toLowerCase()}`;
              
              if (addonMap.has(addonKey)) {
                const existing = addonMap.get(addonKey);
                
                // Check if data changed
                const hasChanges = 
                  (price !== parseFloat(existing.price)) ||
                  (foodType !== existing.item_type);
                
                if (hasChanges) {
                  await conn.query(
                    `UPDATE addons SET price = ?, item_type = ? WHERE id = ?`,
                    [price, foodType, existing.id]
                  );
                  result.updated.addons++;
                } else {
                  result.skipped.addons++;
                }
              } else {
                await conn.query(
                  `INSERT INTO addons (addon_group_id, name, price, item_type, display_order, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
                  [groupId, name.trim(), price, foodType, order++]
                );
                addonMap.set(addonKey, { id: null, addon_group_id: groupId, name: name.trim(), price, item_type: foodType });
                result.created.addons++;
              }
              break;
            }
          }
        } catch (rowErr) {
          result.errors.push({ row: rowNum, message: rowErr.message });
        }
      }

      // Update items with variants to use smallest variant price as base_price
      // Only for items where base_price is 0 or not set
      await conn.query(`
        UPDATE items i
        SET base_price = (
          SELECT MIN(v.price) FROM variants v WHERE v.item_id = i.id AND v.is_active = 1
        )
        WHERE i.outlet_id = ? 
          AND i.has_variants = 1 
          AND (i.base_price IS NULL OR i.base_price = 0)
          AND EXISTS (SELECT 1 FROM variants v WHERE v.item_id = i.id AND v.is_active = 1)
      `, [outletId]);

      await conn.commit();
      await this._invalidateCaches(outletId);
      logger.info(`Bulk upload completed for outlet ${outletId}:`, result);

    } catch (error) {
      await conn.rollback();
      result.success = false;
      result.errors.push({ row: 0, message: `Transaction failed: ${error.message}` });
      logger.error('Bulk upload failed:', error);
    } finally {
      conn.release();
    }

    return result;
  },

  async _getOrCreateTaxGroup(conn, outletId, rate) {
    const [existing] = await conn.query(
      'SELECT id FROM tax_groups WHERE total_rate = ? AND (outlet_id = ? OR outlet_id IS NULL) AND is_active = 1 LIMIT 1',
      [rate, outletId]
    );
    if (existing.length > 0) return existing[0].id;

    const [r] = await conn.query(
      `INSERT INTO tax_groups (outlet_id, name, code, total_rate, is_active) VALUES (?, ?, ?, ?, 1)`,
      [outletId, `GST ${rate}%`, `GST_${rate}`, rate]
    );
    return r.insertId;
  },

  async _getOrCreateVatGroup(conn, outletId, rate) {
    // Check for existing VAT group
    const [existing] = await conn.query(
      `SELECT id FROM tax_groups WHERE code = ? AND (outlet_id = ? OR outlet_id IS NULL) AND is_active = 1 LIMIT 1`,
      [`VAT_${rate}`, outletId]
    );
    if (existing.length > 0) return existing[0].id;

    // Create VAT tax group for liquor
    const [r] = await conn.query(
      `INSERT INTO tax_groups (outlet_id, name, code, total_rate, is_active) VALUES (?, ?, ?, ?, 1)`,
      [outletId, `VAT ${rate}%`, `VAT_${rate}`, rate]
    );
    return r.insertId;
  },

  async _invalidateCaches(outletId) {
    try {
      await cache.del(`categories:${outletId}:false`);
      await cache.del(`categories:${outletId}:true`);
      await cache.del(`items:${outletId}`);
      await cache.del(`addon_groups:${outletId}`);
      await cache.del(`kitchen_stations:${outletId}`);
    } catch (e) {
      logger.warn('Cache invalidation error:', e);
    }
  },

  // ========================
  // SUPER ADMIN MENU TEMPLATE (Versioned)
  // ========================

  /**
   * Publish a new versioned template for a super admin.
   * Auto-increments version, sets it as active, deactivates previous active version.
   */
  async saveSuperAdminTemplate(userId, csvContent, label = null) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Get next version number
      const [[maxRow]] = await conn.query(
        'SELECT COALESCE(MAX(version), 0) AS max_version FROM super_admin_menu_templates WHERE user_id = ?',
        [userId]
      );
      const nextVersion = (maxRow.max_version || 0) + 1;

      // Deactivate current active version
      await conn.query(
        'UPDATE super_admin_menu_templates SET is_active = 0 WHERE user_id = ? AND is_active = 1',
        [userId]
      );

      // Insert new version as active
      await conn.query(
        `INSERT INTO super_admin_menu_templates (user_id, version, label, template_data, is_active)
         VALUES (?, ?, ?, ?, 1)`,
        [userId, nextVersion, label, csvContent]
      );

      await conn.commit();
      return { success: true, version: nextVersion, message: `Template published as version ${nextVersion}` };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /**
   * List all template versions for a super admin.
   */
  async listSuperAdminTemplateVersions(userId) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, version, label, is_active,
              LENGTH(template_data) AS size_bytes,
              created_at, updated_at
       FROM super_admin_menu_templates
       WHERE user_id = ?
       ORDER BY version DESC`,
      [userId]
    );
    return rows;
  },

  /**
   * Get a super admin's active (published) template CSV data.
   */
  async getSuperAdminTemplate(userId) {
    const pool = getPool();
    const [[row]] = await pool.query(
      'SELECT template_data FROM super_admin_menu_templates WHERE user_id = ? AND is_active = 1 LIMIT 1',
      [userId]
    );
    return row ? row.template_data : null;
  },

  /**
   * Get a specific version of a super admin's template CSV data.
   */
  async getSuperAdminTemplateByVersion(userId, version) {
    const pool = getPool();
    const [[row]] = await pool.query(
      'SELECT template_data, label, is_active FROM super_admin_menu_templates WHERE user_id = ? AND version = ?',
      [userId, version]
    );
    return row || null;
  },

  /**
   * Activate (publish) a specific version, deactivating all others.
   */
  async activateSuperAdminTemplateVersion(userId, version) {
    const pool = getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [exists] = await conn.query(
        'SELECT id FROM super_admin_menu_templates WHERE user_id = ? AND version = ?',
        [userId, version]
      );
      if (!exists.length) throw new Error(`Version ${version} not found`);

      await conn.query(
        'UPDATE super_admin_menu_templates SET is_active = 0 WHERE user_id = ?',
        [userId]
      );
      await conn.query(
        'UPDATE super_admin_menu_templates SET is_active = 1 WHERE user_id = ? AND version = ?',
        [userId, version]
      );
      await conn.commit();
      return { success: true, message: `Version ${version} is now active` };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  /**
   * Delete a specific version of a super admin's template.
   * Cannot delete the currently active version if it's the only one.
   */
  async deleteSuperAdminTemplateVersion(userId, version) {
    const pool = getPool();
    const [[row]] = await pool.query(
      'SELECT id, is_active FROM super_admin_menu_templates WHERE user_id = ? AND version = ?',
      [userId, version]
    );
    if (!row) throw new Error(`Version ${version} not found`);
    if (row.is_active) {
      const [[countRow]] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM super_admin_menu_templates WHERE user_id = ?',
        [userId]
      );
      if (countRow.cnt <= 1) throw new Error('Cannot delete the only active template version');
    }
    await pool.query(
      'DELETE FROM super_admin_menu_templates WHERE user_id = ? AND version = ?',
      [userId, version]
    );
    return { success: true, message: `Version ${version} deleted` };
  },

  /**
   * Delete ALL versions of a super admin's template.
   */
  async deleteSuperAdminTemplate(userId) {
    const pool = getPool();
    const [result] = await pool.query(
      'DELETE FROM super_admin_menu_templates WHERE user_id = ?',
      [userId]
    );
    return { success: true, deleted: result.affectedRows > 0 };
  },

  /**
   * Resolve outlet → super admin → template.
   * Returns the template string if the outlet's super admin has one,
   * otherwise null.
   */
  async getSuperAdminTemplateForOutlet(outletId) {
    const pool = getPool();

    // Path 1: Check user_roles for an active super_admin explicitly assigned to this outlet
    const [[assignedSuperAdmin]] = await pool.query(
      `SELECT ur.user_id AS super_admin_id
       FROM user_roles ur
       INNER JOIN roles r ON r.id = ur.role_id
       WHERE ur.outlet_id = ? AND r.slug = 'super_admin' AND ur.is_active = 1
       LIMIT 1`,
      [outletId]
    );

    // Path 2: Check outlets.created_by where creator is a super_admin
    let creatorSuperAdminId = null;
    if (!assignedSuperAdmin || !assignedSuperAdmin.super_admin_id) {
      const [[outlet]] = await pool.query(
        `SELECT o.created_by AS super_admin_id
         FROM outlets o
         INNER JOIN user_roles ur ON ur.user_id = o.created_by AND ur.is_active = 1
         INNER JOIN roles r ON r.id = ur.role_id AND r.slug = 'super_admin'
         WHERE o.id = ?
         LIMIT 1`,
        [outletId]
      );
      creatorSuperAdminId = outlet ? outlet.super_admin_id : null;
    }

    const superAdminId = (assignedSuperAdmin && assignedSuperAdmin.super_admin_id) || creatorSuperAdminId;
    if (!superAdminId) return null;

    const [[row]] = await pool.query(
      'SELECT template_data FROM super_admin_menu_templates WHERE user_id = ?',
      [superAdminId]
    );
    return row ? row.template_data : null;
  },

  /**
   * Generate CSV template — outlet-specific if outletId provided,
   * otherwise falls back to the sample/default template.
   */
  async generateTemplate(outletId) {
    if (outletId) {
      // Priority 1: Return the outlet's super admin master template (if set)
      try {
        const superAdminTemplate = await this.getSuperAdminTemplateForOutlet(outletId);
        if (superAdminTemplate) {
          logger.info(`Serving super admin template for outlet ${outletId}`);
          return superAdminTemplate;
        }
      } catch (err) {
        logger.warn(`Failed to fetch super admin template for outlet ${outletId}:`, err.message);
      }

      // Priority 2: Fall back to the outlet's current live menu export
      try {
        const outletTemplate = await this._generateOutletTemplate(outletId);
        if (outletTemplate) return outletTemplate;
      } catch (err) {
        logger.warn(`Failed to generate outlet template for ${outletId}, falling back to default:`, err.message);
      }
    }

    // Fallback: read from sample data file or use default template
    const sampleFilePath = path.join(__dirname, '../../menu-want/Complete_BulkUpload.csv');

    try {
      if (fs.existsSync(sampleFilePath)) {
        const sampleData = fs.readFileSync(sampleFilePath, 'utf-8');
        logger.info('Serving bulk upload template from sample file');
        return sampleData;
      }
    } catch (err) {
      logger.warn('Could not read sample file, using default template:', err.message);
    }

    // Fallback to basic template if sample file not found
    const header = 'Type,Name,Category,Price,ItemType,GST,VAT,Station,Description,Parent,ShortName,SKU,Default,SelectionType,Min,Max,Required,Group,Item,ServiceType';
    const examples = [
      '# MENU CATEGORIES - ServiceType: restaurant, bar, both',
      'CATEGORY,Starters,,,,,,,Appetizers and snacks,,,,,,,,,,,restaurant',
      'CATEGORY,Veg Starters,,,,,,,Vegetarian starters,Starters,,,,,,,,,,restaurant',
      'CATEGORY,Beverages,,,,,,,Drinks and beverages,,,,,,,,,,,both',
      'CATEGORY,Whisky,,,,,,,Whisky category,,,,,,,,,,,bar',
      '',
      '# MENU ITEMS - Station: Kitchen or Bar only',
      'ITEM,Paneer Tikka,Veg Starters,250,veg,5,,Kitchen,Grilled cottage cheese,,P.Tikka,PTK001,,,,,,,,restaurant',
      'ITEM,Chicken Tikka,Veg Starters,320,non_veg,5,,Kitchen,Grilled chicken pieces,,C.Tikka,CTK001,,,,,,,,restaurant',
      '',
      '# LIQUOR ITEMS - Use VAT instead of GST, Station: Bar',
      'ITEM,Royal Stag,Whisky,110,veg,,18,Bar,,,Roya Stag,WHI001,,,,,,,,bar',
      '',
      '# VARIANTS (Place after ITEM row, or specify Item column)',
      'VARIANT,Small 30 ML,,110,,,,,,,,,no,,,,,Royal Stag,',
      'VARIANT,Large 60 ML,,210,,,,,,,,,no,,,,,Royal Stag,',
      '',
      '# ADDON GROUPS',
      'ADDON_GROUP,Extra Toppings,,,,,,,,,,,,multiple,0,3,no,,,',
      '',
      '# ADDONS (Group column references the ADDON_GROUP)',
      'ADDON,Extra Cheese,,30,veg,,,,,,,,,,,,,Extra Toppings,,'
    ];

    return header + '\n' + examples.join('\n');
  },

  /**
   * Export an outlet's current menu into CSV template format.
   * Returns null if outlet has no menu data.
   */
  async _generateOutletTemplate(outletId) {
    const pool = getPool();
    const header = 'Type,Name,Category,Price,ItemType,GST,VAT,Station,Description,Parent,ShortName,SKU,Default,SelectionType,Min,Max,Required,Group,Item,ServiceType';

    const [catRows] = await pool.query(
      `SELECT id, name, description, service_type, parent_id, display_order
       FROM categories
       WHERE outlet_id = ? AND deleted_at IS NULL
       ORDER BY display_order, id`,
      [outletId]
    );

    if (!catRows.length) return null;

    const [itemRows] = await pool.query(
      `SELECT i.id, i.name, i.sku, i.category_id, i.base_price, i.item_type,
              i.description, i.short_name, i.service_type, i.kitchen_station_id,
              i.tax_group_id, i.display_order, i.has_variants,
              c.name AS category_name
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       WHERE i.outlet_id = ? AND i.deleted_at IS NULL
       ORDER BY i.category_id, i.display_order, i.id`,
      [outletId]
    );

    const [variantRows] = await pool.query(
      `SELECT v.id, v.item_id, v.name, v.sku, v.price, v.is_default,
              v.display_order, i.name AS item_name
       FROM variants v
       JOIN items i ON i.id = v.item_id
       WHERE i.outlet_id = ? AND v.is_active = 1
       ORDER BY v.item_id, v.display_order, v.id`,
      [outletId]
    );

    const [groupRows] = await pool.query(
      `SELECT id, name, selection_type, min_selection, max_selection,
              is_required, display_order
       FROM addon_groups
       WHERE outlet_id = ? AND is_active = 1
       ORDER BY display_order, id`,
      [outletId]
    );

    const [addonRows] = await pool.query(
      `SELECT a.id, a.addon_group_id, a.name, a.price, a.item_type,
              a.display_order, ag.name AS group_name
       FROM addons a
       JOIN addon_groups ag ON ag.id = a.addon_group_id
       WHERE ag.outlet_id = ? AND a.is_active = 1
       ORDER BY a.addon_group_id, a.display_order, a.id`,
      [outletId]
    );

    // Build lookup maps
    const catMap = new Map(catRows.map(c => [c.id, c]));
    const itemMap = new Map(itemRows.map(i => [i.id, i]));

    // Tax groups for GST/VAT lookup
    const [taxRows] = await pool.query(
      `SELECT id, code, total_rate FROM tax_groups
       WHERE (outlet_id = ? OR outlet_id IS NULL) AND is_active = 1`,
      [outletId]
    );
    const taxMap = new Map(taxRows.map(t => [t.id, t]));

    // Kitchen stations for station name lookup
    const [stationRows] = await pool.query(
      `SELECT id, name FROM kitchen_stations
       WHERE outlet_id = ? AND is_active = 1`,
      [outletId]
    );
    const stationMap = new Map(stationRows.map(s => [s.id, s.name]));

    const rows = [];

    // Helper to safely escape CSV values
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const makeRow = (cols) => cols.map(esc).join(',');

    // ── Categories (parents first so subcategories can reference them) ──
    // Sort so parent categories appear before child categories
    const sortedCats = [...catRows].sort((a, b) => {
      const aParent = a.parent_id;
      const bParent = b.parent_id;
      if (!aParent && bParent) return -1;
      if (aParent && !bParent) return 1;
      return a.display_order - b.display_order || a.id - b.id;
    });

    rows.push('# CATEGORIES - ServiceType: restaurant, bar, both');
    for (const c of sortedCats) {
      rows.push(makeRow([
        'CATEGORY', c.name, '', '', '', '', '', '',
        c.description || '',
        c.parent_id ? (catMap.get(c.parent_id)?.name || '') : '',
        '', '', '', '', '', '', '', '', '', '',
        c.service_type || 'both'
      ]));
    }

    // ── Items ──
    if (itemRows.length) {
      rows.push('');
      rows.push('# ITEMS - Station: Kitchen or Bar only');
      for (const i of itemRows) {
        let gst = '';
        let vat = '';
        const tax = taxMap.get(i.tax_group_id);
        if (tax) {
          if (tax.code && tax.code.startsWith('VAT_')) {
            vat = tax.code.replace('VAT_', '');
          } else if (tax.code && tax.code.startsWith('GST_')) {
            gst = tax.code.replace('GST_', '');
          } else {
            // Fallback: match total_rate to known GST/VAT rates
            const rate = String(tax.total_rate);
            if (GST_RATES[rate] !== undefined) gst = rate;
            else if (VAT_RATES[rate] !== undefined) vat = rate;
          }
        }

        const stationName = stationMap.get(i.kitchen_station_id) || '';

        rows.push(makeRow([
          'ITEM', i.name, i.category_name || '',
          i.has_variants ? '0' : (i.base_price || '0'),
          i.item_type || 'veg',
          gst, vat, stationName,
          i.description || '', '',
          i.short_name || '',
          i.sku || '', '', '', '', '', '', '', '', '',
          i.service_type || 'both'
        ]));
      }
    }

    // ── Variants ──
    if (variantRows.length) {
      rows.push('');
      rows.push('# VARIANTS (Place after ITEM row, or specify Item column)');
      for (const v of variantRows) {
        const parentItem = itemMap.get(v.item_id);
        rows.push(makeRow([
          'VARIANT', v.name, '', v.price || '0', '', '', '', '', '', '', '', '',
          v.is_default ? 'yes' : 'no',
          '', '', '', '', '', '', '',
          parentItem ? parentItem.name : ''
        ]));
      }
    }

    // ── Addon Groups ──
    if (groupRows.length) {
      rows.push('');
      rows.push('# ADDON GROUPS');
      for (const g of groupRows) {
        rows.push(makeRow([
          'ADDON_GROUP', g.name, '', '', '', '', '', '', '', '', '', '', '',
          g.selection_type || 'multiple',
          g.min_selection || '0',
          g.max_selection || '10',
          g.is_required ? 'yes' : 'no',
          '', '', ''
        ]));
      }
    }

    // ── Addons ──
    if (addonRows.length) {
      rows.push('');
      rows.push('# ADDONS (Group column references the ADDON_GROUP)');
      for (const a of addonRows) {
        rows.push(makeRow([
          'ADDON', a.name, '', a.price || '0',
          a.item_type || 'veg',
          '', '', '', '', '', '', '', '', '', '', '', '',
          a.group_name || '', '', ''
        ]));
      }
    }

    return header + '\n' + rows.join('\n');
  },

  /**
   * Get template structure for frontend
   */
  getTemplateStructure() {
    return {
      columns: [
        { name: 'Type', required: true, description: 'CATEGORY, ITEM, VARIANT, ADDON_GROUP, ADDON' },
        { name: 'Name', required: true, description: 'Name of the item/category/addon' },
        { name: 'Category', required: false, description: 'Category name (for items)' },
        { name: 'Price', required: false, description: 'Price (required for ITEM, VARIANT, ADDON). For items with variants, use smallest variant price or leave 0.' },
        { name: 'ItemType', required: false, description: 'veg, non_veg, egg, vegan (for items)' },
        { name: 'GST', required: false, description: 'GST tax rate: 0, 5, 12, 18, 28 (for food items)' },
        { name: 'VAT', required: false, description: 'VAT tax rate: 0, 5, 12, 18, 20, 25, 28 (for liquor items)' },
        { name: 'Station', required: false, description: 'Kitchen or Bar only (for items). Food items use Kitchen, liquor items use Bar.' },
        { name: 'Description', required: false, description: 'Description text' },
        { name: 'Parent', required: false, description: 'Parent category (for subcategories)' },
        { name: 'ShortName', required: false, description: 'Short name for KOT' },
        { name: 'SKU', required: false, description: 'Item/variant code' },
        { name: 'Default', required: false, description: 'Is default variant (yes/no)' },
        { name: 'SelectionType', required: false, description: 'single/multiple (for addon groups)' },
        { name: 'Min', required: false, description: 'Min selection (for addon groups)' },
        { name: 'Max', required: false, description: 'Max selection (for addon groups)' },
        { name: 'Required', required: false, description: 'Is required (yes/no)' },
        { name: 'Group', required: false, description: 'Addon group name (for addons)' },
        { name: 'Item', required: false, description: 'Item name (for variants)' },
        { name: 'ServiceType', required: false, description: 'restaurant, bar, both (for categories/items)' }
      ],
      types: {
        CATEGORY: { required: ['Name'], optional: ['Description', 'Parent', 'ServiceType'] },
        ITEM: { required: ['Name'], optional: ['Category', 'Price', 'ItemType', 'GST', 'VAT', 'Station', 'Description', 'ShortName', 'SKU', 'ServiceType'] },
        VARIANT: { required: ['Name', 'Price'], optional: ['Item', 'SKU', 'Default'] },
        ADDON_GROUP: { required: ['Name'], optional: ['SelectionType', 'Min', 'Max', 'Required'] },
        ADDON: { required: ['Name'], optional: ['Group', 'Price', 'ItemType'] }
      },
      itemTypes: ['veg', 'non_veg', 'egg', 'vegan'],
      serviceTypes: ['restaurant', 'bar', 'both'],
      stations: ['Kitchen', 'Bar'],
      foodTypes: ['veg', 'nonveg', 'non_veg', 'egg', 'vegan'],
      gstRates: ['0', '5', '12', '18', '28'],
      vatRates: ['0', '5', '12', '18', '20', '25', '28']
    };
  },

  /**
   * Get upload history
   */
  async getUploadHistory(outletId, limit = 20) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT * FROM bulk_upload_logs WHERE outlet_id = ? ORDER BY created_at DESC LIMIT ?`,
      [outletId, limit]
    );
    return rows.map(h => ({
      id: h.id,
      filename: h.filename,
      status: h.status,
      summary: h.summary ? JSON.parse(h.summary) : null,
      errors: h.errors ? JSON.parse(h.errors) : null,
      createdAt: h.created_at
    }));
  },

  /**
   * Log upload attempt
   */
  async logUpload(outletId, userId, filename, result) {
    const pool = getPool();
    await pool.query(
      `INSERT INTO bulk_upload_logs (outlet_id, user_id, filename, status, summary, errors, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [outletId, userId, filename, result.success ? 'success' : 'failed', JSON.stringify(result.created), JSON.stringify(result.errors)]
    );
  }
};

module.exports = bulkUploadService;
