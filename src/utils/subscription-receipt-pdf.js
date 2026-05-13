/**
 * Subscription Receipt PDF Generator
 * Generates a professional A4 tax invoice PDF for subscription payment receipts.
 * Used for email attachments and WhatsApp document delivery.
 *
 * Signature unchanged: generateSubscriptionReceiptPDF(data, outlet) → Promise<Buffer>
 *
 * @param {object} data   - { receiptNo, date, outletName, outletAddress, baseAmount, gstAmount,
 *                            totalAmount, gstPercentage, subscriptionStart, subscriptionEnd,
 *                            paymentMode, paymentId, orderId }
 * @param {object} outlet - { name, address, phone, email, gstin, logoUrl, logo }
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

function resolveLogoCandidates(outlet = {}) {
  const sources = [outlet.logoUrl, outlet.logo, DEFAULT_LOGO_PATH].filter(
    (s) => typeof s === 'string' && s.trim(),
  );
  return Array.from(new Set(sources.map((s) => s.trim())));
}

function amt(value) {
  return `Rs.${parseFloat(value || 0).toFixed(2)}`;
}

/**
 * @returns {Promise<Buffer>}
 */
async function generateSubscriptionReceiptPDF(data, outlet = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  return new Promise(async (resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 40;    // left margin
    const R = 555;   // right edge
    const W = R - L; // usable width

    function drawLine(y, color = '#cccccc') {
      doc.save().lineWidth(0.5).moveTo(L, y).lineTo(R, y).stroke(color).restore();
    }

    function drawThickLine(y) {
      doc.save().lineWidth(1).moveTo(L, y).lineTo(R, y).stroke('#333333').restore();
    }

    let y = 40;
    let logoWidth = 0;

    // ── Logo ────────────────────────────────────────────────────────────────
    for (const src of resolveLogoCandidates(outlet)) {
      try {
        let buf = null;
        if (src.startsWith('http://') || src.startsWith('https://')) {
          buf = await fetchImageBuffer(src);
        } else {
          const p = resolveLocalLogoPath(src);
          if (p) buf = fs.readFileSync(p);
        }
        if (buf) {
          doc.image(buf, L, y, { fit: [55, 55], align: 'left', valign: 'top' });
          logoWidth = 65;
          break;
        }
      } catch (_) { /* try next */ }
    }

    // ── Header: Company (left) + Invoice title (right) ──────────────────────
    const hx = L + logoWidth;
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a1a2e').text('iMakerRestro', hx, y, { width: 220 });
    y += 20;
    doc.font('Helvetica').fontSize(9).fillColor('#666666').text('Subscription Management Platform', hx, y, { width: 250 });
    y += 12;
    doc.text('support@imakerrestro.com', hx, y, { width: 250 });

    doc.font('Helvetica-Bold').fontSize(20).fillColor('#1a1a2e').text('TAX INVOICE', L, 40, { width: W, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#555555');
    doc.text(`Invoice #: ${data.receiptNo || 'N/A'}`, L, 65, { width: W, align: 'right' });
    doc.text(`Date: ${data.date || new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`, L, 78, { width: W, align: 'right' });

    y = Math.max(y + 20, 112);
    drawThickLine(y);
    y += 10;

    // ── Status badge + type ──────────────────────────────────────────────────
    doc.roundedRect(L, y, 70, 18, 4).fill('#e8f5e9');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#2e7d32').text('PAID', L, y + 4, { width: 70, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#555555').text('Type: Subscription Renewal', L, y + 4, { width: W, align: 'right' });
    y += 30;

    // ── Billed To ────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#888888').text('BILLED TO', L, y);
    y += 13;

    doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a2e').text(
      (outlet.name || data.outletName || 'N/A').toUpperCase(), L, y,
    );
    y += 17;

    const address = outlet.address || data.outletAddress;
    if (address) {
      doc.font('Helvetica').fontSize(9).fillColor('#444444').text(address, L, y, { width: W * 0.65 });
      y += doc.heightOfString(address, { width: W * 0.65 }) + 5;
    }

    const infoItems = [
      outlet.phone && `Phone: ${outlet.phone}`,
      outlet.email && `Email: ${outlet.email}`,
      outlet.gstin && `GSTIN: ${outlet.gstin}`,
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

    // ── Line Items Table ─────────────────────────────────────────────────────
    const colNo    = L;
    const colDesc  = L + 24;
    const colQty   = R - 175;
    const colPrice = R - 115;
    const colAmt   = R - 55;
    const descW    = colQty - colDesc - 8;

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#333333');
    doc.text('#',           colNo,    y, { width: 20 });
    doc.text('Description', colDesc,  y, { width: descW });
    doc.text('Qty',         colQty,   y, { width: 55, align: 'right' });
    doc.text('Unit Price',  colPrice, y, { width: 55, align: 'right' });
    doc.text('Amount',      colAmt,   y, { width: 55, align: 'right' });
    y += 14;
    drawLine(y);
    y += 6;

    const baseAmount = parseFloat(data.baseAmount || 0);
    doc.font('Helvetica').fontSize(10).fillColor('#333333');
    doc.text('1',                          colNo,    y, { width: 20 });
    doc.text('Annual Subscription Plan',   colDesc,  y, { width: descW });
    doc.text('1',                          colQty,   y, { width: 55, align: 'right' });
    doc.text(amt(baseAmount),              colPrice, y, { width: 55, align: 'right' });
    doc.text(amt(baseAmount),              colAmt,   y, { width: 55, align: 'right' });
    y += 18;

    y += 4;
    drawThickLine(y);
    y += 10;

    // ── Totals (right-aligned) ───────────────────────────────────────────────
    const gstAmount  = parseFloat(data.gstAmount  || 0);
    const totalAmount = parseFloat(data.totalAmount || 0);
    const gstPct     = parseFloat(data.gstPercentage || 18);

    const totLabelX = R - 250;
    const totLabelW = 175;
    const totValX   = R - 70;
    const totValW   = 70;

    function totalRow(label, value, opts = {}) {
      doc
        .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(opts.fontSize || 9)
        .fillColor(opts.color || '#444444');
      doc.text(label, totLabelX, y, { width: totLabelW, align: 'right' });
      doc.text(value, totValX,   y, { width: totValW,   align: 'right' });
      y += opts.spacing || 14;
    }

    totalRow('Taxable Amount:',          amt(baseAmount));
    totalRow(`CGST (${gstPct / 2}%):`,  amt(gstAmount / 2));
    totalRow(`SGST (${gstPct / 2}%):`,  amt(gstAmount / 2));
    drawLine(y, '#999999');
    y += 6;
    totalRow('GRAND TOTAL:', amt(totalAmount), { bold: true, fontSize: 12, color: '#1a1a2e', spacing: 18 });

    y += 8;
    drawThickLine(y);
    y += 10;

    // ── Payment Details ──────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#888888').text('PAYMENT DETAILS', L, y);
    y += 13;

    const payRows = [
      ['Payment Method',  data.paymentMode  || 'Online (Razorpay)'],
      data.paymentId && ['Transaction ID',   data.paymentId],
      data.orderId   && ['Order ID',         data.orderId],
      ['Status',          'CAPTURED'],
    ].filter(Boolean);

    // Add subscription period in payment section
    if (data.subscriptionStart || data.subscriptionEnd) {
      payRows.push(['Valid From', data.subscriptionStart || 'N/A']);
      payRows.push(['Expires On', data.subscriptionEnd  || 'N/A']);
    }

    payRows.forEach(([label, value]) => {
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text(`${label}:`, L, y, { width: 120 });
      doc.fillColor('#333333').text(String(value), L + 125, y, { width: W - 125 });
      y += 13;
    });

    // ── Footer ───────────────────────────────────────────────────────────────
    y = Math.max(y + 20, 730);
    if (y > 790) { doc.addPage(); y = 730; }

    drawLine(y);
    y += 8;
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#aaaaaa');
    doc.text('This is a computer-generated invoice. No signature is required.', L, y, { width: W, align: 'center' });
    y += 11;
    doc.text('iMakerRestro \u2022 Powered by iMaker Technology \u2022 support@imakerrestro.com', L, y, { width: W, align: 'center' });

    doc.end();
  });
}

module.exports = { generateSubscriptionReceiptPDF };
