/**
 * Order Service
 * Core order management - create, items, status, modifications
 * This is the backbone of the POS system
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
const tableService = require('./table.service');
const menuEngineService = require('./menuEngine.service');
const taxService = require('./tax.service');
const { prefixImageUrl } = require('../utils/helpers');
const costSnapshotService = require('./costSnapshot.service');
const stockDeductionService = require('./stockDeduction.service');

// Order status flow
const ORDER_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  BILLED: 'billed',
  PAID: 'paid',
  CANCELLED: 'cancelled'
};

/**
 * Business day starts at this hour (IST). Orders before this hour belong to the previous business day.
 * E.g. 4 means: business day = 4:00 AM today → 3:59:59 AM tomorrow.
 */
const BUSINESS_DAY_START_HOUR = 4;

/**
 * Convert business-day date strings to actual datetime range for index-friendly WHERE.
 * For startDate=2026-04-11, endDate=2026-04-11:
 *   startDt = '2026-04-11 04:00:00' (4am April 11)
 *   endDt   = '2026-04-12 04:00:00' (4am April 12, exclusive)
 * This captures all orders from 4am April 11 to 3:59:59am April 12.
 */
function businessDayRange(startDate, endDate) {
  const h = String(BUSINESS_DAY_START_HOUR).padStart(2, '0') + ':00:00';
  const startDt = `${startDate} ${h}`;
  // endDate is inclusive, so the upper bound is the START of the NEXT day
  const ed = new Date(endDate + 'T00:00:00');
  ed.setDate(ed.getDate() + 1);
  const endStr = ed.getFullYear() + '-' + String(ed.getMonth() + 1).padStart(2, '0') + '-' + String(ed.getDate()).padStart(2, '0');
  const endDt = `${endStr} ${h}`;
  return { startDt, endDt };
}

const ITEM_STATUS = {
  PENDING: 'pending',
  SENT_TO_KITCHEN: 'sent_to_kitchen',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  CANCELLED: 'cancelled'
};

