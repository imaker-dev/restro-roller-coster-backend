/**
 * Dashboard Routes
 */

const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboard.controller');
const superAdminDashboardController = require('../controllers/superAdminDashboard.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

// Real-time dashboard
router.get('/realtime/:outletId', authenticate, dashboardController.getRealtime);

/**
 * @route   GET /api/v1/dashboard/super-admin
 * @desc    Master dashboard: today's sales + orders for every outlet
 * @access  super_admin / master only
 * @query   sort    - 'total_sale' | 'total_orders' | 'outlet_name'  (default: total_sale)
 * @query   order   - 'asc' | 'desc'                                  (default: desc)
 * @query   refresh - 'true' to force cache bypass
 */
router.get('/super-admin', authenticate, authorize('super_admin', 'master'), superAdminDashboardController.getDashboard);

module.exports = router;
