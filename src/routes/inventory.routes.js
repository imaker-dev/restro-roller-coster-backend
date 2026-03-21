/**
 * Inventory Routes — 24 endpoints
 * Module 1: Units (3)  |  Module 2: Vendors (4)  |  Module 4: Purchases (5)
 * Module 3: Categories (3) + Items (4) + Batches (1) + Movements (1) + Adjust (1) + Wastage (1) + Summary (1) = 12
 *
 * Design: No separate delete endpoints — use PUT with { isActive: false } to deactivate.
 *         Units auto-seed on first list call. Ledger = movements?inventoryItemId.
 *         Vendor purchases = purchases?vendorId.
 */

const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventory.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

router.use(authenticate);

const admin = authorize('super_admin', 'admin', 'manager','cashier');

// ======================== MODULE 1: UNITS ========================

/** GET  /:outletId/units           — List units (auto-seeds defaults on first call) */
router.get('/:outletId/units', admin, inventoryController.listUnits);

/** POST /:outletId/units           — Create custom unit */
router.post('/:outletId/units', admin, inventoryController.createUnit);

/** PUT  /units/:id                 — Update unit (set isActive:false to deactivate) */
router.put('/units/:id', admin, inventoryController.updateUnit);

// ======================== MODULE 2: VENDORS ========================

/** GET  /:outletId/vendors          — List vendors with purchase stats */
router.get('/:outletId/vendors', admin, inventoryController.listVendors);

/** GET  /vendors/:id                — Vendor detail */
// router.get('/vendors/:id', admin, inventoryController.getVendor);
router.get('/vendors/:id', admin, inventoryController.getVendorDetail);


/** GET  /vendors/:id/detail         — Comprehensive vendor detail with purchases, payments, items, trends */
// router.get('/vendors/:id/detail', admin, inventoryController.getVendorDetail);

/** POST /:outletId/vendors          — Create vendor */
router.post('/:outletId/vendors', admin, inventoryController.createVendor);

/** PUT  /vendors/:id                — Update vendor (set isActive:false to deactivate) */
router.put('/vendors/:id', admin, inventoryController.updateVendor);

// ======================== MODULE 3: INVENTORY ========================

/** GET  /:outletId/categories       — List inventory categories */
router.get('/:outletId/categories', admin, inventoryController.listCategories);

/** POST /:outletId/categories       — Create category */
router.post('/:outletId/categories', admin, inventoryController.createCategory);

/** PUT  /categories/:id             — Update category (set isActive:false to deactivate) */
router.put('/categories/:id', admin, inventoryController.updateCategory);

/** GET  /:outletId/items            — List inventory items (?lowStock, ?categoryId, etc.) */
router.get('/:outletId/items', admin, inventoryController.listItems);

/** GET  /items/:id                  — Item detail (stock, prices, batch count) */
router.get('/items/:id', admin, inventoryController.getItem);

/** POST /:outletId/items            — Create inventory item */
router.post('/:outletId/items', admin, inventoryController.createItem);

/** PUT  /items/:id                  — Update item (set isActive:false to deactivate) */
router.put('/items/:id', admin, inventoryController.updateItem);

/** GET  /items/:itemId/batches      — List batches for an item (?activeOnly) */
router.get('/items/:itemId/batches', admin, inventoryController.listBatches);

/** GET  /:outletId/movements        — Movement log (?inventoryItemId, ?movementType, ?startDate, ?endDate) */
router.get('/:outletId/movements', admin, inventoryController.listMovements);

/** POST /:outletId/adjustments      — Stock adjustment (+/-) */
router.post('/:outletId/adjustments', admin, inventoryController.recordAdjustment);

/** POST /:outletId/wastage          — Record wastage */
router.post('/:outletId/wastage', admin, inventoryController.recordWastage);

/** GET  /:outletId/stock-summary    — Stock summary with values & low-stock alerts */
router.get('/:outletId/stock-summary', admin, inventoryController.getStockSummary);

// ======================== MODULE 4: PURCHASES ========================

/** GET  /:outletId/purchases        — List purchases (?vendorId, ?status, ?startDate, etc.) */
router.get('/:outletId/purchases', admin, inventoryController.listPurchases);

/** GET  /purchases/:id              — Purchase detail with items */
router.get('/purchases/:id', admin, inventoryController.getPurchase);

/** POST /:outletId/purchases        — Create purchase (batch + stock + avg price auto-updated) */
router.post('/:outletId/purchases', admin, inventoryController.createPurchase);

/** POST /purchases/:id/cancel       — Cancel purchase (reverses stock) */
router.post('/purchases/:id/cancel', admin, inventoryController.cancelPurchase);

/** PUT  /purchases/:id/payment      — Update purchase payment */
router.put('/purchases/:id/payment', admin, inventoryController.updatePurchasePayment);

module.exports = router;
