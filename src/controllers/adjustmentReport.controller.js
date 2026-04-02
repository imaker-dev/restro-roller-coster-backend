/**
 * Adjustment Report Controller
 * Handles adjustment listing, detail, and export endpoints.
 */

const adjustmentReportService = require('../services/adjustmentReport.service');
const logger = require('../utils/logger');

const adjustmentReportController = {

  async getAdjustments(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate, staffId, page, limit, sortBy, sortOrder } = req.query;
      const result = await adjustmentReportService.getAdjustments(outletId, startDate, endDate, {
        staffId, page, limit, sortBy, sortOrder
      });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get adjustments error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getAdjustmentById(req, res) {
    try {
      const { outletId, id } = req.params;
      const result = await adjustmentReportService.getAdjustmentById(outletId, id);
      if (!result) {
        return res.status(404).json({ success: false, message: 'Adjustment not found' });
      }
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get adjustment detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async exportAdjustments(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate, staffId } = req.query;
      const result = await adjustmentReportService.exportAdjustments(outletId, startDate, endDate, { staffId });
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.content);
    } catch (error) {
      logger.error('Export adjustments error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
};

module.exports = adjustmentReportController;
