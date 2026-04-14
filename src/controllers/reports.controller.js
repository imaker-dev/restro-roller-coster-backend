const reportsService = require('../services/reports.service');
const userService = require('../services/user.service');
const logger = require('../utils/logger');
const csvExport = require('../utils/csv-export');

/**
 * Role-based data scoping
 * - super_admin/admin: All data (no floor restriction)
 * - manager: Data for assigned floors only
 * - cashier: Only their own billed/created orders
 * - captain/waiter: Data for assigned floors only
 */
const ADMIN_ROLES = ['super_admin', 'admin'];
const MANAGER_ROLES = ['manager'];
const CASHIER_ROLES = ['cashier'];
const STAFF_ROLES = ['captain', 'waiter', 'bartender', 'kitchen'];

/**
 * Get user's data scope based on role and floor assignments
 */
async function getUserDataScope(user, outletId) {
  const roles = user.roles || [];
  const roleSlug = roles[0]?.slug || user.role;
  
  // Admin sees everything
  if (ADMIN_ROLES.includes(roleSlug)) {
    return { floorIds: [], userId: null, isCashier: false, isAdmin: true, roleSlug };
  }
  
  // Cashier sees only their own data
  if (CASHIER_ROLES.includes(roleSlug)) {
    const floorIds = await getUserFloorIds(user.userId, outletId);
    return { floorIds, userId: user.userId, isCashier: true, isAdmin: false, roleSlug };
  }
  
  // Manager and staff see their assigned floors
  const floorIds = await getUserFloorIds(user.userId, outletId);
  return { floorIds, userId: user.userId, isCashier: false, isAdmin: false, roleSlug };
}

/**
 * Get floor IDs assigned to user
 */
async function getUserFloorIds(userId, outletId) {
  if (!userId || !outletId) return [];
  try {
    const floors = await userService.getUserFloors(userId, outletId);
    return floors.map(f => f.floorId);
  } catch (e) {
    return [];
  }
}

// ========================
// DAY END SUMMARY
// ========================

/**
 * GET /api/v1/reports/day-end-summary
 * Day End Summary report with role-based filtering
 */
const getDayEndSummary = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getDayEndSummary(
      parseInt(outletId),
      startDate,
      endDate,
      {
        floorIds: scope.floorIds,
        userId: scope.userId,
        isCashier: scope.isCashier
      }
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: {
        role: scope.roleSlug,
        isFiltered: !scope.isAdmin,
        floorRestricted: scope.floorIds.length > 0
      }
    });
  } catch (error) {
    logger.error('Get Day End Summary failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/day-end-summary/detail
 * Day End Summary Detail - Comprehensive details for a specific date
 */
const getDayEndSummaryDetail = async (req, res, next) => {
  try {
    const { outletId, date, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    // Support both 'date' and 'startDate' parameters for flexibility
    const targetDate = date || startDate || endDate;

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getDayEndSummaryDetail(
      parseInt(outletId),
      targetDate,
      {
        floorIds: scope.floorIds,
        userId: scope.userId,
        isCashier: scope.isCashier
      }
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: {
        role: scope.roleSlug,
        isFiltered: !scope.isAdmin,
        floorRestricted: scope.floorIds.length > 0
      }
    });
  } catch (error) {
    logger.error('Get Day End Summary Detail failed:', error);
    next(error);
  }
};

// ========================
// RUNNING ORDERS/TABLES
// ========================

/**
 * GET /api/v1/reports/running-orders
 * Running orders dashboard with role-based filtering
 */
const getRunningOrders = async (req, res, next) => {
  try {
    const { outletId } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getRunningOrders(
      parseInt(outletId),
      {
        floorIds: scope.floorIds,
        userId: scope.userId,
        isCashier: scope.isCashier
      }
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Running Orders failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/running-tables
 * Running tables with role-based filtering
 */
const getRunningTables = async (req, res, next) => {
  try {
    const { outletId } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getRunningTables(
      parseInt(outletId),
      { floorIds: scope.floorIds }
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Running Tables failed:', error);
    next(error);
  }
};

// ========================
// SALES REPORTS
// ========================

/**
 * GET /api/v1/reports/daily-sales
 * Daily sales report with role-based filtering
 */
const getDailySalesReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getDailySalesReport(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds,
      { cashierId: scope.userId, isCashierOnly: scope.isCashier }
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Daily Sales Report failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/daily-sales-detail
 * Detailed daily sales with role-based filtering
 */
const getDailySalesDetail = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate, ...filters } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getDailySalesDetail(
      parseInt(outletId),
      startDate,
      endDate,
      { ...filters, floorIds: scope.floorIds, cashierId: scope.userId, isCashierOnly: scope.isCashier }
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Daily Sales Detail failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/item-sales
 * Item sales report with role-based filtering
 */
const getItemSalesReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate, limit, serviceType } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getItemSalesReport(
      parseInt(outletId),
      startDate,
      endDate,
      parseInt(limit) || 50,
      scope.floorIds,
      serviceType
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Item Sales Report failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/category-sales
 * Category sales report with role-based filtering
 */
const getCategorySalesReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate, serviceType } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getCategorySalesReport(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds,
      serviceType
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Category Sales Report failed:', error);
    next(error);
  }
};

// ========================
// BILLER/CASHIER WISE
// ========================

/**
 * GET /api/v1/reports/biller-wise
 * Biller-wise (Pax Sales) report with role-based filtering
 */
const getBillerWiseReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    // Cashier sees only their own data
    const userId = scope.isCashier ? scope.userId : null;
    
    const result = await reportsService.getBillerWiseReport(
      parseInt(outletId),
      startDate,
      endDate,
      { floorIds: scope.floorIds, userId }
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin || scope.isCashier }
    });
  } catch (error) {
    logger.error('Get Biller Wise Report failed:', error);
    next(error);
  }
};

// ========================
// STAFF PERFORMANCE
// ========================

/**
 * GET /api/v1/reports/staff
 * Staff performance report with role-based filtering
 */
const getStaffReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getStaffReport(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Staff Report failed:', error);
    next(error);
  }
};

