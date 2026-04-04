/**
 * Dashboard Controller
 * Real-time dashboard endpoints
 */

const dashboardService = require('../services/dashboard.service');
const logger = require('../utils/logger');

const dashboardController = {
  /**
   * GET /api/v1/dashboard/realtime/:outletId
   * Query params: floorId, orderType
   */
  async getRealtime(req, res, next) {
    try {
      const outletId = parseInt(req.params.outletId);
      if (!outletId) {
        return res.status(400).json({ success: false, message: 'outletId is required' });
      }

      const filters = {};
      if (req.query.floorId) filters.floorId = parseInt(req.query.floorId);
      if (req.query.orderType) filters.orderType = req.query.orderType;

      const data = await dashboardService.getRealtime(outletId, filters);

      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = dashboardController;
