/**
 * Reports Service
 * Aggregated reports - Staff, Table, Counter, Item, Sales
 * Never read raw orders - always use aggregated tables
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

/**
 * Get local date string (YYYY-MM-DD) accounting for server timezone
 * Uses local time instead of UTC to match MySQL DATE() function behavior
 */
function getLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Build SQL snippet + params for floor restriction.
 * @param {number[]} floorIds - array of allowed floor IDs (empty = no restriction)
 * @param {string} alias - table alias for orders, default 'o'
 * @returns {{ sql: string, params: number[] }}
 */
function floorFilter(floorIds, alias = 'o') {
  if (!floorIds || floorIds.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND ${alias}.floor_id IN (${floorIds.map(() => '?').join(',')})`,
    params: [...floorIds]
  };
}

/**
 * Build SQL snippet + params for service type restriction (restaurant/bar/both).
 * @param {string} serviceType - 'restaurant', 'bar', or null/all for no restriction
 * @param {string} categoryAlias - table alias for categories, default 'c'
 * @returns {{ sql: string, params: string[] }}
 */
function serviceTypeFilter(serviceType, categoryAlias = 'c') {
  if (!serviceType || serviceType === 'all') return { sql: '', params: [] };
  return {
    sql: ` AND (${categoryAlias}.service_type = ? OR ${categoryAlias}.service_type = 'both')`,
    params: [serviceType]
  };
}

/**
 * Extract DATE from a timestamp column for date filtering.
 * MySQL session timezone is already IST — no CONVERT_TZ needed.
 * @param {string} column - the timestamp column (e.g., 'o.created_at')
 * @returns {string} SQL snippet for date extraction
 */
function toISTDate(column) {
  return `DATE(${column})`;
}

const reportsService = {
  // ========================
  // DAILY SALES AGGREGATION
  // ========================

  /**
   * Aggregate daily sales (run at end of day or on-demand)
   */
  async aggregateDailySales(outletId, reportDate = null) {
    const pool = getPool();
    const date = reportDate || getLocalDate();

    // Get order totals
    const [orderStats] = await pool.query(
      `SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN order_type = 'dine_in' THEN 1 END) as dine_in_orders,
        COUNT(CASE WHEN order_type = 'takeaway' THEN 1 END) as takeaway_orders,
        COUNT(CASE WHEN order_type = 'delivery' THEN 1 END) as delivery_orders,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
        SUM(guest_count) as total_guests,
        SUM(subtotal + tax_amount) as gross_sales,
        SUM(subtotal - discount_amount) as net_sales,
        SUM(discount_amount) as discount_amount,
        SUM(tax_amount) as tax_amount,
        SUM(service_charge) as service_charge,
        SUM(packaging_charge) as packaging_charge,
        SUM(delivery_charge) as delivery_charge,
        SUM(round_off) as round_off,
        COUNT(CASE WHEN is_nc = 1 THEN 1 END) as nc_orders,
        SUM(COALESCE(nc_amount, 0)) as nc_amount
       FROM orders 
       WHERE outlet_id = ? AND ${toISTDate('created_at')} = ? AND status != 'cancelled'`,
      [outletId, date]
    );

    // Get payment totals
    const [paymentStats] = await pool.query(
      `SELECT 
        SUM(total_amount) as total_collection,
        SUM(CASE WHEN payment_mode = 'cash' THEN total_amount ELSE 0 END) as cash_collection,
        SUM(CASE WHEN payment_mode = 'card' THEN total_amount ELSE 0 END) as card_collection,
        SUM(CASE WHEN payment_mode = 'upi' THEN total_amount ELSE 0 END) as upi_collection,
        SUM(CASE WHEN payment_mode = 'wallet' THEN total_amount ELSE 0 END) as wallet_collection,
        SUM(CASE WHEN payment_mode = 'credit' THEN total_amount ELSE 0 END) as credit_collection,
        SUM(tip_amount) as tip_amount
       FROM payments 
       WHERE outlet_id = ? AND ${toISTDate('created_at')} = ? AND status = 'completed'`,
      [outletId, date]
    );

    // Get complimentary and refunds
    const [extras] = await pool.query(
      `SELECT 
        (SELECT SUM(total_amount) FROM orders WHERE outlet_id = ? AND ${toISTDate('created_at')} = ? AND is_complimentary = 1) as complimentary_amount,
        (SELECT SUM(refund_amount) FROM refunds WHERE outlet_id = ? AND ${toISTDate('created_at')} = ? AND status = 'approved') as refund_amount
      `,
      [outletId, date, outletId, date]
    );

    // Get peak hour
    const [peakHour] = await pool.query(
      `SELECT 
        HOUR(created_at) as hour,
        SUM(total_amount) as sales
       FROM orders 
       WHERE outlet_id = ? AND ${toISTDate('created_at')} = ? AND status IN ('paid', 'completed')
       GROUP BY HOUR(created_at)
       ORDER BY sales DESC
       LIMIT 1`,
      [outletId, date]
    );

    const stats = orderStats[0];
    const payments = paymentStats[0];
    const ext = extras[0];

    const avgOrderValue = stats.total_orders > 0 ? stats.net_sales / stats.total_orders : 0;
    const avgGuestSpend = stats.total_guests > 0 ? stats.net_sales / stats.total_guests : 0;

    // Upsert daily sales
    await pool.query(
      `INSERT INTO daily_sales (
        outlet_id, report_date, total_orders, dine_in_orders, takeaway_orders, delivery_orders,
        cancelled_orders, nc_orders, nc_amount, total_guests, gross_sales, net_sales, discount_amount, tax_amount,
        service_charge, packaging_charge, delivery_charge, round_off,
        total_collection, cash_collection, card_collection, upi_collection, wallet_collection, credit_collection,
        complimentary_amount, refund_amount, tip_amount,
        average_order_value, average_guest_spend,
        peak_hour, peak_hour_sales, aggregated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        total_orders = VALUES(total_orders), dine_in_orders = VALUES(dine_in_orders),
        takeaway_orders = VALUES(takeaway_orders), delivery_orders = VALUES(delivery_orders),
        cancelled_orders = VALUES(cancelled_orders), nc_orders = VALUES(nc_orders), nc_amount = VALUES(nc_amount),
        total_guests = VALUES(total_guests),
        gross_sales = VALUES(gross_sales), net_sales = VALUES(net_sales),
        discount_amount = VALUES(discount_amount), tax_amount = VALUES(tax_amount),
        service_charge = VALUES(service_charge), packaging_charge = VALUES(packaging_charge),
        delivery_charge = VALUES(delivery_charge), round_off = VALUES(round_off),
        total_collection = VALUES(total_collection), cash_collection = VALUES(cash_collection),
        card_collection = VALUES(card_collection), upi_collection = VALUES(upi_collection),
        wallet_collection = VALUES(wallet_collection), credit_collection = VALUES(credit_collection),
        complimentary_amount = VALUES(complimentary_amount), refund_amount = VALUES(refund_amount),
        tip_amount = VALUES(tip_amount), average_order_value = VALUES(average_order_value),
        average_guest_spend = VALUES(average_guest_spend), peak_hour = VALUES(peak_hour),
        peak_hour_sales = VALUES(peak_hour_sales), aggregated_at = NOW()`,
      [
        outletId, date, stats.total_orders || 0, stats.dine_in_orders || 0,
        stats.takeaway_orders || 0, stats.delivery_orders || 0, stats.cancelled_orders || 0,
        stats.nc_orders || 0, stats.nc_amount || 0,
        stats.total_guests || 0, stats.gross_sales || 0, stats.net_sales || 0,
        stats.discount_amount || 0, stats.tax_amount || 0, stats.service_charge || 0,
        stats.packaging_charge || 0, stats.delivery_charge || 0, stats.round_off || 0,
        payments.total_collection || 0, payments.cash_collection || 0, payments.card_collection || 0,
        payments.upi_collection || 0, payments.wallet_collection || 0, payments.credit_collection || 0,
        ext.complimentary_amount || 0, ext.refund_amount || 0, payments.tip_amount || 0,
        avgOrderValue, avgGuestSpend,
        peakHour[0]?.hour ? `${peakHour[0].hour}:00` : null, peakHour[0]?.sales || 0
      ]
    );

    return { success: true, date };
  },

  // ========================
  // ITEM SALES AGGREGATION
  // ========================

  async aggregateItemSales(outletId, reportDate = null) {
    const pool = getPool();
    const date = reportDate || getLocalDate();

    const [items] = await pool.query(
      `SELECT 
        oi.item_id, oi.variant_id, oi.item_name, oi.variant_name,
        i.category_id, c.name as category_name,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.quantity ELSE 0 END) as quantity_sold,
        SUM(CASE WHEN oi.status = 'cancelled' THEN oi.quantity ELSE 0 END) as quantity_cancelled,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.total_price ELSE 0 END) as gross_amount,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.discount_amount ELSE 0 END) as discount_amount,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.tax_amount ELSE 0 END) as tax_amount,
        COUNT(DISTINCT oi.order_id) as order_count
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} = ?
       GROUP BY oi.item_id, oi.variant_id, oi.item_name, oi.variant_name, i.category_id, c.name`,
      [outletId, date]
    );

    for (const item of items) {
      const netAmount = item.gross_amount - item.discount_amount;
      const avgPrice = item.quantity_sold > 0 ? netAmount / item.quantity_sold : 0;

      await pool.query(
        `INSERT INTO item_sales (
          outlet_id, report_date, item_id, variant_id, item_name, variant_name,
          category_id, category_name, quantity_sold, quantity_cancelled,
          gross_amount, discount_amount, net_amount, tax_amount,
          order_count, average_price, aggregated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          quantity_sold = VALUES(quantity_sold), quantity_cancelled = VALUES(quantity_cancelled),
          gross_amount = VALUES(gross_amount), discount_amount = VALUES(discount_amount),
          net_amount = VALUES(net_amount), tax_amount = VALUES(tax_amount),
          order_count = VALUES(order_count), average_price = VALUES(average_price), aggregated_at = NOW()`,
        [
          outletId, date, item.item_id, item.variant_id, item.item_name, item.variant_name,
          item.category_id, item.category_name, item.quantity_sold, item.quantity_cancelled,
          item.gross_amount, item.discount_amount, netAmount, item.tax_amount,
          item.order_count, avgPrice
        ]
      );
    }

    return { success: true, itemCount: items.length };
  },

  // ========================
  // STAFF SALES AGGREGATION
  // ========================

  async aggregateStaffSales(outletId, reportDate = null) {
    const pool = getPool();
    const date = reportDate || getLocalDate();

    const [staff] = await pool.query(
      `SELECT 
        o.created_by as user_id, u.name as user_name,
        COUNT(*) as order_count,
        SUM(o.guest_count) as guest_count,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as net_sales,
        SUM(o.discount_amount) as discount_given,
        SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN o.status = 'cancelled' THEN o.total_amount ELSE 0 END) as cancelled_amount,
        COUNT(CASE WHEN o.is_nc = 1 THEN 1 END) as nc_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount
       FROM orders o
       JOIN users u ON o.created_by = u.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} = ?
       GROUP BY o.created_by, u.full_name`,
      [outletId, date]
    );

    // Get tips
    const [tips] = await pool.query(
      `SELECT p.received_by as user_id, SUM(p.tip_amount) as tips
       FROM payments p
       WHERE p.outlet_id = ? AND ${toISTDate('p.created_at')} = ? AND p.status = 'completed'
       GROUP BY p.received_by`,
      [outletId, date]
    );
    const tipMap = {};
    tips.forEach(t => tipMap[t.user_id] = t.tips);

    for (const s of staff) {
      const avgOrderValue = s.order_count > 0 ? s.net_sales / s.order_count : 0;

      await pool.query(
        `INSERT INTO staff_sales (
          outlet_id, report_date, user_id, user_name,
          order_count, guest_count, net_sales, discount_given, tips_received,
          cancelled_orders, cancelled_amount, nc_orders, nc_amount, average_order_value, aggregated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          order_count = VALUES(order_count), guest_count = VALUES(guest_count),
          net_sales = VALUES(net_sales), discount_given = VALUES(discount_given),
          tips_received = VALUES(tips_received), cancelled_orders = VALUES(cancelled_orders),
          cancelled_amount = VALUES(cancelled_amount), nc_orders = VALUES(nc_orders),
          nc_amount = VALUES(nc_amount), average_order_value = VALUES(average_order_value),
          aggregated_at = NOW()`,
        [
          outletId, date, s.user_id, s.user_name,
          s.order_count, s.guest_count, s.net_sales, s.discount_given,
          tipMap[s.user_id] || 0, s.cancelled_orders, s.cancelled_amount,
          s.nc_orders || 0, s.nc_amount || 0, avgOrderValue
        ]
      );
    }

    return { success: true, staffCount: staff.length };
  },

  // ========================
  // REPORTS RETRIEVAL (live data queries)
  // ========================

  /**
   * Helper: default date range (today if not provided)
   * Uses local date to match MySQL DATE() function behavior
   */
  _dateRange(startDate, endDate) {
    const today = getLocalDate();
    return {
      start: startDate || today,
      end: endDate || startDate || today
    };
  },

  /**
   * 8.1 Daily Sales Report — live from orders + payments
   */
  async getDailySalesReport(outletId, startDate, endDate, floorIds = []) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const ff = floorFilter(floorIds);

    const [rows] = await pool.query(
      `SELECT 
        ${toISTDate('o.created_at')} as report_date,
        COUNT(*) as total_orders,
        COUNT(CASE WHEN o.order_type = 'dine_in' THEN 1 END) as dine_in_orders,
        COUNT(CASE WHEN o.order_type = 'takeaway' THEN 1 END) as takeaway_orders,
        COUNT(CASE WHEN o.order_type = 'delivery' THEN 1 END) as delivery_orders,
        COUNT(CASE WHEN o.status = 'cancelled' THEN 1 END) as cancelled_orders,
        COUNT(CASE WHEN o.is_nc = 1 THEN 1 END) as nc_orders,
        SUM(o.guest_count) as total_guests,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal + o.tax_amount) ELSE 0 END) as gross_sales,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as net_sales,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.discount_amount ELSE 0 END) as discount_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.tax_amount ELSE 0 END) as tax_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.service_charge ELSE 0 END) as service_charge,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.packaging_charge ELSE 0 END) as packaging_charge,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.delivery_charge ELSE 0 END) as delivery_charge,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.round_off ELSE 0 END) as round_off,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount
       FROM orders o
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?${ff.sql}
       GROUP BY ${toISTDate('o.created_at')}
       ORDER BY report_date DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Attach payment breakdown per day (regular payments, non-split)
    const [payRows] = await pool.query(
      `SELECT 
        ${toISTDate('p.created_at')} as report_date,
        SUM(p.total_amount) as total_collection,
        SUM(CASE WHEN p.payment_mode = 'cash' THEN p.total_amount ELSE 0 END) as cash_collection,
        SUM(CASE WHEN p.payment_mode = 'card' THEN p.total_amount ELSE 0 END) as card_collection,
        SUM(CASE WHEN p.payment_mode = 'upi' THEN p.total_amount ELSE 0 END) as upi_collection,
        SUM(CASE WHEN p.payment_mode = 'wallet' THEN p.total_amount ELSE 0 END) as wallet_collection,
        SUM(CASE WHEN p.payment_mode = 'credit' THEN p.total_amount ELSE 0 END) as credit_collection,
        SUM(p.tip_amount) as tip_amount
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       WHERE p.outlet_id = ? AND ${toISTDate('p.created_at')} BETWEEN ? AND ? AND p.status = 'completed' AND p.payment_mode != 'split'${ff.sql}
       GROUP BY ${toISTDate('p.created_at')}`,
      [outletId, start, end, ...ff.params]
    );
    
    // Get split payment breakdown per day
    const [splitPayRows] = await pool.query(
      `SELECT 
        ${toISTDate('p.created_at')} as report_date,
        SUM(sp.amount) as total_collection,
        SUM(CASE WHEN sp.payment_mode = 'cash' THEN sp.amount ELSE 0 END) as cash_collection,
        SUM(CASE WHEN sp.payment_mode = 'card' THEN sp.amount ELSE 0 END) as card_collection,
        SUM(CASE WHEN sp.payment_mode = 'upi' THEN sp.amount ELSE 0 END) as upi_collection,
        SUM(CASE WHEN sp.payment_mode = 'wallet' THEN sp.amount ELSE 0 END) as wallet_collection,
        SUM(CASE WHEN sp.payment_mode = 'credit' THEN sp.amount ELSE 0 END) as credit_collection
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id
       WHERE p.outlet_id = ? AND ${toISTDate('p.created_at')} BETWEEN ? AND ? AND p.status = 'completed' AND p.payment_mode = 'split'${ff.sql}
       GROUP BY ${toISTDate('p.created_at')}`,
      [outletId, start, end, ...ff.params]
    );
    const splitPayMap = {};
    splitPayRows.forEach(r => { splitPayMap[r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date] = r; });
    
    const payMap = {};
    payRows.forEach(r => { 
      const dateKey = r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date;
      const splitPay = splitPayMap[dateKey] || {};
      payMap[dateKey] = {
        ...r,
        total_collection: (parseFloat(r.total_collection) || 0) + (parseFloat(splitPay.total_collection) || 0),
        cash_collection: (parseFloat(r.cash_collection) || 0) + (parseFloat(splitPay.cash_collection) || 0),
        card_collection: (parseFloat(r.card_collection) || 0) + (parseFloat(splitPay.card_collection) || 0),
        upi_collection: (parseFloat(r.upi_collection) || 0) + (parseFloat(splitPay.upi_collection) || 0),
        wallet_collection: (parseFloat(r.wallet_collection) || 0) + (parseFloat(splitPay.wallet_collection) || 0),
        credit_collection: (parseFloat(r.credit_collection) || 0) + (parseFloat(splitPay.credit_collection) || 0)
      };
    });
    // Handle days that only have split payments
    splitPayRows.forEach(r => {
      const dateKey = r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date;
      if (!payMap[dateKey]) {
        payMap[dateKey] = {
          total_collection: parseFloat(r.total_collection) || 0,
          cash_collection: parseFloat(r.cash_collection) || 0,
          card_collection: parseFloat(r.card_collection) || 0,
          upi_collection: parseFloat(r.upi_collection) || 0,
          wallet_collection: parseFloat(r.wallet_collection) || 0,
          credit_collection: parseFloat(r.credit_collection) || 0,
          tip_amount: 0
        };
      }
    });

    // Cost/Profit data from order_item_costs grouped by date
    const [costRows] = await pool.query(
      `SELECT ${toISTDate('o.created_at')} as report_date,
        COALESCE(SUM(oic.making_cost), 0) as making_cost,
        COALESCE(SUM(oic.profit), 0) as profit
       FROM order_item_costs oic
       JOIN orders o ON oic.order_id = o.id
       WHERE o.outlet_id = ? AND o.status IN ('paid','completed')
         AND ${toISTDate('o.created_at')} BETWEEN ? AND ?${ff.sql}
       GROUP BY ${toISTDate('o.created_at')}`,
      [outletId, start, end, ...ff.params]
    );
    const costMap = {};
    costRows.forEach(r => {
      const dk = r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date;
      costMap[dk] = { making_cost: parseFloat(r.making_cost) || 0, profit: parseFloat(r.profit) || 0 };
    });

    // Wastage data grouped by date
    const [wastageRows] = await pool.query(
      `SELECT wl.wastage_date as report_date,
        COUNT(*) as wastage_count,
        COALESCE(SUM(wl.total_cost), 0) as wastage_cost
       FROM wastage_logs wl
       WHERE wl.outlet_id = ? AND wl.wastage_date BETWEEN ? AND ?
       GROUP BY wl.wastage_date`,
      [outletId, start, end]
    );
    const wastageMap = {};
    wastageRows.forEach(r => {
      const dk = r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date;
      wastageMap[dk] = { wastage_count: parseInt(r.wastage_count) || 0, wastage_cost: parseFloat(r.wastage_cost) || 0 };
    });

    const daily = rows.map(r => {
      const dateKey = r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date;
      const pay = payMap[dateKey] || {};
      const cost = costMap[dateKey] || { making_cost: 0, profit: 0 };
      const wst = wastageMap[dateKey] || { wastage_count: 0, wastage_cost: 0 };
      const avgOrderValue = r.total_orders > 0 ? (parseFloat(r.net_sales) / r.total_orders).toFixed(2) : '0.00';
      const avgGuestSpend = r.total_guests > 0 ? (parseFloat(r.net_sales) / r.total_guests).toFixed(2) : '0.00';
      const netSalesVal = parseFloat(r.net_sales) || 0;
      const foodCostPct = netSalesVal > 0 ? parseFloat(((cost.making_cost / netSalesVal) * 100).toFixed(2)) : 0;
      return {
        ...r,
        total_collection: pay.total_collection || 0,
        cash_collection: pay.cash_collection || 0,
        card_collection: pay.card_collection || 0,
        upi_collection: pay.upi_collection || 0,
        wallet_collection: pay.wallet_collection || 0,
        credit_collection: pay.credit_collection || 0,
        tip_amount: pay.tip_amount || 0,
        making_cost: cost.making_cost,
        profit: cost.profit,
        food_cost_percentage: foodCostPct,
        wastage_count: wst.wastage_count,
        wastage_cost: wst.wastage_cost,
        average_order_value: avgOrderValue,
        average_guest_spend: avgGuestSpend
      };
    });

    // Calculate summary totals across all days - use merged daily data for collections
    const totalOrders = rows.reduce((s, r) => s + (r.total_orders || 0), 0);
    const totalGuests = rows.reduce((s, r) => s + parseInt(r.total_guests || 0), 0);
    const grossSales = rows.reduce((s, r) => s + parseFloat(r.gross_sales || 0), 0);
    const netSales = rows.reduce((s, r) => s + parseFloat(r.net_sales || 0), 0);
    const totalDiscount = rows.reduce((s, r) => s + parseFloat(r.discount_amount || 0), 0);
    const totalTax = rows.reduce((s, r) => s + parseFloat(r.tax_amount || 0), 0);
    const totalServiceCharge = rows.reduce((s, r) => s + parseFloat(r.service_charge || 0), 0);
    // Use daily (merged with split payments) instead of raw payRows
    const totalCollection = daily.reduce((s, r) => s + parseFloat(r.total_collection || 0), 0);
    const cashCollection = daily.reduce((s, r) => s + parseFloat(r.cash_collection || 0), 0);
    const cardCollection = daily.reduce((s, r) => s + parseFloat(r.card_collection || 0), 0);
    const upiCollection = daily.reduce((s, r) => s + parseFloat(r.upi_collection || 0), 0);
    const walletCollection = daily.reduce((s, r) => s + parseFloat(r.wallet_collection || 0), 0);
    const creditCollection = daily.reduce((s, r) => s + parseFloat(r.credit_collection || 0), 0);
    const totalTips = daily.reduce((s, r) => s + parseFloat(r.tip_amount || 0), 0);

    // Calculate NC totals
    const totalNCOrders = rows.reduce((s, r) => s + (r.nc_orders || 0), 0);
    const totalNCAmount = rows.reduce((s, r) => s + parseFloat(r.nc_amount || 0), 0);
    const totalDueAmount = rows.reduce((s, r) => s + parseFloat(r.due_amount || 0), 0);
    const totalPaidAmount = rows.reduce((s, r) => s + parseFloat(r.paid_amount || 0), 0);

    return {
      dateRange: { start, end },
      daily,
      summary: {
        total_days: daily.length,
        total_orders: totalOrders,
        dine_in_orders: rows.reduce((s, r) => s + (r.dine_in_orders || 0), 0),
        takeaway_orders: rows.reduce((s, r) => s + (r.takeaway_orders || 0), 0),
        delivery_orders: rows.reduce((s, r) => s + (r.delivery_orders || 0), 0),
        cancelled_orders: rows.reduce((s, r) => s + (r.cancelled_orders || 0), 0),
        nc_orders: totalNCOrders,
        nc_amount: totalNCAmount.toFixed(2),
        due_amount: totalDueAmount.toFixed(2),
        paid_amount: totalPaidAmount.toFixed(2),
        total_guests: totalGuests,
        gross_sales: grossSales.toFixed(2),
        net_sales: netSales.toFixed(2),
        discount_amount: totalDiscount.toFixed(2),
        tax_amount: totalTax.toFixed(2),
        service_charge: totalServiceCharge.toFixed(2),
        total_collection: totalCollection.toFixed(2),
        cash_collection: cashCollection.toFixed(2),
        card_collection: cardCollection.toFixed(2),
        upi_collection: upiCollection.toFixed(2),
        wallet_collection: walletCollection.toFixed(2),
        credit_collection: creditCollection.toFixed(2),
        tip_amount: totalTips.toFixed(2),
        making_cost: daily.reduce((s, r) => s + (r.making_cost || 0), 0).toFixed(2),
        profit: daily.reduce((s, r) => s + (r.profit || 0), 0).toFixed(2),
        food_cost_percentage: netSales > 0 ? ((daily.reduce((s, r) => s + (r.making_cost || 0), 0) / netSales) * 100).toFixed(2) : '0.00',
        wastage_count: daily.reduce((s, r) => s + (r.wastage_count || 0), 0),
        wastage_cost: daily.reduce((s, r) => s + (r.wastage_cost || 0), 0).toFixed(2),
        average_order_value: totalOrders > 0 ? (netSales / totalOrders).toFixed(2) : '0.00',
        average_guest_spend: totalGuests > 0 ? (netSales / totalGuests).toFixed(2) : '0.00',
        average_daily_sales: daily.length > 0 ? (netSales / daily.length).toFixed(2) : '0.00'
      }
    };
  },

  /**
   * 8.2 Item Sales Report — live from order_items + orders
   * @param {string} serviceType - 'restaurant', 'bar', or null/all for no restriction
   */
  async getItemSalesReport(outletId, startDate, endDate, limit = 50, floorIds = [], serviceType = null) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const ff = floorFilter(floorIds);
    const stf = serviceTypeFilter(serviceType);

    // Get item counts from order_items (for total_items count)
    const [itemCountResult] = await pool.query(
      `SELECT 
        COUNT(DISTINCT CONCAT(oi.item_id, '-', COALESCE(oi.variant_name, ''))) as total_items,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.quantity ELSE 0 END) as total_quantity,
        SUM(CASE WHEN oi.status = 'cancelled' THEN oi.quantity ELSE 0 END) as cancelled_quantity,
        SUM(CASE WHEN oi.status != 'cancelled' AND oi.is_nc = 1 THEN oi.quantity ELSE 0 END) as nc_quantity,
        SUM(CASE WHEN oi.status != 'cancelled' AND oi.is_nc = 1 THEN oi.total_price ELSE 0 END) as nc_amount
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?${ff.sql}${stf.sql}`,
      [outletId, start, end, ...ff.params, ...stf.params]
    );
    const itemCount = itemCountResult[0];

    // Get financial summary from ORDERS table for consistency with daily sales report
    // Gross = subtotal + tax, Net = subtotal - discount
    const [orderSummary] = await pool.query(
      `SELECT 
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal + o.tax_amount) ELSE 0 END) as gross_revenue,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.discount_amount ELSE 0 END) as discount_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.tax_amount ELSE 0 END) as tax_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as net_revenue,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount
       FROM orders o
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.status != 'cancelled'${ff.sql}`,
      [outletId, start, end, ...ff.params]
    );
    const summary = { ...itemCount, ...orderSummary[0] };

    // Then get item details with LIMIT for display
    const [rows] = await pool.query(
      `SELECT 
        oi.item_id, oi.item_name, oi.variant_name,
        c.name as category_name, i.category_id,
        c.service_type as category_service_type,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.quantity ELSE 0 END) as total_quantity,
        SUM(CASE WHEN oi.status = 'cancelled' THEN oi.quantity ELSE 0 END) as cancelled_quantity,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.total_price ELSE 0 END) as gross_revenue,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.discount_amount ELSE 0 END) as discount_amount,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.tax_amount ELSE 0 END) as tax_amount,
        SUM(CASE WHEN oi.status != 'cancelled' THEN (oi.total_price - oi.discount_amount) ELSE 0 END) as net_revenue,
        COUNT(DISTINCT oi.order_id) as order_count,
        AVG(CASE WHEN oi.status != 'cancelled' THEN oi.unit_price ELSE NULL END) as avg_price,
        SUM(CASE WHEN oi.status != 'cancelled' AND oi.is_nc = 1 THEN oi.quantity ELSE 0 END) as nc_quantity,
        SUM(CASE WHEN oi.status != 'cancelled' AND oi.is_nc = 1 THEN oi.total_price ELSE 0 END) as nc_amount,
        COALESCE(SUM(oic.making_cost), 0) as making_cost,
        COALESCE(SUM(oic.profit), 0) as item_profit,
        COALESCE(AVG(oic.making_cost / NULLIF(oi.quantity, 0)), 0) as avg_cost_per_unit
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       LEFT JOIN order_item_costs oic ON oic.order_item_id = oi.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?${ff.sql}${stf.sql}
       GROUP BY oi.item_id, oi.item_name, oi.variant_name, c.name, i.category_id, c.service_type
       ORDER BY total_quantity DESC
       LIMIT ?`,
      [outletId, start, end, ...ff.params, ...stf.params, limit]
    );

    // Use summary totals from the first query (accurate counts without LIMIT)
    const totalItems = parseInt(summary.total_items || 0);
    const totalQuantity = parseInt(summary.total_quantity || 0);
    const cancelledQuantity = parseInt(summary.cancelled_quantity || 0);
    const grossRevenue = parseFloat(summary.gross_revenue || 0);
    const discountAmount = parseFloat(summary.discount_amount || 0);
    const taxAmount = parseFloat(summary.tax_amount || 0);
    const netRevenue = parseFloat(summary.net_revenue || 0);
    const ncQuantity = parseInt(summary.nc_quantity || 0);
    const ncAmount = parseFloat(summary.nc_amount || 0);
    const dueAmount = parseFloat(summary.due_amount || 0);
    const paidAmount = parseFloat(summary.paid_amount || 0);

    return {
      dateRange: { start, end },
      items: rows,
      summary: {
        total_items: totalItems,
        total_quantity: totalQuantity,
        cancelled_quantity: cancelledQuantity,
        nc_quantity: ncQuantity,
        nc_amount: ncAmount.toFixed(2),
        due_amount: dueAmount.toFixed(2),
        paid_amount: paidAmount.toFixed(2),
        gross_revenue: grossRevenue.toFixed(2),
        discount_amount: discountAmount.toFixed(2),
        tax_amount: taxAmount.toFixed(2),
        net_revenue: netRevenue.toFixed(2),
        making_cost: rows.reduce((s, r) => s + parseFloat(r.making_cost || 0), 0).toFixed(2),
        profit: rows.reduce((s, r) => s + parseFloat(r.item_profit || 0), 0).toFixed(2),
        food_cost_percentage: netRevenue > 0 ? ((rows.reduce((s, r) => s + parseFloat(r.making_cost || 0), 0) / netRevenue) * 100).toFixed(2) : '0.00',
        average_item_revenue: rows.length > 0 ? (netRevenue / rows.length).toFixed(2) : '0.00',
        top_seller: rows.length > 0 ? rows[0].item_name : null,
        top_seller_quantity: rows.length > 0 ? rows[0].total_quantity : 0
      }
    };
  },

  /**
   * 8.3 Category Sales Report — live from order_items + items + categories
   * @param {string} serviceType - 'restaurant', 'bar', or null/all for no restriction
   */
  async getCategorySalesReport(outletId, startDate, endDate, floorIds = [], serviceType = null) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const ff = floorFilter(floorIds);
    const stf = serviceTypeFilter(serviceType);

    // Get category breakdown from order_items
    const [rows] = await pool.query(
      `SELECT 
        i.category_id, c.name as category_name,
        c.service_type as category_service_type,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.quantity ELSE 0 END) as total_quantity,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.total_price ELSE 0 END) as gross_revenue,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.discount_amount ELSE 0 END) as discount_amount,
        SUM(CASE WHEN oi.status != 'cancelled' THEN (oi.total_price - oi.discount_amount) ELSE 0 END) as net_revenue,
        COUNT(DISTINCT oi.item_id) as item_count,
        COUNT(DISTINCT oi.order_id) as order_count,
        SUM(CASE WHEN oi.status != 'cancelled' AND oi.is_nc = 1 THEN oi.quantity ELSE 0 END) as nc_quantity,
        SUM(CASE WHEN oi.status != 'cancelled' AND oi.is_nc = 1 THEN oi.total_price ELSE 0 END) as nc_amount
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?${ff.sql}${stf.sql}
       GROUP BY i.category_id, c.name, c.service_type
       ORDER BY net_revenue DESC`,
      [outletId, start, end, ...ff.params, ...stf.params]
    );

    // Get financial summary from ORDERS table for consistency with daily sales report
    // Gross = subtotal + tax, Net = subtotal - discount
    const [orderSummary] = await pool.query(
      `SELECT 
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal + o.tax_amount) ELSE 0 END) as gross_revenue,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.discount_amount ELSE 0 END) as discount_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as net_revenue,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount,
        COUNT(CASE WHEN o.is_nc = 1 AND o.status != 'cancelled' THEN 1 END) as nc_orders
       FROM orders o
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.status != 'cancelled'${ff.sql}`,
      [outletId, start, end, ...ff.params]
    );

    const totalQuantity = rows.reduce((s, r) => s + parseInt(r.total_quantity || 0), 0);
    const grossRevenue = parseFloat(orderSummary[0].gross_revenue || 0);
    const discountAmount = parseFloat(orderSummary[0].discount_amount || 0);
    const totalRevenue = parseFloat(orderSummary[0].net_revenue || 0);
    const ncAmount = parseFloat(orderSummary[0].nc_amount || 0);
    const dueAmount = parseFloat(orderSummary[0].due_amount || 0);
    const paidAmount = parseFloat(orderSummary[0].paid_amount || 0);

    const categories = rows.map(r => ({
      ...r,
      contribution_percent: totalRevenue > 0 ? ((parseFloat(r.net_revenue) / totalRevenue) * 100).toFixed(2) : '0.00'
    }));

    return {
      dateRange: { start, end },
      categories,
      summary: {
        total_categories: categories.length,
        total_quantity: totalQuantity,
        nc_amount: ncAmount.toFixed(2),
        due_amount: dueAmount.toFixed(2),
        paid_amount: paidAmount.toFixed(2),
        gross_revenue: grossRevenue.toFixed(2),
        discount_amount: discountAmount.toFixed(2),
        net_revenue: totalRevenue.toFixed(2),
        top_category: categories.length > 0 ? categories[0].category_name : null,
        top_category_revenue: categories.length > 0 ? parseFloat(categories[0].net_revenue).toFixed(2) : '0.00'
      }
    };
  },

  /**
   * 8.4 Payment Modes Report — live from payments (includes split payment breakdown)
   */
  async getPaymentModeReport(outletId, startDate, endDate, floorIds = []) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const ff = floorFilter(floorIds);

    // Get regular payments (non-split)
    const [regularRows] = await pool.query(
      `SELECT 
        p.payment_mode,
        COUNT(*) as transaction_count,
        SUM(p.total_amount) as total_amount,
        SUM(p.amount) as base_amount,
        SUM(p.tip_amount) as tip_amount
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       WHERE p.outlet_id = ? AND ${toISTDate('p.created_at')} BETWEEN ? AND ? AND p.status = 'completed' AND p.payment_mode != 'split'${ff.sql}
       GROUP BY p.payment_mode
       ORDER BY total_amount DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Get split payment breakdown from split_payments table
    const [splitRows] = await pool.query(
      `SELECT 
        sp.payment_mode,
        COUNT(*) as transaction_count,
        SUM(sp.amount) as total_amount,
        SUM(sp.amount) as base_amount,
        0 as tip_amount
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id
       WHERE p.outlet_id = ? AND ${toISTDate('p.created_at')} BETWEEN ? AND ? AND p.status = 'completed' AND p.payment_mode = 'split'${ff.sql}
       GROUP BY sp.payment_mode
       ORDER BY total_amount DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Merge regular and split payments by payment_mode
    const modeMap = {};
    for (const r of regularRows) {
      modeMap[r.payment_mode] = {
        payment_mode: r.payment_mode,
        transaction_count: r.transaction_count,
        total_amount: parseFloat(r.total_amount) || 0,
        base_amount: parseFloat(r.base_amount) || 0,
        tip_amount: parseFloat(r.tip_amount) || 0
      };
    }
    for (const r of splitRows) {
      if (modeMap[r.payment_mode]) {
        modeMap[r.payment_mode].transaction_count += r.transaction_count;
        modeMap[r.payment_mode].total_amount += parseFloat(r.total_amount) || 0;
        modeMap[r.payment_mode].base_amount += parseFloat(r.base_amount) || 0;
      } else {
        modeMap[r.payment_mode] = {
          payment_mode: r.payment_mode,
          transaction_count: r.transaction_count,
          total_amount: parseFloat(r.total_amount) || 0,
          base_amount: parseFloat(r.base_amount) || 0,
          tip_amount: 0
        };
      }
    }

    const rows = Object.values(modeMap).sort((a, b) => b.total_amount - a.total_amount);
    const totalAmount = rows.reduce((sum, r) => sum + r.total_amount, 0);
    const totalBase = rows.reduce((sum, r) => sum + r.base_amount, 0);
    const totalTips = rows.reduce((sum, r) => sum + r.tip_amount, 0);
    const totalTransactions = rows.reduce((sum, r) => sum + r.transaction_count, 0);

    // NC summary — compute from order_items (item-level is_nc) since orders table may not be updated
    const [ncSummary] = await pool.query(
      `SELECT 
        COUNT(DISTINCT oi.order_id) as nc_orders,
        COALESCE(SUM(oi.total_price), 0) as nc_amount
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.status != 'cancelled'
       AND oi.is_nc = 1 AND oi.status != 'cancelled'${ff.sql}`,
      [outletId, start, end, ...ff.params]
    );
    const ncData = ncSummary[0] || {};

    // Due summary from orders
    const [dueSummary] = await pool.query(
      `SELECT SUM(COALESCE(o.due_amount, 0)) as due_amount
       FROM orders o
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.status != 'cancelled'${ff.sql}`,
      [outletId, start, end, ...ff.params]
    );
    const dueData = dueSummary[0] || {};

    return {
      dateRange: { start, end },
      modes: rows.map(r => ({
        ...r,
        percentage_share: totalAmount > 0 ? ((r.total_amount / totalAmount) * 100).toFixed(2) : '0.00'
      })),
      summary: {
        total_transactions: totalTransactions,
        total_collected: totalAmount.toFixed(2),
        total_base_amount: totalBase.toFixed(2),
        total_tips: totalTips.toFixed(2),
        average_transaction: totalTransactions > 0 ? (totalAmount / totalTransactions).toFixed(2) : '0.00',
        nc_orders: parseInt(ncData.nc_orders) || 0,
        nc_amount: parseFloat(ncData.nc_amount || 0).toFixed(2),
        due_amount: parseFloat(dueData.due_amount || 0).toFixed(2)
      }
    };
  },

  /**
   * 8.5 Tax Report — live from invoices + tax_breakup JSON for accurate per-component data
   */
  async getTaxReport(outletId, startDate, endDate, floorIds = []) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const ff = floorFilter(floorIds);

    // Daily aggregated from invoice columns
    const [rows] = await pool.query(
      `SELECT 
        ${toISTDate('i.created_at')} as report_date,
        SUM(i.subtotal) as subtotal,
        SUM(i.discount_amount) as discount_amount,
        SUM(i.taxable_amount) as taxable_amount,
        SUM(i.cgst_amount) as cgst_amount,
        SUM(i.sgst_amount) as sgst_amount,
        SUM(i.igst_amount) as igst_amount,
        SUM(i.vat_amount) as vat_amount,
        SUM(i.cess_amount) as cess_amount,
        SUM(i.total_tax) as total_tax,
        SUM(i.service_charge) as service_charge,
        SUM(i.grand_total) as grand_total,
        COUNT(*) as invoice_count
       FROM invoices i
       JOIN orders o ON i.order_id = o.id
       WHERE i.outlet_id = ? AND ${toISTDate('i.created_at')} BETWEEN ? AND ? AND i.is_cancelled = 0${ff.sql}
       GROUP BY ${toISTDate('i.created_at')}
       ORDER BY report_date DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Parse tax_breakup JSON from each invoice for accurate per-component breakdown
    const [invoices] = await pool.query(
      `SELECT i.tax_breakup FROM invoices i
       JOIN orders o ON i.order_id = o.id
       WHERE i.outlet_id = ? AND ${toISTDate('i.created_at')} BETWEEN ? AND ? AND i.is_cancelled = 0${ff.sql}`,
      [outletId, start, end, ...ff.params]
    );

    const componentTotals = {};
    for (const inv of invoices) {
      if (!inv.tax_breakup) continue;
      let breakup;
      try {
        breakup = typeof inv.tax_breakup === 'string' ? JSON.parse(inv.tax_breakup) : inv.tax_breakup;
      } catch (e) { continue; }
      if (!breakup || typeof breakup !== 'object') continue;
      for (const [code, detail] of Object.entries(breakup)) {
        if (!detail || typeof detail !== 'object') continue;
        const compName = detail.name || detail.componentName || code;
        if (!componentTotals[code]) {
          componentTotals[code] = {
            code,
            name: compName,
            rate: detail.rate || 0,
            taxableAmount: 0,
            taxAmount: 0,
            invoiceCount: 0
          };
        }
        componentTotals[code].taxableAmount += parseFloat(detail.taxableAmount || 0);
        componentTotals[code].taxAmount += parseFloat(detail.taxAmount || 0);
        componentTotals[code].invoiceCount += 1;
      }
    }

    // Round component totals
    const taxComponents = Object.values(componentTotals).map(c => ({
      ...c,
      taxableAmount: parseFloat(c.taxableAmount.toFixed(2)),
      taxAmount: parseFloat(c.taxAmount.toFixed(2))
    })).sort((a, b) => b.taxAmount - a.taxAmount);

    // Summary totals
    const summary = {
      total_subtotal: rows.reduce((s, r) => s + parseFloat(r.subtotal || 0), 0).toFixed(2),
      total_discount: rows.reduce((s, r) => s + parseFloat(r.discount_amount || 0), 0).toFixed(2),
      total_taxable: rows.reduce((s, r) => s + parseFloat(r.taxable_amount || 0), 0).toFixed(2),
      total_cgst: rows.reduce((s, r) => s + parseFloat(r.cgst_amount || 0), 0).toFixed(2),
      total_sgst: rows.reduce((s, r) => s + parseFloat(r.sgst_amount || 0), 0).toFixed(2),
      total_igst: rows.reduce((s, r) => s + parseFloat(r.igst_amount || 0), 0).toFixed(2),
      total_vat: rows.reduce((s, r) => s + parseFloat(r.vat_amount || 0), 0).toFixed(2),
      total_cess: rows.reduce((s, r) => s + parseFloat(r.cess_amount || 0), 0).toFixed(2),
      total_tax: rows.reduce((s, r) => s + parseFloat(r.total_tax || 0), 0).toFixed(2),
      total_service_charge: rows.reduce((s, r) => s + parseFloat(r.service_charge || 0), 0).toFixed(2),
      total_grand: rows.reduce((s, r) => s + parseFloat(r.grand_total || 0), 0).toFixed(2),
      total_invoices: rows.reduce((s, r) => s + r.invoice_count, 0)
    };

    // NC summary — compute from order_items (item-level is_nc) since orders table may not be updated
    const [ncSummary] = await pool.query(
      `SELECT 
        COUNT(DISTINCT oi.order_id) as nc_orders,
        COALESCE(SUM(oi.total_price), 0) as nc_amount
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.status != 'cancelled'
       AND oi.is_nc = 1 AND oi.status != 'cancelled'${ff.sql}`,
      [outletId, start, end, ...ff.params]
    );
    const ncData = ncSummary[0] || {};
    summary.nc_orders = parseInt(ncData.nc_orders) || 0;
    summary.nc_amount = parseFloat(ncData.nc_amount || 0).toFixed(2);

    // Due summary from orders
    const [dueSummary] = await pool.query(
      `SELECT SUM(COALESCE(o.due_amount, 0)) as due_amount
       FROM orders o
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.status != 'cancelled'${ff.sql}`,
      [outletId, start, end, ...ff.params]
    );
    summary.due_amount = parseFloat((dueSummary[0] || {}).due_amount || 0).toFixed(2);

    return { dateRange: { start, end }, daily: rows, taxComponents, summary };
  },

  /**
   * 8.6 Hourly Sales Report — live from orders
   */
  async getHourlySalesReport(outletId, reportDate, floorIds = []) {
    const pool = getPool();
    const date = reportDate || getLocalDate();
    const ff = floorFilter(floorIds);

    const [rows] = await pool.query(
      `SELECT 
        HOUR(o.created_at) as hour,
        COUNT(*) as order_count,
        SUM(o.guest_count) as guest_count,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as net_sales,
        COUNT(CASE WHEN o.order_type = 'dine_in' THEN 1 END) as dine_in_count,
        COUNT(CASE WHEN o.order_type = 'takeaway' THEN 1 END) as takeaway_count,
        COUNT(CASE WHEN o.is_nc = 1 THEN 1 END) as nc_orders,
        SUM(COALESCE(o.nc_amount, 0)) as nc_amount
       FROM orders o
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} = ? AND o.status != 'cancelled'${ff.sql}
       GROUP BY HOUR(o.created_at)
       ORDER BY hour`,
      [outletId, date, ...ff.params]
    );

    // Fill all 24 hours (0-23) for chart-friendly output
    const hourMap = {};
    rows.forEach(r => { hourMap[r.hour] = r; });
    const fullDay = [];
    for (let h = 0; h < 24; h++) {
      fullDay.push(hourMap[h] || {
        hour: h, order_count: 0, guest_count: 0, net_sales: 0,
        dine_in_count: 0, takeaway_count: 0, nc_orders: 0, nc_amount: 0
      });
    }

    // Peak hour
    const peak = rows.length > 0 ? rows.reduce((a, b) => parseFloat(a.net_sales) > parseFloat(b.net_sales) ? a : b) : null;

    return {
      date,
      hourly: fullDay,
      summary: {
        total_orders: rows.reduce((s, r) => s + r.order_count, 0),
        total_sales: rows.reduce((s, r) => s + parseFloat(r.net_sales || 0), 0).toFixed(2),
        peak_hour: peak ? `${peak.hour}:00` : null,
        peak_hour_sales: peak ? peak.net_sales : 0
      }
    };
  },

  /**
   * 8.7 Staff Performance Report — live from orders + payments
   */
  async getStaffReport(outletId, startDate, endDate, floorIds = []) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const ff = floorFilter(floorIds);

    const [rows] = await pool.query(
      `SELECT 
        o.created_by as user_id, u.name as user_name,
        COUNT(*) as total_orders,
        SUM(o.guest_count) as total_guests,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as total_sales,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.discount_amount ELSE 0 END) as total_discounts,
        COUNT(CASE WHEN o.status = 'cancelled' THEN 1 END) as cancelled_orders,
        SUM(CASE WHEN o.status = 'cancelled' THEN o.total_amount ELSE 0 END) as cancelled_amount,
        COUNT(CASE WHEN o.is_nc = 1 THEN 1 END) as nc_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount
       FROM orders o
       JOIN users u ON o.created_by = u.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?${ff.sql}
       GROUP BY o.created_by, u.name
       ORDER BY total_sales DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Get tips per staff
    const [tips] = await pool.query(
      `SELECT p.received_by as user_id, SUM(p.tip_amount) as tips
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       WHERE p.outlet_id = ? AND ${toISTDate('p.created_at')} BETWEEN ? AND ? AND p.status = 'completed' AND p.tip_amount > 0${ff.sql}
       GROUP BY p.received_by`,
      [outletId, start, end, ...ff.params]
    );
    const tipMap = {};
    tips.forEach(t => { tipMap[t.user_id] = parseFloat(t.tips); });

    const staff = rows.map(r => ({
      ...r,
      total_tips: tipMap[r.user_id] || 0,
      avg_order_value: r.total_orders > 0 ? (parseFloat(r.total_sales) / r.total_orders).toFixed(2) : '0.00',
      avg_guest_spend: r.total_guests > 0 ? (parseFloat(r.total_sales) / r.total_guests).toFixed(2) : '0.00'
    }));

    // Calculate summary totals
    const totalOrders = rows.reduce((s, r) => s + (r.total_orders || 0), 0);
    const totalGuests = rows.reduce((s, r) => s + (r.total_guests || 0), 0);
    const totalSales = rows.reduce((s, r) => s + parseFloat(r.total_sales || 0), 0);
    const totalDiscounts = rows.reduce((s, r) => s + parseFloat(r.total_discounts || 0), 0);
    const cancelledOrders = rows.reduce((s, r) => s + (r.cancelled_orders || 0), 0);
    const cancelledAmount = rows.reduce((s, r) => s + parseFloat(r.cancelled_amount || 0), 0);
    const totalTips = Object.values(tipMap).reduce((s, t) => s + t, 0);

    return {
      dateRange: { start, end },
      staff,
      summary: {
        total_staff: staff.length,
        total_orders: totalOrders,
        total_guests: totalGuests,
        total_sales: totalSales.toFixed(2),
        total_discounts: totalDiscounts.toFixed(2),
        cancelled_orders: cancelledOrders,
        cancelled_amount: cancelledAmount.toFixed(2),
        nc_orders: rows.reduce((s, r) => s + (r.nc_orders || 0), 0),
        nc_amount: rows.reduce((s, r) => s + parseFloat(r.nc_amount || 0), 0).toFixed(2),
        due_amount: rows.reduce((s, r) => s + parseFloat(r.due_amount || 0), 0).toFixed(2),
        paid_amount: rows.reduce((s, r) => s + parseFloat(r.paid_amount || 0), 0).toFixed(2),
        total_tips: totalTips.toFixed(2),
        average_per_staff: staff.length > 0 ? (totalSales / staff.length).toFixed(2) : '0.00',
        top_performer: staff.length > 0 ? staff[0].user_name : null,
        top_performer_sales: staff.length > 0 ? parseFloat(staff[0].total_sales).toFixed(2) : '0.00'
      }
    };
  },

  /**
   * Floor/Section Sales Report — live from orders
   * Supports: filters, search, pagination for admin/manager view
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options - { floorIds, search, page, limit, sortBy, sortOrder }
   */
  async getFloorSectionReport(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    
    const floorIds = options.floorIds || [];
    const search = (options.search || '').trim();
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const sortBy = options.sortBy || 'net_sales';
    const sortOrder = (options.sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    
    const ff = floorFilter(floorIds);

    // Build search condition for floor query
    let floorSearchSql = '';
    const floorSearchParams = [];
    if (search) {
      floorSearchSql = ` AND f.name LIKE ?`;
      floorSearchParams.push(`%${search}%`);
    }

    // Build search condition for section query  
    let sectionSearchSql = '';
    const sectionSearchParams = [];
    if (search) {
      sectionSearchSql = ` AND (f.name LIKE ? OR s.name LIKE ?)`;
      sectionSearchParams.push(`%${search}%`, `%${search}%`);
    }

    // Valid sort columns
    const validSorts = ['net_sales', 'order_count', 'guest_count', 'floor_name', 'section_name'];
    const orderCol = validSorts.includes(sortBy) ? sortBy : 'net_sales';

    // Get floor-wise breakdown (exclude orders without floor_id - delivery/takeaway/counter)
    const [floorRows] = await pool.query(
      `SELECT 
        o.floor_id, 
        f.name as floor_name,
        COUNT(*) as order_count,
        COALESCE(SUM(CAST(o.guest_count AS UNSIGNED)), 0) as guest_count,
        COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END), 0) as net_sales,
        SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        COUNT(CASE WHEN o.is_nc = 1 THEN 1 END) as nc_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount
       FROM orders o
       INNER JOIN floors f ON o.floor_id = f.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.floor_id IS NOT NULL${ff.sql}${floorSearchSql}
       GROUP BY o.floor_id, f.name
       ORDER BY net_sales DESC`,
      [outletId, start, end, ...ff.params, ...floorSearchParams]
    );

    // Get section-wise breakdown with pagination (exclude orders without floor_id)
    const [countResult] = await pool.query(
      `SELECT COUNT(DISTINCT CONCAT(o.floor_id, '-', COALESCE(o.section_id, 0))) as total
       FROM orders o
       INNER JOIN floors f ON o.floor_id = f.id
       LEFT JOIN sections s ON o.section_id = s.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.floor_id IS NOT NULL${ff.sql}${sectionSearchSql}`,
      [outletId, start, end, ...ff.params, ...sectionSearchParams]
    );
    const total = countResult[0]?.total || 0;

    const [sectionRows] = await pool.query(
      `SELECT 
        o.floor_id, 
        f.name as floor_name,
        o.section_id, 
        s.name as section_name,
        COUNT(*) as order_count,
        COALESCE(SUM(CAST(o.guest_count AS UNSIGNED)), 0) as guest_count,
        COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END), 0) as net_sales,
        SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        COUNT(CASE WHEN o.is_nc = 1 THEN 1 END) as nc_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount
       FROM orders o
       INNER JOIN floors f ON o.floor_id = f.id
       LEFT JOIN sections s ON o.section_id = s.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.floor_id IS NOT NULL${ff.sql}${sectionSearchSql}
       GROUP BY o.floor_id, f.name, o.section_id, s.name
       ORDER BY ${orderCol} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [outletId, start, end, ...ff.params, ...sectionSearchParams, limit, offset]
    );

    // Format sections first for grouping
    const formattedSections = sectionRows.map(r => ({
      floorId: r.floor_id,
      floorName: r.floor_name || 'Unassigned',
      sectionId: r.section_id,
      sectionName: r.section_name || 'No Section',
      orderCount: parseInt(r.order_count) || 0,
      guestCount: parseInt(r.guest_count) || 0,
      netSales: parseFloat(r.net_sales) || 0,
      cancelledOrders: parseInt(r.cancelled_orders) || 0,
      ncOrders: parseInt(r.nc_orders) || 0,
      ncAmount: parseFloat(r.nc_amount) || 0,
      dueAmount: parseFloat(r.due_amount) || 0,
      paidAmount: parseFloat(r.paid_amount) || 0,
      avgOrderValue: r.order_count > 0 ? parseFloat((parseFloat(r.net_sales) / r.order_count).toFixed(2)) : 0
    }));

    // Group sections by floor
    const sectionsByFloor = {};
    for (const section of formattedSections) {
      const key = section.floorId || 'unassigned';
      if (!sectionsByFloor[key]) {
        sectionsByFloor[key] = [];
      }
      sectionsByFloor[key].push({
        sectionId: section.sectionId,
        sectionName: section.sectionName,
        orderCount: section.orderCount,
        guestCount: section.guestCount,
        netSales: section.netSales,
        cancelledOrders: section.cancelledOrders,
        ncOrders: section.ncOrders,
        ncAmount: section.ncAmount,
        dueAmount: section.dueAmount,
        paidAmount: section.paidAmount,
        avgOrderValue: section.avgOrderValue
      });
    }

    // Format floors with nested sections
    const floors = floorRows.map(r => {
      const floorId = r.floor_id;
      const floorSections = sectionsByFloor[floorId] || sectionsByFloor['unassigned'] || [];
      return {
        floorId: floorId,
        floorName: r.floor_name || 'Unassigned',
        orderCount: parseInt(r.order_count) || 0,
        guestCount: parseInt(r.guest_count) || 0,
        netSales: parseFloat(r.net_sales) || 0,
        cancelledOrders: parseInt(r.cancelled_orders) || 0,
        ncOrders: parseInt(r.nc_orders) || 0,
        ncAmount: parseFloat(r.nc_amount) || 0,
        dueAmount: parseFloat(r.due_amount) || 0,
        paidAmount: parseFloat(r.paid_amount) || 0,
        avgOrderValue: r.order_count > 0 ? parseFloat((parseFloat(r.net_sales) / r.order_count).toFixed(2)) : 0,
        sections: floorSections
      };
    });

    // Calculate summary totals from floors (more accurate)
    const totalOrders = floors.reduce((s, r) => s + r.orderCount, 0);
    const totalGuests = floors.reduce((s, r) => s + r.guestCount, 0);
    const totalSales = floors.reduce((s, r) => s + r.netSales, 0);
    const cancelledOrders = floors.reduce((s, r) => s + r.cancelledOrders, 0);
    const totalNCOrders = floors.reduce((s, r) => s + r.ncOrders, 0);
    const totalNCAmount = floors.reduce((s, r) => s + r.ncAmount, 0);
    const totalDueAmount = floors.reduce((s, r) => s + r.dueAmount, 0);
    const totalPaidAmount = floors.reduce((s, r) => s + r.paidAmount, 0);

    // Find top section by sales
    const topSection = formattedSections.length > 0 ? formattedSections.reduce((a, b) => a.netSales > b.netSales ? a : b) : null;

    return {
      dateRange: { start, end },
      floors,
      summary: {
        total_floors: floors.length,
        total_sections: total,
        total_orders: totalOrders,
        total_guests: totalGuests,
        total_sales: totalSales.toFixed(2),
        cancelled_orders: cancelledOrders,
        nc_orders: totalNCOrders,
        nc_amount: parseFloat(totalNCAmount.toFixed(2)),
        due_amount: parseFloat(totalDueAmount.toFixed(2)),
        paid_amount: parseFloat(totalPaidAmount.toFixed(2)),
        average_order_value: totalOrders > 0 ? (totalSales / totalOrders).toFixed(2) : '0.00',
        top_section: topSection?.sectionName || null,
        top_section_sales: topSection ? topSection.netSales.toFixed(2) : '0.00'
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  },

  /**
   * Counter/Station Sales Report — live from KOT tickets
   */
  async getCounterSalesReport(outletId, startDate, endDate, floorIds = []) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const ff = floorFilter(floorIds);

    // Get counter/station breakdown using station_id for actual counter/station names
    const [rows] = await pool.query(
      `SELECT 
        kt.station as station_type,
        kt.station_id,
        COALESCE(ks.name, c.name, kt.station) as station_name,
        COALESCE(ks.station_type, c.counter_type, kt.station) as station_category,
        COUNT(DISTINCT kt.id) as ticket_count,
        COUNT(ki.id) as item_count,
        COALESCE(SUM(ki.quantity), 0) as total_quantity,
        AVG(CASE WHEN kt.ready_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, kt.created_at, kt.ready_at) ELSE NULL END) as avg_prep_time_mins,
        SUM(CASE WHEN ki.status = 'served' THEN 1 ELSE 0 END) as served_count,
        SUM(CASE WHEN ki.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count
       FROM kot_tickets kt
       LEFT JOIN kot_items ki ON kt.id = ki.kot_id
       LEFT JOIN kitchen_stations ks ON kt.station_id = ks.id AND ks.outlet_id = kt.outlet_id
       LEFT JOIN counters c ON kt.station_id = c.id AND c.outlet_id = kt.outlet_id 
         AND kt.station IN ('bar', 'main_bar', 'mocktail', 'live_counter')
       JOIN orders o ON kt.order_id = o.id
       WHERE kt.outlet_id = ? AND ${toISTDate('kt.created_at')} BETWEEN ? AND ?${ff.sql}
       GROUP BY kt.station, kt.station_id, ks.name, c.name, ks.station_type, c.counter_type
       ORDER BY ticket_count DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Format stations with proper naming
    const stations = rows.map(r => ({
      stationId: r.station_id,
      stationName: r.station_name || r.station_type || 'Unknown',
      stationType: r.station_type,
      stationCategory: r.station_category,
      ticketCount: parseInt(r.ticket_count) || 0,
      itemCount: parseInt(r.item_count) || 0,
      totalQuantity: parseInt(r.total_quantity) || 0,
      avgPrepTimeMins: r.avg_prep_time_mins ? parseFloat(r.avg_prep_time_mins).toFixed(1) : null,
      servedCount: parseInt(r.served_count) || 0,
      cancelledCount: parseInt(r.cancelled_count) || 0
    }));

    // Calculate summary totals
    const totalTickets = stations.reduce((s, r) => s + r.ticketCount, 0);
    const totalItems = stations.reduce((s, r) => s + r.itemCount, 0);
    const totalQuantity = stations.reduce((s, r) => s + r.totalQuantity, 0);
    const servedCount = stations.reduce((s, r) => s + r.servedCount, 0);
    const cancelledCount = stations.reduce((s, r) => s + r.cancelledCount, 0);
    const busiestStation = stations.length > 0 ? stations[0] : null;

    return {
      dateRange: { start, end },
      stations,
      summary: {
        total_stations: stations.length,
        total_tickets: totalTickets,
        total_items: totalItems,
        total_quantity: totalQuantity,
        served_count: servedCount,
        cancelled_count: cancelledCount,
        busiest_station: busiestStation?.stationName || null,
        busiest_station_tickets: busiestStation?.ticketCount || 0
      }
    };
  },

  /**
   * Counter Sales Detail — per-KOT ticket breakdown with item details
   * Supports: filters, search, pagination, sorting
   *
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options
   * @param {number}  options.page          - 1-indexed page (default 1)
   * @param {number}  options.limit         - items per page (default 50, max 200)
   * @param {string}  options.search        - search in kot_number, order_number, item_name
   * @param {string}  options.station       - kitchen | bar | dessert | other
   * @param {string}  options.status        - pending | accepted | preparing | ready | served | cancelled
   * @param {string}  options.orderType     - dine_in | takeaway | delivery
   * @param {string}  options.captainName   - partial match on captain (order creator)
   * @param {string}  options.floorName     - partial match on floor name
   * @param {string}  options.tableNumber   - exact table number
   * @param {string}  options.sortBy        - created_at | kot_number | item_count | station (default created_at)
   * @param {string}  options.sortOrder     - ASC | DESC (default DESC)
   * @param {Array}   options.floorIds      - floor restriction
   */
  async getCounterSalesDetail(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);

    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (options.search || '').trim();
    const station = (options.station || '').trim();
    const status = (options.status || '').trim();
    const orderType = (options.orderType || '').trim();
    const captainName = (options.captainName || '').trim();
    const floorName = (options.floorName || '').trim();
    const tableNumber = (options.tableNumber || '').trim() || null;
    const floorIds = options.floorIds || [];

    const allowedSort = ['created_at', 'kot_number', 'item_count', 'station'];
    const sortBy = allowedSort.includes(options.sortBy) ? options.sortBy : 'created_at';
    const sortOrder = (options.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // ─── Build base query ───
    const baseFrom = `FROM kot_tickets kt
       JOIN orders o ON kt.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_accepted ON kt.accepted_by = u_accepted.id
       LEFT JOIN users u_served ON kt.served_by = u_served.id`;

    let conditions = ['kt.outlet_id = ?', `${toISTDate('kt.created_at')} BETWEEN ? AND ?`];
    let params = [outletId, start, end];

    if (floorIds.length > 0) {
      conditions.push(`o.floor_id IN (${floorIds.map(() => '?').join(',')})`);
      params.push(...floorIds);
    }
    if (station) { conditions.push('kt.station = ?'); params.push(station); }
    if (status) { conditions.push('kt.status = ?'); params.push(status); }
    if (orderType) { conditions.push('o.order_type = ?'); params.push(orderType); }
    if (captainName) { conditions.push('u_captain.name LIKE ?'); params.push(`%${captainName}%`); }
    if (floorName) { conditions.push('f.name LIKE ?'); params.push(`%${floorName}%`); }
    if (tableNumber) { conditions.push('t.table_number = ?'); params.push(tableNumber); }
    if (search) {
      conditions.push('(kt.kot_number LIKE ? OR o.order_number LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // ─── 0. Total count ───
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total ${baseFrom} ${whereClause}`,
      params
    );
    const totalCount = countResult[0].total;

    const emptyFilters = {};
    if (search) emptyFilters.search = search;
    if (station) emptyFilters.station = station;
    if (status) emptyFilters.status = status;
    if (orderType) emptyFilters.orderType = orderType;
    if (captainName) emptyFilters.captainName = captainName;
    if (floorName) emptyFilters.floorName = floorName;
    if (tableNumber) emptyFilters.tableNumber = tableNumber;
    if (options.sortBy) emptyFilters.sortBy = options.sortBy;
    if (options.sortOrder) emptyFilters.sortOrder = options.sortOrder;

    if (totalCount === 0) {
      return {
        dateRange: { start, end },
        tickets: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false },
        filters: emptyFilters,
        summary: {
          totalTickets: 0, totalItemsSent: 0, totalQuantity: 0,
          byStation: [], byStatus: [], byHour: [],
          avgPrepTimeMins: 0, servedCount: 0, cancelledCount: 0, pendingCount: 0
        }
      };
    }

    const totalPages = Math.ceil(totalCount / limit);

    // ─── 1. Summary aggregation (all filtered, not paginated) ───
    const [summaryRows] = await pool.query(
      `SELECT
        COUNT(*) as total_tickets,
        SUM(CASE WHEN kt.status = 'served' THEN 1 ELSE 0 END) as served_count,
        SUM(CASE WHEN kt.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
        SUM(CASE WHEN kt.status NOT IN ('served','cancelled') THEN 1 ELSE 0 END) as pending_count,
        AVG(CASE WHEN kt.ready_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, kt.created_at, kt.ready_at) ELSE NULL END) as avg_prep_time_mins
       ${baseFrom} ${whereClause}`,
      params
    );
    const sr = summaryRows[0];

    // Item-level aggregation
    const [itemSummary] = await pool.query(
      `SELECT
        COUNT(ki.id) as total_items_sent,
        SUM(ki.quantity) as total_quantity
       FROM kot_items ki
       JOIN kot_tickets kt ON ki.kot_id = kt.id
       JOIN orders o ON kt.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_accepted ON kt.accepted_by = u_accepted.id
       LEFT JOIN users u_served ON kt.served_by = u_served.id
       ${whereClause}`,
      params
    );
    const isr = itemSummary[0];

    // By station breakdown
    const [stationBreakdown] = await pool.query(
      `SELECT 
        kt.station,
        COUNT(*) as ticket_count,
        SUM(CASE WHEN kt.status = 'served' THEN 1 ELSE 0 END) as served,
        SUM(CASE WHEN kt.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        AVG(CASE WHEN kt.ready_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, kt.created_at, kt.ready_at) ELSE NULL END) as avg_prep_mins
       ${baseFrom} ${whereClause}
       GROUP BY kt.station ORDER BY ticket_count DESC`,
      params
    );

    // By status breakdown
    const [statusBreakdown] = await pool.query(
      `SELECT kt.status, COUNT(*) as count
       ${baseFrom} ${whereClause}
       GROUP BY kt.status ORDER BY count DESC`,
      params
    );

    // Hourly distribution
    const [hourlyBreakdown] = await pool.query(
      `SELECT HOUR(kt.created_at) as hour, COUNT(*) as count
       ${baseFrom} ${whereClause}
       GROUP BY HOUR(kt.created_at) ORDER BY hour`,
      params
    );

    const summary = {
      totalTickets: parseInt(sr.total_tickets) || 0,
      totalItemsSent: parseInt(isr.total_items_sent) || 0,
      totalQuantity: parseFloat(isr.total_quantity) || 0,
      avgPrepTimeMins: sr.avg_prep_time_mins !== null ? parseFloat(parseFloat(sr.avg_prep_time_mins).toFixed(1)) : 0,
      servedCount: parseInt(sr.served_count) || 0,
      cancelledCount: parseInt(sr.cancelled_count) || 0,
      pendingCount: parseInt(sr.pending_count) || 0,
      byStation: stationBreakdown.map(r => ({
        station: r.station,
        ticketCount: parseInt(r.ticket_count),
        served: parseInt(r.served),
        cancelled: parseInt(r.cancelled),
        avgPrepMins: r.avg_prep_mins !== null ? parseFloat(parseFloat(r.avg_prep_mins).toFixed(1)) : 0
      })),
      byStatus: statusBreakdown.map(r => ({
        status: r.status,
        count: parseInt(r.count)
      })),
      byHour: hourlyBreakdown.map(r => ({
        hour: parseInt(r.hour),
        count: parseInt(r.count)
      }))
    };

    // ─── 2. Paginated KOT tickets ───
    const sortColumn = sortBy === 'item_count' ? '(SELECT COUNT(*) FROM kot_items ki2 WHERE ki2.kot_id = kt.id)'
      : sortBy === 'kot_number' ? 'kt.kot_number' : sortBy === 'station' ? 'kt.station' : 'kt.created_at';

    const [tickets] = await pool.query(
      `SELECT 
        kt.id as kot_id, kt.kot_number, kt.station, kt.status as kot_status,
        kt.priority, kt.notes as kot_notes,
        kt.table_number as kot_table_number,
        kt.printed_count, kt.last_printed_at,
        kt.created_at as kot_created_at,
        kt.accepted_at, kt.ready_at, kt.served_at, kt.cancelled_at as kot_cancelled_at,
        kt.cancel_reason as kot_cancel_reason,
        o.id as order_id, o.order_number, o.order_type, o.status as order_status,
        o.total_amount as order_total, o.customer_name, o.customer_phone,
        t.table_number, t.name as table_name,
        f.name as floor_name,
        u_captain.name as captain_name,
        u_accepted.name as accepted_by_name,
        u_served.name as served_by_name
       ${baseFrom} ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    if (tickets.length === 0) {
      return {
        dateRange: { start, end },
        tickets: [],
        pagination: { page, limit, totalCount, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
        filters: emptyFilters,
        summary
      };
    }

    // ─── 3. Batch-fetch items for all tickets on this page ───
    const kotIds = tickets.map(t => t.kot_id);
    let kotItemsMap = {};
    if (kotIds.length > 0) {
      const [items] = await pool.query(
        `SELECT 
          ki.kot_id, ki.item_name, ki.variant_name, ki.quantity,
          ki.addons_text, ki.special_instructions, ki.status as item_status,
          oi.item_type, oi.unit_price, oi.total_price, oi.tax_amount,
          oi.discount_amount, oi.status as order_item_status
         FROM kot_items ki
         LEFT JOIN order_items oi ON ki.order_item_id = oi.id
         WHERE ki.kot_id IN (?)
         ORDER BY ki.kot_id, ki.created_at`,
        [kotIds]
      );
      for (const item of items) {
        if (!kotItemsMap[item.kot_id]) kotItemsMap[item.kot_id] = [];
        kotItemsMap[item.kot_id].push({
          itemName: item.item_name,
          variantName: item.variant_name || null,
          itemType: item.item_type || null,
          quantity: parseFloat(item.quantity) || 0,
          unitPrice: parseFloat(item.unit_price) || 0,
          totalPrice: parseFloat(item.total_price) || 0,
          taxAmount: parseFloat(item.tax_amount) || 0,
          discountAmount: parseFloat(item.discount_amount) || 0,
          addonsText: item.addons_text || null,
          specialInstructions: item.special_instructions || null,
          itemStatus: item.item_status,
          orderItemStatus: item.order_item_status
        });
      }
    }

    // ─── 4. Build response ───
    const ticketList = tickets.map(tk => {
      const items = kotItemsMap[tk.kot_id] || [];
      const prepTimeMins = tk.ready_at && tk.kot_created_at
        ? Math.round((new Date(tk.ready_at) - new Date(tk.kot_created_at)) / 60000)
        : null;

      return {
        kotId: tk.kot_id,
        kotNumber: tk.kot_number,
        station: tk.station,
        kotStatus: tk.kot_status,
        priority: tk.priority,
        kotNotes: tk.kot_notes || null,
        printedCount: tk.printed_count || 0,

        // Timestamps
        createdAt: tk.kot_created_at,
        acceptedAt: tk.accepted_at || null,
        readyAt: tk.ready_at || null,
        servedAt: tk.served_at || null,
        cancelledAt: tk.kot_cancelled_at || null,
        cancelReason: tk.kot_cancel_reason || null,
        prepTimeMins,

        // People
        captainName: tk.captain_name || null,
        acceptedByName: tk.accepted_by_name || null,
        servedByName: tk.served_by_name || null,

        // Order context
        orderId: tk.order_id,
        orderNumber: tk.order_number,
        orderType: tk.order_type,
        orderStatus: tk.order_status,
        orderTotal: parseFloat(tk.order_total) || 0,
        customerName: tk.customer_name || null,
        customerPhone: tk.customer_phone || null,

        // Location
        tableNumber: tk.table_number || tk.kot_table_number || null,
        tableName: tk.table_name || null,
        floorName: tk.floor_name || null,

        // Items
        itemCount: items.length,
        totalQuantity: items.reduce((s, i) => s + i.quantity, 0),
        itemsValue: parseFloat(items.reduce((s, i) => s + i.totalPrice, 0).toFixed(2)),
        items
      };
    });

    return {
      dateRange: { start, end },
      tickets: ticketList,
      pagination: {
        page, limit, totalCount, totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: emptyFilters,
      summary
    };
  },

  /**
   * 8.8 Cancellation Report — live from order_cancel_logs + cancelled items
   * Supports all roles: admin, manager, cashier, captain
   */
  async getCancellationReport(outletId, startDate, endDate, floorIds = []) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const ff = floorFilter(floorIds);

    // Order-level cancellations - use created_at as fallback if cancelled_at is NULL
    const [orderCancels] = await pool.query(
      `SELECT 
        'full_order' as cancel_type,
        o.id as order_id,
        o.order_number, 
        o.order_type, 
        o.subtotal,
        o.total_amount,
        o.cancel_reason as reason,
        u.name as cancelled_by_name,
        c.name as captain_name,
        f.name as floor_name,
        t.table_number,
        COALESCE(o.cancelled_at, o.updated_at) as cancelled_at,
        DATE(COALESCE(o.cancelled_at, o.updated_at)) as cancel_date
       FROM orders o
       LEFT JOIN users u ON o.cancelled_by = u.id
       LEFT JOIN users c ON o.created_by = c.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = ? 
         AND ${toISTDate('COALESCE(o.cancelled_at, o.created_at)')} BETWEEN ? AND ? 
         AND o.status = 'cancelled'${ff.sql}
       ORDER BY COALESCE(o.cancelled_at, o.updated_at) DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Item-level cancellations - include items cancelled within active orders
    const [itemCancels] = await pool.query(
      `SELECT 
        'item' as cancel_type,
        o.id as order_id,
        o.order_number, 
        o.order_type,
        oi.id as item_id,
        oi.item_name, 
        oi.variant_name,
        oi.quantity as cancelled_quantity,
        oi.unit_price,
        oi.total_price as cancelled_amount,
        oi.cancel_reason as reason,
        u.name as cancelled_by_name,
        c.name as captain_name,
        f.name as floor_name,
        t.table_number,
        COALESCE(oi.cancelled_at, oi.updated_at) as cancelled_at,
        DATE(COALESCE(oi.cancelled_at, oi.updated_at)) as cancel_date
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN users u ON oi.cancelled_by = u.id
       LEFT JOIN users c ON o.created_by = c.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = ? 
         AND ${toISTDate('COALESCE(oi.cancelled_at, oi.created_at)')} BETWEEN ? AND ? 
         AND oi.status = 'cancelled'${ff.sql}
       ORDER BY COALESCE(oi.cancelled_at, oi.updated_at) DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Summary by reason - combine both order and item cancellations
    const [reasonSummary] = await pool.query(
      `SELECT reason, SUM(cnt) as count, SUM(amount) as total_amount FROM (
        SELECT 
          COALESCE(o.cancel_reason, 'No reason') as reason,
          1 as cnt,
          o.total_amount as amount
        FROM orders o
        WHERE o.outlet_id = ? 
          AND ${toISTDate('COALESCE(o.cancelled_at, o.created_at)')} BETWEEN ? AND ? 
          AND o.status = 'cancelled'${ff.sql}
        UNION ALL
        SELECT 
          COALESCE(oi.cancel_reason, 'No reason') as reason,
          1 as cnt,
          oi.total_price as amount
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        WHERE o.outlet_id = ? 
          AND ${toISTDate('COALESCE(oi.cancelled_at, oi.created_at)')} BETWEEN ? AND ? 
          AND oi.status = 'cancelled'${ff.sql}
      ) combined
      GROUP BY reason
      ORDER BY count DESC`,
      [outletId, start, end, ...ff.params, outletId, start, end, ...ff.params]
    );

    // Daily breakdown
    const dailyBreakdown = {};
    for (const cancel of orderCancels) {
      const day = cancel.cancel_date instanceof Date 
        ? cancel.cancel_date.toISOString().slice(0, 10) 
        : String(cancel.cancel_date);
      if (!dailyBreakdown[day]) {
        dailyBreakdown[day] = { orders: 0, items: 0, orderAmount: 0, itemAmount: 0 };
      }
      dailyBreakdown[day].orders++;
      dailyBreakdown[day].orderAmount += parseFloat(cancel.total_amount || 0);
    }
    for (const cancel of itemCancels) {
      const day = cancel.cancel_date instanceof Date 
        ? cancel.cancel_date.toISOString().slice(0, 10) 
        : String(cancel.cancel_date);
      if (!dailyBreakdown[day]) {
        dailyBreakdown[day] = { orders: 0, items: 0, orderAmount: 0, itemAmount: 0 };
      }
      dailyBreakdown[day].items++;
      dailyBreakdown[day].itemAmount += parseFloat(cancel.cancelled_amount || 0);
    }

    const totalOrderAmount = orderCancels.reduce((s, r) => s + parseFloat(r.total_amount || 0), 0);
    const totalItemAmount = itemCancels.reduce((s, r) => s + parseFloat(r.cancelled_amount || 0), 0);

    return {
      dateRange: { start, end },
      order_cancellations: orderCancels,
      item_cancellations: itemCancels,
      daily_breakdown: Object.entries(dailyBreakdown).map(([date, data]) => ({
        date,
        ...data,
        orderAmount: parseFloat(data.orderAmount.toFixed(2)),
        itemAmount: parseFloat(data.itemAmount.toFixed(2))
      })).sort((a, b) => b.date.localeCompare(a.date)),
      summary: {
        total_order_cancellations: orderCancels.length,
        total_item_cancellations: itemCancels.length,
        total_cancellations: orderCancels.length + itemCancels.length,
        total_order_cancel_amount: totalOrderAmount.toFixed(2),
        total_item_cancel_amount: totalItemAmount.toFixed(2),
        total_cancel_amount: (totalOrderAmount + totalItemAmount).toFixed(2),
        by_reason: reasonSummary
      }
    };
  },

  // ========================
  // DETAILED CANCELLATION REPORT
  // ========================

  /**
   * Detailed cancellation report — comprehensive per-cancellation breakdown
   * Covers: full order cancellations, individual item cancellations, partial quantity reductions
   * Includes: order context, items, captain/cashier, floor/table, KOT info, cancel logs, approval, timestamps
   * Supports: filters, search, pagination, sorting
   *
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options
   * @param {number}  options.page          - 1-indexed page (default 1)
   * @param {number}  options.limit         - items per page (default 50, max 200)
   * @param {string}  options.search        - search in order_number, item_name, reason_text
   * @param {string}  options.cancelType    - full_order | full_item | quantity_reduce
   * @param {string}  options.cancelledByName - partial match on who cancelled
   * @param {string}  options.approvedByName  - partial match on who approved
   * @param {string}  options.orderType     - dine_in | takeaway | delivery
   * @param {string}  options.floorName     - partial match on floor name
   * @param {number}  options.tableNumber   - exact table number
   * @param {string}  options.sortBy        - created_at | cancelled_amount | order_number (default created_at)
   * @param {string}  options.sortOrder     - ASC | DESC (default DESC)
   * @param {Array}   options.floorIds      - floor restriction for assigned-floor users
   */
  async getCancellationDetail(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);

    // Parse options
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (options.search || '').trim();
    const cancelType = (options.cancelType || '').trim();
    const cancelledByName = (options.cancelledByName || '').trim();
    const approvedByName = (options.approvedByName || '').trim();
    const captainName = (options.captainName || '').trim();
    const cashierName = (options.cashierName || '').trim();
    const orderType = (options.orderType || '').trim();
    const floorName = (options.floorName || '').trim();
    const tableNumber = (options.tableNumber || '').trim() || null;

    const allowedSort = ['created_at', 'cancelled_amount', 'order_number'];
    const sortBy = allowedSort.includes(options.sortBy) ? options.sortBy : 'created_at';
    const sortOrder = (options.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Floor restriction
    const floorIds = options.floorIds || [];

    // ─── Build unified cancellation log query ───
    // We query from order_cancel_logs as the primary source since it captures all cancel actions
    const baseFrom = `FROM order_cancel_logs ocl
       JOIN orders o ON ocl.order_id = o.id
       LEFT JOIN order_items oi ON ocl.order_item_id = oi.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u_cancel ON ocl.cancelled_by = u_cancel.id
       LEFT JOIN users u_approve ON ocl.approved_by = u_approve.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_cashier ON o.billed_by = u_cashier.id`;

    let conditions = ['o.outlet_id = ?', `${toISTDate('ocl.created_at')} BETWEEN ? AND ?`];
    let params = [outletId, start, end];

    if (floorIds.length > 0) {
      conditions.push(`o.floor_id IN (${floorIds.map(() => '?').join(',')})`);
      params.push(...floorIds);
    }
    if (cancelType) { conditions.push('ocl.cancel_type = ?'); params.push(cancelType); }
    if (orderType) { conditions.push('o.order_type = ?'); params.push(orderType); }
    if (cancelledByName) { conditions.push('u_cancel.name LIKE ?'); params.push(`%${cancelledByName}%`); }
    if (approvedByName) { conditions.push('u_approve.name LIKE ?'); params.push(`%${approvedByName}%`); }
    if (captainName) { conditions.push('u_captain.name LIKE ?'); params.push(`%${captainName}%`); }
    if (cashierName) { conditions.push('u_cashier.name LIKE ?'); params.push(`%${cashierName}%`); }
    if (floorName) { conditions.push('f.name LIKE ?'); params.push(`%${floorName}%`); }
    if (tableNumber) { conditions.push('t.table_number = ?'); params.push(tableNumber); }
    if (search) {
      conditions.push('(o.order_number LIKE ? OR oi.item_name LIKE ? OR ocl.reason_text LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // ─── 0. Total count for pagination ───
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total ${baseFrom} ${whereClause}`,
      params
    );
    const totalCount = countResult[0].total;

    if (totalCount === 0) {
      return {
        dateRange: { start, end },
        cancellations: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false },
        filters: this._cancelDetailFilters(options),
        summary: this._emptyCancelDetailSummary()
      };
    }

    const totalPages = Math.ceil(totalCount / limit);

    // ─── 1. Summary aggregation over ALL filtered logs (not paginated) ───
    const [summaryRows] = await pool.query(
      `SELECT
        COUNT(*) as total_cancellations,
        SUM(CASE WHEN ocl.cancel_type = 'full_order' THEN 1 ELSE 0 END) as full_order_cancellations,
        SUM(CASE WHEN ocl.cancel_type IN ('full_item','partial_item') THEN 1 ELSE 0 END) as item_cancellations,
        SUM(CASE WHEN ocl.cancel_type = 'quantity_reduce' THEN 1 ELSE 0 END) as quantity_reductions,
        COUNT(DISTINCT ocl.order_id) as unique_orders_affected,
        SUM(CASE WHEN ocl.cancel_type = 'full_order' THEN o.total_amount ELSE 0 END) as full_order_cancel_amount,
        SUM(CASE WHEN ocl.cancel_type IN ('full_item','partial_item') AND oi.id IS NOT NULL THEN oi.total_price ELSE 0 END) as item_cancel_amount,
        SUM(CASE WHEN ocl.cancel_type = 'quantity_reduce' AND oi.id IS NOT NULL 
             THEN (ocl.cancelled_quantity * oi.unit_price) ELSE 0 END) as quantity_reduce_amount,
        SUM(ocl.refund_amount) as total_refund_amount,
        COUNT(DISTINCT ocl.cancelled_by) as unique_cancellers,
        SUM(CASE WHEN ocl.approved_by IS NOT NULL THEN 1 ELSE 0 END) as approved_cancellations
       ${baseFrom} ${whereClause}`,
      params
    );
    const sr = summaryRows[0];

    // ─── 2. By-reason breakdown (over all filtered) ───
    const [reasonBreakdown] = await pool.query(
      `SELECT 
        COALESCE(ocl.reason_text, 'No reason provided') as reason,
        COUNT(*) as count,
        SUM(CASE WHEN ocl.cancel_type = 'full_order' THEN o.total_amount 
             WHEN oi.id IS NOT NULL THEN oi.total_price ELSE 0 END) as total_amount
       ${baseFrom} ${whereClause}
       GROUP BY COALESCE(ocl.reason_text, 'No reason provided')
       ORDER BY count DESC`,
      params
    );

    // ─── 3. By-staff breakdown (who cancelled the most) ───
    const [staffBreakdown] = await pool.query(
      `SELECT 
        u_cancel.name as staff_name,
        COUNT(*) as cancel_count,
        SUM(CASE WHEN ocl.cancel_type = 'full_order' THEN 1 ELSE 0 END) as order_cancels,
        SUM(CASE WHEN ocl.cancel_type != 'full_order' THEN 1 ELSE 0 END) as item_cancels,
        SUM(CASE WHEN ocl.cancel_type = 'full_order' THEN o.total_amount
             WHEN oi.id IS NOT NULL THEN oi.total_price ELSE 0 END) as total_amount
       ${baseFrom} ${whereClause}
       GROUP BY ocl.cancelled_by, u_cancel.name
       ORDER BY cancel_count DESC`,
      params
    );

    // ─── 4. By cancel_type breakdown ───
    const [typeBreakdown] = await pool.query(
      `SELECT 
        ocl.cancel_type,
        COUNT(*) as count,
        SUM(CASE WHEN ocl.cancel_type = 'full_order' THEN o.total_amount
             WHEN oi.id IS NOT NULL THEN oi.total_price ELSE 0 END) as total_amount
       ${baseFrom} ${whereClause}
       GROUP BY ocl.cancel_type
       ORDER BY count DESC`,
      params
    );

    // ─── 5. Hourly distribution ───
    const [hourlyBreakdown] = await pool.query(
      `SELECT 
        HOUR(ocl.created_at) as hour,
        COUNT(*) as count
       ${baseFrom} ${whereClause}
       GROUP BY HOUR(ocl.created_at)
       ORDER BY hour`,
      params
    );

    // ─── 6. Daily distribution ───
    const [dailyBreakdown] = await pool.query(
      `SELECT 
        ${toISTDate('ocl.created_at')} as date,
        COUNT(*) as count,
        SUM(CASE WHEN ocl.cancel_type = 'full_order' THEN 1 ELSE 0 END) as order_cancels,
        SUM(CASE WHEN ocl.cancel_type != 'full_order' THEN 1 ELSE 0 END) as item_cancels,
        SUM(CASE WHEN ocl.cancel_type = 'full_order' THEN o.total_amount
             WHEN oi.id IS NOT NULL THEN oi.total_price ELSE 0 END) as total_amount
       ${baseFrom} ${whereClause}
       GROUP BY ${toISTDate('ocl.created_at')}
       ORDER BY date`,
      params
    );

    // ─── 7. Floor-wise breakdown ───
    const [floorBreakdown] = await pool.query(
      `SELECT 
        COALESCE(f.name, 'No Floor') as floor_name,
        COUNT(*) as count,
        SUM(CASE WHEN ocl.cancel_type = 'full_order' THEN o.total_amount
             WHEN oi.id IS NOT NULL THEN oi.total_price ELSE 0 END) as total_amount
       ${baseFrom} ${whereClause}
       GROUP BY f.name
       ORDER BY count DESC`,
      params
    );

    const fullOrderAmt = parseFloat(sr.full_order_cancel_amount) || 0;
    const itemCancelAmt = parseFloat(sr.item_cancel_amount) || 0;
    const qtyReduceAmt = parseFloat(sr.quantity_reduce_amount) || 0;

    const summary = {
      dateRange: { start, end },
      totalCancellations: parseInt(sr.total_cancellations) || 0,
      fullOrderCancellations: parseInt(sr.full_order_cancellations) || 0,
      itemCancellations: parseInt(sr.item_cancellations) || 0,
      quantityReductions: parseInt(sr.quantity_reductions) || 0,
      uniqueOrdersAffected: parseInt(sr.unique_orders_affected) || 0,
      totalCancelAmount: parseFloat((fullOrderAmt + itemCancelAmt + qtyReduceAmt).toFixed(2)),
      fullOrderCancelAmount: parseFloat(fullOrderAmt.toFixed(2)),
      itemCancelAmount: parseFloat(itemCancelAmt.toFixed(2)),
      quantityReduceAmount: parseFloat(qtyReduceAmt.toFixed(2)),
      totalRefundAmount: parseFloat((parseFloat(sr.total_refund_amount) || 0).toFixed(2)),
      uniqueCancellers: parseInt(sr.unique_cancellers) || 0,
      approvedCancellations: parseInt(sr.approved_cancellations) || 0,
      byReason: reasonBreakdown.map(r => ({
        reason: r.reason,
        count: parseInt(r.count),
        totalAmount: parseFloat((parseFloat(r.total_amount) || 0).toFixed(2))
      })),
      byStaff: staffBreakdown.map(r => ({
        staffName: r.staff_name || 'Unknown',
        cancelCount: parseInt(r.cancel_count),
        orderCancels: parseInt(r.order_cancels),
        itemCancels: parseInt(r.item_cancels),
        totalAmount: parseFloat((parseFloat(r.total_amount) || 0).toFixed(2))
      })),
      byType: typeBreakdown.map(r => ({
        cancelType: r.cancel_type,
        count: parseInt(r.count),
        totalAmount: parseFloat((parseFloat(r.total_amount) || 0).toFixed(2))
      })),
      byHour: hourlyBreakdown.map(r => ({
        hour: parseInt(r.hour),
        count: parseInt(r.count)
      })),
      byDate: dailyBreakdown.map(r => ({
        date: r.date,
        count: parseInt(r.count),
        orderCancels: parseInt(r.order_cancels),
        itemCancels: parseInt(r.item_cancels),
        totalAmount: parseFloat((parseFloat(r.total_amount) || 0).toFixed(2))
      })),
      byFloor: floorBreakdown.map(r => ({
        floorName: r.floor_name,
        count: parseInt(r.count),
        totalAmount: parseFloat((parseFloat(r.total_amount) || 0).toFixed(2))
      }))
    };

    // ─── 8. Paginated cancel log entries ───
    const sortColumn = sortBy === 'cancelled_amount'
      ? 'CASE WHEN ocl.cancel_type = \'full_order\' THEN o.total_amount WHEN oi.id IS NOT NULL THEN oi.total_price ELSE 0 END'
      : sortBy === 'order_number' ? 'o.order_number' : 'ocl.created_at';

    const [logs] = await pool.query(
      `SELECT 
        ocl.id as log_id,
        ocl.order_id, ocl.order_item_id, ocl.cancel_type,
        ocl.original_quantity, ocl.cancelled_quantity,
        ocl.reason_id, ocl.reason_text, ocl.refund_amount,
        ocl.created_at as cancelled_at,
        o.order_number, o.order_type, o.status as order_status,
        o.total_amount as order_total, o.subtotal as order_subtotal,
        o.tax_amount as order_tax, o.discount_amount as order_discount,
        o.guest_count, o.customer_name, o.customer_phone,
        o.created_at as order_created_at, o.cancelled_at as order_cancelled_at,
        o.cancel_reason as order_cancel_reason,
        t.table_number, t.name as table_name,
        f.name as floor_name,
        u_cancel.name as cancelled_by_name,
        u_approve.name as approved_by_name,
        u_captain.name as captain_name,
        u_cashier.name as cashier_name,
        oi.item_name, oi.variant_name, oi.item_type,
        oi.quantity as current_quantity, oi.unit_price, oi.base_price,
        oi.total_price as item_total_price, oi.tax_amount as item_tax,
        oi.discount_amount as item_discount, oi.status as item_status,
        oi.cancel_reason as item_cancel_reason, oi.cancel_quantity as item_cancel_quantity,
        oi.kot_id
       ${baseFrom} ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    if (logs.length === 0) {
      return {
        dateRange: { start, end },
        cancellations: [],
        pagination: { page, limit, totalCount, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
        filters: this._cancelDetailFilters(options),
        summary
      };
    }

    // ─── 9. Batch-fetch KOT details for item cancellations ───
    const kotIds = [...new Set(logs.filter(l => l.kot_id).map(l => l.kot_id))];
    let kotMap = {};
    if (kotIds.length > 0) {
      const [kots] = await pool.query(
        `SELECT id, kot_number, station, status, created_at FROM kot_tickets WHERE id IN (?)`,
        [kotIds]
      );
      for (const k of kots) {
        kotMap[k.id] = {
          kotNumber: k.kot_number,
          station: k.station,
          status: k.status,
          createdAt: k.created_at
        };
      }
    }

    // ─── 10. For full_order cancellations, batch-fetch items that were in those orders ───
    const fullOrderIds = [...new Set(logs.filter(l => l.cancel_type === 'full_order').map(l => l.order_id))];
    let orderItemsMap = {};
    if (fullOrderIds.length > 0) {
      const [orderItems] = await pool.query(
        `SELECT 
          oi.order_id, oi.item_name, oi.variant_name, oi.item_type,
          oi.quantity, oi.unit_price, oi.total_price, oi.tax_amount,
          oi.status, oi.cancel_reason,
          c.name as category_name
         FROM order_items oi
         LEFT JOIN items i ON oi.item_id = i.id
         LEFT JOIN categories c ON i.category_id = c.id
         WHERE oi.order_id IN (?)
         ORDER BY oi.order_id, oi.created_at`,
        [fullOrderIds]
      );
      for (const item of orderItems) {
        if (!orderItemsMap[item.order_id]) orderItemsMap[item.order_id] = [];
        orderItemsMap[item.order_id].push({
          itemName: item.item_name,
          variantName: item.variant_name || null,
          itemType: item.item_type,
          categoryName: item.category_name || null,
          quantity: parseFloat(item.quantity),
          unitPrice: parseFloat(item.unit_price) || 0,
          totalPrice: parseFloat(item.total_price) || 0,
          taxAmount: parseFloat(item.tax_amount) || 0,
          status: item.status,
          cancelReason: item.cancel_reason || null
        });
      }
    }

    // ─── 11. Build detailed cancellation list ───
    const cancellations = logs.map(log => {
      const cancelledAmount = log.cancel_type === 'full_order'
        ? parseFloat(log.order_total) || 0
        : log.cancel_type === 'quantity_reduce'
          ? (parseFloat(log.cancelled_quantity) || 0) * (parseFloat(log.unit_price) || 0)
          : parseFloat(log.item_total_price) || 0;

      const entry = {
        logId: log.log_id,
        cancelType: log.cancel_type,
        cancelledAt: log.cancelled_at,
        cancelledAmount: parseFloat(cancelledAmount.toFixed(2)),
        reasonText: log.reason_text || log.item_cancel_reason || log.order_cancel_reason || null,
        refundAmount: parseFloat(log.refund_amount) || 0,

        // Who
        cancelledByName: log.cancelled_by_name || null,
        approvedByName: log.approved_by_name || null,
        captainName: log.captain_name || null,
        cashierName: log.cashier_name || null,

        // Order context
        orderId: log.order_id,
        orderNumber: log.order_number,
        orderType: log.order_type,
        orderStatus: log.order_status,
        orderTotal: parseFloat(log.order_total) || 0,
        orderCreatedAt: log.order_created_at,
        customerName: log.customer_name || null,
        customerPhone: log.customer_phone || null,
        guestCount: log.guest_count || 0,

        // Location
        floorName: log.floor_name || null,
        tableNumber: log.table_number || null,
        tableName: log.table_name || null
      };

      if (log.cancel_type === 'full_order') {
        // Full order cancellation — include all items that were in the order
        entry.orderCancelReason = log.order_cancel_reason || null;
        entry.orderCancelledAt = log.order_cancelled_at || null;
        entry.orderSubtotal = parseFloat(log.order_subtotal) || 0;
        entry.orderTax = parseFloat(log.order_tax) || 0;
        entry.orderDiscount = parseFloat(log.order_discount) || 0;
        entry.items = orderItemsMap[log.order_id] || [];
        entry.itemCount = entry.items.length;
      } else {
        // Item-level cancellation
        entry.itemName = log.item_name || null;
        entry.variantName = log.variant_name || null;
        entry.itemType = log.item_type || null;
        entry.originalQuantity = parseFloat(log.original_quantity) || 0;
        entry.cancelledQuantity = parseFloat(log.cancelled_quantity) || 0;
        entry.currentQuantity = parseFloat(log.current_quantity) || 0;
        entry.unitPrice = parseFloat(log.unit_price) || 0;
        entry.itemTotalPrice = parseFloat(log.item_total_price) || 0;
        entry.itemTax = parseFloat(log.item_tax) || 0;
        entry.itemDiscount = parseFloat(log.item_discount) || 0;
        entry.itemStatus = log.item_status || null;

        // KOT info
        if (log.kot_id && kotMap[log.kot_id]) {
          entry.kot = kotMap[log.kot_id];
        }
      }

      return entry;
    });

    return {
      dateRange: { start, end },
      cancellations,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: this._cancelDetailFilters(options),
      summary
    };
  },

  _cancelDetailFilters(options = {}) {
    const f = {};
    if (options.search) f.search = options.search;
    if (options.cancelType) f.cancelType = options.cancelType;
    if (options.cancelledByName) f.cancelledByName = options.cancelledByName;
    if (options.approvedByName) f.approvedByName = options.approvedByName;
    if (options.captainName) f.captainName = options.captainName;
    if (options.cashierName) f.cashierName = options.cashierName;
    if (options.orderType) f.orderType = options.orderType;
    if (options.floorName) f.floorName = options.floorName;
    if (options.tableNumber) f.tableNumber = options.tableNumber;
    if (options.sortBy) f.sortBy = options.sortBy;
    if (options.sortOrder) f.sortOrder = options.sortOrder;
    return f;
  },

  _emptyCancelDetailSummary() {
    return {
      dateRange: { start: null, end: null },
      totalCancellations: 0,
      fullOrderCancellations: 0,
      itemCancellations: 0,
      quantityReductions: 0,
      uniqueOrdersAffected: 0,
      totalCancelAmount: 0,
      fullOrderCancelAmount: 0,
      itemCancelAmount: 0,
      quantityReduceAmount: 0,
      totalRefundAmount: 0,
      uniqueCancellers: 0,
      approvedCancellations: 0,
      byReason: [],
      byStaff: [],
      byType: [],
      byHour: [],
      byDate: [],
      byFloor: []
    };
  },

  // ========================
  // DASHBOARD STATS
  // ========================

  /**
   * Get live dashboard stats
   */
  async getLiveDashboard(outletId, floorIds = []) {
    const pool = getPool();
    const today = getLocalDate();
    const ff = floorFilter(floorIds);
    const ffT = floorFilter(floorIds, 't');

    // Today's sales - use paid_amount for completed orders for accurate sales
    const [todaySales] = await pool.query(
      `SELECT 
        COUNT(*) as total_orders,
        SUM(guest_count) as total_guests,
        SUM(CASE WHEN status != 'cancelled' THEN (subtotal - discount_amount) ELSE 0 END) as net_sales,
        COUNT(CASE WHEN status NOT IN ('paid', 'completed', 'cancelled') THEN 1 END) as active_orders,
        COUNT(CASE WHEN is_nc = 1 THEN 1 END) as nc_orders,
        SUM(CASE WHEN status != 'cancelled' THEN COALESCE(nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN status != 'cancelled' THEN COALESCE(due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN status != 'cancelled' THEN COALESCE(paid_amount, 0) ELSE 0 END) as paid_amount
       FROM orders o
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} = ?${ff.sql}`,
      [outletId, today, ...ff.params]
    );

    // Active tables
    const [activeTables] = await pool.query(
      `SELECT COUNT(*) as count FROM tables t WHERE t.outlet_id = ? AND t.status = 'occupied'${ffT.sql}`,
      [outletId, ...ffT.params]
    );

    // Pending KOTs by station
    const [pendingKots] = await pool.query(
      `SELECT 
        kt.station,
        COUNT(*) as count
       FROM kot_tickets kt
       JOIN orders o ON kt.order_id = o.id
       WHERE kt.outlet_id = ? AND kt.status NOT IN ('served', 'cancelled') AND ${toISTDate('kt.created_at')} = ?${ff.sql}
       GROUP BY kt.station`,
      [outletId, today, ...ff.params]
    );

    // Payment breakdown
    const [payments] = await pool.query(
      `SELECT 
        p.payment_mode,
        SUM(p.total_amount) as amount
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       WHERE p.outlet_id = ? AND ${toISTDate('p.created_at')} = ? AND p.status = 'completed'${ff.sql}
       GROUP BY p.payment_mode`,
      [outletId, today, ...ff.params]
    );

    return {
      date: today,
      sales: todaySales[0],
      activeTables: activeTables[0].count,
      pendingKots: pendingKots.reduce((obj, k) => { obj[k.station] = k.count; return obj; }, {}),
      paymentBreakdown: payments.reduce((obj, p) => { obj[p.payment_mode] = p.amount; return obj; }, {})
    };
  },

  // ========================
  // DETAILED DAILY SALES REPORT
  // ========================

  /**
   * Detailed daily sales — per-order breakdown with items, captain, cashier, tax, payments, timestamps
   * Supports: filters, search, pagination, sorting
   *
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options
   * @param {number}  options.page          - 1-indexed page (default 1)
   * @param {number}  options.limit         - items per page (default 50, max 200)
   * @param {string}  options.search        - search in order_number, customer_name, customer_phone
   * @param {string}  options.orderType     - dine_in | takeaway | delivery
   * @param {string}  options.status        - pending|confirmed|preparing|ready|served|billed|paid|completed|cancelled
   * @param {string}  options.paymentStatus - pending | partial | paid
   * @param {string}  options.captainName   - partial match on captain name
   * @param {string}  options.cashierName   - partial match on cashier name
   * @param {string}  options.floorName     - partial match on floor name
   * @param {number}  options.tableNumber   - exact table number
   * @param {string}  options.sortBy        - created_at | total_amount | order_number (default created_at)
   * @param {string}  options.sortOrder     - ASC | DESC (default DESC)
   */
  async getDailySalesDetail(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);

    // Parse options
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (options.search || '').trim();
    const orderType = (options.orderType || '').trim();
    const status = (options.status || '').trim();
    const paymentStatus = (options.paymentStatus || '').trim();
    const captainName = (options.captainName || '').trim();
    const cashierName = (options.cashierName || '').trim();
    const floorName = (options.floorName || '').trim();
    const tableNumber = (options.tableNumber || '').trim() || null;

    const allowedSort = ['created_at', 'total_amount', 'order_number', 'subtotal', 'tax_amount'];
    const sortBy = allowedSort.includes(options.sortBy) ? options.sortBy : 'created_at';
    const sortOrder = (options.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Build dynamic WHERE
    const baseFrom = `FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_biller ON o.billed_by = u_biller.id
       LEFT JOIN users u_cancel ON o.cancelled_by = u_cancel.id`;

    let conditions = ['o.outlet_id = ?', `${toISTDate('o.created_at')} BETWEEN ? AND ?`];
    let params = [outletId, start, end];

    // Floor restriction for assigned-floor users
    if (options.floorIds && options.floorIds.length > 0) {
      conditions.push(`o.floor_id IN (${options.floorIds.map(() => '?').join(',')})`);
      params.push(...options.floorIds);
    }

    if (orderType) { conditions.push('o.order_type = ?'); params.push(orderType); }
    if (status) { conditions.push('o.status = ?'); params.push(status); }
    if (paymentStatus) { conditions.push('o.payment_status = ?'); params.push(paymentStatus); }
    if (captainName) { conditions.push('u_captain.name LIKE ?'); params.push(`%${captainName}%`); }
    if (cashierName) { conditions.push('u_biller.name LIKE ?'); params.push(`%${cashierName}%`); }
    if (floorName) { conditions.push('f.name LIKE ?'); params.push(`%${floorName}%`); }
    if (tableNumber) { conditions.push('t.table_number = ?'); params.push(tableNumber); }
    if (search) {
      conditions.push('(o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // 0. Total count (for pagination metadata)
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total ${baseFrom} ${whereClause}`,
      params
    );
    const totalCount = countResult[0].total;

    if (totalCount === 0) {
      return {
        dateRange: { start, end },
        orders: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false },
        filters: this._activeFilters(options),
        summary: this._emptyDetailSummary()
      };
    }

    const totalPages = Math.ceil(totalCount / limit);

    // 1. Summary aggregation over ALL filtered orders (not paginated)
    const [summaryRows] = await pool.query(
      `SELECT
        COUNT(*) as total_orders,
        SUM(CASE WHEN o.status IN ('paid','completed') THEN 1 ELSE 0 END) as completed_orders,
        SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN o.status NOT IN ('paid','completed','cancelled') THEN 1 ELSE 0 END) as active_orders,
        SUM(CASE WHEN o.order_type = 'dine_in' THEN 1 ELSE 0 END) as dine_in_count,
        SUM(CASE WHEN o.order_type = 'takeaway' THEN 1 ELSE 0 END) as takeaway_count,
        SUM(CASE WHEN o.order_type = 'delivery' THEN 1 ELSE 0 END) as delivery_count,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal + o.tax_amount) ELSE 0 END) as gross_sales,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.discount_amount ELSE 0 END) as total_discount,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.tax_amount ELSE 0 END) as total_tax,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as net_sales,
        0 as nc_orders_placeholder,
        0 as nc_amount_placeholder
       ${baseFrom} ${whereClause}`,
      params
    );
    const sr = summaryRows[0];

    // Payment summary over all filtered orders
    const [paymentSummary] = await pool.query(
      `SELECT p.payment_mode, SUM(p.total_amount) as total, SUM(p.tip_amount) as tips
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_biller ON o.billed_by = u_biller.id
       LEFT JOIN users u_cancel ON o.cancelled_by = u_cancel.id
       ${whereClause} AND p.status = 'completed'
       GROUP BY p.payment_mode`,
      params
    );
    const paymentModeBreakdown = {};
    let totalPaidAll = 0, totalTipsAll = 0;
    for (const pm of paymentSummary) {
      const amt = parseFloat(pm.total) || 0;
      paymentModeBreakdown[pm.payment_mode] = parseFloat(amt.toFixed(2));
      totalPaidAll += amt;
      totalTipsAll += parseFloat(pm.tips) || 0;
    }

    const completedCount = parseInt(sr.completed_orders) || 0;
    const netSales = parseFloat(sr.net_sales) || 0;

    // NC summary — compute from order_items (item-level is_nc) since orders table may not be updated
    const [ncSummaryRows] = await pool.query(
      `SELECT 
        COUNT(DISTINCT oi.order_id) as nc_orders,
        SUM(oi.total_price) as nc_amount
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_biller ON o.billed_by = u_biller.id
       LEFT JOIN users u_cancel ON o.cancelled_by = u_cancel.id
       ${whereClause}
       AND oi.is_nc = 1 AND oi.status != 'cancelled'`,
      params
    );
    const ncSr = ncSummaryRows[0] || {};

    // Cost/Profit aggregates from order_item_costs
    const [costSummaryRows] = await pool.query(
      `SELECT COALESCE(SUM(oic.making_cost), 0) as making_cost,
              COALESCE(SUM(oic.profit), 0) as profit
       FROM order_item_costs oic
       JOIN orders o ON oic.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_biller ON o.billed_by = u_biller.id
       LEFT JOIN users u_cancel ON o.cancelled_by = u_cancel.id
       ${whereClause} AND o.status IN ('paid','completed')`,
      params
    );
    const costSr = costSummaryRows[0] || {};
    const totalMakingCost = parseFloat(costSr.making_cost) || 0;
    const totalProfit = parseFloat(costSr.profit) || 0;
    const foodCostPct = netSales > 0 ? parseFloat(((totalMakingCost / netSales) * 100).toFixed(2)) : 0;

    // Wastage aggregates from wastage_logs
    const [wastageSummaryRows] = await pool.query(
      `SELECT COUNT(*) as wastage_count, COALESCE(SUM(wl.total_cost), 0) as wastage_cost
       FROM wastage_logs wl
       WHERE wl.outlet_id = ? AND wl.wastage_date BETWEEN ? AND ?`,
      [outletId, start, end]
    );
    const wastageSr = wastageSummaryRows[0] || {};
    const totalWastageCount = parseInt(wastageSr.wastage_count) || 0;
    const totalWastageCost = parseFloat(wastageSr.wastage_cost) || 0;

    const summary = {
      dateRange: { start, end },
      totalOrders: parseInt(sr.total_orders) || 0,
      completedOrders: completedCount,
      cancelledOrders: parseInt(sr.cancelled_orders) || 0,
      activeOrders: parseInt(sr.active_orders) || 0,
      orderTypeBreakdown: {
        dine_in: parseInt(sr.dine_in_count) || 0,
        takeaway: parseInt(sr.takeaway_count) || 0,
        delivery: parseInt(sr.delivery_count) || 0
      },
      grossSales: parseFloat((parseFloat(sr.gross_sales) || 0).toFixed(2)),
      totalDiscount: parseFloat((parseFloat(sr.total_discount) || 0).toFixed(2)),
      totalTax: parseFloat((parseFloat(sr.total_tax) || 0).toFixed(2)),
      netSales: parseFloat(netSales.toFixed(2)),
      ncOrders: parseInt(ncSr.nc_orders) || 0,
      ncAmount: parseFloat((parseFloat(ncSr.nc_amount) || 0).toFixed(2)),
      totalPaid: parseFloat(totalPaidAll.toFixed(2)),
      totalTips: parseFloat(totalTipsAll.toFixed(2)),
      makingCost: parseFloat(totalMakingCost.toFixed(2)),
      profit: parseFloat(totalProfit.toFixed(2)),
      foodCostPercentage: foodCostPct,
      wastageCount: totalWastageCount,
      wastageCost: parseFloat(totalWastageCost.toFixed(2)),
      averageOrderValue: completedCount > 0 ? parseFloat((netSales / completedCount).toFixed(2)) : 0,
      paymentModeBreakdown
    };

    // 2. Paginated orders
    const orderSelect = `SELECT 
        o.id, o.order_number, o.order_type, o.status, o.payment_status,
        o.subtotal, o.discount_amount, o.tax_amount, o.service_charge,
        o.packaging_charge, o.delivery_charge, o.round_off,
        o.total_amount, o.paid_amount, o.due_amount,
        o.guest_count, o.customer_name, o.customer_phone,
        o.table_id, o.is_complimentary, o.is_priority,
        o.special_instructions, o.cancel_reason,
        o.created_by, o.billed_by, o.cancelled_by,
        o.created_at, o.billed_at, o.cancelled_at, o.updated_at,
        t.table_number, t.name as table_name,
        f.name as floor_name,
        u_captain.name as captain_name,
        u_biller.name as cashier_name,
        u_cancel.name as cancelled_by_name`;

    const [orders] = await pool.query(
      `${orderSelect} ${baseFrom} ${whereClause} ORDER BY o.${sortBy} ${sortOrder} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    if (orders.length === 0) {
      return {
        dateRange: { start, end },
        orders: [],
        pagination: { page, limit, totalCount, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
        filters: this._activeFilters(options),
        summary
      };
    }

    const orderIds = orders.map(o => o.id);

    // 3. All items for these orders (batch)
    const [items] = await pool.query(
      `SELECT 
        oi.id, oi.order_id, oi.item_id, oi.item_name, oi.variant_name,
        oi.item_type, oi.quantity, oi.unit_price, oi.base_price,
        oi.discount_amount, oi.tax_amount, oi.total_price,
        oi.status, oi.special_instructions, oi.tax_details,
        oi.is_complimentary, oi.complimentary_reason,
        oi.is_nc, oi.nc_amount, oi.nc_reason,
        oi.cancelled_by, oi.cancelled_at, oi.cancel_reason,
        oi.created_at,
        u.name as cancelled_by_name,
        c.name as category_name,
        ks.name as station_name,
        oic.making_cost, oic.profit as item_profit,
        oic.food_cost_percentage as item_food_cost_pct
       FROM order_items oi
       LEFT JOIN users u ON oi.cancelled_by = u.id
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
       LEFT JOIN order_item_costs oic ON oic.order_item_id = oi.id
       WHERE oi.order_id IN (?)
       ORDER BY oi.order_id, oi.created_at`,
      [orderIds]
    );

    // 4. All addons for these items (batch)
    const itemIds = items.map(i => i.id);
    let addonsMap = {};
    if (itemIds.length > 0) {
      const [addons] = await pool.query(
        `SELECT oia.order_item_id, oia.addon_name, oia.unit_price, oia.total_price, oia.quantity
         FROM order_item_addons oia
         WHERE oia.order_item_id IN (?)`,
        [itemIds]
      );
      for (const a of addons) {
        if (!addonsMap[a.order_item_id]) addonsMap[a.order_item_id] = [];
        addonsMap[a.order_item_id].push({
          addonName: a.addon_name,
          unitPrice: parseFloat(a.unit_price) || 0,
          totalPrice: parseFloat(a.total_price) || 0,
          quantity: parseInt(a.quantity) || 1
        });
      }
    }

    // 5. All payments for these orders (batch)
    const [payments] = await pool.query(
      `SELECT 
        p.order_id, p.payment_mode, p.amount, p.tip_amount, p.total_amount,
        p.status, p.transaction_id, p.reference_number,
        p.card_last_four, p.card_type, p.upi_id, p.wallet_name,
        p.created_at,
        u.name as received_by_name
       FROM payments p
       LEFT JOIN users u ON p.received_by = u.id
       WHERE p.order_id IN (?) AND p.status = 'completed'
       ORDER BY p.created_at`,
      [orderIds]
    );

    // 6. All invoices for these orders (batch)
    const [invoices] = await pool.query(
      `SELECT 
        inv.order_id, inv.invoice_number, inv.invoice_date, inv.invoice_time,
        inv.subtotal, inv.discount_amount, inv.taxable_amount,
        inv.cgst_amount, inv.sgst_amount, inv.igst_amount, inv.vat_amount,
        inv.cess_amount, inv.total_tax, inv.service_charge,
        inv.packaging_charge, inv.delivery_charge, inv.round_off,
        inv.grand_total, inv.payment_status, inv.tax_breakup,
        inv.is_cancelled
       FROM invoices inv
       WHERE inv.order_id IN (?) AND inv.is_cancelled = 0`,
      [orderIds]
    );

    // 7. All discounts for these orders (batch)
    const [discounts] = await pool.query(
      `SELECT 
        od.order_id, od.discount_name, od.discount_type, od.discount_value,
        od.discount_amount, od.discount_code, od.applied_on,
        u.name as created_by_name
       FROM order_discounts od
       LEFT JOIN users u ON od.created_by = u.id
       WHERE od.order_id IN (?)`,
      [orderIds]
    );

    // Build lookup maps
    const itemsByOrder = {};
    for (const it of items) {
      if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = [];

      let taxDetails = null;
      if (it.tax_details) {
        try {
          taxDetails = typeof it.tax_details === 'string' ? JSON.parse(it.tax_details) : it.tax_details;
        } catch (e) { /* ignore */ }
      }

      itemsByOrder[it.order_id].push({
        id: it.id,
        itemName: it.item_name,
        variantName: it.variant_name || null,
        itemType: it.item_type,
        categoryName: it.category_name || null,
        stationName: it.station_name || null,
        quantity: parseFloat(it.quantity),
        unitPrice: parseFloat(it.unit_price) || 0,
        discountAmount: parseFloat(it.discount_amount) || 0,
        taxAmount: parseFloat(it.tax_amount) || 0,
        totalPrice: parseFloat(it.total_price) || 0,
        makingCost: parseFloat(it.making_cost) || 0,
        itemProfit: parseFloat(it.item_profit) || 0,
        foodCostPercentage: parseFloat(it.item_food_cost_pct) || 0,
        status: it.status,
        specialInstructions: it.special_instructions || null,
        taxDetails,
        isComplimentary: !!it.is_complimentary,
        complimentaryReason: it.complimentary_reason || null,
        isNC: !!it.is_nc,
        ncAmount: parseFloat(it.nc_amount) || 0,
        ncReason: it.nc_reason || null,
        cancelReason: it.cancel_reason || null,
        cancelledByName: it.cancelled_by_name || null,
        cancelledAt: it.cancelled_at || null,
        addons: addonsMap[it.id] || [],
        createdAt: it.created_at
      });
    }

    const paymentsByOrder = {};
    for (const p of payments) {
      if (!paymentsByOrder[p.order_id]) paymentsByOrder[p.order_id] = [];
      paymentsByOrder[p.order_id].push({
        paymentMode: p.payment_mode,
        amount: parseFloat(p.amount) || 0,
        tipAmount: parseFloat(p.tip_amount) || 0,
        totalAmount: parseFloat(p.total_amount) || 0,
        transactionId: p.transaction_id || null,
        referenceNumber: p.reference_number || null,
        cardLastFour: p.card_last_four || null,
        cardType: p.card_type || null,
        upiId: p.upi_id || null,
        walletName: p.wallet_name || null,
        receivedByName: p.received_by_name || null,
        createdAt: p.created_at
      });
    }

    const invoiceByOrder = {};
    for (const inv of invoices) {
      let taxBreakup = null;
      if (inv.tax_breakup) {
        try {
          taxBreakup = typeof inv.tax_breakup === 'string' ? JSON.parse(inv.tax_breakup) : inv.tax_breakup;
        } catch (e) { /* ignore */ }
      }
      invoiceByOrder[inv.order_id] = {
        invoiceNumber: inv.invoice_number,
        invoiceDate: inv.invoice_date,
        invoiceTime: inv.invoice_time,
        subtotal: parseFloat(inv.subtotal) || 0,
        discountAmount: parseFloat(inv.discount_amount) || 0,
        taxableAmount: parseFloat(inv.taxable_amount) || 0,
        cgstAmount: parseFloat(inv.cgst_amount) || 0,
        sgstAmount: parseFloat(inv.sgst_amount) || 0,
        igstAmount: parseFloat(inv.igst_amount) || 0,
        vatAmount: parseFloat(inv.vat_amount) || 0,
        cessAmount: parseFloat(inv.cess_amount) || 0,
        totalTax: parseFloat(inv.total_tax) || 0,
        serviceCharge: parseFloat(inv.service_charge) || 0,
        packagingCharge: parseFloat(inv.packaging_charge) || 0,
        deliveryCharge: parseFloat(inv.delivery_charge) || 0,
        roundOff: parseFloat(inv.round_off) || 0,
        grandTotal: parseFloat(inv.grand_total) || 0,
        paymentStatus: inv.payment_status,
        taxBreakup
      };
    }

    const discountsByOrder = {};
    for (const d of discounts) {
      if (!discountsByOrder[d.order_id]) discountsByOrder[d.order_id] = [];
      discountsByOrder[d.order_id].push({
        discountName: d.discount_name,
        discountType: d.discount_type,
        discountValue: parseFloat(d.discount_value) || 0,
        discountAmount: parseFloat(d.discount_amount) || 0,
        discountCode: d.discount_code || null,
        appliedOn: d.applied_on,
        createdByName: d.created_by_name || null
      });
    }

    // Build detailed order list (current page only)
    const detailedOrders = orders.map(o => {
      const orderItems = itemsByOrder[o.id] || [];
      const orderPayments = paymentsByOrder[o.id] || [];
      const orderInvoice = invoiceByOrder[o.id] || null;
      const orderDiscounts = discountsByOrder[o.id] || [];

      const activeItems = orderItems.filter(i => i.status !== 'cancelled');
      const cancelledItems = orderItems.filter(i => i.status === 'cancelled');
      const itemSubtotal = activeItems.reduce((s, i) => s + i.totalPrice, 0);
      const itemTax = activeItems.reduce((s, i) => s + i.taxAmount, 0);
      const itemDiscount = activeItems.reduce((s, i) => s + i.discountAmount, 0);
      const orderMakingCost = activeItems.reduce((s, i) => s + i.makingCost, 0);
      const orderProfit = activeItems.reduce((s, i) => s + i.itemProfit, 0);
      const orderFoodCostPct = itemSubtotal > 0 ? parseFloat(((orderMakingCost / itemSubtotal) * 100).toFixed(2)) : 0;

      // Compute NC from actual item data (orders table is_nc/nc_amount may not be updated)
      const ncItems = activeItems.filter(i => i.isNC);
      const computedNcAmount = ncItems.reduce((s, i) => s + i.totalPrice, 0);
      const computedIsNc = ncItems.length > 0;
      const ncReasons = [...new Set(ncItems.map(i => i.ncReason).filter(Boolean))];
      const computedNcReason = ncReasons.length > 0 ? ncReasons.join(', ') : null;

      return {
        orderId: o.id,
        orderNumber: o.order_number,
        orderType: o.order_type,
        status: o.status,
        paymentStatus: o.payment_status,

        // People
        captainName: o.captain_name || null,
        cashierName: o.cashier_name || null,
        customerName: o.customer_name || null,
        customerPhone: o.customer_phone || null,
        cancelledByName: o.cancelled_by_name || null,

        // Table info
        tableNumber: o.table_number || null,
        tableName: o.table_name || null,
        floorName: o.floor_name || null,
        guestCount: o.guest_count || 0,

        // Amounts - use paid_amount for completed orders as displayAmount
        subtotal: parseFloat(o.subtotal) || 0,
        discountAmount: parseFloat(o.discount_amount) || 0,
        taxAmount: parseFloat(o.tax_amount) || 0,
        serviceCharge: parseFloat(o.service_charge) || 0,
        packagingCharge: parseFloat(o.packaging_charge) || 0,
        deliveryCharge: parseFloat(o.delivery_charge) || 0,
        roundOff: parseFloat(o.round_off) || 0,
        totalAmount: parseFloat(o.total_amount) || 0,
        paidAmount: parseFloat(o.paid_amount) || 0,
        displayAmount: ['paid', 'completed'].includes(o.status) 
          ? (parseFloat(o.paid_amount) || parseFloat(o.total_amount) || 0) 
          : (parseFloat(o.total_amount) || 0),
        dueAmount: parseFloat(o.due_amount) || 0,

        // Flags
        isComplimentary: !!o.is_complimentary,
        isPriority: !!o.is_priority,
        isNC: computedIsNc,
        ncAmount: parseFloat(computedNcAmount.toFixed(2)),
        ncReason: computedNcReason,
        ncItemCount: ncItems.length,
        cancelReason: o.cancel_reason || null,

        // Timestamps
        createdAt: o.created_at,
        billedAt: o.billed_at || null,
        cancelledAt: o.cancelled_at || null,

        // Items
        items: {
          active: activeItems,
          cancelled: cancelledItems,
          activeCount: activeItems.length,
          cancelledCount: cancelledItems.length,
          totalCount: orderItems.length,
          itemSubtotal: parseFloat(itemSubtotal.toFixed(2)),
          itemTax: parseFloat(itemTax.toFixed(2)),
          itemDiscount: parseFloat(itemDiscount.toFixed(2))
        },

        // Discounts
        discounts: orderDiscounts,

        // Payments
        payments: orderPayments,

        // Cost & Profit
        makingCost: parseFloat(orderMakingCost.toFixed(2)),
        profit: parseFloat(orderProfit.toFixed(2)),
        foodCostPercentage: orderFoodCostPct,

        // Invoice
        invoice: orderInvoice
      };
    });

    return {
      dateRange: { start, end },
      orders: detailedOrders,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: this._activeFilters(options),
      summary
    };
  },

  _activeFilters(options = {}) {
    const f = {};
    if (options.search) f.search = options.search;
    if (options.orderType) f.orderType = options.orderType;
    if (options.status) f.status = options.status;
    if (options.paymentStatus) f.paymentStatus = options.paymentStatus;
    if (options.captainName) f.captainName = options.captainName;
    if (options.cashierName) f.cashierName = options.cashierName;
    if (options.floorName) f.floorName = options.floorName;
    if (options.tableNumber) f.tableNumber = options.tableNumber;
    if (options.sortBy) f.sortBy = options.sortBy;
    if (options.sortOrder) f.sortOrder = options.sortOrder;
    return f;
  },

  /**
   * Detailed Item Sales — per-item breakdown with every order occurrence,
   * table, floor, captain, cashier, addons, tax, timestamps, cancellations
   * Supports: filters, search, pagination, sorting
   *
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options
   * @param {number}  options.page          - 1-indexed page (default 1)
   * @param {number}  options.limit         - items per page (default 50, max 200)
   * @param {string}  options.search        - search in item_name, variant_name, order_number, category_name
   * @param {string}  options.itemType      - veg | non_veg | egg
   * @param {string}  options.categoryName  - partial match on category
   * @param {string}  options.status        - item status filter (cancelled, served, etc.)
   * @param {string}  options.orderType     - dine_in | takeaway | delivery
   * @param {string}  options.floorName     - partial match on floor name
   * @param {number}  options.tableNumber   - exact table number
   * @param {string}  options.captainName   - partial match on captain name
   * @param {string}  options.cashierName   - partial match on cashier name
   * @param {string}  options.sortBy        - total_quantity | gross_revenue | net_revenue | item_name | order_count (default total_quantity)
   * @param {string}  options.sortOrder     - ASC | DESC (default DESC)
   * @param {Array}   options.floorIds      - floor restriction for assigned-floor users
   */
  async getItemSalesDetail(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);

    // Parse options
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const search = (options.search || '').trim();
    const itemType = (options.itemType || '').trim();
    const categoryName = (options.categoryName || '').trim();
    const status = (options.status || '').trim();
    const orderType = (options.orderType || '').trim();
    const floorName = (options.floorName || '').trim();
    const tableNumber = (options.tableNumber || '').trim() || null;
    const captainName = (options.captainName || '').trim();
    const cashierName = (options.cashierName || '').trim();
    const floorIds = options.floorIds || [];

    const allowedSort = ['total_quantity', 'gross_revenue', 'net_revenue', 'item_name', 'order_count'];
    const sortBy = allowedSort.includes(options.sortBy) ? options.sortBy : 'total_quantity';
    const sortOrder = (options.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Build dynamic WHERE
    const baseFrom = `FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors fl ON t.floor_id = fl.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_cashier ON o.billed_by = u_cashier.id
       LEFT JOIN users u_item_cancel ON oi.cancelled_by = u_item_cancel.id
       LEFT JOIN users u_item_creator ON oi.created_by = u_item_creator.id
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
       LEFT JOIN tax_groups tg ON oi.tax_group_id = tg.id
       LEFT JOIN order_item_costs oic ON oic.order_item_id = oi.id`;

    let conditions = ['o.outlet_id = ?', `${toISTDate('o.created_at')} BETWEEN ? AND ?`];
    let params = [outletId, start, end];

    if (floorIds.length > 0) {
      conditions.push(`o.floor_id IN (${floorIds.map(() => '?').join(',')})`);
      params.push(...floorIds);
    }
    if (itemType) { conditions.push('oi.item_type = ?'); params.push(itemType); }
    if (categoryName) { conditions.push('c.name LIKE ?'); params.push(`%${categoryName}%`); }
    if (status) { conditions.push('oi.status = ?'); params.push(status); }
    if (orderType) { conditions.push('o.order_type = ?'); params.push(orderType); }
    if (floorName) { conditions.push('fl.name LIKE ?'); params.push(`%${floorName}%`); }
    if (tableNumber) { conditions.push('t.table_number = ?'); params.push(tableNumber); }
    if (captainName) { conditions.push('u_captain.name LIKE ?'); params.push(`%${captainName}%`); }
    if (cashierName) { conditions.push('u_cashier.name LIKE ?'); params.push(`%${cashierName}%`); }
    if (search) {
      conditions.push('(oi.item_name LIKE ? OR oi.variant_name LIKE ? OR o.order_number LIKE ? OR c.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // 1. Get all filtered order_items
    const [rows] = await pool.query(
      `SELECT 
        oi.id as order_item_id, oi.order_id, oi.item_id, oi.variant_id,
        oi.item_name, oi.variant_name, oi.item_type,
        oi.quantity, oi.unit_price, oi.base_price,
        oi.discount_amount, oi.tax_amount, oi.total_price,
        oi.tax_group_id, oi.tax_details, oi.price_rule_applied,
        oi.special_instructions, oi.status as item_status,
        oi.kot_id, oi.is_complimentary, oi.complimentary_reason,
        oi.cancelled_by, oi.cancelled_at, oi.cancel_reason, oi.cancel_quantity,
        oi.is_nc, oi.nc_reason,
        oi.created_by as item_created_by, oi.created_at as item_created_at,
        o.order_number, o.order_type, o.status as order_status,
        o.payment_status, o.table_id, o.guest_count,
        o.customer_name, o.customer_phone,
        o.is_nc as order_is_nc, o.nc_amount as order_nc_amount, o.nc_reason as order_nc_reason,
        o.created_at as order_created_at, o.billed_at, o.billed_by,
        t.table_number, t.name as table_name,
        fl.name as floor_name,
        u_captain.name as captain_name,
        u_cashier.name as cashier_name,
        u_item_cancel.name as item_cancelled_by_name,
        u_item_creator.name as item_created_by_name,
        c.name as category_name, c.id as category_id,
        ks.name as station_name,
        tg.name as tax_group_name, tg.total_rate as tax_rate,
        oic.making_cost as oic_making_cost, oic.profit as oic_profit,
        oic.food_cost_percentage as oic_food_cost_pct
       ${baseFrom} ${whereClause}
       ORDER BY oi.item_name, oi.variant_name, oi.created_at DESC`,
      params
    );

    if (rows.length === 0) {
      return {
        dateRange: { start, end },
        items: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false },
        filters: this._itemDetailFilters(options),
        summary: this._emptyItemSalesDetailSummary()
      };
    }

    // 2. Batch-fetch addons for all order_items
    const orderItemIds = rows.map(r => r.order_item_id);
    const addonsMap = {};
    if (orderItemIds.length > 0) {
      const [addons] = await pool.query(
        `SELECT oia.order_item_id, oia.addon_name, oia.unit_price, oia.total_price, oia.quantity
         FROM order_item_addons oia
         WHERE oia.order_item_id IN (?)`,
        [orderItemIds]
      );
      for (const a of addons) {
        if (!addonsMap[a.order_item_id]) addonsMap[a.order_item_id] = [];
        addonsMap[a.order_item_id].push({
          addonName: a.addon_name,
          unitPrice: parseFloat(a.unit_price) || 0,
          totalPrice: parseFloat(a.total_price) || 0,
          quantity: parseInt(a.quantity) || 1
        });
      }
    }

    // 3. Group rows by item_id + variant_name (unique item key)
    const itemMap = {};
    // Global summary accumulators
    let globalTotalQty = 0, globalCancelledQty = 0, globalGrossRevenue = 0;
    let globalDiscount = 0, globalTax = 0, globalNetRevenue = 0;
    let globalAddonRevenue = 0, globalComplimentaryCount = 0;
    let globalNcCount = 0, globalNcQuantity = 0, globalNcAmount = 0;
    let globalMakingCost = 0, globalProfit = 0;
    const globalCategoryBreakdown = {};
    const globalTypeBreakdown = {};

    for (const r of rows) {
      const key = `${r.item_id || 0}::${r.variant_name || ''}`;
      const isActive = r.item_status !== 'cancelled';

      let taxDetails = null;
      if (r.tax_details) {
        try { taxDetails = typeof r.tax_details === 'string' ? JSON.parse(r.tax_details) : r.tax_details; } catch (e) {}
      }
      let priceRule = null;
      if (r.price_rule_applied) {
        try { priceRule = typeof r.price_rule_applied === 'string' ? JSON.parse(r.price_rule_applied) : r.price_rule_applied; } catch (e) {}
      }

      const itemAddons = addonsMap[r.order_item_id] || [];
      const addonTotal = itemAddons.reduce((s, a) => s + a.totalPrice, 0);

      // Build the order occurrence record
      const occurrence = {
        orderItemId: r.order_item_id,
        orderId: r.order_id,
        orderNumber: r.order_number,
        orderType: r.order_type,
        orderStatus: r.order_status,
        paymentStatus: r.payment_status,

        // Table & floor
        tableId: r.table_id || null,
        tableNumber: r.table_number || null,
        tableName: r.table_name || null,
        floorName: r.floor_name || null,

        // People
        captainName: r.captain_name || null,
        cashierName: r.cashier_name || null,
        orderedByName: r.item_created_by_name || null,
        customerName: r.customer_name || null,
        customerPhone: r.customer_phone || null,
        guestCount: r.guest_count || 0,

        // Item specifics
        quantity: parseFloat(r.quantity),
        unitPrice: parseFloat(r.unit_price) || 0,
        basePrice: parseFloat(r.base_price) || 0,
        discountAmount: parseFloat(r.discount_amount) || 0,
        taxAmount: parseFloat(r.tax_amount) || 0,
        totalPrice: parseFloat(r.total_price) || 0,
        addonTotal: parseFloat(addonTotal.toFixed(2)),
        addons: itemAddons,

        // Tax
        taxGroupName: r.tax_group_name || null,
        taxRate: r.tax_rate ? parseFloat(r.tax_rate) : null,
        taxDetails,
        priceRuleApplied: priceRule,

        // Status & KOT
        status: r.item_status,
        kotId: r.kot_id || null,
        specialInstructions: r.special_instructions || null,

        // Complimentary
        isComplimentary: !!r.is_complimentary,
        complimentaryReason: r.complimentary_reason || null,

        // NC (No Charge)
        isNc: !!r.is_nc,
        ncReason: r.nc_reason || null,
        orderIsNc: !!r.order_is_nc,
        orderNcAmount: parseFloat(r.order_nc_amount) || 0,
        orderNcReason: r.order_nc_reason || null,

        // Cancellation
        cancelQuantity: parseFloat(r.cancel_quantity || 0),
        cancelReason: r.cancel_reason || null,
        cancelledByName: r.item_cancelled_by_name || null,
        cancelledAt: r.cancelled_at || null,

        // Cost & Profit
        makingCost: parseFloat(r.oic_making_cost) || 0,
        itemProfit: parseFloat(r.oic_profit) || 0,
        foodCostPercentage: parseFloat(r.oic_food_cost_pct) || 0,

        // Timestamps
        itemCreatedAt: r.item_created_at,
        orderCreatedAt: r.order_created_at,
        billedAt: r.billed_at || null,
      };

      if (!itemMap[key]) {
        itemMap[key] = {
          itemId: r.item_id,
          itemName: r.item_name,
          variantId: r.variant_id || null,
          variantName: r.variant_name || null,
          itemType: r.item_type,
          categoryId: r.category_id || null,
          categoryName: r.category_name || null,
          stationName: r.station_name || null,
          // Accumulators
          totalQuantity: 0,
          cancelledQuantity: 0,
          grossRevenue: 0,
          discountAmount: 0,
          taxAmount: 0,
          netRevenue: 0,
          addonRevenue: 0,
          makingCost: 0,
          profit: 0,
          complimentaryCount: 0,
          ncCount: 0,
          ncQuantity: 0,
          ncAmount: 0,
          orderCount: new Set(),
          dineInCount: 0,
          takeawayCount: 0,
          deliveryCount: 0,
          occurrences: []
        };
      }

      const item = itemMap[key];
      item.occurrences.push(occurrence);
      item.orderCount.add(r.order_id);

      if (isActive) {
        const qty = parseFloat(r.quantity);
        const tp = parseFloat(r.total_price) || 0;
        const da = parseFloat(r.discount_amount) || 0;
        const ta = parseFloat(r.tax_amount) || 0;

        item.totalQuantity += qty;
        item.grossRevenue += tp;
        item.discountAmount += da;
        item.taxAmount += ta;
        item.netRevenue += (tp - da);
        item.addonRevenue += addonTotal;
        item.makingCost += parseFloat(r.oic_making_cost) || 0;
        item.profit += parseFloat(r.oic_profit) || 0;

        globalTotalQty += qty;
        globalGrossRevenue += tp;
        globalDiscount += da;
        globalTax += ta;
        globalNetRevenue += (tp - da);
        globalAddonRevenue += addonTotal;
        globalMakingCost += parseFloat(r.oic_making_cost) || 0;
        globalProfit += parseFloat(r.oic_profit) || 0;

        if (r.is_complimentary) {
          item.complimentaryCount++;
          globalComplimentaryCount++;
        }

        if (r.is_nc) {
          item.ncCount++;
          item.ncQuantity += qty;
          item.ncAmount += tp;
          globalNcCount++;
          globalNcQuantity += qty;
          globalNcAmount += tp;
        }

        // Type breakdown
        const type = r.item_type || 'other';
        if (!globalTypeBreakdown[type]) globalTypeBreakdown[type] = { quantity: 0, revenue: 0 };
        globalTypeBreakdown[type].quantity += qty;
        globalTypeBreakdown[type].revenue += tp;
      } else {
        // Use full quantity for cancelled items (matches summary report logic)
        const cq = parseFloat(r.quantity);
        item.cancelledQuantity += cq;
        globalCancelledQty += cq;
      }

      if (r.order_type === 'dine_in') item.dineInCount++;
      else if (r.order_type === 'takeaway') item.takeawayCount++;
      else if (r.order_type === 'delivery') item.deliveryCount++;

      // Category breakdown
      const catName = r.category_name || 'Uncategorized';
      if (!globalCategoryBreakdown[catName]) globalCategoryBreakdown[catName] = { quantity: 0, revenue: 0, itemCount: new Set() };
      if (isActive) {
        globalCategoryBreakdown[catName].quantity += parseFloat(r.quantity);
        globalCategoryBreakdown[catName].revenue += parseFloat(r.total_price) || 0;
      }
      globalCategoryBreakdown[catName].itemCount.add(r.item_id);
    }

    // 4. Finalize items
    const itemsArray = Object.values(itemMap).map(item => {
      const orderCount = item.orderCount.size;
      return {
        itemId: item.itemId,
        itemName: item.itemName,
        variantId: item.variantId,
        variantName: item.variantName,
        itemType: item.itemType,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        stationName: item.stationName,

        // Aggregates
        totalQuantity: parseFloat(item.totalQuantity.toFixed(3)),
        cancelledQuantity: parseFloat(item.cancelledQuantity.toFixed(3)),
        grossRevenue: parseFloat(item.grossRevenue.toFixed(2)),
        discountAmount: parseFloat(item.discountAmount.toFixed(2)),
        taxAmount: parseFloat(item.taxAmount.toFixed(2)),
        netRevenue: parseFloat(item.netRevenue.toFixed(2)),
        addonRevenue: parseFloat(item.addonRevenue.toFixed(2)),
        makingCost: parseFloat(item.makingCost.toFixed(2)),
        profit: parseFloat(item.profit.toFixed(2)),
        foodCostPercentage: item.netRevenue > 0 ? parseFloat(((item.makingCost / item.netRevenue) * 100).toFixed(2)) : 0,
        avgUnitPrice: item.totalQuantity > 0
          ? parseFloat((item.grossRevenue / item.totalQuantity).toFixed(2))
          : 0,
        orderCount,
        complimentaryCount: item.complimentaryCount,
        ncCount: item.ncCount,
        ncQuantity: parseFloat(item.ncQuantity.toFixed(3)),
        ncAmount: parseFloat(item.ncAmount.toFixed(2)),

        // Order type breakdown
        orderTypeBreakdown: {
          dine_in: item.dineInCount,
          takeaway: item.takeawayCount,
          delivery: item.deliveryCount
        },

        // Every occurrence
        occurrenceCount: item.occurrences.length,
        occurrences: item.occurrences
      };
    });

    // Sort by chosen field
    const sortMultiplier = sortOrder === 'ASC' ? 1 : -1;
    itemsArray.sort((a, b) => {
      if (sortBy === 'item_name') return sortMultiplier * (a.itemName || '').localeCompare(b.itemName || '');
      if (sortBy === 'gross_revenue') return sortMultiplier * (a.grossRevenue - b.grossRevenue);
      if (sortBy === 'net_revenue') return sortMultiplier * (a.netRevenue - b.netRevenue);
      if (sortBy === 'order_count') return sortMultiplier * (a.orderCount - b.orderCount);
      return sortMultiplier * (a.totalQuantity - b.totalQuantity); // default: total_quantity
    });

    // Pagination on grouped items
    const totalCount = itemsArray.length;
    const totalPages = Math.ceil(totalCount / limit);
    const offset = (page - 1) * limit;
    const paginatedItems = itemsArray.slice(offset, offset + limit);

    // 5. Finalize category breakdown
    const categoryBreakdown = Object.entries(globalCategoryBreakdown).map(([name, data]) => ({
      categoryName: name,
      totalQuantity: parseFloat(data.quantity.toFixed(3)),
      totalRevenue: parseFloat(data.revenue.toFixed(2)),
      uniqueItems: data.itemCount.size
    })).sort((a, b) => b.totalRevenue - a.totalRevenue);

    // 6. Build summary (over ALL filtered items, not just paginated page)
    const summary = {
      dateRange: { start, end },
      totalUniqueItems: itemsArray.length,
      totalItemsShown: paginatedItems.length,
      totalQuantitySold: parseFloat(globalTotalQty.toFixed(3)),
      totalCancelledQuantity: parseFloat(globalCancelledQty.toFixed(3)),
      grossRevenue: parseFloat(globalGrossRevenue.toFixed(2)),
      totalDiscount: parseFloat(globalDiscount.toFixed(2)),
      totalTax: parseFloat(globalTax.toFixed(2)),
      netRevenue: parseFloat(globalNetRevenue.toFixed(2)),
      addonRevenue: parseFloat(globalAddonRevenue.toFixed(2)),
      complimentaryCount: globalComplimentaryCount,
      ncCount: globalNcCount,
      ncQuantity: parseFloat(globalNcQuantity.toFixed(3)),
      ncAmount: parseFloat(globalNcAmount.toFixed(2)),
      makingCost: parseFloat(globalMakingCost.toFixed(2)),
      profit: parseFloat(globalProfit.toFixed(2)),
      foodCostPercentage: globalNetRevenue > 0 ? parseFloat(((globalMakingCost / globalNetRevenue) * 100).toFixed(2)) : 0,
      avgRevenuePerItem: itemsArray.length > 0
        ? parseFloat((globalNetRevenue / itemsArray.length).toFixed(2))
        : 0,
      itemTypeBreakdown: Object.entries(globalTypeBreakdown).map(([type, data]) => ({
        type,
        quantity: parseFloat(data.quantity.toFixed(3)),
        revenue: parseFloat(data.revenue.toFixed(2))
      })),
      categoryBreakdown
    };

    return {
      dateRange: { start, end },
      items: paginatedItems,
      pagination: {
        page, limit, totalCount, totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: this._itemDetailFilters(options),
      summary
    };
  },

  _itemDetailFilters(options = {}) {
    const f = {};
    if (options.search) f.search = options.search;
    if (options.itemType) f.itemType = options.itemType;
    if (options.categoryName) f.categoryName = options.categoryName;
    if (options.status) f.status = options.status;
    if (options.orderType) f.orderType = options.orderType;
    if (options.captainName) f.captainName = options.captainName;
    if (options.cashierName) f.cashierName = options.cashierName;
    if (options.floorName) f.floorName = options.floorName;
    if (options.tableNumber) f.tableNumber = options.tableNumber;
    if (options.sortBy) f.sortBy = options.sortBy;
    if (options.sortOrder) f.sortOrder = options.sortOrder;
    return f;
  },

  /**
   * Detailed Category Sales — per-category breakdown with items, every order occurrence,
   * table, floor, captain, cashier, addons, tax, timestamps, cancellations
   * Supports: filters, search, pagination, sorting
   *
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options
   * @param {number}  options.page          - 1-indexed page (default 1)
   * @param {number}  options.limit         - categories per page (default 50, max 200)
   * @param {string}  options.search        - search in category_name, item_name, order_number
   * @param {string}  options.itemType      - veg | non_veg | egg
   * @param {string}  options.categoryName  - partial match on category
   * @param {string}  options.status        - item status filter
   * @param {string}  options.orderType     - dine_in | takeaway | delivery
   * @param {string}  options.floorName     - partial match on floor name
   * @param {number}  options.tableNumber   - exact table number
   * @param {string}  options.captainName   - partial match on captain name
   * @param {string}  options.cashierName   - partial match on cashier name
   * @param {string}  options.sortBy        - net_revenue | total_quantity | category_name | order_count (default net_revenue)
   * @param {string}  options.sortOrder     - ASC | DESC (default DESC)
   * @param {Array}   options.floorIds      - floor restriction for assigned-floor users
   */
  async getCategorySalesDetail(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);

    // Parse options
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const search = (options.search || '').trim();
    const itemType = (options.itemType || '').trim();
    const categoryName = (options.categoryName || '').trim();
    const status = (options.status || '').trim();
    const orderType = (options.orderType || '').trim();
    const floorName = (options.floorName || '').trim();
    const tableNumber = (options.tableNumber || '').trim() || null;
    const captainName = (options.captainName || '').trim();
    const cashierName = (options.cashierName || '').trim();
    const floorIds = options.floorIds || [];

    const allowedSort = ['net_revenue', 'total_quantity', 'category_name', 'order_count'];
    const sortBy = allowedSort.includes(options.sortBy) ? options.sortBy : 'net_revenue';
    const sortOrder = (options.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Build dynamic WHERE
    const baseFrom = `FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors fl ON t.floor_id = fl.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_cashier ON o.billed_by = u_cashier.id
       LEFT JOIN users u_item_cancel ON oi.cancelled_by = u_item_cancel.id
       LEFT JOIN users u_item_creator ON oi.created_by = u_item_creator.id
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
       LEFT JOIN tax_groups tg ON oi.tax_group_id = tg.id`;

    let conditions = ['o.outlet_id = ?', `${toISTDate('o.created_at')} BETWEEN ? AND ?`];
    let params = [outletId, start, end];

    if (floorIds.length > 0) {
      conditions.push(`o.floor_id IN (${floorIds.map(() => '?').join(',')})`);
      params.push(...floorIds);
    }
    if (itemType) { conditions.push('oi.item_type = ?'); params.push(itemType); }
    if (categoryName) { conditions.push('c.name LIKE ?'); params.push(`%${categoryName}%`); }
    if (status) { conditions.push('oi.status = ?'); params.push(status); }
    if (orderType) { conditions.push('o.order_type = ?'); params.push(orderType); }
    if (floorName) { conditions.push('fl.name LIKE ?'); params.push(`%${floorName}%`); }
    if (tableNumber) { conditions.push('t.table_number = ?'); params.push(tableNumber); }
    if (captainName) { conditions.push('u_captain.name LIKE ?'); params.push(`%${captainName}%`); }
    if (cashierName) { conditions.push('u_cashier.name LIKE ?'); params.push(`%${cashierName}%`); }
    if (search) {
      conditions.push('(c.name LIKE ? OR oi.item_name LIKE ? OR o.order_number LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // 1. Get all filtered order_items with full context
    const [rows] = await pool.query(
      `SELECT 
        oi.id as order_item_id, oi.order_id, oi.item_id, oi.variant_id,
        oi.item_name, oi.variant_name, oi.item_type,
        oi.quantity, oi.unit_price, oi.base_price,
        oi.discount_amount, oi.tax_amount, oi.total_price,
        oi.tax_group_id, oi.tax_details, oi.price_rule_applied,
        oi.special_instructions, oi.status as item_status,
        oi.kot_id, oi.is_complimentary, oi.complimentary_reason,
        oi.cancelled_by, oi.cancelled_at, oi.cancel_reason, oi.cancel_quantity,
        oi.is_nc, oi.nc_reason,
        oi.created_by as item_created_by, oi.created_at as item_created_at,
        o.order_number, o.order_type, o.status as order_status,
        o.payment_status, o.table_id, o.guest_count,
        o.customer_name, o.customer_phone,
        o.is_nc as order_is_nc, o.nc_amount as order_nc_amount, o.nc_reason as order_nc_reason,
        o.created_at as order_created_at, o.billed_at,
        t.table_number, t.name as table_name,
        fl.name as floor_name,
        u_captain.name as captain_name,
        u_cashier.name as cashier_name,
        u_item_cancel.name as item_cancelled_by_name,
        u_item_creator.name as item_created_by_name,
        c.id as category_id, c.name as category_name,
        ks.name as station_name,
        tg.name as tax_group_name, tg.total_rate as tax_rate
       ${baseFrom} ${whereClause}
       ORDER BY c.name, oi.item_name, oi.created_at DESC`,
      params
    );

    if (rows.length === 0) {
      return {
        dateRange: { start, end },
        categories: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false },
        filters: this._categoryDetailFilters(options),
        summary: this._emptyCategorySalesDetailSummary()
      };
    }

    // 2. Batch-fetch addons
    const orderItemIds = rows.map(r => r.order_item_id);
    const addonsMap = {};
    if (orderItemIds.length > 0) {
      const [addons] = await pool.query(
        `SELECT oia.order_item_id, oia.addon_name, oia.unit_price, oia.total_price, oia.quantity
         FROM order_item_addons oia WHERE oia.order_item_id IN (?)`,
        [orderItemIds]
      );
      for (const a of addons) {
        if (!addonsMap[a.order_item_id]) addonsMap[a.order_item_id] = [];
        addonsMap[a.order_item_id].push({
          addonName: a.addon_name,
          unitPrice: parseFloat(a.unit_price) || 0,
          totalPrice: parseFloat(a.total_price) || 0,
          quantity: parseInt(a.quantity) || 1
        });
      }
    }

    // 3. Group by category -> items -> occurrences
    const catMap = {};
    let globalTotalQty = 0, globalCancelledQty = 0, globalGrossRevenue = 0;
    let globalDiscount = 0, globalTax = 0, globalNetRevenue = 0;
    let globalAddonRevenue = 0, globalComplimentaryCount = 0;
    let globalNcCount = 0, globalNcQuantity = 0, globalNcAmount = 0;
    const globalOrderIds = new Set();
    const globalTypeBreakdown = {};

    for (const r of rows) {
      const catKey = r.category_id || 0;
      const catName = r.category_name || 'Uncategorized';
      const itemKey = `${r.item_id || 0}::${r.variant_name || ''}`;
      const isActive = r.item_status !== 'cancelled';

      let taxDetails = null;
      if (r.tax_details) {
        try { taxDetails = typeof r.tax_details === 'string' ? JSON.parse(r.tax_details) : r.tax_details; } catch (e) {}
      }
      let priceRule = null;
      if (r.price_rule_applied) {
        try { priceRule = typeof r.price_rule_applied === 'string' ? JSON.parse(r.price_rule_applied) : r.price_rule_applied; } catch (e) {}
      }

      const itemAddons = addonsMap[r.order_item_id] || [];
      const addonTotal = itemAddons.reduce((s, a) => s + a.totalPrice, 0);

      // Build occurrence
      const occurrence = {
        orderItemId: r.order_item_id,
        orderId: r.order_id,
        orderNumber: r.order_number,
        orderType: r.order_type,
        orderStatus: r.order_status,
        paymentStatus: r.payment_status,
        tableId: r.table_id || null,
        tableNumber: r.table_number || null,
        tableName: r.table_name || null,
        floorName: r.floor_name || null,
        captainName: r.captain_name || null,
        cashierName: r.cashier_name || null,
        orderedByName: r.item_created_by_name || null,
        customerName: r.customer_name || null,
        customerPhone: r.customer_phone || null,
        guestCount: r.guest_count || 0,
        quantity: parseFloat(r.quantity),
        unitPrice: parseFloat(r.unit_price) || 0,
        basePrice: parseFloat(r.base_price) || 0,
        discountAmount: parseFloat(r.discount_amount) || 0,
        taxAmount: parseFloat(r.tax_amount) || 0,
        totalPrice: parseFloat(r.total_price) || 0,
        addonTotal: parseFloat(addonTotal.toFixed(2)),
        addons: itemAddons,
        taxGroupName: r.tax_group_name || null,
        taxRate: r.tax_rate ? parseFloat(r.tax_rate) : null,
        taxDetails,
        priceRuleApplied: priceRule,
        status: r.item_status,
        kotId: r.kot_id || null,
        specialInstructions: r.special_instructions || null,
        isComplimentary: !!r.is_complimentary,
        complimentaryReason: r.complimentary_reason || null,
        isNc: !!r.is_nc,
        ncReason: r.nc_reason || null,
        orderIsNc: !!r.order_is_nc,
        orderNcAmount: parseFloat(r.order_nc_amount) || 0,
        orderNcReason: r.order_nc_reason || null,
        cancelQuantity: parseFloat(r.cancel_quantity || 0),
        cancelReason: r.cancel_reason || null,
        cancelledByName: r.item_cancelled_by_name || null,
        cancelledAt: r.cancelled_at || null,
        itemCreatedAt: r.item_created_at,
        orderCreatedAt: r.order_created_at,
        billedAt: r.billed_at || null,
      };

      // Init category
      if (!catMap[catKey]) {
        catMap[catKey] = {
          categoryId: r.category_id,
          categoryName: catName,
          totalQuantity: 0, cancelledQuantity: 0,
          grossRevenue: 0, discountAmount: 0, taxAmount: 0, netRevenue: 0,
          addonRevenue: 0, complimentaryCount: 0,
          ncCount: 0, ncQuantity: 0, ncAmount: 0,
          orderIds: new Set(), uniqueItemIds: new Set(),
          dineInCount: 0, takeawayCount: 0, deliveryCount: 0,
          items: {}
        };
      }
      const cat = catMap[catKey];
      cat.orderIds.add(r.order_id);
      cat.uniqueItemIds.add(r.item_id);
      globalOrderIds.add(r.order_id);

      // Init item within category
      if (!cat.items[itemKey]) {
        cat.items[itemKey] = {
          itemId: r.item_id,
          itemName: r.item_name,
          variantId: r.variant_id || null,
          variantName: r.variant_name || null,
          itemType: r.item_type,
          stationName: r.station_name || null,
          totalQuantity: 0, cancelledQuantity: 0,
          grossRevenue: 0, discountAmount: 0, taxAmount: 0, netRevenue: 0,
          addonRevenue: 0, complimentaryCount: 0,
          ncCount: 0, ncQuantity: 0, ncAmount: 0,
          orderCount: new Set(),
          occurrences: []
        };
      }
      const item = cat.items[itemKey];
      item.occurrences.push(occurrence);
      item.orderCount.add(r.order_id);

      if (isActive) {
        const qty = parseFloat(r.quantity);
        const tp = parseFloat(r.total_price) || 0;
        const da = parseFloat(r.discount_amount) || 0;
        const ta = parseFloat(r.tax_amount) || 0;

        item.totalQuantity += qty;
        item.grossRevenue += tp;
        item.discountAmount += da;
        item.taxAmount += ta;
        item.netRevenue += (tp - da);
        item.addonRevenue += addonTotal;

        cat.totalQuantity += qty;
        cat.grossRevenue += tp;
        cat.discountAmount += da;
        cat.taxAmount += ta;
        cat.netRevenue += (tp - da);
        cat.addonRevenue += addonTotal;

        globalTotalQty += qty;
        globalGrossRevenue += tp;
        globalDiscount += da;
        globalTax += ta;
        globalNetRevenue += (tp - da);
        globalAddonRevenue += addonTotal;

        if (r.is_complimentary) {
          item.complimentaryCount++;
          cat.complimentaryCount++;
          globalComplimentaryCount++;
        }

        if (r.is_nc) {
          item.ncCount++;
          item.ncQuantity += qty;
          item.ncAmount += tp;
          cat.ncCount++;
          cat.ncQuantity += qty;
          cat.ncAmount += tp;
          globalNcCount++;
          globalNcQuantity += qty;
          globalNcAmount += tp;
        }

        const type = r.item_type || 'other';
        if (!globalTypeBreakdown[type]) globalTypeBreakdown[type] = { quantity: 0, revenue: 0 };
        globalTypeBreakdown[type].quantity += qty;
        globalTypeBreakdown[type].revenue += tp;
      } else {
        const cq = parseFloat(r.quantity);
        item.cancelledQuantity += cq;
        cat.cancelledQuantity += cq;
        globalCancelledQty += cq;
      }

      if (r.order_type === 'dine_in') cat.dineInCount++;
      else if (r.order_type === 'takeaway') cat.takeawayCount++;
      else if (r.order_type === 'delivery') cat.deliveryCount++;
    }

    // 4. Finalize categories
    const totalNetRevenue = globalNetRevenue || 1; // avoid divide by zero
    const categoriesArray = Object.values(catMap).map(cat => {
      // Finalize items within category
      const itemsArray = Object.values(cat.items).map(item => ({
        itemId: item.itemId,
        itemName: item.itemName,
        variantId: item.variantId,
        variantName: item.variantName,
        itemType: item.itemType,
        stationName: item.stationName,
        totalQuantity: parseFloat(item.totalQuantity.toFixed(3)),
        cancelledQuantity: parseFloat(item.cancelledQuantity.toFixed(3)),
        grossRevenue: parseFloat(item.grossRevenue.toFixed(2)),
        discountAmount: parseFloat(item.discountAmount.toFixed(2)),
        taxAmount: parseFloat(item.taxAmount.toFixed(2)),
        netRevenue: parseFloat(item.netRevenue.toFixed(2)),
        addonRevenue: parseFloat(item.addonRevenue.toFixed(2)),
        avgUnitPrice: item.totalQuantity > 0
          ? parseFloat((item.grossRevenue / item.totalQuantity).toFixed(2)) : 0,
        orderCount: item.orderCount.size,
        complimentaryCount: item.complimentaryCount,
        ncCount: item.ncCount,
        ncQuantity: parseFloat(item.ncQuantity.toFixed(3)),
        ncAmount: parseFloat(item.ncAmount.toFixed(2)),
        occurrenceCount: item.occurrences.length,
        occurrences: item.occurrences
      })).sort((a, b) => b.totalQuantity - a.totalQuantity);

      const netRev = parseFloat(cat.netRevenue.toFixed(2));
      return {
        categoryId: cat.categoryId,
        categoryName: cat.categoryName,
        totalQuantity: parseFloat(cat.totalQuantity.toFixed(3)),
        cancelledQuantity: parseFloat(cat.cancelledQuantity.toFixed(3)),
        grossRevenue: parseFloat(cat.grossRevenue.toFixed(2)),
        discountAmount: parseFloat(cat.discountAmount.toFixed(2)),
        taxAmount: parseFloat(cat.taxAmount.toFixed(2)),
        netRevenue: netRev,
        addonRevenue: parseFloat(cat.addonRevenue.toFixed(2)),
        contributionPercent: parseFloat(((netRev / totalNetRevenue) * 100).toFixed(2)),
        complimentaryCount: cat.complimentaryCount,
        ncCount: cat.ncCount,
        ncQuantity: parseFloat(cat.ncQuantity.toFixed(3)),
        ncAmount: parseFloat(cat.ncAmount.toFixed(2)),
        uniqueItemCount: cat.uniqueItemIds.size,
        orderCount: cat.orderIds.size,
        orderTypeBreakdown: {
          dine_in: cat.dineInCount,
          takeaway: cat.takeawayCount,
          delivery: cat.deliveryCount
        },
        items: itemsArray
      };
    });

    // Sort categories by chosen field
    const sortMultiplier = sortOrder === 'ASC' ? 1 : -1;
    categoriesArray.sort((a, b) => {
      if (sortBy === 'category_name') return sortMultiplier * (a.categoryName || '').localeCompare(b.categoryName || '');
      if (sortBy === 'total_quantity') return sortMultiplier * (a.totalQuantity - b.totalQuantity);
      if (sortBy === 'order_count') return sortMultiplier * (a.orderCount - b.orderCount);
      return sortMultiplier * (a.netRevenue - b.netRevenue); // default: net_revenue
    });

    // Pagination on categories
    const totalCount = categoriesArray.length;
    const totalPages = Math.ceil(totalCount / limit);
    const offset = (page - 1) * limit;
    const paginatedCategories = categoriesArray.slice(offset, offset + limit);

    // 5. Build summary (over ALL filtered categories, not just paginated page)
    // Sort all categories by netRevenue for topCategory
    const allSortedByRevenue = [...categoriesArray].sort((a, b) => b.netRevenue - a.netRevenue);

    const summary = {
      dateRange: { start, end },
      totalCategories: categoriesArray.length,
      totalUniqueItems: new Set(rows.map(r => r.item_id)).size,
      totalOrders: globalOrderIds.size,
      totalQuantitySold: parseFloat(globalTotalQty.toFixed(3)),
      totalCancelledQuantity: parseFloat(globalCancelledQty.toFixed(3)),
      grossRevenue: parseFloat(globalGrossRevenue.toFixed(2)),
      totalDiscount: parseFloat(globalDiscount.toFixed(2)),
      totalTax: parseFloat(globalTax.toFixed(2)),
      netRevenue: parseFloat(globalNetRevenue.toFixed(2)),
      addonRevenue: parseFloat(globalAddonRevenue.toFixed(2)),
      complimentaryCount: globalComplimentaryCount,
      ncCount: globalNcCount,
      ncQuantity: parseFloat(globalNcQuantity.toFixed(3)),
      ncAmount: parseFloat(globalNcAmount.toFixed(2)),
      avgRevenuePerCategory: categoriesArray.length > 0
        ? parseFloat((globalNetRevenue / categoriesArray.length).toFixed(2)) : 0,
      topCategory: allSortedByRevenue.length > 0 ? {
        name: allSortedByRevenue[0].categoryName,
        netRevenue: allSortedByRevenue[0].netRevenue,
        quantity: allSortedByRevenue[0].totalQuantity
      } : null,
      itemTypeBreakdown: Object.entries(globalTypeBreakdown).map(([type, data]) => ({
        type,
        quantity: parseFloat(data.quantity.toFixed(3)),
        revenue: parseFloat(data.revenue.toFixed(2))
      }))
    };

    return {
      dateRange: { start, end },
      categories: paginatedCategories,
      pagination: {
        page, limit, totalCount, totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: this._categoryDetailFilters(options),
      summary
    };
  },

  _categoryDetailFilters(options = {}) {
    const f = {};
    if (options.search) f.search = options.search;
    if (options.itemType) f.itemType = options.itemType;
    if (options.categoryName) f.categoryName = options.categoryName;
    if (options.status) f.status = options.status;
    if (options.orderType) f.orderType = options.orderType;
    if (options.captainName) f.captainName = options.captainName;
    if (options.cashierName) f.cashierName = options.cashierName;
    if (options.floorName) f.floorName = options.floorName;
    if (options.tableNumber) f.tableNumber = options.tableNumber;
    if (options.sortBy) f.sortBy = options.sortBy;
    if (options.sortOrder) f.sortOrder = options.sortOrder;
    return f;
  },

  /**
   * Detailed Payment Modes — per-mode breakdown with every transaction,
   * order details, table, floor, captain, cashier, items, invoice, timestamps
   * Supports: filters, search, pagination, sorting
   *
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options
   * @param {number}  options.page          - 1-indexed page (default 1)
   * @param {number}  options.limit         - transactions per page (default 50, max 200)
   * @param {string}  options.search        - search in order_number, payment_number, transaction_id, customer_name
   * @param {string}  options.paymentMode   - filter by payment mode (cash, card, upi, etc.)
   * @param {string}  options.orderType     - dine_in | takeaway | delivery
   * @param {string}  options.floorName     - partial match on floor name
   * @param {number}  options.tableNumber   - exact table number
   * @param {string}  options.captainName   - partial match on captain name
   * @param {string}  options.cashierName   - partial match on cashier name
   * @param {string}  options.sortBy        - total_amount | created_at | order_number (default created_at)
   * @param {string}  options.sortOrder     - ASC | DESC (default DESC)
   * @param {Array}   options.floorIds      - floor restriction for assigned-floor users
   */
  async getPaymentModeDetail(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);

    // Parse options
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (options.search || '').trim();
    const paymentMode = (options.paymentMode || '').trim();
    const orderType = (options.orderType || '').trim();
    const floorName = (options.floorName || '').trim();
    const tableNumber = (options.tableNumber || '').trim() || null;
    const captainName = (options.captainName || '').trim();
    const cashierName = (options.cashierName || '').trim();
    const floorIds = options.floorIds || [];

    const allowedSort = ['total_amount', 'created_at', 'order_number'];
    const sortBy = allowedSort.includes(options.sortBy) ? options.sortBy : 'created_at';
    const sortOrder = (options.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Build dynamic WHERE
    const baseFrom = `FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors fl ON t.floor_id = fl.id
       LEFT JOIN users u_recv ON p.received_by = u_recv.id
       LEFT JOIN users u_verify ON p.verified_by = u_verify.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_cashier ON o.billed_by = u_cashier.id
       LEFT JOIN invoices inv ON p.invoice_id = inv.id`;

    let conditions = ['p.outlet_id = ?', `${toISTDate('p.created_at')} BETWEEN ? AND ?`, "p.status = 'completed'"];
    let params = [outletId, start, end];

    if (floorIds.length > 0) {
      conditions.push(`o.floor_id IN (${floorIds.map(() => '?').join(',')})`);
      params.push(...floorIds);
    }
    if (paymentMode) { conditions.push('p.payment_mode = ?'); params.push(paymentMode); }
    if (orderType) { conditions.push('o.order_type = ?'); params.push(orderType); }
    if (floorName) { conditions.push('fl.name LIKE ?'); params.push(`%${floorName}%`); }
    if (tableNumber) { conditions.push('t.table_number = ?'); params.push(tableNumber); }
    if (captainName) { conditions.push('u_captain.name LIKE ?'); params.push(`%${captainName}%`); }
    if (cashierName) { conditions.push('u_cashier.name LIKE ?'); params.push(`%${cashierName}%`); }
    if (search) {
      conditions.push('(o.order_number LIKE ? OR p.payment_number LIKE ? OR p.transaction_id LIKE ? OR o.customer_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // 0. Total count for pagination
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total ${baseFrom} ${whereClause}`, params
    );
    const totalCount = countResult[0].total;

    if (totalCount === 0) {
      return {
        dateRange: { start, end },
        modes: [],
        transactions: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false },
        filters: this._paymentDetailFilters(options),
        summary: this._emptyPaymentModeDetailSummary()
      };
    }

    const totalPages = Math.ceil(totalCount / limit);

    // 0b. Summary aggregation over ALL filtered data (not paginated)
    const [summaryAgg] = await pool.query(
      `SELECT
        COUNT(*) as total_transactions,
        COUNT(DISTINCT p.order_id) as total_orders,
        SUM(p.total_amount) as total_collected,
        SUM(p.amount) as total_base_amount,
        SUM(p.tip_amount) as total_tips,
        SUM(p.refund_amount) as total_refund_amount,
        SUM(CASE WHEN p.refund_amount > 0 THEN 1 ELSE 0 END) as total_refund_count
       ${baseFrom} ${whereClause}`, params
    );

    // 0c. Mode breakdown over all filtered
    const [modeBreakdown] = await pool.query(
      `SELECT p.payment_mode,
        COUNT(*) as txn_count,
        SUM(p.total_amount) as total_amount,
        SUM(p.amount) as base_amount,
        SUM(p.tip_amount) as tip_amount,
        SUM(p.refund_amount) as refund_amount,
        SUM(CASE WHEN p.refund_amount > 0 THEN 1 ELSE 0 END) as refund_count,
        COUNT(DISTINCT p.order_id) as order_count,
        SUM(CASE WHEN o.order_type='dine_in' THEN 1 ELSE 0 END) as dine_in_count,
        SUM(CASE WHEN o.order_type='takeaway' THEN 1 ELSE 0 END) as takeaway_count,
        SUM(CASE WHEN o.order_type='delivery' THEN 1 ELSE 0 END) as delivery_count
       ${baseFrom} ${whereClause}
       GROUP BY p.payment_mode ORDER BY total_amount DESC`, params
    );

    // 0d. Daily breakdown over all filtered
    const [dailyAgg] = await pool.query(
      `SELECT ${toISTDate('p.created_at')} as date, p.payment_mode,
        COUNT(*) as count, SUM(p.total_amount) as amount
       ${baseFrom} ${whereClause}
       GROUP BY ${toISTDate('p.created_at')}, p.payment_mode
       ORDER BY date`, params
    );

    // 0e. Hourly breakdown over all filtered
    const [hourlyAgg] = await pool.query(
      `SELECT HOUR(p.created_at) as hour,
        COUNT(*) as count, SUM(p.total_amount) as amount
       ${baseFrom} ${whereClause}
       GROUP BY HOUR(p.created_at) ORDER BY hour`, params
    );

    // Sort column mapping
    const sortCol = sortBy === 'total_amount' ? 'p.total_amount'
      : sortBy === 'order_number' ? 'o.order_number' : 'p.created_at';

    // 1. Get paginated payments
    const [payments] = await pool.query(
      `SELECT 
        p.id as payment_id, p.uuid as payment_uuid, p.order_id, p.invoice_id,
        p.payment_number, p.payment_mode,
        p.amount, p.tip_amount, p.total_amount,
        p.status, p.transaction_id, p.reference_number,
        p.card_last_four, p.card_type, p.upi_id, p.wallet_name,
        p.bank_name, p.payment_gateway, p.notes,
        p.refund_amount, p.refund_reason, p.refund_reference, p.refunded_at,
        p.created_at as payment_created_at, p.verified_at,
        u_recv.name as received_by_name,
        u_verify.name as verified_by_name,
        o.order_number, o.order_type, o.status as order_status,
        o.subtotal as order_subtotal, o.discount_amount as order_discount,
        o.tax_amount as order_tax, o.service_charge as order_service_charge,
        o.total_amount as order_total, o.guest_count,
        o.customer_name, o.customer_phone,
        o.is_nc as order_is_nc, o.nc_amount as order_nc_amount, o.nc_reason as order_nc_reason,
        o.due_amount as order_due_amount,
        o.table_id, o.created_at as order_created_at, o.billed_at,
        o.created_by as order_created_by, o.billed_by,
        t.table_number, t.name as table_name,
        fl.name as floor_name,
        u_captain.name as captain_name,
        u_cashier.name as cashier_name,
        inv.invoice_number, inv.grand_total as invoice_total
       ${baseFrom} ${whereClause}
       ORDER BY ${sortCol} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    if (payments.length === 0) {
      return {
        dateRange: { start, end },
        modes: [],
        transactions: [],
        pagination: { page, limit, totalCount, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
        filters: this._paymentDetailFilters(options),
        summary: this._emptyPaymentModeDetailSummary()
      };
    }

    // 2. Batch-fetch order items for all orders in these payments
    const orderIds = [...new Set(payments.map(p => p.order_id))];
    const itemsByOrder = {};
    if (orderIds.length > 0) {
      const [items] = await pool.query(
        `SELECT oi.order_id, oi.item_name, oi.variant_name, oi.item_type,
                oi.quantity, oi.unit_price, oi.total_price, oi.status,
                oi.is_nc, oi.nc_reason,
                c.name as category_name
         FROM order_items oi
         LEFT JOIN items i ON oi.item_id = i.id
         LEFT JOIN categories c ON i.category_id = c.id
         WHERE oi.order_id IN (?)
         ORDER BY oi.created_at`,
        [orderIds]
      );
      for (const it of items) {
        if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = [];
        itemsByOrder[it.order_id].push({
          itemName: it.item_name,
          variantName: it.variant_name || null,
          itemType: it.item_type,
          categoryName: it.category_name || null,
          quantity: parseFloat(it.quantity),
          unitPrice: parseFloat(it.unit_price) || 0,
          totalPrice: parseFloat(it.total_price) || 0,
          status: it.status,
          isNc: !!it.is_nc,
          ncReason: it.nc_reason || null
        });
      }
    }

    // 3. Build transaction records from paginated payments
    const transactions = payments.map(p => {
      const orderItems = itemsByOrder[p.order_id] || [];
      const activeItems = orderItems.filter(i => i.status !== 'cancelled');
      const itemCount = activeItems.reduce((s, i) => s + i.quantity, 0);

      return {
        paymentId: p.payment_id,
        paymentNumber: p.payment_number,
        paymentMode: p.payment_mode,
        orderId: p.order_id,
        orderNumber: p.order_number,
        orderType: p.order_type,
        orderStatus: p.order_status,
        invoiceId: p.invoice_id || null,
        invoiceNumber: p.invoice_number || null,
        invoiceTotal: p.invoice_total ? parseFloat(p.invoice_total) : null,
        amount: parseFloat(p.amount) || 0,
        tipAmount: parseFloat(p.tip_amount) || 0,
        totalAmount: parseFloat(p.total_amount) || 0,
        transactionId: p.transaction_id || null,
        referenceNumber: p.reference_number || null,
        cardLastFour: p.card_last_four || null,
        cardType: p.card_type || null,
        upiId: p.upi_id || null,
        walletName: p.wallet_name || null,
        bankName: p.bank_name || null,
        paymentGateway: p.payment_gateway || null,
        notes: p.notes || null,
        refundAmount: parseFloat(p.refund_amount) || 0,
        refundReason: p.refund_reason || null,
        refundReference: p.refund_reference || null,
        refundedAt: p.refunded_at || null,
        tableId: p.table_id || null,
        tableNumber: p.table_number || null,
        tableName: p.table_name || null,
        floorName: p.floor_name || null,
        captainName: p.captain_name || null,
        cashierName: p.cashier_name || null,
        receivedByName: p.received_by_name || null,
        verifiedByName: p.verified_by_name || null,
        customerName: p.customer_name || null,
        customerPhone: p.customer_phone || null,
        guestCount: p.guest_count || 0,
        orderSubtotal: parseFloat(p.order_subtotal) || 0,
        orderDiscount: parseFloat(p.order_discount) || 0,
        orderTax: parseFloat(p.order_tax) || 0,
        orderServiceCharge: parseFloat(p.order_service_charge) || 0,
        orderTotal: parseFloat(p.order_total) || 0,
        orderIsNc: !!p.order_is_nc,
        orderNcAmount: parseFloat(p.order_nc_amount) || 0,
        orderNcReason: p.order_nc_reason || null,
        orderDueAmount: parseFloat(p.order_due_amount) || 0,
        itemCount: parseFloat(itemCount.toFixed(3)),
        items: activeItems,
        paymentCreatedAt: p.payment_created_at,
        verifiedAt: p.verified_at || null,
        orderCreatedAt: p.order_created_at,
        billedAt: p.billed_at || null,
      };
    });

    // 4. Build modes array from SQL-aggregated mode breakdown (over all filtered data)
    const sa = summaryAgg[0];
    const globalTotalCollected = parseFloat(sa.total_collected) || 1;

    const modesArray = modeBreakdown.map(m => ({
      paymentMode: m.payment_mode,
      transactionCount: parseInt(m.txn_count),
      totalAmount: parseFloat((parseFloat(m.total_amount) || 0).toFixed(2)),
      baseAmount: parseFloat((parseFloat(m.base_amount) || 0).toFixed(2)),
      tipAmount: parseFloat((parseFloat(m.tip_amount) || 0).toFixed(2)),
      refundAmount: parseFloat((parseFloat(m.refund_amount) || 0).toFixed(2)),
      refundCount: parseInt(m.refund_count),
      percentageShare: parseFloat(((parseFloat(m.total_amount) / globalTotalCollected) * 100).toFixed(2)),
      orderCount: parseInt(m.order_count),
      avgTransactionAmount: parseInt(m.txn_count) > 0
        ? parseFloat((parseFloat(m.total_amount) / parseInt(m.txn_count)).toFixed(2)) : 0,
      orderTypeBreakdown: {
        dine_in: parseInt(m.dine_in_count),
        takeaway: parseInt(m.takeaway_count),
        delivery: parseInt(m.delivery_count)
      }
    }));

    // 5. Daily breakdown from SQL aggregation
    const dailyMap = {};
    for (const d of dailyAgg) {
      const day = d.date instanceof Date ? d.date.toISOString().slice(0, 10) : String(d.date);
      if (!dailyMap[day]) dailyMap[day] = { total: 0, txnCount: 0, modes: {} };
      dailyMap[day].modes[d.payment_mode] = { count: parseInt(d.count), amount: parseFloat((parseFloat(d.amount) || 0).toFixed(2)) };
      dailyMap[day].total += parseFloat(d.amount) || 0;
      dailyMap[day].txnCount += parseInt(d.count);
    }
    const dailyBreakdown = Object.entries(dailyMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, data]) => ({
      date,
      total: parseFloat(data.total.toFixed(2)),
      transactionCount: data.txnCount,
      modes: Object.entries(data.modes).map(([mode, d]) => ({ mode, count: d.count, amount: d.amount }))
    }));

    // 6. Hourly breakdown from SQL aggregation
    const hourlyBreakdown = hourlyAgg.map(h => ({
      hour: String(h.hour).padStart(2, '0') + ':00',
      transactionCount: parseInt(h.count),
      totalAmount: parseFloat((parseFloat(h.amount) || 0).toFixed(2))
    }));

    // 7. Summary (over ALL filtered data)
    const summary = {
      dateRange: { start, end },
      totalTransactions: parseInt(sa.total_transactions) || 0,
      totalOrders: parseInt(sa.total_orders) || 0,
      totalCollected: parseFloat((parseFloat(sa.total_collected) || 0).toFixed(2)),
      totalBaseAmount: parseFloat((parseFloat(sa.total_base_amount) || 0).toFixed(2)),
      totalTips: parseFloat((parseFloat(sa.total_tips) || 0).toFixed(2)),
      totalRefundAmount: parseFloat((parseFloat(sa.total_refund_amount) || 0).toFixed(2)),
      totalRefundCount: parseInt(sa.total_refund_count) || 0,
      avgTransactionAmount: parseInt(sa.total_transactions) > 0
        ? parseFloat((parseFloat(sa.total_collected) / parseInt(sa.total_transactions)).toFixed(2)) : 0,
      paymentModeCount: modesArray.length,
      topMode: modesArray.length > 0 ? {
        mode: modesArray[0].paymentMode,
        totalAmount: modesArray[0].totalAmount,
        transactionCount: modesArray[0].transactionCount
      } : null,
      dailyBreakdown,
      hourlyBreakdown
    };

    return {
      dateRange: { start, end },
      modes: modesArray,
      transactions,
      pagination: {
        page, limit, totalCount, totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: this._paymentDetailFilters(options),
      summary
    };
  },

  _paymentDetailFilters(options = {}) {
    const f = {};
    if (options.search) f.search = options.search;
    if (options.paymentMode) f.paymentMode = options.paymentMode;
    if (options.orderType) f.orderType = options.orderType;
    if (options.captainName) f.captainName = options.captainName;
    if (options.cashierName) f.cashierName = options.cashierName;
    if (options.floorName) f.floorName = options.floorName;
    if (options.tableNumber) f.tableNumber = options.tableNumber;
    if (options.sortBy) f.sortBy = options.sortBy;
    if (options.sortOrder) f.sortOrder = options.sortOrder;
    return f;
  },

  /**
   * Detailed Tax Report — per-invoice breakdown with order, table, captain, cashier,
   * items with per-item tax, tax components, customer, HSN summary, timestamps
   * Supports: filters, search, pagination, sorting
   *
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options
   * @param {number}  options.page            - 1-indexed page (default 1)
   * @param {number}  options.limit           - invoices per page (default 50, max 200)
   * @param {string}  options.search          - search in invoice_number, order_number, customer_name, customer_gstin
   * @param {string}  options.paymentStatus   - pending | partial | completed
   * @param {string}  options.orderType       - dine_in | takeaway | delivery
   * @param {string}  options.floorName       - partial match on floor name
   * @param {number}  options.tableNumber     - exact table number
   * @param {string}  options.captainName     - partial match on captain name
   * @param {string}  options.cashierName     - partial match on cashier name
   * @param {string}  options.sortBy          - grand_total | total_tax | created_at | invoice_number (default created_at)
   * @param {string}  options.sortOrder       - ASC | DESC (default DESC)
   * @param {Array}   options.floorIds        - floor restriction for assigned-floor users
   */
  async getTaxDetail(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);

    // Parse options
    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (options.search || '').trim();
    const paymentStatus = (options.paymentStatus || '').trim();
    const orderType = (options.orderType || '').trim();
    const floorName = (options.floorName || '').trim();
    const tableNumber = (options.tableNumber || '').trim() || null;
    const captainName = (options.captainName || '').trim();
    const cashierName = (options.cashierName || '').trim();
    const floorIds = options.floorIds || [];

    const allowedSort = ['grand_total', 'total_tax', 'created_at', 'invoice_number'];
    const sortBy = allowedSort.includes(options.sortBy) ? options.sortBy : 'created_at';
    const sortOrder = (options.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Build dynamic WHERE
    const baseFrom = `FROM invoices inv
       JOIN orders o ON inv.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors fl ON t.floor_id = fl.id
       LEFT JOIN users u_captain ON o.created_by = u_captain.id
       LEFT JOIN users u_cashier ON o.billed_by = u_cashier.id
       LEFT JOIN users u_gen ON inv.generated_by = u_gen.id`;

    let conditions = ['inv.outlet_id = ?', `${toISTDate('inv.created_at')} BETWEEN ? AND ?`, 'inv.is_cancelled = 0'];
    let params = [outletId, start, end];

    if (floorIds.length > 0) {
      conditions.push(`o.floor_id IN (${floorIds.map(() => '?').join(',')})`);
      params.push(...floorIds);
    }
    if (paymentStatus) { conditions.push('inv.payment_status = ?'); params.push(paymentStatus); }
    if (orderType) { conditions.push('o.order_type = ?'); params.push(orderType); }
    if (floorName) { conditions.push('fl.name LIKE ?'); params.push(`%${floorName}%`); }
    if (tableNumber) { conditions.push('t.table_number = ?'); params.push(tableNumber); }
    if (captainName) { conditions.push('u_captain.name LIKE ?'); params.push(`%${captainName}%`); }
    if (cashierName) { conditions.push('u_cashier.name LIKE ?'); params.push(`%${cashierName}%`); }
    if (search) {
      conditions.push('(inv.invoice_number LIKE ? OR o.order_number LIKE ? OR inv.customer_name LIKE ? OR inv.customer_gstin LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // 0. Total count for pagination
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total ${baseFrom} ${whereClause}`, params
    );
    const totalCount = countResult[0].total;

    if (totalCount === 0) {
      return {
        dateRange: { start, end },
        invoices: [],
        pagination: { page, limit, totalCount: 0, totalPages: 0, hasNext: false, hasPrev: false },
        filters: this._taxDetailFilters(options),
        summary: this._emptyTaxDetailSummary()
      };
    }

    const totalPages = Math.ceil(totalCount / limit);

    // 0b. Summary aggregation over ALL filtered data (not paginated)
    const [taxSummaryAgg] = await pool.query(
      `SELECT
        COUNT(*) as total_invoices,
        COUNT(DISTINCT inv.order_id) as total_orders,
        SUM(inv.subtotal) as total_subtotal,
        SUM(inv.discount_amount) as total_discount,
        SUM(inv.taxable_amount) as total_taxable,
        SUM(inv.cgst_amount) as total_cgst,
        SUM(inv.sgst_amount) as total_sgst,
        SUM(inv.igst_amount) as total_igst,
        SUM(inv.vat_amount) as total_vat,
        SUM(inv.cess_amount) as total_cess,
        SUM(inv.total_tax) as total_tax,
        SUM(inv.service_charge) as total_service_charge,
        SUM(inv.packaging_charge) as total_packaging_charge,
        SUM(inv.delivery_charge) as total_delivery_charge,
        SUM(inv.round_off) as total_round_off,
        SUM(inv.grand_total) as total_grand
       ${baseFrom} ${whereClause}`, params
    );

    // 0c. Daily tax breakdown over all filtered
    const [dailyTaxAgg] = await pool.query(
      `SELECT ${toISTDate('inv.created_at')} as date,
        SUM(inv.taxable_amount) as taxable,
        SUM(inv.cgst_amount) as cgst, SUM(inv.sgst_amount) as sgst,
        SUM(inv.igst_amount) as igst, SUM(inv.vat_amount) as vat,
        SUM(inv.cess_amount) as cess, SUM(inv.total_tax) as total_tax,
        SUM(inv.grand_total) as grand_total, COUNT(*) as invoice_count
       ${baseFrom} ${whereClause}
       GROUP BY ${toISTDate('inv.created_at')} ORDER BY date`, params
    );

    // Sort column mapping
    const sortCol = sortBy === 'grand_total' ? 'inv.grand_total'
      : sortBy === 'total_tax' ? 'inv.total_tax'
      : sortBy === 'invoice_number' ? 'inv.invoice_number' : 'inv.created_at';

    // 1. Get paginated invoices
    const [invoices] = await pool.query(
      `SELECT 
        inv.id as invoice_id, inv.uuid as invoice_uuid,
        inv.order_id, inv.invoice_number, inv.invoice_date, inv.invoice_time,
        inv.customer_name, inv.customer_phone, inv.customer_email,
        inv.customer_gstin, inv.customer_address, inv.billing_address,
        inv.subtotal, inv.discount_amount, inv.taxable_amount,
        inv.cgst_amount, inv.sgst_amount, inv.igst_amount,
        inv.vat_amount, inv.cess_amount, inv.total_tax,
        inv.service_charge, inv.packaging_charge, inv.delivery_charge,
        inv.round_off, inv.grand_total, inv.amount_in_words,
        inv.payment_status, inv.tax_breakup, inv.hsn_summary,
        inv.notes, inv.created_at as invoice_created_at,
        inv.generated_by,
        o.order_number, o.order_type, o.status as order_status,
        o.is_nc as order_is_nc, o.nc_amount as order_nc_amount, o.nc_reason as order_nc_reason,
        o.due_amount as order_due_amount,
        o.table_id, o.guest_count, o.created_at as order_created_at, o.billed_at,
        t.table_number, t.name as table_name,
        fl.name as floor_name,
        u_captain.name as captain_name,
        u_cashier.name as cashier_name,
        u_gen.name as generated_by_name
       ${baseFrom} ${whereClause}
       ORDER BY ${sortCol} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    if (invoices.length === 0) {
      return {
        dateRange: { start, end },
        invoices: [],
        pagination: { page, limit, totalCount, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
        filters: this._taxDetailFilters(options),
        summary: this._emptyTaxDetailSummary()
      };
    }

    // 2. Batch-fetch order items with per-item tax for all orders
    const orderIds = [...new Set(invoices.map(inv => inv.order_id))];
    const itemsByOrder = {};
    if (orderIds.length > 0) {
      const [items] = await pool.query(
        `SELECT oi.order_id, oi.item_name, oi.variant_name, oi.item_type,
                oi.quantity, oi.unit_price, oi.base_price,
                oi.discount_amount, oi.tax_amount, oi.total_price,
                oi.tax_details, oi.status,
                oi.is_nc, oi.nc_reason,
                c.name as category_name,
                tg.name as tax_group_name, tg.total_rate as tax_rate
         FROM order_items oi
         LEFT JOIN items i ON oi.item_id = i.id
         LEFT JOIN categories c ON i.category_id = c.id
         LEFT JOIN tax_groups tg ON oi.tax_group_id = tg.id
         WHERE oi.order_id IN (?)
         ORDER BY oi.created_at`,
        [orderIds]
      );
      for (const it of items) {
        if (!itemsByOrder[it.order_id]) itemsByOrder[it.order_id] = [];
        let taxDetails = null;
        if (it.tax_details) {
          try { taxDetails = typeof it.tax_details === 'string' ? JSON.parse(it.tax_details) : it.tax_details; } catch (e) {}
        }
        itemsByOrder[it.order_id].push({
          itemName: it.item_name,
          variantName: it.variant_name || null,
          itemType: it.item_type,
          categoryName: it.category_name || null,
          quantity: parseFloat(it.quantity),
          unitPrice: parseFloat(it.unit_price) || 0,
          basePrice: parseFloat(it.base_price) || 0,
          discountAmount: parseFloat(it.discount_amount) || 0,
          taxAmount: parseFloat(it.tax_amount) || 0,
          totalPrice: parseFloat(it.total_price) || 0,
          taxGroupName: it.tax_group_name || null,
          taxRate: it.tax_rate ? parseFloat(it.tax_rate) : null,
          taxDetails,
          status: it.status,
          isNc: !!it.is_nc,
          ncReason: it.nc_reason || null
        });
      }
    }

    // 3. Batch-fetch payments for these orders
    const paymentsByOrder = {};
    if (orderIds.length > 0) {
      const [payments] = await pool.query(
        `SELECT p.order_id, p.payment_mode, p.amount, p.tip_amount, p.total_amount
         FROM payments p WHERE p.order_id IN (?) AND p.status = 'completed'`,
        [orderIds]
      );
      for (const p of payments) {
        if (!paymentsByOrder[p.order_id]) paymentsByOrder[p.order_id] = [];
        paymentsByOrder[p.order_id].push({
          paymentMode: p.payment_mode,
          amount: parseFloat(p.amount) || 0,
          tipAmount: parseFloat(p.tip_amount) || 0,
          totalAmount: parseFloat(p.total_amount) || 0
        });
      }
    }

    // 4. Build detailed invoices + accumulators
    let totalSubtotal = 0, totalDiscount = 0, totalTaxable = 0;
    let totalCgst = 0, totalSgst = 0, totalIgst = 0, totalVat = 0, totalCess = 0, totalTax = 0;
    let totalServiceCharge = 0, totalPackagingCharge = 0, totalDeliveryCharge = 0;
    let totalRoundOff = 0, totalGrand = 0;
    const componentTotals = {};
    const dailyTaxBreakdown = {};
    const taxRateBreakdown = {};

    const detailedInvoices = invoices.map(inv => {
      const sub = parseFloat(inv.subtotal) || 0;
      const disc = parseFloat(inv.discount_amount) || 0;
      const taxable = parseFloat(inv.taxable_amount) || 0;
      const cgst = parseFloat(inv.cgst_amount) || 0;
      const sgst = parseFloat(inv.sgst_amount) || 0;
      const igst = parseFloat(inv.igst_amount) || 0;
      const vat = parseFloat(inv.vat_amount) || 0;
      const cess = parseFloat(inv.cess_amount) || 0;
      const tax = parseFloat(inv.total_tax) || 0;
      const sc = parseFloat(inv.service_charge) || 0;
      const pc = parseFloat(inv.packaging_charge) || 0;
      const dc = parseFloat(inv.delivery_charge) || 0;
      const ro = parseFloat(inv.round_off) || 0;
      const grand = parseFloat(inv.grand_total) || 0;

      totalSubtotal += sub; totalDiscount += disc; totalTaxable += taxable;
      totalCgst += cgst; totalSgst += sgst; totalIgst += igst;
      totalVat += vat; totalCess += cess; totalTax += tax;
      totalServiceCharge += sc; totalPackagingCharge += pc; totalDeliveryCharge += dc;
      totalRoundOff += ro; totalGrand += grand;

      // Parse tax_breakup for per-component tracking
      let taxBreakup = null;
      if (inv.tax_breakup) {
        try { taxBreakup = typeof inv.tax_breakup === 'string' ? JSON.parse(inv.tax_breakup) : inv.tax_breakup; } catch (e) {}
      }
      if (taxBreakup && typeof taxBreakup === 'object') {
        for (const [code, detail] of Object.entries(taxBreakup)) {
          if (!detail || typeof detail !== 'object') continue;
          const compName = detail.name || detail.componentName || code;
          const rate = detail.rate || 0;
          if (!componentTotals[code]) {
            componentTotals[code] = { code, name: compName, rate, taxableAmount: 0, taxAmount: 0, invoiceCount: 0 };
          }
          componentTotals[code].taxableAmount += parseFloat(detail.taxableAmount || 0);
          componentTotals[code].taxAmount += parseFloat(detail.taxAmount || 0);
          componentTotals[code].invoiceCount += 1;

          // Tax rate breakdown
          const rateKey = String(rate);
          if (!taxRateBreakdown[rateKey]) taxRateBreakdown[rateKey] = { rate, taxableAmount: 0, taxAmount: 0, invoiceCount: 0 };
          taxRateBreakdown[rateKey].taxableAmount += parseFloat(detail.taxableAmount || 0);
          taxRateBreakdown[rateKey].taxAmount += parseFloat(detail.taxAmount || 0);
          taxRateBreakdown[rateKey].invoiceCount += 1;
        }
      }

      let hsnSummary = null;
      if (inv.hsn_summary) {
        try { hsnSummary = typeof inv.hsn_summary === 'string' ? JSON.parse(inv.hsn_summary) : inv.hsn_summary; } catch (e) {}
      }

      // Daily tax breakdown — use DATE(created_at) to match summary report grouping
      const day = inv.invoice_created_at ? new Date(inv.invoice_created_at).toISOString().slice(0, 10) : (inv.invoice_date || 'unknown');
      if (!dailyTaxBreakdown[day]) {
        dailyTaxBreakdown[day] = { taxable: 0, cgst: 0, sgst: 0, igst: 0, vat: 0, cess: 0, totalTax: 0, invoiceCount: 0, grandTotal: 0 };
      }
      dailyTaxBreakdown[day].taxable += taxable;
      dailyTaxBreakdown[day].cgst += cgst;
      dailyTaxBreakdown[day].sgst += sgst;
      dailyTaxBreakdown[day].igst += igst;
      dailyTaxBreakdown[day].vat += vat;
      dailyTaxBreakdown[day].cess += cess;
      dailyTaxBreakdown[day].totalTax += tax;
      dailyTaxBreakdown[day].invoiceCount++;
      dailyTaxBreakdown[day].grandTotal += grand;

      const orderItems = itemsByOrder[inv.order_id] || [];
      const orderPayments = paymentsByOrder[inv.order_id] || [];

      return {
        invoiceId: inv.invoice_id,
        invoiceNumber: inv.invoice_number,
        invoiceDate: inv.invoice_date,
        invoiceTime: inv.invoice_time,

        // Order
        orderId: inv.order_id,
        orderNumber: inv.order_number,
        orderType: inv.order_type,
        orderStatus: inv.order_status,

        // Table
        tableNumber: inv.table_number || null,
        tableName: inv.table_name || null,
        floorName: inv.floor_name || null,
        guestCount: inv.guest_count || 0,

        // People
        captainName: inv.captain_name || null,
        cashierName: inv.cashier_name || null,
        generatedByName: inv.generated_by_name || null,

        // Customer
        customerName: inv.customer_name || null,
        customerPhone: inv.customer_phone || null,
        customerEmail: inv.customer_email || null,
        customerGstin: inv.customer_gstin || null,
        customerAddress: inv.customer_address || null,
        billingAddress: inv.billing_address || null,

        // Amounts
        subtotal: sub,
        discountAmount: disc,
        taxableAmount: taxable,
        cgstAmount: cgst,
        sgstAmount: sgst,
        igstAmount: igst,
        vatAmount: vat,
        cessAmount: cess,
        totalTax: tax,
        serviceCharge: sc,
        packagingCharge: pc,
        deliveryCharge: dc,
        roundOff: ro,
        grandTotal: grand,
        amountInWords: inv.amount_in_words || null,

        // NC info
        orderIsNc: !!inv.order_is_nc,
        orderNcAmount: parseFloat(inv.order_nc_amount) || 0,
        orderNcReason: inv.order_nc_reason || null,
        orderDueAmount: parseFloat(inv.order_due_amount) || 0,

        // Tax detail
        taxBreakup,
        hsnSummary,
        paymentStatus: inv.payment_status,
        notes: inv.notes || null,

        // Items with per-item tax
        items: orderItems,

        // Payments
        payments: orderPayments,

        // Timestamps
        invoiceCreatedAt: inv.invoice_created_at,
        orderCreatedAt: inv.order_created_at,
        billedAt: inv.billed_at || null,
      };
    });

    // 5. Finalize component totals
    const taxComponents = Object.values(componentTotals).map(c => ({
      ...c,
      taxableAmount: parseFloat(c.taxableAmount.toFixed(2)),
      taxAmount: parseFloat(c.taxAmount.toFixed(2))
    })).sort((a, b) => b.taxAmount - a.taxAmount);

    // 6. Tax rate breakdown
    const rateBreakdown = Object.values(taxRateBreakdown).map(r => ({
      rate: r.rate,
      taxableAmount: parseFloat(r.taxableAmount.toFixed(2)),
      taxAmount: parseFloat(r.taxAmount.toFixed(2)),
      invoiceCount: r.invoiceCount
    })).sort((a, b) => a.rate - b.rate);

    // 7. Daily breakdown from SQL aggregation (over ALL filtered data)
    const dailyBreakdown = dailyTaxAgg.map(d => {
      const day = d.date instanceof Date ? d.date.toISOString().slice(0, 10) : String(d.date);
      return {
        date: day,
        taxableAmount: parseFloat((parseFloat(d.taxable) || 0).toFixed(2)),
        cgstAmount: parseFloat((parseFloat(d.cgst) || 0).toFixed(2)),
        sgstAmount: parseFloat((parseFloat(d.sgst) || 0).toFixed(2)),
        igstAmount: parseFloat((parseFloat(d.igst) || 0).toFixed(2)),
        vatAmount: parseFloat((parseFloat(d.vat) || 0).toFixed(2)),
        cessAmount: parseFloat((parseFloat(d.cess) || 0).toFixed(2)),
        totalTax: parseFloat((parseFloat(d.total_tax) || 0).toFixed(2)),
        grandTotal: parseFloat((parseFloat(d.grand_total) || 0).toFixed(2)),
        invoiceCount: parseInt(d.invoice_count)
      };
    });

    // 8. Summary (over ALL filtered data, not just paginated page)
    const tsa = taxSummaryAgg[0];
    const allTotalTax = parseFloat(tsa.total_tax) || 0;
    const allTotalTaxable = parseFloat(tsa.total_taxable) || 0;
    const allTotalInvoices = parseInt(tsa.total_invoices) || 0;

    const summary = {
      dateRange: { start, end },
      totalInvoices: allTotalInvoices,
      totalOrders: parseInt(tsa.total_orders) || 0,
      totalSubtotal: parseFloat((parseFloat(tsa.total_subtotal) || 0).toFixed(2)),
      totalDiscount: parseFloat((parseFloat(tsa.total_discount) || 0).toFixed(2)),
      totalTaxable: parseFloat(allTotalTaxable.toFixed(2)),
      totalCgst: parseFloat((parseFloat(tsa.total_cgst) || 0).toFixed(2)),
      totalSgst: parseFloat((parseFloat(tsa.total_sgst) || 0).toFixed(2)),
      totalIgst: parseFloat((parseFloat(tsa.total_igst) || 0).toFixed(2)),
      totalVat: parseFloat((parseFloat(tsa.total_vat) || 0).toFixed(2)),
      totalCess: parseFloat((parseFloat(tsa.total_cess) || 0).toFixed(2)),
      totalTax: parseFloat(allTotalTax.toFixed(2)),
      totalServiceCharge: parseFloat((parseFloat(tsa.total_service_charge) || 0).toFixed(2)),
      totalPackagingCharge: parseFloat((parseFloat(tsa.total_packaging_charge) || 0).toFixed(2)),
      totalDeliveryCharge: parseFloat((parseFloat(tsa.total_delivery_charge) || 0).toFixed(2)),
      totalRoundOff: parseFloat((parseFloat(tsa.total_round_off) || 0).toFixed(2)),
      totalGrandTotal: parseFloat((parseFloat(tsa.total_grand) || 0).toFixed(2)),
      avgTaxPerInvoice: allTotalInvoices > 0 ? parseFloat((allTotalTax / allTotalInvoices).toFixed(2)) : 0,
      effectiveTaxRate: allTotalTaxable > 0 ? parseFloat(((allTotalTax / allTotalTaxable) * 100).toFixed(2)) : 0,
      taxComponents,
      rateBreakdown,
      dailyBreakdown
    };

    return {
      dateRange: { start, end },
      invoices: detailedInvoices,
      pagination: {
        page, limit, totalCount, totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: this._taxDetailFilters(options),
      summary
    };
  },

  _taxDetailFilters(options = {}) {
    const f = {};
    if (options.search) f.search = options.search;
    if (options.paymentStatus) f.paymentStatus = options.paymentStatus;
    if (options.orderType) f.orderType = options.orderType;
    if (options.captainName) f.captainName = options.captainName;
    if (options.cashierName) f.cashierName = options.cashierName;
    if (options.floorName) f.floorName = options.floorName;
    if (options.tableNumber) f.tableNumber = options.tableNumber;
    if (options.sortBy) f.sortBy = options.sortBy;
    if (options.sortOrder) f.sortOrder = options.sortOrder;
    return f;
  },

  _emptyTaxDetailSummary() {
    return {
      dateRange: { start: null, end: null },
      totalInvoices: 0, totalOrders: 0,
      totalSubtotal: 0, totalDiscount: 0, totalTaxable: 0,
      totalCgst: 0, totalSgst: 0, totalIgst: 0, totalVat: 0, totalCess: 0, totalTax: 0,
      totalServiceCharge: 0, totalPackagingCharge: 0, totalDeliveryCharge: 0,
      totalRoundOff: 0, totalGrandTotal: 0,
      avgTaxPerInvoice: 0, effectiveTaxRate: 0,
      taxComponents: [], rateBreakdown: [], dailyBreakdown: []
    };
  },

  _emptyPaymentModeDetailSummary() {
    return {
      dateRange: { start: null, end: null },
      totalTransactions: 0, totalOrders: 0,
      totalCollected: 0, totalBaseAmount: 0, totalTips: 0,
      totalRefundAmount: 0, totalRefundCount: 0,
      avgTransactionAmount: 0, paymentModeCount: 0,
      topMode: null, dailyBreakdown: [], hourlyBreakdown: []
    };
  },

  _emptyCategorySalesDetailSummary() {
    return {
      dateRange: { start: null, end: null },
      totalCategories: 0, totalUniqueItems: 0, totalOrders: 0,
      totalQuantitySold: 0, totalCancelledQuantity: 0,
      grossRevenue: 0, totalDiscount: 0, totalTax: 0, netRevenue: 0,
      addonRevenue: 0, complimentaryCount: 0, avgRevenuePerCategory: 0,
      topCategory: null, itemTypeBreakdown: []
    };
  },

  _emptyItemSalesDetailSummary() {
    return {
      dateRange: { start: null, end: null },
      totalUniqueItems: 0, totalItemsShown: 0,
      totalQuantitySold: 0, totalCancelledQuantity: 0,
      grossRevenue: 0, totalDiscount: 0, totalTax: 0, netRevenue: 0,
      addonRevenue: 0, complimentaryCount: 0,
      ncCount: 0, ncQuantity: 0, ncAmount: 0,
      makingCost: 0, profit: 0, foodCostPercentage: 0,
      avgRevenuePerItem: 0,
      itemTypeBreakdown: [], categoryBreakdown: []
    };
  },

  _emptyDetailSummary() {
    return {
      dateRange: { start: null, end: null },
      totalOrders: 0, completedOrders: 0, cancelledOrders: 0, activeOrders: 0,
      orderTypeBreakdown: { dine_in: 0, takeaway: 0, delivery: 0 },
      grossSales: 0, totalDiscount: 0, totalTax: 0, netSales: 0,
      ncOrders: 0, ncAmount: 0,
      totalPaid: 0, totalTips: 0,
      makingCost: 0, profit: 0, foodCostPercentage: 0,
      wastageCount: 0, wastageCost: 0,
      averageOrderValue: 0,
      paymentModeBreakdown: {}
    };
  },

  /**
   * Get sales breakdown by service type (restaurant vs bar)
   * Provides separate calculations for restaurant items, bar items, and combined
   */
  async getServiceTypeSalesBreakdown(outletId, startDate, endDate, floorIds = []) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const ff = floorFilter(floorIds);

    const [rows] = await pool.query(
      `SELECT 
        COALESCE(c.service_type, 'both') as service_type,
        COUNT(DISTINCT o.id) as order_count,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.quantity ELSE 0 END) as total_quantity,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.total_price ELSE 0 END) as gross_revenue,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.discount_amount ELSE 0 END) as discount_amount,
        SUM(CASE WHEN oi.status != 'cancelled' THEN oi.tax_amount ELSE 0 END) as tax_amount,
        SUM(CASE WHEN oi.status != 'cancelled' THEN (oi.total_price - oi.discount_amount) ELSE 0 END) as net_revenue,
        COUNT(DISTINCT oi.item_id) as unique_items,
        SUM(CASE WHEN oi.status != 'cancelled' AND oi.is_nc = 1 THEN oi.quantity ELSE 0 END) as nc_quantity,
        SUM(CASE WHEN oi.status != 'cancelled' AND oi.is_nc = 1 THEN oi.total_price ELSE 0 END) as nc_amount
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?${ff.sql}
       GROUP BY COALESCE(c.service_type, 'both')
       ORDER BY net_revenue DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Get order-level summary for consistency with other reports
    // Gross = subtotal + tax, Net = subtotal - discount
    const [orderSummary] = await pool.query(
      `SELECT 
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal + o.tax_amount) ELSE 0 END) as gross_revenue,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.discount_amount ELSE 0 END) as discount_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.tax_amount ELSE 0 END) as tax_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as net_revenue,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount,
        COUNT(CASE WHEN o.is_nc = 1 AND o.status != 'cancelled' THEN 1 END) as nc_orders
       FROM orders o
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ? AND o.status != 'cancelled'${ff.sql}`,
      [outletId, start, end, ...ff.params]
    );

    // Calculate totals from item-level for breakdown, order-level for summary
    const totalRevenue = rows.reduce((sum, r) => sum + parseFloat(r.net_revenue || 0), 0);
    const totalQuantity = rows.reduce((sum, r) => sum + parseInt(r.total_quantity || 0), 0);
    const orderGross = parseFloat(orderSummary[0].gross_revenue || 0);
    const orderDiscount = parseFloat(orderSummary[0].discount_amount || 0);
    const orderTax = parseFloat(orderSummary[0].tax_amount || 0);
    const orderNet = parseFloat(orderSummary[0].net_revenue || 0);
    const orderNC = parseFloat(orderSummary[0].nc_amount || 0);
    const orderDue = parseFloat(orderSummary[0].due_amount || 0);
    const orderPaid = parseFloat(orderSummary[0].paid_amount || 0);

    // Build breakdown with percentages
    const breakdown = {
      restaurant: { quantity: 0, gross_revenue: 0, net_revenue: 0, discount: 0, tax: 0, order_count: 0, unique_items: 0, nc_quantity: 0, nc_amount: 0, percentage: 0 },
      bar: { quantity: 0, gross_revenue: 0, net_revenue: 0, discount: 0, tax: 0, order_count: 0, unique_items: 0, nc_quantity: 0, nc_amount: 0, percentage: 0 },
      both: { quantity: 0, gross_revenue: 0, net_revenue: 0, discount: 0, tax: 0, order_count: 0, unique_items: 0, nc_quantity: 0, nc_amount: 0, percentage: 0 }
    };

    for (const row of rows) {
      const type = row.service_type || 'both';
      if (breakdown[type]) {
        breakdown[type] = {
          quantity: parseInt(row.total_quantity || 0),
          gross_revenue: parseFloat(row.gross_revenue || 0),
          net_revenue: parseFloat(row.net_revenue || 0),
          discount: parseFloat(row.discount_amount || 0),
          tax: parseFloat(row.tax_amount || 0),
          order_count: parseInt(row.order_count || 0),
          unique_items: parseInt(row.unique_items || 0),
          nc_quantity: parseInt(row.nc_quantity || 0),
          nc_amount: parseFloat(row.nc_amount || 0),
          percentage: totalRevenue > 0 ? ((parseFloat(row.net_revenue) / totalRevenue) * 100).toFixed(2) : '0.00'
        };
      }
    }

    return {
      dateRange: { start, end },
      outletId,
      summary: {
        gross_revenue: orderGross.toFixed(2),
        discount_amount: orderDiscount.toFixed(2),
        tax_amount: orderTax.toFixed(2),
        nc_amount: orderNC.toFixed(2),
        due_amount: orderDue.toFixed(2),
        paid_amount: orderPaid.toFixed(2),
        net_revenue: orderNet.toFixed(2),
        total_quantity: totalQuantity,
        restaurant_revenue: breakdown.restaurant.net_revenue.toFixed(2),
        bar_revenue: breakdown.bar.net_revenue.toFixed(2),
        shared_revenue: breakdown.both.net_revenue.toFixed(2)
      },
      breakdown
    };
  },

  // ========================
  // DAY END SUMMARY
  // ========================

  /**
   * Day End Summary - Aggregated daily summary for date range
   * Role-based: cashier sees only their billed orders, others see based on floor assignment
   */
  async getDayEndSummary(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const { floorIds = [], userId = null, isCashier = false } = options;

    let conditions = ['o.outlet_id = ?', `${toISTDate('o.created_at')} BETWEEN ? AND ?`];
    let params = [outletId, start, end];

    // Floor restriction - include takeaway/delivery orders (they have NULL floor_id)
    if (floorIds.length > 0) {
      const floorPlaceholders = floorIds.map(() => '?').join(',');
      conditions.push(`(o.floor_id IN (${floorPlaceholders}) OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery')))`);
      params.push(...floorIds);
    }

    // Cashier sees only their billed orders or orders they created
    if (isCashier && userId) {
      conditions.push('(o.billed_by = ? OR o.created_by = ?)');
      params.push(userId, userId);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT 
        ${toISTDate('o.created_at')} as report_date,
        COUNT(*) as total_orders,
        COUNT(CASE WHEN o.status IN ('paid', 'completed') THEN 1 END) as completed_orders,
        COUNT(CASE WHEN o.status = 'cancelled' THEN 1 END) as cancelled_orders,
        COUNT(CASE WHEN o.order_type = 'dine_in' AND o.status != 'cancelled' THEN 1 END) as dine_in_orders,
        COUNT(CASE WHEN o.order_type = 'takeaway' AND o.status != 'cancelled' THEN 1 END) as takeaway_orders,
        COUNT(CASE WHEN o.order_type = 'delivery' AND o.status != 'cancelled' THEN 1 END) as delivery_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as total_sales,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal + o.tax_amount) ELSE 0 END) as gross_sales,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.discount_amount ELSE 0 END) as total_discount,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.tax_amount ELSE 0 END) as total_tax,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.service_charge ELSE 0 END) as total_sc,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.guest_count ELSE 0 END) as total_guests,
        COUNT(CASE WHEN o.is_nc = 1 THEN 1 END) as nc_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount
       FROM orders o
       ${whereClause}
       GROUP BY ${toISTDate('o.created_at')}
       ORDER BY report_date DESC`,
      params
    );

    // Get payment breakdown (regular payments)
    const [payRows] = await pool.query(
      `SELECT 
        ${toISTDate('p.created_at')} as report_date,
        p.payment_mode,
        COUNT(*) as payment_count,
        SUM(p.total_amount) as amount
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       ${whereClause} AND p.status = 'completed'
       GROUP BY ${toISTDate('p.created_at')}, p.payment_mode`,
      params
    );

    // Get split payment breakdown (actual payment modes from split_payments table)
    const [splitRows] = await pool.query(
      `SELECT 
        ${toISTDate('p.created_at')} as report_date,
        sp.payment_mode,
        COUNT(*) as payment_count,
        SUM(sp.amount) as amount
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id
       ${whereClause} AND p.status = 'completed' AND p.payment_mode = 'split'
       GROUP BY ${toISTDate('p.created_at')}, sp.payment_mode`,
      params
    );

    const paymentByDate = {};
    // Add regular payments (excluding split which we'll break down)
    for (const pr of payRows) {
      const dateKey = pr.report_date instanceof Date ? pr.report_date.toISOString().slice(0, 10) : pr.report_date;
      if (!paymentByDate[dateKey]) paymentByDate[dateKey] = { breakdown: {}, splitBreakdown: {} };
      if (pr.payment_mode !== 'split') {
        paymentByDate[dateKey].breakdown[pr.payment_mode] = parseFloat(pr.amount) || 0;
      }
    }
    // Add split payment breakdown
    for (const sp of splitRows) {
      const dateKey = sp.report_date instanceof Date ? sp.report_date.toISOString().slice(0, 10) : sp.report_date;
      if (!paymentByDate[dateKey]) paymentByDate[dateKey] = { breakdown: {}, splitBreakdown: {} };
      paymentByDate[dateKey].splitBreakdown[sp.payment_mode] = parseFloat(sp.amount) || 0;
      // Also add to main breakdown for totals
      paymentByDate[dateKey].breakdown[sp.payment_mode] = 
        (paymentByDate[dateKey].breakdown[sp.payment_mode] || 0) + (parseFloat(sp.amount) || 0);
    }

    // Cost/Profit data from order_item_costs grouped by date
    const [costByDate] = await pool.query(
      `SELECT ${toISTDate('o.created_at')} as report_date,
        COALESCE(SUM(oic.making_cost), 0) as making_cost,
        COALESCE(SUM(oic.profit), 0) as profit
       FROM order_item_costs oic
       JOIN orders o ON oic.order_id = o.id
       ${whereClause} AND o.status IN ('paid','completed')
       GROUP BY ${toISTDate('o.created_at')}`,
      params
    );
    const costByDateMap = {};
    costByDate.forEach(r => {
      const dk = r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date;
      costByDateMap[dk] = { making_cost: parseFloat(r.making_cost) || 0, profit: parseFloat(r.profit) || 0 };
    });

    // Wastage data grouped by date
    const [wastageByDate] = await pool.query(
      `SELECT wl.wastage_date as report_date,
        COUNT(*) as wastage_count,
        COALESCE(SUM(wl.total_cost), 0) as wastage_cost
       FROM wastage_logs wl
       WHERE wl.outlet_id = ? AND wl.wastage_date BETWEEN ? AND ?
       GROUP BY wl.wastage_date`,
      [outletId, start, end]
    );
    const wastageByDateMap = {};
    wastageByDate.forEach(r => {
      const dk = r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date;
      wastageByDateMap[dk] = { wastage_count: parseInt(r.wastage_count) || 0, wastage_cost: parseFloat(r.wastage_cost) || 0 };
    });

    const summary = rows.map(r => {
      const dateKey = r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date;
      const payments = paymentByDate[dateKey] || { breakdown: {}, splitBreakdown: {} };
      const cost = costByDateMap[dateKey] || { making_cost: 0, profit: 0 };
      const wst = wastageByDateMap[dateKey] || { wastage_count: 0, wastage_cost: 0 };
      // Total collection = sum of all payment mode amounts for this date
      const totalCollection = Object.values(payments.breakdown).reduce((sum, v) => sum + (v || 0), 0);
      const totalSalesVal = parseFloat(r.total_sales) || 0;
      const foodCostPct = totalSalesVal > 0 ? parseFloat(((cost.making_cost / totalSalesVal) * 100).toFixed(2)) : 0;
      return {
        date: dateKey,
        totalOrders: parseInt(r.total_orders) || 0,
        completedOrders: parseInt(r.completed_orders) || 0,
        cancelledOrders: parseInt(r.cancelled_orders) || 0,
        ordersByType: {
          dineIn: parseInt(r.dine_in_orders) || 0,
          takeaway: parseInt(r.takeaway_orders) || 0,
          delivery: parseInt(r.delivery_orders) || 0
        },
        totalSales: totalSalesVal,
        grossSales: parseFloat(r.gross_sales) || 0,
        totalDiscount: parseFloat(r.total_discount) || 0,
        totalTax: parseFloat(r.total_tax) || 0,
        totalServiceCharge: parseFloat(r.total_sc) || 0,
        totalGuests: parseInt(r.total_guests) || 0,
        ncOrders: parseInt(r.nc_orders) || 0,
        ncAmount: parseFloat(r.nc_amount) || 0,
        dueAmount: parseFloat(r.due_amount) || 0,
        paidAmount: parseFloat(r.paid_amount) || 0,
        totalCollection: parseFloat(totalCollection.toFixed(2)),
        makingCost: cost.making_cost,
        profit: cost.profit,
        foodCostPercentage: foodCostPct,
        wastageCount: wst.wastage_count,
        wastageCost: wst.wastage_cost,
        avgOrderValue: r.completed_orders > 0 ? parseFloat((r.total_sales / r.completed_orders).toFixed(2)) : 0,
        payments: payments.breakdown,
        splitPaymentBreakdown: payments.splitBreakdown
      };
    });

    // Grand totals
    const grandTotalSales = parseFloat(summary.reduce((s, r) => s + r.totalSales, 0).toFixed(2));
    const grandMakingCost = parseFloat(summary.reduce((s, r) => s + r.makingCost, 0).toFixed(2));
    const grandTotal = {
      totalOrders: summary.reduce((s, r) => s + r.totalOrders, 0),
      completedOrders: summary.reduce((s, r) => s + r.completedOrders, 0),
      cancelledOrders: summary.reduce((s, r) => s + r.cancelledOrders, 0),
      ordersByType: {
        dineIn: summary.reduce((s, r) => s + r.ordersByType.dineIn, 0),
        takeaway: summary.reduce((s, r) => s + r.ordersByType.takeaway, 0),
        delivery: summary.reduce((s, r) => s + r.ordersByType.delivery, 0)
      },
      totalSales: grandTotalSales,
      grossSales: parseFloat(summary.reduce((s, r) => s + r.grossSales, 0).toFixed(2)),
      totalDiscount: parseFloat(summary.reduce((s, r) => s + r.totalDiscount, 0).toFixed(2)),
      totalTax: parseFloat(summary.reduce((s, r) => s + r.totalTax, 0).toFixed(2)),
      totalServiceCharge: parseFloat(summary.reduce((s, r) => s + r.totalServiceCharge, 0).toFixed(2)),
      totalGuests: summary.reduce((s, r) => s + r.totalGuests, 0),
      ncOrders: summary.reduce((s, r) => s + r.ncOrders, 0),
      ncAmount: parseFloat(summary.reduce((s, r) => s + r.ncAmount, 0).toFixed(2)),
      dueAmount: parseFloat(summary.reduce((s, r) => s + r.dueAmount, 0).toFixed(2)),
      paidAmount: parseFloat(summary.reduce((s, r) => s + r.paidAmount, 0).toFixed(2)),
      totalCollection: parseFloat(summary.reduce((s, r) => s + r.totalCollection, 0).toFixed(2)),
      makingCost: grandMakingCost,
      profit: parseFloat(summary.reduce((s, r) => s + r.profit, 0).toFixed(2)),
      foodCostPercentage: grandTotalSales > 0 ? parseFloat(((grandMakingCost / grandTotalSales) * 100).toFixed(2)) : 0,
      wastageCount: summary.reduce((s, r) => s + r.wastageCount, 0),
      wastageCost: parseFloat(summary.reduce((s, r) => s + r.wastageCost, 0).toFixed(2))
    };

    return {
      dateRange: { start, end },
      days: summary,
      grandTotal,
      dayCount: summary.length
    };
  },

  /**
   * Day End Summary Detail - Comprehensive details for a specific date
   * Includes: orders list, item sales, category breakdown, staff performance, hourly breakdown, refunds, discounts
   */
  async getDayEndSummaryDetail(outletId, date, options = {}) {
    const pool = getPool();
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const { floorIds = [], userId = null, isCashier = false } = options;

    let conditions = ['o.outlet_id = ?', `${toISTDate('o.created_at')} = ?`];
    let params = [outletId, targetDate];

    // Floor restriction - include takeaway/delivery orders
    if (floorIds.length > 0) {
      const floorPlaceholders = floorIds.map(() => '?').join(',');
      conditions.push(`(o.floor_id IN (${floorPlaceholders}) OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery')))`);
      params.push(...floorIds);
    }

    // Cashier sees only their orders
    if (isCashier && userId) {
      conditions.push('(o.billed_by = ? OR o.created_by = ?)');
      params.push(userId, userId);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // 1. Order Summary Statistics
    const [summaryRows] = await pool.query(
      `SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN o.status IN ('paid', 'completed') THEN 1 END) as completed_orders,
        COUNT(CASE WHEN o.status = 'cancelled' THEN 1 END) as cancelled_orders,
        COUNT(CASE WHEN o.order_type = 'dine_in' AND o.status != 'cancelled' THEN 1 END) as dine_in_orders,
        COUNT(CASE WHEN o.order_type = 'takeaway' AND o.status != 'cancelled' THEN 1 END) as takeaway_orders,
        COUNT(CASE WHEN o.order_type = 'delivery' AND o.status != 'cancelled' THEN 1 END) as delivery_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as total_sales,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal + o.tax_amount) ELSE 0 END) as gross_sales,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.discount_amount ELSE 0 END) as total_discount,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.tax_amount ELSE 0 END) as total_tax,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.service_charge ELSE 0 END) as total_service_charge,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.guest_count ELSE 0 END) as total_guests,
        AVG(CASE WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, 0) END) as avg_order_value,
        MAX(CASE WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, 0) END) as max_order_value,
        MIN(CASE WHEN o.status IN ('paid', 'completed') AND COALESCE(o.paid_amount, 0) > 0 THEN COALESCE(o.paid_amount, 0) END) as min_order_value,
        COUNT(CASE WHEN o.is_nc = 1 THEN 1 END) as nc_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount
       FROM orders o
       ${whereClause}`,
      params
    );

    // 2. Payment Breakdown
    const [paymentRows] = await pool.query(
      `SELECT 
        p.payment_mode,
        COUNT(*) as count,
        SUM(p.total_amount) as amount
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       ${whereClause} AND p.status = 'completed'
       GROUP BY p.payment_mode`,
      params
    );

    // 3. Split Payment Breakdown
    const [splitPaymentRows] = await pool.query(
      `SELECT 
        sp.payment_mode,
        COUNT(*) as count,
        SUM(sp.amount) as amount
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id
       ${whereClause} AND p.status = 'completed' AND p.payment_mode = 'split'
       GROUP BY sp.payment_mode`,
      params
    );

    // 4. Hourly Breakdown
    const [hourlyRows] = await pool.query(
      `SELECT 
        HOUR(o.created_at) as hour,
        COUNT(*) as order_count,
        SUM(CASE WHEN o.status IN ('paid', 'completed') THEN o.total_amount ELSE 0 END) as sales,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.guest_count ELSE 0 END) as guests
       FROM orders o
       ${whereClause} AND o.status != 'cancelled'
       GROUP BY HOUR(o.created_at)
       ORDER BY hour`,
      params
    );

    // 5. Category-wise Sales
    const [categoryRows] = await pool.query(
      `SELECT 
        c.id as category_id,
        c.name as category_name,
        COUNT(DISTINCT oi.id) as items_sold,
        SUM(oi.quantity) as total_quantity,
        SUM(oi.total_price) as total_sales
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       ${whereClause} AND oi.status != 'cancelled' AND o.status != 'cancelled'
       GROUP BY c.id, c.name
       ORDER BY total_sales DESC`,
      params
    );

    // 6. Top Selling Items
    const [topItemRows] = await pool.query(
      `SELECT 
        i.id as item_id,
        COALESCE(i.name, oi.item_name) as item_name,
        c.name as category_name,
        SUM(oi.quantity) as quantity_sold,
        SUM(oi.total_price) as total_sales,
        COUNT(DISTINCT o.id) as order_count
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN categories c ON i.category_id = c.id
       ${whereClause} AND oi.status != 'cancelled' AND o.status != 'cancelled'
       GROUP BY i.id, COALESCE(i.name, oi.item_name), c.name
       ORDER BY quantity_sold DESC
       LIMIT 20`,
      params
    );

    // 7. Staff Performance
    const [staffRows] = await pool.query(
      `SELECT 
        u.id as user_id,
        u.name as user_name,
        GROUP_CONCAT(DISTINCT r.name) as role_name,
        COUNT(DISTINCT CASE WHEN o.status != 'cancelled' THEN o.id END) as orders_handled,
        SUM(CASE WHEN o.status IN ('paid', 'completed') THEN o.total_amount ELSE 0 END) as total_sales,
        AVG(CASE WHEN o.status IN ('paid', 'completed') THEN o.total_amount END) as avg_order_value
       FROM orders o
       JOIN users u ON o.created_by = u.id
       LEFT JOIN user_roles ur ON u.id = ur.user_id AND ur.is_active = 1
       LEFT JOIN roles r ON ur.role_id = r.id AND r.is_active = 1
       ${whereClause}
       GROUP BY u.id, u.name
       ORDER BY total_sales DESC`,
      params
    );

    // 8. Discounts Applied
    const [discountRows] = await pool.query(
      `SELECT 
        od.discount_name,
        od.discount_type,
        COUNT(*) as times_applied,
        SUM(od.discount_amount) as total_amount,
        u.name as approved_by_name
       FROM order_discounts od
       JOIN orders o ON od.order_id = o.id
       LEFT JOIN users u ON od.approved_by = u.id
       ${whereClause}
       GROUP BY od.discount_name, od.discount_type, u.name
       ORDER BY total_amount DESC`,
      params
    );

    // 9. Refunds - query separately with direct date filter
    let refundRows = [];
    try {
      const [refunds] = await pool.query(
        `SELECT 
          rf.id, rf.refund_amount, rf.reason, rf.status, rf.created_at,
          o.order_number, o.total_amount as order_total,
          u.name as refunded_by
         FROM refunds rf
         JOIN orders o ON rf.order_id = o.id
         LEFT JOIN users u ON rf.refunded_by = u.id
         WHERE o.outlet_id = ? AND ${toISTDate('rf.created_at')} = ? AND rf.status IN ('completed', 'approved')
         ORDER BY rf.created_at DESC`,
        [outletId, targetDate]
      );
      refundRows = refunds;
    } catch (e) {
      // Refunds table may not exist or have different structure
      refundRows = [];
    }

    // 10. Orders List (with basic details)
    const [ordersRows] = await pool.query(
      `SELECT 
        o.id, o.uuid, o.order_number, o.order_type, o.status, o.payment_status,
        o.customer_name, o.customer_phone, o.guest_count,
        o.subtotal, o.discount_amount, o.tax_amount, o.service_charge, o.total_amount,
        o.is_nc, o.nc_amount, o.nc_reason, o.due_amount, o.paid_amount,
        o.created_at, o.updated_at,
        t.table_number, f.name as floor_name,
        u.name as created_by_name,
        p.payment_mode
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'completed'
       ${whereClause}
       ORDER BY o.created_at DESC`,
      params
    );

    // 11. Floor-wise breakdown
    const [floorRows] = await pool.query(
      `SELECT 
        COALESCE(f.name, 'Takeaway/Delivery') as floor_name,
        o.order_type,
        COUNT(*) as order_count,
        SUM(CASE WHEN o.status IN ('paid', 'completed') THEN o.total_amount ELSE 0 END) as sales
       FROM orders o
       LEFT JOIN floors f ON o.floor_id = f.id
       ${whereClause} AND o.status != 'cancelled'
       GROUP BY f.name, o.order_type
       ORDER BY sales DESC`,
      params
    );

    // 12. Cancelled orders summary
    const [cancelledRows] = await pool.query(
      `SELECT 
        o.id, o.order_number, o.order_type, o.total_amount,
        o.customer_name, o.cancel_reason,
        o.created_at, o.updated_at as cancelled_at,
        u.name as created_by_name
       FROM orders o
       LEFT JOIN users u ON o.created_by = u.id
       ${whereClause} AND o.status = 'cancelled'
       ORDER BY o.updated_at DESC`,
      params
    );

    // Format summary
    const summary = summaryRows[0] || {};

    // Format payment breakdown
    const paymentBreakdown = {};
    let totalPayments = 0;
    for (const p of paymentRows) {
      if (p.payment_mode !== 'split') {
        paymentBreakdown[p.payment_mode] = {
          count: parseInt(p.count) || 0,
          amount: parseFloat(p.amount) || 0
        };
        totalPayments += parseFloat(p.amount) || 0;
      }
    }
    // Add split payment details
    for (const sp of splitPaymentRows) {
      if (!paymentBreakdown[sp.payment_mode]) {
        paymentBreakdown[sp.payment_mode] = { count: 0, amount: 0 };
      }
      paymentBreakdown[sp.payment_mode].count += parseInt(sp.count) || 0;
      paymentBreakdown[sp.payment_mode].amount += parseFloat(sp.amount) || 0;
      totalPayments += parseFloat(sp.amount) || 0;
    }

    // Format hourly breakdown
    const hourlyBreakdown = hourlyRows.map(h => ({
      hour: h.hour,
      timeSlot: `${String(h.hour).padStart(2, '0')}:00 - ${String(h.hour + 1).padStart(2, '0')}:00`,
      orderCount: parseInt(h.order_count) || 0,
      sales: parseFloat(h.sales) || 0,
      guests: parseInt(h.guests) || 0
    }));

    // Format category breakdown
    const categoryBreakdown = categoryRows.map(c => ({
      categoryId: c.category_id,
      categoryName: c.category_name,
      itemsSold: parseInt(c.items_sold) || 0,
      totalQuantity: parseInt(c.total_quantity) || 0,
      totalSales: parseFloat(c.total_sales) || 0
    }));

    // Format top items
    const topSellingItems = topItemRows.map(i => ({
      itemId: i.item_id,
      itemName: i.item_name,
      categoryName: i.category_name,
      quantitySold: parseInt(i.quantity_sold) || 0,
      totalSales: parseFloat(i.total_sales) || 0,
      orderCount: parseInt(i.order_count) || 0
    }));

    // Format staff performance
    const staffPerformance = staffRows.map(s => ({
      userId: s.user_id,
      userName: s.user_name,
      roleName: s.role_name,
      ordersHandled: parseInt(s.orders_handled) || 0,
      totalSales: parseFloat(s.total_sales) || 0,
      avgOrderValue: parseFloat(s.avg_order_value) || 0
    }));

    // Format discounts
    const discountsApplied = discountRows.map(d => ({
      discountName: d.discount_name,
      discountType: d.discount_type,
      timesApplied: parseInt(d.times_applied) || 0,
      totalAmount: parseFloat(d.total_amount) || 0,
      approvedBy: d.approved_by_name
    }));

    // Format refunds
    const refunds = refundRows.map(r => ({
      id: r.id,
      orderNumber: r.order_number,
      orderTotal: parseFloat(r.order_total) || 0,
      refundAmount: parseFloat(r.refund_amount) || 0,
      reason: r.reason,
      refundedBy: r.refunded_by,
      createdAt: r.created_at
    }));

    // Format orders
    const orders = ordersRows.map(o => ({
      id: o.id,
      uuid: o.uuid,
      orderNumber: o.order_number,
      orderType: o.order_type,
      status: o.status,
      paymentStatus: o.payment_status,
      customerName: o.customer_name,
      customerPhone: o.customer_phone,
      guestCount: o.guest_count,
      tableNumber: o.table_number,
      floorName: o.floor_name,
      subtotal: parseFloat(o.subtotal) || 0,
      discountAmount: parseFloat(o.discount_amount) || 0,
      taxAmount: parseFloat(o.tax_amount) || 0,
      serviceCharge: parseFloat(o.service_charge) || 0,
      totalAmount: parseFloat(o.total_amount) || 0,
      paidAmount: parseFloat(o.paid_amount) || 0,
      dueAmount: parseFloat(o.due_amount) || 0,
      isNC: !!o.is_nc,
      ncAmount: parseFloat(o.nc_amount) || 0,
      ncReason: o.nc_reason || null,
      paymentMode: o.payment_mode,
      createdBy: o.created_by_name,
      createdAt: o.created_at,
      updatedAt: o.updated_at
    }));

    // Format floor breakdown
    const floorBreakdown = floorRows.map(f => ({
      floorName: f.floor_name,
      orderType: f.order_type,
      orderCount: parseInt(f.order_count) || 0,
      sales: parseFloat(f.sales) || 0
    }));

    // Format cancelled orders
    const cancelledOrders = cancelledRows.map(c => ({
      id: c.id,
      orderNumber: c.order_number,
      orderType: c.order_type,
      totalAmount: parseFloat(c.total_amount) || 0,
      customerName: c.customer_name,
      cancelReason: c.cancel_reason,
      createdBy: c.created_by_name,
      createdAt: c.created_at,
      cancelledAt: c.cancelled_at
    }));

    // Calculate totals for refunds
    const totalRefunds = refunds.reduce((sum, r) => sum + r.refundAmount, 0);
    const totalDiscounts = discountsApplied.reduce((sum, d) => sum + d.totalAmount, 0);

    // Cost/Profit data from order_item_costs for this date
    const [detailCostRows] = await pool.query(
      `SELECT COALESCE(SUM(oic.making_cost), 0) as making_cost,
              COALESCE(SUM(oic.profit), 0) as profit
       FROM order_item_costs oic
       JOIN orders o ON oic.order_id = o.id
       ${whereClause} AND o.status IN ('paid','completed')`,
      params
    );
    const detailMakingCost = parseFloat(detailCostRows[0]?.making_cost) || 0;
    const detailProfit = parseFloat(detailCostRows[0]?.profit) || 0;
    const detailTotalSales = parseFloat(summary.total_sales) || 0;
    const detailFoodCostPct = detailTotalSales > 0
      ? parseFloat(((detailMakingCost / detailTotalSales) * 100).toFixed(2)) : 0;

    // Wastage data for this date
    const [detailWastageRows] = await pool.query(
      `SELECT COUNT(*) as wastage_count, COALESCE(SUM(wl.total_cost), 0) as wastage_cost
       FROM wastage_logs wl
       WHERE wl.outlet_id = ? AND wl.wastage_date = ?`,
      [outletId, targetDate]
    );
    const detailWastageCount = parseInt(detailWastageRows[0]?.wastage_count) || 0;
    const detailWastageCost = parseFloat(detailWastageRows[0]?.wastage_cost) || 0;

    return {
      date: targetDate,
      summary: {
        totalOrders: parseInt(summary.total_orders) || 0,
        completedOrders: parseInt(summary.completed_orders) || 0,
        cancelledOrders: parseInt(summary.cancelled_orders) || 0,
        ordersByType: {
          dineIn: parseInt(summary.dine_in_orders) || 0,
          takeaway: parseInt(summary.takeaway_orders) || 0,
          delivery: parseInt(summary.delivery_orders) || 0
        },
        totalSales: detailTotalSales,
        grossSales: parseFloat(summary.gross_sales) || 0,
        totalDiscount: parseFloat(summary.total_discount) || 0,
        totalTax: parseFloat(summary.total_tax) || 0,
        totalServiceCharge: parseFloat(summary.total_service_charge) || 0,
        netSales: detailTotalSales - totalRefunds,
        totalGuests: parseInt(summary.total_guests) || 0,
        ncOrders: parseInt(summary.nc_orders) || 0,
        ncAmount: parseFloat(summary.nc_amount) || 0,
        dueAmount: parseFloat(summary.due_amount) || 0,
        paidAmount: parseFloat(summary.paid_amount) || 0,
        makingCost: detailMakingCost,
        profit: detailProfit,
        foodCostPercentage: detailFoodCostPct,
        wastageCount: detailWastageCount,
        wastageCost: detailWastageCost,
        avgOrderValue: parseFloat(summary.avg_order_value) || 0,
        maxOrderValue: parseFloat(summary.max_order_value) || 0,
        minOrderValue: parseFloat(summary.min_order_value) || 0,
        totalRefunds,
        totalDiscountsApplied: totalDiscounts
      },
      paymentBreakdown,
      hourlyBreakdown,
      categoryBreakdown,
      topSellingItems,
      staffPerformance,
      floorBreakdown,
      discountsApplied,
      refunds,
      cancelledOrders,
      orders,
      orderCount: orders.length
    };
  },

  // ========================
  // RUNNING ORDERS/TABLES DASHBOARD
  // ========================

  /**
   * Running Orders Dashboard - Active orders breakdown by type
   * Role-based: cashier sees only their orders, others see based on floor
   */
  async getRunningOrders(outletId, options = {}) {
    const pool = getPool();
    const { floorIds = [], userId = null, isCashier = false } = options;

    let conditions = ['o.outlet_id = ?', "o.status NOT IN ('paid', 'completed', 'cancelled')"];
    let params = [outletId];

    if (floorIds.length > 0) {
      conditions.push(`o.floor_id IN (${floorIds.map(() => '?').join(',')})`);
      params.push(...floorIds);
    }

    if (isCashier && userId) {
      conditions.push('(o.created_by = ? OR o.billed_by = ?)');
      params.push(userId, userId);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    // Get actual running orders as array
    const [orders] = await pool.query(
      `SELECT 
        o.id, o.order_number, o.order_type, o.status, o.payment_status,
        o.table_id, o.floor_id, o.customer_name, o.customer_phone,
        o.guest_count, o.subtotal, o.total_amount, o.discount_amount,
        o.is_priority, o.special_instructions, o.is_nc, o.nc_amount, o.nc_reason,
        o.created_at, o.updated_at,
        t.table_number, t.name as table_name,
        f.name as floor_name,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as item_count,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'ready') as ready_count,
        i.id as invoice_id, i.invoice_number, i.grand_total as invoice_total
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN invoices i ON i.order_id = o.id AND i.is_cancelled = 0
       ${whereClause}
       ORDER BY o.is_priority DESC, o.created_at DESC`,
      params
    );

    return orders;
  },

  /**
   * Running Tables - Active tables with order info
   */
  async getRunningTables(outletId, options = {}) {
    const pool = getPool();
    const { floorIds = [] } = options;

    // Include all non-available tables (occupied, running, reserved, billing, merged, etc.)
    let conditions = ['t.outlet_id = ?', "t.status != 'available'", 't.is_active = 1'];
    let params = [outletId];

    if (floorIds.length > 0) {
      conditions.push(`t.floor_id IN (${floorIds.map(() => '?').join(',')})`);
      params.push(...floorIds);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const [tables] = await pool.query(
      `SELECT 
        t.id, t.table_number, t.name as table_name, t.capacity, t.status,
        f.name as floor_name, f.id as floor_id,
        o.id as order_id, o.order_number, o.status as order_status,
        o.total_amount, o.guest_count, o.is_nc, o.nc_amount,
        o.created_at as order_started,
        u.name as captain_name
       FROM tables t
       LEFT JOIN floors f ON t.floor_id = f.id
       LEFT JOIN orders o ON o.table_id = t.id AND o.status NOT IN ('paid', 'completed', 'cancelled')
       LEFT JOIN users u ON o.created_by = u.id
       ${whereClause}
       ORDER BY f.display_order, t.table_number`,
      params
    );

    // Group by floor with enhanced structure
    const floors = [];
    const floorMap = {};
    
    for (const t of tables) {
      const floorKey = t.floor_name || 'Unassigned';
      if (!floorMap[floorKey]) {
        floorMap[floorKey] = {
          floorId: t.floor_id,
          floorName: floorKey,
          tableCount: 0,
          totalAmount: 0,
          totalGuests: 0,
          tables: []
        };
        floors.push(floorMap[floorKey]);
      }
      
      const duration = t.order_started ? Math.round((Date.now() - new Date(t.order_started).getTime()) / 60000) : 0;
      const tableAmount = parseFloat(t.total_amount) || 0;
      const ncAmount = parseFloat(t.nc_amount) || 0;
      const guestCount = t.guest_count || 0;
      
      floorMap[floorKey].tableCount++;
      floorMap[floorKey].totalAmount += tableAmount;
      floorMap[floorKey].totalGuests += guestCount;
      
      floorMap[floorKey].tables.push({
        tableId: t.id,
        tableNumber: t.table_number,
        tableName: t.table_name,
        capacity: t.capacity,
        guestCount: guestCount,
        order: t.order_id ? {
          id: t.order_id,
          orderNumber: t.order_number,
          status: t.order_status,
          totalAmount: tableAmount,
          isNC: !!t.is_nc,
          ncAmount: ncAmount,
          payableAmount: tableAmount - ncAmount,
          startedAt: t.order_started,
          durationMinutes: duration,
          durationFormatted: duration >= 60 ? `${Math.floor(duration / 60)}h ${duration % 60}m` : `${duration}m`
        } : null,
        captain: t.captain_name ? {
          name: t.captain_name
        } : null
      });
    }

    const totalAmount = tables.reduce((s, t) => s + (parseFloat(t.total_amount) || 0), 0);
    const totalGuests = tables.reduce((s, t) => s + (t.guest_count || 0), 0);

    return {
      summary: {
        totalOccupiedTables: tables.length,
        totalFloors: floors.length,
        totalGuests: totalGuests,
        totalAmount: totalAmount,
        formattedAmount: `₹${totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
      },
      floors: floors
    };
  },

  // ========================
  // BILLER/CASHIER WISE REPORT
  // ========================

  /**
   * Biller-wise sales report
   */
  async getBillerWiseReport(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);
    const { floorIds = [], userId = null } = options;

    let conditions = ['o.outlet_id = ?', `${toISTDate('o.created_at')} BETWEEN ? AND ?`, 'o.billed_by IS NOT NULL'];
    let params = [outletId, start, end];

    if (floorIds.length > 0) {
      conditions.push(`o.floor_id IN (${floorIds.map(() => '?').join(',')})`);
      params.push(...floorIds);
    }

    // If userId provided (cashier), only show their data
    if (userId) {
      conditions.push('o.billed_by = ?');
      params.push(userId);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const [rows] = await pool.query(
      `SELECT 
        o.billed_by as user_id, u.name as biller_name,
        COUNT(*) as total_bills,
        SUM(o.guest_count) as total_pax,
        SUM(CASE WHEN o.status != 'cancelled' THEN (o.subtotal - o.discount_amount) ELSE 0 END) as total_sales,
        SUM(o.discount_amount) as total_discount,
        SUM(o.tax_amount) as total_tax,
        SUM(o.service_charge) as total_sc,
        COUNT(CASE WHEN o.status = 'cancelled' THEN 1 END) as cancelled_bills,
        COUNT(CASE WHEN o.is_nc = 1 THEN 1 END) as nc_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.due_amount, 0) ELSE 0 END) as due_amount,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.paid_amount, 0) ELSE 0 END) as paid_amount
       FROM orders o
       JOIN users u ON o.billed_by = u.id
       ${whereClause}
       GROUP BY o.billed_by, u.name
       ORDER BY total_sales DESC`,
      params
    );

    // Get payment breakdown per biller
    const [payments] = await pool.query(
      `SELECT 
        o.billed_by as user_id,
        p.payment_mode,
        SUM(p.total_amount) as amount
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       JOIN users u ON o.billed_by = u.id
       ${whereClause} AND p.status = 'completed'
       GROUP BY o.billed_by, p.payment_mode`,
      params
    );

    const paymentByBiller = {};
    for (const p of payments) {
      if (!paymentByBiller[p.user_id]) paymentByBiller[p.user_id] = {};
      paymentByBiller[p.user_id][p.payment_mode] = parseFloat(p.amount) || 0;
    }

    const billers = rows.map(r => ({
      userId: r.user_id,
      billerName: r.biller_name,
      totalBills: parseInt(r.total_bills) || 0,
      totalPax: parseInt(r.total_pax) || 0,
      totalSales: parseFloat(r.total_sales) || 0,
      totalDiscount: parseFloat(r.total_discount) || 0,
      totalTax: parseFloat(r.total_tax) || 0,
      totalServiceCharge: parseFloat(r.total_sc) || 0,
      cancelledBills: parseInt(r.cancelled_bills) || 0,
      ncOrders: parseInt(r.nc_orders) || 0,
      ncAmount: parseFloat(r.nc_amount) || 0,
      dueAmount: parseFloat(r.due_amount) || 0,
      paidAmount: parseFloat(r.paid_amount) || 0,
      avgBillValue: r.total_bills > 0 ? parseFloat((r.total_sales / r.total_bills).toFixed(2)) : 0,
      paxPerBill: r.total_bills > 0 ? parseFloat((r.total_pax / r.total_bills).toFixed(1)) : 0,
      payments: paymentByBiller[r.user_id] || {}
    }));

    const grandTotal = {
      totalBills: billers.reduce((s, b) => s + b.totalBills, 0),
      totalPax: billers.reduce((s, b) => s + b.totalPax, 0),
      totalSales: parseFloat(billers.reduce((s, b) => s + b.totalSales, 0).toFixed(2)),
      totalDiscount: parseFloat(billers.reduce((s, b) => s + b.totalDiscount, 0).toFixed(2)),
      ncOrders: billers.reduce((s, b) => s + b.ncOrders, 0),
      ncAmount: parseFloat(billers.reduce((s, b) => s + b.ncAmount, 0).toFixed(2)),
      dueAmount: parseFloat(billers.reduce((s, b) => s + b.dueAmount, 0).toFixed(2)),
      paidAmount: parseFloat(billers.reduce((s, b) => s + b.paidAmount, 0).toFixed(2))
    };

    return {
      dateRange: { start, end },
      billers,
      grandTotal,
      billerCount: billers.length
    };
  },

  // ========================
  // NC (NO CHARGE) REPORT
  // ========================

  /**
   * NC Report — comprehensive NC data with filters, pagination, sorting
   * Supports order-level NC and item-level NC separately
   *
   * @param {number} outletId
   * @param {string} startDate
   * @param {string} endDate
   * @param {Object} options
   * @param {number}  options.page          - 1-indexed page (default 1)
   * @param {number}  options.limit         - items per page (default 50, max 200)
   * @param {string}  options.search        - search in order_number, item_name, nc_reason
   * @param {string}  options.ncType        - 'order' | 'item' | 'all' (default 'all')
   * @param {string}  options.ncReason      - filter by NC reason text (partial match)
   * @param {string}  options.appliedByName - filter by staff who applied NC
   * @param {string}  options.orderType     - dine_in | takeaway | delivery
   * @param {string}  options.floorName     - partial match on floor name
   * @param {string}  options.sortBy        - nc_at | nc_amount | order_number (default nc_at)
   * @param {string}  options.sortOrder     - ASC | DESC (default DESC)
   * @param {Array}   options.floorIds      - floor restriction
   */
  async getNCReport(outletId, startDate, endDate, options = {}) {
    const pool = getPool();
    const { start, end } = this._dateRange(startDate, endDate);

    const page = Math.max(1, parseInt(options.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(options.limit) || 50));
    const offset = (page - 1) * limit;
    const search = (options.search || '').trim();
    const ncType = options.ncType || 'all';
    const ff = floorFilter(options.floorIds || []);

    // ── 1. ORDER-LEVEL NC (orders where is_nc = 1 — whole order marked NC) ──
    let orderConditions = [
      'o.outlet_id = ?',
      `${toISTDate('o.created_at')} BETWEEN ? AND ?`,
      'o.is_nc = 1'
    ];
    let orderParams = [outletId, start, end];

    if (ff.sql) {
      orderConditions.push(ff.sql.replace(/^ AND /, ''));
      orderParams.push(...ff.params);
    }
    if (options.orderType) {
      orderConditions.push('o.order_type = ?');
      orderParams.push(options.orderType);
    }
    if (options.floorName) {
      orderConditions.push('f.name LIKE ?');
      orderParams.push(`%${options.floorName}%`);
    }
    if (options.appliedByName) {
      orderConditions.push('ua.name LIKE ?');
      orderParams.push(`%${options.appliedByName}%`);
    }
    if (options.ncReason) {
      orderConditions.push('o.nc_reason LIKE ?');
      orderParams.push(`%${options.ncReason}%`);
    }
    if (search) {
      orderConditions.push('(o.order_number LIKE ? OR o.nc_reason LIKE ?)');
      orderParams.push(`%${search}%`, `%${search}%`);
    }

    const orderWhere = 'WHERE ' + orderConditions.join(' AND ');

    // Order-level NC count
    const [orderCountResult] = await pool.query(
      `SELECT COUNT(*) as total FROM orders o
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users ua ON o.nc_approved_by = ua.id
       ${orderWhere}`,
      orderParams
    );
    const totalOrderNC = orderCountResult[0]?.total || 0;

    // Order-level NC data (paginated)
    const validOrderSorts = ['nc_at', 'nc_amount', 'order_number', 'created_at', 'total_amount'];
    const orderSortCol = validOrderSorts.includes(options.sortBy) ? `o.${options.sortBy}` : 'o.nc_at';
    const sortDir = (options.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const [orderNCRows] = await pool.query(
      `SELECT 
        o.id as order_id, o.order_number, o.order_type, o.status,
        o.subtotal, o.tax_amount, o.discount_amount, o.total_amount,
        o.nc_amount, o.nc_reason, o.nc_reason_id,
        o.paid_amount, o.due_amount, o.guest_count,
        o.is_nc as order_is_nc,
        o.nc_at, o.created_at,
        f.name as floor_name, t.table_number,
        uc.name as captain_name,
        ua.name as nc_approved_by_name,
        nr.name as nc_reason_name
       FROM orders o
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN users uc ON o.created_by = uc.id
       LEFT JOIN users ua ON o.nc_approved_by = ua.id
       LEFT JOIN nc_reasons nr ON o.nc_reason_id = nr.id
       ${orderWhere}
       ORDER BY ${orderSortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...orderParams, limit, offset]
    );

    // ── 2. ITEM-LEVEL NC (individual items marked NC, but order itself NOT fully NC) ──
    let itemConditions = [
      'o.outlet_id = ?',
      `${toISTDate('o.created_at')} BETWEEN ? AND ?`,
      'oi.is_nc = 1',
      'oi.status != ?'
    ];
    let itemParams = [outletId, start, end, 'cancelled'];

    if (ff.sql) {
      itemConditions.push(ff.sql.replace(/^ AND /, ''));
      itemParams.push(...ff.params);
    }
    if (options.orderType) {
      itemConditions.push('o.order_type = ?');
      itemParams.push(options.orderType);
    }
    if (options.floorName) {
      itemConditions.push('f.name LIKE ?');
      itemParams.push(`%${options.floorName}%`);
    }
    if (options.appliedByName) {
      itemConditions.push('unc.name LIKE ?');
      itemParams.push(`%${options.appliedByName}%`);
    }
    if (options.ncReason) {
      itemConditions.push('oi.nc_reason LIKE ?');
      itemParams.push(`%${options.ncReason}%`);
    }
    if (search) {
      itemConditions.push('(o.order_number LIKE ? OR oi.item_name LIKE ? OR oi.nc_reason LIKE ?)');
      itemParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const itemWhere = 'WHERE ' + itemConditions.join(' AND ');

    // Item-level NC count
    const [itemCountResult] = await pool.query(
      `SELECT COUNT(*) as total FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users unc ON oi.nc_by = unc.id
       ${itemWhere}`,
      itemParams
    );
    const totalItemNC = itemCountResult[0]?.total || 0;

    // Item-level NC data (paginated)
    const validItemSorts = ['nc_at', 'nc_amount', 'item_name', 'quantity'];
    let itemSortCol = 'oi.nc_at';
    if (options.sortBy === 'nc_amount') itemSortCol = 'oi.nc_amount';
    else if (options.sortBy === 'item_name') itemSortCol = 'oi.item_name';
    else if (options.sortBy === 'quantity') itemSortCol = 'oi.quantity';
    else if (options.sortBy === 'order_number') itemSortCol = 'o.order_number';

    const [itemNCRows] = await pool.query(
      `SELECT 
        oi.id as order_item_id, oi.order_id,
        oi.item_name, oi.variant_name,
        oi.quantity, oi.unit_price, oi.total_price,
        oi.nc_amount, oi.nc_reason, oi.nc_reason_id,
        oi.nc_at, oi.is_nc as item_is_nc,
        o.order_number, o.order_type, o.status as order_status,
        o.is_nc as order_is_nc,
        f.name as floor_name, t.table_number,
        uc.name as captain_name,
        unc.name as nc_by_name,
        nr.name as nc_reason_name
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN users uc ON o.created_by = uc.id
       LEFT JOIN users unc ON oi.nc_by = unc.id
       LEFT JOIN nc_reasons nr ON oi.nc_reason_id = nr.id
       ${itemWhere}
       ORDER BY ${itemSortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...itemParams, limit, offset]
    );

    // ── 3. SUMMARY STATS (across ALL filtered data, not paginated) ──
    const [summaryRows] = await pool.query(
      `SELECT
        COUNT(DISTINCT CASE WHEN o.is_nc = 1 THEN o.id END) as total_order_nc,
        SUM(CASE WHEN o.is_nc = 1 THEN o.nc_amount ELSE 0 END) as order_nc_amount,
        COUNT(CASE WHEN oi.is_nc = 1 AND oi.status != 'cancelled' AND o.is_nc = 0 THEN 1 END) as total_item_nc,
        SUM(CASE WHEN oi.is_nc = 1 AND oi.status != 'cancelled' AND o.is_nc = 0 THEN oi.nc_amount ELSE 0 END) as item_nc_amount
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?${ff.sql}`,
      [outletId, start, end, ...ff.params]
    );
    const sr = summaryRows[0];
    const totalOrderNCAmount = parseFloat(sr?.order_nc_amount) || 0;
    const itemOnlyNCAmount = parseFloat(sr?.item_nc_amount) || 0;

    // ── 4. BREAKDOWNS ──

    // By Reason (order-level NC)
    const [byReason] = await pool.query(
      `SELECT 
        COALESCE(oi.nc_reason, sub.nc_reason, 'Unknown') as reason,
        COUNT(*) as count,
        SUM(COALESCE(oi.nc_amount, sub.nc_amount, 0)) as total_amount
       FROM (
         SELECT o.id, o.nc_reason, o.nc_amount, o.outlet_id, o.created_at FROM orders o
         WHERE o.is_nc = 1 AND o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?${ff.sql}
       ) sub
       LEFT JOIN order_items oi ON sub.id = oi.order_id AND oi.is_nc = 1 AND oi.status != 'cancelled'
       GROUP BY reason
       ORDER BY total_amount DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Items-only NC by reason (items NC'd individually, not whole-order NC)
    const [itemByReason] = await pool.query(
      `SELECT 
        COALESCE(oi.nc_reason, 'Unknown') as reason,
        COUNT(*) as count,
        SUM(oi.nc_amount) as total_amount
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?
         AND oi.is_nc = 1 AND oi.status != 'cancelled' AND o.is_nc = 0${ff.sql}
       GROUP BY reason
       ORDER BY total_amount DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Merge reason breakdowns
    const reasonMap = {};
    for (const r of byReason) {
      reasonMap[r.reason] = { reason: r.reason, count: r.count, totalAmount: parseFloat(r.total_amount) || 0, type: 'order' };
    }
    for (const r of itemByReason) {
      if (reasonMap[r.reason]) {
        reasonMap[r.reason].count += r.count;
        reasonMap[r.reason].totalAmount += parseFloat(r.total_amount) || 0;
        reasonMap[r.reason].type = 'mixed';
      } else {
        reasonMap[r.reason] = { reason: r.reason, count: r.count, totalAmount: parseFloat(r.total_amount) || 0, type: 'item' };
      }
    }

    // By Staff
    const [byStaff] = await pool.query(
      `SELECT 
        u.id as user_id, u.name as user_name,
        COUNT(*) as count,
        SUM(nl.nc_amount) as total_amount
       FROM nc_logs nl
       JOIN users u ON nl.applied_by = u.id
       WHERE nl.outlet_id = ? AND DATE(nl.applied_at) BETWEEN ? AND ?
         AND nl.action_type IN ('item_nc', 'order_nc')
       GROUP BY u.id, u.name
       ORDER BY total_amount DESC`,
      [outletId, start, end]
    );

    // By Date
    const [byDate] = await pool.query(
      `SELECT 
        ${toISTDate('o.created_at')} as report_date,
        COUNT(DISTINCT CASE WHEN o.is_nc = 1 THEN o.id END) as order_nc_count,
        SUM(CASE WHEN o.is_nc = 1 THEN o.nc_amount ELSE 0 END) as order_nc_amount,
        COUNT(DISTINCT CASE WHEN oi.is_nc = 1 AND oi.status != 'cancelled' AND o.is_nc = 0 THEN oi.id END) as item_nc_count,
        SUM(CASE WHEN oi.is_nc = 1 AND oi.status != 'cancelled' AND o.is_nc = 0 THEN oi.nc_amount ELSE 0 END) as item_nc_amount
       FROM orders o
       LEFT JOIN order_items oi ON o.id = oi.order_id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?
         AND (o.is_nc = 1 OR (oi.is_nc = 1 AND oi.status != 'cancelled'))${ff.sql}
       GROUP BY ${toISTDate('o.created_at')}
       ORDER BY report_date DESC`,
      [outletId, start, end, ...ff.params]
    );

    // Top NC Items
    const [topNCItems] = await pool.query(
      `SELECT 
        oi.item_name, oi.variant_name,
        COUNT(*) as nc_count,
        SUM(oi.nc_amount) as total_nc_amount,
        SUM(oi.quantity) as total_quantity
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.outlet_id = ? AND ${toISTDate('o.created_at')} BETWEEN ? AND ?
         AND oi.is_nc = 1 AND oi.status != 'cancelled'${ff.sql}
       GROUP BY oi.item_name, oi.variant_name
       ORDER BY total_nc_amount DESC
       LIMIT 20`,
      [outletId, start, end, ...ff.params]
    );

    // ── 5. FORMAT RESPONSE ──
    const orderNCList = orderNCRows.map(r => ({
      orderId: r.order_id,
      orderNumber: r.order_number,
      orderType: r.order_type,
      status: r.status,
      subtotal: parseFloat(r.subtotal) || 0,
      taxAmount: parseFloat(r.tax_amount) || 0,
      discountAmount: parseFloat(r.discount_amount) || 0,
      totalAmount: parseFloat(r.total_amount) || 0,
      ncAmount: parseFloat(r.nc_amount) || 0,
      ncReason: r.nc_reason || r.nc_reason_name || null,
      ncApprovedBy: r.nc_approved_by_name || null,
      ncAt: r.nc_at,
      paidAmount: parseFloat(r.paid_amount) || 0,
      dueAmount: parseFloat(r.due_amount) || 0,
      guestCount: r.guest_count || 0,
      floorName: r.floor_name || null,
      tableNumber: r.table_number || null,
      captainName: r.captain_name || null,
      createdAt: r.created_at,
      isNC: true, // whole order NC
      ncLevel: 'order'
    }));

    const itemNCList = itemNCRows.map(r => ({
      orderItemId: r.order_item_id,
      orderId: r.order_id,
      orderNumber: r.order_number,
      orderType: r.order_type,
      orderStatus: r.order_status,
      orderIsNC: !!r.order_is_nc,
      itemName: r.item_name,
      variantName: r.variant_name || null,
      quantity: parseFloat(r.quantity) || 0,
      unitPrice: parseFloat(r.unit_price) || 0,
      totalPrice: parseFloat(r.total_price) || 0,
      ncAmount: parseFloat(r.nc_amount) || 0,
      ncReason: r.nc_reason || r.nc_reason_name || null,
      ncBy: r.nc_by_name || null,
      ncAt: r.nc_at,
      floorName: r.floor_name || null,
      tableNumber: r.table_number || null,
      captainName: r.captain_name || null,
      isNC: true,
      ncLevel: 'item'
    }));

    return {
      dateRange: { start, end },
      summary: {
        totalOrderNC: parseInt(sr?.total_order_nc) || 0,
        orderNCAmount: parseFloat(totalOrderNCAmount.toFixed(2)),
        totalItemNC: parseInt(sr?.total_item_nc) || 0,
        itemNCAmount: parseFloat(itemOnlyNCAmount.toFixed(2)),
        totalNCAmount: parseFloat((totalOrderNCAmount + itemOnlyNCAmount).toFixed(2)),
        totalNCEntries: (parseInt(sr?.total_order_nc) || 0) + (parseInt(sr?.total_item_nc) || 0)
      },
      orderNC: {
        data: ncType === 'item' ? [] : orderNCList,
        pagination: {
          page, limit,
          total: totalOrderNC,
          totalPages: Math.ceil(totalOrderNC / limit)
        }
      },
      itemNC: {
        data: ncType === 'order' ? [] : itemNCList,
        pagination: {
          page, limit,
          total: totalItemNC,
          totalPages: Math.ceil(totalItemNC / limit)
        }
      },
      breakdowns: {
        byReason: Object.values(reasonMap).sort((a, b) => b.totalAmount - a.totalAmount),
        byStaff: byStaff.map(s => ({
          userId: s.user_id,
          userName: s.user_name,
          count: s.count,
          totalAmount: parseFloat(s.total_amount) || 0
        })),
        byDate: byDate.map(d => ({
          date: d.report_date,
          orderNCCount: parseInt(d.order_nc_count) || 0,
          orderNCAmount: parseFloat(d.order_nc_amount) || 0,
          itemNCCount: parseInt(d.item_nc_count) || 0,
          itemNCAmount: parseFloat(d.item_nc_amount) || 0,
          totalNCAmount: (parseFloat(d.order_nc_amount) || 0) + (parseFloat(d.item_nc_amount) || 0)
        })),
        topNCItems: topNCItems.map(i => ({
          itemName: i.item_name,
          variantName: i.variant_name || null,
          ncCount: parseInt(i.nc_count) || 0,
          totalNCAmount: parseFloat(i.total_nc_amount) || 0,
          totalQuantity: parseFloat(i.total_quantity) || 0
        }))
      }
    };
  }
};

module.exports = reportsService;
