const express = require('express');
const router = express.Router();
const reportsController = require('../controllers/reports.controller');
const discountReportController = require('../controllers/discountReport.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

// All routes require authentication
router.use(authenticate);

// Roles that can access reports
const REPORT_ROLES = ['super_admin', 'admin', 'manager', 'cashier'];

/**
 * @route   GET /api/v1/reports/dashboard
 * @desc    Live dashboard stats
 * @access  Private (admin, manager, cashier, captain)
 * @query   outletId - Required
 */
router.get('/dashboard', authorize(...REPORT_ROLES), reportsController.getLiveDashboard);

/**
 * @route   GET /api/v1/reports/running-orders
 * @desc    Running orders breakdown by type
 * @access  Private (admin, manager, cashier, captain)
 * @query   outletId - Required
 */
router.get('/running-orders', authorize(...REPORT_ROLES), reportsController.getRunningOrders);

/**
 * @route   GET /api/v1/reports/running-tables
 * @desc    Running tables with active orders
 * @access  Private (admin, manager, cashier, captain)
 * @query   outletId - Required
 */
router.get('/running-tables', authorize(...REPORT_ROLES), reportsController.getRunningTables);

/**
 * @route   GET /api/v1/reports/day-end-summary
 * @desc    Day End Summary report
 * @access  Private (admin, manager, cashier)
 * @query   outletId - Required
 * @query   startDate - Start date (YYYY-MM-DD)
 * @query   endDate - End date (YYYY-MM-DD)
 */
router.get('/day-end-summary', authorize(...REPORT_ROLES), reportsController.getDayEndSummary);

/**
 * @route   GET /api/v1/reports/day-end-summary/detail
 * @desc    Day End Summary Detail - Comprehensive details for a specific date
 * @access  Private (admin, manager, cashier)
 * @query   outletId - Required
 * @query   date - Target date (YYYY-MM-DD), defaults to today
 */
router.get('/day-end-summary/detail', authorize(...REPORT_ROLES), reportsController.getDayEndSummaryDetail);

/**
 * @route   GET /api/v1/reports/day-end-summary/export
 * @desc    Export Day End Summary as CSV
 * @access  Private (admin, manager, cashier)
 * @query   outletId - Required
 * @query   startDate - Start date (YYYY-MM-DD)
 * @query   endDate - End date (YYYY-MM-DD)
 */
router.get('/day-end-summary/export', authorize(...REPORT_ROLES), reportsController.exportDayEndSummary);

/**
 * @route   GET /api/v1/reports/day-end-summary/detail/export
 * @desc    Export Day End Summary Detail as CSV
 * @access  Private (admin, manager, cashier)
 * @query   outletId - Required
 * @query   date - Target date (YYYY-MM-DD)
 */
router.get('/day-end-summary/detail/export', authorize(...REPORT_ROLES), reportsController.exportDayEndSummaryDetail);

/**
 * @route   GET /api/v1/reports/daily-sales
 * @desc    Daily sales aggregated report
 * @access  Private (admin, manager, cashier)
 * @query   outletId - Required
 * @query   startDate, endDate - Date range
 */
router.get('/daily-sales', authorize(...REPORT_ROLES), reportsController.getDailySalesReport);

/**
 * @route   GET /api/v1/reports/daily-sales-detail
 * @desc    Detailed daily sales with orders
 * @access  Private (admin, manager)
 * @query   outletId, startDate, endDate, page, limit, filters
 */
router.get('/daily-sales-detail', authorize('super_admin', 'admin', 'manager'), reportsController.getDailySalesDetail);

/**
 * @route   GET /api/v1/reports/item-sales
 * @desc    Item-wise sales report
 * @access  Private (admin, manager)
 * @query   outletId, startDate, endDate, limit, serviceType
 */
router.get('/item-sales', authorize('super_admin', 'admin', 'manager'), reportsController.getItemSalesReport);

/**
 * @route   GET /api/v1/reports/category-sales
 * @desc    Category-wise sales report
 * @access  Private (admin, manager)
 * @query   outletId, startDate, endDate, serviceType
 */
router.get('/category-sales', authorize('super_admin', 'admin', 'manager'), reportsController.getCategorySalesReport);

/**
 * @route   GET /api/v1/reports/biller-wise
 * @desc    Biller/Cashier wise sales (Pax Sales Report)
 * @access  Private (admin, manager, cashier)
 * @query   outletId, startDate, endDate
 */
router.get('/biller-wise', authorize(...REPORT_ROLES), reportsController.getBillerWiseReport);

/**
 * @route   GET /api/v1/reports/staff
 * @desc    Staff performance report
 * @access  Private (admin, manager)
 * @query   outletId, startDate, endDate
 */
router.get('/staff', authorize('super_admin', 'admin', 'manager'), reportsController.getStaffReport);

/**
 * @route   GET /api/v1/reports/tax
 * @desc    Tax report with component breakdown
 * @access  Private (admin, manager)
 * @query   outletId, startDate, endDate
 */
router.get('/tax', authorize('super_admin', 'admin', 'manager'), reportsController.getTaxReport);

/**
 * @route   GET /api/v1/reports/payment-modes
 * @desc    Payment mode breakdown
 * @access  Private (admin, manager, cashier)
 * @query   outletId, startDate, endDate
 */
router.get('/payment-modes', authorize(...REPORT_ROLES), reportsController.getPaymentModeReport);

/**
 * @route   GET /api/v1/reports/cancellations
 * @desc    Cancellation report
 * @access  Private (admin, manager)
 * @query   outletId, startDate, endDate
 */
router.get('/cancellations', authorize('super_admin', 'admin', 'manager'), reportsController.getCancellationReport);

/**
 * @route   GET /api/v1/reports/floor-section
 * @desc    Floor/Section wise sales
 * @access  Private (admin, manager)
 * @query   outletId, startDate, endDate
 */
router.get('/floor-section', authorize('super_admin', 'admin', 'manager'), reportsController.getFloorSectionReport);

/**
 * @route   GET /api/v1/reports/hourly
 * @desc    Hourly sales breakdown
 * @access  Private (admin, manager)
 * @query   outletId, reportDate
 */
router.get('/hourly', authorize('super_admin', 'admin', 'manager'), reportsController.getHourlySalesReport);

/**
 * @route   GET /api/v1/reports/counter-sales
 * @desc    Counter/Station KOT report
 * @access  Private (admin, manager)
 * @query   outletId, startDate, endDate
 */
router.get('/counter-sales', authorize('super_admin', 'admin', 'manager'), reportsController.getCounterSalesReport);

// ========================
// CSV EXPORT ENDPOINTS
// ========================

/**
 * @route   GET /api/v1/reports/running-tables/export
 * @desc    Export running tables as CSV
 * @access  Private (admin, manager, cashier, captain)
 * @query   outletId - Required
 */
router.get('/running-tables/export', authorize(...REPORT_ROLES), reportsController.exportRunningTables);

/**
 * @route   GET /api/v1/reports/running-orders/export
 * @desc    Export running orders as CSV
 * @access  Private (admin, manager, cashier, captain)
 * @query   outletId - Required
 */
router.get('/running-orders/export', authorize(...REPORT_ROLES), reportsController.exportRunningOrders);

// ========================
// DISCOUNT REPORT ENDPOINTS
// ========================

/**
 * @route   GET /api/v1/reports/discounts/:outletId/summary
 * @desc    Get discount summary report with totals and breakdowns
 * @access  Private (admin, manager)
 * @query   startDate, endDate - Date range (YYYY-MM-DD)
 */
router.get('/discounts/:outletId/summary', authorize('super_admin', 'admin', 'manager'), discountReportController.getDiscountSummary);

/**
 * @route   GET /api/v1/reports/discounts/:outletId/details
 * @desc    Get detailed discount report with pagination and filters
 * @access  Private (admin, manager)
 * @query   startDate, endDate - Date range
 * @query   page, limit - Pagination
 * @query   search - Search in code, name, order number
 * @query   discountType - percentage | flat
 * @query   discountCode - Filter by specific code
 * @query   givenBy - Filter by staff user ID
 * @query   sortBy, sortOrder - Sorting
 */
router.get('/discounts/:outletId/details', authorize('super_admin', 'admin', 'manager'), discountReportController.getDiscountDetails);

/**
 * @route   GET /api/v1/reports/discounts/:outletId/codes
 * @desc    Get discount code performance report
 * @access  Private (admin, manager)
 * @query   startDate, endDate - Date range
 * @query   page, limit - Pagination
 * @query   search - Search in code, name
 * @query   sortBy, sortOrder - Sorting
 */
router.get('/discounts/:outletId/codes', authorize('super_admin', 'admin', 'manager'), discountReportController.getDiscountCodeReport);

/**
 * @route   GET /api/v1/reports/discounts/:outletId/staff
 * @desc    Get staff discount report - who gave how much discount
 * @access  Private (admin, manager)
 * @query   startDate, endDate - Date range
 * @query   page, limit - Pagination
 * @query   search - Search by staff name
 * @query   sortBy, sortOrder - Sorting
 */
router.get('/discounts/:outletId/staff', authorize('super_admin', 'admin', 'manager'), discountReportController.getStaffDiscountReport);

/**
 * @route   GET /api/v1/reports/discounts/:outletId/export
 * @desc    Export discount report as CSV
 * @access  Private (admin, manager)
 * @query   startDate, endDate - Date range
 * @query   reportType - details | summary | staff
 * @query   discountType, discountCode, givenBy - Filters
 */
router.get('/discounts/:outletId/export', authorize('super_admin', 'admin', 'manager'), discountReportController.exportDiscountReport);

/**
 * @route   GET /api/v1/reports/discounts/:outletId/filters
 * @desc    Get available filter options (codes, staff list)
 * @access  Private (admin, manager)
 */
router.get('/discounts/:outletId/filters', authorize('super_admin', 'admin', 'manager'), discountReportController.getFilterOptions);

module.exports = router;
