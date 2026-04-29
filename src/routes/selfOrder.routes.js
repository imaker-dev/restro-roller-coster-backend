/**
 * Self-Order Routes
 * QR table ordering — public customer endpoints + authenticated staff endpoints.
 *
 * Public endpoints (customer-facing, rate-limited):
 *   POST /init                   - Initialize session from QR scan
 *   GET  /menu                   - Browse menu (requires session token)
 *   GET  /session                - Get session info
 *   PUT  /customer               - Update customer details
 *   POST /order                  - Place order
 *   POST /order/add-items        - Add items to existing order (reorder)
 *   POST /order/cancel            - Cancel order (before preparation)
 *   PUT  /order/item/:id          - Update item quantity (before KOT)
 *   DELETE /order/item/:id        - Remove item from order (before KOT)
 *   GET  /order/status           - Track order status
 *   POST /cart                   - Save cart
 *   GET  /cart                   - Get cart
 *   GET  /orders                 - Past orders for the table
 *
 * Staff endpoints (JWT authenticated):
 *   GET  /staff/pending/:outletId          - List pending self-orders
 *   POST /staff/accept                     - Accept a pending order
 *   POST /staff/reject                     - Reject a pending order
 *   GET  /staff/settings/:outletId         - Get self-order settings
 *   PATCH /staff/settings/:outletId        - Update self-order settings
 *   GET  /staff/qr/tables/:outletId        - Get all table QR URLs (grouped by floor)
 *   POST /staff/qr/generate               - Generate QR image for a table
 *   POST /staff/qr/generate-all           - Bulk generate QR images for all tables
 *   POST /staff/session/:id/complete      - Complete session
 */

const express = require('express');
const router = express.Router();
const selfOrderController = require('../controllers/selfOrder.controller');
const { verifySelfOrderSession } = require('../middlewares/selfOrderAuth');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate');
const selfOrderValidation = require('../validations/selfOrder.validation');
const rateLimit = require('express-rate-limit');

// ============================================================
// RATE LIMITERS (public endpoints need stricter limits)
// ============================================================

// Session init: 8 per 5 seconds per IP — brief cooldown, auto-resumes
const initLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 8,
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Too many session requests. Please try again in a few seconds.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Menu: 10 per 5 seconds per IP — generous for browsing, brief cooldown
const menuLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Too many menu requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Order actions: 5 per 5 seconds per IP — prevents spam, resumes in ~5s
const orderLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 5,
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Too many order requests. Please wait a few seconds.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Status check: 15 per 5 seconds per IP — generous for polling, brief cooldown
const statusLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 15,
  keyGenerator: (req) => req.ip,
  message: { success: false, message: 'Too many status requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// PUBLIC ENDPOINTS (no JWT auth, session-token based)
// ============================================================

// Initialize session from QR scan (no session token needed yet)
router.post('/init',
  initLimiter,
  validate(selfOrderValidation.initSession),
  selfOrderController.initSession
);

// All subsequent public endpoints require a valid session token
router.get('/menu',
  menuLimiter,
  verifySelfOrderSession,
  selfOrderController.getMenu
);

router.get('/session',
  statusLimiter,
  verifySelfOrderSession,
  selfOrderController.getSession
);

router.put('/customer',
  verifySelfOrderSession,
  validate(selfOrderValidation.updateCustomer),
  selfOrderController.updateCustomer
);

router.post('/order',
  orderLimiter,
  verifySelfOrderSession,
  validate(selfOrderValidation.placeOrder),
  selfOrderController.placeOrder
);

router.post('/order/add-items',
  orderLimiter,
  verifySelfOrderSession,
  validate(selfOrderValidation.addItems),
  selfOrderController.addItems
);

router.post('/order/cancel',
  orderLimiter,
  verifySelfOrderSession,
  validate(selfOrderValidation.cancelOrder),
  selfOrderController.cancelOrder
);

router.put('/order/item/:orderItemId',
  orderLimiter,
  verifySelfOrderSession,
  validate(selfOrderValidation.updateItemQuantity),
  selfOrderController.updateItemQuantity
);

router.delete('/order/item/:orderItemId',
  orderLimiter,
  verifySelfOrderSession,
  selfOrderController.removeItem
);

router.get('/order/status',
  statusLimiter,
  verifySelfOrderSession,
  selfOrderController.getOrderStatus
);

// Cart: save and retrieve (session-token auth)
router.post('/cart',
  statusLimiter,
  verifySelfOrderSession,
  validate(selfOrderValidation.saveCart),
  selfOrderController.saveCart
);

router.get('/cart',
  statusLimiter,
  verifySelfOrderSession,
  selfOrderController.getCart
);

// Past orders for the table (session-token auth)
router.get('/orders',
  statusLimiter,
  verifySelfOrderSession,
  selfOrderController.getPastOrders
);

// ============================================================
// STAFF ENDPOINTS (JWT authenticated)
// ============================================================

router.get('/staff/pending/:outletId',
  authenticate,
  authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user', 'captain'),
  selfOrderController.getPendingOrders
);

router.post('/staff/accept',
  authenticate,
  authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'),
  validate(selfOrderValidation.acceptOrder),
  selfOrderController.acceptOrder
);

router.post('/staff/reject',
  authenticate,
  authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'),
  validate(selfOrderValidation.rejectOrder),
  selfOrderController.rejectOrder
);

router.get('/staff/settings/:outletId',
  authenticate,
  authorize('super_admin', 'admin', 'manager', 'pos_user', 'cashier'),
  selfOrderController.getSettings
);

router.patch('/staff/settings/:outletId',
  authenticate,
  authorize('super_admin', 'admin', 'manager', 'pos_user', 'cashier'),
  validate(selfOrderValidation.updateSettings),
  selfOrderController.updateSettings
);

// QR code — get all table URLs for an outlet (grouped by floor)
router.get('/staff/qr/tables/:outletId',
  authenticate,
  authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user', 'captain'),
  selfOrderController.getTableQrUrls
);

// QR code generation for tables
router.post('/staff/qr/generate',
  authenticate,
  authorize('super_admin', 'admin', 'manager'),
  validate(selfOrderValidation.generateQr),
  selfOrderController.generateQr
);

router.post('/staff/qr/generate-all',
  authenticate,
  authorize('super_admin', 'admin', 'manager'),
  selfOrderController.generateAllQrs
);

// Complete session + rotate QR token
router.post('/staff/session/:sessionId/complete',
  authenticate,
  authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'),
  selfOrderController.completeSession
);

module.exports = router;
