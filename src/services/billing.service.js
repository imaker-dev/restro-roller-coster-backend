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

/**
 * Convert business-day date strings to actual datetime range for index-friendly WHERE.
 * For startDate=2026-04-11, endDate=2026-04-11:
 *   startDt = '2026-04-11 04:00:00' (4am April 11)
 *   endDt   = '2026-04-12 04:00:00' (4am April 12, exclusive)
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
    isNC: !!(item.is_nc || item.isNc || item.isNC),
    ncAmount: parseFloat(item.nc_amount || item.ncAmount) || 0,
    ncReason: item.nc_reason || item.ncReason || null,
    isOpenItem: !!(item.is_open_item || item.isOpenItem),
  };
}

function formatDiscount(discount) {
  if (!discount) return null;
  return {
    id: discount.id,
    orderId: discount.order_id || discount.orderId,
    orderItemId: discount.order_item_id || discount.orderItemId || null,
    discountId: discount.discount_id || discount.discountId || null,
    discountCode: discount.discount_code || discount.discountCode || null,
    discountName: discount.discount_name || discount.discountName,
    discountType: discount.discount_type || discount.discountType,
    discountValue: parseFloat(discount.discount_value || discount.discountValue) || 0,
    discountAmount: parseFloat(discount.discount_amount || discount.discountAmount) || 0,
    appliedOn: discount.applied_on || discount.appliedOn || 'subtotal',
    approvedBy: discount.approved_by || discount.approvedBy || null,
    createdBy: discount.created_by || discount.createdBy || null,
    createdAt: discount.created_at || discount.createdAt || null,
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
    isAdjustment: !!payment.is_adjustment,
    adjustmentAmount: parseFloat(payment.adjustment_amount) || 0,
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

/**
 * Consolidate identical items in bill (same name + variant + unitPrice + isNC).
 * Merges quantities and totals so "Burger x1 + Burger x2" becomes "Burger x3".
 */
function consolidateInvoiceItems(items) {
  const map = new Map();
  for (const item of items) {
    const key = `${item.name}|${item.variantName || ''}|${item.unitPrice}|${item.isNC}`;
    if (map.has(key)) {
      const existing = map.get(key);
      existing.quantity += item.quantity;
      existing.totalPrice = parseFloat((existing.totalPrice + item.totalPrice).toFixed(2));
      existing.ncAmount = parseFloat((existing.ncAmount + item.ncAmount).toFixed(2));
    } else {
      map.set(key, { ...item });
    }
  }
  return Array.from(map.values());
}

