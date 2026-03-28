/**
 * Menu QR Code Service
 * Generates and manages QR codes for menu viewing per outlet+menu_type
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');
const QRCode = require('qrcode');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const QR_SUBFOLDER = 'menu-qr';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Strip 'uploads/' prefix before joining with UPLOAD_DIR (handles both old and new stored paths)
const toAbsPath = (storedPath) => path.join(UPLOAD_DIR, storedPath.replace(/^uploads[\/]/, ''));

const menuQrService = {
  /**
   * Get QR code record by outlet and menu_type
   */
  async getByOutletAndType(outletId, menuType = 'restaurant') {
    const pool = getPool();
    const [[row]] = await pool.query(
      'SELECT * FROM menu_qr_codes WHERE outlet_id = ? AND menu_type = ?',
      [outletId, menuType]
    );
    return row || null;
  },

  /**
   * Get all QR codes for an outlet
   */
  async listByOutlet(outletId) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM menu_qr_codes WHERE outlet_id = ? ORDER BY menu_type',
      [outletId]
    );
    return rows;
  },

  /**
   * Generate QR code image with optional logo overlay
   * Returns the relative path to the saved QR image
   */
  async generateQrImage(viewUrl, outletId, menuType, logoPath = null) {
    const qrDir = path.join(UPLOAD_DIR, QR_SUBFOLDER);
    if (!fs.existsSync(qrDir)) {
      fs.mkdirSync(qrDir, { recursive: true });
    }

    const filename = `qr_${outletId}_${menuType}_${Date.now()}.png`;
    const qrFilePath = path.join(qrDir, filename);
    const relativePath = `uploads/${QR_SUBFOLDER}/${filename}`;

    // Generate base QR code as buffer
    const qrBuffer = await QRCode.toBuffer(viewUrl, {
      errorCorrectionLevel: 'H', // High error correction for logo overlay
      type: 'png',
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    // If logo provided, overlay it on the QR code
    if (logoPath) {
      // Strip leading 'uploads/' since UPLOAD_DIR already points to the uploads folder
      const relativeLogoPath = logoPath.replace(/^uploads[\\/]/, '');
      const absoluteLogoPath = relativeLogoPath.startsWith('/') || relativeLogoPath.includes(':')
        ? relativeLogoPath
        : path.join(UPLOAD_DIR, relativeLogoPath);

      if (fs.existsSync(absoluteLogoPath)) {
        try {
          // Resize logo to fit in center (about 20% of QR size)
          const logoSize = 80;
          const logoBuffer = await sharp(absoluteLogoPath)
            .resize(logoSize, logoSize, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .png()
            .toBuffer();

          // Composite logo onto QR code center
          const qrWithLogo = await sharp(qrBuffer)
            .composite([{
              input: logoBuffer,
              gravity: 'center'
            }])
            .png()
            .toFile(qrFilePath);

          return relativePath;
        } catch (logoErr) {
          logger.warn('Failed to overlay logo on QR, generating without logo:', logoErr.message);
        }
      }
    }

    // Save QR without logo
    await sharp(qrBuffer).toFile(qrFilePath);
    return relativePath;
  },

  /**
   * Create or get existing QR code for outlet+menu_type
   * This is called automatically when first menu media is uploaded for a menu_type
   */
  async getOrCreateQr(outletId, menuType = 'restaurant') {
    const pool = getPool();

    // Check if QR already exists
    let existing = await this.getByOutletAndType(outletId, menuType);
    if (existing) {
      return existing;
    }

    // Build the view URL
    const viewUrl = `${APP_URL}/api/v1/menu-media/${outletId}/view?type=${menuType}`;

    // Generate QR image (no logo initially)
    const qrPath = await this.generateQrImage(viewUrl, outletId, menuType, null);

    // Insert record
    const [res] = await pool.query(
      `INSERT INTO menu_qr_codes (outlet_id, menu_type, qr_path, view_url)
       VALUES (?, ?, ?, ?)`,
      [outletId, menuType, qrPath, viewUrl]
    );

    const [[row]] = await pool.query('SELECT * FROM menu_qr_codes WHERE id = ?', [res.insertId]);
    logger.info(`Created QR code for outlet ${outletId}, menu_type ${menuType}`);
    return row;
  },

  /**
   * Update QR code with a custom logo
   * Regenerates the QR image with logo overlay
   */
  async updateLogo(outletId, menuType, logoPath) {
    const pool = getPool();

    const existing = await this.getByOutletAndType(outletId, menuType);
    if (!existing) {
      throw new Error(`QR code not found for outlet ${outletId}, menu_type ${menuType}`);
    }

    // Delete old QR file
    const oldQrPath = toAbsPath(existing.qr_path);
    if (fs.existsSync(oldQrPath)) {
      fs.unlinkSync(oldQrPath);
    }

    // Regenerate QR with new logo
    const newQrPath = await this.generateQrImage(existing.view_url, outletId, menuType, logoPath);

    // Update record
    await pool.query(
      'UPDATE menu_qr_codes SET qr_path = ?, logo_path = ?, updated_at = NOW() WHERE id = ?',
      [newQrPath, logoPath, existing.id]
    );

    const [[row]] = await pool.query('SELECT * FROM menu_qr_codes WHERE id = ?', [existing.id]);
    return row;
  },

  /**
   * Regenerate QR code (e.g., if URL changes or logo is removed)
   */
  async regenerateQr(outletId, menuType, includeLogo = true) {
    const pool = getPool();

    const existing = await this.getByOutletAndType(outletId, menuType);
    if (!existing) {
      throw new Error(`QR code not found for outlet ${outletId}, menu_type ${menuType}`);
    }

    // Delete old QR file
    const oldQrPath = toAbsPath(existing.qr_path);
    if (fs.existsSync(oldQrPath)) {
      fs.unlinkSync(oldQrPath);
    }

    // Regenerate
    const logoPath = includeLogo ? existing.logo_path : null;
    const newQrPath = await this.generateQrImage(existing.view_url, outletId, menuType, logoPath);

    await pool.query(
      'UPDATE menu_qr_codes SET qr_path = ?, updated_at = NOW() WHERE id = ?',
      [newQrPath, existing.id]
    );

    const [[row]] = await pool.query('SELECT * FROM menu_qr_codes WHERE id = ?', [existing.id]);
    return row;
  },

  /**
   * Increment scan count (called when /view page is accessed)
   */
  async incrementScanCount(outletId, menuType) {
    const pool = getPool();
    await pool.query(
      'UPDATE menu_qr_codes SET scan_count = scan_count + 1 WHERE outlet_id = ? AND menu_type = ?',
      [outletId, menuType]
    );
  },

  /**
   * Delete QR code
   */
  async deleteQr(outletId, menuType) {
    const pool = getPool();

    const existing = await this.getByOutletAndType(outletId, menuType);
    if (!existing) {
      return { deleted: false };
    }

    // Delete QR file
    const qrPath = path.join(UPLOAD_DIR, existing.qr_path);
    if (fs.existsSync(qrPath)) {
      fs.unlinkSync(qrPath);
    }

    // Delete logo file if exists
    if (existing.logo_path) {
      const logoPath = path.join(UPLOAD_DIR, existing.logo_path);
      if (fs.existsSync(logoPath)) {
        fs.unlinkSync(logoPath);
      }
    }

    await pool.query('DELETE FROM menu_qr_codes WHERE id = ?', [existing.id]);
    return { deleted: true, row: existing };
  }
};

module.exports = menuQrService;
