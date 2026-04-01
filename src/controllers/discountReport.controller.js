/**
 * Discount Report Controller
 * Handles discount report API endpoints
 */

const discountReportService = require('../services/discountReport.service');
const logger = require('../utils/logger');

const discountReportController = {
  /**
   * GET /api/v1/reports/discounts/:outletId/summary
   * Get discount summary report
   */
  async getDiscountSummary(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;

      const result = await discountReportService.getDiscountSummary(
        outletId,
        startDate,
        endDate
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Get discount summary error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to get discount summary'
      });
    }
  },

  /**
   * GET /api/v1/reports/discounts/:outletId/details
   * Get detailed discount report with pagination and filters
   */
  async getDiscountDetails(req, res) {
    try {
      const { outletId } = req.params;
      const {
        startDate,
        endDate,
        page,
        limit,
        search,
        discountType,
        discountCode,
        givenBy,
        approvedBy,
        sortBy,
        sortOrder
      } = req.query;

      const result = await discountReportService.getDiscountDetails(
        outletId,
        startDate,
        endDate,
        {
          page: parseInt(page) || 1,
          limit: parseInt(limit) || 50,
          search,
          discountType,
          discountCode,
          givenBy: givenBy ? parseInt(givenBy) : null,
          approvedBy: approvedBy ? parseInt(approvedBy) : null,
          sortBy,
          sortOrder
        }
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Get discount details error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to get discount details'
      });
    }
  },

  /**
   * GET /api/v1/reports/discounts/:outletId/codes
   * Get discount code performance report
   */
  async getDiscountCodeReport(req, res) {
    try {
      const { outletId } = req.params;
      const {
        startDate,
        endDate,
        page,
        limit,
        search,
        sortBy,
        sortOrder
      } = req.query;

      const result = await discountReportService.getDiscountCodeReport(
        outletId,
        startDate,
        endDate,
        {
          page: parseInt(page) || 1,
          limit: parseInt(limit) || 50,
          search,
          sortBy,
          sortOrder
        }
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Get discount code report error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to get discount code report'
      });
    }
  },

  /**
   * GET /api/v1/reports/discounts/:outletId/staff
   * Get staff discount report
   */
  async getStaffDiscountReport(req, res) {
    try {
      const { outletId } = req.params;
      const {
        startDate,
        endDate,
        page,
        limit,
        search,
        sortBy,
        sortOrder
      } = req.query;

      const result = await discountReportService.getStaffDiscountReport(
        outletId,
        startDate,
        endDate,
        {
          page: parseInt(page) || 1,
          limit: parseInt(limit) || 50,
          search,
          sortBy,
          sortOrder
        }
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('Get staff discount report error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to get staff discount report'
      });
    }
  },

  /**
   * GET /api/v1/reports/discounts/:outletId/export
   * Export discount report as CSV
   */
  async exportDiscountReport(req, res) {
    try {
      const { outletId } = req.params;
      const {
        startDate,
        endDate,
        reportType,
        discountType,
        discountCode,
        givenBy
      } = req.query;

      const result = await discountReportService.exportDiscountReport(
        outletId,
        startDate,
        endDate,
        {
          reportType: reportType || 'details',
          discountType,
          discountCode,
          givenBy: givenBy ? parseInt(givenBy) : null
        }
      );

      if (!result.rows || result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No data found for the specified criteria'
        });
      }

      // Convert to CSV
      const headers = Object.keys(result.rows[0]);
      const csvRows = [
        headers.join(','),
        ...result.rows.map(row => 
          headers.map(header => {
            let value = row[header];
            if (value === null || value === undefined) {
              value = '';
            }
            // Escape quotes and wrap in quotes if contains comma or quote
            value = String(value);
            if (value.includes(',') || value.includes('"') || value.includes('\n')) {
              value = `"${value.replace(/"/g, '""')}"`;
            }
            return value;
          }).join(',')
        )
      ];
      const csvContent = csvRows.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(csvContent);
    } catch (error) {
      logger.error('Export discount report error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to export discount report'
      });
    }
  },

  /**
   * GET /api/v1/reports/discounts/:outletId/filters
   * Get available filter options (codes, staff)
   */
  async getFilterOptions(req, res) {
    try {
      const { outletId } = req.params;

      const [codes, staff] = await Promise.all([
        discountReportService.getDiscountCodesForFilter(outletId),
        discountReportService.getStaffForFilter(outletId)
      ]);

      res.json({
        success: true,
        data: {
          discountCodes: codes,
          staff: staff,
          discountTypes: [
            { value: 'percentage', label: 'Percentage' },
            { value: 'flat', label: 'Flat Amount' }
          ],
          sortOptions: {
            details: [
              { value: 'created_at', label: 'Date' },
              { value: 'discount_amount', label: 'Discount Amount' },
              { value: 'order_number', label: 'Order Number' },
              { value: 'discount_name', label: 'Discount Name' }
            ],
            codes: [
              { value: 'total_amount', label: 'Total Amount' },
              { value: 'times_used', label: 'Times Used' },
              { value: 'avg_amount', label: 'Average Amount' },
              { value: 'orders_count', label: 'Orders Count' }
            ],
            staff: [
              { value: 'total_amount', label: 'Total Amount' },
              { value: 'discounts_given', label: 'Discounts Given' },
              { value: 'avg_amount', label: 'Average Amount' },
              { value: 'user_name', label: 'Staff Name' }
            ]
          }
        }
      });
    } catch (error) {
      logger.error('Get filter options error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to get filter options'
      });
    }
  }
};

module.exports = discountReportController;
