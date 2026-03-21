/**
 * Invoice PDF Generator
 * Generates professional invoice PDFs using pdfkit
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const DEFAULT_LOGO_PATH = path.resolve(__dirname, '../../public/Whatsapp.bmp');

/**
 * Fetch image from URL and return as buffer (uses built-in fetch)
 */
async function fetchImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function resolveLogoCandidates(outlet = {}) {
  const sources = [outlet.logoUrl, outlet.logo].filter((s) => typeof s === 'string' && s.trim());
  const cleaned = sources.map((s) => s.trim());
  if (fs.existsSync(DEFAULT_LOGO_PATH)) {
    cleaned.push(DEFAULT_LOGO_PATH);
  }
  return Array.from(new Set(cleaned));
}

function resolveLocalLogoPath(source) {
  if (!source || typeof source !== 'string') return null;
  if (fs.existsSync(source)) return source;

  const relativeToCwd = path.resolve(process.cwd(), source.replace(/^\/+/, ''));
  if (fs.existsSync(relativeToCwd)) return relativeToCwd;

  if (source.startsWith('/')) {
    const relativeToPublic = path.resolve(process.cwd(), 'public', source.replace(/^\/+/, ''));
    if (fs.existsSync(relativeToPublic)) return relativeToPublic;
  }

  return null;
}

/**
 * Generate invoice PDF and return as a readable stream
 * @param {object} invoice - Formatted invoice object from billingService.getInvoiceById
 * @param {object} outlet - Outlet info { name, address, phone, email, gstin, logo, logoUrl }
 * @returns {PDFDocument} - PDF stream (pipe to res or file)
 */
