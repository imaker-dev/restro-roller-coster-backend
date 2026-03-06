/**
 * Billing Service
 * Invoice generation, tax calculation, bill types
 * Handles GST + VAT mixed bills, service charges, discounts
 */

const { getPool } = require('../database');
const { cache, publishMessage } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const orderService = require('./order.service');
const taxService = require('./tax.service');
const printerService = require('./printer.service');
const { prefixImageUrl } = require('../utils/helpers');

/**
 * Get local date string (YYYY-MM-DD) accounting for server timezone
 */
function getLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ========================
// FORMAT HELPERS — clean camelCase output matching KOT details style
// ========================

function formatInvoiceItem(item) {
  if (!item) return null;
  
  // Handle both snake_case (raw DB) and camelCase (formatted) item structures
  const taxDetails = item.tax_details || item.taxDetails;
  
  return {
    id: item.id,
    orderItemId: item.order_item_id || item.orderItemId || item.id,
    itemId: item.item_id || item.itemId,
    name: item.item_name || item.itemName || item.name,
    shortName: item.short_name || item.shortName || null,
    imageUrl: prefixImageUrl(item.image_url || item.imageUrl),
    variantName: item.variant_name || item.variantName || null,
    itemType: item.item_type || item.itemType || null,
    quantity: parseInt(item.quantity) || 0,
    unitPrice: parseFloat(item.unit_price || item.unitPrice) || 0,
    totalPrice: parseFloat(item.total_price || item.totalPrice) || 0,
    taxDetails: taxDetails
      ? (typeof taxDetails === 'string' ? JSON.parse(taxDetails) : taxDetails)
      : null,
    status: item.status,
    specialInstructions: item.special_instructions || item.specialInstructions || null,
  };
}

function formatDiscount(discount) {
  if (!discount) return null;
  return {
    id: discount.id,
    orderId: discount.order_id,
    orderItemId: discount.order_item_id || null,
    discountId: discount.discount_id || null,
    discountCode: discount.discount_code || null,
    discountName: discount.discount_name,
    discountType: discount.discount_type,
    discountValue: parseFloat(discount.discount_value) || 0,
    discountAmount: parseFloat(discount.discount_amount) || 0,
    appliedOn: discount.applied_on || 'subtotal',
    approvedBy: discount.approved_by || null,
    createdBy: discount.created_by || null,
    createdAt: discount.created_at || null,
  };
}

function formatPaymentEntry(payment) {
  if (!payment) return null;
  const entry = {
    id: payment.id,
    paymentMode: payment.payment_mode,
    amount: parseFloat(payment.amount) || 0,
    tipAmount: parseFloat(payment.tip_amount) || 0,
    totalAmount: parseFloat(payment.total_amount) || 0,
    status: payment.status,
    transactionId: payment.transaction_id || null,
    referenceNumber: payment.reference_number || null,
    createdAt: payment.created_at || null,
  };
  // Include split payment breakdown if present
  if (payment.splitBreakdown) {
    entry.splitBreakdown = payment.splitBreakdown;
  }
  return entry;
}

function formatInvoice(invoice) {
  if (!invoice) return null;
  
  const isInterstate = !!invoice.is_interstate;
  let taxBreakup = invoice.tax_breakup
    ? (typeof invoice.tax_breakup === 'string' ? JSON.parse(invoice.tax_breakup) : invoice.tax_breakup)
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
        // Keep non-GST taxes (VAT, CESS, etc.)
        transformedBreakup[code] = data;
      }
    }
    
    // Add combined IGST if there was any GST
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
  
  return {
    id: invoice.id,
    uuid: invoice.uuid,
    outletId: invoice.outlet_id,
    orderId: invoice.order_id,
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    invoiceTime: invoice.invoice_time,
    orderNumber: invoice.order_number || null,
    orderType: invoice.order_type || null,
    tableId: invoice.table_id || null,
    tableNumber: invoice.table_number || null,
    tableName: invoice.table_name || null,
    floorId: invoice.floor_id || null,
    floorName: invoice.floor_name || null,
    customerId: invoice.customer_id || null,
    customerName: invoice.customer_name || null,
    customerPhone: invoice.customer_phone || null,
    customerEmail: invoice.customer_email || null,
    customerGstin: invoice.customer_gstin || null,
    customerCompanyName: invoice.customer_company_name || null,
    customerGstState: invoice.customer_gst_state || null,
    customerGstStateCode: invoice.customer_gst_state_code || null,
    isInterstate,
    customerAddress: invoice.customer_address || null,
    billingAddress: invoice.billing_address || null,
    subtotal: parseFloat(invoice.subtotal) || 0,
    discountAmount: parseFloat(invoice.discount_amount) || 0,
    taxableAmount: parseFloat(invoice.taxable_amount) || 0,
    cgstAmount: isInterstate ? 0 : parseFloat(invoice.cgst_amount) || 0,
    sgstAmount: isInterstate ? 0 : parseFloat(invoice.sgst_amount) || 0,
    igstAmount: isInterstate ? (parseFloat(invoice.cgst_amount) || 0) + (parseFloat(invoice.sgst_amount) || 0) + (parseFloat(invoice.igst_amount) || 0) : parseFloat(invoice.igst_amount) || 0,
    vatAmount: parseFloat(invoice.vat_amount) || 0,
    cessAmount: parseFloat(invoice.cess_amount) || 0,
    totalTax: parseFloat(invoice.total_tax) || 0,
    serviceCharge: parseFloat(invoice.service_charge) || 0,
    packagingCharge: parseFloat(invoice.packaging_charge) || 0,
    deliveryCharge: parseFloat(invoice.delivery_charge) || 0,
    roundOff: parseFloat(invoice.round_off) || 0,
    grandTotal: parseFloat(invoice.grand_total) || 0,
    amountInWords: invoice.amount_in_words || null,
    paymentStatus: invoice.payment_status,
    taxBreakup,
    hsnSummary: invoice.hsn_summary
      ? (typeof invoice.hsn_summary === 'string' ? JSON.parse(invoice.hsn_summary) : invoice.hsn_summary)
      : null,
    notes: invoice.notes || null,
    termsConditions: invoice.terms_conditions || null,
    generatedBy: invoice.generated_by || null,
    generatedByName: invoice.generated_by_name || null,
    isCancelled: !!invoice.is_cancelled,
    cancelledAt: invoice.cancelled_at || null,
    cancelledBy: invoice.cancelled_by || null,
    cancelReason: invoice.cancel_reason || null,
    createdAt: invoice.created_at || null,
    items: (invoice.items || []).map(formatInvoiceItem),
    discounts: (invoice.discounts || []).map(formatDiscount),
    payments: (invoice.payments || []).map(formatPaymentEntry),
    isDuplicate: invoice.isDuplicate || false,
    duplicateNumber: invoice.duplicateNumber || null,
  };
}

