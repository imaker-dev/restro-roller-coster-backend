/**
 * Subscription Controller
 * Master APIs + Outlet-facing APIs + Razorpay webhook
 *
 * All amounts in paise for Razorpay, rupees in DB responses.
 */

const crypto = require('crypto');
const subscriptionService = require('../services/subscription.service');
const logger = require('../utils/logger');
const { getPool } = require('../database');

// ─── MASTER APIs ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/subscriptions/pricing
 * Master only — view current pricing
 */
const getPricing = async (req, res) => {
  try {
    const pricing = await subscriptionService.getActivePricing();
    if (!pricing) {
      return res.status(200).json({ success: true, pricing: null, message: 'No pricing set yet' });
    }
    return res.status(200).json({
      success: true,
      pricing: {
        id: pricing.id,
        basePrice: parseFloat(pricing.base_price),
        gstPercentage: parseFloat(pricing.gst_percentage),
        totalPrice: parseFloat(pricing.total_price),
        effectiveFrom: pricing.effective_from,
        createdAt: pricing.created_at,
      },
    });
  } catch (error) {
    logger.error('getPricing error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch pricing' });
  }
};

/**
 * POST /api/v1/subscriptions/pricing
 * Master only — set new pricing
 * Body: { basePrice: number, gstPercentage: number }
 */
const setPricing = async (req, res) => {
  try {
    const { basePrice, gstPercentage } = req.body;
    if (typeof basePrice !== 'number' || basePrice <= 0 || typeof gstPercentage !== 'number' || gstPercentage < 0) {
      return res.status(400).json({ success: false, message: 'Valid basePrice and gstPercentage required' });
    }

    const result = await subscriptionService.setPricing(basePrice, gstPercentage, req.user.userId);
    return res.status(200).json({ success: true, pricing: result, message: 'Pricing updated successfully' });
  } catch (error) {
    logger.error('setPricing error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update pricing' });
  }
};

/**
 * GET /api/v1/subscriptions
 * Master only — paginated list of all outlet subscriptions
 * Query: ?page=1&limit=50&status=&search=&pricingSource=&expiringWithinDays=&expiredOnly=&expiringToday=&superAdminId=
 */
const getAllSubscriptions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filters = {
      status: req.query.status || null,
      search: req.query.search || null,
      pricingSource: req.query.pricingSource || null,
      expiringWithinDays: req.query.expiringWithinDays || null,
      expiredOnly: req.query.expiredOnly === 'true' || req.query.expiredOnly === '1' || false,
      expiringToday: req.query.expiringToday === 'true' || req.query.expiringToday === '1' || false,
      superAdminId: req.query.superAdminId || null,
    };

    const result = await subscriptionService.getAllSubscriptions(filters, { page, limit });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('getAllSubscriptions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch subscriptions' });
  }
};

/**
 * POST /api/v1/subscriptions/:outletId/activate
 * Master only — force activate an outlet subscription
 * Body: { startDate?, endDate?, notes? }
 */
const activateSubscription = async (req, res) => {
  try {
    const outletId = parseInt(req.params.outletId, 10);
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'Valid outletId required' });
    }

    const result = await subscriptionService.activateSubscription(outletId, req.user.userId, {
      startDate: req.body.startDate || null,
      endDate: req.body.endDate || null,
      notes: req.body.notes || null,
    });

    return res.status(200).json({ success: true, ...result, message: 'Subscription activated' });
  } catch (error) {
    logger.error('activateSubscription error:', error);
    return res.status(500).json({ success: false, message: 'Failed to activate subscription' });
  }
};

/**
 * POST /api/v1/subscriptions/:outletId/deactivate
 * Master only — force deactivate / suspend
 * Body: { notes? }
 */
