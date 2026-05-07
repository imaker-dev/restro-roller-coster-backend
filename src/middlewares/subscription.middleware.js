/**
 * Subscription Check Middleware
 *
 * Fast outlet subscription validation — Redis-first with 5-min TTL.
 * Called by auth.middleware.js AFTER successful authentication.
 *
 * Skips:
 *   - master users (platform admin bypass)
 *   - routes under /subscriptions/* (payment flow must work)
 *   - public/unauthenticated requests
 *
 * Returns 403 when subscription expired AND grace period ended.
 * Adds X-Subscription-Grace-Days header during grace period.
 */

const { getSubscriptionStatus } = require('../services/subscription.service');
const logger = require('../utils/logger');

// Routes that should skip subscription check (exact prefixes)
const SKIP_PATH_PREFIXES = [
  '/api/v1/subscriptions',
  '/api/v1/auth',
  '/api/v1/health',
  '/api/v1/upgrade-payment',
  '/api/v1/token-generation',
  '/api/v1/registration',
  '/sentry-debug',
  '/test-hook',
  '/ws-debug',
];

const shouldSkip = (originalUrl) => {
  if (!originalUrl) return true;
  return SKIP_PATH_PREFIXES.some((prefix) => originalUrl.startsWith(prefix));
};

/**
 * Check subscription for the current request.
 * Called from auth.middleware.js after req.user is set.
 *
 * @param {object} req — Express request (must have req.user)
 * @param {object} res — Express response
 * @returns {Promise<{blocked:boolean, status:string, graceDays:number|null, responseSent:boolean}>}
 */
const checkSubscription = async (req, res) => {
  // No user → skip (auth will handle)
  if (!req.user) {
    return { blocked: false, status: null, graceDays: null, responseSent: false };
  }

  // Master bypass
  if (req.user.roles?.includes('master')) {
    return { blocked: false, status: null, graceDays: null, responseSent: false };
  }

  // Skip subscription routes and public paths
  if (shouldSkip(req.originalUrl)) {
    return { blocked: false, status: null, graceDays: null, responseSent: false };
  }

  // Determine target outlet
  const outletId = req.user.outletId || parseInt(req.params.outletId, 10) || parseInt(req.query.outletId, 10) || null;
  if (!outletId) {
    return { blocked: false, status: null, graceDays: null, responseSent: false };
  }

  try {
    const sub = await getSubscriptionStatus(outletId);

    // During grace period: allow but add header
    if (sub.status === 'grace_period' && sub.graceDaysRemaining > 0) {
      res.setHeader('X-Subscription-Status', 'grace_period');
      res.setHeader('X-Subscription-Grace-Days', sub.graceDaysRemaining);
      return { blocked: false, status: sub.status, graceDays: sub.graceDaysRemaining, responseSent: false };
    }

    // Hard stop
    if (sub.isBlocked) {
      res.status(403).json({
        success: false,
        code: 'SUBSCRIPTION_EXPIRED',
        message: 'Your subscription has expired. Please renew to continue using the system.',
        renewUrl: '/api/v1/subscriptions/create-order',
        status: sub.status,
        graceDaysRemaining: sub.graceDaysRemaining,
      });
      return { blocked: true, status: sub.status, graceDays: sub.graceDaysRemaining, responseSent: true };
    }

    // Active / trial → add header for client awareness
    res.setHeader('X-Subscription-Status', sub.status);
    if (sub.subscriptionEnd) {
      res.setHeader('X-Subscription-End', sub.subscriptionEnd);
    }

    return { blocked: false, status: sub.status, graceDays: null, responseSent: false };
  } catch (error) {
    // Fail open on cache/DB errors — don't block users due to infra issues
    logger.error(`Subscription check failed for outlet ${outletId}:`, error.message);
    return { blocked: false, status: null, graceDays: null, responseSent: false };
  }
};

module.exports = {
  checkSubscription,
};