const billingService = {
  // ========================
  // PRINTER LOOKUP
  // ========================

  /**
   * Get bill printer for an outlet based on cashier user or floor
   * Priority: 0) Specific cashier user's assigned bill station printer
   *           1) Floor-specific cashier's bill station printer
   *           2) Outlet-level bill printer (station = 'bill')
   *           3) Any active network printer for the outlet
   * 
   * @param {number} outletId - Outlet ID
   * @param {number} floorId - Optional floor ID for floor-based routing
   * @param {number} cashierUserId - Optional specific cashier user ID
   */
  async getBillPrinter(outletId, floorId = null, cashierUserId = null) {
    const pool = getPool();

    // Priority 0: Find printer assigned to the specific cashier user (via user_stations -> kitchen_stations)
    if (cashierUserId) {
      const [userPrinters] = await pool.query(
        `SELECT DISTINCT p.*
         FROM user_stations us
         JOIN kitchen_stations ks ON us.station_id = ks.id AND ks.is_active = 1 AND ks.station_type = 'bill'
         JOIN printers p ON ks.printer_id = p.id AND p.is_active = 1
         WHERE us.user_id = ? AND us.outlet_id = ? AND us.is_active = 1
         ORDER BY us.is_primary DESC
         LIMIT 1`,
        [cashierUserId, outletId]
      );
      if (userPrinters[0]) {
        logger.info(`Bill printer found via cashier user ${cashierUserId}: ${userPrinters[0].name}`);
        return userPrinters[0];
      }
    }

    // Priority 1: Find printer from cashier's bill station for this floor
    if (floorId) {
      const [floorPrinters] = await pool.query(
        `SELECT DISTINCT p.*
         FROM user_floors uf
         JOIN user_roles ur ON uf.user_id = ur.user_id AND ur.outlet_id = uf.outlet_id AND ur.is_active = 1
         JOIN roles r ON ur.role_id = r.id AND r.slug = 'cashier'
         JOIN user_stations us ON uf.user_id = us.user_id AND us.outlet_id = uf.outlet_id AND us.is_active = 1
         JOIN kitchen_stations ks ON us.station_id = ks.id AND ks.is_active = 1 AND ks.station_type = 'bill'
         JOIN printers p ON ks.printer_id = p.id AND p.is_active = 1
         WHERE uf.floor_id = ? AND uf.outlet_id = ? AND uf.is_active = 1
         ORDER BY us.is_primary DESC, uf.is_primary DESC
         LIMIT 1`,
        [floorId, outletId]
      );
      if (floorPrinters[0]) {
        logger.info(`Bill printer found via floor ${floorId} cashier station: ${floorPrinters[0].name}`);
        return floorPrinters[0];
      }

      // Priority 1b: Find bill printer assigned to any cashier on this floor (simpler join)
      const [cashierPrinters] = await pool.query(
        `SELECT DISTINCT p.*
         FROM user_floors uf
         JOIN user_roles ur ON uf.user_id = ur.user_id AND ur.outlet_id = uf.outlet_id AND ur.is_active = 1
         JOIN roles r ON ur.role_id = r.id AND r.slug = 'cashier'
         JOIN printers p ON p.outlet_id = uf.outlet_id AND p.station = 'bill' AND p.is_active = 1
         WHERE uf.floor_id = ? AND uf.outlet_id = ? AND uf.is_active = 1
         LIMIT 1`,
        [floorId, outletId]
      );
      if (cashierPrinters[0]) {
        logger.info(`Bill printer found via floor ${floorId} cashier (outlet-level): ${cashierPrinters[0].name}`);
        return cashierPrinters[0];
      }
    }

    // Priority 2: Dedicated outlet-level bill printer
    let [printers] = await pool.query(
      `SELECT * FROM printers 
       WHERE outlet_id = ? AND station = 'bill' AND is_active = 1
       ORDER BY id LIMIT 1`,
      [outletId]
    );
    if (printers[0]) {
      logger.info(`Bill printer found via outlet-level bill station: ${printers[0].name}`);
      return printers[0];
    }

    // Priority 3: Bill printer type
    [printers] = await pool.query(
      `SELECT * FROM printers 
       WHERE outlet_id = ? AND printer_type = 'bill' AND is_active = 1
       ORDER BY id LIMIT 1`,
      [outletId]
    );
    if (printers[0]) {
      logger.info(`Bill printer found via printer_type=bill: ${printers[0].name}`);
      return printers[0];
    }

    // Priority 4: Any active network printer for this outlet
    [printers] = await pool.query(
      `SELECT * FROM printers 
       WHERE outlet_id = ? AND is_active = 1 AND ip_address IS NOT NULL
       ORDER BY id LIMIT 1`,
      [outletId]
    );
    if (printers[0]) {
      logger.info(`Bill printer fallback to any network printer: ${printers[0].name}`);
    }
    return printers[0] || null;
  },

  /**
   * Print bill to thermal printer — shared by generateBill + existing invoice reprint
   * Tries direct TCP first, falls back to print job queue
   */
  async printBillToThermal(invoice, order, userId) {
    const pool = getPool();

    // Get outlet info for bill header (including logo_url)
    const [outletInfo] = await pool.query(
      `SELECT name, CONCAT_WS(', ', NULLIF(address_line1,''), NULLIF(city,''), NULLIF(state,'')) as address, gstin, phone, logo_url
       FROM outlets WHERE id = ?`,
      [invoice.outletId || order.outlet_id]
    );
    const outletData = outletInfo[0] || {};
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(2);

    // Build print data from the formatted invoice (camelCase fields)
    const billPrintData = {
      outletId: invoice.outletId || order.outlet_id,
      orderId: invoice.orderId || order.id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      orderNumber: invoice.orderNumber || order.order_number || null,
      orderType: invoice.orderType || order.order_type || null,
      outletName: outletData.name || 'Restaurant',
      outletAddress: outletData.address || null,
      outletPhone: outletData.phone || null,
      outletGstin: outletData.gstin || null,
      outletLogoUrl: outletData.logo_url || null,
      tableNumber: invoice.tableNumber || order.table_number,
      cashierName: invoice.generatedByName || order.created_by_name || null,
      date: `${dd}/${mm}/${yy}`,
      time: now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      // Customer details with Walk-in fallback
      customerName: invoice.customerName || order.customer_name || 'Walk-in Customer',
      customerPhone: invoice.customerPhone || order.customer_phone || null,
      customerGstin: invoice.customerGstin || order.customer_gstin || null,
      customerCompanyName: invoice.customerCompanyName || order.customer_company_name || null,
      customerGstState: invoice.customerGstState || order.customer_gst_state || null,
      customerGstStateCode: invoice.customerGstStateCode || order.customer_gst_state_code || null,
      isInterstate: invoice.isInterstate || order.is_interstate || false,
      items: (invoice.items || []).filter(i => i.status !== 'cancelled').map(item => ({
        itemName: item.name || item.item_name || item.itemName,
        quantity: item.quantity,
        unitPrice: parseFloat(item.unitPrice || item.unit_price || 0).toFixed(2),
        totalPrice: parseFloat(item.totalPrice || item.total_price || 0).toFixed(2)
      })),
      subtotal: parseFloat(invoice.subtotal || 0).toFixed(2),
      taxes: Object.values(invoice.taxBreakup || {}).map(t => ({
        name: t.name || 'Tax',
        rate: t.rate || 0,
        amount: parseFloat(t.taxAmount || 0).toFixed(2)
      })),
      serviceCharge: parseFloat(invoice.serviceCharge || 0) > 0 ? parseFloat(invoice.serviceCharge).toFixed(2) : null,
      discount: parseFloat(invoice.discountAmount || 0) > 0 ? parseFloat(invoice.discountAmount).toFixed(2) : null,
      roundOff: invoice.roundOff !== undefined ? parseFloat(invoice.roundOff).toFixed(2) : null,
      grandTotal: parseFloat(invoice.grandTotal || 0).toFixed(2),
      paymentMode: invoice.payments?.[0]?.paymentMode || null,
      splitBreakdown: invoice.payments?.[0]?.splitBreakdown || null,
      isDuplicate: invoice.isDuplicate || false,
      duplicateNumber: invoice.duplicateNumber || null,
      openDrawer: false
    };

    // Get floor ID and user ID for printer routing
    const floorId = invoice.floorId || order.floor_id || null;
    const cashierUserId = userId || invoice.generatedBy || order.created_by || null;
    const printer = await this.getBillPrinter(billPrintData.outletId, floorId, cashierUserId);
    if (printer && printer.ip_address) {
      try {
        await printerService.printBillDirect(billPrintData, printer.ip_address, printer.port || 9100);
        logger.info(`Bill ${invoice.invoiceNumber} printed directly to ${printer.ip_address}:${printer.port || 9100}`);
        return;
      } catch (directErr) {
        logger.error(`Direct bill print failed for ${invoice.invoiceNumber}:`, directErr.message);
      }
    }
    // Fallback: create print job for bridge polling
    await printerService.printBill(billPrintData, userId);
    logger.info(`Bill ${invoice.invoiceNumber} queued for bridge printing`);
  },

  // ========================
  // INVOICE NUMBER GENERATION
  // ========================

  async generateInvoiceNumber(outletId, connection = null) {
    const queryRunner = connection || getPool();
    const today = new Date();
    const financialYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
    const fyShort = `${String(financialYear).slice(2)}${String(financialYear + 1).slice(2)}`;
    
    // Use MAX to extract highest sequence number to avoid collisions
    const [result] = await queryRunner.query(
      `SELECT MAX(CAST(SUBSTRING_INDEX(invoice_number, '/', -1) AS UNSIGNED)) as max_seq 
       FROM invoices 
       WHERE outlet_id = ? AND YEAR(invoice_date) = YEAR(CURDATE())`,
      [outletId]
    );
    
    const nextSeq = (result[0].max_seq || 0) + 1;
    const seq = String(nextSeq).padStart(6, '0');
    return `INV/${fyShort}/${seq}`;
  },

  // ========================
  // GENERATE BILL
  // ========================

  /**
   * Generate bill/invoice for order
   */
  async generateBill(orderId, data = {}) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      // Read order BEFORE transaction to avoid REPEATABLE READ snapshot issues
      let order = await orderService.getOrderWithItems(orderId);
      if (!order) {
        // Fallback: read directly via connection BEFORE transaction starts
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
          [orderId]
        );
        if (rows[0]) {
          order = rows[0];
          const [items] = await connection.query(
            `SELECT oi.*, i.short_name, i.image_url
             FROM order_items oi
             LEFT JOIN items i ON oi.item_id = i.id
             WHERE oi.order_id = ? ORDER BY oi.id`,
            [orderId]
          );
          order.items = items;
        }
      }
      if (!order) throw new Error('Order not found');

      await connection.beginTransaction();

      if (order.status === 'paid' || order.status === 'completed') {
        throw new Error('Order already paid');
      }

      // Check if invoice already exists
      const [existingInvoice] = await connection.query(
        'SELECT * FROM invoices WHERE order_id = ? AND is_cancelled = 0',
        [orderId]
      );

      if (existingInvoice[0]) {
        const ei = existingInvoice[0];
        // Default: no service charge. Only apply if explicitly passed as true
        const applyServiceCharge = data.applyServiceCharge === true;

        // Rollback the transaction — we don't need it for existing invoice
        await connection.rollback();

        // Check if customer details or isInterstate changed from order
        const isInterstate = order.is_interstate || false;
        const currentIsInterstate = !!ei.is_interstate;
        const currentSC = parseFloat(ei.service_charge) || 0;
        
        // Sync customer details from order if they've been updated
        const customerChanged = (
          (order.customer_id && order.customer_id !== ei.customer_id) ||
          (order.customer_name && order.customer_name !== ei.customer_name) ||
          (order.customer_phone && order.customer_phone !== ei.customer_phone) ||
          (order.customer_gstin && order.customer_gstin !== ei.customer_gstin) ||
          (order.customer_company_name && order.customer_company_name !== ei.customer_company_name)
        );
        
        // Recalculate if service charge, interstate, or customer changed
        const needsUpdate = (currentSC > 0 && !applyServiceCharge) || 
                           (currentSC === 0 && applyServiceCharge) ||
                           (isInterstate !== currentIsInterstate) ||
                           customerChanged;

        if (needsUpdate) {
          const billDetails = await this.calculateBillDetails(order, { applyServiceCharge, isInterstate });
          await pool.query(
            `UPDATE invoices SET
              customer_id = ?, customer_name = ?, customer_phone = ?,
              customer_gstin = ?, customer_company_name = ?,
              customer_gst_state = ?, customer_gst_state_code = ?,
              is_interstate = ?,
              cgst_amount = ?, sgst_amount = ?, igst_amount = ?, total_tax = ?,
              service_charge = ?, grand_total = ?, round_off = ?,
              amount_in_words = ?, tax_breakup = ?, hsn_summary = ?
             WHERE id = ?`,
            [
              order.customer_id || ei.customer_id,
              order.customer_name || ei.customer_name,
              order.customer_phone || ei.customer_phone,
              order.customer_gstin || ei.customer_gstin,
              order.customer_company_name || ei.customer_company_name,
              order.customer_gst_state || ei.customer_gst_state,
              order.customer_gst_state_code || ei.customer_gst_state_code,
              isInterstate ? 1 : 0,
              billDetails.cgstAmount, billDetails.sgstAmount, billDetails.igstAmount, billDetails.totalTax,
              billDetails.serviceCharge, billDetails.grandTotal, billDetails.roundOff,
              this.numberToWords(billDetails.grandTotal),
              JSON.stringify(billDetails.taxBreakup), JSON.stringify(billDetails.hsnSummary),
              ei.id
            ]
          );
        }

        const existingInv = await this.getInvoiceById(ei.id);
        try {
          await this.printBillToThermal(existingInv, order, data.generatedBy);
        } catch (printErr) {
          logger.error(`Reprint existing invoice ${existingInv?.invoiceNumber} failed:`, printErr.message);
        }
        return existingInv;
      }

      const {
        customerId, customerName, customerPhone, customerEmail,
        customerGstin, customerAddress, billingAddress,
        customerCompanyName, customerGstState, customerGstStateCode,
        applyServiceCharge = false, notes, termsConditions,
        generatedBy
      } = data;

      // Check if interstate (customer from different state)
      const isInterstate = order.is_interstate || false;

      // Calculate totals with interstate flag
      const billDetails = await this.calculateBillDetails(order, { applyServiceCharge, isInterstate });

      // Generate invoice number
      const invoiceNumber = await this.generateInvoiceNumber(order.outlet_id, connection);
      const uuid = uuidv4();
      const today = new Date();

      // Create invoice with customer GST details
      const [result] = await connection.query(
        `INSERT INTO invoices (
          uuid, outlet_id, order_id, invoice_number, invoice_date, invoice_time,
          customer_id, customer_name, customer_phone, customer_email,
          customer_gstin, customer_address, billing_address,
          is_interstate, customer_company_name, customer_gst_state, customer_gst_state_code,
          subtotal, discount_amount, taxable_amount,
          cgst_amount, sgst_amount, igst_amount, vat_amount, cess_amount, total_tax,
          service_charge, packaging_charge, delivery_charge, round_off, grand_total,
          amount_in_words, payment_status, tax_breakup, hsn_summary,
          notes, terms_conditions, generated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [
          uuid, order.outlet_id, orderId, invoiceNumber,
          today.toISOString().slice(0, 10), today.toTimeString().slice(0, 8),
          customerId || order.customer_id,
          customerName || order.customer_name,
          customerPhone || order.customer_phone,
          customerEmail,
          customerGstin || order.customer_gstin,
          customerAddress, billingAddress,
          isInterstate,
          customerCompanyName || order.customer_company_name,
          customerGstState || order.customer_gst_state,
          customerGstStateCode || order.customer_gst_state_code,
          billDetails.subtotal, billDetails.discountAmount, billDetails.taxableAmount,
          billDetails.cgstAmount, billDetails.sgstAmount, billDetails.igstAmount,
          billDetails.vatAmount, billDetails.cessAmount, billDetails.totalTax,
          billDetails.serviceCharge, billDetails.packagingCharge, billDetails.deliveryCharge,
          billDetails.roundOff, billDetails.grandTotal,
          this.numberToWords(billDetails.grandTotal),
          JSON.stringify(billDetails.taxBreakup),
          JSON.stringify(billDetails.hsnSummary),
          notes, termsConditions, generatedBy
        ]
      );

      const invoiceId = result.insertId;

      // Update order status to billed
      await connection.query(
        `UPDATE orders SET 
          status = 'billed', billed_by = ?, billed_at = NOW(),
          total_amount = ?, tax_amount = ?, service_charge = ?, round_off = ?
         WHERE id = ?`,
        [generatedBy, billDetails.grandTotal, billDetails.totalTax, billDetails.serviceCharge, billDetails.roundOff, orderId]
      );

      // Update table status to 'billing' when bill is generated (dine_in orders with a table)
      if (order.table_id && order.order_type === 'dine_in') {
        await connection.query(
          `UPDATE tables SET status = 'billing' WHERE id = ? AND status IN ('occupied', 'running', 'billing')`,
          [order.table_id]
        );
      }

      await connection.commit();

      // Try pool first, fall back to connection read for visibility lag
      let invoice = await this.getInvoiceById(invoiceId);
      if (!invoice) {
        // Fallback: read invoice directly via connection
        const [invRows] = await connection.query(
          `SELECT i.*, o.order_number, o.order_type, o.table_id,
            t.table_number, t.name as table_name
           FROM invoices i
           LEFT JOIN orders o ON i.order_id = o.id
           LEFT JOIN tables t ON o.table_id = t.id
           WHERE i.id = ?`,
          [invoiceId]
        );
        if (invRows[0]) {
          invoice = invRows[0];
          invoice.items = order.items || [];
          invoice.discounts = [];
          invoice.payments = [];
          invoice = formatInvoice(invoice);
        }
      }

      // Emit table status update to 'billing' for real-time floor view
      if (order.table_id && order.order_type === 'dine_in') {
        await publishMessage('table:update', {
          outletId: order.outlet_id,
          tableId: order.table_id,
          floorId: order.floor_id,
          status: 'billing',
          event: 'bill_generated',
          timestamp: new Date().toISOString()
        });
      }

      // Emit order update event
      await publishMessage('order:update', {
        type: 'order:billed',
        outletId: order.outlet_id,
        orderId,
        tableId: order.table_id,
        captainId: order.created_by,
        invoice,
        timestamp: new Date().toISOString()
      });

      // Get floor cashier for routing bill request to correct cashier
      let floorCashierId = null;
      if (order.floor_id) {
        const today = getLocalDate();
        const [floorShift] = await pool.query(
          `SELECT ds.cashier_id FROM day_sessions ds
           WHERE ds.outlet_id = ? AND ds.floor_id = ? AND ds.session_date = ? AND ds.status = 'open'`,
          [order.outlet_id, order.floor_id, today]
        );
        if (floorShift[0]?.cashier_id) {
          floorCashierId = floorShift[0].cashier_id;
        }
      }

      // Emit bill status event for Captain real-time tracking
      // Include floorId, orderType, and cashierId for proper routing (including takeaway)
      await publishMessage('bill:status', {
        outletId: order.outlet_id,
        orderId,
        orderType: order.order_type,
        tableId: order.table_id,
        tableNumber: order.table_number,
        floorId: order.floor_id,
        floorCashierId,
        captainId: order.created_by,
        invoiceId,
        invoiceNumber,
        billStatus: 'pending',
        grandTotal: billDetails.grandTotal,
        customerName: order.customer_name || null,
        customerPhone: order.customer_phone || null,
        timestamp: new Date().toISOString()
      });

      // Print bill to thermal printer
      try {
        await this.printBillToThermal(invoice, order, generatedBy);
      } catch (printError) {
        logger.error(`Bill print failed for ${invoiceNumber}:`, printError.message);
      }

      return invoice;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Calculate bill details with tax breakup
   * @param {Object} order - Order object with items
   * @param {Object} options - { applyServiceCharge, isInterstate }
   */
  async calculateBillDetails(order, options = {}) {
    const pool = getPool();
    const { applyServiceCharge = false } = options;
    
    // Check if interstate from order or options
    const isInterstate = options.isInterstate || order.is_interstate || false;

    let subtotal = 0;
    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;
    let vatAmount = 0;
    let cessAmount = 0;
    const taxBreakup = {};
    const hsnSummary = {};

    // Process each item
    for (const item of order.items) {
      if (item.status === 'cancelled') continue;

      // Handle both snake_case (raw DB) and camelCase (formatted) item structures
      const itemTotal = parseFloat(item.total_price || item.totalPrice) || 0;
      subtotal += itemTotal;

      // Parse tax details (handle both snake_case and camelCase)
      const itemTaxDetails = item.tax_details || item.taxDetails;
      if (itemTaxDetails) {
        const taxDetails = typeof itemTaxDetails === 'string' 
          ? JSON.parse(itemTaxDetails) 
          : itemTaxDetails;

        if (Array.isArray(taxDetails)) {
          // For interstate: convert CGST+SGST to IGST
          if (isInterstate) {
            // Calculate total GST rate from components
            let totalGstRate = 0;
            let totalGstAmount = 0;
            for (const tax of taxDetails) {
              const codeUpper = (tax.componentCode || tax.code || '').toUpperCase();
              if (codeUpper.includes('CGST') || codeUpper.includes('SGST')) {
                totalGstRate += parseFloat(tax.rate) || 0;
                totalGstAmount += parseFloat(tax.amount) || 0;
              } else if (codeUpper.includes('IGST')) {
                // Already IGST
                totalGstRate += parseFloat(tax.rate) || 0;
                totalGstAmount += parseFloat(tax.amount) || 0;
              } else {
                // VAT, CESS etc - keep as is
                const taxCode = tax.componentCode || tax.code || tax.componentName || tax.name || 'TAX';
                const taxName = tax.componentName || tax.name || taxCode;
                const taxAmt = parseFloat(tax.amount) || (itemTotal * tax.rate / 100);
                if (!taxBreakup[taxCode]) {
                  taxBreakup[taxCode] = { name: taxName, rate: tax.rate, taxableAmount: 0, taxAmount: 0 };
                }
                taxBreakup[taxCode].taxableAmount += itemTotal;
                taxBreakup[taxCode].taxAmount += taxAmt;
                const cUpper = taxCode.toUpperCase();
                if (cUpper.includes('VAT')) vatAmount += taxAmt;
                else if (cUpper.includes('CESS')) cessAmount += taxAmt;
              }
            }
            // Add combined IGST
            if (totalGstRate > 0) {
              if (!taxBreakup['IGST']) {
                taxBreakup['IGST'] = { name: 'IGST', rate: totalGstRate, taxableAmount: 0, taxAmount: 0 };
              }
              taxBreakup['IGST'].taxableAmount += itemTotal;
              taxBreakup['IGST'].taxAmount += totalGstAmount;
              igstAmount += totalGstAmount;
            }
          } else {
            // Normal intrastate: CGST + SGST
            for (const tax of taxDetails) {
              const taxCode = tax.componentCode || tax.code || tax.componentName || tax.name || 'TAX';
              const taxName = tax.componentName || tax.name || taxCode;
              const taxAmt = tax.amount || (itemTotal * tax.rate / 100);

              if (!taxBreakup[taxCode]) {
                taxBreakup[taxCode] = {
                  name: taxName,
                  rate: tax.rate,
                  taxableAmount: 0,
                  taxAmount: 0
                };
              }
              taxBreakup[taxCode].taxableAmount += itemTotal;
              taxBreakup[taxCode].taxAmount += taxAmt;

              // Categorize tax by code
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
        }
      }
    }

    // Get discount amount and calculate discount ratio
    const discountAmount = parseFloat(order.discount_amount) || 0;
    const taxableAmount = subtotal - discountAmount;
    
    // Calculate discount ratio to proportionally reduce tax
    // Tax should be calculated on discounted amount, not full subtotal
    const discountRatio = subtotal > 0 ? (taxableAmount / subtotal) : 1;

    // Apply discount ratio to all tax amounts (tax on discounted subtotal)
    for (const key of Object.keys(taxBreakup)) {
      taxBreakup[key].taxableAmount = parseFloat((taxBreakup[key].taxableAmount * discountRatio).toFixed(2));
      taxBreakup[key].taxAmount = parseFloat((taxBreakup[key].taxAmount * discountRatio).toFixed(2));
    }

    // Recalculate tax amounts after discount adjustment
    cgstAmount = parseFloat((cgstAmount * discountRatio).toFixed(2));
    sgstAmount = parseFloat((sgstAmount * discountRatio).toFixed(2));
    igstAmount = parseFloat((igstAmount * discountRatio).toFixed(2));
    vatAmount = parseFloat((vatAmount * discountRatio).toFixed(2));
    cessAmount = parseFloat((cessAmount * discountRatio).toFixed(2));

    // totalTax: sum from adjusted taxBreakup
    let totalTax = 0;
    for (const key of Object.keys(taxBreakup)) {
      totalTax += taxBreakup[key].taxAmount;
    }

    // Service charge
    let serviceCharge = 0;
    if (applyServiceCharge && order.order_type === 'dine_in') {
      const [charges] = await pool.query(
        'SELECT * FROM service_charges WHERE outlet_id = ? AND is_active = 1 LIMIT 1',
        [order.outlet_id]
      );
      if (charges[0]) {
        if (charges[0].is_percentage) {
          serviceCharge = (taxableAmount * parseFloat(charges[0].rate)) / 100;
        } else {
          serviceCharge = parseFloat(charges[0].rate);
        }
      }
    }

    const packagingCharge = parseFloat(order.packaging_charge) || 0;
    const deliveryCharge = parseFloat(order.delivery_charge) || 0;

    const preRoundTotal = taxableAmount + totalTax + serviceCharge + packagingCharge + deliveryCharge;
    const grandTotal = Math.round(preRoundTotal);
    const roundOff = grandTotal - preRoundTotal;

    return {
      subtotal: parseFloat(subtotal.toFixed(2)),
      discountAmount: parseFloat(discountAmount.toFixed(2)),
      taxableAmount: parseFloat(taxableAmount.toFixed(2)),
      cgstAmount,
      sgstAmount,
      igstAmount,
      vatAmount,
      cessAmount,
      totalTax: parseFloat(totalTax.toFixed(2)),
      serviceCharge: parseFloat(serviceCharge.toFixed(2)),
      packagingCharge: parseFloat(packagingCharge.toFixed(2)),
      deliveryCharge: parseFloat(deliveryCharge.toFixed(2)),
      roundOff: parseFloat(roundOff.toFixed(2)),
      grandTotal,
      taxBreakup,
      hsnSummary
    };
  },

  // ========================
  // INVOICE RETRIEVAL
  // ========================

  async getInvoiceById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT i.*, o.order_number, o.order_type, o.table_id, o.floor_id,
        t.table_number, t.name as table_name,
        f.name as floor_name,
        u.name as generated_by_name
       FROM invoices i
       LEFT JOIN orders o ON i.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u ON i.generated_by = u.id
       WHERE i.id = ?`,
      [id]
    );

    if (!rows[0]) return null;

    const invoice = rows[0];

    // Get order items — exclude cancelled items from bill/invoice view
    const order = await orderService.getOrderWithItems(invoice.order_id);
    invoice.items = (order.items || []).filter(item => item.status !== 'cancelled');
    invoice.discounts = order.discounts;

    // Get payments
    const [payments] = await pool.query(
      'SELECT * FROM payments WHERE invoice_id = ?',
      [id]
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
    
    invoice.payments = payments;

    return formatInvoice(invoice);
  },

  async getInvoiceByOrder(orderId) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT id FROM invoices WHERE order_id = ? AND is_cancelled = 0',
      [orderId]
    );
    return rows[0] ? await this.getInvoiceById(rows[0].id) : null;
  },

  /**
   * Get outlet info for invoice PDF / print header
   */
  async getOutletInfo(outletId) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT name, CONCAT_WS(', ', address_line1, address_line2, city, state, postal_code) as address,
        phone, email, gstin, logo_url
       FROM outlets WHERE id = ?`,
      [outletId]
    );
    return rows[0] || {};
  },

  /**
   * Resolve invoice — tries by invoice ID first, then by order ID
   */
  async resolveInvoice(id) {
    let invoice = await this.getInvoiceById(id);
    if (!invoice) {
      invoice = await this.getInvoiceByOrder(id);
    }
    if (!invoice) throw new Error('Invoice not found');
    return invoice;
  },

  /**
   * Generate invoice PDF stream
   * @param {number} id - Invoice ID or Order ID
   * @returns {{ pdfStream, invoice, filename }}
   */
  async generateInvoicePDF(id) {
    const invoice = await this.resolveInvoice(id);

    const outletData = await this.getOutletInfo(invoice.outletId);
    // Map logo_url to logoUrl for invoice-pdf.js
    const outlet = {
      ...outletData,
      logoUrl: outletData.logo_url
    };
    const { generateInvoicePDF } = require('../utils/invoice-pdf');

    const pdfStream = await generateInvoicePDF(invoice, outlet);
    const filename = `${invoice.invoiceNumber.replace(/\//g, '-')}.pdf`;

    return { pdfStream, invoice, filename };
  },

  /**
   * Print invoice to thermal printer (after payment or on demand)
   * @param {number} id - Invoice ID or Order ID
   * @param {number} userId
   */
  async printInvoice(id, userId) {
    const invoice = await this.resolveInvoice(id);

    await this.printBillToThermal(invoice, { outlet_id: invoice.outletId, floor_id: invoice.floorId }, userId);
    return invoice;
  },

  // ========================
  // BILL TYPES
  // ========================

  /**
   * Print duplicate bill
   */
  async printDuplicateBill(invoiceId, userId, reason = null) {
    const pool = getPool();

    // Get current duplicate count
    const [counts] = await pool.query(
      'SELECT COALESCE(MAX(duplicate_number), 0) + 1 as next FROM duplicate_bill_logs WHERE invoice_id = ?',
      [invoiceId]
    );

    const duplicateNumber = counts[0].next;

    await pool.query(
      `INSERT INTO duplicate_bill_logs (invoice_id, outlet_id, duplicate_number, reason, printed_by)
       SELECT ?, outlet_id, ?, ?, ? FROM invoices WHERE id = ?`,
      [invoiceId, duplicateNumber, reason, userId, invoiceId]
    );

    const invoice = await this.getInvoiceById(invoiceId);
    invoice.isDuplicate = true;
    invoice.duplicateNumber = duplicateNumber;

    // Print duplicate bill to thermal printer using shared helper
    try {
      await this.printBillToThermal(invoice, { outlet_id: invoice.outletId, floor_id: invoice.floorId }, userId);
    } catch (printError) {
      logger.error(`Duplicate bill #${duplicateNumber} print failed for ${invoice.invoiceNumber}:`, printError.message);
    }

    return invoice;
  },

  /**
   * Split bill - create multiple invoices from one order
   */
  async splitBill(orderId, splits, generatedBy) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const order = await orderService.getOrderWithItems(orderId);
      if (!order) throw new Error('Order not found');

      const invoices = [];

      for (let i = 0; i < splits.length; i++) {
        const split = splits[i];
        const { itemIds, customerName, customerPhone } = split;

        // Create partial order for invoice calculation
        const splitItems = order.items.filter(item => itemIds.includes(item.id));
        if (splitItems.length === 0) continue;

        const splitOrder = { ...order, items: splitItems };
        const billDetails = await this.calculateBillDetails(splitOrder, { applyServiceCharge: false });

        const invoiceNumber = await this.generateInvoiceNumber(order.outlet_id, connection);
        const uuid = uuidv4();
        const today = new Date();

        const [result] = await connection.query(
          `INSERT INTO invoices (
            uuid, outlet_id, order_id, invoice_number, invoice_date, invoice_time,
            customer_name, customer_phone,
            subtotal, discount_amount, taxable_amount,
            cgst_amount, sgst_amount, vat_amount, total_tax,
            service_charge, round_off, grand_total,
            amount_in_words, payment_status, tax_breakup, generated_by,
            notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          [
            uuid, order.outlet_id, orderId, invoiceNumber,
            today.toISOString().slice(0, 10), today.toTimeString().slice(0, 8),
            customerName, customerPhone,
            billDetails.subtotal, billDetails.discountAmount, billDetails.taxableAmount,
            billDetails.cgstAmount, billDetails.sgstAmount, billDetails.vatAmount, billDetails.totalTax,
            billDetails.serviceCharge, billDetails.roundOff, billDetails.grandTotal,
            this.numberToWords(billDetails.grandTotal),
            JSON.stringify(billDetails.taxBreakup), generatedBy,
            `Split bill ${i + 1} of ${splits.length}`
          ]
        );

        invoices.push({
          id: result.insertId,
          invoiceNumber,
          grandTotal: billDetails.grandTotal,
          itemCount: splitItems.length
        });
      }

      // Update order status
      await connection.query(
        `UPDATE orders SET status = 'billed', billed_by = ?, billed_at = NOW() WHERE id = ?`,
        [generatedBy, orderId]
      );

      await connection.commit();

      return invoices;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Cancel invoice
   */
  async cancelInvoice(invoiceId, reason, cancelledBy) {
    const pool = getPool();

    const invoice = await this.getInvoiceById(invoiceId);
    if (!invoice) throw new Error('Invoice not found');

    if (invoice.paymentStatus === 'paid') {
      throw new Error('Cannot cancel paid invoice');
    }

    await pool.query(
      `UPDATE invoices SET 
        is_cancelled = 1, cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ?
       WHERE id = ?`,
      [cancelledBy, reason, invoiceId]
    );

    // Revert order status
    await pool.query(
      `UPDATE orders SET status = 'served' WHERE id = ?`,
      [invoice.orderId]
    );

    // Emit bill cancelled event
    await publishMessage('bill:status', {
      outletId: invoice.outletId,
      orderId: invoice.orderId,
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      billStatus: 'cancelled',
      reason,
      timestamp: new Date().toISOString()
    });

    return { success: true, message: 'Invoice cancelled' };
  },

  // ========================
  // PENDING BILLS — Cashier real-time view
  // ========================

  /**
   * Get all pending (unpaid) invoices for an outlet — role-aware
   * Captain: sees only their own orders' bills
   * Cashier/Admin/Manager: sees all bills
   * @param {number} outletId
   * @param {object} filters - { floorId, search, sortBy, sortOrder, page, limit, status }
   *   status: 'pending' (default) | 'completed' | 'all'
   * @param {object} user - { userId, roles[] } from auth token
   */
  async getPendingBills(outletId, filters = {}, user = {}) {
    const pool = getPool();
    const { floorId, search, sortBy = 'created_at', sortOrder = 'desc', status = 'pending' } = filters;
    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit) || 20));
    const offset = (page - 1) * limit;

    // Determine if user is a captain (not admin/manager/cashier/super_admin)
    const privilegedRoles = ['admin', 'manager', 'super_admin', 'cashier'];
    const userRoles = user.roles || [];
    const isCaptain = !userRoles.some(r => privilegedRoles.includes(r));

    let whereClause = `WHERE i.outlet_id = ? AND i.is_cancelled = 0`;
    const params = [outletId];

    // Captain sees only their own orders' bills
    if (isCaptain && user.userId) {
      whereClause += ` AND o.created_by = ?`;
      params.push(user.userId);
    }

    // Status filter: pending (default), completed, or all
    if (status === 'completed') {
      whereClause += ` AND i.payment_status = 'paid'`;
    } else if (status === 'all') {
      whereClause += ` AND i.payment_status IN ('pending', 'partial', 'paid')`;
    } else {
      // Default: pending bills only
      whereClause += ` AND i.payment_status IN ('pending', 'partial')`;
    }

    // Also exclude invoices whose order is cancelled
    whereClause += ` AND (o.status IS NULL OR o.status != 'cancelled')`;

    // Order type filter (to include/exclude takeaway, delivery, etc.)
    if (filters.orderType) {
      whereClause += ' AND o.order_type = ?';
      params.push(filters.orderType);
    }

    // Floor filter with special handling for takeaway/delivery orders
    // Takeaway/delivery orders have no floor_id, so we include them if created/generated by the current user
    const isCashier = userRoles.includes('cashier');
    
    if (floorId) {
      // Specific floor requested - also include takeaway orders created by this user
      if (isCashier && user.userId) {
        whereClause += ` AND (o.floor_id = ? OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery') AND (o.created_by = ? OR i.generated_by = ?)))`;
        params.push(floorId, user.userId, user.userId);
      } else {
        whereClause += ' AND o.floor_id = ?';
        params.push(floorId);
      }
    } else if (filters.floorIds && filters.floorIds.length > 0) {
      // Multiple floors - also include takeaway orders created by this user
      if (isCashier && user.userId) {
        whereClause += ` AND (o.floor_id IN (${filters.floorIds.map(() => '?').join(',')}) OR (o.floor_id IS NULL AND o.order_type IN ('takeaway', 'delivery') AND (o.created_by = ? OR i.generated_by = ?)))`;
        params.push(...filters.floorIds, user.userId, user.userId);
      } else {
        whereClause += ` AND o.floor_id IN (${filters.floorIds.map(() => '?').join(',')})`;
        params.push(...filters.floorIds);
      }
    }
    // Note: If no floor filter at all (admin/manager), all orders are included

    // Search: table number, customer name, order number, invoice number
    if (search) {
      whereClause += ` AND (t.table_number LIKE ? OR i.customer_name LIKE ? OR o.order_number LIKE ? OR i.invoice_number LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const fromClause = `FROM invoices i
       LEFT JOIN orders o ON i.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u ON i.generated_by = u.id`;

    // Count total matching rows for pagination
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total ${fromClause} ${whereClause}`, params
    );
    const total = countResult[0].total;
    const totalPages = Math.ceil(total / limit);

    // Sort
    const allowedSorts = {
      created_at: 'i.created_at',
      grand_total: 'i.grand_total',
      table_number: 't.table_number',
      invoice_number: 'i.invoice_number',
      order_number: 'o.order_number'
    };
    const sortCol = allowedSorts[sortBy] || 'i.created_at';
    const order = sortOrder?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const dataQuery = `SELECT i.*, o.order_number, o.order_type, o.table_id, o.floor_id,
        t.table_number, t.name as table_name,
        f.name as floor_name,
        u.name as generated_by_name
       ${fromClause} ${whereClause}
       ORDER BY ${sortCol} ${order}
       LIMIT ? OFFSET ?`;

    const [rows] = await pool.query(dataQuery, [...params, limit, offset]);

    // Attach items (excluding cancelled), discounts, payments for each invoice
    const invoices = [];
    for (const row of rows) {
      const ord = await orderService.getOrderWithItems(row.order_id);
      // Filter out cancelled items — cashier should not see them on the bill
      row.items = (ord?.items || []).filter(item => item.status !== 'cancelled');
      row.discounts = ord?.discounts || [];
      const [payments] = await pool.query(
        'SELECT * FROM payments WHERE invoice_id = ?', [row.id]
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
      
      row.payments = payments;
      invoices.push(formatInvoice(row));
    }

    return {
      data: invoices,
      pagination: { page, limit, total, totalPages }
    };
  },

  // ========================
  // CAPTAIN BILLS — Captain sees only their own orders' bills
  // ========================

  /**
   * Get captain's own bills (pending/completed/all)
   * Filters by orders created_by = captainId (captain's own orders)
   * @param {number} captainId
   * @param {number} outletId
   * @param {object} filters - { status, search, page, limit, sortBy, sortOrder }
   */
  async getCaptainBills(captainId, outletId, filters = {}) {
    const pool = getPool();
    const { search, sortBy = 'created_at', sortOrder = 'desc', status = 'pending' } = filters;
    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit) || 20));
    const offset = (page - 1) * limit;

    let whereClause = `WHERE i.outlet_id = ? AND i.is_cancelled = 0 AND o.created_by = ?`;
    const params = [outletId, captainId];

    // Status filter
    if (status === 'completed') {
      whereClause += ` AND i.payment_status = 'paid'`;
    } else if (status === 'all') {
      whereClause += ` AND i.payment_status IN ('pending', 'partial', 'paid')`;
    } else {
      whereClause += ` AND i.payment_status IN ('pending', 'partial')`;
    }

    whereClause += ` AND (o.status IS NULL OR o.status != 'cancelled')`;

    // Floor restriction for captain/cashier
    if (filters.floorIds && filters.floorIds.length > 0) {
      whereClause += ` AND o.floor_id IN (${filters.floorIds.map(() => '?').join(',')})`;
      params.push(...filters.floorIds);
    }

    if (search) {
      whereClause += ` AND (t.table_number LIKE ? OR o.order_number LIKE ? OR i.invoice_number LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const fromClause = `FROM invoices i
       LEFT JOIN orders o ON i.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id`;

    // Count
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total ${fromClause} ${whereClause}`, params
    );
    const total = countResult[0].total;
    const totalPages = Math.ceil(total / limit);

    // Sort
    const allowedSorts = {
      created_at: 'i.created_at',
      grand_total: 'i.grand_total',
      table_number: 't.table_number'
    };
    const sortCol = allowedSorts[sortBy] || 'i.created_at';
    const order = sortOrder?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const [rows] = await pool.query(
      `SELECT i.*, o.order_number, o.order_type, o.table_id, o.floor_id,
        t.table_number, t.name as table_name,
        f.name as floor_name
       ${fromClause} ${whereClause}
       ORDER BY ${sortCol} ${order}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Attach items (excluding cancelled) for each invoice
    const invoices = [];
    for (const row of rows) {
      const ord = await orderService.getOrderWithItems(row.order_id);
      row.items = (ord?.items || []).filter(item => item.status !== 'cancelled');
      row.discounts = ord?.discounts || [];
      const [payments] = await pool.query(
        'SELECT * FROM payments WHERE invoice_id = ?', [row.id]
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
      
      row.payments = payments;
      invoices.push(formatInvoice(row));
    }

    return {
      data: invoices,
      pagination: { page, limit, total, totalPages }
    };
  },

  // ========================
  // UPDATE INVOICE CHARGES — Remove/restore service charge & GST
  // ========================

  /**
   * Update invoice: toggle service charge, toggle GST, recalculate
   * @param {number} invoiceId
   * @param {object} options - { removeServiceCharge, removeGst }
   * @param {number} userId
   */
  async updateInvoiceCharges(invoiceId, options, userId) {
    const pool = getPool();

    const invoice = await this.getInvoiceById(invoiceId);
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.paymentStatus === 'paid') throw new Error('Cannot modify paid invoice');
    if (invoice.isCancelled) throw new Error('Cannot modify cancelled invoice');

    const { removeServiceCharge = false, removeGst = false, customerGstin } = options;

    // When removing GST, customer GSTIN is mandatory
    if (removeGst && !customerGstin) {
      throw new Error('Customer GSTIN is required when removing GST');
    }

    // Re-fetch order to recalculate from scratch
    const order = await orderService.getOrderWithItems(invoice.orderId);
    if (!order) throw new Error('Order not found');

    // Recalculate bill with toggled options
    const applyServiceCharge = !removeServiceCharge;
    const billDetails = await this.calculateBillDetails(order, { applyServiceCharge });

    // If removeGst, zero out all taxes
    let finalTax = billDetails.totalTax;
    let finalCgst = billDetails.cgstAmount;
    let finalSgst = billDetails.sgstAmount;
    let finalIgst = billDetails.igstAmount;
    let finalVat = billDetails.vatAmount;
    let finalCess = billDetails.cessAmount;
    let finalTaxBreakup = billDetails.taxBreakup;

    if (removeGst) {
      finalTax = 0;
      finalCgst = 0;
      finalSgst = 0;
      finalIgst = 0;
      finalVat = 0;
      finalCess = 0;
      finalTaxBreakup = {};
    }

    const finalServiceCharge = removeServiceCharge ? 0 : billDetails.serviceCharge;
    const preRoundTotal = billDetails.taxableAmount + finalTax + finalServiceCharge
      + billDetails.packagingCharge + billDetails.deliveryCharge;
    const grandTotal = Math.round(preRoundTotal);
    const roundOff = parseFloat((grandTotal - preRoundTotal).toFixed(2));

    // Build update query — include customer_gstin when removing GST
    let updateQuery = `UPDATE invoices SET
        cgst_amount = ?, sgst_amount = ?, igst_amount = ?, vat_amount = ?, cess_amount = ?,
        total_tax = ?, service_charge = ?, round_off = ?, grand_total = ?,
        amount_in_words = ?, tax_breakup = ?`;
    const updateParams = [
      finalCgst, finalSgst, finalIgst, finalVat, finalCess,
      finalTax, finalServiceCharge, roundOff, grandTotal,
      this.numberToWords(grandTotal), JSON.stringify(finalTaxBreakup)
    ];

    if (removeGst && customerGstin) {
      updateQuery += ', customer_gstin = ?';
      updateParams.push(customerGstin);
    }

    updateQuery += ', updated_at = NOW() WHERE id = ?';
    updateParams.push(invoiceId);

    await pool.query(updateQuery, updateParams);

    // Update order totals to match
    await pool.query(
      `UPDATE orders SET total_amount = ?, tax_amount = ?, service_charge = ?, round_off = ? WHERE id = ?`,
      [grandTotal, finalTax, finalServiceCharge, roundOff, invoice.orderId]
    );

    const updatedInvoice = await this.getInvoiceById(invoiceId);

    // Get captainId from order for real-time filtering
    const orderForEvent = await orderService.getById(invoice.orderId);

    // Emit bill updated event for real-time
    await publishMessage('bill:status', {
      outletId: invoice.outletId,
      orderId: invoice.orderId,
      tableId: invoice.tableId,
      tableNumber: invoice.tableNumber,
      captainId: orderForEvent?.created_by || null,
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      billStatus: 'updated',
      grandTotal,
      removeServiceCharge,
      removeGst,
      timestamp: new Date().toISOString()
    });

    return updatedInvoice;
  },

  // ========================
  // DISCOUNT BY CODE — Validate from discounts master table
  // ========================

  /**
   * Apply discount using a discount code from the discounts master table
   */
  async applyDiscountByCode(orderId, discountCode, userId) {
    const pool = getPool();

    const order = await orderService.getOrderWithItems(orderId);
    if (!order) throw new Error('Order not found');

    if (['paid', 'completed', 'cancelled'].includes(order.status)) {
      throw new Error(`Cannot apply discount — order is ${order.status}`);
    }

    // Lookup discount code in discounts master
    const [discRows] = await pool.query(
      `SELECT * FROM discounts WHERE code = ? AND outlet_id = ? AND is_active = 1`,
      [discountCode, order.outlet_id]
    );

    if (!discRows[0]) throw new Error('Invalid discount code');

    const disc = discRows[0];

    // Check validity dates
    const now = new Date();
    if (disc.valid_from && now < new Date(disc.valid_from)) {
      throw new Error('Discount code is not yet valid');
    }
    if (disc.valid_until && now > new Date(disc.valid_until)) {
      throw new Error('Discount code has expired');
    }

    // Check usage limit
    if (disc.usage_limit && disc.usage_count >= disc.usage_limit) {
      throw new Error('Discount code usage limit reached');
    }

    // Check minimum order amount
    const subtotal = parseFloat(order.subtotal) || 0;
    if (disc.min_order_amount && subtotal < parseFloat(disc.min_order_amount)) {
      throw new Error(`Minimum order amount of ₹${disc.min_order_amount} required`);
    }

    // Check if already applied on this order
    const [existing] = await pool.query(
      'SELECT id FROM order_discounts WHERE order_id = ? AND discount_code = ?',
      [orderId, discountCode]
    );
    if (existing[0]) throw new Error('Discount code already applied on this order');

    // Calculate discount amount
    let discountAmount = 0;
    const discountType = disc.discount_type === 'bill_level' ? 'flat'
      : disc.discount_type === 'item_level' ? 'flat'
      : disc.discount_type;

    if (discountType === 'percentage') {
      discountAmount = (subtotal * parseFloat(disc.value)) / 100;
      // Cap at max_discount_amount if set
      if (disc.max_discount_amount && discountAmount > parseFloat(disc.max_discount_amount)) {
        discountAmount = parseFloat(disc.max_discount_amount);
      }
    } else {
      discountAmount = parseFloat(disc.value);
    }

    // Don't discount more than subtotal
    if (discountAmount > subtotal) {
      discountAmount = subtotal;
    }

    discountAmount = parseFloat(discountAmount.toFixed(2));

    // Insert order_discount record
    await pool.query(
      `INSERT INTO order_discounts (
        order_id, discount_id, discount_code, discount_name,
        discount_type, discount_value, discount_amount, applied_on,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'subtotal', ?)`,
      [
        orderId, disc.id, discountCode, disc.name,
        discountType, parseFloat(disc.value), discountAmount, userId
      ]
    );

    // Increment usage count
    await pool.query(
      'UPDATE discounts SET usage_count = usage_count + 1 WHERE id = ?',
      [disc.id]
    );

    // Recalculate order totals
    await orderService.recalculateTotals(orderId);

    // If invoice exists, recalculate it
    await this.recalculateInvoiceAfterDiscount(orderId);

    const updatedOrder = await orderService.getOrderWithItems(orderId);
    return {
      order: updatedOrder,
      appliedDiscount: {
        discountName: disc.name,
        discountCode: discountCode,
        discountType: discountType,
        discountValue: parseFloat(disc.value),
        discountAmount,
        appliedOn: 'subtotal'
      }
    };
  },

  // ========================
  // DISCOUNTS
  // ========================

  /**
   * Get all discounts applied to an order
   */
  async getOrderDiscounts(orderId) {
    const pool = getPool();

    const order = await orderService.getById(orderId);
    if (!order) throw new Error('Order not found');

    const [discounts] = await pool.query(
      `SELECT od.*, u.name as created_by_name, a.name as approved_by_name
       FROM order_discounts od
       LEFT JOIN users u ON od.created_by = u.id
       LEFT JOIN users a ON od.approved_by = a.id
       WHERE od.order_id = ?
       ORDER BY od.created_at DESC`,
      [orderId]
    );

    // Summary
    const totalDiscount = discounts.reduce((sum, d) => sum + parseFloat(d.discount_amount), 0);

    return {
      orderId: parseInt(orderId),
      orderNumber: order.order_number,
      subtotal: parseFloat(order.subtotal) || 0,
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      discountCount: discounts.length,
      discounts: discounts.map(d => ({
        id: d.id,
        discountName: d.discount_name,
        discountType: d.discount_type,
        discountValue: parseFloat(d.discount_value),
        discountAmount: parseFloat(d.discount_amount),
        discountCode: d.discount_code || null,
        appliedOn: d.applied_on,
        orderItemId: d.order_item_id || null,
        createdBy: d.created_by,
        createdByName: d.created_by_name,
        approvedBy: d.approved_by,
        approvedByName: d.approved_by_name,
        approvalReason: d.approval_reason,
        createdAt: d.created_at
      }))
    };
  },

  /**
   * Apply manual discount to order (percentage or fixed)
   * Requires security key validation (132564556)
   */
  async applyDiscount(orderId, data, userId) {
    const pool = getPool();
    const {
      discountId, discountCode, discountName, discountType, discountValue,
      appliedOn = 'subtotal', orderItemId, approvedBy, approvalReason, securityKey
    } = data;

    // Security key validation - must match authorized key
    const AUTHORIZED_DISCOUNT_KEY = '132564556';
    if (!securityKey || securityKey !== AUTHORIZED_DISCOUNT_KEY) {
      throw new Error('Invalid security key. Discount cannot be applied.');
    }

    const order = await orderService.getOrderWithItems(orderId);
    if (!order) throw new Error('Order not found');

    // Status check — can't discount paid/cancelled orders
    if (['paid', 'completed', 'cancelled'].includes(order.status)) {
      throw new Error(`Cannot apply discount — order is ${order.status}`);
    }

    const subtotal = parseFloat(order.subtotal) || 0;
    if (subtotal <= 0) throw new Error('Order has no billable amount');

    // Validate percentage range
    if (discountType === 'percentage' && discountValue > 100) {
      throw new Error('Percentage discount cannot exceed 100%');
    }

    // Calculate base amount and discount
    let baseAmount = subtotal;
    let discountAmount = 0;

    if (appliedOn === 'item' && orderItemId) {
      const item = order.items?.find(i => i.id === parseInt(orderItemId) && i.status !== 'cancelled');
      if (!item) throw new Error('Order item not found or cancelled');
      baseAmount = parseFloat(item.total_price) || 0;
    }

    if (discountType === 'percentage') {
      discountAmount = (baseAmount * discountValue) / 100;
    } else {
      discountAmount = discountValue;
    }

    // Cap: discount cannot exceed base amount
    if (discountAmount > baseAmount) {
      discountAmount = baseAmount;
    }

    // Check total discount doesn't exceed subtotal
    const existingDiscount = parseFloat(order.discount_amount) || 0;
    if (existingDiscount + discountAmount > subtotal) {
      const maxAllowed = subtotal - existingDiscount;
      throw new Error(`Discount exceeds order total. Maximum additional discount allowed: ₹${maxAllowed.toFixed(2)}`);
    }

    discountAmount = parseFloat(discountAmount.toFixed(2));

    const [result] = await pool.query(
      `INSERT INTO order_discounts (
        order_id, order_item_id, discount_id, discount_code, discount_name,
        discount_type, discount_value, discount_amount, applied_on,
        approved_by, approval_reason, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId, orderItemId || null, discountId || null, discountCode || null, discountName,
        discountType, discountValue, discountAmount, appliedOn,
        approvedBy || null, approvalReason || null, userId
      ]
    );

    // Recalculate order totals
    await orderService.recalculateTotals(orderId);

    // If invoice exists, recalculate it
    await this.recalculateInvoiceAfterDiscount(orderId);

    const updatedOrder = await orderService.getOrderWithItems(orderId);
    return {
      order: updatedOrder,
      appliedDiscount: {
        id: result.insertId,
        discountName,
        discountType,
        discountValue,
        discountAmount,
        appliedOn,
        orderItemId: orderItemId || null
      }
    };
  },

  /**
   * Remove a discount from an order
   */
  async removeDiscount(orderId, discountRecordId, userId) {
    const pool = getPool();

    const order = await orderService.getById(orderId);
    if (!order) throw new Error('Order not found');

    if (['paid', 'completed', 'cancelled'].includes(order.status)) {
      throw new Error(`Cannot remove discount — order is ${order.status}`);
    }

    // Find the discount record
    const [discRows] = await pool.query(
      'SELECT * FROM order_discounts WHERE id = ? AND order_id = ?',
      [discountRecordId, orderId]
    );
    if (!discRows[0]) throw new Error('Discount not found on this order');

    const disc = discRows[0];

    // Delete the discount record
    await pool.query('DELETE FROM order_discounts WHERE id = ?', [discountRecordId]);

    // If it was a code-based discount, decrement usage count
    if (disc.discount_id) {
      await pool.query(
        'UPDATE discounts SET usage_count = GREATEST(usage_count - 1, 0) WHERE id = ?',
        [disc.discount_id]
      );
    }

    // Recalculate order totals
    await orderService.recalculateTotals(orderId);

    // If invoice exists, recalculate it
    await this.recalculateInvoiceAfterDiscount(orderId);

    const updatedOrder = await orderService.getOrderWithItems(orderId);
    return {
      order: updatedOrder,
      removedDiscount: {
        id: disc.id,
        discountName: disc.discount_name,
        discountType: disc.discount_type,
        discountValue: parseFloat(disc.discount_value),
        discountAmount: parseFloat(disc.discount_amount),
        discountCode: disc.discount_code || null
      }
    };
  },

  /**
   * Recalculate existing invoice after discount change
   */
  async recalculateInvoiceAfterDiscount(orderId) {
    const pool = getPool();

    const [invoices] = await pool.query(
      'SELECT id FROM invoices WHERE order_id = ? AND is_cancelled = 0',
      [orderId]
    );

    if (!invoices[0]) return; // No invoice yet — nothing to recalculate

    const order = await orderService.getOrderWithItems(orderId);
    if (!order) return;

    const billDetails = await this.calculateBillDetails(order, { applyServiceCharge: false });

    await pool.query(
      `UPDATE invoices SET
        subtotal = ?, discount_amount = ?, taxable_amount = ?,
        cgst_amount = ?, sgst_amount = ?, igst_amount = ?,
        total_tax = ?, service_charge = ?,
        grand_total = ?, round_off = ?,
        amount_in_words = ?, tax_breakup = ?, hsn_summary = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        billDetails.subtotal, billDetails.discountAmount, billDetails.taxableAmount,
        billDetails.cgstAmount, billDetails.sgstAmount, billDetails.igstAmount,
        billDetails.totalTax, billDetails.serviceCharge,
        billDetails.grandTotal, billDetails.roundOff,
        this.numberToWords(billDetails.grandTotal),
        JSON.stringify(billDetails.taxBreakup), JSON.stringify(billDetails.hsnSummary),
        invoices[0].id
      ]
    );

    logger.info(`Invoice ${invoices[0].id} recalculated after discount change on order ${orderId}`);
  },

  // ========================
  // UTILITIES
  // ========================

  numberToWords(amount) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];

    if (amount === 0) return 'Zero Rupees Only';

    amount = Math.round(amount);
    let words = '';

    const crore = Math.floor(amount / 10000000);
    amount %= 10000000;
    const lakh = Math.floor(amount / 100000);
    amount %= 100000;
    const thousand = Math.floor(amount / 1000);
    amount %= 1000;
    const hundred = Math.floor(amount / 100);
    amount %= 100;

    const twoDigit = (n) => {
      if (n === 0) return '';
      if (n < 10) return ones[n];
      if (n < 20) return teens[n - 10];
      return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    };

    if (crore) words += twoDigit(crore) + ' Crore ';
    if (lakh) words += twoDigit(lakh) + ' Lakh ';
    if (thousand) words += twoDigit(thousand) + ' Thousand ';
    if (hundred) words += ones[hundred] + ' Hundred ';
    if (amount) words += twoDigit(amount);

    return words.trim() + ' Rupees Only';
  }
};

module.exports = billingService;