function formatInvoice(invoice) {
  if (!invoice) return null;
  
  const isInterstate = !!invoice.is_interstate;
  let taxBreakup = invoice.tax_breakup
    ? (typeof invoice.tax_breakup === 'string' ? JSON.parse(invoice.tax_breakup) : invoice.tax_breakup)
    : null;
  
  // Transform taxBreakup for interstate: convert CGST+SGST to IGST per rate group
  if (isInterstate && taxBreakup) {
    const transformedBreakup = {};
    // Group GST components by rate to create proper IGST entries per rate group
    const gstByRate = {};
    
    for (const [code, data] of Object.entries(taxBreakup)) {
      const codeUpper = code.toUpperCase();
      if (codeUpper.includes('CGST') || codeUpper.includes('SGST')) {
        const rate = parseFloat(data.rate) || 0;
        const rateKey = String(rate);
        if (!gstByRate[rateKey]) {
          gstByRate[rateKey] = { totalRate: 0, taxableAmount: 0, taxAmount: 0 };
        }
        gstByRate[rateKey].totalRate += rate;
        gstByRate[rateKey].taxableAmount = Math.max(gstByRate[rateKey].taxableAmount, parseFloat(data.taxableAmount) || 0);
        gstByRate[rateKey].taxAmount += parseFloat(data.taxAmount) || 0;
      } else {
        // Keep non-GST taxes (VAT, CESS, IGST, etc.)
        transformedBreakup[code] = data;
      }
    }
    
    // Create IGST entries for each rate group (e.g., CGST@2.5+SGST@2.5 → IGST@5)
    for (const [, gstData] of Object.entries(gstByRate)) {
      const igstRate = gstData.totalRate;
      const igstKey = 'IGST@' + igstRate;
      if (!transformedBreakup[igstKey]) {
        transformedBreakup[igstKey] = { name: 'IGST', rate: igstRate, taxableAmount: 0, taxAmount: 0 };
      }
      transformedBreakup[igstKey].taxableAmount += gstData.taxableAmount;
      transformedBreakup[igstKey].taxAmount += gstData.taxAmount;
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
    isNC: !!invoice.is_nc,
    ncAmount: parseFloat(invoice.nc_amount) || 0,
    paidAmount: parseFloat(invoice.paid_amount) || 0,
    dueAmount: parseFloat(invoice.due_amount) || 0,
    isAdjustment: !!invoice.is_adjustment || (parseFloat(invoice.adjustment_amount) || 0) > 0,
    adjustmentAmount: parseFloat(invoice.adjustment_amount) || 0,
    isDuePayment: !!invoice.is_due_payment,
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
    items: consolidateInvoiceItems((invoice.items || []).map(formatInvoiceItem)),
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
   * Get bill printer for an outlet — simple step-by-step resolution with full logging.
   * Flow: requester → floor → floor cashier (day_sessions) → cashier's stations → bill station → printer
   */
  async getBillPrinter(outletId, floorId = null, cashierUserId = null) {
    const pool = getPool();

    logger.info(`[BILL-PRINTER] === START === outletId=${outletId}, floorId=${floorId}, requestUserId=${cashierUserId}`);

    // Helper: check if a station is bill-related
    const isBillStation = (s) => {
      const type = (s.station_type || '').toLowerCase();
      const name = (s.station_name || s.name || '').toLowerCase();
      return type === 'bill' || type.includes('bill') || name.includes('bill');
    };

    // Bidirectional printer lookup: ks.printer_id → p.id OR p.station_id → ks.id
    // (kitchen_stations.printer_id may be NULL even when printers.station_id is set)
    const printerJoin = `LEFT JOIN printers p ON (
      (ks.printer_id IS NOT NULL AND p.id = ks.printer_id AND p.is_active = 1)
      OR (ks.printer_id IS NULL AND p.station_id = ks.id AND p.is_active = 1 AND p.outlet_id = ks.outlet_id)
    )`;

    // ── Step 1: If cashierUserId given, get ALL their stations and find bill station ──
    if (cashierUserId) {
      const [stations] = await pool.query(
        `SELECT us.station_id, us.is_primary,
                ks.name AS station_name, ks.station_type, ks.printer_id AS ks_printer_id,
                p.id AS p_id, p.name AS printer_name, p.ip_address, p.port, p.station AS printer_station,
                p.station_id AS p_station_id
         FROM user_stations us
         JOIN kitchen_stations ks ON us.station_id = ks.id AND ks.is_active = 1
         ${printerJoin}
         WHERE us.user_id = ? AND us.outlet_id = ? AND us.is_active = 1
         ORDER BY us.is_primary DESC`,
        [cashierUserId, outletId]
      );
      logger.info(`[BILL-PRINTER] Step1: user ${cashierUserId} stations (${stations.length}): ${JSON.stringify(stations.map(s => ({ name: s.station_name, type: s.station_type, ks_printerId: s.ks_printer_id, p_station_id: s.p_station_id, printerName: s.printer_name, ip: s.ip_address })))}`);

      const bill = stations.find(isBillStation);
      if (bill && bill.p_id) {
        logger.info(`[BILL-PRINTER] Step1: ✅ FOUND → station "${bill.station_name}" → printer "${bill.printer_name}" id=${bill.p_id} ip=${bill.ip_address}:${bill.port}`);
        const [printer] = await pool.query('SELECT * FROM printers WHERE id = ?', [bill.p_id]);
        if (printer[0]) return printer[0];
      } else if (bill) {
        logger.warn(`[BILL-PRINTER] Step1: Bill station "${bill.station_name}" (ks.id=${bill.station_id}) found but NO printer linked (ks.printer_id=${bill.ks_printer_id}, no printers.kitchen_station_id match)`);
      } else {
        logger.warn(`[BILL-PRINTER] Step1: User ${cashierUserId} has NO bill station among their ${stations.length} stations`);
      }
    }

    // ── Step 2: Find floor's cashier from day_sessions, then THEIR stations ──
    if (floorId) {
      const [sessions] = await pool.query(
        `SELECT ds.id, ds.cashier_id, u.name AS cashier_name
         FROM day_sessions ds
         LEFT JOIN users u ON ds.cashier_id = u.id
         WHERE ds.outlet_id = ? AND ds.floor_id = ? AND ds.status = 'open'
         ORDER BY ds.id DESC LIMIT 1`,
        [outletId, floorId]
      );
      logger.info(`[BILL-PRINTER] Step2a: day_sessions for floor ${floorId}: ${sessions[0] ? `cashier="${sessions[0].cashier_name}" id=${sessions[0].cashier_id}` : 'NONE'}`);

      if (sessions[0] && sessions[0].cashier_id && sessions[0].cashier_id !== cashierUserId) {
        const floorCashierId = sessions[0].cashier_id;
        const [stations] = await pool.query(
          `SELECT us.station_id, us.is_primary,
                  ks.name AS station_name, ks.station_type, ks.printer_id AS ks_printer_id,
                  p.id AS p_id, p.name AS printer_name, p.ip_address, p.port,
                  p.station_id AS p_station_id
           FROM user_stations us
           JOIN kitchen_stations ks ON us.station_id = ks.id AND ks.is_active = 1
           ${printerJoin}
           WHERE us.user_id = ? AND us.outlet_id = ? AND us.is_active = 1
           ORDER BY us.is_primary DESC`,
          [floorCashierId, outletId]
        );
        logger.info(`[BILL-PRINTER] Step2b: floor cashier ${floorCashierId} stations (${stations.length}): ${JSON.stringify(stations.map(s => ({ name: s.station_name, type: s.station_type, ks_printerId: s.ks_printer_id, p_station_id: s.p_station_id, printerName: s.printer_name, ip: s.ip_address })))}`);

        const bill = stations.find(isBillStation);
        if (bill && bill.p_id) {
          logger.info(`[BILL-PRINTER] Step2b: ✅ FOUND → floor ${floorId} cashier ${floorCashierId} → station "${bill.station_name}" → printer "${bill.printer_name}" id=${bill.p_id} ip=${bill.ip_address}:${bill.port}`);
          const [printer] = await pool.query('SELECT * FROM printers WHERE id = ?', [bill.p_id]);
          if (printer[0]) return printer[0];
        } else {
          logger.warn(`[BILL-PRINTER] Step2b: Floor cashier ${floorCashierId} has NO bill station with printer`);
        }
      }
    }

    // ── Step 3: Find ALL bill-type kitchen stations in outlet with bidirectional printer lookup ──
    const [allBillStations] = await pool.query(
      `SELECT ks.id, ks.name, ks.station_type, ks.printer_id AS ks_printer_id,
              p.id AS p_id, p.name AS printer_name, p.ip_address, p.port,
              p.station_id AS p_station_id
       FROM kitchen_stations ks
       ${printerJoin}
       WHERE ks.outlet_id = ? AND ks.is_active = 1`,
      [outletId]
    );
    const billOnly = allBillStations.filter(s => isBillStation(s));
    logger.info(`[BILL-PRINTER] Step3: ALL kitchen_stations: ${allBillStations.length} total, ${billOnly.length} bill-related: ${JSON.stringify(billOnly.map(s => ({ id: s.id, name: s.name, type: s.station_type, ks_printerId: s.ks_printer_id, p_station_id: s.p_station_id, printerId: s.p_id, printerName: s.printer_name, ip: s.ip_address })))}`);

    if (billOnly.length > 0 && billOnly[0].p_id) {
      logger.info(`[BILL-PRINTER] Step3: Using first bill station → "${billOnly[0].name}" → printer "${billOnly[0].printer_name}" id=${billOnly[0].p_id}`);
      const [printer] = await pool.query('SELECT * FROM printers WHERE id = ?', [billOnly[0].p_id]);
      if (printer[0]) return printer[0];
    }

    // ── Step 4: Any printer with 'bill' in its station code ──
    let [printers] = await pool.query(
      `SELECT * FROM printers
       WHERE outlet_id = ? AND is_active = 1 AND (station = 'bill' OR station LIKE '%bill%')
       ORDER BY id LIMIT 1`,
      [outletId]
    );
    if (printers[0]) {
      logger.info(`[BILL-PRINTER] Step4: printer with bill station: "${printers[0].name}" id=${printers[0].id} station=${printers[0].station}`);
      return printers[0];
    }

    // ── Step 5: Last resort — any active network printer ──
    [printers] = await pool.query(
      `SELECT * FROM printers WHERE outlet_id = ? AND is_active = 1 AND ip_address IS NOT NULL ORDER BY id LIMIT 1`,
      [outletId]
    );
    logger.warn(`[BILL-PRINTER] Step5: LAST RESORT → ${printers[0] ? `"${printers[0].name}" id=${printers[0].id}` : 'NONE'}`);
    return printers[0] || null;
  },

  /**
   * Print bill to thermal printer — shared by generateBill + existing invoice reprint
   * Creates a print job in the queue for the bridge agent to pick up
   */
  async printBillToThermal(invoice, order, userId) {
    const pool = getPool();

    // Get outlet info for bill header (including logo settings)
    const [outletInfo] = await pool.query(
      `SELECT name, CONCAT_WS(', ', NULLIF(address_line1,''), NULLIF(city,''), NULLIF(state,'')) as address, 
              gstin, phone, logo_url, print_logo_url, print_logo_enabled
       FROM outlets WHERE id = ?`,
      [invoice.outletId || order.outlet_id]
    );
    const outletData = outletInfo[0] || {};
    
    // Determine logo URL for printing (only if print_logo_enabled is true)
    let printLogoUrl = null;
    if (outletData.print_logo_enabled) {
      // Prefer print_logo_url, fallback to logo_url
      printLogoUrl = outletData.print_logo_url || outletData.logo_url || null;
    }
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
      outletLogoUrl: printLogoUrl,
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
      items: this._consolidateItems((invoice.items || []).filter(i => i.status !== 'cancelled').map(item => {
        // Compute total tax rate from item's tax details for bill print
        let taxRate = 0;
        const itemTaxDetails = item.taxDetails || item.tax_details;
        if (itemTaxDetails) {
          const details = typeof itemTaxDetails === 'string' ? JSON.parse(itemTaxDetails) : itemTaxDetails;
          if (Array.isArray(details)) {
            taxRate = details.reduce((sum, t) => sum + (parseFloat(t.rate) || 0), 0);
          }
        }
        return {
          itemName: item.name || item.item_name || item.itemName,
          variantName: item.variantName || item.variant_name || null,
          quantity: parseInt(item.quantity) || 0,
          unitPrice: parseFloat(item.unitPrice || item.unit_price || 0),
          totalPrice: parseFloat(item.totalPrice || item.total_price || 0),
          isNC: !!(item.isNC || item.is_nc),
          ncAmount: parseFloat(item.ncAmount || item.nc_amount || 0),
          taxRate
        };
      })),
      subtotal: parseFloat(invoice.subtotal || 0).toFixed(2),
      taxes: Object.values(invoice.taxBreakup || {}).map(t => ({
        name: t.name || 'Tax',
        rate: t.rate || 0,
        amount: parseFloat(t.taxAmount || 0).toFixed(2)
      })),
      serviceCharge: parseFloat(invoice.serviceCharge || 0) > 0 ? parseFloat(invoice.serviceCharge).toFixed(2) : null,
      discount: parseFloat(invoice.discountAmount || 0) > 0 ? parseFloat(invoice.discountAmount).toFixed(2) : null,
      discounts: (invoice.discounts || []).map(d => ({
        name: d.discountName || 'Discount',
        type: d.discountType || 'flat',
        value: parseFloat(d.discountValue) || 0,
        amount: parseFloat(d.discountAmount) || 0
      })),
      roundOff: invoice.roundOff !== undefined ? parseFloat(invoice.roundOff).toFixed(2) : null,
      grandTotal: parseFloat(invoice.grandTotal || 0).toFixed(2),
      // NC (No Charge) fields for print
      isNC: !!(invoice.isNC || invoice.is_nc),
      ncAmount: parseFloat(invoice.ncAmount || invoice.nc_amount || 0),
      paidAmount: parseFloat(invoice.paidAmount || 0).toFixed(2),
      dueAmount: parseFloat(invoice.dueAmount || 0).toFixed(2),
      paymentMode: invoice.payments?.[0]?.paymentMode || null,
      splitBreakdown: invoice.payments?.[0]?.splitBreakdown || null,
      isDuplicate: invoice.isDuplicate || false,
      duplicateNumber: invoice.duplicateNumber || null,
      openDrawer: false
    };

    // Get floor ID and user ID for printer routing
    const floorId = invoice.floorId || order.floor_id || null;
    const cashierUserId = userId || invoice.generatedBy || order.created_by || null;
    logger.info(`[BILL-PRINT] printBillToThermal: invoice=${invoice.invoiceNumber}, floorId=${floorId}, userId=${userId}, cashierUserId=${cashierUserId}`);
    
    const printer = await this.getBillPrinter(billPrintData.outletId, floorId, cashierUserId);
    logger.info(`[BILL-PRINT] Resolved printer: ${printer ? `"${printer.name}" id=${printer.id} ip=${printer.ip_address}:${printer.port} station=${printer.station}` : 'NULL (will use fallback)'}`);
    
    // All printing goes through the bridge queue — no direct TCP printing
    await printerService.printBill(billPrintData, userId, printer || null);
    logger.info(`[BILL-PRINT] Job created for ${invoice.invoiceNumber} → printer_id=${printer?.id || 'auto'}`);
  },

  /**
   * Consolidate same items into single lines (e.g., 4x Chilli Fish Dry → 1 line qty 4)
   * Groups by itemName + variantName + unitPrice + isNC + taxRate
   */
  _consolidateItems(items) {
    const map = new Map();
    for (const item of items) {
      const key = `${item.itemName}|${item.variantName || ''}|${item.unitPrice}|${item.isNC}|${item.taxRate || 0}`;
      if (map.has(key)) {
        const existing = map.get(key);
        existing.quantity += item.quantity;
        existing.totalPrice += item.totalPrice;
        existing.ncAmount += item.ncAmount;
      } else {
        map.set(key, { ...item });
      }
    }
    return Array.from(map.values()).map(item => ({
      ...item,
      unitPrice: parseFloat(item.unitPrice).toFixed(2),
      totalPrice: parseFloat(item.totalPrice).toFixed(2)
    }));
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
      // Also fetch floor_id early so we can parallelize the cashier lookup
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

      // Early status check — avoid transaction overhead for already-paid orders
      if (order.status === 'paid' || order.status === 'completed') {
        throw new Error('Order already paid');
      }

      // Resolve floor cashier — needed for bill printer routing in ALL paths
      // (including existing invoice reprint and new bill generation)
      let floorCashierId = null;
      if (order.floor_id) {
        const [floorShift] = await pool.query(
          `SELECT ds.cashier_id FROM day_sessions ds
           WHERE ds.outlet_id = ? AND ds.floor_id = ? AND ds.status = 'open'
           ORDER BY ds.id DESC LIMIT 1`,
          [order.outlet_id, order.floor_id]
        );
        if (floorShift[0]?.cashier_id) {
          floorCashierId = floorShift[0].cashier_id;
        }
      }

      await connection.beginTransaction();

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
        
        // Check if order amounts changed (discount added/changed, items modified)
        const currentSubtotal = parseFloat(ei.subtotal) || 0;
        const currentDiscount = parseFloat(ei.discount_amount) || 0;
        const orderSubtotal = parseFloat(order.subtotal) || 0;
        const orderDiscount = parseFloat(order.discount_amount) || 0;
        const amountsChanged = (
          Math.abs(currentSubtotal - orderSubtotal) > 0.01 ||
          Math.abs(currentDiscount - orderDiscount) > 0.01
        );
        
        // Check for tax amount consistency (vatAmount should equal totalTax when only VAT applies)
        // This catches cases where invoice was partially updated
        const storedVat = parseFloat(ei.vat_amount) || 0;
        const storedCgst = parseFloat(ei.cgst_amount) || 0;
        const storedSgst = parseFloat(ei.sgst_amount) || 0;
        const storedIgst = parseFloat(ei.igst_amount) || 0;
        const storedCess = parseFloat(ei.cess_amount) || 0;
        const storedTotalTax = parseFloat(ei.total_tax) || 0;
        const calculatedTaxSum = storedCgst + storedSgst + storedIgst + storedVat + storedCess;
        const taxInconsistent = Math.abs(calculatedTaxSum - storedTotalTax) > 0.01;
        
        // Check if NC status changed on items (need to recalculate bill)
        const currentInvoiceNC = parseFloat(ei.nc_amount) || 0;
        const orderNCAmount = parseFloat(order.nc_amount) || 0;
        // Also check individual items for NC changes
        let itemsNCAmount = 0;
        for (const item of order.items || []) {
          if (item.status !== 'cancelled' && (item.is_nc || item.isNc || item.isNC)) {
            itemsNCAmount += parseFloat(item.total_price || item.totalPrice) || 0;
          }
        }
        const ncChanged = Math.abs(currentInvoiceNC - itemsNCAmount) > 0.01 || 
                          Math.abs(currentInvoiceNC - orderNCAmount) > 0.01;
        
        // Recalculate if service charge, interstate, customer, amounts, tax inconsistency, or NC changed
        const needsUpdate = (currentSC > 0 && !applyServiceCharge) || 
                           (currentSC === 0 && applyServiceCharge) ||
                           (isInterstate !== currentIsInterstate) ||
                           customerChanged ||
                           amountsChanged ||
                           taxInconsistent ||
                           ncChanged;

        if (needsUpdate) {
          const billDetails = await this.calculateBillDetails(order, { applyServiceCharge, isInterstate });
          await pool.query(
            `UPDATE invoices SET
              customer_id = ?, customer_name = ?, customer_phone = ?,
              customer_gstin = ?, customer_company_name = ?,
              customer_gst_state = ?, customer_gst_state_code = ?,
              is_interstate = ?,
              subtotal = ?, discount_amount = ?, taxable_amount = ?,
              cgst_amount = ?, sgst_amount = ?, igst_amount = ?, vat_amount = ?, cess_amount = ?, total_tax = ?,
              service_charge = ?, grand_total = ?, round_off = ?,
              is_nc = ?, nc_amount = ?, nc_tax_amount = 0, payable_amount = ?,
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
              billDetails.subtotal, billDetails.discountAmount, billDetails.taxableAmount,
              billDetails.cgstAmount, billDetails.sgstAmount, billDetails.igstAmount, 
              billDetails.vatAmount, billDetails.cessAmount, billDetails.totalTax,
              billDetails.serviceCharge, billDetails.grandTotal, billDetails.roundOff,
              billDetails.isNC ? 1 : 0, 
              billDetails.ncAmount || 0,
              billDetails.grandTotal,
              this.numberToWords(billDetails.grandTotal),
              JSON.stringify(billDetails.taxBreakup), JSON.stringify(billDetails.hsnSummary),
              ei.id
            ]
          );
        }

        const existingInv = await this.getInvoiceById(ei.id, order);
        // Non-blocking print for existing invoice (skip if skipPrint is true)
        // Use floorCashierId for correct printer routing (generatedBy may be captain)
        if (!data.skipPrint) {
          this.printBillToThermal(existingInv, order, floorCashierId || data.generatedBy).catch(printErr => {
            logger.error(`Reprint existing invoice ${existingInv?.invoiceNumber} failed:`, printErr.message);
          });
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

      // Calculate totals and check for reusable cancelled invoice in parallel
      const [billDetails, cancelledInvRes] = await Promise.all([
        this.calculateBillDetails(order, { applyServiceCharge, isInterstate }),
        connection.query(
          'SELECT id, invoice_number FROM invoices WHERE order_id = ? AND is_cancelled = 1 ORDER BY id ASC LIMIT 1',
          [orderId]
        )
      ]);
      const [cancelledInv] = cancelledInvRes;
      const today = new Date();
      let invoiceId;
      let invoiceNumber;

      if (cancelledInv[0]) {
        // Revive cancelled invoice: UPDATE existing row to preserve bill number
        invoiceId = cancelledInv[0].id;
        invoiceNumber = cancelledInv[0].invoice_number;
        await connection.query(
          `UPDATE invoices SET
            uuid = ?, invoice_date = ?, invoice_time = ?,
            customer_id = ?, customer_name = ?, customer_phone = ?, customer_email = ?,
            customer_gstin = ?, customer_address = ?, billing_address = ?,
            is_interstate = ?, customer_company_name = ?, customer_gst_state = ?, customer_gst_state_code = ?,
            subtotal = ?, discount_amount = ?, taxable_amount = ?,
            cgst_amount = ?, sgst_amount = ?, igst_amount = ?, vat_amount = ?, cess_amount = ?, total_tax = ?,
            service_charge = ?, packaging_charge = ?, delivery_charge = ?, round_off = ?, grand_total = ?,
            is_nc = ?, nc_amount = ?, nc_tax_amount = 0, payable_amount = ?,
            amount_in_words = ?, payment_status = 'pending', tax_breakup = ?, hsn_summary = ?,
            notes = ?, terms_conditions = ?, generated_by = ?,
            is_cancelled = 0, cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL
           WHERE id = ?`,
          [
            uuidv4(),
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
            billDetails.isNC ? 1 : 0, billDetails.ncAmount || 0, billDetails.grandTotal,
            this.numberToWords(billDetails.grandTotal),
            JSON.stringify(billDetails.taxBreakup),
            JSON.stringify(billDetails.hsnSummary),
            notes, termsConditions, generatedBy,
            invoiceId
          ]
        );
      } else {
        // No prior invoice — create new one
        invoiceNumber = await this.generateInvoiceNumber(order.outlet_id, connection);
        const uuid = uuidv4();
        const [result] = await connection.query(
          `INSERT INTO invoices (
            uuid, outlet_id, order_id, invoice_number, invoice_date, invoice_time,
            customer_id, customer_name, customer_phone, customer_email,
            customer_gstin, customer_address, billing_address,
            is_interstate, customer_company_name, customer_gst_state, customer_gst_state_code,
            subtotal, discount_amount, taxable_amount,
            cgst_amount, sgst_amount, igst_amount, vat_amount, cess_amount, total_tax,
            service_charge, packaging_charge, delivery_charge, round_off, grand_total,
            is_nc, nc_amount, nc_tax_amount, payable_amount,
            amount_in_words, payment_status, tax_breakup, hsn_summary,
            notes, terms_conditions, generated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
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
            billDetails.isNC ? 1 : 0, billDetails.ncAmount || 0, 0, billDetails.grandTotal,
            this.numberToWords(billDetails.grandTotal),
            JSON.stringify(billDetails.taxBreakup),
            JSON.stringify(billDetails.hsnSummary),
            notes, termsConditions, generatedBy
          ]
        );
        invoiceId = result.insertId;
      }

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
      let invoice = await this.getInvoiceById(invoiceId, order);
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

      // Emit events non-blocking (don't await - fire and forget)
      const emitPromises = [];
      
      // Emit table status update to 'billing' for real-time floor view
      if (order.table_id && order.order_type === 'dine_in') {
        emitPromises.push(publishMessage('table:update', {
          outletId: order.outlet_id,
          tableId: order.table_id,
          floorId: order.floor_id,
          status: 'billing',
          event: 'bill_generated',
          timestamp: new Date().toISOString()
        }));
      }

      // Emit order update event
      emitPromises.push(publishMessage('order:update', {
        type: 'order:billed',
        outletId: order.outlet_id,
        orderId,
        tableId: order.table_id,
        captainId: order.created_by,
        invoice,
        timestamp: new Date().toISOString()
      }));
      
      // Fire all events in parallel, don't block response
      Promise.all(emitPromises).catch(err => logger.error('Bill event emit error:', err.message));

      // Emit bill status event for Captain real-time tracking (non-blocking)
      // Include floorId, orderType, and cashierId for proper routing (including takeaway)
      publishMessage('bill:status', {
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
      }).catch(err => logger.error('Bill status emit error:', err.message));

      // Print bill to thermal printer (non-blocking - don't wait for print)
      // Skip if skipPrint is true (user will print via /invoice/:id/print endpoint)
      // Use floorCashierId for correct printer routing (generatedBy may be captain, not cashier)
      if (!data.skipPrint) {
        this.printBillToThermal(invoice, order, floorCashierId || generatedBy).catch(printError => {
          logger.error(`Bill print failed for ${invoiceNumber}:`, printError.message);
        });
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
   * Tax is calculated AFTER discount is applied (GST/VAT compliance)
   * @param {Object} order - Order object with items
   * @param {Object} options - { applyServiceCharge, isInterstate }
   */
  async calculateBillDetails(order, options = {}) {
    const pool = getPool();
    const { applyServiceCharge = false } = options;
    
    // Check if interstate from order or options
    const isInterstate = options.isInterstate || order.is_interstate || false;

    let subtotal = 0;
    const taxBreakup = {};
    const hsnSummary = {};

    // Track NC amounts
    let ncAmount = 0;

    // Track items with their tax rates for recalculation after discount
    const itemsWithTax = [];

    // Process each item - collect subtotal and tax rates
    for (const item of order.items) {
      if (item.status === 'cancelled') continue;

      // Handle both snake_case (raw DB) and camelCase (formatted) item structures
      const itemTotal = parseFloat(item.total_price || item.totalPrice) || 0;
      const itemIsNC = item.is_nc || item.isNc || item.isNC || false;
      
      // NC items: track amount separately, do NOT add to subtotal
      if (itemIsNC) {
        ncAmount += itemTotal;
        continue;
      }

      // Add to subtotal (only non-NC items)
      subtotal += itemTotal;

      // Extract tax rates from item for recalculation after discount
      const itemTaxDetails = item.tax_details || item.taxDetails;
      if (itemTaxDetails) {
        const taxDetails = typeof itemTaxDetails === 'string' 
          ? JSON.parse(itemTaxDetails) 
          : itemTaxDetails;

        if (Array.isArray(taxDetails) && taxDetails.length > 0) {
          itemsWithTax.push({
            amount: itemTotal,
            taxDetails: taxDetails
          });
        }
      }
    }

    // Recalculate discount amount based on current subtotal (after NC exclusion)
    // This ensures percentage discounts are correctly calculated on the new subtotal
    let discountAmount = 0;
    if (order.discounts && Array.isArray(order.discounts)) {
      for (const discount of order.discounts) {
        const discountType = discount.discount_type || discount.discountType;
        const discountValue = parseFloat(discount.discount_value || discount.discountValue) || 0;
        const appliedOn = discount.applied_on || discount.appliedOn || 'subtotal';
        
        if (discountType === 'percentage') {
          if (appliedOn === 'item') {
            // Item-level discount - use stored amount (item price doesn't change)
            discountAmount += parseFloat(discount.discount_amount || discount.discountAmount) || 0;
          } else {
            // Subtotal-level percentage discount - recalculate on current subtotal
            discountAmount += (subtotal * discountValue) / 100;
          }
        } else {
          // Flat discount
          discountAmount += parseFloat(discount.discount_amount || discount.discountAmount) || 0;
        }
      }
    } else {
      // Fallback to order.discount_amount if discounts array not available
      discountAmount = parseFloat(order.discount_amount) || 0;
    }
    
    // Cap discount to not exceed subtotal
    discountAmount = Math.min(discountAmount, subtotal);
    discountAmount = parseFloat(discountAmount.toFixed(2));
    
    // Taxable amount = subtotal - discount (tax is calculated on this)
    const taxableAmount = Math.max(0, subtotal - discountAmount);

    // Calculate discount ratio for proportional distribution
    const discountRatio = subtotal > 0 ? (taxableAmount / subtotal) : 1;

    // Now calculate tax on the TAXABLE AMOUNT (after discount)
    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;
    let vatAmount = 0;
    let cessAmount = 0;

    // Process each item's tax, applying discount ratio to get correct taxable base
    for (const itemData of itemsWithTax) {
      const itemTaxableAmount = itemData.amount * discountRatio;

      if (isInterstate) {
        // For interstate: combine CGST+SGST into IGST
        let totalGstRate = 0;
        for (const tax of itemData.taxDetails) {
          const codeUpper = (tax.componentCode || tax.code || '').toUpperCase();
          if (codeUpper.includes('CGST') || codeUpper.includes('SGST') || codeUpper.includes('IGST')) {
            totalGstRate += parseFloat(tax.rate) || 0;
          } else {
            // VAT, CESS etc - calculate on discounted amount
            const taxCode = tax.componentCode || tax.code || tax.componentName || tax.name || 'TAX';
            const taxName = tax.componentName || tax.name || taxCode;
            const rate = parseFloat(tax.rate) || 0;
            const taxAmt = (itemTaxableAmount * rate) / 100;
            
            const breakupKey = taxCode + '@' + rate;
            if (!taxBreakup[breakupKey]) {
              taxBreakup[breakupKey] = { name: taxName, rate: rate, taxableAmount: 0, taxAmount: 0 };
            }
            taxBreakup[breakupKey].taxableAmount += itemTaxableAmount;
            taxBreakup[breakupKey].taxAmount += taxAmt;
            
            const cUpper = taxCode.toUpperCase();
            if (cUpper.includes('VAT')) vatAmount += taxAmt;
            else if (cUpper.includes('CESS')) cessAmount += taxAmt;
          }
        }
        // Add combined IGST calculated on discounted amount
        if (totalGstRate > 0) {
          const igstAmt = (itemTaxableAmount * totalGstRate) / 100;
          const igstKey = 'IGST@' + totalGstRate;
          if (!taxBreakup[igstKey]) {
            taxBreakup[igstKey] = { name: 'IGST', rate: totalGstRate, taxableAmount: 0, taxAmount: 0 };
          }
          taxBreakup[igstKey].taxableAmount += itemTaxableAmount;
          taxBreakup[igstKey].taxAmount += igstAmt;
          igstAmount += igstAmt;
        }
      } else {
        // Normal intrastate: CGST + SGST - calculate on discounted amount
        for (const tax of itemData.taxDetails) {
          const taxCode = tax.componentCode || tax.code || tax.componentName || tax.name || 'TAX';
          const taxName = tax.componentName || tax.name || taxCode;
          const rate = parseFloat(tax.rate) || 0;
          // Calculate tax on the discounted item amount
          const taxAmt = (itemTaxableAmount * rate) / 100;

          const breakupKey = taxCode + '@' + rate;
          if (!taxBreakup[breakupKey]) {
            taxBreakup[breakupKey] = {
              name: taxName,
              rate: rate,
              taxableAmount: 0,
              taxAmount: 0
            };
          }
          taxBreakup[breakupKey].taxableAmount += itemTaxableAmount;
          taxBreakup[breakupKey].taxAmount += taxAmt;

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

    // Round tax amounts
    cgstAmount = parseFloat(cgstAmount.toFixed(2));
    sgstAmount = parseFloat(sgstAmount.toFixed(2));
    igstAmount = parseFloat(igstAmount.toFixed(2));
    vatAmount = parseFloat(vatAmount.toFixed(2));
    cessAmount = parseFloat(cessAmount.toFixed(2));

    // Round taxBreakup amounts
    for (const key of Object.keys(taxBreakup)) {
      taxBreakup[key].taxableAmount = parseFloat(taxBreakup[key].taxableAmount.toFixed(2));
      taxBreakup[key].taxAmount = parseFloat(taxBreakup[key].taxAmount.toFixed(2));
    }

    // totalTax: sum of individual tax amounts
    let totalTax = cgstAmount + sgstAmount + igstAmount + vatAmount + cessAmount;

    // Service charge (applied on taxable amount after discount)
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

    // grandTotal = taxableAmount (after discount) + tax (on taxable amount) + charges
    const preRoundTotal = taxableAmount + totalTax + serviceCharge + packagingCharge + deliveryCharge;
    const grandTotal = Math.max(0, Math.round(preRoundTotal));
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
      isNC: ncAmount > 0,
      ncAmount: parseFloat(ncAmount.toFixed(2)),
      taxBreakup,
      hsnSummary
    };
  },

  // ========================
  // INVOICE RETRIEVAL
  // ========================

  async getInvoiceById(id, preloadedOrder = null) {
    const pool = getPool();

    // Run invoice query and payments query in parallel
    const [invoiceResult, paymentsResult] = await Promise.all([
      pool.query(
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
      ),
      pool.query(
        'SELECT * FROM payments WHERE invoice_id = ?',
        [id]
      )
    ]);

    const [rows] = invoiceResult;
    if (!rows[0]) return null;

    const invoice = rows[0];
    const [payments] = paymentsResult;

    // Use preloaded order if available, otherwise fetch (avoids double getOrderWithItems in generateBill)
    const order = preloadedOrder || await orderService.getOrderWithItems(invoice.order_id);
    invoice.items = (order.items || []).filter(item => item.status !== 'cancelled');
    invoice.discounts = order.discounts;

    // Batch-fetch split payment breakdowns (avoids N+1)
    const splitPaymentIds = payments.filter(p => p.payment_mode === 'split').map(p => p.id);
    if (splitPaymentIds.length > 0) {
      const [allSplits] = await pool.query(
        'SELECT * FROM split_payments WHERE payment_id IN (?)',
        [splitPaymentIds]
      );
      const splitMap = {};
      for (const sp of allSplits) {
        if (!splitMap[sp.payment_id]) splitMap[sp.payment_id] = [];
        splitMap[sp.payment_id].push({
          paymentMode: sp.payment_mode,
          amount: parseFloat(sp.amount) || 0,
          reference: sp.reference_number
        });
      }
      for (const payment of payments) {
        if (payment.payment_mode === 'split') {
          payment.splitBreakdown = splitMap[payment.id] || [];
        }
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
      `SELECT name, CONCAT_WS(', ', NULLIF(address_line1,''), NULLIF(address_line2,''), NULLIF(city,''), NULLIF(state,''), NULLIF(postal_code,'')) as address,
        phone, email, gstin, logo_url, print_logo_url, print_logo_enabled
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
    // Map logo_url to logoUrl for invoice-pdf.js — prefer print_logo_url if enabled
    const logoUrl = outletData.print_logo_enabled
      ? (outletData.print_logo_url || outletData.logo_url)
      : outletData.logo_url;
    const outlet = {
      ...outletData,
      logoUrl
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

    // Print invoice (non-blocking - don't wait for print)
    this.printBillToThermal(invoice, { outlet_id: invoice.outletId, floor_id: invoice.floorId }, userId).catch(printError => {
      logger.error(`Invoice print failed for ${invoice.invoiceNumber}:`, printError.message);
    });
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

    // Print duplicate bill (non-blocking - don't wait for print)
    this.printBillToThermal(invoice, { outlet_id: invoice.outletId, floor_id: invoice.floorId }, userId).catch(printError => {
      logger.error(`Duplicate bill #${duplicateNumber} print failed for ${invoice.invoiceNumber}:`, printError.message);
    });

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
    const { floorId, search, sortBy = 'created_at', sortOrder = 'desc', status = 'pending', fromDate, toDate } = filters;
    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit) || 20));
    const offset = (page - 1) * limit;

    // Determine if user is a captain (not admin/manager/cashier/super_admin)
    const privilegedRoles = ['admin', 'manager', 'super_admin', 'cashier'];
    const userRoles = user.roles || [];
    const isCaptain = !userRoles.some(r => privilegedRoles.includes(r));

    let whereClause = `WHERE i.outlet_id = ? AND i.is_cancelled = 0`;
    const params = [outletId];

    // Date range filter (business hours: 4am to 4am)
    if (fromDate && toDate && fromDate.length === 10 && toDate.length === 10) {
      // Both dates provided as YYYY-MM-DD - use business day range
      const { startDt, endDt } = businessDayRange(fromDate, toDate);
      whereClause += ` AND i.created_at >= ? AND i.created_at < ?`;
      params.push(startDt, endDt);
    } else if (fromDate) {
      if (fromDate.length === 10) {
        // Date-only: from 4am on that day
        const { startDt } = businessDayRange(fromDate, fromDate);
        whereClause += ` AND i.created_at >= ?`;
        params.push(startDt);
      } else {
        // Full datetime provided - use as-is
        whereClause += ` AND i.created_at >= ?`;
        params.push(fromDate);
      }
    } else if (toDate) {
      if (toDate.length === 10) {
        // Date-only: up to 4am the next day
        const { endDt } = businessDayRange(toDate, toDate);
        whereClause += ` AND i.created_at < ?`;
        params.push(endDt);
      } else {
        // Full datetime provided - use as-is
        whereClause += ` AND i.created_at <= ?`;
        params.push(toDate);
      }
    }

    // Captain sees only their own orders' bills
    if (isCaptain && user.userId) {
      whereClause += ` AND o.created_by = ?`;
      params.push(user.userId);
    }

    // Status filter: pending (default), completed, partial/due, or all
    if (status === 'completed') {
      whereClause += ` AND i.payment_status = 'paid'`;
    } else if (status === 'partial' || status === 'due') {
      // Show only partial/due payment bills (order completed but has due amount)
      whereClause += ` AND i.payment_status = 'partial'`;
    } else if (status === 'all') {
      whereClause += ` AND i.payment_status IN ('pending', 'partial', 'paid')`;
    } else {
      // Default: pending bills only (exclude partial - those are completed with due)
      whereClause += ` AND i.payment_status = 'pending'`;
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

    // Open item filter - show only orders that contain open items
    if (filters.hasOpenItems === 'true' || filters.hasOpenItems === true) {
      whereClause += ` AND EXISTS (SELECT 1 FROM order_items oi_f WHERE oi_f.order_id = o.id AND oi_f.is_open_item = 1 AND oi_f.status != 'cancelled')`;
    }

    // NC item filter - show only orders that contain NC items
    if (filters.hasNcItems === 'true' || filters.hasNcItems === true) {
      whereClause += ` AND EXISTS (SELECT 1 FROM order_items oi_f WHERE oi_f.order_id = o.id AND oi_f.is_nc = 1 AND oi_f.status != 'cancelled')`;
    }

    const fromClause = `FROM invoices i
       LEFT JOIN orders o ON i.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       LEFT JOIN floors f ON o.floor_id = f.id
       LEFT JOIN users u ON i.generated_by = u.id`;

    // Sort (support both camelCase and snake_case)
    const allowedSorts = {
      created_at: 'i.created_at',
      createdAt: 'i.created_at',
      grand_total: 'i.grand_total',
      grandTotal: 'i.grand_total',
      table_number: 't.table_number',
      tableNumber: 't.table_number',
      invoice_number: 'i.invoice_number',
      invoiceNumber: 'i.invoice_number',
      order_number: 'o.order_number',
      orderNumber: 'o.order_number'
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

    // Parallel: count + data
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total ${fromClause} ${whereClause}`, params),
      pool.query(dataQuery, [...params, limit, offset])
    ]);
    const total = countResult[0][0].total;
    const totalPages = Math.ceil(total / limit);
    const rows = dataResult[0];

    // Batch-fetch items, addons, discounts, payments for ALL invoices at once (eliminates N+1)
    const orderIds = [...new Set(rows.filter(r => r.order_id).map(r => r.order_id))];
    const invoiceIds = rows.map(r => r.id);

    let itemsByOrder = {};
    let addonsByItemId = {};
    let discountsByOrder = {};
    let paymentsByInvoice = {};

    if (orderIds.length > 0 && invoiceIds.length > 0) {
      // All 5 queries in parallel — addons/splits use JOINs so they don't depend on prior results
      const [allItems, allAddons, allDiscounts, allPayments, allSplits] = await Promise.all([
        pool.query(
          `SELECT oi.*, i.short_name, i.image_url
           FROM order_items oi
           LEFT JOIN items i ON oi.item_id = i.id
           WHERE oi.order_id IN (?) AND oi.status != 'cancelled'
           ORDER BY oi.id`,
          [orderIds]
        ).then(([r]) => r),
        pool.query(
          `SELECT oia.* FROM order_item_addons oia
           INNER JOIN order_items oi ON oia.order_item_id = oi.id
           WHERE oi.order_id IN (?) AND oi.status != 'cancelled'`,
          [orderIds]
        ).then(([r]) => r),
        pool.query(
          'SELECT * FROM order_discounts WHERE order_id IN (?)',
          [orderIds]
        ).then(([r]) => r),
        pool.query(
          'SELECT * FROM payments WHERE invoice_id IN (?)',
          [invoiceIds]
        ).then(([r]) => r),
        pool.query(
          `SELECT sp.* FROM split_payments sp
           INNER JOIN payments p ON sp.payment_id = p.id
           WHERE p.invoice_id IN (?) AND p.payment_mode = 'split'`,
          [invoiceIds]
        ).then(([r]) => r)
      ]);

      // Build addon lookup
      for (const a of allAddons) {
        if (!addonsByItemId[a.order_item_id]) addonsByItemId[a.order_item_id] = [];
        addonsByItemId[a.order_item_id].push(a);
      }

      // Build split payment lookup
      const splitsByPaymentId = {};
      for (const sp of allSplits) {
        if (!splitsByPaymentId[sp.payment_id]) splitsByPaymentId[sp.payment_id] = [];
        splitsByPaymentId[sp.payment_id].push({
          paymentMode: sp.payment_mode,
          amount: parseFloat(sp.amount) || 0,
          reference: sp.reference_number
        });
      }

      // Build lookup maps
      for (const item of allItems) {
        item.addons = addonsByItemId[item.id] || [];
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }
      for (const d of allDiscounts) {
        if (!discountsByOrder[d.order_id]) discountsByOrder[d.order_id] = [];
        discountsByOrder[d.order_id].push(d);
      }
      for (const p of allPayments) {
        if (p.payment_mode === 'split') {
          p.splitBreakdown = splitsByPaymentId[p.id] || [];
        }
        if (!paymentsByInvoice[p.invoice_id]) paymentsByInvoice[p.invoice_id] = [];
        paymentsByInvoice[p.invoice_id].push(p);
      }
    }

    // Build invoices from lookup maps (pure in-memory — no more DB calls)
    const invoices = [];
    for (const row of rows) {
      row.items = itemsByOrder[row.order_id] || [];
      row.discounts = discountsByOrder[row.order_id] || [];
      row.payments = paymentsByInvoice[row.id] || [];
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

    // Status filter: pending (default), completed, partial/due, or all
    if (status === 'completed') {
      whereClause += ` AND i.payment_status = 'paid'`;
    } else if (status === 'partial' || status === 'due') {
      whereClause += ` AND i.payment_status = 'partial'`;
    } else if (status === 'all') {
      whereClause += ` AND i.payment_status IN ('pending', 'partial', 'paid')`;
    } else {
      // Default: pending bills only (exclude partial - those are completed with due)
      whereClause += ` AND i.payment_status = 'pending'`;
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

    // Sort
    const allowedSorts = {
      created_at: 'i.created_at',
      grand_total: 'i.grand_total',
      table_number: 't.table_number'
    };
    const sortCol = allowedSorts[sortBy] || 'i.created_at';
    const order = sortOrder?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Parallel: count + data
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total ${fromClause} ${whereClause}`, params),
      pool.query(
        `SELECT i.*, o.order_number, o.order_type, o.table_id, o.floor_id,
          t.table_number, t.name as table_name,
          f.name as floor_name
         ${fromClause} ${whereClause}
         ORDER BY ${sortCol} ${order}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      )
    ]);
    const total = countResult[0][0].total;
    const totalPages = Math.ceil(total / limit);
    const rows = dataResult[0];

    // Batch-fetch items, addons, discounts, payments for ALL invoices (eliminates N+1)
    const orderIds = [...new Set(rows.filter(r => r.order_id).map(r => r.order_id))];
    const invoiceIds = rows.map(r => r.id);

    let itemsByOrder = {};
    let addonsByItemId = {};
    let discountsByOrder = {};
    let paymentsByInvoice = {};

    if (orderIds.length > 0 && invoiceIds.length > 0) {
      const [allItems, allAddons, allDiscounts, allPayments, allSplits] = await Promise.all([
        pool.query(
          `SELECT oi.*, i.short_name, i.image_url
           FROM order_items oi
           LEFT JOIN items i ON oi.item_id = i.id
           WHERE oi.order_id IN (?) AND oi.status != 'cancelled'
           ORDER BY oi.id`,
          [orderIds]
        ).then(([r]) => r),
        pool.query(
          `SELECT oia.* FROM order_item_addons oia
           INNER JOIN order_items oi ON oia.order_item_id = oi.id
           WHERE oi.order_id IN (?) AND oi.status != 'cancelled'`,
          [orderIds]
        ).then(([r]) => r),
        pool.query(
          'SELECT * FROM order_discounts WHERE order_id IN (?)',
          [orderIds]
        ).then(([r]) => r),
        pool.query(
          'SELECT * FROM payments WHERE invoice_id IN (?)',
          [invoiceIds]
        ).then(([r]) => r),
        pool.query(
          `SELECT sp.* FROM split_payments sp
           INNER JOIN payments p ON sp.payment_id = p.id
           WHERE p.invoice_id IN (?) AND p.payment_mode = 'split'`,
          [invoiceIds]
        ).then(([r]) => r)
      ]);

      for (const a of allAddons) {
        if (!addonsByItemId[a.order_item_id]) addonsByItemId[a.order_item_id] = [];
        addonsByItemId[a.order_item_id].push(a);
      }
      const splitsByPaymentId = {};
      for (const sp of allSplits) {
        if (!splitsByPaymentId[sp.payment_id]) splitsByPaymentId[sp.payment_id] = [];
        splitsByPaymentId[sp.payment_id].push({
          paymentMode: sp.payment_mode,
          amount: parseFloat(sp.amount) || 0,
          reference: sp.reference_number
        });
      }
      for (const item of allItems) {
        item.addons = addonsByItemId[item.id] || [];
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }
      for (const d of allDiscounts) {
        if (!discountsByOrder[d.order_id]) discountsByOrder[d.order_id] = [];
        discountsByOrder[d.order_id].push(d);
      }
      for (const p of allPayments) {
        if (p.payment_mode === 'split') {
          p.splitBreakdown = splitsByPaymentId[p.id] || [];
        }
        if (!paymentsByInvoice[p.invoice_id]) paymentsByInvoice[p.invoice_id] = [];
        paymentsByInvoice[p.invoice_id].push(p);
      }
    }

    // Build invoices from lookup maps (pure in-memory — no more DB calls)
    const invoices = [];
    for (const row of rows) {
      row.items = itemsByOrder[row.order_id] || [];
      row.discounts = discountsByOrder[row.order_id] || [];
      row.payments = paymentsByInvoice[row.id] || [];
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

    // Fetch updated order ONCE — reuse for invoice recalc AND return value
    const updatedOrder = await orderService.getOrderWithItems(orderId);

    // If invoice exists, recalculate it (pass order to avoid redundant DB fetch)
    await this.recalculateInvoiceAfterDiscount(orderId, updatedOrder);

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

    // Lightweight validation — only need order_number + subtotal, no heavy JOINs
    const [[order]] = await pool.query(
      'SELECT id, order_number, subtotal FROM orders WHERE id = ?',
      [orderId]
    );
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

    // Fetch updated order ONCE — reuse for invoice recalc AND return value
    const updatedOrder = await orderService.getOrderWithItems(orderId);

    // If invoice exists, recalculate it (pass order to avoid redundant DB fetch)
    await this.recalculateInvoiceAfterDiscount(orderId, updatedOrder);

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

    // Fetch updated order ONCE — reuse for invoice recalc AND return value
    const updatedOrder = await orderService.getOrderWithItems(orderId);

    // If invoice exists, recalculate it (pass order to avoid redundant DB fetch)
    await this.recalculateInvoiceAfterDiscount(orderId, updatedOrder);

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
   * @param {number} orderId
   * @param {object} [preloadedOrder] - Pass pre-fetched order to avoid redundant DB call
   */
  async recalculateInvoiceAfterDiscount(orderId, preloadedOrder = null) {
    const pool = getPool();

    const [invoices] = await pool.query(
      'SELECT id FROM invoices WHERE order_id = ? AND is_cancelled = 0',
      [orderId]
    );

    if (!invoices[0]) return; // No invoice yet — nothing to recalculate

    const order = preloadedOrder || await orderService.getOrderWithItems(orderId);
    if (!order) return;

    const billDetails = await this.calculateBillDetails(order, { applyServiceCharge: false });

    await pool.query(
      `UPDATE invoices SET
        subtotal = ?, discount_amount = ?, taxable_amount = ?,
        cgst_amount = ?, sgst_amount = ?, igst_amount = ?,
        vat_amount = ?, cess_amount = ?,
        total_tax = ?, service_charge = ?,
        grand_total = ?, round_off = ?,
        amount_in_words = ?, tax_breakup = ?, hsn_summary = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        billDetails.subtotal, billDetails.discountAmount, billDetails.taxableAmount,
        billDetails.cgstAmount, billDetails.sgstAmount, billDetails.igstAmount,
        billDetails.vatAmount, billDetails.cessAmount,
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
