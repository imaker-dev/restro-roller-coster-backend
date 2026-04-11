/**
 * Online Order Service
 * Handles processing of Swiggy/Zomato orders received via Dyno APIs
 * Creates POS orders, generates KOTs, syncs status back to platforms
 */

const { getPool } = require('../database');
const { publishMessage } = require('../config/redis');
const logger = require('../utils/logger');
const orderService = require('./order.service');
const kotService = require('./kot.service');
const dynoService = require('./dyno.service');

/**
 * Business day starts at this hour (IST). Orders before this hour belong to the previous business day.
 */
const BUSINESS_DAY_START_HOUR = 4;

/**
 * Convert business-day date strings to actual datetime range for index-friendly WHERE.
 */
function businessDayRange(startDate, endDate) {
  const h = String(BUSINESS_DAY_START_HOUR).padStart(2, '0') + ':00:00';
  const startDt = `${startDate} ${h}`;
  const ed = new Date(endDate + 'T00:00:00');
  ed.setDate(ed.getDate() + 1);
  const endStr = ed.getFullYear() + '-' + String(ed.getMonth() + 1).padStart(2, '0') + '-' + String(ed.getDate()).padStart(2, '0');
  const endDt = `${endStr} ${h}`;
  return { startDt, endDt };
}

// Online order status enum
const ONLINE_ORDER_STATUS = {
  RECEIVED: 'received',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  PREPARING: 'preparing',
  READY: 'ready',
  PICKED_UP: 'picked_up',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled'
};

