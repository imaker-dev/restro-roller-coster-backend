/**
 * Dyno APIs Service
 * Handles communication with Dyno APIs for Swiggy/Zomato integration
 * All external platform communication goes through Dyno middleware
 */

const axios = require('axios');
const crypto = require('crypto');
const { getPool } = require('../database');
const logger = require('../utils/logger');

// Configuration from Dyno API Documentation v2.0.19
// Dyno runs as a local service on port 8080
const DYNO_API_BASE_URL = process.env.DYNO_API_BASE_URL || 'http://localhost:8080';
const DYNO_API_TIMEOUT = parseInt(process.env.DYNO_API_TIMEOUT) || 30000;

// Platform-specific API paths (from OpenAPI spec)
const PLATFORM_ENDPOINTS = {
  swiggy: {
    login: '/api/v1/swiggy/login',
    getOrders: '/api/v1/swiggy/orders',
    acceptOrder: '/api/v1/swiggy/orders/accept',        // query: order_id, prep_time
    acceptOrderByRes: '/api/v1/swiggy/orders/accept/',  // + res_id, query: order_id, prep_time
    markReady: '/api/v1/swiggy/orders/ready',           // query: order_id
    markReadyByRes: '/api/v1/swiggy/orders/ready/',     // + res_id, query: order_id
    getItems: '/api/v1/swiggy/items',
    getItemsByRes: '/api/v1/swiggy/items/',             // + res_id
    itemInStock: '/api/v1/swiggy/items/instock',        // query: item_id
    itemOutOfStock: '/api/v1/swiggy/items/outofstock',  // query: item_id
    orderHistory: '/api/v1/swiggy/orderHistory'         // query: restaurant_id
  },
  zomato: {
    login: '/api/v1/zomato/login',
    getCurrentOrders: '/api/v1/zomato/orders/current',
    getOrderDetails: '/api/v1/zomato/order/details',    // query: order_id
    acceptOrder: '/api/v1/zomato/orders/accept_order',  // query: order_id, delivery_time
    acceptOrderByRes: '/api/v1/zomato/orders/accept_order/', // + res_id
    markReady: '/api/v1/zomato/orders/mark_ready',      // query: order_id
    markReadyByRes: '/api/v1/zomato/orders/mark_ready/', // + res_id
    rejectOrder: '/api/v1/zomato/orders/reject',        // query: restaurant_id, order_id
    getItems: '/api/v1/zomato/items',
    getItemsByRes: '/api/v1/zomato/items/',             // + res_id
    itemInStock: '/api/v1/zomato/items/in_stock',       // query: item_id
    itemOutOfStock: '/api/v1/zomato/items/out_of_stock', // query: item_id
    orderHistory: '/api/v1/zomato/orderHistory'         // query: restaurant_id
  }
};

// Status mapping: POS status -> Dyno status
const STATUS_MAP = {
  received: 'RECEIVED',
  accepted: 'ACCEPTED',
  preparing: 'PREPARING',
  ready: 'READY_FOR_PICKUP',
  picked_up: 'DISPATCHED',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED'
};

// Reverse mapping: Dyno status -> POS status
const REVERSE_STATUS_MAP = {
  'NEW': 'received',
  'RECEIVED': 'received',
  'ACCEPTED': 'accepted',
  'CONFIRMED': 'accepted',
  'PREPARING': 'preparing',
  'READY': 'ready',
  'READY_FOR_PICKUP': 'ready',
  'DISPATCHED': 'picked_up',
  'OUT_FOR_DELIVERY': 'picked_up',
  'DELIVERED': 'delivered',
  'COMPLETED': 'delivered',
  'CANCELLED': 'cancelled',
  'REJECTED': 'cancelled'
};

