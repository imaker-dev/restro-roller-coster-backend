/**
 * ESC/POS Image Utility
 * Converts images to ESC/POS bit image format for thermal printers
 * Uses ESC * command for maximum compatibility
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');

/**
 * Convert image to ESC/POS bit image format using ESC * command
 * This command has broader compatibility than GS v 0 raster command
 * @param {string|Buffer} imageSource - Image path, URL, or buffer
 * @param {object} options - Conversion options
 * @param {number} options.maxWidth - Maximum width in pixels (default 384 for 80mm paper)
 * @param {number} options.maxHeight - Maximum height in pixels (default 120)
 * @param {number} options.threshold - Black/white threshold 0-255 (default 128)
 * @returns {Promise<Buffer>} - ESC/POS bitmap data
 */
async function imageToEscPos(imageSource, options = {}) {
  const {
    maxWidth = 384,  // 80mm paper = ~384 pixels at 203 DPI
    maxHeight = 120,
    threshold = 128
  } = options;

  // Supported image formats by sharp
  const SUPPORTED_FORMATS = ['jpeg', 'jpg', 'png', 'webp', 'gif', 'avif', 'tiff', 'svg'];
  
  try {
    let imageBuffer;

    // Handle different input types
    if (Buffer.isBuffer(imageSource)) {
      imageBuffer = imageSource;
    } else if (typeof imageSource === 'string') {
      // Check file extension for unsupported formats before loading
      const ext = imageSource.split('.').pop()?.toLowerCase();
      if (ext === 'bmp') {
        logger.warn(`BMP format not supported for ESC/POS conversion: ${imageSource}. Please use PNG or JPEG.`);
        return Buffer.alloc(0);
      }
      
      if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
        // Download from URL using built-in fetch (Node.js 18+)
        const response = await fetch(imageSource);
        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`);
        }
        imageBuffer = Buffer.from(await response.arrayBuffer());
      } else {
        // Read from file path
        imageBuffer = await fs.readFile(imageSource);
      }
    } else {
      throw new Error('Invalid image source type');
    }

    // Check image format using sharp metadata
    let metadata;
    try {
      metadata = await sharp(imageBuffer).metadata();
    } catch (metaErr) {
      logger.warn(`Cannot read image metadata (unsupported format?): ${metaErr.message}`);
      return Buffer.alloc(0);
    }
    
    // Verify format is supported
    if (metadata.format && !SUPPORTED_FORMATS.includes(metadata.format.toLowerCase())) {
      logger.warn(`Image format "${metadata.format}" not supported for ESC/POS. Use PNG or JPEG.`);
      return Buffer.alloc(0);
    }

    // Process image with sharp - flatten to white background, trim whitespace, enhance contrast
    let image = sharp(imageBuffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } }) // Remove transparency, white bg
      .trim({ background: '#FFFFFF', threshold: 10 }) // Trim white borders
      .normalize() // Enhance contrast
      .grayscale();

    // Calculate resize dimensions maintaining aspect ratio
    let width = metadata.width || maxWidth;
    let height = metadata.height || maxHeight;

    if (width > maxWidth) {
      height = Math.round(height * (maxWidth / width));
      width = maxWidth;
    }
    if (height > maxHeight) {
      width = Math.round(width * (maxHeight / height));
      height = maxHeight;
    }

    // Width must be multiple of 8 for ESC/POS
    width = Math.floor(width / 8) * 8;
    if (width < 8) width = 8;

    // Resize and get raw pixel data
    const { data, info } = await image
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Use ESC * (bit image) command - print line by line for compatibility
    // ESC * m nL nH d1...dk where m=0 (8-dot single density), m=1 (8-dot double), m=32 (24-dot single), m=33 (24-dot double)
    // We use m=33 (24-dot double density) for better quality, processing 24 rows at a time
    
    const bytesPerRow = Math.ceil(info.width / 8);
    const sliceHeight = 24; // 24-dot mode
    const slices = Math.ceil(info.height / sliceHeight);
    
    const buffers = [];
    
    // Set line spacing to 24 dots (match our slice height)
    buffers.push(Buffer.from([0x1B, 0x33, 24])); // ESC 3 n - set line spacing to n/180 inch
    
    for (let slice = 0; slice < slices; slice++) {
      const yStart = slice * sliceHeight;
      const yEnd = Math.min(yStart + sliceHeight, info.height);
      const actualSliceHeight = yEnd - yStart;
      
      // ESC * m nL nH - select bit image mode
      // m = 33 (24-dot double density = 180 DPI horizontal)
      const nL = info.width & 0xFF;
      const nH = (info.width >> 8) & 0xFF;
      
      buffers.push(Buffer.from([0x1B, 0x2A, 33, nL, nH]));
      
      // For 24-dot mode, we need 3 bytes per column (24 bits = 3 bytes)
      const columnData = [];
      
      for (let x = 0; x < info.width; x++) {
        // Process 24 vertical pixels for this column
        for (let byteNum = 0; byteNum < 3; byteNum++) {
          let byte = 0;
          for (let bit = 0; bit < 8; bit++) {
            const y = yStart + byteNum * 8 + bit;
            if (y < info.height) {
              const pixelIdx = y * info.width + x;
              const pixelValue = data[pixelIdx];
              // Dark pixels become 1 (print black)
              if (pixelValue < threshold) {
                byte |= (0x80 >> bit);
              }
            }
          }
          columnData.push(byte);
        }
      }
      
      buffers.push(Buffer.from(columnData));
      buffers.push(Buffer.from([0x0A])); // Line feed after each slice
    }
    
    // Reset line spacing to default
    buffers.push(Buffer.from([0x1B, 0x32])); // ESC 2 - reset line spacing
    
    return Buffer.concat(buffers);
  } catch (error) {
    logger.error('Image to ESC/POS conversion failed:', error);
    throw error;
  }
}

/**
 * Create centered logo command with minimal spacing
 * @param {Buffer} logoData - ESC/POS bitmap data from imageToEscPos
 * @returns {Buffer} - Centered logo with minimal spacing
 */
function wrapLogoWithAlignment(logoData) {
  if (!logoData || !Buffer.isBuffer(logoData)) {
    return Buffer.alloc(0);
  }

  return Buffer.concat([
    Buffer.from([0x1B, 0x61, 0x01]),  // Align center
    logoData,
    Buffer.from([0x1B, 0x32]),        // Reset line spacing to default (important after image)
    Buffer.from([0x1B, 0x61, 0x00])   // Align left
  ]);
}

/**
 * Load and cache logo for an outlet
 * @param {string} logoUrl - URL or path to logo
 * @param {object} options - Conversion options
 * @returns {Promise<Buffer|null>} - ESC/POS logo data or null if failed
 */
async function loadOutletLogo(logoUrl, options = {}) {
  if (!logoUrl) {
    return null;
  }

  try {
    const logoBuffer = await imageToEscPos(logoUrl, {
      maxWidth: options.maxWidth || 300,
      maxHeight: options.maxHeight || 120,
      threshold: options.threshold || 128
    });
    return wrapLogoWithAlignment(logoBuffer);
  } catch (error) {
    logger.warn(`Failed to load outlet logo: ${logoUrl}`, error.message);
    return null;
  }
}

module.exports = {
  imageToEscPos,
  wrapLogoWithAlignment,
  loadOutletLogo
};
