/**
 * Dyno Webhook Controller
 * 
 * Handles all webhook endpoints that Dyno calls on your server.
 * Based on Dyno Webhook Implementation Documentation v2.0
 */

const onlineOrderService = require('../services/onlineOrder.service');
const dynoService = require('../services/dyno.service');
const { getPool } = require('../database');
const logger = require('../utils/logger');

/**
 * POST /orders
 * Receive new orders from Swiggy/Zomato via Dyno
 * 
 * Dyno Webhook Payload Format:
 * {
 *   "orders": [
 *     {
 *       "data": { ... full Swiggy/Zomato order JSON ... },
 *       "orderId": "string",
 *       "resId": "string",
 *       "status": "NEW | PREPARING | READY | DELIVERED",
 *       "vendor": "Swiggy | Zomato"
 *     }
 *   ]
 * }
 * 
 * Expected Response Format:
 * [
 *   { "status": 200, "orderId": "123", "message": "Order No. 123 Inserted Successfully" }
 * ]
 */
exports.receiveOrder = async (req, res) => {
  const startTime = Date.now();
  const responses = [];
  
  try {
    const payload = req.body;
    
    // Handle Dyno's actual format: { orders: [...] }
    const ordersArray = payload.orders || (Array.isArray(payload) ? payload : [payload]);
    
    logger.info('Dyno webhook: Received orders batch', {
      orderCount: ordersArray.length,
      rawPayload: JSON.stringify(payload).substring(0, 500)
    });

    // Process each order in the batch
    for (const orderWrapper of ordersArray) {
      const orderId = orderWrapper.orderId || orderWrapper.order_id;
      
      try {
        // Extract order details from Dyno wrapper
        const resId = orderWrapper.resId || orderWrapper.res_id;
        const vendor = (orderWrapper.vendor || 'swiggy').toLowerCase();
        const status = orderWrapper.status || 'NEW';
        const orderData = orderWrapper.data || orderWrapper; // Full order JSON is in 'data' field
        
        logger.info('Dyno webhook: Processing order', {
          orderId,
          resId,
          vendor,
          status
        });

        // Skip non-NEW orders (status updates handled separately)
        if (status !== 'NEW' && status !== 'new') {
          logger.info('Dyno webhook: Skipping non-NEW order', { orderId, status });
          responses.push({
            status: 200,
            orderId: orderId,
            message: `Order ${orderId} status update acknowledged (${status})`
          });
          continue;
        }

        // Find channel by resId (Property ID)
        const pool = getPool();
        let channel;
        
        if (resId) {
          const [channels] = await pool.query(
            `SELECT * FROM integration_channels 
             WHERE property_id = ? AND is_active = 1`,
            [resId]
          );
          channel = channels[0];
        }
        
        if (!channel) {
          // Try to find by vendor/platform name
          const [channels] = await pool.query(
            `SELECT * FROM integration_channels 
             WHERE channel_name = ? AND is_active = 1 LIMIT 1`,
            [vendor]
          );
          channel = channels[0];
        }

        if (!channel) {
          logger.warn('No active channel found for order', { orderId, resId, vendor });
          responses.push({
            status: 400,
            orderId: orderId,
            message: `No active integration channel found for resId: ${resId}, vendor: ${vendor}`
          });
          continue;
        }

        // Normalize order data to our internal format
        const normalizedOrder = normalizeSwiggyOrder(orderData, orderId, resId, vendor, channel);
        
        // Process the order
        const result = await onlineOrderService.processIncomingOrder(normalizedOrder, channel.id);

        // Log successful receipt
        await logWebhook(channel.id, 'order_received', 'inbound', orderWrapper, result, 'success');

        logger.info('Dyno webhook: Order processed successfully', {
          orderId,
          onlineOrderId: result.onlineOrderId,
          posOrderNumber: result.orderNumber,
          duration: Date.now() - startTime
        });

        responses.push({
          status: 200,
          orderId: orderId,
          message: `Order No. ${result.orderNumber || result.onlineOrderId} Inserted Successfully`
        });

      } catch (orderError) {
        logger.error('Dyno webhook: Error processing single order', { 
          orderId, 
          error: orderError.message 
        });
        
        // Log failed receipt
        await logWebhook(null, 'order_received', 'inbound', orderWrapper, null, 'failed', orderError.message);

        // Check for duplicate order
        if (orderError.message.includes('duplicate') || orderError.code === 'ER_DUP_ENTRY') {
          responses.push({
            status: 200,
            orderId: orderId,
            message: `Order ${orderId} already exists (duplicate)`
          });
        } else {
          responses.push({
            status: 500,
            orderId: orderId,
            message: `Error: ${orderError.message}`
          });
        }
      }
    }

    // Return array response as expected by Dyno
    return res.status(200).json(responses);

  } catch (error) {
    logger.error('Dyno webhook: Fatal error processing orders batch', { error: error.message });
    
    // Log failed receipt
    await logWebhook(null, 'order_received', 'inbound', req.body, null, 'failed', error.message);

    // Return error in array format
    return res.status(500).json([{
      status: 500,
      orderId: null,
      message: `Fatal error: ${error.message}`
    }]);
  }
};

