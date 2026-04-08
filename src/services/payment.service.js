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
 * Business day starts at this hour. Orders before this hour belong to the previous business day.
 * E.g. 4 means: business day = 4:00 AM today → 3:59:59 AM tomorrow.
 */
const BUSINESS_DAY_START_HOUR = 4;

/**
 * Get local date string (YYYY-MM-DD) for the current business day.
 * If the current time is before BUSINESS_DAY_START_HOUR (e.g. 4 AM),
 * the business day is still "yesterday".
 */
function getLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const shifted = new Date(d.getTime() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
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
    isAdjustment: !!payment.is_adjustment,
    adjustmentAmount: parseFloat(payment.adjustment_amount) || 0,
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
    let adjustmentRecord = null;
    const { outletId: requestOutletId, orderId: reqOrderId, invoiceId: reqInvoiceId,
            paymentMode, amount, tipAmount = 0,
            transactionId, referenceNumber,
            cardLastFour, cardType, upiId, walletName, bankName,
            notes, receivedBy,
            adjustment = false, adjustmentAmount: reqAdjustmentAmount = 0, adjustmentReason
          } = data;
    const isAdjustment = adjustment === true || adjustment === 'true';
    const adjustmentAmount = isAdjustment ? parseFloat(reqAdjustmentAmount) || 0 : 0;

    try {

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

      // Allow payments on completed orders that still have due amount (partial payment)
      const isFullyPaid = order.status === 'paid' || 
        (order.status === 'completed' && order.payment_status === 'completed');
      if (isFullyPaid) {
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
          notes, received_by, is_adjustment, adjustment_amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid, outletId, orderId, invoiceId, paymentNumber,
          paymentMode, amount, tipAmount, totalAmount,
          transactionId, referenceNumber,
          cardLastFour, cardType, upiId, walletName, bankName,
          notes, receivedBy, isAdjustment ? 1 : 0, adjustmentAmount
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

      // Use invoice grand_total (already includes NC deduction) if available, fallback to order total_amount
      let orderTotal = parseFloat(order.total_amount) || 0;
      let isNCOrder = order.is_nc || false;
      if (invoiceId) {
        const [invRow] = await connection.query(
          'SELECT grand_total, is_nc, customer_id FROM invoices WHERE id = ? AND is_cancelled = 0',
          [invoiceId]
        );
        if (invRow[0]) {
          // Use !== null check (not ||) because grand_total can be 0 for NC orders
          orderTotal = invRow[0].grand_total !== null && invRow[0].grand_total !== undefined
            ? parseFloat(invRow[0].grand_total) : orderTotal;
          isNCOrder = !!invRow[0].is_nc;
        }
      }

      // When adjustment is applied, the adjustment covers the remaining amount
      // So effective due = 0, payment is considered complete
      const effectivePaid = paidAmount + adjustmentAmount;
      const dueAmount = isAdjustment ? Math.max(0, orderTotal - effectivePaid) : (orderTotal - paidAmount);

      // Check if customer info exists for due payment support
      const customerId = order.customer_id;
      const hasCustomerInfo = customerId && order.customer_phone;
      const isDuePayment = !isAdjustment && dueAmount > 0 && hasCustomerInfo;

      paymentStatus = 'pending';
      orderStatus = order.status;

      if (isAdjustment) {
        // Adjustment always completes the order — remaining is written off
        paymentStatus = 'completed';
        orderStatus = 'completed';
      } else if (dueAmount <= 0) {
        paymentStatus = 'completed';
        orderStatus = 'completed';
      } else if (paidAmount >= 0) {
        paymentStatus = 'partial';
        orderStatus = 'completed'; // Always complete order on any payment — table freed, KOTs served
      } else if (dueAmount > 0 ) {
        // Zero payment with customer info = full due payment scenario
        // Complete the order, release table, mark KOTs served, but payment status is pending (due)
        paymentStatus = 'pending';
        orderStatus = 'completed';
      }

      await connection.query(
        `UPDATE orders SET 
          paid_amount = ?, due_amount = ?, adjustment_amount = ?, is_adjustment = ?, payment_status = ?, status = ?
         WHERE id = ?`,
        [paidAmount, Math.max(0, isAdjustment ? 0 : dueAmount), adjustmentAmount, isAdjustment ? 1 : 0, paymentStatus, orderStatus, orderId]
      );

      // Update invoice if exists
      if (invoiceId) {
        await connection.query(
          `UPDATE invoices SET payment_status = ?, paid_amount = ?, due_amount = ?, adjustment_amount = ?, is_due_payment = ? WHERE id = ?`,
          [paymentStatus === 'completed' ? 'paid' : paymentStatus, paidAmount, Math.max(0, isAdjustment ? 0 : dueAmount), adjustmentAmount, isDuePayment ? 1 : 0, invoiceId]
        );
      }

      // Create adjustment record if adjustment is applied
      if (isAdjustment && adjustmentAmount > 0) {
        const [adjResult] = await connection.query(
          `INSERT INTO payment_adjustments (
            outlet_id, order_id, invoice_id, payment_id, order_number,
            total_amount, paid_amount, adjustment_amount, reason, adjusted_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [outletId, orderId, invoiceId, paymentId, order.order_number,
           orderTotal, paidAmount, adjustmentAmount, adjustmentReason || null, receivedBy]
        );
        adjustmentRecord = {
          id: Number(adjResult.insertId),
          adjustmentAmount,
          reason: adjustmentReason || null
        };
      }

      // Read previous due BEFORE deciding to create new due or collect
      const previousDue = parseFloat(order.due_amount) || 0;

      // Create due transaction ONLY on first partial payment (no previous due existed)
      // On subsequent payments, just collect from the existing due — don't add a new one
      if (isDuePayment && dueAmount > 0 && previousDue <= 0) {
        await this.createDueTransaction(connection, {
          outletId,
          customerId,
          orderId,
          invoiceId,
          paymentId,
          dueAmount,
          userId: receivedBy,
          notes: `Due from order ${order.order_number}`
        });
      }

      // Check if this payment is settling a previous due (due collection)
      if (previousDue > 0 && customerId) {
        if (isAdjustment) {
          // Adjustment settles the full remaining due:
          // cash portion is collected, adjustment portion is waived
          // NOTE: Adjustment payments are NOT marked as due collections — they appear in adjustment reports only
          const cashPortion = Math.min(totalAmount, previousDue);
          const adjustedPortion = previousDue - cashPortion;

          if (cashPortion > 0) {
            await this.createDueCollectionTransaction(connection, {
              outletId, customerId, orderId, invoiceId, paymentId,
              amount: cashPortion,
              paymentMode,
              userId: receivedBy,
              notes: `Due settled via adjustment for order ${order.order_number}`
            });
          }

          // Write off remaining due covered by adjustment
          if (adjustedPortion > 0) {
            const [custBal] = await connection.query(
              'SELECT due_balance FROM customers WHERE id = ? FOR UPDATE', [customerId]
            );
            const currentBal = parseFloat(custBal[0]?.due_balance) || 0;
            const newBal = Math.max(0, currentBal - adjustedPortion);
            const waiveUuid = uuidv4();
            await connection.query(
              `INSERT INTO customer_due_transactions (
                uuid, outlet_id, customer_id, order_id, invoice_id, payment_id,
                transaction_type, amount, balance_before, balance_after, notes, created_by
              ) VALUES (?, ?, ?, ?, ?, ?, 'due_waived', ?, ?, ?, ?, ?)`,
              [waiveUuid, outletId, customerId, orderId, invoiceId, paymentId,
               -adjustedPortion, currentBal, newBal,
               `Adjustment on order ${order.order_number} - ${adjustmentReason || 'Adjustment'}`, receivedBy]
            );
            await connection.query(
              'UPDATE customers SET due_balance = ? WHERE id = ?',
              [newBal, customerId]
            );
          }
        } else {
          // Normal payment - collect what was actually paid toward the due
          const collectedAmount = Math.min(totalAmount, previousDue);
          await this.createDueCollectionTransaction(connection, {
            outletId, customerId, orderId, invoiceId, paymentId,
            amount: collectedAmount,
            paymentMode,
            userId: receivedBy,
            notes: `Due collected for order ${order.order_number}`
          });

          // Mark payment as due collection (only for non-adjustment payments)
          await connection.query(
            'UPDATE payments SET is_due_collection = 1 WHERE id = ?',
            [paymentId]
          );
        }
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

      // Release table when order is completed (full payment, partial payment, or 0 payment with due)
      const shouldReleaseTable = orderStatus === 'completed' && tableId;
      if (shouldReleaseTable) {
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
        
        // Close table session - use provided ID or find active session for this table
        if (tableSessionId) {
          await connection.query(
            `UPDATE table_sessions SET 
              status = 'completed', ended_at = NOW()
             WHERE id = ?`,
            [tableSessionId]
          );
        } else {
          // Fallback: close any active sessions for this table
          await connection.query(
            `UPDATE table_sessions SET 
              status = 'completed', ended_at = NOW()
             WHERE table_id = ? AND status = 'active'`,
            [tableId]
          );
        }
      }

      // Mark all KOTs and order items as served when order is completed (full, partial, or 0 payment with due)
      if (orderStatus === 'completed') {
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
    // For 0 payment (due), billStatus should be 'due' to indicate full amount is due
    let billStatus = 'partial';
    if (paymentStatus === 'completed') {
      billStatus = 'paid';
    } else if (paymentStatus === 'pending' && orderStatus === 'completed') {
      billStatus = 'due'; // 0 payment - full amount goes to due
    }
    await publishMessage('bill:status', {
      outletId,
      orderId,
      tableId,
      tableNumber: order.table_number,
      captainId: order.created_by,
      invoiceId,
      billStatus,
      amountPaid: totalAmount,
      isAdjustment,
      adjustmentAmount,
      timestamp: new Date().toISOString()
    });

    // Emit table update if released - table now available (on any payment including 0 payment with due)
    if (orderStatus === 'completed' && tableId) {
      // Check if there were merged tables and emit unmerge event
      const pool = getPool();
      const [mergeCheck] = await pool.query(
        `SELECT tm.merged_table_id, t.table_number, t.floor_id
         FROM table_merges tm
         JOIN tables t ON tm.merged_table_id = t.id
         WHERE tm.primary_table_id = ? 
         AND tm.unmerged_at IS NOT NULL 
         AND tm.unmerged_at >= DATE_SUB(NOW(), INTERVAL 5 SECOND)`,
        [tableId]
      );

      // Emit unmerge event if tables were just unmerged
      if (mergeCheck.length > 0) {
        const unmergedTableIds = mergeCheck.map(m => m.merged_table_id);
        await publishMessage('table:unmerge', {
          outletId,
          primaryTableId: tableId,
          floorId: order.floor_id,
          unmergedTableIds,
          unmergedTables: mergeCheck.map(m => ({
            id: m.merged_table_id,
            tableNumber: m.table_number,
            floorId: m.floor_id
          })),
          event: 'tables_unmerged_after_payment',
          timestamp: new Date().toISOString()
        });
      }

      await publishMessage('table:update', {
        outletId,
        tableId,
        floorId: order.floor_id,
        status: 'available',
        event: 'session_ended',
        timestamp: new Date().toISOString()
      });
    }

    // Emit KOT served events for real-time kitchen display - remove from all stations (on any payment including 0 payment)
    if (orderStatus === 'completed') {
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
    const response = await this.buildPaymentResponse(payment, orderId, invoiceId, orderStatus, paymentStatus, tableId);
    if (adjustmentRecord) {
      response.adjustment = adjustmentRecord;
    }
    return response;
  },

  /**
   * Process split payment - works same as processPayment for due collection
   */
  async processSplitPayment(data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    // Variables needed after transaction for event publishing
    let paymentId, paymentStatus, orderStatus, paidAmount, dueAmount;
    let order, tableId, customerId, isDuePayment;
    let adjustmentRecord = null;
    const { outletId, orderId, invoiceId, splits, receivedBy,
            adjustment = false, adjustmentAmount: reqAdjustmentAmount = 0, adjustmentReason } = data;
    const isAdjustment = adjustment === true || adjustment === 'true';
    const adjustmentAmount = isAdjustment ? parseFloat(reqAdjustmentAmount) || 0 : 0;

    try {
      // Validate order BEFORE transaction
      order = await orderService.getById(orderId);
      if (!order) throw new Error('Order not found');

      // Allow payments on completed orders that still have due amount (partial payment)
      const isFullyPaid = order.status === 'paid' || 
        (order.status === 'completed' && order.payment_status === 'completed');
      if (isFullyPaid) {
        throw new Error('Order already paid');
      }

      await connection.beginTransaction();

      tableId = order.table_id;
      customerId = order.customer_id;

      // Calculate total for this split payment
      const splitTotalAmount = splits.reduce((sum, s) => sum + parseFloat(s.amount), 0);
      const paymentNumber = await this.generatePaymentNumber(outletId);
      const uuid = uuidv4();

      // Create main payment record
      const [mainResult] = await connection.query(
        `INSERT INTO payments (
          uuid, outlet_id, order_id, invoice_id, payment_number,
          payment_mode, amount, total_amount, status, received_by, is_adjustment, adjustment_amount
        ) VALUES (?, ?, ?, ?, ?, 'split', ?, ?, 'completed', ?, ?, ?)`,
        [uuid, outletId, orderId, invoiceId, paymentNumber, splitTotalAmount, splitTotalAmount, receivedBy,
         isAdjustment ? 1 : 0, adjustmentAmount]
      );

      paymentId = Number(mainResult.insertId);

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

      // Calculate TOTAL paid from ALL payments (not just this split)
      const [totalPaidResult] = await connection.query(
        `SELECT SUM(total_amount) as paid FROM payments 
         WHERE order_id = ? AND status = 'completed'`,
        [orderId]
      );
      paidAmount = parseFloat(totalPaidResult[0].paid) || 0;

      // Use invoice grand_total (already includes NC deduction) if available, fallback to order total_amount
      let orderTotal = parseFloat(order.total_amount) || 0;
      if (invoiceId) {
        const [invRow] = await connection.query(
          'SELECT grand_total FROM invoices WHERE id = ? AND is_cancelled = 0',
          [invoiceId]
        );
        if (invRow[0]) {
          // Use !== null check (not ||) because grand_total can be 0 for NC orders
          orderTotal = invRow[0].grand_total !== null && invRow[0].grand_total !== undefined
            ? parseFloat(invRow[0].grand_total) : orderTotal;
        }
      }
      // When adjustment is applied, the adjustment covers the remaining amount
      const effectivePaid = paidAmount + adjustmentAmount;
      dueAmount = isAdjustment ? Math.max(0, orderTotal - effectivePaid) : (orderTotal - paidAmount);

      // Check if customer info exists for due payment support
      const hasCustomerInfo = customerId && order.customer_phone;
      isDuePayment = !isAdjustment && dueAmount > 0 && hasCustomerInfo;

      paymentStatus = 'pending';
      orderStatus = order.status;

      if (isAdjustment) {
        // Adjustment always completes the order — remaining is written off
        paymentStatus = 'completed';
        orderStatus = 'completed';
      } else if (dueAmount <= 0) {
        paymentStatus = 'completed';
        orderStatus = 'completed';
      } else if (paidAmount > 0) {
        paymentStatus = 'partial';
        orderStatus = 'completed'; // Always complete order on any payment — table freed, KOTs served
      }

      // Update order status
      await connection.query(
        `UPDATE orders SET 
          paid_amount = ?, due_amount = ?, adjustment_amount = ?, is_adjustment = ?, payment_status = ?, status = ?
         WHERE id = ?`,
        [paidAmount, Math.max(0, isAdjustment ? 0 : dueAmount), adjustmentAmount, isAdjustment ? 1 : 0, paymentStatus, orderStatus, orderId]
      );

      if (invoiceId) {
        await connection.query(
          `UPDATE invoices SET payment_status = ?, paid_amount = ?, due_amount = ?, adjustment_amount = ?, is_due_payment = ? WHERE id = ?`,
          [paymentStatus === 'completed' ? 'paid' : paymentStatus, paidAmount, Math.max(0, isAdjustment ? 0 : dueAmount), adjustmentAmount, isDuePayment ? 1 : 0, invoiceId]
        );
      }

      // Create adjustment record if adjustment is applied
      if (isAdjustment && adjustmentAmount > 0) {
        const [adjResult] = await connection.query(
          `INSERT INTO payment_adjustments (
            outlet_id, order_id, invoice_id, payment_id, order_number,
            total_amount, paid_amount, adjustment_amount, reason, adjusted_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [outletId, orderId, invoiceId, paymentId, order.order_number,
           orderTotal, paidAmount, adjustmentAmount, adjustmentReason || null, receivedBy]
        );
        adjustmentRecord = {
          id: Number(adjResult.insertId),
          adjustmentAmount,
          reason: adjustmentReason || null
        };
      }

      // Read previous due BEFORE deciding to create new due or collect
      const previousDue = parseFloat(order.due_amount) || 0;

      // Create due transaction ONLY on first partial payment (no previous due existed)
      // On subsequent payments, just collect from the existing due — don't add a new one
      if (isDuePayment && dueAmount > 0 && previousDue <= 0) {
        await this.createDueTransaction(connection, {
          outletId,
          customerId,
          orderId,
          invoiceId,
          paymentId,
          dueAmount,
          userId: receivedBy,
          notes: `Due from split payment on order ${order.order_number}`
        });
      }

      // Check if this payment is settling a previous due (due collection)
      if (previousDue > 0 && customerId) {
        if (isAdjustment) {
          // Adjustment settles the full remaining due:
          // cash portion is collected, adjustment portion is waived
          const cashPortion = Math.min(splitTotalAmount, previousDue);
          const adjustedPortion = previousDue - cashPortion;

          if (cashPortion > 0) {
            await this.createDueCollectionTransaction(connection, {
              outletId, customerId, orderId, invoiceId, paymentId,
              amount: cashPortion,
              paymentMode: 'split',
              userId: receivedBy,
              notes: `Due collected via split payment for order ${order.order_number}`
            });
          }

          // Write off remaining due covered by adjustment
          if (adjustedPortion > 0) {
            const [custBal] = await connection.query(
              'SELECT due_balance FROM customers WHERE id = ? FOR UPDATE', [customerId]
            );
            const currentBal = parseFloat(custBal[0]?.due_balance) || 0;
            const newBal = Math.max(0, currentBal - adjustedPortion);
            const waiveUuid = uuidv4();
            await connection.query(
              `INSERT INTO customer_due_transactions (
                uuid, outlet_id, customer_id, order_id, invoice_id, payment_id,
                transaction_type, amount, balance_before, balance_after, notes, created_by
              ) VALUES (?, ?, ?, ?, ?, ?, 'due_waived', ?, ?, ?, ?, ?)`,
              [waiveUuid, outletId, customerId, orderId, invoiceId, paymentId,
               -adjustedPortion, currentBal, newBal,
               `Adjustment on order ${order.order_number} - ${adjustmentReason || 'Adjustment'}`, receivedBy]
            );
            await connection.query(
              'UPDATE customers SET due_balance = ? WHERE id = ?',
              [newBal, customerId]
            );
          }
        } else {
          // Normal split payment - collect what was actually paid toward the due
          const collectedAmount = Math.min(splitTotalAmount, previousDue);
          await this.createDueCollectionTransaction(connection, {
            outletId, customerId, orderId, invoiceId, paymentId,
            amount: collectedAmount,
            paymentMode: 'split',
            userId: receivedBy,
            notes: `Due collected via split payment for order ${order.order_number}`
          });

          // Mark payment as due collection (only for non-adjustment payments)
          await connection.query(
            'UPDATE payments SET is_due_collection = 1 WHERE id = ?',
            [paymentId]
          );
        }
      }

      // Release table on any payment (full or partial) — order is completed, table should be freed
      const shouldReleaseTable = (paymentStatus === 'completed' || paymentStatus === 'partial') && tableId;
      if (shouldReleaseTable) {
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
        
        // Close table session - use provided ID or find active session for this table
        if (order.table_session_id) {
          await connection.query(
            `UPDATE table_sessions SET 
              status = 'completed', ended_at = NOW()
             WHERE id = ?`,
            [order.table_session_id]
          );
        } else {
          // Fallback: close any active sessions for this table
          await connection.query(
            `UPDATE table_sessions SET 
              status = 'completed', ended_at = NOW()
             WHERE table_id = ? AND status = 'active'`,
            [order.table_id]
          );
        }
      }

      // Mark all KOTs and order items as served on any payment (full or partial)
      if (paymentStatus === 'completed' || paymentStatus === 'partial') {
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
      amountPaid: paidAmount,
      dueAmount: Math.max(0, dueAmount),
      isAdjustment,
      adjustmentAmount,
      timestamp: new Date().toISOString()
    });

    // Emit table update if released — always on any payment
    if ((paymentStatus === 'completed' || paymentStatus === 'partial') && tableId) {
      await publishMessage('table:update', {
        outletId,
        tableId,
        floorId: order.floor_id,
        status: 'available',
        event: 'session_ended',
        timestamp: new Date().toISOString()
      });
    }

    // Emit KOT served events - remove from all stations on any payment
    if (paymentStatus === 'completed' || paymentStatus === 'partial') {
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
    }

    // Send WhatsApp bill to customer on full payment completion
    if (paymentStatus === 'completed') {
      this.sendWhatsAppBillOnCompletion(invoiceId, outletId, orderId).catch(err =>
        logger.warn('WhatsApp bill send failed (non-critical):', err.message)
      );
    }

    const response = await this.buildPaymentResponse(payment, orderId, invoiceId, orderStatus, paymentStatus, tableId);
    if (adjustmentRecord) {
      response.adjustment = adjustmentRecord;
    }
    return response;
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
    const totalAdjustment = allPayments.reduce((s, p) => s + (p.adjustmentAmount || 0), 0);
    const orderTotal = invoice ? invoice.grandTotal : (parseFloat(updatedOrder?.total_amount) || 0);
    const dueAmount = Math.max(0, orderTotal - totalPaid - totalAdjustment);

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
        adjustmentAmount: parseFloat(totalAdjustment.toFixed(2)),
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

    // Check if there's already an OPEN session for this floor (regardless of date)
    // An open shift must be closed before a new one can be opened
    const [existingOpen] = await pool.query(
      `SELECT * FROM day_sessions WHERE outlet_id = ? 
       AND (floor_id = ? OR (floor_id IS NULL AND ? IS NULL)) AND status = 'open'`,
      [outletId, floorId, floorId]
    );

    if (existingOpen[0]) {
      throw new Error('Shift already open for this floor. Please close the existing shift first.');
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

    // Get floor info and cashier name for response and socket event
    let floorName = null;
    let cashierName = null;
    const [[floorInfo], [cashierInfo]] = await Promise.all([
      floorId ? pool.query('SELECT name FROM floors WHERE id = ?', [floorId]) : [[]],
      pool.query('SELECT name FROM users WHERE id = ?', [userId])
    ]);
    floorName = floorInfo[0]?.name || null;
    cashierName = cashierInfo[0]?.name || 'Cashier';

    logger.info(`Shift opened: outlet=${outletId}, floor=${floorId}, cashier=${userId}`);

    // Emit shift:open socket event to captain room (floor captains/staff only, NOT cashier)
    await publishMessage('shift:open', {
      type: 'shift:opened',
      outletId: parseInt(outletId),
      floorId: floorId || null,
      floorName,
      sessionId,
      cashierId: userId,
      cashierName,
      openingCash,
      shiftOpen: true,
      openedAt: new Date().toISOString()
    });

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

      // Get open session for this floor — no date filter so shifts opened yesterday can be closed today
      const [sessions] = await connection.query(
        `SELECT * FROM day_sessions WHERE outlet_id = ? AND status = 'open'
         AND (floor_id = ? OR (floor_id IS NULL AND ? IS NULL))
         ORDER BY id DESC LIMIT 1`,
        [outletId, floorId, floorId]
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

      // Get shift totals (not day totals) — only completed/paid orders
      const [shiftTotals] = await connection.query(
        `SELECT 
          COUNT(*) as total_orders,
          SUM(o.total_amount) as total_sales,
          SUM(CASE WHEN o.payment_status = 'completed' THEN o.paid_amount ELSE 0 END) as total_collected,
          SUM(COALESCE(o.discount_amount, 0)) as total_discounts
         FROM orders o
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ? AND o.status IN ('completed', 'paid')
         AND (t.floor_id = ? OR (t.floor_id IS NULL AND ? IS NULL) OR o.table_id IS NULL)`,
        [outletId, shiftStartTime, shiftEndTime, floorId, floorId]
      );

      // Get payment mode breakdown for storing in day_sessions
      const [shiftPayBreakdown] = await connection.query(
        `SELECT 
          SUM(CASE WHEN p.payment_mode = 'cash' THEN p.total_amount ELSE 0 END) as total_cash,
          SUM(CASE WHEN p.payment_mode = 'card' THEN p.total_amount ELSE 0 END) as total_card,
          SUM(CASE WHEN p.payment_mode = 'upi' THEN p.total_amount ELSE 0 END) as total_upi
         FROM payments p
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
           AND p.status = 'completed' AND p.payment_mode != 'split'
           AND (t.floor_id = ? OR (t.floor_id IS NULL AND ? IS NULL) OR o.table_id IS NULL)`,
        [outletId, shiftStartTime, shiftEndTime, floorId, floorId]
      );
      const [shiftSplitBreakdown] = await connection.query(
        `SELECT 
          SUM(CASE WHEN sp.payment_mode = 'cash' THEN sp.amount ELSE 0 END) as total_cash,
          SUM(CASE WHEN sp.payment_mode = 'card' THEN sp.amount ELSE 0 END) as total_card,
          SUM(CASE WHEN sp.payment_mode = 'upi' THEN sp.amount ELSE 0 END) as total_upi
         FROM split_payments sp
         JOIN payments p ON sp.payment_id = p.id
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
           AND p.status = 'completed' AND p.payment_mode = 'split'
           AND (t.floor_id = ? OR (t.floor_id IS NULL AND ? IS NULL) OR o.table_id IS NULL)`,
        [outletId, shiftStartTime, shiftEndTime, floorId, floorId]
      );
      const storedCash = (parseFloat(shiftPayBreakdown[0]?.total_cash) || 0) + (parseFloat(shiftSplitBreakdown[0]?.total_cash) || 0);
      const storedCard = (parseFloat(shiftPayBreakdown[0]?.total_card) || 0) + (parseFloat(shiftSplitBreakdown[0]?.total_card) || 0);
      const storedUpi = (parseFloat(shiftPayBreakdown[0]?.total_upi) || 0) + (parseFloat(shiftSplitBreakdown[0]?.total_upi) || 0);

      // Update session with accurate values
      await connection.query(
        `UPDATE day_sessions SET 
          closing_time = NOW(), closing_cash = ?, expected_cash = ?,
          cash_variance = ?, total_sales = ?, total_orders = ?,
          total_cash_sales = ?, total_card_sales = ?, total_upi_sales = ?,
          total_discounts = ?,
          status = 'closed', closed_by = ?, variance_notes = ?
         WHERE id = ?`,
        [
          actualCash, expectedCash, variance,
          shiftTotals[0].total_sales || 0, shiftTotals[0].total_orders || 0,
          storedCash, storedCard, storedUpi,
          shiftTotals[0].total_discounts || 0,
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

      // Get floor name and cashier name for socket event
      let floorName = null;
      let cashierName = null;
      const pool = getPool();
      const [[floorInfo], [cashierInfo]] = await Promise.all([
        floorId ? pool.query('SELECT name FROM floors WHERE id = ?', [floorId]) : [[]],
        pool.query('SELECT name FROM users WHERE id = ?', [userId])
      ]);
      floorName = floorInfo[0]?.name || null;
      cashierName = cashierInfo[0]?.name || 'Cashier';

      logger.info(`Shift closed: outlet=${outletId}, floor=${floorId}, cashier=${userId}`);

      // Emit shift:close socket event to captain room (floor captains/staff only, NOT cashier)
      await publishMessage('shift:close', {
        type: 'shift:closed',
        outletId: parseInt(outletId),
        floorId: floorId || null,
        floorName,
        sessionId: session.id,
        cashierId: userId,
        cashierName,
        expectedCash,
        actualCash,
        variance,
        totalSales: shiftTotals[0].total_sales || 0,
        totalOrders: shiftTotals[0].total_orders || 0,
        shiftOpen: false,
        closedAt: new Date().toISOString()
      });

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

    // Get session for this floor - prioritize OPEN session (no date filter), else get today's most recent
    // An open shift stays open until manually closed, regardless of date rollover
    let sessionQuery = `
      SELECT ds.*, f.name as floor_name, u.name as cashier_name
      FROM day_sessions ds
      LEFT JOIN floors f ON ds.floor_id = f.id
      LEFT JOIN users u ON ds.cashier_id = u.id
      WHERE ds.outlet_id = ? AND (ds.status = 'open' OR ds.session_date = ?)`;
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

    // Build shared condition parts
    // Takeaway/delivery with no floor → assign to shift's cashier to avoid double-counting
    const cashierId = session[0]?.cashier_id;
    let floorCondition = '';
    let paymentFloorCondition = '';
    const floorParam = floorId ? [floorId] : [];
    const floorPayParam = floorId ? [floorId, cashierId] : [];
    if (floorId) {
      floorCondition = ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`;
      paymentFloorCondition = floorCondition;
    }
    // Order floor condition (orders table directly, no join)
    const orderFloorCond = floorId
      ? ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`
      : '';
    const orderFloorParams = floorId ? [floorId, cashierId] : [];
    const cdFloorCond = floorId ? ` AND floor_id = ?` : '';

    // Parallel: all 8 queries at once
    const [balanceRes, transRes, orderDataRes, completedStatsRes, regularRes, splitRes, cashMovRes, dueCollRes] = await Promise.all([
      pool.query(
        `SELECT balance_after FROM cash_drawer 
         WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?${cdFloorCond}
         ORDER BY id DESC LIMIT 1`,
        [outletId, shiftStartTime, shiftEndTime, ...floorParam]
      ),
      pool.query(
        `SELECT cd.*, u.name as user_name FROM cash_drawer cd
         LEFT JOIN users u ON cd.user_id = u.id
         WHERE cd.outlet_id = ? AND cd.created_at >= ? AND cd.created_at <= ?${cdFloorCond}
         ORDER BY cd.created_at DESC LIMIT 20`,
        [outletId, shiftStartTime, shiftEndTime, ...floorParam]
      ),
      // Active/pending orders (for running status - NOT for sales)
      pool.query(
        `SELECT 
          COUNT(DISTINCT o.id) as total_orders,
          SUM(o.guest_count) as total_guests,
          SUM(CASE WHEN o.status NOT IN ('cancelled', 'completed') THEN o.total_amount ELSE 0 END) as pending_amount,
          COUNT(CASE WHEN o.status = 'completed' THEN 1 END) as completed_orders,
          COUNT(CASE WHEN o.status NOT IN ('cancelled', 'completed') THEN 1 END) as active_orders
         FROM orders o
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ? AND o.status != 'cancelled'${floorCondition}`,
        [outletId, shiftStartTime, shiftEndTime, ...floorPayParam]
      ),
      // Completed order stats — THIS is the source of truth for totalSales
      pool.query(
        `SELECT 
          COUNT(*) as completed_orders,
          SUM(total_amount) as total_sale,
          SUM(COALESCE(discount_amount, 0)) as discount_amount,
          COUNT(CASE WHEN is_nc = 1 THEN 1 END) as nc_order_count,
          SUM(CASE WHEN is_nc = 1 THEN COALESCE(nc_amount, 0) ELSE 0 END) as nc_amount,
          COUNT(CASE WHEN is_adjustment = 1 THEN 1 END) as adjustment_count,
          SUM(CASE WHEN is_adjustment = 1 THEN COALESCE(adjustment_amount, 0) ELSE 0 END) as adjustment_amount,
          SUM(COALESCE(due_amount, 0)) as due_amount
         FROM orders
         WHERE outlet_id = ? AND status = 'completed' AND created_at >= ? AND created_at <= ?${orderFloorCond}`,
        [outletId, shiftStartTime, shiftEndTime, ...orderFloorParams]
      ),
      // ALL payments during shift (including due collections — real money received)
      pool.query(
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
        [outletId, shiftStartTime, shiftEndTime, ...floorPayParam]
      ),
      pool.query(
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
        [outletId, shiftStartTime, shiftEndTime, ...floorPayParam]
      ),
      pool.query(
        `SELECT 
          SUM(CASE WHEN transaction_type = 'opening' THEN amount ELSE 0 END) as opening_cash,
          SUM(CASE WHEN transaction_type = 'cash_in' THEN amount ELSE 0 END) as cash_in,
          SUM(CASE WHEN transaction_type = 'cash_out' THEN ABS(amount) ELSE 0 END) as cash_out,
          SUM(CASE WHEN transaction_type = 'refund' THEN ABS(amount) ELSE 0 END) as refunds,
          SUM(CASE WHEN transaction_type = 'expense' THEN ABS(amount) ELSE 0 END) as expenses
         FROM cash_drawer 
         WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?${cdFloorCond}`,
        [outletId, shiftStartTime, shiftEndTime, ...floorParam]
      ),
      // Due collection amount (tracked separately, NOT added to sale)
      pool.query(
        `SELECT COALESCE(SUM(p.total_amount), 0) as due_collected
         FROM payments p
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
           AND p.status = 'completed' AND COALESCE(p.is_due_collection, 0) = 1${paymentFloorCondition}`,
        [outletId, shiftStartTime, shiftEndTime, ...floorPayParam]
      )
    ]);
    const balance = balanceRes[0];
    const transactions = transRes[0];
    const orderData = orderDataRes[0];
    const completedStats = completedStatsRes[0];
    const regularPayments = regularRes[0];
    const splitPayments = splitRes[0];
    const cashMovements = cashMovRes[0];
    const dueCollData = dueCollRes[0];

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

    // cashMovements already fetched in parallel block above
    const cashSummary = cashMovements[0] || {};
    // Cash sales come from payments table (paymentSummary.cash), not cash_drawer
    const cashSalesFromPayments = paymentSummary.cash;
    
    // Get opening cash from session record (more reliable than cash_drawer)
    const openingCashFromSession = parseFloat(session[0]?.opening_cash) || 0;
    
    // Total sales = SUM(total_amount) of completed orders (NOT from payments)
    const totalSalesFromOrders = parseFloat(completedStats[0]?.total_sale) || 0;
    const totalSales = totalSalesFromOrders;
    const dueCollected = parseFloat(dueCollData[0]?.due_collected) || 0;
    
    // Expected amount = Opening Cash + ALL payment collections (incl due collections) + cash_in - cash_out - refunds - expenses
    const expectedAmount = 
      openingCashFromSession +
      paymentSummary.total +
      (parseFloat(cashSummary.cash_in) || 0) -
      (parseFloat(cashSummary.cash_out) || 0) -
      (parseFloat(cashSummary.refunds) || 0) -
      (parseFloat(cashSummary.expenses) || 0);
    
    // Expected cash in drawer (only cash) = opening + ALL cash payments (incl due collections) + cash_in - cash_out - refunds - expenses
    const expectedCashInDrawer = 
      openingCashFromSession +
      cashSalesFromPayments +
      (parseFloat(cashSummary.cash_in) || 0) -
      (parseFloat(cashSummary.cash_out) || 0) -
      (parseFloat(cashSummary.refunds) || 0) -
      (parseFloat(cashSummary.expenses) || 0);
    
    // Debug logging
    logger.info(`Cash drawer calculation - Opening: ${openingCashFromSession}, Cash Sales: ${cashSalesFromPayments}, Due Collected: ${dueCollected}, Total Sales: ${totalSales}, Expected Amount: ${expectedAmount}, Expected Cash: ${expectedCashInDrawer}`);

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
      expectedAmount: expectedAmount,         // Opening + ALL payment collections (incl due) + Cash In - Cash Out - Refunds - Expenses
      totalSales: totalSales,                 // SUM(total_amount) of completed orders
      totalCollection: paymentSummary.total,   // Actual money collected (incl due collections)
      currentBalance: expectedCashInDrawer,   // Expected cash in drawer only
      expectedCash: expectedCashInDrawer,     // Expected cash in drawer only
      // Real-time sales data
      sales: {
        totalOrders: parseInt(orderData[0]?.total_orders) || 0,
        completedOrders: parseInt(completedStats[0]?.completed_orders) || 0,
        activeOrders: parseInt(orderData[0]?.active_orders) || 0,
        totalGuests: parseInt(orderData[0]?.total_guests) || 0,
        totalSale: totalSales,
        totalCollection: paymentSummary.total,
        pendingAmount: parseFloat(orderData[0]?.pending_amount) || 0,
        discountAmount: parseFloat(completedStats[0]?.discount_amount) || 0,
        ncOrderCount: parseInt(completedStats[0]?.nc_order_count) || 0,
        ncAmount: parseFloat(completedStats[0]?.nc_amount) || 0,
        adjustmentCount: parseInt(completedStats[0]?.adjustment_count) || 0,
        adjustmentAmount: parseFloat(completedStats[0]?.adjustment_amount) || 0,
        dueAmount: parseFloat(completedStats[0]?.due_amount) || 0,
        dueCollected: dueCollected
      },
      // Collection breakdown — includes due collections (real money received during shift)
      collection: {
        totalCollection: paymentSummary.total,
        dueCollection: dueCollected,
        cash: paymentSummary.cash,
        card: paymentSummary.card,
        upi: paymentSummary.upi,
        wallet: paymentSummary.wallet,
        note: 'totalCollection = SUM of all payments during shift (incl due collections). dueCollection shown separately for reference.'
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

    // Get shift status for each floor — prioritize open shifts regardless of date
    const floorShifts = [];
    for (const floor of floors) {
      const [session] = await pool.query(
        `SELECT ds.*, u.name as cashier_name
         FROM day_sessions ds
         LEFT JOIN users u ON ds.cashier_id = u.id
         WHERE ds.outlet_id = ? AND ds.floor_id = ? AND (ds.status = 'open' OR ds.session_date = ?)
         ORDER BY CASE WHEN ds.status = 'open' THEN 0 ELSE 1 END, ds.opening_time DESC
         LIMIT 1`,
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

    // Don't filter by session_date — open shift persists until manually closed
    const [session] = await pool.query(
      `SELECT ds.id, ds.status, ds.cashier_id, ds.opening_cash,
              u.name as cashier_name, f.name as floor_name
       FROM day_sessions ds
       LEFT JOIN users u ON ds.cashier_id = u.id
       LEFT JOIN floors f ON ds.floor_id = f.id
       WHERE ds.outlet_id = ? AND ds.floor_id = ? AND ds.status = 'open'
       ORDER BY ds.id DESC LIMIT 1`,
      [outletId, floorId]
    );

    return {
      isOpen: !!session[0],
      shiftId: session[0]?.id || null,
      cashierId: session[0]?.cashier_id || null,
      cashierName: session[0]?.cashier_name || null,
      openingCash: session[0] ? (parseFloat(session[0].opening_cash) || 0).toFixed(2) : null,
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
  // SHIFT HELPERS
  // ========================

  /**
   * Merge regular + split payment rows by payment_mode (sum counts and totals).
   * Prevents duplicate "cash", "upi" etc. entries in paymentBreakdown.
   */
  _mergePaymentsByMode(regularPayments, splitPayments) {
    const map = {};
    for (const p of [...regularPayments, ...splitPayments]) {
      const mode = p.payment_mode;
      if (!map[mode]) {
        map[mode] = { payment_mode: mode, count: 0, total: 0 };
      }
      map[mode].count += parseInt(p.count) || 0;
      map[mode].total += parseFloat(p.total) || 0;
    }
    return Object.values(map);
  },

  /**
   * Calculate payment totals from merged breakdown
   */
  _calcPaymentTotals(paymentBreakdown) {
    let totalCash = 0, totalCard = 0, totalUpi = 0, totalOther = 0, total = 0;
    for (const p of paymentBreakdown) {
      const amount = parseFloat(p.total) || 0;
      total += amount;
      if (p.payment_mode === 'cash') totalCash += amount;
      else if (p.payment_mode === 'card' || p.payment_mode === 'credit_card' || p.payment_mode === 'debit_card') totalCard += amount;
      else if (p.payment_mode === 'upi') totalUpi += amount;
      else totalOther += amount;
    }
    return { totalCash, totalCard, totalUpi, totalOther, total };
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
    const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
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

    // Parallel: count + data
    const [countResult, shiftsResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total FROM day_sessions ds WHERE ${whereClause}`, queryParams),
      pool.query(
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
      )
    ]);
    const total = countResult[0][0].total;
    const shifts = shiftsResult[0];

    // Helper to format date in LOCAL timezone (not UTC)
    const formatLocalDate = (dateVal) => {
      if (!dateVal) return null;
      if (dateVal instanceof Date) {
        return `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')}`;
      }
      return String(dateVal).slice(0, 10);
    };

    // Helper to format datetime for MySQL query (handles cross-day shifts correctly)
    const formatDateTimeForQuery = (dateVal) => {
      if (!dateVal) return null;
      if (dateVal instanceof Date) {
        return `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')} ${String(dateVal.getHours()).padStart(2, '0')}:${String(dateVal.getMinutes()).padStart(2, '0')}:${String(dateVal.getSeconds()).padStart(2, '0')}`;
      }
      // If it's a string, return as-is (already formatted)
      return String(dateVal);
    };

    // Calculate real-time values for each shift based on shift time range
    const formattedShifts = await Promise.all(shifts.map(async (shift) => {
      // Use opening_time directly (it's stored as DATETIME in DB)
      // For cross-day shifts, closing_time will have the correct date (next day)
      const shiftStartTime = formatDateTimeForQuery(shift.opening_time);
      
      // For closed shifts, use closing_time directly (handles cross-day correctly)
      // For open shifts, use current time
      let shiftEndTime;
      if (shift.closing_time) {
        shiftEndTime = formatDateTimeForQuery(shift.closing_time);
      } else if (shift.status === 'open') {
        const now = new Date();
        shiftEndTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      } else {
        // Fallback: use session_date end of day
        const sessionDateStr = formatLocalDate(shift.session_date);
        shiftEndTime = `${sessionDateStr} 23:59:59`;
      }

      // Parallel: all 5 per-shift queries at once (was sequential — 5 round-trips per shift)
      // Takeaway/delivery with no floor → assign to shift's cashier via created_by to avoid double-counting across floors
      const floorCondition = shift.floor_id ? ' AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != \'dine_in\' AND o.created_by = ?))' : '';
      const floorParams = shift.floor_id ? [shift.floor_id, shift.cashier_id] : [];
      const ncFloorCond = shift.floor_id ? ' AND (floor_id = ? OR (floor_id IS NULL AND order_type IN (\'takeaway\', \'delivery\') AND created_by = ?))' : '';
      const ncFloorParams = shift.floor_id ? [shift.floor_id, shift.cashier_id] : [];
      const sessionDateStr2 = formatLocalDate(shift.session_date);

      const [regularPaymentsRes, splitPaymentsRes, orderStatsRes, dueCollRes, shiftCostRes, shiftWastageRes] = await Promise.all([
        // Payments EXCLUDING due collections (due already counted in total_amount at order completion)
        pool.query(
          `SELECT p.payment_mode, SUM(p.total_amount) as total
           FROM payments p
           JOIN orders o ON p.order_id = o.id
           LEFT JOIN tables t ON o.table_id = t.id
           WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
             AND p.status = 'completed' AND p.payment_mode != 'split'
             AND COALESCE(p.is_due_collection, 0) = 0${floorCondition}
           GROUP BY p.payment_mode`,
          [shift.outlet_id, shiftStartTime, shiftEndTime, ...floorParams]
        ),
        pool.query(
          `SELECT sp.payment_mode, SUM(sp.amount) as total
           FROM split_payments sp
           JOIN payments p ON sp.payment_id = p.id
           JOIN orders o ON p.order_id = o.id
           LEFT JOIN tables t ON o.table_id = t.id
           WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
             AND p.status = 'completed' AND p.payment_mode = 'split'
             AND COALESCE(p.is_due_collection, 0) = 0${floorCondition}
           GROUP BY sp.payment_mode`,
          [shift.outlet_id, shiftStartTime, shiftEndTime, ...floorParams]
        ),
        // Live order stats — only completed orders
        pool.query(
          `SELECT 
            COUNT(*) as total_orders,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
            SUM(CASE WHEN order_type = 'dine_in' AND status = 'completed' THEN 1 ELSE 0 END) as dine_in_orders,
            SUM(CASE WHEN order_type = 'takeaway' AND status = 'completed' THEN 1 ELSE 0 END) as takeaway_orders,
            SUM(CASE WHEN order_type = 'delivery' AND status = 'completed' THEN 1 ELSE 0 END) as delivery_orders,
            SUM(CASE WHEN status = 'completed' THEN COALESCE(total_amount, 0) ELSE 0 END) as total_sale,
            COUNT(CASE WHEN is_nc = 1 AND status = 'completed' THEN 1 END) as nc_orders,
            SUM(CASE WHEN status = 'completed' THEN COALESCE(nc_amount, 0) ELSE 0 END) as nc_amount,
            COUNT(CASE WHEN is_adjustment = 1 AND status = 'completed' THEN 1 END) as adjustment_count,
            SUM(CASE WHEN status = 'completed' THEN COALESCE(adjustment_amount, 0) ELSE 0 END) as total_adjustment_amount,
            SUM(CASE WHEN status = 'completed' THEN COALESCE(due_amount, 0) ELSE 0 END) as total_due_amount,
            SUM(CASE WHEN status = 'completed' THEN COALESCE(discount_amount, 0) ELSE 0 END) as total_discounts
           FROM orders WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?${ncFloorCond}`,
          [shift.outlet_id, shiftStartTime, shiftEndTime, ...ncFloorParams]
        ),
        // Due collection amount (tracked separately, NOT added to sale)
        pool.query(
          `SELECT COALESCE(SUM(p.total_amount), 0) as due_collected
           FROM payments p
           JOIN orders o ON p.order_id = o.id
           LEFT JOIN tables t ON o.table_id = t.id
           WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
             AND p.status = 'completed' AND COALESCE(p.is_due_collection, 0) = 1${floorCondition}`,
          [shift.outlet_id, shiftStartTime, shiftEndTime, ...floorParams]
        ),
        pool.query(
          `SELECT COALESCE(SUM(oic.making_cost), 0) as making_cost,
                  COALESCE(SUM(oic.profit), 0) as profit
           FROM order_item_costs oic
           JOIN orders o ON oic.order_id = o.id
           LEFT JOIN tables t ON o.table_id = t.id
           WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ?
             AND o.status IN ('paid','completed')${floorCondition}`,
          [shift.outlet_id, shiftStartTime, shiftEndTime, ...floorParams]
        ),
        pool.query(
          `SELECT COUNT(*) as wastage_count, COALESCE(SUM(total_cost), 0) as wastage_cost
           FROM wastage_logs WHERE outlet_id = ? AND wastage_date = ?`,
          [shift.outlet_id, sessionDateStr2]
        )
      ]);
      const regularPayments = regularPaymentsRes[0];
      const splitPayments = splitPaymentsRes[0];
      const os = orderStatsRes[0][0] || {};
      const totalDueCollected = parseFloat(dueCollRes[0][0]?.due_collected) || 0;
      const shiftCostRows = shiftCostRes[0];
      const shiftWastageRows = shiftWastageRes[0];

      // Merge regular + split payments (due collections already excluded)
      const mergedPayments = this._mergePaymentsByMode(regularPayments, splitPayments);
      const { totalCash: totalCashSales, totalCard: totalCardSales, totalUpi: totalUpiSales, totalOther: totalOtherSales, total: totalPaymentCollection } = this._calcPaymentTotals(mergedPayments);
      // totalSales = SUM(total_amount) of completed orders (source of truth)
      const totalSales = parseFloat(os.total_sale) || 0;
      const shiftMakingCost = parseFloat(shiftCostRows[0]?.making_cost) || 0;
      const shiftProfit = parseFloat(shiftCostRows[0]?.profit) || 0;
      const shiftWastageCount = parseInt(shiftWastageRows[0]?.wastage_count) || 0;
      const shiftWastageCost = parseFloat(shiftWastageRows[0]?.wastage_cost) || 0;

      const openingCash = parseFloat(shift.opening_cash) || 0;
      const closingCash = parseFloat(shift.closing_cash) || 0;
      const expectedAmount = openingCash + totalPaymentCollection;
      const expectedCash = openingCash + totalCashSales;
      const cashVariance = shift.status === 'closed' ? (closingCash - expectedCash) : 0;

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
        totalSales: r2(totalSales),
        totalCollection: r2(totalSales),
        totalOrders: parseInt(os.completed_orders) || 0,
        totalCashSales: totalCashSales,
        totalCardSales: totalCardSales,
        totalUpiSales: totalUpiSales,
        totalOtherSales: totalOtherSales,
        totalDiscounts: parseFloat(os.total_discounts) || 0,
        orderStats: {
          totalOrders: parseInt(os.total_orders) || 0,
          completedOrders: parseInt(os.completed_orders) || 0,
          cancelledOrders: parseInt(os.cancelled_orders) || 0,
          dineInOrders: parseInt(os.dine_in_orders) || 0,
          takeawayOrders: parseInt(os.takeaway_orders) || 0,
          deliveryOrders: parseInt(os.delivery_orders) || 0,
          ncOrders: parseInt(os.nc_orders) || 0,
          ncAmount: parseFloat(os.nc_amount) || 0,
          adjustmentCount: parseInt(os.adjustment_count) || 0,
          adjustmentAmount: parseFloat(os.total_adjustment_amount) || 0,
          totalDueAmount: parseFloat(os.total_due_amount) || 0
        },
        collection: {
          totalCollection: r2(totalSales),
          dueCollection: r2(totalDueCollected),
          paymentBreakdown: {
            cash: r2(totalCashSales),
            card: r2(totalCardSales),
            upi: r2(totalUpiSales),
            wallet: r2(mergedPayments.find(p => p.payment_mode === 'wallet')?.total || 0),
            credit: r2(mergedPayments.find(p => p.payment_mode === 'credit')?.total || 0)
          },
          totalDue: r2(parseFloat(os.total_due_amount) || 0),
          totalNC: r2(parseFloat(os.nc_amount) || 0),
          ncOrderCount: parseInt(os.nc_orders) || 0,
          totalAdjustment: r2(parseFloat(os.total_adjustment_amount) || 0),
          adjustmentCount: parseInt(os.adjustment_count) || 0
        },
        makingCost: shiftMakingCost,
        profit: shiftProfit,
        note: 'totalSales = SUM(total_amount) of completed orders. Due collection not added to sale/collection.',
        foodCostPercentage: totalSales > 0 ? parseFloat(((shiftMakingCost / totalSales) * 100).toFixed(2)) : 0,
        wastageCount: shiftWastageCount,
        wastageCost: shiftWastageCost,
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
    // Helper to format datetime for MySQL query
    const formatDateTimeForQuery = (dateVal) => {
      if (!dateVal) return null;
      if (dateVal instanceof Date) {
        return `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')} ${String(dateVal.getHours()).padStart(2, '0')}:${String(dateVal.getMinutes()).padStart(2, '0')}:${String(dateVal.getSeconds()).padStart(2, '0')}`;
      }
      // If it's a string, return as-is (already formatted)
      return String(dateVal);
    };
    
    // Use opening_time directly (it's stored as DATETIME in DB)
    // For cross-day shifts, closing_time will have the correct date (next day)
    const shiftStartTime = formatDateTimeForQuery(shift.opening_time);
    
    // For closed shifts, use closing_time directly (handles cross-day correctly)
    // For open shifts, use current time
    let shiftEndTime;
    if (shift.closing_time) {
      shiftEndTime = formatDateTimeForQuery(shift.closing_time);
    } else if (shift.status === 'open') {
      const now = new Date();
      shiftEndTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    } else {
      // Fallback: use session_date end of day
      const sessionDateStr = shift.session_date instanceof Date 
        ? `${shift.session_date.getFullYear()}-${String(shift.session_date.getMonth() + 1).padStart(2, '0')}-${String(shift.session_date.getDate()).padStart(2, '0')}`
        : String(shift.session_date).slice(0, 10);
      shiftEndTime = `${sessionDateStr} 23:59:59`;
    }

    // Debug log for shift time range
    logger.info(`Shift ${shiftId} time range: ${shiftStartTime} to ${shiftEndTime} (status: ${shift.status})`);

    // Build query parts for parallel execution
    let transQuery = `
      SELECT cd.*, u.name as user_name
      FROM cash_drawer cd
      LEFT JOIN users u ON cd.user_id = u.id
      WHERE cd.outlet_id = ? AND cd.created_at >= ? AND cd.created_at <= ?`;
    const transParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    if (floorId) { transQuery += ` AND cd.floor_id = ?`; transParams.push(floorId); }
    if (cashierId) { transQuery += ` AND cd.user_id = ?`; transParams.push(cashierId); }
    transQuery += ` ORDER BY cd.created_at ASC`;

    let paymentFloorCondition = '';
    const paymentParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    const splitParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    const orderParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    let orderFloorCond = '';
    if (floorId) {
      // Takeaway/delivery with no floor → assign to shift's cashier via created_by to avoid double-counting
      paymentFloorCondition = ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`;
      paymentParams.push(floorId, shift.cashier_id);
      splitParams.push(floorId, shift.cashier_id);
      orderFloorCond = ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway', 'delivery') AND created_by = ?))`;
      orderParams.push(floorId, shift.cashier_id);
    }

    // Parallel: transactions + regularPayments(excl due) + splitPayments(excl due) + orderStats(only completed)
    const [transRes, regularRes, splitRes, orderStatsRes] = await Promise.all([
      pool.query(transQuery, transParams),
      pool.query(
        `SELECT p.payment_mode, COUNT(*) as count, SUM(p.total_amount) as total
         FROM payments p
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
           AND p.status = 'completed' AND p.payment_mode != 'split'
           AND COALESCE(p.is_due_collection, 0) = 0${paymentFloorCondition}
         GROUP BY p.payment_mode`,
        paymentParams
      ),
      pool.query(
        `SELECT sp.payment_mode, COUNT(*) as count, SUM(sp.amount) as total
         FROM split_payments sp
         JOIN payments p ON sp.payment_id = p.id
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
           AND p.status = 'completed' AND p.payment_mode = 'split'
           AND COALESCE(p.is_due_collection, 0) = 0${paymentFloorCondition}
         GROUP BY sp.payment_mode`,
        splitParams
      ),
      pool.query(
        `SELECT 
          COUNT(*) as total_orders,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
          SUM(CASE WHEN order_type = 'dine_in' AND status = 'completed' THEN 1 ELSE 0 END) as dine_in_orders,
          SUM(CASE WHEN order_type = 'takeaway' AND status = 'completed' THEN 1 ELSE 0 END) as takeaway_orders,
          SUM(CASE WHEN order_type = 'delivery' AND status = 'completed' THEN 1 ELSE 0 END) as delivery_orders,
          SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as real_total_sales,
          AVG(CASE WHEN status = 'completed' THEN total_amount ELSE NULL END) as avg_order_value,
          MAX(CASE WHEN status = 'completed' THEN total_amount ELSE NULL END) as max_order_value,
          MIN(CASE WHEN status = 'completed' AND total_amount > 0 THEN total_amount ELSE NULL END) as min_order_value,
          COUNT(CASE WHEN is_nc = 1 AND status = 'completed' THEN 1 END) as nc_orders,
          SUM(CASE WHEN status = 'completed' THEN COALESCE(nc_amount, 0) ELSE 0 END) as nc_amount,
          COUNT(CASE WHEN is_adjustment = 1 AND status = 'completed' THEN 1 END) as adjustment_count,
          SUM(CASE WHEN status = 'completed' THEN COALESCE(adjustment_amount, 0) ELSE 0 END) as total_adjustment_amount,
          SUM(CASE WHEN status = 'completed' THEN COALESCE(due_amount, 0) ELSE 0 END) as total_due_amount
        FROM orders
        WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?${orderFloorCond}`,
        orderParams
      )
    ]);
    const transactions = transRes[0];
    const regularPayments = regularRes[0];
    const splitPayments = splitRes[0];
    const orderStats = orderStatsRes[0];

    // Merge regular + split payments by mode (due collections already excluded)
    const paymentBreakdown = this._mergePaymentsByMode(regularPayments, splitPayments);
    
    // Calculate payment totals from merged payment breakdown
    const { totalCash: totalCashSales, totalCard: totalCardSales, totalUpi: totalUpiSales, totalOther: totalOtherSales, total: calculatedPaymentTotal } = this._calcPaymentTotals(paymentBreakdown);

    // totalSales = SUM(total_amount) of completed orders (source of truth, not payments)
    const totalSalesFromOrders = parseFloat(orderStats[0]?.real_total_sales) || 0;

    const openingCash = parseFloat(shift.opening_cash) || 0;
    const closingCash = parseFloat(shift.closing_cash) || 0;
    const expectedAmount = openingCash + calculatedPaymentTotal;
    const expectedCash = openingCash + totalCashSales;
    // Calculate cash variance: actual closing cash vs expected cash (positive = over, negative = short)
    const cashVariance = shift.status === 'closed' ? (closingCash - expectedCash) : 0;
    
    // Use calculated values for accuracy
    const realTotalOrders = parseInt(orderStats[0]?.completed_orders) || 0;

    logger.info(`Shift ${shiftId} detail calc - Time: ${shiftStartTime} to ${shiftEndTime}, Opening: ${openingCash}, Cash: ${totalCashSales}, UPI: ${totalUpiSales}, Card: ${totalCardSales}, OrderSales: ${totalSalesFromOrders}, Expected: ${expectedAmount}, ExpectedCash: ${expectedCash}, ClosingCash: ${closingCash}, Variance: ${cashVariance}`);

    // Get staff activity: all users who created orders OR received payments during this shift
    // Includes takeaway/delivery order creators even if not floor-assigned
    let staffActivity = [];
    const floorCond = floorId
      ? `AND (o.floor_id = ? OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery') AND o.created_by = ${pool.escape(shift.cashier_id)}))`
      : '';
    const payFloorCond = floorId
      ? `AND (t.floor_id = ? OR (o_x.table_id IS NULL AND o_x.order_type != 'dine_in' AND o_x.created_by = ${pool.escape(shift.cashier_id)}))`
      : '';

    // Build user-source subquery: all users who had activity during shift
    let userSourceQuery;
    const userSourceParams = [];
    if (floorId) {
      userSourceQuery = `
        SELECT DISTINCT created_by as uid FROM orders
        WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?
          AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway', 'delivery') AND created_by = ?))
        UNION
        SELECT DISTINCT billed_by FROM orders
        WHERE outlet_id = ? AND created_at >= ? AND created_at <= ? AND billed_by IS NOT NULL
          AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway', 'delivery') AND created_by = ?))
        UNION
        SELECT DISTINCT p.received_by FROM payments p
        JOIN orders o ON p.order_id = o.id LEFT JOIN tables t ON o.table_id = t.id
        WHERE p.outlet_id = ? AND p.status = 'completed' AND p.created_at >= ? AND p.created_at <= ?
          AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))
        UNION
        SELECT uf.user_id FROM user_floors uf
        WHERE uf.floor_id = ? AND uf.outlet_id = ? AND uf.is_active = 1`;
      userSourceParams.push(
        shift.outlet_id, shiftStartTime, shiftEndTime, floorId, shift.cashier_id,
        shift.outlet_id, shiftStartTime, shiftEndTime, floorId, shift.cashier_id,
        shift.outlet_id, shiftStartTime, shiftEndTime, floorId, shift.cashier_id,
        floorId, shift.outlet_id
      );
    } else {
      userSourceQuery = `
        SELECT DISTINCT created_by as uid FROM orders
        WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?
        UNION
        SELECT DISTINCT billed_by FROM orders
        WHERE outlet_id = ? AND created_at >= ? AND created_at <= ? AND billed_by IS NOT NULL
        UNION
        SELECT DISTINCT p.received_by FROM payments p
        WHERE p.outlet_id = ? AND p.status = 'completed' AND p.created_at >= ? AND p.created_at <= ?`;
      userSourceParams.push(
        shift.outlet_id, shiftStartTime, shiftEndTime,
        shift.outlet_id, shiftStartTime, shiftEndTime,
        shift.outlet_id, shiftStartTime, shiftEndTime
      );
    }

    // Build staff activity with correct metrics
    const staffParams = [];
    let staffQuery = `SELECT 
      u.id as user_id,
      u.name as user_name,
      (SELECT GROUP_CONCAT(DISTINCT r.slug) FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE ur.user_id = u.id AND ur.outlet_id = ? AND ur.is_active = 1
         AND r.slug IN ('cashier', 'captain', 'admin', 'owner')
      ) as role,
      (SELECT COUNT(DISTINCT o.id) FROM orders o
       WHERE o.created_by = u.id AND o.outlet_id = ? AND o.status IN ('completed', 'paid')
         AND o.created_at >= ? AND o.created_at <= ? ${floorCond}
      ) as orders_created,
      (SELECT COUNT(DISTINCT o.id) FROM orders o
       WHERE o.created_by = u.id AND o.outlet_id = ? AND o.status = 'cancelled'
         AND o.created_at >= ? AND o.created_at <= ? ${floorCond}
      ) as orders_cancelled,
      (SELECT COUNT(DISTINCT o.id) FROM orders o
       WHERE o.billed_by = u.id AND o.outlet_id = ? AND o.status IN ('completed', 'paid')
         AND o.created_at >= ? AND o.created_at <= ? ${floorCond}
      ) as orders_handled,
      (SELECT COALESCE(SUM(o.total_amount), 0) FROM orders o
       WHERE o.billed_by = u.id AND o.outlet_id = ? AND o.status IN ('completed', 'paid')
         AND o.created_at >= ? AND o.created_at <= ? ${floorCond}
      ) as orders_handled_sales,
      (SELECT COALESCE(SUM(o.total_amount), 0) FROM orders o
       WHERE o.created_by = u.id AND o.outlet_id = ? AND o.status IN ('completed', 'paid')
         AND o.created_at >= ? AND o.created_at <= ? ${floorCond}
      ) as order_sales,
      (SELECT COUNT(DISTINCT p2.id) FROM payments p2
       JOIN orders o_x ON p2.order_id = o_x.id
       LEFT JOIN tables t ON o_x.table_id = t.id
       WHERE p2.received_by = u.id AND p2.outlet_id = ? AND p2.status = 'completed'
         AND p2.created_at >= ? AND p2.created_at <= ? ${payFloorCond}
      ) as payments_received,
      (SELECT COALESCE(SUM(p3.total_amount), 0) FROM payments p3
       JOIN orders o_x ON p3.order_id = o_x.id
       LEFT JOIN tables t ON o_x.table_id = t.id
       WHERE p3.received_by = u.id AND p3.outlet_id = ? AND p3.status = 'completed'
         AND p3.created_at >= ? AND p3.created_at <= ? ${payFloorCond}
      ) as amount_collected,
      (SELECT COALESCE(SUM(p4.total_amount), 0) FROM payments p4
       JOIN orders o_x ON p4.order_id = o_x.id
       LEFT JOIN tables t ON o_x.table_id = t.id
       WHERE p4.received_by = u.id AND p4.outlet_id = ? AND p4.status = 'completed'
         AND COALESCE(p4.is_due_collection, 0) = 1
         AND p4.created_at >= ? AND p4.created_at <= ? ${payFloorCond}
      ) as due_collected
     FROM users u
     WHERE u.id IN (${userSourceQuery})
     ORDER BY amount_collected DESC`;

    // Build params: role + orders_created + orders_cancelled + orders_handled + orders_handled_sales + order_sales + payments_received + amount_collected + due_collected + userSource
    staffParams.push(shift.outlet_id); // role
    // orders_created
    staffParams.push(shift.outlet_id, shiftStartTime, shiftEndTime);
    if (floorId) staffParams.push(floorId);
    // orders_cancelled
    staffParams.push(shift.outlet_id, shiftStartTime, shiftEndTime);
    if (floorId) staffParams.push(floorId);
    // orders_handled (billed_by)
    staffParams.push(shift.outlet_id, shiftStartTime, shiftEndTime);
    if (floorId) staffParams.push(floorId);
    // orders_handled_sales (billed_by)
    staffParams.push(shift.outlet_id, shiftStartTime, shiftEndTime);
    if (floorId) staffParams.push(floorId);
    // order_sales
    staffParams.push(shift.outlet_id, shiftStartTime, shiftEndTime);
    if (floorId) staffParams.push(floorId);
    // payments_received
    staffParams.push(shift.outlet_id, shiftStartTime, shiftEndTime);
    if (floorId) staffParams.push(floorId);
    // amount_collected
    staffParams.push(shift.outlet_id, shiftStartTime, shiftEndTime);
    if (floorId) staffParams.push(floorId);
    // due_collected
    staffParams.push(shift.outlet_id, shiftStartTime, shiftEndTime);
    if (floorId) staffParams.push(floorId);
    // userSource params
    staffParams.push(...userSourceParams);

    // Build all independent queries for parallel execution
    // Orders query
    let ordersQuery = `
      SELECT 
        o.id, o.uuid, o.order_number, o.order_type, o.status, o.payment_status,
        o.customer_name, o.customer_phone,
        o.subtotal, o.tax_amount, o.discount_amount, o.total_amount,
        o.is_nc, o.nc_amount, o.nc_reason, o.due_amount, o.paid_amount as order_paid_amount,
        o.is_adjustment, o.adjustment_amount,
        o.created_at, o.updated_at,
        u.name as created_by_name,
        t.table_number, t.name as table_name,
        p.payment_mode, p.total_amount as paid_amount, p.status as payment_record_status,
        p.is_due_collection
      FROM orders o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN tables t ON o.table_id = t.id
      LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'completed'
      WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ?`;
    const ordersParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    if (floorId) {
      ordersQuery += ` AND (o.floor_id = ? OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery') AND o.created_by = ?))`;
      ordersParams.push(floorId, shift.cashier_id);
    }
    ordersQuery += ` ORDER BY o.created_at DESC`;

    // Due collections query
    let dueCollQuery = `
      SELECT cdt.payment_id, cdt.order_id, ABS(cdt.amount) as collected_amount,
        p.payment_mode, p.received_by as collected_by_id, u_coll.name as collected_by_name,
        cdt.created_at,
        o.order_number, o.customer_name, o.customer_phone, o.total_amount as order_total
      FROM customer_due_transactions cdt
      JOIN orders o ON cdt.order_id = o.id
      LEFT JOIN payments p ON cdt.payment_id = p.id
      LEFT JOIN users u_coll ON p.received_by = u_coll.id
      WHERE cdt.outlet_id = ? AND cdt.transaction_type = 'due_collected'
        AND cdt.created_at >= ? AND cdt.created_at <= ?
        AND (p.is_adjustment IS NULL OR p.is_adjustment = 0)`;
    const dueCollParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    if (floorId) {
      dueCollQuery += ` AND (o.floor_id = ? OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery') AND o.created_by = ?))`;
      dueCollParams.push(floorId, shift.cashier_id);
    }
    dueCollQuery += ` ORDER BY cdt.created_at DESC`;

    // Cashier-wise collection queries
    let cashierQuery = `
      SELECT 
        p.received_by as cashier_id, u.name as cashier_name,
        COUNT(DISTINCT p.order_id) as order_count,
        SUM(p.total_amount) as total_collection,
        SUM(CASE WHEN p.payment_mode = 'cash' THEN p.total_amount ELSE 0 END) as cash_total,
        SUM(CASE WHEN p.payment_mode = 'card' THEN p.total_amount ELSE 0 END) as card_total,
        SUM(CASE WHEN p.payment_mode = 'upi' THEN p.total_amount ELSE 0 END) as upi_total,
        SUM(CASE WHEN p.payment_mode = 'wallet' THEN p.total_amount ELSE 0 END) as wallet_total,
        SUM(CASE WHEN p.payment_mode = 'credit' THEN p.total_amount ELSE 0 END) as credit_total,
        SUM(CASE WHEN COALESCE(p.is_due_collection, 0) = 1 THEN p.total_amount ELSE 0 END) as due_collection
      FROM payments p
      LEFT JOIN users u ON p.received_by = u.id
      JOIN orders o ON p.order_id = o.id
      LEFT JOIN tables t ON o.table_id = t.id
      WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
        AND p.status = 'completed' AND p.payment_mode != 'split'${paymentFloorCondition}
      GROUP BY p.received_by, u.name`;
    const cashierParams = [...paymentParams];

    let cashierSplitQuery = `
      SELECT 
        p.received_by as cashier_id, u.name as cashier_name,
        COUNT(DISTINCT p.order_id) as order_count,
        SUM(sp.amount) as total_collection,
        SUM(CASE WHEN sp.payment_mode = 'cash' THEN sp.amount ELSE 0 END) as cash_total,
        SUM(CASE WHEN sp.payment_mode = 'card' THEN sp.amount ELSE 0 END) as card_total,
        SUM(CASE WHEN sp.payment_mode = 'upi' THEN sp.amount ELSE 0 END) as upi_total,
        SUM(CASE WHEN sp.payment_mode = 'wallet' THEN sp.amount ELSE 0 END) as wallet_total,
        SUM(CASE WHEN sp.payment_mode = 'credit' THEN sp.amount ELSE 0 END) as credit_total,
        SUM(CASE WHEN COALESCE(p.is_due_collection, 0) = 1 THEN sp.amount ELSE 0 END) as due_collection
      FROM split_payments sp
      JOIN payments p ON sp.payment_id = p.id
      LEFT JOIN users u ON p.received_by = u.id
      JOIN orders o ON p.order_id = o.id
      LEFT JOIN tables t ON o.table_id = t.id
      WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
        AND p.status = 'completed' AND p.payment_mode = 'split'${paymentFloorCondition}
      GROUP BY p.received_by, u.name`;
    const cashierSplitParams = [...splitParams];

    // Cost/Profit query
    let costQuery = `
      SELECT COALESCE(SUM(oic.making_cost), 0) as making_cost,
        COALESCE(SUM(oic.profit), 0) as profit
       FROM order_item_costs oic
       JOIN orders o ON oic.order_id = o.id
       WHERE o.outlet_id = ? AND o.status IN ('paid','completed')
         AND o.created_at >= ? AND o.created_at <= ?`;
    const costParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    if (floorId) {
      costQuery += ` AND (o.floor_id = ? OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery')))`;
      costParams.push(floorId);
    }

    // Wastage query
    let wastageQuery = `
      SELECT COUNT(*) as wastage_count, COALESCE(SUM(total_cost), 0) as wastage_cost
       FROM wastage_logs
       WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?`;
    const wastageParams = [shift.outlet_id, shiftStartTime, shiftEndTime];

    // Execute ALL 7 independent queries in parallel (was sequential — 7 round-trips)
    const [staffRows, ordersRawRes, dueCollRows, cashierRegRes, cashierSplRes, costRows, wastageRows] = await Promise.all([
      pool.query(staffQuery, staffParams),
      pool.query(ordersQuery, ordersParams),
      pool.query(dueCollQuery, dueCollParams),
      pool.query(cashierQuery, cashierParams),
      pool.query(cashierSplitQuery, cashierSplitParams),
      pool.query(costQuery, costParams),
      pool.query(wastageQuery, wastageParams)
    ]);
    staffActivity = staffRows[0];
    const ordersRaw = ordersRawRes[0];

    // Fetch order items (depends on ordersRaw results)
    const orderIds = [...new Set(ordersRaw.map(o => o.id))];
    let orderItemsMap = {};
    if (orderIds.length > 0) {
      const [allItems] = await pool.query(`
        SELECT 
          oi.order_id, oi.item_name, oi.variant_name, oi.quantity, 
          oi.unit_price, oi.total_price, oi.status as item_status
        FROM order_items oi
        WHERE oi.order_id IN (${orderIds.map(() => '?').join(',')})
          AND oi.status != 'cancelled'
        ORDER BY oi.id
      `, orderIds);
      
      for (const item of allItems) {
        if (!orderItemsMap[item.order_id]) orderItemsMap[item.order_id] = [];
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

    // Format orders — deduplicate (may have multiple payment rows per order)
    const ordersMap = new Map();
    for (const row of ordersRaw) {
      if (!ordersMap.has(row.id)) {
        ordersMap.set(row.id, {
          id: row.id, uuid: row.uuid, orderNumber: row.order_number,
          orderType: row.order_type, status: row.status, paymentStatus: row.payment_status,
          tableNumber: row.table_number, tableName: row.table_name,
          customerName: row.customer_name, customerPhone: row.customer_phone,
          subtotal: parseFloat(row.subtotal) || 0, taxAmount: parseFloat(row.tax_amount) || 0,
          discountAmount: parseFloat(row.discount_amount) || 0, totalAmount: parseFloat(row.total_amount) || 0,
          isNC: !!row.is_nc, ncAmount: parseFloat(row.nc_amount) || 0, ncReason: row.nc_reason || null,
          paidAmount: parseFloat(row.order_paid_amount) || 0, dueAmount: parseFloat(row.due_amount) || 0,
          isAdjustment: !!row.is_adjustment, adjustmentAmount: parseFloat(row.adjustment_amount) || 0,
          isDueCollection: !!row.is_due_collection, createdByName: row.created_by_name,
          createdAt: row.created_at, updatedAt: row.updated_at,
          paymentMode: row.payment_mode, paymentPaid: parseFloat(row.paid_amount) || 0,
          items: orderItemsMap[row.id] || []
        });
      }
    }
    const shiftOrders = Array.from(ordersMap.values());

    // Process due collections
    const dueCollections = dueCollRows[0].map(r => ({
      paymentId: r.payment_id, orderId: r.order_id, orderNumber: r.order_number,
      customerName: r.customer_name || null, customerPhone: r.customer_phone || null,
      orderTotal: parseFloat(r.order_total) || 0, collectedAmount: parseFloat(r.collected_amount) || 0,
      paymentMode: r.payment_mode, collectedById: r.collected_by_id || null,
      collectedByName: r.collected_by_name || null, createdAt: r.created_at
    }));
    const totalDueCollected = dueCollections.reduce((s, d) => s + d.collectedAmount, 0);

    // Merge regular + split cashier data
    const cashierMap = {};
    const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
    for (const row of [...cashierRegRes[0], ...cashierSplRes[0]]) {
      const cid = row.cashier_id || 0;
      if (!cashierMap[cid]) {
        cashierMap[cid] = {
          cashierId: row.cashier_id, cashierName: row.cashier_name || 'Unknown',
          orderCount: 0, totalCollection: 0,
          cash: 0, card: 0, upi: 0, wallet: 0, credit: 0, dueCollection: 0
        };
      }
      const c = cashierMap[cid];
      c.orderCount = Math.max(c.orderCount, parseInt(row.order_count) || 0);
      c.totalCollection += parseFloat(row.total_collection) || 0;
      c.cash += parseFloat(row.cash_total) || 0;
      c.card += parseFloat(row.card_total) || 0;
      c.upi += parseFloat(row.upi_total) || 0;
      c.wallet += parseFloat(row.wallet_total) || 0;
      c.credit += parseFloat(row.credit_total) || 0;
      c.dueCollection += parseFloat(row.due_collection) || 0;
    }
    const cashierBreakdown = Object.values(cashierMap).map(c => ({
      cashierId: c.cashierId, cashierName: c.cashierName, orderCount: c.orderCount,
      totalCollection: r2(c.totalCollection), freshCollection: r2(c.totalCollection - c.dueCollection),
      dueCollection: r2(c.dueCollection),
      paymentBreakdown: {
        cash: r2(c.cash), card: r2(c.card), upi: r2(c.upi),
        wallet: r2(c.wallet), credit: r2(c.credit)
      }
    })).sort((a, b) => b.totalCollection - a.totalCollection);

    // Cost/Profit
    const shiftMakingCost = parseFloat(costRows[0][0]?.making_cost) || 0;
    const shiftProfit = parseFloat(costRows[0][0]?.profit) || 0;
    const shiftFoodCostPct = totalSalesFromOrders > 0
      ? parseFloat(((shiftMakingCost / totalSalesFromOrders) * 100).toFixed(2)) : 0;

    // Wastage
    const shiftWastageCount = parseInt(wastageRows[0][0]?.wastage_count) || 0;
    const shiftWastageCost = parseFloat(wastageRows[0][0]?.wastage_cost) || 0;

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
      total: calculatedPaymentTotal
    };

    // Extract wallet and credit from merged payment breakdown for collection block
    const totalWalletSales = formattedPayments.find(p => p.mode === 'wallet')?.total || 0;
    const totalCreditSales = formattedPayments.find(p => p.mode === 'credit')?.total || 0;

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
      // Real-time calculated totals (totalSales = SUM(total_amount) of completed orders)
      totalSales: r2(totalSalesFromOrders),
      totalCollection: r2(totalSalesFromOrders),
      totalOrders: realTotalOrders,
      totalCashSales: totalCashSales,
      totalCardSales: totalCardSales,
      totalUpiSales: totalUpiSales,
      totalOtherSales: totalOtherSales,
      totalDiscounts: parseFloat(shift.total_discounts) || 0,
      totalRefunds: parseFloat(shift.total_refunds) || 0,
      totalCancellations: parseFloat(shift.total_cancellations) || 0,
      // Cost & Profit
      makingCost: shiftMakingCost,
      profit: shiftProfit,
      foodCostPercentage: shiftFoodCostPct,
      wastageCount: shiftWastageCount,
      wastageCost: shiftWastageCost,
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
        minOrderValue: parseFloat(orderStats[0]?.min_order_value) || 0,
        ncOrders: parseInt(orderStats[0]?.nc_orders) || 0,
        ncAmount: parseFloat(orderStats[0]?.nc_amount) || 0,
        adjustmentCount: parseInt(orderStats[0]?.adjustment_count) || 0,
        adjustmentAmount: parseFloat(orderStats[0]?.total_adjustment_amount) || 0,
        totalDueAmount: parseFloat(orderStats[0]?.total_due_amount) || 0
      },
      note: 'totalSales = SUM(total_amount) of completed orders. Due collection not added to sale/collection.',
      collection: {
        totalCollection: r2(totalSalesFromOrders),
        dueCollection: r2(totalDueCollected),
        paymentBreakdown: {
          cash: r2(totalCashSales),
          card: r2(totalCardSales),
          upi: r2(totalUpiSales),
          wallet: r2(totalWalletSales),
          credit: r2(totalCreditSales)
        },
        totalDue: r2(parseFloat(orderStats[0]?.total_due_amount) || 0),
        totalNC: r2(parseFloat(orderStats[0]?.nc_amount) || 0),
        ncOrderCount: parseInt(orderStats[0]?.nc_orders) || 0,
        totalAdjustment: r2(parseFloat(orderStats[0]?.total_adjustment_amount) || 0),
        adjustmentCount: parseInt(orderStats[0]?.adjustment_count) || 0
      },
      cashierBreakdown,
      dueCollections: {
        totalCollected: parseFloat(totalDueCollected.toFixed(2)),
        count: dueCollections.length,
        orders: dueCollections
      },
      staffActivity: staffActivity.map(s => ({
        userId: s.user_id,
        userName: s.user_name,
        role: s.role || null,
        ordersCreated: parseInt(s.orders_created) || 0,
        ordersCancelled: parseInt(s.orders_cancelled) || 0,
        ordersHandled: parseInt(s.orders_handled) || 0,
        ordersHandledSales: parseFloat(s.orders_handled_sales) || 0,
        orderSales: parseFloat(s.order_sales) || 0,
        paymentsReceived: parseInt(s.payments_received) || 0,
        amountCollected: parseFloat(s.amount_collected) || 0,
        dueCollected: parseFloat(s.due_collected) || 0
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
    const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));

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
    // Helper to format datetime for MySQL query
    const formatDateTimeForQuery = (dateVal) => {
      if (!dateVal) return null;
      if (dateVal instanceof Date) {
        return `${dateVal.getFullYear()}-${String(dateVal.getMonth() + 1).padStart(2, '0')}-${String(dateVal.getDate()).padStart(2, '0')} ${String(dateVal.getHours()).padStart(2, '0')}:${String(dateVal.getMinutes()).padStart(2, '0')}:${String(dateVal.getSeconds()).padStart(2, '0')}`;
      }
      // If it's a string, return as-is (already formatted)
      return String(dateVal);
    };
    
    // Use opening_time directly (it's stored as DATETIME in DB)
    // For cross-day shifts, closing_time will have the correct date (next day)
    const shiftStartTime = formatDateTimeForQuery(shift.opening_time);
    
    // For closed shifts, use closing_time directly (handles cross-day correctly)
    // For open shifts, use current time
    let shiftEndTime;
    if (shift.closing_time) {
      shiftEndTime = formatDateTimeForQuery(shift.closing_time);
    } else if (shift.status === 'open') {
      const now = new Date();
      shiftEndTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    } else {
      // Fallback: use session_date end of day
      const sessionDateStr = shift.session_date instanceof Date 
        ? `${shift.session_date.getFullYear()}-${String(shift.session_date.getMonth() + 1).padStart(2, '0')}-${String(shift.session_date.getDate()).padStart(2, '0')}`
        : String(shift.session_date).slice(0, 10);
      shiftEndTime = `${sessionDateStr} 23:59:59`;
    }

    logger.info(`Shift ${shiftId} summary time range: ${shiftStartTime} to ${shiftEndTime} (status: ${shift.status})`);

    const floorId = shift.floor_id;

    // Build query parts — takeaway/delivery with no floor → assign to shift's cashier to avoid double-counting
    let orderFloorCond = '';
    const orderParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    if (floorId) {
      orderFloorCond = ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway', 'delivery') AND created_by = ?))`;
      orderParams.push(floorId, shift.cashier_id);
    }

    let paymentFloorCondition = '';
    const paymentParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    const splitParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    const dueCollParams = [shift.outlet_id, shiftStartTime, shiftEndTime];
    if (floorId) {
      paymentFloorCondition = ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`;
      paymentParams.push(floorId, shift.cashier_id);
      splitParams.push(floorId, shift.cashier_id);
      dueCollParams.push(floorId, shift.cashier_id);
    }

    // Parallel: orderStats(only completed) + regularPayments(excl due) + splitPayments(excl due) + dueCollection
    const [orderStatsRes, regularPaymentsRes, splitPaymentsRes, dueCollRes] = await Promise.all([
      pool.query(
        `SELECT 
          COUNT(*) as total_orders,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
          SUM(CASE WHEN status = 'completed' THEN total_amount ELSE 0 END) as total_sales,
          SUM(CASE WHEN order_type = 'dine_in' AND status = 'completed' THEN 1 ELSE 0 END) as dine_in_orders,
          SUM(CASE WHEN order_type = 'takeaway' AND status = 'completed' THEN 1 ELSE 0 END) as takeaway_orders,
          SUM(CASE WHEN order_type = 'delivery' AND status = 'completed' THEN 1 ELSE 0 END) as delivery_orders,
          AVG(CASE WHEN status = 'completed' THEN total_amount ELSE NULL END) as avg_order_value,
          MAX(CASE WHEN status = 'completed' THEN total_amount ELSE NULL END) as max_order_value,
          MIN(CASE WHEN status = 'completed' AND total_amount > 0 THEN total_amount ELSE NULL END) as min_order_value,
          COUNT(CASE WHEN is_nc = 1 AND status = 'completed' THEN 1 END) as nc_orders,
          SUM(CASE WHEN status = 'completed' THEN COALESCE(nc_amount, 0) ELSE 0 END) as nc_amount,
          COUNT(CASE WHEN is_adjustment = 1 AND status = 'completed' THEN 1 END) as adjustment_count,
          SUM(CASE WHEN status = 'completed' THEN COALESCE(adjustment_amount, 0) ELSE 0 END) as total_adjustment_amount,
          SUM(CASE WHEN status = 'completed' THEN COALESCE(due_amount, 0) ELSE 0 END) as total_due_amount,
          SUM(CASE WHEN status = 'completed' THEN COALESCE(discount_amount, 0) ELSE 0 END) as total_discounts
        FROM orders
        WHERE outlet_id = ? AND created_at >= ? AND created_at <= ?${orderFloorCond}`,
        orderParams
      ),
      // Payments EXCLUDING due collections (due already counted in total_amount at order completion)
      pool.query(
        `SELECT p.payment_mode, COUNT(*) as count, SUM(p.total_amount) as total
         FROM payments p
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
           AND p.status = 'completed' AND p.payment_mode != 'split'
           AND COALESCE(p.is_due_collection, 0) = 0${paymentFloorCondition}
         GROUP BY p.payment_mode`,
        paymentParams
      ),
      pool.query(
        `SELECT sp.payment_mode, COUNT(*) as count, SUM(sp.amount) as total
         FROM split_payments sp
         JOIN payments p ON sp.payment_id = p.id
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? 
           AND p.status = 'completed' AND p.payment_mode = 'split'
           AND COALESCE(p.is_due_collection, 0) = 0${paymentFloorCondition}
         GROUP BY sp.payment_mode`,
        splitParams
      ),
      pool.query(
        `SELECT COALESCE(SUM(p.total_amount), 0) as due_collected
         FROM payments p
         JOIN orders o ON p.order_id = o.id
         LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ?
           AND p.status = 'completed' AND COALESCE(p.is_due_collection, 0) = 1${paymentFloorCondition}`,
        dueCollParams
      )
    ]);
    const orderStats = orderStatsRes[0];
    const regularPayments = regularPaymentsRes[0];
    const splitPayments = splitPaymentsRes[0];
    const totalDueCollected = parseFloat(dueCollRes[0][0]?.due_collected) || 0;

    // Merge regular + split payments by mode (due collections already excluded)
    const paymentBreakdown = this._mergePaymentsByMode(regularPayments, splitPayments);
    const { totalCash: totalCashSales, totalCard: totalCardSales, totalUpi: totalUpiSales, totalOther: totalOtherSales, total: totalPaymentCollection } = this._calcPaymentTotals(paymentBreakdown);

    // Calculate values
    const openingCash = parseFloat(shift.opening_cash) || 0;
    
    // totalSales = SUM(total_amount) of completed orders (source of truth)
    const totalSalesAmount = parseFloat(orderStats[0]?.total_sales) || 0;
    
    // Expected amount = Opening + payment collection (excl due collections)
    const expectedAmount = openingCash + totalPaymentCollection;
    
    // Expected cash in drawer = Opening + Cash Sales only
    const expectedCashInDrawer = openingCash + totalCashSales;

    logger.info(`Shift ${shiftId} summary - Opening: ${openingCash}, Cash Sales: ${totalCashSales}, OrderSales: ${totalSalesAmount}, PaymentTotal: ${totalPaymentCollection}, Expected: ${expectedAmount}, ExpectedCash: ${expectedCashInDrawer}`);

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
      totalSales: r2(totalSalesAmount),  // SUM(total_amount) of completed orders
      totalCollection: r2(totalSalesAmount),
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
        minOrderValue: parseFloat(orderStats[0]?.min_order_value) || 0,
        ncOrders: parseInt(orderStats[0]?.nc_orders) || 0,
        ncAmount: parseFloat(orderStats[0]?.nc_amount) || 0,
        adjustmentCount: parseInt(orderStats[0]?.adjustment_count) || 0,
        adjustmentAmount: parseFloat(orderStats[0]?.total_adjustment_amount) || 0,
        totalDueAmount: parseFloat(orderStats[0]?.total_due_amount) || 0
      },
      paymentBreakdown: paymentBreakdown.map(p => ({
        mode: p.payment_mode,
        count: parseInt(p.count) || 0,
        total: parseFloat(p.total) || 0
      })),
      note: 'totalSales = SUM(total_amount) of completed orders. Due collection not added to sale/collection.',
      collection: {
        totalCollection: r2(totalSalesAmount),
        dueCollection: r2(totalDueCollected),
        paymentBreakdown: {
          cash: r2(totalCashSales),
          card: r2(totalCardSales),
          upi: r2(totalUpiSales),
          wallet: r2(paymentBreakdown.find(p => p.payment_mode === 'wallet')?.total || 0),
          credit: r2(paymentBreakdown.find(p => p.payment_mode === 'credit')?.total || 0)
        },
        totalDue: r2(parseFloat(orderStats[0]?.total_due_amount) || 0),
        totalNC: r2(parseFloat(orderStats[0]?.nc_amount) || 0),
        ncOrderCount: parseInt(orderStats[0]?.nc_orders) || 0,
        totalAdjustment: r2(parseFloat(orderStats[0]?.total_adjustment_amount) || 0),
        adjustmentCount: parseInt(orderStats[0]?.adjustment_count) || 0
      },
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
    const r2 = (n) => parseFloat((parseFloat(n) || 0).toFixed(2));
    const {
      outletId,
      startDate = null,
      endDate = null,
      floorId = null,
      cashierId = null
    } = params;

    const conditions = ['ds.outlet_id = ?'];
    const queryParams = [outletId];

    if (startDate) {
      conditions.push('ds.session_date >= ?');
      queryParams.push(startDate);
    }
    if (endDate) {
      conditions.push('ds.session_date <= ?');
      queryParams.push(endDate);
    }
    if (floorId) {
      conditions.push('ds.floor_id = ?');
      queryParams.push(floorId);
    }
    if (cashierId) {
      conditions.push('ds.cashier_id = ?');
      queryParams.push(cashierId);
    }

    const whereClause = conditions.join(' AND ');

    // Execute both independent queries in parallel
    const [shiftMetaRes, shiftRangesRes] = await Promise.all([
      pool.query(
        `SELECT 
          COUNT(*) as total_shifts,
          SUM(CASE WHEN ds.status = 'closed' THEN 1 ELSE 0 END) as closed_shifts,
          SUM(CASE WHEN ds.status = 'open' THEN 1 ELSE 0 END) as open_shifts,
          SUM(ds.cash_variance) as total_variance
         FROM day_sessions ds
         WHERE ${whereClause}`,
        queryParams
      ),
      pool.query(
        `SELECT ds.id, ds.outlet_id, ds.floor_id, ds.cashier_id, ds.opening_time, ds.closing_time, ds.session_date, ds.status
         FROM day_sessions ds
         WHERE ${whereClause}`,
        queryParams
      )
    ]);
    const shiftMeta = shiftMetaRes[0];
    const shiftRanges = shiftRangesRes[0];

    // Helper to format datetime
    const fdt = (d) => {
      if (!d) return null;
      if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
      return String(d);
    };
    const fld = (d) => {
      if (!d) return null;
      if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      return String(d).slice(0,10);
    };

    // Aggregate live totals across all matching shifts
    let grandTotalSales = 0, grandTotalOrders = 0, grandCash = 0, grandCard = 0, grandUpi = 0;
    let grandDiscounts = 0, grandDueCollected = 0, grandNC = 0, grandAdj = 0;
    let grandCompletedOrders = 0, grandCancelledOrders = 0;
    let grandTakeaway = 0, grandDineIn = 0, grandDelivery = 0;
    const perShiftSales = [];

    // Process shifts in parallel batches (max 10 at a time for DB connection efficiency)
    const BATCH_SIZE = 10;
    for (let i = 0; i < shiftRanges.length; i += BATCH_SIZE) {
      const batch = shiftRanges.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (s) => {
        const start = fdt(s.opening_time);
        let end;
        if (s.closing_time) end = fdt(s.closing_time);
        else if (s.status === 'open') { const n = new Date(); end = fdt(n); }
        else { end = `${fld(s.session_date)} 23:59:59`; }

        // Takeaway/delivery with no floor → assign to shift's cashier to avoid double-counting
        const flCond = s.floor_id
          ? ` AND (floor_id = ? OR (floor_id IS NULL AND order_type IN ('takeaway','delivery') AND created_by = ?))`
          : '';
        const flParams = s.floor_id ? [s.floor_id, s.cashier_id] : [];
        const payFlCond = s.floor_id
          ? ` AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`
          : '';
        const payFlParams = s.floor_id ? [s.floor_id, s.cashier_id] : [];

        // 4 parallel queries per shift: orderStats(only completed), regularPay(excl due), splitPay(excl due), dueColl
        const [osRes, rpRes, spRes, dcRes] = await Promise.all([
          pool.query(
            `SELECT 
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
              SUM(CASE WHEN order_type='dine_in' AND status = 'completed' THEN 1 ELSE 0 END) as dine_in,
              SUM(CASE WHEN order_type='takeaway' AND status = 'completed' THEN 1 ELSE 0 END) as takeaway,
              SUM(CASE WHEN order_type='delivery' AND status = 'completed' THEN 1 ELSE 0 END) as delivery,
              SUM(CASE WHEN status = 'completed' THEN COALESCE(total_amount,0) ELSE 0 END) as total_sale,
              SUM(CASE WHEN status = 'completed' THEN COALESCE(discount_amount,0) ELSE 0 END) as discounts,
              SUM(CASE WHEN status = 'completed' THEN COALESCE(nc_amount,0) ELSE 0 END) as nc_amt,
              SUM(CASE WHEN status = 'completed' THEN COALESCE(adjustment_amount,0) ELSE 0 END) as adj_amt
             FROM orders WHERE outlet_id=? AND created_at>=? AND created_at<=?${flCond}`,
            [s.outlet_id, start, end, ...flParams]
          ),
          pool.query(
            `SELECT p.payment_mode, SUM(p.total_amount) as total
             FROM payments p JOIN orders o ON p.order_id=o.id LEFT JOIN tables t ON o.table_id=t.id
             WHERE p.outlet_id=? AND p.created_at>=? AND p.created_at<=? AND p.status='completed' AND p.payment_mode!='split'
               AND COALESCE(p.is_due_collection,0)=0${payFlCond}
             GROUP BY p.payment_mode`,
            [s.outlet_id, start, end, ...payFlParams]
          ),
          pool.query(
            `SELECT sp.payment_mode, SUM(sp.amount) as total
             FROM split_payments sp JOIN payments p ON sp.payment_id=p.id JOIN orders o ON p.order_id=o.id LEFT JOIN tables t ON o.table_id=t.id
             WHERE p.outlet_id=? AND p.created_at>=? AND p.created_at<=? AND p.status='completed' AND p.payment_mode='split'
               AND COALESCE(p.is_due_collection,0)=0${payFlCond}
             GROUP BY sp.payment_mode`,
            [s.outlet_id, start, end, ...payFlParams]
          ),
          pool.query(
            `SELECT COALESCE(SUM(p.total_amount),0) as dc
             FROM payments p JOIN orders o ON p.order_id=o.id LEFT JOIN tables t ON o.table_id=t.id
             WHERE p.outlet_id=? AND p.created_at>=? AND p.created_at<=? AND p.status='completed' AND COALESCE(p.is_due_collection,0)=1${payFlCond}`,
            [s.outlet_id, start, end, ...payFlParams]
          )
        ]);

        const os0 = osRes[0][0] || {};
        const merged = this._mergePaymentsByMode(rpRes[0], spRes[0]);
        const { totalCash, totalCard, totalUpi, total } = this._calcPaymentTotals(merged);
        const dc = parseFloat(dcRes[0][0]?.dc) || 0;
        const shiftSale = parseFloat(os0.total_sale) || 0;

        grandTotalSales += shiftSale;
        grandCompletedOrders += parseInt(os0.completed) || 0;
        grandCancelledOrders += parseInt(os0.cancelled) || 0;
        grandDineIn += parseInt(os0.dine_in) || 0;
        grandTakeaway += parseInt(os0.takeaway) || 0;
        grandDelivery += parseInt(os0.delivery) || 0;
        grandCash += totalCash;
        grandCard += totalCard;
        grandUpi += totalUpi;
        grandDiscounts += parseFloat(os0.discounts) || 0;
        grandDueCollected += dc;
        grandNC += parseFloat(os0.nc_amt) || 0;
        grandAdj += parseFloat(os0.adj_amt) || 0;
        grandTotalOrders += (parseInt(os0.completed) || 0);
        perShiftSales.push(shiftSale);
      }));
    }

    const avgSales = perShiftSales.length > 0 ? grandTotalSales / perShiftSales.length : 0;
    const avgOrders = perShiftSales.length > 0 ? grandTotalOrders / perShiftSales.length : 0;
    const maxSales = perShiftSales.length > 0 ? Math.max(...perShiftSales) : 0;
    const positiveSales = perShiftSales.filter(s => s > 0);
    const minSales = positiveSales.length > 0 ? Math.min(...positiveSales) : 0;

    return {
      totalShifts: shiftMeta[0]?.total_shifts || 0,
      closedShifts: parseInt(shiftMeta[0]?.closed_shifts) || 0,
      openShifts: parseInt(shiftMeta[0]?.open_shifts) || 0,
      totalSales: r2(grandTotalSales),
      totalOrders: grandTotalOrders,
      totalCashSales: r2(grandCash),
      totalCardSales: r2(grandCard),
      totalUpiSales: r2(grandUpi),
      totalDiscounts: r2(grandDiscounts),
      totalVariance: parseFloat(shiftMeta[0]?.total_variance) || 0,
      avgDailySales: r2(avgSales),
      avgDailyOrders: r2(avgOrders),
      maxDailySales: r2(maxSales),
      minDailySales: r2(minSales),
      orderStats: {
        completedOrders: grandCompletedOrders,
        cancelledOrders: grandCancelledOrders,
        dineInOrders: grandDineIn,
        takeawayOrders: grandTakeaway,
        deliveryOrders: grandDelivery
      },
      note: 'totalSales = SUM(total_amount) of completed orders. Due collection not added to sale/collection.',
      collection: {
        totalCollection: r2(grandTotalSales),
        dueCollection: r2(grandDueCollected),
        paymentBreakdown: {
          cash: r2(grandCash),
          card: r2(grandCard),
          upi: r2(grandUpi)
        },
        totalNC: r2(grandNC),
        totalAdjustment: r2(grandAdj)
      },
      floorId,
      cashierId
    };
  },

  // ========================
  // DUE PAYMENT MANAGEMENT
  // ========================

  /**
   * Create a due transaction when payment is less than total
   * @param {Object} connection - Database connection (for transaction support)
   * @param {Object} data - Due transaction data
   */
  async createDueTransaction(connection, data) {
    const {
      outletId, customerId, orderId, invoiceId, paymentId,
      dueAmount, userId, notes
    } = data;

    const uuid = uuidv4();

    // Get current customer due balance
    const [customer] = await connection.query(
      'SELECT due_balance FROM customers WHERE id = ?',
      [customerId]
    );
    const currentBalance = parseFloat(customer[0]?.due_balance) || 0;
    const newBalance = currentBalance + dueAmount;

    // Create due transaction record
    await connection.query(
      `INSERT INTO customer_due_transactions (
        uuid, outlet_id, customer_id, order_id, invoice_id, payment_id,
        transaction_type, amount, balance_after, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, 'due_created', ?, ?, ?, ?)`,
      [uuid, outletId, customerId, orderId, invoiceId, paymentId, dueAmount, newBalance, notes, userId]
    );

    // Update customer due balance
    await connection.query(
      'UPDATE customers SET due_balance = ? WHERE id = ?',
      [newBalance, customerId]
    );

    logger.info(`Due created: customer=${customerId}, order=${orderId}, amount=${dueAmount}, newBalance=${newBalance}`);

    return { dueAmount, balanceAfter: newBalance };
  },

  /**
   * Create due collection transaction (when due is settled via regular payment API)
   * @param {Object} connection - Database connection (for transaction support)
   * @param {Object} data - Due collection data
   */
  async createDueCollectionTransaction(connection, data) {
    const {
      outletId, customerId, orderId, invoiceId, paymentId,
      amount, paymentMode, userId, notes
    } = data;

    const uuid = uuidv4();

    // Get current customer due balance
    const [customer] = await connection.query(
      'SELECT due_balance, total_due_collected FROM customers WHERE id = ?',
      [customerId]
    );
    const currentBalance = parseFloat(customer[0]?.due_balance) || 0;
    const totalCollected = parseFloat(customer[0]?.total_due_collected) || 0;
    const newBalance = Math.max(0, currentBalance - amount);

    // Create due collection transaction record
    await connection.query(
      `INSERT INTO customer_due_transactions (
        uuid, outlet_id, customer_id, order_id, invoice_id, payment_id,
        transaction_type, amount, balance_before, balance_after, reference_number, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, 'due_collected', ?, ?, ?, ?, ?, ?)`,
      [uuid, outletId, customerId, orderId, invoiceId, paymentId, amount, currentBalance, newBalance, paymentMode, notes, userId]
    );

    // Update customer due balance and total collected
    await connection.query(
      'UPDATE customers SET due_balance = ?, total_due_collected = ? WHERE id = ?',
      [newBalance, totalCollected + amount, customerId]
    );

    logger.info(`Due collected: customer=${customerId}, order=${orderId}, amount=${amount}, newBalance=${newBalance}`);

    return { amountCollected: amount, balanceAfter: newBalance };
  },

  /**
   * Collect due payment from customer
   * Can be for a specific order or general due collection
   */
  async collectDuePayment(data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const {
        outletId, customerId, orderId, invoiceId,
        amount, paymentMode, transactionId, referenceNumber,
        notes, receivedBy
      } = data;

      // Validate customer exists and has due balance
      const [customer] = await connection.query(
        'SELECT id, name, phone, due_balance FROM customers WHERE id = ? AND outlet_id = ?',
        [customerId, outletId]
      );
      if (!customer[0]) throw new Error('Customer not found');
      
      const currentBalance = parseFloat(customer[0].due_balance) || 0;
      if (currentBalance <= 0) throw new Error('Customer has no pending due');
      if (amount > currentBalance) throw new Error(`Amount exceeds due balance (₹${currentBalance.toFixed(2)})`);

      const uuid = uuidv4();
      const paymentNumber = await this.generatePaymentNumber(outletId);
      const newBalance = currentBalance - amount;

      // Create payment record for due collection
      const [paymentResult] = await connection.query(
        `INSERT INTO payments (
          uuid, outlet_id, order_id, invoice_id, payment_number,
          payment_mode, amount, total_amount, status,
          transaction_id, reference_number, notes,
          received_by, is_due_collection
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, TRUE)`,
        [uuid, outletId, orderId, invoiceId, paymentNumber, paymentMode, amount, amount,
         transactionId, referenceNumber, notes, receivedBy]
      );
      const paymentId = paymentResult.insertId;

      // Create due collection transaction
      const dueUuid = uuidv4();
      const [dueTxResult] = await connection.query(
        `INSERT INTO customer_due_transactions (
          uuid, outlet_id, customer_id, order_id, invoice_id, payment_id,
          transaction_type, amount, balance_after, payment_mode,
          transaction_id, reference_number, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'due_collected', ?, ?, ?, ?, ?, ?, ?)`,
        [dueUuid, outletId, customerId, orderId, invoiceId, paymentId,
         -amount, newBalance, paymentMode, transactionId, referenceNumber, notes, receivedBy]
      );

      // Update payment with due transaction ID
      await connection.query(
        'UPDATE payments SET due_transaction_id = ? WHERE id = ?',
        [dueTxResult.insertId, paymentId]
      );

      // Update customer balance
      await connection.query(
        'UPDATE customers SET due_balance = ?, total_due_collected = total_due_collected + ? WHERE id = ?',
        [newBalance, amount, customerId]
      );

      // If collecting for specific order/invoice, update their due amounts
      if (orderId) {
        await connection.query(
          `UPDATE orders SET 
            paid_amount = paid_amount + ?, 
            due_amount = GREATEST(0, due_amount - ?),
            payment_status = CASE WHEN due_amount - ? <= 0 THEN 'completed' ELSE payment_status END,
            status = CASE WHEN due_amount - ? <= 0 THEN 'completed' ELSE status END
           WHERE id = ?`,
          [amount, amount, amount, amount, orderId]
        );
      }
      if (invoiceId) {
        await connection.query(
          `UPDATE invoices SET 
            paid_amount = paid_amount + ?, 
            due_amount = GREATEST(0, due_amount - ?),
            payment_status = CASE WHEN due_amount - ? <= 0 THEN 'paid' ELSE payment_status END
           WHERE id = ?`,
          [amount, amount, amount, invoiceId]
        );
      }

      // Record cash if applicable
      if (paymentMode === 'cash') {
        await this.recordCashTransaction(connection, {
          outletId,
          userId: receivedBy,
          type: 'due_collection',
          amount,
          referenceType: 'due_payment',
          referenceId: paymentId,
          description: `Due collection from ${customer[0].name}`
        });
      }

      await connection.commit();

      logger.info(`Due collected: customer=${customerId}, amount=${amount}, newBalance=${newBalance}`);

      return {
        success: true,
        paymentId,
        paymentNumber,
        customerId,
        customerName: customer[0].name,
        amountCollected: amount,
        previousBalance: currentBalance,
        newBalance,
        paymentMode
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Get customer due balance and summary - calculated from actual orders
   * Returns comprehensive due info including history even when current due is 0
   */
  async getCustomerDueBalance(customerId, outletId = null) {
    const pool = getPool();
    
    // Get customer with outlet validation
    let customerQuery = `SELECT id, name, phone, email, outlet_id, due_balance, total_due_collected FROM customers WHERE id = ?`;
    const customerParams = [customerId];
    
    if (outletId) {
      customerQuery = `SELECT id, name, phone, email, outlet_id, due_balance, total_due_collected FROM customers WHERE id = ? AND outlet_id = ?`;
      customerParams.push(outletId);
    }
    
    const [customer] = await pool.query(customerQuery, customerParams);
    if (!customer[0]) return null;

    // Get pending due orders with actual due amounts + NC computed from items
    const [pendingOrders] = await pool.query(
      `SELECT o.id, o.order_number, o.total_amount, o.paid_amount, o.due_amount, o.created_at,
              i.id as invoice_id, i.invoice_number,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.is_nc = 1 AND oi.status != 'cancelled') as nc_item_count,
              (SELECT COALESCE(SUM(oi.total_price), 0) FROM order_items oi WHERE oi.order_id = o.id AND oi.is_nc = 1 AND oi.status != 'cancelled') as nc_amount
       FROM orders o
       LEFT JOIN invoices i ON o.id = i.order_id AND i.is_cancelled = 0
       WHERE o.customer_id = ? AND o.due_amount > 0 AND o.status != 'cancelled'
       ORDER BY o.created_at DESC`,
      [customerId]
    );

    // Calculate actual due from orders
    const actualDueBalance = pendingOrders.reduce((sum, o) => sum + (parseFloat(o.due_amount) || 0), 0);
    const totalPaidOnDueOrders = pendingOrders.reduce((sum, o) => sum + (parseFloat(o.paid_amount) || 0), 0);

    // Get due transaction summary
    const [[txnSummary]] = await pool.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN transaction_type = 'due_created' THEN amount ELSE 0 END), 0) as total_due_created,
        COALESCE(SUM(CASE WHEN transaction_type = 'due_collected' THEN amount ELSE 0 END), 0) as total_due_collected,
        COALESCE(SUM(CASE WHEN transaction_type = 'due_waived' THEN amount ELSE 0 END), 0) as total_due_waived,
        COUNT(*) as transaction_count
       FROM customer_due_transactions
       WHERE customer_id = ?`,
      [customerId]
    );

    // Get recent transactions
    const [recentTransactions] = await pool.query(
      `SELECT cdt.id, cdt.transaction_type, cdt.amount, cdt.balance_after, cdt.notes, cdt.created_at,
              o.order_number, i.invoice_number
       FROM customer_due_transactions cdt
       LEFT JOIN orders o ON cdt.order_id = o.id
       LEFT JOIN invoices i ON cdt.invoice_id = i.id
       WHERE cdt.customer_id = ?
       ORDER BY cdt.created_at DESC
       LIMIT 10`,
      [customerId]
    );

    return {
      customerId: customer[0].id,
      customerName: customer[0].name,
      customerPhone: customer[0].phone,
      customerEmail: customer[0].email,
      outletId: customer[0].outlet_id,
      dueBalance: actualDueBalance,
      storedDueBalance: parseFloat(customer[0].due_balance) || 0,
      totalDueCollected: parseFloat(txnSummary.total_due_collected) || 0,
      totalDueCreated: parseFloat(txnSummary.total_due_created) || 0,
      totalDueWaived: parseFloat(txnSummary.total_due_waived) || 0,
      pendingOrdersCount: pendingOrders.length,
      hasHistory: (txnSummary.transaction_count || 0) > 0,
      pendingOrders: pendingOrders.map(o => ({
        orderId: o.id,
        orderNumber: o.order_number,
        invoiceId: o.invoice_id || null,
        invoiceNumber: o.invoice_number || null,
        totalAmount: parseFloat(o.total_amount) || 0,
        paidAmount: parseFloat(o.paid_amount) || 0,
        dueAmount: parseFloat(o.due_amount) || 0,
        ncItemCount: parseInt(o.nc_item_count) || 0,
        ncAmount: parseFloat(o.nc_amount) || 0,
        createdAt: o.created_at
      })),
      recentTransactions: recentTransactions.map(t => ({
        id: t.id,
        type: t.transaction_type,
        amount: parseFloat(t.amount) || 0,
        balanceAfter: parseFloat(t.balance_after) || 0,
        orderNumber: t.order_number || null,
        invoiceNumber: t.invoice_number || null,
        notes: t.notes || null,
        createdAt: t.created_at
      }))
    };
  },

  /**
   * Get customer due transaction history
   */
  async getCustomerDueTransactions(customerId, options = {}) {
    const pool = getPool();
    const { page = 1, limit = 50, type } = options;
    const offset = (page - 1) * limit;

    let whereClause = 'cdt.customer_id = ?';
    const params = [customerId];

    if (type) {
      whereClause += ' AND cdt.transaction_type = ?';
      params.push(type);
    }

    const [transactions] = await pool.query(
      `SELECT cdt.*, o.order_number, i.invoice_number, u.name as created_by_name
       FROM customer_due_transactions cdt
       LEFT JOIN orders o ON cdt.order_id = o.id
       LEFT JOIN invoices i ON cdt.invoice_id = i.id
       LEFT JOIN users u ON cdt.created_by = u.id
       WHERE ${whereClause}
       ORDER BY cdt.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM customer_due_transactions cdt WHERE ${whereClause}`,
      params
    );

    return {
      transactions: transactions.map(t => ({
        id: t.id,
        transactionType: t.transaction_type,
        amount: parseFloat(t.amount) || 0,
        balanceAfter: parseFloat(t.balance_after) || 0,
        orderNumber: t.order_number,
        invoiceNumber: t.invoice_number,
        paymentMode: t.payment_mode,
        transactionId: t.transaction_id,
        referenceNumber: t.reference_number,
        notes: t.notes,
        createdBy: t.created_by_name,
        createdAt: t.created_at
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    };
  },

  /**
   * Waive/adjust customer due (for manager override)
   */
  async waiveDue(data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const { outletId, customerId, amount, reason, userId } = data;

      const [customer] = await connection.query(
        'SELECT due_balance FROM customers WHERE id = ?',
        [customerId]
      );
      if (!customer[0]) throw new Error('Customer not found');

      const currentBalance = parseFloat(customer[0].due_balance) || 0;
      if (amount > currentBalance) throw new Error('Waive amount exceeds due balance');

      const newBalance = currentBalance - amount;
      const uuid = uuidv4();

      await connection.query(
        `INSERT INTO customer_due_transactions (
          uuid, outlet_id, customer_id, transaction_type, amount,
          balance_after, notes, created_by
        ) VALUES (?, ?, ?, 'due_waived', ?, ?, ?, ?)`,
        [uuid, outletId, customerId, -amount, newBalance, reason, userId]
      );

      await connection.query(
        'UPDATE customers SET due_balance = ? WHERE id = ?',
        [newBalance, customerId]
      );

      await connection.commit();

      return { success: true, amountWaived: amount, newBalance };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Get due report for admin/manager with search, filter, pagination
   * @param {number} outletId - Outlet ID
   * @param {Object} options - Query options
   */
  async getDueReport(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1,
      limit = 20,
      search = null,
      customerId = null,
      minDue = null,
      maxDue = null,
      startDate = null,
      endDate = null,
      sortBy = 'due_balance',
      sortOrder = 'DESC'
    } = options;

    const offset = (page - 1) * limit;
    const conditions = ['c.outlet_id = ?', 'c.is_active = 1'];
    const params = [outletId];

    if (search) {
      conditions.push('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    if (customerId) {
      conditions.push('c.id = ?');
      params.push(customerId);
    }

    const whereClause = conditions.join(' AND ');

    // Build having clause for due filters
    let havingConditions = ['actual_due > 0'];
    if (minDue) {
      havingConditions.push(`actual_due >= ${parseFloat(minDue)}`);
    }
    if (maxDue) {
      havingConditions.push(`actual_due <= ${parseFloat(maxDue)}`);
    }
    const havingClause = havingConditions.join(' AND ');

    // Sort mapping - use actual calculated due, not stale column
    const sortMap = {
      due_balance: 'actual_due',
      name: 'c.name',
      total_orders: 'total_due_orders',
      last_due_date: 'last_due_date',
      total_due_collected: 'total_paid_on_due_orders'
    };
    const sortCol = sortMap[sortBy] || 'actual_due';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Build date filter for orders (IST — MySQL stores dates in IST, use DATE() directly)
    let orderDateFilter = '';
    const orderDateParams = [];
    if (startDate && endDate) {
      orderDateFilter = ' AND DATE(o.created_at) BETWEEN ? AND ?';
      orderDateParams.push(startDate, endDate);
    } else if (startDate) {
      orderDateFilter = ' AND DATE(o.created_at) >= ?';
      orderDateParams.push(startDate);
    } else if (endDate) {
      orderDateFilter = ' AND DATE(o.created_at) <= ?';
      orderDateParams.push(endDate);
    }

    // Get customers with actual due calculated from orders (exclude cancelled orders)
    const [customers] = await pool.query(
      `SELECT 
        c.id, c.name, c.phone, c.email, c.total_orders, c.total_spent, c.created_at,
        COALESCE(SUM(o.due_amount), 0) as actual_due,
        COUNT(o.id) as total_due_orders,
        MAX(o.created_at) as last_due_date,
        COALESCE(SUM(o.paid_amount), 0) as total_paid_on_due_orders
       FROM customers c
       INNER JOIN orders o ON o.customer_id = c.id AND o.due_amount > 0 AND o.status != 'cancelled'${orderDateFilter}
       WHERE ${whereClause}
       GROUP BY c.id
       HAVING ${havingClause}
       ORDER BY ${sortCol} ${order}
       LIMIT ? OFFSET ?`,
      [...orderDateParams, ...params, parseInt(limit), parseInt(offset)]
    );

    // Get total count
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM (
        SELECT c.id, COALESCE(SUM(o.due_amount), 0) as actual_due
        FROM customers c
        INNER JOIN orders o ON o.customer_id = c.id AND o.due_amount > 0 AND o.status != 'cancelled'${orderDateFilter}
        WHERE ${whereClause}
        GROUP BY c.id
        HAVING ${havingClause}
      ) as due_customers`,
      [...orderDateParams, ...params]
    );

    // Get pending due orders for each customer
    for (const customer of customers) {
      const [orders] = await pool.query(
        `SELECT o.id, o.order_number, o.total_amount, o.paid_amount, o.due_amount,
                o.is_nc, o.nc_amount, o.nc_reason,
                o.created_at, i.invoice_number, i.grand_total as invoice_total
         FROM orders o
         LEFT JOIN invoices i ON o.id = i.order_id AND i.is_cancelled = 0
         WHERE o.customer_id = ? AND o.due_amount > 0 AND o.status != 'cancelled'
         ORDER BY o.created_at DESC
         LIMIT 5`,
        [customer.id]
      );
      customer.pendingOrders = orders.map(o => ({
        orderId: o.id,
        orderNumber: o.order_number,
        invoiceNumber: o.invoice_number,
        invoiceTotal: parseFloat(o.invoice_total) || 0,
        totalAmount: parseFloat(o.total_amount) || 0,
        paidAmount: parseFloat(o.paid_amount) || 0,
        dueAmount: parseFloat(o.due_amount) || 0,
        isNC: !!o.is_nc,
        ncAmount: parseFloat(o.nc_amount) || 0,
        ncReason: o.nc_reason || null,
        createdAt: o.created_at
      }));
    }

    // Get summary - calculated from actual orders (exclude cancelled)
    const [[summary]] = await pool.query(
      `SELECT 
        COUNT(DISTINCT c.id) as total_customers_with_due,
        COALESCE(SUM(o.due_amount), 0) as total_outstanding_due,
        COALESCE(SUM(o.paid_amount), 0) as total_collected,
        AVG(od.actual_due) as avg_due_per_customer,
        MAX(od.actual_due) as max_due,
        COUNT(o.id) as total_orders_with_due
       FROM customers c
       INNER JOIN orders o ON o.customer_id = c.id AND o.due_amount > 0 AND o.status != 'cancelled'
       INNER JOIN (
         SELECT customer_id, SUM(due_amount) as actual_due
         FROM orders WHERE due_amount > 0 AND status != 'cancelled'
         GROUP BY customer_id
       ) od ON od.customer_id = c.id
       WHERE c.outlet_id = ? AND c.is_active = 1`,
      [outletId]
    );

    return {
      customers: customers.map(c => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        dueBalance: parseFloat(c.actual_due) || 0,
        totalDueCollected: parseFloat(c.total_paid_on_due_orders) || 0,
        totalOrders: c.total_orders || 0,
        totalSpent: parseFloat(c.total_spent) || 0,
        totalDueOrders: c.total_due_orders || 0,
        totalPendingDue: parseFloat(c.actual_due) || 0,
        lastDueDate: c.last_due_date,
        createdAt: c.created_at,
        pendingOrders: c.pendingOrders || []
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / limit)
      },
      summary: {
        totalCustomersWithDue: summary.total_customers_with_due || 0,
        totalOutstandingDue: parseFloat(summary.total_outstanding_due) || 0,
        totalCollected: parseFloat(summary.total_collected) || 0,
        avgDuePerCustomer: parseFloat(summary.avg_due_per_customer) || 0,
        maxDue: parseFloat(summary.max_due) || 0,
        totalOrdersWithDue: summary.total_orders_with_due || 0
      }
    };
  },

  /**
   * Get due report for CSV export (no pagination) - calculated from actual orders
   */
  async getDueReportForExport(outletId, options = {}) {
    const pool = getPool();
    const {
      search = null,
      customerId = null,
      minDue = null,
      maxDue = null,
      sortBy = 'due_balance',
      sortOrder = 'DESC'
    } = options;

    const conditions = ['c.outlet_id = ?', 'c.is_active = 1'];
    const params = [outletId];

    if (search) {
      conditions.push('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    if (customerId) {
      conditions.push('c.id = ?');
      params.push(customerId);
    }

    const whereClause = conditions.join(' AND ');

    // Build having clause for due filters
    let havingConditions = ['actual_due > 0'];
    if (minDue) {
      havingConditions.push(`actual_due >= ${parseFloat(minDue)}`);
    }
    if (maxDue) {
      havingConditions.push(`actual_due <= ${parseFloat(maxDue)}`);
    }
    const havingClause = havingConditions.join(' AND ');

    const sortMap = {
      due_balance: 'actual_due',
      name: 'c.name',
      total_orders: 'total_due_orders',
      last_due_date: 'last_due_date'
    };
    const sortCol = sortMap[sortBy] || 'actual_due';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Get all customers with actual due from orders (exclude cancelled)
    const [customers] = await pool.query(
      `SELECT 
        c.id, c.name, c.phone, c.email, c.total_orders, c.total_spent, c.created_at,
        COALESCE(SUM(o.due_amount), 0) as actual_due,
        COUNT(o.id) as total_due_orders,
        MAX(o.created_at) as last_due_date,
        COALESCE(SUM(o.paid_amount), 0) as total_paid_on_due_orders,
        GROUP_CONCAT(CONCAT(o.order_number, ': ₹', o.due_amount) SEPARATOR '; ') as pending_orders_summary
       FROM customers c
       INNER JOIN orders o ON o.customer_id = c.id AND o.due_amount > 0 AND o.status != 'cancelled'
       WHERE ${whereClause}
       GROUP BY c.id
       HAVING ${havingClause}
       ORDER BY ${sortCol} ${order}`,
      params
    );

    // Get summary from actual orders (exclude cancelled)
    const [[summary]] = await pool.query(
      `SELECT 
        COUNT(DISTINCT c.id) as total_customers_with_due,
        COALESCE(SUM(o.due_amount), 0) as total_outstanding_due,
        COALESCE(SUM(o.paid_amount), 0) as total_collected
       FROM customers c
       INNER JOIN orders o ON o.customer_id = c.id AND o.due_amount > 0 AND o.status != 'cancelled'
       WHERE c.outlet_id = ? AND c.is_active = 1`,
      [outletId]
    );

    return {
      customers: customers.map(c => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        dueBalance: parseFloat(c.actual_due) || 0,
        totalDueCollected: parseFloat(c.total_paid_on_due_orders) || 0,
        totalOrders: c.total_orders || 0,
        totalSpent: parseFloat(c.total_spent) || 0,
        totalDueOrders: c.total_due_orders || 0,
        lastDueDate: c.last_due_date,
        pendingOrdersSummary: c.pending_orders_summary,
        createdAt: c.created_at
      })),
      summary: {
        totalCustomersWithDue: summary.total_customers_with_due || 0,
        totalOutstandingDue: parseFloat(summary.total_outstanding_due) || 0,
        totalCollected: parseFloat(summary.total_collected) || 0
      }
    };
  }
};

module.exports = paymentService;
