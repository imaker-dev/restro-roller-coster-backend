/**
 * Dyno Webhook Routes (Production-Level)
 * 
 * These endpoints are called BY Dyno to push data to your server.
 * Pattern: Webhook → Queue (Redis) → Worker → DB
 * 
 * Base URL configured in Dyno: https://restro-backend.imaker.in/api/v1/dyno
 * 
 * Order Endpoints:
 *   POST /orders                      - Receive new orders from aggregators
 *   GET  /:resId/orders/status        - Dyno polls for order statuses (every 30s)
 *   POST /orders/:orderId/status      - Dyno posts status update confirmation
 *   POST /:resId/orders/history       - Dyno posts last 40 orders
 * 
 * Items Endpoints:
 *   GET  /:resId/items                - Dyno fetches items/categories
 *   POST /:resId/items                - Dyno posts all items (menu sync)
 *   POST /:resId/items/status         - Dyno posts item stock updates
 *   POST /:resId/categories/status    - Dyno posts category stock updates
 */

const express = require('express');
const router = express.Router();
const dynoWebhookController = require('../controllers/dynoWebhook.controller');
const { verifyDynoWebhookSimple, dynoRateLimit } = require('../middleware/webhookAuth');

// Note: Rate limiting is applied per-route (not globally) because we need req.params.resId

// ============================================================
// ORDER ENDPOINTS
// ============================================================

/**
 * POST /orders
 * Push new orders from various aggregators
 * Main webhook endpoint - orders are queued for async processing
 */
router.post('/orders',
  verifyDynoWebhookSimple,
  dynoWebhookController.receiveOrder
);

/**
 * GET /:resId/orders/status
 * Get order statuses for a restaurant (polled every 30s)
 * Returns orders needing action: status 1 = accept, status 3 = mark ready
 * RATE LIMITED: 1 request per minute per resId
 */
router.get('/:resId/orders/status',
  dynoRateLimit,
  verifyDynoWebhookSimple,
  dynoWebhookController.getOrdersStatus
);

/**
 * POST /orders/:orderId/status
 * Update order status and send response
 * Called after client exe accepts (status 2) or marks ready (status 4)
 */
router.post('/orders/:orderId/status',
  verifyDynoWebhookSimple,
  dynoWebhookController.updateOrderStatusById
);

/**
 * POST /:resId/orders/status
 * Legacy endpoint for status updates
 */
router.post('/:resId/orders/status',
  verifyDynoWebhookSimple,
  dynoWebhookController.updateOrderStatus
);

/**
 * POST /:resId/orders/history
 * Receive last 40 orders history
 * Pushed when orderHistory = true in status response
 */
router.post('/:resId/orders/history',
  verifyDynoWebhookSimple,
  dynoWebhookController.receiveOrderHistory
);

// ============================================================
// ITEMS ENDPOINTS
// ============================================================

/**
 * GET /:resId/items
 * Get items and categories of the restaurant
 * Returns getAllItems flag and current stock status
 */
router.get('/:resId/items',
  verifyDynoWebhookSimple,
  dynoWebhookController.getItems
);

/**
 * POST /:resId/items
 * Receive all items from platform (menu sync)
 * Posted when getAllItems = true in GET response
 */
router.post('/:resId/items',
  verifyDynoWebhookSimple,
  dynoWebhookController.receiveAllItems
);

/**
 * GET /:resId/items/status
 * Get current item stock statuses
 * RATE LIMITED: 1 request per minute per resId
 */
router.get('/:resId/items/status',
  dynoRateLimit,
  verifyDynoWebhookSimple,
  dynoWebhookController.getItemsStatus
);

/**
 * POST /:resId/items/status
 * Mark items inStock/outOfStock
 * RATE LIMITED: 1 request per minute per resId
 */
router.post('/:resId/items/status',
  dynoRateLimit,
  verifyDynoWebhookSimple,
  dynoWebhookController.updateItemsStatus
);

/**
 * POST /:resId/categories/status
 * Mark categories inStock/outOfStock
 * RATE LIMITED: 1 request per minute per resId
 */
router.post('/:resId/categories/status',
  dynoRateLimit,
  verifyDynoWebhookSimple,
  dynoWebhookController.updateCategoriesStatus
);

module.exports = router;
