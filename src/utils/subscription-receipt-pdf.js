/**
 * Subscription Receipt PDF Generator
 * Generates a professional subscription payment receipt using pdfkit
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const DEFAULT_LOGO_PATH = path.resolve(__dirname, '../../public/assets/IR.png');

function resolveLocalLogoPath(source) {
  if (!source || typeof source !== 'string') return null;
  if (fs.existsSync(source)) return source;
  const relativeToCwd = path.resolve(process.cwd(), source.replace(/^\/+/ ,''));
  if (fs.existsSync(relativeToCwd)) return relativeToCwd;
  if (source.startsWith('/')) {
    const relativeToPublic = path.resolve(process.cwd(), 'public', source.replace(/^\/+/ ,''));
    if (fs.existsSync(relativeToPublic)) return relativeToPublic;
  }
  return null;
}

async function fetchImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function resolveLogoCandidates(outlet = {}) {
  const sources = [outlet.logoUrl, outlet.logo].filter((s) => typeof s === 'string' && s.trim());
  const cleaned = sources.map((s) => s.trim());
  if (fs.existsSync(DEFAULT_LOGO_PATH)) cleaned.push(DEFAULT_LOGO_PATH);
  return Array.from(new Set(cleaned));
}

function currency(amount) {
  return `Rs.${parseFloat(amount || 0).toFixed(2)}`;
}

/**
 * Generate subscription receipt PDF
 * @param {object} data - { receiptNo, date, outletName, outletAddress, baseAmount, gstAmount, totalAmount, gstPercentage, subscriptionStart, subscriptionEnd, paymentMode, paymentId }
 * @param {object} outlet - { name, address, phone, email, gstin, logoUrl }
 * @returns {Promise<Buffer>}
 */
async function generateSubscriptionReceiptPDF(data, outlet = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  return new Promise(async (resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 40;
    const right = 555;
    const width = right - left;
    let y = 40;

    // Logo
    for (const logoSource of resolveLogoCandidates(outlet)) {
      try {
        let logoBuffer = null;
        if (logoSource.startsWith('http')) {
          logoBuffer = await fetchImageBuffer(logoSource);
        } else {
          const p = resolveLocalLogoPath(logoSource);
          if (p) logoBuffer = fs.readFileSync(p);
        }
        if (logoBuffer) {
          doc.image(logoBuffer, left, y, { fit: [60, 60], align: 'left' });
          y += 70;
          break;
        }
      } catch (_) { /* continue */ }
    }

    // Header with iMakerRestro branding
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#1a1a2e');
    doc.text('iMakerRestro', left, y, { align: 'center', width });
    y += 22;
    doc.font('Helvetica').fontSize(12).fillColor('#555');
    doc.text('SUBSCRIPTION RECEIPT', left, y, { align: 'center', width });
    y += 30;

    doc.font('Helvetica').fontSize(9).fillColor('#555');
    doc.text(`Receipt No: ${data.receiptNo || 'N/A'}`, left, y);
    doc.text(`Date: ${data.date || new Date().toLocaleDateString('en-IN')}`, left, y, { align: 'right', width });
    y += 20;

    // Separator
    doc.moveTo(left, y).lineTo(right, y).stroke('#cccccc');
    y += 12;

    // Outlet Info
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a2e');
    doc.text(outlet.name || data.outletName || 'Restaurant', left, y);
    y += 16;

    if (outlet.address || data.outletAddress) {
      doc.font('Helvetica').fontSize(9).fillColor('#555');
      doc.text(outlet.address || data.outletAddress, left, y, { width: width * 0.7 });
      y += 14;
    }
    if (outlet.phone) {
      doc.text(`Phone: ${outlet.phone}`, left, y);
      y += 14;
    }
    if (outlet.gstin) {
      doc.text(`GSTIN: ${outlet.gstin}`, left, y);
      y += 14;
    }
    y += 8;

    // Separator
    doc.moveTo(left, y).lineTo(right, y).stroke('#cccccc');
    y += 12;

    // Title
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#1a1a2e');
    doc.text('Subscription Payment Details', left, y);
    y += 20;

    // Table header
    const col1 = left;
    const col2 = right - 120;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333');
    doc.text('Description', col1, y);
    doc.text('Amount', col2, y, { align: 'right', width: 120 });
    y += 18;

    // Row 1: Base Amount
    doc.font('Helvetica').fontSize(10).fillColor('#333');
    doc.text('Subscription Base Amount', col1, y);
    doc.text(currency(data.baseAmount), col2, y, { align: 'right', width: 120 });
    y += 16;

    // Row 2: GST
    doc.text(`GST (${data.gstPercentage || 18}%)`, col1, y);
    doc.text(currency(data.gstAmount), col2, y, { align: 'right', width: 120 });
    y += 16;

    // Separator before total
    doc.moveTo(col2, y).lineTo(right, y).stroke('#999');
    y += 10;

    // Total
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a2e');
    doc.text('Total Amount Paid', col1, y);
    doc.text(currency(data.totalAmount), col2, y, { align: 'right', width: 120 });
    y += 24;

    // Separator
    doc.moveTo(left, y).lineTo(right, y).stroke('#cccccc');
    y += 12;

    // Subscription Period
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a2e');
    doc.text('Subscription Period', left, y);
    y += 16;

    doc.font('Helvetica').fontSize(10).fillColor('#333');
    doc.text(`Valid From:  ${data.subscriptionStart || 'N/A'}`, left, y);
    y += 14;
    doc.text(`Expires On:  ${data.subscriptionEnd || 'N/A'}`, left, y);
    y += 20;

    // Payment Info
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#1a1a2e');
    doc.text('Payment Information', left, y);
    y += 16;

    doc.font('Helvetica').fontSize(10).fillColor('#333');
    doc.text(`Payment Mode: ${data.paymentMode || 'Online (Razorpay)'}`, left, y);
    y += 14;
    if (data.paymentId) {
      doc.text(`Payment ID:   ${data.paymentId}`, left, y);
      y += 14;
    }
    if (data.orderId) {
      doc.text(`Order ID:     ${data.orderId}`, left, y);
      y += 14;
    }
    y += 20;

    // Footer
    doc.moveTo(left, y).lineTo(right, y).stroke('#cccccc');
    y += 12;

    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#888');
    doc.text('This is a computer-generated receipt. No signature required.', left, y, { align: 'center', width });
    y += 14;
    doc.text('iMakerRestro • Powered by iMaker Technology', left, y, { align: 'center', width });
    y += 10;
    doc.text('support@imakerrestro.com', left, y, { align: 'center', width });

    doc.end();
  });
}

module.exports = { generateSubscriptionReceiptPDF };