const deactivateSubscription = async (req, res) => {
  try {
    const outletId = parseInt(req.params.outletId, 10);
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'Valid outletId required' });
    }

    const result = await subscriptionService.deactivateSubscription(outletId, req.user.userId, {
      notes: req.body.notes || null,
    });

    return res.status(200).json({ success: true, ...result, message: 'Subscription deactivated' });
  } catch (error) {
    logger.error('deactivateSubscription error:', error);
    return res.status(500).json({ success: false, message: 'Failed to deactivate subscription' });
  }
};

/**
 * POST /api/v1/subscriptions/:outletId/extend
 * Master only — extend by N days
 * Body: { days: number }
 */
const extendSubscription = async (req, res) => {
  try {
    const outletId = parseInt(req.params.outletId, 10);
    const days = parseInt(req.body.days, 10);
    if (!outletId || !days || days <= 0) {
      return res.status(400).json({ success: false, message: 'Valid outletId and days > 0 required' });
    }

    const result = await subscriptionService.extendSubscription(outletId, days, req.user.userId);
    return res.status(200).json({ success: true, ...result, message: `Subscription extended by ${days} days` });
  } catch (error) {
    logger.error('extendSubscription error:', error);
    return res.status(500).json({ success: false, message: 'Failed to extend subscription' });
  }
};

// ─── OUTLET APIs ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/subscriptions/my
 * Any authenticated user with outletId — view my subscription
 */
const getMySubscription = async (req, res) => {
  try {
    const outletId = req.user.outletId;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'No outlet assigned' });
    }

    const subscription = await subscriptionService.getMySubscription(outletId);
    return res.status(200).json({ success: true, subscription });
  } catch (error) {
    logger.error('getMySubscription error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch subscription' });
  }
};

/**
 * POST /api/v1/subscriptions/create-order
 * Outlet admin/super_admin — create Razorpay order for payment
 */
const createPaymentOrder = async (req, res) => {
  try {
    const outletId = req.user.outletId;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'No outlet assigned' });
    }

    const order = await subscriptionService.createRazorpayOrder(outletId, req.user.userId);
    return res.status(200).json({
      success: true,
      orderId: order.orderId,
      amount: order.amount,         // paise
      currency: order.currency,
      keyId: order.keyId,           // public key for Razorpay checkout
      basePrice: order.basePrice,
      gstAmount: order.gstAmount,
      totalPrice: order.totalPrice,
      gstPercentage: order.gstPercentage,
      receipt: order.receipt,
    });
  } catch (error) {
    logger.error('createPaymentOrder error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to create payment order' });
  }
};

/**
 * POST /api/v1/subscriptions/verify-payment
 * Outlet admin/super_admin — verify Razorpay payment + extend subscription
 * Body: { razorpayOrderId, razorpayPaymentId, razorpaySignature }
 */
const verifyPayment = async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({
        success: false,
        message: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required',
      });
    }

    const outletId = req.user.outletId;
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'No outlet assigned' });
    }

    const result = await subscriptionService.verifyAndExtendSubscription(
      outletId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    );

    if (result.alreadyProcessed) {
      return res.status(200).json({ success: true, message: result.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Payment verified and subscription activated',
      subscriptionStart: result.subscriptionStart,
      subscriptionEnd: result.subscriptionEnd,
    });
  } catch (error) {
    logger.error('verifyPayment error:', error);
    return res.status(400).json({ success: false, message: error.message || 'Payment verification failed' });
  }
};

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/subscriptions/webhook
 * Razorpay webhook — async payment confirmation (no auth)
 */
const razorpayWebhook = async (req, res) => {
  try {
    // Razorpay webhook secret verification (optional but recommended)
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const sigHeader = req.headers['x-razorpay-signature'];
      if (!sigHeader) {
        return res.status(400).json({ success: false, message: 'Missing signature' });
      }
      const expectedSig = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (sigHeader !== expectedSig) {
        logger.warn('Razorpay webhook signature mismatch');
        return res.status(400).json({ success: false, message: 'Invalid signature' });
      }
    }

    const result = await subscriptionService.processWebhook(req.body);
    return res.status(200).json({ success: true, processed: result.processed });
  } catch (error) {
    logger.error('razorpayWebhook error:', error);
    // Always return 200 to Razorpay to prevent retries
    return res.status(200).json({ success: false, message: 'Webhook processed with error' });
  }
};

