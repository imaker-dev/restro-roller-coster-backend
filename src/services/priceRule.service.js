/**
 * Price Rule Service
 * Handles dynamic pricing based on time, floor, section, happy hour, etc.
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_TTL = 1800;

const priceRuleService = {
  // ========================
  // PRICE RULES CRUD
  // ========================

  async create(data) {
    const pool = getPool();
    const {
      outletId, name, description, ruleType,
      itemId, variantId, categoryId, floorId, sectionId,
      timeStart, timeEnd, daysOfWeek, dateStart, dateEnd,
      adjustmentType = 'percentage', adjustmentValue,
      priority = 0, isActive = true
    } = data;

    const [result] = await pool.query(
      `INSERT INTO price_rules (
        outlet_id, name, description, rule_type,
        item_id, variant_id, category_id, floor_id, section_id,
        time_start, time_end, days_of_week, date_start, date_end,
        adjustment_type, adjustment_value, priority, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outletId, name, description, ruleType,
        itemId, variantId, categoryId, floorId, sectionId,
        timeStart, timeEnd, daysOfWeek, dateStart, dateEnd,
        adjustmentType, adjustmentValue, priority, isActive
      ]
    );

    await this.invalidateCache(outletId);
    return { id: result.insertId, ...data };
  },

  async getByOutlet(outletId, filters = {}) {
    const pool = getPool();
    let query = `
      SELECT pr.*,
        i.name as item_name,
        v.name as variant_name,
        c.name as category_name,
        f.name as floor_name,
        s.name as section_name
      FROM price_rules pr
      LEFT JOIN items i ON pr.item_id = i.id
      LEFT JOIN variants v ON pr.variant_id = v.id
      LEFT JOIN categories c ON pr.category_id = c.id
      LEFT JOIN floors f ON pr.floor_id = f.id
      LEFT JOIN sections s ON pr.section_id = s.id
      WHERE pr.outlet_id = ?
    `;
    const params = [outletId];

    if (!filters.includeInactive) {
      query += ' AND pr.is_active = 1';
    }
    if (filters.ruleType) {
      query += ' AND pr.rule_type = ?';
      params.push(filters.ruleType);
    }
    if (filters.itemId) {
      query += ' AND pr.item_id = ?';
      params.push(filters.itemId);
    }

    query += ' ORDER BY pr.priority DESC, pr.created_at DESC';

    const [rules] = await pool.query(query, params);
    return rules;
  },

  async getById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT pr.*,
        i.name as item_name,
        v.name as variant_name,
        c.name as category_name,
        f.name as floor_name,
        s.name as section_name
       FROM price_rules pr
       LEFT JOIN items i ON pr.item_id = i.id
       LEFT JOIN variants v ON pr.variant_id = v.id
       LEFT JOIN categories c ON pr.category_id = c.id
       LEFT JOIN floors f ON pr.floor_id = f.id
       LEFT JOIN sections s ON pr.section_id = s.id
       WHERE pr.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async update(id, data) {
    const pool = getPool();
    const fields = [];
    const values = [];

    const fieldMap = {
      name: 'name', description: 'description', ruleType: 'rule_type',
      itemId: 'item_id', variantId: 'variant_id', categoryId: 'category_id',
      floorId: 'floor_id', sectionId: 'section_id',
      timeStart: 'time_start', timeEnd: 'time_end',
      daysOfWeek: 'days_of_week', dateStart: 'date_start', dateEnd: 'date_end',
      adjustmentType: 'adjustment_type', adjustmentValue: 'adjustment_value',
      priority: 'priority', isActive: 'is_active'
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${column} = ?`);
        values.push(data[key]);
      }
    }

    if (fields.length === 0) return null;
    values.push(id);

    await pool.query(`UPDATE price_rules SET ${fields.join(', ')} WHERE id = ?`, values);

    const rule = await this.getById(id);
    if (rule) await this.invalidateCache(rule.outlet_id);
    return rule;
  },

  async delete(id) {
    const pool = getPool();
    const rule = await this.getById(id);
    if (!rule) return false;

    await pool.query('UPDATE price_rules SET is_active = 0 WHERE id = ?', [id]);
    await this.invalidateCache(rule.outlet_id);
    return true;
  },

  // ========================
  // PRICE CALCULATION
  // ========================

  /**
   * Get applicable price rules for an item/variant in a given context
   */
  async getApplicableRules(outletId, itemId, variantId = null, context = {}) {
    const { floorId, sectionId, categoryId, time, day, date } = context;
    const pool = getPool();

    const now = new Date();
    const currentTime = time || now.toTimeString().slice(0, 8);
    const currentDay = day || now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const currentDate = date || now.toISOString().slice(0, 10);

    let query = `
      SELECT * FROM price_rules
      WHERE outlet_id = ? AND is_active = 1
      AND (
        (item_id = ? OR item_id IS NULL)
        ${variantId ? 'AND (variant_id = ? OR variant_id IS NULL)' : 'AND variant_id IS NULL'}
        ${categoryId ? 'AND (category_id = ? OR category_id IS NULL)' : ''}
      )
    `;
    const params = [outletId, itemId];
    if (variantId) params.push(variantId);
    if (categoryId) params.push(categoryId);

    // Time-based rules
    query += `
      AND (
        (time_start IS NULL AND time_end IS NULL)
        OR (time_start <= ? AND time_end >= ?)
        OR (time_start > time_end AND (? >= time_start OR ? <= time_end))
      )
    `;
    params.push(currentTime, currentTime, currentTime, currentTime);

    // Day-based rules
    query += `
      AND (days_of_week IS NULL OR days_of_week LIKE ?)
    `;
    params.push(`%${currentDay}%`);

    // Date range rules
    query += `
      AND (
        (date_start IS NULL AND date_end IS NULL)
        OR (date_start <= ? AND date_end >= ?)
      )
    `;
    params.push(currentDate, currentDate);

    // Floor/Section rules
    if (floorId) {
      query += ' AND (floor_id IS NULL OR floor_id = ?)';
      params.push(floorId);
    }
    if (sectionId) {
      query += ' AND (section_id IS NULL OR section_id = ?)';
      params.push(sectionId);
    }

    query += ' ORDER BY priority DESC, created_at DESC';

    const [rules] = await pool.query(query, params);
    return rules;
  },

  /**
   * Calculate final price after applying rules
   * NOTE: Price rules are currently disabled — returns base price only (menu total + tax).
   * To re-enable, uncomment the rule application logic below.
   */
  async calculatePrice(basePrice, outletId, itemId, variantId = null, context = {}) {
    // ── Price rules DISABLED — return base price with no adjustments ──
    const parsed = parseFloat(basePrice);
    return {
      basePrice: parsed,
      finalPrice: Math.max(0, parseFloat(parsed.toFixed(2))),
      appliedRules: [],
      hasDiscount: false
    };

    /* ── ORIGINAL RULE LOGIC (disabled) ──
    const rules = await this.getApplicableRules(outletId, itemId, variantId, context);

    let finalPrice = parseFloat(basePrice);
    const appliedRules = [];

    for (const rule of rules) {
      let adjustment = 0;

      switch (rule.adjustment_type) {
        case 'fixed':
          adjustment = parseFloat(rule.adjustment_value);
          finalPrice += adjustment;
          break;
        case 'percentage':
          adjustment = (finalPrice * parseFloat(rule.adjustment_value)) / 100;
          finalPrice += adjustment;
          break;
        case 'override':
          finalPrice = parseFloat(rule.adjustment_value);
          adjustment = finalPrice - basePrice;
          break;
      }

      appliedRules.push({
        ruleId: rule.id,
        ruleName: rule.name,
        ruleType: rule.rule_type,
        adjustmentType: rule.adjustment_type,
        adjustmentValue: parseFloat(rule.adjustment_value),
        priceAdjustment: adjustment
      });

      // For override, stop processing more rules
      if (rule.adjustment_type === 'override') break;
    }

    return {
      basePrice: parseFloat(basePrice),
      finalPrice: Math.max(0, parseFloat(finalPrice.toFixed(2))),
      appliedRules,
      hasDiscount: finalPrice < basePrice
    };
    */
  },

  // ========================
  // HAPPY HOUR
  // ========================

  async createHappyHourRule(outletId, data) {
    const {
      name, description, timeStart, timeEnd, daysOfWeek,
      discountPercent, categoryIds = [], itemIds = [],
      priority = 10, isActive = true
    } = data;

    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();
      const createdRules = [];

      // Create rule for each category
      for (const categoryId of categoryIds) {
        const [result] = await connection.query(
          `INSERT INTO price_rules (
            outlet_id, name, description, rule_type, category_id,
            time_start, time_end, days_of_week,
            adjustment_type, adjustment_value, priority, is_active
          ) VALUES (?, ?, ?, 'happy_hour', ?, ?, ?, ?, 'percentage', ?, ?, ?)`,
          [outletId, name, description, categoryId, timeStart, timeEnd, daysOfWeek, -discountPercent, priority, isActive]
        );
        createdRules.push(result.insertId);
      }

      // Create rule for each item
      for (const itemId of itemIds) {
        const [result] = await connection.query(
          `INSERT INTO price_rules (
            outlet_id, name, description, rule_type, item_id,
            time_start, time_end, days_of_week,
            adjustment_type, adjustment_value, priority, is_active
          ) VALUES (?, ?, ?, 'happy_hour', ?, ?, ?, ?, 'percentage', ?, ?, ?)`,
          [outletId, name, description, itemId, timeStart, timeEnd, daysOfWeek, -discountPercent, priority, isActive]
        );
        createdRules.push(result.insertId);
      }

      await connection.commit();
      await this.invalidateCache(outletId);

      return { ruleIds: createdRules, count: createdRules.length };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async getActiveHappyHours(outletId) {
    const pool = getPool();
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 8);
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

    const [rules] = await pool.query(
      `SELECT pr.*, c.name as category_name, i.name as item_name
       FROM price_rules pr
       LEFT JOIN categories c ON pr.category_id = c.id
       LEFT JOIN items i ON pr.item_id = i.id
       WHERE pr.outlet_id = ? AND pr.rule_type = 'happy_hour' AND pr.is_active = 1
       AND (pr.time_start <= ? AND pr.time_end >= ?)
       AND (pr.days_of_week IS NULL OR pr.days_of_week LIKE ?)
       ORDER BY pr.priority DESC`,
      [outletId, currentTime, currentTime, `%${currentDay}%`]
    );

    return rules;
  },

  async invalidateCache(outletId) {
    await Promise.all([
      cache.del(`price_rules:${outletId}`),
      cache.delPattern(`menu:build:${outletId}:*`),
      cache.delPattern(`menu:captain:${outletId}:*`),
      cache.delPattern(`menu:search:${outletId}:*`),
      cache.delPattern(`self_order:menu:${outletId}:*`),
      cache.delPattern(`report:${outletId}:menu-captain:*`),
    ]);
  }
};

module.exports = priceRuleService;
