/**
 * Dyno Webhook Queue Processor
 * 
 * Handles async processing of incoming Dyno webhook orders.
 * Pattern: Webhook → Queue (Redis) → Worker → DB
 * 
 * Job Types:
 * - process-order: Process a new order from Swiggy/Zomato
 * - sync-status: Sync order status back to platform
 * - process-history: Process order history batch
 */

const { getPool } = require('../../database');
const onlineOrderService = require('../../services/onlineOrder.service');
const logger = require('../../utils/logger');

/**
 * Main processor function for Dyno webhook jobs
 */
const dynoWebhookProcessor = async (job) => {
  const { name, data } = job;
  const startTime = Date.now();

  logger.info(`Processing Dyno webhook job: ${name}`, { jobId: job.id });

  try {
    switch (name) {
      case 'process-order':
        return await processOrder(data);

      case 'process-order-batch':
        return await processOrderBatch(data);

      case 'sync-status':
        return await syncOrderStatus(data);

      case 'process-history':
        return await processOrderHistory(data);

      default:
        logger.warn(`Unknown Dyno webhook job type: ${name}`);
        return { success: false, error: `Unknown job type: ${name}` };
    }
  } catch (error) {
    logger.error(`Dyno webhook job failed: ${name}`, {
      jobId: job.id,
      error: error.message,
      duration: Date.now() - startTime
    });
    throw error; // Re-throw for retry mechanism
  }
};

/**
 * Process a single order from Dyno webhook
 */
async function processOrder(data) {
  const { orderWrapper, channel, receivedAt } = data;
  const orderId = orderWrapper.orderId || orderWrapper.order_id;
  const startTime = Date.now();

  try {
    const vendor = (orderWrapper.vendor || 'swiggy').toLowerCase();
    const status = orderWrapper.status || 'NEW';
    const orderData = orderWrapper.data || orderWrapper;

    // Skip non-NEW orders
    if (status.toUpperCase() !== 'NEW') {
      logger.info('Dyno processor: Skipping non-NEW order', { orderId, status });
      return {
        success: true,
        orderId,
        skipped: true,
        reason: `Status is ${status}, not NEW`
      };
    }

    // Normalize order data based on vendor
    const normalizedOrder = normalizeOrderData(orderData, orderId, orderWrapper.resId, vendor, channel);

    // Process the order (creates online_order + POS order)
    const result = await onlineOrderService.processIncomingOrder(normalizedOrder, channel.id);

    // Log success
    await logWebhookResult(channel.id, 'order_processed', orderWrapper, result, 'success');

    logger.info('Dyno processor: Order processed successfully', {
      orderId,
      onlineOrderId: result.onlineOrderId,
      posOrderNumber: result.orderNumber,
      queueLatency: startTime - new Date(receivedAt).getTime(),
      processingTime: Date.now() - startTime
    });

    return {
      success: true,
      orderId,
      onlineOrderId: result.onlineOrderId,
      orderNumber: result.orderNumber,
      posOrderId: result.posOrderId
    };

  } catch (error) {
    // Log failure
    await logWebhookResult(null, 'order_processed', data.orderWrapper, null, 'failed', error.message);

    // Check for duplicate
    if (error.message.includes('duplicate') || error.code === 'ER_DUP_ENTRY') {
      return {
        success: true,
        orderId,
        duplicate: true,
        message: `Order ${orderId} already exists`
      };
    }

    throw error;
  }
}

/**
 * Process a batch of orders (for bulk webhook calls)
 */
async function processOrderBatch(data) {
  const { orders, channel, receivedAt } = data;
  const results = [];

  for (const orderWrapper of orders) {
    try {
      const result = await processOrder({ orderWrapper, channel, receivedAt });
      results.push({
        orderId: orderWrapper.orderId || orderWrapper.order_id,
        ...result
      });
    } catch (error) {
      results.push({
        orderId: orderWrapper.orderId || orderWrapper.order_id,
        success: false,
        error: error.message
      });
    }
  }

  return { success: true, results };
}

/**
 * Sync order status back to platform via Dyno
 */
async function syncOrderStatus(data) {
  const { onlineOrderId, newStatus, channelId } = data;
  
  // This would call Dyno API to update status on Swiggy/Zomato
  // Implementation depends on Dyno's outbound API
  logger.info('Dyno processor: Status sync requested', { onlineOrderId, newStatus });
  
  return { success: true, synced: true };
}

/**
 * Process order history batch
 */
async function processOrderHistory(data) {
  const { orders, channelId, resId } = data;
  
  logger.info('Dyno processor: Processing order history', {
    orderCount: orders?.length || 0,
    resId
  });

  // Store for reconciliation purposes
  await logWebhookResult(channelId, 'order_history', { orders, resId }, null, 'success');

  return {
    success: true,
    processed: orders?.length || 0
  };
}

/**
 * Normalize order data from Swiggy/Zomato format to internal format
 */
function normalizeOrderData(orderData, orderId, resId, vendor, channel) {
  if (vendor === 'swiggy') {
    return normalizeSwiggyOrder(orderData, orderId, resId, channel);
  } else if (vendor === 'zomato') {
    return normalizeZomatoOrder(orderData, orderId, resId, channel);
  }
  
  // Generic fallback
  return {
    external_order_id: orderId,
    platform: vendor,
    channel_id: channel.id,
    outlet_id: channel.outlet_id,
    customer: orderData.customer || {},
    items: orderData.items || orderData.cart?.items || [],
    payment: orderData.payment || {},
    charges: orderData.charges || {},
    raw_data: orderData
  };
}

