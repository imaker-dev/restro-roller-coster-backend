/**
 * Outside Collection Service
 * Handle payments collected outside POS system (Party Hall, Kitty Party, etc.)
 * These amounts are included in cashier totals, shift reports, DSR, and dashboards.
 */

const { getPool } = require('../database');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const BUSINESS_DAY_START_HOUR = 4;

function getLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const shifted = new Date(d.getTime() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const outsideCollectionService = {

  /**
   * Add an outside collection
   * @param {Object} data - { outletId, collectedBy, amount, paymentMode, reason, description, collectionDate, floorId }
   * @returns {Object} - Created record
   */
  async addCollection(data) {
    const pool = getPool();
    const {
      outletId,
      collectedBy,
      amount,
      paymentMode = 'cash',
      reason,
      description = null,
      collectionDate = null,
      floorId = null
    } = data;

    if (!outletId || !collectedBy || !amount || !reason) {
      throw new Error('outletId, collectedBy, amount, and reason are required');
    }
    if (parseFloat(amount) <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    const effectiveDate = collectionDate || getLocalDate();
    const uuid = uuidv4();

    // Find current open shift for this floor/cashier to link
    let shiftId = null;
    if (floorId) {
      const [shifts] = await pool.query(
        `SELECT id FROM day_sessions 
         WHERE outlet_id = ? AND floor_id = ? AND status = 'open'
         ORDER BY opening_time DESC LIMIT 1`,
        [outletId, floorId]
      );
      if (shifts.length > 0) shiftId = shifts[0].id;
    }
    if (!shiftId) {
      // Try finding any open shift for the cashier
      const [shifts] = await pool.query(
        `SELECT id FROM day_sessions 
         WHERE outlet_id = ? AND cashier_id = ? AND status = 'open'
         ORDER BY opening_time DESC LIMIT 1`,
        [outletId, collectedBy]
      );
      if (shifts.length > 0) shiftId = shifts[0].id;
    }

    const [result] = await pool.query(
      `INSERT INTO outside_collections 
        (uuid, outlet_id, shift_id, floor_id, collected_by, amount, payment_mode, reason, description, collection_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid, outletId, shiftId, floorId, collectedBy, amount, paymentMode, reason, description, effectiveDate]
    );

    logger.info(`Outside collection created: id=${result.insertId}, outlet=${outletId}, amount=${amount}, reason=${reason}, by=${collectedBy}`);

    // Return the full created record
    const [created] = await pool.query(
      `SELECT oc.*, u.name as collected_by_name, f.name as floor_name
       FROM outside_collections oc
       LEFT JOIN users u ON oc.collected_by = u.id
       LEFT JOIN floors f ON oc.floor_id = f.id
       WHERE oc.id = ?`,
      [result.insertId]
    );

    return this._formatRecord(created[0]);
  },

  /**
   * Get outside collections list with filters
   * Date filtering uses created_at with business day logic (4am-4am)
   */
  async getCollections({ outletId, startDate, endDate, floorId, collectedBy, status = 'active', page = 1, limit = 20 }) {
    const pool = getPool();
    const conditions = ['oc.outlet_id = ?'];
    const params = [outletId];

    // Use created_at with business day range (4am-4am) for date filtering
    if (startDate) {
      const h = String(BUSINESS_DAY_START_HOUR).padStart(2, '0') + ':00:00';
      conditions.push('oc.created_at >= ?');
      params.push(`${startDate} ${h}`);
    }
    if (endDate) {
      const h = String(BUSINESS_DAY_START_HOUR).padStart(2, '0') + ':00:00';
      const ed = new Date(endDate + 'T00:00:00');
      ed.setDate(ed.getDate() + 1);
      const endDt = `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, '0')}-${String(ed.getDate()).padStart(2, '0')} ${h}`;
      conditions.push('oc.created_at < ?');
      params.push(endDt);
    }
    if (floorId) { conditions.push('oc.floor_id = ?'); params.push(floorId); }
    if (collectedBy) { conditions.push('oc.collected_by = ?'); params.push(collectedBy); }
    if (status && status !== 'all') { conditions.push('oc.status = ?'); params.push(status); }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * limit;

    const [countRes, dataRes, summaryRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total FROM outside_collections oc WHERE ${where}`, params),
      pool.query(
        `SELECT oc.*, u.name as collected_by_name, f.name as floor_name,
                cu.name as cancelled_by_name
         FROM outside_collections oc
         LEFT JOIN users u ON oc.collected_by = u.id
         LEFT JOIN floors f ON oc.floor_id = f.id
         LEFT JOIN users cu ON oc.cancelled_by = cu.id
         WHERE ${where}
         ORDER BY oc.collection_date DESC, oc.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, parseInt(limit), parseInt(offset)]
      ),
      pool.query(
        `SELECT 
           COUNT(*) as total_count,
           SUM(amount) as total_amount,
           SUM(CASE WHEN payment_mode = 'cash' THEN amount ELSE 0 END) as cash_total,
           SUM(CASE WHEN payment_mode = 'card' THEN amount ELSE 0 END) as card_total,
           SUM(CASE WHEN payment_mode = 'upi' THEN amount ELSE 0 END) as upi_total,
           SUM(CASE WHEN payment_mode NOT IN ('cash','card','upi') THEN amount ELSE 0 END) as other_total
         FROM outside_collections oc
         WHERE ${where}`,
        params
      )
    ]);

    const total = countRes[0][0].total;
    const summary = summaryRes[0][0];

    return {
      collections: dataRes[0].map(r => this._formatRecord(r)),
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / limit) },
      summary: {
        totalCount: parseInt(summary.total_count) || 0,
        totalAmount: parseFloat(summary.total_amount) || 0,
        paymentBreakdown: {
          cash: parseFloat(summary.cash_total) || 0,
          card: parseFloat(summary.card_total) || 0,
          upi: parseFloat(summary.upi_total) || 0,
          other: parseFloat(summary.other_total) || 0
        }
      }
    };
  },

  /**
   * Get single collection by ID
   */
  async getCollectionById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT oc.*, u.name as collected_by_name, f.name as floor_name,
              cu.name as cancelled_by_name
       FROM outside_collections oc
       LEFT JOIN users u ON oc.collected_by = u.id
       LEFT JOIN floors f ON oc.floor_id = f.id
       LEFT JOIN users cu ON oc.cancelled_by = cu.id
       WHERE oc.id = ?`,
      [id]
    );
    if (!rows[0]) throw new Error('Outside collection not found');
    return this._formatRecord(rows[0]);
  },

  /**
   * Update an outside collection (only if still active)
   */
  async updateCollection(id, data, userId) {
    const pool = getPool();
    const existing = await this.getCollectionById(id);
    if (existing.status !== 'active') {
      throw new Error('Cannot update a cancelled collection');
    }

    const updates = [];
    const params = [];
    const allowed = ['amount', 'payment_mode', 'reason', 'description', 'collection_date', 'floor_id'];
    for (const field of allowed) {
      // Map camelCase to snake_case
      const camel = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (data[camel] !== undefined || data[field] !== undefined) {
        const val = data[camel] !== undefined ? data[camel] : data[field];
        updates.push(`${field} = ?`);
        params.push(val);
      }
    }

    if (updates.length === 0) throw new Error('No valid fields to update');

    params.push(id);
    await pool.query(`UPDATE outside_collections SET ${updates.join(', ')} WHERE id = ?`, params);
    
    logger.info(`Outside collection updated: id=${id}, by=${userId}, fields=[${updates.map(u => u.split(' ')[0]).join(',')}]`);
    return this.getCollectionById(id);
  },

  /**
   * Cancel an outside collection (soft delete)
   */
  async cancelCollection(id, userId, cancelReason = null) {
    const pool = getPool();
    const existing = await this.getCollectionById(id);
    if (existing.status === 'cancelled') {
      throw new Error('Collection is already cancelled');
    }

    await pool.query(
      `UPDATE outside_collections SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ? WHERE id = ?`,
      [userId, cancelReason, id]
    );

    logger.info(`Outside collection cancelled: id=${id}, by=${userId}, reason=${cancelReason}`);
    return this.getCollectionById(id);
  },

  // ========================
  // QUERY HELPERS (used by payment.service.js and reports.service.js)
  // ========================

  /**
   * Get total outside collections for a shift time range (used in shift detail, shift history, cash drawer)
   * @param {number} outletId
   * @param {string} shiftStartTime - datetime string
   * @param {string} shiftEndTime - datetime string
   * @param {number|null} floorId
   * @param {Object} options - Additional options
   * @param {number} options.cashierId - Filter by cashier (for cashier role)
   * @param {boolean} options.isCashierOnly - If true, only show collections by this cashier
   * @returns {{ total, cash, card, upi, other, count, items[] }}
   */
  async getCollectionsForShift(outletId, shiftStartTime, shiftEndTime, floorId = null, options = {}) {
    const { cashierId = null, isCashierOnly = false } = options;
    const pool = getPool();
    let query = `
      SELECT oc.*, u.name as collected_by_name
      FROM outside_collections oc
      LEFT JOIN users u ON oc.collected_by = u.id
      WHERE oc.outlet_id = ? AND oc.status = 'active'
        AND oc.created_at >= ? AND oc.created_at <= ?`;
    const params = [outletId, shiftStartTime, shiftEndTime];
    if (floorId) {
      query += ` AND (oc.floor_id = ? OR oc.floor_id IS NULL)`;
      params.push(floorId);
    }
    // If cashier role, only show their own collections
    if (isCashierOnly && cashierId) {
      query += ` AND oc.collected_by = ?`;
      params.push(cashierId);
    }
    query += ` ORDER BY oc.created_at DESC`;

    const [rows] = await pool.query(query, params);
    return this._aggregateCollections(rows);
  },

  /**
   * Get total outside collections for a date range (used in DSR, dashboard, day-end)
   * Uses created_at with business day logic (4am-4am) — NOT collection_date.
   * The collection appears in reports based on WHEN it was created, not the future date it's for.
   * @param {number} outletId
   * @param {string} startDate - YYYY-MM-DD (business day)
   * @param {string} endDate - YYYY-MM-DD (business day)
   * @param {number[]} floorIds - optional floor filter
   * @returns {{ total, cash, card, upi, other, count, byDate, byCashier }}
   */
  async getCollectionsForDateRange(outletId, startDate, endDate, floorIds = []) {
    const pool = getPool();
    // Business day range: startDate 04:00:00 → endDate+1 04:00:00
    const h = String(BUSINESS_DAY_START_HOUR).padStart(2, '0') + ':00:00';
    const startDt = `${startDate} ${h}`;
    const ed = new Date(endDate + 'T00:00:00');
    ed.setDate(ed.getDate() + 1);
    const endDt = `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, '0')}-${String(ed.getDate()).padStart(2, '0')} ${h}`;

    let query = `
      SELECT oc.*, u.name as collected_by_name
      FROM outside_collections oc
      LEFT JOIN users u ON oc.collected_by = u.id
      WHERE oc.outlet_id = ? AND oc.status = 'active'
        AND oc.created_at >= ? AND oc.created_at < ?`;
    const params = [outletId, startDt, endDt];
    if (floorIds.length > 0) {
      const placeholders = floorIds.map(() => '?').join(',');
      query += ` AND (oc.floor_id IN (${placeholders}) OR oc.floor_id IS NULL)`;
      params.push(...floorIds);
    }
    query += ` ORDER BY oc.created_at`;

    const [rows] = await pool.query(query, params);
    const agg = this._aggregateCollections(rows);

    // Group by business date (based on created_at, shifted by BUSINESS_DAY_START_HOUR)
    const byDate = {};
    const byCashier = {};
    for (const row of rows) {
      // Derive business date from created_at
      const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
      const shifted = new Date(createdAt.getTime() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
      const d = `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;

      const amt = parseFloat(row.amount) || 0;
      const mode = row.payment_mode || 'other';

      // By date
      if (!byDate[d]) byDate[d] = { total: 0, count: 0, cash: 0, card: 0, upi: 0, other: 0 };
      byDate[d].total += amt;
      byDate[d].count++;
      if (['cash', 'card', 'upi'].includes(mode)) byDate[d][mode] += amt;
      else byDate[d].other += amt;

      // By cashier
      const cId = row.collected_by || 'unknown';
      if (!byCashier[cId]) byCashier[cId] = { cashierId: cId, cashierName: row.collected_by_name || 'Unknown', total: 0, count: 0, cash: 0, card: 0, upi: 0, other: 0 };
      byCashier[cId].total += amt;
      byCashier[cId].count++;
      if (['cash', 'card', 'upi'].includes(mode)) byCashier[cId][mode] += amt;
      else byCashier[cId].other += amt;
    }

    return { ...agg, byDate, byCashier: Object.values(byCashier) };
  },

  /**
   * Get total outside collections for a cashier during a time range (for cashier breakdown)
   */
  async getCollectionsByCashier(outletId, shiftStartTime, shiftEndTime, floorId = null) {
    const pool = getPool();
    let query = `
      SELECT oc.collected_by, u.name as collected_by_name,
             COUNT(*) as count,
             SUM(oc.amount) as total,
             SUM(CASE WHEN oc.payment_mode = 'cash' THEN oc.amount ELSE 0 END) as cash,
             SUM(CASE WHEN oc.payment_mode = 'card' THEN oc.amount ELSE 0 END) as card,
             SUM(CASE WHEN oc.payment_mode = 'upi' THEN oc.amount ELSE 0 END) as upi,
             SUM(CASE WHEN oc.payment_mode NOT IN ('cash','card','upi') THEN oc.amount ELSE 0 END) as other_total
      FROM outside_collections oc
      LEFT JOIN users u ON oc.collected_by = u.id
      WHERE oc.outlet_id = ? AND oc.status = 'active'
        AND oc.created_at >= ? AND oc.created_at <= ?`;
    const params = [outletId, shiftStartTime, shiftEndTime];
    if (floorId) {
      query += ` AND (oc.floor_id = ? OR oc.floor_id IS NULL)`;
      params.push(floorId);
    }
    query += ` GROUP BY oc.collected_by, u.name`;

    const [rows] = await pool.query(query, params);
    return rows.map(r => ({
      cashierId: r.collected_by,
      cashierName: r.collected_by_name,
      count: parseInt(r.count) || 0,
      total: parseFloat(r.total) || 0,
      cash: parseFloat(r.cash) || 0,
      card: parseFloat(r.card) || 0,
      upi: parseFloat(r.upi) || 0,
      other: parseFloat(r.other_total) || 0
    }));
  },

  // ========================
  // INTERNAL HELPERS
  // ========================

  _aggregateCollections(rows) {
    const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
    let total = 0, cash = 0, card = 0, upi = 0, other = 0;
    const items = [];
    for (const row of rows) {
      const amt = parseFloat(row.amount) || 0;
      total += amt;
      const mode = row.payment_mode || 'other';
      if (mode === 'cash') cash += amt;
      else if (mode === 'card') card += amt;
      else if (mode === 'upi') upi += amt;
      else other += amt;

      items.push(this._formatRecord(row));
    }
    return {
      total: r2(total), cash: r2(cash), card: r2(card), upi: r2(upi), other: r2(other),
      count: rows.length, items
    };
  },

  _formatRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      uuid: row.uuid,
      outletId: row.outlet_id,
      shiftId: row.shift_id,
      floorId: row.floor_id,
      floorName: row.floor_name || null,
      collectedBy: row.collected_by,
      collectedByName: row.collected_by_name || null,
      amount: parseFloat(row.amount) || 0,
      paymentMode: row.payment_mode,
      reason: row.reason,
      description: row.description,
      collectionDate: row.collection_date,
      status: row.status,
      cancelledBy: row.cancelled_by || null,
      cancelledByName: row.cancelled_by_name || null,
      cancelledAt: row.cancelled_at || null,
      cancelReason: row.cancel_reason || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
};

module.exports = outsideCollectionService;
