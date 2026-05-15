/**
 * Table QR PDF Generator
 * Generates A4 PDFs with table QR codes using pdfkit.
 *
 * Single-table PDF: one large QR per A4 page with table number.
 * Bulk PDF: 3x3 grid (9 QR codes) per A4 page.
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

// A4 in points (72 DPI)
const A4_W = 595.28;
const A4_H = 841.89;

// Base uploads dir — mirrors selfOrder.service.js logic
const UPLOAD_BASE = path.resolve(__dirname, '../../uploads');

function resolveQrImagePath(qrCodeRelativePath) {
  if (!qrCodeRelativePath) return null;
  const absPath = path.resolve(__dirname, '../../', qrCodeRelativePath);
  if (fs.existsSync(absPath)) return absPath;
  // Fallback: treat as already absolute
  if (fs.existsSync(qrCodeRelativePath)) return qrCodeRelativePath;
  return null;
}

/**
 * Generate a single-page A4 PDF for one table QR.
 * @param {object} table - { tableId, tableNumber, tableName, qrCodePath }
 * @param {string} outletName
 * @returns {Promise<Buffer>}
 */
async function generateSingleTableQrPDF(table, outletName = '') {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const centerX = A4_W / 2;
      let y = 50;

      // Outlet name header
      if (outletName) {
        doc.fontSize(16).fillColor('#555').font('Helvetica-Bold');
        doc.text(outletName, 40, y, { align: 'center', width: A4_W - 80 });
        y += 35;
      }

      // Decorative line
      doc.strokeColor('#ddd').lineWidth(1);
      doc.moveTo(100, y).lineTo(A4_W - 100, y).stroke();
      y += 25;

      // QR image (already contains table info + logo)
      const imgPath = resolveQrImagePath(table.qrCodePath);
      if (imgPath) {
        const imgW = 380;
        const imgX = (A4_W - imgW) / 2;
        doc.image(imgPath, imgX, y, { width: imgW });
        y += imgW * (670 / 600) + 25;
      } else {
        doc.fontSize(14).fillColor('#c00');
        doc.text('QR image not found — please regenerate.', 40, y, { align: 'center', width: A4_W - 80 });
      }

      // Footer hint
      doc.fontSize(11).fillColor('#bbb').font('Helvetica');
      doc.text('Scan QR to place your order', 40, A4_H - 45, { align: 'center', width: A4_W - 80 });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generate a multi-page A4 PDF with 3x3 grid of table QR codes.
 * @param {Array} tables - [{ tableId, tableNumber, tableName, qrCodePath }, ...]
 * @param {string} outletName
 * @returns {Promise<Buffer>}
 */
async function generateAllTablesQrPDF(tables, outletName = '') {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Filter only tables that have a QR image
      const validTables = tables.filter((t) => resolveQrImagePath(t.qrCodePath));
      if (validTables.length === 0) {
        doc.fontSize(20).fillColor('#c00');
        doc.text('No QR codes available — generate QR codes first.', 40, 100, { align: 'center', width: A4_W - 80 });
        doc.end();
        return;
      }

      // Page layout constants
      const MARGIN = 25;
      const COLS = 3;
      const ROWS = 3;
      const GAP_X = 15;
      const GAP_Y = 20;
      const CELL_W = (A4_W - MARGIN * 2 - GAP_X * (COLS - 1)) / COLS;  // ≈ 170
      const CELL_H = (A4_H - MARGIN * 2 - GAP_Y * (ROWS - 1)) / ROWS;  // ≈ 250
      const QR_SIZE = Math.min(CELL_W - 20, CELL_H - 50); // ≈ 150

      // Outlet name header on first page (drawn before grid so it sits above cells)
      if (outletName) {
        doc.fontSize(10).fillColor('#999');
        doc.text(outletName, MARGIN, 8, { width: A4_W - MARGIN * 2, align: 'left' });
      }

      let pageCount = 0;
      for (let i = 0; i < validTables.length; i++) {
        const col = i % COLS;
        const row = Math.floor((i % (COLS * ROWS)) / COLS);

        // Start new page after every 9 items (except first)
        if (i > 0 && i % (COLS * ROWS) === 0) {
          doc.addPage();
          pageCount++;
        }

        const table = validTables[i];
        const cellX = MARGIN + col * (CELL_W + GAP_X);
        const cellY = MARGIN + row * (CELL_H + GAP_Y);
        const imgPath = resolveQrImagePath(table.qrCodePath);

        // Cell background border (light grey)
        doc.strokeColor('#ddd').lineWidth(1).rect(cellX, cellY, CELL_W, CELL_H).stroke();

        // QR image centered in cell
        const imgX = cellX + (CELL_W - QR_SIZE) / 2;
        const imgY = cellY + 12;
        doc.image(imgPath, imgX, imgY, { width: QR_SIZE, height: QR_SIZE * (680 / 600) });

        // Table label below image (only if different from number)
        const textY = imgY + QR_SIZE * (670 / 600) + 6;
        const displayLabel = table.tableName && table.tableName !== String(table.tableNumber)
          ? `${table.tableNumber} — ${table.tableName}`
          : `Table ${table.tableNumber || table.tableId}`;
        doc.fontSize(12).fillColor('#444').font('Helvetica-Bold');
        doc.text(displayLabel, cellX, textY, {
          align: 'center',
          width: CELL_W,
        });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  generateSingleTableQrPDF,
  generateAllTablesQrPDF,
};
