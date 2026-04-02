/**
 * Discount Report Service
 * Comprehensive discount reporting with pagination, filters, and CSV export
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');

/**
 * Business day starts at this hour (IST). Orders before this hour belong to the previous business day.
 */
const BUSINESS_DAY_START_HOUR = 4;

/**
 * Get local date string (YYYY-MM-DD) for the current business day.
 * If the current time is before BUSINESS_DAY_START_HOUR (e.g. 4 AM),
 * the business day is still "yesterday".
 */
function getLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const shifted = new Date(d.getTime() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Extract the business-day DATE from a timestamp column.
 * Subtracts BUSINESS_DAY_START_HOUR hours so pre-cutoff orders map to previous business day.
 */
function toISTDate(column) {
  return `DATE(DATE_SUB(${column}, INTERVAL ${BUSINESS_DAY_START_HOUR} HOUR))`;
}

/**
 * Convert inclusive business-day date range to index-friendly datetime bounds.
 */
function businessDayRange(startDate, endDate) {
  const h = String(BUSINESS_DAY_START_HOUR).padStart(2, '0') + ':00:00';
  const startDt = `${startDate} ${h}`;
  const ed = new Date(endDate + 'T00:00:00');
  ed.setDate(ed.getDate() + 1);
  const endStr = ed.getFullYear() + '-' + String(ed.getMonth() + 1).padStart(2, '0') + '-' + String(ed.getDate()).padStart(2, '0');
  const endDt = `${endStr} ${h}`;
  return { startDt, endDt };
}

/**
 * SQL snippet for index-friendly business-day WHERE condition.
 * Params: [startDt, endDt] from businessDayRange().
 */
function bdWhere(column) {
  return `${column} >= ? AND ${column} < ?`;
}

const discountReportService = {
  /**
   * Parse and validate date range
   */
  _dateRange(startDate, endDate) {
    const start = startDate || getLocalDate();
    const end = endDate || start;
    const { startDt, endDt } = businessDayRange(start, end);
    return { start, end, startDt, endDt };
  },

  /**
   * Get Discount Summary Report
   * Overview of all discounts applied in a date range
   * 
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options - { discountType, discountCode, givenBy, page, limit, sortBy, sortOrder }
   */
  async getDiscountSummary(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end, startDt, endDt } = this._dateRange(startDate, endDate);

    // Summary totals (no pagination)
    const [summaryRows] = await pool.query(
      `SELECT 
        COUNT(DISTINCT od.id) as total_discounts_applied,
        COUNT(DISTINCT od.order_id) as orders_with_discount,
        COUNT(DISTINCT od.discount_code) as unique_codes_used,
        SUM(od.discount_amount) as total_discount_amount,
        AVG(od.discount_amount) as avg_discount_per_application,
        COUNT(CASE WHEN od.discount_type = 'percentage' THEN 1 END) as percentage_discounts,
        COUNT(CASE WHEN od.discount_type = 'flat' THEN 1 END) as flat_discounts,
        COUNT(CASE WHEN od.discount_code IS NOT NULL THEN 1 END) as code_based_discounts,
        COUNT(CASE WHEN od.discount_code IS NULL THEN 1 END) as manual_discounts
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       WHERE o.outlet_id = ? 
         AND ${bdWhere('od.created_at')}
         AND o.status NOT IN ('cancelled')`,
      [outletId, startDt, endDt]
    );

    // Order totals for comparison
    const [orderTotals] = await pool.query(
      `SELECT 
        COUNT(*) as total_orders,
        SUM(subtotal) as total_subtotal,
        SUM(total_amount) as total_revenue,
        SUM(discount_amount) as total_order_discount
       FROM orders 
       WHERE outlet_id = ? 
         AND ${bdWhere('created_at')}
         AND status NOT IN ('cancelled')`,
      [outletId, startDt, endDt]
    );

    // Top discount codes
    const [topCodes] = await pool.query(
      `SELECT 
        od.discount_code,
        od.discount_name,
        COUNT(*) as times_used,
        SUM(od.discount_amount) as total_amount,
        AVG(od.discount_amount) as avg_amount
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       WHERE o.outlet_id = ? 
         AND ${bdWhere('od.created_at')}
         AND o.status NOT IN ('cancelled')
         AND od.discount_code IS NOT NULL
       GROUP BY od.discount_code, od.discount_name
       ORDER BY total_amount DESC
       LIMIT 10`,
      [outletId, startDt, endDt]
    );

    // Top staff giving discounts
    const [topStaff] = await pool.query(
      `SELECT 
        od.created_by as user_id,
        u.name as user_name,
        COUNT(*) as discounts_given,
        SUM(od.discount_amount) as total_amount,
        AVG(od.discount_amount) as avg_amount
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       LEFT JOIN users u ON od.created_by = u.id
       WHERE o.outlet_id = ? 
         AND ${bdWhere('od.created_at')}
         AND o.status NOT IN ('cancelled')
       GROUP BY od.created_by, u.name
       ORDER BY total_amount DESC
       LIMIT 10`,
      [outletId, startDt, endDt]
    );

    // Daily breakdown
    const [dailyBreakdown] = await pool.query(
      `SELECT 
        ${toISTDate('od.created_at')} as date,
        COUNT(*) as discount_count,
        SUM(od.discount_amount) as total_amount,
        COUNT(DISTINCT od.order_id) as orders_count
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       WHERE o.outlet_id = ? 
         AND ${bdWhere('od.created_at')}
         AND o.status NOT IN ('cancelled')
       GROUP BY ${toISTDate('od.created_at')}
       ORDER BY date DESC`,
      [outletId, startDt, endDt]
    );

    const summary = summaryRows[0];
    const orders = orderTotals[0];

    return {
      dateRange: { start, end },
      summary: {
        totalDiscountsApplied: parseInt(summary.total_discounts_applied) || 0,
        ordersWithDiscount: parseInt(summary.orders_with_discount) || 0,
        uniqueCodesUsed: parseInt(summary.unique_codes_used) || 0,
        totalDiscountAmount: parseFloat(summary.total_discount_amount) || 0,
        avgDiscountPerApplication: parseFloat(summary.avg_discount_per_application) || 0,
        percentageDiscounts: parseInt(summary.percentage_discounts) || 0,
        flatDiscounts: parseInt(summary.flat_discounts) || 0,
        codeBasedDiscounts: parseInt(summary.code_based_discounts) || 0,
        manualDiscounts: parseInt(summary.manual_discounts) || 0
      },
      orderContext: {
        totalOrders: parseInt(orders.total_orders) || 0,
        totalSubtotal: parseFloat(orders.total_subtotal) || 0,
        totalRevenue: parseFloat(orders.total_revenue) || 0,
        totalOrderDiscount: parseFloat(orders.total_order_discount) || 0,
        discountPercentage: orders.total_subtotal > 0 
          ? parseFloat(((orders.total_order_discount / orders.total_subtotal) * 100).toFixed(2))
          : 0,
        ordersWithDiscountPercentage: orders.total_orders > 0
          ? parseFloat(((summary.orders_with_discount / orders.total_orders) * 100).toFixed(2))
          : 0
      },
      topDiscountCodes: topCodes.map(c => ({
        code: c.discount_code,
        name: c.discount_name,
        timesUsed: parseInt(c.times_used),
        totalAmount: parseFloat(c.total_amount),
        avgAmount: parseFloat(c.avg_amount)
      })),
      topStaffGivingDiscounts: topStaff.map(s => ({
        userId: s.user_id,
        userName: s.user_name || 'Unknown',
        discountsGiven: parseInt(s.discounts_given),
        totalAmount: parseFloat(s.total_amount),
        avgAmount: parseFloat(s.avg_amount)
      })),
      dailyBreakdown: dailyBreakdown.map(d => ({
        date: d.date,
        discountCount: parseInt(d.discount_count),
        totalAmount: parseFloat(d.total_amount),
        ordersCount: parseInt(d.orders_count)
      }))
    };
  },

  /**
   * Get Discount Detail Report
   * Detailed list of all discounts with order info, pagination, filters
   * 
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options
   */
  async getDiscountDetails(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end, startDt, endDt } = this._dateRange(startDate, endDate);

    // Parse options
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (options.search || '').trim();
    const discountType = (options.discountType || '').trim();
    const discountCode = (options.discountCode || '').trim();
    const givenBy = options.givenBy ? parseInt(options.givenBy) : null;
    const approvedBy = options.approvedBy ? parseInt(options.approvedBy) : null;
    const sortBy = options.sortBy || 'created_at';
    const sortOrder = (options.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Build WHERE conditions
    const conditions = [
      'o.outlet_id = ?',
      `${bdWhere('od.created_at')}`,
      "o.status NOT IN ('cancelled')"
    ];
    const params = [outletId, startDt, endDt];

    if (search) {
      conditions.push(`(
        od.discount_code LIKE ? OR 
        od.discount_name LIKE ? OR 
        o.order_number LIKE ? OR
        uc.name LIKE ?
      )`);
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    if (discountType) {
      conditions.push('od.discount_type = ?');
      params.push(discountType);
    }

    if (discountCode) {
      conditions.push('od.discount_code = ?');
      params.push(discountCode);
    }

    if (givenBy) {
      conditions.push('od.created_by = ?');
      params.push(givenBy);
    }

    if (approvedBy) {
      conditions.push('od.approved_by = ?');
      params.push(approvedBy);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // Get total count and summary in one query
    const [summaryResult] = await pool.query(
      `SELECT 
        COUNT(*) as total_count,
        COUNT(DISTINCT od.order_id) as orders_with_discount,
        SUM(od.discount_amount) as total_discount_amount,
        AVG(od.discount_amount) as avg_discount_amount,
        MIN(od.discount_amount) as min_discount_amount,
        MAX(od.discount_amount) as max_discount_amount,
        COUNT(CASE WHEN od.discount_type = 'percentage' THEN 1 END) as percentage_discounts,
        COUNT(CASE WHEN od.discount_type = 'flat' THEN 1 END) as flat_discounts,
        COUNT(CASE WHEN od.discount_code IS NOT NULL THEN 1 END) as code_based_discounts,
        COUNT(CASE WHEN od.discount_code IS NULL THEN 1 END) as manual_discounts
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       LEFT JOIN users uc ON od.created_by = uc.id
       ${whereClause}`,
      params
    );
    
    const summaryRow = summaryResult[0];
    const totalCount = parseInt(summaryRow.total_count) || 0;
    const totalPages = Math.ceil(totalCount / limit);

    const summary = {
      totalDiscountsApplied: totalCount,
      ordersWithDiscount: parseInt(summaryRow.orders_with_discount) || 0,
      totalDiscountAmount: parseFloat(summaryRow.total_discount_amount) || 0,
      avgDiscountAmount: parseFloat(summaryRow.avg_discount_amount) || 0,
      minDiscountAmount: parseFloat(summaryRow.min_discount_amount) || 0,
      maxDiscountAmount: parseFloat(summaryRow.max_discount_amount) || 0,
      percentageDiscounts: parseInt(summaryRow.percentage_discounts) || 0,
      flatDiscounts: parseInt(summaryRow.flat_discounts) || 0,
      codeBasedDiscounts: parseInt(summaryRow.code_based_discounts) || 0,
      manualDiscounts: parseInt(summaryRow.manual_discounts) || 0
    };

    if (totalCount === 0) {
      return {
        dateRange: { start, end },
        summary,
        discounts: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false },
        filters: { discountType, discountCode, givenBy, approvedBy, search }
      };
    }

    // Validate sort column
    const validSortColumns = {
      'created_at': 'od.created_at',
      'discount_amount': 'od.discount_amount',
      'discount_value': 'od.discount_value',
      'order_number': 'o.order_number',
      'discount_name': 'od.discount_name',
      'discount_code': 'od.discount_code'
    };
    const sortColumn = validSortColumns[sortBy] || 'od.created_at';

    // Get discount details with pagination
    const [discounts] = await pool.query(
      `SELECT 
        od.id as discount_record_id,
        od.order_id,
        o.order_number,
        o.order_type,
        o.subtotal as order_subtotal,
        o.total_amount as order_total,
        o.status as order_status,
        o.created_at as order_created_at,
        od.discount_id,
        od.discount_code,
        od.discount_name,
        od.discount_type,
        od.discount_value,
        od.discount_amount,
        od.applied_on,
        od.order_item_id,
        oi.item_name as applied_item_name,
        od.created_by,
        uc.name as created_by_name,
        od.approved_by,
        ua.name as approved_by_name,
        od.approval_reason,
        od.created_at,
        t.name as table_name,
        f.name as floor_name,
        c.name as customer_name,
        c.phone as customer_phone
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       LEFT JOIN order_items oi ON od.order_item_id = oi.id
       LEFT JOIN users uc ON od.created_by = uc.id
       LEFT JOIN users ua ON od.approved_by = ua.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN customers c ON o.customer_id = c.id
       ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      dateRange: { start, end },
      summary,
      discounts: discounts.map(d => ({
        discountRecordId: d.discount_record_id,
        orderId: d.order_id,
        orderNumber: d.order_number,
        orderType: d.order_type,
        orderSubtotal: parseFloat(d.order_subtotal) || 0,
        orderTotal: parseFloat(d.order_total) || 0,
        orderStatus: d.order_status,
        orderCreatedAt: d.order_created_at,
        discountId: d.discount_id,
        discountCode: d.discount_code,
        discountName: d.discount_name,
        discountType: d.discount_type,
        discountValue: parseFloat(d.discount_value) || 0,
        discountAmount: parseFloat(d.discount_amount) || 0,
        appliedOn: d.applied_on,
        appliedItemId: d.order_item_id,
        appliedItemName: d.applied_item_name,
        createdBy: d.created_by,
        createdByName: d.created_by_name || 'Unknown',
        approvedBy: d.approved_by,
        approvedByName: d.approved_by_name,
        approvalReason: d.approval_reason,
        createdAt: d.created_at,
        tableName: d.table_name,
        floorName: d.floor_name,
        customerName: d.customer_name,
        customerPhone: d.customer_phone
      })),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: { discountType, discountCode, givenBy, approvedBy, search }
    };
  },

  /**
   * Get Discount Code Performance Report
   * Analysis of each discount code's usage and effectiveness
   */
  async getDiscountCodeReport(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end, startDt, endDt } = this._dateRange(startDate, endDate);

    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (options.search || '').trim();
    const sortBy = options.sortBy || 'total_amount';
    const sortOrder = (options.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Build WHERE conditions
    const conditions = [
      'o.outlet_id = ?',
      `${bdWhere('od.created_at')}`,
      "o.status NOT IN ('cancelled')",
      'od.discount_code IS NOT NULL'
    ];
    const params = [outletId, startDt, endDt];

    if (search) {
      conditions.push('(od.discount_code LIKE ? OR od.discount_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // Get total count of unique codes
    const [countResult] = await pool.query(
      `SELECT COUNT(DISTINCT od.discount_code) as total
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult[0].total) || 0;
    const totalPages = Math.ceil(totalCount / limit);

    if (totalCount === 0) {
      return {
        dateRange: { start, end },
        codes: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false }
      };
    }

    // Validate sort column
    const validSortColumns = {
      'total_amount': 'total_amount',
      'times_used': 'times_used',
      'avg_amount': 'avg_amount',
      'orders_count': 'orders_count',
      'discount_code': 'od.discount_code'
    };
    const sortColumn = validSortColumns[sortBy] || 'total_amount';

    // Get code performance with pagination
    const [codes] = await pool.query(
      `SELECT 
        od.discount_code,
        od.discount_name,
        od.discount_type,
        od.discount_value,
        d.valid_from,
        d.valid_until,
        d.usage_limit,
        d.usage_count as master_usage_count,
        d.min_order_amount,
        d.max_discount_amount,
        COUNT(*) as times_used,
        COUNT(DISTINCT od.order_id) as orders_count,
        SUM(od.discount_amount) as total_amount,
        AVG(od.discount_amount) as avg_amount,
        MIN(od.discount_amount) as min_amount,
        MAX(od.discount_amount) as max_amount,
        SUM(o.subtotal) as total_order_subtotal,
        SUM(o.total_amount) as total_order_revenue,
        MIN(od.created_at) as first_used,
        MAX(od.created_at) as last_used
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       LEFT JOIN discounts d ON od.discount_id = d.id
       ${whereClause}
       GROUP BY od.discount_code, od.discount_name, od.discount_type, od.discount_value,
                d.valid_from, d.valid_until, d.usage_limit, d.usage_count, 
                d.min_order_amount, d.max_discount_amount
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      dateRange: { start, end },
      codes: codes.map(c => ({
        discountCode: c.discount_code,
        discountName: c.discount_name,
        discountType: c.discount_type,
        discountValue: parseFloat(c.discount_value) || 0,
        validFrom: c.valid_from,
        validUntil: c.valid_until,
        usageLimit: c.usage_limit,
        masterUsageCount: c.master_usage_count,
        minOrderAmount: parseFloat(c.min_order_amount) || 0,
        maxDiscountAmount: parseFloat(c.max_discount_amount) || 0,
        timesUsed: parseInt(c.times_used),
        ordersCount: parseInt(c.orders_count),
        totalAmount: parseFloat(c.total_amount) || 0,
        avgAmount: parseFloat(c.avg_amount) || 0,
        minAmount: parseFloat(c.min_amount) || 0,
        maxAmount: parseFloat(c.max_amount) || 0,
        totalOrderSubtotal: parseFloat(c.total_order_subtotal) || 0,
        totalOrderRevenue: parseFloat(c.total_order_revenue) || 0,
        discountPercentageOfSubtotal: c.total_order_subtotal > 0
          ? parseFloat(((c.total_amount / c.total_order_subtotal) * 100).toFixed(2))
          : 0,
        firstUsed: c.first_used,
        lastUsed: c.last_used
      })),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    };
  },

  /**
   * Get Staff Discount Report
   * Analysis of discounts given by each staff member
   */
  async getStaffDiscountReport(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end, startDt, endDt } = this._dateRange(startDate, endDate);

    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (options.search || '').trim();
    const sortBy = options.sortBy || 'total_amount';
    const sortOrder = (options.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Build WHERE conditions
    const conditions = [
      'o.outlet_id = ?',
      `${bdWhere('od.created_at')}`,
      "o.status NOT IN ('cancelled')"
    ];
    const params = [outletId, startDt, endDt];

    if (search) {
      conditions.push('u.name LIKE ?');
      params.push(`%${search}%`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // Get total count of unique staff
    const [countResult] = await pool.query(
      `SELECT COUNT(DISTINCT od.created_by) as total
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       LEFT JOIN users u ON od.created_by = u.id
       ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult[0].total) || 0;
    const totalPages = Math.ceil(totalCount / limit);

    if (totalCount === 0) {
      return {
        dateRange: { start, end },
        staff: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false }
      };
    }

    // Validate sort column
    const validSortColumns = {
      'total_amount': 'total_amount',
      'discounts_given': 'discounts_given',
      'avg_amount': 'avg_amount',
      'orders_count': 'orders_count',
      'user_name': 'u.name'
    };
    const sortColumn = validSortColumns[sortBy] || 'total_amount';

    // Get staff discount performance
    const [staff] = await pool.query(
      `SELECT 
        od.created_by as user_id,
        u.name as user_name,
        u.email as user_email,
        COUNT(*) as discounts_given,
        COUNT(DISTINCT od.order_id) as orders_count,
        SUM(od.discount_amount) as total_amount,
        AVG(od.discount_amount) as avg_amount,
        MIN(od.discount_amount) as min_amount,
        MAX(od.discount_amount) as max_amount,
        COUNT(CASE WHEN od.discount_type = 'percentage' THEN 1 END) as percentage_discounts,
        COUNT(CASE WHEN od.discount_type = 'flat' THEN 1 END) as flat_discounts,
        COUNT(CASE WHEN od.discount_code IS NOT NULL THEN 1 END) as code_based,
        COUNT(CASE WHEN od.discount_code IS NULL THEN 1 END) as manual,
        MIN(od.created_at) as first_discount,
        MAX(od.created_at) as last_discount
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       LEFT JOIN users u ON od.created_by = u.id
       ${whereClause}
       GROUP BY od.created_by, u.name, u.email
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      dateRange: { start, end },
      staff: staff.map(s => ({
        userId: s.user_id,
        userName: s.user_name || 'Unknown',
        userEmail: s.user_email,
        discountsGiven: parseInt(s.discounts_given),
        ordersCount: parseInt(s.orders_count),
        totalAmount: parseFloat(s.total_amount) || 0,
        avgAmount: parseFloat(s.avg_amount) || 0,
        minAmount: parseFloat(s.min_amount) || 0,
        maxAmount: parseFloat(s.max_amount) || 0,
        percentageDiscounts: parseInt(s.percentage_discounts),
        flatDiscounts: parseInt(s.flat_discounts),
        codeBased: parseInt(s.code_based),
        manual: parseInt(s.manual),
        firstDiscount: s.first_discount,
        lastDiscount: s.last_discount
      })),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    };
  },

  /**
   * Export Discount Report to CSV format
   * Returns data formatted for CSV export
   */
  async exportDiscountReport(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end, startDt, endDt } = this._dateRange(startDate, endDate);

    const reportType = options.reportType || 'details';
    const discountType = (options.discountType || '').trim();
    const discountCode = (options.discountCode || '').trim();
    const givenBy = options.givenBy ? parseInt(options.givenBy) : null;

    // Build WHERE conditions
    const conditions = [
      'o.outlet_id = ?',
      `${bdWhere('od.created_at')}`,
      "o.status NOT IN ('cancelled')"
    ];
    const params = [outletId, startDt, endDt];

    if (discountType) {
      conditions.push('od.discount_type = ?');
      params.push(discountType);
    }

    if (discountCode) {
      conditions.push('od.discount_code = ?');
      params.push(discountCode);
    }

    if (givenBy) {
      conditions.push('od.created_by = ?');
      params.push(givenBy);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    if (reportType === 'summary') {
      // Export code summary
      const [rows] = await pool.query(
        `SELECT 
          od.discount_code as 'Discount Code',
          od.discount_name as 'Discount Name',
          od.discount_type as 'Type',
          od.discount_value as 'Value',
          COUNT(*) as 'Times Used',
          COUNT(DISTINCT od.order_id) as 'Orders Count',
          SUM(od.discount_amount) as 'Total Discount Amount',
          AVG(od.discount_amount) as 'Avg Discount Amount',
          SUM(o.subtotal) as 'Total Order Subtotal',
          SUM(o.total_amount) as 'Total Order Revenue'
         FROM order_discounts od
         INNER JOIN orders o ON od.order_id = o.id
         ${whereClause}
         GROUP BY od.discount_code, od.discount_name, od.discount_type, od.discount_value
         ORDER BY SUM(od.discount_amount) DESC`,
        params
      );
      return { rows, filename: `discount_summary_${start}_to_${end}.csv` };
    }

    if (reportType === 'staff') {
      // Export staff summary
      const [rows] = await pool.query(
        `SELECT 
          u.name as 'Staff Name',
          u.email as 'Email',
          COUNT(*) as 'Discounts Given',
          COUNT(DISTINCT od.order_id) as 'Orders Count',
          SUM(od.discount_amount) as 'Total Discount Amount',
          AVG(od.discount_amount) as 'Avg Discount Amount',
          COUNT(CASE WHEN od.discount_code IS NOT NULL THEN 1 END) as 'Code Based',
          COUNT(CASE WHEN od.discount_code IS NULL THEN 1 END) as 'Manual'
         FROM order_discounts od
         INNER JOIN orders o ON od.order_id = o.id
         LEFT JOIN users u ON od.created_by = u.id
         ${whereClause}
         GROUP BY od.created_by, u.name, u.email
         ORDER BY SUM(od.discount_amount) DESC`,
        params
      );
      return { rows, filename: `discount_by_staff_${start}_to_${end}.csv` };
    }

    // Default: Export detailed records
    const [rows] = await pool.query(
      `SELECT 
        ${toISTDate('od.created_at')} as 'Date',
        DATE_FORMAT(od.created_at, '%H:%i:%s') as 'Time',
        o.order_number as 'Order Number',
        o.order_type as 'Order Type',
        t.name as 'Table',
        f.name as 'Floor',
        c.name as 'Customer Name',
        c.phone as 'Customer Phone',
        od.discount_code as 'Discount Code',
        od.discount_name as 'Discount Name',
        od.discount_type as 'Discount Type',
        od.discount_value as 'Discount Value',
        od.discount_amount as 'Discount Amount',
        od.applied_on as 'Applied On',
        oi.item_name as 'Applied Item',
        o.subtotal as 'Order Subtotal',
        o.total_amount as 'Order Total',
        uc.name as 'Given By',
        ua.name as 'Approved By',
        od.approval_reason as 'Approval Reason'
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       LEFT JOIN order_items oi ON od.order_item_id = oi.id
       LEFT JOIN users uc ON od.created_by = uc.id
       LEFT JOIN users ua ON od.approved_by = ua.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN customers c ON o.customer_id = c.id
       ${whereClause}
       ORDER BY od.created_at DESC`,
      params
    );

    return { rows, filename: `discount_details_${start}_to_${end}.csv` };
  },

  /**
   * Get available discount codes for filter dropdown
   */
  async getDiscountCodesForFilter(outletId) {
    const pool = getPool();
    
    const [codes] = await pool.query(
      `SELECT DISTINCT 
        od.discount_code,
        od.discount_name
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       WHERE o.outlet_id = ? AND od.discount_code IS NOT NULL
       ORDER BY od.discount_code`,
      [outletId]
    );

    return codes.map(c => ({
      code: c.discount_code,
      name: c.discount_name
    }));
  },

  /**
   * Get staff list for filter dropdown
   */
  async getStaffForFilter(outletId) {
    const pool = getPool();
    
    const [staff] = await pool.query(
      `SELECT DISTINCT 
        od.created_by as user_id,
        u.name as user_name
       FROM order_discounts od
       INNER JOIN orders o ON od.order_id = o.id
       LEFT JOIN users u ON od.created_by = u.id
       WHERE o.outlet_id = ?
       ORDER BY u.name`,
      [outletId]
    );

    return staff.map(s => ({
      userId: s.user_id,
      userName: s.user_name || 'Unknown'
    }));
  }
};

module.exports = discountReportService;
