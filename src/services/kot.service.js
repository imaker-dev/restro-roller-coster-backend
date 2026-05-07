/**
 * KOT/BOT Service
 * Kitchen Order Ticket / Bar Order Ticket - Multi-counter routing
 * Routes items to correct station: Kitchen, Bar, Mocktail, Dessert
 */

const { getPool } = require('../database');
const { cache, publishMessage } = require('../config/redis');
const logger = require('../utils/logger');
const printerService = require('./printer.service');

// Station types for routing
const STATION_TYPES = {
  KITCHEN: 'kitchen',
  BAR: 'bar',
  DESSERT: 'dessert',
  MOCKTAIL: 'mocktail',
  OTHER: 'other'
};

const KOT_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  CANCELLED: 'cancelled'
};

// ========================
// FORMAT HELPERS — clean camelCase output matching table details style
// ========================

function formatKotItem(item) {
  return {
    id: item.id,
    kotId: item.kot_id,
    orderItemId: item.order_item_id,
    name: item.item_name,
    variantName: item.variant_name || null,
    itemType: item.item_type,
    quantity: parseFloat(item.quantity) || 0,
    addonsText: item.addons_text || null,
    specialInstructions: item.special_instructions || null,
    weight: item.weight || null,
    isOpenItem: !!item.is_open_item,
    status: item.status,
    createdAt: item.created_at,
    addons: (item.addons || []).map(a => ({
      name: a.addon_name,
      price: parseFloat(a.unit_price) || 0,
      quantity: a.quantity || 1
    }))
  };
}

function formatKot(kot) {
  if (!kot) return null;
  return {
    id: kot.id,
    outletId: kot.outlet_id,
    orderId: kot.order_id,
    kotNumber: kot.kot_number,
    orderNumber: kot.order_number || null,
    tableId: kot.table_id || null,
    tableNumber: kot.table_number || null,
    tableName: kot.table_name || null,
    station: kot.station,
    stationId: kot.station_id || null,
    status: kot.status,
    priority: kot.priority || 0,
    notes: kot.notes || null,
    itemCount: Number(kot.item_count) || (kot.items ? kot.items.filter(i => i.status !== 'cancelled').length : 0),
    totalItemCount: Number(kot.total_item_count) || (kot.items ? kot.items.length : 0),
    cancelledItemCount: Number(kot.cancelled_item_count) || 0,
    readyCount: Number(kot.ready_count) || 0,
    acceptedBy: kot.accepted_by_name || kot.accepted_by || null,
    acceptedAt: kot.accepted_at || null,
    readyAt: kot.ready_at || null,
    servedAt: kot.served_at || null,
    servedBy: kot.served_by || null,
    cancelledBy: kot.cancelled_by || null,
    cancelledAt: kot.cancelled_at || null,
    cancelReason: kot.cancel_reason || null,
    createdBy: kot.created_by,
    createdByName: kot.created_by_name || null,
    orderSource: kot.order_source || null,
    createdAt: kot.created_at,
    items: (kot.items || []).map(formatKotItem)
  };
}