const dynoService = {
  STATUS_MAP,
  REVERSE_STATUS_MAP,
  PLATFORM_ENDPOINTS,

  // ========================
  // API CLIENT
  // ========================

  /**
   * Create axios instance with channel credentials
   */
  createClient(accessToken) {
    return axios.create({
      baseURL: DYNO_API_BASE_URL,
      timeout: DYNO_API_TIMEOUT,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
  },

  // ========================
  // WEBHOOK VERIFICATION
  // ========================

  /**
   * Verify webhook signature from Dyno
   * Uses HMAC-SHA256 with timestamp to prevent replay attacks
   */
  verifyWebhookSignature(payload, signature, timestamp, webhookSecret) {
    if (!signature || !timestamp || !webhookSecret) {
      return false;
    }

    // Check timestamp is within 5 minutes
    const now = Math.floor(Date.now() / 1000);
    const webhookTime = parseInt(timestamp, 10);
    if (Math.abs(now - webhookTime) > 300) {
      logger.warn('Webhook timestamp expired', { now, webhookTime, diff: now - webhookTime });
      return false;
    }

    // Compute expected signature
    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const signatureData = `${timestamp}.${payloadString}`;
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(signatureData)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch (err) {
      return false;
    }
  },

  // ========================
  // CHANNEL MANAGEMENT
  // ========================

  /**
   * Get integration channel by ID
   */
  async getChannelById(channelId) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM integration_channels WHERE id = ?',
      [channelId]
    );
    return rows[0] || null;
  },

  /**
   * Get active channel for outlet and platform
   */
  async getChannelByOutletAndPlatform(outletId, platform) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM integration_channels WHERE outlet_id = ? AND channel_name = ? AND is_active = 1',
      [outletId, platform]
    );
    return rows[0] || null;
  },

  /**
   * Get all active channels for outlet
   */
  async getChannelsByOutlet(outletId) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM integration_channels WHERE outlet_id = ? AND is_active = 1 ORDER BY channel_name',
      [outletId]
    );
    return rows;
  },

  /**
   * Create or update integration channel
   */
  async upsertChannel(data) {
    const pool = getPool();
    const {
      outletId, channelName, channelDisplayName,
      dynoOrderId, dynoAccessToken, propertyId,
      propertyName, propertyArea, webhookSecret,
      autoAcceptOrders = false, autoPrintKot = true,
      defaultPrepTime = 20
    } = data;

    const [existing] = await pool.query(
      'SELECT id FROM integration_channels WHERE outlet_id = ? AND channel_name = ?',
      [outletId, channelName]
    );

    if (existing.length > 0) {
      // Update existing
      await pool.query(
        `UPDATE integration_channels SET
          channel_display_name = ?, dyno_order_id = ?, dyno_access_token = ?,
          property_id = ?, property_name = ?, property_area = ?,
          webhook_secret = ?, auto_accept_orders = ?, auto_print_kot = ?,
          default_prep_time = ?, is_active = 1, sync_status = 'active',
          updated_at = NOW()
        WHERE id = ?`,
        [
          channelDisplayName, dynoOrderId, dynoAccessToken,
          propertyId, propertyName, propertyArea,
          webhookSecret, autoAcceptOrders, autoPrintKot,
          defaultPrepTime, existing[0].id
        ]
      );
      return { id: existing[0].id, updated: true };
    } else {
      // Create new
      const [result] = await pool.query(
        `INSERT INTO integration_channels (
          outlet_id, channel_name, channel_display_name,
          dyno_order_id, dyno_access_token, property_id,
          property_name, property_area, webhook_secret,
          auto_accept_orders, auto_print_kot, default_prep_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          outletId, channelName, channelDisplayName,
          dynoOrderId, dynoAccessToken, propertyId,
          propertyName, propertyArea, webhookSecret,
          autoAcceptOrders, autoPrintKot, defaultPrepTime
        ]
      );
      return { id: result.insertId, created: true };
    }
  },

  // ========================
  // ORDER STATUS UPDATES
  // ========================

  /**
   * Accept order via Dyno - platform specific endpoint
   * Swiggy: POST /api/v1/swiggy/orders/accept?order_id=X&prep_time=30
   * Zomato: POST /api/v1/zomato/orders/accept_order?order_id=X&delivery_time=30
   */
  async acceptOrder(channelId, externalOrderId, prepTime = 30) {
    const channel = await this.getChannelById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const platform = channel.channel_name.toLowerCase();
    const endpoints = PLATFORM_ENDPOINTS[platform];
    if (!endpoints) throw new Error(`Unknown platform: ${platform}`);

    const client = this.createClient(channel.dyno_access_token);
    const endpoint = channel.property_id 
      ? `${endpoints.acceptOrderByRes}${channel.property_id}`
      : endpoints.acceptOrder;

    const params = platform === 'swiggy'
      ? { order_id: externalOrderId, prep_time: prepTime }
      : { order_id: externalOrderId, delivery_time: String(prepTime) };

    const logId = await this.logRequest({
      outletId: channel.outlet_id,
      channelId,
      logType: 'accept_order',
      direction: 'outbound',
      endpoint,
      method: 'POST',
      requestBody: params
    });

    try {
      const response = await client.post(endpoint, null, { params });
      await this.updateLog(logId, { status: 'success', responseStatus: response.status, responseBody: response.data });
      logger.info(`Order accepted via Dyno: ${externalOrderId} on ${platform}`);
      return { success: true, data: response.data };
    } catch (error) {
      const errorMessage = error.response?.data?.message || error.message;
      await this.updateLog(logId, { status: 'failed', responseStatus: error.response?.status, responseBody: error.response?.data, errorMessage });
      logger.error(`Failed to accept order: ${externalOrderId}`, { error: errorMessage });
      throw new Error(`Dyno API error: ${errorMessage}`);
    }
  },

  /**
   * Mark order ready - platform specific endpoint
   * Swiggy: POST /api/v1/swiggy/orders/ready?order_id=X
   * Zomato: POST /api/v1/zomato/orders/mark_ready?order_id=X
   */
  async markOrderReady(channelId, externalOrderId) {
    const channel = await this.getChannelById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const platform = channel.channel_name.toLowerCase();
    const endpoints = PLATFORM_ENDPOINTS[platform];
    if (!endpoints) throw new Error(`Unknown platform: ${platform}`);

    const client = this.createClient(channel.dyno_access_token);
    const endpoint = channel.property_id 
      ? `${endpoints.markReadyByRes}${channel.property_id}`
      : endpoints.markReady;

    const params = { order_id: externalOrderId };

    const logId = await this.logRequest({
      outletId: channel.outlet_id,
      channelId,
      logType: 'mark_ready',
      direction: 'outbound',
      endpoint,
      method: 'POST',
      requestBody: params
    });

    try {
      const response = await client.post(endpoint, null, { params });
      await this.updateLog(logId, { status: 'success', responseStatus: response.status, responseBody: response.data });
      logger.info(`Order marked ready via Dyno: ${externalOrderId} on ${platform}`);
      return { success: true, data: response.data };
    } catch (error) {
      const errorMessage = error.response?.data?.message || error.message;
      await this.updateLog(logId, { status: 'failed', responseStatus: error.response?.status, responseBody: error.response?.data, errorMessage });
      logger.error(`Failed to mark ready: ${externalOrderId}`, { error: errorMessage });
      throw new Error(`Dyno API error: ${errorMessage}`);
    }
  },

  /**
   * Reject order - Zomato only
   * POST /api/v1/zomato/orders/reject?restaurant_id=X&order_id=X
   */
  async rejectOrder(channelId, externalOrderId, reason) {
    const channel = await this.getChannelById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const platform = channel.channel_name.toLowerCase();
    if (platform !== 'zomato') {
      logger.warn(`Reject not supported on ${platform}, order: ${externalOrderId}`);
      return { success: false, message: 'Reject only supported for Zomato orders' };
    }

    const client = this.createClient(channel.dyno_access_token);
    const params = { restaurant_id: channel.property_id, order_id: externalOrderId };

    const logId = await this.logRequest({
      outletId: channel.outlet_id,
      channelId,
      logType: 'reject_order',
      direction: 'outbound',
      endpoint: PLATFORM_ENDPOINTS.zomato.rejectOrder,
      method: 'POST',
      requestBody: { ...params, reason }
    });

    try {
      const response = await client.post(PLATFORM_ENDPOINTS.zomato.rejectOrder, null, { params });
      await this.updateLog(logId, { status: 'success', responseStatus: response.status, responseBody: response.data });
      logger.info(`Order rejected via Dyno: ${externalOrderId}`);
      return { success: true, data: response.data };
    } catch (error) {
      const errorMessage = error.response?.data?.message || error.message;
      await this.updateLog(logId, { status: 'failed', responseStatus: error.response?.status, responseBody: error.response?.data, errorMessage });
      logger.error(`Failed to reject order: ${externalOrderId}`, { error: errorMessage });
      throw new Error(`Dyno API error: ${errorMessage}`);
    }
  },

  /**
   * Get current/new orders from platform
   * Swiggy: GET /api/v1/swiggy/orders
   * Zomato: GET /api/v1/zomato/orders/current
   */
  async getOrders(channelId) {
    const channel = await this.getChannelById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const platform = channel.channel_name.toLowerCase();
    const endpoints = PLATFORM_ENDPOINTS[platform];
    if (!endpoints) throw new Error(`Unknown platform: ${platform}`);

    const client = this.createClient(channel.dyno_access_token);
    const endpoint = platform === 'swiggy' ? endpoints.getOrders : endpoints.getCurrentOrders;

    try {
      const response = await client.get(endpoint);
      logger.info(`Fetched orders from ${platform}: ${response.data?.orders?.length || 0} orders`);
      return { success: true, orders: response.data?.orders || response.data || [] };
    } catch (error) {
      logger.error(`Failed to get orders from ${platform}`, { error: error.message });
      throw new Error(`Dyno API error: ${error.response?.data?.message || error.message}`);
    }
  },

  /**
   * Get menu items from platform
   * Swiggy: GET /api/v1/swiggy/items or /api/v1/swiggy/items/{res_id}
   * Zomato: GET /api/v1/zomato/items or /api/v1/zomato/items/{res_id}
   */
  async getItems(channelId) {
    const channel = await this.getChannelById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const platform = channel.channel_name.toLowerCase();
    const endpoints = PLATFORM_ENDPOINTS[platform];
    if (!endpoints) throw new Error(`Unknown platform: ${platform}`);

    const client = this.createClient(channel.dyno_access_token);
    const endpoint = channel.property_id 
      ? `${endpoints.getItemsByRes}${channel.property_id}`
      : endpoints.getItems;

    try {
      const response = await client.get(endpoint);
      logger.info(`Fetched items from ${platform}: ${response.data?.items?.length || 0} items`);
      return { success: true, items: response.data?.items || response.data || [] };
    } catch (error) {
      logger.error(`Failed to get items from ${platform}`, { error: error.message });
      throw new Error(`Dyno API error: ${error.response?.data?.message || error.message}`);
    }
  },

  /**
   * Update item stock status
   * Swiggy: POST /api/v1/swiggy/items/instock or outofstock?item_id=X
   * Zomato: POST /api/v1/zomato/items/in_stock or out_of_stock?item_id=X
   */
  async updateItemStock(channelId, itemId, inStock) {
    const channel = await this.getChannelById(channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const platform = channel.channel_name.toLowerCase();
    const endpoints = PLATFORM_ENDPOINTS[platform];
    if (!endpoints) throw new Error(`Unknown platform: ${platform}`);

    const client = this.createClient(channel.dyno_access_token);
    const endpoint = inStock ? endpoints.itemInStock : endpoints.itemOutOfStock;

    try {
      const response = await client.post(endpoint, null, { params: { item_id: itemId } });
      logger.info(`Item ${itemId} marked ${inStock ? 'in stock' : 'out of stock'} on ${platform}`);
      return { success: true, data: response.data };
    } catch (error) {
      logger.error(`Failed to update item stock: ${itemId}`, { error: error.message });
      throw new Error(`Dyno API error: ${error.response?.data?.message || error.message}`);
    }
  },

  // ========================
  // ORDER POLLING (Use getOrders instead)
  // ========================

  /**
   * Poll for new orders - wrapper around getOrders
   */
  async pollNewOrders(channelId) {
    const result = await this.getOrders(channelId);
    await this.updateChannelSyncStatus(channelId, 'active');
    return result.orders || [];
  },

  /**
   * Update channel sync status
   */
  async updateChannelSyncStatus(channelId, status, errorMessage = null) {
    const pool = getPool();
    await pool.query(
      `UPDATE integration_channels SET 
        last_sync_at = NOW(), sync_status = ?, sync_error_message = ?
      WHERE id = ?`,
      [status, errorMessage, channelId]
    );
  },

  // ========================
  // MENU SYNC
  // ========================

  /**
   * Sync item availability - uses platform-specific stock endpoints
   */
  async syncItemAvailability(channelId, items) {
    const results = [];
    for (const item of items) {
      try {
        const result = await this.updateItemStock(channelId, item.externalItemId, item.isAvailable);
        results.push({ itemId: item.externalItemId, success: true });
      } catch (error) {
        results.push({ itemId: item.externalItemId, success: false, error: error.message });
      }
    }
    logger.info(`Menu availability synced: ${results.filter(r => r.success).length}/${items.length} items`);
    return results;
  },

  // ========================
  // LOGGING
  // ========================

  /**
   * Log integration request
   */
  async logRequest(data) {
    const pool = getPool();
    const {
      outletId, channelId, onlineOrderId,
      logType, direction, endpoint, method,
      requestHeaders, requestBody
    } = data;

    const [result] = await pool.query(
      `INSERT INTO integration_logs (
        outlet_id, channel_id, online_order_id,
        log_type, direction, endpoint, method,
        request_headers, request_body, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [
        outletId, channelId, onlineOrderId,
        logType, direction, endpoint, method,
        JSON.stringify(requestHeaders), JSON.stringify(requestBody)
      ]
    );

    return result.insertId;
  },

  /**
   * Update log with response
   */
  async updateLog(logId, data) {
    const pool = getPool();
    const { status, responseStatus, responseBody, errorMessage } = data;

    await pool.query(
      `UPDATE integration_logs SET
        status = ?, response_status = ?, response_body = ?,
        error_message = ?, completed_at = NOW(),
        duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, NOW()) / 1000
      WHERE id = ?`,
      [status, responseStatus, JSON.stringify(responseBody), errorMessage, logId]
    );
  },

  /**
   * Get integration logs
   */
  async getLogs(filters = {}) {
    const pool = getPool();
    const { outletId, channelId, logType, status, limit = 100 } = filters;

    let query = 'SELECT * FROM integration_logs WHERE 1=1';
    const params = [];

    if (outletId) {
      query += ' AND outlet_id = ?';
      params.push(outletId);
    }
    if (channelId) {
      query += ' AND channel_id = ?';
      params.push(channelId);
    }
    if (logType) {
      query += ' AND log_type = ?';
      params.push(logType);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(query, params);
    return rows;
  }
};

module.exports = dynoService;