// ─── CRON SCANNER (called by cron job) ──────────────────────────────────────
/**
 * GET /api/v1/subscriptions/scan (internal/cron)
 * Scans for expiring subscriptions and returns notification targets.
 * Should be called by BullMQ job or cron.
 */
const scanSubscriptions = async (req, res) => {
  try {
    const result = await subscriptionService.scanExpiringSubscriptions();

    // Log notifications for downstream processing (email/WhatsApp/in-app)
    for (const item of result.reminder10Days) {
      await subscriptionService.logNotification(item.outletId, 'renewal_reminder_10d');
    }
    for (const item of result.reminder3Days) {
      await subscriptionService.logNotification(item.outletId, 'renewal_reminder_3d');
    }
    for (const item of result.expiredToday) {
      await subscriptionService.logNotification(item.outletId, 'expired');
    }
    for (const item of result.graceEndedToday) {
      await subscriptionService.logNotification(item.outletId, 'grace_ended');
    }

    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('scanSubscriptions error:', error);
    return res.status(500).json({ success: false, message: 'Scan failed' });
  }
};

// ─── HIERARCHICAL PRICING APIs ──────────────────────────────────────────────

/**
 * GET /api/v1/subscriptions/pricing/resolve/:outletId
 * Master only — resolve effective pricing for a specific outlet
 */
const resolveOutletPricing = async (req, res) => {
  try {
    const outletId = parseInt(req.params.outletId, 10);
    if (!outletId) return res.status(400).json({ success: false, message: 'Valid outletId required' });

    const pricing = await subscriptionService.resolveOutletPricing(outletId);
    return res.status(200).json({ success: true, pricing });
  } catch (error) {
    logger.error('resolveOutletPricing error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to resolve pricing' });
  }
};

/**
 * GET /api/v1/subscriptions/pricing/super-admin
 * Master only — list all super admin custom pricings
 */
const getAllSuperAdminPricings = async (req, res) => {
  try {
    const pricings = await subscriptionService.getAllSuperAdminPricings();
    return res.status(200).json({ success: true, pricings });
  } catch (error) {
    logger.error('getAllSuperAdminPricings error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch super admin pricings' });
  }
};

/**
 * GET /api/v1/subscriptions/pricing/super-admin/:userId
 * Master only — get pricing for a specific super admin
 */
const getSuperAdminPricing = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.status(400).json({ success: false, message: 'Valid userId required' });

    const pricing = await subscriptionService.getSuperAdminPricing(userId);
    return res.status(200).json({ success: true, pricing });
  } catch (error) {
    logger.error('getSuperAdminPricing error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch super admin pricing' });
  }
};

/**
 * POST /api/v1/subscriptions/pricing/super-admin/:userId
 * Master only — set custom pricing for a super admin
 * Body: { basePrice: number, gstPercentage: number, notes?: string }
 */
const setSuperAdminPricing = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.status(400).json({ success: false, message: 'Valid userId required' });

    const { basePrice, gstPercentage, notes } = req.body;
    if (typeof basePrice !== 'number' || basePrice <= 0 || typeof gstPercentage !== 'number' || gstPercentage < 0) {
      return res.status(400).json({ success: false, message: 'Valid basePrice and gstPercentage required' });
    }

    const result = await subscriptionService.setSuperAdminPricing(userId, basePrice, gstPercentage, req.user.userId, notes || null);
    return res.status(200).json({ success: true, pricing: result, message: 'Super admin pricing updated' });
  } catch (error) {
    logger.error('setSuperAdminPricing error:', error);
    return res.status(500).json({ success: false, message: 'Failed to set super admin pricing' });
  }
};

