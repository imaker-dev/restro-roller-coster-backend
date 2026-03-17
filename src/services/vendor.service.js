/**
 * Vendor Service
 * Handles vendor/supplier management for inventory purchases
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');

const vendorService = {

  // ========================
  // CRUD
  // ========================

  async list(outletId, options = {}) {
    const pool = getPool();
    const { page = 1, limit = 50, search, isActive, sortBy = 'name', sortOrder = 'ASC' } = options;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['name', 'created_at', 'updated_at'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'name';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let where = 'WHERE v.outlet_id = ?';
    const params = [outletId];

    if (typeof isActive === 'boolean') {
      where += ' AND v.is_active = ?';
      params.push(isActive ? 1 : 0);
    }
    if (search) {
      where += ' AND (v.name LIKE ? OR v.phone LIKE ? OR v.email LIKE ? OR v.contact_person LIKE ? OR v.gst_number LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM vendors v ${where}`, params
    );

    const [rows] = await pool.query(
      `SELECT v.*,
        (SELECT COUNT(*) FROM purchases p WHERE p.vendor_id = v.id AND p.status != 'cancelled') as purchase_count,
        (SELECT COALESCE(SUM(p.total_amount), 0) FROM purchases p WHERE p.vendor_id = v.id AND p.status != 'cancelled') as total_purchase_amount,
        (SELECT MAX(p.purchase_date) FROM purchases p WHERE p.vendor_id = v.id AND p.status != 'cancelled') as last_purchase_date
       FROM vendors v ${where}
       ORDER BY v.${safeSortBy} ${safeSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    return {
      vendors: rows.map(r => this.format(r)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit)
      }
    };
  },

  async getById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT v.*,
        (SELECT COUNT(*) FROM purchases p WHERE p.vendor_id = v.id AND p.status != 'cancelled') as purchase_count,
        (SELECT COALESCE(SUM(p.total_amount), 0) FROM purchases p WHERE p.vendor_id = v.id AND p.status != 'cancelled') as total_purchase_amount,
        (SELECT MAX(p.purchase_date) FROM purchases p WHERE p.vendor_id = v.id AND p.status != 'cancelled') as last_purchase_date
       FROM vendors v WHERE v.id = ?`,
      [id]
    );
    return rows[0] ? this.format(rows[0]) : null;
  },

  async create(outletId, data) {
    const pool = getPool();
    const {
      name, contactPerson, phone, alternatePhone, email, address,
      city, state, pincode, gstNumber, panNumber,
      bankName, bankAccount, bankIfsc, paymentTerms, creditDays, notes
    } = data;

    if (!name) throw new Error('Vendor name is required');

    const [result] = await pool.query(
      `INSERT INTO vendors (
        outlet_id, name, contact_person, phone, alternate_phone, email, address,
        city, state, pincode, gst_number, pan_number,
        bank_name, bank_account, bank_ifsc, payment_terms, credit_days, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outletId, name.trim(), contactPerson || null, phone || null, alternatePhone || null,
        email || null, address || null, city || null, state || null, pincode || null,
        gstNumber || null, panNumber || null, bankName || null, bankAccount || null,
        bankIfsc || null, paymentTerms || null, creditDays || 0, notes || null
      ]
    );

    return this.getById(result.insertId);
  },

  async update(id, data) {
    const pool = getPool();
    const fields = [];
    const params = [];

    const fieldMap = {
      name: 'name', contactPerson: 'contact_person', phone: 'phone',
      alternatePhone: 'alternate_phone', email: 'email', address: 'address',
      city: 'city', state: 'state', pincode: 'pincode',
      gstNumber: 'gst_number', panNumber: 'pan_number',
      bankName: 'bank_name', bankAccount: 'bank_account', bankIfsc: 'bank_ifsc',
      paymentTerms: 'payment_terms', creditDays: 'credit_days', notes: 'notes',
      isActive: 'is_active'
    };

    for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbKey} = ?`);
        if (jsKey === 'isActive') {
          params.push(data[jsKey] ? 1 : 0);
        } else if (jsKey === 'name') {
          params.push(data[jsKey].trim());
        } else {
          params.push(data[jsKey]);
        }
      }
    }

    if (fields.length === 0) return this.getById(id);

    params.push(id);
    await pool.query(`UPDATE vendors SET ${fields.join(', ')} WHERE id = ?`, params);
    return this.getById(id);
  },

  async delete(id) {
    const pool = getPool();

    // Check if vendor has purchases
    const [usage] = await pool.query(
      'SELECT COUNT(*) as count FROM purchases WHERE vendor_id = ? AND status != ?',
      [id, 'cancelled']
    );
    if (usage[0].count > 0) {
      throw new Error('Cannot delete vendor with existing purchases. Deactivate instead.');
    }

    await pool.query('DELETE FROM vendors WHERE id = ?', [id]);
    return true;
  },

  /**
   * Get vendor purchase history
   */
  async getPurchaseHistory(vendorId, options = {}) {
    const pool = getPool();
    const { page = 1, limit = 20 } = options;
    const offset = (Math.max(1, parseInt(page) || 1) - 1) * Math.min(100, parseInt(limit) || 20);
    const safeLimit = Math.min(100, parseInt(limit) || 20);

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) as total FROM purchases WHERE vendor_id = ? AND status != ?',
      [vendorId, 'cancelled']
    );

    const [rows] = await pool.query(
      `SELECT p.*, u.name as created_by_name
       FROM purchases p
       LEFT JOIN users u ON p.created_by = u.id
       WHERE p.vendor_id = ? AND p.status != 'cancelled'
       ORDER BY p.purchase_date DESC, p.id DESC
       LIMIT ? OFFSET ?`,
      [vendorId, safeLimit, offset]
    );

    return {
      purchases: rows.map(r => ({
        id: r.id,
        purchaseNumber: r.purchase_number,
        invoiceNumber: r.invoice_number || null,
        purchaseDate: r.purchase_date,
        totalAmount: parseFloat(r.total_amount) || 0,
        paidAmount: parseFloat(r.paid_amount) || 0,
        dueAmount: parseFloat(r.due_amount) || 0,
        paymentStatus: r.payment_status,
        status: r.status,
        createdByName: r.created_by_name || null,
        createdAt: r.created_at
      })),
      pagination: {
        page: Math.max(1, parseInt(options.page) || 1),
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit)
      }
    };
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
      contactPerson: row.contact_person || null,
      phone: row.phone || null,
      alternatePhone: row.alternate_phone || null,
      email: row.email || null,
      address: row.address || null,
      city: row.city || null,
      state: row.state || null,
      pincode: row.pincode || null,
      gstNumber: row.gst_number || null,
      panNumber: row.pan_number || null,
      bankName: row.bank_name || null,
      bankAccount: row.bank_account || null,
      bankIfsc: row.bank_ifsc || null,
      paymentTerms: row.payment_terms || null,
      creditDays: row.credit_days || 0,
      notes: row.notes || null,
      isActive: !!row.is_active,
      purchaseCount: parseInt(row.purchase_count) || 0,
      totalPurchaseAmount: parseFloat(row.total_purchase_amount) || 0,
      lastPurchaseDate: row.last_purchase_date || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
};

module.exports = vendorService;
