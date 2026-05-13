/**
 * Subscription Invoice PDF Generator
 * Generates a professional A4 tax invoice PDF for subscription payments.
 * Returns a PDFDocument stream — pipe to res or collect into a Buffer.
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const DEFAULT_LOGO_PATH = path.resolve(__dirname, '../../public/assets/IR.png');

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

async function fetchImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch logo: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function amt(value) {
  return `Rs.${parseFloat(value || 0).toFixed(2)}`;
}

function fmtDate(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    });
  } catch {
    return String(dateStr);
  }
}

function fmtDateTime(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    return new Date(dateStr).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch {
    return String(dateStr);
  }
}

/**
 * Generate subscription tax invoice PDF.
 * @param {object} invoiceData  Result from subscriptionService.getTransactionInvoice()
 * @returns {PDFDocument}       Readable stream — pipe directly to res
 */
async function generateSubscriptionInvoicePDF(invoiceData) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  const L = 40;    // left margin
  const R = 555;   // right edge
  const W = R - L; // usable content width

  function drawLine(y, color = '#cccccc') {
    doc.save().lineWidth(0.5).moveTo(L, y).lineTo(R, y).stroke(color).restore();
  }

  function drawThickLine(y) {
    doc.save().lineWidth(1).moveTo(L, y).lineTo(R, y).stroke('#333333').restore();
  }

  const { invoice, billedTo, lineItems, taxBreakdown, totals, payment } = invoiceData;

  let y = 40;
  let logoWidth = 0;

  // ── Logo ───────────────────────────────────────────────────────────────────
  const logoSources = [DEFAULT_LOGO_PATH].filter(Boolean);
  for (const src of logoSources) {
    try {
      let buf = null;
      if (typeof src === 'string' && (src.startsWith('http://') || src.startsWith('https://'))) {
        buf = await fetchImageBuffer(src);
      } else {
        const resolved = resolveLocalLogoPath(src);
        if (resolved) buf = fs.readFileSync(resolved);
      }
      if (buf) {
        doc.image(buf, L, y, { fit: [55, 55], align: 'left', valign: 'top' });
        logoWidth = 65;
        break;
      }
    } catch (_) { /* try next */ }
  }

  // ── Header: Company (left) + Invoice title (right) ─────────────────────────
  const hx = L + logoWidth;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1a2e').text('iMakerRestro', hx, y, { width: 220 });
  y += 20;
  doc.font('Helvetica').fontSize(9).fillColor('#666666').text('Subscription Management Platform', hx, y, { width: 250 });
  y += 12;
  doc.text('support@imakerrestro.com', hx, y, { width: 250 });

  doc.font('Helvetica-Bold').fontSize(20).fillColor('#1a1a2e').text('TAX INVOICE', L, 40, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#555555');
  doc.text(`Invoice #: ${invoice.invoiceNumber}`, L, 65, { width: W, align: 'right' });
  doc.text(`Date: ${fmtDate(invoice.invoiceDate)}`, L, 78, { width: W, align: 'right' });
  if (invoice.invoiceTime) {
    doc.text(`Time: ${invoice.invoiceTime}`, L, 91, { width: W, align: 'right' });
  }

  y = Math.max(y + 20, 112);
  drawThickLine(y);
  y += 10;

  // ── Payment status badge ───────────────────────────────────────────────────
  const statusMap = {
    captured: { label: 'PAID',           fg: '#2e7d32', bg: '#e8f5e9' },
    manual:   { label: 'PAID (MANUAL)',   fg: '#2e7d32', bg: '#e8f5e9' },
    pending:  { label: 'PENDING',         fg: '#e65100', bg: '#fff3e0' },
    failed:   { label: 'FAILED',          fg: '#c62828', bg: '#ffebee' },
    refunded: { label: 'REFUNDED',        fg: '#1565c0', bg: '#e3f2fd' },
  };
  const sc = statusMap[invoice.status] || { label: (invoice.status || '').toUpperCase(), fg: '#333', bg: '#f5f5f5' };
  doc.roundedRect(L, y, 115, 18, 4).fill(sc.bg);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(sc.fg).text(sc.label, L, y + 4, { width: 115, align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`Type: ${invoice.type || 'Subscription Renewal'}`, L, y + 4, { width: W, align: 'right' });
  y += 30;

  // ── Billed To ──────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#888888').text('BILLED TO', L, y);
  y += 13;

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a2e').text(billedTo.name || billedTo.outletName || 'N/A', L, y);
  y += 17;

  if (billedTo.outletCode) {
    doc.font('Helvetica').fontSize(9).fillColor('#666666').text(`Outlet Code: ${billedTo.outletCode}`, L, y);
    y += 13;
  }

  const addrParts = [
    billedTo.address?.line1,
    billedTo.address?.line2,
    [billedTo.address?.city, billedTo.address?.state].filter(Boolean).join(', '),
    [billedTo.address?.postalCode, billedTo.address?.country].filter(Boolean).join(' - '),
  ].filter(Boolean);

  if (addrParts.length) {
    const addrStr = addrParts.join(', ');
    doc.font('Helvetica').fontSize(9).fillColor('#444444').text(addrStr, L, y, { width: W * 0.65 });
    y += doc.heightOfString(addrStr, { width: W * 0.65 }) + 5;
  }

  const infoItems = [
    billedTo.phone && `Phone: ${billedTo.phone}`,
    billedTo.email && `Email: ${billedTo.email}`,
    billedTo.gstin && `GSTIN: ${billedTo.gstin}`,
    billedTo.panNumber && `PAN: ${billedTo.panNumber}`,
  ].filter(Boolean);

  doc.font('Helvetica').fontSize(9).fillColor('#444444');
  for (let i = 0; i < infoItems.length; i += 2) {
    doc.text(infoItems[i], L, y, { width: W / 2 - 10 });
    if (infoItems[i + 1]) doc.text(infoItems[i + 1], L + W / 2, y, { width: W / 2 });
    y += 13;
  }

  y += 8;
  drawThickLine(y);
  y += 10;

  // ── Line Items Table ───────────────────────────────────────────────────────
  const colNo    = L;
  const colDesc  = L + 24;
  const colQty   = R - 175;
  const colPrice = R - 115;
  const colAmt   = R - 55;
  const descW    = colQty - colDesc - 8;

  doc.font('Helvetica-Bold').fontSize(8).fillColor('#333333');
  doc.text('#',            colNo,    y, { width: 20 });
  doc.text('Description',  colDesc,  y, { width: descW });
  doc.text('Qty',          colQty,   y, { width: 55, align: 'right' });
  doc.text('Unit Price',   colPrice, y, { width: 55, align: 'right' });
  doc.text('Amount',       colAmt,   y, { width: 55, align: 'right' });
  y += 14;
  drawLine(y);
  y += 6;

  doc.font('Helvetica').fontSize(10).fillColor('#333333');
  (lineItems || []).forEach((item, idx) => {
    if (y > 700) { doc.addPage(); y = 40; }
    doc.text(String(idx + 1),             colNo,    y, { width: 20 });
    doc.text(item.description || '',      colDesc,  y, { width: descW });
    doc.text(String(item.quantity || 1),  colQty,   y, { width: 55, align: 'right' });
    doc.text(amt(item.unitPrice),         colPrice, y, { width: 55, align: 'right' });
    doc.text(amt(item.amount),            colAmt,   y, { width: 55, align: 'right' });
    y += 18;
  });

  y += 4;
  drawThickLine(y);
  y += 10;

  // ── Totals (right-aligned block) ────────────────────────────────────────────
  const totLabelX = R - 250;
  const totLabelW = 175;
  const totValX   = R - 70;
  const totValW   = 70;

  function totalRow(label, value, opts = {}) {
    if (y > 750) { doc.addPage(); y = 40; }
    doc
      .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(opts.fontSize || 9)
      .fillColor(opts.color || '#444444');
    doc.text(label, totLabelX, y, { width: totLabelW, align: 'right' });
    doc.text(value, totValX,   y, { width: totValW,   align: 'right' });
    y += opts.spacing || 14;
  }

  const gstPct = parseFloat(taxBreakdown?.gstPercentage || 18);
  totalRow('Taxable Amount:',          amt(taxBreakdown?.taxableAmount));
  totalRow(`CGST (${gstPct / 2}%):`,  amt(taxBreakdown?.cgst));
  totalRow(`SGST (${gstPct / 2}%):`,  amt(taxBreakdown?.sgst));
  drawLine(y, '#999999');
  y += 6;
  totalRow('GRAND TOTAL:', amt(totals?.grandTotal), { bold: true, fontSize: 12, color: '#1a1a2e', spacing: 18 });

  const paidVal = parseFloat(totals?.amountPaid ?? 0);
  const dueVal  = parseFloat(totals?.amountDue  ?? 0);
  if (paidVal > 0 && paidVal !== parseFloat(totals?.grandTotal ?? 0)) {
    totalRow('Amount Paid:', amt(paidVal), { bold: true, color: '#2e7d32' });
  }
  if (dueVal > 0) {
    totalRow('Amount Due:', amt(dueVal), { bold: true, color: '#c62828' });
  }

  y += 8;
  drawThickLine(y);
  y += 10;

  // ── Payment Details ────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#888888').text('PAYMENT DETAILS', L, y);
  y += 13;

  const payRows = [
    payment?.method       && ['Payment Method', payment.method.charAt(0).toUpperCase() + payment.method.slice(1)],
    payment?.transactionId && ['Transaction ID', payment.transactionId],
    payment?.paidAt        && ['Paid At',         fmtDateTime(payment.paidAt)],
    payment?.status        && ['Status',           (payment.status || '').toUpperCase()],
    payment?.notes         && ['Notes',            payment.notes],
  ].filter(Boolean);

  payRows.forEach(([label, value]) => {
    if (y > 750) { doc.addPage(); y = 40; }
    doc.font('Helvetica').fontSize(9).fillColor('#666666').text(`${label}:`, L, y, { width: 120 });
    doc.fillColor('#333333').text(String(value), L + 125, y, { width: W - 125 });
    y += 13;
  });

  // ── Footer ────────────────────────────────────────────────────────────────
  y = Math.max(y + 20, 730);
  if (y > 790) { doc.addPage(); y = 730; }

  drawLine(y);
  y += 8;
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#aaaaaa');
  doc.text('This is a computer-generated invoice. No signature is required.', L, y, { width: W, align: 'center' });
  y += 11;
  doc.text('iMakerRestro \u2022 Powered by iMaker Technology \u2022 support@imakerrestro.com', L, y, { width: W, align: 'center' });

  doc.end();
  return doc;
}

module.exports = { generateSubscriptionInvoicePDF };
