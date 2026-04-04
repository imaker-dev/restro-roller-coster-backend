/**
 * Tax Service
 * Handles tax types, components, groups, and rules
 * Supports GST (CGST/SGST/IGST) and VAT
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_TTL = 3600;

const taxService = {
  // ========================
  // TAX TYPES (GST, VAT)
  // ========================

  async createTaxType(data) {
    const pool = getPool();
    const { name, code, description, isActive = true } = data;

    const [result] = await pool.query(
      `INSERT INTO tax_types (name, code, description, is_active)
       VALUES (?, ?, ?, ?)`,
      [name, code.toUpperCase(), description, isActive]
    );

    await this.invalidateTaxCache();
    return { id: result.insertId, ...data };
  },

  async getTaxTypes() {
    const cacheKey = 'tax:types';
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const pool = getPool();
    const [types] = await pool.query(
      `SELECT * FROM tax_types WHERE is_active = 1 ORDER BY name`
    );

    await cache.set(cacheKey, types, CACHE_TTL);
    return types;
  },

  async updateTaxType(id, data) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.code !== undefined) { fields.push('code = ?'); values.push(data.code.toUpperCase()); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
    if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive); }

    if (fields.length === 0) return null;
    values.push(id);

    await pool.query(`UPDATE tax_types SET ${fields.join(', ')} WHERE id = ?`, values);
    await this.invalidateTaxCache();
    return this.getTaxTypeById(id);
  },

  async getTaxTypeById(id) {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM tax_types WHERE id = ?', [id]);
    return rows[0] || null;
  },

  // ========================
  // TAX COMPONENTS (CGST, SGST, IGST, VAT)
  // ========================

  async createTaxComponent(data) {
    const pool = getPool();
    const { taxTypeId, name, code, rate, description, isActive = true } = data;

    const [result] = await pool.query(
      `INSERT INTO tax_components (tax_type_id, name, code, rate, description, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [taxTypeId, name, code.toUpperCase(), rate, description, isActive]
    );

    await this.invalidateTaxCache();
    return { id: result.insertId, ...data };
  },

  async getTaxComponents(taxTypeId = null) {
    const pool = getPool();
    
    // Deduplicate by name + rate combination (handles different codes like VAT18 vs VAT_18)
    let query = `
      SELECT tc.*, tt.name as tax_type_name, tt.code as tax_type_code
      FROM tax_components tc
      JOIN tax_types tt ON tc.tax_type_id = tt.id
      WHERE tc.is_active = 1
        AND tc.id = (
          SELECT MIN(id) FROM tax_components 
          WHERE name = tc.name AND rate = tc.rate AND is_active = 1
        )
    `;
    const params = [];

    if (taxTypeId) {
      query += ' AND tc.tax_type_id = ?';
      params.push(taxTypeId);
    }
    query += ' ORDER BY tt.name, tc.name';

    const [components] = await pool.query(query, params);
    return components;
  },

  async updateTaxComponent(id, data) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (data.taxTypeId !== undefined) { fields.push('tax_type_id = ?'); values.push(data.taxTypeId); }
    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.code !== undefined) { fields.push('code = ?'); values.push(data.code.toUpperCase()); }
    if (data.rate !== undefined) { fields.push('rate = ?'); values.push(data.rate); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
    if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive); }

    if (fields.length === 0) return null;
    values.push(id);

    await pool.query(`UPDATE tax_components SET ${fields.join(', ')} WHERE id = ?`, values);
    await this.invalidateTaxCache();
    return this.getTaxComponentById(id);
  },

  async getTaxComponentById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT tc.*, tt.name as tax_type_name, tt.code as tax_type_code
       FROM tax_components tc
       JOIN tax_types tt ON tc.tax_type_id = tt.id
       WHERE tc.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  // ========================
  // TAX GROUPS (Combinations)
  // ========================

  async createTaxGroup(data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const {
        outletId, name, code, description,
        isInclusive = false, isDefault = false, isActive = true,
        componentIds = []
      } = data;

      // Calculate total rate from components
      let totalRate = 0;
      if (componentIds.length > 0) {
        const [components] = await connection.query(
          `SELECT SUM(rate) as total FROM tax_components WHERE id IN (?) AND is_active = 1`,
          [componentIds]
        );
        totalRate = components[0]?.total || 0;
      }

      // If setting as default, unset other defaults for this outlet
      if (isDefault && outletId) {
        await connection.query(
          `UPDATE tax_groups SET is_default = 0 WHERE outlet_id = ?`,
          [outletId]
        );
      }

      const [result] = await connection.query(
        `INSERT INTO tax_groups (outlet_id, name, code, description, total_rate, is_inclusive, is_default, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [outletId, name, code?.toUpperCase(), description, totalRate, isInclusive, isDefault, isActive]
      );

      const groupId = result.insertId;

      // Add component mappings
      for (const componentId of componentIds) {
        await connection.query(
          `INSERT INTO tax_group_components (tax_group_id, tax_component_id, is_active)
           VALUES (?, ?, 1)`,
          [groupId, componentId]
        );
      }

      await connection.commit();
      await this.invalidateTaxCache();

      return this.getTaxGroupById(groupId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async getTaxGroups(outletId = null) {
    // Skip cache for now to ensure fresh data
    const pool = getPool();
    let groups = [];

    if (outletId) {
      // Get outlet-specific tax groups first
      const [outletGroups] = await pool.query(
        `SELECT * FROM tax_groups WHERE is_active = 1 AND outlet_id = ? ORDER BY is_default DESC, name`,
        [outletId]
      );
      
      // Get outlet-specific codes to exclude from global
      const outletCodes = outletGroups.map(g => g.code);
      
      // Get global tax groups, deduplicated by name + total_rate (MIN id)
      const [globalGroups] = await pool.query(
        `SELECT tg.* FROM tax_groups tg
         WHERE tg.is_active = 1 AND tg.outlet_id IS NULL
           AND tg.id = (
             SELECT MIN(id) FROM tax_groups 
             WHERE name = tg.name AND total_rate = tg.total_rate AND outlet_id IS NULL AND is_active = 1
           )
         ORDER BY is_default DESC, name`
      );
      
      // Get outlet-specific names to exclude from global
      const outletNames = outletGroups.map(g => g.name);
      
      // Filter out global groups that have outlet-specific versions (by name)
      const filteredGlobal = globalGroups.filter(g => !outletNames.includes(g.name) && !outletCodes.includes(g.code));
      
      // Combine: outlet-specific first, then global
      groups = [...outletGroups, ...filteredGlobal];
    } else {
      // No outlet filter - return unique global tax groups (deduplicated by name + total_rate)
      const [globalGroups] = await pool.query(
        `SELECT tg.* FROM tax_groups tg
         WHERE tg.is_active = 1 AND tg.outlet_id IS NULL
           AND tg.id = (
             SELECT MIN(id) FROM tax_groups 
             WHERE name = tg.name AND total_rate = tg.total_rate AND outlet_id IS NULL AND is_active = 1
           )
         ORDER BY is_default DESC, name`
      );
      groups = globalGroups;
    }

    // Sort final result
    groups.sort((a, b) => {
      if (b.is_default !== a.is_default) return b.is_default - a.is_default;
      return a.name.localeCompare(b.name);
    });
    
    // Get components for each group
    for (const group of groups) {
      const [components] = await pool.query(
        `SELECT tc.id, tc.name, tc.code, tc.rate
         FROM tax_group_components tgc
         JOIN tax_components tc ON tgc.tax_component_id = tc.id
         WHERE tgc.tax_group_id = ? AND tgc.is_active = 1`,
        [group.id]
      );
      group.components = components;
    }

    return groups;
  },

  async getTaxGroupById(id) {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM tax_groups WHERE id = ?', [id]);

    if (!rows[0]) return null;

    const [components] = await pool.query(
      `SELECT tc.id, tc.name, tc.code, tc.rate
       FROM tax_group_components tgc
       JOIN tax_components tc ON tgc.tax_component_id = tc.id
       WHERE tgc.tax_group_id = ? AND tgc.is_active = 1`,
      [id]
    );

    return {
      ...rows[0],
      components
    };
  },

  async updateTaxGroup(id, data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const fields = [];
      const values = [];

      if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
      if (data.code !== undefined) { fields.push('code = ?'); values.push(data.code?.toUpperCase()); }
      if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
      if (data.isInclusive !== undefined) { fields.push('is_inclusive = ?'); values.push(data.isInclusive); }
      if (data.isDefault !== undefined) { fields.push('is_default = ?'); values.push(data.isDefault); }
      if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive); }

      // Update components if provided
      if (data.componentIds !== undefined) {
        // Remove old mappings
        await connection.query('DELETE FROM tax_group_components WHERE tax_group_id = ?', [id]);

        // Add new mappings
        for (const componentId of data.componentIds) {
          await connection.query(
            `INSERT INTO tax_group_components (tax_group_id, tax_component_id, is_active) VALUES (?, ?, 1)`,
            [id, componentId]
          );
        }

        // Recalculate total rate
        const [components] = await connection.query(
          `SELECT SUM(rate) as total FROM tax_components WHERE id IN (?) AND is_active = 1`,
          [data.componentIds.length > 0 ? data.componentIds : [0]]
        );
        fields.push('total_rate = ?');
        values.push(components[0]?.total || 0);
      }

      if (fields.length > 0) {
        values.push(id);
        await connection.query(`UPDATE tax_groups SET ${fields.join(', ')} WHERE id = ?`, values);
      }

      await connection.commit();
      await this.invalidateTaxCache();

      return this.getTaxGroupById(id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async deleteTaxGroup(id) {
    const pool = getPool();
    await pool.query('UPDATE tax_groups SET is_active = 0 WHERE id = ?', [id]);
    await this.invalidateTaxCache();
    return true;
  },

  // ========================
  // SERVICE CHARGES
  // ========================

  async createServiceCharge(data) {
    const pool = getPool();
    const {
      outletId, name, rate, isPercentage = true,
      minBillAmount = 0, maxChargeAmount, applyOn = 'subtotal',
      isTaxable = false, taxGroupId, floorId, sectionId,
      isOptional = false, isActive = true
    } = data;

    const [result] = await pool.query(
      `INSERT INTO service_charges 
       (outlet_id, name, rate, is_percentage, min_bill_amount, max_charge_amount,
        apply_on, is_taxable, tax_group_id, floor_id, section_id, is_optional, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [outletId, name, rate, isPercentage, minBillAmount, maxChargeAmount,
       applyOn, isTaxable, taxGroupId, floorId, sectionId, isOptional, isActive]
    );

    await cache.del(`service_charges:${outletId}`);
    return { id: result.insertId, ...data };
  },

  async getServiceCharges(outletId, floorId = null, sectionId = null) {
    const pool = getPool();
    let query = `
      SELECT sc.*, tg.name as tax_group_name, tg.total_rate as tax_rate
      FROM service_charges sc
      LEFT JOIN tax_groups tg ON sc.tax_group_id = tg.id
      WHERE sc.outlet_id = ? AND sc.is_active = 1
    `;
    const params = [outletId];

    if (floorId) {
      query += ' AND (sc.floor_id IS NULL OR sc.floor_id = ?)';
      params.push(floorId);
    }
    if (sectionId) {
      query += ' AND (sc.section_id IS NULL OR sc.section_id = ?)';
      params.push(sectionId);
    }

    const [charges] = await pool.query(query, params);
    return charges;
  },

  // ========================
  // DISCOUNTS
  // ========================

  async createDiscount(data) {
    const pool = getPool();
    const {
      outletId, code, name, description, discountType, value,
      maxDiscountAmount, minOrderAmount = 0, minQuantity = 1,
      applicableOn = 'all', categoryIds, itemIds, orderTypes,
      validFrom, validUntil, usageLimit, perUserLimit,
      requiresApproval = false, approvalRoleId,
      isAutoApply = false, isCombinable = false, priority = 0,
      isActive = true, createdBy
    } = data;

    const [result] = await pool.query(
      `INSERT INTO discounts 
       (outlet_id, code, name, description, discount_type, value,
        max_discount_amount, min_order_amount, min_quantity,
        applicable_on, category_ids, item_ids, order_types,
        valid_from, valid_until, usage_limit, per_user_limit,
        requires_approval, approval_role_id, is_auto_apply, is_combinable,
        priority, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [outletId, code?.toUpperCase(), name, description, discountType, value,
       maxDiscountAmount, minOrderAmount, minQuantity,
       applicableOn, JSON.stringify(categoryIds), JSON.stringify(itemIds), JSON.stringify(orderTypes),
       validFrom, validUntil, usageLimit, perUserLimit,
       requiresApproval, approvalRoleId, isAutoApply, isCombinable,
       priority, isActive, createdBy]
    );

    return { id: result.insertId, ...data };
  },

  async getDiscounts(outletId, filters = {}) {
    // Cache discount list per outlet (5 min) — discounts rarely change
    const cacheKey = `discounts:outlet:${outletId}:${filters.code || ''}:${filters.activeOnly || ''}:${filters.autoApplyOnly || ''}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const pool = getPool();
    let query = `SELECT * FROM discounts WHERE outlet_id = ? AND is_active = 1`;
    const params = [outletId];

    if (filters.code) {
      query += ' AND code = ?';
      params.push(filters.code.toUpperCase());
    }
    if (filters.activeOnly) {
      query += ' AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_until IS NULL OR valid_until >= NOW())';
      query += ' AND (usage_limit IS NULL OR usage_count < usage_limit)';
    }
    if (filters.autoApplyOnly) {
      query += ' AND is_auto_apply = 1';
    }

    query += ' ORDER BY priority DESC, created_at DESC';

    const [discounts] = await pool.query(query, params);
    const result = discounts.map(d => ({
      ...d,
      category_ids: d.category_ids ? JSON.parse(d.category_ids) : [],
      item_ids: d.item_ids ? JSON.parse(d.item_ids) : [],
      order_types: d.order_types ? JSON.parse(d.order_types) : []
    }));

    await cache.set(cacheKey, result, 300);
    return result;
  },

  async validateDiscountCode(outletId, code, orderAmount, orderType) {
    const pool = getPool();
    const [discounts] = await pool.query(
      `SELECT * FROM discounts 
       WHERE outlet_id = ? AND code = ? AND is_active = 1
       AND (valid_from IS NULL OR valid_from <= NOW())
       AND (valid_until IS NULL OR valid_until >= NOW())
       AND (usage_limit IS NULL OR usage_count < usage_limit)
       AND min_order_amount <= ?`,
      [outletId, code.toUpperCase(), orderAmount]
    );

    if (discounts.length === 0) {
      return { valid: false, message: 'Invalid or expired discount code' };
    }

    const discount = discounts[0];

    // Check order type applicability
    if (discount.order_types) {
      const orderTypes = JSON.parse(discount.order_types);
      if (orderTypes.length > 0 && !orderTypes.includes(orderType)) {
        return { valid: false, message: 'Discount not applicable for this order type' };
      }
    }

    return { valid: true, discount };
  },

  // ========================
  // TAX CALCULATION
  // ========================

  async calculateTax(items, taxGroupId, isInclusive = false, options = {}) {
    const taxGroup = await this.getTaxGroupById(taxGroupId);
    if (!taxGroup) {
      return { taxAmount: 0, breakdown: [] };
    }

    let subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    let taxableAmount = subtotal;

    if (isInclusive || taxGroup.is_inclusive) {
      // For inclusive: baseAmount = total / (1 + taxRate)
      taxableAmount = subtotal / (1 + taxGroup.total_rate / 100);
    }

    const { isInterstate = false } = options;
    let breakdown;

    if (isInterstate) {
      // For interstate: combine CGST+SGST into IGST
      const totalRate = parseFloat(taxGroup.total_rate);
      breakdown = [{
        componentId: null,
        componentName: 'IGST',
        componentCode: 'IGST',
        rate: totalRate,
        amount: parseFloat(((taxableAmount * totalRate) / 100).toFixed(2))
      }];
    } else if (taxGroup.components && taxGroup.components.length > 0) {
      breakdown = taxGroup.components.map(comp => ({
        componentId: comp.id,
        componentName: comp.name,
        componentCode: comp.code,
        rate: parseFloat(comp.rate),
        amount: parseFloat(((taxableAmount * comp.rate) / 100).toFixed(2))
      }));
    } else {
      // Fallback: tax group has total_rate but no components linked (misconfigured).
      // Use total_rate directly so tax is still calculated correctly.
      const totalRate = parseFloat(taxGroup.total_rate);
      if (totalRate > 0) {
        breakdown = [{
          componentId: null,
          componentName: taxGroup.name || 'Tax',
          componentCode: taxGroup.code || 'TAX',
          rate: totalRate,
          amount: parseFloat(((taxableAmount * totalRate) / 100).toFixed(2))
        }];
      } else {
        breakdown = [];
      }
    }

    const taxAmount = breakdown.reduce((sum, b) => sum + b.amount, 0);

    return {
      taxableAmount: parseFloat(taxableAmount.toFixed(2)),
      taxAmount: parseFloat(taxAmount.toFixed(2)),
      totalRate: parseFloat(taxGroup.total_rate),
      isInclusive: isInclusive || taxGroup.is_inclusive,
      isInterstate,
      breakdown
    };
  },

  // ========================
  // CACHE MANAGEMENT
  // ========================

  async invalidateTaxCache(outletId = null) {
    await cache.del('tax:types');
    await cache.del('tax:components:all');
    await cache.del('tax:groups:all');
    // Clear outlet-specific caches
    if (outletId) {
      await cache.del(`tax:groups:${outletId}`);
    }
    // Clear all outlet-specific tax group caches
    await cache.delPattern('tax:groups:*');
  }
};

module.exports = taxService;
