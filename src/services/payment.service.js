/**
 * Payment Service
 * Handle all payment modes - Cash, Card, UPI, Split
 * Settlement, refunds, cash drawer
 */

const { getPool } = require('../database');
const { cache, publishMessage } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const orderService = require('./order.service');
const tableService = require('./table.service');
const billingService = require('./billing.service');
const kotService = require('./kot.service');
const whatsappService = require('./whatsapp.service');

/**
 * Get local date string (YYYY-MM-DD) accounting for server timezone
 * Uses local time instead of UTC to match MySQL DATE() function behavior
 */
function getLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const PAYMENT_MODES = {
  CASH: 'cash',
  CARD: 'card',
  UPI: 'upi',
  WALLET: 'wallet',
  CREDIT: 'credit',
  COMPLIMENTARY: 'complimentary',
  SPLIT: 'split'
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled'
};

// ========================
// FORMAT HELPERS — clean camelCase output matching KOT details style
// ========================

function formatSplitEntry(split) {
  if (!split) return null;
  return {
    id: split.id,
    paymentId: split.payment_id,
    paymentMode: split.payment_mode,
    amount: parseFloat(split.amount) || 0,
    transactionId: split.transaction_id || null,
    referenceNumber: split.reference_number || null,
    cardLastFour: split.card_last_four || null,
    upiId: split.upi_id || null,
    notes: split.notes || null,
  };
}

function formatPayment(payment) {
  if (!payment) return null;
  return {
    id: payment.id,
    uuid: payment.uuid,
    outletId: payment.outlet_id,
    orderId: payment.order_id,
    invoiceId: payment.invoice_id || null,
    paymentNumber: payment.payment_number,
    paymentMode: payment.payment_mode,
    amount: parseFloat(payment.amount) || 0,
    tipAmount: parseFloat(payment.tip_amount) || 0,
    totalAmount: parseFloat(payment.total_amount) || 0,
    status: payment.status,
    transactionId: payment.transaction_id || null,
    referenceNumber: payment.reference_number || null,
    cardLastFour: payment.card_last_four || null,
    cardType: payment.card_type || null,
    upiId: payment.upi_id || null,
    walletName: payment.wallet_name || null,
    bankName: payment.bank_name || null,
    notes: payment.notes || null,
    receivedBy: payment.received_by || null,
    receivedByName: payment.received_by_name || null,
    refundAmount: parseFloat(payment.refund_amount) || 0,
    refundedAt: payment.refunded_at || null,
    refundReason: payment.refund_reason || null,
    orderNumber: payment.order_number || null,
    invoiceNumber: payment.invoice_number || null,
    createdAt: payment.created_at || null,
    splits: payment.splits ? payment.splits.map(formatSplitEntry) : undefined,
  };
}

