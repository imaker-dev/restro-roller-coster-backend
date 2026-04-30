/**
 * Self-Order Controller
 * Handles QR table ordering — public (customer) and authenticated (staff) endpoints.
 */

const selfOrderService = require('../services/selfOrder.service');
const logger = require('../utils/logger');

const selfOrderController = {

  // ========================
  // PUBLIC ENDPOINTS (customer-facing, session-token auth)
  // ========================

  /**
   * POST /self-order/init
   * Initialize a self-order session from QR scan
   */
  async initSession(req, res) {
    try {
      const { outletId, tableId, qrToken, deviceId } = req.body;
      const result = await selfOrderService.initSession({
        outletId,
        tableId,
        qrToken,
        deviceId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order init error:', error);
      const status = error.message.includes('not enabled') || error.message.includes('closed') ? 403
        : error.message.includes('not found') ? 404
        : error.message.includes('another device') ? 409
        : error.message.includes('Maximum active') || error.message.includes('in use') || error.message.includes('managed by staff') ? 409
        : error.message.includes('bill has been generated') || error.message.includes('complete payment') ? 409
        : 400;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /self-order/menu
   * Get menu for self-order (requires valid session)
   */
  async getMenu(req, res) {
    try {
      const { outletId } = req.selfOrderSession;
      const { filter, serviceType } = req.query;
      const menu = await selfOrderService.getMenu(outletId, { filter, serviceType });
      res.status(200).json({ success: true, data: menu });
    } catch (error) {
      logger.error('Self-order menu error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /self-order/session
   * Get current session info (customer view)
   */
  async getSession(req, res) {
    try {
      res.status(200).json({ success: true, data: req.selfOrderSession });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * PUT /self-order/customer
   * Update customer details on session
   */
  async updateCustomer(req, res) {
    try {
      const { id: sessionId } = req.selfOrderSession;
      const { customerName, customerPhone } = req.body;
      const result = await selfOrderService.updateCustomerDetails(sessionId, { customerName, customerPhone });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order update customer error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /self-order/order
   * Place a self-order
   */
  async placeOrder(req, res) {
    try {
      const session = req.selfOrderSession;
      const { customerName, customerPhone, specialInstructions, items } = req.body;
      const result = await selfOrderService.placeOrder(session, {
        customerName,
        customerPhone,
        specialInstructions,
        items,
      });
      res.status(201).json({ success: true, message: 'Order placed successfully', data: result });
    } catch (error) {
      logger.error('Self-order place error:', error);
      const status = error.message.includes('required') ? 422
        : error.message.includes('not found') || error.message.includes('not available') ? 400
        : error.message.includes('already been placed') ? 409
        : error.message.includes('bill has been generated') || error.message.includes('complete payment') ? 409
        : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /self-order/order/add-items
   * Add items to existing order (reorder)
   */
  async addItems(req, res) {
    try {
      const session = req.selfOrderSession;
      if (!session.orderId) {
        return res.status(400).json({ success: false, message: 'No active order in this session. Place an order first.' });
      }
      const { specialInstructions, items } = req.body;
      const result = await selfOrderService._addItemsToExistingOrder(
        session,
        { specialInstructions, items },
        await selfOrderService.getSettings(session.outletId)
      );
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order add items error:', error);
      const status = error.message.includes('bill has been generated') || error.message.includes('complete payment') ? 409 : 400;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /self-order/order/status
   * Get order status for customer
   */
  async getOrderStatus(req, res) {
    try {
      const session = req.selfOrderSession;
      const result = await selfOrderService.getOrderStatus(session);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order status error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // CUSTOMER: ORDER MODIFICATION
  // ========================

  /**
   * POST /self-order/order/cancel
   * Cancel a self-order (customer-initiated, before preparation)
   */
  async cancelOrder(req, res) {
    try {
      const session = req.selfOrderSession;
      const { reason } = req.body;
      const result = await selfOrderService.cancelOrder(session, reason);
      res.status(200).json({ success: true, message: 'Order cancelled successfully', data: result });
    } catch (error) {
      logger.error('Self-order cancel error:', error);
      const status = error.message.includes('No active') ? 400
        : error.message.includes('cannot be cancelled') ? 409
        : error.message.includes('not found') ? 404
        : 400;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  /**
   * PUT /self-order/order/item/:orderItemId
   * Update item quantity (customer-initiated, before KOT)
   */
  async updateItemQuantity(req, res) {
    try {
      const session = req.selfOrderSession;
      const orderItemId = parseInt(req.params.orderItemId, 10);
      const { quantity } = req.body;
      const result = await selfOrderService.updateItemQuantity(session, orderItemId, quantity);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order update item error:', error);
      const status = error.message.includes('not found') ? 404
        : error.message.includes('cannot be modified') || error.message.includes('sent to the kitchen') ? 409
        : 400;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  /**
   * DELETE /self-order/order/item/:orderItemId
   * Remove an item from order (customer-initiated, before KOT)
   */
  async removeItem(req, res) {
    try {
      const session = req.selfOrderSession;
      const orderItemId = parseInt(req.params.orderItemId, 10);
      const result = await selfOrderService.removeItem(session, orderItemId);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order remove item error:', error);
      const status = error.message.includes('not found') ? 404
        : error.message.includes('cannot be removed') || error.message.includes('sent to the kitchen') ? 409
        : error.message.includes('last item') ? 422
        : 400;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  // ========================
  // STAFF ENDPOINTS (JWT authenticated)
  // ========================

  /**
   * GET /self-order/staff/pending
   * Get pending self-orders for outlet
   */
  async getPendingOrders(req, res) {
    try {
      const outletId = parseInt(req.params.outletId || req.query.outletId, 10);
      const { status, page, limit, search, fromDate, toDate } = req.query;
      const result = await selfOrderService.getPendingSelfOrders(outletId, {
        status: status || 'pending',
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 20,
        search,
        fromDate,
        toDate,
      });
      res.status(200).json({ success: true, data: result.orders, pagination: result.pagination });
    } catch (error) {
      logger.error('Self-order pending list error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /self-order/staff/accept
   * Accept a pending self-order
   */
  async acceptOrder(req, res) {
    try {
      const { orderId } = req.body;
      const acceptedBy = req.user.userId;
      const result = await selfOrderService.acceptOrder(orderId, acceptedBy);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order accept error:', error);
      const status = error.message.includes('not found') ? 404
        : error.message.includes('already') ? 409
        : 400;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /self-order/staff/reject
   * Reject a pending self-order
   */
  async rejectOrder(req, res) {
    try {
      const { orderId, reason } = req.body;
      const rejectedBy = req.user.userId;
      const result = await selfOrderService.rejectOrder(orderId, rejectedBy, reason);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order reject error:', error);
      const status = error.message.includes('not found') ? 404
        : error.message.includes('already') ? 409
        : 400;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /self-order/staff/settings
   * Get self-order settings for outlet
   */
  async getSettings(req, res) {
    try {
      const outletId = req.params.outletId || req.query.outletId;
      const settings = await selfOrderService.getSettings(parseInt(outletId, 10));
      res.status(200).json({ success: true, data: settings });
    } catch (error) {
      logger.error('Self-order settings error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * PATCH /self-order/staff/settings/:outletId
   * Update self-order settings for outlet
   */
  async updateSettings(req, res) {
    try {
      const outletId = parseInt(req.params.outletId, 10);
      const updates = req.body;
      const result = await selfOrderService.updateSettings(outletId, updates);
      res.status(200).json({ success: true, message: 'Settings updated', data: result });
    } catch (error) {
      logger.error('Self-order update settings error:', error);
      const status = error.message.includes('Invalid') ? 400 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  // ========================
  // CART ENDPOINTS (public, session-token auth)
  // ========================

  /**
   * POST /self-order/cart
   * Save cart for current session
   */
  async saveCart(req, res) {
    try {
      const session = req.selfOrderSession;
      const { items } = req.body;
      const result = await selfOrderService.saveCart(session, items);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order save cart error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /self-order/cart
   * Get cart for current session
   */
  async getCart(req, res) {
    try {
      const session = req.selfOrderSession;
      const result = await selfOrderService.getCart(session);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order get cart error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // PAST ORDERS (public, session-token auth)
  // ========================

  /**
   * GET /self-order/orders
   * Get past orders for the table in current session
   */
  async getPastOrders(req, res) {
    try {
      const session = req.selfOrderSession;
      const limit = parseInt(req.query.limit, 10) || 10;
      const result = await selfOrderService.getPastOrders(session, { limit });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order past orders error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // QR CODE GENERATION (staff, JWT auth)
  // ========================

  /**
   * GET /self-order/staff/qr/tables/:outletId
   * Get all table QR URLs for an outlet, grouped by floor
   */
  async getTableQrUrls(req, res) {
    try {
      const outletId = parseInt(req.params.outletId, 10);
      const { baseUrl, floorId } = req.query;
      const result = await selfOrderService.getTableQrUrls(outletId, { baseUrl, floorId });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order get table QR URLs error:', error);
      const status = error.message.includes('not found') ? 404 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /self-order/staff/qr/generate
   * Generate QR code for a single table
   */
  async generateQr(req, res) {
    try {
      const { outletId, tableId, baseUrl } = req.body;
      const result = await selfOrderService.generateTableQr(outletId, tableId, { baseUrl });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order QR generate error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /self-order/staff/qr/generate-all
   * Bulk generate QR codes for all tables in outlet
   */
  async generateAllQrs(req, res) {
    try {
      const { outletId, baseUrl } = req.body;
      const results = await selfOrderService.generateAllTableQrs(parseInt(outletId, 10), { baseUrl });
      res.status(200).json({ success: true, data: { tables: results, count: results.length } });
    } catch (error) {
      logger.error('Self-order QR generate-all error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /self-order/staff/session/:sessionId/complete
   * Complete a session (QR codes are permanent — no rotation)
   */
  async completeSession(req, res) {
    try {
      const sessionId = parseInt(req.params.sessionId, 10);
      const result = await selfOrderService.completeSession(sessionId);
      if (!result) return res.status(404).json({ success: false, message: 'Session not found' });
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      logger.error('Self-order complete session error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },
};

module.exports = selfOrderController;
