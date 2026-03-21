/**
 * Purchase Service
 * Handles purchase management — creating purchases, inventory batches, stock updates,
 * average price calculation, and movement recording
 *
 * Flow: Purchase → Purchase Items → Inventory Batches → Stock Update → Movement Log
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');
const unitService = require('./unit.service');
const inventoryService = require('./inventory.service');
const { generateCode } = require('../utils/helpers');

const purchaseService = {

  // ========================
  // PURCHASE NUMBER GENERATION
  // ========================

  async _generatePurchaseNumber(outletId) {
    const pool = getPool();
    const date = new Date();
    const prefix = `PUR-${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}`;

    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) as count FROM purchases WHERE outlet_id = ? AND purchase_number LIKE ?`,
      [outletId, `${prefix}%`]
    );

    return `${prefix}-${String(count + 1).padStart(4, '0')}`;
  },

  async _generateBatchCode(inventoryItemId) {
    const date = new Date();
    const dateStr = `${String(date.getFullYear()).slice(-2)}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const rand = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    return `B-${inventoryItemId}-${dateStr}-${rand}`;
  },

  // ========================
  // CRUD
  // ========================

  async list(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1, limit = 50, vendorId, status, paymentStatus,
      startDate, endDate, search, sortBy = 'purchase_date', sortOrder = 'DESC'
    } = options;
    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['purchase_date', 'total_amount', 'created_at', 'purchase_number'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'purchase_date';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    let where = 'WHERE p.outlet_id = ?';
    const params = [outletId];

    if (vendorId) { where += ' AND p.vendor_id = ?'; params.push(vendorId); }
    if (status) { where += ' AND p.status = ?'; params.push(status); }
    if (paymentStatus) { where += ' AND p.payment_status = ?'; params.push(paymentStatus); }
    if (startDate) { where += ' AND p.purchase_date >= ?'; params.push(startDate); }
    if (endDate) { where += ' AND p.purchase_date <= ?'; params.push(endDate); }
    if (search) {
      where += ' AND (p.purchase_number LIKE ? OR p.invoice_number LIKE ? OR v.name LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM purchases p LEFT JOIN vendors v ON p.vendor_id = v.id ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT p.*, v.name as vendor_name, v.phone as vendor_phone,
        u.name as created_by_name,
        (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) as item_count
       FROM purchases p
       LEFT JOIN vendors v ON p.vendor_id = v.id
       LEFT JOIN users u ON p.created_by = u.id
       ${where}
       ORDER BY p.${safeSortBy} ${safeSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    return {
      purchases: rows.map(r => this.formatPurchase(r)),
      pagination: { page: safePage, limit: safeLimit, total, totalPages: Math.ceil(total / safeLimit) }
    };
  },

  async getById(id) {
    const pool = getPool();

    // Purchase header
    const [rows] = await pool.query(
      `SELECT p.*, v.name as vendor_name, v.phone as vendor_phone, v.gst_number as vendor_gst,
        u.name as created_by_name
       FROM purchases p
       LEFT JOIN vendors v ON p.vendor_id = v.id
       LEFT JOIN users u ON p.created_by = u.id
       WHERE p.id = ?`,
      [id]
    );
    if (!rows[0]) return null;

    // Purchase items — return in purchase unit exactly as entered (not base unit)
    const [items] = await pool.query(
      `SELECT pi.*, ii.name as item_name, ii.sku as item_sku,
        u.name as unit_name, u.abbreviation as unit_abbreviation
       FROM purchase_items pi
       LEFT JOIN inventory_items ii ON pi.inventory_item_id = ii.id
       LEFT JOIN units u ON pi.unit_id = u.id
       WHERE pi.purchase_id = ?
       ORDER BY pi.id`,
      [id]
    );

    const purchase = this.formatPurchase(rows[0]);
    purchase.items = items.map(i => ({
      id: i.id,
      inventoryItemId: i.inventory_item_id,
      itemName: i.item_name || null,
      itemSku: i.item_sku || null,
      quantity: parseFloat(i.quantity) || 0,
      unitId: i.unit_id,
      unitName: i.unit_name || null,
      unitAbbreviation: i.unit_abbreviation || null,
      pricePerUnit: parseFloat(i.price_per_unit) || 0,
      taxAmount: parseFloat(i.tax_amount) || 0,
      discountAmount: parseFloat(i.discount_amount) || 0,
      totalCost: parseFloat(i.total_cost) || 0,
      batchCode: i.batch_code || null,
      expiryDate: i.expiry_date || null,
      notes: i.notes || null
    }));

    // Get payment history
    const [payments] = await pool.query(
      `SELECT pp.*, u.name as created_by_name
       FROM purchase_payments pp
       LEFT JOIN users u ON pp.created_by = u.id
       WHERE pp.purchase_id = ?
       ORDER BY pp.payment_date ASC, pp.id ASC`,
      [id]
    );

    purchase.payments = payments.map(p => ({
      id: p.id,
      amount: parseFloat(p.amount),
      paymentMethod: p.payment_method,
      paymentReference: p.payment_reference || null,
      paymentDate: p.payment_date,
      notes: p.notes || null,
      createdByName: p.created_by_name || null,
      createdAt: p.created_at
    }));

    return purchase;
  },

  /**
   * Create purchase with items
   * This is the main entry point — creates purchase, purchase items, inventory batches,
   * updates stock, calculates average price, and records movements
   *
   * @param {number} outletId
   * @param {object} data - { vendorId, invoiceNumber, purchaseDate, items[], notes, paidAmount, taxAmount, discountAmount }
   * @param {number} userId
   */
  async create(outletId, data, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const {
        vendorId, invoiceNumber, purchaseDate, items, notes,
        paidAmount = 0, taxAmount = 0, discountAmount = 0
      } = data;

      // Validations
      if (!vendorId) throw new Error('Vendor is required');
      if (!items || !Array.isArray(items) || items.length === 0) {
        throw new Error('At least one purchase item is required');
      }
      if (!purchaseDate) throw new Error('Purchase date is required');

      // Verify vendor exists
      const [[vendor]] = await connection.query(
        'SELECT id FROM vendors WHERE id = ? AND outlet_id = ?',
        [vendorId, outletId]
      );
      if (!vendor) throw new Error('Vendor not found');

      // Generate purchase number
      const purchaseNumber = await this._generatePurchaseNumber(outletId);

      // Calculate subtotal from items
      let subtotal = 0;
      const processedItems = [];

      for (const item of items) {
        if (!item.inventoryItemId) throw new Error('Each item must have inventoryItemId');
        if (!item.quantity || item.quantity <= 0) throw new Error('Each item must have positive quantity');
        if (!item.pricePerUnit || item.pricePerUnit <= 0) throw new Error('Each item must have positive pricePerUnit');
        if (!item.unitId) throw new Error('Each item must have unitId');

        // Verify inventory item exists and get base unit
        const [[invItem]] = await connection.query(
          'SELECT id, base_unit_id FROM inventory_items WHERE id = ? AND outlet_id = ?',
          [item.inventoryItemId, outletId]
        );
        if (!invItem) throw new Error(`Inventory item ${item.inventoryItemId} not found`);

        // Convert quantity to base unit
        const quantityInBase = await unitService.toBaseUnit(item.quantity, item.unitId);

        // Calculate price per base unit
        // If purchased 10kg at ₹400/kg, and base unit is g:
        // price_per_base_unit = 400 / 1000 = ₹0.4/g
        const [unitRows] = await connection.query(
          'SELECT conversion_factor FROM units WHERE id = ?', [item.unitId]
        );
        const conversionFactor = parseFloat(unitRows[0]?.conversion_factor) || 1;
        const pricePerBaseUnit = parseFloat((item.pricePerUnit / conversionFactor).toFixed(6));

        const itemTax = parseFloat(item.taxAmount) || 0;
        const itemDiscount = parseFloat(item.discountAmount) || 0;
        const totalCost = parseFloat(((item.quantity * item.pricePerUnit) + itemTax - itemDiscount).toFixed(2));

        subtotal += totalCost;

        processedItems.push({
          ...item,
          quantityInBase,
          pricePerBaseUnit,
          totalCost,
          baseUnitId: invItem.base_unit_id,
          itemTax,
          itemDiscount
        });
      }

      const totalAmount = parseFloat((subtotal + taxAmount - discountAmount).toFixed(2));
      const dueAmount = parseFloat((totalAmount - paidAmount).toFixed(2));
      let paymentStatus = 'unpaid';
      if (paidAmount >= totalAmount) paymentStatus = 'paid';
      else if (paidAmount > 0) paymentStatus = 'partial';

      // Insert purchase
      const [purchaseResult] = await connection.query(
        `INSERT INTO purchases (
          outlet_id, vendor_id, purchase_number, invoice_number, purchase_date,
          subtotal, tax_amount, discount_amount, total_amount, paid_amount, due_amount,
          payment_status, status, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
        [
          outletId, vendorId, purchaseNumber, invoiceNumber || null, purchaseDate,
          subtotal, taxAmount, discountAmount, totalAmount, paidAmount, dueAmount,
          paymentStatus, notes || null, userId
        ]
      );
      const purchaseId = purchaseResult.insertId;

      // Process each item: insert purchase_item, create batch, update stock, record movement
      for (const item of processedItems) {
        const batchCode = item.batchCode || await this._generateBatchCode(item.inventoryItemId);

        // Insert purchase item
        const [piResult] = await connection.query(
          `INSERT INTO purchase_items (
            purchase_id, inventory_item_id, quantity, unit_id, quantity_in_base,
            price_per_unit, price_per_base_unit, tax_amount, discount_amount,
            total_cost, batch_code, expiry_date, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            purchaseId, item.inventoryItemId, item.quantity, item.unitId, item.quantityInBase,
            item.pricePerUnit, item.pricePerBaseUnit, item.itemTax, item.itemDiscount,
            item.totalCost, batchCode, item.expiryDate || null, item.notes || null
          ]
        );

        // Create inventory batch + update stock + record movement
        // Uses quantityInBase (base unit) for stock tracking
        await inventoryService.createBatch(connection, {
          inventoryItemId: item.inventoryItemId,
          outletId,
          batchCode,
          quantity: item.quantityInBase,
          purchasePrice: item.pricePerBaseUnit,
          purchaseDate,
          expiryDate: item.expiryDate || null,
          vendorId,
          purchaseItemId: piResult.insertId,
          userId
        });
      }

      // Record initial payment if paidAmount > 0
      if (paidAmount > 0) {
        await connection.query(
          `INSERT INTO purchase_payments 
           (purchase_id, amount, payment_method, payment_date, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            purchaseId,
            paidAmount,
            data.paymentMethod || 'cash',
            purchaseDate,
            'Initial payment at purchase',
            userId
          ]
        );
      }

      await connection.commit();

      logger.info(`Purchase ${purchaseNumber} created with ${processedItems.length} items for outlet ${outletId}`);
      return this.getById(purchaseId);

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Cancel a purchase — reverses all stock changes
   */
  async cancel(purchaseId, userId, reason) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [[purchase]] = await connection.query(
        'SELECT * FROM purchases WHERE id = ? FOR UPDATE',
        [purchaseId]
      );
      if (!purchase) throw new Error('Purchase not found');
      if (purchase.status === 'cancelled') throw new Error('Purchase is already cancelled');

      // Get all purchase items
      const [items] = await connection.query(
        'SELECT * FROM purchase_items WHERE purchase_id = ?',
        [purchaseId]
      );

      // Reverse stock for each item
      for (const item of items) {
        const qtyInBase = parseFloat(item.quantity_in_base);

        // Get current stock
        const [[invItem]] = await connection.query(
          'SELECT current_stock FROM inventory_items WHERE id = ? FOR UPDATE',
          [item.inventory_item_id]
        );
        if (!invItem) continue;

        const balanceBefore = parseFloat(invItem.current_stock);
        const balanceAfter = Math.max(0, balanceBefore - qtyInBase);

        // Update stock
        await connection.query(
          'UPDATE inventory_items SET current_stock = ? WHERE id = ?',
          [balanceAfter, item.inventory_item_id]
        );

        // Deactivate the batch created by this purchase item
        await connection.query(
          `UPDATE inventory_batches SET is_active = 0, remaining_quantity = 0
           WHERE purchase_item_id = ?`,
          [item.id]
        );

        // Record reversal movement
        await connection.query(
          `INSERT INTO inventory_movements (
            outlet_id, inventory_item_id, movement_type,
            quantity, quantity_in_base, balance_before, balance_after,
            reference_type, reference_id, notes, created_by
          ) VALUES (?, ?, 'adjustment', ?, ?, ?, ?, 'purchase_cancel', ?, ?, ?)`,
          [
            purchase.outlet_id, item.inventory_item_id,
            -qtyInBase, -qtyInBase, balanceBefore, balanceAfter,
            purchaseId, reason || 'Purchase cancelled', userId
          ]
        );

        // Recalculate average price from remaining active batches
        await this._recalculateAveragePrice(connection, item.inventory_item_id);
      }

      // Mark purchase as cancelled
      await connection.query(
        'UPDATE purchases SET status = ? WHERE id = ?',
        ['cancelled', purchaseId]
      );

      await connection.commit();

      logger.info(`Purchase ${purchase.purchase_number} cancelled by user ${userId}`);
      return this.getById(purchaseId);

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Record a payment against a purchase
   * This ADDS to the existing paid amount (not replaces)
   */
  async updatePayment(purchaseId, data, userId = null) {
    const pool = getPool();
    const {
      amount,
      paymentMethod = 'cash',
      paymentReference,
      paymentDate,
      notes
    } = data;

    // Support legacy 'paidAmount' field for backward compatibility
    const paymentAmount = parseFloat(amount || data.paidAmount);

    const [[purchase]] = await pool.query('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
    if (!purchase) throw new Error('Purchase not found');
    if (purchase.status === 'cancelled') throw new Error('Cannot update cancelled purchase');

    if (!paymentAmount || paymentAmount <= 0) {
      throw new Error('Payment amount must be greater than 0');
    }

    const totalAmount = parseFloat(purchase.total_amount);
    const currentPaid = parseFloat(purchase.paid_amount) || 0;
    const currentDue = parseFloat(purchase.due_amount) || totalAmount;

    // Check if payment exceeds due amount
    if (paymentAmount > currentDue + 0.01) { // small tolerance for rounding
      throw new Error(`Payment amount (${paymentAmount}) exceeds due amount (${currentDue})`);
    }

    // Calculate new totals
    const newPaidTotal = parseFloat((currentPaid + paymentAmount).toFixed(2));
    const newDueAmount = parseFloat((totalAmount - newPaidTotal).toFixed(2));

    let paymentStatus = 'unpaid';
    if (newPaidTotal >= totalAmount - 0.01) paymentStatus = 'paid';
    else if (newPaidTotal > 0) paymentStatus = 'partial';

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Record the payment in purchase_payments table
      await connection.query(
        `INSERT INTO purchase_payments 
         (purchase_id, amount, payment_method, payment_reference, payment_date, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          purchaseId,
          paymentAmount,
          paymentMethod,
          paymentReference || null,
          paymentDate || new Date().toISOString().split('T')[0],
          notes || null,
          userId
        ]
      );

      // Update purchase totals
      await connection.query(
        'UPDATE purchases SET paid_amount = ?, due_amount = ?, payment_status = ? WHERE id = ?',
        [newPaidTotal, Math.max(0, newDueAmount), paymentStatus, purchaseId]
      );

      await connection.commit();

      logger.info(`Payment of ${paymentAmount} recorded for purchase ${purchase.purchase_number}. New total paid: ${newPaidTotal}`);

      return this.getById(purchaseId);

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Get payment history for a purchase
   */
  async getPaymentHistory(purchaseId) {
    const pool = getPool();

    const [[purchase]] = await pool.query('SELECT id FROM purchases WHERE id = ?', [purchaseId]);
    if (!purchase) throw new Error('Purchase not found');

    const [payments] = await pool.query(
      `SELECT pp.*, u.name as created_by_name
       FROM purchase_payments pp
       LEFT JOIN users u ON pp.created_by = u.id
       WHERE pp.purchase_id = ?
       ORDER BY pp.payment_date DESC, pp.id DESC`,
      [purchaseId]
    );

    return payments.map(p => ({
      id: p.id,
      purchaseId: p.purchase_id,
      amount: parseFloat(p.amount),
      paymentMethod: p.payment_method,
      paymentReference: p.payment_reference || null,
      paymentDate: p.payment_date,
      notes: p.notes || null,
      createdBy: p.created_by,
      createdByName: p.created_by_name || null,
      createdAt: p.created_at
    }));
  },

  /**
   * Recalculate weighted average price from active batches
   */
  async _recalculateAveragePrice(connection, inventoryItemId) {
    const [[result]] = await connection.query(
      `SELECT
        COALESCE(SUM(remaining_quantity * purchase_price), 0) as total_value,
        COALESCE(SUM(remaining_quantity), 0) as total_qty
       FROM inventory_batches
       WHERE inventory_item_id = ? AND is_active = 1 AND remaining_quantity > 0`,
      [inventoryItemId]
    );

    const totalQty = parseFloat(result.total_qty) || 0;
    const totalValue = parseFloat(result.total_value) || 0;
    const newAvg = totalQty > 0 ? parseFloat((totalValue / totalQty).toFixed(6)) : 0;

    // Get latest price from most recent active batch
    const [[latestBatch]] = await connection.query(
      `SELECT purchase_price FROM inventory_batches
       WHERE inventory_item_id = ? AND is_active = 1
       ORDER BY purchase_date DESC, id DESC LIMIT 1`,
      [inventoryItemId]
    );

    await connection.query(
      'UPDATE inventory_items SET average_price = ?, latest_price = ? WHERE id = ?',
      [newAvg, latestBatch ? parseFloat(latestBatch.purchase_price) : 0, inventoryItemId]
    );
  },

  // ========================
  // FORMAT
  // ========================

  formatPurchase(row) {
    if (!row) return null;
    return {
      id: row.id,
      outletId: row.outlet_id,
      vendorId: row.vendor_id,
      vendorName: row.vendor_name || null,
      vendorPhone: row.vendor_phone || null,
      vendorGst: row.vendor_gst || null,
      purchaseNumber: row.purchase_number,
      invoiceNumber: row.invoice_number || null,
      purchaseDate: row.purchase_date,
      subtotal: parseFloat(row.subtotal) || 0,
      taxAmount: parseFloat(row.tax_amount) || 0,
      discountAmount: parseFloat(row.discount_amount) || 0,
      totalAmount: parseFloat(row.total_amount) || 0,
      paidAmount: parseFloat(row.paid_amount) || 0,
      dueAmount: parseFloat(row.due_amount) || 0,
      paymentStatus: row.payment_status,
      status: row.status,
      notes: row.notes || null,
      itemCount: parseInt(row.item_count) || 0,
      createdBy: row.created_by || null,
      createdByName: row.created_by_name || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
};

module.exports = purchaseService;
