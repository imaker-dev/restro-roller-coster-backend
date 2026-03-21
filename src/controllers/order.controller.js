/**
 * Order Controller
 * Handles orders, items, KOT, modifications
 */

const orderService = require('../services/order.service');
const kotService = require('../services/kot.service');
const billingService = require('../services/billing.service');
const paymentService = require('../services/payment.service');
const reportsService = require('../services/reports.service');
const userService = require('../services/user.service');
const { getUserFloorIds } = require('../utils/helpers');
const logger = require('../utils/logger');
const csvExport = require('../utils/csv-export');

const costSnapshotService = require('../services/costSnapshot.service');

const orderController = {
  // ========================
  // ORDER MANAGEMENT
  // ========================

  async createOrder(req, res) {
    try {
      const order = await orderService.createOrder({
        ...req.body,
        createdBy: req.user.userId
      });
      res.status(201).json({ success: true, message: 'Order created', data: order });
    } catch (error) {
      logger.error('Create order error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getOrder(req, res) {
    try {
      const order = await orderService.getOrderWithItems(req.params.id);
      if (!order) {
        return res.status(404).json({ success: false, message: 'Order not found' });
      }
      res.json({ success: true, data: order });
    } catch (error) {
      logger.error('Get order error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getActiveOrders(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const filters = {
        floorId: req.query.floorId,
        floorIds: !req.query.floorId && floorIds.length > 0 ? floorIds : undefined,
        status: req.query.status,
        tableId: req.query.tableId,
        createdBy: req.query.createdBy
      };
      const orders = await orderService.getActiveOrders(outletId, filters);
      res.json({ success: true, data: orders });
    } catch (error) {
      logger.error('Get active orders error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getPendingTakeawayOrders(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      // Note: Takeaway orders don't use floor filtering - they're outlet-wide
      const filters = {
        search: req.query.search,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        page: req.query.page,
        limit: req.query.limit,
        status: req.query.status,
        cashierId: req.user.userId,
        userRole: req.user.role
      };
      const result = await orderService.getPendingTakeawayOrders(outletId, filters);
      res.json({ success: true, data: result.data, pagination: result.pagination });
    } catch (error) {
      logger.error('Get pending takeaway orders error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getTakeawayOrderDetail(req, res) {
    try {
      const result = await orderService.getTakeawayOrderDetail(req.params.id);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get takeaway order detail error:', error);
      const status = error.message.includes('not found') ? 404 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  async getOrdersByTable(req, res) {
    try {
      const orders = await orderService.getByTable(req.params.tableId);
      res.json({ success: true, data: orders });
    } catch (error) {
      logger.error('Get orders by table error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async addItems(req, res) {
    try {
      const result = await orderService.addItems(
        req.params.id,
        req.body.items,
        req.user.userId
      );
      res.json({ success: true, message: 'Items added', data: result });
    } catch (error) {
      logger.error('Add items error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updateItemQuantity(req, res) {
    try {
      const order = await orderService.updateItemQuantity(
        req.params.itemId,
        req.body.quantity,
        req.user.userId
      );
      res.json({ success: true, message: 'Quantity updated', data: order });
    } catch (error) {
      logger.error('Update item quantity error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async cancelItem(req, res) {
    try {
      const order = await orderService.cancelItem(
        req.params.itemId,
        req.body,
        req.user.userId
      );
      res.json({ success: true, message: 'Item cancelled', data: order });
    } catch (error) {
      logger.error('Cancel item error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async cancelOrder(req, res) {
    try {
      const order = await orderService.cancelOrder(
        req.params.id,
        req.body,
        req.user.userId
      );
      res.json({ success: true, message: 'Order cancelled', data: order });
    } catch (error) {
      logger.error('Cancel order error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updateStatus(req, res) {
    try {
      const order = await orderService.updateStatus(
        req.params.id,
        req.body.status,
        req.user.userId
      );
      res.json({ success: true, message: 'Status updated', data: order });
    } catch (error) {
      logger.error('Update status error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async transferTable(req, res) {
    try {
      const order = await orderService.transferTable(
        req.params.id,
        req.body.toTableId,
        req.user.userId
      );
      res.json({ success: true, message: 'Table transferred', data: order });
    } catch (error) {
      logger.error('Transfer table error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCancelReasons(req, res) {
    try {
      const { outletId } = req.params;
      const { type } = req.query;
      const reasons = await orderService.getCancelReasons(outletId, type);
      res.json({ success: true, data: reasons });
    } catch (error) {
      logger.error('Get cancel reasons error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // KOT MANAGEMENT
  // ========================

  async sendKot(req, res) {
    try {
      const result = await kotService.sendKot(req.params.id, req.user.userId);
      res.json({ success: true, message: 'KOT sent', data: result });
    } catch (error) {
      logger.error('Send KOT error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getActiveKotsForUser(req, res) {
    try {
      // Get outletId from: 1) token, 2) query param, 3) user's roles in database
      let outletId = req.user.outletId || req.query.outletId;
      
      if (!outletId) {
        // Fetch from user's roles in database
        outletId = await userService.getUserOutletId(req.user.userId);
      }
      
      if (!outletId) {
        return res.status(400).json({ success: false, message: 'User not assigned to any outlet' });
      }
      
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const { station, status, includeStats } = req.query;
      // Support comma-separated status: ?status=pending,cancelled
      const statusFilter = status ? status.split(',').map(s => s.trim()) : null;
      const kots = await kotService.getActiveKots(outletId, station, statusFilter, floorIds);
      
      // Include stats if requested or if station filter is provided
      if (includeStats === 'true' || station) {
        const stats = await kotService.getKotStats(outletId, station);
        res.json({ success: true, data: { kots, stats } });
      } else {
        res.json({ success: true, data: kots });
      }
    } catch (error) {
      logger.error('Get active KOTs error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getActiveKots(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const { station, status } = req.query;
      const statusFilter = status ? status.split(',').map(s => s.trim()) : null;
      const kots = await kotService.getActiveKots(outletId, station, statusFilter, floorIds);
      res.json({ success: true, data: kots });
    } catch (error) {
      logger.error('Get active KOTs error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getKotsByOrder(req, res) {
    try {
      const kots = await kotService.getKotsByOrder(req.params.orderId);
      res.json({ success: true, data: kots });
    } catch (error) {
      logger.error('Get KOTs by order error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getKotById(req, res) {
    try {
      const kot = await kotService.getKotById(req.params.id);
      if (!kot) {
        return res.status(404).json({ success: false, message: 'KOT not found' });
      }
      res.json({ success: true, data: kot });
    } catch (error) {
      logger.error('Get KOT error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async acceptKot(req, res) {
    try {
      const kot = await kotService.acceptKot(req.params.id, req.user.userId);
      res.json({ success: true, message: 'KOT accepted', data: kot });
    } catch (error) {
      logger.error('Accept KOT error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async startPreparingKot(req, res) {
    try {
      const kot = await kotService.startPreparing(req.params.id, req.user.userId);
      res.json({ success: true, message: 'Started preparing', data: kot });
    } catch (error) {
      logger.error('Start preparing error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async markItemReady(req, res) {
    try {
      const kot = await kotService.markItemReady(req.params.itemId, req.user.userId);
      res.json({ success: true, message: 'Item ready', data: kot });
    } catch (error) {
      logger.error('Mark item ready error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async markKotReady(req, res) {
    try {
      const kot = await kotService.markKotReady(req.params.id, req.user.userId);
      res.json({ success: true, message: 'KOT ready', data: kot });
    } catch (error) {
      logger.error('Mark KOT ready error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async markKotServed(req, res) {
    try {
      const kot = await kotService.markKotServed(req.params.id, req.user.userId);
      res.json({ success: true, message: 'KOT served', data: kot });
    } catch (error) {
      logger.error('Mark KOT served error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getStationDashboardForUser(req, res) {
    try {
      // Get outletId from: 1) token, 2) query param, 3) user's roles in database
      let outletId = req.user.outletId || req.query.outletId;
      
      if (!outletId) {
        // Fetch from user's roles in database
        outletId = await userService.getUserOutletId(req.user.userId);
      }
      
      if (!outletId) {
        return res.status(400).json({ success: false, message: 'User not assigned to any outlet' });
      }
      
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const { station } = req.params;
      const dashboard = await kotService.getStationDashboard(outletId, station, floorIds);
      res.json({ success: true, data: dashboard });
    } catch (error) {
      logger.error('Get station dashboard error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getStationDashboard(req, res) {
    try {
      const { outletId, station } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const dashboard = await kotService.getStationDashboard(outletId, station, floorIds);
      res.json({ success: true, data: dashboard });
    } catch (error) {
      logger.error('Get station dashboard error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async reprintKot(req, res) {
    try {
      const kot = await kotService.reprintKot(req.params.id, req.user.userId);
      res.json({ success: true, message: 'KOT reprinted', data: kot });
    } catch (error) {
      logger.error('Reprint KOT error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // BILLING
  // ========================

  async generateBill(req, res) {
    try {
      const { applyServiceCharge: _sc, ...rest } = req.body || {};
      const invoice = await billingService.generateBill(req.params.id, {
        ...rest,
        // Service charge always OFF — override any client value
        applyServiceCharge: false,
        generatedBy: req.user.userId
      });
      res.json({ success: true, message: 'Bill generated', data: invoice });
    } catch (error) {
      logger.error('Generate bill error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getInvoice(req, res) {
    try {
      const invoice = await billingService.getInvoiceById(req.params.id);
      if (!invoice) {
        return res.status(404).json({ success: false, message: 'Invoice not found' });
      }
      res.json({ success: true, data: invoice });
    } catch (error) {
      logger.error('Get invoice error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getInvoiceByOrder(req, res) {
    try {
      const invoice = await billingService.getInvoiceByOrder(req.params.orderId);
      if (!invoice) {
        return res.status(404).json({ success: false, message: 'Invoice not found' });
      }
      res.json({ success: true, data: invoice });
    } catch (error) {
      logger.error('Get invoice by order error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async downloadInvoicePDF(req, res) {
    try {
      const { pdfStream, invoice, filename } = await billingService.generateInvoicePDF(req.params.id);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      pdfStream.pipe(res);
    } catch (error) {
      logger.error('Download invoice PDF error:', error);
      const status = error.message === 'Invoice not found' ? 404 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  async printInvoice(req, res) {
    try {
      const invoice = await billingService.printInvoice(req.params.id, req.user.userId);
      res.json({ success: true, message: 'Invoice sent to printer', data: invoice });
    } catch (error) {
      logger.error('Print invoice error:', error);
      const status = error.message === 'Invoice not found' ? 404 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  async printDuplicateBill(req, res) {
    try {
      const invoice = await billingService.printDuplicateBill(
        req.params.id,
        req.user.userId,
        req.body.reason
      );
      res.json({ success: true, message: 'Duplicate bill printed', data: invoice });
    } catch (error) {
      logger.error('Print duplicate bill error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async splitBill(req, res) {
    try {
      const invoices = await billingService.splitBill(
        req.params.id,
        req.body.splits,
        req.user.userId
      );
      res.json({ success: true, message: 'Bill split', data: invoices });
    } catch (error) {
      logger.error('Split bill error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async cancelInvoice(req, res) {
    try {
      const result = await billingService.cancelInvoice(
        req.params.id,
        req.body.reason,
        req.user.userId
      );
      res.json({ success: true, message: result.message });
    } catch (error) {
      logger.error('Cancel invoice error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getOrderDiscounts(req, res) {
    try {
      const result = await billingService.getOrderDiscounts(req.params.id);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get order discounts error:', error);
      const status = error.message.includes('not found') ? 404 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  async applyDiscount(req, res) {
    try {
      const result = await billingService.applyDiscount(
        req.params.id,
        req.body,
        req.user.userId
      );
      res.json({ success: true, message: 'Discount applied successfully', data: result });
    } catch (error) {
      logger.error('Apply discount error:', error);
      const msg = error.message;
      const status = msg.includes('not found') ? 404
        : msg.includes('Cannot apply') || msg.includes('exceed') || msg.includes('no billable') ? 400
        : 500;
      res.status(status).json({ success: false, message: msg });
    }
  },

  async applyDiscountByCode(req, res) {
    try {
      const result = await billingService.applyDiscountByCode(
        req.params.id,
        req.body.discountCode,
        req.user.userId
      );
      res.json({ success: true, message: 'Discount code applied successfully', data: result });
    } catch (error) {
      logger.error('Apply discount by code error:', error);
      const msg = error.message;
      const status = msg.includes('not found') ? 404
        : msg.includes('Invalid') || msg.includes('expired') || msg.includes('limit')
          || msg.includes('already') || msg.includes('Minimum') || msg.includes('Cannot') ? 400
        : 500;
      res.status(status).json({ success: false, message: msg });
    }
  },

  async removeDiscount(req, res) {
    try {
      const result = await billingService.removeDiscount(
        req.params.id,
        req.params.discountId,
        req.user.userId
      );
      res.json({ success: true, message: 'Discount removed successfully', data: result });
    } catch (error) {
      logger.error('Remove discount error:', error);
      const msg = error.message;
      const status = msg.includes('not found') ? 404
        : msg.includes('Cannot remove') ? 400
        : 500;
      res.status(status).json({ success: false, message: msg });
    }
  },

  async getPendingBills(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const filters = {
        floorId: req.query.floorId,
        floorIds: !req.query.floorId && floorIds.length > 0 ? floorIds : undefined,
        search: req.query.search,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        page: req.query.page,
        limit: req.query.limit,
        status: req.query.status,
        fromDate: req.query.fromDate,
        toDate: req.query.toDate,
        orderType: req.query.orderType
      };
      const result = await billingService.getPendingBills(outletId, filters, {
        userId: req.user.userId,
        roles: req.user.roles || []
      });
      res.json({ success: true, data: result.data, pagination: result.pagination });
    } catch (error) {
      logger.error('Get pending bills error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updateInvoiceCharges(req, res) {
    try {
      const invoice = await billingService.updateInvoiceCharges(
        req.params.id,
        req.body,
        req.user.userId
      );
      res.json({ success: true, message: 'Invoice updated', data: invoice });
    } catch (error) {
      logger.error('Update invoice charges error:', error);
      const status = error.message.includes('Cannot modify') || error.message.includes('GSTIN is required') ? 400 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  // ========================
  // PAYMENTS
  // ========================

  async processPayment(req, res) {
    try {
      const result = await paymentService.processPayment({
        ...req.body,
        outletId: req.body.outletId || req.user.outletId,
        receivedBy: req.user.userId
      });

      // Scenario-specific message
      let message;
      const ps = result.paymentStatus;
      const due = result.paymentSummary?.dueAmount || 0;
      if (ps === 'completed') {
        message = 'Payment successful — order fully paid. Table released, KOTs served.';
      } else if (ps === 'partial') {
        message = `Partial payment recorded. Due amount: ₹${due.toFixed(2)}`;
      } else {
        message = 'Payment recorded';
      }

      res.json({ success: true, message, data: result });
    } catch (error) {
      logger.error('Process payment error:', error);
      const msg = error.message;
      const status = msg.includes('not found') ? 404
        : msg.includes('already paid') ? 400
        : 500;
      res.status(status).json({ success: false, message: msg });
    }
  },

  async processSplitPayment(req, res) {
    try {
      const result = await paymentService.processSplitPayment({
        ...req.body,
        outletId: req.body.outletId || req.user.outletId,
        receivedBy: req.user.userId
      });
      res.json({
        success: true,
        message: 'Split payment successful — order fully paid. Table released, KOTs served.',
        data: result
      });
    } catch (error) {
      logger.error('Process split payment error:', error);
      const msg = error.message;
      const status = msg.includes('not found') ? 404
        : msg.includes('already paid') ? 400
        : 500;
      res.status(status).json({ success: false, message: msg });
    }
  },

  async getPaymentsByOrder(req, res) {
    try {
      const payments = await paymentService.getPaymentsByOrder(req.params.orderId);
      res.json({ success: true, data: payments });
    } catch (error) {
      logger.error('Get payments error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async initiateRefund(req, res) {
    try {
      const refund = await paymentService.initiateRefund({
        ...req.body,
        outletId: req.body.outletId || req.user.outletId,
        requestedBy: req.user.userId
      });
      res.json({ success: true, message: 'Refund initiated', data: refund });
    } catch (error) {
      logger.error('Initiate refund error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async approveRefund(req, res) {
    try {
      const result = await paymentService.approveRefund(req.params.id, req.user.userId);
      res.json({ success: true, message: result.message });
    } catch (error) {
      logger.error('Approve refund error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // CASH DRAWER
  // ========================

  async openCashDrawer(req, res) {
    try {
      const { outletId } = req.params;
      const { openingCash, floorId, notes } = req.body;
      const result = await paymentService.openCashDrawer(
        outletId,
        openingCash,
        req.user.userId,
        floorId || null,
        notes || null
      );
      console.log("Open Shift",req.body)
      res.json({ success: true, message: 'Shift opened for floor', data: result });
    } catch (error) {
      logger.error('Open cash drawer error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async closeCashDrawer(req, res) {
    try {
      const { outletId } = req.params;
      const { actualCash, notes, floorId } = req.body;
      const result = await paymentService.closeCashDrawer(
        outletId,
        actualCash,
        req.user.userId,
        notes,
        floorId || null
      );
      res.json({ success: true, message: 'Shift closed for floor', data: result });
    } catch (error) {
      logger.error('Close cash drawer error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCashDrawerStatus(req, res) {
    try {
      const { outletId } = req.params;
      const { floorId } = req.query;
      const status = await paymentService.getCashDrawerStatus(
        outletId,
        floorId ? parseInt(floorId) : null,
        req.user.userId
      );
      res.json({ success: true, data: status });
    } catch (error) {
      logger.error('Get cash drawer status error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Get all floor shifts status for an outlet
   * GET /api/v1/orders/:outletId/shifts/floors
   */
  async getAllFloorShiftsStatus(req, res) {
    try {
      const { outletId } = req.params;
      const result = await paymentService.getAllFloorShiftsStatus(outletId);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get all floor shifts status error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Check if shift is open for a specific floor
   * GET /api/v1/orders/:outletId/shifts/floor/:floorId/status
   */
  async getFloorShiftStatus(req, res) {
    try {
      const { outletId, floorId } = req.params;
      const result = await paymentService.isFloorShiftOpen(outletId, parseInt(floorId));
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get floor shift status error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // REPORTS
  // ========================

  async getLiveDashboard(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const dashboard = await reportsService.getLiveDashboard(outletId, floorIds);
      res.json({ success: true, data: dashboard });
    } catch (error) {
      logger.error('Get live dashboard error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getDailySalesReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getDailySalesReport(outletId, startDate, endDate, floorIds);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get daily sales report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getDailySalesDetail(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate, page, limit, search,
              orderType, status, paymentStatus,
              captainName, cashierName, floorName, tableNumber,
              sortBy, sortOrder } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getDailySalesDetail(outletId, startDate, endDate, {
        page, limit, search,
        orderType, status, paymentStatus,
        captainName, cashierName, floorName, tableNumber,
        sortBy, sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      });
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get daily sales detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getItemSalesReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate, limit, serviceType } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getItemSalesReport(outletId, startDate, endDate, parseInt(limit) || 20, floorIds, serviceType || null);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get item sales report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getItemSalesDetail(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search,
        itemType: req.query.itemType,
        categoryName: req.query.categoryName,
        status: req.query.status,
        orderType: req.query.orderType,
        floorName: req.query.floorName,
        tableNumber: req.query.tableNumber,
        captainName: req.query.captainName,
        cashierName: req.query.cashierName,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      const report = await reportsService.getItemSalesDetail(outletId, req.query.startDate, req.query.endDate, options);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get item sales detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getStaffReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getStaffReport(outletId, startDate, endDate, floorIds);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get staff report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCategorySalesReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate, serviceType } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getCategorySalesReport(outletId, startDate, endDate, floorIds, serviceType || null);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get category sales report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCategorySalesDetail(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search,
        itemType: req.query.itemType,
        categoryName: req.query.categoryName,
        status: req.query.status,
        orderType: req.query.orderType,
        floorName: req.query.floorName,
        tableNumber: req.query.tableNumber,
        captainName: req.query.captainName,
        cashierName: req.query.cashierName,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      const report = await reportsService.getCategorySalesDetail(outletId, req.query.startDate, req.query.endDate, options);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get category sales detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getPaymentModeReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getPaymentModeReport(outletId, startDate, endDate, floorIds);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get payment mode report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getPaymentModeDetail(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search,
        paymentMode: req.query.paymentMode,
        orderType: req.query.orderType,
        floorName: req.query.floorName,
        tableNumber: req.query.tableNumber,
        captainName: req.query.captainName,
        cashierName: req.query.cashierName,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      const report = await reportsService.getPaymentModeDetail(outletId, req.query.startDate, req.query.endDate, options);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get payment mode detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getTaxReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getTaxReport(outletId, startDate, endDate, floorIds);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get tax report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getTaxDetail(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search,
        paymentStatus: req.query.paymentStatus,
        orderType: req.query.orderType,
        floorName: req.query.floorName,
        tableNumber: req.query.tableNumber,
        captainName: req.query.captainName,
        cashierName: req.query.cashierName,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      const report = await reportsService.getTaxDetail(outletId, req.query.startDate, req.query.endDate, options);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get tax detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getHourlySalesReport(req, res) {
    try {
      const { outletId } = req.params;
      const { date } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getHourlySalesReport(outletId, date, floorIds);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get hourly sales report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getFloorSectionReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate, search, page, limit, sortBy, sortOrder } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      
      const report = await reportsService.getFloorSectionReport(outletId, startDate, endDate, {
        floorIds,
        search,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 50,
        sortBy,
        sortOrder
      });
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get floor section report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCounterSalesReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getCounterSalesReport(outletId, startDate, endDate, floorIds);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get counter sales report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCounterSalesDetail(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search,
        station: req.query.station,
        status: req.query.status,
        orderType: req.query.orderType,
        captainName: req.query.captainName,
        floorName: req.query.floorName,
        tableNumber: req.query.tableNumber,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      const report = await reportsService.getCounterSalesDetail(outletId, req.query.startDate, req.query.endDate, options);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get counter sales detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCancellationReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getCancellationReport(outletId, startDate, endDate, floorIds);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get cancellation report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCancellationDetail(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search,
        cancelType: req.query.cancelType,
        cancelledByName: req.query.cancelledByName,
        approvedByName: req.query.approvedByName,
        captainName: req.query.captainName,
        cashierName: req.query.cashierName,
        orderType: req.query.orderType,
        floorName: req.query.floorName,
        tableNumber: req.query.tableNumber,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      const report = await reportsService.getCancellationDetail(outletId, req.query.startDate, req.query.endDate, options);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get cancellation detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async aggregateDailySales(req, res) {
    try {
      const { outletId } = req.params;
      const { date } = req.query;
      await reportsService.aggregateDailySales(outletId, date);
      await reportsService.aggregateItemSales(outletId, date);
      await reportsService.aggregateStaffSales(outletId, date);
      res.json({ success: true, message: 'Reports aggregated' });
    } catch (error) {
      logger.error('Aggregate daily sales error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // CAPTAIN BILLS
  // ========================

  async getCaptainBills(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const filters = {
        status: req.query.status,
        search: req.query.search,
        page: req.query.page,
        limit: req.query.limit,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      const result = await billingService.getCaptainBills(
        req.user.userId,
        outletId,
        filters
      );
      res.json({ success: true, data: result.data, pagination: result.pagination });
    } catch (error) {
      logger.error('Get captain bills error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // CAPTAIN ORDER HISTORY
  // ========================

  async getCaptainOrderHistory(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      
      // Determine user role - cashiers see all floor orders, captains see only their own
      // Note: req.user.roles is array of role strings like ['cashier', 'admin']
      const isCashier = req.user.roles?.includes('cashier');
      const isCaptain = req.user.roles?.includes('captain') || req.user.roles?.includes('waiter');
      
      const filters = {
        status: req.query.status,
        search: req.query.search || req.query.q,
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        page: req.query.page,
        limit: req.query.limit,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined,
        // Cashiers see all orders for their assigned floors, captains see only their own
        viewAllFloorOrders: isCashier && !isCaptain
      };
      
      const result = await orderService.getCaptainOrderHistory(
        req.user.userId,
        outletId,
        filters
      );
      
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get captain order history error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCaptainOrderDetail(req, res) {
    try {
      const order = await orderService.getCaptainOrderDetail(
        req.params.orderId,
        req.user.userId
      );
      res.json({ success: true, data: order });
    } catch (error) {
      logger.error('Get captain order detail error:', error);
      if (error.message === 'Order not found') {
        return res.status(404).json({ success: false, message: error.message });
      }
      if (error.message === 'You can only view your own orders') {
        return res.status(403).json({ success: false, message: error.message });
      }
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCaptainOrderStats(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const dateRange = {
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      
      const stats = await orderService.getCaptainOrderStats(
        req.user.userId,
        outletId,
        dateRange
      );
      
      res.json({ success: true, data: stats });
    } catch (error) {
      logger.error('Get captain order stats error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // SHIFT HISTORY (CASHIER)
  // ========================

  /**
   * Get shift history with pagination and filters
   * GET /api/v1/orders/shifts/:outletId/history
   * @query floorId - Filter by floor ID
   * @query cashierId - Filter by cashier ID
   * @query userId - Filter by user (opened_by, closed_by, or cashier_id)
   * @query startDate - Filter from date
   * @query endDate - Filter to date
   * @query status - 'open', 'closed', 'all'
   */
  async getShiftHistory(req, res) {
    try {
      const { outletId } = req.params;
      const {
        floorId,
        cashierId,
        userId,
        startDate,
        endDate,
        status,
        page = 1,
        limit = 20,
        sortBy = 'opening_time',
        sortOrder = 'DESC'
      } = req.query;

      // If cashier role, filter to only their own shifts
      // Note: req.user.roles is array of role strings like ['cashier', 'admin']
      const isCashier = req.user.roles?.includes('cashier');
      const effectiveCashierId = isCashier ? req.user.userId : (cashierId || null);

      const result = await paymentService.getShiftHistory({
        outletId,
        floorId: floorId ? parseInt(floorId) : null,
        cashierId: effectiveCashierId ? parseInt(effectiveCashierId) : null,
        userId: userId ? parseInt(userId) : null,
        startDate: startDate || null,
        endDate: endDate || null,
        status: status || null,
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder
      });

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get shift history error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Get detailed shift information
   * GET /api/v1/orders/shifts/:shiftId/detail
   * Cashiers can only view their own shifts
   */
  async getShiftDetail(req, res) {
    try {
      const { shiftId } = req.params;
      
      // Allow all authorized roles to view shift details
      // Admin, manager, super_admin, cashier, captain can view any shift
      const shift = await paymentService.getShiftDetail(shiftId, null);
      res.json({ success: true, data: shift });
    } catch (error) {
      logger.error('Get shift detail error:', error);
      if (error.message === 'Shift not found') {
        return res.status(404).json({ success: false, message: error.message });
      }
      if (error.message === 'You can only view your own shifts') {
        return res.status(403).json({ success: false, message: error.message });
      }
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Get single shift summary by ID with shift-time-based calculations
   * GET /api/v1/orders/shifts/:shiftId/summary
   * Cashiers can only view their own shifts
   */
  async getShiftSummaryById(req, res) {
    try {
      const { shiftId } = req.params;
      
      // Allow all authorized roles to view shift summaries
      // Admin, manager, super_admin can view any shift
      // Cashiers can also view shifts (for their outlet/floor context)
      const summary = await paymentService.getShiftSummaryById(shiftId, null);
      res.json({ success: true, data: summary });
    } catch (error) {
      logger.error('Get shift summary by ID error:', error);
      if (error.message === 'Shift not found') {
        return res.status(404).json({ success: false, message: error.message });
      }
      if (error.message === 'You can only view your own shifts') {
        return res.status(403).json({ success: false, message: error.message });
      }
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Get shift summary statistics across date range for an outlet
   * GET /api/v1/orders/shifts/:outletId/outlet-summary
   * Cashiers see only their own shift summary
   */
  async getShiftSummary(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate, floorId } = req.query;

      // If cashier role, filter to only their own shifts
      // Note: req.user.roles is array of role strings like ['cashier', 'admin']
      const isCashier = req.user.roles?.includes('cashier');
      const cashierId = isCashier ? req.user.userId : null;
      
      // Get user's floor if not provided
      let effectiveFloorId = floorId ? parseInt(floorId) : null;
      if (!effectiveFloorId && isCashier) {
        const floorIds = await getUserFloorIds(req.user.userId, outletId);
        effectiveFloorId = floorIds.length > 0 ? floorIds[0] : null;
      }

      const summary = await paymentService.getShiftSummary({
        outletId,
        startDate: startDate || null,
        endDate: endDate || null,
        floorId: effectiveFloorId,
        cashierId
      });

      res.json({ success: true, data: summary });
    } catch (error) {
      logger.error('Get shift summary error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // ADMIN ORDER MANAGEMENT
  // ========================

  /**
   * Get all orders for admin with filters, pagination, sorting
   * GET /api/v1/orders/admin/list
   */
  async getAdminOrderList(req, res) {
    try {
      const {
        outletId,
        status,
        orderType,
        paymentStatus,
        startDate,
        endDate,
        search,
        captainId,
        cashierId,
        tableId,
        floorId,
        minAmount,
        maxAmount,
        page = 1,
        limit = 20,
        sortBy = 'created_at',
        sortOrder = 'DESC'
      } = req.query;

      const result = await orderService.getAdminOrderList({
        outletId: outletId || null,
        status: status || null,
        orderType: orderType || null,
        paymentStatus: paymentStatus || null,
        startDate: startDate || null,
        endDate: endDate || null,
        search: search || null,
        captainId: captainId || null,
        cashierId: cashierId || null,
        tableId: tableId || null,
        floorId: floorId || null,
        minAmount: minAmount ? parseFloat(minAmount) : null,
        maxAmount: maxAmount ? parseFloat(maxAmount) : null,
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder
      });

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get admin order list error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export orders list as CSV for admin/manager
   * GET /api/v1/orders/admin/list/export
   */
  async exportAdminOrderList(req, res) {
    try {
      const {
        outletId,
        status,
        orderType,
        paymentStatus,
        startDate: rawStartDate,
        endDate: rawEndDate,
        search,
        captainId,
        cashierId,
        tableId,
        floorId,
        minAmount,
        maxAmount,
        sortBy = 'created_at',
        sortOrder = 'DESC'
      } = req.query;

      // Handle startDate/endDate - can be flat params or nested in orderType object
      const startDate = rawStartDate || (typeof orderType === 'object' ? orderType.startDate : null);
      const endDate = rawEndDate || (typeof orderType === 'object' ? orderType.endDate : null);
      // orderType filter - only use if it's a string (not object with dates)
      const orderTypeFilter = typeof orderType === 'string' ? orderType : null;

      // Get floor permissions for manager
      const userFloorIds = outletId ? await getUserFloorIds(req.user.userId, outletId) : [];
      
      // Use floorId filter if provided, otherwise use user's floor permissions
      const effectiveFloorId = floorId || (userFloorIds.length > 0 ? userFloorIds : null);

      // Get all orders without pagination for export
      const result = await orderService.getAdminOrderListForExport({
        outletId: outletId || null,
        status: status || null,
        orderType: orderTypeFilter || null,
        paymentStatus: paymentStatus || null,
        startDate: startDate || null,
        endDate: endDate || null,
        search: search || null,
        captainId: captainId || null,
        cashierId: cashierId || null,
        tableId: tableId || null,
        floorId: effectiveFloorId,
        minAmount: minAmount ? parseFloat(minAmount) : null,
        maxAmount: maxAmount ? parseFloat(maxAmount) : null,
        sortBy,
        sortOrder
      });

      const csv = csvExport.adminOrderListCSV(result, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('orders_list', { startDate, endDate });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export admin order list error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Get comprehensive order details for admin
   * GET /api/v1/orders/admin/detail/:orderId
   */
  async getAdminOrderDetail(req, res) {
    try {
      const { orderId } = req.params;
      const order = await orderService.getAdminOrderDetail(orderId);
      res.json({ success: true, data: order });
    } catch (error) {
      logger.error('Get admin order detail error:', error);
      if (error.message === 'Order not found') {
        return res.status(404).json({ success: false, message: error.message });
      }
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Get sales breakdown by service type (restaurant vs bar)
   * GET /api/v1/orders/reports/:outletId/service-type-breakdown
   */
  async getServiceTypeSalesBreakdown(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getServiceTypeSalesBreakdown(outletId, startDate, endDate, floorIds);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get service type sales breakdown error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Get due report for admin/manager
   * GET /api/v1/orders/reports/:outletId/due
   */
  async getDueReport(req, res) {
    try {
      const { outletId } = req.params;
      const { page, limit, search, customerId, minDue, maxDue, sortBy, sortOrder, startDate, endDate } = req.query;

      const result = await paymentService.getDueReport(outletId, {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
        search: search || null,
        customerId: customerId ? parseInt(customerId) : null,
        minDue: minDue ? parseFloat(minDue) : null,
        maxDue: maxDue ? parseFloat(maxDue) : null,
        startDate: startDate || null,
        endDate: endDate || null,
        sortBy: sortBy || 'due_balance',
        sortOrder: sortOrder || 'DESC'
      });

      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Get due report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export due report as CSV
   * GET /api/v1/orders/reports/:outletId/due/export
   */
  async exportDueReport(req, res) {
    try {
      const { outletId } = req.params;
      const { search, customerId, minDue, maxDue, sortBy, sortOrder } = req.query;

      const result = await paymentService.getDueReportForExport(outletId, {
        search: search || null,
        customerId: customerId ? parseInt(customerId) : null,
        minDue: minDue ? parseFloat(minDue) : null,
        maxDue: maxDue ? parseFloat(maxDue) : null,
        sortBy: sortBy || 'due_balance',
        sortOrder: sortOrder || 'DESC'
      });

      const csv = csvExport.dueReportCSV(result);
      const filename = csvExport.generateFilename('due_report', {});

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export due report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // CSV EXPORT METHODS
  // ========================

  /**
   * Export daily sales report as CSV
   */
  async exportDailySales(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getDailySalesReport(outletId, startDate, endDate, floorIds);
      
      const csv = csvExport.dailySalesCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('daily_sales', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export daily sales error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export detailed daily sales as CSV
   */
  async exportDailySalesDetail(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      // Get all records without pagination for export
      const report = await reportsService.getDailySalesDetail(outletId, startDate, endDate, { page: 1, limit: 10000 }, floorIds);
      
      const csv = csvExport.dailySalesDetailCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('daily_sales_detail', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export daily sales detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export item sales report as CSV
   */
  async exportItemSales(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate, serviceType } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getItemSalesReport(outletId, startDate, endDate, 10000, floorIds, serviceType || null);
      
      const csv = csvExport.itemSalesCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('item_sales', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export item sales error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export category sales report as CSV
   */
  async exportCategorySales(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getCategorySalesReport(outletId, startDate, endDate, floorIds);
      
      const csv = csvExport.categorySalesCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('category_sales', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export category sales error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export item sales detail report as CSV
   */
  async exportItemSalesDetail(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate, serviceType } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getItemSalesDetail(outletId, startDate, endDate, {
        limit: 10000,
        floorIds,
        serviceType: serviceType || null
      });
      
      const csv = csvExport.itemSalesDetailCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('item_sales_detail', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export item sales detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export staff performance report as CSV
   */
  async exportStaffReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getStaffReport(outletId, startDate, endDate, floorIds);
      
      const csv = csvExport.staffReportCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('staff_report', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export staff report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export payment mode report as CSV
   */
  async exportPaymentModes(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getPaymentModeReport(outletId, startDate, endDate, floorIds);
      
      const csv = csvExport.paymentModeCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('payment_modes', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export payment modes error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export tax report as CSV
   */
  async exportTaxReport(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getTaxReport(outletId, startDate, endDate, floorIds);
      
      const csv = csvExport.taxReportCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('tax_report', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export tax report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export service type breakdown as CSV
   */
  async exportServiceTypeBreakdown(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getServiceTypeSalesBreakdown(outletId, startDate, endDate, floorIds);
      
      const csv = csvExport.serviceTypeCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('service_type_breakdown', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export service type breakdown error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export floor/section sales report as CSV
   */
  async exportFloorSection(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getFloorSectionReport(outletId, startDate, endDate, floorIds);
      
      const csv = csvExport.floorSectionCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('floor_section', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export floor section error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export counter sales report as CSV
   */
  async exportCounterSales(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getCounterSalesReport(outletId, startDate, endDate, floorIds);
      
      const csv = csvExport.counterSalesCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('counter_sales', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export counter sales error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export cancellation report as CSV
   */
  async exportCancellations(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const report = await reportsService.getCancellationReport(outletId, startDate, endDate, floorIds);
      
      const csv = csvExport.cancellationCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('cancellations', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export cancellations error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export shift history as CSV
   */
  async exportShiftHistory(req, res) {
    try {
      const { outletId } = req.params;
      const { startDate, endDate } = req.query;
      
      const report = await paymentService.getShiftHistory({
        outletId,
        startDate,
        endDate,
        limit: 10000 // Get all shifts for export
      });
      
      const csv = csvExport.shiftHistoryCSV(report, { startDate, endDate, outletId });
      const filename = csvExport.generateFilename('shift_history', { startDate, endDate });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export shift history error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * Export shift detail as CSV
   */
  async exportShiftDetail(req, res) {
    try {
      const { shiftId } = req.params;
      
      const report = await paymentService.getShiftDetail(shiftId);
      
      if (!report) {
        return res.status(404).json({ success: false, message: 'Shift not found' });
      }
      
      const csv = csvExport.shiftDetailCSV(report, { shiftId });
      const filename = csvExport.generateFilename('shift_detail', { shiftId });
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export shift detail error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // NC (NO CHARGE) REPORT
  // ========================

  /**
   * GET /api/v1/orders/reports/:outletId/nc
   * NC Report with filters, pagination, sorting — order-level and item-level
   */
  async getNCReport(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const options = {
        page: req.query.page,
        limit: req.query.limit,
        search: req.query.search,
        ncType: req.query.ncType,
        ncReason: req.query.ncReason,
        appliedByName: req.query.appliedByName,
        orderType: req.query.orderType,
        floorName: req.query.floorName,
        sortBy: req.query.sortBy,
        sortOrder: req.query.sortOrder,
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      const report = await reportsService.getNCReport(outletId, req.query.startDate, req.query.endDate, options);
      res.json({ success: true, data: report });
    } catch (error) {
      logger.error('Get NC report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /api/v1/orders/reports/:outletId/nc/export
   * Export NC Report as CSV
   */
  async exportNCReport(req, res) {
    try {
      const { outletId } = req.params;
      const floorIds = await getUserFloorIds(req.user.userId, outletId);
      const options = {
        page: 1,
        limit: 10000,
        search: req.query.search,
        ncType: req.query.ncType,
        ncReason: req.query.ncReason,
        appliedByName: req.query.appliedByName,
        orderType: req.query.orderType,
        floorName: req.query.floorName,
        sortBy: req.query.sortBy || 'nc_at',
        sortOrder: req.query.sortOrder || 'DESC',
        floorIds: floorIds.length > 0 ? floorIds : undefined
      };
      const report = await reportsService.getNCReport(outletId, req.query.startDate, req.query.endDate, options);

      const csv = csvExport.ncReportCSV(report, {
        startDate: req.query.startDate,
        endDate: req.query.endDate,
        outletId
      });
      const filename = csvExport.generateFilename('nc_report', {
        startDate: req.query.startDate,
        endDate: req.query.endDate
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error) {
      logger.error('Export NC report error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // COST SNAPSHOT
  // ========================

  async getOrderCosts(req, res) {
    try {
      const { orderId } = req.params;
      const result = await costSnapshotService.getOrderCosts(orderId);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Get order costs error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
};

module.exports = orderController;