const orderService = {
  ORDER_STATUS,
  ITEM_STATUS,

  // ========================
  // CAPTAIN OWNERSHIP VERIFICATION
  // ========================

  /**
   * Verify if user can modify order (is session owner or admin/manager)
   */
  async verifyCaptainOwnership(orderId, userId, connection = null) {
    const pool = connection || getPool();
    
    const [order] = await pool.query(
      `SELECT o.table_session_id, o.order_type, ts.started_by 
       FROM orders o 
       LEFT JOIN table_sessions ts ON o.table_session_id = ts.id 
       WHERE o.id = ?`,
      [orderId]
    );
    
    if (!order[0]) throw new Error('Order not found');
    
    // Non dine-in orders don't have session ownership
    if (order[0].order_type !== 'dine_in' || !order[0].table_session_id) {
      return true;
    }
    
    // Check if user is admin/manager
    const [userRoles] = await pool.query(
      `SELECT r.slug as role_name FROM user_roles ur 
       JOIN roles r ON ur.role_id = r.id 
       WHERE ur.user_id = ? AND ur.is_active = 1`,
      [userId]
    );
    // Captains and cashiers can modify any order (no ownership restriction)
    const isPrivileged = userRoles.some(r => ['master', 'admin', 'manager', 'super_admin', 'cashier', 'captain'].includes(r.role_name));
    
    if (isPrivileged) return true;
    
    // For other roles, check if user is session owner
    const sessionOwnerId = parseInt(order[0].started_by, 10);
    const currentUserId = parseInt(userId, 10);
    
    if (sessionOwnerId !== currentUserId) {
      throw new Error('You do not have permission to modify this order.');
    }
    
    return true;
  },

  /**
   * Verify cashier password for post-bill order modifications.
   * Only users with cashier/manager/admin role can modify billed orders.
   * @param {object} cashierAuth - { cashierId, password }
   * @param {number} outletId - Outlet ID for validation
   * @param {object} [conn] - Optional DB connection
   * @returns {object} - { verified: true, cashierId, cashierName }
   */
  async _verifyCashierAuth(cashierAuth, outletId, conn = null) {
    const pool = conn || getPool();

    if (!cashierAuth || !cashierAuth.cashierId || !cashierAuth.password) {
      throw new Error('Cashier authentication required to modify a billed order. Provide cashierId and password.');
    }

    const { cashierId, password } = cashierAuth;

    // Get user with password hash and roles in parallel
    const [[users], [roles]] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.password_hash, u.is_active
         FROM users u
         WHERE u.id = ? AND u.is_active = 1`,
        [cashierId]
      ),
      pool.query(
        `SELECT r.slug FROM user_roles ur
         JOIN roles r ON ur.role_id = r.id
         WHERE ur.user_id = ? AND ur.is_active = 1`,
        [cashierId]
      )
    ]);

    if (!users[0]) {
      throw new Error('Cashier not found or inactive');
    }

    const user = users[0];

    // Verify fixed password for post-bill modifications (restaurant requirement)
    const FIXED_MODIFICATION_PASSWORD = '132564556';
    if (password !== FIXED_MODIFICATION_PASSWORD) {
      logger.warn(`Post-bill modification: Invalid password attempt for cashier ${cashierId} (${user.name})`);
      throw new Error('Invalid modification password');
    }

    const allowedRoles = ['cashier', 'manager', 'admin', 'super_admin', 'master'];
    const hasRole = roles.some(r => allowedRoles.includes(r.slug));
    if (!hasRole) {
      throw new Error('Only cashier, manager or admin can modify a billed order');
    }

    logger.info(`Post-bill modification authorized: cashier ${cashierId} (${user.name}) for outlet ${outletId}`);
    return { verified: true, cashierId: user.id, cashierName: user.name };
  },

  /**
   * Auto-void existing invoice for a billed order so it can be modified.
   * Called internally when cashier authenticates to modify a billed order.
   * @returns {number|null} - Cancelled invoice ID or null
   */
  async _voidInvoiceForModification(orderId, cashierId, conn) {
    // Find active (non-cancelled, unpaid) invoice
    const [invoices] = await conn.query(
      `SELECT i.id, i.invoice_number, i.payment_status
       FROM invoices i
       WHERE i.order_id = ? AND i.is_cancelled = 0
       ORDER BY i.id DESC LIMIT 1`,
      [orderId]
    );

    if (!invoices[0]) return null;

    const invoice = invoices[0];

    if (invoice.payment_status === 'paid') {
      throw new Error('Cannot modify order — invoice is already paid');
    }

    // Cancel the invoice
    await conn.query(
      `UPDATE invoices SET
        is_cancelled = 1, cancelled_at = NOW(), cancelled_by = ?,
        cancel_reason = 'Auto-voided for post-bill order modification'
       WHERE id = ?`,
      [cashierId, invoice.id]
    );

    // Revert order status to 'served' so modifications can proceed
    await conn.query(
      `UPDATE orders SET status = 'served' WHERE id = ? AND status = 'billed'`,
      [orderId]
    );

    logger.info(`Invoice ${invoice.invoice_number} (id=${invoice.id}) auto-voided for order ${orderId} modification by cashier ${cashierId}`);
    return invoice.id;
  },

  // ========================
  // ORDER CREATION
  // ========================

  /**
   * Generate unique order number
   */
  async generateOrderNumber(outletId, connection = null) {
    const db = connection || getPool();
    const today = new Date();
    const datePrefix = today.toISOString().slice(2, 10).replace(/-/g, '');
    const prefix = `ORD${datePrefix}`;
    
    const [result] = await db.query(
      `SELECT MAX(CAST(SUBSTRING(order_number, ?) AS UNSIGNED)) as max_seq
       FROM orders 
       WHERE outlet_id = ? AND order_number LIKE CONCAT(?, '%')`,
      [prefix.length + 1, outletId, prefix]
    );
    
    const seq = String((result[0].max_seq || 0) + 1).padStart(4, '0');
    return `${prefix}${seq}`;
  },

  /**
   * Create new order for table
   */
  async createOrder(data) {
    const pool = getPool();

    const {
      outletId, tableId, floorId, sectionId, orderType = 'dine_in',
      customerId, customerName, customerPhone, guestCount = 1,
      specialInstructions, createdBy
    } = data;

    // ── Pre-transaction validation (no connection held) ──
    let tableInfo = null;
    let existingSession = null;
    let isPrivileged = false;
    let needNewSession = false;

    if (tableId && orderType === 'dine_in') {
      // Parallel: table info + active session + user roles (all independent reads)
      const [tableResult, sessionResult, roleResult] = await Promise.all([
        pool.query(
          'SELECT id, table_number, name, status, floor_id, outlet_id FROM tables WHERE id = ? AND is_active = 1',
          [tableId]
        ),
        pool.query(
          'SELECT * FROM table_sessions WHERE table_id = ? AND status = \'active\' ORDER BY id DESC LIMIT 1',
          [tableId]
        ),
        pool.query(
          `SELECT r.slug as role_name FROM user_roles ur 
           JOIN roles r ON ur.role_id = r.id 
           WHERE ur.user_id = ? AND ur.is_active = 1`,
          [createdBy]
        )
      ]);

      tableInfo = tableResult[0][0] || null;
      existingSession = sessionResult[0][0] || null;
      const userRoles = roleResult[0];
      isPrivileged = userRoles.some(r => ['master', 'admin', 'manager', 'super_admin', 'cashier'].includes(r.role_name));

      if (existingSession) {
        if (existingSession.order_id) {
          // Check if existing order is terminal
          const [[existingOrder]] = await pool.query(
            'SELECT id, status, payment_status FROM orders WHERE id = ?',
            [existingSession.order_id]
          );
          const orderStatus = existingOrder?.status;
          const paymentStatus = existingOrder?.payment_status;

          if (['paid', 'completed', 'cancelled'].includes(orderStatus) || paymentStatus === 'paid') {
            needNewSession = true; // Will end old + create new inside transaction
          } else if (isPrivileged) {
            needNewSession = true; // Privileged user force-ends stuck session
          } else {
            throw new Error(`Table already has an active order (Order ID: ${existingSession.order_id}). Use existing order or end session first.`);
          }
        } else {
          // Session exists but no order — check ownership
          const sessionOwnerId = parseInt(existingSession.started_by, 10);
          const currentUserId = parseInt(createdBy, 10);

          if (sessionOwnerId !== currentUserId && !isPrivileged) {
            const [[sessionOwner]] = await pool.query('SELECT name FROM users WHERE id = ?', [sessionOwnerId]);
            const ownerName = sessionOwner?.name || `User ID ${sessionOwnerId}`;
            throw new Error(`This table session was started by ${ownerName}. Only they can create orders for this table, or contact a manager to transfer the table.`);
          }
          // Use existing session (will be linked inside transaction)
        }
      } else {
        // No session — will create inline inside transaction
        needNewSession = true;
      }
    }

    // ── Transaction: only writes + order number generation ──
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Generate order number (needs transaction for race-condition safety)
      const orderNumber = await this.generateOrderNumber(outletId, connection);
      const uuid = uuidv4();

      let tableSessionId = null;

      if (tableId && orderType === 'dine_in') {
        // Lock table row to serialize concurrent operations on same table
        await connection.query('SELECT id FROM tables WHERE id = ? FOR UPDATE', [tableId]);

        // Re-read session state under lock (pre-transaction read may be stale)
        const [sessionResult] = await connection.query(
          'SELECT * FROM table_sessions WHERE table_id = ? AND status = \'active\' ORDER BY id DESC LIMIT 1',
          [tableId]
        );
        const lockedSession = sessionResult[0] || null;
        let lockedNeedNewSession = false;

        if (lockedSession) {
          if (lockedSession.order_id) {
            const [[existingOrder]] = await connection.query(
              'SELECT id, status, payment_status FROM orders WHERE id = ?',
              [lockedSession.order_id]
            );
            const orderStatus = existingOrder?.status;
            const paymentStatus = existingOrder?.payment_status;
            if (['paid', 'completed', 'cancelled'].includes(orderStatus) || paymentStatus === 'paid') {
              lockedNeedNewSession = true;
            } else if (isPrivileged) {
              lockedNeedNewSession = true;
            } else {
              throw new Error(`Table already has an active order (Order ID: ${lockedSession.order_id}). Use existing order or end session first.`);
            }
          } else {
            const sessionOwnerId = parseInt(lockedSession.started_by, 10);
            const currentUserId = parseInt(createdBy, 10);
            if (sessionOwnerId !== currentUserId && !isPrivileged) {
              const [[sessionOwner]] = await connection.query('SELECT name FROM users WHERE id = ?', [sessionOwnerId]);
              const ownerName = sessionOwner?.name || `User ID ${sessionOwnerId}`;
              throw new Error(`This table session was started by ${ownerName}. Only they can create orders for this table, or contact a manager to transfer the table.`);
            }
          }
        } else {
          lockedNeedNewSession = true;
        }

        if (lockedNeedNewSession) {
          // End old session if it exists (inline — no nested transaction)
          if (lockedSession) {
            await connection.query(
              `UPDATE table_sessions SET status = 'completed', ended_at = NOW(), ended_by = ? WHERE id = ?`,
              [createdBy, lockedSession.id]
            );
          }
          // Create new session inline (avoid nested tableService.startSession transaction)
          const [sessionResult2] = await connection.query(
            `INSERT INTO table_sessions (table_id, guest_count, guest_name, guest_phone, started_by)
             VALUES (?, ?, ?, ?, ?)`,
            [tableId, guestCount, customerName || null, customerPhone || null, createdBy]
          );
          tableSessionId = sessionResult2.insertId;
          // Set table to occupied
          await connection.query('UPDATE tables SET status = \'occupied\' WHERE id = ?', [tableId]);
        } else if (lockedSession) {
          // Reuse existing session
          tableSessionId = lockedSession.id;
        }
      }

      // Create order
      const [result] = await connection.query(
        `INSERT INTO orders (
          uuid, outlet_id, order_number, order_type,
          table_id, table_session_id, floor_id, section_id,
          customer_id, customer_name, customer_phone, guest_count,
          status, payment_status, special_instructions, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)`,
        [
          uuid, outletId, orderNumber, orderType,
          tableId, tableSessionId, floorId, sectionId,
          customerId, customerName, customerPhone, guestCount,
          specialInstructions, createdBy
        ]
      );

      const orderId = result.insertId;

      // Link order to table session
      if (tableSessionId) {
        await connection.query(
          'UPDATE table_sessions SET order_id = ? WHERE id = ?',
          [orderId, tableSessionId]
        );
      }

      await connection.commit();

      // Lightweight inline read instead of heavy getById (already have most data)
      const [rows] = await pool.query(
        `SELECT o.*, t.table_number, t.name as table_name,
          f.name as floor_name, s.name as section_name,
          u.name as created_by_name
         FROM orders o
         LEFT JOIN tables t ON o.table_id = t.id
         LEFT JOIN floors f ON o.floor_id = f.id
         LEFT JOIN sections s ON o.section_id = s.id
         LEFT JOIN users u ON o.created_by = u.id
         WHERE o.id = ?`,
        [orderId]
      );
      const order = rows[0] || null;

      // Fire-and-forget: emit event + cache invalidation (don't block response)
      if (order) {
        this.emitOrderUpdate(outletId, order, 'order:created').catch(err =>
          logger.error('createOrder event emit error:', err.message)
        );
      }
      if (tableInfo && needNewSession) {
        tableService.invalidateCache(tableInfo.outlet_id, tableInfo.floor_id, tableId).catch(err =>
          logger.error('createOrder cache invalidation error:', err.message)
        );
        tableService.broadcastTableUpdate(tableInfo.outlet_id, tableInfo.floor_id, {
          tableId, tableNumber: tableInfo.table_number,
          event: 'session_started', captain: createdBy
        });
      }

      return order;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ========================
  // ORDER ITEMS
  // ========================

  /**
   * Add items to order (before sending KOT)
   * Items are staged locally, this stores them in DB with pending status
   */
  async addItems(orderId, items, createdBy, cashierAuth = null) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Use connection (not pool) to avoid snapshot visibility lag for recently created orders
      const [orderRows] = await connection.query(
        `SELECT o.*, t.table_number, t.name as table_name,
          f.name as floor_name, s.name as section_name,
          u.name as created_by_name
         FROM orders o
         LEFT JOIN tables t ON o.table_id = t.id
         LEFT JOIN floors f ON o.floor_id = f.id
         LEFT JOIN sections s ON o.section_id = s.id
         LEFT JOIN users u ON o.created_by = u.id
         WHERE o.id = ?`,
        [orderId]
      );
      const order = orderRows[0] || null;
      if (!order) throw new Error('Order not found');

      // Post-bill modification: require cashier password to modify billed orders
      if (order.status === 'billed') {
        await this._verifyCashierAuth(cashierAuth, order.outlet_id, connection);
        await this._voidInvoiceForModification(orderId, cashierAuth.cashierId, connection);
        // Order status is now 'served' — proceed normally
        order.status = 'served';
      } else if (order.status === 'paid' || order.status === 'completed' || order.status === 'cancelled') {
        throw new Error('Cannot add items to this order');
      }

      // Fetch user roles once (reused for ownership check + open item check)
      const hasOpenItems = items.some(i => i.isOpenItem);
      let cachedUserRoles = null;

      // Verify captain ownership for dine-in orders
      if (order.table_session_id && order.order_type === 'dine_in') {
        const [[sessionOwner], [userRoles]] = await Promise.all([
          connection.query(
            'SELECT started_by FROM table_sessions WHERE id = ?',
            [order.table_session_id]
          ),
          connection.query(
            `SELECT r.slug as role_name FROM user_roles ur 
             JOIN roles r ON ur.role_id = r.id 
             WHERE ur.user_id = ? AND ur.is_active = 1`,
            [createdBy]
          )
        ]);
        cachedUserRoles = userRoles;
        // Captains and cashiers can modify any order (no ownership restriction)
        const isPrivileged = userRoles.some(r => ['master', 'admin', 'manager', 'super_admin', 'cashier', 'captain'].includes(r.role_name));
        
        // Convert to numbers for comparison (handle type mismatch)
        const sessionOwnerId = parseInt(sessionOwner[0]?.started_by, 10);
        const currentUserId = parseInt(createdBy, 10);
        
        if (sessionOwner[0] && sessionOwnerId !== currentUserId && !isPrivileged) {
          throw new Error('You do not have permission to modify this order.');
        }
      } else if (hasOpenItems) {
        // Non-dine_in: only fetch roles if needed for open item check
        const [userRoles] = await connection.query(
          `SELECT r.slug as role_name FROM user_roles ur 
           JOIN roles r ON ur.role_id = r.id 
           WHERE ur.user_id = ? AND ur.is_active = 1`,
          [createdBy]
        );
        cachedUserRoles = userRoles;
      }

      const addedItems = [];
      const context = {
        floorId: order.floor_id,
        sectionId: order.section_id
      };

      // Reuse cached roles for open item permission check
      const creatorRolesCache = cachedUserRoles;

      for (const item of items) {
        const {
          itemId, variantId, quantity, addons = [],
          specialInstructions, isComplimentary = false, complimentaryReason,
          isOpenItem = false, openItemName, openItemPrice, weight = null,
          ingredients: openItemIngredients  // Optional: ad-hoc ingredients for stock deduction
        } = item;

        // ── OPEN ITEM FLOW ──────────────────────────
        if (isOpenItem) {
          // Role check: only cashier/manager/admin can add open items (pre-fetched)
          const allowedOpenItemRoles = ['cashier', 'manager', 'admin', 'super_admin', 'master'];
          if (!creatorRolesCache || !creatorRolesCache.some(r => allowedOpenItemRoles.includes(r.role_name || r.slug))) {
            throw new Error('Only cashier, manager or admin can add open items');
          }

          if (!openItemName || !openItemName.trim()) {
            throw new Error('Open item name is required');
          }
          if (openItemPrice === undefined || openItemPrice === null || parseFloat(openItemPrice) < 0) {
            throw new Error('Open item price must be 0 or greater');
          }

          // Fetch template item (for tax_group_id, item_type, category)
          const [templateRows] = await connection.query(
            `SELECT i.id, i.name, i.item_type, i.tax_group_id, i.category_id, i.is_open_item,
                    c.name as category_name
             FROM items i
             JOIN categories c ON i.category_id = c.id
             WHERE i.id = ? AND i.is_active = 1 AND i.deleted_at IS NULL`,
            [itemId]
          );
          if (!templateRows[0]) throw new Error(`Open item template ${itemId} not found`);
          const template = templateRows[0];

          const oiPrice = parseFloat(openItemPrice);
          const oiTotalPrice = oiPrice * quantity;
          const taxGroupId = template.tax_group_id;

          // Calculate tax using template's tax group (locked)
          let taxAmount = 0;
          let taxDetails = null;
          if (taxGroupId) {
            const taxResult = await taxService.calculateTax(
              [{ price: oiPrice, quantity }],
              taxGroupId
            );
            taxAmount = taxResult.taxAmount;
            taxDetails = taxResult.breakdown;
          }

          // Insert open item into order_items
          const oiWeight = weight && weight.trim() ? weight.trim() : null;
          const [itemResult] = await connection.query(
            `INSERT INTO order_items (
              order_id, item_id, variant_id, item_name, variant_name, item_type,
              quantity, weight, unit_price, base_price, tax_amount, total_price,
              tax_group_id, tax_details, special_instructions,
              status, is_complimentary, complimentary_reason, is_open_item, created_by
            ) VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?)`,
            [
              orderId, itemId, openItemName.trim(), template.item_type,
              quantity, oiWeight, oiPrice, oiPrice, taxAmount, oiTotalPrice,
              taxGroupId, JSON.stringify(taxDetails), specialInstructions,
              isComplimentary, complimentaryReason, createdBy
            ]
          );

          const orderItemId = itemResult.insertId;

          // Optional stock deduction: if cashier provided ingredients, deduct stock
          let stockResult = null;
          if (openItemIngredients && Array.isArray(openItemIngredients) && openItemIngredients.length > 0) {
            stockResult = await stockDeductionService.deductForOpenItemIngredients(connection, {
              orderId, orderItemId, outletId: order.outlet_id, userId: createdBy,
              orderQuantity: quantity, ingredients: openItemIngredients
            });
          }

          logger.info(`[OPEN-ITEM] Added: "${openItemName.trim()}" price=${oiPrice} qty=${quantity} template=${template.name}(id=${itemId}) taxGroup=${taxGroupId} ingredients=${openItemIngredients?.length || 0} stockDeducted=${!!stockResult} by user ${createdBy} to order ${orderId}`);

          addedItems.push({
            id: orderItemId,
            itemId,
            itemName: openItemName.trim(),
            variantId: null,
            variantName: null,
            quantity,
            weight: oiWeight,
            unitPrice: oiPrice,
            totalPrice: oiTotalPrice,
            taxAmount,
            status: 'pending',
            isOpenItem: true,
            templateName: template.name,
            addons: [],
            stockDeducted: !!stockResult,
            ingredientCount: stockResult?.ingredientCount || 0
          });
          continue;
        }

        // ── REGULAR ITEM FLOW ───────────────────────
        // Get item details with effective price
        const itemDetails = await menuEngineService.getItemForOrder(itemId, context);
        if (!itemDetails) throw new Error(`Item ${itemId} not found`);

        // Determine price
        let unitPrice, basePrice;
        let variantName = null;
        let taxGroupId = itemDetails.tax_group_id;
        let taxEnabled = itemDetails.tax_enabled !== 0 && itemDetails.tax_enabled !== false;

        if (variantId) {
          const variant = itemDetails.variants?.find(v => v.id === variantId);
          if (!variant) throw new Error(`Variant ${variantId} not found`);
          unitPrice = variant.effectivePrice || variant.price;
          basePrice = variant.price;
          variantName = variant.name;
          if (variant.tax_group_id) taxGroupId = variant.tax_group_id;
          // Variant can override item's tax_enabled setting
          if (variant.tax_enabled !== undefined && variant.tax_enabled !== null) {
            taxEnabled = variant.tax_enabled !== 0 && variant.tax_enabled !== false;
          }
        } else {
          unitPrice = itemDetails.effectivePrice || itemDetails.base_price;
          basePrice = itemDetails.base_price;
        }

        // Calculate addon total — batch fetch all addons in one query
        let addonTotal = 0;
        let addonDetails = [];
        if (addons.length > 0) {
          const [addonRows] = await connection.query(
            'SELECT a.*, ag.name as group_name FROM addons a JOIN addon_groups ag ON a.addon_group_id = ag.id WHERE a.id IN (?)',
            [addons]
          );
          addonDetails = addonRows;
          for (const addon of addonRows) {
            addonTotal += parseFloat(addon.price);
          }
        }

        const totalUnitPrice = unitPrice + addonTotal;
        const totalPrice = totalUnitPrice * quantity;

        // Calculate tax (only if tax is enabled for this item)
        let taxAmount = 0;
        let taxDetails = null;
        if (taxGroupId && taxEnabled) {
          const taxResult = await taxService.calculateTax(
            [{ price: totalUnitPrice, quantity }],
            taxGroupId
          );
          taxAmount = taxResult.taxAmount;
          taxDetails = taxResult.breakdown;
        }

        // Insert order item
        const [itemResult] = await connection.query(
          `INSERT INTO order_items (
            order_id, item_id, variant_id, item_name, variant_name, item_type,
            quantity, unit_price, base_price, tax_amount, total_price,
            tax_group_id, tax_details, special_instructions,
            status, is_complimentary, complimentary_reason, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [
            orderId, itemId, variantId, itemDetails.name, variantName, itemDetails.item_type,
            quantity, totalUnitPrice, basePrice, taxAmount, totalPrice,
            taxGroupId, JSON.stringify(taxDetails), specialInstructions,
            isComplimentary, complimentaryReason, createdBy
          ]
        );

        const orderItemId = itemResult.insertId;

        // Batch insert addons (single query instead of N sequential inserts)
        if (addonDetails.length > 0) {
          const addonValues = addonDetails.map(addon => 
            [orderItemId, addon.id, addon.addon_group_id, addon.name, addon.group_name, 1, addon.price, addon.price]
          );
          await connection.query(
            `INSERT INTO order_item_addons (
              order_item_id, addon_id, addon_group_id, addon_name, addon_group_name,
              quantity, unit_price, total_price
            ) VALUES ?`,
            [addonValues]
          );
        }

        // Snapshot making cost at order time (for accurate historical reports)
        await costSnapshotService.snapshotOrderItemCost(connection, {
          orderId, orderItemId, itemId, variantId, quantity, outletId: order.outlet_id
        });

        // Deduct stock from inventory (FIFO batch deduction + movements)
        await stockDeductionService.deductForOrderItem(connection, {
          orderId, orderItemId, itemId, variantId, quantity, outletId: order.outlet_id, userId: createdBy
        });

        addedItems.push({
          id: orderItemId,
          itemId,
          itemName: itemDetails.name,
          variantId,
          variantName,
          quantity,
          unitPrice: totalUnitPrice,
          totalPrice,
          taxAmount,
          status: 'pending',
          addons: addonDetails.map(a => ({ id: a.id, name: a.name, price: a.price }))
        });
      }

      // Recalculate order totals
      await this.recalculateTotals(orderId, connection);

      await connection.commit();

      // Lightweight order read after commit (replaces heavy getById with 4 JOINs)
      const [updatedRows] = await pool.query(
        `SELECT o.*, t.table_number, t.name as table_name,
          f.name as floor_name, s.name as section_name,
          u.name as created_by_name
         FROM orders o
         LEFT JOIN tables t ON o.table_id = t.id
         LEFT JOIN floors f ON o.floor_id = f.id
         LEFT JOIN sections s ON o.section_id = s.id
         LEFT JOIN users u ON o.created_by = u.id
         WHERE o.id = ?`,
        [orderId]
      );
      const updatedOrder = updatedRows[0] || null;

      // Fire-and-forget: emit update (don't block response)
      if (updatedOrder) {
        this.emitOrderUpdate(order.outlet_id, updatedOrder, 'order:items_added')
          .catch(err => logger.error('addItems emit error:', err.message));
      }

      return { order: updatedOrder, addedItems };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Recalculate order totals
   * NC items are excluded from subtotal - only chargeable items count
   * Tax is calculated AFTER discount is applied (GST/VAT compliance)
   */
  async recalculateTotals(orderId, connection = null) {
    const pool = connection || getPool();

    // Fetch items + discounts in parallel (items include id for discount lookup)
    const [[orderItems], [discountRows]] = await Promise.all([
      pool.query(
        `SELECT id, total_price, tax_amount, tax_details, is_nc, nc_amount
         FROM order_items WHERE order_id = ? AND status != 'cancelled'`,
        [orderId]
      ),
      pool.query(
        `SELECT id, discount_type, discount_value, discount_amount, applied_on, order_item_id
         FROM order_discounts WHERE order_id = ?`,
        [orderId]
      )
    ]);

    // Build in-memory item lookup (eliminates N+1 per-discount queries)
    const itemById = {};
    let subtotal = 0;
    let ncAmount = 0;
    const itemsWithTax = [];

    for (const item of orderItems) {
      const itemTotal = parseFloat(item.total_price) || 0;
      itemById[item.id] = { total_price: itemTotal, is_nc: !!item.is_nc };
      
      if (item.is_nc) {
        ncAmount += parseFloat(item.nc_amount || item.total_price) || 0;
        continue;
      }

      subtotal += itemTotal;

      if (item.tax_details) {
        const taxDetails = typeof item.tax_details === 'string' 
          ? JSON.parse(item.tax_details) 
          : item.tax_details;
        if (Array.isArray(taxDetails) && taxDetails.length > 0) {
          itemsWithTax.push({ amount: itemTotal, taxDetails });
        }
      }
    }

    // Recalculate discounts using in-memory item data (zero DB queries in this loop)
    let totalDiscountAmount = 0;
    const discountUpdates = [];
    for (const discount of discountRows) {
      let newDiscountAmount = parseFloat(discount.discount_amount) || 0;
      
      if (discount.discount_type === 'percentage') {
        const discountValue = parseFloat(discount.discount_value) || 0;
        
        if (discount.applied_on === 'item' && discount.order_item_id) {
          // Item-level discount - lookup from in-memory map (was N+1 DB query)
          const itemData = itemById[discount.order_item_id];
          if (itemData && !itemData.is_nc) {
            newDiscountAmount = (itemData.total_price * discountValue) / 100;
          } else {
            newDiscountAmount = 0;
          }
        } else {
          newDiscountAmount = (subtotal * discountValue) / 100;
        }
        
        newDiscountAmount = Math.min(newDiscountAmount, subtotal - totalDiscountAmount);
        newDiscountAmount = Math.max(0, newDiscountAmount);
        newDiscountAmount = parseFloat(newDiscountAmount.toFixed(2));
        
        // Batch discount updates (execute after loop)
        if (Math.abs(newDiscountAmount - (parseFloat(discount.discount_amount) || 0)) > 0.01) {
          discountUpdates.push(pool.query(
            'UPDATE order_discounts SET discount_amount = ? WHERE id = ?',
            [newDiscountAmount, discount.id]
          ));
        }
      } else {
        newDiscountAmount = Math.min(newDiscountAmount, subtotal - totalDiscountAmount);
        newDiscountAmount = Math.max(0, newDiscountAmount);
      }
      
      totalDiscountAmount += newDiscountAmount;
    }
    // Execute all discount updates in parallel
    if (discountUpdates.length > 0) await Promise.all(discountUpdates);

    // Calculate taxable amount after discount
    const taxableAmount = Math.max(0, subtotal - totalDiscountAmount);
    
    // Calculate discount ratio for proportional tax distribution
    const discountRatio = subtotal > 0 ? (taxableAmount / subtotal) : 1;

    // Recalculate tax on the TAXABLE AMOUNT (after discount)
    let totalTax = 0;
    for (const itemData of itemsWithTax) {
      const itemTaxableAmount = itemData.amount * discountRatio;
      for (const tax of itemData.taxDetails) {
        const rate = parseFloat(tax.rate) || 0;
        totalTax += (itemTaxableAmount * rate) / 100;
      }
    }
    totalTax = parseFloat(totalTax.toFixed(2));

    // Calculate total: taxableAmount + tax (NC already excluded from subtotal)
    const preRoundTotal = taxableAmount + totalTax;
    const totalAmount = Math.round(preRoundTotal);
    const roundOff = totalAmount - preRoundTotal;

    // Update order with NC amount tracked separately
    await pool.query(
      `UPDATE orders SET 
        subtotal = ?, discount_amount = ?, tax_amount = ?,
        round_off = ?, total_amount = ?, nc_amount = ?, updated_at = NOW()
       WHERE id = ?`,
      [subtotal, totalDiscountAmount, totalTax, roundOff, totalAmount, ncAmount, orderId]
    );
  },

  // ========================
  // ORDER RETRIEVAL
  // ========================

  async getById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT o.*, t.table_number, t.name as table_name,
        f.name as floor_name, s.name as section_name,
        u.name as created_by_name,
        CASE 
          WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount)
          ELSE o.total_amount
        END as display_amount
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN sections s ON o.section_id = s.id
       LEFT JOIN users u ON o.created_by = u.id
       WHERE o.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async getByUuid(uuid) {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM orders WHERE uuid = ?', [uuid]);
    return rows[0] ? await this.getById(rows[0].id) : null;
  },

  async getOrderWithItems(orderId) {
    const pool = getPool();
    
    // Get comprehensive order details with all joins
    const [orderRows] = await pool.query(
      `SELECT o.*,
        t.table_number, t.name as table_name, t.capacity as table_capacity,
        f.id as floor_id, f.name as floor_name,
        s.name as section_name,
        uc.id as created_by_id, uc.name as created_by_name, uc.email as created_by_email,
        cust.id as cust_id, cust.name as customer_name_db, cust.phone as customer_phone_db, 
        cust.email as customer_email, cust.gstin as customer_gstin,
        ol.name as outlet_name, ol.gstin as outlet_gstin, ol.fssai_number as outlet_fssai,
        ol.address_line1 as outlet_address, ol.city as outlet_city, ol.state as outlet_state
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN sections s ON o.section_id = s.id
       LEFT JOIN users uc ON o.created_by = uc.id
       LEFT JOIN customers cust ON o.customer_id = cust.id
       LEFT JOIN outlets ol ON o.outlet_id = ol.id
       WHERE o.id = ?`,
      [orderId]
    );
    
    if (!orderRows[0]) return null;
    const order = orderRows[0];

    // Run ALL 7 queries in parallel (items, discounts, payments, invoice, KOTs, addons, splits)
    // Addons & splits use subqueries so they don't depend on prior results
    const [
      [items],
      [discounts],
      [payments],
      [invoiceRows],
      kotRows,
      allAddons,
      allSplits
    ] = await Promise.all([
      pool.query(
        `SELECT oi.*, 
          i.short_name, i.image_url, i.item_type,
          ks.name as station_name, ks.station_type,
          c.name as counter_name,
          cat.name as category_name
         FROM order_items oi
         LEFT JOIN items i ON oi.item_id = i.id
         LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
         LEFT JOIN counters c ON i.counter_id = c.id
         LEFT JOIN categories cat ON i.category_id = cat.id
         WHERE oi.order_id = ? 
         ORDER BY oi.created_at`,
        [orderId]
      ),
      pool.query(
        `SELECT od.*, u.name as approved_by_name, uc.name as created_by_name
         FROM order_discounts od
         LEFT JOIN users u ON od.approved_by = u.id
         LEFT JOIN users uc ON od.created_by = uc.id
         WHERE od.order_id = ?`,
        [orderId]
      ),
      pool.query(
        `SELECT p.*, u.name as received_by_name
         FROM payments p
         LEFT JOIN users u ON p.received_by = u.id
         WHERE p.order_id = ? 
         ORDER BY p.created_at DESC`,
        [orderId]
      ),
      pool.query(
        `SELECT i.*, u.name as generated_by_name
         FROM invoices i
         LEFT JOIN users u ON i.generated_by = u.id
         WHERE i.order_id = ? AND i.is_cancelled = 0
         ORDER BY i.created_at DESC LIMIT 1`,
        [orderId]
      ),
      pool.query(
        `SELECT kt.id, kt.kot_number, kt.status, kt.station_id, kt.created_at,
          ks.name as station_name
         FROM kot_tickets kt
         LEFT JOIN kitchen_stations ks ON kt.station_id = ks.id
         WHERE kt.order_id = ?
         ORDER BY kt.created_at DESC`,
        [orderId]
      ).then(([rows]) => rows).catch(() => []),
      // Addons via subquery (no dependency on items result)
      pool.query(
        `SELECT oia.* FROM order_item_addons oia
         WHERE oia.order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
        [orderId]
      ).then(([rows]) => rows),
      // Split breakdowns via subquery (no dependency on payments result)
      pool.query(
        `SELECT sp.* FROM split_payments sp
         WHERE sp.payment_id IN (SELECT id FROM payments WHERE order_id = ? AND payment_mode = 'split')`,
        [orderId]
      ).then(([rows]) => rows)
    ]);

    // Build addons map from parallel-fetched results
    let addonsMap = {};
    for (const addon of allAddons) {
      if (!addonsMap[addon.order_item_id]) addonsMap[addon.order_item_id] = [];
      addonsMap[addon.order_item_id].push({
        id: addon.id,
        addonId: addon.addon_id,
        addonName: addon.addon_name,
        quantity: addon.quantity,
        unitPrice: parseFloat(addon.unit_price) || 0,
        totalPrice: parseFloat(addon.total_price) || 0
      });
    }

    // Build split map from parallel-fetched results
    let splitMap = {};
    for (const sp of allSplits) {
      if (!splitMap[sp.payment_id]) splitMap[sp.payment_id] = [];
      splitMap[sp.payment_id].push({
        id: sp.id,
        paymentMode: sp.payment_mode,
        amount: parseFloat(sp.amount) || 0,
        transactionId: sp.transaction_id,
        referenceNumber: sp.reference_number,
        cardLastFour: sp.card_last_four,
        cardType: sp.card_type,
        upiId: sp.upi_id,
        walletProvider: sp.wallet_provider,
        notes: sp.notes
      });
    }

    // Calculate tax breakdown from items
    let cgstAmount = 0, sgstAmount = 0, igstAmount = 0, vatAmount = 0, cessAmount = 0;
    const taxBreakup = {};
    
    // Format items with parsed tax details and aggregate tax breakdown
    const formattedItems = items.map(item => {
      if (item.status === 'cancelled') {
        return null; // Skip cancelled items for tax calculation
      }
      
      let taxDetails = null;
      if (item.tax_details) {
        try {
          taxDetails = typeof item.tax_details === 'string' ? JSON.parse(item.tax_details) : item.tax_details;
          
          // Aggregate tax breakdown — skip NC items (NC items have zero tax)
          if (Array.isArray(taxDetails) && !item.is_nc) {
            for (const tax of taxDetails) {
              const taxCode = tax.componentCode || tax.code || tax.componentName || tax.name || 'TAX';
              const taxName = tax.componentName || tax.name || taxCode;
              const taxAmt = parseFloat(tax.amount) || 0;
              const taxRate = parseFloat(tax.rate) || 0;
              const itemTotal = parseFloat(item.total_price) || 0;
              
              // Add to tax breakup (composite key to separate same code at different rates)
              const breakupKey = taxCode + '@' + taxRate;
              if (!taxBreakup[breakupKey]) {
                taxBreakup[breakupKey] = {
                  name: taxName,
                  rate: taxRate,
                  taxableAmount: 0,
                  taxAmount: 0
                };
              }
              taxBreakup[breakupKey].taxableAmount += itemTotal;
              taxBreakup[breakupKey].taxAmount += taxAmt;
              
              // Categorize by tax type
              const codeUpper = taxCode.toUpperCase();
              if (codeUpper.includes('CGST')) {
                cgstAmount += taxAmt;
              } else if (codeUpper.includes('SGST')) {
                sgstAmount += taxAmt;
              } else if (codeUpper.includes('IGST')) {
                igstAmount += taxAmt;
              } else if (codeUpper.includes('VAT')) {
                vatAmount += taxAmt;
              } else if (codeUpper.includes('CESS')) {
                cessAmount += taxAmt;
              }
            }
          }
        } catch (e) { /* ignore */ }
      }
      return {
        id: item.id,
        itemId: item.item_id,
        itemName: item.item_name,
        shortName: item.short_name,
        variantId: item.variant_id,
        variantName: item.variant_name,
        itemType: item.item_type,
        categoryName: item.category_name,
        quantity: parseFloat(item.quantity) || 0,
        unitPrice: parseFloat(item.unit_price) || 0,
        totalPrice: parseFloat(item.total_price) || 0,
        taxAmount: parseFloat(item.tax_amount) || 0,
        taxDetails,
        status: item.status,
        kotStatus: item.kot_status,
        specialInstructions: item.special_instructions,
        stationName: item.station_name,
        stationType: item.station_type,
        counterName: item.counter_name,
        imageUrl: prefixImageUrl(item.image_url),
        addons: addonsMap[item.id] || [],
        isNC: !!item.is_nc,
        ncAmount: parseFloat(item.nc_amount) || 0,
        ncReason: item.nc_reason || null,
        isOpenItem: !!item.is_open_item,
        weight: item.weight || null,
        createdAt: item.created_at,
        updatedAt: item.updated_at
      };
    }).filter(Boolean); // Remove null entries (cancelled items)

    // Apply discount ratio to tax amounts (same as billing.service.js)
    const subtotalForRatio = parseFloat(order.subtotal) || 0;
    const discountAmountForRatio = parseFloat(order.discount_amount) || 0;
    const discountRatio = subtotalForRatio > 0 ? ((subtotalForRatio - discountAmountForRatio) / subtotalForRatio) : 1;
    
    // Adjust tax amounts for discount
    cgstAmount = parseFloat((cgstAmount * discountRatio).toFixed(2));
    sgstAmount = parseFloat((sgstAmount * discountRatio).toFixed(2));
    igstAmount = parseFloat((igstAmount * discountRatio).toFixed(2));
    vatAmount = parseFloat((vatAmount * discountRatio).toFixed(2));
    cessAmount = parseFloat((cessAmount * discountRatio).toFixed(2));
    
    // Adjust taxBreakup for discount
    for (const key of Object.keys(taxBreakup)) {
      taxBreakup[key].taxableAmount = parseFloat((taxBreakup[key].taxableAmount * discountRatio).toFixed(2));
      taxBreakup[key].taxAmount = parseFloat((taxBreakup[key].taxAmount * discountRatio).toFixed(2));
    }
    
    const formattedDiscounts = discounts.map(d => ({
      id: d.id,
      discountId: d.discount_id,
      discountCode: d.discount_code,
      discountName: d.discount_name,
      discountType: d.discount_type,
      discountValue: parseFloat(d.discount_value) || 0,
      discountAmount: parseFloat(d.discount_amount) || 0,
      appliedOn: d.applied_on || 'subtotal',
      orderItemId: d.order_item_id,
      approvedBy: d.approved_by,
      approvedByName: d.approved_by_name,
      createdBy: d.created_by,
      createdByName: d.created_by_name,
      createdAt: d.created_at
    }));

    // Format payments with pre-fetched split breakdowns
    const formattedPayments = payments.map(payment => {
      const formatted = {
        id: payment.id,
        invoiceId: payment.invoice_id,
        paymentMode: payment.payment_mode,
        amount: parseFloat(payment.amount) || 0,
        tipAmount: parseFloat(payment.tip_amount) || 0,
        totalAmount: parseFloat(payment.total_amount) || 0,
        status: payment.status,
        transactionId: payment.transaction_id,
        referenceNumber: payment.reference_number,
        cardLastFour: payment.card_last_four,
        cardType: payment.card_type,
        upiId: payment.upi_id,
        walletProvider: payment.wallet_provider,
        receivedBy: payment.received_by,
        receivedByName: payment.received_by_name,
        isAdjustment: !!payment.is_adjustment,
        adjustmentAmount: parseFloat(payment.adjustment_amount) || 0,
        isDueCollection: !!payment.is_due_collection,
        notes: payment.notes,
        createdAt: payment.created_at
      };
      if (payment.payment_mode === 'split') {
        formatted.splitBreakdown = splitMap[payment.id] || [];
      }
      return formatted;
    });

    // Format invoice
    let invoice = null;
    if (invoiceRows[0]) {
      const inv = invoiceRows[0];
      let taxBreakup = null;
      if (inv.tax_breakup) {
        try {
          taxBreakup = typeof inv.tax_breakup === 'string' ? JSON.parse(inv.tax_breakup) : inv.tax_breakup;
        } catch (e) { /* ignore */ }
      }
      let hsnSummary = null;
      if (inv.hsn_summary) {
        try {
          hsnSummary = typeof inv.hsn_summary === 'string' ? JSON.parse(inv.hsn_summary) : inv.hsn_summary;
        } catch (e) { /* ignore */ }
      }
      
      invoice = {
        id: inv.id,
        uuid: inv.uuid,
        invoiceNumber: inv.invoice_number,
        invoiceDate: inv.invoice_date,
        invoiceTime: inv.invoice_time,
        subtotal: parseFloat(inv.subtotal) || 0,
        discountAmount: parseFloat(inv.discount_amount) || 0,
        taxableAmount: parseFloat(inv.taxable_amount) || 0,
        cgstAmount: parseFloat(inv.cgst_amount) || 0,
        sgstAmount: parseFloat(inv.sgst_amount) || 0,
        igstAmount: parseFloat(inv.igst_amount) || 0,
        vatAmount: parseFloat(inv.vat_amount) || 0,
        cessAmount: parseFloat(inv.cess_amount) || 0,
        totalTax: parseFloat(inv.total_tax) || 0,
        serviceCharge: parseFloat(inv.service_charge) || 0,
        packagingCharge: parseFloat(inv.packaging_charge) || 0,
        deliveryCharge: parseFloat(inv.delivery_charge) || 0,
        roundOff: parseFloat(inv.round_off) || 0,
        grandTotal: parseFloat(inv.grand_total) || 0,
        amountInWords: inv.amount_in_words,
        paymentStatus: inv.payment_status,
        taxBreakup,
        hsnSummary,
        isInterstate: !!inv.is_interstate,
        isAdjustment: (parseFloat(inv.adjustment_amount) || 0) > 0,
        adjustmentAmount: parseFloat(inv.adjustment_amount) || 0,
        paidAmount: parseFloat(inv.paid_amount) || 0,
        dueAmount: parseFloat(inv.due_amount) || 0,
        generatedBy: inv.generated_by,
        generatedByName: inv.generated_by_name,
        notes: inv.notes,
        createdAt: inv.created_at
      };
    }

    const kots = kotRows;

    // Calculate totals and summary
    const totalDiscount = formattedDiscounts.reduce((sum, d) => sum + d.discountAmount, 0);
    const totalPaid = formattedPayments.filter(p => p.status === 'completed').reduce((sum, p) => sum + p.totalAmount, 0);
    // Use invoice grandTotal (reflects NC deduction) if available, else order total_amount
    const effectiveTotal = invoice ? parseFloat(invoice.grandTotal) : (parseFloat(order.total_amount) || 0);
    const adjustmentAmt = parseFloat(order.adjustment_amount) || 0;
    const balanceDue = effectiveTotal - totalPaid - adjustmentAmt;

    // Build comprehensive response
    return {
      // Order basic info
      id: order.id,
      uuid: order.uuid,
      orderNumber: order.order_number,
      orderType: order.order_type,
      status: order.status,
      paymentStatus: order.payment_status,
      isPriority: !!order.is_priority,
      
      // Table & Location
      tableId: order.table_id,
      tableNumber: order.table_number,
      tableName: order.table_name,
      tableCapacity: order.table_capacity,
      floorId: order.floor_id,
      floorName: order.floor_name,
      sectionId: order.section_id,
      sectionName: order.section_name,
      
      // Customer info
      customerId: order.customer_id || order.customer_id,
      customerName: order.customer_name || order.customer_name_db,
      customerPhone: order.customer_phone || order.customer_phone_db,
      customerEmail: order.customer_email,
      customerGstin: order.customer_gstin,
      guestCount: order.guest_count,
      
      // Financial summary
      subtotal: parseFloat(order.subtotal) || 0,
      taxAmount: parseFloat(order.tax_amount) || 0,
      discountAmount: parseFloat(order.discount_amount) || 0,
      serviceCharge: parseFloat(order.service_charge) || 0,
      packagingCharge: parseFloat(order.packaging_charge) || 0,
      deliveryCharge: parseFloat(order.delivery_charge) || 0,
      roundOff: parseFloat(order.round_off) || 0,
      totalAmount: parseFloat(order.total_amount) || 0,
      paidAmount: parseFloat(order.paid_amount) || 0,
      dueAmount: parseFloat(order.due_amount) || 0,
      isAdjustment: !!order.is_adjustment,
      adjustmentAmount: parseFloat(order.adjustment_amount) || 0,
      
      // NC (No Charge) info
      isNC: !!order.is_nc,
      ncAmount: parseFloat(order.nc_amount) || 0,
      ncReason: order.nc_reason || null,
      
      // Tax breakdown (calculated from items)
      cgstAmount: parseFloat(cgstAmount.toFixed(2)),
      sgstAmount: parseFloat(sgstAmount.toFixed(2)),
      igstAmount: parseFloat(igstAmount.toFixed(2)),
      vatAmount: parseFloat(vatAmount.toFixed(2)),
      cessAmount: parseFloat(cessAmount.toFixed(2)),
      totalTax: parseFloat((cgstAmount + sgstAmount + igstAmount + vatAmount + cessAmount).toFixed(2)),
      taxBreakup,
      
      // Calculated fields
      totalDiscount,
      totalPaid,
      balanceDue: balanceDue > 0 ? balanceDue : 0,
      
      // Staff info
      createdBy: {
        id: order.created_by_id,
        name: order.created_by_name,
        email: order.created_by_email
      },
      captainId: order.captain_id,
      
      // Outlet info
      outletId: order.outlet_id,
      outletName: order.outlet_name,
      outletGstin: order.outlet_gstin,
      outletFssai: order.outlet_fssai,
      outletAddress: order.outlet_address,
      outletCity: order.outlet_city,
      outletState: order.outlet_state,
      
      // Order notes
      notes: order.notes,
      kitchenNotes: order.kitchen_notes,
      
      // Timestamps
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      
      // Related data
      items: formattedItems,
      discounts: formattedDiscounts,
      payments: formattedPayments,
      invoice,
      kots: kots.map(k => ({
        id: k.id,
        kotNumber: k.kot_number,
        status: k.status,
        stationId: k.station_id,
        stationName: k.station_name,
        createdAt: k.created_at
      })),
      
      // Item counts
      itemCount: formattedItems.length,
      totalQuantity: formattedItems.reduce((sum, i) => sum + (i.quantity || 0), 0),
      
      // Snake_case aliases for backward compatibility with billing/other services
      outlet_id: order.outlet_id,
      order_type: order.order_type,
      table_id: order.table_id,
      floor_id: order.floor_id,
      section_id: order.section_id,
      customer_id: order.customer_id,
      customer_name: order.customer_name || order.customer_name_db,
      customer_phone: order.customer_phone || order.customer_phone_db,
      customer_email: order.customer_email,
      customer_gstin: order.customer_gstin,
      customer_company_name: order.customer_company_name,
      customer_gst_state: order.customer_gst_state,
      customer_gst_state_code: order.customer_gst_state_code,
      is_interstate: order.is_interstate,
      subtotal: parseFloat(order.subtotal) || 0,
      tax_amount: parseFloat(order.tax_amount) || 0,
      discount_amount: parseFloat(order.discount_amount) || 0,
      service_charge: parseFloat(order.service_charge) || 0,
      packaging_charge: parseFloat(order.packaging_charge) || 0,
      delivery_charge: parseFloat(order.delivery_charge) || 0,
      total_amount: parseFloat(order.total_amount) || 0,
      created_by: order.created_by
    };
  },

  /**
   * Get active orders for outlet
   */
  async getActiveOrders(outletId, filters = {}) {
    const pool = getPool();
    // Step 1: Fetch orders (fast, uses indexes, no GROUP BY)
    let query = `
      SELECT o.*, t.table_number, t.name as table_name,
        f.name as floor_name, s.name as section_name
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN floors f ON o.floor_id = f.id
      LEFT JOIN sections s ON o.section_id = s.id
      WHERE o.outlet_id = ? AND o.status NOT IN ('paid', 'completed', 'cancelled')
        AND NOT (o.order_source = 'self_order' AND o.status = 'pending')
    `;
    const params = [outletId];

    if (filters.floorId) {
      query += ' AND o.floor_id = ?';
      params.push(filters.floorId);
    } else if (filters.floorIds && filters.floorIds.length > 0) {
      query += ` AND o.floor_id IN (${filters.floorIds.map(() => '?').join(',')})`;
      params.push(...filters.floorIds);
    }
    if (filters.status) {
      query += ' AND o.status = ?';
      params.push(filters.status);
    }
    if (filters.tableId) {
      query += ' AND o.table_id = ?';
      params.push(filters.tableId);
    }
    if (filters.createdBy) {
      query += ' AND o.created_by = ?';
      params.push(filters.createdBy);
    }

    query += ' ORDER BY o.is_priority DESC, o.created_at DESC';

    const [orders] = await pool.query(query, params);

    // Step 2: Batch-fetch item counts for these orders only (avoids GROUP BY on full join)
    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const [itemStats] = await pool.query(
        `SELECT order_id,
           COUNT(CASE WHEN status != 'cancelled' THEN 1 END) as item_count,
           COUNT(CASE WHEN status = 'ready' THEN 1 END) as ready_count
         FROM order_items WHERE order_id IN (?)
         GROUP BY order_id`,
        [orderIds]
      );
      const statsMap = {};
      for (const s of itemStats) statsMap[s.order_id] = s;
      for (const o of orders) {
        const s = statsMap[o.id];
        o.item_count = s ? Number(s.item_count) : 0;
        o.ready_count = s ? Number(s.ready_count) : 0;
      }
    }

    return orders;
  },

  /**
   * Get pending takeaway orders for cashier
   * Returns takeaway orders that are not yet paid/completed/cancelled
   * Supports search, pagination, sorting, and status filtering
   */
  async getPendingTakeawayOrders(outletId, filters = {}) {
    const pool = getPool();
    const {
      search, sortBy = 'created_at', sortOrder = 'DESC',
      status, startDate, endDate, cashierId, userRoles = []
    } = filters;
    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit) || 20));
    const offset = (page - 1) * limit;

    const allowedSort = ['created_at', 'order_number', 'total_amount', 'status'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'created_at';
    const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let whereClause = `WHERE o.outlet_id = ? AND o.order_type = 'takeaway'`;
    const params = [outletId];

    // Cashier-wise filtering: cashiers only see their own takeaway orders
    // Admins, managers, super_admins can see all orders
    const privilegedRoles = ['master', 'super_admin', 'admin', 'manager'];
    const isPrivileged = userRoles.some(r => privilegedRoles.includes(r));
    if (cashierId && !isPrivileged) {
      whereClause += ` AND o.created_by = ?`;
      params.push(cashierId);
    }

    // Status filter: 'pending' (active/not paid), 'completed', 'cancelled', 'all'
    if (status === 'completed') {
      whereClause += ` AND o.status IN ('paid', 'completed')`;
    } else if (status === 'cancelled') {
      whereClause += ` AND o.status = 'cancelled'`;
    } else if (status === 'all') {
      // no additional filter
    } else {
      // Default: pending (all active non-finished orders)
      whereClause += ` AND o.status NOT IN ('paid', 'completed', 'cancelled')`;
    }

    // Date range filter (business hours: 4am to 4am)
    if (startDate && endDate) {
      const { startDt, endDt } = businessDayRange(startDate, endDate);
      whereClause += ` AND o.created_at >= ? AND o.created_at < ?`;
      params.push(startDt, endDt);
    } else if (startDate) {
      const { startDt } = businessDayRange(startDate, startDate);
      whereClause += ` AND o.created_at >= ?`;
      params.push(startDt);
    } else if (endDate) {
      const { endDt } = businessDayRange(endDate, endDate);
      whereClause += ` AND o.created_at < ?`;
      params.push(endDt);
    }

    if (search) {
      whereClause += ` AND (o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR i.token_number LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    // Step 1: Parallel fetch — count + orders (fast, uses indexes on orders table)
    const dataQuery = `SELECT o.*,
        u.name as created_by_name,
        i.id as invoice_id, i.invoice_number, i.token_number, i.grand_total as invoice_total, i.payment_status as invoice_payment_status
       FROM orders o
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN invoices i ON i.order_id = o.id AND i.is_cancelled = 0
       ${whereClause}
       ORDER BY o.is_priority DESC, o.${safeSortBy} ${safeSortOrder}
       LIMIT ? OFFSET ?`;

    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT o.id) as total FROM orders o LEFT JOIN invoices i ON i.order_id = o.id AND i.is_cancelled = 0 ${whereClause}`, params),
      pool.query(dataQuery, [...params, limit, offset])
    ]);
    const total = countResult[0][0].total;
    const orders = dataResult[0];

    // Step 2: Batch-fetch item stats for only the returned orders (avoids full order_items scan)
    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const [itemStats] = await pool.query(
        `SELECT oi.order_id,
           COUNT(CASE WHEN oi.status != 'cancelled' THEN 1 END) as item_count,
           COUNT(CASE WHEN oi.status = 'ready' THEN 1 END) as ready_count,
           GROUP_CONCAT(DISTINCT CASE WHEN oi.status != 'cancelled' THEN oi.item_name END SEPARATOR ', ') as item_summary,
           COUNT(CASE WHEN oi.is_nc = 1 AND oi.status != 'cancelled' THEN 1 END) as nc_item_count,
           COALESCE(SUM(CASE WHEN oi.is_nc = 1 AND oi.status != 'cancelled' THEN oi.total_price ELSE 0 END), 0) as computed_nc_amount
         FROM order_items oi
         WHERE oi.order_id IN (?)
         GROUP BY oi.order_id`,
        [orderIds]
      );
      const statsMap = {};
      for (const s of itemStats) statsMap[s.order_id] = s;
      for (const o of orders) {
        const s = statsMap[o.id];
        o.item_count = s ? Number(s.item_count) : 0;
        o.ready_count = s ? Number(s.ready_count) : 0;
        o.item_summary = s ? s.item_summary : null;
        o.nc_item_count = s ? Number(s.nc_item_count) : 0;
        o.computed_nc_amount = s ? Number(s.computed_nc_amount) : 0;
      }
    }

    return {
      data: orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  },

  /**
   * Get detailed takeaway order by ID — deep detail with items, KOTs, discounts, payments, invoice
   */
  async getTakeawayOrderDetail(orderId) {
    const pool = getPool();

    // 1. Core order info
    const order = await this.getById(orderId);
    if (!order) throw new Error('Order not found');

    // 2. All items with addons, station info
    const [items] = await pool.query(
      `SELECT oi.*,
        i.short_name, i.image_url, i.tags as item_tags,
        CASE WHEN oi.is_open_item = 1 THEN oi.item_name ELSE COALESCE(i.name, oi.item_name) END as display_name,
        ks.name as station_name, ks.station_type,
        c.name as counter_name,
        v.name as catalog_variant_name,
        u_cancel.name as cancelled_by_name
       FROM order_items oi
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN variants v ON oi.variant_id = v.id
       LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
       LEFT JOIN counters c ON i.counter_id = c.id
       LEFT JOIN users u_cancel ON oi.cancelled_by = u_cancel.id
       WHERE oi.order_id = ?
       ORDER BY oi.created_at`,
      [orderId]
    );

    // Batch-load addons
    const itemIds = items.map(i => i.id);
    let addonsMap = {};
    if (itemIds.length > 0) {
      const [allAddons] = await pool.query(
        'SELECT * FROM order_item_addons WHERE order_item_id IN (?)',
        [itemIds]
      );
      for (const addon of allAddons) {
        if (!addonsMap[addon.order_item_id]) addonsMap[addon.order_item_id] = [];
        addonsMap[addon.order_item_id].push({
          id: addon.id,
          addonName: addon.addon_name,
          addonGroupName: addon.addon_group_name || null,
          quantity: addon.quantity,
          unitPrice: parseFloat(addon.unit_price) || 0,
          totalPrice: parseFloat(addon.total_price) || 0
        });
      }
    }

    // Format items
    const formattedItems = items.map(it => ({
      id: it.id,
      itemId: it.item_id,
      itemName: it.display_name || it.item_name,
      shortName: it.is_open_item ? (it.item_name || it.short_name) : (it.short_name || null),
      variantName: it.catalog_variant_name || it.variant_name || null,
      imageUrl: prefixImageUrl(it.image_url),
      quantity: it.quantity,
      unitPrice: parseFloat(it.unit_price) || 0,
      totalPrice: parseFloat(it.total_price) || 0,
      status: it.status,
      itemType: it.item_type || null,
      tags: it.item_tags || null,
      isOpenItem: !!it.is_open_item,
      weight: it.weight || null,
      stationName: it.station_name || null,
      stationType: it.station_type || null,
      counterName: it.counter_name || null,
      specialInstructions: it.special_instructions || null,
      taxDetails: it.tax_details ? (typeof it.tax_details === 'string' ? JSON.parse(it.tax_details) : it.tax_details) : null,
      isNc: !!it.is_nc,
      ncReason: it.nc_reason || null,
      cancelledBy: it.cancelled_by || null,
      cancelledByName: it.cancelled_by_name || null,
      cancelReason: it.cancel_reason || null,
      cancelledAt: it.cancelled_at || null,
      addons: addonsMap[it.id] || [],
      createdAt: it.created_at
    }));

    const activeItems = formattedItems.filter(i => i.status !== 'cancelled');
    const cancelledItems = formattedItems.filter(i => i.status === 'cancelled');

    // Compute NC from actual item data (orders table is_nc/nc_amount may not be updated)
    const ncItems = activeItems.filter(i => i.isNc);
    const computedNcAmount = ncItems.reduce((s, i) => s + i.totalPrice, 0);
    const computedIsNc = ncItems.length > 0;
    const ncReasons = [...new Set(ncItems.map(i => i.ncReason).filter(Boolean))];
    const computedNcReason = ncReasons.length > 0 ? ncReasons.join(', ') : null;

    // 3. KOTs with items
    const [kots] = await pool.query(
      `SELECT kt.*,
        u_created.name as created_by_name,
        u_served.name as served_by_name
       FROM kot_tickets kt
       LEFT JOIN users u_created ON kt.created_by = u_created.id
       LEFT JOIN users u_served ON kt.served_by = u_served.id
       WHERE kt.order_id = ?
       ORDER BY kt.created_at`,
      [orderId]
    );

    const kotIds = kots.map(k => k.id);
    let kotItemsMap = {};
    if (kotIds.length > 0) {
      const [allKotItems] = await pool.query(
        `SELECT ki.*, oi.item_name, oi.unit_price, oi.status as order_item_status
         FROM kot_items ki
         LEFT JOIN order_items oi ON ki.order_item_id = oi.id
         WHERE ki.kot_id IN (?)
         ORDER BY ki.id`,
        [kotIds]
      );
      for (const ki of allKotItems) {
        if (!kotItemsMap[ki.kot_id]) kotItemsMap[ki.kot_id] = [];
        kotItemsMap[ki.kot_id].push({
          id: ki.id,
          orderItemId: ki.order_item_id,
          itemName: ki.item_name || ki.item_name,
          quantity: ki.quantity,
          unitPrice: parseFloat(ki.unit_price) || 0,
          status: ki.status,
          orderItemStatus: ki.order_item_status || null,
          specialInstructions: ki.special_instructions || null
        });
      }
    }

    const formattedKots = kots.map(k => {
      const kotItems = kotItemsMap[k.id] || [];
      return {
        id: k.id,
        kotNumber: k.kot_number,
        station: k.station,
        status: k.status,
        itemCount: kotItems.filter(i => i.status !== 'cancelled').length,
        cancelledCount: kotItems.filter(i => i.status === 'cancelled').length,
        items: kotItems,
        createdBy: k.created_by,
        createdByName: k.created_by_name || null,
        servedBy: k.served_by || null,
        servedByName: k.served_by_name || null,
        servedAt: k.served_at || null,
        readyAt: k.ready_at || null,
        createdAt: k.created_at
      };
    });

    // 4. Discounts
    const [discounts] = await pool.query(
      `SELECT od.*, u.name as created_by_name
       FROM order_discounts od
       LEFT JOIN users u ON od.created_by = u.id
       WHERE od.order_id = ?
       ORDER BY od.created_at`,
      [orderId]
    );

    const formattedDiscounts = discounts.map(d => ({
      id: d.id,
      discountName: d.discount_name,
      discountType: d.discount_type,
      discountValue: parseFloat(d.discount_value) || 0,
      discountAmount: parseFloat(d.discount_amount) || 0,
      discountCode: d.discount_code || null,
      appliedOn: d.applied_on || 'subtotal',
      approvedBy: d.approved_by || null,
      approvalReason: d.approval_reason || null,
      createdBy: d.created_by,
      createdByName: d.created_by_name || null,
      createdAt: d.created_at
    }));

    // 5. Payments with split breakdown
    const [payments] = await pool.query(
      `SELECT p.*, u.name as received_by_name
       FROM payments p
       LEFT JOIN users u ON p.received_by = u.id
       WHERE p.order_id = ?
       ORDER BY p.created_at`,
      [orderId]
    );

    // Fetch split payment breakdown for split payments
    for (const payment of payments) {
      if (payment.payment_mode === 'split') {
        const [splitDetails] = await pool.query(
          'SELECT * FROM split_payments WHERE payment_id = ?',
          [payment.id]
        );
        payment.splitBreakdown = splitDetails.map(sp => ({
          id: sp.id,
          paymentMode: sp.payment_mode,
          amount: parseFloat(sp.amount) || 0,
          referenceNumber: sp.reference_number || null,
          transactionId: sp.transaction_id || null,
          cardLastFour: sp.card_last_four || null,
          cardType: sp.card_type || null,
          upiId: sp.upi_id || null,
          walletName: sp.wallet_name || null,
          bankName: sp.bank_name || null
        }));
      }
    }

    const formattedPayments = payments.map(p => ({
      id: p.id,
      paymentNumber: p.payment_number,
      paymentMode: p.payment_mode,
      amount: parseFloat(p.amount) || 0,
      tipAmount: parseFloat(p.tip_amount) || 0,
      totalAmount: parseFloat(p.total_amount) || 0,
      status: p.status,
      transactionId: p.transaction_id || null,
      referenceNumber: p.reference_number || null,
      cardLastFour: p.card_last_four || null,
      cardType: p.card_type || null,
      upiId: p.upi_id || null,
      walletName: p.wallet_name || null,
      bankName: p.bank_name || null,
      receivedBy: p.received_by,
      receivedByName: p.received_by_name || null,
      splitBreakdown: p.splitBreakdown || null,
      createdAt: p.created_at
    }));

    // 6. Invoice
    const [invoices] = await pool.query(
      `SELECT * FROM invoices WHERE order_id = ? AND is_cancelled = 0 LIMIT 1`,
      [orderId]
    );
    const inv = invoices[0];
    const invoice = inv ? {
      id: inv.id,
      invoiceNumber: inv.invoice_number,
      tokenNumber: inv.token_number || null,
      subtotal: parseFloat(inv.subtotal) || 0,
      discountAmount: parseFloat(inv.discount_amount) || 0,
      taxableAmount: parseFloat(inv.taxable_amount) || 0,
      cgst: parseFloat(inv.cgst) || 0,
      sgst: parseFloat(inv.sgst) || 0,
      totalTax: parseFloat(inv.total_tax) || 0,
      serviceCharge: parseFloat(inv.service_charge) || 0,
      packagingCharge: parseFloat(inv.packaging_charge) || 0,
      deliveryCharge: parseFloat(inv.delivery_charge) || 0,
      roundOff: parseFloat(inv.round_off) || 0,
      grandTotal: parseFloat(inv.grand_total) || 0,
      amountInWords: inv.amount_in_words || null,
      paymentStatus: inv.payment_status,
      createdAt: inv.created_at
    } : null;

    // 7. Summary
    const totalPaid = formattedPayments.reduce((s, p) => s + p.totalAmount, 0);
    const orderTotal = invoice ? invoice.grandTotal : (parseFloat(order.total_amount) || 0);
    const dueAmount = Math.max(0, orderTotal - totalPaid);
    const totalDiscount = formattedDiscounts.reduce((s, d) => s + d.discountAmount, 0);

    const kotStatusCounts = {};
    for (const k of formattedKots) {
      kotStatusCounts[k.status] = (kotStatusCounts[k.status] || 0) + 1;
    }

    const itemStatusCounts = {};
    for (const i of formattedItems) {
      itemStatusCounts[i.status] = (itemStatusCounts[i.status] || 0) + 1;
    }

    return {
      order: {
        id: order.id,
        uuid: order.uuid,
        orderNumber: order.order_number,
        orderType: order.order_type,
        status: order.status,
        paymentStatus: order.payment_status,
        customerName: order.customer_name || null,
        customerPhone: order.customer_phone || null,
        customerAddress: order.customer_address || null,
        isPriority: !!order.is_priority,
        notes: order.notes || null,
        subtotal: parseFloat(order.subtotal) || 0,
        discountAmount: parseFloat(order.discount_amount) || 0,
        taxAmount: parseFloat(order.tax_amount) || 0,
        totalAmount: parseFloat(order.total_amount) || 0,
        paidAmount: parseFloat(order.paid_amount) || 0,
        dueAmount: parseFloat(order.due_amount) || 0,
        isNc: computedIsNc,
        ncAmount: parseFloat(computedNcAmount.toFixed(2)),
        ncReason: computedNcReason,
        ncItemCount: ncItems.length,
        createdBy: order.created_by,
        createdByName: order.created_by_name || null,
        createdAt: order.created_at,
        updatedAt: order.updated_at
      },
      items: {
        active: activeItems,
        cancelled: cancelledItems,
        activeCount: activeItems.length,
        cancelledCount: cancelledItems.length,
        totalCount: formattedItems.length,
        statusBreakdown: itemStatusCounts
      },
      kots: {
        list: formattedKots,
        totalCount: formattedKots.length,
        statusBreakdown: kotStatusCounts
      },
      discounts: {
        list: formattedDiscounts,
        totalCount: formattedDiscounts.length,
        totalDiscount: parseFloat(totalDiscount.toFixed(2))
      },
      payments: {
        list: formattedPayments,
        totalCount: formattedPayments.length,
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        dueAmount: parseFloat(dueAmount.toFixed(2)),
        orderTotal: parseFloat(orderTotal.toFixed(2))
      },
      invoice
    };
  },

  /**
   * Get orders by table
   */
  async getByTable(tableId) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT * FROM orders 
       WHERE table_id = ? AND status NOT IN ('paid', 'completed', 'cancelled')
       ORDER BY created_at DESC`,
      [tableId]
    );
    return rows;
  },

  // ========================
  // ORDER STATUS
  // ========================

  async updateStatus(orderId, status, userId) {
    const pool = getPool();
    const order = await this.getById(orderId);
    if (!order) throw new Error('Order not found');

    const updates = { status, updated_by: userId };

    if (status === 'cancelled') {
      updates.cancelled_by = userId;
      updates.cancelled_at = new Date();
    } else if (status === 'billed') {
      updates.billed_by = userId;
      updates.billed_at = new Date();
    }

    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(orderId);

    await pool.query(`UPDATE orders SET ${fields} WHERE id = ?`, values);

    const updatedOrder = await this.getById(orderId);
    await this.emitOrderUpdate(order.outlet_id, updatedOrder, 'order:status_changed');

    return updatedOrder;
  },

  // ========================
  // ITEM MODIFICATIONS
  // ========================

  /**
   * Update item quantity (before KOT sent)
   */
  async updateItemQuantity(orderItemId, newQuantity, userId) {
    const pool = getPool();

    const [items] = await pool.query(
      'SELECT * FROM order_items WHERE id = ?',
      [orderItemId]
    );
    if (!items[0]) throw new Error('Order item not found');

    const item = items[0];

    // Only allow if item is still pending
    if (item.status !== 'pending') {
      throw new Error('Cannot modify item after KOT sent. Use cancel instead.');
    }

    // Recalculate totals
    const totalPrice = item.unit_price * newQuantity;
    let taxAmount = 0;
    let taxDetails = null;

    if (item.tax_group_id && item.tax_details) {
      const taxResult = await taxService.calculateTax(
        [{ price: item.unit_price, quantity: newQuantity }],
        item.tax_group_id
      );
      taxAmount = taxResult.taxAmount;
      taxDetails = taxResult.breakdown || null;
    }

    await pool.query(
      `UPDATE order_items SET quantity = ?, total_price = ?, tax_amount = ?, tax_details = ? WHERE id = ?`,
      [newQuantity, totalPrice, taxAmount, taxDetails ? JSON.stringify(taxDetails) : null, orderItemId]
    );

    // Recalculate order totals
    await this.recalculateTotals(item.order_id);

    const order = await this.getOrderWithItems(item.order_id);
    await this.emitOrderUpdate(order.outlet_id, order, 'order:item_modified');

    return order;
  },

  /**
   * Cancel order item
   */
  async cancelItem(orderItemId, data, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [items] = await connection.query(
        `SELECT oi.*, o.outlet_id, o.status as order_status, o.order_number, o.table_id,
          t.table_number, kt.kot_number, kt.station as kot_station,
          (SELECT COUNT(*) FROM invoices inv WHERE inv.order_id = o.id AND inv.is_cancelled = 0) as has_invoice
         FROM order_items oi
         JOIN orders o ON oi.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         LEFT JOIN kot_tickets kt ON oi.kot_id = kt.id
         WHERE oi.id = ?`,
        [orderItemId]
      );
      if (!items[0]) throw new Error('Order item not found');

      const item = items[0];
      const { reason, reasonId, quantity, approvedBy, stockAction, cashierAuth } = data;

      // Post-bill modification: require cashier password to cancel items on billed orders
      if (item.order_status === 'billed') {
        await this._verifyCashierAuth(cashierAuth, item.outlet_id, connection);
        await this._voidInvoiceForModification(item.order_id, cashierAuth.cashierId, connection);
        item.order_status = 'served';
        item.has_invoice = 0;
      } else if (['billing', 'paid', 'completed', 'cancelled'].includes(item.order_status)) {
        throw new Error('Cannot cancel items after bill is generated or order is completed');
      }

      // Extra safety: Block if invoice exists (skip if we just voided it above)
      if (item.has_invoice > 0) {
        throw new Error('Cannot cancel items after bill has been generated');
      }

      // Check if cancellation requires approval (after preparation started)
      const requiresApproval = ['preparing', 'ready'].includes(item.status);
      if (requiresApproval && !approvedBy) {
        throw new Error('Manager approval required to cancel prepared items');
      }

      // Full or partial cancel
      const cancelQuantity = quantity || item.quantity;
      const isFullCancel = cancelQuantity >= item.quantity;

      // Determine stock action BEFORE updating item (need original created_at + kot_id)
      let stockDecision = { action: 'none', auto: true, reason: 'No stock deducted' };
      if (item.stock_deducted) {
        stockDecision = await stockDeductionService.determineCancelStockAction(
          connection, item, stockAction || null
        );
      }

      if (isFullCancel) {
        await connection.query(
          `UPDATE order_items SET 
            status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(),
            cancel_reason = ?, cancel_quantity = ?
           WHERE id = ?`,
          [userId, reason, cancelQuantity, orderItemId]
        );
      } else {
        // Partial cancel - reduce quantity and recalculate tax
        const newQuantity = item.quantity - cancelQuantity;
        const newTotal = item.unit_price * newQuantity;
        
        // Recalculate tax for new quantity (only if item originally had tax)
        let newTaxAmount = 0;
        let newTaxDetails = null;
        if (item.tax_group_id && item.tax_details) {
          const taxResult = await taxService.calculateTax(
            [{ price: item.unit_price, quantity: newQuantity }],
            item.tax_group_id
          );
          newTaxAmount = taxResult.taxAmount;
          newTaxDetails = taxResult.breakdown || null;
        }

        await connection.query(
          `UPDATE order_items SET 
            quantity = ?, total_price = ?, tax_amount = ?, tax_details = ?, cancel_quantity = ?
           WHERE id = ?`,
          [newQuantity, newTotal, newTaxAmount, newTaxDetails ? JSON.stringify(newTaxDetails) : null, cancelQuantity, orderItemId]
        );
      }

      // Log cancellation with stock_action
      await connection.query(
        `INSERT INTO order_cancel_logs (
          order_id, order_item_id, cancel_type, original_quantity,
          cancelled_quantity, reason_id, reason_text, stock_action, stock_action_auto, approved_by, cancelled_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.order_id, orderItemId,
          isFullCancel ? 'full_item' : 'quantity_reduce',
          item.quantity, cancelQuantity, reasonId, reason,
          stockDecision.action, stockDecision.auto ? 1 : 0,
          approvedBy, userId
        ]
      );

      // Update KOT item status if item was sent to kitchen
      let kotCancelled = false;
      let kotData = null;
      
      if (isFullCancel && item.kot_id) {
        await connection.query(
          `UPDATE kot_items SET status = 'cancelled' WHERE order_item_id = ?`,
          [orderItemId]
        );
        
        // Get KOT details for real-time event
        const [kotDetails] = await connection.query(
          `SELECT kt.*, o.order_number, o.table_id, t.table_number
           FROM kot_tickets kt
           JOIN orders o ON kt.order_id = o.id
           LEFT JOIN tables t ON o.table_id = t.id
           WHERE kt.id = ?`,
          [item.kot_id]
        );
        kotData = kotDetails[0];
        
        // Check if all items in the KOT are cancelled, update KOT status
        const [kotItems] = await connection.query(
          `SELECT COUNT(*) as total, 
                  SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
           FROM kot_items WHERE kot_id = ?`,
          [item.kot_id]
        );
        
        if (kotItems[0] && Number(kotItems[0].total) > 0 && Number(kotItems[0].total) === Number(kotItems[0].cancelled)) {
          await connection.query(
            `UPDATE kot_tickets SET status = 'cancelled' WHERE id = ?`,
            [item.kot_id]
          );
          kotCancelled = true;
        }
      }

      // Handle stock based on decision: REVERSE or WASTAGE
      if (item.stock_deducted) {
        if (stockDecision.action === 'reverse') {
          // REVERSE: Restore stock to original batches
          if (isFullCancel) {
            await stockDeductionService.reverseForOrderItem(connection, {
              orderItemId, outletId: item.outlet_id, userId, reason: reason || 'Item cancelled'
            });
          } else {
            await stockDeductionService.partialReverseForOrderItem(connection, {
              orderItemId, outletId: item.outlet_id, userId,
              reason: reason || 'Quantity reduced',
              cancelQuantity, originalQuantity: item.quantity
            });
          }
        } else if (stockDecision.action === 'wastage') {
          // WASTAGE: Stock stays deducted, record as spoilage/wastage
          if (isFullCancel) {
            await stockDeductionService.recordWastageForCancelledItem(connection, {
              orderItemId, orderId: item.order_id, outletId: item.outlet_id, userId,
              reason: reason || 'Item cancelled (wastage)'
            });
          } else {
            await stockDeductionService.recordWastageForPartialCancel(connection, {
              orderItemId, orderId: item.order_id, outletId: item.outlet_id, userId,
              reason: reason || 'Quantity reduced (wastage)',
              cancelQuantity, originalQuantity: item.quantity
            });
          }
        }
        logger.info(`Cancel item ${orderItemId}: stock_action=${stockDecision.action} (auto=${stockDecision.auto}), reason: ${stockDecision.reason}`);
      }

      // Update cost snapshot for quantity change
      if (item.stock_deducted || !isFullCancel) {
        const newQty = isFullCancel ? 0 : (item.quantity - cancelQuantity);
        if (newQty > 0) {
          // Recalculate cost snapshot for reduced quantity
          await connection.query(
            `UPDATE order_item_costs SET 
              making_cost = ROUND(making_cost * ? / ?, 2),
              selling_price = ROUND(selling_price * ? / ?, 2),
              profit = ROUND(selling_price * ? / ? - making_cost * ? / ?, 2)
             WHERE order_item_id = ?`,
            [newQty, item.quantity, newQty, item.quantity, newQty, item.quantity, newQty, item.quantity, orderItemId]
          );
        }
      }

      // Recalculate order totals
      await this.recalculateTotals(item.order_id, connection);

      await connection.commit();

      const order = await this.getOrderWithItems(item.order_id);
      await this.emitOrderUpdate(item.outlet_id, order, 'order:item_cancelled');

      // Emit KOT event to kitchen for real-time update
      if (item.kot_id && kotData) {
        const kotService = require('./kot.service');
        const updatedKot = await kotService.getKotById(item.kot_id);
        
        if (kotCancelled) {
          // Entire KOT was cancelled
          await kotService.emitKotUpdate(item.outlet_id, updatedKot, 'kot:cancelled');
        } else {
          // Single item cancelled - kitchen needs to know
          await kotService.emitKotUpdate(item.outlet_id, {
            ...updatedKot,
            cancelledItem: {
              orderItemId: orderItemId,
              itemName: item.item_name,
              quantity: cancelQuantity,
              reason: reason
            }
          }, 'kot:item_cancelled');
        }
      }

      // Print cancel slip to kitchen printer
      try {
        const printerService = require('./printer.service');
        const kotService = require('./kot.service');
        // Resolve user name for cancel slip
        const [[cancelUser]] = await pool.query('SELECT name FROM users WHERE id = ?', [userId]);
        const cancelledByName = cancelUser?.name || 'Staff';
        const cancelSlipData = {
          outletId: item.outlet_id,
          orderId: item.order_id,
          orderNumber: item.order_number,
          tableNumber: item.table_number || 'Takeaway',
          kotNumber: item.kot_number || null,
          station: item.kot_station || 'kitchen',
          time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          reason: reason,
          cancelledBy: cancelledByName,
          items: [{
            itemName: item.item_name,
            variantName: item.variant_name,
            quantity: cancelQuantity,
            itemType: item.item_type || null
          }]
        };

        // All printing goes through the bridge queue — no direct TCP printing
        await printerService.printCancelSlip(cancelSlipData, userId);
      } catch (printError) {
        logger.error('Failed to print cancel slip:', printError.message);
      }

      return order;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Cancel entire order
   */
  async cancelOrder(orderId, data, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const order = await this.getById(orderId);
      if (!order) throw new Error('Order not found');

      const { reason, reasonId, approvedBy, stockAction } = data;

      // Check if order can be cancelled - block after bill is generated
      if (['billing', 'billed', 'paid', 'completed', 'cancelled'].includes(order.status)) {
        throw new Error('Order cannot be cancelled after bill is generated or when completed/cancelled');
      }

      // Extra safety: Check if invoice exists for this order
      const [invoiceCheck] = await connection.query(
        `SELECT COUNT(*) as count FROM invoices WHERE order_id = ? AND is_cancelled = 0`,
        [orderId]
      );
      if (invoiceCheck[0].count > 0) {
        throw new Error('Order cannot be cancelled after bill has been generated');
      }

      // Requires approval if order has prepared items
      const [preparedItems] = await connection.query(
        `SELECT COUNT(*) as count FROM order_items 
         WHERE order_id = ? AND status IN ('preparing', 'ready', 'served')`,
        [orderId]
      );
      
      // if (preparedItems[0].count > 0 && !approvedBy) {
      //   throw new Error('Manager approval required to cancel order with prepared items');
      // }

      // Get all active KOTs for this order before cancelling (for kitchen notification)
      const [activeKots] = await connection.query(
        `SELECT kt.*, o.table_id, t.table_number 
         FROM kot_tickets kt
         JOIN orders o ON kt.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE kt.order_id = ? AND kt.status NOT IN ('served', 'cancelled')`,
        [orderId]
      );

      // Get all order items with stock deducted for per-item stock action decisions
      const [stockItems] = await connection.query(
        `SELECT oi.*, kt.id as kot_id_resolved
         FROM order_items oi
         LEFT JOIN kot_tickets kt ON oi.kot_id = kt.id
         WHERE oi.order_id = ? AND oi.status != 'cancelled' AND oi.stock_deducted = 1`,
        [orderId]
      );

      // Determine stock action for each item BEFORE cancellation
      const itemStockDecisions = [];
      for (const si of stockItems) {
        const decision = await stockDeductionService.determineCancelStockAction(
          connection, si, stockAction || null
        );
        itemStockDecisions.push({ item: si, decision });
      }

      // Cancel all items
      await connection.query(
        `UPDATE order_items SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ?
         WHERE order_id = ? AND status != 'cancelled'`,
        [userId, reason, orderId]
      );

      // Cancel all KOT items
      await connection.query(
        `UPDATE kot_items ki
         JOIN kot_tickets kt ON ki.kot_id = kt.id
         SET ki.status = 'cancelled'
         WHERE kt.order_id = ? AND ki.status != 'cancelled'`,
        [orderId]
      );

      // Cancel all KOTs
      await connection.query(
        `UPDATE kot_tickets SET status = 'cancelled'
         WHERE order_id = ? AND status NOT IN ('served', 'cancelled')`,
        [orderId]
      );

      // Cancel order
      await connection.query(
        `UPDATE orders SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(), cancel_reason = ?
         WHERE id = ?`,
        [userId, reason, orderId]
      );

      // Determine overall stock action summary for the cancel log
      const hasReverse = itemStockDecisions.some(d => d.decision.action === 'reverse');
      const hasWastage = itemStockDecisions.some(d => d.decision.action === 'wastage');
      const overallStockAction = hasReverse && hasWastage ? 'reverse' : (hasWastage ? 'wastage' : (hasReverse ? 'reverse' : 'none'));

      // Log cancellation with stock_action
      await connection.query(
        `INSERT INTO order_cancel_logs (
          order_id, cancel_type, reason_id, reason_text, stock_action, stock_action_auto, approved_by, cancelled_by
        ) VALUES (?, 'full_order', ?, ?, ?, ?, ?, ?)`,
        [orderId, reasonId, reason, overallStockAction, 1, approvedBy, userId]
      );

      // Auto-cancel any pending invoices for this order
      const [pendingInvoices] = await connection.query(
        `SELECT id, invoice_number FROM invoices 
         WHERE order_id = ? AND is_cancelled = 0 AND payment_status IN ('pending', 'partial')`,
        [orderId]
      );
      if (pendingInvoices.length > 0) {
        await connection.query(
          `UPDATE invoices SET is_cancelled = 1, cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ?
           WHERE order_id = ? AND is_cancelled = 0 AND payment_status IN ('pending', 'partial')`,
          [userId, reason || 'Order cancelled', orderId]
        );
      }

      // Handle stock per-item: REVERSE or WASTAGE based on each item's decision
      let reversedCount = 0, wastageCount = 0;
      for (const { item: si, decision } of itemStockDecisions) {
        if (decision.action === 'reverse') {
          await stockDeductionService.reverseForOrderItem(connection, {
            orderItemId: si.id, outletId: order.outlet_id, userId, reason: reason || 'Order cancelled'
          });
          reversedCount++;
        } else if (decision.action === 'wastage') {
          await stockDeductionService.recordWastageForCancelledItem(connection, {
            orderItemId: si.id, orderId, outletId: order.outlet_id, userId,
            reason: reason || 'Order cancelled (wastage)'
          });
          wastageCount++;
        }
      }

      if (reversedCount > 0 || wastageCount > 0) {
        // Mark order stock handling
        await connection.query(
          'UPDATE orders SET stock_reversed = ? WHERE id = ?',
          [reversedCount > 0 ? 1 : 0, orderId]
        );
        logger.info(`Cancel order ${orderId}: ${reversedCount} items reversed, ${wastageCount} items wastage`);
      }

      // Release table if dine-in - end session and set to available (INLINE, same transaction)
      if (order.table_id) {
        // Get active session inline (same transaction)
        const [sessions] = await connection.query(
          'SELECT * FROM table_sessions WHERE table_id = ? AND status = "active"',
          [order.table_id]
        );

        if (sessions.length > 0) {
          const session = sessions[0];

          // End session
          await connection.query(
            'UPDATE table_sessions SET status = "completed", ended_at = NOW(), ended_by = ? WHERE id = ?',
            [userId, session.id]
          );

          // Unmerge any merged tables and restore capacity
          const [activeMerges] = await connection.query(
            `SELECT tm.merged_table_id, t.capacity
             FROM table_merges tm
             JOIN tables t ON tm.merged_table_id = t.id
             WHERE tm.primary_table_id = ? AND tm.unmerged_at IS NULL`,
            [order.table_id]
          );

          if (activeMerges.length > 0) {
            await connection.query(
              'UPDATE table_merges SET unmerged_at = NOW(), unmerged_by = ? WHERE primary_table_id = ? AND tm.unmerged_at IS NULL',
              [userId, order.table_id]
            );
            const mergedIds = activeMerges.map(m => m.merged_table_id);
            await connection.query(
              'UPDATE tables SET status = "available" WHERE id IN (?)',
              [mergedIds]
            );
            const capacityToRemove = activeMerges.reduce((sum, m) => sum + (m.capacity || 0), 0);
            if (capacityToRemove > 0) {
              await connection.query(
                'UPDATE tables SET capacity = GREATEST(1, capacity - ?) WHERE id = ?',
                [capacityToRemove, order.table_id]
              );
            }
          }
        }

        // Only free table if no OTHER active orders remain on it
        const [[otherActiveOrders]] = await connection.query(
          `SELECT COUNT(*) as cnt FROM orders
           WHERE table_id = ? AND id != ? AND status NOT IN ('paid', 'completed', 'cancelled')`,
          [order.table_id, orderId]
        );
        if (Number(otherActiveOrders.cnt) === 0) {
          await connection.query(
            'UPDATE tables SET status = "available" WHERE id = ?',
            [order.table_id]
          );
        }
      }

      await connection.commit();

      // Mark self-order session as order-completed (triggers expiry buffer)
      if (order.order_source === 'self_order' && order.self_order_session_id) {
        const selfOrderService = require('./selfOrder.service');
        selfOrderService.markSessionOrderCompleted(orderId).catch(err =>
          logger.warn('Failed to mark self-order session completed:', err.message)
        );
      }

      const cancelledOrder = await this.getById(orderId);
      await this.emitOrderUpdate(order.outlet_id, cancelledOrder, 'order:cancelled');

      // Emit bill:status cancelled for each auto-cancelled invoice
      if (pendingInvoices.length > 0) {
        const { publishMessage } = require('../config/redis');
        for (const inv of pendingInvoices) {
          try {
            await publishMessage('bill:status', {
              outletId: order.outlet_id,
              orderId,
              tableId: order.table_id,
              tableNumber: order.table_number,
              invoiceId: inv.id,
              invoiceNumber: inv.invoice_number,
              billStatus: 'cancelled',
              reason: reason || 'Order cancelled',
              timestamp: new Date().toISOString()
            });
          } catch (e) {
            logger.error(`Failed to emit bill:status for invoice ${inv.id}:`, e.message);
          }
        }
      }

      // Emit KOT cancellation events to kitchen + print cancel slips for each KOT
      if (activeKots.length > 0) {
        const kotService = require('./kot.service');
        const printerService = require('./printer.service');
        // Resolve user name for cancel slips
        const [[cancelUser]] = await pool.query('SELECT name FROM users WHERE id = ?', [userId]);
        const cancelledByName = cancelUser?.name || 'Staff';

        for (const kot of activeKots) {
          // Fetch full KOT with items, addons, item_type for rich event data
          const fullKot = await kotService.getKotById(kot.id);

          // Emit to kitchen with full details
          await kotService.emitKotUpdate(order.outlet_id, {
            ...(fullKot || kot),
            status: 'cancelled',
            cancelReason: reason,
            orderNumber: order.order_number,
            tableNumber: kot.table_number
          }, 'kot:cancelled');

          // Print cancel slip to kitchen printer for this KOT
          try {
            const kotItems = (fullKot?.items || []).map(i => ({
              itemName: i.name || i.item_name,
              variantName: i.variantName || i.variant_name,
              quantity: i.quantity,
              itemType: i.itemType || i.item_type || null
            }));

            const cancelSlipData = {
              outletId: order.outlet_id,
              orderId,
              orderNumber: order.order_number,
              tableNumber: kot.table_number || 'Takeaway',
              kotNumber: kot.kot_number,
              station: kot.station || 'kitchen',
              time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
              reason: reason || 'Order cancelled',
              cancelledBy: cancelledByName,
              items: kotItems
            };

            // All printing goes through the bridge queue — no direct TCP printing
            await printerService.printCancelSlip(cancelSlipData, userId);
            logger.info(`Cancel slip print job created for KOT ${kot.kot_number}`);
          } catch (printError) {
            logger.error(`Failed to print cancel slip for KOT ${kot.kot_number}:`, printError.message);
          }
        }
      }

      // Emit table update for real-time floor plan update
      if (order.table_id) {
        await this.emitTableUpdate(order.outlet_id, order.table_id);
      }

      return cancelledOrder;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ========================
  // CAPTAIN ORDER HISTORY
  // ========================

  /**
   * Get captain's order history with filters
   * Captain sees only their own orders
   * Cashier with viewAllFloorOrders sees all orders for their assigned floors
   */
  async getCaptainOrderHistory(captainId, outletId, filters = {}) {
    const pool = getPool();
    
    const {
      status,        // 'running' | 'completed' | 'cancelled' | 'all'
      search,        // Search by order number, table number, customer name
      startDate,     // Date range start
      endDate,       // Date range end
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      viewAllFloorOrders = false,  // Cashiers see all floor orders
      hasOpenItems,  // 'true' to show only orders with open items
      hasNcItems     // 'true' to show only orders with NC items
    } = filters;

    // Lightweight query — uses pre-computed totals from orders table (set by recalculateTotals)
    // Stats (item_count, kot_count, etc.) are batch-fetched AFTER pagination for only returned orders
    let query = `
      SELECT 
        o.id, o.order_number, o.order_type, o.status, o.payment_status,
        o.subtotal, o.tax_amount, o.discount_amount, o.total_amount,
        o.paid_amount, o.nc_amount,
        CASE 
          WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount)
          ELSE COALESCE(inv.grand_total, o.total_amount)
        END as display_amount,
        o.guest_count, o.customer_name, o.customer_phone,
        o.created_at, o.updated_at, o.cancelled_at, o.cancel_reason,
        t.table_number, t.name as table_name,
        f.name as floor_name,
        ts.started_at as session_started_at, ts.ended_at as session_ended_at,
        u.name as created_by_name,
        inv.grand_total as invoice_grand_total, inv.is_nc as invoice_is_nc,
        inv.nc_amount as invoice_nc_amount, inv.invoice_number, inv.token_number
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN floors f ON o.floor_id = f.id
      LEFT JOIN table_sessions ts ON o.table_session_id = ts.id
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN invoices inv ON o.id = inv.order_id AND inv.is_cancelled = 0
      WHERE o.outlet_id = ?
        AND NOT (o.order_source = 'self_order' AND o.status = 'pending')
    `;
    const params = [outletId];

    // Cashiers with viewAllFloorOrders see all orders for their floors
    // Captains see only their own orders
    if (!viewAllFloorOrders) {
      query += ` AND o.created_by = ?`;
      params.push(captainId);
    }

    // Floor restriction - include takeaway/delivery orders (floor_id IS NULL)
    if (filters.floorIds && filters.floorIds.length > 0) {
      if (!viewAllFloorOrders) {
        // Captain: own orders on assigned floors + own takeaway/delivery
        query += ` AND (o.floor_id IN (${filters.floorIds.map(() => '?').join(',')}) OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery') AND o.created_by = ?))`;
        params.push(...filters.floorIds, captainId);
      } else if (!filters.isPrivileged) {
        // Cashier: all orders on floors + own takeaway/delivery only
        query += ` AND (o.floor_id IN (${filters.floorIds.map(() => '?').join(',')}) OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery') AND o.created_by = ?))`;
        params.push(...filters.floorIds, captainId);
      } else {
        // Admin/manager: all orders on floors + all takeaway/delivery
        query += ` AND (o.floor_id IN (${filters.floorIds.map(() => '?').join(',')}) OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery')))`;
        params.push(...filters.floorIds);
      }
    }

    // Status filter
    if (status && status !== 'all') {
      if (status === 'running') {
        // Include 'billing' in running - order is still active until paid
        // Exclude pending self-orders (manual mode, not accepted yet — should not show as running)
        query += ` AND o.status IN ('pending', 'confirmed', 'preparing', 'ready', 'served', 'billing')
          AND NOT (o.order_source = 'self_order' AND o.status = 'pending')`;
      } else if (status === 'completed') {
        query += ` AND o.status IN ('paid', 'completed')`;
      } else if (status === 'cancelled') {
        query += ` AND o.status = 'cancelled'`;
      } else {
        query += ` AND o.status = ?`;
        params.push(status);
      }
    }

    // Search filter
    if (search) {
      query += ` AND (
        o.order_number LIKE ? OR
        t.table_number LIKE ? OR
        o.customer_name LIKE ? OR
        o.customer_phone LIKE ? OR
        inv.token_number LIKE ?
      )`;
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }

    // Date range filter (business hours: 4am to 4am)
    if (startDate && endDate) {
      const { startDt, endDt } = businessDayRange(startDate, endDate);
      query += ` AND o.created_at >= ? AND o.created_at < ?`;
      params.push(startDt, endDt);
    } else if (startDate) {
      const { startDt } = businessDayRange(startDate, startDate);
      query += ` AND o.created_at >= ?`;
      params.push(startDt);
    } else if (endDate) {
      const { endDt } = businessDayRange(endDate, endDate);
      query += ` AND o.created_at < ?`;
      params.push(endDt);
    }

    // Open item filter
    if (hasOpenItems === 'true' || hasOpenItems === true) {
      query += ` AND EXISTS (SELECT 1 FROM order_items oi_f WHERE oi_f.order_id = o.id AND oi_f.is_open_item = 1 AND oi_f.status != 'cancelled')`;
    }

    // NC item filter
    if (hasNcItems === 'true' || hasNcItems === true) {
      query += ` AND EXISTS (SELECT 1 FROM order_items oi_f WHERE oi_f.order_id = o.id AND oi_f.is_nc = 1 AND oi_f.status != 'cancelled')`;
    }

    // Add sorting and pagination
    const validSortColumns = ['created_at', 'order_number', 'total_amount', 'status'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const countQuery = query.replace(/SELECT[\s\S]*?FROM orders/, 'SELECT COUNT(DISTINCT o.id) as total FROM orders');
    const dataQuery = query + ` ORDER BY o.${sortColumn} ${order} LIMIT ? OFFSET ?`;
    const dataParams = [...params, parseInt(limit), (parseInt(page) - 1) * parseInt(limit)];

    // Parallel: count + data
    const [countResult, dataResult] = await Promise.all([
      pool.query(countQuery, params),
      pool.query(dataQuery, dataParams)
    ]);
    const total = countResult[0][0].total;
    const orders = dataResult[0];

    // Step 2: Batch-fetch stats for only the returned page of orders (avoids full table scans)
    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const [itemStatsRes, kotStatsRes, ncStatsRes, openItemStatsRes] = await Promise.all([
        pool.query(
          `SELECT order_id, COUNT(*) as item_count
           FROM order_items WHERE order_id IN (?) AND status != 'cancelled'
           GROUP BY order_id`,
          [orderIds]
        ),
        pool.query(
          `SELECT order_id, COUNT(*) as kot_count
           FROM kot_tickets WHERE order_id IN (?)
           GROUP BY order_id`,
          [orderIds]
        ),
        pool.query(
          `SELECT order_id, COUNT(*) as nc_item_count, SUM(COALESCE(nc_amount, total_price)) as nc_total
           FROM order_items WHERE order_id IN (?) AND is_nc = 1 AND status != 'cancelled'
           GROUP BY order_id`,
          [orderIds]
        ),
        pool.query(
          `SELECT order_id, COUNT(*) as open_item_count
           FROM order_items WHERE order_id IN (?) AND is_open_item = 1 AND status != 'cancelled'
           GROUP BY order_id`,
          [orderIds]
        )
      ]);
      const itemMap = {}, kotMap = {}, ncMap = {}, oiMap = {};
      for (const s of itemStatsRes[0]) itemMap[s.order_id] = s;
      for (const s of kotStatsRes[0]) kotMap[s.order_id] = s;
      for (const s of ncStatsRes[0]) ncMap[s.order_id] = s;
      for (const s of openItemStatsRes[0]) oiMap[s.order_id] = s;

      for (const o of orders) {
        o.item_count = itemMap[o.id] ? Number(itemMap[o.id].item_count) : 0;
        o.kot_count = kotMap[o.id] ? Number(kotMap[o.id].kot_count) : 0;
        o.nc_item_count = ncMap[o.id] ? Number(ncMap[o.id].nc_item_count) : 0;
        o.nc_items_total = ncMap[o.id] ? Number(ncMap[o.id].nc_total) : 0;
        o.is_nc = o.nc_item_count > 0 ? 1 : 0;
        o.open_item_count = oiMap[o.id] ? Number(oiMap[o.id].open_item_count) : 0;
        o.has_open_items = o.open_item_count > 0 ? 1 : 0;
      }
    }

    return {
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  },

  /**
   * Get detailed order with time logs for captain
   */
  async getCaptainOrderDetail(orderId, captainId) {
    const pool = getPool();

    // Get order with verification
    const [orders] = await pool.query(
      `SELECT o.*, 
        t.table_number, t.name as table_name,
        f.name as floor_name,
        u.name as created_by_name,
        ts.started_at as session_started_at,
        ts.ended_at as session_ended_at,
        ts.guest_count as session_guest_count
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN table_sessions ts ON o.table_session_id = ts.id
       WHERE o.id = ?`,
      [orderId]
    );

    if (!orders[0]) {
      throw new Error('Order not found');
    }

    const order = orders[0];

    // Verify captain owns this order (or has elevated role)
    const [userRoles] = await pool.query(
      `SELECT r.slug as role_name FROM user_roles ur 
       JOIN roles r ON ur.role_id = r.id 
       WHERE ur.user_id = ? AND ur.is_active = 1`,
      [captainId]
    );
    // Cashier, manager, admin can view any order; captain/waiter can only view their own
    const canViewAnyOrder = userRoles.some(r => 
      ['master', 'admin', 'manager', 'super_admin', 'cashier'].includes(r.role_name)
    );

    if (order.created_by !== captainId && !canViewAnyOrder) {
      throw new Error('You can only view your own orders');
    }

    // Get order items with details
    // For open items, use oi.item_name (custom name) instead of i.name (template name)
    const [items] = await pool.query(
      `SELECT oi.*, 
        CASE WHEN oi.is_open_item = 1 THEN oi.item_name ELSE COALESCE(i.name, oi.item_name) END as item_name,
        i.short_name,
        CASE WHEN oi.is_open_item = 1 THEN oi.variant_name ELSE COALESCE(v.name, oi.variant_name) END as variant_name,
        uc.name as cancelled_by_name
       FROM order_items oi
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN variants v ON oi.variant_id = v.id
       LEFT JOIN users uc ON oi.cancelled_by = uc.id
       WHERE oi.order_id = ?
       ORDER BY oi.created_at`,
      [orderId]
    );
    // Add isOpenItem flag to each item
    for (const item of items) {
      item.isOpenItem = !!item.is_open_item;
    }
    order.items = items;

    // NC breakdown for items
    const activeItems = items.filter(i => i.status !== 'cancelled');
    const ncItems = activeItems.filter(i => i.is_nc);
    const chargeableItems = activeItems.filter(i => !i.is_nc);
    
    // Calculate correct subtotal excluding NC items
    const chargeableSubtotal = chargeableItems.reduce((s, i) => s + (parseFloat(i.total_price) || 0), 0);
    const chargeableTax = chargeableItems.reduce((s, i) => s + (parseFloat(i.tax_amount) || 0), 0);
    const ncAmount = ncItems.reduce((s, i) => s + (parseFloat(i.total_price) || 0), 0);
    
    order.ncSummary = {
      isNC: !!order.is_nc || ncItems.length > 0,
      ncAmount: ncAmount,
      ncReason: order.nc_reason || null,
      ncItemCount: ncItems.length,
      ncItemsTotal: ncAmount,
      totalItems: activeItems.length,
      chargeableItems: chargeableItems.length,
      chargeableTotal: chargeableSubtotal
    };

    // Adjustment summary — expose camelCase adjustment fields
    order.adjustmentSummary = {
      isAdjustment: !!order.is_adjustment,
      adjustmentAmount: parseFloat(order.adjustment_amount) || 0,
      paidAmount: parseFloat(order.paid_amount) || 0,
      dueAmount: parseFloat(order.due_amount) || 0,
      paymentStatus: order.payment_status
    };

    // Override order subtotal/total with correct values (excluding NC items)
    const discountAmount = parseFloat(order.discount_amount) || 0;
    const discountRatio = chargeableSubtotal > 0 ? ((chargeableSubtotal - discountAmount) / chargeableSubtotal) : 1;
    const adjustedTax = parseFloat((chargeableTax * discountRatio).toFixed(2));
    const taxableAmount = chargeableSubtotal - discountAmount;
    const preRoundTotal = taxableAmount + adjustedTax;
    const calculatedTotal = Math.round(preRoundTotal);
    
    // Set corrected values on order object
    order.subtotal = parseFloat(chargeableSubtotal.toFixed(2));
    order.nc_amount = parseFloat(ncAmount.toFixed(2));
    order.tax_amount = adjustedTax;
    order.total_amount = calculatedTotal;
    order.round_off = parseFloat((calculatedTotal - preRoundTotal).toFixed(2));

    // Get KOT history with time logs
    const [kots] = await pool.query(
      `SELECT kt.*,
        ua.name as accepted_by_name,
        us.name as served_by_name
       FROM kot_tickets kt
       LEFT JOIN users ua ON kt.accepted_by = ua.id
       LEFT JOIN users us ON kt.served_by = us.id
       WHERE kt.order_id = ?
       ORDER BY kt.created_at`,
      [orderId]
    );

    for (const kot of kots) {
      const [kotItems] = await pool.query(
        'SELECT * FROM kot_items WHERE kot_id = ?',
        [kot.id]
      );
      kot.items = kotItems;
    }
    order.kots = kots;

    // Get time logs
    order.timeLogs = {
      orderCreated: order.created_at,
      sessionStarted: order.session_started_at,
      firstKotSent: kots.length > 0 ? kots[0].created_at : null,
      lastKotSent: kots.length > 0 ? kots[kots.length - 1].created_at : null,
      orderCompleted: (order.status === 'paid' || order.status === 'completed') ? order.updated_at : null,
      orderCancelled: order.cancelled_at,
      sessionEnded: order.session_ended_at
    };

    // Get invoice if exists
    const [invoices] = await pool.query(
      'SELECT * FROM invoices WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
      [orderId]
    );
    if (invoices[0]) {
      const inv = invoices[0];
      const isInterstate = !!inv.is_interstate;
      let taxBreakup = inv.tax_breakup
        ? (typeof inv.tax_breakup === 'string' ? JSON.parse(inv.tax_breakup) : inv.tax_breakup)
        : null;
      
      // Transform taxBreakup for interstate: convert CGST+SGST to IGST
      if (isInterstate && taxBreakup) {
        const transformedBreakup = {};
        let totalGstRate = 0;
        let totalGstTaxable = 0;
        let totalGstAmount = 0;
        
        for (const [code, data] of Object.entries(taxBreakup)) {
          const codeUpper = code.toUpperCase();
          if (codeUpper.includes('CGST') || codeUpper.includes('SGST')) {
            totalGstRate += parseFloat(data.rate) || 0;
            totalGstTaxable = Math.max(totalGstTaxable, parseFloat(data.taxableAmount) || 0);
            totalGstAmount += parseFloat(data.taxAmount) || 0;
          } else {
            transformedBreakup[code] = data;
          }
        }
        
        if (totalGstAmount > 0) {
          transformedBreakup['IGST'] = {
            name: `IGST ${totalGstRate}%`,
            rate: totalGstRate,
            taxableAmount: totalGstTaxable,
            taxAmount: totalGstAmount
          };
        }
        taxBreakup = transformedBreakup;
      }
      
      order.invoice = {
        ...inv,
        is_interstate: isInterstate,
        tax_breakup: taxBreakup,
        cgst_amount: isInterstate ? 0 : parseFloat(inv.cgst_amount) || 0,
        sgst_amount: isInterstate ? 0 : parseFloat(inv.sgst_amount) || 0,
        igst_amount: isInterstate 
          ? (parseFloat(inv.cgst_amount) || 0) + (parseFloat(inv.sgst_amount) || 0) + (parseFloat(inv.igst_amount) || 0) 
          : parseFloat(inv.igst_amount) || 0
      };
    } else {
      order.invoice = null;
    }

    // Get payments if exists
    const [payments] = await pool.query(
      'SELECT * FROM payments WHERE order_id = ? ORDER BY created_at',
      [orderId]
    );
    
    // For split payments, fetch the breakdown from split_payments table
    for (const payment of payments) {
      if (payment.payment_mode === 'split') {
        const [splitDetails] = await pool.query(
          'SELECT * FROM split_payments WHERE payment_id = ?', [payment.id]
        );
        payment.splitBreakdown = splitDetails.map(sp => ({
          paymentMode: sp.payment_mode,
          amount: parseFloat(sp.amount) || 0,
          reference: sp.reference_number
        }));
      }
    }
    
    order.payments = payments;

    return order;
  },

  /**
   * Get captain order statistics
   */
  async getCaptainOrderStats(captainId, outletId, dateRange = {}) {
    const pool = getPool();
    
    const { startDate, endDate, floorIds } = dateRange;
    let dateFilter = '';
    let floorFilter = '';
    const params = [outletId, captainId];

    // Date range filter (business hours: 4am to 4am)
    if (startDate && endDate) {
      const { startDt, endDt } = businessDayRange(startDate, endDate);
      dateFilter = 'AND o.created_at >= ? AND o.created_at < ?';
      params.push(startDt, endDt);
    } else {
      // Default to today's business day (4am today to 4am tomorrow)
      const today = new Date();
      const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      const { startDt, endDt } = businessDayRange(todayStr, todayStr);
      dateFilter = 'AND o.created_at >= ? AND o.created_at < ?';
      params.push(startDt, endDt);
    }

    if (floorIds && floorIds.length > 0) {
      floorFilter = ` AND o.floor_id IN (${floorIds.map(() => '?').join(',')})`;
      params.push(...floorIds);
    }

    const [stats] = await pool.query(
      `SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status IN ('pending', 'confirmed', 'preparing', 'ready', 'served') THEN 1 END) as running_orders,
        COUNT(CASE WHEN status IN ('billed', 'paid', 'completed') THEN 1 END) as completed_orders,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
        COALESCE(SUM(CASE WHEN status IN ('paid', 'completed') THEN total_amount ELSE 0 END), 0) as total_sales,
        COALESCE(AVG(CASE WHEN status IN ('paid', 'completed') THEN total_amount END), 0) as avg_order_value
       FROM orders o
       WHERE o.outlet_id = ? AND o.created_by = ? ${dateFilter}${floorFilter}`,
      params
    );

    return stats[0];
  },

  // ========================
  // TABLE OPERATIONS
  // ========================

  /**
   * Transfer order to another table
   */
  async transferTable(orderId, toTableId, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const order = await this.getById(orderId);
      if (!order) throw new Error('Order not found');

      const fromTableId = order.table_id;

      // Get new table details
      const [newTable] = await connection.query(
        'SELECT * FROM tables WHERE id = ?',
        [toTableId]
      );
      if (!newTable[0]) throw new Error('Target table not found');

      // Check if new table is available
      if (newTable[0].status === 'occupied') {
        throw new Error('Target table is already occupied');
      }

      // Update order
      await connection.query(
        `UPDATE orders SET 
          table_id = ?, floor_id = ?, section_id = ?, updated_by = ?
         WHERE id = ?`,
        [toTableId, newTable[0].floor_id, newTable[0].section_id, userId, orderId]
      );

      // Update table statuses
      await connection.query('UPDATE tables SET status = ? WHERE id = ?', ['occupied', toTableId]);
      await connection.query('UPDATE tables SET status = ? WHERE id = ?', ['available', fromTableId]);

      // Log transfer
      await connection.query(
        `INSERT INTO order_transfer_logs (
          order_id, from_table_id, to_table_id, transfer_type, transferred_by
        ) VALUES (?, ?, ?, 'table', ?)`,
        [orderId, fromTableId, toTableId, userId]
      );

      await connection.commit();

      const updatedOrder = await this.getById(orderId);
      await this.emitOrderUpdate(order.outlet_id, updatedOrder, 'order:transferred');

      // Emit table updates
      await this.emitTableUpdate(order.outlet_id, fromTableId, toTableId);

      return updatedOrder;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Transfer specific items (partial or full qty) from one order to another table.
   * 
   * Rules:
   * - Source order must be active (not billed/paid/completed/cancelled)
   * - Target table: if occupied/running → must have an active modifiable order
   * - Target table: if available → creates new order + session automatically
   * - KOT items are moved to a new KOT on the target order
   * - If source order has no active items left → auto-cancel source & free table
   * - Stock deductions stay with items (no reversal — items still exist)
   *
   * @param {number} sourceOrderId - Order to transfer items FROM
   * @param {number} targetTableId - Table to transfer items TO
   * @param {Array}  items - [{ orderItemId, quantity }] — quantity = how many to transfer
   * @param {number} userId - User performing the transfer
   * @returns {Object} Transfer result
   */
  async transferItems(sourceOrderId, targetTableId, items, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      if (!items || !Array.isArray(items) || items.length === 0) {
        throw new Error('No items specified for transfer');
      }

      // ── 1. Parallel validation: user role + source order + target table ──
      const orderItemIds = items.map(i => i.orderItemId);
      const [
        [userRoles],
        [srcRows],
        [tgtTableRows],
        [srcItems]
      ] = await Promise.all([
        connection.query(
          `SELECT r.slug as role_name FROM user_roles ur 
           JOIN roles r ON ur.role_id = r.id 
           WHERE ur.user_id = ? AND ur.is_active = 1`,
          [userId]
        ),
        connection.query(
          `SELECT o.*, t.table_number as source_table_number, t.floor_id as source_floor_id
           FROM orders o
           LEFT JOIN tables t ON o.table_id = t.id
           WHERE o.id = ?`,
          [sourceOrderId]
        ),
        connection.query(
          `SELECT t.*, f.name as floor_name, s.name as section_name
           FROM tables t
           JOIN floors f ON t.floor_id = f.id
           LEFT JOIN sections s ON t.section_id = s.id
           WHERE t.id = ? AND t.is_active = 1`,
          [targetTableId]
        ),
        connection.query(
          `SELECT oi.*, i.kitchen_station_id, i.counter_id, i.name as catalog_name,
                  ks.station_type, ks.name as station_name,
                  c.counter_type, c.name as counter_name
           FROM order_items oi
           JOIN items i ON oi.item_id = i.id
           LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
           LEFT JOIN counters c ON i.counter_id = c.id
           WHERE oi.id IN (?) AND oi.order_id = ? AND oi.status != 'cancelled'
           FOR UPDATE`,
          [orderItemIds, sourceOrderId]
        )
      ]);

      // ── 2. Validate results ──
      const allowedRoles = ['master', 'super_admin', 'admin', 'manager', 'cashier', 'captain'];
      if (!userRoles.some(r => allowedRoles.includes(r.role_name))) {
        throw new Error('Only Cashier, Captain, Manager, Admin, or Super Admin can transfer items');
      }

      const srcOrder = srcRows[0];
      if (!srcOrder) throw new Error('Source order not found');

      const nonTransferableStatuses = ['billed', 'paid', 'completed', 'cancelled'];
      if (nonTransferableStatuses.includes(srcOrder.status)) {
        throw new Error(`Cannot transfer items from an order with status "${srcOrder.status}". Order must be active (pending/confirmed/preparing/ready/served).`);
      }

      if (srcItems.length !== orderItemIds.length) {
        const foundIds = srcItems.map(i => i.id);
        const missing = orderItemIds.filter(id => !foundIds.includes(id));
        throw new Error(`Order item(s) ${missing.join(', ')} not found, not in this order, or already cancelled`);
      }

      // Build transfer map & validate quantities
      const transferMap = {};
      for (const ti of items) {
        transferMap[ti.orderItemId] = parseFloat(ti.quantity);
      }
      for (const item of srcItems) {
        const transferQty = transferMap[item.id];
        if (!transferQty || transferQty <= 0) {
          throw new Error(`Invalid transfer quantity for item ${item.id}`);
        }
        if (transferQty > parseFloat(item.quantity)) {
          throw new Error(`Cannot transfer ${transferQty} of "${item.item_name}" — only ${item.quantity} available`);
        }
      }

      const tgtTable = tgtTableRows[0];
      if (!tgtTable) throw new Error('Target table not found');
      if (tgtTable.outlet_id !== srcOrder.outlet_id) {
        throw new Error('Cannot transfer between different outlets');
      }
      if (targetTableId === srcOrder.table_id) {
        throw new Error('Source and target table cannot be the same');
      }

      let targetOrderId = null;
      let targetOrderCreated = false;

      // ── 5. Resolve target order ──
      if (['occupied', 'running'].includes(tgtTable.status)) {
        // Target table has an active session — find its order
        const [tgtSessions] = await connection.query(
          `SELECT ts.order_id FROM table_sessions ts
           WHERE ts.table_id = ? AND ts.status = 'active'
           ORDER BY ts.id DESC LIMIT 1`,
          [targetTableId]
        );
        if (!tgtSessions[0] || !tgtSessions[0].order_id) {
          throw new Error('Target table is occupied but has no active order');
        }
        targetOrderId = tgtSessions[0].order_id;

        // Validate target order is modifiable
        const [[tgtOrder]] = await connection.query(
          `SELECT id, status FROM orders WHERE id = ?`,
          [targetOrderId]
        );
        if (!tgtOrder) throw new Error('Target order not found');
        if (nonTransferableStatuses.includes(tgtOrder.status)) {
          throw new Error(`Target table order is "${tgtOrder.status}" — cannot transfer items to a billed/paid/completed order`);
        }

      } else if (tgtTable.status === 'available') {
        // Target table is available — create order + session
        // Close any stale sessions first
        await connection.query(
          `UPDATE table_sessions SET status = 'completed', ended_at = NOW(), ended_by = ?
           WHERE table_id = ? AND status = 'active'`,
          [userId, targetTableId]
        );

        // Create new session
        const [sessionRes] = await connection.query(
          `INSERT INTO table_sessions (table_id, guest_count, started_by)
           VALUES (?, 1, ?)`,
          [targetTableId, userId]
        );
        const newSessionId = sessionRes.insertId;

        // Generate order number
        const orderNumber = await this.generateOrderNumber(srcOrder.outlet_id, connection);
        const uuid = uuidv4();

        // Create new order on target table
        const [orderRes] = await connection.query(
          `INSERT INTO orders (
            uuid, outlet_id, order_number, order_type,
            table_id, table_session_id, floor_id, section_id,
            guest_count, status, payment_status, created_by
          ) VALUES (?, ?, ?, 'dine_in', ?, ?, ?, ?, 1, 'confirmed', 'pending', ?)`,
          [
            uuid, srcOrder.outlet_id, orderNumber,
            targetTableId, newSessionId, tgtTable.floor_id, tgtTable.section_id,
            userId
          ]
        );
        targetOrderId = orderRes.insertId;
        targetOrderCreated = true;

        // Link session to order
        await connection.query(
          'UPDATE table_sessions SET order_id = ? WHERE id = ?',
          [targetOrderId, newSessionId]
        );

        // Set target table to running (items have KOTs already)
        await connection.query(
          `UPDATE tables SET status = 'running' WHERE id = ?`,
          [targetTableId]
        );

        logger.info(`[ITEM-TRANSFER] Created order ${orderNumber} (id=${targetOrderId}) on target table ${tgtTable.table_number} for item transfer`);

      } else {
        throw new Error(`Target table is "${tgtTable.status}" — must be available, occupied, or running`);
      }

      // ── 6. Transfer items + KOTs ──
      const transferredItems = [];
      // Group items by their original KOT's station for new KOT creation on target
      const kotStationGroups = {}; // groupKey → { station, stationId, stationName, items: [] }

      for (const srcItem of srcItems) {
        const transferQty = transferMap[srcItem.id];
        const srcQty = parseFloat(srcItem.quantity);
        const isFullTransfer = Math.abs(transferQty - srcQty) < 0.001;

        let newOrderItemId;

        if (isFullTransfer) {
          // ── Full item transfer: move entire order_item to target order ──
          await connection.query(
            `UPDATE order_items SET order_id = ? WHERE id = ?`,
            [targetOrderId, srcItem.id]
          );
          newOrderItemId = srcItem.id;

          // Move addons
          // (addons reference order_item_id, which stays the same — no update needed)

          // Move cost snapshot
          await connection.query(
            `UPDATE order_item_costs SET order_id = ? WHERE order_item_id = ?`,
            [targetOrderId, srcItem.id]
          );

          // Inventory movements use reference_type='order_item', reference_id=order_item_id
          // Since order_item_id stays the same for full transfer, no update needed

        } else {
          // ── Partial transfer: split the item ──
          const remainQty = srcQty - transferQty;
          const unitPrice = parseFloat(srcItem.unit_price);
          const basePrice = parseFloat(srcItem.base_price);

          // Calculate proportional amounts for transferred portion
          const origTotalPrice = parseFloat(srcItem.total_price);
          const origTaxAmount = parseFloat(srcItem.tax_amount || 0);
          const origDiscountAmt = parseFloat(srcItem.discount_amount || 0);
          const origNcAmount = parseFloat(srcItem.nc_amount || 0);

          const newTotalPrice = parseFloat((unitPrice * transferQty).toFixed(2));
          const newTaxAmount = parseFloat(((origTaxAmount / srcQty) * transferQty).toFixed(2));
          const newDiscountAmt = parseFloat(((origDiscountAmt / srcQty) * transferQty).toFixed(2));
          const newNcAmount = parseFloat(((origNcAmount / srcQty) * transferQty).toFixed(2));

          // Reduce source item quantity & amounts
          const remainTotalPrice = parseFloat((unitPrice * remainQty).toFixed(2));
          const remainTaxAmount = parseFloat((origTaxAmount - newTaxAmount).toFixed(2));
          const remainDiscountAmt = parseFloat((origDiscountAmt - newDiscountAmt).toFixed(2));
          const remainNcAmount = parseFloat((origNcAmount - newNcAmount).toFixed(2));

          await connection.query(
            `UPDATE order_items SET 
              quantity = ?, total_price = ?, tax_amount = ?, 
              discount_amount = ?, nc_amount = ?
             WHERE id = ?`,
            [remainQty, remainTotalPrice, remainTaxAmount, remainDiscountAmt, remainNcAmount, srcItem.id]
          );

          // Create new order_item on target order
          const [newItemRes] = await connection.query(
            `INSERT INTO order_items (
              order_id, item_id, variant_id, item_name, variant_name, item_type,
              quantity, weight, unit_price, base_price, tax_amount, total_price,
              discount_amount, tax_group_id, tax_details, special_instructions,
              status, is_complimentary, complimentary_reason,
              is_nc, nc_reason_id, nc_reason, nc_amount, nc_by, nc_at,
              is_open_item, created_by
            ) SELECT 
              ?, item_id, variant_id, item_name, variant_name, item_type,
              ?, weight, unit_price, base_price, ?, ?,
              ?, tax_group_id, tax_details, special_instructions,
              status, is_complimentary, complimentary_reason,
              is_nc, nc_reason_id, nc_reason, ?, nc_by, nc_at,
              is_open_item, ?
            FROM order_items WHERE id = ?`,
            [targetOrderId, transferQty, newTaxAmount, newTotalPrice, 
             newDiscountAmt, newNcAmount, userId, srcItem.id]
          );
          newOrderItemId = newItemRes.insertId;

          // Duplicate addons for the new item
          const [srcAddons] = await connection.query(
            `SELECT * FROM order_item_addons WHERE order_item_id = ?`,
            [srcItem.id]
          );
          if (srcAddons.length > 0) {
            const addonValues = srcAddons.map(a => [
              newOrderItemId, a.addon_id, a.addon_group_id, a.addon_name,
              a.addon_group_name, a.quantity, a.unit_price, a.total_price
            ]);
            await connection.query(
              `INSERT INTO order_item_addons (
                order_item_id, addon_id, addon_group_id, addon_name,
                addon_group_name, quantity, unit_price, total_price
              ) VALUES ?`,
              [addonValues]
            );
          }

          // Split cost snapshot proportionally
          const [srcCosts] = await connection.query(
            `SELECT * FROM order_item_costs WHERE order_item_id = ?`,
            [srcItem.id]
          );
          if (srcCosts[0]) {
            const ratio = transferQty / srcQty;
            const sc = srcCosts[0];
            await connection.query(
              `INSERT INTO order_item_costs (order_id, order_item_id, item_id, variant_id,
                making_cost, selling_price, profit, food_cost_percentage, cost_breakdown)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                targetOrderId, newOrderItemId, sc.item_id, sc.variant_id,
                parseFloat((sc.making_cost * ratio).toFixed(2)),
                parseFloat((sc.selling_price * ratio).toFixed(2)),
                parseFloat((sc.profit * ratio).toFixed(2)),
                sc.food_cost_percentage,
                sc.cost_breakdown
              ]
            );
            // Reduce source cost snapshot
            await connection.query(
              `UPDATE order_item_costs SET 
                making_cost = ROUND(making_cost * ?, 2),
                selling_price = ROUND(selling_price * ?, 2),
                profit = ROUND(profit * ?, 2)
               WHERE order_item_id = ?`,
              [1 - ratio, 1 - ratio, 1 - ratio, srcItem.id]
            );
          }
        }

        // ── Collect KOT grouping info for this item ──
        if (srcItem.kot_id) {
          // Determine station grouping key
          let station = 'kitchen', stationId = null, stationName = 'Kitchen';
          if (srcItem.counter_id) {
            station = srcItem.counter_name ? srcItem.counter_name.toLowerCase().replace(/\s+/g, '_') : 'bar';
            stationId = srcItem.counter_id;
            stationName = srcItem.counter_name || 'Bar';
          } else if (srcItem.kitchen_station_id) {
            station = srcItem.station_name ? srcItem.station_name.toLowerCase().replace(/\s+/g, '_') : (srcItem.station_type || 'kitchen');
            stationId = srcItem.kitchen_station_id;
            stationName = srcItem.station_name || station;
          }
          const groupKey = `${station}:${stationId || 'default'}`;

          if (!kotStationGroups[groupKey]) {
            kotStationGroups[groupKey] = { station, stationId, stationName, items: [] };
          }
          kotStationGroups[groupKey].items.push({
            srcItem,
            newOrderItemId,
            transferQty,
            isFullTransfer: Math.abs(transferQty - parseFloat(srcItem.quantity)) < 0.001
          });
        }

        transferredItems.push({
          orderItemId: srcItem.id,
          newOrderItemId,
          itemName: srcItem.item_name,
          variantName: srcItem.variant_name,
          transferredQty: transferQty,
          originalQty: srcQty,
          isFullTransfer: Math.abs(transferQty - srcQty) < 0.001
        });
      }

      // ── 7. Create new KOT tickets on target order for transferred items ──
      const kotService = require('./kot.service');
      const createdKots = [];

      for (const [groupKey, group] of Object.entries(kotStationGroups)) {
        // Generate KOT number for target order
        const kotNumber = await kotService.generateKotNumber(
          srcOrder.outlet_id, group.station, group.stationName, 
          group.station !== 'kitchen' && group.stationId
        );

        // Create new KOT ticket on target order
        const [kotRes] = await connection.query(
          `INSERT INTO kot_tickets (
            outlet_id, order_id, kot_number, table_number,
            station, station_id, status, priority, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 'Item transfer', ?)`,
          [
            srcOrder.outlet_id, targetOrderId, kotNumber,
            tgtTable.table_number,
            group.station, group.stationId, userId
          ]
        );
        const newKotId = kotRes.insertId;

        for (const ti of group.items) {
          const item = ti.srcItem;
          const isFullItemTransfer = Math.abs(ti.transferQty - parseFloat(item.quantity)) < 0.001;

          if (isFullItemTransfer) {
            // Full transfer: move existing kot_items to new KOT
            await connection.query(
              `UPDATE kot_items SET kot_id = ? WHERE order_item_id = ?`,
              [newKotId, item.id]
            );
            // Update order_item's kot_id to point to new KOT
            await connection.query(
              `UPDATE order_items SET kot_id = ? WHERE id = ?`,
              [newKotId, item.id]
            );
          } else {
            // Partial transfer: create new kot_item for the new order_item
            // Get addons text for the new item
            const [addons] = await connection.query(
              `SELECT addon_name FROM order_item_addons WHERE order_item_id = ?`,
              [ti.newOrderItemId]
            );
            const addonsText = addons.map(a => a.addon_name).join(', ');

            await connection.query(
              `INSERT INTO kot_items (
                kot_id, order_item_id, item_name, variant_name, item_type,
                quantity, addons_text, special_instructions, status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                newKotId, ti.newOrderItemId, item.item_name, item.variant_name,
                item.item_type, ti.transferQty, addonsText || null,
                item.special_instructions, item.status
              ]
            );
            // Update the new order_item's kot_id
            await connection.query(
              `UPDATE order_items SET kot_id = ? WHERE id = ?`,
              [newKotId, ti.newOrderItemId]
            );

            // Update source kot_item quantity
            await connection.query(
              `UPDATE kot_items SET quantity = ? WHERE order_item_id = ?`,
              [parseFloat(item.quantity) - ti.transferQty, item.id]
            );
          }
        }

        // Set the new KOT status to match the most advanced item status
        const [kotItemStatuses] = await connection.query(
          `SELECT DISTINCT status FROM kot_items WHERE kot_id = ?`,
          [newKotId]
        );
        const statuses = kotItemStatuses.map(r => r.status);
        let kotStatus = 'pending';
        if (statuses.includes('served')) kotStatus = 'ready';
        else if (statuses.includes('ready')) kotStatus = 'ready';
        else if (statuses.includes('preparing')) kotStatus = 'preparing';
        else if (statuses.every(s => s === 'cancelled')) kotStatus = 'cancelled';

        if (kotStatus !== 'pending') {
          await connection.query(
            `UPDATE kot_tickets SET status = ? WHERE id = ?`,
            [kotStatus, newKotId]
          );
        }

        createdKots.push({ kotId: newKotId, kotNumber, station: group.station, stationName: group.stationName });
        logger.info(`[ITEM-TRANSFER] Created KOT ${kotNumber} on target order ${targetOrderId} for station ${group.stationName}`);
      }

      // ── 8. Clean up empty source KOTs (single batch query) ──
      const srcKotIds = [...new Set(srcItems.filter(i => i.kot_id).map(i => i.kot_id))];
      if (srcKotIds.length > 0) {
        // Cancel KOTs where all items are gone or cancelled
        await connection.query(
          `UPDATE kot_tickets kt SET kt.status = 'cancelled', kt.cancel_reason = 'All items transferred'
           WHERE kt.id IN (?)
             AND NOT EXISTS (
               SELECT 1 FROM kot_items ki 
               WHERE ki.kot_id = kt.id AND ki.status != 'cancelled'
             )`,
          [srcKotIds]
        );
      }

      // ── 9. Recalculate totals on both orders (parallel) ──
      await Promise.all([
        this.recalculateTotals(sourceOrderId, connection),
        this.recalculateTotals(targetOrderId, connection)
      ]);

      // ── 10. Check if source order is now empty → auto-cancel + free table ──
      const [[srcActiveItems]] = await connection.query(
        `SELECT COUNT(*) as cnt FROM order_items 
         WHERE order_id = ? AND status != 'cancelled'`,
        [sourceOrderId]
      );
      
      let sourceOrderCancelled = false;
      let sourceTableFreed = false;

      if (Number(srcActiveItems.cnt) === 0) {
        // No active items left — cancel the source order
        await connection.query(
          `UPDATE orders SET status = 'cancelled', cancel_reason = 'All items transferred', 
           cancelled_by = ?, cancelled_at = NOW() WHERE id = ?`,
          [userId, sourceOrderId]
        );
        sourceOrderCancelled = true;

        // End session and free source table (only if no OTHER active orders remain)
        if (srcOrder.table_id) {
          const [[otherActiveOrders]] = await connection.query(
            `SELECT COUNT(*) as cnt FROM orders
             WHERE table_id = ? AND id != ? AND status NOT IN ('paid', 'completed', 'cancelled')`,
            [srcOrder.table_id, sourceOrderId]
          );
          if (Number(otherActiveOrders.cnt) === 0) {
            await connection.query(
              `UPDATE table_sessions SET status = 'completed', ended_at = NOW(), ended_by = ?
               WHERE table_id = ? AND status = 'active'`,
              [userId, srcOrder.table_id]
            );
            await connection.query(
              `UPDATE tables SET status = 'available' WHERE id = ?`,
              [srcOrder.table_id]
            );
            sourceTableFreed = true;
          }
        }
      }

      // ── 11. Log transfer ──
      const transferDetails = {
        sourceOrderId,
        targetOrderId,
        sourceTableId: srcOrder.table_id,
        targetTableId,
        targetOrderCreated,
        sourceOrderCancelled,
        sourceTableFreed,
        items: transferredItems,
        createdKots: createdKots.map(k => ({ kotId: k.kotId, kotNumber: k.kotNumber, station: k.station }))
      };

      await connection.query(
        `INSERT INTO order_transfer_logs (
          order_id, from_table_id, to_table_id, target_order_id,
          transfer_type, reason, transfer_details, transferred_by
        ) VALUES (?, ?, ?, ?, 'item', 'Item transfer', ?, ?)`,
        [
          sourceOrderId, srcOrder.table_id, targetTableId, targetOrderId,
          JSON.stringify(transferDetails), userId
        ]
      );

      await connection.commit();

      // ── 12. Post-commit: emit order/table events (fire-and-forget) ──
      // NOTE: KOT records are created in DB (section 7) for bookkeeping only.
      // No KOT emit or print — kitchen already has the original KOT for these items.
      const self = this;
      const _outletId = srcOrder.outlet_id;
      const _srcTableId = srcOrder.table_id;
      const _srcFloorId = srcOrder.source_floor_id;
      const _tgtFloorId = tgtTable.floor_id;

      Promise.resolve().then(async () => {
        try {
          // Fetch updated orders in parallel
          const [srcUpdated, tgtUpdated] = await Promise.all([
            self.getById(sourceOrderId),
            self.getById(targetOrderId)
          ]);

          // Emit order + table events + invalidate cache (no KOT emit, no KOT print)
          await Promise.all([
            self.emitOrderUpdate(_outletId, srcUpdated, 'order:items_transferred'),
            self.emitOrderUpdate(_outletId, tgtUpdated, targetOrderCreated ? 'order:created' : 'order:items_received'),
            self.emitTableUpdate(_outletId, _srcTableId, targetTableId),
            tableService.invalidateCache(_outletId, _srcFloorId, _srcTableId),
            tableService.invalidateCache(_outletId, _tgtFloorId, targetTableId)
          ]);

          logger.info(`[ITEM-TRANSFER] Post-commit done: order/table events emitted (KOT print skipped — items already in kitchen)`);
        } catch (postErr) {
          logger.error('[ITEM-TRANSFER] Post-commit event error:', postErr.message);
        }
      });

      logger.info(`[ITEM-TRANSFER] Transferred ${transferredItems.length} item(s) from order ${sourceOrderId} to order ${targetOrderId} (table ${tgtTable.table_number}) by user ${userId}`);

      return {
        success: true,
        message: `Transferred ${transferredItems.length} item(s) to table ${tgtTable.table_number}`,
        sourceOrderId,
        targetOrderId,
        targetOrderCreated,
        sourceOrderCancelled,
        sourceTableFreed,
        transferredItems,
        createdKots,
        transfer: transferDetails
      };

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ========================
  // REALTIME EVENTS
  // ========================

  async emitOrderUpdate(outletId, order, eventType) {
    try {
      const { publishMessage } = require('../config/redis');
      await publishMessage('order:update', {
        type: eventType,
        outletId,
        order,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to emit order update:', error);
    }
  },

  async emitTableUpdate(outletId, ...tableIds) {
    try {
      const { publishMessage } = require('../config/redis');
      for (const tableId of tableIds) {
        await publishMessage('table:update', {
          outletId,
          tableId,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error('Failed to emit table update:', error);
    }
  },

  // ========================
  // UTILITIES
  // ========================

  async getCancelReasons(outletId, type = 'item_cancel') {
    const pool = getPool();
    const [reasons] = await pool.query(
      `SELECT cr.* FROM cancel_reasons cr
       INNER JOIN (
         SELECT reason,
                COALESCE(
                  MAX(CASE WHEN outlet_id = ? THEN id END),
                  MAX(CASE WHEN outlet_id IS NULL THEN id END)
                ) as pick_id
         FROM cancel_reasons
         WHERE (outlet_id = ? OR outlet_id IS NULL) AND reason_type = ? AND is_active = 1
         GROUP BY reason
       ) dedup ON cr.id = dedup.pick_id
       ORDER BY cr.display_order, cr.id`,
      [outletId, outletId, type]
    );
    return reasons;
  },

  async getOpenItemTemplates(outletId) {
    const pool = getPool();
    const [templates] = await pool.query(
      `SELECT i.id, i.name, i.short_name, i.item_type, i.base_price,
              i.tax_group_id, i.category_id, i.kitchen_station_id,
              c.name as category_name, c.service_type as category_service_type,
              tg.name as tax_group_name, tg.total_rate as tax_rate, tg.is_inclusive as tax_inclusive
       FROM items i
       JOIN categories c ON i.category_id = c.id
       LEFT JOIN tax_groups tg ON i.tax_group_id = tg.id
       WHERE i.outlet_id = ? AND i.is_open_item = 1 AND i.is_active = 1 AND i.deleted_at IS NULL
       ORDER BY c.display_order, i.display_order, i.name`,
      [outletId]
    );
    return templates;
  },

  /**
   * Get available ingredients for open items (cashier picks to deduct stock)
   * Returns a lightweight list: id, name, inventory item name, unit info, current stock
   */
  async getIngredientsForOpenItem(outletId, options = {}) {
    const pool = getPool();
    const { search } = options;

    let where = 'WHERE ing.outlet_id = ? AND ing.is_active = 1 AND ii.is_active = 1';
    const params = [outletId];

    if (search && search.trim()) {
      where += ' AND (ing.name LIKE ? OR ii.name LIKE ?)';
      const s = `%${search.trim()}%`;
      params.push(s, s);
    }

    const [rows] = await pool.query(
      `SELECT ing.id as ingredientId, ing.name,
              ii.id as inventoryItemId, ii.name as inventoryItemName,
              ii.current_stock as currentStock,
              bu.id as baseUnitId, bu.name as baseUnitName, bu.abbreviation as baseUnitAbbreviation,
              ing.yield_percentage as yieldPercentage,
              ing.wastage_percentage as wastagePercentage
       FROM ingredients ing
       JOIN inventory_items ii ON ing.inventory_item_id = ii.id
       JOIN units bu ON ii.base_unit_id = bu.id
       ${where}
       ORDER BY ing.name ASC
       LIMIT 200`,
      params
    );

    // Also fetch all available units for the dropdown
    const [units] = await pool.query(
      `SELECT id, name, abbreviation, conversion_factor FROM units WHERE is_active = 1 ORDER BY name`
    );

    return { ingredients: rows, units };
  },

  // ========================
  // ADMIN ORDER LISTING
  // ========================

  /**
   * Get all orders for admin with comprehensive filters, pagination, and sorting
   * @param {Object} params - Query parameters
   * @returns {Object} - Paginated orders with summary
   */
  async getAdminOrderList(params) {
    const pool = getPool();
    const {
      outletId = null,
      status = null, // 'pending', 'confirmed', 'preparing', 'ready', 'served', 'billed', 'paid', 'completed', 'cancelled', 'all'
      orderType = null, // 'dine_in', 'takeaway', 'delivery', 'all'
      paymentStatus = null, // 'pending', 'partial', 'completed', 'all'
      startDate = null,
      endDate = null,
      search = null, // Search by order number, table number, customer name/phone
      captainId = null,
      cashierId = null,
      tableId = null,
      floorId = null,
      minAmount = null,
      maxAmount = null,
      hasOpenItems = null,
      hasNcItems = null,
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      allowedOutletIds = null, // Array of outlet IDs for super_admin scope enforcement
    } = params;

    const offset = (page - 1) * limit;
    const conditions = [];
    const queryParams = [];

    // Outlet filter — respects super_admin scope
    if (outletId) {
      conditions.push('o.outlet_id = ?');
      queryParams.push(outletId);
    } else if (allowedOutletIds && allowedOutletIds.length > 0) {
      // No specific outlet requested: restrict to allowed outlets
      conditions.push(`o.outlet_id IN (?)`);
      queryParams.push(allowedOutletIds);
    } else if (allowedOutletIds && allowedOutletIds.length === 0) {
      // super_admin with zero outlets — return nothing
      return { orders: [], total: 0, page: parseInt(page), limit: parseInt(limit), totalPages: 0 };
    }

    // Status filter
    if (status && status !== 'all') {
      conditions.push('o.status = ?');
      queryParams.push(status);
    }

    // Order type filter
    if (orderType && orderType !== 'all') {
      conditions.push('o.order_type = ?');
      queryParams.push(orderType);
    }

    // Payment status filter
    if (paymentStatus && paymentStatus !== 'all') {
      conditions.push('o.payment_status = ?');
      queryParams.push(paymentStatus);
    }

    // Date range filter (business hours: 4am to 4am)
    if (startDate && endDate) {
      // Both dates provided - use business day range
      const { startDt, endDt } = businessDayRange(startDate, endDate);
      conditions.push('o.created_at >= ? AND o.created_at < ?');
      queryParams.push(startDt, endDt);
    } else if (startDate) {
      // Only start date - from 4am on that day onwards
      const { startDt } = businessDayRange(startDate, startDate);
      conditions.push('o.created_at >= ?');
      queryParams.push(startDt);
    } else if (endDate) {
      // Only end date - up to 4am the next day
      const { endDt } = businessDayRange(endDate, endDate);
      conditions.push('o.created_at < ?');
      queryParams.push(endDt);
    }

    // Captain filter
    if (captainId) {
      conditions.push('o.created_by = ?');
      queryParams.push(captainId);
    }

    // Cashier filter (who processed payment)
    if (cashierId) {
      conditions.push('EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.received_by = ?)');
      queryParams.push(cashierId);
    }

    // Table filter
    if (tableId) {
      conditions.push('o.table_id = ?');
      queryParams.push(tableId);
    }

    // Floor filter
    if (floorId) {
      conditions.push('t.floor_id = ?');
      queryParams.push(floorId);
    }

    // Amount range filter
    if (minAmount) {
      conditions.push('o.total_amount >= ?');
      queryParams.push(minAmount);
    }
    if (maxAmount) {
      conditions.push('o.total_amount <= ?');
      queryParams.push(maxAmount);
    }

    // Search filter
    if (search) {
      conditions.push(`(
        o.order_number LIKE ? OR 
        t.table_number LIKE ? OR 
        o.customer_name LIKE ? OR 
        o.customer_phone LIKE ? OR
        inv.invoice_number LIKE ?
      )`);
      const searchPattern = `%${search}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }

    // Open item filter
    if (hasOpenItems === 'true' || hasOpenItems === true) {
      conditions.push(`EXISTS (SELECT 1 FROM order_items oi_f WHERE oi_f.order_id = o.id AND oi_f.is_open_item = 1 AND oi_f.status != 'cancelled')`);
    }

    // NC item filter
    if (hasNcItems === 'true' || hasNcItems === true) {
      conditions.push(`EXISTS (SELECT 1 FROM order_items oi_f WHERE oi_f.order_id = o.id AND oi_f.is_nc = 1 AND oi_f.status != 'cancelled')`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Validate sort columns
    const allowedSortColumns = ['created_at', 'order_number', 'total_amount', 'status', 'order_type', 'table_number'];
    const sortColumnMap = {
      'created_at': 'o.created_at',
      'order_number': 'o.order_number',
      'total_amount': 'o.total_amount',
      'status': 'o.status',
      'order_type': 'o.order_type',
      'table_number': 't.table_number'
    };
    const safeSort = allowedSortColumns.includes(sortBy) ? sortColumnMap[sortBy] : 'o.created_at';
    const safeOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Run count + data + summary in parallel (was 3 sequential queries)
    const [countResult, ordersResult, summaryResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT o.id) as total 
         FROM orders o
         LEFT JOIN tables t ON o.table_id = t.id
         LEFT JOIN invoices inv ON o.id = inv.order_id
         ${whereClause}`,
        queryParams
      ),
      pool.query(
        `SELECT 
          o.*,
          ol.name as outlet_name,
          t.table_number,
          t.name as table_name,
          f.name as floor_name,
          s.name as section_name,
          captain.name as captain_name,
          inv.id as invoice_id,
          inv.invoice_number,
          inv.grand_total as invoice_total,
          inv.payment_status as invoice_payment_status
         FROM orders o
         LEFT JOIN outlets ol ON o.outlet_id = ol.id
         LEFT JOIN tables t ON o.table_id = t.id
         LEFT JOIN floors f ON t.floor_id = f.id
         LEFT JOIN sections s ON t.section_id = s.id
         LEFT JOIN users captain ON o.created_by = captain.id
         LEFT JOIN invoices inv ON o.id = inv.order_id
         ${whereClause}
         GROUP BY o.id
         ORDER BY ${safeSort} ${safeOrder}
         LIMIT ? OFFSET ?`,
        [...queryParams, parseInt(limit), parseInt(offset)]
      ),
      pool.query(
        `SELECT 
          COUNT(DISTINCT o.id) as total_orders,
          SUM(CASE WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount) ELSE o.total_amount END) as total_amount,
          SUM(CASE WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount) ELSE 0 END) as completed_amount,
          SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
          SUM(CASE WHEN o.order_type = 'dine_in' THEN 1 ELSE 0 END) as dine_in_count,
          SUM(CASE WHEN o.order_type = 'takeaway' THEN 1 ELSE 0 END) as takeaway_count,
          SUM(CASE WHEN o.order_type = 'delivery' THEN 1 ELSE 0 END) as delivery_count,
          AVG(CASE WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount) ELSE o.total_amount END) as avg_order_value,
          SUM(CASE WHEN o.is_nc = 1 THEN 1 ELSE 0 END) as nc_count,
          SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount
         FROM orders o
         LEFT JOIN tables t ON o.table_id = t.id
         LEFT JOIN invoices inv ON o.id = inv.order_id
         ${whereClause}`,
        queryParams
      )
    ]);
    const total = countResult[0][0].total;
    const orders = ordersResult[0];

    // Batch-fetch item_count, kot_count, paid_amount for only returned orders (was 3 correlated subqueries per row)
    if (orders.length > 0) {
      const orderIds = orders.map(o => o.id);
      const [itemRes, kotRes, payRes] = await Promise.all([
        pool.query(
          `SELECT order_id, COUNT(*) as cnt FROM order_items WHERE order_id IN (?) GROUP BY order_id`,
          [orderIds]
        ),
        pool.query(
          `SELECT order_id, COUNT(*) as cnt FROM kot_tickets WHERE order_id IN (?) GROUP BY order_id`,
          [orderIds]
        ),
        pool.query(
          `SELECT order_id, SUM(total_amount) as paid FROM payments WHERE order_id IN (?) AND status = 'completed' GROUP BY order_id`,
          [orderIds]
        )
      ]);
      const iMap = {}, kMap = {}, pMap = {};
      for (const r of itemRes[0]) iMap[r.order_id] = Number(r.cnt);
      for (const r of kotRes[0]) kMap[r.order_id] = Number(r.cnt);
      for (const r of payRes[0]) pMap[r.order_id] = parseFloat(r.paid) || 0;
      for (const o of orders) {
        o.item_count = iMap[o.id] || 0;
        o.kot_count = kMap[o.id] || 0;
        o.paid_amount = pMap[o.id] || parseFloat(o.paid_amount) || 0;
      }
    }

    // Format orders
    const formattedOrders = orders.map(order => {
      const totalAmt = parseFloat(order.total_amount) || 0;
      const paidAmt = parseFloat(order.paid_amount) || 0;
      const isCompleted = ['paid', 'completed'].includes(order.status);
      const displayAmt = isCompleted ? (paidAmt || totalAmt) : totalAmt;
      
      return {
      id: order.id,
      uuid: order.uuid,
      orderNumber: order.order_number,
      outletId: order.outlet_id,
      outletName: order.outlet_name,
      orderType: order.order_type,
      status: order.status,
      paymentStatus: order.payment_status,
      tableId: order.table_id,
      tableNumber: order.table_number,
      tableName: order.table_name,
      floorName: order.floor_name,
      sectionName: order.section_name,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      numberOfGuests: order.number_of_guests,
      subtotal: parseFloat(order.subtotal) || 0,
      discountAmount: parseFloat(order.discount_amount) || 0,
      taxAmount: parseFloat(order.tax_amount) || 0,
      serviceCharge: parseFloat(order.service_charge) || 0,
      totalAmount: totalAmt,
      paidAmount: paidAmt,
      dueAmount: parseFloat(order.due_amount) || 0,
      displayAmount: displayAmt,
      captainId: order.created_by,
      captainName: order.captain_name,
      invoiceId: order.invoice_id,
      invoiceNumber: order.invoice_number,
      invoiceTotal: parseFloat(order.invoice_total) || 0,
      invoicePaymentStatus: order.invoice_payment_status,
      itemCount: order.item_count || 0,
      kotCount: order.kot_count || 0,
      isNC: !!order.is_nc,
      ncAmount: parseFloat(order.nc_amount) || 0,
      ncReason: order.nc_reason || null,
      specialInstructions: order.special_instructions,
      createdAt: order.created_at,
      updatedAt: order.updated_at
    }});

    return {
      orders: formattedOrders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      },
      summary: {
        totalOrders: parseInt(summaryResult[0][0]?.total_orders) || 0,
        totalAmount: parseFloat(summaryResult[0][0]?.total_amount) || 0,
        completedAmount: parseFloat(summaryResult[0][0]?.completed_amount) || 0,
        cancelledCount: parseInt(summaryResult[0][0]?.cancelled_count) || 0,
        dineInCount: parseInt(summaryResult[0][0]?.dine_in_count) || 0,
        takeawayCount: parseInt(summaryResult[0][0]?.takeaway_count) || 0,
        deliveryCount: parseInt(summaryResult[0][0]?.delivery_count) || 0,
        avgOrderValue: parseFloat(summaryResult[0][0]?.avg_order_value) || 0,
        ncCount: parseInt(summaryResult[0][0]?.nc_count) || 0,
        ncAmount: parseFloat(summaryResult[0][0]?.nc_amount) || 0
      }
    };
  },

  /**
   * Get admin order list for CSV export (no pagination, includes all data)
   * @param {Object} params - Query parameters
   * @returns {Object} - All orders with summary
   */
  async getAdminOrderListForExport(params) {
    const pool = getPool();
    const {
      outletId = null,
      status = null,
      orderType = null,
      paymentStatus = null,
      startDate = null,
      endDate = null,
      search = null,
      captainId = null,
      cashierId = null,
      tableId = null,
      floorId = null,
      minAmount = null,
      maxAmount = null,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      allowedOutletIds = null, // Array of outlet IDs for super_admin scope enforcement
    } = params;

    const conditions = [];
    const queryParams = [];

    // Outlet filter — respects super_admin scope
    if (outletId) {
      conditions.push('o.outlet_id = ?');
      queryParams.push(outletId);
    } else if (allowedOutletIds && allowedOutletIds.length > 0) {
      conditions.push(`o.outlet_id IN (?)`);
      queryParams.push(allowedOutletIds);
    } else if (allowedOutletIds && allowedOutletIds.length === 0) {
      return { orders: [] };
    }
    if (status && status !== 'all') {
      conditions.push('o.status = ?');
      queryParams.push(status);
    }
    if (orderType && orderType !== 'all') {
      conditions.push('o.order_type = ?');
      queryParams.push(orderType);
    }
    if (paymentStatus && paymentStatus !== 'all') {
      conditions.push('o.payment_status = ?');
      queryParams.push(paymentStatus);
    }
    // Date range filter (business hours: 4am to 4am)
    if (startDate && endDate) {
      const { startDt, endDt } = businessDayRange(startDate, endDate);
      conditions.push('o.created_at >= ? AND o.created_at < ?');
      queryParams.push(startDt, endDt);
    } else if (startDate) {
      const { startDt } = businessDayRange(startDate, startDate);
      conditions.push('o.created_at >= ?');
      queryParams.push(startDt);
    } else if (endDate) {
      const { endDt } = businessDayRange(endDate, endDate);
      conditions.push('o.created_at < ?');
      queryParams.push(endDt);
    }
    if (captainId) {
      conditions.push('o.created_by = ?');
      queryParams.push(captainId);
    }
    if (cashierId) {
      conditions.push('EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.received_by = ?)');
      queryParams.push(cashierId);
    }
    if (tableId) {
      conditions.push('o.table_id = ?');
      queryParams.push(tableId);
    }
    // Floor filter - can be single ID or array
    if (floorId) {
      if (Array.isArray(floorId) && floorId.length > 0) {
        conditions.push(`t.floor_id IN (${floorId.map(() => '?').join(',')})`);
        queryParams.push(...floorId);
      } else if (!Array.isArray(floorId)) {
        conditions.push('t.floor_id = ?');
        queryParams.push(floorId);
      }
    }
    if (minAmount) {
      conditions.push('o.total_amount >= ?');
      queryParams.push(minAmount);
    }
    if (maxAmount) {
      conditions.push('o.total_amount <= ?');
      queryParams.push(maxAmount);
    }
    if (search) {
      conditions.push(`(
        o.order_number LIKE ? OR 
        t.table_number LIKE ? OR 
        o.customer_name LIKE ? OR 
        o.customer_phone LIKE ? OR
        inv.invoice_number LIKE ?
      )`);
      const searchPattern = `%${search}%`;
      queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const sortColumnMap = {
      'created_at': 'o.created_at',
      'order_number': 'o.order_number',
      'total_amount': 'o.total_amount',
      'status': 'o.status',
      'order_type': 'o.order_type',
      'table_number': 't.table_number'
    };
    const safeSort = sortColumnMap[sortBy] || 'o.created_at';
    const safeOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Get all orders with comprehensive data for export
    const [orders] = await pool.query(
      `SELECT 
        o.id,
        o.uuid,
        o.order_number,
        o.outlet_id,
        ol.name as outlet_name,
        o.order_type,
        o.status,
        o.payment_status,
        o.table_id,
        t.table_number,
        t.name as table_name,
        f.name as floor_name,
        s.name as section_name,
        o.customer_name,
        o.customer_phone,
        o.guest_count,
        o.subtotal,
        o.discount_amount,
        o.discount_details,
        o.tax_amount,
        o.service_charge,
        o.packaging_charge,
        o.delivery_charge,
        o.round_off,
        o.total_amount,
        o.paid_amount,
        o.due_amount,
        o.special_instructions,
        o.source,
        o.external_order_id,
        captain.name as captain_name,
        cashier.name as cashier_name,
        inv.id as invoice_id,
        inv.invoice_number,
        inv.grand_total as invoice_total,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count,
        (SELECT GROUP_CONCAT(CONCAT(item_name, ' x', quantity) SEPARATOR '; ') FROM order_items WHERE order_id = o.id) as items_summary,
        (SELECT SUM(total_amount) FROM payments WHERE order_id = o.id AND status = 'completed') as total_paid,
        (SELECT GROUP_CONCAT(DISTINCT payment_mode SEPARATOR ', ') FROM payments WHERE order_id = o.id AND status = 'completed') as payment_modes,
        (SELECT GROUP_CONCAT(CONCAT(sp.payment_mode, ':', sp.amount) SEPARATOR '; ') 
         FROM payments p2 
         JOIN split_payments sp ON p2.id = sp.payment_id 
         WHERE p2.order_id = o.id AND p2.status = 'completed' AND p2.payment_mode = 'split') as split_breakdown,
        o.created_at,
        o.updated_at
       FROM orders o
       LEFT JOIN outlets ol ON o.outlet_id = ol.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON t.floor_id = f.id
       LEFT JOIN sections s ON t.section_id = s.id
       LEFT JOIN users captain ON o.created_by = captain.id
       LEFT JOIN invoices inv ON o.id = inv.order_id
       LEFT JOIN payments pay ON o.id = pay.order_id AND pay.status = 'completed'
       LEFT JOIN users cashier ON pay.received_by = cashier.id
       ${whereClause}
       GROUP BY o.id
       ORDER BY ${safeSort} ${safeOrder}`,
      queryParams
    );

    // Get summary
    const [summaryResult] = await pool.query(
      `SELECT 
        COUNT(DISTINCT o.id) as total_orders,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.subtotal ELSE 0 END) as total_subtotal,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.discount_amount ELSE 0 END) as total_discount,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.tax_amount ELSE 0 END) as total_tax,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.total_amount ELSE 0 END) as total_amount,
        SUM(CASE WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount) ELSE 0 END) as total_paid,
        SUM(CASE WHEN o.due_amount > 0 THEN o.due_amount ELSE 0 END) as total_due,
        SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
        SUM(CASE WHEN o.order_type = 'dine_in' THEN 1 ELSE 0 END) as dine_in_count,
        SUM(CASE WHEN o.order_type = 'takeaway' THEN 1 ELSE 0 END) as takeaway_count,
        SUM(CASE WHEN o.order_type = 'delivery' THEN 1 ELSE 0 END) as delivery_count,
        SUM(CASE WHEN o.is_nc = 1 THEN 1 ELSE 0 END) as nc_count,
        SUM(CASE WHEN o.status != 'cancelled' THEN COALESCE(o.nc_amount, 0) ELSE 0 END) as nc_amount
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN invoices inv ON o.id = inv.order_id
       ${whereClause}`,
      queryParams
    );

    return {
      orders: orders.map(o => ({
        id: o.id,
        uuid: o.uuid,
        orderNumber: o.order_number,
        outletId: o.outlet_id,
        outletName: o.outlet_name,
        orderType: o.order_type,
        status: o.status,
        paymentStatus: o.payment_status,
        tableId: o.table_id,
        tableNumber: o.table_number,
        tableName: o.table_name,
        floorName: o.floor_name,
        sectionName: o.section_name,
        customerName: o.customer_name,
        customerPhone: o.customer_phone,
        guestCount: o.guest_count,
        subtotal: parseFloat(o.subtotal) || 0,
        discountAmount: parseFloat(o.discount_amount) || 0,
        discountDetails: o.discount_details,
        taxAmount: parseFloat(o.tax_amount) || 0,
        serviceCharge: parseFloat(o.service_charge) || 0,
        packagingCharge: parseFloat(o.packaging_charge) || 0,
        deliveryCharge: parseFloat(o.delivery_charge) || 0,
        roundOff: parseFloat(o.round_off) || 0,
        totalAmount: parseFloat(o.total_amount) || 0,
        paidAmount: parseFloat(o.paid_amount) || 0,
        dueAmount: parseFloat(o.due_amount) || 0,
        totalPaid: parseFloat(o.total_paid) || 0,
        specialInstructions: o.special_instructions,
        source: o.source || 'pos',
        externalOrderId: o.external_order_id,
        captainName: o.captain_name,
        cashierName: o.cashier_name,
        invoiceId: o.invoice_id,
        invoiceNumber: o.invoice_number,
        invoiceTotal: parseFloat(o.invoice_total) || 0,
        itemCount: o.item_count || 0,
        itemsSummary: o.items_summary,
        paymentModes: o.payment_modes,
        splitBreakdown: o.split_breakdown,
        isNC: !!o.is_nc,
        ncAmount: parseFloat(o.nc_amount) || 0,
        ncReason: o.nc_reason || null,
        createdAt: o.created_at,
        updatedAt: o.updated_at
      })),
      summary: {
        totalOrders: summaryResult[0]?.total_orders || 0,
        totalSubtotal: parseFloat(summaryResult[0]?.total_subtotal) || 0,
        totalDiscount: parseFloat(summaryResult[0]?.total_discount) || 0,
        totalTax: parseFloat(summaryResult[0]?.total_tax) || 0,
        totalAmount: parseFloat(summaryResult[0]?.total_amount) || 0,
        totalPaid: parseFloat(summaryResult[0]?.total_paid) || 0,
        totalDue: parseFloat(summaryResult[0]?.total_due) || 0,
        cancelledCount: summaryResult[0]?.cancelled_count || 0,
        dineInCount: summaryResult[0]?.dine_in_count || 0,
        takeawayCount: summaryResult[0]?.takeaway_count || 0,
        deliveryCount: summaryResult[0]?.delivery_count || 0,
        ncCount: summaryResult[0]?.nc_count || 0,
        ncAmount: parseFloat(summaryResult[0]?.nc_amount) || 0
      }
    };
  },

  /**
   * Get comprehensive order details for admin view
   * @param {number} orderId - Order ID
   * @returns {Object} - Complete order details
   */
  async getAdminOrderDetail(orderId) {
    const pool = getPool();

    // Get order with all related data
    const [orders] = await pool.query(
      `SELECT 
        o.*,
        ol.name as outlet_name,
        ol.address_line1 as outlet_address,
        ol.city as outlet_city,
        ol.phone as outlet_phone,
        ol.gstin as outlet_gstin,
        t.table_number,
        t.name as table_name,
        t.capacity as table_capacity,
        f.name as floor_name,
        s.name as section_name,
        s.section_type,
        captain.name as captain_name,
        captain.email as captain_email,
        captain.phone as captain_phone,
        ts.id as session_id,
        ts.started_at as session_started_at,
        ts.ended_at as session_ended_at
       FROM orders o
       LEFT JOIN outlets ol ON o.outlet_id = ol.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON t.floor_id = f.id
       LEFT JOIN sections s ON t.section_id = s.id
       LEFT JOIN users captain ON o.created_by = captain.id
       LEFT JOIN table_sessions ts ON o.table_session_id = ts.id
       WHERE o.id = ?`,
      [orderId]
    );

    const order = orders[0];

    // Get order items with full details
    const [items] = await pool.query(
      `SELECT 
        oi.*,
        mi.name as item_name,
        mi.short_code,
        mi.image_url,
        c.name as category_name,
        v.name as variant_name,
        oi.addons as addons_json
       FROM order_items oi
       LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
       LEFT JOIN categories c ON mi.category_id = c.id
       LEFT JOIN menu_item_variants v ON oi.variant_id = v.id
       WHERE oi.order_id = ?
       ORDER BY oi.created_at`,
      [orderId]
    );

    // Get KOTs
    const [kots] = await pool.query(
      `SELECT 
        k.*,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM kot_items WHERE kot_id = k.id) as item_count
       FROM kots k
       LEFT JOIN users u ON k.created_by = u.id
       WHERE k.order_id = ?
       ORDER BY k.created_at`,
      [orderId]
    );

    // Get KOT items for each KOT
    for (const kot of kots) {
      const [kotItems] = await pool.query(
        `SELECT 
          ki.*,
          mi.name as item_name
         FROM kot_items ki
         LEFT JOIN menu_items mi ON ki.menu_item_id = mi.id
         WHERE ki.kot_id = ?`,
        [kot.id]
      );
      kot.items = kotItems;
    }

    // Get invoice
    const [invoices] = await pool.query(
      `SELECT 
        inv.*,
        u.name as generated_by_name,
        cu.name as cancelled_by_name
       FROM invoices inv
       LEFT JOIN users u ON inv.generated_by = u.id
       LEFT JOIN users cu ON inv.cancelled_by = cu.id
       WHERE inv.order_id = ?`,
      [orderId]
    );

    // Get payments
    const [payments] = await pool.query(
      `SELECT 
        p.*,
        u.name as received_by_name,
        vu.name as verified_by_name
       FROM payments p
       LEFT JOIN users u ON p.received_by = u.id
       LEFT JOIN users vu ON p.verified_by = vu.id
       WHERE p.order_id = ?
       ORDER BY p.created_at`,
      [orderId]
    );

    // Get split payments for each payment
    for (const payment of payments) {
      if (payment.payment_mode === 'split') {
        const [splits] = await pool.query(
          `SELECT * FROM split_payments WHERE payment_id = ?`,
          [payment.id]
        );
        payment.splits = splits;
      }
    }

    // Get discounts applied
    const [discounts] = await pool.query(
      `SELECT 
        od.*,
        d.name as discount_name,
        d.code as discount_code,
        au.name as approved_by_name,
        cu.name as created_by_name
       FROM order_discounts od
       LEFT JOIN discounts d ON od.discount_id = d.id
       LEFT JOIN users au ON od.approved_by = au.id
       LEFT JOIN users cu ON od.created_by = cu.id
       WHERE od.order_id = ?`,
      [orderId]
    );

    // Get order timeline/logs
    const [logs] = await pool.query(
      `SELECT 
        ol.*,
        u.name as performed_by_name
       FROM order_logs ol
       LEFT JOIN users u ON ol.performed_by = u.id
       WHERE ol.order_id = ?
       ORDER BY ol.created_at`,
      [orderId]
    );

    // Get cancellations
    const [cancellations] = await pool.query(
      `SELECT 
        cl.*,
        u.name as cancelled_by_name,
        au.name as approved_by_name,
        mi.name as item_name
       FROM cancellation_logs cl
       LEFT JOIN users u ON cl.cancelled_by = u.id
       LEFT JOIN users au ON cl.approved_by = au.id
       LEFT JOIN menu_items mi ON cl.menu_item_id = mi.id
       WHERE cl.order_id = ?
       ORDER BY cl.created_at`,
      [orderId]
    );

    // Format items
    const formattedItems = items.map(item => {
      let addons = [];
      try {
        addons = item.addons_json ? JSON.parse(item.addons_json) : [];
      } catch (e) {
        addons = [];
      }

      return {
        id: item.id,
        menuItemId: item.menu_item_id,
        itemName: item.item_name,
        shortCode: item.short_code,
        imageUrl: prefixImageUrl(item.image_url),
        categoryName: item.category_name,
        variantId: item.variant_id,
        variantName: item.variant_name,
        quantity: parseFloat(item.quantity) || 0,
        unitPrice: parseFloat(item.unit_price) || 0,
        totalPrice: parseFloat(item.total_price) || 0,
        discountAmount: parseFloat(item.discount_amount) || 0,
        taxAmount: parseFloat(item.tax_amount) || 0,
        status: item.status,
        kotStatus: item.kot_status,
        specialInstructions: item.special_instructions,
        addons,
        isCancelled: item.is_cancelled === 1,
        cancelReason: item.cancel_reason,
        createdAt: item.created_at
      };
    });

    // Format KOTs
    const formattedKots = kots.map(kot => ({
      id: kot.id,
      kotNumber: kot.kot_number,
      station: kot.station,
      status: kot.status,
      itemCount: kot.item_count,
      createdBy: kot.created_by,
      createdByName: kot.created_by_name,
      printedAt: kot.printed_at,
      acceptedAt: kot.accepted_at,
      preparingAt: kot.preparing_at,
      readyAt: kot.ready_at,
      servedAt: kot.served_at,
      createdAt: kot.created_at,
      items: kot.items?.map(ki => ({
        id: ki.id,
        menuItemId: ki.menu_item_id,
        itemName: ki.item_name,
        quantity: ki.quantity,
        status: ki.status,
        specialInstructions: ki.special_instructions
      })) || []
    }));

    // Format invoice
    const inv = invoices[0];
    const isInterstate = inv ? !!inv.is_interstate : false;
    const invoice = inv ? {
      id: inv.id,
      uuid: inv.uuid,
      invoiceNumber: inv.invoice_number,
      invoiceDate: inv.invoice_date,
      invoiceTime: inv.invoice_time,
      customerName: inv.customer_name,
      customerPhone: inv.customer_phone,
      customerEmail: inv.customer_email,
      customerGstin: inv.customer_gstin,
      customerCompanyName: inv.customer_company_name || null,
      isInterstate,
      taxType: isInterstate ? 'IGST' : 'CGST+SGST',
      subtotal: parseFloat(inv.subtotal) || 0,
      discountAmount: parseFloat(inv.discount_amount) || 0,
      taxableAmount: parseFloat(inv.taxable_amount) || 0,
      cgstAmount: parseFloat(inv.cgst_amount) || 0,
      sgstAmount: parseFloat(inv.sgst_amount) || 0,
      igstAmount: parseFloat(inv.igst_amount) || 0,
      totalTax: parseFloat(inv.total_tax) || 0,
      serviceCharge: parseFloat(inv.service_charge) || 0,
      roundOff: parseFloat(inv.round_off) || 0,
      grandTotal: parseFloat(inv.grand_total) || 0,
      paymentStatus: inv.payment_status,
      taxBreakup: inv.tax_breakup ? (typeof inv.tax_breakup === 'string' ? JSON.parse(inv.tax_breakup) : inv.tax_breakup) : null,
      isCancelled: inv.is_cancelled === 1,
      cancelledAt: inv.cancelled_at,
      cancelledByName: inv.cancelled_by_name,
      cancelReason: inv.cancel_reason,
      generatedBy: inv.generated_by,
      generatedByName: inv.generated_by_name,
      createdAt: inv.created_at
    } : null;

    // Format payments
    const formattedPayments = payments.map(p => ({
      id: p.id,
      uuid: p.uuid,
      paymentNumber: p.payment_number,
      paymentMode: p.payment_mode,
      amount: parseFloat(p.amount) || 0,
      tipAmount: parseFloat(p.tip_amount) || 0,
      totalAmount: parseFloat(p.total_amount) || 0,
      status: p.status,
      transactionId: p.transaction_id,
      referenceNumber: p.reference_number,
      cardLastFour: p.card_last_four,
      cardType: p.card_type,
      upiId: p.upi_id,
      notes: p.notes,
      receivedBy: p.received_by,
      receivedByName: p.received_by_name,
      verifiedBy: p.verified_by,
      verifiedByName: p.verified_by_name,
      refundAmount: parseFloat(p.refund_amount) || 0,
      refundedAt: p.refunded_at,
      refundReason: p.refund_reason,
      createdAt: p.created_at,
      splits: p.splits?.map(s => ({
        id: s.id,
        paymentMode: s.payment_mode,
        amount: parseFloat(s.amount) || 0,
        transactionId: s.transaction_id,
        referenceNumber: s.reference_number
      })) || []
    }));

    // Format discounts
    const formattedDiscounts = discounts.map(d => ({
      id: d.id,
      discountId: d.discount_id,
      discountCode: d.discount_code,
      discountName: d.discount_name,
      discountType: d.discount_type,
      discountValue: parseFloat(d.discount_value) || 0,
      discountAmount: parseFloat(d.discount_amount) || 0,
      appliedOn: d.applied_on,
      approvedBy: d.approved_by,
      approvedByName: d.approved_by_name,
      approvalReason: d.approval_reason,
      createdBy: d.created_by,
      createdByName: d.created_by_name,
      createdAt: d.created_at
    }));

    // Format timeline
    const timeline = logs.map(l => ({
      id: l.id,
      action: l.action,
      description: l.description,
      oldValue: l.old_value,
      newValue: l.new_value,
      performedBy: l.performed_by,
      performedByName: l.performed_by_name,
      createdAt: l.created_at
    }));

    // Format cancellations
    const formattedCancellations = cancellations.map(c => ({
      id: c.id,
      cancelType: c.cancel_type,
      menuItemId: c.menu_item_id,
      itemName: c.item_name,
      quantity: c.quantity,
      amount: parseFloat(c.amount) || 0,
      reason: c.reason,
      cancelledBy: c.cancelled_by,
      cancelledByName: c.cancelled_by_name,
      approvedBy: c.approved_by,
      approvedByName: c.approved_by_name,
      createdAt: c.created_at
    }));

    return {
      id: order.id,
      uuid: order.uuid,
      orderNumber: order.order_number,
      outletId: order.outlet_id,
      outletName: order.outlet_name,
      outletAddress: order.outlet_address,
      outletCity: order.outlet_city,
      outletPhone: order.outlet_phone,
      outletGstin: order.outlet_gstin,
      orderType: order.order_type,
      status: order.status,
      paymentStatus: order.payment_status,
      table: order.table_id ? {
        id: order.table_id,
        tableNumber: order.table_number,
        tableName: order.table_name,
        capacity: order.table_capacity,
        floorName: order.floor_name,
        sectionName: order.section_name,
        sectionType: order.section_type
      } : null,
      session: order.session_id ? {
        id: order.session_id,
        startedAt: order.session_started_at,
        endedAt: order.session_ended_at
      } : null,
      customer: {
        name: order.customer_name,
        phone: order.customer_phone,
        email: order.customer_email,
        address: order.customer_address,
        numberOfGuests: order.number_of_guests
      },
      captain: {
        id: order.created_by,
        name: order.captain_name,
        email: order.captain_email,
        phone: order.captain_phone
      },
      amounts: (() => {
        const totalAmt = parseFloat(order.total_amount) || 0;
        const paidAmt = parseFloat(order.paid_amount) || 0;
        const isCompleted = ['paid', 'completed'].includes(order.status);
        const displayAmt = isCompleted ? (paidAmt || totalAmt) : totalAmt;
        return {
          subtotal: parseFloat(order.subtotal) || 0,
          discountAmount: parseFloat(order.discount_amount) || 0,
          taxAmount: parseFloat(order.tax_amount) || 0,
          serviceCharge: parseFloat(order.service_charge) || 0,
          packagingCharge: parseFloat(order.packaging_charge) || 0,
          deliveryCharge: parseFloat(order.delivery_charge) || 0,
          roundOff: parseFloat(order.round_off) || 0,
          totalAmount: totalAmt,
          paidAmount: paidAmt,
          displayAmount: displayAmt,
          balanceAmount: totalAmt - paidAmt
        };
      })(),
      specialInstructions: order.special_instructions,
      items: formattedItems,
      kots: formattedKots,
      invoice,
      payments: formattedPayments,
      discounts: formattedDiscounts,
      cancellations: formattedCancellations,
      timeline,
      createdAt: order.created_at,
      updatedAt: order.updated_at
    };
  }
};

module.exports = orderService;
