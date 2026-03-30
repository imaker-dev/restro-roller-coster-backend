/**
 * Integration Routes
 * Handles Dyno API webhooks and online order management
 */

const express = require('express');
const router = express.Router();
const integrationController = require('../controllers/integration.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { verifyDynoWebhook } = require('../middleware/webhookAuth');

// Roles for integration management
const INTEGRATION_ROLES = ['super_admin', 'admin'];
const ORDER_MANAGEMENT_ROLES = ['super_admin', 'admin', 'manager', 'cashier'];

// ========================
// WEBHOOK ENDPOINTS (No auth - uses signature verification)
// ========================

/**
 * Dyno webhook endpoint
 * Receives orders from Swiggy/Zomato via Dyno
 * POST /api/v1/integrations/dyno/webhook
 * Note: No rate limiting on order webhooks - they're critical
 */
router.post('/dyno/webhook',
  verifyDynoWebhook,
  integrationController.handleDynoWebhook
);

// ========================
// AUTHENTICATED ENDPOINTS
// ========================

// All routes below require authentication
router.use(authenticate);

// ========================
// CHANNEL MANAGEMENT (Admin only)
// ========================

/**
 * Get all integration channels for outlet
 * GET /api/v1/integrations/channels
 */
router.get('/channels',
  authorize(...INTEGRATION_ROLES),
  integrationController.getChannels
);

/**
 * Create or update integration channel
 * POST /api/v1/integrations/channels
 */
router.post('/channels',
  authorize(...INTEGRATION_ROLES),
  integrationController.upsertChannel
);

/**
 * Deactivate integration channel
 * DELETE /api/v1/integrations/channels/:id
 */
router.delete('/channels/:id',
  authorize(...INTEGRATION_ROLES),
  integrationController.deleteChannel
);

// ========================
// MENU MAPPING (Admin only)
// ========================

/**
 * Get menu mappings for channel
 * GET /api/v1/integrations/channels/:channelId/menu-mapping
 */
router.get('/channels/:channelId/menu-mapping',
  authorize(...INTEGRATION_ROLES),
  integrationController.getMenuMappings
);

/**
 * Create or update menu mapping
 * POST /api/v1/integrations/channels/:channelId/menu-mapping
 */
router.post('/channels/:channelId/menu-mapping',
  authorize(...INTEGRATION_ROLES),
  integrationController.upsertMenuMapping
);

// ========================
// ONLINE ORDERS
// ========================

/**
 * Get active online orders (for kitchen display / dashboard)
 * GET /api/v1/integrations/orders/active
 */
router.get('/orders/active',
  authorize(...ORDER_MANAGEMENT_ROLES),
  integrationController.getActiveOnlineOrders
);

/**
 * Get online orders with filters
 * GET /api/v1/integrations/orders
 */
router.get('/orders',
  authorize(...ORDER_MANAGEMENT_ROLES),
  integrationController.getOnlineOrders
);

/**
 * Get online order details
 * GET /api/v1/integrations/orders/:id
 */
router.get('/orders/:id',
  authorize(...ORDER_MANAGEMENT_ROLES),
  integrationController.getOnlineOrderDetails
);

/**
 * Accept online order
 * POST /api/v1/integrations/orders/:id/accept
 */
router.post('/orders/:id/accept',
  authorize(...ORDER_MANAGEMENT_ROLES),
  integrationController.acceptOnlineOrder
);

/**
 * Reject online order
 * POST /api/v1/integrations/orders/:id/reject
 */
router.post('/orders/:id/reject',
  authorize(...ORDER_MANAGEMENT_ROLES),
  integrationController.rejectOnlineOrder
);

/**
 * Mark order ready for pickup
 * POST /api/v1/integrations/orders/:id/ready
 */
router.post('/orders/:id/ready',
  authorize(...ORDER_MANAGEMENT_ROLES),
  integrationController.markOrderReady
);

/**
 * Mark order dispatched
 * POST /api/v1/integrations/orders/:id/dispatch
 */
router.post('/orders/:id/dispatch',
  authorize(...ORDER_MANAGEMENT_ROLES),
  integrationController.markOrderDispatched
);

// ========================
// LOGS & DEBUGGING
// ========================

/**
 * Get integration logs
 * GET /api/v1/integrations/logs
 */
router.get('/logs',
  authorize(...INTEGRATION_ROLES),
  integrationController.getLogs
);

/**
 * Test webhook (development only)
 * POST /api/v1/integrations/test-webhook
 */
router.post('/test-webhook',
  authorize(...INTEGRATION_ROLES),
  integrationController.testWebhook
);

module.exports = router;