/**
 * DELETE /api/v1/subscriptions/pricing/super-admin/:userId
 * Master only — remove custom pricing for a super admin (falls back to global)
 */
const removeSuperAdminPricing = async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.status(400).json({ success: false, message: 'Valid userId required' });

    const result = await subscriptionService.deleteSuperAdminPricing(userId);
    return res.status(200).json({ success: true, ...result, message: 'Super admin pricing removed, outlets will use global pricing' });
  } catch (error) {
    logger.error('removeSuperAdminPricing error:', error);
    return res.status(500).json({ success: false, message: 'Failed to remove super admin pricing' });
  }
};

/**
 * GET /api/v1/subscriptions/pricing/outlet/:outletId
 * Master only — get custom pricing override for a specific outlet
 */
const getOutletPricingOverride = async (req, res) => {
  try {
    const outletId = parseInt(req.params.outletId, 10);
    if (!outletId) return res.status(400).json({ success: false, message: 'Valid outletId required' });

    const pricing = await subscriptionService.getOutletPricingOverride(outletId);

    // Also resolve effective pricing (outlet → super_admin → global)
    let resolvedPricing = null;
    try {
      resolvedPricing = await subscriptionService.resolveOutletPricing(outletId);
    } catch (_) { /* no pricing configured at any level */ }

    return res.status(200).json({ success: true, pricing, resolvedPricing });
  } catch (error) {
    logger.error('getOutletPricingOverride error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch outlet pricing override' });
  }
};

/**
 * POST /api/v1/subscriptions/pricing/outlet/:outletId
 * Master only — set custom pricing override for a specific outlet
 * Body: { basePrice: number, gstPercentage: number, notes?: string }
 */
const setOutletPricingOverride = async (req, res) => {
  try {
    const outletId = parseInt(req.params.outletId, 10);
    if (!outletId) return res.status(400).json({ success: false, message: 'Valid outletId required' });

    const { basePrice, gstPercentage, notes } = req.body;
    if (typeof basePrice !== 'number' || basePrice <= 0 || typeof gstPercentage !== 'number' || gstPercentage < 0) {
      return res.status(400).json({ success: false, message: 'Valid basePrice and gstPercentage required' });
    }

    const result = await subscriptionService.setOutletPricingOverride(outletId, basePrice, gstPercentage, req.user.userId, notes || null);
    return res.status(200).json({ success: true, pricing: result, message: 'Outlet pricing override set' });
  } catch (error) {
    logger.error('setOutletPricingOverride error:', error);
    return res.status(500).json({ success: false, message: 'Failed to set outlet pricing override' });
  }
};

/**
 * DELETE /api/v1/subscriptions/pricing/outlet/:outletId
 * Master only — remove custom pricing override for an outlet (falls back to SA or global)
 */
const removeOutletPricingOverride = async (req, res) => {
  try {
    const outletId = parseInt(req.params.outletId, 10);
    if (!outletId) return res.status(400).json({ success: false, message: 'Valid outletId required' });

    const result = await subscriptionService.deleteOutletPricingOverride(outletId);
    return res.status(200).json({ success: true, ...result, message: 'Outlet pricing override removed' });
  } catch (error) {
    logger.error('removeOutletPricingOverride error:', error);
    return res.status(500).json({ success: false, message: 'Failed to remove outlet pricing override' });
  }
};

// ─── SUPER ADMIN DASHBOARD ──────────────────────────────────────────────────

/**
 * GET /api/v1/subscriptions/dashboard
 * Super Admin — view all their outlets' subscriptions
 * Query: ?page=1&limit=50&status=&search=
 */
const getSuperAdminDashboard = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filters = {
      status: req.query.status || null,
      search: req.query.search || null,
    };

    const result = await subscriptionService.getSuperAdminDashboardSubscriptions(
      req.user.userId, filters, { page, limit }
    );
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    logger.error('getSuperAdminDashboard error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch dashboard' });
  }
};

