/**
 * Customer Service
 * Handles customer management, GST details, and order history
 */

const { getPool } = require('../database');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Shared GST state code to state name map
const GST_STATE_MAP = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam',
  '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
  '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (Old)', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman & Nicobar', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh'
};

function deriveGstState(gstin) {
  if (!gstin || gstin.length < 2) return { gstState: null, gstStateCode: null };
  const gstStateCode = gstin.substring(0, 2);
  return { gstState: GST_STATE_MAP[gstStateCode] || null, gstStateCode };
}

const VALID_ORDER_TYPES = new Set(['dine_in', 'takeaway', 'delivery', 'online']);
const VALID_ORDER_STATUSES = new Set([
  'pending', 'confirmed', 'preparing', 'ready', 'served', 'billed', 'paid', 'cancelled'
]);
const VALID_PAYMENT_STATUSES = new Set(['pending', 'partial', 'completed', 'refunded']);

function toSafeInteger(value, fallback, min = 1, max = 200) {
  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function toSafeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const customerService = {
  // ========================
  // CUSTOMER CRUD
  // ========================

  async create(data) {
    const pool = getPool();
    const uuid = uuidv4();
    const {
      outletId, name, phone, email, address,
      isGstCustomer = false, companyName, gstin,
      companyPhone, companyAddress, notes,
      isInterstate = false
    } = data;

    // Derive gstState/gstStateCode from GSTIN if not provided
    let { gstState, gstStateCode } = data;
    if (!gstState && gstin) {
      const derived = deriveGstState(gstin);
      gstState = derived.gstState;
      gstStateCode = derived.gstStateCode;
    }

    const [result] = await pool.query(
      `INSERT INTO customers 
        (uuid, outlet_id, name, phone, email, address,
         is_gst_customer, company_name, gstin, gst_state, gst_state_code,
         company_phone, company_address, notes, is_interstate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid, outletId, name, phone, email, address,
       isGstCustomer, companyName, gstin, gstState, gstStateCode,
       companyPhone, companyAddress, notes, isInterstate ? 1 : 0]
    );

    return this.getById(result.insertId);
  },

  async update(id, data) {
    const pool = getPool();
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.phone !== undefined) { fields.push('phone = ?'); values.push(data.phone); }
    if (data.email !== undefined) { fields.push('email = ?'); values.push(data.email); }
    if (data.address !== undefined) { fields.push('address = ?'); values.push(data.address); }
    if (data.isGstCustomer !== undefined) { fields.push('is_gst_customer = ?'); values.push(data.isGstCustomer); }
    if (data.companyName !== undefined) { fields.push('company_name = ?'); values.push(data.companyName); }
    if (data.gstin !== undefined) { fields.push('gstin = ?'); values.push(data.gstin); }
    if (data.gstState !== undefined) { fields.push('gst_state = ?'); values.push(data.gstState); }
    if (data.gstStateCode !== undefined) { fields.push('gst_state_code = ?'); values.push(data.gstStateCode); }
    if (data.companyPhone !== undefined) { fields.push('company_phone = ?'); values.push(data.companyPhone); }
    if (data.companyAddress !== undefined) { fields.push('company_address = ?'); values.push(data.companyAddress); }
    if (data.notes !== undefined) { fields.push('notes = ?'); values.push(data.notes); }
    if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive); }
    if (data.isInterstate !== undefined) { fields.push('is_interstate = ?'); values.push(data.isInterstate ? 1 : 0); }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    await pool.query(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.getById(id);
  },

  async getById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT * FROM customers WHERE id = ?`,
      [id]
    );
    if (!rows[0]) return null;
    return this.formatCustomer(rows[0]);
  },

  async getByPhone(outletId, phone, exactMatch = false) {
    const pool = getPool();
    
    // If exactMatch or phone is 10+ digits, try exact match first
    if (exactMatch || phone.length >= 10) {
      const [exactRows] = await pool.query(
        `SELECT * FROM customers WHERE outlet_id = ? AND phone = ? AND is_active = 1`,
        [outletId, phone]
      );
      if (exactRows[0]) return this.formatCustomer(exactRows[0]);
    }
    
    // Partial search (last N digits match or contains)
    const searchPhone = `%${phone}%`;
    const [rows] = await pool.query(
      `SELECT * FROM customers 
       WHERE outlet_id = ? AND phone LIKE ? AND is_active = 1
       ORDER BY 
         CASE WHEN phone = ? THEN 0 ELSE 1 END,
         last_order_at DESC
       LIMIT 10`,
      [outletId, searchPhone, phone]
    );
    
    // If single result, return it; otherwise return array for selection
    if (rows.length === 1) return this.formatCustomer(rows[0]);
    if (rows.length > 1) return rows.map(r => this.formatCustomer(r));
    return null;
  },

  async getByGstin(outletId, gstin) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT * FROM customers WHERE outlet_id = ? AND gstin = ? AND is_active = 1`,
      [outletId, gstin]
    );
    if (!rows[0]) return null;
    return this.formatCustomer(rows[0]);
  },

  // ========================
  // SEARCH & LIST
  // ========================

  async search(outletId, query, limit = 20) {
    const pool = getPool();
    const searchTerm = `%${query}%`;
    const [rows] = await pool.query(
      `SELECT * FROM customers 
       WHERE outlet_id = ? AND is_active = 1
         AND (name LIKE ? OR phone LIKE ? OR company_name LIKE ? OR gstin LIKE ?)
       ORDER BY last_order_at DESC, name ASC
       LIMIT ?`,
      [outletId, searchTerm, searchTerm, searchTerm, searchTerm, limit]
    );
    return rows.map(r => this.formatCustomer(r));
  },

  async list(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1,
      limit = 50,
      gstOnly = false,
      isGstCustomer,
      isActive = true,
      hasPhone,
      hasEmail,
      isInterstate,
      search,
      minTotalSpent,
      maxTotalSpent,
      minTotalOrders,
      maxTotalOrders,
      createdFrom,
      createdTo,
      lastOrderFrom,
      lastOrderTo,
      orderType,
      paymentStatus,
      sortBy = 'lastOrderAt',
      sortOrder = 'DESC'
    } = options;

    const safePage = toSafeInteger(page, 1, 1, 100000);
    const safeLimit = toSafeInteger(limit, 50, 1, 200);
    const offset = (safePage - 1) * safeLimit;

    const statsJoin = `
      LEFT JOIN (
        SELECT
          o.customer_id,
          COUNT(*) AS total_orders,
          SUM(COALESCE(o.total_amount, 0)) AS total_spent,
          MAX(o.created_at) AS last_order_at,
          MIN(o.created_at) AS first_order_at,
          AVG(COALESCE(o.total_amount, 0)) AS avg_order_value,
          SUM(COALESCE(o.due_amount, 0)) AS total_due
        FROM orders o
        WHERE o.customer_id IS NOT NULL
          AND o.status != 'cancelled'
        GROUP BY o.customer_id
      ) os ON os.customer_id = c.id
      LEFT JOIN (
        SELECT
          o2.customer_id,
          COUNT(*) AS nc_item_count,
          COALESCE(SUM(oi.total_price), 0) AS nc_amount
        FROM order_items oi
        JOIN orders o2 ON oi.order_id = o2.id
        WHERE o2.customer_id IS NOT NULL
          AND o2.status != 'cancelled'
          AND oi.is_nc = 1 AND oi.status != 'cancelled'
        GROUP BY o2.customer_id
      ) nc ON nc.customer_id = c.id
    `;

    const whereParts = ['c.outlet_id = ?'];
    const params = [outletId];

    const gstFilter = typeof isGstCustomer === 'boolean'
      ? isGstCustomer
      : (gstOnly ? true : null);
    if (gstFilter !== null) {
      whereParts.push('c.is_gst_customer = ?');
      params.push(gstFilter ? 1 : 0);
    }

    if (typeof isActive === 'boolean') {
      whereParts.push('c.is_active = ?');
      params.push(isActive ? 1 : 0);
    }

    if (typeof hasPhone === 'boolean') {
      whereParts.push(hasPhone
        ? "c.phone IS NOT NULL AND TRIM(c.phone) != ''"
        : "(c.phone IS NULL OR TRIM(c.phone) = '')");
    }

    if (typeof hasEmail === 'boolean') {
      whereParts.push(hasEmail
        ? "c.email IS NOT NULL AND TRIM(c.email) != ''"
        : "(c.email IS NULL OR TRIM(c.email) = '')");
    }

    if (typeof isInterstate === 'boolean') {
      whereParts.push('c.is_interstate = ?');
      params.push(isInterstate ? 1 : 0);
    }

    if (hasText(search)) {
      const searchTerm = `%${search.trim()}%`;
      const isNumericSearch = /^\d+$/.test(search.trim());
      
      whereParts.push(`(
        c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.company_name LIKE ? OR c.gstin LIKE ? OR
        EXISTS (
          SELECT 1 FROM orders os 
          LEFT JOIN invoices inv ON os.id = inv.order_id AND inv.is_cancelled = 0
          WHERE os.customer_id = c.id AND os.status != 'cancelled' AND (
            os.order_number LIKE ? OR 
            os.id = ? OR
            inv.invoice_number LIKE ? OR
            inv.id = ?
          )
        )
      )`);
      params.push(
        searchTerm, searchTerm, searchTerm, searchTerm, searchTerm,
        searchTerm,
        isNumericSearch ? parseInt(search.trim()) : 0,
        searchTerm,
        isNumericSearch ? parseInt(search.trim()) : 0
      );
    }

    const minSpent = toSafeNumber(minTotalSpent);
    if (minSpent !== null) {
      whereParts.push('COALESCE(os.total_spent, c.total_spent, 0) >= ?');
      params.push(minSpent);
    }

    const maxSpent = toSafeNumber(maxTotalSpent);
    if (maxSpent !== null) {
      whereParts.push('COALESCE(os.total_spent, c.total_spent, 0) <= ?');
      params.push(maxSpent);
    }

    const minOrders = toSafeNumber(minTotalOrders);
    if (minOrders !== null) {
      whereParts.push('COALESCE(os.total_orders, c.total_orders, 0) >= ?');
      params.push(minOrders);
    }

    const maxOrders = toSafeNumber(maxTotalOrders);
    if (maxOrders !== null) {
      whereParts.push('COALESCE(os.total_orders, c.total_orders, 0) <= ?');
      params.push(maxOrders);
    }

    if (hasText(createdFrom)) {
      whereParts.push('c.created_at >= ?');
      params.push(createdFrom.trim());
    }
    if (hasText(createdTo)) {
      whereParts.push('c.created_at <= ?');
      params.push(createdTo.trim());
    }

    if (hasText(lastOrderFrom)) {
      whereParts.push('COALESCE(os.last_order_at, c.last_order_at) >= ?');
      params.push(lastOrderFrom.trim());
    }
    if (hasText(lastOrderTo)) {
      whereParts.push('COALESCE(os.last_order_at, c.last_order_at) <= ?');
      params.push(lastOrderTo.trim());
    }

    if (hasText(orderType) && VALID_ORDER_TYPES.has(orderType.trim())) {
      whereParts.push('EXISTS (SELECT 1 FROM orders o2 WHERE o2.customer_id = c.id AND o2.order_type = ?)');
      params.push(orderType.trim());
    }

    if (hasText(paymentStatus) && VALID_PAYMENT_STATUSES.has(paymentStatus.trim())) {
      whereParts.push('EXISTS (SELECT 1 FROM orders o3 WHERE o3.customer_id = c.id AND o3.payment_status = ?)');
      params.push(paymentStatus.trim());
    }

    const whereClause = whereParts.join(' AND ');

    const sortMap = {
      name: 'c.name',
      createdAt: 'c.created_at',
      updatedAt: 'c.updated_at',
      totalOrders: 'COALESCE(os.total_orders, c.total_orders, 0)',
      totalSpent: 'COALESCE(os.total_spent, c.total_spent, 0)',
      lastOrderAt: 'COALESCE(os.last_order_at, c.last_order_at)',
      avgOrderValue: 'COALESCE(os.avg_order_value, 0)'
    };

    const sortExpr = sortMap[sortBy] || sortMap.lastOrderAt;
    const order = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Parallel: data + count + summary
    const [dataResult, countResult, summaryResult] = await Promise.all([
      pool.query(
        `SELECT
           c.*,
           COALESCE(os.total_orders, c.total_orders, 0) AS total_orders,
           COALESCE(os.total_spent, c.total_spent, 0) AS total_spent,
           COALESCE(os.last_order_at, c.last_order_at) AS last_order_at,
           os.first_order_at,
           COALESCE(os.avg_order_value, 0) AS avg_order_value,
           COALESCE(os.total_due, 0) AS total_due,
           COALESCE(nc.nc_item_count, 0) AS nc_item_count,
           COALESCE(nc.nc_amount, 0) AS nc_amount
         FROM customers c
         ${statsJoin}
         WHERE ${whereClause}
         ORDER BY ${sortExpr} ${order}, c.id DESC
         LIMIT ? OFFSET ?`,
        [...params, safeLimit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) AS total
         FROM customers c
         ${statsJoin}
         WHERE ${whereClause}`,
        params
      ),
      pool.query(
        `SELECT
           COUNT(*) AS total_customers,
           SUM(CASE WHEN c.is_gst_customer = 1 THEN 1 ELSE 0 END) AS gst_customers,
           SUM(CASE WHEN c.is_active = 1 THEN 1 ELSE 0 END) AS active_customers,
           SUM(COALESCE(os.total_orders, c.total_orders, 0)) AS total_orders,
           SUM(COALESCE(os.total_spent, c.total_spent, 0)) AS total_spent
         FROM customers c
         ${statsJoin}
         WHERE ${whereClause}`,
        params
      )
    ]);
    const rows = dataResult[0];
    const total = countResult[0][0].total;
    const summaryRow = summaryResult[0][0];

    return {
      customers: rows.map((r) => ({
        ...this.formatCustomer(r),
        dueBalance: parseFloat(r.total_due) || 0,
        firstOrderAt: r.first_order_at || null,
        avgOrderValue: parseFloat(r.avg_order_value) || 0,
        totalDue: parseFloat(r.total_due) || 0,
        ncItemCount: parseInt(r.nc_item_count) || 0,
        ncAmount: parseFloat(r.nc_amount) || 0
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit)
      },
      summary: {
        totalCustomers: Number(summaryRow.total_customers) || 0,
        gstCustomers: Number(summaryRow.gst_customers) || 0,
        activeCustomers: Number(summaryRow.active_customers) || 0,
        totalOrders: Number(summaryRow.total_orders) || 0,
        totalSpent: parseFloat(summaryRow.total_spent) || 0
      }
    };
  },

  // ========================
  // ORDER HISTORY
  // ========================

  async getOrderHistory(customerId, options = {}) {
    const pool = getPool();
    const { page = 1, limit = 20 } = options;
    const offset = (page - 1) * limit;

    const [orders] = await pool.query(
      `SELECT o.id, o.uuid, o.order_number, o.order_type, o.status, o.payment_status,
              o.subtotal, o.discount_amount, o.tax_amount, o.total_amount,
              o.paid_amount, o.due_amount, o.is_adjustment, o.adjustment_amount,
              o.is_interstate, o.customer_gstin, o.customer_company_name,
              o.created_at, o.billed_at,
              t.table_number, t.name as table_name,
              i.cgst_amount, i.sgst_amount, i.igst_amount, i.invoice_number,
              i.paid_amount as invoice_paid_amount, i.due_amount as invoice_due_amount
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN invoices i ON o.id = i.order_id AND i.is_cancelled = 0
       WHERE o.customer_id = ?
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [customerId, limit, offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM orders WHERE customer_id = ?`,
      [customerId]
    );

    return {
      orders: orders.map(o => {
        const isInterstate = !!o.is_interstate;
        return {
          id: o.id,
          uuid: o.uuid,
          orderNumber: o.order_number,
          orderType: o.order_type,
          status: o.status,
          paymentStatus: o.payment_status,
          subtotal: parseFloat(o.subtotal) || 0,
          discountAmount: parseFloat(o.discount_amount) || 0,
          taxAmount: parseFloat(o.tax_amount) || 0,
          totalAmount: parseFloat(o.total_amount) || 0,
          paidAmount: parseFloat(o.paid_amount) || 0,
          dueAmount: parseFloat(o.due_amount) || 0,
          isAdjustment: !!o.is_adjustment,
          adjustmentAmount: parseFloat(o.adjustment_amount) || 0,
          isInterstate,
          taxType: isInterstate ? 'IGST' : 'CGST+SGST',
          cgstAmount: parseFloat(o.cgst_amount) || 0,
          sgstAmount: parseFloat(o.sgst_amount) || 0,
          igstAmount: parseFloat(o.igst_amount) || 0,
          customerGstin: o.customer_gstin || null,
          customerCompanyName: o.customer_company_name || null,
          invoiceNumber: o.invoice_number || null,
          tableNumber: o.table_number,
          tableName: o.table_name,
          createdAt: o.created_at,
          billedAt: o.billed_at
        };
      }),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    };
  },

  async getCustomerDetails(outletId, customerId, options = {}) {
    const pool = getPool();
    const {
      includeOrders = true,
      includeItems = true,
      includePayments = true,
      includeCancelledOrders = true,
      paginate = false,
      page = 1,
      limit = 50,
      search,
      status,
      paymentStatus,
      orderType,
      fromDate,
      toDate,
      minAmount,
      maxAmount,
      sortBy = 'createdAt',
      sortOrder = 'DESC'
    } = options;

    const [customerRows] = await pool.query(
      `SELECT
         c.*,
         COALESCE(os.total_orders, c.total_orders, 0) AS total_orders,
         COALESCE(os.total_spent, c.total_spent, 0) AS total_spent,
         COALESCE(os.last_order_at, c.last_order_at) AS last_order_at,
         os.first_order_at,
         COALESCE(os.avg_order_value, 0) AS avg_order_value,
         COALESCE(os.total_due, 0) AS total_due
       FROM customers c
       LEFT JOIN (
         SELECT
           o.customer_id,
           COUNT(*) AS total_orders,
           SUM(COALESCE(o.total_amount, 0)) AS total_spent,
           MAX(o.created_at) AS last_order_at,
           MIN(o.created_at) AS first_order_at,
           AVG(COALESCE(o.total_amount, 0)) AS avg_order_value,
           SUM(COALESCE(o.due_amount, 0)) AS total_due
         FROM orders o
         WHERE o.customer_id IS NOT NULL
           AND o.status != 'cancelled'
         GROUP BY o.customer_id
       ) os ON os.customer_id = c.id
       WHERE c.outlet_id = ? AND c.id = ?
       LIMIT 1`,
      [outletId, customerId]
    );

    if (!customerRows[0]) {
      return null;
    }

    const customerRow = customerRows[0];
    const customer = {
      ...this.formatCustomer(customerRow),
      dueBalance: parseFloat(customerRow.total_due) || 0,
      firstOrderAt: customerRow.first_order_at || null,
      avgOrderValue: parseFloat(customerRow.avg_order_value) || 0
    };

    if (!includeOrders) {
      return {
        customer,
        orderHistory: [],
        pagination: null,
        historyStats: null,
        historyBreakdown: null
      };
    }

    const whereParts = ['o.customer_id = ?'];
    const params = [customerId];

    if (!includeCancelledOrders) {
      whereParts.push("o.status != 'cancelled'");
    }

    if (hasText(search)) {
      const term = `%${search.trim()}%`;
      const isNumericSearch = /^\d+$/.test(search.trim());
      
      whereParts.push(`(
        o.order_number LIKE ? OR 
        o.id = ? OR
        i.invoice_number LIKE ? OR 
        i.id = ? OR
        t.table_number LIKE ? OR 
        t.name LIKE ?
      )`);
      params.push(
        term,
        isNumericSearch ? parseInt(search.trim()) : 0,
        term,
        isNumericSearch ? parseInt(search.trim()) : 0,
        term,
        term
      );
    }

    if (hasText(status) && VALID_ORDER_STATUSES.has(status.trim())) {
      whereParts.push('o.status = ?');
      params.push(status.trim());
    }

    if (hasText(paymentStatus) && VALID_PAYMENT_STATUSES.has(paymentStatus.trim())) {
      whereParts.push('o.payment_status = ?');
      params.push(paymentStatus.trim());
    }

    if (hasText(orderType) && VALID_ORDER_TYPES.has(orderType.trim())) {
      whereParts.push('o.order_type = ?');
      params.push(orderType.trim());
    }

    if (hasText(fromDate)) {
      whereParts.push('o.created_at >= ?');
      params.push(fromDate.trim());
    }
    if (hasText(toDate)) {
      whereParts.push('o.created_at <= ?');
      params.push(toDate.trim());
    }

    const minTotal = toSafeNumber(minAmount);
    if (minTotal !== null) {
      whereParts.push('COALESCE(o.total_amount, 0) >= ?');
      params.push(minTotal);
    }
    const maxTotal = toSafeNumber(maxAmount);
    if (maxTotal !== null) {
      whereParts.push('COALESCE(o.total_amount, 0) <= ?');
      params.push(maxTotal);
    }

    const whereClause = whereParts.join(' AND ');

    const sortMap = {
      createdAt: 'o.created_at',
      billedAt: 'o.billed_at',
      totalAmount: 'o.total_amount',
      orderNumber: 'o.order_number',
      invoiceDate: 'i.invoice_date'
    };
    const sortExpr = sortMap[sortBy] || sortMap.createdAt;
    const orderDir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const baseOrderSql = `
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN floors f ON o.floor_id = f.id
      LEFT JOIN invoices i ON i.order_id = o.id AND i.is_cancelled = 0
      WHERE ${whereClause}
    `;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${baseOrderSql}`,
      params
    );

    const safePage = toSafeInteger(page, 1, 1, 100000);
    const safeLimit = toSafeInteger(limit, 50, 1, 200);
    const offset = (safePage - 1) * safeLimit;

    const orderQuery = paginate
      ? `SELECT
           o.id, o.uuid, o.order_number, o.order_type, o.status, o.payment_status,
           o.subtotal, o.discount_amount, o.tax_amount, o.total_amount,
           o.paid_amount, o.due_amount, o.is_adjustment, o.adjustment_amount,
           o.is_nc, o.nc_amount, o.nc_reason,
           o.service_charge, o.packaging_charge, o.delivery_charge, o.round_off,
           o.is_interstate, o.customer_gstin, o.customer_company_name,
           o.customer_gst_state, o.customer_gst_state_code,
           o.created_at, o.updated_at, o.billed_at,
           t.id AS table_id, t.table_number, t.name AS table_name,
           f.id AS floor_id, f.name AS floor_name,
           i.id AS invoice_id, i.invoice_number, i.invoice_date, i.invoice_time,
           i.grand_total AS invoice_grand_total, i.payment_status AS invoice_payment_status
         ${baseOrderSql}
         ORDER BY ${sortExpr} ${orderDir}, o.id DESC
         LIMIT ? OFFSET ?`
      : `SELECT
           o.id, o.uuid, o.order_number, o.order_type, o.status, o.payment_status,
           o.subtotal, o.discount_amount, o.tax_amount, o.total_amount,
           o.paid_amount, o.due_amount, o.is_adjustment, o.adjustment_amount,
           o.is_nc, o.nc_amount, o.nc_reason,
           o.service_charge, o.packaging_charge, o.delivery_charge, o.round_off,
           o.is_interstate, o.customer_gstin, o.customer_company_name,
           o.customer_gst_state, o.customer_gst_state_code,
           o.created_at, o.updated_at, o.billed_at,
           t.id AS table_id, t.table_number, t.name AS table_name,
           f.id AS floor_id, f.name AS floor_name,
           i.id AS invoice_id, i.invoice_number, i.invoice_date, i.invoice_time,
           i.grand_total AS invoice_grand_total, i.payment_status AS invoice_payment_status
         ${baseOrderSql}
         ORDER BY ${sortExpr} ${orderDir}, o.id DESC`;

    const queryParams = paginate ? [...params, safeLimit, offset] : params;
    const [orders] = await pool.query(orderQuery, queryParams);

    const orderIds = orders.map((o) => o.id);
    const itemsByOrder = new Map();
    const paymentsByOrder = new Map();

    if (includeItems && orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const [items] = await pool.query(
        `SELECT
           oi.id, oi.order_id, oi.item_id, oi.variant_id,
           oi.item_name, oi.variant_name, oi.item_type, oi.status,
           oi.quantity, oi.unit_price, oi.base_price,
           oi.discount_amount, oi.tax_amount, oi.total_price,
           oi.is_nc, oi.nc_reason,
           oi.special_instructions, oi.created_at
         FROM order_items oi
         WHERE oi.order_id IN (${placeholders})
         ORDER BY oi.order_id ASC, oi.id ASC`,
        orderIds
      );

      for (const item of items) {
        if (!itemsByOrder.has(item.order_id)) {
          itemsByOrder.set(item.order_id, []);
        }
        itemsByOrder.get(item.order_id).push({
          id: item.id,
          itemId: item.item_id,
          variantId: item.variant_id,
          itemName: item.item_name,
          variantName: item.variant_name || null,
          itemType: item.item_type || null,
          status: item.status,
          quantity: parseFloat(item.quantity) || 0,
          unitPrice: parseFloat(item.unit_price) || 0,
          basePrice: parseFloat(item.base_price) || 0,
          discountAmount: parseFloat(item.discount_amount) || 0,
          taxAmount: parseFloat(item.tax_amount) || 0,
          totalPrice: parseFloat(item.total_price) || 0,
          isNc: !!item.is_nc,
          ncReason: item.nc_reason || null,
          specialInstructions: item.special_instructions || null,
          createdAt: item.created_at
        });
      }
    }

    if (includePayments && orderIds.length > 0) {
      const placeholders = orderIds.map(() => '?').join(',');
      const [payments] = await pool.query(
        `SELECT
           p.id, p.order_id, p.invoice_id,
           p.payment_mode, p.amount, p.tip_amount, p.total_amount,
           p.status, p.transaction_id, p.reference_number,
           p.created_at
         FROM payments p
         WHERE p.order_id IN (${placeholders})
         ORDER BY p.order_id ASC, p.created_at ASC, p.id ASC`,
        orderIds
      );

      for (const payment of payments) {
        if (!paymentsByOrder.has(payment.order_id)) {
          paymentsByOrder.set(payment.order_id, []);
        }
        paymentsByOrder.get(payment.order_id).push({
          id: payment.id,
          invoiceId: payment.invoice_id || null,
          paymentMode: payment.payment_mode,
          amount: parseFloat(payment.amount) || 0,
          tipAmount: parseFloat(payment.tip_amount) || 0,
          totalAmount: parseFloat(payment.total_amount) || 0,
          status: payment.status,
          transactionId: payment.transaction_id || null,
          referenceNumber: payment.reference_number || null,
          createdAt: payment.created_at
        });
      }
    }

    const orderHistory = orders.map((o) => {
      const isInterstateOrder = !!o.is_interstate;
      return {
        id: o.id,
        uuid: o.uuid,
        orderNumber: o.order_number,
        orderType: o.order_type,
        status: o.status,
        paymentStatus: o.payment_status,
        subtotal: parseFloat(o.subtotal) || 0,
        discountAmount: parseFloat(o.discount_amount) || 0,
        taxAmount: parseFloat(o.tax_amount) || 0,
        totalAmount: parseFloat(o.total_amount) || 0,
        paidAmount: parseFloat(o.paid_amount) || 0,
        dueAmount: parseFloat(o.due_amount) || 0,
        isAdjustment: !!o.is_adjustment,
        adjustmentAmount: parseFloat(o.adjustment_amount) || 0,
        isNc: !!o.is_nc,
        ncAmount: parseFloat(o.nc_amount) || 0,
        ncReason: o.nc_reason || null,
        serviceCharge: parseFloat(o.service_charge) || 0,
        packagingCharge: parseFloat(o.packaging_charge) || 0,
        deliveryCharge: parseFloat(o.delivery_charge) || 0,
        roundOff: parseFloat(o.round_off) || 0,
        isInterstate: isInterstateOrder,
        taxType: isInterstateOrder ? 'IGST' : 'CGST+SGST',
        customerGstin: o.customer_gstin || null,
        customerCompanyName: o.customer_company_name || null,
        customerGstState: o.customer_gst_state || null,
        customerGstStateCode: o.customer_gst_state_code || null,
        tableId: o.table_id || null,
        tableNumber: o.table_number || null,
        tableName: o.table_name || null,
        floorId: o.floor_id || null,
        floorName: o.floor_name || null,
        invoice: o.invoice_id ? {
          id: o.invoice_id,
          invoiceNumber: o.invoice_number,
          invoiceDate: o.invoice_date || null,
          invoiceTime: o.invoice_time || null,
          grandTotal: parseFloat(o.invoice_grand_total) || 0,
          paymentStatus: o.invoice_payment_status || null
        } : null,
        items: includeItems ? (itemsByOrder.get(o.id) || []) : undefined,
        payments: includePayments ? (paymentsByOrder.get(o.id) || []) : undefined,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
        billedAt: o.billed_at
      };
    });

    const [[statsRow]] = await pool.query(
      `SELECT
         COUNT(*) AS total_orders,
         SUM(CASE WHEN o.status != 'cancelled' THEN 1 ELSE 0 END) AS active_orders,
         SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders,
         SUM(CASE WHEN o.payment_status = 'completed' THEN 1 ELSE 0 END) AS fully_paid_orders,
         SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.total_amount, 0) ELSE 0 END) AS total_spent,
         AVG(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.total_amount, 0) ELSE NULL END) AS avg_order_value,
         MIN(o.created_at) AS first_order_at,
         MAX(o.created_at) AS last_order_at
       FROM orders o
       WHERE o.customer_id = ?`,
      [customerId]
    );

    const [byOrderTypeRows] = await pool.query(
      `SELECT
         o.order_type,
         COUNT(*) AS count,
         SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.total_amount, 0) ELSE 0 END) AS amount
       FROM orders o
       WHERE o.customer_id = ?
       GROUP BY o.order_type`,
      [customerId]
    );

    const [byPaymentStatusRows] = await pool.query(
      `SELECT
         o.payment_status,
         COUNT(*) AS count,
         SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.total_amount, 0) ELSE 0 END) AS amount
       FROM orders o
       WHERE o.customer_id = ?
       GROUP BY o.payment_status`,
      [customerId]
    );

    const pagination = paginate
      ? {
          page: safePage,
          limit: safeLimit,
          total,
          totalPages: Math.ceil(total / safeLimit)
        }
      : {
          page: 1,
          limit: total,
          total,
          totalPages: total > 0 ? 1 : 0
        };

    return {
      customer,
      orderHistory,
      pagination,
      historyStats: {
        totalOrders: Number(statsRow.total_orders) || 0,
        activeOrders: Number(statsRow.active_orders) || 0,
        cancelledOrders: Number(statsRow.cancelled_orders) || 0,
        fullyPaidOrders: Number(statsRow.fully_paid_orders) || 0,
        totalSpent: parseFloat(statsRow.total_spent) || 0,
        avgOrderValue: parseFloat(statsRow.avg_order_value) || 0,
        firstOrderAt: statsRow.first_order_at || null,
        lastOrderAt: statsRow.last_order_at || null
      },
      historyBreakdown: {
        byOrderType: byOrderTypeRows.map((row) => ({
          orderType: row.order_type,
          count: Number(row.count) || 0,
          amount: parseFloat(row.amount) || 0
        })),
        byPaymentStatus: byPaymentStatusRows.map((row) => ({
          paymentStatus: row.payment_status,
          count: Number(row.count) || 0,
          amount: parseFloat(row.amount) || 0
        }))
      }
    };
  },

  // ========================
  // LINK CUSTOMER TO ORDER
  // ========================

  async linkToOrder(orderId, customerData) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      let customerId = customerData.customerId;
      let customer = null;
      let isUpdate = false; // Track if this is an update operation
      const isInterstate = customerData.isInterstate === true;
      const taxType = isInterstate ? 'IGST' : 'CGST+SGST';

      // Derive gstState/gstStateCode from GSTIN
      const gstin = customerData.gstin || null;
      const { gstState, gstStateCode } = deriveGstState(gstin);

      // Get order info (needed for outlet_id and existing customer_id)
      const [orderRows] = await connection.query(
        'SELECT outlet_id, customer_id FROM orders WHERE id = ?', [orderId]
      );
      const outletId = orderRows[0]?.outlet_id;
      const existingCustomerId = orderRows[0]?.customer_id;
      if (!outletId) throw new Error('Order not found');

      // SCENARIO 1: Order already has a customer linked - UPDATE existing customer
      if (existingCustomerId && !customerId) {
        customerId = existingCustomerId;
        customer = await this.getById(customerId);
        isUpdate = true;
        
        // Update existing customer with new details
        const updateFields = [];
        const updateValues = [];
        
        if (customerData.name) { updateFields.push('name = ?'); updateValues.push(customerData.name); }
        if (customerData.phone) { updateFields.push('phone = ?'); updateValues.push(customerData.phone); }
        if (customerData.email) { updateFields.push('email = ?'); updateValues.push(customerData.email); }
        if (customerData.address) { updateFields.push('address = ?'); updateValues.push(customerData.address); }
        if (gstin) { 
          updateFields.push('gstin = ?', 'is_gst_customer = 1'); 
          updateValues.push(gstin); 
        }
        if (customerData.companyName) { updateFields.push('company_name = ?'); updateValues.push(customerData.companyName); }
        if (customerData.companyPhone) { updateFields.push('company_phone = ?'); updateValues.push(customerData.companyPhone); }
        if (customerData.companyAddress) { updateFields.push('company_address = ?'); updateValues.push(customerData.companyAddress); }
        if (gstState) { updateFields.push('gst_state = ?'); updateValues.push(gstState); }
        if (gstStateCode) { updateFields.push('gst_state_code = ?'); updateValues.push(gstStateCode); }
        updateFields.push('is_interstate = ?'); updateValues.push(isInterstate ? 1 : 0);
        
        if (updateFields.length > 0) {
          updateValues.push(customerId);
          await connection.query(
            `UPDATE customers SET ${updateFields.join(', ')}, updated_at = NOW() WHERE id = ?`,
            updateValues
          );
        }
        
        // Refresh customer data after update
        customer = await this.getById(customerId);
      }
      // SCENARIO 2: customerId explicitly provided - use that customer
      else if (customerId) {
        customer = await this.getById(customerId);
      } 
      // SCENARIO 3: Try to find existing customer by phone
      else if (customerData.phone) {
        const found = await this.getByPhone(outletId, customerData.phone);
        if (found && !Array.isArray(found)) {
          customer = found;
          customerId = customer.id;
        } else if (Array.isArray(found) && found.length === 1) {
          customer = found[0];
          customerId = customer.id;
        }
      }

      // SCENARIO 4: Create new customer if not found
      if (!customerId && customerData.name) {
        const newCustomer = await this.create({
          outletId,
          name: customerData.name,
          phone: customerData.phone,
          email: customerData.email,
          address: customerData.address,
          isGstCustomer: customerData.isGstCustomer || false,
          companyName: customerData.companyName,
          gstin,
          gstState,
          gstStateCode,
          companyPhone: customerData.companyPhone,
          companyAddress: customerData.companyAddress,
          isInterstate
        });
        customerId = newCustomer.id;
        customer = newCustomer;
      }

      // Update existing customer's GST fields if GST data is provided
      if (customerId && (gstin || customerData.isGstCustomer)) {
        await connection.query(
          `UPDATE customers SET 
            is_gst_customer = ?,
            gstin = COALESCE(?, gstin),
            company_name = COALESCE(?, company_name),
            company_phone = COALESCE(?, company_phone),
            gst_state = COALESCE(?, gst_state),
            gst_state_code = COALESCE(?, gst_state_code),
            is_interstate = ?
           WHERE id = ?`,
          [
            customerData.isGstCustomer ? 1 : (gstin ? 1 : 0),
            gstin,
            customerData.companyName || null,
            customerData.companyPhone || null,
            gstState,
            gstStateCode,
            isInterstate ? 1 : 0,
            customerId
          ]
        );
      }

      // Update order with customer details
      const updateFields = [
        'customer_id = ?', 'customer_name = ?', 'customer_phone = ?',
        'is_interstate = ?'
      ];
      const updateValues = [
        customerId,
        customerData.name || customer?.name,
        customerData.phone || customer?.phone,
        isInterstate ? 1 : 0
      ];

      // Add GST fields if provided
      if (gstin || customer?.gstin) {
        updateFields.push(
          'customer_gstin = ?', 'customer_company_name = ?',
          'customer_gst_state = ?', 'customer_gst_state_code = ?'
        );
        updateValues.push(
          gstin || customer?.gstin,
          customerData.companyName || customer?.companyName,
          gstState || customer?.gstState,
          gstStateCode || customer?.gstStateCode
        );
      }

      updateValues.push(orderId);
      await connection.query(
        `UPDATE orders SET ${updateFields.join(', ')} WHERE id = ?`,
        updateValues
      );

      // Update customer stats (only increment total_orders if this is NOT an update operation)
      if (customerId && !isUpdate) {
        await connection.query(
          `UPDATE customers SET 
            total_orders = total_orders + 1,
            last_order_at = NOW()
           WHERE id = ?`,
          [customerId]
        );
      } else if (customerId && isUpdate) {
        // Just update last_order_at for updates
        await connection.query(
          `UPDATE customers SET last_order_at = NOW() WHERE id = ?`,
          [customerId]
        );
      }

      // Update existing invoice if one exists for this order
      const [existingInvoice] = await connection.query(
        'SELECT id FROM invoices WHERE order_id = ? AND is_cancelled = 0 ORDER BY created_at DESC LIMIT 1',
        [orderId]
      );
      if (existingInvoice[0]) {
        const invoiceId = existingInvoice[0].id;
        const customerName = customerData.name || customer?.name;
        const customerPhone = customerData.phone || customer?.phone;
        const customerGstin = gstin || customer?.gstin;
        const customerCompanyName = customerData.companyName || customer?.companyName;

        // Get order with items for tax recalculation
        const [orderData] = await connection.query(
          `SELECT o.*, GROUP_CONCAT(oi.id) as item_ids
           FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
           WHERE o.id = ?`, [orderId]
        );
        const [orderItems] = await connection.query(
          'SELECT * FROM order_items WHERE order_id = ? AND status != ?',
          [orderId, 'cancelled']
        );

        if (orderData[0]) {
          const orderObj = { ...orderData[0], items: orderItems, is_interstate: isInterstate };
          const billingService = require('./billing.service');
          const billDetails = await billingService.calculateBillDetails(orderObj, { isInterstate });

          await connection.query(
            `UPDATE invoices SET
              customer_id = ?, customer_name = ?, customer_phone = ?,
              customer_gstin = ?, customer_company_name = ?,
              customer_gst_state = ?, customer_gst_state_code = ?,
              is_interstate = ?,
              cgst_amount = ?, sgst_amount = ?, igst_amount = ?,
              vat_amount = ?, cess_amount = ?,
              total_tax = ?,
              round_off = ?, grand_total = ?,
              amount_in_words = ?, tax_breakup = ?
             WHERE id = ?`,
            [
              customerId, customerName, customerPhone,
              customerGstin, customerCompanyName,
              gstState, gstStateCode,
              isInterstate ? 1 : 0,
              billDetails.cgstAmount, billDetails.sgstAmount, billDetails.igstAmount,
              billDetails.vatAmount, billDetails.cessAmount,
              billDetails.totalTax,
              billDetails.roundOff, billDetails.grandTotal,
              billingService.numberToWords(billDetails.grandTotal),
              JSON.stringify(billDetails.taxBreakup),
              invoiceId
            ]
          );
        }
      }

      await connection.commit();

      // Fetch fresh customer data to return
      const finalCustomer = customerId ? await this.getById(customerId) : customer;

      return { 
        customerId, 
        orderId: parseInt(orderId),
        customer: finalCustomer,
        customerName: finalCustomer?.name || customerData.name || 'Walk-in Customer',
        customerPhone: finalCustomer?.phone || customerData.phone || null,
        customerEmail: finalCustomer?.email || customerData.email || null,
        customerAddress: finalCustomer?.address || customerData.address || null,
        isGstCustomer: finalCustomer?.isGstCustomer || false,
        gstin: finalCustomer?.gstin || customerData.gstin || null,
        companyName: finalCustomer?.companyName || customerData.companyName || null,
        isInterstate,
        taxType,
        isUpdate // Indicates if existing customer was updated vs new creation
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async updateOrderCustomerGst(orderId, gstData) {
    const pool = getPool();
    let { customerId, gstin, companyName, companyPhone, isInterstate: inputInterstate } = gstData;

    // Use isInterstate directly from input (default false = same state)
    const isInterstate = inputInterstate === true;
    const taxType = isInterstate ? 'IGST' : 'CGST+SGST';

    // Derive gst_state and gst_state_code from GSTIN
    const { gstState, gstStateCode } = deriveGstState(gstin);

    // Update order with GST details
    await pool.query(
      `UPDATE orders SET 
        customer_gstin = ?, customer_company_name = ?,
        customer_gst_state = ?, customer_gst_state_code = ?,
        is_interstate = ?
       WHERE id = ?`,
      [gstin, companyName, gstState, gstStateCode, isInterstate, orderId]
    );

    // If customerId not provided, try to get it from the order
    if (!customerId) {
      const [order] = await pool.query('SELECT customer_id FROM orders WHERE id = ?', [orderId]);
      if (order[0]?.customer_id) {
        customerId = order[0].customer_id;
      }
    }

    // Update the customer record if customerId exists
    if (customerId) {
      const [customer] = await pool.query('SELECT id FROM customers WHERE id = ?', [customerId]);
      if (customer[0]) {
        await pool.query(
          `UPDATE customers SET 
            is_gst_customer = 1,
            gstin = ?, company_name = ?,
            company_phone = ?,
            gst_state = ?, gst_state_code = ?,
            is_interstate = ?
           WHERE id = ?`,
          [gstin, companyName, companyPhone || null, gstState, gstStateCode, isInterstate ? 1 : 0, customerId]
        );
      }
    }

    // Update existing invoice if one exists for this order
    const [existingInvoice] = await pool.query(
      'SELECT id FROM invoices WHERE order_id = ? AND is_cancelled = 0 ORDER BY created_at DESC LIMIT 1',
      [orderId]
    );
    if (existingInvoice[0]) {
      const invoiceId = existingInvoice[0].id;
      const [orderData] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      const [orderItems] = await pool.query(
        'SELECT * FROM order_items WHERE order_id = ? AND status != ?',
        [orderId, 'cancelled']
      );
      if (orderData[0]) {
        const orderObj = { ...orderData[0], items: orderItems, is_interstate: isInterstate };
        const billingService = require('./billing.service');
        const billDetails = await billingService.calculateBillDetails(orderObj, { isInterstate });

        await pool.query(
          `UPDATE invoices SET
            customer_gstin = ?, customer_company_name = ?,
            customer_gst_state = ?, customer_gst_state_code = ?,
            is_interstate = ?,
            cgst_amount = ?, sgst_amount = ?, igst_amount = ?,
            vat_amount = ?, cess_amount = ?,
            total_tax = ?,
            round_off = ?, grand_total = ?,
            amount_in_words = ?, tax_breakup = ?
           WHERE id = ?`,
          [
            gstin, companyName,
            gstState, gstStateCode,
            isInterstate ? 1 : 0,
            billDetails.cgstAmount, billDetails.sgstAmount, billDetails.igstAmount,
            billDetails.vatAmount, billDetails.cessAmount,
            billDetails.totalTax,
            billDetails.roundOff, billDetails.grandTotal,
            billingService.numberToWords(billDetails.grandTotal),
            JSON.stringify(billDetails.taxBreakup),
            invoiceId
          ]
        );
      }
    }

    return { 
      orderId: parseInt(orderId),
      isInterstate, 
      taxType,
      customerId,
      gstin,
      companyName,
      gstState,
      gstStateCode
    };
  },

  // ========================
  // HELPERS
  // ========================

  formatCustomer(row) {
    return {
      id: row.id,
      uuid: row.uuid,
      outletId: row.outlet_id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      address: row.address,
      isGstCustomer: !!row.is_gst_customer,
      companyName: row.company_name,
      gstin: row.gstin,
      gstState: row.gst_state,
      gstStateCode: row.gst_state_code,
      companyPhone: row.company_phone,
      companyAddress: row.company_address,
      isInterstate: !!row.is_interstate,
      totalOrders: row.total_orders,
      totalSpent: parseFloat(row.total_spent) || 0,
      dueBalance: parseFloat(row.due_balance) || 0,
      totalDueCollected: parseFloat(row.total_due_collected) || 0,
      lastOrderAt: row.last_order_at,
      notes: row.notes,
      isActive: !!row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  },

  /**
   * List customers with due balance (calculated from actual order dues)
   * Supports search by customer name, phone, order number, invoice number
   */
  async listWithDue(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1,
      limit = 50,
      search = null,
      minDue = null,
      maxDue = null,
      fromDate = null,
      toDate = null,
      sortBy = 'dueBalance',
      sortOrder = 'DESC'
    } = options;

    const safePage = toSafeInteger(page, 1, 1, 100000);
    const safeLimit = toSafeInteger(limit, 50, 1, 200);
    const offset = (safePage - 1) * safeLimit;

    // Build conditions for customer and order filters
    const customerConditions = ['c.outlet_id = ?', 'c.is_active = 1'];
    const customerParams = [outletId];

    // Build order subquery conditions for search (exclude cancelled orders)
    let orderSearchCondition = "o.due_amount > 0 AND o.status != 'cancelled'";
    const orderSearchParams = [];

    // Search by customer name, phone, order number, invoice number
    if (hasText(search)) {
      const searchTerm = `%${search.trim()}%`;
      // Check if search term looks like an order/invoice number
      const isNumericSearch = /^\d+$/.test(search.trim());
      
      customerConditions.push(`(
        c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR
        EXISTS (
          SELECT 1 FROM orders os 
          LEFT JOIN invoices inv ON os.id = inv.order_id AND inv.is_cancelled = 0
          WHERE os.customer_id = c.id AND os.due_amount > 0 AND os.status != 'cancelled' AND (
            os.order_number LIKE ? OR 
            os.id = ? OR
            inv.invoice_number LIKE ? OR
            inv.id = ?
          )
        )
      )`);
      customerParams.push(
        searchTerm, searchTerm, searchTerm,
        searchTerm,
        isNumericSearch ? parseInt(search.trim()) : 0,
        searchTerm,
        isNumericSearch ? parseInt(search.trim()) : 0
      );
    }

    // Date filters on due orders
    if (hasText(fromDate)) {
      orderSearchCondition += ' AND o.created_at >= ?';
      orderSearchParams.push(fromDate.trim());
    }
    if (hasText(toDate)) {
      orderSearchCondition += ' AND o.created_at <= ?';
      orderSearchParams.push(toDate.trim());
    }

    const customerWhereClause = customerConditions.join(' AND ');

    // Build due amount filter conditions (reference od.actual_due in WHERE, not HAVING)
    let dueFilterConditions = [];
    if (minDue !== null && minDue > 0) {
      dueFilterConditions.push(`od.actual_due >= ${parseFloat(minDue)}`);
    }
    if (maxDue !== null) {
      dueFilterConditions.push(`od.actual_due <= ${parseFloat(maxDue)}`);
    }
    const dueFilterClause = dueFilterConditions.length > 0 
      ? ' AND ' + dueFilterConditions.join(' AND ') 
      : '';

    const sortMap = {
      dueBalance: 'od.actual_due',
      name: 'c.name',
      lastOrderAt: 'od.last_due_date',
      totalSpent: 'c.total_spent',
      pendingOrders: 'od.pending_due_orders',
      totalCollected: 'od.total_due_collected'
    };
    const sortExpr = sortMap[sortBy] || 'od.actual_due';
    const order = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Parallel: data + count + summary
    const [dataResult, countResult, summaryResult] = await Promise.all([
      pool.query(
        `SELECT c.*, 
                od.actual_due,
                od.pending_due_orders,
                od.total_due_collected as calculated_due_collected,
                od.last_due_date,
                od.first_due_date,
                od.order_numbers,
                od.nc_item_count,
                od.nc_amount
         FROM customers c
         INNER JOIN (
           SELECT o.customer_id, 
                  SUM(o.due_amount) as actual_due,
                  COUNT(*) as pending_due_orders,
                  SUM(o.paid_amount) as total_due_collected,
                  MAX(o.created_at) as last_due_date,
                  MIN(o.created_at) as first_due_date,
                  GROUP_CONCAT(o.order_number ORDER BY o.created_at DESC SEPARATOR ', ') as order_numbers,
                  (SELECT COUNT(*) FROM order_items oi2 WHERE oi2.order_id IN (SELECT o2.id FROM orders o2 WHERE o2.customer_id = o.customer_id AND o2.due_amount > 0 AND o2.status != 'cancelled') AND oi2.is_nc = 1 AND oi2.status != 'cancelled') as nc_item_count,
                  (SELECT COALESCE(SUM(oi2.total_price), 0) FROM order_items oi2 WHERE oi2.order_id IN (SELECT o2.id FROM orders o2 WHERE o2.customer_id = o.customer_id AND o2.due_amount > 0 AND o2.status != 'cancelled') AND oi2.is_nc = 1 AND oi2.status != 'cancelled') as nc_amount
           FROM orders o
           WHERE ${orderSearchCondition}
           GROUP BY o.customer_id
           HAVING SUM(o.due_amount) > 0
         ) od ON od.customer_id = c.id
         WHERE ${customerWhereClause}${dueFilterClause}
         ORDER BY ${sortExpr} ${order}, c.id DESC
         LIMIT ? OFFSET ?`,
        [...orderSearchParams, ...customerParams, safeLimit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) as total
         FROM customers c
         INNER JOIN (
           SELECT o.customer_id, SUM(o.due_amount) as actual_due
           FROM orders o
           WHERE ${orderSearchCondition}
           GROUP BY o.customer_id
           HAVING SUM(o.due_amount) > 0
         ) od ON od.customer_id = c.id
         WHERE ${customerWhereClause}${dueFilterClause}`,
        [...orderSearchParams, ...customerParams]
      ),
      pool.query(
        `SELECT 
           COUNT(DISTINCT c.id) as total_customers_with_due,
           SUM(od.actual_due) as total_due_amount,
           AVG(od.actual_due) as avg_due_amount,
           MAX(od.actual_due) as max_due_amount,
           SUM(od.pending_due_orders) as total_pending_orders
         FROM customers c
         INNER JOIN (
           SELECT o.customer_id, SUM(o.due_amount) as actual_due, COUNT(*) as pending_due_orders
           FROM orders o
           WHERE ${orderSearchCondition}
           GROUP BY o.customer_id
           HAVING SUM(o.due_amount) > 0
         ) od ON od.customer_id = c.id
         WHERE ${customerWhereClause}${dueFilterClause}`,
        [...orderSearchParams, ...customerParams]
      )
    ]);
    const rows = dataResult[0];
    const total = countResult[0][0].total;
    const summary = summaryResult[0][0];

    return {
      customers: rows.map(r => ({
        ...this.formatCustomer(r),
        dueBalance: parseFloat(r.actual_due) || 0,
        totalDueCollected: parseFloat(r.calculated_due_collected) || parseFloat(r.total_due_collected) || 0,
        pendingDueOrders: r.pending_due_orders || 0,
        lastDueDate: r.last_due_date || null,
        firstDueDate: r.first_due_date || null,
        pendingOrderNumbers: r.order_numbers || null,
        ncItemCount: parseInt(r.nc_item_count) || 0,
        ncAmount: parseFloat(r.nc_amount) || 0
      })),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit)
      },
      summary: {
        totalCustomersWithDue: Number(summary?.total_customers_with_due) || 0,
        totalDueAmount: parseFloat(summary?.total_due_amount) || 0,
        avgDueAmount: parseFloat(summary?.avg_due_amount) || 0,
        maxDueAmount: parseFloat(summary?.max_due_amount) || 0,
        totalPendingOrders: Number(summary?.total_pending_orders) || 0
      }
    };
  }
};

module.exports = customerService;
