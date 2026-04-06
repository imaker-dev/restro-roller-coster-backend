/**
 * Adjustment Report Service
 * Listing, detail, and export for payment adjustments.
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');

const BUSINESS_DAY_START_HOUR = 4;

function businessDayRange(startDate, endDate) {
  const h = String(BUSINESS_DAY_START_HOUR).padStart(2, '0') + ':00:00';
  const startDt = `${startDate} ${h}`;
  const ed = new Date(endDate + 'T00:00:00');
  ed.setDate(ed.getDate() + 1);
  const endStr = ed.getFullYear() + '-' + String(ed.getMonth() + 1).padStart(2, '0') + '-' + String(ed.getDate()).padStart(2, '0');
  const endDt = `${endStr} ${h}`;
  return { startDt, endDt };
}

function bdWhere(column) {
  return `${column} >= ? AND ${column} < ?`;
}

function getLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const shifted = new Date(d.getTime() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}-${String(shifted.getDate()).padStart(2, '0')}`;
}

const adjustmentReportService = {

  /**
   * List adjustments with filters, pagination, and summary
   * GET /reports/adjustments/:outletId
   */
  async getAdjustments(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const start = startDate || getLocalDate();
    const end = endDate || start;
    const { startDt, endDt } = businessDayRange(start, end);
    const { staffId, page = 1, limit = 50, sortBy = 'created_at', sortOrder = 'DESC' } = options;

    let conditions = ['pa.outlet_id = ?', `${bdWhere('pa.created_at')}`];
    let params = [outletId, startDt, endDt];

    if (staffId) {
      conditions.push('pa.adjusted_by = ?');
      params.push(staffId);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // Count
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM payment_adjustments pa ${whereClause}`,
      params
    );
    const total = countResult[0].total;

    // Valid sort columns
    const validSorts = ['created_at', 'adjustment_amount', 'total_amount', 'paid_amount'];
    const orderCol = validSorts.includes(sortBy) ? `pa.${sortBy}` : 'pa.created_at';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));

    // Rows
    const [rows] = await pool.query(
      `SELECT 
        pa.id, pa.outlet_id, pa.order_id, pa.invoice_id, pa.payment_id,
        pa.order_number, pa.total_amount, pa.paid_amount, pa.adjustment_amount,
        pa.reason, pa.adjusted_by, pa.created_at,
        u.name as adjusted_by_name,
        o.order_type, o.table_id, o.customer_name, o.customer_phone,
        t.table_number, f.name as floor_name
       FROM payment_adjustments pa
       JOIN users u ON pa.adjusted_by = u.id
       JOIN orders o ON pa.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       ${whereClause}
       ORDER BY ${orderCol} ${order}
       LIMIT ? OFFSET ?`,
      [...params, Math.min(100, parseInt(limit)), offset]
    );

    // Summary
    const [summaryResult] = await pool.query(
      `SELECT 
        COUNT(*) as adjustment_count,
        COALESCE(SUM(pa.adjustment_amount), 0) as total_adjustment_amount,
        COALESCE(SUM(pa.paid_amount), 0) as total_paid_amount,
        COALESCE(SUM(pa.total_amount), 0) as total_bill_amount
       FROM payment_adjustments pa
       ${whereClause}`,
      params
    );
    const summary = summaryResult[0];

    const items = rows.map(r => ({
      id: r.id,
      outletId: r.outlet_id,
      orderId: r.order_id,
      invoiceId: r.invoice_id,
      paymentId: r.payment_id,
      orderNumber: r.order_number,
      orderType: r.order_type,
      totalAmount: parseFloat(r.total_amount) || 0,
      paidAmount: parseFloat(r.paid_amount) || 0,
      adjustmentAmount: parseFloat(r.adjustment_amount) || 0,
      reason: r.reason || null,
      adjustedBy: r.adjusted_by,
      adjustedByName: r.adjusted_by_name,
      customerName: r.customer_name || null,
      customerPhone: r.customer_phone || null,
      tableNumber: r.table_number || null,
      floorName: r.floor_name || null,
      createdAt: r.created_at
    }));

    return {
      dateRange: { start, end },
      items,
      summary: {
        adjustmentCount: parseInt(summary.adjustment_count) || 0,
        totalAdjustmentAmount: parseFloat(parseFloat(summary.total_adjustment_amount).toFixed(2)),
        totalPaidAmount: parseFloat(parseFloat(summary.total_paid_amount).toFixed(2)),
        totalBillAmount: parseFloat(parseFloat(summary.total_bill_amount).toFixed(2))
      },
      pagination: {
        total,
        page: Math.max(1, parseInt(page)),
        limit: Math.min(100, parseInt(limit)),
        totalPages: Math.ceil(total / Math.min(100, parseInt(limit)))
      }
    };
  },

  /**
   * Get single adjustment detail
   * GET /reports/adjustments/:outletId/:id
   */
  async getAdjustmentById(outletId, id) {
    const pool = getPool();

    const [rows] = await pool.query(
      `SELECT 
        pa.id, pa.outlet_id, pa.order_id, pa.invoice_id, pa.payment_id,
        pa.order_number, pa.total_amount, pa.paid_amount, pa.adjustment_amount,
        pa.reason, pa.adjusted_by, pa.created_at,
        u.name as adjusted_by_name,
        o.order_type, o.status as order_status, o.payment_status,
        o.subtotal, o.discount_amount, o.tax_amount, o.service_charge,
        o.customer_name, o.customer_phone, o.customer_id, o.guest_count,
        o.table_id, o.floor_id,
        t.table_number, f.name as floor_name,
        i.invoice_number, i.grand_total as invoice_total,
        p.payment_mode, p.amount as payment_amount
       FROM payment_adjustments pa
       JOIN users u ON pa.adjusted_by = u.id
       JOIN orders o ON pa.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN invoices i ON pa.invoice_id = i.id
       LEFT JOIN payments p ON pa.payment_id = p.id
       WHERE pa.id = ? AND pa.outlet_id = ?`,
      [id, outletId]
    );

    if (!rows[0]) return null;

    const r = rows[0];
    return {
      id: r.id,
      outletId: r.outlet_id,
      orderId: r.order_id,
      invoiceId: r.invoice_id,
      paymentId: r.payment_id,
      orderNumber: r.order_number,
      invoiceNumber: r.invoice_number || null,
      orderType: r.order_type,
      orderStatus: r.order_status,
      paymentStatus: r.payment_status,
      totalAmount: parseFloat(r.total_amount) || 0,
      paidAmount: parseFloat(r.paid_amount) || 0,
      adjustmentAmount: parseFloat(r.adjustment_amount) || 0,
      reason: r.reason || null,
      adjustedBy: r.adjusted_by,
      adjustedByName: r.adjusted_by_name,
      customerName: r.customer_name || null,
      customerPhone: r.customer_phone || null,
      guestCount: r.guest_count || 0,
      tableNumber: r.table_number || null,
      floorName: r.floor_name || null,
      paymentMode: r.payment_mode || null,
      paymentAmount: parseFloat(r.payment_amount) || 0,
      invoiceTotal: parseFloat(r.invoice_total) || 0,
      orderDetails: {
        subtotal: parseFloat(r.subtotal) || 0,
        discountAmount: parseFloat(r.discount_amount) || 0,
        taxAmount: parseFloat(r.tax_amount) || 0,
        serviceCharge: parseFloat(r.service_charge) || 0
      },
      createdAt: r.created_at
    };
  },

  /**
   * Export adjustments as CSV-ready data
   * GET /reports/adjustments/:outletId/export
   */
  async exportAdjustments(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const start = startDate || getLocalDate();
    const end = endDate || start;
    const { startDt, endDt } = businessDayRange(start, end);
    const { staffId } = options;

    let conditions = ['pa.outlet_id = ?', `${bdWhere('pa.created_at')}`];
    let params = [outletId, startDt, endDt];

    if (staffId) {
      conditions.push('pa.adjusted_by = ?');
      params.push(staffId);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT 
        pa.id, pa.order_number, pa.total_amount, pa.paid_amount, pa.adjustment_amount,
        pa.reason, pa.created_at,
        u.name as adjusted_by_name,
        o.order_type, o.customer_name, o.customer_phone,
        t.table_number, f.name as floor_name,
        i.invoice_number,
        p.payment_mode
       FROM payment_adjustments pa
       JOIN users u ON pa.adjusted_by = u.id
       JOIN orders o ON pa.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN invoices i ON pa.invoice_id = i.id
       LEFT JOIN payments p ON pa.payment_id = p.id
       ${whereClause}
       ORDER BY pa.created_at DESC`,
      params
    );

    // CSV header + rows
    const headers = [
      'ID', 'Date', 'Order Number', 'Invoice Number', 'Order Type',
      'Customer Name', 'Customer Phone', 'Table', 'Floor',
      'Bill Amount', 'Paid Amount', 'Adjustment Amount',
      'Payment Mode', 'Reason', 'Adjusted By'
    ];

    const csvRows = rows.map(r => [
      r.id,
      r.created_at ? new Date(r.created_at).toISOString().slice(0, 19).replace('T', ' ') : '',
      r.order_number || '',
      r.invoice_number || '',
      r.order_type || '',
      r.customer_name || '',
      r.customer_phone || '',
      r.table_number || '',
      r.floor_name || '',
      parseFloat(r.total_amount) || 0,
      parseFloat(r.paid_amount) || 0,
      parseFloat(r.adjustment_amount) || 0,
      r.payment_mode || '',
      (r.reason || '').replace(/,/g, ';'),
      r.adjusted_by_name || ''
    ]);

    // Build CSV string
    const csvContent = [
      headers.join(','),
      ...csvRows.map(row => row.map(v => `"${v}"`).join(','))
    ].join('\n');

    return {
      filename: `adjustments_${outletId}_${start}_to_${end}.csv`,
      contentType: 'text/csv',
      content: csvContent,
      rowCount: rows.length
    };
  }
};

module.exports = adjustmentReportService;