const onlineOrderService = {
  ONLINE_ORDER_STATUS,

  // ========================
  // ORDER PROCESSING
  // ========================

  /**
   * Process incoming webhook order from Dyno
   * Main entry point for new online orders
   */
  async processIncomingOrder(webhookPayload, channelId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const { data, event } = webhookPayload;
      const platform = data.platform?.toLowerCase();
      const externalOrderId = data.external_order_id;

      // Get channel details
      const channel = await dynoService.getChannelById(channelId);
      if (!channel) {
        throw new Error(`Channel ${channelId} not found`);
      }

      // Check for duplicate order
      const [existing] = await connection.query(
        'SELECT id FROM online_orders WHERE channel_id = ? AND external_order_id = ?',
        [channelId, externalOrderId]
      );

      if (existing.length > 0) {
        logger.warn(`Duplicate order received: ${externalOrderId}`, { channelId });
        await connection.rollback();
        return { duplicate: true, onlineOrderId: existing[0].id };
      }

      // Create online_orders record
      const onlineOrderId = await this.createOnlineOrderRecord(connection, {
        outletId: channel.outlet_id,
        channelId,
        platform,
        externalOrderId,
        dynoOrderId: data.dyno_order_id,
        platformOrderNumber: data.platform_order_number || externalOrderId,
        customer: data.customer,
        payment: data.payment,
        timing: data.timing,
        rawData: webhookPayload
      });

      // Map external items to POS items
      const mappedItems = await this.mapExternalItems(connection, channelId, data.items);

      // Get system user for online orders
      const systemUserId = await this.getSystemUserId(connection);

      // Create POS order
      const posOrder = await this.createPosOrder(connection, {
        outletId: channel.outlet_id,
        onlineOrderId,
        externalOrderId,
        platform,
        customer: data.customer,
        items: mappedItems,
        payment: data.payment,
        systemUserId
      });

      // Link POS order to online order
      await connection.query(
        'UPDATE online_orders SET pos_order_id = ? WHERE id = ?',
        [posOrder.id, onlineOrderId]
      );

      await connection.commit();

      // Post-commit actions (outside transaction)
      
      // Auto-accept if configured
      if (channel.auto_accept_orders) {
        await this.acceptOrder(onlineOrderId);
      }

      // Auto-generate KOT if configured
      if (channel.auto_print_kot && posOrder.id) {
        try {
          await kotService.sendKot(posOrder.id, systemUserId);
          logger.info(`Auto-generated KOT for online order: ${externalOrderId}`);
        } catch (kotError) {
          logger.error(`Failed to auto-generate KOT for ${externalOrderId}:`, kotError.message);
        }
      }

      // Emit real-time event
      await this.emitOnlineOrderEvent(channel.outlet_id, {
        type: 'online_order:new',
        onlineOrderId,
        posOrderId: posOrder.id,
        platform,
        externalOrderId,
        customer: data.customer,
        itemCount: mappedItems.length,
        totalAmount: data.payment?.total || 0
      });

      // Log success
      await dynoService.logRequest({
        outletId: channel.outlet_id,
        channelId,
        onlineOrderId,
        logType: 'order_created',
        direction: 'inbound',
        endpoint: '/webhook',
        method: 'POST',
        requestBody: webhookPayload
      });

      return {
        success: true,
        onlineOrderId,
        posOrderId: posOrder.id,
        orderNumber: posOrder.order_number
      };

    } catch (error) {
      await connection.rollback();
      logger.error('Failed to process online order:', error);
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Create online_orders record
   */
  async createOnlineOrderRecord(connection, data) {
    const {
      outletId, channelId, platform, externalOrderId, dynoOrderId,
      platformOrderNumber, customer, payment, timing, rawData
    } = data;

    const [result] = await connection.query(
      `INSERT INTO online_orders (
        outlet_id, channel_id, external_order_id, dyno_order_id,
        platform, platform_order_number,
        customer_name, customer_phone, customer_address, customer_instructions,
        order_type, payment_method, is_paid,
        item_total, platform_discount, delivery_charge, packaging_charge, taxes, total_amount,
        order_placed_at, estimated_delivery_at,
        platform_status, pos_status, raw_order_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
      [
        outletId, channelId, externalOrderId, dynoOrderId,
        platform, platformOrderNumber,
        customer?.name, customer?.phone, customer?.address, customer?.instructions,
        'delivery', payment?.method || 'prepaid', payment?.is_paid || false,
        payment?.item_total || 0, payment?.discount || 0, payment?.delivery_charge || 0,
        payment?.packaging_charge || 0, payment?.taxes || 0, payment?.total || 0,
        timing?.placed_at ? new Date(timing.placed_at) : new Date(),
        timing?.expected_delivery ? new Date(timing.expected_delivery) : null,
        'NEW', JSON.stringify(rawData)
      ]
    );

    return result.insertId;
  },

  /**
   * Map external items to POS items using channel_menu_mapping
   */
  async mapExternalItems(connection, channelId, externalItems) {
    const mappedItems = [];

    for (const extItem of externalItems) {
      // Try to find mapping
      const [mappings] = await connection.query(
        `SELECT cmm.*, i.name as pos_item_name, i.base_price, i.kitchen_station_id, i.counter_id
         FROM channel_menu_mapping cmm
         LEFT JOIN items i ON cmm.pos_item_id = i.id
         WHERE cmm.channel_id = ? AND cmm.external_item_id = ?
         AND (cmm.external_variant_id IS NULL OR cmm.external_variant_id = ?)`,
        [channelId, extItem.external_item_id, extItem.variant_id || null]
      );

      const mapping = mappings[0];

      if (mapping && mapping.pos_item_id) {
        // Mapped item found
        mappedItems.push({
          itemId: mapping.pos_item_id,
          variantId: mapping.pos_variant_id || null,
          itemName: mapping.pos_item_name || extItem.name,
          quantity: extItem.quantity,
          unitPrice: extItem.unit_price,
          totalPrice: extItem.total_price,
          specialInstructions: extItem.instructions,
          addons: await this.mapAddons(connection, channelId, extItem.addons || []),
          isMapped: true
        });
      } else {
        // Unmapped item - use external data and flag for review
        logger.warn(`Unmapped item in order: ${extItem.name} (${extItem.external_item_id})`);
        
        // Create mapping record for future
        await connection.query(
          `INSERT IGNORE INTO channel_menu_mapping (
            channel_id, external_item_id, external_item_name,
            external_variant_id, external_variant_name, is_mapped
          ) VALUES (?, ?, ?, ?, ?, 0)`,
          [channelId, extItem.external_item_id, extItem.name, extItem.variant_id, extItem.variant_name]
        );

        mappedItems.push({
          itemId: null,
          variantId: null,
          itemName: extItem.name,
          variantName: extItem.variant_name,
          quantity: extItem.quantity,
          unitPrice: extItem.unit_price,
          totalPrice: extItem.total_price,
          specialInstructions: extItem.instructions,
          addons: extItem.addons || [],
          isMapped: false,
          externalItemId: extItem.external_item_id
        });
      }
    }

    return mappedItems;
  },

  /**
   * Map addons from external to POS
   */
  async mapAddons(connection, channelId, externalAddons) {
    const mappedAddons = [];

    for (const extAddon of externalAddons) {
      const [mappings] = await connection.query(
        `SELECT pos_addon_id FROM channel_menu_mapping 
         WHERE channel_id = ? AND external_addon_id = ? AND is_mapped = 1`,
        [channelId, extAddon.addon_id]
      );

      if (mappings[0]?.pos_addon_id) {
        mappedAddons.push({
          addonId: mappings[0].pos_addon_id,
          name: extAddon.name,
          price: extAddon.price,
          isMapped: true
        });
      } else {
        mappedAddons.push({
          addonId: null,
          name: extAddon.name,
          price: extAddon.price,
          isMapped: false
        });
      }
    }

    return mappedAddons;
  },

  /**
   * Create POS order from online order data
   */
  async createPosOrder(connection, data) {
    const {
      outletId, onlineOrderId, externalOrderId, platform,
      customer, items, payment, systemUserId
    } = data;

    // Generate order number
    const orderNumber = await orderService.generateOrderNumber(outletId, connection);

    // Create order
    const [orderResult] = await connection.query(
      `INSERT INTO orders (
        uuid, outlet_id, order_number, order_type, source,
        external_order_id, online_order_id,
        customer_name, customer_phone,
        status, payment_status, created_by
      ) VALUES (UUID(), ?, ?, 'delivery', ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        outletId, orderNumber, platform,
        externalOrderId, onlineOrderId,
        customer?.name, customer?.phone,
        payment?.is_paid ? 'completed' : 'pending', systemUserId
      ]
    );

    const orderId = orderResult.insertId;

    // Add order items
    let subtotal = 0;
    let taxAmount = 0;

    for (const item of items) {
      if (item.itemId) {
        // Mapped item - use POS item
        const itemTotal = item.unitPrice * item.quantity;
        subtotal += itemTotal;

        await connection.query(
          `INSERT INTO order_items (
            order_id, item_id, variant_id, item_name, variant_name,
            quantity, unit_price, base_price, total_price,
            special_instructions, status, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [
            orderId, item.itemId, item.variantId,
            item.itemName, item.variantName || null,
            item.quantity, item.unitPrice, item.unitPrice, itemTotal,
            item.specialInstructions, systemUserId
          ]
        );
      } else {
        // Unmapped item - use placeholder item
        const itemTotal = item.unitPrice * item.quantity;
        subtotal += itemTotal;

        // Get or create placeholder item for unmapped online order items
        const placeholderItemId = await this.getPlaceholderItemId(connection, outletId);

        await connection.query(
          `INSERT INTO order_items (
            order_id, item_id, item_name, variant_name,
            quantity, unit_price, base_price, total_price,
            special_instructions, status, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [
            orderId, placeholderItemId, item.itemName, item.variantName,
            item.quantity, item.unitPrice, item.unitPrice, itemTotal,
            `[UNMAPPED: ${item.externalItemId}] ${item.specialInstructions || ''}`,
            systemUserId
          ]
        );
      }
    }

    // Update order totals
    const total = payment?.total || subtotal;
    const paidAmount = payment?.is_paid ? total : 0;

    await connection.query(
      `UPDATE orders SET 
        subtotal = ?, tax_amount = ?, total_amount = ?,
        paid_amount = ?, due_amount = ?,
        delivery_charge = ?, packaging_charge = ?, discount_amount = ?
      WHERE id = ?`,
      [
        subtotal, payment?.taxes || 0, total,
        paidAmount, total - paidAmount,
        payment?.delivery_charge || 0, payment?.packaging_charge || 0,
        payment?.discount || 0, orderId
      ]
    );

    // Return order details
    const [orders] = await connection.query(
      'SELECT * FROM orders WHERE id = ?',
      [orderId]
    );

    return orders[0];
  },

  /**
   * Get or create placeholder item for unmapped online order items
   */
  async getPlaceholderItemId(connection, outletId) {
    // Check if placeholder exists
    const [existing] = await connection.query(
      "SELECT id FROM items WHERE name = 'Online Order Item' LIMIT 1"
    );

    if (existing.length > 0) {
      return existing[0].id;
    }

    // Get first category
    const [cats] = await connection.query('SELECT id FROM categories LIMIT 1');
    const catId = cats[0]?.id || 1;

    // Create placeholder item
    const [result] = await connection.query(
      `INSERT INTO items (outlet_id, category_id, name, base_price, is_active) 
       VALUES (?, ?, 'Online Order Item', 0, 1)`,
      [outletId, catId]
    );

    return result.insertId;
  },

  /**
   * Get system user ID for online orders
   */
  async getSystemUserId(connection) {
    const [users] = await connection.query(
      "SELECT id FROM users WHERE email = 'system.online@restropos.local' AND is_active = 1 LIMIT 1"
    );

    if (users[0]) {
      return users[0].id;
    }

    // Fallback: get first admin user
    const [admins] = await connection.query(
      `SELECT u.id FROM users u
       JOIN user_roles ur ON u.id = ur.user_id
       JOIN roles r ON ur.role_id = r.id
       WHERE r.slug = 'admin' AND u.is_active = 1 LIMIT 1`
    );

    return admins[0]?.id || 1;
  },

  // ========================
  // ORDER STATUS MANAGEMENT
  // ========================

  /**
   * Accept online order
   */
  async acceptOrder(onlineOrderId, prepTime = null) {
    const order = await this.getOnlineOrderById(onlineOrderId);
    if (!order) throw new Error('Online order not found');

    const channel = await dynoService.getChannelById(order.channel_id);
    const actualPrepTime = prepTime || channel?.default_prep_time || 20;

    // Update local status
    await this.updateOnlineOrderStatus(onlineOrderId, 'accepted');

    // Update POS order status
    if (order.pos_order_id) {
      const pool = getPool();
      await pool.query(
        "UPDATE orders SET status = 'confirmed' WHERE id = ?",
        [order.pos_order_id]
      );
    }

    // Sync to Dyno
    try {
      await dynoService.acceptOrder(order.channel_id, order.external_order_id, actualPrepTime);
    } catch (err) {
      logger.error(`Failed to sync accept to Dyno: ${order.external_order_id}`, err.message);
    }

    // Emit event
    await this.emitOnlineOrderEvent(order.outlet_id, {
      type: 'online_order:accepted',
      onlineOrderId,
      posOrderId: order.pos_order_id,
      prepTime: actualPrepTime
    });

    return { success: true, prepTime: actualPrepTime };
  },

  /**
   * Reject online order
   */
  async rejectOrder(onlineOrderId, reason) {
    const order = await this.getOnlineOrderById(onlineOrderId);
    if (!order) throw new Error('Online order not found');

    // Update local status
    await this.updateOnlineOrderStatus(onlineOrderId, 'rejected', {
      cancel_reason: reason,
      cancelled_by: 'restaurant',
      cancelled_at: new Date()
    });

    // Cancel POS order
    if (order.pos_order_id) {
      const pool = getPool();
      await pool.query(
        "UPDATE orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?",
        [reason, order.pos_order_id]
      );
    }

    // Sync to Dyno
    try {
      await dynoService.rejectOrder(order.channel_id, order.external_order_id, reason);
    } catch (err) {
      logger.error(`Failed to sync reject to Dyno: ${order.external_order_id}`, err.message);
    }

    return { success: true };
  },

  /**
   * Mark order as ready for pickup
   */
  async markReady(onlineOrderId) {
    const order = await this.getOnlineOrderById(onlineOrderId);
    if (!order) throw new Error('Online order not found');

    // Update local status
    await this.updateOnlineOrderStatus(onlineOrderId, 'ready', {
      food_ready_at: new Date()
    });

    // Update POS order
    if (order.pos_order_id) {
      const pool = getPool();
      await pool.query(
        "UPDATE orders SET status = 'ready' WHERE id = ?",
        [order.pos_order_id]
      );
    }

    // Sync to Dyno
    try {
      await dynoService.markOrderReady(order.channel_id, order.external_order_id);
    } catch (err) {
      logger.error(`Failed to sync ready to Dyno: ${order.external_order_id}`, err.message);
    }

    // Emit event
    await this.emitOnlineOrderEvent(order.outlet_id, {
      type: 'online_order:ready',
      onlineOrderId,
      posOrderId: order.pos_order_id
    });

    return { success: true };
  },

  /**
   * Mark order as dispatched/picked up
   */
  async markDispatched(onlineOrderId) {
    const order = await this.getOnlineOrderById(onlineOrderId);
    if (!order) throw new Error('Online order not found');

    // Update local status
    await this.updateOnlineOrderStatus(onlineOrderId, 'picked_up', {
      picked_up_at: new Date()
    });

    // Update POS order
    if (order.pos_order_id) {
      const pool = getPool();
      await pool.query(
        "UPDATE orders SET status = 'served' WHERE id = ?",
        [order.pos_order_id]
      );
    }

    // Sync to Dyno
    try {
      await dynoService.markOrderDispatched(order.channel_id, order.external_order_id);
    } catch (err) {
      logger.error(`Failed to sync dispatch to Dyno: ${order.external_order_id}`, err.message);
    }

    return { success: true };
  },

  // ========================
  // QUERIES
  // ========================

  /**
   * Get online order by ID
   */
  async getOnlineOrderById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT oo.*, ic.channel_display_name, ic.dyno_access_token
       FROM online_orders oo
       JOIN integration_channels ic ON oo.channel_id = ic.id
       WHERE oo.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  /**
   * Get active online orders for outlet
   */
  async getActiveOrders(outletId) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT oo.*, ic.channel_display_name, o.order_number as pos_order_number
       FROM online_orders oo
       JOIN integration_channels ic ON oo.channel_id = ic.id
       LEFT JOIN orders o ON oo.pos_order_id = o.id
       WHERE oo.outlet_id = ? 
       AND oo.pos_status NOT IN ('delivered', 'cancelled')
       ORDER BY oo.created_at DESC`,
      [outletId]
    );
    return rows;
  },

  /**
   * Get online orders with filters
   */
  async getOrders(filters = {}) {
    const pool = getPool();
    const { outletId, platform, status, startDate, endDate, limit = 50 } = filters;

    let query = `
      SELECT oo.*, ic.channel_display_name, o.order_number as pos_order_number
      FROM online_orders oo
      JOIN integration_channels ic ON oo.channel_id = ic.id
      LEFT JOIN orders o ON oo.pos_order_id = o.id
      WHERE 1=1
    `;
    const params = [];

    if (outletId) {
      query += ' AND oo.outlet_id = ?';
      params.push(outletId);
    }
    if (platform) {
      query += ' AND oo.platform = ?';
      params.push(platform);
    }
    if (status) {
      query += ' AND oo.pos_status = ?';
      params.push(status);
    }
    // Date range filter (business hours: 4am to 4am)
    if (startDate && endDate) {
      const { startDt, endDt } = businessDayRange(startDate, endDate);
      query += ' AND oo.created_at >= ? AND oo.created_at < ?';
      params.push(startDt, endDt);
    } else if (startDate) {
      const { startDt } = businessDayRange(startDate, startDate);
      query += ' AND oo.created_at >= ?';
      params.push(startDt);
    } else if (endDate) {
      const { endDt } = businessDayRange(endDate, endDate);
      query += ' AND oo.created_at < ?';
      params.push(endDt);
    }

    query += ' ORDER BY oo.created_at DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(query, params);
    return rows;
  },

  /**
   * Update online order status
   */
  async updateOnlineOrderStatus(onlineOrderId, status, additionalFields = {}) {
    const pool = getPool();
    
    let query = 'UPDATE online_orders SET pos_status = ?, last_status_sync_at = NOW()';
    const params = [status];

    // Add additional fields
    for (const [key, value] of Object.entries(additionalFields)) {
      query += `, ${key} = ?`;
      params.push(value);
    }

    query += ' WHERE id = ?';
    params.push(onlineOrderId);

    await pool.query(query, params);
  },

  // ========================
  // REAL-TIME EVENTS
  // ========================

  /**
   * Emit online order event via Redis pub/sub
   */
  async emitOnlineOrderEvent(outletId, eventData) {
    try {
      await publishMessage('online_order:update', {
        outletId,
        ...eventData,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      logger.error('Failed to emit online order event:', err.message);
    }
  },

  // ========================
  // HANDLE PLATFORM CALLBACKS
  // ========================

  /**
   * Handle order cancellation from platform
   */
  async handlePlatformCancel(externalOrderId, channelId, reason, cancelledBy = 'platform') {
    const pool = getPool();

    // Find the online order
    const [orders] = await pool.query(
      'SELECT * FROM online_orders WHERE channel_id = ? AND external_order_id = ?',
      [channelId, externalOrderId]
    );

    if (!orders[0]) {
      logger.warn(`Cancel received for unknown order: ${externalOrderId}`);
      return { success: false, reason: 'Order not found' };
    }

    const order = orders[0];

    // Update online order
    await this.updateOnlineOrderStatus(order.id, 'cancelled', {
      cancel_reason: reason,
      cancelled_by: cancelledBy,
      cancelled_at: new Date()
    });

    // Cancel POS order
    if (order.pos_order_id) {
      await pool.query(
        "UPDATE orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?",
        [`Platform cancelled: ${reason}`, order.pos_order_id]
      );

      // Cancel associated KOTs
      await pool.query(
        "UPDATE kot_tickets SET status = 'cancelled', cancel_reason = ? WHERE order_id = ?",
        [`Platform cancelled: ${reason}`, order.pos_order_id]
      );
    }

    // Emit event
    await this.emitOnlineOrderEvent(order.outlet_id, {
      type: 'online_order:cancelled',
      onlineOrderId: order.id,
      posOrderId: order.pos_order_id,
      reason,
      cancelledBy
    });

    return { success: true };
  }
};

module.exports = onlineOrderService;
