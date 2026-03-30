/**
 * Dyno Webhook Controller (Production-Level)
 * 
 * Handles all webhook endpoints that Dyno calls on your server.
 * Pattern: Webhook → Queue (Redis) → Worker → DB
 * 
 * Based on Dyno Webhook Implementation Documentation v2.0
 */

const { getPool } = require('../database');
const { addJob } = require('../queues');
const { QUEUE_NAMES } = require('../constants');
const { isRedisAvailable, cache } = require('../config/redis');
const onlineOrderService = require('../services/onlineOrder.service');
const logger = require('../utils/logger');

// ============================================================
// IN-MEMORY CACHE FOR HIGH-FREQUENCY ENDPOINTS
// Reduces DB load from Dyno's frequent polling
// ============================================================
const statusCache = new Map(); // resId -> { data, timestamp }
const STATUS_CACHE_TTL = 5000; // 5 seconds - respond with cached data if same request within 5s
const LOG_DEBOUNCE_MS = 30000; // Only log to DB every 30 seconds per resId
const lastLogTime = new Map(); // resId:logType -> timestamp

// Dyno status codes
const DYNO_STATUS = {
  ACCEPT: 1,      // Order needs to be accepted
  ACCEPTED: 2,    // Order was accepted
  READY: 3,       // Order needs to be marked ready
  MARKED_READY: 4 // Order was marked ready
};

// ============================================================
// ORDER ENDPOINTS
// ============================================================

/**
 * POST /orders
 * Receive new orders from Swiggy/Zomato via Dyno
 * 
 * Uses Redis queue for async processing when available,
 * falls back to sync processing otherwise.
 */
exports.receiveOrder = async (req, res) => {
  const startTime = Date.now();
  const responses = [];
  
  try {
    const payload = req.body;
    const ordersArray = payload.orders || (Array.isArray(payload) ? payload : [payload]);
    
    logger.info('Dyno webhook: Received orders', {
      count: ordersArray.length,
      ip: req.ip
    });

    // Get channel from middleware (already validated)
    const channel = req.webhookChannel;

    for (const orderWrapper of ordersArray) {
      const orderId = orderWrapper.orderId || orderWrapper.order_id;
      const status = (orderWrapper.status || 'NEW').toUpperCase();

      try {
        // Skip non-NEW orders
        if (status !== 'NEW') {
          responses.push({
            status: 200,
            orderId,
            message: `Order ${orderId} status update acknowledged (${status})`
          });
          continue;
        }

        // Find channel if not from middleware
        let orderChannel = channel;
        if (!orderChannel) {
          const resId = orderWrapper.resId || orderWrapper.res_id;
          orderChannel = await findChannelByResId(resId);
        }

        if (!orderChannel) {
          responses.push({
            status: 400,
            orderId,
            message: `No active channel found for resId: ${orderWrapper.resId}`
          });
          continue;
        }

        // Use Redis queue if available, otherwise process sync
        if (isRedisAvailable()) {
          // Queue for async processing
          await addJob(QUEUE_NAMES.DYNO_WEBHOOK, 'process-order', {
            orderWrapper,
            channel: orderChannel,
            receivedAt: new Date().toISOString()
          }, {
            priority: 1, // High priority
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 }
          });

          responses.push({
            status: 200,
            orderId,
            message: `Order ${orderId} queued for processing`
          });
        } else {
          // Sync processing (fallback)
          const result = await processOrderSync(orderWrapper, orderChannel);
          responses.push({
            status: 200,
            orderId,
            message: `Order No. ${result.orderNumber || result.onlineOrderId} Inserted Successfully`
          });
        }

      } catch (error) {
        logger.error('Dyno webhook: Order processing error', { orderId, error: error.message });
        
        if (error.message.includes('duplicate') || error.code === 'ER_DUP_ENTRY') {
          responses.push({
            status: 200,
            orderId,
            message: `Order ${orderId} already exists (duplicate)`
          });
        } else {
          responses.push({
            status: 500,
            orderId,
            message: `Error: ${error.message}`
          });
        }
      }
    }

    logger.info('Dyno webhook: Batch processed', {
      count: ordersArray.length,
      duration: Date.now() - startTime
    });

    return res.status(200).json(responses);

  } catch (error) {
    logger.error('Dyno webhook: Fatal error', { error: error.message });
    return res.status(500).json([{
      status: 500,
      orderId: null,
      message: `Fatal error: ${error.message}`
    }]);
  }
};

