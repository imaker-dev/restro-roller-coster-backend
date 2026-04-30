/**
 * Self-Order Service
 * Core business logic for QR table ordering system.
 * Handles session management, menu retrieval, order placement, and accept/reject flows.
 * Designed for rush-hour scalability: minimal DB round-trips, aggressive caching, batched writes.
 */

const crypto = require('crypto');
const { getPool } = require('../database');
const { cache, publishMessage } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { SELF_ORDER } = require('../constants');
const settingsService = require('./settings.service');
const menuEngineService = require('./menuEngine.service');

/**
 * Generate a cryptographically secure session token (URL-safe, 48 bytes → 64 hex chars)
 */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

const BUSINESS_DAY_START_HOUR = 4;

/**
 * Convert YYYY-MM-DD date strings to a business-day datetime range (4am to 4am).
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

/**
 * Resolve the self-order system user ID (cached after first lookup).
 * Falls back to 0 if user doesn't exist.
 */
let _selfOrderUserId = null;
async function getSelfOrderUserId() {
  if (_selfOrderUserId !== null) return _selfOrderUserId;
  try {
    const pool = getPool();
    const [[user]] = await pool.query(
      `SELECT id FROM users WHERE email = ? AND is_active = 1 LIMIT 1`,
      [SELF_ORDER.SYSTEM_USER_EMAIL]
    );
    _selfOrderUserId = user ? user.id : 0;
  } catch (err) {
    logger.warn('Failed to resolve self-order user:', err.message);
    _selfOrderUserId = 0;
  }
  return _selfOrderUserId;
}