// ========================
// TAX & PAYMENT REPORTS
// ========================

/**
 * GET /api/v1/reports/tax
 * Tax report with role-based filtering
 */
const getTaxReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getTaxReport(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Tax Report failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/payment-modes
 * Payment mode breakdown with role-based filtering
 */
const getPaymentModeReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getPaymentModeReport(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Payment Mode Report failed:', error);
    next(error);
  }
};

// ========================
// CANCELLATION REPORTS
// ========================

/**
 * GET /api/v1/reports/cancellations
 * Cancellation report with role-based filtering
 */
const getCancellationReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getCancellationReport(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Cancellation Report failed:', error);
    next(error);
  }
};

// ========================
// FLOOR/SECTION REPORTS
// ========================

/**
 * GET /api/v1/reports/floor-section
 * Floor/Section sales report with role-based filtering
 */
const getFloorSectionReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getFloorSectionReport(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Floor Section Report failed:', error);
    next(error);
  }
};

// ========================
// HOURLY REPORT
// ========================

/**
 * GET /api/v1/reports/hourly
 * Hourly sales report with role-based filtering
 */
const getHourlySalesReport = async (req, res, next) => {
  try {
    const { outletId, reportDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getHourlySalesReport(
      parseInt(outletId),
      reportDate,
      scope.floorIds
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Hourly Sales Report failed:', error);
    next(error);
  }
};

// ========================
// LIVE DASHBOARD
// ========================

/**
 * GET /api/v1/reports/dashboard
 * Live dashboard stats with role-based filtering
 */
const getLiveDashboard = async (req, res, next) => {
  try {
    const { outletId } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getLiveDashboard(
      parseInt(outletId),
      scope.floorIds,
      { cashierId: scope.userId, isCashierOnly: scope.isCashier }
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Live Dashboard failed:', error);
    next(error);
  }
};

// ========================
// COUNTER/KOT REPORTS
// ========================

/**
 * GET /api/v1/reports/counter-sales
 * Counter/Station sales with role-based filtering
 */
const getCounterSalesReport = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getCounterSalesReport(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Counter Sales Report failed:', error);
    next(error);
  }
};

/**
 * Export running tables as CSV
 * GET /api/v1/reports/running-tables/export
 */
const exportRunningTables = async (req, res, next) => {
  try {
    const { outletId } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getRunningTables(parseInt(outletId), scope.floorIds);
    
    const csv = csvExport.runningTablesCSV(result, { outletId });
    const filename = csvExport.generateFilename('running_tables', {});
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    logger.error('Export Running Tables failed:', error);
    next(error);
  }
};

/**
 * Export running orders as CSV
 * GET /api/v1/reports/running-orders/export
 */
const exportRunningOrders = async (req, res, next) => {
  try {
    const { outletId } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getRunningOrders(parseInt(outletId), scope.floorIds);
    
    const csv = csvExport.runningOrdersCSV(result, { outletId });
    const filename = csvExport.generateFilename('running_orders', {});
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    logger.error('Export Running Orders failed:', error);
    next(error);
  }
};

/**
 * Export Day End Summary as CSV
 */
const exportDayEndSummary = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getDayEndSummary(parseInt(outletId), startDate, endDate, scope.floorIds);
    
    const csv = csvExport.dayEndSummaryCSV(result, { startDate, endDate, outletId });
    const filename = csvExport.generateFilename('day_end_summary', { startDate, endDate });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    logger.error('Export Day End Summary failed:', error);
    next(error);
  }
};

