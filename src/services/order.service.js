/**
 * Order Service
 * Core order management - create, items, status, modifications
 * This is the backbone of the POS system
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const tableService = require('./table.service');
const menuEngineService = require('./menuEngine.service');
const taxService = require('./tax.service');
const { prefixImageUrl } = require('../utils/helpers');

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
    const isPrivileged = userRoles.some(r => ['admin', 'manager', 'super_admin', 'cashier'].includes(r.role_name));
    
    if (isPrivileged) return true;
    
    // Check if user is session owner (convert to numbers for comparison)
    const sessionOwnerId = parseInt(order[0].started_by, 10);
    const currentUserId = parseInt(userId, 10);
    
    if (sessionOwnerId !== currentUserId) {
      throw new Error('Only the assigned captain can modify this order. Contact manager to transfer table.');
    }
    
    return true;
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
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const {
        outletId, tableId, floorId, sectionId, orderType = 'dine_in',
        customerId, customerName, customerPhone, guestCount = 1,
        specialInstructions, createdBy
      } = data;

      // Generate order number within the transaction to prevent race conditions
      const orderNumber = await this.generateOrderNumber(outletId, connection);
      const uuid = uuidv4();

      // Get or create table session
      let tableSessionId = null;
      if (tableId && orderType === 'dine_in') {
        // Check for existing active session
        const existingSession = await tableService.getActiveSession(tableId);
        
        if (existingSession) {
          // Check if user is privileged (admin/manager/cashier)
          const [userRoles] = await connection.query(
            `SELECT r.slug as role_name FROM user_roles ur 
             JOIN roles r ON ur.role_id = r.id 
             WHERE ur.user_id = ? AND ur.is_active = 1`,
            [createdBy]
          );
          const isPrivileged = userRoles.some(r => ['admin', 'manager', 'super_admin', 'cashier'].includes(r.role_name));
          
          // Session exists - verify ownership or authorization
          if (existingSession.order_id) {
            // Check if the existing order is in a terminal state (paid/completed/cancelled)
            const [existingOrder] = await connection.query(
              'SELECT id, status, payment_status FROM orders WHERE id = ?',
              [existingSession.order_id]
            );
            const orderStatus = existingOrder[0]?.status;
            const paymentStatus = existingOrder[0]?.payment_status;
            
            // If order is completed/paid/cancelled, end the old session and create new one
            if (['paid', 'completed', 'cancelled'].includes(orderStatus) || paymentStatus === 'paid') {
              // End the old session
              await connection.query(
                `UPDATE table_sessions SET status = 'completed', ended_at = NOW() WHERE id = ?`,
                [existingSession.id]
              );
              // Create new session below
              const session = await tableService.startSession(tableId, {
                guestCount,
                guestName: customerName,
                guestPhone: customerPhone,
                waiterId: createdBy,
                notes: specialInstructions
              }, createdBy);
              tableSessionId = session.sessionId;
            } else if (isPrivileged) {
              // Privileged user can force-end a stuck session (e.g., 'billed' with partial payment)
              // End the old session
              await connection.query(
                `UPDATE table_sessions SET status = 'completed', ended_at = NOW(), ended_by = ? WHERE id = ?`,
                [createdBy, existingSession.id]
              );
              // Create new session
              const session = await tableService.startSession(tableId, {
                guestCount,
                guestName: customerName,
                guestPhone: customerPhone,
                waiterId: createdBy,
                notes: specialInstructions
              }, createdBy);
              tableSessionId = session.sessionId;
            } else {
              throw new Error(`Table already has an active order (Order ID: ${existingSession.order_id}). Use existing order or end session first.`);
            }
          } else {
            // Session exists but has no order_id - check ownership
            
            // Convert to numbers for comparison (handle type mismatch)
            const sessionOwnerId = parseInt(existingSession.started_by, 10);
            const currentUserId = parseInt(createdBy, 10);
            
            if (sessionOwnerId !== currentUserId && !isPrivileged) {
              // Get session owner name for better error message
              const [sessionOwner] = await connection.query(
                'SELECT name FROM users WHERE id = ?',
                [sessionOwnerId]
              );
              const ownerName = sessionOwner[0]?.name || `User ID ${sessionOwnerId}`;
              throw new Error(`This table session was started by ${ownerName}. Only they can create orders for this table, or contact a manager to transfer the table.`);
            }
            
            // Use existing session
            tableSessionId = existingSession.id;
          }
        } else {
          // No session exists - create new one
          const session = await tableService.startSession(tableId, {
            guestCount,
            guestName: customerName,
            guestPhone: customerPhone,
            waiterId: createdBy,
            notes: specialInstructions
          }, createdBy);
          tableSessionId = session.sessionId;

          // Update table status to occupied
          await tableService.updateStatus(tableId, 'occupied', createdBy);
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

      // Link order to table session
      if (tableSessionId) {
        await connection.query(
          'UPDATE table_sessions SET order_id = ? WHERE id = ?',
          [result.insertId, tableSessionId]
        );
      }

      await connection.commit();

      // Read order using pool (connection is still held but committed)
      let order = await this.getById(result.insertId);
      
      // Fallback: if pool read fails due to visibility lag, read via connection
      if (!order) {
        const [rows] = await connection.query(
          `SELECT o.*, t.table_number, t.name as table_name,
            f.name as floor_name, s.name as section_name,
            u.name as created_by_name
           FROM orders o
           LEFT JOIN tables t ON o.table_id = t.id
           LEFT JOIN floors f ON o.floor_id = f.id
           LEFT JOIN sections s ON o.section_id = s.id
           LEFT JOIN users u ON o.created_by = u.id
           WHERE o.id = ?`,
          [result.insertId]
        );
        order = rows[0] || null;
      }

      // Emit realtime event
      if (order) {
        await this.emitOrderUpdate(outletId, order, 'order:created');
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
  async addItems(orderId, items, createdBy) {
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
      if (order.status === 'billed' || order.status === 'paid' || order.status === 'completed' || order.status === 'cancelled') {
        throw new Error('Cannot add items to this order');
      }

      // Verify captain ownership for dine-in orders
      if (order.table_session_id && order.order_type === 'dine_in') {
        const [sessionOwner] = await connection.query(
          'SELECT started_by FROM table_sessions WHERE id = ?',
          [order.table_session_id]
        );
        const [userRoles] = await connection.query(
          `SELECT r.slug as role_name FROM user_roles ur 
           JOIN roles r ON ur.role_id = r.id 
           WHERE ur.user_id = ? AND ur.is_active = 1`,
          [createdBy]
        );
        const isPrivileged = userRoles.some(r => ['admin', 'manager', 'super_admin', 'cashier'].includes(r.role_name));
        
        // Convert to numbers for comparison (handle type mismatch)
        const sessionOwnerId = parseInt(sessionOwner[0]?.started_by, 10);
        const currentUserId = parseInt(createdBy, 10);
        
        if (sessionOwner[0] && sessionOwnerId !== currentUserId && !isPrivileged) {
          throw new Error('Only the assigned captain can modify this order. Contact manager to transfer table.');
        }
      }

      const addedItems = [];
      const context = {
        floorId: order.floor_id,
        sectionId: order.section_id
      };

      for (const item of items) {
        const {
          itemId, variantId, quantity, addons = [],
          specialInstructions, isComplimentary = false, complimentaryReason
        } = item;

        // Get item details with effective price
        const itemDetails = await menuEngineService.getItemForOrder(itemId, context);
        if (!itemDetails) throw new Error(`Item ${itemId} not found`);

        // Determine price
        let unitPrice, basePric;
        let variantName = null;
        let taxGroupId = itemDetails.tax_group_id;

        if (variantId) {
          const variant = itemDetails.variants?.find(v => v.id === variantId);
          if (!variant) throw new Error(`Variant ${variantId} not found`);
          unitPrice = variant.effectivePrice || variant.price;
          basePrice = variant.price;
          variantName = variant.name;
          if (variant.tax_group_id) taxGroupId = variant.tax_group_id;
        } else {
          unitPrice = itemDetails.effectivePrice || itemDetails.base_price;
          basePrice = itemDetails.base_price;
        }

        // Calculate addon total
        let addonTotal = 0;
        const addonDetails = [];
        for (const addonId of addons) {
          const [addonRows] = await connection.query(
            'SELECT a.*, ag.name as group_name FROM addons a JOIN addon_groups ag ON a.addon_group_id = ag.id WHERE a.id = ?',
            [addonId]
          );
          if (addonRows[0]) {
            addonTotal += parseFloat(addonRows[0].price);
            addonDetails.push(addonRows[0]);
          }
        }

        const totalUnitPrice = unitPrice + addonTotal;
        const totalPrice = totalUnitPrice * quantity;

        // Calculate tax
        let taxAmount = 0;
        let taxDetails = null;
        if (taxGroupId) {
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

        // Insert addons
        for (const addon of addonDetails) {
          await connection.query(
            `INSERT INTO order_item_addons (
              order_item_id, addon_id, addon_group_id, addon_name, addon_group_name,
              quantity, unit_price, total_price
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [orderItemId, addon.id, addon.addon_group_id, addon.name, addon.group_name, 1, addon.price, addon.price]
          );
        }

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

      // Get updated order
      const updatedOrder = await this.getById(orderId);
      await this.emitOrderUpdate(order.outlet_id, updatedOrder, 'order:items_added');

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
   */
  async recalculateTotals(orderId, connection = null) {
    const pool = connection || getPool();

    // Get all non-cancelled items
    const [items] = await pool.query(
      `SELECT SUM(total_price) as subtotal, SUM(tax_amount) as tax_total
       FROM order_items WHERE order_id = ? AND status != 'cancelled'`,
      [orderId]
    );

    const subtotal = parseFloat(items[0].subtotal) || 0;
    const originalTaxAmount = parseFloat(items[0].tax_total) || 0;

    // Get discount
    const [discounts] = await pool.query(
      'SELECT SUM(discount_amount) as total FROM order_discounts WHERE order_id = ?',
      [orderId]
    );
    const discountAmount = parseFloat(discounts[0].total) || 0;

    // Calculate taxable amount after discount
    const taxableAmount = subtotal - discountAmount;
    
    // Apply discount ratio to tax (same as calculateBillDetails in billing.service.js)
    // Tax should be proportionally reduced when discount is applied
    const discountRatio = subtotal > 0 ? (taxableAmount / subtotal) : 1;
    const adjustedTaxAmount = parseFloat((originalTaxAmount * discountRatio).toFixed(2));

    // Calculate total: taxableAmount + adjustedTax (matches invoice grand_total calculation)
    const preRoundTotal = taxableAmount + adjustedTaxAmount;
    const totalAmount = Math.round(preRoundTotal);
    const roundOff = totalAmount - preRoundTotal;

    await pool.query(
      `UPDATE orders SET 
        subtotal = ?, discount_amount = ?, tax_amount = ?,
        round_off = ?, total_amount = ?, updated_at = NOW()
       WHERE id = ?`,
      [subtotal, discountAmount, adjustedTaxAmount, roundOff, totalAmount, orderId]
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

    // Get items with full details
    const [items] = await pool.query(
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
    );

    // Get addons for ALL items in one query (avoids N+1)
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
          addonId: addon.addon_id,
          addonName: addon.addon_name,
          quantity: addon.quantity,
          unitPrice: parseFloat(addon.unit_price) || 0,
          totalPrice: parseFloat(addon.total_price) || 0
        });
      }
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
          
          // Aggregate tax breakdown from each item
          if (Array.isArray(taxDetails)) {
            for (const tax of taxDetails) {
              const taxCode = tax.componentCode || tax.code || tax.componentName || tax.name || 'TAX';
              const taxName = tax.componentName || tax.name || taxCode;
              const taxAmt = parseFloat(tax.amount) || 0;
              const taxRate = parseFloat(tax.rate) || 0;
              const itemTotal = parseFloat(item.total_price) || 0;
              
              // Add to tax breakup
              if (!taxBreakup[taxCode]) {
                taxBreakup[taxCode] = {
                  name: taxName,
                  rate: taxRate,
                  taxableAmount: 0,
                  taxAmount: 0
                };
              }
              taxBreakup[taxCode].taxableAmount += itemTotal;
              taxBreakup[taxCode].taxAmount += taxAmt;
              
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
        quantity: item.quantity,
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
        createdAt: item.created_at,
        updatedAt: item.updated_at
      };
    }).filter(Boolean); // Remove null entries (cancelled items)

    // Get applied discounts with approver info
    const [discounts] = await pool.query(
      `SELECT od.*, u.name as approved_by_name, uc.name as created_by_name
       FROM order_discounts od
       LEFT JOIN users u ON od.approved_by = u.id
       LEFT JOIN users uc ON od.created_by = uc.id
       WHERE od.order_id = ?`,
      [orderId]
    );
    
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

    // Get payments with full details and split breakdown
    const [payments] = await pool.query(
      `SELECT p.*, u.name as received_by_name
       FROM payments p
       LEFT JOIN users u ON p.received_by = u.id
       WHERE p.order_id = ? 
       ORDER BY p.created_at DESC`,
      [orderId]
    );
    
    const formattedPayments = [];
    for (const payment of payments) {
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
        notes: payment.notes,
        createdAt: payment.created_at
      };
      
      // For split payments, fetch the breakdown
      if (payment.payment_mode === 'split') {
        const [splitDetails] = await pool.query(
          'SELECT * FROM split_payments WHERE payment_id = ?', [payment.id]
        );
        formatted.splitBreakdown = splitDetails.map(sp => ({
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
        }));
      }
      formattedPayments.push(formatted);
    }

    // Get invoice details if exists
    const [invoiceRows] = await pool.query(
      `SELECT i.*, u.name as generated_by_name
       FROM invoices i
       LEFT JOIN users u ON i.generated_by = u.id
       WHERE i.order_id = ? AND i.is_cancelled = 0
       ORDER BY i.created_at DESC LIMIT 1`,
      [orderId]
    );
    
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
        generatedBy: inv.generated_by,
        generatedByName: inv.generated_by_name,
        notes: inv.notes,
        createdAt: inv.created_at
      };
    }

    // Get KOTs for this order (if table exists)
    let kots = [];
    try {
      const [kotRows] = await pool.query(
        `SELECT k.id, k.kot_number, k.status, k.station_id, k.created_at,
          ks.name as station_name
         FROM kot k
         LEFT JOIN kitchen_stations ks ON k.station_id = ks.id
         WHERE k.order_id = ?
         ORDER BY k.created_at DESC`,
        [orderId]
      );
      kots = kotRows;
    } catch (e) { /* KOT table may not exist */ }

    // Calculate totals and summary
    const totalDiscount = formattedDiscounts.reduce((sum, d) => sum + d.discountAmount, 0);
    const totalPaid = formattedPayments.filter(p => p.status === 'completed').reduce((sum, p) => sum + p.totalAmount, 0);
    const balanceDue = (parseFloat(order.total_amount) || 0) - totalPaid;

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
      totalQuantity: formattedItems.reduce((sum, i) => sum + (i.quantity || 0), 0)
    };
  },

  /**
   * Get active orders for outlet
   */
  async getActiveOrders(outletId, filters = {}) {
    const pool = getPool();
    let query = `
      SELECT o.*, t.table_number, t.name as table_name,
        f.name as floor_name, s.name as section_name,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as item_count,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'ready') as ready_count
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN floors f ON o.floor_id = f.id
      LEFT JOIN sections s ON o.section_id = s.id
      WHERE o.outlet_id = ? AND o.status NOT IN ('paid', 'completed', 'cancelled')
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
      status, cashierId, userRole
    } = filters;
    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit) || 20));
    const offset = (page - 1) * limit;

    const allowedSort = ['created_at', 'order_number', 'total_amount', 'status'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'created_at';
    const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let whereClause = `WHERE o.outlet_id = ? AND o.order_type = 'takeaway'`;
    const params = [outletId];

    // Cashier-wise filtering: cashiers only see their own orders
    // Admins, managers, super_admins can see all orders
    const privilegedRoles = ['super_admin', 'admin', 'manager'];
    if (cashierId && userRole && !privilegedRoles.includes(userRole)) {
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

    if (search) {
      whereClause += ` AND (o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    // Count query
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM orders o ${whereClause}`, params
    );
    const total = countResult[0].total;

    // Data query
    const [orders] = await pool.query(
      `SELECT o.*,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as item_count,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'ready') as ready_count,
        (SELECT GROUP_CONCAT(DISTINCT oi.item_name SEPARATOR ', ')
         FROM order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled' LIMIT 1) as item_summary,
        i.id as invoice_id, i.invoice_number, i.grand_total as invoice_total, i.payment_status as invoice_payment_status
       FROM orders o
       LEFT JOIN users u ON o.created_by = u.id
       LEFT JOIN invoices i ON i.order_id = o.id AND i.is_cancelled = 0
       ${whereClause}
       ORDER BY o.is_priority DESC, o.${safeSortBy} ${safeSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

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
        i.short_name, i.image_url,
        ks.name as station_name, ks.station_type,
        c.name as counter_name,
        u_cancel.name as cancelled_by_name
       FROM order_items oi
       LEFT JOIN items i ON oi.item_id = i.id
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
      itemName: it.item_name,
      shortName: it.short_name || null,
      imageUrl: prefixImageUrl(it.image_url),
      quantity: it.quantity,
      unitPrice: parseFloat(it.unit_price) || 0,
      totalPrice: parseFloat(it.total_price) || 0,
      status: it.status,
      itemType: it.item_type || null,
      stationName: it.station_name || null,
      stationType: it.station_type || null,
      counterName: it.counter_name || null,
      specialInstructions: it.special_instructions || null,
      taxDetails: it.tax_details ? (typeof it.tax_details === 'string' ? JSON.parse(it.tax_details) : it.tax_details) : null,
      cancelledBy: it.cancelled_by || null,
      cancelledByName: it.cancelled_by_name || null,
      cancelReason: it.cancel_reason || null,
      cancelledAt: it.cancelled_at || null,
      addons: addonsMap[it.id] || [],
      createdAt: it.created_at
    }));

    const activeItems = formattedItems.filter(i => i.status !== 'cancelled');
    const cancelledItems = formattedItems.filter(i => i.status === 'cancelled');

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

    // 5. Payments
    const [payments] = await pool.query(
      `SELECT p.*, u.name as received_by_name
       FROM payments p
       LEFT JOIN users u ON p.received_by = u.id
       WHERE p.order_id = ?
       ORDER BY p.created_at`,
      [orderId]
    );

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

    if (item.tax_group_id) {
      const taxResult = await taxService.calculateTax(
        [{ price: item.unit_price, quantity: newQuantity }],
        item.tax_group_id
      );
      taxAmount = taxResult.taxAmount;
    }

    await pool.query(
      `UPDATE order_items SET quantity = ?, total_price = ?, tax_amount = ? WHERE id = ?`,
      [newQuantity, totalPrice, taxAmount, orderItemId]
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
      const { reason, reasonId, quantity, approvedBy } = data;

      // Block cancellation if order is billed, billing, paid, completed or cancelled
      if (['billing', 'billed', 'paid', 'completed', 'cancelled'].includes(item.order_status)) {
        throw new Error('Cannot cancel items after bill is generated or order is completed');
      }

      // Extra safety: Block if invoice exists for this order
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

      if (isFullCancel) {
        await connection.query(
          `UPDATE order_items SET 
            status = 'cancelled', cancelled_by = ?, cancelled_at = NOW(),
            cancel_reason = ?, cancel_quantity = ?
           WHERE id = ?`,
          [userId, reason, cancelQuantity, orderItemId]
        );
      } else {
        // Partial cancel - reduce quantity
        const newQuantity = item.quantity - cancelQuantity;
        const newTotal = item.unit_price * newQuantity;

        await connection.query(
          `UPDATE order_items SET 
            quantity = ?, total_price = ?, cancel_quantity = ?
           WHERE id = ?`,
          [newQuantity, newTotal, cancelQuantity, orderItemId]
        );
      }

      // Log cancellation
      await connection.query(
        `INSERT INTO order_cancel_logs (
          order_id, order_item_id, cancel_type, original_quantity,
          cancelled_quantity, reason_id, reason_text, approved_by, cancelled_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.order_id, orderItemId,
          isFullCancel ? 'full_item' : 'quantity_reduce',
          item.quantity, cancelQuantity, reasonId, reason, approvedBy, userId
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
        const cancelSlipData = {
          outletId: item.outlet_id,
          orderId: item.order_id,
          orderNumber: item.order_number,
          tableNumber: item.table_number || 'Takeaway',
          kotNumber: item.kot_number || null,
          station: item.kot_station || 'kitchen',
          time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          reason: reason,
          cancelledBy: userId,
          items: [{
            itemName: item.item_name,
            variantName: item.variant_name,
            quantity: cancelQuantity,
            itemType: item.item_type || null
          }]
        };

        const printer = await kotService.getPrinterForStation(item.outlet_id, cancelSlipData.station);
        if (printer && printer.ip_address) {
          await printerService.printCancelSlipDirect(cancelSlipData, printer.ip_address, printer.port || 9100);
        } else {
          await printerService.printCancelSlip(cancelSlipData, userId);
        }
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

      const { reason, reasonId, approvedBy } = data;

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

      // Log cancellation
      await connection.query(
        `INSERT INTO order_cancel_logs (
          order_id, cancel_type, reason_id, reason_text, approved_by, cancelled_by
        ) VALUES (?, 'full_order', ?, ?, ?, ?)`,
        [orderId, reasonId, reason, approvedBy, userId]
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

      // Release table if dine-in - end session and set to available
      if (order.table_id) {
        // End session first (this also sets table to available)
        try {
          await tableService.endSession(order.table_id, userId);
        } catch (e) {
          // If no active session, just update table status
          await tableService.updateStatus(order.table_id, 'available', userId);
        }
      }

      await connection.commit();

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
              cancelledBy: userId,
              items: kotItems
            };

            const printer = await kotService.getPrinterForStation(order.outlet_id, cancelSlipData.station);
            if (printer && printer.ip_address) {
              await printerService.printCancelSlipDirect(cancelSlipData, printer.ip_address, printer.port || 9100);
              logger.info(`Cancel slip for KOT ${kot.kot_number} printed to ${printer.ip_address}`);
            } else {
              await printerService.printCancelSlip(cancelSlipData, userId);
              logger.info(`Cancel slip print job created for KOT ${kot.kot_number}`);
            }
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
      viewAllFloorOrders = false  // Cashiers see all floor orders
    } = filters;

    // Optimized query with LEFT JOIN aggregations instead of subqueries for better performance
    // Use paid_amount for completed orders to show actual amount after discount
    let query = `
      SELECT 
        o.id,
        o.order_number,
        o.order_type,
        o.status,
        o.payment_status,
        o.subtotal,
        o.tax_amount,
        o.discount_amount,
        o.total_amount,
        o.paid_amount,
        CASE 
          WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount)
          ELSE o.total_amount
        END as display_amount,
        o.guest_count,
        o.customer_name,
        o.customer_phone,
        o.created_at,
        o.updated_at,
        o.cancelled_at,
        o.cancel_reason,
        t.table_number,
        t.name as table_name,
        f.name as floor_name,
        ts.started_at as session_started_at,
        ts.ended_at as session_ended_at,
        COALESCE(item_stats.item_count, 0) as item_count,
        COALESCE(kot_stats.kot_count, 0) as kot_count,
        u.name as created_by_name
      FROM orders o
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN floors f ON o.floor_id = f.id
      LEFT JOIN table_sessions ts ON o.table_session_id = ts.id
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT order_id, COUNT(*) as item_count 
        FROM order_items WHERE status != 'cancelled' 
        GROUP BY order_id
      ) item_stats ON o.id = item_stats.order_id
      LEFT JOIN (
        SELECT order_id, COUNT(*) as kot_count 
        FROM kot_tickets 
        GROUP BY order_id
      ) kot_stats ON o.id = kot_stats.order_id
      WHERE o.outlet_id = ?
    `;
    const params = [outletId];

    // Cashiers with viewAllFloorOrders see all orders for their floors
    // Captains see only their own orders
    if (!viewAllFloorOrders) {
      query += ` AND o.created_by = ?`;
      params.push(captainId);
    }

    // Floor restriction - for cashiers, shows only orders from their assigned floors
    if (filters.floorIds && filters.floorIds.length > 0) {
      query += ` AND o.floor_id IN (${filters.floorIds.map(() => '?').join(',')})`;
      params.push(...filters.floorIds);
    }

    // Status filter
    if (status && status !== 'all') {
      if (status === 'running') {
        // Include 'billing' in running - order is still active until paid
        query += ` AND o.status IN ('pending', 'confirmed', 'preparing', 'ready', 'served', 'billing')`;
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
        o.customer_phone LIKE ?
      )`;
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    // Date range filter
    if (startDate) {
      query += ` AND DATE(o.created_at) >= ?`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND DATE(o.created_at) <= ?`;
      params.push(endDate);
    }

    // Get total count for pagination
    const countQuery = query.replace(/SELECT[\s\S]*?FROM orders/, 'SELECT COUNT(*) as total FROM orders');
    const [countResult] = await pool.query(countQuery, params);
    const total = countResult[0].total;

    // Add sorting and pagination
    const validSortColumns = ['created_at', 'order_number', 'total_amount', 'status'];
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    
    query += ` ORDER BY o.${sortColumn} ${order}`;
    query += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    const [orders] = await pool.query(query, params);

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
      ['admin', 'manager', 'super_admin', 'cashier'].includes(r.role_name)
    );

    if (order.created_by !== captainId && !canViewAnyOrder) {
      throw new Error('You can only view your own orders');
    }

    // Get order items with details
    const [items] = await pool.query(
      `SELECT oi.*, 
        i.name as item_name, i.short_name,
        v.name as variant_name,
        uc.name as cancelled_by_name
       FROM order_items oi
       LEFT JOIN items i ON oi.item_id = i.id
       LEFT JOIN variants v ON oi.variant_id = v.id
       LEFT JOIN users uc ON oi.cancelled_by = uc.id
       WHERE oi.order_id = ?
       ORDER BY oi.created_at`,
      [orderId]
    );
    order.items = items;

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

    if (startDate && endDate) {
      dateFilter = 'AND DATE(o.created_at) BETWEEN ? AND ?';
      params.push(startDate, endDate);
    } else {
      dateFilter = 'AND DATE(o.created_at) = CURDATE()';
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
      `SELECT * FROM cancel_reasons 
       WHERE (outlet_id = ? OR outlet_id IS NULL) AND reason_type = ? AND is_active = 1
       ORDER BY display_order`,
      [outletId, type]
    );
    return reasons;
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
      page = 1,
      limit = 20,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = params;

    const offset = (page - 1) * limit;
    const conditions = [];
    const queryParams = [];

    // Outlet filter
    if (outletId) {
      conditions.push('o.outlet_id = ?');
      queryParams.push(outletId);
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

    // Date range filter
    if (startDate) {
      conditions.push('DATE(o.created_at) >= ?');
      queryParams.push(startDate);
    }
    if (endDate) {
      conditions.push('DATE(o.created_at) <= ?');
      queryParams.push(endDate);
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

    // Get total count
    const [countResult] = await pool.query(
      `SELECT COUNT(DISTINCT o.id) as total 
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN invoices inv ON o.id = inv.order_id
       ${whereClause}`,
      queryParams
    );
    const total = countResult[0].total;

    // Get orders with all related data
    const [orders] = await pool.query(
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
        inv.payment_status as invoice_payment_status,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count,
        (SELECT COUNT(*) FROM kot_tickets WHERE order_id = o.id) as kot_count,
        (SELECT SUM(total_amount) FROM payments WHERE order_id = o.id AND status = 'completed') as paid_amount
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
    );

    // Format orders - use paid_amount for completed orders to show correct amount after discount
    const formattedOrders = orders.map(order => {
      const totalAmt = parseFloat(order.total_amount) || 0;
      const paidAmt = parseFloat(order.paid_amount) || 0;
      const isCompleted = ['paid', 'completed'].includes(order.status);
      // Display amount: for completed orders use paid_amount, otherwise use total_amount
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
      displayAmount: displayAmt,
      captainId: order.created_by,
      captainName: order.captain_name,
      invoiceId: order.invoice_id,
      invoiceNumber: order.invoice_number,
      invoiceTotal: parseFloat(order.invoice_total) || 0,
      invoicePaymentStatus: order.invoice_payment_status,
      itemCount: order.item_count || 0,
      kotCount: order.kot_count || 0,
      specialInstructions: order.special_instructions,
      createdAt: order.created_at,
      updatedAt: order.updated_at
    }});

    // Get summary statistics for the filtered results - use paid_amount for completed orders
    const [summaryResult] = await pool.query(
      `SELECT 
        COUNT(DISTINCT o.id) as total_orders,
        SUM(CASE WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount) ELSE o.total_amount END) as total_amount,
        SUM(CASE WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount) ELSE 0 END) as completed_amount,
        SUM(CASE WHEN o.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_count,
        SUM(CASE WHEN o.order_type = 'dine_in' THEN 1 ELSE 0 END) as dine_in_count,
        SUM(CASE WHEN o.order_type = 'takeaway' THEN 1 ELSE 0 END) as takeaway_count,
        SUM(CASE WHEN o.order_type = 'delivery' THEN 1 ELSE 0 END) as delivery_count,
        AVG(CASE WHEN o.status IN ('paid', 'completed') THEN COALESCE(o.paid_amount, o.total_amount) ELSE o.total_amount END) as avg_order_value
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN invoices inv ON o.id = inv.order_id
       ${whereClause}`,
      queryParams
    );

    return {
      orders: formattedOrders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      },
      summary: {
        totalOrders: summaryResult[0]?.total_orders || 0,
        totalAmount: parseFloat(summaryResult[0]?.total_amount) || 0,
        completedAmount: parseFloat(summaryResult[0]?.completed_amount) || 0,
        cancelledCount: summaryResult[0]?.cancelled_count || 0,
        dineInCount: summaryResult[0]?.dine_in_count || 0,
        takeawayCount: summaryResult[0]?.takeaway_count || 0,
        deliveryCount: summaryResult[0]?.delivery_count || 0,
        avgOrderValue: parseFloat(summaryResult[0]?.avg_order_value) || 0
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
        quantity: item.quantity,
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