// ─── OFFLINE POS SYNC ───────────────────────────────────────────────────────

/**
 * POST /api/v1/subscriptions/sync-offline
 * Offline POS — validate by outletId + licenseKey + activationKey (no JWT).
 * Returns full subscription state for the outlet.
 */
const syncOfflineSubscription = async (req, res) => {
  try {
    const { outletId, licenseKey, activationKey } = req.body;

    if (!outletId || !licenseKey || !activationKey) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_CREDENTIALS',
        message: 'outletId, licenseKey and activationKey are required',
      });
    }

    const pool = getPool();

    // ─── 1. Validate activation token against token_generation_log ─────────────
    // activationKey is the raw signed token; we store SHA256(activationKey) as token_hash
    const activationHash = crypto
      .createHash('sha256')
      .update(String(activationKey))
      .digest('hex');

    const [tokenRows] = await pool.query(
      `SELECT id, license_id, outlet_id, token_type, subscription_expiry, device_hash, created_at
       FROM token_generation_log
       WHERE license_id = ? AND token_hash = ? AND outlet_id = ? AND token_type = 'offline_activation'
       ORDER BY created_at DESC
       LIMIT 1`,
      [String(licenseKey).trim(), activationHash, parseInt(outletId, 10)]
    );

    if (!tokenRows.length) {
      // Also try direct match in case activationKey IS the hash itself
      const [hashRows] = await pool.query(
        `SELECT id, license_id, outlet_id, token_type, subscription_expiry, device_hash, created_at
         FROM token_generation_log
         WHERE license_id = ? AND token_hash = ? AND outlet_id = ? AND token_type = 'offline_activation'
         ORDER BY created_at DESC
         LIMIT 1`,
        [String(licenseKey).trim(), String(activationKey).trim(), parseInt(outletId, 10)]
      );

      if (!hashRows.length) {
        logger.warn(`[SyncOffline] Invalid credentials for outlet ${outletId}, license ${licenseKey}`);
        return res.status(401).json({
          success: false,
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid outletId, licenseKey or activationKey',
        });
      }
    }

    // ─── 2. Fetch outlet + subscription ────────────────────────────────────────
    const parsedOutletId = parseInt(outletId, 10);
    const subscription = await subscriptionService.getMySubscription(parsedOutletId);

    if (!subscription) {
      return res.status(404).json({
        success: false,
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'No subscription found for this outlet',
      });
    }

    // ─── 3. Build comprehensive response ───────────────────────────────────────
    const [outletRows] = await pool.query(
      `SELECT id, uuid, code, name, legal_name, outlet_type, address_line1, city, state, country,
              postal_code, phone, email, gstin, fssai_number, pan_number, timezone,
              is_active, created_at, updated_at
       FROM outlets
       WHERE id = ?`,
      [parsedOutletId]
    );
    const outlet = outletRows[0] || null;

    // Resolve current pricing for renewal display
    let currentPricing = null;
    try {
      currentPricing = await subscriptionService.resolveOutletPricing(parsedOutletId);
    } catch (_) { /* no pricing configured */ }

    return res.status(200).json({
      success: true,
      code: 'SYNC_SUCCESS',
      outlet: outlet
        ? {
            id: outlet.id,
            uuid: outlet.uuid,
            code: outlet.code,
            name: outlet.name,
            legalName: outlet.legal_name,
            type: outlet.outlet_type,
            addressLine1: outlet.address_line1,
            city: outlet.city,
            state: outlet.state,
            country: outlet.country,
            postalCode: outlet.postal_code,
            phone: outlet.phone,
            email: outlet.email,
            gstin: outlet.gstin,
            fssaiNumber: outlet.fssai_number,
            panNumber: outlet.pan_number,
            timezone: outlet.timezone,
            isActive: !!outlet.is_active,
            createdAt: outlet.created_at,
            updatedAt: outlet.updated_at,
          }
        : null,
      subscription: {
        status: subscription.status,
        subscriptionStart: subscription.subscription_start,
        subscriptionEnd: subscription.subscription_end,
        gracePeriodEnd: subscription.grace_period_end,
        isSuspended: subscription.isBlocked,
        isBlocked: subscription.isBlocked,
        graceDaysRemaining: subscription.graceDaysRemaining,
        autoRenew: subscription.auto_renew,
        pricingSource: subscription.pricing_source || 'global',
        lastPaymentAt: subscription.pricingInfo?.paidAt || null,
        paymentStatus: subscription.pricingInfo?.paymentStatus || null,
        notes: subscription.notes || null,
        createdAt: subscription.created_at,
        updatedAt: subscription.updated_at,
      },
      pricing: {
        current: subscription.pricingInfo
          ? {
              basePrice: subscription.pricingInfo.basePrice,
              gstPercentage: subscription.pricingInfo.gstPercentage,
              totalAmount: subscription.pricingInfo.totalAmount,
              pricingSource: subscription.pricingInfo.pricingSource,
              paidAt: subscription.pricingInfo.paidAt,
              paymentStatus: subscription.pricingInfo.paymentStatus,
            }
          : null,
        nextRenewal: subscription.nextRenewalPricing || currentPricing
          ? {
              basePrice: subscription.nextRenewalPricing?.basePrice ?? currentPricing?.basePrice ?? null,
              gstPercentage: subscription.nextRenewalPricing?.gstPercentage ?? currentPricing?.gstPercentage ?? null,
              totalPrice: subscription.nextRenewalPricing?.totalPrice ?? currentPricing?.totalPrice ?? null,
              source: subscription.nextRenewalPricing?.source ?? currentPricing?.source ?? 'global',
            }
          : null,
      },
    });
  } catch (error) {
    logger.error('syncOfflineSubscription error:', error);
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: 'Failed to sync subscription: ' + error.message,
    });
  }
};

