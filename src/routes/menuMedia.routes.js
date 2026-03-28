/**
 * Menu Media Routes — Public endpoints
 * - Upload image/PDF with menuType (restaurant, bar, etc.)
 * - List media for outlet
 * - Public HTML view (for QR scans)
 * - QR code management (auto-generated on first upload per menuType)
 */

const express = require('express');
const router = express.Router();
const menuMediaController = require('../controllers/menuMedia.controller');

// Public upload (image or PDF) — menuType in body (default: 'restaurant')
router.post('/:outletId/upload', menuMediaController.uploadMenuMedia);
router.post('/:outletId/upload/multiple', menuMediaController.uploadMultipleMenuMedia);

// Public listing — ?type=image|pdf|all&isActive=1|0&menuType=restaurant|bar|...
router.get('/:outletId', menuMediaController.listMenuMedia);

// Get distinct menu types for outlet
router.get('/:outletId/menu-types', menuMediaController.getMenuTypes);

// Public HTML gallery view (for QR scans) — ?type=restaurant|bar|...
router.get('/:outletId/view', menuMediaController.renderPublicView);

// ==================== QR CODE ROUTES ====================
// List all QR codes for outlet
router.get('/:outletId/qr', menuMediaController.listQrCodes);

// Get specific QR code info
router.get('/:outletId/qr/:menuType', menuMediaController.getQrCode);

// Get QR code image directly (for download/display)
router.get('/:outletId/qr/:menuType/image', menuMediaController.getQrImage);

// Upload custom logo for QR (regenerates QR with logo overlay)
router.post('/:outletId/qr/:menuType/logo', menuMediaController.uploadQrLogo);

// Regenerate QR code (e.g., after URL change or to remove logo)
router.post('/:outletId/qr/:menuType/regenerate', menuMediaController.regenerateQr);

// ==================== ADMIN ENDPOINTS ====================
// Optional admin-style endpoints (left public per requirement; secure via gateway if needed)
router.patch('/:id/active', menuMediaController.setActive);
router.patch('/:id', menuMediaController.updateMeta);
router.patch('/:id/replace', menuMediaController.replaceMenuMediaFile);
router.delete('/:id', menuMediaController.deleteMenuMedia);

module.exports = router;