const paymentService = {
  PAYMENT_MODES,
  PAYMENT_STATUS,

  // ========================
  // PAYMENT NUMBER GENERATION
  // ========================

  async generatePaymentNumber(outletId) {
    const pool = getPool();
    const today = new Date();
    const datePrefix = today.toISOString().slice(2, 10).replace(/-/g, '');
    
    const [result] = await pool.query(
      `SELECT COUNT(*) + 1 as seq FROM payments 
       WHERE outlet_id = ? AND DATE(created_at) = CURDATE()`,
      [outletId]
    );
    
    const seq = String(result[0].seq).padStart(4, '0');
    return `PAY${datePrefix}${seq}`;
  },

  // ========================
  // PROCESS PAYMENT
  // ========================

  /**
   * Process single payment
   */
  async processPayment(data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    // Variables needed after transaction for event publishing
    let paymentId, outletId, orderId, invoiceId, orderStatus, paymentStatus;
    let totalAmount, tableId, tableSessionId;
    let order;

    try {
      const {
        outletId: requestOutletId, orderId: reqOrderId, invoiceId: reqInvoiceId,
        paymentMode, amount, tipAmount = 0,
        transactionId, referenceNumber,
        cardLastFour, cardType, upiId, walletName, bankName,
        notes, receivedBy
      } = data;

      orderId = reqOrderId;
      invoiceId = reqInvoiceId;

      // Validate order/invoice BEFORE transaction to avoid REPEATABLE READ snapshot issues
      order = await orderService.getById(orderId);
      if (!order) {
        // Fallback: read directly via connection before transaction
        const [rows] = await connection.query(
          `SELECT * FROM orders WHERE id = ?`,
          [orderId]
        );
        order = rows[0] || null;
      }
      if (!order) throw new Error('Order not found');

      await connection.beginTransaction();

      // Use request outletId or fallback to order's outlet_id
      outletId = requestOutletId || order.outlet_id;
      if (!outletId) throw new Error('Outlet ID is required');
      tableId = order.table_id;
      tableSessionId = order.table_session_id;

      if (order.status === 'paid' || order.status === 'completed') {
        throw new Error('Order already paid');
      }

      totalAmount = parseFloat(amount) + parseFloat(tipAmount);
      const paymentNumber = await this.generatePaymentNumber(outletId);
      const uuid = uuidv4();

      // Create payment record
      const [result] = await connection.query(
        `INSERT INTO payments (
          uuid, outlet_id, order_id, invoice_id, payment_number,
          payment_mode, amount, tip_amount, total_amount, status,
          transaction_id, reference_number,
          card_last_four, card_type, upi_id, wallet_name, bank_name,
          notes, received_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid, outletId, orderId, invoiceId, paymentNumber,
          paymentMode, amount, tipAmount, totalAmount,
          transactionId, referenceNumber,
          cardLastFour, cardType, upiId, walletName, bankName,
          notes, receivedBy
        ]
      );

      paymentId = Number(result.insertId);

      // Update order payment status
      const [totalPaid] = await connection.query(
        `SELECT SUM(total_amount) as paid FROM payments 
         WHERE order_id = ? AND status = 'completed'`,
        [orderId]
      );

      const paidAmount = parseFloat(totalPaid[0].paid) || 0;

      // Use invoice grand_total if available, fallback to order total_amount
      let orderTotal = parseFloat(order.total_amount) || 0;
      if (invoiceId) {
        const [invRow] = await connection.query(
          'SELECT grand_total FROM invoices WHERE id = ? AND is_cancelled = 0',
          [invoiceId]
        );
        if (invRow[0]) {
          orderTotal = parseFloat(invRow[0].grand_total) || orderTotal;
        }
      }
      const dueAmount = orderTotal - paidAmount;

      paymentStatus = 'pending';
      orderStatus = order.status;

      if (dueAmount <= 0) {
        paymentStatus = 'completed';
        orderStatus = 'completed';
      } else if (paidAmount > 0) {
        paymentStatus = 'partial';
      }

      await connection.query(
        `UPDATE orders SET 
          paid_amount = ?, due_amount = ?, payment_status = ?, status = ?
         WHERE id = ?`,
        [paidAmount, Math.max(0, dueAmount), paymentStatus, orderStatus, orderId]
      );

      // Update invoice if exists
      if (invoiceId) {
        await connection.query(
          `UPDATE invoices SET payment_status = ? WHERE id = ?`,
          [paymentStatus === 'completed' ? 'paid' : paymentStatus, invoiceId]
        );
      }

      // Record cash drawer transaction if cash payment
      if (paymentMode === 'cash') {
        await this.recordCashTransaction(connection, {
          outletId,
          userId: receivedBy,
          type: 'sale',
          amount: totalAmount,
          referenceType: 'payment',
          referenceId: paymentId,
          description: `Payment for order ${order.order_number}`
        });
      }

      // Release table if fully paid - auto end session, unmerge, and make available
      if (paymentStatus === 'completed' && tableId) {
        // Unmerge any merged tables and restore capacity
        const [activeMerges] = await connection.query(
          `SELECT tm.merged_table_id, t.capacity
           FROM table_merges tm
           JOIN tables t ON tm.merged_table_id = t.id
           WHERE tm.primary_table_id = ? AND tm.unmerged_at IS NULL`,
          [tableId]
        );

        if (activeMerges.length > 0) {
          await connection.query(
            'UPDATE table_merges SET unmerged_at = NOW(), unmerged_by = ? WHERE primary_table_id = ? AND unmerged_at IS NULL',
            [data.receivedBy, tableId]
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
              [capacityToRemove, tableId]
            );
          }
        }

        await connection.query(
          `UPDATE tables SET status = 'available' WHERE id = ?`,
          [tableId]
        );
        
        if (tableSessionId) {
          await connection.query(
            `UPDATE table_sessions SET 
              status = 'completed', ended_at = NOW()
             WHERE id = ?`,
            [tableSessionId]
          );
        }
      }

      // Mark all KOTs and order items as served on full payment
      if (paymentStatus === 'completed') {
        await connection.query(
          `UPDATE kot_tickets SET status = 'served', served_at = NOW(), served_by = ?
           WHERE order_id = ? AND status NOT IN ('served', 'cancelled')`,
          [data.receivedBy, orderId]
        );
        await connection.query(
          `UPDATE kot_items SET status = 'served'
           WHERE kot_id IN (SELECT id FROM kot_tickets WHERE order_id = ?)
             AND status != 'cancelled'`,
          [orderId]
        );
        await connection.query(
          `UPDATE order_items SET status = 'served'
           WHERE order_id = ? AND status NOT IN ('served', 'cancelled')`,
          [orderId]
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    // Fetch payment and publish events AFTER connection is released
    const payment = await this.getPaymentById(paymentId);

    // Emit realtime event
    await publishMessage('order:update', {
      type: 'order:payment_received',
      outletId,
      orderId,
      tableId,
      captainId: order.created_by,
      payment,
      orderStatus,
      paymentStatus,
      timestamp: new Date().toISOString()
    });

    // Emit bill status for Captain real-time tracking
    await publishMessage('bill:status', {
      outletId,
      orderId,
      tableId,
      tableNumber: order.table_number,
      captainId: order.created_by,
      invoiceId,
      billStatus: paymentStatus === 'completed' ? 'paid' : 'partial',
      amountPaid: totalAmount,
      timestamp: new Date().toISOString()
    });

    // Emit table update if released - table now available
    if (paymentStatus === 'completed' && tableId) {
      await publishMessage('table:update', {
        outletId,
        tableId,
        floorId: order.floor_id,
        status: 'available',
        event: 'session_ended',
        timestamp: new Date().toISOString()
      });
    }

    // Emit KOT served events for real-time kitchen display - remove from all stations
    if (paymentStatus === 'completed') {
      try {
        const kots = await kotService.getKotsByOrder(orderId);
        logger.info(`[Payment] Emitting kot:served for ${kots.length} KOTs of order ${orderId}`);
        for (const kot of kots) {
          // Use kotService.emitKotUpdate for consistent socket emission with stationId
          await kotService.emitKotUpdate(outletId, kot, 'kot:served');
          logger.info(`[Payment] KOT ${kot.kotNumber} marked served - station: ${kot.station}, stationId: ${kot.stationId}`);
        }
      } catch (err) {
        logger.error('Failed to emit KOT served events:', err.message);
      }
    }

    // Send WhatsApp bill to customer on full payment completion
    if (paymentStatus === 'completed') {
      this.sendWhatsAppBillOnCompletion(invoiceId, outletId, orderId).catch(err =>
        logger.warn('WhatsApp bill send failed (non-critical):', err.message)
      );
    }

    // Build detailed response for all scenarios
    return this.buildPaymentResponse(payment, orderId, invoiceId, orderStatus, paymentStatus, tableId);
  },

  /**
   * Process split payment
   */
  async processSplitPayment(data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const { outletId, orderId, invoiceId, splits, receivedBy } = data;

      const order = await orderService.getById(orderId);
      if (!order) throw new Error('Order not found');

      // Calculate total
      const totalAmount = splits.reduce((sum, s) => sum + parseFloat(s.amount), 0);
      const paymentNumber = await this.generatePaymentNumber(outletId);
      const uuid = uuidv4();

      // Create main payment record
      const [mainResult] = await connection.query(
        `INSERT INTO payments (
          uuid, outlet_id, order_id, invoice_id, payment_number,
          payment_mode, amount, total_amount, status, received_by
        ) VALUES (?, ?, ?, ?, ?, 'split', ?, ?, 'completed', ?)`,
        [uuid, outletId, orderId, invoiceId, paymentNumber, totalAmount, totalAmount, receivedBy]
      );

      const paymentId = Number(mainResult.insertId);

      // Create split payment records
      for (const split of splits) {
        await connection.query(
          `INSERT INTO split_payments (
            payment_id, payment_mode, amount,
            transaction_id, reference_number, card_last_four, upi_id, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            paymentId, split.paymentMode, split.amount,
            split.transactionId, split.referenceNumber,
            split.cardLastFour, split.upiId, split.notes
          ]
        );

        // Record cash if applicable
        if (split.paymentMode === 'cash') {
          await this.recordCashTransaction(connection, {
            outletId,
            userId: receivedBy,
            type: 'sale',
            amount: split.amount,
            referenceType: 'split_payment',
            referenceId: paymentId,
            description: `Split payment for order ${order.order_number}`
          });
        }
      }

      // Update order status
      await connection.query(
        `UPDATE orders SET 
          paid_amount = ?, due_amount = 0, payment_status = 'completed', status = 'completed'
         WHERE id = ?`,
        [totalAmount, orderId]
      );

      if (invoiceId) {
        await connection.query(
          `UPDATE invoices SET payment_status = 'paid' WHERE id = ?`,
          [invoiceId]
        );
      }

      // Release table - unmerge, restore capacity, end session, set available
      if (order.table_id) {
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
            'UPDATE table_merges SET unmerged_at = NOW(), unmerged_by = ? WHERE primary_table_id = ? AND unmerged_at IS NULL',
            [receivedBy, order.table_id]
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

        await connection.query(
          `UPDATE tables SET status = 'available' WHERE id = ?`,
          [order.table_id]
        );
        
        if (order.table_session_id) {
          await connection.query(
            `UPDATE table_sessions SET 
              status = 'completed', ended_at = NOW()
             WHERE id = ?`,
            [order.table_session_id]
          );
        }
      }

      // Mark all KOTs and order items as served
      await connection.query(
        `UPDATE kot_tickets SET status = 'served', served_at = NOW(), served_by = ?
         WHERE order_id = ? AND status NOT IN ('served', 'cancelled')`,
        [receivedBy, orderId]
      );
      await connection.query(
        `UPDATE kot_items SET status = 'served'
         WHERE kot_id IN (SELECT id FROM kot_tickets WHERE order_id = ?)
           AND status != 'cancelled'`,
        [orderId]
      );
      await connection.query(
        `UPDATE order_items SET status = 'served'
         WHERE order_id = ? AND status NOT IN ('served', 'cancelled')`,
        [orderId]
      );

      await connection.commit();

      const payment = await this.getPaymentById(paymentId);

      await publishMessage('order:update', {
        type: 'order:payment_received',
        outletId,
        orderId,
        payment,
        orderStatus: 'completed',
        timestamp: new Date().toISOString()
      });

      // Emit table update
      if (order.table_id) {
        await publishMessage('table:update', {
          outletId,
          tableId: order.table_id,
          floorId: order.floor_id,
          status: 'available',
          event: 'session_ended',
          timestamp: new Date().toISOString()
        });
      }

      // Emit KOT served events - remove from all stations
      try {
        const kots = await kotService.getKotsByOrder(orderId);
        logger.info(`[SplitPayment] Emitting kot:served for ${kots.length} KOTs of order ${orderId}`);
        for (const kot of kots) {
          await kotService.emitKotUpdate(outletId, kot, 'kot:served');
          logger.info(`[SplitPayment] KOT ${kot.kotNumber} marked served - station: ${kot.station}, stationId: ${kot.stationId}`);
        }
      } catch (err) {
        logger.error('Failed to emit KOT served events:', err.message);
      }

      // Send WhatsApp bill to customer on split payment completion
      this.sendWhatsAppBillOnCompletion(invoiceId, outletId, orderId).catch(err =>
        logger.warn('WhatsApp bill send failed (non-critical):', err.message)
      );

      return this.buildPaymentResponse(payment, orderId, invoiceId, 'completed', 'completed', order.table_id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ========================
  // WHATSAPP NOTIFICATION
  // ========================

  /**
   * Fetch invoice + outlet info and send WhatsApp bill template to customer.
   * Silently skips if customer has no phone or WhatsApp is not configured.
   */
  async sendWhatsAppBillOnCompletion(invoiceId, outletId, orderId = null) {
    logger.info(`[WhatsApp] Triggered for invoiceId=${invoiceId} orderId=${orderId} outletId=${outletId}`);

    if (!process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN) {
      logger.warn('[WhatsApp] Skipped: WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set');
      return;
    }

    const pool = getPool();

    let invoice = null;

    if (invoiceId) {
      invoice = await billingService.getInvoiceById(invoiceId);
    } else if (orderId) {
      // Fallback: look up invoice by orderId
      logger.info(`[WhatsApp] No invoiceId provided, looking up invoice by orderId=${orderId}`);
      const [rows] = await pool.query(
        `SELECT id FROM invoices WHERE order_id = ? AND is_cancelled = 0 ORDER BY id DESC LIMIT 1`,
        [orderId]
      );
      if (rows[0]) {
        invoice = await billingService.getInvoiceById(rows[0].id);
      }
    }

    if (!invoice) {
      logger.warn(`[WhatsApp] Skipped: no invoice found for invoiceId=${invoiceId} orderId=${orderId}`);
      return;
    }
    logger.info(`[WhatsApp] Invoice fetched: ${invoice.invoiceNumber} | customer: ${invoice.customerName} | phone: ${invoice.customerPhone}`);

    const phone = invoice.customerPhone;
    if (!phone) {
      logger.warn(`[WhatsApp] Skipped: no customer phone on invoice ${invoice.invoiceNumber}`);
      return;
    }

    const [outletRows] = await pool.query(
      `SELECT name, CONCAT_WS(', ', NULLIF(address_line1,''), NULLIF(city,''), NULLIF(state,'')) as address, phone
       FROM outlets WHERE id = ?`,
      [outletId]
    );
    const outlet = outletRows[0] || {};
    logger.info(`[WhatsApp] Outlet: ${outlet.name} | template: ${process.env.WHATSAPP_INVOICE_TEMPLATE || 'send_invoice'}`);

    logger.info(`[WhatsApp] Generating PDF and uploading for invoice ${invoice.invoiceNumber}...`);
    await whatsappService.sendBillingPDFTemplate(
      phone,
      invoice,
      outlet,
      process.env.WHATSAPP_INVOICE_TEMPLATE || 'send_invoice',
      process.env.WHATSAPP_TEMPLATE_LANG || 'en'
    );

    logger.info(`[WhatsApp] ✓ Invoice ${invoice.invoiceNumber} sent to ${phone}`);
  },

  // ========================
  // RESPONSE BUILDER
  // ========================

  async buildPaymentResponse(payment, orderId, invoiceId, orderStatus, paymentStatus, tableId) {
    const pool = getPool();

    // Fetch updated order
    const updatedOrder = await orderService.getOrderWithItems(orderId);

    // Fetch invoice (always, not just on complete)
    let invoice = null;
    if (invoiceId) {
      try {
        invoice = await billingService.getInvoiceById(invoiceId);
      } catch (err) {
        logger.error('Failed to fetch invoice:', err.message);
      }
    }
    // Fallback: find invoice by order if not passed
    if (!invoice) {
      try {
        const [invRows] = await pool.query(
          'SELECT id FROM invoices WHERE order_id = ? AND is_cancelled = 0 LIMIT 1',
          [orderId]
        );
        if (invRows[0]) invoice = await billingService.getInvoiceById(invRows[0].id);
      } catch (err) { /* ignore */ }
    }

    // Fetch all payments for this order
    const allPayments = await this.getPaymentsByOrder(orderId);
    const totalPaid = allPayments.reduce((s, p) => s + p.totalAmount, 0);
    const orderTotal = invoice ? invoice.grandTotal : (parseFloat(updatedOrder?.total_amount) || 0);
    const dueAmount = Math.max(0, orderTotal - totalPaid);

    // Table info
    let tableInfo = null;
    if (tableId) {
      try {
        const [tbl] = await pool.query(
          'SELECT id, table_number, name, status FROM tables WHERE id = ?',
          [tableId]
        );
        if (tbl[0]) {
          tableInfo = {
            id: tbl[0].id,
            tableNumber: tbl[0].table_number,
            name: tbl[0].name,
            status: tbl[0].status
          };
        }
      } catch (err) { /* ignore */ }
    }

    return {
      payment,
      invoice,
      order: updatedOrder ? {
        id: updatedOrder.id,
        orderNumber: updatedOrder.order_number,
        orderType: updatedOrder.order_type,
        status: orderStatus,
        itemCount: updatedOrder.items?.filter(i => i.status !== 'cancelled').length || 0,
        subtotal: parseFloat(updatedOrder.subtotal) || 0,
        discountAmount: parseFloat(updatedOrder.discount_amount) || 0,
        taxAmount: parseFloat(updatedOrder.tax_amount) || 0,
        totalAmount: orderTotal,
        tableName: updatedOrder.table_name || null,
        tableNumber: updatedOrder.table_number || null,
        floorName: updatedOrder.floor_name || null,
        createdByName: updatedOrder.created_by_name || null
      } : null,
      paymentSummary: {
        orderTotal,
        totalPaid: parseFloat(totalPaid.toFixed(2)),
        dueAmount: parseFloat(dueAmount.toFixed(2)),
        paymentStatus,
        paymentCount: allPayments.length,
        payments: allPayments
      },
      table: tableInfo,
      orderStatus,
      paymentStatus
    };
  },

  // ========================
  // PAYMENT RETRIEVAL
  // ========================

  async getPaymentById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT p.*, o.order_number, i.invoice_number,
        u.name as received_by_name
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN invoices i ON p.invoice_id = i.id
       LEFT JOIN users u ON p.received_by = u.id
       WHERE p.id = ?`,
      [id]
    );

    if (!rows[0]) return null;

    const payment = rows[0];

    // Get split payments if split
    if (payment.payment_mode === 'split') {
      const [splits] = await pool.query(
        'SELECT * FROM split_payments WHERE payment_id = ?',
        [id]
      );
      payment.splits = splits;
    }

    return formatPayment(payment);
  },

  async getPaymentsByOrder(orderId) {
    const pool = getPool();
    const [payments] = await pool.query(
      'SELECT * FROM payments WHERE order_id = ? ORDER BY created_at',
      [orderId]
    );
    return payments.map(formatPayment);
  },

  // ========================
  // REFUNDS
  // ========================

  async initiateRefund(data) {
    const pool = getPool();
    const {
      outletId, orderId, paymentId, refundAmount,
      refundMode, reason, requestedBy
    } = data;

    const today = new Date();
    const datePrefix = today.toISOString().slice(2, 10).replace(/-/g, '');
    const [seqResult] = await pool.query(
      `SELECT COUNT(*) + 1 as seq FROM refunds WHERE outlet_id = ? AND DATE(created_at) = CURDATE()`,
      [outletId]
    );
    const refundNumber = `REF${datePrefix}${String(seqResult[0].seq).padStart(4, '0')}`;

    const [result] = await pool.query(
      `INSERT INTO refunds (
        outlet_id, order_id, payment_id, refund_number, refund_amount,
        refund_mode, status, reason, requested_by
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [outletId, orderId, paymentId, refundNumber, refundAmount, refundMode, reason, requestedBy]
    );

    return { id: result.insertId, refundNumber, status: 'pending' };
  },

  async approveRefund(refundId, approvedBy) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [refunds] = await connection.query(
        'SELECT * FROM refunds WHERE id = ?',
        [refundId]
      );
      if (!refunds[0]) throw new Error('Refund not found');

      const refund = refunds[0];

      // Update refund status
      await connection.query(
        `UPDATE refunds SET 
          status = 'approved', approved_by = ?, approved_at = NOW()
         WHERE id = ?`,
        [approvedBy, refundId]
      );

      // Update payment
      await connection.query(
        `UPDATE payments SET 
          refund_amount = refund_amount + ?, refunded_at = NOW(), refund_reason = ?
         WHERE id = ?`,
        [refund.refund_amount, refund.reason, refund.payment_id]
      );

      // Record cash out if cash refund
      if (refund.refund_mode === 'cash') {
        await this.recordCashTransaction(connection, {
          outletId: refund.outlet_id,
          userId: approvedBy,
          type: 'refund',
          amount: -refund.refund_amount,
          referenceType: 'refund',
          referenceId: refundId,
          description: `Refund for order`
        });
      }

      await connection.commit();

      return { success: true, message: 'Refund approved' };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ========================
  // CASH DRAWER
  // ========================

  async recordCashTransaction(connection, data) {
    const {
      outletId, userId, type, amount,
      referenceType, referenceId, description
    } = data;

    // Get current balance
    const [lastTx] = await connection.query(
      `SELECT balance_after FROM cash_drawer 
       WHERE outlet_id = ? ORDER BY id DESC LIMIT 1`,
      [outletId]
    );
    const balanceBefore = parseFloat(lastTx[0]?.balance_after) || 0;
    const balanceAfter = balanceBefore + parseFloat(amount);

    await connection.query(
      `INSERT INTO cash_drawer (
        outlet_id, user_id, transaction_type, amount,
        balance_before, balance_after,
        reference_type, reference_id, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [outletId, userId, type, amount, balanceBefore, balanceAfter, referenceType, referenceId, description]
    );
  },

  /**
   * Open cash drawer / shift for a specific floor
   * @param {number} outletId - Outlet ID
   * @param {number} floorId - Floor ID (required for floor-based shifts)
   * @param {number} openingCash - Opening cash amount
   * @param {number} userId - Cashier user ID
   */
  async openCashDrawer(outletId, openingCash, userId, floorId = null, notes = null) {
    const pool = getPool();
    const today = getLocalDate();
    console.log(notes);
    // If floorId not provided, get from user's assigned floor
    if (!floorId) {
      const [userFloors] = await pool.query(
        `SELECT uf.floor_id FROM user_floors uf
         WHERE uf.user_id = ? AND uf.outlet_id = ? AND uf.is_active = 1
         ORDER BY uf.is_primary DESC LIMIT 1`,
        [userId, outletId]
      );
      if (userFloors.length > 0) {
        floorId = userFloors[0].floor_id;
      }
    }

    // Validate cashier is assigned to this floor
    if (floorId) {
      const [floorAssignment] = await pool.query(
        `SELECT uf.id FROM user_floors uf
         WHERE uf.user_id = ? AND uf.floor_id = ? AND uf.outlet_id = ? AND uf.is_active = 1`,
        [userId, floorId, outletId]
      );
      if (floorAssignment.length === 0) {
        throw new Error('You are not assigned to this floor');
      }
    }

    // Check if there's already an OPEN session for today for this floor
    const [existingOpen] = await pool.query(
      `SELECT * FROM day_sessions WHERE outlet_id = ? AND session_date = ? 
       AND (floor_id = ? OR (floor_id IS NULL AND ? IS NULL)) AND status = 'open'`,
      [outletId, today, floorId, floorId]
    );

    if (existingOpen[0]) {
      throw new Error('Shift already open for this floor');
    }

    // Always create a NEW shift - never reopen a closed one
    // Multiple shifts per day per floor are allowed (e.g., morning shift, evening shift)
    const [result] = await pool.query(
      `INSERT INTO day_sessions (
        outlet_id, floor_id, session_date, opening_time, opening_cash, status, opened_by, cashier_id, variance_notes
      ) VALUES (?, ?, ?, NOW(), ?, 'open', ?, ?, ?)`,
      [outletId, floorId, today, openingCash, userId, userId, notes]
    );
    const sessionId = result.insertId;

    await pool.query(
      `INSERT INTO cash_drawer (
        outlet_id, floor_id, user_id, transaction_type, amount,
        balance_before, balance_after, description
      ) VALUES (?, ?, ?, 'opening', ?, 0, ?, 'Shift opening')`,
      [outletId, floorId, userId, openingCash, openingCash]
    );

    // Get floor info for response
    let floorName = null;
    if (floorId) {
      const [floorInfo] = await pool.query('SELECT name FROM floors WHERE id = ?', [floorId]);
      floorName = floorInfo[0]?.name;
    }

    logger.info(`Shift opened: outlet=${outletId}, floor=${floorId}, cashier=${userId}`);

    return { success: true, openingCash, floorId, floorName, sessionId };
  },

  /**
   * Close cash drawer / shift for a specific floor
   * @param {number} outletId - Outlet ID
   * @param {number} actualCash - Actual closing cash amount
   * @param {number} userId - Cashier user ID
   * @param {string} notes - Variance notes
   * @param {number} floorId - Floor ID (optional, will use user's assigned floor)
   */
  async closeCashDrawer(outletId, actualCash, userId, notes = null, floorId = null) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const today = getLocalDate();

      // If floorId not provided, get from user's assigned floor
      if (!floorId) {
        const [userFloors] = await connection.query(
          `SELECT uf.floor_id FROM user_floors uf
           WHERE uf.user_id = ? AND uf.outlet_id = ? AND uf.is_active = 1
           ORDER BY uf.is_primary DESC LIMIT 1`,
          [userId, outletId]
        );
        if (userFloors.length > 0) {
          floorId = userFloors[0].floor_id;
        }
      }

      // Get session for this floor
      const [sessions] = await connection.query(
        `SELECT * FROM day_sessions WHERE outlet_id = ? AND session_date = ? AND status = 'open'
         AND (floor_id = ? OR (floor_id IS NULL AND ? IS NULL))`,
        [outletId, today, floorId, floorId]
      );

      if (!sessions[0]) throw new Error('No open shift found for this floor');

      const session = sessions[0];

      // Validate cashier is the one who opened or is assigned to this floor
      if (session.cashier_id && session.cashier_id !== userId) {
        const [floorAssignment] = await connection.query(
          `SELECT uf.id FROM user_floors uf
           WHERE uf.user_id = ? AND uf.floor_id = ? AND uf.outlet_id = ? AND uf.is_active = 1`,
          [userId, floorId, outletId]
        );
        if (floorAssignment.length === 0) {
          throw new Error('You are not authorized to close this floor shift');
        }
      }

      // Build shift time range for filtering (shift-specific, not day-wise)
      const sessionDateStr = session.session_date instanceof Date 
        ? session.session_date.toISOString().slice(0, 10)
        : String(session.session_date).slice(0, 10);
      
      const extractTime = (timeVal) => {
        if (!timeVal) return null;
        const str = String(timeVal);
        if (str.includes(' ')) return str.split(' ')[1] || str;
        if (str.includes('T')) return str.split('T')[1]?.slice(0, 8) || str;
        return str;
      };
      
      const openingTimeStr = extractTime(session.opening_time) || '00:00:00';
      const shiftStartTime = `${sessionDateStr} ${openingTimeStr}`;
      const now = new Date();
      const shiftEndTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

      logger.info(`Closing shift ${session.id} - Time range: ${shiftStartTime} to ${shiftEndTime}`);

      // Calculate expected cash for THIS SHIFT only (not cumulative across all shifts)
      // Expected cash = opening cash + cash sales during this shift
      const openingCash = parseFloat(session.opening_cash) || 0;
      
      // Get cash payments for this shift time range
      const [cashPayments] = await connection.query(
        `SELECT SUM(p.total_amount) as total_cash
         FROM payments p
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
           AND p.status = 'completed' AND p.payment_mode = 'cash'
           AND (t.floor_id = ? OR (t.floor_id IS NULL AND ? IS NULL) OR o.table_id IS NULL)`,
        [outletId, shiftStartTime, shiftEndTime, floorId, floorId]
      );
      
      // Get cash from split payments for this shift
      const [splitCashPayments] = await connection.query(
        `SELECT SUM(sp.amount) as total_cash
         FROM split_payments sp
         JOIN payments p ON sp.payment_id = p.id
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
           AND p.status = 'completed' AND p.payment_mode = 'split' AND sp.payment_mode = 'cash'
           AND (t.floor_id = ? OR (t.floor_id IS NULL AND ? IS NULL) OR o.table_id IS NULL)`,
        [outletId, shiftStartTime, shiftEndTime, floorId, floorId]
      );
      
      const totalCashSales = (parseFloat(cashPayments[0]?.total_cash) || 0) + (parseFloat(splitCashPayments[0]?.total_cash) || 0);
      const expectedCash = openingCash + totalCashSales;
      const variance = actualCash - expectedCash;

      logger.info(`Shift ${session.id} closing calc - Opening: ${openingCash}, CashSales: ${totalCashSales}, ExpectedCash: ${expectedCash}, ActualCash: ${actualCash}, Variance: ${variance}`);

      // Get shift totals (not day totals)
      const [shiftTotals] = await connection.query(
        `SELECT 
          COUNT(*) as total_orders,
          SUM(o.total_amount) as total_sales,
          SUM(CASE WHEN o.payment_status = 'completed' THEN o.paid_amount ELSE 0 END) as total_collected
         FROM orders o
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ? AND o.status != 'cancelled'
         AND (t.floor_id = ? OR (t.floor_id IS NULL AND ? IS NULL) OR o.table_id IS NULL)`,
        [outletId, shiftStartTime, shiftEndTime, floorId, floorId]
      );

      // Update session
      await connection.query(
        `UPDATE day_sessions SET 
          closing_time = NOW(), closing_cash = ?, expected_cash = ?,
          cash_variance = ?, total_sales = ?, total_orders = ?,
          status = 'closed', closed_by = ?, variance_notes = ?
         WHERE id = ?`,
        [
          actualCash, expectedCash, variance,
          shiftTotals[0].total_sales || 0, shiftTotals[0].total_orders || 0,
          userId, notes, session.id
        ]
      );

      // Record closing transaction
      await connection.query(
        `INSERT INTO cash_drawer (
          outlet_id, floor_id, user_id, transaction_type, amount,
          balance_before, balance_after, description
        ) VALUES (?, ?, ?, 'closing', ?, ?, ?, 'Shift closing')`,
        [outletId, floorId, userId, -expectedCash, expectedCash, 0]
      );

      await connection.commit();

      logger.info(`Shift closed: outlet=${outletId}, floor=${floorId}, cashier=${userId}`);

      return {
        success: true,
        floorId,
        expectedCash,
        actualCash,
        variance,
        totalSales: shiftTotals[0].total_sales || 0,
        totalOrders: shiftTotals[0].total_orders || 0
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Get cash drawer status for a specific floor/cashier
   * @param {number} outletId - Outlet ID
   * @param {number} floorId - Floor ID (optional)
   * @param {number} userId - User ID to get their assigned floor if floorId not provided
   */
  async getCashDrawerStatus(outletId, floorId = null, userId = null) {
    const pool = getPool();
    const today = getLocalDate();

    // If floorId not provided but userId is, get user's assigned floor
    let assignedFloor = null;
    if (!floorId && userId) {
      const [userFloors] = await pool.query(
        `SELECT uf.floor_id, f.name as floor_name, f.floor_number 
         FROM user_floors uf
         JOIN floors f ON uf.floor_id = f.id
         WHERE uf.user_id = ? AND uf.outlet_id = ? AND uf.is_active = 1
         ORDER BY uf.is_primary DESC LIMIT 1`,
        [userId, outletId]
      );
      if (userFloors.length > 0) {
        floorId = userFloors[0].floor_id;
        assignedFloor = {
          id: userFloors[0].floor_id,
          name: userFloors[0].floor_name,
          floorNumber: userFloors[0].floor_number
        };
      }
    } else if (floorId) {
      // Get floor info if floorId was provided
      const [floorInfo] = await pool.query(
        `SELECT id, name, floor_number FROM floors WHERE id = ?`,
        [floorId]
      );
      if (floorInfo[0]) {
        assignedFloor = {
          id: floorInfo[0].id,
          name: floorInfo[0].name,
          floorNumber: floorInfo[0].floor_number
        };
      }
    }

    // Get session for this floor - prioritize OPEN session, else get most recent
    // Since multiple shifts per day are now allowed, we need to find the current open one
    let sessionQuery = `
      SELECT ds.*, f.name as floor_name, u.name as cashier_name
      FROM day_sessions ds
      LEFT JOIN floors f ON ds.floor_id = f.id
      LEFT JOIN users u ON ds.cashier_id = u.id
      WHERE ds.outlet_id = ? AND ds.session_date = ?`;
    const sessionParams = [outletId, today];

    if (floorId) {
      sessionQuery += ` AND ds.floor_id = ?`;
      sessionParams.push(floorId);
    }
    
    // Order by status (open first) and then by opening_time DESC to get most recent
    sessionQuery += ` ORDER BY CASE WHEN ds.status = 'open' THEN 0 ELSE 1 END, ds.opening_time DESC LIMIT 1`;

    const [session] = await pool.query(sessionQuery, sessionParams);
    
    logger.info(`getCashDrawerStatus - Found session: ${session[0] ? `ID=${session[0].id}, status=${session[0].status}` : 'none'}, floorId=${floorId}, today=${today}`);
    
    // Check if current user is the shift owner
    const isShiftOwner = session[0] && session[0].cashier_id === userId;
    
    // Get shift timing - if session is open, use opening_time; if closed, no data
    const hasOpenShift = session[0] && session[0].status === 'open';
    
    // Helper to extract time portion from various formats
    const extractTime = (timeVal) => {
      if (!timeVal) return null;
      const str = String(timeVal);
      if (str.includes(' ')) return str.split(' ')[1] || str;
      if (str.includes('T')) return str.split('T')[1]?.slice(0, 8) || str;
      return str;
    };
    
    // Helper to format date in LOCAL timezone (not UTC)
    const formatLocalDate = (dateVal) => {
      if (!dateVal) return null;
      if (dateVal instanceof Date) {
        return `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')}`;
      }
      // If string, extract just the date part
      return String(dateVal).slice(0, 10);
    };

    // Build proper shift start and end datetime
    let shiftStartTime = null;
    let shiftEndTime = null;
    if (hasOpenShift && session[0].opening_time) {
      const sessionDate = formatLocalDate(session[0].session_date);
      const openingTime = extractTime(session[0].opening_time) || '00:00:00';
      shiftStartTime = `${sessionDate} ${openingTime}`;
      // For open shifts, use current LOCAL time as end (not UTC)
      const now = new Date();
      const localDateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      shiftEndTime = localDateTime;
    }

    logger.info(`Cash drawer status - Shift time range: ${shiftStartTime} to ${shiftEndTime}`);

    // If no open shift, return empty data structure
    if (!hasOpenShift) {
      return {
        session: session[0] ? {
          id: session[0].id,
          status: session[0].status,
          sessionDate: session[0].session_date,
          openingTime: session[0].opening_time,
          closingTime: session[0].closing_time,
          openingCash: parseFloat(session[0].opening_cash) || 0,
          floorId: session[0].floor_id,
          floorName: session[0].floor_name,
          cashierId: session[0].cashier_id,
          cashierName: session[0].cashier_name,
          isShiftOwner: isShiftOwner
        } : null,
        assignedFloor,
        floorId,
        userId,
        currentBalance: 0,
        expectedCash: 0,
        sales: {
          totalOrders: 0,
          completedOrders: 0,
          activeOrders: 0,
          totalGuests: 0,
          totalCollected: 0,
          ordersPaidInShift: 0,
          pendingAmount: 0
        },
        paymentBreakdown: { cash: 0, card: 0, upi: 0, wallet: 0, other: 0, total: 0 },
        paymentDetails: [],
        cashMovements: {
          openingCash: 0, cashSales: 0, cashIn: 0, cashOut: 0,
          refunds: 0, expenses: 0, expectedCash: 0
        },
        runningTables: {
          summary: { totalOccupiedTables: 0, totalGuests: 0, totalAmount: 0, formattedAmount: '₹0.00' },
          tables: []
        },
        recentTransactions: []
      };
    }

    // Get current balance for this floor (within shift time range)
    let balanceQuery = `
      SELECT balance_after FROM cash_drawer 
      WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?`;
    const balanceParams = [outletId, shiftStartTime, shiftEndTime];
    
    if (floorId) {
      balanceQuery += ` AND floor_id = ?`;
      balanceParams.push(floorId);
    }
    balanceQuery += ` ORDER BY id DESC LIMIT 1`;
    
    const [balance] = await pool.query(balanceQuery, balanceParams);

    // Get recent transactions for this shift (within shift time range)
    let transQuery = `
      SELECT cd.*, u.name as user_name FROM cash_drawer cd
      LEFT JOIN users u ON cd.user_id = u.id
      WHERE cd.outlet_id = ? AND cd.created_at >= ? AND cd.created_at <= ?`;
    const transParams = [outletId, shiftStartTime, shiftEndTime];
    
    if (floorId) {
      transQuery += ` AND cd.floor_id = ?`;
      transParams.push(floorId);
    }
    transQuery += ` ORDER BY cd.created_at DESC LIMIT 20`;
    
    const [transactions] = await pool.query(transQuery, transParams);

    // Build floor filter for orders - filter by cashier's assigned floor
    let floorCondition = '';
    const salesParams = [outletId, shiftStartTime, shiftEndTime];
    if (floorId) {
      floorCondition = ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in'))`;
      salesParams.push(floorId);
    }

    // Get real-time order data for this SHIFT (within shift time range)
    const [orderData] = await pool.query(
      `SELECT 
        COUNT(DISTINCT o.id) as total_orders,
        SUM(o.guest_count) as total_guests,
        SUM(CASE WHEN o.status NOT IN ('cancelled', 'paid', 'completed') THEN o.total_amount ELSE 0 END) as pending_amount,
        COUNT(CASE WHEN o.status IN ('paid', 'completed') THEN 1 END) as completed_orders,
        COUNT(CASE WHEN o.status NOT IN ('cancelled', 'paid', 'completed') THEN 1 END) as active_orders
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ? AND o.status != 'cancelled'${floorCondition}`,
      salesParams
    );

    // Get total collected in this SHIFT from payments (within shift time range)
    const collectedParams = [outletId, shiftStartTime, shiftEndTime];
    let collectedFloorCondition = '';
    if (floorId) {
      collectedFloorCondition = ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in'))`;
      collectedParams.push(floorId);
    }
    const [collectedData] = await pool.query(
      `SELECT 
        COALESCE(SUM(p.total_amount), 0) as total_collected,
        COUNT(DISTINCT p.order_id) as orders_paid_in_shift
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? AND p.status = 'completed'${collectedFloorCondition}`,
      collectedParams
    );

    // Get payment breakdown by mode for this SHIFT (within shift time range)
    // Handle both regular payments AND split payments (from split_payments table)
    const paymentParams = [outletId, shiftStartTime, shiftEndTime];
    let paymentFloorCondition = '';
    if (floorId) {
      paymentFloorCondition = ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in'))`;
      paymentParams.push(floorId);
    }

    // Query for regular payments (non-split)
    const regularPaymentParams = [...paymentParams];
    const [regularPayments] = await pool.query(
      `SELECT 
        p.payment_mode,
        COUNT(*) as transaction_count,
        SUM(p.total_amount) as total_amount
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
         AND p.status = 'completed' AND p.payment_mode != 'split'${paymentFloorCondition}
       GROUP BY p.payment_mode`,
      regularPaymentParams
    );

    // Query for split payments - get individual payment modes from split_payments table
    const splitPaymentParams = [outletId, shiftStartTime, shiftEndTime];
    if (floorId) {
      splitPaymentParams.push(floorId);
    }
    const [splitPayments] = await pool.query(
      `SELECT 
        sp.payment_mode,
        COUNT(*) as transaction_count,
        SUM(sp.amount) as total_amount
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
         AND p.status = 'completed' AND p.payment_mode = 'split'${paymentFloorCondition}
       GROUP BY sp.payment_mode`,
      splitPaymentParams
    );

    // Combine regular and split payments into one breakdown
    const paymentBreakdown = [...regularPayments, ...splitPayments];

    // Calculate payment totals
    const paymentSummary = {
      cash: 0,
      card: 0,
      upi: 0,
      wallet: 0,
      other: 0,
      total: 0
    };

    for (const pm of paymentBreakdown) {
      const amount = parseFloat(pm.total_amount) || 0;
      paymentSummary.total += amount;
      
      switch (pm.payment_mode) {
        case 'cash':
          paymentSummary.cash += amount;
          break;
        case 'card':
        case 'credit_card':
        case 'debit_card':
          paymentSummary.card += amount;
          break;
        case 'upi':
          paymentSummary.upi += amount;
          break;
        case 'wallet':
        case 'paytm':
        case 'phonepe':
        case 'gpay':
          paymentSummary.wallet += amount;
          break;
        default:
          paymentSummary.other += amount;
      }
    }

    // Get cash drawer movements for this SHIFT (within shift time range)
    const cashMovementParams = [outletId, shiftStartTime, shiftEndTime];
    let cashFloorCondition = '';
    if (floorId) {
      cashFloorCondition = ` AND floor_id = ?`;
      cashMovementParams.push(floorId);
    }

    const [cashMovements] = await pool.query(
      `SELECT 
        SUM(CASE WHEN transaction_type = 'opening' THEN amount ELSE 0 END) as opening_cash,
        SUM(CASE WHEN transaction_type = 'cash_in' THEN amount ELSE 0 END) as cash_in,
        SUM(CASE WHEN transaction_type = 'cash_out' THEN ABS(amount) ELSE 0 END) as cash_out,
        SUM(CASE WHEN transaction_type = 'refund' THEN ABS(amount) ELSE 0 END) as refunds,
        SUM(CASE WHEN transaction_type = 'expense' THEN ABS(amount) ELSE 0 END) as expenses
       FROM cash_drawer 
       WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?${cashFloorCondition}`,
      cashMovementParams
    );

    const cashSummary = cashMovements[0] || {};
    // Cash sales come from payments table (paymentSummary.cash), not cash_drawer
    const cashSalesFromPayments = paymentSummary.cash;
    
    // Get opening cash from session record (more reliable than cash_drawer)
    const openingCashFromSession = parseFloat(session[0]?.opening_cash) || 0;
    
    // Total sales = all payments (cash + card + upi + others)
    const totalSales = paymentSummary.total;
    
    // Expected amount = Opening Cash + ALL payments (cash + card + UPI etc.) + cash_in - cash_out - refunds - expenses
    const expectedAmount = 
      openingCashFromSession +
      totalSales +
      (parseFloat(cashSummary.cash_in) || 0) -
      (parseFloat(cashSummary.cash_out) || 0) -
      (parseFloat(cashSummary.refunds) || 0) -
      (parseFloat(cashSummary.expenses) || 0);
    
    // Expected cash in drawer (only cash) = opening + cash payments + cash_in - cash_out - refunds - expenses
    const expectedCashInDrawer = 
      openingCashFromSession +
      cashSalesFromPayments +
      (parseFloat(cashSummary.cash_in) || 0) -
      (parseFloat(cashSummary.cash_out) || 0) -
      (parseFloat(cashSummary.refunds) || 0) -
      (parseFloat(cashSummary.expenses) || 0);
    
    // Debug logging
    logger.info(`Cash drawer calculation - Opening: ${openingCashFromSession}, Cash Sales: ${cashSalesFromPayments}, Total Sales: ${totalSales}, Expected Amount: ${expectedAmount}, Expected Cash: ${expectedCashInDrawer}`);

    // Get running tables for this floor (occupied tables with active orders created during this shift)
    let runningTablesQuery = `
      SELECT t.id as tableId, t.table_number as tableNumber, t.name as tableName,
             t.capacity, t.status as tableStatus,
             o.id as orderId, o.order_number as orderNumber, o.status as orderStatus,
             o.total_amount as totalAmount, o.guest_count as guestCount,
             o.created_at as startedAt,
             TIMESTAMPDIFF(MINUTE, o.created_at, NOW()) as durationMinutes,
             u.name as captainName
      FROM tables t
      LEFT JOIN orders o ON o.table_id = t.id 
        AND o.status NOT IN ('paid', 'completed', 'cancelled')
        AND o.created_at >= ? AND o.created_at <= ?
      LEFT JOIN users u ON o.created_by = u.id
      WHERE t.outlet_id = ? AND t.status = 'occupied' AND t.is_active = 1`;
    const runningTablesParams = [shiftStartTime, shiftEndTime, outletId];
    
    if (floorId) {
      runningTablesQuery += ` AND t.floor_id = ?`;
      runningTablesParams.push(floorId);
    }
    runningTablesQuery += ` ORDER BY o.created_at ASC`;

    const [runningTables] = await pool.query(runningTablesQuery, runningTablesParams);

    // Calculate running tables summary
    let runningTableCount = 0, runningAmount = 0, runningGuests = 0;
    const formattedTables = runningTables.map(t => {
      runningTableCount++;
      runningAmount += parseFloat(t.totalAmount) || 0;
      runningGuests += parseInt(t.guestCount) || 0;
      
      const mins = parseInt(t.durationMinutes) || 0;
      const hours = Math.floor(mins / 60);
      const minutes = mins % 60;
      const durationFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      return {
        tableId: t.tableId,
        tableNumber: t.tableNumber,
        tableName: t.tableName,
        capacity: t.capacity,
        guestCount: parseInt(t.guestCount) || 0,
        order: t.orderId ? {
          id: t.orderId,
          orderNumber: t.orderNumber,
          status: t.orderStatus,
          totalAmount: parseFloat(t.totalAmount) || 0,
          startedAt: t.startedAt,
          durationMinutes: mins,
          durationFormatted
        } : null,
        captain: t.captainName ? { name: t.captainName } : null
      };
    });

    return {
      session: session[0] ? {
        id: session[0].id,
        status: session[0].status,
        sessionDate: session[0].session_date,
        openingTime: session[0].opening_time,
        closingTime: session[0].closing_time,
        openingCash: parseFloat(session[0].opening_cash) || 0,
        floorId: session[0].floor_id,
        floorName: session[0].floor_name,
        cashierId: session[0].cashier_id,
        cashierName: session[0].cashier_name,
        isShiftOwner: isShiftOwner  // true if current user owns this shift
      } : null,
      assignedFloor,
      floorId,
      userId,
      // Key summary values for UI
      openingAmount: openingCashFromSession,
      expectedAmount: expectedAmount,         // Opening + ALL Sales (cash + card + UPI) + Cash In - Cash Out - Refunds - Expenses
      totalSales: totalSales,                 // All payments (cash + card + UPI etc.) without opening
      currentBalance: expectedCashInDrawer,   // Expected cash in drawer only
      expectedCash: expectedCashInDrawer,     // Expected cash in drawer only
      // Real-time sales data
      sales: {
        totalOrders: parseInt(orderData[0]?.total_orders) || 0,
        completedOrders: parseInt(orderData[0]?.completed_orders) || 0,
        activeOrders: parseInt(orderData[0]?.active_orders) || 0,
        totalGuests: parseInt(orderData[0]?.total_guests) || 0,
        totalCollected: totalSales,  // Use calculated totalSales
        ordersPaidInShift: parseInt(collectedData[0]?.orders_paid_in_shift) || 0,
        pendingAmount: parseFloat(orderData[0]?.pending_amount) || 0
      },
      // Payment breakdown by mode
      paymentBreakdown: paymentSummary,
      paymentDetails: paymentBreakdown.map(p => ({
        mode: p.payment_mode,
        count: parseInt(p.transaction_count) || 0,
        amount: parseFloat(p.total_amount) || 0
      })),
      // Cash drawer movements
      cashMovements: {
        openingCash: openingCashFromSession,
        cashSales: cashSalesFromPayments,
        cashIn: parseFloat(cashSummary.cash_in) || 0,
        cashOut: parseFloat(cashSummary.cash_out) || 0,
        refunds: parseFloat(cashSummary.refunds) || 0,
        expenses: parseFloat(cashSummary.expenses) || 0,
        expectedCash: expectedCashInDrawer
      },
      recentTransactions: transactions.map(t => ({
        id: t.id,
        type: t.transaction_type,
        amount: parseFloat(t.amount) || 0,
        balanceAfter: parseFloat(t.balance_after) || 0,
        description: t.description,
        userName: t.user_name,
        createdAt: t.created_at
      })),
      // Running tables status
      runningTables: {
        summary: {
          totalOccupiedTables: runningTableCount,
          totalGuests: runningGuests,
          totalAmount: runningAmount,
          formattedAmount: `₹${runningAmount.toFixed(2)}`
        },
        tables: formattedTables
      }
    };
  },

  /**
   * Get all floor shifts status for an outlet
   * @param {number} outletId - Outlet ID
   */
  async getAllFloorShiftsStatus(outletId) {
    const pool = getPool();
    const today = getLocalDate();

    // Get all floors for this outlet
    const [floors] = await pool.query(
      `SELECT f.id, f.name, f.floor_number FROM floors f
       WHERE f.outlet_id = ? AND f.is_active = 1
       ORDER BY f.floor_number`,
      [outletId]
    );

    // Get shift status for each floor
    const floorShifts = [];
    for (const floor of floors) {
      const [session] = await pool.query(
        `SELECT ds.*, u.name as cashier_name
         FROM day_sessions ds
         LEFT JOIN users u ON ds.cashier_id = u.id
         WHERE ds.outlet_id = ? AND ds.floor_id = ? AND ds.session_date = ?`,
        [outletId, floor.id, today]
      );

      // Get assigned cashiers for this floor
      const [cashiers] = await pool.query(
        `SELECT u.id, u.name FROM users u
         JOIN user_floors uf ON u.id = uf.user_id
         JOIN user_roles ur ON u.id = ur.user_id AND ur.outlet_id = uf.outlet_id
         JOIN roles r ON ur.role_id = r.id
         WHERE uf.floor_id = ? AND uf.outlet_id = ? AND uf.is_active = 1
         AND r.slug = 'cashier' AND ur.is_active = 1`,
        [floor.id, outletId]
      );

      floorShifts.push({
        floorId: floor.id,
        floorName: floor.name,
        floorNumber: floor.floor_number,
        shift: session[0] ? {
          id: session[0].id,
          status: session[0].status,
          openingTime: session[0].opening_time,
          closingTime: session[0].closing_time,
          openingCash: parseFloat(session[0].opening_cash) || 0,
          cashierId: session[0].cashier_id,
          cashierName: session[0].cashier_name
        } : null,
        assignedCashiers: cashiers,
        isShiftOpen: session[0]?.status === 'open'
      });
    }

    return { floors: floorShifts, date: today };
  },

  /**
   * Check if shift is open for a specific floor
   * @param {number} outletId - Outlet ID
   * @param {number} floorId - Floor ID
   * @returns {Object} - Shift status info
   */
  async isFloorShiftOpen(outletId, floorId) {
    const pool = getPool();
    const today = getLocalDate();

    const [session] = await pool.query(
      `SELECT ds.id, ds.status, ds.cashier_id, u.name as cashier_name, f.name as floor_name
       FROM day_sessions ds
       LEFT JOIN users u ON ds.cashier_id = u.id
       LEFT JOIN floors f ON ds.floor_id = f.id
       WHERE ds.outlet_id = ? AND ds.floor_id = ? AND ds.session_date = ? AND ds.status = 'open'`,
      [outletId, floorId, today]
    );

    return {
      isOpen: !!session[0],
      shiftId: session[0]?.id || null,
      cashierId: session[0]?.cashier_id || null,
      cashierName: session[0]?.cashier_name || null,
      floorName: session[0]?.floor_name || null
    };
  },

  /**
   * Get cashier assigned to a floor
   * @param {number} outletId - Outlet ID
   * @param {number} floorId - Floor ID
   */
  async getFloorCashier(outletId, floorId) {
    const pool = getPool();

    const [cashiers] = await pool.query(
      `SELECT u.id, u.name, u.email, uf.is_primary
       FROM users u
       JOIN user_floors uf ON u.id = uf.user_id
       JOIN user_roles ur ON u.id = ur.user_id AND ur.outlet_id = uf.outlet_id
       JOIN roles r ON ur.role_id = r.id
       WHERE uf.floor_id = ? AND uf.outlet_id = ? AND uf.is_active = 1
       AND r.slug = 'cashier' AND ur.is_active = 1
       ORDER BY uf.is_primary DESC`,
      [floorId, outletId]
    );

    return cashiers[0] || null;
  },

  // ========================
  // SHIFT HISTORY
  // ========================

  /**
   * Get shift history with pagination, filtering, and full details
   * @param {Object} params - Query parameters
   * @returns {Object} - Paginated shift history with summary
   */
  async getShiftHistory(params) {
    const pool = getPool();
    const {
      outletId,
      userId = null,
      floorId = null,
      cashierId = null,
      startDate = null,
      endDate = null,
      status = null, // 'open', 'closed', 'all'
      page = 1,
      limit = 20,
      sortBy = 'session_date',
      sortOrder = 'DESC'
    } = params;

    const offset = (page - 1) * limit;
    const conditions = ['ds.outlet_id = ?'];
    const queryParams = [outletId];

    // Filter by floor
    if (floorId) {
      conditions.push('ds.floor_id = ?');
      queryParams.push(floorId);
    }

    // Filter by cashier (the one who opened the shift)
    if (cashierId) {
      conditions.push('ds.cashier_id = ?');
      queryParams.push(cashierId);
    }

    // Filter by user (opened_by or closed_by) - for backward compatibility
    if (userId) {
      conditions.push('(ds.opened_by = ? OR ds.closed_by = ? OR ds.cashier_id = ?)');
      queryParams.push(userId, userId, userId);
    }

    // Date range filter
    if (startDate) {
      conditions.push('ds.session_date >= ?');
      queryParams.push(startDate);
    }
    if (endDate) {
      conditions.push('ds.session_date <= ?');
      queryParams.push(endDate);
    }

    // Status filter
    if (status && status !== 'all') {
      conditions.push('ds.status = ?');
      queryParams.push(status);
    }

    const whereClause = conditions.join(' AND ');

    // Validate sort columns - default to opening_time DESC (newest first)
    const allowedSortColumns = ['session_date', 'opening_time', 'closing_time', 'total_sales', 'total_orders', 'cash_variance', 'id'];
    const safeSort = allowedSortColumns.includes(sortBy) ? sortBy : 'opening_time';
    const safeOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Get total count
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total FROM day_sessions ds WHERE ${whereClause}`,
      queryParams
    );
    const total = countResult[0].total;

    // Get shifts with user and floor details
    const [shifts] = await pool.query(
      `SELECT 
        ds.*,
        o.name as outlet_name,
        f.name as floor_name,
        f.floor_number,
        cashier.name as cashier_name,
        opener.name as opened_by_name,
        closer.name as closed_by_name
       FROM day_sessions ds
       LEFT JOIN outlets o ON ds.outlet_id = o.id
       LEFT JOIN floors f ON ds.floor_id = f.id
       LEFT JOIN users cashier ON ds.cashier_id = cashier.id
       LEFT JOIN users opener ON ds.opened_by = opener.id
       LEFT JOIN users closer ON ds.closed_by = closer.id
       WHERE ${whereClause}
       ORDER BY ds.${safeSort} ${safeOrder}
       LIMIT ? OFFSET ?`,
      [...queryParams, parseInt(limit), parseInt(offset)]
    );

    // Helper to format date in LOCAL timezone (not UTC)
    const formatLocalDate = (dateVal) => {
      if (!dateVal) return null;
      if (dateVal instanceof Date) {
        return `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')}`;
      }
      return String(dateVal).slice(0, 10);
    };

    // Helper to extract time portion
    const extractTime = (timeVal) => {
      if (!timeVal) return null;
      const str = String(timeVal);
      if (str.includes(' ')) return str.split(' ')[1] || str;
      if (str.includes('T')) return str.split('T')[1]?.slice(0, 8) || str;
      return str;
    };

    // Calculate real-time values for each shift based on shift time range
    const formattedShifts = await Promise.all(shifts.map(async (shift) => {
      const sessionDateStr = formatLocalDate(shift.session_date);
      const openingTimeStr = extractTime(shift.opening_time) || '00:00:00';
      const closingTimeStr = extractTime(shift.closing_time);
      
      const shiftStartTime = `${sessionDateStr} ${openingTimeStr}`;
      let shiftEndTime;
      if (closingTimeStr) {
        shiftEndTime = `${sessionDateStr} ${closingTimeStr}`;
      } else if (shift.status === 'open') {
        const now = new Date();
        shiftEndTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      } else {
        shiftEndTime = `${sessionDateStr} 23:59:59`;
      }

      // Calculate payment breakdown from payments + split_payments within shift time range
      // Must join with orders table for floor filtering (payments table has no floor_id)
      const floorCondition = shift.floor_id ? ' AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != \'dine_in\'))' : '';
      const floorParams = shift.floor_id ? [shift.floor_id] : [];

      // Regular payments (non-split) - join orders for floor filtering
      const [regularPayments] = await pool.query(
        `SELECT p.payment_mode, SUM(p.total_amount) as total
         FROM payments p
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
           AND p.status = 'completed' AND p.payment_mode != 'split'${floorCondition}
         GROUP BY p.payment_mode`,
        [shift.outlet_id, shiftStartTime, shiftEndTime, ...floorParams]
      );

      // Split payments - join orders for floor filtering
      const [splitPayments] = await pool.query(
        `SELECT sp.payment_mode, SUM(sp.amount) as total
         FROM split_payments sp
         JOIN payments p ON sp.payment_id = p.id
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
           AND p.status = 'completed' AND p.payment_mode = 'split'${floorCondition}
         GROUP BY sp.payment_mode`,
        [shift.outlet_id, shiftStartTime, shiftEndTime, ...floorParams]
      );

      // Calculate totals
      let totalCashSales = 0, totalCardSales = 0, totalUpiSales = 0, totalOtherSales = 0;
      let totalSales = 0;
      for (const p of [...regularPayments, ...splitPayments]) {
        const amount = parseFloat(p.total) || 0;
        totalSales += amount;
        if (p.payment_mode === 'cash') totalCashSales += amount;
        else if (p.payment_mode === 'card' || p.payment_mode === 'credit_card' || p.payment_mode === 'debit_card') totalCardSales += amount;
        else if (p.payment_mode === 'upi') totalUpiSales += amount;
        else totalOtherSales += amount;
      }

      const openingCash = parseFloat(shift.opening_cash) || 0;
      const closingCash = parseFloat(shift.closing_cash) || 0;
      const expectedAmount = openingCash + totalSales;
      const expectedCash = openingCash + totalCashSales;
      // Calculate cash variance: actual closing cash vs expected cash (positive = over, negative = short)
      const cashVariance = shift.status === 'closed' ? (closingCash - expectedCash) : 0;

      logger.info(`Shift ${shift.id} history calc - Time: ${shiftStartTime} to ${shiftEndTime}, Opening: ${openingCash}, Cash: ${totalCashSales}, UPI: ${totalUpiSales}, Card: ${totalCardSales}, Total: ${totalSales}, Expected: ${expectedAmount}, ExpectedCash: ${expectedCash}, ClosingCash: ${closingCash}, Variance: ${cashVariance}`);

      return {
        id: shift.id,
        outletId: shift.outlet_id,
        outletName: shift.outlet_name,
        floorId: shift.floor_id,
        floorName: shift.floor_name,
        floorNumber: shift.floor_number,
        cashierId: shift.cashier_id,
        cashierName: shift.cashier_name,
        sessionDate: shift.session_date,
        openingTime: shift.opening_time,
        closingTime: shift.closing_time,
        openingCash: openingCash,
        closingCash: closingCash,
        expectedAmount: expectedAmount,
        expectedCash: expectedCash,
        cashVariance: cashVariance,
        totalSales: totalSales,
        totalOrders: shift.total_orders || 0,
        totalCashSales: totalCashSales,
        totalCardSales: totalCardSales,
        totalUpiSales: totalUpiSales,
        totalOtherSales: totalOtherSales,
        totalDiscounts: parseFloat(shift.total_discounts) || 0,
        totalRefunds: parseFloat(shift.total_refunds) || 0,
        totalCancellations: parseFloat(shift.total_cancellations) || 0,
        status: shift.status,
        openedBy: shift.opened_by,
        openedByName: shift.opened_by_name,
        closedBy: shift.closed_by,
        closedByName: shift.closed_by_name,
        varianceNotes: shift.variance_notes,
        createdAt: shift.created_at,
        updatedAt: shift.updated_at
      };
    }));

    return {
      shifts: formattedShifts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      }
    };
  },

  /**
   * Get detailed shift by ID with all transactions
   * @param {number} shiftId - Day session ID
   * @param {number} cashierId - If provided, verify shift belongs to this cashier
   * @returns {Object} - Detailed shift with transactions
   */
  async getShiftDetail(shiftId, cashierId = null) {
    const pool = getPool();

    // Get shift details
    const [shifts] = await pool.query(
      `SELECT 
        ds.*,
        o.name as outlet_name,
        f.name as floor_name,
        opener.name as opened_by_name,
        closer.name as closed_by_name,
        cashier.name as cashier_name
       FROM day_sessions ds
       LEFT JOIN outlets o ON ds.outlet_id = o.id
       LEFT JOIN floors f ON ds.floor_id = f.id
       LEFT JOIN users opener ON ds.opened_by = opener.id
       LEFT JOIN users closer ON ds.closed_by = closer.id
       LEFT JOIN users cashier ON ds.cashier_id = cashier.id
       WHERE ds.id = ?`,
      [shiftId]
    );

    if (!shifts[0]) {
      throw new Error('Shift not found');
    }

    const shift = shifts[0];

    // If cashierId provided, verify this shift belongs to the cashier
    if (cashierId && shift.cashier_id && shift.cashier_id !== cashierId) {
      throw new Error('You can only view your own shifts');
    }

    // Build floor filter for queries - use shift's floor_id
    const floorId = shift.floor_id;

    // Build shift time range for filtering (shift-specific, not day-wise)
    // Helper to format date in LOCAL timezone (not UTC)
    const formatLocalDate = (dateVal) => {
      if (!dateVal) return null;
      if (dateVal instanceof Date) {
        return `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')}`;
      }
      return String(dateVal).slice(0, 10);
    };
    
    const sessionDateStr = formatLocalDate(shift.session_date);
    
    // Helper to extract time portion from various formats
    const extractTime = (timeVal) => {
      if (!timeVal) return null;
      const str = String(timeVal);
      if (str.includes(' ')) return str.split(' ')[1] || str;
      if (str.includes('T')) return str.split('T')[1]?.slice(0, 8) || str;
      return str;
    };
    
    // Format opening_time and closing_time
    const openingTimeStr = extractTime(shift.opening_time) || '00:00:00';
    const closingTimeStr = extractTime(shift.closing_time);
    
    // Combine date and time for shift range
    const shiftStartTime = `${sessionDateStr} ${openingTimeStr}`;
    // For open shifts, use current LOCAL time as end (not UTC); for closed shifts use closing_time
    let shiftEndTime;
    if (closingTimeStr) {
      shiftEndTime = `${sessionDateStr} ${closingTimeStr}`;
    } else if (shift.status === 'open') {
      const now = new Date();
      shiftEndTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    } else {
      shiftEndTime = `${sessionDateStr} 23:59:59`;
    }

    // Debug log for shift time range
    logger.info(`Shift ${shiftId} time range: ${shiftStartTime} to ${shiftEndTime} (status: ${shift.status})`);

    // Get all cash drawer transactions for this shift (filtered by shift time range)
    let transQuery = `
      SELECT cd.*, u.name as user_name
      FROM cash_drawer cd
      LEFT JOIN users u ON cd.user_id = u.id
      WHERE cd.outlet_id = ? AND cd.created_at >= ? AND cd.created_at <= ?`;
    const transParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    
    if (floorId) {
      transQuery += ` AND cd.floor_id = ?`;
      transParams.push(floorId);
    }
    if (cashierId) {
      transQuery += ` AND cd.user_id = ?`;
      transParams.push(cashierId);
    }
    transQuery += ` ORDER BY cd.created_at ASC`;
    
    const [transactions] = await pool.query(transQuery, transParams);

    // Get payment breakdown for the shift (filtered by shift time range)
    // Handle both regular payments AND split payments (from split_payments table)
    // Must join with orders table for floor filtering (payments table has no floor_id)
    const paymentParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    let paymentFloorCondition = '';
    if (floorId) {
      paymentFloorCondition = ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in'))`;
      paymentParams.push(floorId);
    }

    // Query for regular payments (non-split) - join orders for floor filtering
    const [regularPayments] = await pool.query(
      `SELECT p.payment_mode, COUNT(*) as count, SUM(p.total_amount) as total
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
         AND p.status = 'completed' AND p.payment_mode != 'split'${paymentFloorCondition}
       GROUP BY p.payment_mode`,
      paymentParams
    );

    // Query for split payments - get individual payment modes from split_payments table
    const splitParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    if (floorId) {
      splitParams.push(floorId);
    }
    const [splitPayments] = await pool.query(
      `SELECT sp.payment_mode, COUNT(*) as count, SUM(sp.amount) as total
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
         AND p.status = 'completed' AND p.payment_mode = 'split'${paymentFloorCondition}
       GROUP BY sp.payment_mode`,
      splitParams
    );

    // Combine regular and split payments
    const paymentBreakdown = [...regularPayments, ...splitPayments];

    // Get order statistics (filtered by shift time range)
    // Also calculate real-time total_sales and total_orders for open shifts
    let orderQuery = `
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status IN ('completed', 'paid') THEN 1 ELSE 0 END) as completed_orders,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN order_type = 'dine_in' AND status != 'cancelled' THEN 1 ELSE 0 END) as dine_in_orders,
        SUM(CASE WHEN order_type = 'takeaway' AND status != 'cancelled' THEN 1 ELSE 0 END) as takeaway_orders,
        SUM(CASE WHEN order_type = 'delivery' AND status != 'cancelled' THEN 1 ELSE 0 END) as delivery_orders,
        SUM(CASE WHEN status IN ('completed', 'paid') THEN total_amount ELSE 0 END) as real_total_sales,
        AVG(CASE WHEN status != 'cancelled' THEN total_amount ELSE NULL END) as avg_order_value,
        MAX(CASE WHEN status != 'cancelled' THEN total_amount ELSE NULL END) as max_order_value,
        MIN(CASE WHEN status != 'cancelled' AND total_amount > 0 THEN total_amount ELSE NULL END) as min_order_value
      FROM orders
      WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?`;
    const orderParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    
    if (floorId) {
      orderQuery += ` AND floor_id = ?`;
      orderParams.push(floorId);
    }
    
    const [orderStats] = await pool.query(orderQuery, orderParams);
    
    // Calculate payment totals from payment breakdown (handles split payments correctly)
    let totalCashSales = 0, totalCardSales = 0, totalUpiSales = 0, totalOtherSales = 0;
    let calculatedTotalSales = 0;
    for (const p of paymentBreakdown) {
      const amount = parseFloat(p.total) || 0;
      calculatedTotalSales += amount;
      if (p.payment_mode === 'cash') totalCashSales += amount;
      else if (p.payment_mode === 'card' || p.payment_mode === 'credit_card' || p.payment_mode === 'debit_card') totalCardSales += amount;
      else if (p.payment_mode === 'upi') totalUpiSales += amount;
      else totalOtherSales += amount;
    }

    const openingCash = parseFloat(shift.opening_cash) || 0;
    const closingCash = parseFloat(shift.closing_cash) || 0;
    const expectedAmount = openingCash + calculatedTotalSales;
    const expectedCash = openingCash + totalCashSales;
    // Calculate cash variance: actual closing cash vs expected cash (positive = over, negative = short)
    const cashVariance = shift.status === 'closed' ? (closingCash - expectedCash) : 0;
    
    // Use calculated values for accuracy
    const realTotalOrders = parseInt(orderStats[0]?.completed_orders) || 0;

    logger.info(`Shift ${shiftId} detail calc - Time: ${shiftStartTime} to ${shiftEndTime}, Opening: ${openingCash}, Cash: ${totalCashSales}, UPI: ${totalUpiSales}, Card: ${totalCardSales}, Total: ${calculatedTotalSales}, Expected: ${expectedAmount}, ExpectedCash: ${expectedCash}, ClosingCash: ${closingCash}, Variance: ${cashVariance}`);

    // Get staff who worked during this shift (filtered by shift time range)
    let staffQuery = `
      SELECT 
        u.id as user_id,
        u.name as user_name,
        COUNT(DISTINCT CASE WHEN o.status != 'cancelled' THEN o.id ELSE NULL END) as orders_handled,
        SUM(CASE WHEN o.status != 'cancelled' THEN o.total_amount ELSE 0 END) as total_sales
      FROM orders o
      JOIN users u ON o.created_by = u.id
      WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ?`;
    const staffParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    
    if (floorId) {
      staffQuery += ` AND o.floor_id = ?`;
      staffParams.push(floorId);
    }
    staffQuery += ` GROUP BY u.id, u.name ORDER BY total_sales DESC`;
    
    const [staffActivity] = await pool.query(staffQuery, staffParams);

    // Get orders with items and payment status during this shift
    let ordersQuery = `
      SELECT 
        o.id, o.uuid, o.order_number, o.order_type, o.status, o.payment_status,
        o.customer_name, o.customer_phone,
        o.subtotal, o.tax_amount, o.discount_amount, o.total_amount,
        o.created_at, o.updated_at,
        u.name as created_by_name,
        t.table_number, t.name as table_name,
        p.payment_mode, p.total_amount as paid_amount, p.status as payment_record_status
      FROM orders o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'completed'
      WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ?`;
    const ordersParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    
    if (floorId) {
      ordersQuery += ` AND o.floor_id = ?`;
      ordersParams.push(floorId);
    }
    ordersQuery += ` ORDER BY o.created_at DESC`;
    
    const [ordersRaw] = await pool.query(ordersQuery, ordersParams);

    // Get all order IDs to fetch items
    const orderIds = [...new Set(ordersRaw.map(o => o.id))];
    
    let orderItemsMap = {};
    if (orderIds.length > 0) {
      const [allItems] = await pool.query(`
        SELECT 
          oi.order_id, oi.item_name, oi.variant_name, oi.quantity, 
          oi.unit_price, oi.total_price, oi.status as item_status
        FROM order_items oi
        WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')})
        ORDER BY oi.id
      `, orderIds);
      
      for (const item of allItems) {
        if (!orderItemsMap[item.order_id]) {
          orderItemsMap[item.order_id] = [];
        }
        orderItemsMap[item.order_id].push({
          itemName: item.item_name,
          variantName: item.variant_name,
          quantity: item.quantity,
          unitPrice: parseFloat(item.unit_price) || 0,
          totalPrice: parseFloat(item.total_price) || 0,
          status: item.item_status
        });
      }
    }

    // Format orders with items - deduplicate orders (may have multiple payment rows)
    const ordersMap = new Map();
    for (const row of ordersRaw) {
      if (!ordersMap.has(row.id)) {
        ordersMap.set(row.id, {
          id: row.id,
          uuid: row.uuid,
          orderNumber: row.order_number,
          orderType: row.order_type,
          status: row.status,
          paymentStatus: row.payment_status,
          tableNumber: row.table_number,
          tableName: row.table_name,
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          subtotal: parseFloat(row.subtotal) || 0,
          taxAmount: parseFloat(row.tax_amount) || 0,
          discountAmount: parseFloat(row.discount_amount) || 0,
          totalAmount: parseFloat(row.total_amount) || 0,
          createdByName: row.created_by_name,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          paymentMode: row.payment_mode,
          paidAmount: parseFloat(row.paid_amount) || 0,
          items: orderItemsMap[row.id] || []
        });
      }
    }
    const shiftOrders = Array.from(ordersMap.values());

    // Format transactions
    const formattedTransactions = transactions.map(tx => ({
      id: tx.id,
      type: tx.transaction_type,
      amount: parseFloat(tx.amount) || 0,
      balanceBefore: parseFloat(tx.balance_before) || 0,
      balanceAfter: parseFloat(tx.balance_after) || 0,
      referenceType: tx.reference_type,
      referenceId: tx.reference_id,
      description: tx.description,
      notes: tx.notes,
      userId: tx.user_id,
      userName: tx.user_name,
      createdAt: tx.created_at
    }));

    // Format payment breakdown
    const formattedPayments = paymentBreakdown.map(p => ({
      mode: p.payment_mode,
      count: p.count,
      total: parseFloat(p.total) || 0
    }));

    // Create payment breakdown summary object
    const paymentSummary = {
      cash: totalCashSales,
      card: totalCardSales,
      upi: totalUpiSales,
      other: totalOtherSales,
      total: calculatedTotalSales
    };

    return {
      id: shift.id,
      outletId: shift.outlet_id,
      outletName: shift.outlet_name,
      floorId: shift.floor_id,
      floorName: shift.floor_name,
      cashierId: shift.cashier_id,
      cashierName: shift.cashier_name,
      sessionDate: shift.session_date,
      openingTime: shift.opening_time,
      closingTime: shift.closing_time,
      // Key calculated values
      openingAmount: openingCash,
      openingCash: openingCash,
      closingCash: closingCash,
      expectedAmount: expectedAmount,       // Opening + ALL Sales
      expectedCash: expectedCash,           // Opening + Cash Sales only
      cashVariance: cashVariance,           // Calculated: closingCash - expectedCash
      // Real-time calculated totals
      totalSales: calculatedTotalSales,
      totalOrders: realTotalOrders,
      totalCashSales: totalCashSales,
      totalCardSales: totalCardSales,
      totalUpiSales: totalUpiSales,
      totalOtherSales: totalOtherSales,
      totalDiscounts: parseFloat(shift.total_discounts) || 0,
      totalRefunds: parseFloat(shift.total_refunds) || 0,
      totalCancellations: parseFloat(shift.total_cancellations) || 0,
      status: shift.status,
      openedBy: shift.opened_by,
      openedByName: shift.opened_by_name,
      closedBy: shift.closed_by,
      closedByName: shift.closed_by_name,
      varianceNotes: shift.variance_notes,
      transactions: formattedTransactions,
      paymentBreakdown: formattedPayments,
      paymentSummary: paymentSummary,       // Structured payment breakdown
      orderStats: {
        totalOrders: orderStats[0]?.total_orders || 0,
        completedOrders: orderStats[0]?.completed_orders || 0,
        cancelledOrders: orderStats[0]?.cancelled_orders || 0,
        dineInOrders: orderStats[0]?.dine_in_orders || 0,
        takeawayOrders: orderStats[0]?.takeaway_orders || 0,
        deliveryOrders: orderStats[0]?.delivery_orders || 0,
        avgOrderValue: parseFloat(orderStats[0]?.avg_order_value) || 0,
        maxOrderValue: parseFloat(orderStats[0]?.max_order_value) || 0,
        minOrderValue: parseFloat(orderStats[0]?.min_order_value) || 0
      },
      staffActivity: staffActivity.map(s => ({
        userId: s.user_id,
        userName: s.user_name,
        ordersHandled: s.orders_handled,
        totalSales: parseFloat(s.total_sales) || 0
      })),
      orders: shiftOrders,
      createdAt: shift.created_at,
      updatedAt: shift.updated_at
    };
  },

  /**
   * Get single shift summary by ID with shift-time-based calculations
   * @param {number} shiftId - Shift (day_session) ID
   * @param {number} cashierId - If provided, verify shift belongs to this cashier
   * @returns {Object} - Shift summary with real-time calculations
   */
  async getShiftSummaryById(shiftId, cashierId = null) {
    const pool = getPool();

    // Get shift details
    const [shifts] = await pool.query(
      `SELECT 
        ds.*,
        o.name as outlet_name,
        f.name as floor_name,
        cashier.name as cashier_name
       FROM day_sessions ds
       LEFT JOIN outlets o ON ds.outlet_id = o.id
       LEFT JOIN floors f ON ds.floor_id = f.id
       LEFT JOIN users cashier ON ds.cashier_id = cashier.id
       WHERE ds.id = ?`,
      [shiftId]
    );

    if (!shifts[0]) {
      throw new Error('Shift not found');
    }

    const shift = shifts[0];

    // If cashierId provided, verify this shift belongs to the cashier
    if (cashierId && shift.cashier_id && shift.cashier_id !== cashierId) {
      throw new Error('You can only view your own shifts');
    }

    // Build shift time range for filtering (shift-specific, not day-wise)
    // Helper to format date in LOCAL timezone (not UTC)
    const formatLocalDate = (dateVal) => {
      if (!dateVal) return null;
      if (dateVal instanceof Date) {
        return `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')}`;
      }
      return String(dateVal).slice(0, 10);
    };
    
    const sessionDateStr = formatLocalDate(shift.session_date);
    
    // Helper to extract time portion from various formats
    const extractTime = (timeVal) => {
      if (!timeVal) return null;
      const str = String(timeVal);
      if (str.includes(' ')) return str.split(' ')[1] || str;
      if (str.includes('T')) return str.split('T')[1]?.slice(0, 8) || str;
      return str;
    };
    
    const openingTimeStr = extractTime(shift.opening_time) || '00:00:00';
    const closingTimeStr = extractTime(shift.closing_time);
    
    const shiftStartTime = `${sessionDateStr} ${openingTimeStr}`;
    // For open shifts, use current LOCAL time as end (not UTC); for closed shifts use closing_time
    let shiftEndTime;
    if (closingTimeStr) {
      shiftEndTime = `${sessionDateStr} ${closingTimeStr}`;
    } else if (shift.status === 'open') {
      const now = new Date();
      shiftEndTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    } else {
      shiftEndTime = `${sessionDateStr} 23:59:59`;
    }

    logger.info(`Shift ${shiftId} summary time range: ${shiftStartTime} to ${shiftEndTime} (status: ${shift.status})`);

    const floorId = shift.floor_id;

    // Get order statistics within shift time range
    let orderQuery = `
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status IN ('completed', 'paid') THEN 1 ELSE 0 END) as completed_orders,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN status IN ('completed', 'paid') THEN total_amount ELSE 0 END) as total_sales,
        SUM(CASE WHEN order_type = 'dine_in' AND status != 'cancelled' THEN 1 ELSE 0 END) as dine_in_orders,
        SUM(CASE WHEN order_type = 'takeaway' AND status != 'cancelled' THEN 1 ELSE 0 END) as takeaway_orders,
        SUM(CASE WHEN order_type = 'delivery' AND status != 'cancelled' THEN 1 ELSE 0 END) as delivery_orders,
        AVG(CASE WHEN status != 'cancelled' THEN total_amount ELSE NULL END) as avg_order_value,
        MAX(CASE WHEN status != 'cancelled' THEN total_amount ELSE NULL END) as max_order_value,
        MIN(CASE WHEN status != 'cancelled' AND total_amount > 0 THEN total_amount ELSE NULL END) as min_order_value
      FROM orders
      WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?`;
    const orderParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    
    if (floorId) {
      orderQuery += ` AND floor_id = ?`;
      orderParams.push(floorId);
    }
    
    const [orderStats] = await pool.query(orderQuery, orderParams);

    // Get payment breakdown within shift time range
    // Handle both regular payments AND split payments (from split_payments table)
    // Must join with orders table for floor filtering (payments table has no floor_id)
    const paymentParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    let paymentFloorCondition = '';
    if (floorId) {
      paymentFloorCondition = ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in'))`;
      paymentParams.push(floorId);
    }

    // Query for regular payments (non-split) - join orders for floor filtering
    const [regularPayments] = await pool.query(
      `SELECT p.payment_mode, COUNT(*) as count, SUM(p.total_amount) as total
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
         AND p.status = 'completed' AND p.payment_mode != 'split'${paymentFloorCondition}
       GROUP BY p.payment_mode`,
      paymentParams
    );

    // Query for split payments - join orders for floor filtering
    const splitParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    if (floorId) {
      splitParams.push(floorId);
    }
    const [splitPayments] = await pool.query(
      `SELECT sp.payment_mode, COUNT(*) as count, SUM(sp.amount) as total
       FROM split_payments sp
       JOIN payments p ON sp.payment_id = p.id
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
         AND p.status = 'completed' AND p.payment_mode = 'split'${paymentFloorCondition}
       GROUP BY sp.payment_mode`,
      splitParams
    );

    // Combine regular and split payments
    const paymentBreakdown = [...regularPayments, ...splitPayments];

    // Calculate payment totals from combined payment breakdown
    let totalCashSales = 0, totalCardSales = 0, totalUpiSales = 0, totalOtherSales = 0;
    let totalPayments = 0;
    for (const p of paymentBreakdown) {
      const amount = parseFloat(p.total) || 0;
      totalPayments += amount;
      if (p.payment_mode === 'cash') totalCashSales += amount;
      else if (p.payment_mode === 'card' || p.payment_mode === 'credit_card' || p.payment_mode === 'debit_card') totalCardSales += amount;
      else if (p.payment_mode === 'upi') totalUpiSales += amount;
      else totalOtherSales += amount;
    }

    // Calculate values
    const openingCash = parseFloat(shift.opening_cash) || 0;
    
    // Total sales = all payments (cash + card + UPI)
    const totalSalesAmount = totalPayments;
    
    // Expected amount = Opening + ALL payments (cash + card + UPI)
    const expectedAmount = openingCash + totalPayments;
    
    // Expected cash in drawer = Opening + Cash Sales only
    const expectedCashInDrawer = openingCash + totalCashSales;

    logger.info(`Shift ${shiftId} summary - Opening: ${openingCash}, Cash Sales: ${totalCashSales}, Total Sales: ${totalPayments}, Expected Amount: ${expectedAmount}, Expected Cash: ${expectedCashInDrawer}`);

    return {
      id: shift.id,
      outletId: shift.outlet_id,
      outletName: shift.outlet_name,
      floorId: shift.floor_id,
      floorName: shift.floor_name,
      cashierId: shift.cashier_id,
      cashierName: shift.cashier_name,
      sessionDate: shift.session_date,
      openingTime: shift.opening_time,
      closingTime: shift.closing_time,
      status: shift.status,
      // Key values
      openingAmount: openingCash,
      openingCash: openingCash,
      closingCash: parseFloat(shift.closing_cash) || 0,
      expectedAmount: expectedAmount,          // Opening + ALL Sales (cash + card + UPI)
      expectedCash: expectedCashInDrawer,      // Opening + Cash Sales only (expected in drawer)
      cashVariance: parseFloat(shift.cash_variance) || 0,
      // Real-time calculated values based on shift time range
      totalSales: totalSalesAmount,  // All payments (cash + card + UPI etc.)
      totalOrders: parseInt(orderStats[0]?.completed_orders) || 0,
      totalCashSales,
      totalCardSales,
      totalUpiSales,
      totalOtherSales,
      orderStats: {
        totalOrders: parseInt(orderStats[0]?.total_orders) || 0,
        completedOrders: parseInt(orderStats[0]?.completed_orders) || 0,
        cancelledOrders: parseInt(orderStats[0]?.cancelled_orders) || 0,
        dineInOrders: parseInt(orderStats[0]?.dine_in_orders) || 0,
        takeawayOrders: parseInt(orderStats[0]?.takeaway_orders) || 0,
        deliveryOrders: parseInt(orderStats[0]?.delivery_orders) || 0,
        avgOrderValue: parseFloat(orderStats[0]?.avg_order_value) || 0,
        maxOrderValue: parseFloat(orderStats[0]?.max_order_value) || 0,
        minOrderValue: parseFloat(orderStats[0]?.min_order_value) || 0
      },
      paymentBreakdown: paymentBreakdown.map(p => ({
        mode: p.payment_mode,
        count: parseInt(p.count) || 0,
        total: parseFloat(p.total) || 0
      })),
      shiftTimeRange: {
        start: shiftStartTime,
        end: shiftEndTime
      }
    };
  },

  /**
   * Get shift summary statistics across date range
   * @param {Object} params - Query parameters (outletId, startDate, endDate, floorId, cashierId)
   * @returns {Object} - Summary statistics
   */
  async getShiftSummary(params) {
    const pool = getPool();
    const {
      outletId,
      startDate = null,
      endDate = null,
      floorId = null,
      cashierId = null
    } = params;

    const conditions = ['outlet_id = ?'];
    const queryParams = [outletId];

    if (startDate) {
      conditions.push('session_date >= ?');
      queryParams.push(startDate);
    }
    if (endDate) {
      conditions.push('session_date <= ?');
      queryParams.push(endDate);
    }
    // Filter by floor for floor-based isolation
    if (floorId) {
      conditions.push('floor_id = ?');
      queryParams.push(floorId);
    }
    // Filter by cashier for cashier-based isolation
    if (cashierId) {
      conditions.push('cashier_id = ?');
      queryParams.push(cashierId);
    }

    const whereClause = conditions.join(' AND ');

    const [summary] = await pool.query(
      `SELECT 
        COUNT(*) as total_shifts,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_shifts,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_shifts,
        SUM(total_sales) as total_sales,
        SUM(total_orders) as total_orders,
        SUM(total_cash_sales) as total_cash_sales,
        SUM(total_card_sales) as total_card_sales,
        SUM(total_upi_sales) as total_upi_sales,
        SUM(total_discounts) as total_discounts,
        SUM(total_refunds) as total_refunds,
        SUM(total_cancellations) as total_cancellations,
        SUM(cash_variance) as total_variance,
        AVG(total_sales) as avg_daily_sales,
        AVG(total_orders) as avg_daily_orders,
        MAX(total_sales) as max_daily_sales,
        MIN(CASE WHEN total_sales > 0 THEN total_sales ELSE NULL END) as min_daily_sales
       FROM day_sessions
       WHERE ${whereClause}`,
      queryParams
    );

    return {
      totalShifts: summary[0]?.total_shifts || 0,
      closedShifts: summary[0]?.closed_shifts || 0,
      openShifts: summary[0]?.open_shifts || 0,
      totalSales: parseFloat(summary[0]?.total_sales) || 0,
      totalOrders: summary[0]?.total_orders || 0,
      totalCashSales: parseFloat(summary[0]?.total_cash_sales) || 0,
      totalCardSales: parseFloat(summary[0]?.total_card_sales) || 0,
      totalUpiSales: parseFloat(summary[0]?.total_upi_sales) || 0,
      totalDiscounts: parseFloat(summary[0]?.total_discounts) || 0,
      totalRefunds: parseFloat(summary[0]?.total_refunds) || 0,
      totalCancellations: parseFloat(summary[0]?.total_cancellations) || 0,
      totalVariance: parseFloat(summary[0]?.total_variance) || 0,
      avgDailySales: parseFloat(summary[0]?.avg_daily_sales) || 0,
      avgDailyOrders: parseFloat(summary[0]?.avg_daily_orders) || 0,
      maxDailySales: parseFloat(summary[0]?.max_daily_sales) || 0,
      minDailySales: parseFloat(summary[0]?.min_daily_sales) || 0,
      floorId,
      cashierId
    };
  }
};

module.exports = paymentService;
