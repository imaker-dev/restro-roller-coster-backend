const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const subscriptionController = require('../controllers/subscription.controller');

// ─── Master-only: Global pricing ────────────────────────────────────────────
router.get('/pricing', authenticate, authorize('master'), subscriptionController.getPricing);
router.post('/pricing', authenticate, authorize('master'), subscriptionController.setPricing);

// ─── Master-only: Hierarchical pricing — Super Admin level ──────────────────
router.get('/pricing/super-admin', authenticate, authorize('master'), subscriptionController.getAllSuperAdminPricings);
router.get('/pricing/super-admin/:userId', authenticate, authorize('master'), subscriptionController.getSuperAdminPricing);
router.post('/pricing/super-admin/:userId', authenticate, authorize('master'), subscriptionController.setSuperAdminPricing);
router.delete('/pricing/super-admin/:userId', authenticate, authorize('master'), subscriptionController.removeSuperAdminPricing);

// ─── Master-only: Hierarchical pricing — Outlet level override ──────────────
router.get('/pricing/outlet/:outletId', authenticate, authorize('master'), subscriptionController.getOutletPricingOverride);
router.post('/pricing/outlet/:outletId', authenticate, authorize('master'), subscriptionController.setOutletPricingOverride);
router.delete('/pricing/outlet/:outletId', authenticate, authorize('master'), subscriptionController.removeOutletPricingOverride);

// ─── Master-only: Resolve effective pricing for an outlet ───────────────────
router.get('/pricing/resolve/:outletId', authenticate, authorize('master'), subscriptionController.resolveOutletPricing);

// ─── Master-only: Subscription management ───────────────────────────────────
router.get('/', authenticate, authorize('master'), subscriptionController.getAllSubscriptions);
router.post('/:outletId/activate', authenticate, authorize('master'), subscriptionController.activateSubscription);
router.post('/:outletId/deactivate', authenticate, authorize('master'), subscriptionController.deactivateSubscription);
router.post('/:outletId/extend', authenticate, authorize('master'), subscriptionController.extendSubscription);

// ─── Super Admin: Read-only subscription dashboard ──────────────────────────
router.get('/dashboard', authenticate, authorize('super_admin', 'master'), subscriptionController.getSuperAdminDashboard);

// ─── Outlet-facing APIs ─────────────────────────────────────────────────────
router.get('/my', authenticate, subscriptionController.getMySubscription);
router.post('/create-order', subscriptionController.createPaymentOrder);
router.post('/verify-payment', subscriptionController.verifyPayment);

// ─── Razorpay Webhook (public — signature verified server-side) ────────────────
router.post('/webhook', subscriptionController.razorpayWebhook);

// ─── Internal scan endpoint (called by cron/BullMQ) ───────────────────────────
router.get('/scan', authenticate, authorize('master'), subscriptionController.scanSubscriptions);

// ─── Offline POS sync (no JWT — validated by outletId + licenseKey + activationKey) ───
router.post('/sync-offline', subscriptionController.syncOfflineSubscription);

// ─── Offline POS first-time activation (no JWT — validates + activates outlet) ───
router.post('/activate-offline', subscriptionController.activateOfflineOutlet);

module.exports = router;
