/**
 * Addon Service
 * Handles addon groups and addons (Toppings, Extras, Sides, etc.)
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_TTL = 3600;

const addonService = {
  // ========================
  // ADDON GROUPS
  // ========================

  async createGroup(data) {
    const pool = getPool();
    const {
      outletId, name, description,
      selectionType = 'multiple', minSelection = 0, maxSelection = 10,
      isRequired = false, displayOrder = 0, isActive = true
    } = data;

    const [result] = await pool.query(
      `INSERT INTO addon_groups (outlet_id, name, description, selection_type, min_selection, max_selection, is_required, display_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [outletId, name, description, selectionType, minSelection, maxSelection, isRequired, displayOrder, isActive]
    );

    await this.invalidateCache(outletId);
    return { id: result.insertId, ...data };
  },

  async getGroups(outletId) {
    const cacheKey = `addon_groups:${outletId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const pool = getPool();
    const [groups] = await pool.query(
      `SELECT ag.*,
        (SELECT COUNT(*) FROM addons a WHERE a.addon_group_id = ag.id) as addon_count,
        (SELECT COUNT(*) FROM addons a WHERE a.addon_group_id = ag.id AND a.is_active = 1) as active_addon_count
       FROM addon_groups ag
       WHERE ag.outlet_id = ?
       ORDER BY ag.display_order, ag.name`,
      [outletId]
    );

    await cache.set(cacheKey, groups, CACHE_TTL);
    return groups;
  },

  async getGroupById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT * FROM addon_groups WHERE id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async getGroupWithAddons(id) {
    const group = await this.getGroupById(id);
    if (!group) return null;

    const pool = getPool();
    const [addons] = await pool.query(
      `SELECT * FROM addons WHERE addon_group_id = ? ORDER BY display_order, name`,
      [id]
    );

    return { ...group, addons };
  },

  async updateGroup(id, data) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
    if (data.selectionType !== undefined) { fields.push('selection_type = ?'); values.push(data.selectionType); }
    if (data.minSelection !== undefined) { fields.push('min_selection = ?'); values.push(data.minSelection); }
    if (data.maxSelection !== undefined) { fields.push('max_selection = ?'); values.push(data.maxSelection); }
    if (data.isRequired !== undefined) { fields.push('is_required = ?'); values.push(data.isRequired); }
    if (data.displayOrder !== undefined) { fields.push('display_order = ?'); values.push(data.displayOrder); }
    if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive); }

    if (fields.length === 0) return null;
    values.push(id);

    await pool.query(`UPDATE addon_groups SET ${fields.join(', ')} WHERE id = ?`, values);

    const group = await this.getGroupById(id);
    if (group) await this.invalidateCache(group.outlet_id);
    return group;
  },

  async deleteGroup(id) {
    const pool = getPool();
    const group = await this.getGroupById(id);
    if (!group) return false;

    await pool.query('UPDATE addon_groups SET is_active = 0 WHERE id = ?', [id]);
    await this.invalidateCache(group.outlet_id);
    return true;
  },

  // ========================
  // ADDONS
  // ========================

  async createAddon(data) {
    const pool = getPool();
    const {
      addonGroupId, name, price = 0, itemType = 'veg', imageUrl,
      isDefault = false, displayOrder = 0, isActive = true
    } = data;

    const [result] = await pool.query(
      `INSERT INTO addons (addon_group_id, name, price, item_type, image_url, is_default, display_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [addonGroupId, name, price, itemType, imageUrl, isDefault, displayOrder, isActive]
    );

    // Invalidate cache
    const group = await this.getGroupById(addonGroupId);
    if (group) await this.invalidateCache(group.outlet_id);

    return { id: result.insertId, ...data };
  },

  async getAddons(addonGroupId) {
    const pool = getPool();
    const [addons] = await pool.query(
      `SELECT * FROM addons WHERE addon_group_id = ? AND is_active = 1 ORDER BY display_order, name`,
      [addonGroupId]
    );
    return addons;
  },

  async getAddonById(id) {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM addons WHERE id = ?', [id]);
    return rows[0] || null;
  },

  async updateAddon(id, data) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.price !== undefined) { fields.push('price = ?'); values.push(data.price); }
    if (data.itemType !== undefined) { fields.push('item_type = ?'); values.push(data.itemType); }
    if (data.imageUrl !== undefined) { fields.push('image_url = ?'); values.push(data.imageUrl); }
    if (data.isDefault !== undefined) { fields.push('is_default = ?'); values.push(data.isDefault); }
    if (data.displayOrder !== undefined) { fields.push('display_order = ?'); values.push(data.displayOrder); }
    if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive); }

    if (fields.length === 0) return null;
    values.push(id);

    await pool.query(`UPDATE addons SET ${fields.join(', ')} WHERE id = ?`, values);

    const addon = await this.getAddonById(id);
    if (addon) {
      const group = await this.getGroupById(addon.addon_group_id);
      if (group) await this.invalidateCache(group.outlet_id);
    }
    return addon;
  },

  async deleteAddon(id) {
    const pool = getPool();
    const addon = await this.getAddonById(id);
    if (!addon) return false;

    await pool.query('UPDATE addons SET is_active = 0 WHERE id = ?', [id]);

    const group = await this.getGroupById(addon.addon_group_id);
    if (group) await this.invalidateCache(group.outlet_id);
    return true;
  },

  // ========================
  // ITEM MAPPING
  // ========================

  async mapToItem(itemId, addonGroupId, isRequired = false, displayOrder = 0) {
    const pool = getPool();
    await pool.query(
      `INSERT INTO item_addon_groups (item_id, addon_group_id, is_required, display_order, is_active)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE is_required = ?, display_order = ?, is_active = 1`,
      [itemId, addonGroupId, isRequired, displayOrder, isRequired, displayOrder]
    );

    // Update item has_addons flag
    await pool.query('UPDATE items SET has_addons = 1 WHERE id = ?', [itemId]);
    return true;
  },

  async unmapFromItem(itemId, addonGroupId) {
    const pool = getPool();
    await pool.query(
      `UPDATE item_addon_groups SET is_active = 0 WHERE item_id = ? AND addon_group_id = ?`,
      [itemId, addonGroupId]
    );

    // Check if item still has addons
    const [remaining] = await pool.query(
      `SELECT COUNT(*) as count FROM item_addon_groups WHERE item_id = ? AND is_active = 1`,
      [itemId]
    );
    if (remaining[0].count === 0) {
      await pool.query('UPDATE items SET has_addons = 0 WHERE id = ?', [itemId]);
    }
    return true;
  },

  async getItemAddonGroups(itemId) {
    const pool = getPool();
    const [groups] = await pool.query(
      `SELECT ag.*, iag.is_required as item_required, iag.display_order as item_display_order
       FROM item_addon_groups iag
       JOIN addon_groups ag ON iag.addon_group_id = ag.id
       WHERE iag.item_id = ? AND iag.is_active = 1 AND ag.is_active = 1
       ORDER BY iag.display_order, ag.name`,
      [itemId]
    );

    // Get addons for each group
    for (const group of groups) {
      group.addons = await this.getAddons(group.id);
    }

    return groups;
  },

  async invalidateCache(outletId) {
    await Promise.all([
      cache.del(`addon_groups:${outletId}`),
      cache.delPattern(`menu:build:${outletId}:*`),
      cache.delPattern(`menu:captain:${outletId}:*`),
      cache.delPattern(`menu:search:${outletId}:*`),
      cache.delPattern(`self_order:menu:${outletId}:*`),
      cache.delPattern(`report:${outletId}:menu-captain:*`),
    ]);
  }
};

module.exports = addonService;