const kotService = {
  STATION_TYPES,
  KOT_STATUS,

  // ========================
  // KOT NUMBER GENERATION
  // ========================

  async generateKotNumber(outletId, station, stationName = '', isCounter = false) {
    const pool = getPool();
    const today = new Date();
    const datePrefix = today.toISOString().slice(5, 10).replace(/-/g, '');
    
    // Determine BOT vs KOT based on:
    // 1. isCounter (item has counter_id)
    // 2. station type is 'bar'
    // 3. station NAME contains 'bar'
    const stationLower = (station || '').toLowerCase();
    const stationNameLower = (stationName || '').toLowerCase();
    const isBarOrder = isCounter || 
      stationLower === 'bar' || stationLower.includes('bar') ||
      stationNameLower === 'bar' || stationNameLower.includes('bar');
    const prefix = isBarOrder ? 'BOT' : 'KOT';
    
    const [result] = await pool.query(
      `SELECT COUNT(*) + 1 as seq FROM kot_tickets 
       WHERE outlet_id = ? AND station = ? AND DATE(created_at) = CURDATE()`,
      [outletId, station]
    );
    
    const seq = String(result[0].seq).padStart(3, '0');
    return `${prefix}${datePrefix}${seq}`;
  },

  // ========================
  // SEND KOT - MAIN FUNCTION
  // ========================

  /**
   * Send KOT for pending order items
   * Groups items by station and creates separate tickets
   */
  async sendKot(orderId, createdBy) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Get order details with captain/creator name
      const [orders] = await connection.query(
        `SELECT o.*, t.table_number, u.name as created_by_name 
         FROM orders o
         LEFT JOIN tables t ON o.table_id = t.id
         LEFT JOIN users u ON o.created_by = u.id
         WHERE o.id = ?`,
        [orderId]
      );
      if (!orders[0]) throw new Error('Order not found');
      const order = orders[0];

      // Get pending items with station info and item_type for routing
      const [pendingItems] = await connection.query(
        `SELECT oi.*, 
          i.kitchen_station_id, i.counter_id, i.item_type as menu_item_type,
          i.category_id, cat.name as category_name,
          ks.station_type, ks.name as station_name, ks.id as ks_id,
          c.counter_type, c.name as counter_name, c.id as counter_db_id
         FROM order_items oi
         JOIN items i ON oi.item_id = i.id
         LEFT JOIN categories cat ON i.category_id = cat.id
         LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
         LEFT JOIN counters c ON i.counter_id = c.id
         WHERE oi.order_id = ? AND oi.status = 'pending'`,
        [orderId]
      );

      if (pendingItems.length === 0) {
        throw new Error('No pending items to send');
      }

      // Batch-fetch addons for ALL pending items upfront (avoids N+1 per item in station loop)
      const allItemIds = pendingItems.map(i => i.id);
      let addonsMap = {};
      if (allItemIds.length > 0) {
        const [allAddons] = await connection.query(
          'SELECT order_item_id, addon_name, unit_price, quantity FROM order_item_addons WHERE order_item_id IN (?)',
          [allItemIds]
        );
        for (const a of allAddons) {
          if (!addonsMap[a.order_item_id]) addonsMap[a.order_item_id] = [];
          addonsMap[a.order_item_id].push(a);
        }
      }

      // Group items by station (groupKey = station_type:station_id)
      const groupedItems = this.groupItemsByStation(pendingItems);
      const createdTickets = [];

      // Create KOT for each station group
      for (const [groupKey, items] of Object.entries(groupedItems)) {
        // Extract station info from first item (all items in group have same station)
        const firstItem = items[0];
        const station = firstItem?._station || 'kitchen';
        const stationId = firstItem?._stationId || null;
        const stationName = firstItem?._stationName || station;
        const isCounter = firstItem?._isCounter || false;
        
        const kotNumber = await this.generateKotNumber(order.outlet_id, station, stationName, isCounter);

        // Create KOT ticket with station_type and station_id
        const [kotResult] = await connection.query(
          `INSERT INTO kot_tickets (
            outlet_id, order_id, kot_number, table_number,
            station, station_id, status, priority, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [
            order.outlet_id, orderId, kotNumber, order.table_number,
            station, stationId, order.is_priority ? 1 : 0, order.special_instructions, createdBy
          ]
        );
        
        logger.info(`Created KOT ${kotNumber} for station "${stationName}" (type: ${station}, id: ${stationId}), items: ${items.length}`);

        const kotId = kotResult.insertId;

        // Prepare KOT items data + attach addons info
        const kotItemValues = [];
        const itemIdsForUpdate = [];
        for (const item of items) {
          const itemAddons = addonsMap[item.id] || [];
          const addonsText = itemAddons.map(a => a.addon_name).join(', ');
          item._addons = itemAddons;
          item._addonsText = addonsText;
          const itemType = item.item_type || item.menu_item_type || null;
          kotItemValues.push([kotId, item.id, item.item_name, item.variant_name, itemType, item.quantity, addonsText, item.special_instructions, 'pending']);
          itemIdsForUpdate.push(item.id);
        }

        // Batch insert all KOT items + batch update order_items in parallel
        await Promise.all([
          connection.query(
            `INSERT INTO kot_items (
              kot_id, order_item_id, item_name, variant_name, item_type,
              quantity, addons_text, special_instructions, status
            ) VALUES ?`,
            [kotItemValues]
          ),
          connection.query(
            `UPDATE order_items SET status = 'sent_to_kitchen', kot_id = ? WHERE id IN (?)`,
            [kotId, itemIdsForUpdate]
          )
        ]);

        createdTickets.push({
          id: kotId,
          kotNumber,
          station,
          stationId,
          isCounter: firstItem?._isCounter || false,
          stationName: items[0]?._stationName || station,
          tableNumber: order.table_number,
          orderNumber: order.order_number,
          itemCount: items.length,
          createdAt: new Date().toISOString(),
          items: items.map(i => ({
            id: i.id,
            name: i.item_name,
            variant: i.variant_name,
            quantity: i.quantity,
            weight: i.weight || null,
            isOpenItem: !!i.is_open_item,
            itemType: i.item_type || i.menu_item_type || null,
            addons: (i._addons || []).map(a => ({ name: a.addon_name, price: a.unit_price, quantity: a.quantity })),
            addonsText: i._addonsText || null,
            specialInstructions: i.special_instructions || null
          }))
        });
      }

      // Update order status + table status in parallel where applicable
      const statusUpdates = [];
      if (order.status === 'pending') {
        statusUpdates.push(connection.query(
          `UPDATE orders SET status = 'confirmed' WHERE id = ?`,
          [orderId]
        ));
      }
      if (order.table_id && order.order_type === 'dine_in') {
        statusUpdates.push(connection.query(
          `UPDATE tables SET status = 'running' WHERE id = ? AND status IN ('available', 'occupied', 'running')`,
          [order.table_id]
        ));
      }
      if (statusUpdates.length > 0) {
        await Promise.all(statusUpdates);
      }

      await connection.commit();

      // ── Fire-and-forget: ALL post-commit ops run async (don't block response) ──
      const self = this;
      Promise.resolve().then(async () => {
        try {
          // Emit KOT socket events using in-memory data (skip redundant getKotById re-fetches)
          const emissionPromises = createdTickets.map(ticket => {
            const formattedKot = formatKot({
              id: ticket.id,
              outlet_id: order.outlet_id,
              order_id: orderId,
              kot_number: ticket.kotNumber,
              order_number: order.order_number,
              table_id: order.table_id,
              table_number: order.table_number,
              station: ticket.station,
              station_id: ticket.stationId,
              status: 'pending',
              priority: order.is_priority ? 1 : 0,
              created_by: createdBy,
              created_at: ticket.createdAt,
              item_count: ticket.itemCount,
              total_item_count: ticket.itemCount,
              cancelled_item_count: 0,
              ready_count: 0,
              items: ticket.items.map(i => ({
                id: i.id,
                kot_id: ticket.id,
                order_item_id: i.id,
                item_name: i.name,
                variant_name: i.variant,
                item_type: i.itemType,
                quantity: i.quantity,
                weight: i.weight,
                is_open_item: i.isOpenItem ? 1 : 0,
                addons_text: i.addonsText,
                special_instructions: i.specialInstructions,
                status: 'pending',
                created_at: ticket.createdAt,
                addons: i.addons || []
              }))
            });
            return self.emitKotUpdate(order.outlet_id, formattedKot, 'kot:created')
              .catch(err => logger.error(`KOT emit failed ${ticket.kotNumber}:`, err.message));
          });

          // Print KOTs in parallel
          const printPromises = createdTickets.map(ticket => {
            const kotPrintData = {
              outletId: order.outlet_id,
              kotId: ticket.id,
              orderId,
              orderNumber: order.order_number,
              kotNumber: ticket.kotNumber,
              station: ticket.station,
              stationName: ticket.stationName,
              stationId: ticket.stationId,
              isCounter: ticket.isCounter,
              tableNumber: order.table_number,
              time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
              items: ticket.items.map(i => ({
                itemName: i.name,
                variantName: i.variant,
                quantity: i.quantity,
                weight: i.weight || null,
                itemType: i.itemType,
                addonsText: i.addonsText,
                instructions: i.specialInstructions
              })),
              captainName: order.order_source === 'self_order' ? 'SELF ORDER' : (order.created_by_name || 'Staff')
            };
            return printerService.printKot(kotPrintData, createdBy)
              .catch(err => logger.error(`Failed to queue KOT ${ticket.kotNumber}:`, err.message));
          });

          // Table + order update messages
          const msgPromises = [];
          if (order.table_id && order.order_type === 'dine_in') {
            msgPromises.push(publishMessage('table:update', {
              outletId: order.outlet_id,
              tableId: order.table_id,
              floorId: order.floor_id,
              status: 'running',
              event: 'kot_sent',
              timestamp: new Date().toISOString()
            }));
          }
          msgPromises.push(publishMessage('order:update', {
            type: 'order:kot_sent',
            outletId: order.outlet_id,
            orderId,
            tickets: createdTickets,
            timestamp: new Date().toISOString()
          }));

          await Promise.all([...emissionPromises, ...printPromises, ...msgPromises]);
          logger.info(`sendKot post-commit done: ${createdTickets.length} KOTs for order ${order.order_number}`);
        } catch (postErr) {
          logger.error('sendKot post-commit error:', postErr.message);
        }
      });

      return {
        orderId,
        orderNumber: order.order_number,
        tableNumber: order.table_number,
        tickets: createdTickets
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Group items by their target station
   * Priority: 1) counter_id (bar), 2) kitchen_station_id, 3) default to kitchen
   * Groups by station_id (not station_type) to ensure items from different physical stations
   * get separate KOTs even if they share the same station_type.
   * Returns: { 'groupKey': [items], ... } where groupKey = station_type:station_id or station_type for default
   */
  groupItemsByStation(items) {
    const grouped = {};

    for (const item of items) {
      let station = 'kitchen'; // default station type for routing
      let stationId = null;
      let stationName = null;
      let isCounter = false; // Flag to indicate if this is a counter (bar) vs kitchen station
      let groupKey = 'kitchen'; // key for grouping - ensures separate KOTs per physical station

      // Priority 1: Has counter (bar items) - counter_id takes precedence
      if (item.counter_id || item.counter_db_id) {
        // Use counter NAME (lowercased) — matches printer station names reliably
        // counter_type may be misconfigured, but counter names (e.g., "Bar") are always correct
        station = item.counter_name
          ? item.counter_name.toLowerCase().replace(/\s+/g, '_')
          : (item.counter_type || 'bar');
        stationId = item.counter_id || item.counter_db_id;
        stationName = item.counter_name || 'Bar';
        isCounter = true;
        groupKey = `counter:${station}:${stationId}`; // Group by counter ID
        logger.info(`KOT routing: "${item.item_name}" → counter ${station} (id: ${stationId}), groupKey: ${groupKey}`);
      }
      // Priority 2: Has kitchen station - group by station_id for precise routing
      else if (item.kitchen_station_id || item.ks_id) {
        // Use station NAME (lowercased) — matches printer station names reliably
        // station_type may be misconfigured (e.g., all set to 'main_kitchen'),
        // but station names (e.g., "Kitchen", "Bar", "Tandoor") are always correct
        station = item.station_name
          ? item.station_name.toLowerCase().replace(/\s+/g, '_')
          : (item.station_type || 'kitchen');
        stationId = item.kitchen_station_id || item.ks_id;
        stationName = item.station_name || station;
        isCounter = false;
        groupKey = `station:${station}:${stationId}`; // Group by station ID - ensures separate KOTs per physical station
        logger.info(`KOT routing: "${item.item_name}" → station ${station} (id: ${stationId}), groupKey: ${groupKey}`);
      }
      // Priority 3: Default to kitchen - LOG WARNING for debugging
      else {
        groupKey = 'kitchen:default';
        logger.warn(`KOT routing: "${item.item_name}" has NO station config (counter_id: ${item.counter_id}, kitchen_station_id: ${item.kitchen_station_id}), defaulting to kitchen.`);
      }

      // Attach station info to item for later use
      item._station = station;
      item._stationId = stationId;
      item._stationName = stationName || item.station_name || item.counter_name || station;
      item._isCounter = isCounter;
      item._groupKey = groupKey;

      // Group by groupKey (station_type:station_id) for separate KOTs per physical station
      if (!grouped[groupKey]) {
        grouped[groupKey] = [];
      }
      grouped[groupKey].push(item);
    }

    // Log grouping summary
    const stationSummary = Object.entries(grouped).map(([key, items]) => {
      const firstItem = items[0];
      return `${firstItem._stationName || key}(${items.length})`;
    }).join(', ');
    logger.info(`KOT items grouped by station: ${stationSummary} (${Object.keys(grouped).length} groups)`);

    return grouped;
  },

  // ========================
  // KOT STATUS UPDATES
  // ========================

  /**
   * Accept KOT (station acknowledges)
   */
  async acceptKot(kotId, userId) {
    const pool = getPool();

    await pool.query(
      `UPDATE kot_tickets SET 
        status = 'accepted', accepted_by = ?, accepted_at = NOW()
       WHERE id = ?`,
      [userId, kotId]
    );

    const kot = await this.getKotById(kotId);
    if (kot) await this.emitKotUpdate(kot.outletId, kot, 'kot:accepted');

    return kot;
  },

  /**
   * Start preparing KOT
   */
  async startPreparing(kotId, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      await connection.query(
        `UPDATE kot_tickets SET status = 'preparing' WHERE id = ?`,
        [kotId]
      );

      // Update all items to preparing
      await connection.query(
        `UPDATE kot_items SET status = 'preparing' WHERE kot_id = ?`,
        [kotId]
      );

      // Update order items
      await connection.query(
        `UPDATE order_items SET status = 'preparing' WHERE kot_id = ?`,
        [kotId]
      );

      await connection.commit();

      const kot = await this.getKotById(kotId);

      // Update order status
      if (kot) {
        await pool.query(
          `UPDATE orders SET status = 'preparing' WHERE id = ? AND status != 'preparing'`,
          [kot.orderId]
        );
        await this.emitKotUpdate(kot.outletId, kot, 'kot:preparing');
      }

      return kot;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Mark single item as ready
   */
  async markItemReady(kotItemId, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Get KOT item details
      const [kotItems] = await connection.query(
        `SELECT ki.*, kt.outlet_id, kt.order_id 
         FROM kot_items ki
         JOIN kot_tickets kt ON ki.kot_id = kt.id
         WHERE ki.id = ?`,
        [kotItemId]
      );
      if (!kotItems[0]) throw new Error('KOT item not found');

      const kotItem = kotItems[0];

      // Update KOT item
      await connection.query(
        `UPDATE kot_items SET status = 'ready' WHERE id = ?`,
        [kotItemId]
      );

      // Update order item
      await connection.query(
        `UPDATE order_items SET status = 'ready' WHERE id = ?`,
        [kotItem.order_item_id]
      );

      // Check if all items in KOT are ready
      const [pendingItems] = await connection.query(
        `SELECT COUNT(*) as count FROM kot_items 
         WHERE kot_id = ? AND status NOT IN ('ready', 'served', 'cancelled')`,
        [kotItem.kot_id]
      );

      if (pendingItems[0].count === 0) {
        // All items ready - update KOT status
        await connection.query(
          `UPDATE kot_tickets SET status = 'ready', ready_at = NOW() WHERE id = ?`,
          [kotItem.kot_id]
        );
      }

      await connection.commit();

      const kot = await this.getKotById(kotItem.kot_id);
      if (kot) await this.emitKotUpdate(kot.outletId, kot, 'kot:item_ready');

      // Emit to captain/waiter
      await publishMessage('order:update', {
        type: 'order:item_ready',
        outletId: kotItem.outlet_id,
        orderId: kotItem.order_id,
        itemId: kotItem.order_item_id,
        timestamp: new Date().toISOString()
      });

      return kot;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Mark entire KOT as ready
   */
  async markKotReady(kotId, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      await connection.query(
        `UPDATE kot_tickets SET status = 'ready', ready_at = NOW() WHERE id = ?`,
        [kotId]
      );

      await connection.query(
        `UPDATE kot_items SET status = 'ready' WHERE kot_id = ? AND status != 'cancelled'`,
        [kotId]
      );

      // Get order items and update
      const [kotItems] = await connection.query(
        'SELECT order_item_id FROM kot_items WHERE kot_id = ?',
        [kotId]
      );

      for (const item of kotItems) {
        await connection.query(
          `UPDATE order_items SET status = 'ready' WHERE id = ?`,
          [item.order_item_id]
        );
      }

      await connection.commit();

      const kot = await this.getKotById(kotId);
      if (kot) {
        await this.emitKotUpdate(kot.outletId, kot, 'kot:ready');
        await this.checkOrderReadyStatus(kot.orderId);
      }

      return kot;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Mark KOT items as served
   */
  async markKotServed(kotId, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      await connection.query(
        `UPDATE kot_tickets SET 
          status = 'served', served_at = NOW(), served_by = ?
         WHERE id = ?`,
        [userId, kotId]
      );

      await connection.query(
        `UPDATE kot_items SET status = 'served' WHERE kot_id = ? AND status != 'cancelled'`,
        [kotId]
      );

      // Update order items
      const [kotItems] = await connection.query(
        'SELECT order_item_id FROM kot_items WHERE kot_id = ?',
        [kotId]
      );

      for (const item of kotItems) {
        await connection.query(
          `UPDATE order_items SET status = 'served' WHERE id = ?`,
          [item.order_item_id]
        );
      }

      await connection.commit();

      const kot = await this.getKotById(kotId);
      if (kot) {
        await this.emitKotUpdate(kot.outletId, kot, 'kot:served');
        await this.checkOrderServedStatus(kot.orderId);
      }

      return kot;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Check if all items in order are ready
   */
  async checkOrderReadyStatus(orderId) {
    const pool = getPool();

    const [pending] = await pool.query(
      `SELECT COUNT(*) as count FROM order_items 
       WHERE order_id = ? AND status NOT IN ('ready', 'served', 'cancelled')`,
      [orderId]
    );

    if (pending[0].count === 0) {
      await pool.query(
        `UPDATE orders SET status = 'ready' WHERE id = ? AND status NOT IN ('ready', 'served', 'billed', 'paid', 'completed')`,
        [orderId]
      );

      const [order] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      await publishMessage('order:update', {
        type: 'order:all_ready',
        outletId: order[0].outlet_id,
        orderId,
        timestamp: new Date().toISOString()
      });
    }
  },

  /**
   * Check if all items in order are served
   */
  async checkOrderServedStatus(orderId) {
    const pool = getPool();

    const [pending] = await pool.query(
      `SELECT COUNT(*) as count FROM order_items 
       WHERE order_id = ? AND status NOT IN ('served', 'cancelled')`,
      [orderId]
    );

    if (pending[0].count === 0) {
      await pool.query(
        `UPDATE orders SET status = 'served' WHERE id = ? AND status NOT IN ('served', 'billed', 'paid', 'completed')`,
        [orderId]
      );

      const [order] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      await publishMessage('order:update', {
        type: 'order:all_served',
        outletId: order[0].outlet_id,
        orderId,
        timestamp: new Date().toISOString()
      });
    }
  },

  // ========================
  // KOT RETRIEVAL
  // ========================

  async getKotById(id) {
    const pool = getPool();

    // Run KOT ticket + items queries in parallel
    const [[rows], [items]] = await Promise.all([
      pool.query(
        `SELECT kt.*, o.order_number, o.table_id, o.order_source, t.table_number,
                u.name as created_by_name
         FROM kot_tickets kt
         LEFT JOIN orders o ON kt.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         LEFT JOIN users u ON kt.created_by = u.id
         WHERE kt.id = ?`,
        [id]
      ),
      pool.query(
        `SELECT ki.*, oi.weight, oi.is_open_item
         FROM kot_items ki
         LEFT JOIN order_items oi ON ki.order_item_id = oi.id
         WHERE ki.kot_id = ? ORDER BY ki.id`,
        [id]
      )
    ]);

    if (!rows[0]) return null;

    const kot = rows[0];

    // Batch-load addons for all items (avoids N+1)
    const orderItemIds = items.map(i => i.order_item_id).filter(Boolean);
    let addonsMap = {};
    if (orderItemIds.length > 0) {
      const [allAddons] = await pool.query(
        'SELECT order_item_id, addon_name, unit_price, quantity FROM order_item_addons WHERE order_item_id IN (?)',
        [orderItemIds]
      );
      for (const a of allAddons) {
        if (!addonsMap[a.order_item_id]) addonsMap[a.order_item_id] = [];
        addonsMap[a.order_item_id].push(a);
      }
    }
    for (const item of items) {
      item.addons = addonsMap[item.order_item_id] || [];
    }

    kot.items = items;

    return formatKot(kot);
  },

  // Fallback: read KOT via a specific connection (avoids pool visibility lag)
  async _getKotByIdViaConnection(connection, id) {
    const [rows] = await connection.query(
      `SELECT kt.*, o.order_number, o.table_id, t.table_number
       FROM kot_tickets kt
       LEFT JOIN orders o ON kt.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE kt.id = ?`,
      [id]
    );
    if (!rows[0]) return null;
    const kot = rows[0];
    const [items] = await connection.query(
      `SELECT ki.*, oi.weight, oi.is_open_item
       FROM kot_items ki
       LEFT JOIN order_items oi ON ki.order_item_id = oi.id
       WHERE ki.kot_id = ? ORDER BY ki.id`, [id]
    );
    for (const item of items) {
      const [addons] = await connection.query(
        'SELECT addon_name, unit_price, quantity FROM order_item_addons WHERE order_item_id = ?',
        [item.order_item_id]
      );
      item.addons = addons;
    }
    kot.items = items;
    return formatKot(kot);
  },

  /**
   * Get active KOTs for station
   * @param {number} outletId - Outlet ID
   * @param {string} station - Station filter (kitchen, bar, mocktail, dessert)
   * @param {string|string[]} status - Status filter (pending, accepted, preparing, ready) or array of statuses
   * @param {number[]} floorIds - Floor restriction (empty = no restriction)
   */
  async getActiveKots(outletId, station = null, status = null, floorIds = []) {
    const pool = getPool();
    let query = `
      SELECT kt.*, o.order_number, o.table_id,
        t.table_number, t.name as table_name,
        COUNT(CASE WHEN ki.status != 'cancelled' THEN 1 END) as item_count,
        COUNT(ki.id) as total_item_count,
        COUNT(CASE WHEN ki.status = 'cancelled' THEN 1 END) as cancelled_item_count,
        COUNT(CASE WHEN ki.status = 'ready' THEN 1 END) as ready_count
      FROM kot_tickets kt
      JOIN orders o ON kt.order_id = o.id
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN kot_items ki ON ki.kot_id = kt.id
      WHERE kt.outlet_id = ?
    `;
    const params = [outletId];

    // Floor restriction
    if (floorIds && floorIds.length > 0) {
      query += ` AND t.floor_id IN (${floorIds.map(() => '?').join(',')})`;
      params.push(...floorIds);
    }

    // Status filter - if provided, filter by specific status(es), otherwise exclude served/cancelled
    if (status) {
      const statuses = Array.isArray(status) ? status : [status];
      const validStatuses = statuses.filter(s => ['pending', 'accepted', 'preparing', 'ready', 'served', 'cancelled'].includes(s));
      if (validStatuses.length > 0) {
        query += ` AND kt.status IN (${validStatuses.map(() => '?').join(',')})`;
        params.push(...validStatuses);
      }
    } else {
      query += " AND kt.status NOT IN ('served', 'cancelled')";
    }

    // Station filter - supports station_type or station_id
    if (station) {
      // Check if it's a numeric station_id
      if (!isNaN(station) && Number.isInteger(Number(station))) {
        query += ' AND kt.station_id = ?';
        params.push(parseInt(station));
      } else {
        // Handle backward compatibility: 'kitchen' → 'main_kitchen'
        let stationFilter = station;
        if (station === 'kitchen') {
          stationFilter = 'main_kitchen';
        }
        query += ' AND kt.station = ?';
        params.push(stationFilter);
      }
    }

    query += ' GROUP BY kt.id ORDER BY kt.priority DESC, kt.created_at DESC';

    const [kots] = await pool.query(query, params);

    // Batch-load all KOT items and addons (avoids N+1)
    const kotIds = kots.map(k => k.id);
    if (kotIds.length > 0) {
      const [allItems] = await pool.query(
        `SELECT ki.*, oi.weight, oi.is_open_item
         FROM kot_items ki
         LEFT JOIN order_items oi ON ki.order_item_id = oi.id
         WHERE ki.kot_id IN (?) ORDER BY ki.id`,
        [kotIds]
      );
      const allOrderItemIds = allItems.map(i => i.order_item_id).filter(Boolean);
      let addonsMap = {};
      if (allOrderItemIds.length > 0) {
        const [allAddons] = await pool.query(
          'SELECT order_item_id, addon_name, unit_price, quantity FROM order_item_addons WHERE order_item_id IN (?)',
          [allOrderItemIds]
        );
        for (const a of allAddons) {
          if (!addonsMap[a.order_item_id]) addonsMap[a.order_item_id] = [];
          addonsMap[a.order_item_id].push(a);
        }
      }
      for (const item of allItems) {
        item.addons = addonsMap[item.order_item_id] || [];
      }
      for (const kot of kots) {
        kot.items = allItems.filter(i => i.kot_id === kot.id);
      }
    } else {
      for (const kot of kots) { kot.items = []; }
    }

    return kots.map(formatKot);
  },

  /**
   * Get KOTs for order
   */
  async getKotsByOrder(orderId) {
    const pool = getPool();
    const [kots] = await pool.query(
      `SELECT * FROM kot_tickets WHERE order_id = ? ORDER BY created_at`,
      [orderId]
    );

    // Batch-load all KOT items and addons (avoids N+1)
    const kotIds = kots.map(k => k.id);
    if (kotIds.length > 0) {
      const [allItems] = await pool.query(
        `SELECT ki.*, oi.weight, oi.is_open_item
         FROM kot_items ki
         LEFT JOIN order_items oi ON ki.order_item_id = oi.id
         WHERE ki.kot_id IN (?) ORDER BY ki.id`,
        [kotIds]
      );
      const allOrderItemIds = allItems.map(i => i.order_item_id).filter(Boolean);
      let addonsMap = {};
      if (allOrderItemIds.length > 0) {
        const [allAddons] = await pool.query(
          'SELECT order_item_id, addon_name, unit_price, quantity FROM order_item_addons WHERE order_item_id IN (?)',
          [allOrderItemIds]
        );
        for (const a of allAddons) {
          if (!addonsMap[a.order_item_id]) addonsMap[a.order_item_id] = [];
          addonsMap[a.order_item_id].push(a);
        }
      }
      for (const item of allItems) {
        item.addons = addonsMap[item.order_item_id] || [];
      }
      for (const kot of kots) {
        kot.items = allItems.filter(i => i.kot_id === kot.id);
      }
    } else {
      for (const kot of kots) { kot.items = []; }
    }

    return kots.map(formatKot);
  },

  /**
   * Get station dashboard data
   * @param {number} outletId
   * @param {string} station
   * @param {number[]} floorIds - Floor restriction (empty = no restriction)
   */
  async getStationDashboard(outletId, station, floorIds = []) {
    const pool = getPool();

    // Handle backward compatibility: 'kitchen' → 'main_kitchen'
    let stationFilter = station;
    if (station === 'kitchen') {
      stationFilter = 'main_kitchen';
    }

    // Get active KOTs (pass floor restriction)
    const activeKots = await this.getActiveKots(outletId, stationFilter, null, floorIds);

    // Get stats - check if station is numeric (station_id) or string (station_type)
    let statsQuery, statsParams;
    if (!isNaN(station) && Number.isInteger(Number(station))) {
      statsQuery = `SELECT 
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'preparing' THEN 1 END) as preparing_count,
        COUNT(CASE WHEN status = 'ready' THEN 1 END) as ready_count,
        COUNT(*) as total_count,
        AVG(TIMESTAMPDIFF(MINUTE, created_at, COALESCE(ready_at, NOW()))) as avg_prep_time
       FROM kot_tickets
       WHERE outlet_id = ? AND station_id = ? AND DATE(created_at) = CURDATE()`;
      statsParams = [outletId, parseInt(station)];
    } else {
      statsQuery = `SELECT 
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'preparing' THEN 1 END) as preparing_count,
        COUNT(CASE WHEN status = 'ready' THEN 1 END) as ready_count,
        COUNT(*) as total_count,
        AVG(TIMESTAMPDIFF(MINUTE, created_at, COALESCE(ready_at, NOW()))) as avg_prep_time
       FROM kot_tickets
       WHERE outlet_id = ? AND station = ? AND DATE(created_at) = CURDATE()`;
      statsParams = [outletId, stationFilter];
    }
    const [stats] = await pool.query(statsQuery, statsParams);

    return {
      station,
      kots: activeKots,
      stats: stats[0]
    };
  },

  /**
   * Get KOT stats for outlet/station
   */
  async getKotStats(outletId, station = null) {
    const pool = getPool();
    
    let query = `
      SELECT 
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'accepted' THEN 1 END) as accepted_count,
        COUNT(CASE WHEN status = 'preparing' THEN 1 END) as preparing_count,
        COUNT(CASE WHEN status = 'ready' THEN 1 END) as ready_count,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_count,
        COUNT(CASE WHEN status = 'served' THEN 1 END) as served_count,
        COUNT(CASE WHEN status NOT IN ('served', 'cancelled') THEN 1 END) as active_count,
        AVG(CASE WHEN status = 'ready' THEN TIMESTAMPDIFF(MINUTE, created_at, ready_at) END) as avg_prep_time
       FROM kot_tickets
       WHERE outlet_id = ? AND DATE(created_at) = CURDATE()
    `;
    const params = [outletId];
    
    if (station) {
      // Check if it's a numeric station_id
      if (!isNaN(station) && Number.isInteger(Number(station))) {
        query += ' AND station_id = ?';
        params.push(parseInt(station));
      } else {
        // Handle backward compatibility: 'kitchen' → 'main_kitchen'
        let stationFilter = station;
        if (station === 'kitchen') {
          stationFilter = 'main_kitchen';
        }
        query += ' AND station = ?';
        params.push(stationFilter);
      }
    }
    
    const [stats] = await pool.query(query, params);
    return stats[0];
  },

  // ========================
  // REALTIME EVENTS
  // ========================

  async emitKotUpdate(outletId, kot, eventType) {
    try {
      const payload = {
        type: eventType,
        outletId,
        station: kot.station,
        stationId: kot.stationId || null,
        kot,
        timestamp: new Date().toISOString()
      };
      
      logger.info(`[KOT Socket] Emitting ${eventType} - outlet: ${outletId}, station: ${kot.station}, stationId: ${kot.stationId}, kotNumber: ${kot.kotNumber || kot.id}`);
      
      await publishMessage('kot:update', payload);
      
      logger.info(`[KOT Socket] Successfully emitted ${eventType} for KOT ${kot.kotNumber || kot.id}`);
    } catch (error) {
      logger.error(`[KOT Socket] Failed to emit ${eventType} for KOT ${kot.kotNumber || kot.id}:`, error.message);
      logger.error(`[KOT Socket] Stack:`, error.stack);
    }
  },

  // ========================
  // REPRINT / DUPLICATE
  // ========================

  async reprintKot(kotId, userId) {
    const pool = getPool();

    // Get KOT details
    const kot = await this.getKotById(kotId);
    if (!kot) throw new Error('KOT not found');

    // Update reprint count
    await pool.query(
      `UPDATE kot_tickets SET 
        printed_count = printed_count + 1, last_printed_at = NOW()
       WHERE id = ?`,
      [kotId]
    );

    // Get updated KOT with new printed_count
    const updatedKot = await this.getKotById(kotId);

    // Print the KOT via printerService (handles multi-printer)
    try {
      const kotPrintData = {
        outletId: kot.outletId,
        kotId: kot.id,
        orderId: kot.orderId,
        orderNumber: kot.orderNumber,
        kotNumber: `${kot.kotNumber} [REPRINT]`,
        station: kot.station,
        stationName: kot.stationName || kot.station,
        stationId: kot.stationId || null,
        isCounter: false,
        tableNumber: kot.tableNumber,
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        items: (kot.items || []).map(i => ({
          itemName: i.name,
          variantName: i.variantName,
          quantity: i.quantity,
          weight: i.weight || null,
          itemType: i.itemType,
          addonsText: i.addonsText,
          instructions: i.specialInstructions
        })),
        captainName: kot.orderSource === 'self_order' ? 'SELF ORDER' : (kot.createdByName || 'Staff')
      };
      await printerService.printKot(kotPrintData, userId);
      logger.info(`KOT ${kot.kotNumber} reprinted to all station printers`);
    } catch (printError) {
      logger.error(`Failed to print KOT reprint: ${printError.message}`);
    }

    // Emit reprint event to kitchen for real-time update
    await this.emitKotUpdate(kot.outletId, {
      ...updatedKot,
      reprintedBy: userId,
      reprintCount: updatedKot.printedCount
    }, 'kot:reprinted');

    return updatedKot;
  },

  // ========================
  // PRINTER HELPERS
  // ========================

  /**
   * Get printer configuration for a station
   * Priority:
   * 1a. Kitchen station's assigned printer (via kitchen_stations.printer_id)
   * 1b. Counter's assigned printer (via counters.printer_id) for bar items
   * 2. Printer with matching station type from any station with printer
   * 3. Printer.station column (kot_kitchen, kot_bar, etc.)
   * 4. Any active KOT printer for the outlet
   * 
   * @param {number} outletId - Outlet ID
   * @param {string} station - Station type (main_kitchen, bar, tandoor, dessert, etc.)
   * @param {number} stationId - Optional specific kitchen_station ID or counter ID
   * @param {boolean} isCounter - Whether stationId refers to a counter (default false)
   */
  async getPrinterForStation(outletId, station, stationId = null, isCounter = false) {
    const pool = getPool();
    
    // Priority 1a: If stationId provided and it's a counter, get printer from counters table
    if (stationId && isCounter) {
      const [counterPrinters] = await pool.query(
        `SELECT p.* FROM printers p
         JOIN counters c ON c.printer_id = p.id
         WHERE c.id = ? AND c.outlet_id = ? AND p.is_active = 1
         LIMIT 1`,
        [stationId, outletId]
      );
      if (counterPrinters[0]) {
        logger.info(`Printer found via counter ${stationId}: ${counterPrinters[0].name}`);
        return counterPrinters[0];
      }
    }
    
    // Priority 1b: If stationId provided, get printer from kitchen_stations table
    if (stationId && !isCounter) {
      const [stationPrinters] = await pool.query(
        `SELECT p.* FROM printers p
         JOIN kitchen_stations ks ON ks.printer_id = p.id
         WHERE ks.id = ? AND ks.outlet_id = ? AND p.is_active = 1
         LIMIT 1`,
        [stationId, outletId]
      );
      if (stationPrinters[0]) {
        logger.info(`Printer found via kitchen_station ${stationId}: ${stationPrinters[0].name}`);
        return stationPrinters[0];
      }
    }

    // Priority 2a: Find printer by station_type matching from kitchen_stations
    const stationTypeMap = {
      'kitchen': ['main_kitchen', 'wok', 'tandoor', 'grill'],
      'main_kitchen': ['main_kitchen'],
      'tandoor': ['tandoor'],
      'wok': ['wok'],
      'grill': ['grill'],
      'bar': ['bar', 'main_bar'],
      'main_bar': ['main_bar', 'bar'],
      'dessert': ['dessert'],
      'mocktail': ['mocktail', 'beverage']
    };
    const matchingTypes = stationTypeMap[station] || [station];
    
    const [typePrinters] = await pool.query(
      `SELECT p.* FROM printers p
       JOIN kitchen_stations ks ON ks.printer_id = p.id
       WHERE ks.outlet_id = ? AND ks.station_type IN (?) AND p.is_active = 1 AND ks.is_active = 1
       ORDER BY ks.display_order LIMIT 1`,
      [outletId, matchingTypes]
    );
    if (typePrinters[0]) {
      logger.info(`Printer found via kitchen station_type ${station}: ${typePrinters[0].name}`);
      return typePrinters[0];
    }

    // Priority 2b: Find printer by counter_type matching from counters
    const counterTypeMap = {
      'bar': ['main_bar', 'bar'],
      'main_bar': ['main_bar', 'bar'],
      'mocktail': ['mocktail', 'beverage'],
      'live_counter': ['live_counter']
    };
    const matchingCounterTypes = counterTypeMap[station] || [];
    
    if (matchingCounterTypes.length > 0) {
      const [counterTypePrinters] = await pool.query(
        `SELECT p.* FROM printers p
         JOIN counters c ON c.printer_id = p.id
         WHERE c.outlet_id = ? AND c.counter_type IN (?) AND p.is_active = 1 AND c.is_active = 1
         ORDER BY c.display_order LIMIT 1`,
        [outletId, matchingCounterTypes]
      );
      if (counterTypePrinters[0]) {
        logger.info(`Printer found via counter_type ${station}: ${counterTypePrinters[0].name}`);
        return counterTypePrinters[0];
      }
    }
    
    // Priority 3: Map station to printer.station column (kot_kitchen, kot_bar, etc.)
    const printerStationMap = {
      'kitchen': 'kot_kitchen',
      'main_kitchen': 'kot_kitchen',
      'tandoor': 'kot_kitchen',
      'wok': 'kot_kitchen',
      'grill': 'kot_kitchen',
      'bar': 'kot_bar',
      'main_bar': 'kot_bar',
      'dessert': 'kot_dessert',
      'mocktail': 'kot_kitchen'
    };
    const printerStation = printerStationMap[station] || 'kot_kitchen';
    
    let [printers] = await pool.query(
      `SELECT * FROM printers 
       WHERE outlet_id = ? AND station = ? AND is_active = 1
       LIMIT 1`,
      [outletId, printerStation]
    );

    if (printers[0]) {
      logger.info(`Printer found via printer.station=${printerStation}: ${printers[0].name}`);
      return printers[0];
    }

    // Priority 4: Fall back to any active KOT printer for this outlet
    [printers] = await pool.query(
      `SELECT * FROM printers 
       WHERE outlet_id = ? AND (station LIKE 'kot_%' OR printer_type = 'kot') AND is_active = 1
       ORDER BY id LIMIT 1`,
      [outletId]
    );

    if (printers[0]) {
      logger.info(`Printer fallback to any KOT printer: ${printers[0].name}`);
    } else {
      logger.warn(`No printer found for station ${station} (id: ${stationId}) in outlet ${outletId}`);
    }

    return printers[0] || null;
  }
};

module.exports = kotService;
