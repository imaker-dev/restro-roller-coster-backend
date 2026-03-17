/**
 * Unit Service
 * Handles unit of measurement management and conversions
 * Restaurants buy in large units (kg, litre) and recipes use smaller units (g, ml)
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');

const unitService = {

  // ========================
  // SEED DEFAULT UNITS
  // ========================

  /**
   * Seed default units for an outlet if none exist
   * Called when first accessing inventory for an outlet
   */
  async seedDefaults(outletId) {
    const pool = getPool();

    const [existing] = await pool.query(
      'SELECT COUNT(*) as count FROM units WHERE outlet_id = ?', [outletId]
    );
    if (existing[0].count > 0) return;

    const defaults = [
      // Weight units — base unit: gram (g)
      { name: 'Gram', abbreviation: 'g', unit_type: 'weight', conversion_factor: 1, is_base_unit: true },
      { name: 'Kilogram', abbreviation: 'kg', unit_type: 'weight', conversion_factor: 1000, is_base_unit: false },
      { name: 'Milligram', abbreviation: 'mg', unit_type: 'weight', conversion_factor: 0.001, is_base_unit: false },
      { name: 'Quintal', abbreviation: 'qtl', unit_type: 'weight', conversion_factor: 100000, is_base_unit: false },

      // Volume units — base unit: millilitre (ml)
      { name: 'Millilitre', abbreviation: 'ml', unit_type: 'volume', conversion_factor: 1, is_base_unit: true },
      { name: 'Litre', abbreviation: 'l', unit_type: 'volume', conversion_factor: 1000, is_base_unit: false },
      { name: 'Centilitre', abbreviation: 'cl', unit_type: 'volume', conversion_factor: 10, is_base_unit: false },

      // Count units — base unit: piece (pcs)
      { name: 'Piece', abbreviation: 'pcs', unit_type: 'count', conversion_factor: 1, is_base_unit: true },
      { name: 'Dozen', abbreviation: 'dz', unit_type: 'count', conversion_factor: 12, is_base_unit: false },
      { name: 'Box', abbreviation: 'box', unit_type: 'count', conversion_factor: 1, is_base_unit: false },
      { name: 'Packet', abbreviation: 'pkt', unit_type: 'count', conversion_factor: 1, is_base_unit: false },
      { name: 'Bottle', abbreviation: 'btl', unit_type: 'count', conversion_factor: 1, is_base_unit: false },
      { name: 'Can', abbreviation: 'can', unit_type: 'count', conversion_factor: 1, is_base_unit: false },
    ];

    const values = defaults.map(d => [
      outletId, d.name, d.abbreviation, d.unit_type, d.conversion_factor, d.is_base_unit
    ]);

    await pool.query(
      `INSERT INTO units (outlet_id, name, abbreviation, unit_type, conversion_factor, is_base_unit)
       VALUES ?`,
      [values]
    );

    logger.info(`Seeded ${defaults.length} default units for outlet ${outletId}`);
  },

  // ========================
  // CRUD
  // ========================

  async list(outletId, options = {}) {
    const pool = getPool();
    const { unitType, isActive, search } = options;

    let where = 'WHERE u.outlet_id = ?';
    const params = [outletId];

    if (unitType) {
      where += ' AND u.unit_type = ?';
      params.push(unitType);
    }
    if (typeof isActive === 'boolean') {
      where += ' AND u.is_active = ?';
      params.push(isActive ? 1 : 0);
    }
    if (search) {
      where += ' AND (u.name LIKE ? OR u.abbreviation LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s);
    }

    const [rows] = await pool.query(
      `SELECT u.* FROM units u ${where} ORDER BY u.unit_type, u.is_base_unit DESC, u.name`,
      params
    );

    return rows.map(r => this.format(r));
  },

  async getById(id) {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM units WHERE id = ?', [id]);
    return rows[0] ? this.format(rows[0]) : null;
  },

  async create(outletId, data) {
    const pool = getPool();
    const { name, abbreviation, unitType, conversionFactor, isBaseUnit = false } = data;

    if (!name || !abbreviation || !unitType || conversionFactor === undefined) {
      throw new Error('name, abbreviation, unitType, and conversionFactor are required');
    }

    const [result] = await pool.query(
      `INSERT INTO units (outlet_id, name, abbreviation, unit_type, conversion_factor, is_base_unit)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [outletId, name.trim(), abbreviation.trim(), unitType, conversionFactor, isBaseUnit ? 1 : 0]
    );

    return this.getById(result.insertId);
  },

  async update(id, data) {
    const pool = getPool();
    const fields = [];
    const params = [];

    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name.trim()); }
    if (data.abbreviation !== undefined) { fields.push('abbreviation = ?'); params.push(data.abbreviation.trim()); }
    if (data.unitType !== undefined) { fields.push('unit_type = ?'); params.push(data.unitType); }
    if (data.conversionFactor !== undefined) { fields.push('conversion_factor = ?'); params.push(data.conversionFactor); }
    if (data.isBaseUnit !== undefined) { fields.push('is_base_unit = ?'); params.push(data.isBaseUnit ? 1 : 0); }
    if (data.isActive !== undefined) { fields.push('is_active = ?'); params.push(data.isActive ? 1 : 0); }

    if (fields.length === 0) return this.getById(id);

    params.push(id);
    await pool.query(`UPDATE units SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.getById(id);
  },

  async delete(id) {
    const pool = getPool();

    // Check if unit is used by any inventory item
    const [usage] = await pool.query(
      'SELECT COUNT(*) as count FROM inventory_items WHERE base_unit_id = ?', [id]
    );
    if (usage[0].count > 0) {
      throw new Error('Cannot delete unit — it is used by inventory items. Deactivate it instead.');
    }

    await pool.query('DELETE FROM units WHERE id = ?', [id]);
    return true;
  },

  // ========================
  // CONVERSION
  // ========================

  /**
   * Convert quantity from one unit to another (must be same unit_type)
   * @param {number} quantity - Amount to convert
   * @param {number} fromUnitId - Source unit ID
   * @param {number} toUnitId - Target unit ID
   * @returns {number} Converted quantity
   */
  async convert(quantity, fromUnitId, toUnitId) {
    if (fromUnitId === toUnitId) return quantity;

    const pool = getPool();
    const [units] = await pool.query(
      'SELECT id, unit_type, conversion_factor FROM units WHERE id IN (?, ?)',
      [fromUnitId, toUnitId]
    );

    if (units.length !== 2) throw new Error('One or both units not found');

    const fromUnit = units.find(u => u.id === Number(fromUnitId));
    const toUnit = units.find(u => u.id === Number(toUnitId));

    if (fromUnit.unit_type !== toUnit.unit_type) {
      throw new Error(`Cannot convert between ${fromUnit.unit_type} and ${toUnit.unit_type}`);
    }

    // Convert: quantity_in_target = quantity * (from_factor / to_factor)
    const result = quantity * (parseFloat(fromUnit.conversion_factor) / parseFloat(toUnit.conversion_factor));
    return parseFloat(result.toFixed(6));
  },

  /**
   * Convert quantity to base unit for a given unit
   * @param {number} quantity - Amount
   * @param {number} unitId - Unit ID
   * @returns {number} Quantity in base unit
   */
  async toBaseUnit(quantity, unitId) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT conversion_factor FROM units WHERE id = ?', [unitId]
    );
    if (!rows[0]) throw new Error('Unit not found');
    return parseFloat((quantity * parseFloat(rows[0].conversion_factor)).toFixed(6));
  },

  /**
   * Convert from base unit to target unit
   * @param {number} baseQuantity - Amount in base unit
   * @param {number} unitId - Target unit ID
   * @returns {number} Quantity in target unit
   */
  async fromBaseUnit(baseQuantity, unitId) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT conversion_factor FROM units WHERE id = ?', [unitId]
    );
    if (!rows[0]) throw new Error('Unit not found');
    return parseFloat((baseQuantity / parseFloat(rows[0].conversion_factor)).toFixed(6));
  },

  /**
   * Get all units of the same type for a given unit
   */
  async getCompatibleUnits(unitId) {
    const pool = getPool();
    const unit = await this.getById(unitId);
    if (!unit) throw new Error('Unit not found');

    const [rows] = await pool.query(
      'SELECT * FROM units WHERE outlet_id = (SELECT outlet_id FROM units WHERE id = ?) AND unit_type = ? AND is_active = 1 ORDER BY conversion_factor',
      [unitId, unit.unitType]
    );
    return rows.map(r => this.format(r));
  },

  // ========================
  // FORMAT
  // ========================

  format(row) {
    if (!row) return null;
    return {
      id: row.id,
      outletId: row.outlet_id,
      name: row.name,
      abbreviation: row.abbreviation,
      unitType: row.unit_type,
      conversionFactor: parseFloat(row.conversion_factor),
      isBaseUnit: !!row.is_base_unit,
      isActive: !!row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
};

module.exports = unitService;