/**
 * Normalize Swiggy order format
 */
function normalizeSwiggyOrder(orderData, orderId, resId, channel) {
  const customer = orderData.customer || {};
  const address = orderData.delivery_address || orderData.address || {};
  const cart = orderData.cart || {};
  const charges = orderData.charges || orderData.bill_details || {};
  const payment = orderData.payment || {};

  return {
    external_order_id: orderId || orderData.order_id,
    platform: 'swiggy',
    channel_id: channel.id,
    outlet_id: channel.outlet_id,
    
    customer: {
      name: customer.name || customer.customer_name || 'Swiggy Customer',
      phone: customer.phone || customer.mobile || customer.customer_phone,
      address: formatAddress(address),
      instructions: address.instructions || orderData.special_instructions || ''
    },
    
    items: normalizeItems(cart.items || orderData.items || [], 'swiggy'),
    
    payment: {
      method: normalizePaymentMethod(payment.paymentMethod || payment.payment_method || 'prepaid'),
      is_paid: payment.isPaid !== false && payment.is_paid !== false,
      subtotal: parseFloat(charges.subtotal || charges.item_total || 0),
      taxes: parseFloat(charges.taxes || charges.gst || 0),
      delivery_charge: parseFloat(charges.deliveryCharge || charges.delivery_charge || 0),
      packaging_charge: parseFloat(charges.packagingCharge || charges.packaging_charge || 0),
      discount: parseFloat(charges.discount || charges.total_discount || 0),
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
 * Normalize Zomato order format
 */
function normalizeZomatoOrder(orderData, orderId, resId, channel) {
  const customer = orderData.customer || orderData.delivery || {};
  const address = orderData.delivery_address || orderData.address || customer.address || {};
  const items = orderData.items || orderData.order_items || [];
  const charges = orderData.order_total_details || orderData.charges || {};
  const payment = orderData.payment || {};

  return {
    external_order_id: orderId || orderData.order_id || orderData.id,
    platform: 'zomato',
    channel_id: channel.id,
    outlet_id: channel.outlet_id,
    
    customer: {
      name: customer.name || customer.customer_name || 'Zomato Customer',
      phone: customer.phone || customer.mobile,
      address: typeof address === 'string' ? address : formatAddress(address),
      instructions: orderData.instructions || orderData.special_instructions || ''
    },
    
    items: normalizeItems(items, 'zomato'),
    
    payment: {
      method: normalizePaymentMethod(payment.payment_method || payment.type || 'prepaid'),
      is_paid: payment.is_paid !== false,
      subtotal: parseFloat(charges.subtotal || charges.item_total || 0),
      taxes: parseFloat(charges.taxes || charges.tax || 0),
      delivery_charge: parseFloat(charges.delivery_charge || 0),
      packaging_charge: parseFloat(charges.packing_charge || charges.packaging_charge || 0),
      discount: parseFloat(charges.discount || 0),
      total: parseFloat(charges.total || charges.order_total || orderData.total || 0)
    },
    
    timing: {
      placed_at: orderData.created_at || orderData.order_time || new Date().toISOString(),
      expected_delivery: orderData.delivery_time || orderData.expected_time
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
  
  const parts = [
    address.address || address.line1 || address.address_line_1,
    address.landmark,
    address.area || address.locality,
    address.city,
    address.pincode || address.postal_code
  ].filter(Boolean);
  
  return parts.join(', ');
}

/**
 * Normalize items array
 */
function normalizeItems(items, vendor) {
  if (!Array.isArray(items)) return [];
  
  return items.map(item => ({
    external_item_id: item.id || item.item_id || item.external_id,
    name: item.name || item.item_name,
    quantity: parseInt(item.quantity) || 1,
    unit_price: parseFloat(item.price || item.unit_price || 0),
    total_price: parseFloat(item.total || item.total_price || item.price * item.quantity || 0),
    variant_id: item.variant?.id || item.variant_id,
    variant_name: item.variant?.name || item.variant_name,
    instructions: item.instructions || item.special_instructions || '',
    addons: normalizeAddons(item.addons || item.add_ons || [])
  }));
}

/**
 * Normalize addons array
 */
function normalizeAddons(addons) {
  if (!Array.isArray(addons)) return [];
  
  return addons.map(addon => ({
    external_addon_id: addon.id || addon.addon_id,
    name: addon.name || addon.addon_name,
    price: parseFloat(addon.price || 0),
    quantity: parseInt(addon.quantity) || 1
  }));
}

/**
 * Normalize payment method to enum
 */
function normalizePaymentMethod(method) {
  if (!method) return 'prepaid';
  
  const methodLower = method.toLowerCase();
  
  if (methodLower.includes('cod') || methodLower.includes('cash')) {
    return 'cod';
  }
  if (methodLower.includes('wallet')) {
    return 'wallet';
  }
  return 'prepaid';
}

/**
 * Log webhook processing result
 */
async function logWebhookResult(channelId, logType, requestData, responseData, status, errorMessage = null) {
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
    logger.warn('Failed to log webhook result:', error.message);
  }
}

module.exports = dynoWebhookProcessor;