// ─── OFFLINE POS FIRST-TIME ACTIVATION ──────────────────────────────────────

/**
 * POST /api/v1/subscriptions/activate-offline
 * Offline POS — first-time activation via licenseId + activationKey (no JWT).
 * Validates token, activates outlet if inactive, returns full A-to-Z configuration.
 * One-time use: after successful activation the token is marked used and cannot replay.
 */
const activateOfflineOutlet = async (req, res) => {
  try {
    const { licenseId, activationKey } = req.body;

    if (!licenseId || !activationKey) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_CREDENTIALS',
        message: 'licenseId and activationKey are required',
      });
    }

    const pool = getPool();

    // ─── 1. Validate activation token against token_generation_log ────────────
    const activationHash = crypto
      .createHash('sha256')
      .update(String(activationKey))
      .digest('hex');

    const [tokenRows] = await pool.query(
      `SELECT id, license_id, outlet_id, token_type, plan, restaurant_name, email,
              subscription_expiry, device_hash, used_at, created_at
       FROM token_generation_log
       WHERE license_id = ? AND token_hash = ? AND token_type = 'offline_activation'
       ORDER BY created_at DESC LIMIT 1`,
      [String(licenseId).trim(), activationHash]
    );

    let tokenRecord = null;
    if (tokenRows.length) {
      tokenRecord = tokenRows[0];
    } else {
      // Fallback: activationKey might be the hash itself
      const [hashRows] = await pool.query(
        `SELECT id, license_id, outlet_id, token_type, plan, restaurant_name, email,
                subscription_expiry, device_hash, used_at, created_at
         FROM token_generation_log
         WHERE license_id = ? AND token_hash = ? AND token_type = 'offline_activation'
         ORDER BY created_at DESC LIMIT 1`,
        [String(licenseId).trim(), String(activationKey).trim()]
      );
      if (hashRows.length) tokenRecord = hashRows[0];
    }

    if (!tokenRecord) {
      logger.warn(`[ActivateOffline] Invalid credentials: license ${licenseId}`);
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid licenseId or activationKey',
      });
    }

    // ─── 2. Replay protection: one-time activation ───────────────────────────
    if (tokenRecord.used_at) {
      logger.warn(`[ActivateOffline] Replay blocked: token already used at ${tokenRecord.used_at}`);
      return res.status(409).json({
        success: false,
        code: 'ALREADY_ACTIVATED',
        message: 'This activation key has already been used',
        activatedAt: tokenRecord.used_at,
      });
    }

    // ─── 3. Derive outletId from token record ────────────────────────────────
    const parsedOutletId = parseInt(tokenRecord.outlet_id, 10);
    if (!parsedOutletId || parsedOutletId <= 0) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_OUTLET_ID',
        message: 'Token is not linked to a valid outlet',
      });
    }

    // ─── 4. Decode token payload for embedded config ──────────────────────────
    let tokenPayload = null;
    try {
      const [payloadB64] = String(activationKey).split('.');
      if (payloadB64) {
        tokenPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      }
    } catch (_) { /* ignore decode errors */ }

    // ─── 5. Fetch outlet and activate if inactive ───────────────────────────────
    const [outletRows] = await pool.query(
      `SELECT id, uuid, code, name, legal_name, outlet_type,
              address_line1, address_line2, city, state, country, postal_code,
              phone, email, website, gstin, fssai_number, pan_number,
              logo_url, currency_code, timezone, opening_time, closing_time, is_24_hours,
              default_tax_group_id, invoice_prefix, kot_prefix, settings,
              is_active, created_at, updated_at
       FROM outlets WHERE id = ?`,
      [parsedOutletId]
    );

    if (!outletRows.length) {
      return res.status(404).json({
        success: false,
        code: 'OUTLET_NOT_FOUND',
        message: 'Outlet linked to this token was not found',
      });
    }

    const outlet = outletRows[0];

    // Activate outlet if currently inactive
    if (!outlet.is_active) {
      await pool.query(
        `UPDATE outlets SET is_active = TRUE, updated_at = NOW() WHERE id = ?`,
        [parsedOutletId]
      );
      outlet.is_active = 1;
    }

    // ─── 6. Fetch subscription ────────────────────────────────────────────────
    const subscription = await subscriptionService.getMySubscription(parsedOutletId);

    if (!subscription) {
      return res.status(404).json({
        success: false,
        code: 'SUBSCRIPTION_NOT_FOUND',
        message: 'No subscription found for this outlet',
      });
    }

    // ─── 7. Resolve pricing ───────────────────────────────────────────────────
    let currentPricing = null;
    try {
      currentPricing = await subscriptionService.resolveOutletPricing(parsedOutletId);
    } catch (_) { /* no pricing configured */ }

    // ─── 8. Mark token as used (replay protection) ─────────────────────────────
    await pool.query(
      `UPDATE token_generation_log SET used_at = NOW() WHERE id = ?`,
      [tokenRecord.id]
    );

    // ─── 9. Build A-to-Z response ─────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      code: 'ACTIVATION_SUCCESS',
      message: 'Offline outlet activated successfully',
      license: {
        licenseId: tokenRecord.license_id,
        plan: tokenRecord.plan || 'pro',
        type: 'offline_annual',
        maxOutlets: tokenPayload?.maxOutlets || 1,
        maxUsers: tokenPayload?.maxUsers || -1,
        modules: tokenPayload?.modules || {
          captain: true,
          inventory: true,
          advancedReports: true,
        },
      },
      admin: {
        email: tokenRecord.email || tokenPayload?.email || null,
        phone: tokenRecord.phone || tokenPayload?.phone || null,
        restaurant: tokenRecord.restaurant_name || tokenPayload?.restaurant || null,
      },
      outlet: {
        id: outlet.id,
        uuid: outlet.uuid,
        code: outlet.code,
        name: outlet.name,
        legalName: outlet.legal_name,
        type: outlet.outlet_type,
        addressLine1: outlet.address_line1,
        addressLine2: outlet.address_line2,
        city: outlet.city,
        state: outlet.state,
        country: outlet.country,
        postalCode: outlet.postal_code,
        phone: outlet.phone,
        email: outlet.email,
        website: outlet.website,
        gstin: outlet.gstin,
        fssaiNumber: outlet.fssai_number,
        panNumber: outlet.pan_number,
        logoUrl: outlet.logo_url,
        currencyCode: outlet.currency_code,
        timezone: outlet.timezone,
        openingTime: outlet.opening_time,
        closingTime: outlet.closing_time,
        is24Hours: !!outlet.is_24_hours,
        defaultTaxGroupId: outlet.default_tax_group_id,
        invoicePrefix: outlet.invoice_prefix,
        kotPrefix: outlet.kot_prefix,
        settings: outlet.settings ? (typeof outlet.settings === 'string' ? JSON.parse(outlet.settings) : outlet.settings) : null,
        isActive: !!outlet.is_active,
        createdAt: outlet.created_at,
        updatedAt: outlet.updated_at,
      },
      subscription: {
        status: subscription.status,
        subscriptionStart: subscription.subscription_start,
        subscriptionEnd: subscription.subscription_end,
        gracePeriodEnd: subscription.grace_period_end,
        isSuspended: subscription.isBlocked,
        isBlocked: subscription.isBlocked,
        graceDaysRemaining: subscription.graceDaysRemaining,
        autoRenew: subscription.auto_renew,
        pricingSource: subscription.pricing_source || 'global',
        lastPaymentAt: subscription.pricingInfo?.paidAt || null,
        paymentStatus: subscription.pricingInfo?.paymentStatus || null,
        notes: subscription.notes || null,
        createdAt: subscription.created_at,
        updatedAt: subscription.updated_at,
      },
      pricing: {
        current: subscription.pricingInfo
          ? {
              basePrice: subscription.pricingInfo.basePrice,
              gstPercentage: subscription.pricingInfo.gstPercentage,
              totalAmount: subscription.pricingInfo.totalAmount,
              pricingSource: subscription.pricingInfo.pricingSource,
              paidAt: subscription.pricingInfo.paidAt,
              paymentStatus: subscription.pricingInfo.paymentStatus,
            }
          : null,
        nextRenewal: subscription.nextRenewalPricing || currentPricing
          ? {
              basePrice: subscription.nextRenewalPricing?.basePrice ?? currentPricing?.basePrice ?? null,
              gstPercentage: subscription.nextRenewalPricing?.gstPercentage ?? currentPricing?.gstPercentage ?? null,
              totalPrice: subscription.nextRenewalPricing?.totalPrice ?? currentPricing?.totalPrice ?? null,
              source: subscription.nextRenewalPricing?.source ?? currentPricing?.source ?? 'global',
            }
          : null,
      },
      tokenMeta: {
        generatedAt: tokenRecord.created_at,
        deviceHash: tokenRecord.device_hash || null,
        subscriptionExpiry: tokenRecord.subscription_expiry || null,
        activatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('activateOfflineOutlet error:', error);
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: 'Failed to activate offline outlet: ' + error.message,
    });
  }
};

module.exports = {
  getPricing,
  setPricing,
  getAllSubscriptions,
  activateSubscription,
  deactivateSubscription,
  extendSubscription,
  getMySubscription,
  createPaymentOrder,
  verifyPayment,
  razorpayWebhook,
  scanSubscriptions,
  // Hierarchical pricing
  resolveOutletPricing,
  getAllSuperAdminPricings,
  getSuperAdminPricing,
  setSuperAdminPricing,
  removeSuperAdminPricing,
  getOutletPricingOverride,
  setOutletPricingOverride,
  removeOutletPricingOverride,
  // Super Admin dashboard
  getSuperAdminDashboard,
  // Offline POS sync
  syncOfflineSubscription,
  // Offline POS first-time activation
  activateOfflineOutlet,
};
