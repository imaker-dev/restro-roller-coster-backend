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
    const {
      page = 1, limit = 50, search, isActive, city, state, hasPurchases,
      sortBy = 'name', sortOrder = 'ASC'
    } = options;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['name', 'created_at', 'updated_at', 'city', 'total_purchase_amount', 'last_purchase_date'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'name';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let where = 'WHERE v.outlet_id = ?';
    const params = [outletId];

    if (typeof isActive === 'boolean') {
      where += ' AND v.is_active = ?';
      params.push(isActive ? 1 : 0);
    }
    if (city) {
      where += ' AND v.city LIKE ?';
      params.push(`%${city}%`);
    }
    if (state) {
      where += ' AND v.state LIKE ?';
      params.push(`%${state}%`);
    }
    if (search) {
      where += ' AND (v.name LIKE ? OR v.phone LIKE ? OR v.email LIKE ? OR v.contact_person LIKE ? OR v.gst_number LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    // For hasPurchases filter, we need a subquery
    let havingClause = '';
    if (typeof hasPurchases === 'boolean') {
      havingClause = hasPurchases ? 'HAVING purchase_count > 0' : 'HAVING purchase_count = 0';
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM (
        SELECT v.id,
          (SELECT COUNT(*) FROM purchases p WHERE p.vendor_id = v.id AND p.status != 'cancelled') as purchase_count
        FROM vendors v ${where} ${havingClause}
      ) as filtered`, params
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

  /**
   * Comprehensive vendor detail — full purchase history, payments, items supplied, financial summary
   */
  async getVendorDetail(vendorId, options = {}) {
    const pool = getPool();
    const {
      purchasePage = 1, purchaseLimit = 20,
      startDate, endDate, paymentStatus
    } = options;

    // 1. Vendor info
    const vendor = await this.getById(vendorId);
    if (!vendor) return null;

    // 2. Financial summary
    let summaryWhere = 'WHERE p.vendor_id = ? AND p.status != ?';
    const summaryParams = [vendorId, 'cancelled'];
    if (startDate) { summaryWhere += ' AND p.purchase_date >= ?'; summaryParams.push(startDate); }
    if (endDate) { summaryWhere += ' AND p.purchase_date <= ?'; summaryParams.push(endDate); }

    const [[financial]] = await pool.query(
      `SELECT
        COUNT(*) as total_purchases,
        COALESCE(SUM(p.total_amount), 0) as total_purchase_amount,
        COALESCE(SUM(p.paid_amount), 0) as total_paid_amount,
        COALESCE(SUM(p.due_amount), 0) as total_due_amount,
        COALESCE(AVG(p.total_amount), 0) as avg_purchase_value,
        COALESCE(MAX(p.total_amount), 0) as max_purchase_value,
        COALESCE(MIN(p.total_amount), 0) as min_purchase_value,
        MAX(p.purchase_date) as last_purchase_date,
        MIN(p.purchase_date) as first_purchase_date,
        COUNT(CASE WHEN p.payment_status = 'paid' THEN 1 END) as fully_paid_count,
        COUNT(CASE WHEN p.payment_status = 'partial' THEN 1 END) as partial_paid_count,
        COUNT(CASE WHEN p.payment_status = 'unpaid' THEN 1 END) as unpaid_count
       FROM purchases p ${summaryWhere}`,
      summaryParams
    );

    const financialSummary = {
      totalPurchases: parseInt(financial.total_purchases) || 0,
      totalPurchaseAmount: parseFloat(parseFloat(financial.total_purchase_amount).toFixed(2)) || 0,
      totalPaidAmount: parseFloat(parseFloat(financial.total_paid_amount).toFixed(2)) || 0,
      totalDueAmount: parseFloat(parseFloat(financial.total_due_amount).toFixed(2)) || 0,
      avgPurchaseValue: parseFloat(parseFloat(financial.avg_purchase_value).toFixed(2)) || 0,
      maxPurchaseValue: parseFloat(parseFloat(financial.max_purchase_value).toFixed(2)) || 0,
      minPurchaseValue: parseFloat(parseFloat(financial.min_purchase_value).toFixed(2)) || 0,
      firstPurchaseDate: financial.first_purchase_date || null,
      lastPurchaseDate: financial.last_purchase_date || null,
      paymentBreakdown: {
        fullyPaid: parseInt(financial.fully_paid_count) || 0,
        partialPaid: parseInt(financial.partial_paid_count) || 0,
        unpaid: parseInt(financial.unpaid_count) || 0
      }
    };

    // 3. Paginated purchase history with items
    let purchaseWhere = 'WHERE p.vendor_id = ? AND p.status != ?';
    const purchaseParams = [vendorId, 'cancelled'];
    if (startDate) { purchaseWhere += ' AND p.purchase_date >= ?'; purchaseParams.push(startDate); }
    if (endDate) { purchaseWhere += ' AND p.purchase_date <= ?'; purchaseParams.push(endDate); }
    if (paymentStatus) { purchaseWhere += ' AND p.payment_status = ?'; purchaseParams.push(paymentStatus); }

    const safePage = Math.max(1, parseInt(purchasePage) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(purchaseLimit) || 20));
    const offset = (safePage - 1) * safeLimit;

    const [[{ total: purchaseTotal }]] = await pool.query(
      `SELECT COUNT(*) as total FROM purchases p ${purchaseWhere}`, purchaseParams
    );

    const [purchaseRows] = await pool.query(
      `SELECT p.*, u.name as created_by_name,
        (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) as item_count
       FROM purchases p
       LEFT JOIN users u ON p.created_by = u.id
       ${purchaseWhere}
       ORDER BY p.purchase_date DESC, p.id DESC
       LIMIT ? OFFSET ?`,
      [...purchaseParams, safeLimit, offset]
    );

    // Get items for each purchase
    const purchaseIds = purchaseRows.map(p => p.id);
    let itemsByPurchase = {};
    if (purchaseIds.length > 0) {
      const [allItems] = await pool.query(
        `SELECT pi.*, ii.name as item_name, ii.sku as item_sku,
          u.name as unit_name, u.abbreviation as unit_abbreviation,
          ic.name as category_name
         FROM purchase_items pi
         JOIN inventory_items ii ON pi.inventory_item_id = ii.id
         LEFT JOIN units u ON pi.unit_id = u.id
         LEFT JOIN inventory_categories ic ON ii.category_id = ic.id
         WHERE pi.purchase_id IN (${purchaseIds.map(() => '?').join(',')})
         ORDER BY pi.id`,
        purchaseIds
      );
      for (const item of allItems) {
        if (!itemsByPurchase[item.purchase_id]) itemsByPurchase[item.purchase_id] = [];
        itemsByPurchase[item.purchase_id].push({
          id: item.id,
          inventoryItemId: item.inventory_item_id,
          itemName: item.item_name,
          itemSku: item.item_sku,
          categoryName: item.category_name || null,
          quantity: parseFloat(item.quantity) || 0,
          unitName: item.unit_name || null,
          unitAbbreviation: item.unit_abbreviation || null,
          pricePerUnit: parseFloat(item.price_per_unit) || 0,
          taxAmount: parseFloat(item.tax_amount) || 0,
          discountAmount: parseFloat(item.discount_amount) || 0,
          totalCost: parseFloat(item.total_cost) || 0,
          batchCode: item.batch_code || null,
          expiryDate: item.expiry_date || null
        });
      }
    }

    const purchases = purchaseRows.map(p => ({
      id: p.id,
      purchaseNumber: p.purchase_number,
      invoiceNumber: p.invoice_number || null,
      purchaseDate: p.purchase_date,
      subtotal: parseFloat(p.subtotal) || 0,
      taxAmount: parseFloat(p.tax_amount) || 0,
      discountAmount: parseFloat(p.discount_amount) || 0,
      totalAmount: parseFloat(p.total_amount) || 0,
      paidAmount: parseFloat(p.paid_amount) || 0,
      dueAmount: parseFloat(p.due_amount) || 0,
      paymentStatus: p.payment_status,
      status: p.status,
      notes: p.notes || null,
      itemCount: parseInt(p.item_count) || 0,
      createdByName: p.created_by_name || null,
      createdAt: p.created_at,
      items: itemsByPurchase[p.id] || []
    }));

    // 4. Items supplied — which inventory items this vendor provides
    const [suppliedItems] = await pool.query(
      `SELECT ii.id as inventory_item_id, ii.name as item_name, ii.sku,
        ic.name as category_name,
        bu.abbreviation as base_unit,
        COUNT(DISTINCT pi.purchase_id) as purchase_count,
        SUM(pi.quantity) as total_quantity_purchased,
        COALESCE(SUM(pi.total_cost), 0) as total_spent,
        AVG(pi.price_per_unit) as avg_price_per_unit,
        MAX(pi.price_per_unit) as max_price_per_unit,
        MIN(pi.price_per_unit) as min_price_per_unit,
        MAX(p.purchase_date) as last_purchased_date
       FROM purchase_items pi
       JOIN purchases p ON pi.purchase_id = p.id
       JOIN inventory_items ii ON pi.inventory_item_id = ii.id
       LEFT JOIN inventory_categories ic ON ii.category_id = ic.id
       LEFT JOIN units bu ON ii.base_unit_id = bu.id
       WHERE p.vendor_id = ? AND p.status != 'cancelled'
       GROUP BY ii.id, ii.name, ii.sku, ic.name, bu.abbreviation
       ORDER BY total_spent DESC`,
      [vendorId]
    );

    const itemsSupplied = suppliedItems.map(i => ({
      inventoryItemId: i.inventory_item_id,
      itemName: i.item_name,
      sku: i.sku || null,
      categoryName: i.category_name || null,
      baseUnit: i.base_unit || null,
      purchaseCount: parseInt(i.purchase_count) || 0,
      totalQuantityPurchased: parseFloat(parseFloat(i.total_quantity_purchased).toFixed(3)) || 0,
      totalSpent: parseFloat(parseFloat(i.total_spent).toFixed(2)) || 0,
      avgPricePerUnit: parseFloat(parseFloat(i.avg_price_per_unit).toFixed(2)) || 0,
      maxPricePerUnit: parseFloat(parseFloat(i.max_price_per_unit).toFixed(2)) || 0,
      minPricePerUnit: parseFloat(parseFloat(i.min_price_per_unit).toFixed(2)) || 0,
      lastPurchasedDate: i.last_purchased_date || null
    }));

    // 5. Payment history (all payments across all purchases for this vendor)
    const [paymentRows] = await pool.query(
      `SELECT pp.*, p.purchase_number, p.invoice_number, u.name as created_by_name
       FROM purchase_payments pp
       JOIN purchases p ON pp.purchase_id = p.id
       LEFT JOIN users u ON pp.created_by = u.id
       WHERE p.vendor_id = ? AND p.status != 'cancelled'
       ORDER BY pp.payment_date DESC, pp.id DESC
       LIMIT 100`,
      [vendorId]
    );

    const paymentHistory = paymentRows.map(p => ({
      id: p.id,
      purchaseId: p.purchase_id,
      purchaseNumber: p.purchase_number,
      invoiceNumber: p.invoice_number || null,
      amount: parseFloat(p.amount) || 0,
      paymentMethod: p.payment_method,
      paymentReference: p.payment_reference || null,
      paymentDate: p.payment_date,
      notes: p.notes || null,
      createdByName: p.created_by_name || null,
      createdAt: p.created_at
    }));

    // 6. Monthly purchase trend (last 12 months)
    const [monthlyRows] = await pool.query(
      `SELECT
        DATE_FORMAT(p.purchase_date, '%Y-%m') as month,
        COUNT(*) as purchase_count,
        COALESCE(SUM(p.total_amount), 0) as total_amount,
        COALESCE(SUM(p.paid_amount), 0) as paid_amount,
        COALESCE(SUM(p.due_amount), 0) as due_amount
       FROM purchases p
       WHERE p.vendor_id = ? AND p.status != 'cancelled'
         AND p.purchase_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
       GROUP BY DATE_FORMAT(p.purchase_date, '%Y-%m')
       ORDER BY month DESC`,
      [vendorId]
    );

    const monthlyTrend = monthlyRows.map(m => ({
      month: m.month,
      purchaseCount: parseInt(m.purchase_count) || 0,
      totalAmount: parseFloat(parseFloat(m.total_amount).toFixed(2)) || 0,
      paidAmount: parseFloat(parseFloat(m.paid_amount).toFixed(2)) || 0,
      dueAmount: parseFloat(parseFloat(m.due_amount).toFixed(2)) || 0
    }));

    // 7. Outstanding (unpaid/partial) purchases
    const [outstandingRows] = await pool.query(
      `SELECT p.id, p.purchase_number, p.invoice_number, p.purchase_date,
        p.total_amount, p.paid_amount, p.due_amount, p.payment_status
       FROM purchases p
       WHERE p.vendor_id = ? AND p.status != 'cancelled' AND p.payment_status IN ('unpaid', 'partial')
       ORDER BY p.due_amount DESC`,
      [vendorId]
    );

    const outstandingPurchases = outstandingRows.map(p => ({
      id: p.id,
      purchaseNumber: p.purchase_number,
      invoiceNumber: p.invoice_number || null,
      purchaseDate: p.purchase_date,
      totalAmount: parseFloat(p.total_amount) || 0,
      paidAmount: parseFloat(p.paid_amount) || 0,
      dueAmount: parseFloat(p.due_amount) || 0,
      paymentStatus: p.payment_status
    }));

    return {
      vendor,
      financialSummary,
      purchases: {
        data: purchases,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total: purchaseTotal,
          totalPages: Math.ceil(purchaseTotal / safeLimit)
        }
      },
      itemsSupplied,
      paymentHistory,
      monthlyTrend,
      outstandingPurchases
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