const selfOrderService = {

  // ========================
  // SETTINGS HELPERS (cached)
  // ========================

  /**
   * Get all self-order settings for an outlet (batch read, cached 60s)
   */
  async getSettings(outletId) {
    const cacheKey = `self_order:settings:${outletId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const keys = Object.values(SELF_ORDER.SETTINGS_KEYS);
    const settings = {};
    for (const key of keys) {
      const setting = await settingsService.get(key, outletId);
      settings[key] = setting ? setting.value : null;
    }

    // Apply defaults for any missing keys
    const result = {
      enabled: settings[SELF_ORDER.SETTINGS_KEYS.ENABLED] === true || settings[SELF_ORDER.SETTINGS_KEYS.ENABLED] === 'true',
      acceptMode: settings[SELF_ORDER.SETTINGS_KEYS.ACCEPT_MODE] || SELF_ORDER.ACCEPT_MODE.MANUAL,
      sessionTimeoutMinutes: parseInt(settings[SELF_ORDER.SETTINGS_KEYS.SESSION_TIMEOUT], 10) || SELF_ORDER.SESSION_TTL_MINUTES,
      requirePhone: settings[SELF_ORDER.SETTINGS_KEYS.REQUIRE_PHONE] !== false && settings[SELF_ORDER.SETTINGS_KEYS.REQUIRE_PHONE] !== 'false',
      requireName: settings[SELF_ORDER.SETTINGS_KEYS.REQUIRE_NAME] !== false && settings[SELF_ORDER.SETTINGS_KEYS.REQUIRE_NAME] !== 'false',
      maxSessionsPerTable: parseInt(settings[SELF_ORDER.SETTINGS_KEYS.MAX_SESSIONS_PER_TABLE], 10) || 1,
      allowReorder: settings[SELF_ORDER.SETTINGS_KEYS.ALLOW_REORDER] !== false && settings[SELF_ORDER.SETTINGS_KEYS.ALLOW_REORDER] !== 'false',
      // Smart session expiry settings
      idleTimeoutMinutes: parseInt(settings[SELF_ORDER.SETTINGS_KEYS.IDLE_TIMEOUT], 10) || 10,          // Default: 10 min
      completionBufferMinutes: parseInt(settings[SELF_ORDER.SETTINGS_KEYS.COMPLETION_BUFFER], 10) || 1, // Default: 1 min
    };

    await cache.set(cacheKey, result, 60);
    return result;
  },

  /**
   * Update self-order settings for an outlet
   * @param {number} outletId
   * @param {object} updates - { enabled, acceptMode, sessionTimeoutMinutes, requirePhone, requireName, maxSessionsPerTable, allowReorder }
   */
  async updateSettings(outletId, updates) {
    const pool = getPool();

    // Validate outlet exists
    const [[outlet]] = await pool.query('SELECT id FROM outlets WHERE id = ? AND is_active = 1', [outletId]);
    if (!outlet) throw new Error('Outlet not found');

    // Map camelCase keys to setting_key names
    const keyMap = {
      enabled: SELF_ORDER.SETTINGS_KEYS.ENABLED,
      acceptMode: SELF_ORDER.SETTINGS_KEYS.ACCEPT_MODE,
      sessionTimeoutMinutes: SELF_ORDER.SETTINGS_KEYS.SESSION_TIMEOUT,
      requirePhone: SELF_ORDER.SETTINGS_KEYS.REQUIRE_PHONE,
      requireName: SELF_ORDER.SETTINGS_KEYS.REQUIRE_NAME,
      maxSessionsPerTable: SELF_ORDER.SETTINGS_KEYS.MAX_SESSIONS_PER_TABLE,
      allowReorder: SELF_ORDER.SETTINGS_KEYS.ALLOW_REORDER,
      idleTimeoutMinutes: SELF_ORDER.SETTINGS_KEYS.IDLE_TIMEOUT,
      completionBufferMinutes: SELF_ORDER.SETTINGS_KEYS.COMPLETION_BUFFER,
    };

    // Validate acceptMode if provided
    if (updates.acceptMode !== undefined) {
      const validModes = Object.values(SELF_ORDER.ACCEPT_MODE);
      if (!validModes.includes(updates.acceptMode)) {
        throw new Error(`Invalid acceptMode. Must be one of: ${validModes.join(', ')}`);
      }
    }

    // Validate timeout values if provided
    if (updates.idleTimeoutMinutes !== undefined && (updates.idleTimeoutMinutes < 1 || updates.idleTimeoutMinutes > 120)) {
      throw new Error('idleTimeoutMinutes must be between 1 and 120');
    }
    if (updates.completionBufferMinutes !== undefined && (updates.completionBufferMinutes < 1 || updates.completionBufferMinutes > 60)) {
      throw new Error('completionBufferMinutes must be between 1 and 60');
    }

    // Update each provided setting
    const updatedKeys = [];
    for (const [camelKey, value] of Object.entries(updates)) {
      const settingKey = keyMap[camelKey];
      if (!settingKey) continue; // Skip unknown keys

      // Determine type
      let settingType = 'string';
      if (typeof value === 'boolean' || camelKey === 'enabled' || camelKey === 'requirePhone' || camelKey === 'requireName' || camelKey === 'allowReorder') {
        settingType = 'boolean';
      } else if (typeof value === 'number' || camelKey === 'sessionTimeoutMinutes' || camelKey === 'maxSessionsPerTable' || camelKey === 'idleTimeoutMinutes' || camelKey === 'completionBufferMinutes') {
        settingType = 'number';
      }

      const stringValue = String(value);

      // Upsert setting
      await pool.query(
        `INSERT INTO system_settings (outlet_id, setting_key, setting_value, setting_type, is_editable, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, NOW(), NOW())
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), setting_type = VALUES(setting_type), updated_at = NOW()`,
        [outletId, settingKey, stringValue, settingType]
      );
      updatedKeys.push(camelKey);
    }

    // Clear cache so next read gets fresh data
    const cacheKey = `self_order:settings:${outletId}`;
    await cache.del(cacheKey);

    // Return updated settings
    return this.getSettings(outletId);
  },

  // ========================
  // SESSION MANAGEMENT
  // ========================

  /**
   * Initialize a self-order session from QR scan.
   * Validates outlet, table, and enforces session limits.
   */
  async initSession({ outletId, tableId, qrToken, deviceId, ipAddress, userAgent }) {
    const pool = getPool();

    // Non-blocking cleanup — expiry is also enforced in the SELECT below
    this.expireIdleSessions(outletId, tableId).catch(() => {});

    // Parallel: outlet + table + settings + sessions(+joins) + active shift + active order on table
    const [outletResult, tableResult, settingsResult, activeSessionsResult, activeShiftResult, activeOrderResult] = await Promise.all([
      pool.query('SELECT id, name, is_active FROM outlets WHERE id = ? AND is_active = 1', [outletId]),
      pool.query(
        `SELECT t.id, t.table_number, t.name, t.status, t.floor_id, t.is_active,
                t.qr_token, f.name as floor_name
         FROM tables t
         LEFT JOIN floors f ON t.floor_id = f.id
         WHERE t.id = ? AND t.outlet_id = ?`,
        [tableId, outletId]
      ),
      this.getSettings(outletId),
      pool.query(
        `SELECT s.id, s.token, s.status, s.order_id, s.device_id, s.outlet_id, s.table_id,
                s.customer_name, s.customer_phone, s.expires_at,
                t.table_number, t.name as table_name, f.name as floor_name, o.name as outlet_name
         FROM self_order_sessions s
         JOIN tables t ON s.table_id = t.id
         JOIN outlets o ON s.outlet_id = o.id
         LEFT JOIN floors f ON t.floor_id = f.id
         WHERE s.outlet_id = ? AND s.table_id = ? AND s.status IN ('active', 'ordering') AND s.expires_at > NOW()
         ORDER BY s.created_at DESC`,
        [outletId, tableId]
      ),
      pool.query(
        `SELECT id FROM day_sessions WHERE outlet_id = ? AND status = 'open' LIMIT 1`,
        [outletId]
      ),
      pool.query(
        `SELECT o.id, o.order_number, o.order_source, o.self_order_session_id, o.status
         FROM orders o
         WHERE o.table_id = ? AND o.outlet_id = ?
           AND o.status NOT IN ('paid', 'completed', 'cancelled')
         ORDER BY o.created_at DESC LIMIT 1`,
        [tableId, outletId]
      ),
    ]);

    const outlet = outletResult[0][0];
    const table = tableResult[0][0];
    const settings = settingsResult;
    const activeSessions = activeSessionsResult[0];
    const activeShift = activeShiftResult[0][0];
    const activeOrderOnTable = activeOrderResult[0][0];

    // Validations
    if (!outlet) throw new Error('Outlet not found or inactive');
    if (!table) throw new Error('Table not found');
    if (!table.is_active) throw new Error('Table is not active');
    if (!settings.enabled) throw new Error('Self-ordering is not enabled for this outlet');
    if (!activeShift) throw new Error('Restaurant is currently closed. Please try again during business hours.');

    // QR codes are static/permanent — no token validation needed.
    // The QR only encodes outletId + tableId. Session lifecycle is managed separately.

    if (activeOrderOnTable) {
      // Block: bill already generated — no new items or sessions allowed until payment
      if (activeOrderOnTable.status === 'billed') {
        throw new Error('Your bill has been generated. Please complete payment before placing new orders.');
      }

      // Case 3: Staff/POS order running → block self-order with specific message
      if (activeOrderOnTable.order_source !== 'self_order') {
        throw new Error('This table is currently managed by staff. Please ask your server for assistance.');
      }

      // Case 1 & 2: Self-order running → try to resume the existing session
      if (activeOrderOnTable.self_order_session_id) {
        const existingSession = activeSessions.find(
          s => s.id === activeOrderOnTable.self_order_session_id
        );
        if (existingSession) {
          // ═══════════════════════════════════════════════════════════════
          // DEVICE-BASED SESSION CONTROL
          // ═══════════════════════════════════════════════════════════════
          // Check if this is the same device or a different device
          if (existingSession.device_id && existingSession.device_id !== deviceId) {
            // DIFFERENT DEVICE → Block access
            // Log the blocked attempt (fire-and-forget)
            this._logActivity(existingSession.id, outletId, tableId, 'device_blocked', null, ipAddress, {
              blockedDeviceId: deviceId,
              originalDeviceId: existingSession.device_id
            }).catch(() => {});
            
            throw new Error('This table is currently being used on another device. Please use the original device or wait until the order is completed.');
          }

          // SAME DEVICE (or no device_id set yet) → Allow resume
          // Update device_id non-blocking (future same-device validation only)
          if (!existingSession.device_id && deviceId) {
            pool.query(
              `UPDATE self_order_sessions SET device_id = ? WHERE id = ?`,
              [deviceId, existingSession.id]
            ).catch(() => {});
          }

          return { ...this._formatSession(existingSession, settings), resumed: true };
        }
      }

      // Self-order exists but session expired or missing — table is in use
      throw new Error('This table is currently in use. Please wait until the current order is completed.');
    }

    // Check session limits per table
    if (settings.maxSessionsPerTable > 0 && activeSessions.length >= settings.maxSessionsPerTable) {
      // If there's an active session with an existing order AND reorder is allowed, check device
      const existingWithOrder = activeSessions.find(s => s.order_id && s.status === 'ordering');
      if (existingWithOrder && settings.allowReorder) {
        // ═══════════════════════════════════════════════════════════════
        // DEVICE CHECK FOR REORDER
        // ═══════════════════════════════════════════════════════════════
        if (existingWithOrder.device_id && existingWithOrder.device_id !== deviceId) {
          // Different device trying to access existing session
          this._logActivity(existingWithOrder.id, outletId, tableId, 'device_blocked', null, ipAddress, {
            blockedDeviceId: deviceId,
            originalDeviceId: existingWithOrder.device_id
          }).catch(() => {});
          
          throw new Error('This table is currently being used on another device. Please use the original device or wait until the order is completed.');
        }

        // Same device or no device_id → allow
        if (!existingWithOrder.device_id && deviceId) {
          pool.query(
            `UPDATE self_order_sessions SET device_id = ? WHERE id = ?`,
            [deviceId, existingWithOrder.id]
          ).catch(() => {});
        }

        return { ...this._formatSession(existingWithOrder, settings), resumed: true };
      }

      // If there's an active session without order, check device
      const freshSession = activeSessions.find(s => !s.order_id && s.status === 'active');
      if (freshSession) {
        // ═══════════════════════════════════════════════════════════════
        // DEVICE CHECK FOR FRESH SESSION
        // ═══════════════════════════════════════════════════════════════
        if (freshSession.device_id && freshSession.device_id !== deviceId) {
          this._logActivity(freshSession.id, outletId, tableId, 'device_blocked', null, ipAddress, {
            blockedDeviceId: deviceId,
            originalDeviceId: freshSession.device_id
          }).catch(() => {});
          
          throw new Error('This table is currently being used on another device. Please use the original device or wait until the order is completed.');
        }

        // Same device or no device_id → allow
        if (!freshSession.device_id && deviceId) {
          pool.query(
            `UPDATE self_order_sessions SET device_id = ? WHERE id = ?`,
            [deviceId, freshSession.id]
          ).catch(() => {});
        }

        return { ...this._formatSession(freshSession, settings), resumed: true };
      }

      throw new Error('Maximum active sessions reached for this table. Please wait or ask staff for help.');
    }

    // Create new session — use DB NOW() + INTERVAL to avoid JS/DB timezone mismatch
    const token = generateSessionToken();
    const timeoutMinutes = settings.sessionTimeoutMinutes || 120;
    const idleTimeout = settings.idleTimeoutMinutes || 10;
    const completionBuffer = settings.completionBufferMinutes || 1;

    const [result] = await pool.query(
      `INSERT INTO self_order_sessions (token, outlet_id, table_id, floor_id, device_id, ip_address, user_agent, idle_timeout_minutes, completion_buffer_minutes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW() + INTERVAL ? MINUTE)`,
      [token, outletId, tableId, table.floor_id, deviceId, ipAddress, userAgent, idleTimeout, completionBuffer, timeoutMinutes]
    );

    // Fetch the DB-generated expires_at
    const [[newSession]] = await pool.query(
      `SELECT expires_at FROM self_order_sessions WHERE id = ?`,
      [result.insertId]
    );

    // Log session init (fire-and-forget)
    this._logActivity(result.insertId, outletId, tableId, 'session_init', null, ipAddress).catch(() => {});

    return {
      token,
      sessionId: result.insertId,
      outlet: { id: outletId, name: outlet.name },
      table: {
        id: tableId,
        number: table.table_number,
        name: table.name,
        floorName: table.floor_name,
      },
      expiresAt: newSession.expires_at,
      settings: {
        requirePhone: settings.requirePhone,
        requireName: settings.requireName,
        acceptMode: settings.acceptMode,
        allowReorder: settings.allowReorder,
      },
    };
  },

  /**
   * Update customer details on an active session
   */
  async updateCustomerDetails(sessionId, { customerName, customerPhone }) {
    const pool = getPool();
    await pool.query(
      `UPDATE self_order_sessions SET customer_name = ?, customer_phone = ?, updated_at = NOW()
       WHERE id = ? AND status IN ('active', 'ordering')`,
      [customerName, customerPhone, sessionId]
    );
    return { updated: true };
  },

  // ========================
  // MENU (reuses existing captain menu with caching)
  // ========================

  /**
   * Get menu for self-order. Reuses the captain menu engine (which already has caching).
   * Additional 2-minute cache layer specifically for self-order to handle burst QR scans.
   */
  async getMenu(outletId, { filter, serviceType } = {}) {
    const cacheKey = `self_order:menu:${outletId}:${filter || 'all'}:${serviceType || 'all'}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const menu = await menuEngineService.getCaptainMenu(outletId, { filter, serviceType });

    // Cache for 2 minutes (self-order specific — handles rush-hour burst)
    await cache.set(cacheKey, menu, 120);
    return menu;
  },

  // ========================
  // ORDER PLACEMENT
  // ========================

  /**
   * Place a self-order. Handles the complete flow:
   * 1. Validate session + settings
   * 2. Validate & price items (reuses menu engine for consistent pricing)
   * 3. Create order + order_items in single transaction
   * 4. Auto-accept (KOT + table status) OR mark as pending_approval
   * 5. Emit socket events
   */
  async placeOrder(session, { customerName, customerPhone, specialInstructions, items }) {
    const pool = getPool();
    const outletId = session.outletId;
    const tableId = session.tableId;

    const settings = await this.getSettings(outletId);

    // Check if outlet is still open (shift active)
    const [[activeShift]] = await pool.query(
      `SELECT id FROM day_sessions WHERE outlet_id = ? AND status = 'open' LIMIT 1`,
      [outletId]
    );
    if (!activeShift) throw new Error('Restaurant is currently closed. Orders cannot be placed at this time.');

    // Enforce customer details based on settings
    if (settings.requireName && !customerName && !session.customerName) {
      throw new Error('Customer name is required');
    }
    if (settings.requirePhone && !customerPhone && !session.customerPhone) {
      throw new Error('Phone number is required');
    }

    const finalName = customerName || session.customerName;
    const finalPhone = customerPhone || session.customerPhone;

    // Check if session already has an order (reorder scenario)
    if (session.orderId) {
      if (!settings.allowReorder) {
        throw new Error('An order has already been placed for this session');
      }
      // Add items to existing order
      return this._addItemsToExistingOrder(session, { specialInstructions, items }, settings);
    }

    // ── Validate and price all items in parallel (no DB connection held) ──
    const [pricedItems, selfOrderUserId] = await Promise.all([
      this._validateAndPriceItems(outletId, items),
      getSelfOrderUserId(),
    ]);

    // ── Transaction: create order + items ──
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Generate order number
      const orderNumber = await this._generateOrderNumber(outletId, connection);
      const uuid = uuidv4();

      // Determine initial order status based on accept mode
      const isAutoMode = settings.acceptMode === SELF_ORDER.ACCEPT_MODE.AUTO;
      const orderStatus = isAutoMode ? 'confirmed' : 'pending';

      // Get or create table session
      // In MANUAL mode: don't create table session or occupy table until staff accepts
      // In AUTO mode: create table session + occupy table immediately
      let tableSessionId = null;
      const [existingSessions] = await connection.query(
        `SELECT id, order_id FROM table_sessions WHERE table_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
        [tableId]
      );

      if (existingSessions[0] && !existingSessions[0].order_id) {
        tableSessionId = existingSessions[0].id;
      } else if (existingSessions[0]) {
        // Table has active session with order — use same session
        tableSessionId = existingSessions[0].id;
      } else if (isAutoMode) {
        // AUTO mode: create table session + occupy table immediately
        const [sessionResult] = await connection.query(
          `INSERT INTO table_sessions (table_id, guest_count, guest_name, guest_phone, started_by)
           VALUES (?, 1, ?, ?, ?)`,
          [tableId, finalName, finalPhone, selfOrderUserId]
        );
        tableSessionId = sessionResult.insertId;
        await connection.query(`UPDATE tables SET status = 'occupied' WHERE id = ?`, [tableId]);
      }
      // MANUAL mode with no existing session: tableSessionId stays null — created on accept

      // Find or create customer record so self-order customers appear in /customers list
      let customerId = null;
      if (finalPhone || finalName) {
        // Try to find existing customer by phone (exact match)
        if (finalPhone) {
          const [existingCustomers] = await connection.query(
            `SELECT id FROM customers WHERE outlet_id = ? AND phone = ? AND is_active = 1 LIMIT 1`,
            [outletId, finalPhone]
          );
          if (existingCustomers[0]) {
            customerId = existingCustomers[0].id;
            // Update name if changed and bump stats
            await connection.query(
              `UPDATE customers SET name = COALESCE(?, name), total_orders = total_orders + 1,
               last_order_at = NOW() WHERE id = ?`,
              [finalName, customerId]
            );
          }
        }
        // Create new customer if not found
        if (!customerId && finalName) {
          const [custResult] = await connection.query(
            `INSERT INTO customers (uuid, outlet_id, name, phone, total_orders, last_order_at)
             VALUES (?, ?, ?, ?, 1, NOW())`,
            [uuidv4(), outletId, finalName, finalPhone]
          );
          customerId = custResult.insertId;
        }
      }

      // Create order
      const [orderResult] = await connection.query(
        `INSERT INTO orders (
          uuid, outlet_id, order_number, order_type, order_source, self_order_session_id,
          table_id, table_session_id, floor_id,
          customer_id, customer_name, customer_phone, guest_count,
          status, payment_status, special_instructions, created_by
        ) VALUES (?, ?, ?, 'dine_in', 'self_order', ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?, ?)`,
        [
          uuid, outletId, orderNumber, session.id,
          tableId, tableSessionId, session.floorId,
          customerId, finalName, finalPhone,
          orderStatus, specialInstructions, selfOrderUserId
        ]
      );
      const orderId = orderResult.insertId;

      // Link order to table session
      if (tableSessionId) {
        await connection.query(
          `UPDATE table_sessions SET order_id = ? WHERE id = ? AND order_id IS NULL`,
          [orderId, tableSessionId]
        );
      }

      // Batch insert order items
      let subtotal = 0;
      let totalTax = 0;
      let grandTotal = 0;
      const itemInserts = [];

      for (const pi of pricedItems) {
        subtotal += pi.totalPrice - pi.taxAmount;
        totalTax += pi.taxAmount;
        grandTotal += pi.totalPrice;

        itemInserts.push([
          orderId, pi.itemId, pi.variantId, pi.itemName, pi.variantName,
          pi.itemType, pi.quantity, pi.unitPrice, pi.basePrice,
          0, pi.taxAmount, pi.totalPrice, pi.taxGroupId,
          pi.taxDetails ? JSON.stringify(pi.taxDetails) : null,
          pi.specialInstructions, 'pending', selfOrderUserId
        ]);
      }

      let firstOrderItemId = null;
      if (itemInserts.length > 0) {
        const [insertResult] = await connection.query(
          `INSERT INTO order_items (
            order_id, item_id, variant_id, item_name, variant_name,
            item_type, quantity, unit_price, base_price,
            discount_amount, tax_amount, total_price, tax_group_id,
            tax_details, special_instructions, status, created_by
          ) VALUES ?`,
          [itemInserts]
        );
        firstOrderItemId = insertResult.insertId;
      }

      // Insert order_item_addons using pre-resolved addon data (no extra queries)
      if (firstOrderItemId) {
        const addonInserts = [];
        for (let i = 0; i < pricedItems.length; i++) {
          const pi = pricedItems[i];
          const orderItemId = firstOrderItemId + i;
          for (const addon of pi.addons) {
            if (addon.addonName) {
              addonInserts.push([
                orderItemId, addon.addonId, addon.addonGroupId,
                addon.addonName, addon.groupName, addon.quantity,
                addon.price, addon.price * addon.quantity
              ]);
            }
          }
        }
        if (addonInserts.length > 0) {
          await connection.query(
            `INSERT INTO order_item_addons (
              order_item_id, addon_id, addon_group_id,
              addon_name, addon_group_name, quantity, unit_price, total_price
            ) VALUES ?`,
            [addonInserts]
          );
        }
      }

      // Update order totals
      await connection.query(
        `UPDATE orders SET subtotal = ?, tax_amount = ?, total_amount = ?, due_amount = ? WHERE id = ?`,
        [subtotal, totalTax, grandTotal, grandTotal, orderId]
      );

      // Update self-order session
      await connection.query(
        `UPDATE self_order_sessions SET status = 'ordering', order_id = ?,
         customer_name = COALESCE(?, customer_name), customer_phone = COALESCE(?, customer_phone)
         WHERE id = ?`,
        [orderId, finalName, finalPhone, session.id]
      );

      await connection.commit();

      // ── Post-transaction: async operations (don't block response) ──
      const orderData = {
        id: orderId,
        uuid,
        orderNumber,
        outletId,
        tableId,
        tableNumber: session.tableNumber,
        tableName: session.tableName,
        floorId: session.floorId,
        floorName: session.floorName,
        customerName: finalName,
        customerPhone: finalPhone,
        status: orderStatus,
        orderSource: 'self_order',
        subtotal,
        taxAmount: totalTax,
        totalAmount: grandTotal,
        itemCount: pricedItems.length,
        specialInstructions,
        createdAt: new Date().toISOString(),
      };

      // Fire-and-forget: socket events + auto-accept + logging + clear cart
      this._postOrderActions(orderData, settings, session).catch(err =>
        logger.error('Self-order post-actions error:', err.message)
      );
      this.clearCart(session.id).catch(() => {});

      return orderData;

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Add items to an existing order (reorder flow)
   */
  async _addItemsToExistingOrder(session, { specialInstructions, items }, settings) {
    const pool = getPool();
    const orderId = session.orderId;

    // Verify order is still modifiable
    const [[order]] = await pool.query(
      `SELECT id, status, outlet_id, order_number, table_id FROM orders WHERE id = ? AND outlet_id = ?`,
      [orderId, session.outletId]
    );

    if (!order) throw new Error('Order not found');
    if (['paid', 'completed', 'cancelled'].includes(order.status)) {
      throw new Error('This order is no longer active. Please start a new session.');
    }
    if (order.status === 'billed') {
      throw new Error('Your bill has been generated. No new items can be added. Please complete payment.');
    }

    // Validate and price new items + resolve system user
    const [pricedItems, selfOrderUserId] = await Promise.all([
      this._validateAndPriceItems(session.outletId, items),
      getSelfOrderUserId(),
    ]);

    // Insert items in transaction
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      let addedSubtotal = 0;
      let addedTax = 0;
      let addedGrandTotal = 0;
      const itemInserts = [];

      for (const pi of pricedItems) {
        addedSubtotal += pi.totalPrice - pi.taxAmount;
        addedTax += pi.taxAmount;
        addedGrandTotal += pi.totalPrice;

        itemInserts.push([
          orderId, pi.itemId, pi.variantId, pi.itemName, pi.variantName,
          pi.itemType, pi.quantity, pi.unitPrice, pi.basePrice,
          0, pi.taxAmount, pi.totalPrice, pi.taxGroupId,
          pi.taxDetails ? JSON.stringify(pi.taxDetails) : null,
          pi.specialInstructions, 'pending', selfOrderUserId
        ]);
      }

      let firstReorderItemId = null;
      if (itemInserts.length > 0) {
        const [insertResult] = await connection.query(
          `INSERT INTO order_items (
            order_id, item_id, variant_id, item_name, variant_name,
            item_type, quantity, unit_price, base_price,
            discount_amount, tax_amount, total_price, tax_group_id,
            tax_details, special_instructions, status, created_by
          ) VALUES ?`,
          [itemInserts]
        );
        firstReorderItemId = insertResult.insertId;
      }

      // Insert order_item_addons for reorder items using pre-resolved data
      if (firstReorderItemId) {
        const addonInserts = [];
        for (let i = 0; i < pricedItems.length; i++) {
          const pi = pricedItems[i];
          const orderItemId = firstReorderItemId + i;
          for (const addon of pi.addons) {
            if (addon.addonName) {
              addonInserts.push([
                orderItemId, addon.addonId, addon.addonGroupId,
                addon.addonName, addon.groupName, addon.quantity,
                addon.price, addon.price * addon.quantity
              ]);
            }
          }
        }
        if (addonInserts.length > 0) {
          await connection.query(
            `INSERT INTO order_item_addons (
              order_item_id, addon_id, addon_group_id,
              addon_name, addon_group_name, quantity, unit_price, total_price
            ) VALUES ?`,
            [addonInserts]
          );
        }
      }

      // Update order totals (additive)
      await connection.query(
        `UPDATE orders SET
          subtotal = subtotal + ?, tax_amount = tax_amount + ?,
          total_amount = total_amount + ?, due_amount = due_amount + ?,
          special_instructions = IF(? IS NOT NULL AND ? != '', CONCAT(COALESCE(special_instructions, ''), '\n', ?), special_instructions),
          updated_at = NOW()
         WHERE id = ?`,
        [addedSubtotal, addedTax, addedGrandTotal, addedGrandTotal,
         specialInstructions, specialInstructions, specialInstructions, orderId]
      );

      // If auto-accept: also set status back to confirmed if it was pending
      if (settings.acceptMode === SELF_ORDER.ACCEPT_MODE.AUTO && order.status === 'pending') {
        await connection.query(
          `UPDATE orders SET status = 'confirmed' WHERE id = ?`,
          [orderId]
        );
      }

      await connection.commit();

      // Emit events
      const isManual = settings.acceptMode === SELF_ORDER.ACCEPT_MODE.MANUAL;
      
      // Determine if order is already confirmed (accepted by staff or auto-accepted)
      // If order is confirmed/preparing/ready, new items should auto-send KOT
      const orderIsConfirmed = ['confirmed', 'preparing', 'ready', 'served', 'billed'].includes(order.status);
      
      const eventData = {
        orderId,
        orderNumber: order.order_number,
        outletId: session.outletId,
        tableId: session.tableId,
        tableNumber: session.tableNumber,
        customerName: session.customerName,
        orderSource: 'self_order',
        addedItems: pricedItems.length,
        action: orderIsConfirmed ? 'items_added' : 'items_pending_approval',
      };

      if (orderIsConfirmed) {
        // Order already confirmed → auto-send KOT for new items (both AUTO and MANUAL mode)
        this._emitSelfOrderEvent('selforder:items_added', eventData).catch(() => {});
        this._emitOrderUpdate(session.outletId, orderId, 'order:items_added').catch(() => {});
        
        // Auto-send KOT for the new items
        this._autoSendKot(orderId).catch(err =>
          logger.error('Self-order auto-KOT (reorder) error:', err.message)
        );
      } else {
        // Order still pending → items need staff approval first
        this._emitSelfOrderEvent('selforder:items_pending', eventData).catch(() => {});
        this._emitOrderUpdate(session.outletId, orderId, 'order:items_added').catch(() => {});
      }

      return {
        orderId,
        orderNumber: order.order_number,
        outletId: session.outletId,
        tableId: session.tableId,
        tableNumber: session.tableNumber,
        tableName: session.tableName,
        floorId: session.floorId,
        floorName: session.floorName,
        customerName: session.customerName,
        customerPhone: session.customerPhone,
        addedItems: pricedItems.length,
        addedSubtotal,
        addedTax,
        addedTotal: addedGrandTotal,
        kotSent: orderIsConfirmed,
        message: orderIsConfirmed
          ? 'Items added and sent to kitchen'
          : 'Items added, waiting for staff approval',
      };

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ========================
  // STAFF: ACCEPT / REJECT
  // ========================

  /**
   * Accept a pending self-order (manual mode). Creates KOT and updates statuses.
   */
  async acceptOrder(orderId, acceptedBy) {
    const pool = getPool();

    const [[order]] = await pool.query(
      `SELECT o.*, t.table_number, t.name as table_name, f.name as floor_name
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       WHERE o.id = ? AND o.order_source = 'self_order'`,
      [orderId]
    );

    if (!order) throw new Error('Self-order not found');

    // Check if order has pending items (new items needing approval on an existing confirmed order)
    const [[{ pendingCount }]] = await pool.query(
      `SELECT COUNT(*) as pendingCount FROM order_items WHERE order_id = ? AND status = 'pending'`,
      [orderId]
    );

    const isReorderAccept = order.status !== 'pending' && pendingCount > 0;
    if (order.status !== 'pending' && pendingCount === 0) {
      throw new Error(`Order is already ${order.status} and has no pending items to accept`);
    }

    // If the order has no table_session (manual mode — session was deferred), create it now
    let tableSessionId = order.table_session_id;
    if (!tableSessionId && order.table_id) {
      const selfOrderUserId = await getSelfOrderUserId();
      const [existingSessions] = await pool.query(
        `SELECT id FROM table_sessions WHERE table_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
        [order.table_id]
      );

      if (existingSessions[0]) {
        tableSessionId = existingSessions[0].id;
      } else {
        const [sessionResult] = await pool.query(
          `INSERT INTO table_sessions (table_id, guest_count, guest_name, guest_phone, started_by)
           VALUES (?, 1, ?, ?, ?)`,
          [order.table_id, order.customer_name, order.customer_phone, selfOrderUserId]
        );
        tableSessionId = sessionResult.insertId;
      }

      // Link order to table session
      await pool.query(
        `UPDATE orders SET table_session_id = ? WHERE id = ?`,
        [tableSessionId, orderId]
      );
      await pool.query(
        `UPDATE table_sessions SET order_id = ? WHERE id = ? AND order_id IS NULL`,
        [orderId, tableSessionId]
      );
    }

    // Update order status to confirmed (only if still pending; reorder-accept keeps existing status)
    if (order.status === 'pending') {
      await pool.query(
        `UPDATE orders SET status = 'confirmed', approved_by = ?, updated_at = NOW() WHERE id = ?`,
        [acceptedBy, orderId]
      );
    } else {
      await pool.query(
        `UPDATE orders SET updated_at = NOW() WHERE id = ?`,
        [orderId]
      );
    }

    // Send KOT (only for pending items — kotService.sendKot already filters by status='pending')
    let kotResult = null;
    try {
      const kotService = require('./kot.service');
      kotResult = await kotService.sendKot(orderId, acceptedBy);
    } catch (err) {
      logger.error('Self-order accept: KOT generation failed:', err.message);
    }

    // Update table status to occupied
    if (order.table_id) {
      await pool.query(
        `UPDATE tables SET status = 'occupied' WHERE id = ? AND status != 'occupied'`,
        [order.table_id]
      );
    }

    // Emit events
    const eventData = {
      orderId,
      orderNumber: order.order_number,
      outletId: order.outlet_id,
      tableId: order.table_id,
      tableNumber: order.table_number,
      customerName: order.customer_name,
      action: isReorderAccept ? 'items_accepted' : 'accepted',
      acceptedBy,
      pendingItemsAccepted: pendingCount,
    };

    await Promise.all([
      this._emitSelfOrderEvent('selforder:accepted', eventData),
      this._emitOrderUpdate(order.outlet_id, orderId, 'order:confirmed'),
      this._logActivity(order.self_order_session_id, order.outlet_id, order.table_id, 'order_accepted', orderId),
    ]).catch(() => {});

    // Emit table update
    if (order.table_id) {
      publishMessage('table:update', {
        outletId: order.outlet_id,
        tableId: order.table_id,
        timestamp: new Date().toISOString()
      }).catch(() => {});
    }

    return {
      orderId,
      orderNumber: order.order_number,
      status: isReorderAccept ? order.status : 'confirmed',
      kotGenerated: !!kotResult,
      pendingItemsAccepted: pendingCount,
      message: isReorderAccept
        ? `${pendingCount} new item(s) accepted and sent to kitchen`
        : 'Order accepted and sent to kitchen',
    };
  },

  /**
   * Reject a self-order (manual mode).
   * - If order is 'pending' → full rejection: cancel order + all items + free table
   * - If order is confirmed/preparing but has pending items → partial rejection:
   *   cancel only the pending items, keep the order and accepted items running
   */
  async rejectOrder(orderId, rejectedBy, reason = null) {
    const pool = getPool();

    const [[order]] = await pool.query(
      `SELECT o.*, t.table_number FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.id = ? AND o.order_source = 'self_order'`,
      [orderId]
    );

    if (!order) throw new Error('Self-order not found');

    // Count pending items to decide full vs partial rejection
    const [[{ pendingCount }]] = await pool.query(
      `SELECT COUNT(*) as pendingCount FROM order_items WHERE order_id = ? AND status = 'pending'`,
      [orderId]
    );

    const isPartialReject = order.status !== 'pending' && pendingCount > 0;
    if (order.status !== 'pending' && pendingCount === 0) {
      throw new Error(`Order is already ${order.status} and has no pending items to reject`);
    }

    if (isPartialReject) {
      // ── Partial reject: cancel only the new pending items ──
      // Get pending items for total adjustment
      const [pendingItems] = await pool.query(
        `SELECT id, total_price, tax_amount FROM order_items WHERE order_id = ? AND status = 'pending'`,
        [orderId]
      );

      let removedTotal = 0;
      let removedTax = 0;
      for (const pi of pendingItems) {
        removedTotal += parseFloat(pi.total_price);
        removedTax += parseFloat(pi.tax_amount);
      }
      const removedSubtotal = removedTotal - removedTax;

      // Cancel only pending items
      await pool.query(
        `UPDATE order_items SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(),
         cancel_reason = ? WHERE order_id = ? AND status = 'pending'`,
        [rejectedBy, reason || 'New items rejected by staff', orderId]
      );

      // Subtract the rejected items from order totals
      await pool.query(
        `UPDATE orders SET
          subtotal = subtotal - ?, tax_amount = tax_amount - ?,
          total_amount = total_amount - ?, due_amount = due_amount - ?,
          updated_at = NOW()
         WHERE id = ?`,
        [removedSubtotal, removedTax, removedTotal, removedTotal, orderId]
      );

      // Emit events — order continues, only new items rejected
      const eventData = {
        orderId,
        orderNumber: order.order_number,
        outletId: order.outlet_id,
        tableId: order.table_id,
        tableNumber: order.table_number,
        customerName: order.customer_name,
        action: 'items_rejected',
        rejectedItems: pendingCount,
        reason,
        rejectedBy,
      };

      await Promise.all([
        this._emitSelfOrderEvent('selforder:items_rejected', eventData),
        this._emitOrderUpdate(order.outlet_id, orderId, 'order:items_updated'),
        this._logActivity(order.self_order_session_id, order.outlet_id, order.table_id, 'order_rejected', orderId),
      ]).catch(() => {});

      return {
        orderId,
        orderNumber: order.order_number,
        status: order.status,
        rejectedItems: pendingCount,
        message: `${pendingCount} new item(s) rejected — previously accepted items are still running`,
      };
    }

    // ── Full rejection: order is still 'pending' (first approval) ──

    // Cancel the order
    await pool.query(
      `UPDATE orders SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(),
       cancel_reason = ?, updated_at = NOW() WHERE id = ?`,
      [rejectedBy, reason || 'Rejected by staff', orderId]
    );

    // Cancel all pending order items
    await pool.query(
      `UPDATE order_items SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(),
       cancel_reason = ? WHERE order_id = ? AND status = 'pending'`,
      [rejectedBy, reason || 'Order rejected', orderId]
    );

    // Reset self-order session so customer can place a new order
    if (order.self_order_session_id) {
      await pool.query(
        `UPDATE self_order_sessions SET status = 'active', order_id = NULL WHERE id = ?`,
        [order.self_order_session_id]
      );
    }

    // If table was only occupied by this order, free it
    if (order.table_id) {
      const [[otherOrders]] = await pool.query(
        `SELECT COUNT(*) as cnt FROM orders
         WHERE table_id = ? AND id != ? AND status NOT IN ('cancelled', 'paid', 'completed')`,
        [order.table_id, orderId]
      );
      if (otherOrders.cnt === 0) {
        if (order.table_session_id) {
          await pool.query(
            `UPDATE table_sessions SET status = 'completed', ended_at = NOW(), ended_by = ? WHERE id = ?`,
            [rejectedBy, order.table_session_id]
          );
        }
        await pool.query(
          `UPDATE tables SET status = 'available' WHERE id = ?`,
          [order.table_id]
        );
      }
    }

    // Emit events
    const eventData = {
      orderId,
      orderNumber: order.order_number,
      outletId: order.outlet_id,
      tableId: order.table_id,
      tableNumber: order.table_number,
      customerName: order.customer_name,
      action: 'rejected',
      status: 'cancelled',
      orderStatus: 'cancelled',
      reason,
      rejectedBy,
    };

    await Promise.all([
      this._emitSelfOrderEvent('selforder:rejected', eventData),
      this._emitOrderUpdate(order.outlet_id, orderId, 'order:cancelled'),
      this._logActivity(order.self_order_session_id, order.outlet_id, order.table_id, 'order_rejected', orderId),
    ]).catch(() => {});

    if (order.table_id) {
      publishMessage('table:update', {
        outletId: order.outlet_id,
        tableId: order.table_id,
        timestamp: new Date().toISOString()
      }).catch(() => {});
    }

    return {
      orderId,
      orderNumber: order.order_number,
      status: 'cancelled',
      message: 'Order rejected',
    };
  },

  // ========================
  // CUSTOMER: ORDER STATUS
  // ========================

  /**
   * Get order status for customer (lightweight, fast)
   */
  async getOrderStatus(session) {
    if (!session.orderId) {
      return { hasOrder: false };
    }

    const pool = getPool();

    const [[order]] = await pool.query(
      `SELECT id, order_number, status, subtotal, tax_amount, total_amount,
              special_instructions, created_at, cancel_reason
       FROM orders WHERE id = ?`,
      [session.orderId]
    );

    if (!order) return { hasOrder: false };

    // Manual mode: order not yet accepted by staff — show nothing
    if (order.status === 'pending') {
      return { hasOrder: false };
    }

    // Get items
    const [items] = await pool.query(
      `SELECT oi.id, oi.item_name, oi.variant_name, oi.quantity, oi.unit_price,
              oi.total_price, oi.status, oi.special_instructions, oi.item_type
       FROM order_items oi WHERE oi.order_id = ? ORDER BY oi.id`,
      [session.orderId]
    );

    return {
      hasOrder: true,
      order: {
        id: order.id,
        orderNumber: order.order_number,
        status: order.status,
        subtotal: parseFloat(order.subtotal),
        taxAmount: parseFloat(order.tax_amount),
        totalAmount: parseFloat(order.total_amount),
        cancelReason: order.cancel_reason || null,
        createdAt: order.created_at,
        items: items.map(i => ({
          id: i.id,
          name: i.item_name,
          variantName: i.variant_name,
          quantity: parseFloat(i.quantity),
          unitPrice: parseFloat(i.unit_price),
          totalPrice: parseFloat(i.total_price),
          status: i.status,
          itemType: i.item_type,
          specialInstructions: i.special_instructions,
        })),
      },
    };
  },

  // ========================
  // CUSTOMER: ORDER MODIFICATION (before preparation)
  // ========================

  /**
   * Cancel a self-order (customer-initiated).
   * Only allowed before preparation starts (status = pending or confirmed).
   */
  async cancelOrder(session, reason = null) {
    const pool = getPool();

    if (!session.orderId) throw new Error('No active order to cancel');

    const [[order]] = await pool.query(
      `SELECT id, order_number, status, outlet_id, table_id, table_session_id, self_order_session_id
       FROM orders WHERE id = ? AND outlet_id = ?`,
      [session.orderId, session.outletId]
    );

    if (!order) throw new Error('Order not found');

    // Only allow cancellation before preparation
    const cancellableStatuses = ['pending', 'confirmed'];
    if (!cancellableStatuses.includes(order.status)) {
      throw new Error('Order cannot be cancelled — it is already being prepared. Please ask staff for assistance.');
    }

    const selfOrderUserId = await getSelfOrderUserId();

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Cancel order
      await connection.query(
        `UPDATE orders SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(),
         cancel_reason = ?, updated_at = NOW() WHERE id = ?`,
        [selfOrderUserId, reason || 'Cancelled by customer', order.id]
      );

      // Cancel all pending/confirmed items
      await connection.query(
        `UPDATE order_items SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(),
         cancel_reason = ? WHERE order_id = ? AND status IN ('pending', 'confirmed')`,
        [selfOrderUserId, reason || 'Order cancelled by customer', order.id]
      );

      // Reset self-order session so customer can place a new order
      await connection.query(
        `UPDATE self_order_sessions SET status = 'active', order_id = NULL WHERE id = ?`,
        [session.id]
      );

      // Free table if no other active orders
      if (order.table_id) {
        const [[otherOrders]] = await connection.query(
          `SELECT COUNT(*) as cnt FROM orders
           WHERE table_id = ? AND id != ? AND status NOT IN ('cancelled', 'paid', 'completed')`,
          [order.table_id, order.id]
        );
        if (otherOrders.cnt === 0) {
          if (order.table_session_id) {
            await connection.query(
              `UPDATE table_sessions SET status = 'completed', ended_at = NOW(), ended_by = ? WHERE id = ?`,
              [selfOrderUserId, order.table_session_id]
            );
          }
          await connection.query(
            `UPDATE tables SET status = 'available' WHERE id = ?`,
            [order.table_id]
          );
        }
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    // Emit events — include status so frontend can remove from pending list
    const eventData = {
      orderId: order.id,
      orderNumber: order.order_number,
      outletId: order.outlet_id,
      tableId: order.table_id,
      tableNumber: session.tableNumber,
      customerName: session.customerName,
      action: 'customer_cancelled',
      status: 'cancelled',
      orderStatus: 'cancelled',
      reason,
      cancelledBy: 'customer',
    };

    Promise.all([
      this._emitSelfOrderEvent('selforder:cancelled', eventData),
      this._emitOrderUpdate(order.outlet_id, order.id, 'order:cancelled'),
      this._logActivity(session.id, order.outlet_id, order.table_id, 'order_cancelled', order.id),
    ]).catch(() => {});

    if (order.table_id) {
      publishMessage('table:update', {
        outletId: order.outlet_id,
        tableId: order.table_id,
        timestamp: new Date().toISOString()
      }).catch(() => {});
    }

    return {
      orderId: order.id,
      orderNumber: order.order_number,
      status: 'cancelled',
      message: 'Order cancelled successfully. You can place a new order.',
    };
  },

  /**
   * Update item quantity in a self-order (customer-initiated).
   * Only allowed for items that haven't been sent to kitchen (status = pending).
   */
  async updateItemQuantity(session, orderItemId, newQuantity) {
    const pool = getPool();

    if (!session.orderId) throw new Error('No active order');

    // Fetch item with order validation
    const [[item]] = await pool.query(
      `SELECT oi.id, oi.order_id, oi.item_id, oi.unit_price, oi.base_price,
              oi.tax_amount, oi.total_price, oi.quantity, oi.status, oi.tax_group_id, oi.tax_details,
              o.status as order_status
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE oi.id = ? AND oi.order_id = ? AND o.outlet_id = ?`,
      [orderItemId, session.orderId, session.outletId]
    );

    if (!item) throw new Error('Item not found in your order');
    if (item.status !== 'pending') {
      throw new Error('This item has already been sent to the kitchen and cannot be modified.');
    }
    if (!['pending', 'confirmed'].includes(item.order_status)) {
      throw new Error('Order is being prepared and cannot be modified.');
    }

    // Recalculate price for new quantity
    const unitPrice = parseFloat(item.unit_price);
    const oldTotalPrice = parseFloat(item.total_price);
    const oldTaxAmount = parseFloat(item.tax_amount);
    const taxRate = item.quantity > 0 ? oldTaxAmount / (parseFloat(item.base_price) * item.quantity) : 0;

    const newBaseTotal = parseFloat(item.base_price) * newQuantity;
    const newTaxAmount = parseFloat((newBaseTotal * taxRate).toFixed(2));
    const newTotalPrice = parseFloat((newBaseTotal + newTaxAmount).toFixed(2));

    const priceDiff = newTotalPrice - oldTotalPrice;
    const taxDiff = newTaxAmount - oldTaxAmount;

    await pool.query(
      `UPDATE order_items SET quantity = ?, tax_amount = ?, total_price = ?, updated_at = NOW()
       WHERE id = ?`,
      [newQuantity, newTaxAmount, newTotalPrice, orderItemId]
    );

    // Update order totals
    await pool.query(
      `UPDATE orders SET
        subtotal = subtotal + ?, tax_amount = tax_amount + ?,
        total_amount = total_amount + ?, due_amount = due_amount + ?,
        updated_at = NOW()
       WHERE id = ?`,
      [priceDiff - taxDiff, taxDiff, priceDiff, priceDiff, session.orderId]
    );

    // Emit events
    this._emitSelfOrderEvent('selforder:item_updated', {
      orderId: session.orderId, orderItemId, newQuantity,
      outletId: session.outletId, tableId: session.tableId, action: 'item_updated',
    }).catch(() => {});
    this._emitOrderUpdate(session.outletId, session.orderId, 'order:items_updated').catch(() => {});

    return {
      orderItemId,
      newQuantity,
      newTotalPrice,
      message: 'Item quantity updated',
    };
  },

  /**
   * Remove an item from a self-order (customer-initiated).
   * Only allowed for items that haven't been sent to kitchen (status = pending).
   * Cannot remove last item — use cancelOrder instead.
   */
  async removeItem(session, orderItemId) {
    const pool = getPool();

    if (!session.orderId) throw new Error('No active order');

    // Fetch item + count remaining items
    const [[item]] = await pool.query(
      `SELECT oi.id, oi.order_id, oi.item_name, oi.total_price, oi.tax_amount, oi.status,
              o.status as order_status
       FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE oi.id = ? AND oi.order_id = ? AND o.outlet_id = ?`,
      [orderItemId, session.orderId, session.outletId]
    );

    if (!item) throw new Error('Item not found in your order');
    if (item.status !== 'pending') {
      throw new Error('This item has already been sent to the kitchen and cannot be removed.');
    }
    if (!['pending', 'confirmed'].includes(item.order_status)) {
      throw new Error('Order is being prepared and cannot be modified.');
    }

    // Check this isn't the last item
    const [[{ activeCount }]] = await pool.query(
      `SELECT COUNT(*) as activeCount FROM order_items
       WHERE order_id = ? AND status NOT IN ('cancelled')`,
      [session.orderId]
    );

    if (activeCount <= 1) {
      // Last item — auto-cancel the order instead of blocking
      const cancelResult = await this.cancelOrder(session, 'Last item removed by customer');
      return {
        orderItemId,
        removedItem: item.item_name,
        orderCancelled: true,
        message: 'Last item removed — order has been cancelled.',
        ...cancelResult,
      };
    }

    const selfOrderUserId = await getSelfOrderUserId();
    const totalPrice = parseFloat(item.total_price);
    const taxAmount = parseFloat(item.tax_amount);

    // Cancel the item
    await pool.query(
      `UPDATE order_items SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(),
       cancel_reason = 'Removed by customer' WHERE id = ?`,
      [selfOrderUserId, orderItemId]
    );

    // Update order totals (subtract)
    await pool.query(
      `UPDATE orders SET
        subtotal = subtotal - ?, tax_amount = tax_amount - ?,
        total_amount = total_amount - ?, due_amount = due_amount - ?,
        updated_at = NOW()
       WHERE id = ?`,
      [totalPrice - taxAmount, taxAmount, totalPrice, totalPrice, session.orderId]
    );

    // Emit events
    this._emitSelfOrderEvent('selforder:item_removed', {
      orderId: session.orderId, orderItemId, itemName: item.item_name,
      outletId: session.outletId, tableId: session.tableId, action: 'item_removed',
    }).catch(() => {});
    this._emitOrderUpdate(session.outletId, session.orderId, 'order:items_updated').catch(() => {});

    return {
      orderItemId,
      removedItem: item.item_name,
      message: 'Item removed from order',
    };
  },

  // ========================
  // STAFF: LIST PENDING SELF-ORDERS
  // ========================

  /**
   * Get self-orders for an outlet — staff view with filters
   * @param {number} outletId
   * @param {object} opts - { status, page, limit, search, fromDate, toDate }
   */
  async getPendingSelfOrders(outletId, { status = 'pending', page = 1, limit = 20, search, fromDate, toDate } = {}) {
    const pool = getPool();

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * pageSize;

    let where = `WHERE o.outlet_id = ? AND o.order_source = 'self_order'`;
    const params = [outletId];

    // Status filter
    if (status === 'all') {
      where += ` AND o.status NOT IN ('cancelled')`;
    } else {
      where += ` AND o.status = ?`;
      params.push(status);
    }

    // Date filter (business day range 4am-4am)
    if (fromDate && toDate && fromDate.length === 10 && toDate.length === 10) {
      const { startDt, endDt } = businessDayRange(fromDate, toDate);
      where += ` AND o.created_at >= ? AND o.created_at < ?`;
      params.push(startDt, endDt);
    } else if (fromDate && fromDate.length === 10) {
      const { startDt } = businessDayRange(fromDate, fromDate);
      where += ` AND o.created_at >= ?`;
      params.push(startDt);
    } else if (toDate && toDate.length === 10) {
      const { endDt } = businessDayRange(toDate, toDate);
      where += ` AND o.created_at < ?`;
      params.push(endDt);
    }

    // Search: order number, customer name, phone, table number
    if (search && search.trim()) {
      where += ` AND (o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR t.table_number LIKE ?)`;
      const like = `%${search.trim()}%`;
      params.push(like, like, like, like);
    }

    const fromClause = `FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id`;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total ${fromClause} ${where}`,
      params
    );

    const [orders] = await pool.query(
      `SELECT o.id, o.order_number, o.status, o.order_source,
              o.customer_name, o.customer_phone,
              o.subtotal, o.tax_amount, o.total_amount, o.special_instructions,
              o.created_at, o.updated_at,
              t.table_number, t.name as table_name,
              f.name as floor_name
       ${fromClause} ${where}
       ORDER BY FIELD(o.status, 'pending', 'confirmed', 'preparing', 'ready', 'served', 'paid', 'completed'), o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    // Batch-fetch items for all orders
    let itemsByOrder = {};
    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const [allItems] = await pool.query(
        `SELECT oi.order_id, oi.id, oi.item_name, oi.variant_name, oi.item_type,
                oi.quantity, oi.unit_price, oi.total_price, oi.special_instructions,
                oi.status, oi.tax_details,
                i.image_url, i.short_name
         FROM order_items oi
         LEFT JOIN items i ON oi.item_id = i.id
         WHERE oi.order_id IN (?) AND oi.status != 'cancelled'
         ORDER BY oi.id`,
        [orderIds]
      );
      for (const item of allItems) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        let taxDetails = null;
        if (item.tax_details) {
          try {
            const parsed = typeof item.tax_details === 'string' ? JSON.parse(item.tax_details) : item.tax_details;
            taxDetails = Array.isArray(parsed) ? parsed : [{ componentName: parsed.taxGroupName || 'Tax', rate: parsed.rate, amount: parsed.amount }];
          } catch { taxDetails = null; }
        }
        itemsByOrder[item.order_id].push({
          id: item.id,
          name: item.item_name,
          shortName: item.short_name || null,
          variantName: item.variant_name || null,
          itemType: item.item_type,
          quantity: item.quantity,
          unitPrice: parseFloat(item.unit_price) || 0,
          totalPrice: parseFloat(item.total_price) || 0,
          specialInstructions: item.special_instructions || null,
          status: item.status,
          taxDetails,
        });
      }
    }

    const data = orders.map(o => ({
      id: o.id,
      orderNumber: o.order_number,
      status: o.status,
      customerName: o.customer_name,
      customerPhone: o.customer_phone,
      tableNumber: o.table_number,
      tableName: o.table_name,
      floorName: o.floor_name,
      subtotal: parseFloat(o.subtotal) || 0,
      taxAmount: parseFloat(o.tax_amount) || 0,
      totalAmount: parseFloat(o.total_amount) || 0,
      specialInstructions: o.special_instructions || null,
      itemCount: (itemsByOrder[o.id] || []).length,
      items: itemsByOrder[o.id] || [],
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    }));

    return {
      orders: data,
      pagination: {
        total,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  },

  // ========================
  // INTERNAL HELPERS
  // ========================

  /**
   * Validate items exist, are active, and calculate prices using menu engine.
   * Batched query: single DB call for all items + variants.
   */
  async _validateAndPriceItems(outletId, items) {
    const pool = getPool();

    // Collect all itemIds and variantIds for batch fetch
    const itemIds = [...new Set(items.map(i => i.itemId))];
    const variantIds = [...new Set(items.filter(i => i.variantId).map(i => i.variantId))];
    const allAddonIds = [...new Set(items.flatMap(i => (i.addons || []).map(a => a.addonId)))];

    // Parallel batch fetch: items, variants, addons, tax groups
    const fetchPromises = [
      pool.query(
        `SELECT i.id, i.name, i.short_name, i.base_price, i.item_type, i.tax_group_id,
                i.kitchen_station_id, i.is_active, i.deleted_at, i.category_id,
                c.name as category_name
         FROM items i
         JOIN categories c ON i.category_id = c.id
         WHERE i.id IN (?) AND i.outlet_id = ?`,
        [itemIds, outletId]
      ),
    ];

    if (variantIds.length > 0) {
      fetchPromises.push(
        pool.query(
          `SELECT id, item_id, name, price, tax_group_id, is_active FROM variants WHERE id IN (?)`,
          [variantIds]
        )
      );
    } else {
      fetchPromises.push(Promise.resolve([[], null]));
    }

    if (allAddonIds.length > 0) {
      fetchPromises.push(
        pool.query(
          `SELECT a.id, a.name, a.price, a.item_type, a.addon_group_id, ag.name as group_name
           FROM addons a
           JOIN addon_groups ag ON a.addon_group_id = ag.id
           WHERE a.id IN (?) AND a.is_active = 1`,
          [allAddonIds]
        )
      );
    } else {
      fetchPromises.push(Promise.resolve([[], null]));
    }

    const [itemsResult, variantsResult, addonsResult] = await Promise.all(fetchPromises);

    const itemsMap = new Map(itemsResult[0].map(i => [i.id, i]));
    const variantsMap = new Map(variantsResult[0].map(v => [v.id, v]));
    const addonsMap = new Map(addonsResult[0].map(a => [a.id, a]));

    // Batch fetch tax groups for all unique tax_group_ids
    const taxGroupIds = new Set();
    itemsResult[0].forEach(i => { if (i.tax_group_id) taxGroupIds.add(i.tax_group_id); });
    variantsResult[0].forEach(v => { if (v.tax_group_id) taxGroupIds.add(v.tax_group_id); });

    let taxGroupsMap = new Map();
    if (taxGroupIds.size > 0) {
      const [taxGroups] = await pool.query(
        `SELECT tg.id, tg.name, tg.total_rate, tg.is_inclusive,
                GROUP_CONCAT(tc.id ORDER BY tc.id SEPARATOR ',') as component_ids,
                GROUP_CONCAT(tc.name ORDER BY tc.id SEPARATOR '|||') as component_names,
                GROUP_CONCAT(tc.code ORDER BY tc.id SEPARATOR '|||') as component_codes,
                GROUP_CONCAT(tc.rate ORDER BY tc.id SEPARATOR ',') as component_rates
         FROM tax_groups tg
         LEFT JOIN tax_group_components tgc ON tg.id = tgc.tax_group_id
         LEFT JOIN tax_components tc ON tgc.tax_component_id = tc.id
         WHERE tg.id IN (?) AND tg.is_active = 1
         GROUP BY tg.id`,
        [[...taxGroupIds]]
      );
      // Parse GROUP_CONCAT strings into structured components array
      for (const tg of taxGroups) {
        if (tg.component_ids) {
          const ids = tg.component_ids.split(',');
          const names = tg.component_names.split('|||');
          const codes = tg.component_codes.split('|||');
          const rates = tg.component_rates.split(',');
          tg.components = ids.map((id, i) => ({
            id: parseInt(id, 10),
            name: names[i],
            code: codes[i],
            rate: parseFloat(rates[i]),
          }));
        } else {
          tg.components = [];
        }
      }
      taxGroupsMap = new Map(taxGroups.map(t => [t.id, t]));
    }

    // Price each item
    const pricedItems = [];

    for (const orderItem of items) {
      const dbItem = itemsMap.get(orderItem.itemId);
      if (!dbItem) throw new Error(`Item ${orderItem.itemId} not found`);
      if (!dbItem.is_active || dbItem.deleted_at) throw new Error(`Item "${dbItem.name}" is not available`);

      let unitPrice = parseFloat(dbItem.base_price);
      let basePrice = unitPrice;
      let variantName = null;
      let activeTaxGroupId = dbItem.tax_group_id;

      // Variant pricing
      if (orderItem.variantId) {
        const variant = variantsMap.get(orderItem.variantId);
        if (!variant) throw new Error(`Variant ${orderItem.variantId} not found for item "${dbItem.name}"`);
        if (!variant.is_active) throw new Error(`Variant "${variant.name}" is not available`);
        if (variant.item_id !== orderItem.itemId) throw new Error(`Variant does not belong to item "${dbItem.name}"`);

        unitPrice = parseFloat(variant.price);
        basePrice = unitPrice;
        variantName = variant.name;
        if (variant.tax_group_id) activeTaxGroupId = variant.tax_group_id;
      }

      // Addon pricing
      let addonTotal = 0;
      if (orderItem.addons && orderItem.addons.length > 0) {
        for (const addon of orderItem.addons) {
          const dbAddon = addonsMap.get(addon.addonId);
          if (!dbAddon) throw new Error(`Addon ${addon.addonId} not found`);
          addonTotal += parseFloat(dbAddon.price) * (addon.quantity || 1);
        }
      }

      unitPrice += addonTotal;
      const totalBeforeTax = unitPrice * orderItem.quantity;

      // Tax calculation
      let taxAmount = 0;
      let taxDetails = null;
      const taxGroup = taxGroupsMap.get(activeTaxGroupId);

      if (taxGroup) {
        const totalRate = parseFloat(taxGroup.total_rate) || 0;
        const taxableAmount = taxGroup.is_inclusive
          ? totalBeforeTax / (1 + totalRate / 100)
          : totalBeforeTax;

        // Build taxDetails as array of components — matches POS format (taxService.calculateTax breakdown)
        if (taxGroup.components && taxGroup.components.length > 0) {
          taxDetails = taxGroup.components.map(comp => ({
            componentId: comp.id,
            componentName: comp.name,
            componentCode: comp.code,
            rate: comp.rate,
            amount: parseFloat(((taxableAmount * comp.rate) / 100).toFixed(2)),
          }));
        } else {
          // No components linked — use total_rate as single entry
          taxDetails = totalRate > 0 ? [{
            componentId: null,
            componentName: taxGroup.name || 'Tax',
            componentCode: 'TAX',
            rate: totalRate,
            amount: parseFloat(((taxableAmount * totalRate) / 100).toFixed(2)),
          }] : [];
        }

        taxAmount = Math.round(taxDetails.reduce((s, t) => s + t.amount, 0) * 100) / 100;
      }

      const totalPrice = taxGroup && taxGroup.is_inclusive ? totalBeforeTax : totalBeforeTax + taxAmount;

      pricedItems.push({
        itemId: orderItem.itemId,
        variantId: orderItem.variantId || null,
        itemName: dbItem.name,
        variantName,
        itemType: dbItem.item_type,
        quantity: orderItem.quantity,
        unitPrice: Math.round(unitPrice * 100) / 100,
        basePrice: Math.round(basePrice * 100) / 100,
        taxGroupId: activeTaxGroupId,
        taxAmount,
        taxDetails,
        totalPrice: Math.round(totalPrice * 100) / 100,
        specialInstructions: orderItem.specialInstructions || null,
        addons: (orderItem.addons || []).map(a => {
          const dbAddon = addonsMap.get(a.addonId);
          return {
            addonId: a.addonId,
            addonGroupId: dbAddon ? dbAddon.addon_group_id : a.addonGroupId,
            addonName: dbAddon ? dbAddon.name : null,
            groupName: dbAddon ? dbAddon.group_name : null,
            price: dbAddon ? parseFloat(dbAddon.price) : 0,
            quantity: a.quantity || 1,
          };
        }),
      });
    }

    return pricedItems;
  },

  /**
   * Generate order number (same pattern as order.service.js for consistency)
   */
  async _generateOrderNumber(outletId, connection) {
    const today = new Date();
    const datePrefix = today.toISOString().slice(2, 10).replace(/-/g, '');
    const prefix = `ORD${datePrefix}`;

    const [result] = await connection.query(
      `SELECT MAX(CAST(SUBSTRING(order_number, ?) AS UNSIGNED)) as max_seq
       FROM orders
       WHERE outlet_id = ? AND order_number LIKE CONCAT(?, '%')`,
      [prefix.length + 1, outletId, prefix]
    );

    const seq = String((result[0].max_seq || 0) + 1).padStart(4, '0');
    return `${prefix}${seq}`;
  },

  /**
   * Post-order async actions (auto-KOT, socket events, logging)
   */
  async _postOrderActions(orderData, settings, session) {
    const promises = [];

    // 1. Emit self-order notification to staff
    promises.push(this._emitSelfOrderEvent('selforder:new', {
      ...orderData,
      acceptMode: settings.acceptMode,
      action: 'new_order',
    }));

    // 2. Emit generic order update
    promises.push(this._emitOrderUpdate(orderData.outletId, orderData.id, 'order:created'));

    // 3. Emit table update
    if (orderData.tableId) {
      promises.push(publishMessage('table:update', {
        outletId: orderData.outletId,
        tableId: orderData.tableId,
        timestamp: new Date().toISOString()
      }));
    }

    // 4. Log activity
    promises.push(this._logActivity(
      session.id, orderData.outletId, orderData.tableId, 'order_placed', orderData.id, null,
      { orderNumber: orderData.orderNumber, itemCount: orderData.itemCount, total: orderData.totalAmount }
    ));

    // 5. Auto-accept: send KOT immediately
    if (settings.acceptMode === SELF_ORDER.ACCEPT_MODE.AUTO) {
      promises.push(this._autoSendKot(orderData.id));
    }

    await Promise.allSettled(promises);
  },

  /**
   * Auto-send KOT for confirmed self-orders
   */
  async _autoSendKot(orderId) {
    try {
      const kotService = require('./kot.service');
      const userId = await getSelfOrderUserId();
      await kotService.sendKot(orderId, userId);
      logger.info(`Self-order auto-KOT sent for order ${orderId}`);
    } catch (err) {
      logger.error(`Self-order auto-KOT failed for order ${orderId}:`, err.message);
    }
  },

  /**
   * Emit self-order specific event (goes to outlet room for all staff)
   */
  async _emitSelfOrderEvent(eventType, data) {
    try {
      await publishMessage('selforder:update', {
        type: eventType,
        ...data,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(`Self-order event emit failed (${eventType}):`, err.message);
    }
  },

  /**
   * Emit generic order update (reuses existing order:update channel)
   */
  async _emitOrderUpdate(outletId, orderId, eventType) {
    try {
      await publishMessage('order:update', {
        type: eventType,
        outletId,
        orderId,
        orderSource: 'self_order',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error('Self-order order:update emit failed:', err.message);
    }
  },

  /**
   * Log self-order activity (fire-and-forget, never throws)
   */
  async _logActivity(sessionId, outletId, tableId, action, orderId = null, ipAddress = null, metadata = null) {
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO self_order_logs (session_id, outlet_id, table_id, action, order_id, ip_address, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, outletId, tableId, action, orderId, ipAddress, metadata ? JSON.stringify(metadata) : null]
      );
    } catch (err) {
      logger.warn('Self-order log failed:', err.message);
    }
  },

  /**
   * Format session response for client
   */
  _formatSession(row, settings) {
    return {
      token: row.token,
      sessionId: row.id,
      outlet: { id: row.outlet_id, name: row.outlet_name },
      table: {
        id: row.table_id,
        number: row.table_number,
        name: row.table_name,
        floorName: row.floor_name,
      },
      orderId: row.order_id || null,
      status: row.status,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      expiresAt: row.expires_at,
      settings: {
        requirePhone: settings.requirePhone,
        requireName: settings.requireName,
        acceptMode: settings.acceptMode,
        allowReorder: settings.allowReorder,
      },
    };
  },

  // ========================
  // CLEANUP (for cron)
  // ========================

  /**
   * Expire stale sessions. Call from cron job.
   */
  async expireStaleSessions() {
    const pool = getPool();
    const [result] = await pool.query(
      `UPDATE self_order_sessions SET status = 'expired'
       WHERE status IN ('active', 'ordering') AND expires_at < NOW()`
    );
    if (result.affectedRows > 0) {
      logger.info(`Expired ${result.affectedRows} stale self-order sessions`);
    }
    return result.affectedRows;
  },

  // ========================
  // QR CODE GENERATION
  // ========================

  /**
   * Generate or regenerate the self-order QR code for a table.
   * The QR encodes a static URL containing only outletId and tableId.
   * QR codes are permanent and never expire.
   */
  async generateTableQr(outletId, tableId, { baseUrl } = {}) {
    const pool = getPool();
    const QRCode = require('qrcode');
    const sharp = require('sharp');
    const path = require('path');
    const fs = require('fs');

    const [[table]] = await pool.query(
      `SELECT t.id, t.table_number, t.name, t.qr_code, t.floor_id,
              f.name as floor_name
       FROM tables t
       LEFT JOIN floors f ON t.floor_id = f.id
       WHERE t.id = ? AND t.outlet_id = ?`,
      [tableId, outletId]
    );
    if (!table) throw new Error('Table not found');

    // Build the static self-order URL (outlet + table only — no token)
    const appUrl = baseUrl || process.env.SELF_ORDER_URL || process.env.APP_URL || 'http://localhost:3000';
    const selfOrderUrl = `${appUrl}/self-order?outlet=${outletId}&table=${tableId}`;

    // Generate QR image
    const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
    const qrDir = path.join(uploadDir, 'self-order-qr');
    if (!fs.existsSync(qrDir)) {
      fs.mkdirSync(qrDir, { recursive: true });
    }

    const filename = `so_qr_${outletId}_${tableId}.png`;
    const qrFilePath = path.join(qrDir, filename);
    const relativePath = `uploads/self-order-qr/${filename}`;

    const qrBuffer = await QRCode.toBuffer(selfOrderUrl, {
      type: 'png',
      width: 600,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
      errorCorrectionLevel: 'H',
    });

    // Add table label below QR
    const labelSvg = `
      <svg width="600" height="80">
        <rect width="600" height="80" fill="white"/>
        <text x="300" y="35" font-family="Arial,sans-serif" font-size="28" font-weight="bold"
              text-anchor="middle" fill="#222">Table ${table.table_number}</text>
        <text x="300" y="65" font-family="Arial,sans-serif" font-size="18"
              text-anchor="middle" fill="#666">${table.floor_name || ''} — Scan to Order</text>
      </svg>`;

    const composited = await sharp({
      create: { width: 600, height: 680, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
    })
      .composite([
        { input: qrBuffer, top: 0, left: 0 },
        { input: Buffer.from(labelSvg), top: 600, left: 0 },
      ])
      .png()
      .toFile(qrFilePath);

    // Step 1: always update qr_code (safe on all MySQL versions)
    await pool.query(`UPDATE tables SET qr_code = ? WHERE id = ?`, [relativePath, tableId]);

    // Step 2: store the URL encoded in the QR (requires migration 071)
    // Silently skip if qr_url column not yet present on this server
    try {
      await pool.query(`UPDATE tables SET qr_url = ? WHERE id = ?`, [selfOrderUrl, tableId]);
    } catch (urlErr) {
      if (!urlErr.message.includes('Unknown column')) throw urlErr;
      // qr_url column missing — run migration 071 on production to fix this
    }

    return {
      tableId,
      tableNumber: table.table_number,
      tableName: table.name,
      floorName: table.floor_name,
      qrUrl: selfOrderUrl,
      qrImagePath: relativePath,
    };
  },

  /**
   * Bulk generate QR codes for all tables in an outlet
   */
  async generateAllTableQrs(outletId, { baseUrl } = {}) {
    const pool = getPool();
    const [tables] = await pool.query(
      `SELECT id FROM tables WHERE outlet_id = ? AND is_active = 1 ORDER BY table_number`,
      [outletId]
    );

    const results = [];
    for (const table of tables) {
      try {
        const result = await this.generateTableQr(outletId, table.id, { baseUrl });
        results.push(result);
      } catch (err) {
        results.push({ tableId: table.id, error: err.message });
      }
    }
    return results;
  },

  /**
   * Get all table QR URLs for an outlet, grouped by floor.
   * Returns ALL tables — tables without a generated QR have qrStatus: 'unavailable'.
   * qrImagePath is prefixed with APP_URL so the client can render it directly.
   */
  async getTableQrUrls(outletId, { baseUrl, floorId } = {}) {
    const pool = getPool();

    // Validate outlet
    const [[outlet]] = await pool.query(
      `SELECT id, name FROM outlets WHERE id = ? AND is_active = 1`, [outletId]
    );
    if (!outlet) throw new Error('Outlet not found');

    // Build query with optional floor filter — include ALL active tables
    const buildQuery = (withQrUrl) => {
      const cols = withQrUrl
        ? 't.id, t.table_number, t.name, t.qr_code, t.qr_url, t.status, t.floor_id, f.name as floor_name, f.id as fid'
        : 't.id, t.table_number, t.name, t.qr_code, t.status, t.floor_id, f.name as floor_name, f.id as fid';
      return `SELECT ${cols} FROM tables t LEFT JOIN floors f ON t.floor_id = f.id WHERE t.outlet_id = ? AND t.is_active = 1`;
    };
    const params = [outletId];
    let baseQuery = buildQuery(true);
    if (floorId) params.push(parseInt(floorId, 10));
    const orderBy = ` ORDER BY f.name, t.table_number`;
    const floorFilter = floorId ? ` AND t.floor_id = ?` : '';

    let tables;
    try {
      const [rows] = await pool.query(baseQuery + floorFilter + orderBy, params);
      tables = rows;
    } catch (err) {
      if (!err.message.includes('Unknown column') || !err.message.includes('qr_url')) throw err;
      // qr_url column not yet on this server — fall back to reconstruction
      const [rows] = await pool.query(buildQuery(false) + floorFilter + orderBy, params);
      tables = rows;
    }

    // Self-order URL for QR content (customer-facing frontend)
    const selfOrderAppUrl = baseUrl || process.env.SELF_ORDER_URL || 'http://localhost:3000';
    // Backend APP_URL prefix for serving QR image files
    const serverUrl = (process.env.APP_URL || 'http://localhost:3005').replace(/\/$/, '');

    let tablesWithQrCount = 0;

    // Group ALL tables by floor — mark unavailable if QR not yet generated
    const floorMap = new Map();
    for (const t of tables) {
      const fId = t.floor_id || 0;
      if (!floorMap.has(fId)) {
        floorMap.set(fId, {
          floorId: t.floor_id || null,
          floorName: t.floor_name || 'No Floor',
          tables: [],
        });
      }

      const hasQr = !!t.qr_code;
      if (hasQr) tablesWithQrCount++;

      // Use stored qr_url (actual URL encoded in QR image) — fallback to reconstruction
      // if qr_url column not yet populated (e.g. QR generated before this migration)
      const qrUrl = t.qr_url || (hasQr ? `${selfOrderAppUrl}/self-order?outlet=${outletId}&table=${t.id}` : null);

      floorMap.get(fId).tables.push({
        tableId: t.id,
        tableNumber: t.table_number,
        tableName: t.name,
        status: t.status,
        qrStatus: hasQr ? 'available' : 'unavailable',
        qrUrl: hasQr ? qrUrl : null,
        qrImagePath: hasQr ? `${serverUrl}/${t.qr_code}` : null,
      });
    }

    return {
      outlet: { id: outlet.id, name: outlet.name },
      floors: Array.from(floorMap.values()),
      totalTables: tables.length,
      tablesWithQr: tablesWithQrCount,
      tablesMissingQr: tables.length - tablesWithQrCount,
    };
  },

  /**
   * @deprecated QR codes are now static/permanent. No validation needed.
   * Kept for backward compatibility — always returns true.
   */
  async validateQrToken(outletId, tableId, qrToken) {
    return true;
  },

  /**
   * @deprecated QR codes are now static/permanent. No rotation needed.
   * Kept for backward compatibility — no-op.
   */
  async rotateQrToken(tableId) {
    return null;
  },

  // ========================
  // CART MANAGEMENT (Redis-first, DB fallback)
  // ========================

  /**
   * Save cart for a session. Primary store: Redis (fast). Fallback: DB.
   */
  async saveCart(session, cartItems) {
    const cartData = {
      items: cartItems,
      updatedAt: new Date().toISOString(),
    };

    // Redis primary (fast reads during rush hour)
    const cacheKey = `self_order:cart:${session.id}`;
    try {
      await cache.set(cacheKey, cartData, 7200); // 2 hours
    } catch (err) {
      logger.warn('Cart Redis save failed, using DB:', err.message);
    }

    // DB fallback (persistent)
    const pool = getPool();
    await pool.query(
      `INSERT INTO self_order_cart (session_id, outlet_id, table_id, cart_data)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE cart_data = VALUES(cart_data), updated_at = NOW()`,
      [session.id, session.outletId, session.tableId, JSON.stringify(cartData)]
    );

    return cartData;
  },

  /**
   * Get cart for a session. Redis-first, DB fallback.
   */
  async getCart(session) {
    // Try Redis first
    const cacheKey = `self_order:cart:${session.id}`;
    try {
      const cached = await cache.get(cacheKey);
      if (cached) return cached;
    } catch (err) {
      // Redis down — fall through to DB
    }

    // DB fallback
    const pool = getPool();
    const [[row]] = await pool.query(
      `SELECT cart_data FROM self_order_cart WHERE session_id = ?`,
      [session.id]
    );

    if (!row) return { items: [], updatedAt: null };

    const cartData = typeof row.cart_data === 'string' ? JSON.parse(row.cart_data) : row.cart_data;

    // Warm Redis cache
    try {
      await cache.set(cacheKey, cartData, 7200);
    } catch (_) {}

    return cartData;
  },

  /**
   * Clear cart for a session (after order placement)
   */
  async clearCart(sessionId) {
    const cacheKey = `self_order:cart:${sessionId}`;
    try { await cache.del(cacheKey); } catch (_) {}

    const pool = getPool();
    await pool.query(`DELETE FROM self_order_cart WHERE session_id = ?`, [sessionId]);
  },

  // ========================
  // PAST ORDERS (customer view)
  // ========================

  /**
   * Get all orders for a table within the current session or recent timeframe.
   * Optimized: single query with items subquery.
   */
  async getPastOrders(session, { limit = 10 } = {}) {
    const pool = getPool();

    // Get orders linked to this table from self-order sessions (current + recent)
    // Exclude 'pending' orders — not yet accepted by staff, should not appear in history
    const [orders] = await pool.query(
      `SELECT o.id, o.order_number, o.status, o.subtotal, o.tax_amount, o.total_amount,
              o.special_instructions, o.cancel_reason, o.created_at,
              o.self_order_session_id
       FROM orders o
       WHERE o.table_id = ? AND o.outlet_id = ? AND o.order_source = 'self_order'
         AND o.status != 'pending'
       ORDER BY o.created_at DESC
       LIMIT ?`,
      [session.tableId, session.outletId, limit]
    );

    if (orders.length === 0) return { orders: [] };

    // Batch fetch all items for these orders (single query)
    const orderIds = orders.map(o => o.id);
    const [allItems] = await pool.query(
      `SELECT oi.order_id, oi.id, oi.item_name, oi.variant_name, oi.quantity,
              oi.unit_price, oi.total_price, oi.status, oi.item_type, oi.special_instructions
       FROM order_items oi
       WHERE oi.order_id IN (?)
       ORDER BY oi.id`,
      [orderIds]
    );

    // Group items by order_id
    const itemsByOrder = new Map();
    for (const item of allItems) {
      if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
      itemsByOrder.get(item.order_id).push({
        id: item.id,
        name: item.item_name,
        variantName: item.variant_name,
        quantity: parseFloat(item.quantity),
        unitPrice: parseFloat(item.unit_price),
        totalPrice: parseFloat(item.total_price),
        status: item.status,
        itemType: item.item_type,
        specialInstructions: item.special_instructions,
      });
    }

    return {
      orders: orders.map(o => ({
        id: o.id,
        orderNumber: o.order_number,
        status: o.status,
        subtotal: parseFloat(o.subtotal),
        taxAmount: parseFloat(o.tax_amount),
        totalAmount: parseFloat(o.total_amount),
        cancelReason: o.cancel_reason,
        createdAt: o.created_at,
        isCurrentSession: o.self_order_session_id === session.id,
        items: itemsByOrder.get(o.id) || [],
      })),
    };
  },

  // ========================
  // SESSION COMPLETION + URL ROTATION
  // ========================

  /**
   * Complete a self-order session. Called when order is paid/completed.
   * QR codes are permanent — no rotation needed.
   */
  async completeSession(sessionId) {
    const pool = getPool();

    const [[session]] = await pool.query(
      `SELECT id, outlet_id, table_id, order_id, status FROM self_order_sessions WHERE id = ?`,
      [sessionId]
    );
    if (!session) return null;
    if (session.status === 'completed') return { alreadyCompleted: true };

    // Mark session completed with completion timestamp
    await pool.query(
      `UPDATE self_order_sessions SET status = 'completed', order_completed_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [sessionId]
    );

    // Clear cart
    await this.clearCart(sessionId);

    // QR codes are static/permanent — no rotation needed

    // Log
    this._logActivity(sessionId, session.outlet_id, session.table_id, 'session_completed', session.order_id).catch(() => {});

    return {
      sessionId,
      completed: true,
    };
  },

  // ========================
  // SMART SESSION EXPIRY
  // ========================

  /**
   * Check and expire sessions based on smart rules:
   * 1. Session without order: expires after idle_timeout_minutes (default 20)
   * 2. Session with active order: stays active (order status not completed/cancelled)
   * 3. Session after order completion: expires after completion_buffer_minutes (default 5)
   * 
   * This method is called:
   * - On initSession (to clean up before creating/resuming)
   * - By a scheduled job (cron) for background cleanup
   * - When order status changes to completed/cancelled
   */
  async expireIdleSessions(outletId = null, tableId = null) {
    const pool = getPool();
    
    let whereClause = `s.status IN ('active', 'ordering')`;
    const params = [];
    
    if (outletId) {
      whereClause += ` AND s.outlet_id = ?`;
      params.push(outletId);
    }
    if (tableId) {
      whereClause += ` AND s.table_id = ?`;
      params.push(tableId);
    }

    // Rule 1: Sessions without order that exceeded idle timeout (default 10 min)
    const expiredIdleCount = await pool.query(
      `UPDATE self_order_sessions s
       SET s.status = 'expired', s.updated_at = NOW()
       WHERE ${whereClause}
         AND s.order_id IS NULL
         AND s.created_at < NOW() - INTERVAL COALESCE(s.idle_timeout_minutes, 10) MINUTE`,
      params
    );

    // Rule 3: Sessions with completed/cancelled orders that exceeded buffer (default 1 min)
    const expiredCompletedCount = await pool.query(
      `UPDATE self_order_sessions s
       SET s.status = 'expired', s.updated_at = NOW()
       WHERE ${whereClause}
         AND s.order_completed_at IS NOT NULL
         AND s.order_completed_at < NOW() - INTERVAL COALESCE(s.completion_buffer_minutes, 1) MINUTE`,
      params
    );

    const totalExpired = (expiredIdleCount[0]?.affectedRows || 0) + (expiredCompletedCount[0]?.affectedRows || 0);
    
    if (totalExpired > 0) {
      logger.info(`Smart expiry: expired ${totalExpired} sessions (outlet: ${outletId || 'all'}, table: ${tableId || 'all'})`);
    }

    return { expiredCount: totalExpired };
  },

  /**
   * Mark session as order-completed (triggers completion buffer countdown)
   * Called when order status changes to completed/cancelled/paid
   */
  async markSessionOrderCompleted(orderId) {
    const pool = getPool();
    
    const [[order]] = await pool.query(
      `SELECT self_order_session_id FROM orders WHERE id = ?`,
      [orderId]
    );
    
    if (!order?.self_order_session_id) return null;

    await pool.query(
      `UPDATE self_order_sessions 
       SET order_completed_at = NOW(), updated_at = NOW()
       WHERE id = ? AND order_completed_at IS NULL`,
      [order.self_order_session_id]
    );

    logger.debug(`Session ${order.self_order_session_id} marked as order-completed for order ${orderId}`);
    return { sessionId: order.self_order_session_id, markedCompleted: true };
  },

  /**
   * Check if a session should be considered expired based on smart rules
   * Returns: { expired: boolean, reason: string }
   */
  async checkSessionExpiry(sessionId) {
    const pool = getPool();
    
    const [[session]] = await pool.query(
      `SELECT s.*, o.status as order_status
       FROM self_order_sessions s
       LEFT JOIN orders o ON s.order_id = o.id
       WHERE s.id = ?`,
      [sessionId]
    );

    if (!session) return { expired: true, reason: 'Session not found' };
    if (session.status === 'expired') return { expired: true, reason: 'Session already expired' };
    if (session.status === 'completed') return { expired: true, reason: 'Session completed' };

    // Rule 1: No order + exceeded idle timeout
    if (!session.order_id) {
      const idleTimeout = session.idle_timeout_minutes || 10;
      const createdAt = new Date(session.created_at);
      const now = new Date();
      const minutesElapsed = (now - createdAt) / (1000 * 60);
      
      if (minutesElapsed > idleTimeout) {
        return { expired: true, reason: `Idle timeout exceeded (${idleTimeout} minutes)` };
      }
    }

    // Rule 2: Active order → not expired
    if (session.order_id && !['paid', 'completed', 'cancelled'].includes(session.order_status)) {
      return { expired: false, reason: 'Order is active' };
    }

    // Rule 3: Order completed + exceeded buffer
    if (session.order_completed_at) {
      const bufferMinutes = session.completion_buffer_minutes || 1;
      const completedAt = new Date(session.order_completed_at);
      const now = new Date();
      const minutesElapsed = (now - completedAt) / (1000 * 60);
      
      if (minutesElapsed > bufferMinutes) {
        return { expired: true, reason: `Completion buffer exceeded (${bufferMinutes} minutes)` };
      }
    }

    return { expired: false, reason: 'Session is valid' };
  },
};

module.exports = selfOrderService;
