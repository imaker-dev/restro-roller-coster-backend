/**
 * Super Admin Master Dashboard Service
 *
 * Aggregates today's sales across outlets owned/assigned to the user.
 * - master role: sees ALL outlets
 * - super_admin role: sees only outlets they created OR are assigned via user_roles
 * - Business day: 4:00 AM IST to 3:59:59 AM IST next day (identical to getDailySalesReport)
 * - total_sale = SUM(o.total_amount) WHERE status = 'completed'  (exact match to daily sales report)
 * - total_orders = COUNT(*) WHERE status = 'completed'           (exact match to daily sales report)
 * - Cached in Redis for 30 minutes per user + business date
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const BUSINESS_DAY_START_HOUR = 4;
const CACHE_TTL_SECONDS = 1800; // 30 minutes

/**
 * Returns the current IST business-day date string (YYYY-MM-DD).
 * Before 4 AM → previous calendar day (still in yesterday's business day).
 */
function getLocalDate() {
  const now = new Date();
  const shifted = new Date(now.getTime() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns { startDt, endDt } for a business-day range.
 * Identical logic to order.service.js / reports.service.js.
 */
function businessDayRange(startDate, endDate) {
  const h = `${String(BUSINESS_DAY_START_HOUR).padStart(2, '0')}:00:00`;
  const startDt = `${startDate} ${h}`;
  const ed = new Date(`${endDate}T00:00:00`);
  ed.setDate(ed.getDate() + 1);
  const endStr = `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, '0')}-${String(ed.getDate()).padStart(2, '0')}`;
  const endDt = `${endStr} ${h}`;
  return { startDt, endDt };
}

const superAdminDashboardService = {

  /**
   * Main entry point.
   * Returns cached data if available; fetches fresh otherwise.
   * Sort is applied in-memory so a single cache entry covers all sort variants.
   *
   * @param {object} options
   * @param {number} options.userId - Required: the logged-in user's ID
   * @param {string} options.sort   - 'total_sale' | 'total_orders' | 'outlet_name' (default: 'total_sale')
   * @param {string} options.order  - 'asc' | 'desc' (default: 'desc')
   * @param {boolean} options.forceRefresh - bypass cache (default: false)
   */
  async getDashboard({ userId, sort = 'total_sale', order = 'desc', forceRefresh = false } = {}) {
    if (!userId) throw new Error('userId is required');

    const today = getLocalDate();
    const cacheKey = `super_admin:dashboard:${userId}:${today}`;

    if (!forceRefresh) {
      try {
        const cached = await cache.get(cacheKey);
        if (cached) {
          return this._applySort(cached, sort, order);
        }
      } catch (err) {
        logger.warn('Super admin dashboard cache get failed:', err.message);
      }
    }

    const fresh = await this._fetchFresh(today, userId);

    cache.set(cacheKey, fresh, CACHE_TTL_SECONDS).catch(err =>
      logger.warn('Super admin dashboard cache set failed:', err.message)
    );

    return this._applySort(fresh, sort, order);
  },

  /**
   * Fetch live data from DB.
   * - master: all outlets
   * - super_admin: outlets created by user OR assigned via user_roles
   *
   * @param {string} today  - YYYY-MM-DD business date
   * @param {number} userId - logged-in user ID
   */
  async _fetchFresh(today, userId) {
    const pool = getPool();
    const { startDt, endDt } = businessDayRange(today, today);
    const fetchedAt = new Date().toISOString();

    // Check if user is master or super_admin
    const [roleCheck] = await pool.query(
      `SELECT r.slug FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE ur.user_id = ? AND ur.is_active = 1 AND r.slug IN ('master', 'super_admin')
       LIMIT 1`,
      [userId]
    );
    const isMaster = roleCheck.length > 0 && roleCheck[0].slug === 'master';

    // Get outlets based on role
    let outletsRes;
    if (isMaster) {
      // Master sees all active outlets
      [outletsRes] = await pool.query(
        `SELECT id, name, phone, city, state, is_active
         FROM outlets WHERE is_active = 1
         ORDER BY id ASC`
      );
    } else {
      // Super admin: outlets they created OR assigned via user_roles
      [outletsRes] = await pool.query(
        `SELECT DISTINCT o.id, o.name, o.phone, o.city, o.state, o.is_active
         FROM outlets o
         WHERE o.is_active = 1
           AND (o.created_by = ? OR o.id IN (
             SELECT ur.outlet_id FROM user_roles ur
             WHERE ur.user_id = ? AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
           ))
         ORDER BY o.id ASC`,
        [userId, userId]
      );
    }

    const outlets = outletsRes;
    const outletIds = outlets.map(o => o.id);

    // Get sales for these outlets only (skip if no outlets)
    let salesMap = Object.create(null);
    if (outletIds.length > 0) {
      const [salesRes] = await pool.query(
        `SELECT
           o.outlet_id,
           COUNT(*)                as total_orders,
           SUM(o.total_amount)     as total_sale
         FROM orders o
         WHERE o.status = 'completed'
           AND o.created_at >= ? AND o.created_at < ?
           AND o.outlet_id IN (?)
         GROUP BY o.outlet_id`,
        [startDt, endDt, outletIds]
      );
      for (const row of salesRes) {
        salesMap[row.outlet_id] = {
          totalOrders: parseInt(row.total_orders) || 0,
          totalSale:   parseFloat(row.total_sale)  || 0,
        };
      }
    }

    const outletData = outlets.map(o => {
      const s = salesMap[o.id] || { totalOrders: 0, totalSale: 0 };
      return {
        outletId:    o.id,
        outletName:  o.name,
        outletPhone: o.phone  || null,
        city:        o.city   || null,
        state:       o.state  || null,
        isActive:    !!o.is_active,
        totalOrders: s.totalOrders,
        totalSale:   parseFloat(s.totalSale.toFixed(2)),
      };
    });

    const grandTotalOrders = outletData.reduce((s, o) => s + o.totalOrders, 0);
    const grandTotalSale   = outletData.reduce((s, o) => s + o.totalSale,   0);

    return {
      businessDate: today,
      period: { from: startDt, to: endDt },
      outlets: outletData,
      summary: {
        totalOutlets:      outlets.length,
        activeOutlets:     outlets.filter(o => o.is_active).length,
        grandTotalOrders,
        grandTotalSale:    parseFloat(grandTotalSale.toFixed(2)),
      },
      cachedAt:      fetchedAt,
      nextRefreshAt: new Date(new Date(fetchedAt).getTime() + CACHE_TTL_SECONDS * 1000).toISOString(),
    };
  },

  /**
   * Apply in-memory sort to the outlet list (non-destructive — returns new object).
   *
   * @param {object} data  - raw dashboard payload
   * @param {string} sort  - 'total_sale' | 'total_orders' | 'outlet_name'
   * @param {string} order - 'asc' | 'desc'
   */
  _applySort(data, sort, order) {
    const KEY_MAP = {
      total_sale:   'totalSale',
      total_orders: 'totalOrders',
      outlet_name:  'outletName',
    };
    const key = KEY_MAP[sort] || 'totalSale';
    const asc = order === 'asc';

    const sorted = [...data.outlets].sort((a, b) => {
      if (typeof a[key] === 'string') {
        return asc ? a[key].localeCompare(b[key]) : b[key].localeCompare(a[key]);
      }
      return asc ? a[key] - b[key] : b[key] - a[key];
    });

    return { ...data, outlets: sorted };
  },
};

module.exports = superAdminDashboardService;