/**
 * Export Day End Summary Detail as CSV
 */
const exportDayEndSummaryDetail = async (req, res, next) => {
  try {
    const { outletId, date, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const targetDate = date || startDate || endDate;
    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getDayEndSummaryDetail(parseInt(outletId), targetDate, targetDate, scope.floorIds);
    
    const csv = csvExport.dayEndSummaryDetailCSV(result, { startDate: targetDate, endDate: targetDate, outletId });
    const filename = csvExport.generateFilename('day_end_detail', { startDate: targetDate, endDate: targetDate });
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    logger.error('Export Day End Summary Detail failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/running-dashboard
 * Running dashboard: sales summary, payment breakdown, time-series
 * ?outletId=X&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Single date → hourly blocks (4am–4am), Multiple dates → daily breakdown
 */
const getRunningDashboard = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate, date } = req.query;

    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));

    const result = await reportsService.getRunningDashboard(
      parseInt(outletId),
      startDate || date,
      endDate || date || startDate,
      scope.floorIds
    );

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Get Running Dashboard failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/accurate-dashboard
 * Accurate Dashboard (v2) — only completed orders
 */
const getAccurateDashboard = async (req, res, next) => {
  try {
    const { outletId } = req.query;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }
    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getAccurateDashboard(
      parseInt(outletId),
      scope.floorIds
    );
    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Accurate Dashboard failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/accurate-running-dashboard
 * Accurate Running Dashboard (v2) — only completed orders
 */
const getAccurateRunningDashboard = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate, date } = req.query;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }
    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getAccurateRunningDashboard(
      parseInt(outletId),
      startDate || date,
      endDate || date || startDate,
      scope.floorIds
    );
    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Accurate Running Dashboard failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/accurate-day-end-summary
 * Accurate Day End Summary (v2) — only completed orders
 */
const getAccurateDayEndSummary = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }
    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getAccurateDayEndSummary(
      parseInt(outletId),
      startDate,
      endDate,
      {
        floorIds: scope.floorIds,
        userId: scope.userId,
        isCashier: scope.isCashier
      }
    );
    res.status(200).json({
      success: true,
      data: result,
      meta: {
        role: scope.roleSlug,
        isFiltered: !scope.isAdmin,
        floorRestricted: scope.floorIds.length > 0
      }
    });
  } catch (error) {
    logger.error('Get Accurate Day End Summary failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/accurate-dsr
 * Accurate Daily Sales Report (v2)
 * - Only completed orders
 * - total_sale = full bill amount (total_amount) of completed orders
 * - total_collection = total_sale (regardless of payment status)
 * - NC and discount bifurcated separately
 * - Nothing excluded (dues, adjustments, NC all included)
 * - Cross-verification with order-level list
 */
const getAccurateDSR = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }

    const scope = await getUserDataScope(req.user, parseInt(outletId));
    
    const result = await reportsService.getAccurateDSR(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds
    );

    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Accurate DSR failed:', error);
    next(error);
  }
};

/**
 * Export Accurate Day End Summary as CSV
 * GET /api/v1/reports/accurate-day-end-summary/export
 */