/**
 * GET /:resId/orders/status
 * Return current order statuses to Dyno
 */
exports.getOrdersStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    
    logger.info('Dyno webhook: Fetching orders status', { resId });

    // Find channel by property_id
    const pool = getPool();
    const [channels] = await pool.query(
      `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
      [resId]
    );

    if (!channels.length) {
      return res.status(404).json({
        success: false,
        error: 'Channel not found'
      });
    }

    const channel = channels[0];

    // Get active orders for this channel
    const [orders] = await pool.query(
      `SELECT 
        oo.external_order_id as order_id,
        oo.platform_order_number,
        oo.pos_status as status,
        oo.accepted_at,
        oo.food_ready_at,
        oo.picked_up_at,
        oo.delivered_at,
        oo.cancelled_at,
        oo.cancel_reason,
        o.order_number as pos_order_number
       FROM online_orders oo
       LEFT JOIN orders o ON oo.pos_order_id = o.id
       WHERE oo.channel_id = ?
       AND oo.created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
       ORDER BY oo.created_at DESC`,
      [channel.id]
    );

    // Map to Dyno expected format
    const statusList = orders.map(order => ({
      order_id: order.order_id,
      platform_order_number: order.platform_order_number,
      status: mapStatusToDyno(order.status),
      pos_order_number: order.pos_order_number,
      timestamps: {
        accepted_at: order.accepted_at,
        ready_at: order.food_ready_at,
        picked_up_at: order.picked_up_at,
        delivered_at: order.delivered_at,
        cancelled_at: order.cancelled_at
      },
      cancel_reason: order.cancel_reason
    }));

    return res.json({
      success: true,
      res_id: resId,
      orders: statusList
    });

  } catch (error) {
    logger.error('Dyno webhook: Error fetching orders status', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /:resId/orders/status
 * Receive status update confirmations from Dyno
 */
exports.updateOrderStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    const { order_id, status, message } = req.body;
    
    logger.info('Dyno webhook: Received status update', { resId, order_id, status });

    // Update local tracking
    const pool = getPool();
    const [result] = await pool.query(
      `UPDATE online_orders 
       SET platform_status = ?, last_status_sync_at = NOW()
       WHERE external_order_id = ?`,
      [status, order_id]
    );

    await logWebhook(null, 'status_update', 'inbound', req.body, { updated: result.affectedRows }, 'success');

    return res.json({
      success: true,
      message: 'Status update received',
      order_id,
      status
    });

  } catch (error) {
    logger.error('Dyno webhook: Error updating order status', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /:resId/orders/history
 * Receive order history data from Dyno
 */
exports.receiveOrderHistory = async (req, res) => {
  try {
    const { resId } = req.params;
    const historyData = req.body;
    
    logger.info('Dyno webhook: Received order history', { 
      resId, 
      orderCount: Array.isArray(historyData.orders) ? historyData.orders.length : 0 
    });

    // Store for reference (can be used for reconciliation)
    await logWebhook(null, 'order_history', 'inbound', historyData, null, 'success');

    return res.json({
      success: true,
      message: 'Order history received',
      count: Array.isArray(historyData.orders) ? historyData.orders.length : 0
    });

  } catch (error) {
    logger.error('Dyno webhook: Error receiving order history', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * GET /:resId/items/status
 * Return current item stock statuses to Dyno
 */
exports.getItemsStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    
    logger.info('Dyno webhook: Fetching items status', { resId });

    // Find channel by property_id
    const pool = getPool();
    const [channels] = await pool.query(
      `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
      [resId]
    );

    if (!channels.length) {
      return res.status(404).json({
        success: false,
        error: 'Channel not found'
      });
    }

    const channel = channels[0];

    // Get items with their stock status from menu mapping
    const [items] = await pool.query(
      `SELECT 
        cmm.external_item_id,
        cmm.external_item_name,
        i.name as pos_item_name,
        i.is_available as item_available,
        cmm.is_available as mapping_available
       FROM channel_menu_mapping cmm
       LEFT JOIN items i ON cmm.pos_item_id = i.id
       WHERE cmm.channel_id = ?`,
      [channel.id]
    );

    const itemsList = items.map(item => ({
      item_id: item.external_item_id,
      name: item.external_item_name || item.pos_item_name,
      in_stock: (item.item_available !== false && item.mapping_available !== false)
    }));

    return res.json({
      success: true,
      res_id: resId,
      items: itemsList
    });

  } catch (error) {
    logger.error('Dyno webhook: Error fetching items status', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /:resId/items/status
 * Receive item stock update confirmations from Dyno
 */
exports.updateItemsStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    const { items } = req.body;
    
    logger.info('Dyno webhook: Received items status update', { 
      resId, 
      itemCount: Array.isArray(items) ? items.length : 0 
    });

    // Log the update
    await logWebhook(null, 'items_status', 'inbound', req.body, null, 'success');

    return res.json({
      success: true,
      message: 'Items status update received',
      count: Array.isArray(items) ? items.length : 0
    });

  } catch (error) {
    logger.error('Dyno webhook: Error updating items status', { error: error.message });
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * POST /:resId/categories/status
 * Receive category stock update confirmations from Dyno
 */
exports.updateCategoriesStatus = async (req, res) => {
  try {
    const { resId } = req.params;
    const { categories } = req.body;
    
    logger.info('Dyno webhook: Received categories status update', { 
      resId, 
      categoryCount: Array.isArray(categories) ? categories.length : 0 
    });

    // Log the update
    await logWebhook(null, 'categories_status', 'inbound', req.body, null, 'success');

    return res.json({
      success: true,
      message: 'Categories status update received',
      count: Array.isArray(categories) ? categories.length : 0
    });

  } catch (error) {
    logger.error('Dyno webhook: Error updating categories status', { error: error.message });
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
    const { items } = req.body;
    
    logger.info('Dyno webhook: Received all items', { 
      resId, 
      itemCount: Array.isArray(items) ? items.length : 0 
    });

    // Find channel
    const pool = getPool();
    const [channels] = await pool.query(
      `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
      [resId]
    );

    if (channels.length && Array.isArray(items)) {
      const channel = channels[0];
      
      // Store items in menu mapping for future reference
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

    await logWebhook(channels[0]?.id, 'menu_sync', 'inbound', req.body, { itemCount: items?.length }, 'success');

    return res.json({
      success: true,
      message: 'Items received and stored',
      count: Array.isArray(items) ? items.length : 0
    });

  } catch (error) {
    logger.error('Dyno webhook: Error receiving items', { error: error.message });
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
 * Normalize Swiggy order data from Dyno webhook to our internal format
 * 
 * Swiggy order structure (inside data field):
 * {
 *   "order_id": "123456789",
 *   "restaurant_id": "489654",
 *   "order_status": "placed",
 *   "order_total": 535,
 *   "customer": { "name": "...", "phone": "...", "address": "..." },
 *   "cart": { "items": [...] },
 *   "payment": { "paymentMethod": "PREPAID", ... },
 *   "charges": { "subtotal": 500, "taxes": 25, ... },
 *   ...
 * }
 */
function normalizeSwiggyOrder(orderData, dynoOrderId, resId, vendor, channel) {
  // Swiggy-specific field extraction
  const order = orderData;
  
  // Extract customer info (Swiggy format)
  const customer = order.customer || order.customerDetails || {};
  const deliveryAddress = order.delivery_address || order.deliveryAddress || customer.address || {};
  
  // Extract items (Swiggy uses 'cart.items' or 'items' or 'order_items')
  const cartItems = order.cart?.items || order.items || order.order_items || [];
  
  // Extract charges (Swiggy format)
  const charges = order.charges || order.bill || {};
  const payment = order.payment || order.paymentDetails || {};
  
  // Build normalized format
  return {
    event: 'order.new',
    timestamp: new Date().toISOString(),
    data: {
      platform: vendor || channel.channel_name,
      external_order_id: order.order_id || order.orderId || dynoOrderId,
      dyno_order_id: dynoOrderId,
      platform_order_number: order.order_number || order.orderNumber || order.order_id,
      res_id: resId,
      
      customer: {
        name: customer.name || customer.customerName || 'Customer',
        phone: customer.phone || customer.mobile || customer.phoneNumber || '',
        address: formatSwiggyAddress(deliveryAddress),
        instructions: order.special_instructions || order.instructions || 
                      deliveryAddress.instructions || customer.instructions || ''
      },
      
      items: normalizeSwiggyItems(cartItems),
      
      payment: {
        method: normalizePaymentMethod(payment.paymentMethod || payment.payment_method || payment.mode || 'prepaid'),
        is_paid: payment.isPaid ?? payment.is_paid ?? 
                 (payment.paymentMethod === 'PREPAID' || payment.payment_method === 'prepaid') ?? true,
        item_total: parseFloat(charges.subtotal || charges.itemTotal || charges.item_total || order.subtotal || 0),
        taxes: parseFloat(charges.taxes || charges.tax || charges.gst || order.taxes || 0),
        delivery_charge: parseFloat(charges.deliveryCharge || charges.delivery_charge || charges.delivery_fee || 0),
        packaging_charge: parseFloat(charges.packagingCharge || charges.packaging_charge || charges.packing_charges || 0),
        discount: parseFloat(charges.discount || charges.totalDiscount || order.discount || 0),
        total: parseFloat(charges.total || charges.grandTotal || order.order_total || order.total || 0)
      },
      
      timing: {
        placed_at: order.order_time || order.orderTime || order.created_at || order.placedAt || new Date().toISOString(),
        expected_delivery: order.expected_delivery_time || order.expectedDeliveryTime || 
                          order.delivery_time || order.sla?.expectedDeliveryTime || null
      },
      
      // Store raw data for debugging
      raw_order_data: order
    }
  };
}

/**
 * Format Swiggy address object to string
 */
function formatSwiggyAddress(address) {
  if (typeof address === 'string') return address;
  if (!address) return '';
  
  const parts = [
    address.address || address.full_address || address.completeAddress,
    address.landmark,
    address.area || address.locality,
    address.city,
    address.pincode || address.zipcode
  ].filter(Boolean);
  
  return parts.join(', ') || JSON.stringify(address);
}

/**
 * Normalize Swiggy items to our internal format
 * 
 * Swiggy item structure:
 * {
 *   "id": "12345",
 *   "name": "Butter Chicken",
 *   "quantity": 2,
 *   "price": 250,
 *   "total": 500,
 *   "variant": { "id": "v1", "name": "Half" },
 *   "addons": [{ "id": "a1", "name": "Extra Gravy", "price": 30 }],
 *   "instructions": "Less spicy"
 * }
 */
function normalizeSwiggyItems(items) {
  return items.map(item => ({
    external_item_id: String(item.id || item.item_id || item.itemId),
    name: item.name || item.item_name || item.itemName,
    variant_id: item.variant?.id || item.variantId || item.variation_id || null,
    variant_name: item.variant?.name || item.variantName || item.variation_name || null,
    quantity: parseInt(item.quantity || item.qty || 1),
    unit_price: parseFloat(item.price || item.unit_price || item.unitPrice || 0),
    total_price: parseFloat(item.total || item.total_price || item.totalPrice || 
                           (item.price * item.quantity) || 0),
    addons: normalizeSwiggyAddons(item.addons || item.add_ons || item.customizations || []),
    instructions: item.instructions || item.special_instructions || item.notes || ''
  }));
}

/**
 * Normalize Swiggy addons
 */
function normalizeSwiggyAddons(addons) {
  return addons.map(addon => ({
    addon_id: String(addon.id || addon.addon_id || addon.addonId),
    name: addon.name || addon.addon_name || addon.addonName,
    price: parseFloat(addon.price || addon.addon_price || addon.addonPrice || 0),
    quantity: parseInt(addon.quantity || addon.qty || 1)
  }));
}

/**
 * Normalize payment method to our enum values
 */
function normalizePaymentMethod(method) {
  if (!method) return 'prepaid';
  const m = method.toLowerCase();
  if (m.includes('cod') || m.includes('cash')) return 'cod';
  if (m.includes('wallet')) return 'wallet';
  return 'prepaid';
}

/**
 * Normalize order data from various Dyno formats to our internal format (legacy)
 */
function normalizeOrderData(rawOrder, channel) {
  // Handle different Dyno order formats
  const order = rawOrder.data || rawOrder;
  
  return {
    event: rawOrder.event || 'order.new',
    timestamp: rawOrder.timestamp || new Date().toISOString(),
    data: {
      platform: channel.channel_name,
      external_order_id: order.order_id || order.external_order_id || order.id,
      dyno_order_id: order.dyno_order_id || order.order_id,
      platform_order_number: order.order_number || order.platform_order_number,
      
      customer: {
        name: order.customer?.name || order.customer_name || 'Customer',
        phone: order.customer?.phone || order.customer_phone || '',
        address: order.customer?.address || order.delivery_address || ''
      },
      
      items: normalizeItems(order.items || order.order_items || []),
      
      payment: {
        method: order.payment?.method || order.payment_method || 'prepaid',
        is_paid: order.payment?.is_paid ?? order.is_paid ?? true,
        item_total: parseFloat(order.payment?.item_total || order.item_total || order.subtotal || 0),
        taxes: parseFloat(order.payment?.taxes || order.taxes || order.tax || 0),
        delivery_charges: parseFloat(order.payment?.delivery_charges || order.delivery_charges || 0),
        packaging_charges: parseFloat(order.payment?.packaging_charges || order.packaging_charges || 0),
        discount: parseFloat(order.payment?.discount || order.discount || 0),
        total: parseFloat(order.payment?.total || order.total_amount || order.total || 0)
      },
      
      timing: {
        placed_at: order.timing?.placed_at || order.order_time || order.created_at,
        expected_delivery: order.timing?.expected_delivery || order.expected_delivery_time
      },
      
      special_instructions: order.special_instructions || order.instructions || order.notes || ''
    }
  };
}

/**
 * Normalize items array
 */
function normalizeItems(items) {
  return items.map(item => ({
    external_item_id: item.external_item_id || item.item_id || item.id,
    name: item.name || item.item_name,
    variant_id: item.variant_id || item.variation_id,
    variant_name: item.variant_name || item.variation_name,
    quantity: parseInt(item.quantity || item.qty || 1),
    unit_price: parseFloat(item.unit_price || item.price || 0),
    total_price: parseFloat(item.total_price || item.total || (item.unit_price * item.quantity) || 0),
    addons: normalizeAddons(item.addons || item.add_ons || []),
    instructions: item.instructions || item.special_instructions || ''
  }));
}

/**
 * Normalize addons array
 */
function normalizeAddons(addons) {
  return addons.map(addon => ({
    addon_id: addon.addon_id || addon.id,
    name: addon.name || addon.addon_name,
    price: parseFloat(addon.price || addon.addon_price || 0),
    quantity: parseInt(addon.quantity || addon.qty || 1)
  }));
}

/**
 * Map POS status to Dyno status
 */
function mapStatusToDyno(posStatus) {
  const statusMap = {
    'received': 'RECEIVED',
    'accepted': 'ACCEPTED',
    'preparing': 'PREPARING',
    'ready': 'READY',
    'picked_up': 'PICKED_UP',
    'delivered': 'DELIVERED',
    'cancelled': 'CANCELLED'
  };
  return statusMap[posStatus] || posStatus?.toUpperCase() || 'RECEIVED';
}

/**
 * Log webhook activity
 */
async function logWebhook(channelId, logType, direction, requestData, responseData, status, errorMessage = null) {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO integration_logs 
       (channel_id, log_type, direction, request_data, response_data, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        channelId,
        logType,
        direction,
        JSON.stringify(requestData),
        responseData ? JSON.stringify(responseData) : null,
        status,
        errorMessage
      ]
    );
  } catch (err) {
    logger.error('Failed to log webhook', { error: err.message });
  }
}
