const superAdminDashboardService = require('../services/superAdminDashboard.service');
const logger = require('../utils/logger');

const superAdminDashboardController = {
  /**
   * GET /api/v1/dashboard/super-admin
   *
   * Query params:
   *   sort    - 'total_sale' | 'total_orders' | 'outlet_name'  (default: 'total_sale')
   *   order   - 'asc' | 'desc'                                  (default: 'desc')
   *   refresh - 'true' to bypass cache and force a fresh fetch  (default: false)
   */
  async getDashboard(req, res) {
    try {
      const userId = req.user.userId;
      const { sort = 'total_sale', order = 'desc', refresh } = req.query;
      const forceRefresh = refresh === 'true';

      const data = await superAdminDashboardService.getDashboard({ userId, sort, order, forceRefresh });
      res.json({ success: true, data });
    } catch (error) {
      logger.error('Super admin dashboard error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },
};

module.exports = superAdminDashboardController;