const exportAccurateDayEndSummary = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }
    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getAccurateDayEndSummary(
      parseInt(outletId),
      startDate,
      endDate,
      {
        floorIds: scope.floorIds,
        userId: scope.userId,
        isCashier: scope.isCashier
      }
    );

    const csv = csvExport.accurateDayEndSummaryCSV(result, { startDate, endDate, outletId });
    const filename = csvExport.generateFilename('accurate_day_end_summary', { startDate, endDate });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    logger.error('Export Accurate Day End Summary failed:', error);
    next(error);
  }
};

/**
 * Export Accurate DSR as CSV
 * GET /api/v1/reports/accurate-dsr/export
 */
const exportAccurateDSR = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate } = req.query;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }
    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getAccurateDSR(
      parseInt(outletId),
      startDate,
      endDate,
      scope.floorIds
    );

    const csv = csvExport.accurateDSRCSV(result, { startDate, endDate, outletId });
    const filename = csvExport.generateFilename('accurate_dsr', { startDate, endDate });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    logger.error('Export Accurate DSR failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/accurate-day-end-summary/detail
 * Accurate Day End Summary Detail — paginated order list with items/payments/KOTs
 * Filters: search, orderType, paymentStatus, captainId, floorId, date, page, limit, sortBy, sortOrder
 */
const getAccurateDayEndSummaryDetail = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate, search, orderType, paymentStatus, captainId, floorId, date, page, limit, sortBy, sortOrder } = req.query;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }
    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getAccurateDayEndSummaryDetail(
      parseInt(outletId), startDate, endDate,
      {
        floorIds: scope.floorIds, userId: scope.userId, isCashier: scope.isCashier,
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
        sortBy: sortBy || 'created_at',
        sortOrder: sortOrder || 'DESC',
        search: search || null,
        orderType: orderType || null,
        paymentStatus: paymentStatus || null,
        captainId: captainId ? parseInt(captainId) : null,
        floorId: floorId ? parseInt(floorId) : null,
        date: date || null
      }
    );
    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin, floorRestricted: scope.floorIds.length > 0 }
    });
  } catch (error) {
    logger.error('Get Accurate Day End Summary Detail failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/reports/accurate-dsr/detail
 * Accurate DSR Detail — daily summary + paginated order list with items/payments/KOTs
 * Filters: search, orderType, paymentStatus, captainId, floorId, date, page, limit, sortBy, sortOrder
 */
const getAccurateDSRDetail = async (req, res, next) => {
  try {
    const { outletId, startDate, endDate, search, orderType, paymentStatus, captainId, floorId, date, page, limit, sortBy, sortOrder } = req.query;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'outletId is required' });
    }
    const scope = await getUserDataScope(req.user, parseInt(outletId));
    const result = await reportsService.getAccurateDSRDetail(
      parseInt(outletId), startDate, endDate,
      {
        floorIds: scope.floorIds,
        page: page ? parseInt(page) : 1,
        limit: limit ? parseInt(limit) : 20,
        sortBy: sortBy || 'created_at',
        sortOrder: sortOrder || 'DESC',
        search: search || null,
        orderType: orderType || null,
        paymentStatus: paymentStatus || null,
        captainId: captainId ? parseInt(captainId) : null,
        floorId: floorId ? parseInt(floorId) : null,
        date: date || null
      }
    );
    res.status(200).json({
      success: true,
      data: result,
      meta: { role: scope.roleSlug, isFiltered: !scope.isAdmin }
    });
  } catch (error) {
    logger.error('Get Accurate DSR Detail failed:', error);
    next(error);
  }
};

module.exports = {
  getDayEndSummary,
  getDayEndSummaryDetail,
  getRunningOrders,
  getRunningTables,
  getDailySalesReport,
  getDailySalesDetail,
  getItemSalesReport,
  getCategorySalesReport,
  getBillerWiseReport,
  getStaffReport,
  getTaxReport,
  getPaymentModeReport,
  getCancellationReport,
  getFloorSectionReport,
  getHourlySalesReport,
  getLiveDashboard,
  getCounterSalesReport,
  getRunningDashboard,
  exportRunningTables,
  exportRunningOrders,
  exportDayEndSummary,
  exportDayEndSummaryDetail,
  getAccurateDSR,
  getAccurateDashboard,
  getAccurateRunningDashboard,
  getAccurateDayEndSummary,
  exportAccurateDayEndSummary,
  exportAccurateDSR,
  getAccurateDayEndSummaryDetail,
  getAccurateDSRDetail
};