/**
 * GET /:resId/orders/status
 * Return order statuses to Dyno for polling
 * 
 * OPTIMIZED: Uses in-memory cache to reduce DB queries
 * Dyno polls this every 30 seconds - we cache for 5 seconds
 * 
 * - status: 1 = needs to be accepted
 * - status: 3 = needs to be marked ready
 */
exports.getOrdersStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    
    // Check cache first (5 second TTL)
    const cacheKey = `orders_status:${resId}`;
    const cached = statusCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < STATUS_CACHE_TTL) {
      return res.json(cached.data);
    }
    
    const pool = getPool();

    // Find channel
    const [channels] = await pool.query(
      `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
      [resId]
    );

    if (!channels.length) {
      const emptyResponse = {
        success: true,
        res_id: resId,
        orders: [],
        orderHistory: false
      };
      statusCache.set(cacheKey, { data: emptyResponse, timestamp: Date.now() });
      return res.json(emptyResponse);
    }

    const channel = channels[0];

    // Get orders needing action (last 24 hours)
    const [orders] = await pool.query(
      `SELECT 
        oo.external_order_id as orderId,
        oo.pos_status,
        oo.platform_status,
        oo.accepted_at,
        oo.food_ready_at,
        COALESCE(ic.default_prep_time, 20) as prepTime
       FROM online_orders oo
       JOIN integration_channels ic ON oo.channel_id = ic.id
       WHERE oo.channel_id = ?
       AND oo.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
       AND oo.pos_status NOT IN ('delivered', 'cancelled')
       ORDER BY oo.created_at DESC`,
      [channel.id]
    );

    // Map to Dyno expected format
    const ordersList = orders.map(order => {
      let status = 0;
      
      // Determine what action is needed
      if (!order.accepted_at && order.pos_status === 'received') {
        status = DYNO_STATUS.ACCEPT; // Needs acceptance
      } else if (order.accepted_at && !order.food_ready_at && 
                 ['accepted', 'preparing'].includes(order.pos_status)) {
        status = DYNO_STATUS.READY; // Needs to be marked ready
      } else if (order.accepted_at && !order.food_ready_at) {
        status = DYNO_STATUS.ACCEPTED; // Was accepted
      } else if (order.food_ready_at) {
        status = DYNO_STATUS.MARKED_READY; // Was marked ready
      }

      return {
        orderId: order.orderId,
        resId: resId,
        status,
        prepTime: order.prepTime
      };
    });

    const response = {
      orderHistory: false,
      orders: ordersList
    };
    
    // Cache the response for 5 seconds
    statusCache.set(cacheKey, { data: response, timestamp: Date.now() });

    return res.json(response);

  } catch (error) {
    logger.error('Dyno webhook: getOrdersStatus error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /orders/:orderId/status
 * Receive status update confirmation from Dyno
 * 
 * Called after client exe accepts/marks ready:
 * - statusCode: 2 = Accepted
 * - statusCode: 4 = Marked Ready
 */
exports.updateOrderStatusById = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { statusCode, statusResponse } = req.body;
    
    logger.info('Dyno webhook: Status update received', { orderId, statusCode });

    const pool = getPool();
    
    // Update based on status code
    let updateField = '';
    let newStatus = '';
    
    if (statusCode === DYNO_STATUS.ACCEPTED) {
      updateField = 'accepted_at = NOW()';
      newStatus = 'accepted';
    } else if (statusCode === DYNO_STATUS.MARKED_READY) {
      updateField = 'food_ready_at = NOW()';
      newStatus = 'ready';
    }

    if (updateField) {
      await pool.query(
        `UPDATE online_orders 
         SET ${updateField}, pos_status = ?, platform_status = ?, last_status_sync_at = NOW()
         WHERE external_order_id = ?`,
        [newStatus, statusCode, orderId]
      );
    }

    await logWebhook(null, 'status_update', req.body, { statusCode }, 'success');

    return res.json({
      status: statusCode,
      message: `Updated the status to ${statusCode} for order Id ${orderId}`
    });

  } catch (error) {
    logger.error('Dyno webhook: updateOrderStatusById error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /:resId/orders/status
 * Receive status update confirmations from Dyno (legacy endpoint)
 */
exports.updateOrderStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    const { order_id, orderId, status, statusCode } = req.body;
    const orderIdValue = order_id || orderId;
    const statusValue = status || statusCode;
    
    logger.info('Dyno webhook: Status update', { resId, orderId: orderIdValue, status: statusValue });

    const pool = getPool();
    await pool.query(
      `UPDATE online_orders 
       SET platform_status = ?, last_status_sync_at = NOW()
       WHERE external_order_id = ?`,
      [statusValue, orderIdValue]
    );

    await logWebhook(null, 'status_update', req.body, { updated: true }, 'success');

    return res.json({
      success: true,
      message: 'Status update received',
      order_id: orderIdValue,
      status: statusValue
    });

  } catch (error) {
    logger.error('Dyno webhook: updateOrderStatus error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /:resId/orders/history
 * Receive order history from Dyno (last 40 orders)
 */
exports.receiveOrderHistory = async (req, res) => {
  try {
    const { resId } = req.params;
    const historyData = req.body;
    
    const orderCount = Array.isArray(historyData.orders) ? historyData.orders.length : 
                       Array.isArray(historyData) ? historyData.length : 0;

    logger.info('Dyno webhook: Order history received', { resId, orderCount });

    // Queue for async processing if Redis available
    if (isRedisAvailable() && orderCount > 0) {
      await addJob(QUEUE_NAMES.DYNO_WEBHOOK, 'process-history', {
        orders: historyData.orders || historyData,
        resId,
        receivedAt: new Date().toISOString()
      });
    }

    await logWebhook(null, 'order_history', historyData, { count: orderCount }, 'success');

    return res.json({
      status: 200,
      message: 'Request is Successful'
    });

  } catch (error) {
    logger.error('Dyno webhook: receiveOrderHistory error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// ============================================================
// ITEMS ENDPOINTS
// ============================================================

/**
 * GET /:resId/items
 * Return items and categories for Dyno to fetch
 */
exports.getItems = async (req, res) => {
  try {
    const { resId } = req.params;
    const pool = getPool();

    // Find channel
    const [channels] = await pool.query(
      `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
      [resId]
    );

    if (!channels.length) {
      return res.json({
        getAllItems: false,
        restaurantId: resId,
        items: [],
        categories: []
      });
    }

    const channel = channels[0];

    // Get mapped items
    const [items] = await pool.query(
      `SELECT 
        cmm.external_item_id as id,
        cmm.external_item_name as name,
        cmm.is_available as stockStatus,
        'swiggy' as aggregator
       FROM channel_menu_mapping cmm
       WHERE cmm.channel_id = ?`,
      [channel.id]
    );

    // Get categories (from items table)
    const [categories] = await pool.query(
      `SELECT DISTINCT
        c.id,
        c.name,
        c.is_active as stockStatus,
        ? as aggregator
       FROM categories c
       WHERE c.outlet_id = ? AND c.is_active = 1`,
      [channel.channel_name, channel.outlet_id]
    );

    return res.json({
      getAllItems: false,
      restaurantId: resId,
      items: items.map(i => ({
        id: i.id,
        aggregator: i.aggregator,
        stockStatus: i.stockStatus !== false
      })),
      categories: categories.map(c => ({
        id: String(c.id),
        aggregator: c.aggregator,
        stockStatus: c.stockStatus !== false
      }))
    });

  } catch (error) {
    logger.error('Dyno webhook: getItems error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /:resId/items
 * Receive all items from platform (menu sync)
 */
exports.receiveAllItems = async (req, res) => {
  try {
    const { resId } = req.params;
    const itemsData = req.body;
    const items = itemsData.items || itemsData;
    
    const itemCount = Array.isArray(items) ? items.length : 0;

    logger.info('Dyno webhook: Items received', { resId, itemCount });

    // Find channel
    const pool = getPool();
    const [channels] = await pool.query(
      `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
      [resId]
    );

    if (channels.length && itemCount > 0) {
      const channel = channels[0];
      
      // Batch insert/update items
      for (const item of items) {
        await pool.query(
          `INSERT INTO channel_menu_mapping 
           (channel_id, external_item_id, external_item_name, is_available)
           VALUES (?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE 
           external_item_name = VALUES(external_item_name),
           updated_at = NOW()`,
          [channel.id, item.item_id || item.id, item.name || item.item_name]
        );
      }
    }

    await logWebhook(channels[0]?.id, 'menu_sync', itemsData, { count: itemCount }, 'success');

    return res.json({
      status: 200,
      message: 'Request is Successful'
    });

  } catch (error) {
    logger.error('Dyno webhook: receiveAllItems error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * GET /:resId/items/status
 * Return item stock statuses
 */
exports.getItemsStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    const pool = getPool();

    const [channels] = await pool.query(
      `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
      [resId]
    );

    if (!channels.length) {
      return res.json({
        success: true,
        res_id: resId,
        items: []
      });
    }

    const [items] = await pool.query(
      `SELECT 
        cmm.external_item_id as item_id,
        cmm.external_item_name as name,
        COALESCE(i.is_available, 1) as in_stock
       FROM channel_menu_mapping cmm
       LEFT JOIN items i ON cmm.pos_item_id = i.id
       WHERE cmm.channel_id = ?`,
      [channels[0].id]
    );

    return res.json({
      success: true,
      res_id: resId,
      items: items.map(i => ({
        item_id: i.item_id,
        name: i.name,
        in_stock: i.in_stock !== false && i.in_stock !== 0
      }))
    });

  } catch (error) {
    logger.error('Dyno webhook: getItemsStatus error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /:resId/items/status
 * Receive item stock update confirmations
 * 
 * OPTIMIZED: Uses debounced logging to reduce DB writes
 * Dyno client exe calls this every second - we only log every 30s
 */
exports.updateItemsStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    const { entityId, stockStatus } = req.body;
    
    // Debounced logging - only log to DB every 30 seconds per resId
    const logKey = `${resId}:item_status`;
    const now = Date.now();
    const lastLog = lastLogTime.get(logKey) || 0;
    
    if (now - lastLog > LOG_DEBOUNCE_MS) {
      lastLogTime.set(logKey, now);
      logger.debug('Dyno webhook: Item status update', { resId, entityId, stockStatus });
      // Only log to DB periodically, not every request
      logWebhook(null, 'item_status', req.body, null, 'success').catch(() => {});
    }

    return res.json({
      status: 200,
      message: `Stock for ID ${entityId} Updated Successfully`
    });

  } catch (error) {
    logger.error('Dyno webhook: updateItemsStatus error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /:resId/categories/status
 * Receive category stock update confirmations
 * 
 * OPTIMIZED: Uses debounced logging to reduce DB writes
 * Dyno client exe calls this every second - we only log every 30s
 */
exports.updateCategoriesStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    const { entityId, stockStatus } = req.body;
    
    // Debounced logging - only log to DB every 30 seconds per resId
    const logKey = `${resId}:category_status`;
    const now = Date.now();
    const lastLog = lastLogTime.get(logKey) || 0;
    
    if (now - lastLog > LOG_DEBOUNCE_MS) {
      lastLogTime.set(logKey, now);
      logger.debug('Dyno webhook: Category status update', { resId, entityId, stockStatus });
      // Only log to DB periodically, not every request
      logWebhook(null, 'category_status', req.body, null, 'success').catch(() => {});
    }

    return res.json({
      status: 200,
      message: `Stock for ID ${entityId} Updated Successfully`
    });

  } catch (error) {
    logger.error('Dyno webhook: updateCategoriesStatus error', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Find channel by restaurant ID
 */
async function findChannelByResId(resId) {
  if (!resId) return null;
  
  const pool = getPool();
  const [channels] = await pool.query(
    `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
    [String(resId)]
  );
  return channels[0] || null;
}

/**
 * Process order synchronously (fallback when Redis unavailable)
 */
async function processOrderSync(orderWrapper, channel) {
  const orderId = orderWrapper.orderId || orderWrapper.order_id;
  const vendor = (orderWrapper.vendor || 'swiggy').toLowerCase();
  const orderData = orderWrapper.data || orderWrapper;

  // Normalize order
  const normalizedOrder = normalizeOrderData(orderData, orderId, orderWrapper.resId, vendor, channel);

  // Process via service
  const result = await onlineOrderService.processIncomingOrder(normalizedOrder, channel.id);

  await logWebhook(channel.id, 'order_received', orderWrapper, result, 'success');

  return result;
}

/**
 * Normalize order data from Swiggy/Zomato format
 */
function normalizeOrderData(orderData, orderId, resId, vendor, channel) {
  const customer = orderData.customer || {};
  const address = orderData.delivery_address || orderData.address || {};
  const cart = orderData.cart || {};
  const charges = orderData.charges || orderData.bill_details || {};
  const payment = orderData.payment || {};
  const items = cart.items || orderData.items || [];

  return {
    external_order_id: orderId || orderData.order_id,
    platform: vendor,
    channel_id: channel.id,
    outlet_id: channel.outlet_id,
    
    customer: {
      name: customer.name || customer.customer_name || `${vendor} Customer`,
      phone: customer.phone || customer.mobile || customer.customer_phone,
      address: formatAddress(address),
      instructions: address.instructions || orderData.special_instructions || ''
    },
    
    items: items.map(item => ({
      external_item_id: item.id || item.item_id,
      name: item.name || item.item_name,
      quantity: parseInt(item.quantity) || 1,
      unit_price: parseFloat(item.price || item.unit_price || 0),
      total_price: parseFloat(item.total || item.total_price || 0),
      variant_id: item.variant?.id || item.variant_id,
      variant_name: item.variant?.name || item.variant_name,
      instructions: item.instructions || '',
      addons: (item.addons || item.add_ons || []).map(addon => ({
        external_addon_id: addon.id || addon.addon_id,
        name: addon.name || addon.addon_name,
        price: parseFloat(addon.price || 0)
      }))
    })),
    
    payment: {
      method: normalizePaymentMethod(payment.paymentMethod || payment.payment_method),
      is_paid: payment.isPaid !== false && payment.is_paid !== false,
      subtotal: parseFloat(charges.subtotal || charges.item_total || 0),
      taxes: parseFloat(charges.taxes || charges.gst || 0),
      delivery_charge: parseFloat(charges.deliveryCharge || charges.delivery_charge || 0),
      packaging_charge: parseFloat(charges.packagingCharge || charges.packaging_charge || 0),
      discount: parseFloat(charges.discount || 0),
      total: parseFloat(charges.total || charges.grand_total || orderData.order_total || 0)
    },
    
    timing: {
      placed_at: orderData.order_time || orderData.created_at || new Date().toISOString(),
      expected_delivery: orderData.expected_delivery_time || orderData.delivery_time
    },
    
    raw_data: orderData
  };
}

/**
 * Format address object to string
 */
function formatAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address;
  
  return [
    address.address || address.line1,
    address.landmark,
    address.area || address.locality,
    address.city,
    address.pincode
  ].filter(Boolean).join(', ');
}

/**
 * Normalize payment method
 */
function normalizePaymentMethod(method) {
  if (!method) return 'prepaid';
  const m = method.toLowerCase();
  if (m.includes('cod') || m.includes('cash')) return 'cod';
  if (m.includes('wallet')) return 'wallet';
  return 'prepaid';
}

/**
 * Log webhook to database
 */
async function logWebhook(channelId, logType, requestData, responseData, status, errorMessage = null) {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO integration_logs 
       (channel_id, log_type, direction, request_body, response_body, status, error_message)
       VALUES (?, ?, 'inbound', ?, ?, ?, ?)`,
      [
        channelId,
        logType,
        JSON.stringify(requestData),
        responseData ? JSON.stringify(responseData) : null,
        status,
        errorMessage
      ]
    );
  } catch (error) {
    logger.warn('Failed to log webhook:', error.message);
  }
}

module.exports = exports;