async function generateInvoicePDF(invoice, outlet = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  const leftMargin = 40;
  const rightEdge = 555;
  const colWidth = rightEdge - leftMargin;

  // ─── HELPER FUNCTIONS ─────────────────────────
  function drawLine(y, thickness = 0.5) {
    doc.lineWidth(thickness).moveTo(leftMargin, y).lineTo(rightEdge, y).stroke('#cccccc');
  }

  function drawThickLine(y) {
    doc.lineWidth(1).moveTo(leftMargin, y).lineTo(rightEdge, y).stroke('#333333');
  }

  function rightAlign(text, y, options = {}) {
    doc.text(text, leftMargin, y, { width: colWidth, align: 'right', ...options });
  }

  function row(leftText, rightText, y, opts = {}) {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.fontSize || 9);
    doc.text(leftText, leftMargin, y);
    rightAlign(rightText, y);
  }

  function currency(amount) {
    return `Rs.${parseFloat(amount || 0).toFixed(2)}`;
  }

  // ─── HEADER ───────────────────────────────────
  let y = 40;
  let logoWidth = 0;
  const logoMaxWidth = 60;
  const logoMaxHeight = 60;

  // Try to add logo from outlet config, fallback to default public logo
  for (const logoSource of resolveLogoCandidates(outlet)) {
    try {
      let logoBuffer = null;
      if (logoSource.startsWith('http://') || logoSource.startsWith('https://')) {
        logoBuffer = await fetchImageBuffer(logoSource);
      } else {
        const resolvedPath = resolveLocalLogoPath(logoSource);
        if (resolvedPath) {
          logoBuffer = fs.readFileSync(resolvedPath);
        }
      }

      if (!logoBuffer) {
        continue;
      }

      doc.image(logoBuffer, leftMargin, y, {
        fit: [logoMaxWidth, logoMaxHeight],
        align: 'left',
        valign: 'top'
      });
      logoWidth = logoMaxWidth + 10; // Add spacing after logo
      break;
    } catch (err) {
      // Continue trying next candidate
    }
  }

  // Outlet name (positioned after logo if present)
  const textStartX = leftMargin + logoWidth;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#333333').text(outlet.name || 'Restaurant', textStartX, y);
  y += 22;

  if (outlet.address) {
    doc.font('Helvetica').fontSize(8).fillColor('#555555').text(outlet.address, textStartX, y, { width: 300 - logoWidth });
    y += doc.heightOfString(outlet.address, { width: 300 - logoWidth }) + 2;
  }
  if (outlet.phone) {
    doc.text(`Phone: ${outlet.phone}`, textStartX, y);
    y += 12;
  }
  if (outlet.email) {
    doc.text(`Email: ${outlet.email}`, textStartX, y);
    y += 12;
  }
  if (outlet.gstin) {
    doc.font('Helvetica-Bold').fontSize(8).text(`GSTIN: ${outlet.gstin}`, textStartX, y);
    y += 12;
  }
  
  // Ensure y is at least below the logo
  y = Math.max(y, 40 + logoMaxHeight + 5);

  // Invoice title — right side
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#333333');
  doc.text('TAX INVOICE', 350, 40, { width: 205, align: 'right' });

  doc.font('Helvetica').fontSize(9).fillColor('#555555');
  doc.text(`Invoice #: ${invoice.invoiceNumber}`, 350, 65, { width: 205, align: 'right' });
  doc.text(`Date: ${invoice.invoiceDate || ''}`, 350, 78, { width: 205, align: 'right' });
  doc.text(`Time: ${invoice.invoiceTime || ''}`, 350, 91, { width: 205, align: 'right' });

  y = Math.max(y, 110) + 5;
  drawThickLine(y);
  y += 8;

  // ─── ORDER & CUSTOMER INFO ────────────────────
  doc.fillColor('#333333');

  // Left column: order info
  doc.font('Helvetica-Bold').fontSize(9).text('Order Details', leftMargin, y);
  y += 14;
  doc.font('Helvetica').fontSize(8).fillColor('#555555');
  doc.text(`Order #: ${invoice.orderNumber || '-'}`, leftMargin, y);
  doc.text(`Type: ${(invoice.orderType || '-').replace('_', ' ').toUpperCase()}`, 200, y);
  y += 12;
  if (invoice.tableNumber) {
    doc.text(`Table: ${invoice.tableName || invoice.tableNumber}`, leftMargin, y);
    y += 12;
  }

  // Customer info - always show (Walk-in Customer if no name)
  y += 4;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#333333').text('Bill To', leftMargin, y);
  y += 14;
  doc.font('Helvetica').fontSize(8).fillColor('#555555');
  
  // Company name for B2B customers
  if (invoice.customerCompanyName) {
    doc.font('Helvetica-Bold').text(invoice.customerCompanyName, leftMargin, y);
    y += 12;
    doc.font('Helvetica');
  }
  // Customer name with Walk-in fallback
  const displayName = invoice.customerName || 'Walk-in Customer';
  doc.text(displayName, leftMargin, y); y += 12;
  if (invoice.customerPhone) { doc.text(`Phone: ${invoice.customerPhone}`, leftMargin, y); y += 12; }
  if (invoice.customerEmail) { doc.text(`Email: ${invoice.customerEmail}`, leftMargin, y); y += 12; }
  
  // GST details
  if (invoice.customerGstin) {
    doc.font('Helvetica-Bold').text(`GSTIN: ${invoice.customerGstin}`, leftMargin, y);
    y += 12;
    doc.font('Helvetica');
  }
  if (invoice.customerGstState) {
    doc.text(`State: ${invoice.customerGstState}${invoice.customerGstStateCode ? ` (${invoice.customerGstStateCode})` : ''}`, leftMargin, y);
    y += 12;
  }
  if (invoice.isInterstate) {
    doc.font('Helvetica-Bold').fillColor('#e74c3c').text('** INTERSTATE SUPPLY **', leftMargin, y);
    y += 12;
    doc.font('Helvetica').fillColor('#555555');
  }
  if (invoice.customerAddress) { doc.text(invoice.customerAddress, leftMargin, y, { width: 250 }); y += 12; }

  y += 5;
  drawThickLine(y);
  y += 8;

  // ─── CONSOLIDATE ITEMS ─────────────────────────
  // Merge same items (same name + variant + unitPrice) into single rows
  const rawItems = invoice.items || [];
  const itemMap = new Map();
  for (const item of rawItems) {
    const name = item.variantName ? `${item.name} (${item.variantName})` : (item.name || 'Item');
    const price = parseFloat(item.unitPrice) || 0;
    const isNC = !!(item.isNC || item.is_nc);
    const key = `${name}|${price}|${isNC}`;
    if (itemMap.has(key)) {
      const existing = itemMap.get(key);
      existing.quantity += parseInt(item.quantity) || 0;
      existing.totalPrice += parseFloat(item.totalPrice) || 0;
      existing.ncAmount += parseFloat(item.ncAmount || item.nc_amount || 0);
    } else {
      itemMap.set(key, {
        name,
        quantity: parseInt(item.quantity) || 0,
        unitPrice: price,
        totalPrice: parseFloat(item.totalPrice) || 0,
        isNC,
        ncAmount: parseFloat(item.ncAmount || item.nc_amount || 0)
      });
    }
  }
  const consolidatedItems = Array.from(itemMap.values());

  // ─── ITEMS TABLE HEADER ───────────────────────
  const colItem = leftMargin;
  const colQty = 300;
  const colRate = 370;
  const colAmount = 460;

  doc.font('Helvetica-Bold').fontSize(8).fillColor('#333333');
  doc.text('#', colItem, y, { width: 20 });
  doc.text('Item Description', colItem + 20, y, { width: 260 });
  doc.text('Qty', colQty, y, { width: 50, align: 'right' });
  doc.text('Rate', colRate, y, { width: 70, align: 'right' });
  doc.text('Amount', colAmount, y, { width: 95, align: 'right' });
  y += 14;
  drawLine(y);
  y += 6;

  // ─── ITEMS (consolidated) ─────────────────────
  doc.font('Helvetica').fontSize(8).fillColor('#444444');
  let totalQty = 0;

  consolidatedItems.forEach((item, idx) => {
    if (y > 700) {
      doc.addPage();
      y = 40;
    }

    totalQty += item.quantity;
    let displayName = item.name;
    if (item.isNC) displayName += '  [NC]';

    doc.text(`${idx + 1}`, colItem, y, { width: 20 });
    doc.text(displayName, colItem + 20, y, { width: 260 });
    doc.text(`${item.quantity}`, colQty, y, { width: 50, align: 'right' });
    doc.text(currency(item.unitPrice), colRate, y, { width: 70, align: 'right' });
    doc.text(currency(item.totalPrice), colAmount, y, { width: 95, align: 'right' });
    y += 16;
  });

  // Total quantity row
  y += 4;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#333333');
  doc.text(`Total Items: ${consolidatedItems.length}`, colItem, y, { width: 200 });
  doc.text(`Total Qty: ${totalQty}`, colQty - 50, y, { width: 100, align: 'right' });
  y += 14;

  drawThickLine(y);
  y += 10;

  // ─── TOTALS (aligned with Amount column) ─────
  // Label ends at colAmount, value spans the Amount column width
  const totalsLabelX = leftMargin;
  const totalsLabelW = colAmount - leftMargin - 5;
  const totalsValX = colAmount;
  const totalsValW = 95;

  function totalRow(label, value, opts = {}) {
    if (y > 750) { doc.addPage(); y = 40; }
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.fontSize || 9).fillColor(opts.color || '#444444');
    doc.text(label, totalsLabelX, y, { width: totalsLabelW, align: 'right' });
    doc.text(value, totalsValX, y, { width: totalsValW, align: 'right' });
    y += opts.spacing || 15;
  }

  totalRow('Subtotal:', currency(invoice.subtotal));

  // Discount — show type breakdown with value
  const discounts = invoice.discounts || [];
  if (discounts.length > 0) {
    for (const disc of discounts) {
      let discLabel = 'Discount';
      if (disc.discountType === 'percentage') {
        discLabel += ` (${disc.discountValue}%)`;
      } else if (disc.discountValue > 0) {
        discLabel += ` (Flat Rs.${parseFloat(disc.discountValue).toFixed(0)})`;
      }
      totalRow(discLabel + ':', `-${currency(disc.discountAmount)}`, { color: '#e74c3c' });
    }
  } else if (invoice.discountAmount > 0) {
    totalRow('Discount:', `-${currency(invoice.discountAmount)}`, { color: '#e74c3c' });
  }

  // NC (No Charge) amount
  const ncAmount = parseFloat(invoice.ncAmount || 0);
  if (ncAmount > 0) {
    totalRow('No Charge (NC):', `-${currency(ncAmount)}`, { bold: true, color: '#e67e22' });
  }

  totalRow('Taxable Amount:', currency(invoice.taxableAmount));

  // Taxes — use taxBreakup for detailed rates (e.g., "CGST @2.5%")
  const taxBreakup = invoice.taxBreakup || {};
  const taxEntries = Object.values(taxBreakup);
  if (taxEntries.length > 0) {
    for (const tax of taxEntries) {
      const baseName = (tax.name || 'Tax').replace(/\s*[\d.]+%?/g, '').trim().toUpperCase();
      const label = baseName + ' @' + (tax.rate || 0) + '%';
      totalRow(label + ':', currency(tax.taxAmount));
    }
  } else {
    if (invoice.cgstAmount > 0) totalRow('CGST:', currency(invoice.cgstAmount));
    if (invoice.sgstAmount > 0) totalRow('SGST:', currency(invoice.sgstAmount));
    if (invoice.igstAmount > 0) totalRow('IGST:', currency(invoice.igstAmount));
    if (invoice.vatAmount > 0) totalRow('VAT:', currency(invoice.vatAmount));
    if (invoice.cessAmount > 0) totalRow('Cess:', currency(invoice.cessAmount));
  }
  if (invoice.serviceCharge > 0) totalRow('Service Charge:', currency(invoice.serviceCharge));
  if (invoice.packagingCharge > 0) totalRow('Packaging:', currency(invoice.packagingCharge));
  if (invoice.deliveryCharge > 0) totalRow('Delivery:', currency(invoice.deliveryCharge));
  if (invoice.roundOff !== 0) totalRow('Round Off:', currency(invoice.roundOff));

  drawLine(y);
  y += 6;
  totalRow('GRAND TOTAL:', currency(invoice.grandTotal), { bold: true, fontSize: 12, color: '#000000', spacing: 20 });

  // Show paid and due amounts for partial payments
  if (invoice.dueAmount > 0) {
    totalRow('Paid Amount:', currency(invoice.paidAmount), { bold: true, color: '#27ae60' });
    totalRow('DUE AMOUNT:', currency(invoice.dueAmount), { bold: true, fontSize: 11, color: '#e74c3c', spacing: 20 });
  }

  if (invoice.amountInWords) {
    doc.font('Helvetica').fontSize(7).fillColor('#888888');
    doc.text(`(${invoice.amountInWords})`, totalsLabelX, y, { width: totalsLabelW + 5 + totalsValW, align: 'right' });
    y += 14;
  }

  // ─── PAYMENT INFO ─────────────────────────────
  const payments = invoice.payments || [];
  if (payments.length > 0) {
    y += 6;
    drawLine(y);
    y += 8;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#333333').text('Payment Details', leftMargin, y);
    y += 14;

    doc.font('Helvetica').fontSize(8).fillColor('#555555');
    payments.forEach(p => {
      // Check if this is a split payment with breakdown
      if (p.paymentMode === 'split' && p.splitBreakdown && p.splitBreakdown.length > 0) {
        doc.text('SPLIT PAYMENT', leftMargin, y, { width: 80 });
        doc.text(currency(p.totalAmount), leftMargin + 90, y, { width: 80 });
        y += 14;
        // Show each split payment component
        p.splitBreakdown.forEach(sp => {
          doc.text(`  ${(sp.paymentMode || '').toUpperCase()}`, leftMargin, y, { width: 80 });
          doc.text(currency(sp.amount), leftMargin + 90, y, { width: 80 });
          if (sp.reference) doc.text(`Ref: ${sp.reference}`, leftMargin + 180, y);
          y += 12;
        });
      } else {
        doc.text(`${(p.paymentMode || '').toUpperCase()}`, leftMargin, y, { width: 80 });
        doc.text(currency(p.totalAmount), leftMargin + 90, y, { width: 80 });
        if (p.transactionId) doc.text(`Txn: ${p.transactionId}`, leftMargin + 180, y);
        if (p.referenceNumber) doc.text(`Ref: ${p.referenceNumber}`, leftMargin + 180, y);
        y += 14;
      }
    });

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#333333');
    doc.text(`Payment Status: ${(invoice.paymentStatus || '').toUpperCase()}`, leftMargin, y);
    y += 16;
  }

  // ─── NOTES ────────────────────────────────────
  if (invoice.notes) {
    y += 4;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#333333').text('Notes:', leftMargin, y);
    y += 12;
    doc.font('Helvetica').fontSize(7).fillColor('#666666').text(invoice.notes, leftMargin, y, { width: colWidth });
    y += doc.heightOfString(invoice.notes, { width: colWidth }) + 8;
  }

  if (invoice.termsConditions) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#333333').text('Terms & Conditions:', leftMargin, y);
    y += 12;
    doc.font('Helvetica').fontSize(7).fillColor('#666666').text(invoice.termsConditions, leftMargin, y, { width: colWidth });
    y += doc.heightOfString(invoice.termsConditions, { width: colWidth }) + 8;
  }

  // ─── FOOTER ───────────────────────────────────
  y = Math.max(y + 20, 700);
  if (y > 770) { doc.addPage(); y = 700; }

  drawLine(y);
  y += 8;
  doc.font('Helvetica').fontSize(7).fillColor('#aaaaaa');
  doc.text('This is a computer generated invoice.', leftMargin, y, { width: colWidth, align: 'center' });
  y += 10;
  doc.text('Thank you for your patronage!', leftMargin, y, { width: colWidth, align: 'center' });

  doc.end();
  return doc;
}

module.exports = { generateInvoicePDF };
