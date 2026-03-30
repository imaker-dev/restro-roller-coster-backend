/**
 * Webhook Authentication Middleware
 * Verifies Dyno API webhook signatures and prevents replay attacks
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const dynoService = require('../services/dyno.service');

/**
 * Verify Dyno webhook signature
 * Checks HMAC-SHA256 signature and timestamp freshness
 */
const verifyDynoWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-dyno-signature'];
    const timestamp = req.headers['x-dyno-timestamp'];
    const channelId = req.headers['x-dyno-channel-id'] || req.body?.channel_id;

    // Check required headers
    if (!signature || !timestamp) {
      logger.warn('Webhook missing signature or timestamp', {
        hasSignature: !!signature,
        hasTimestamp: !!timestamp,
        ip: req.ip
      });
      return res.status(401).json({
        success: false,
        error: 'Missing webhook signature or timestamp'
      });
    }

    // Check timestamp freshness (5 minute window)
    const now = Math.floor(Date.now() / 1000);
    const webhookTime = parseInt(timestamp, 10);
    
    if (isNaN(webhookTime) || Math.abs(now - webhookTime) > 300) {
      logger.warn('Webhook timestamp expired or invalid', {
        now,
        webhookTime,
        diff: now - webhookTime,
        ip: req.ip
      });
      return res.status(401).json({
        success: false,
        error: 'Webhook timestamp expired'
      });
    }

    // Get channel webhook secret
    let webhookSecret;
    
    if (channelId) {
      const channel = await dynoService.getChannelById(channelId);
      if (channel) {
        webhookSecret = channel.webhook_secret;
      }
    }

    // Fallback to environment variable
    if (!webhookSecret) {
      webhookSecret = process.env.DYNO_WEBHOOK_SECRET;
    }

    if (!webhookSecret) {
      logger.error('No webhook secret configured', { channelId });
      return res.status(500).json({
        success: false,
        error: 'Webhook verification not configured'
      });
    }

    // Verify signature
    const payload = JSON.stringify(req.body);
    const signatureData = `${timestamp}.${payload}`;
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(signatureData)
      .digest('hex');

    // Constant-time comparison
    let isValid = false;
    try {
      isValid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch (err) {
      // Buffer length mismatch
      isValid = false;
    }

    if (!isValid) {
      logger.warn('Invalid webhook signature', {
        channelId,
        ip: req.ip,
        received: signature?.substring(0, 10) + '...',
        expected: expectedSignature.substring(0, 10) + '...'
      });
      return res.status(401).json({
        success: false,
        error: 'Invalid webhook signature'
      });
    }

    // Attach verified info to request
    req.webhookVerified = true;
    req.webhookTimestamp = webhookTime;
    req.webhookChannelId = channelId;

    logger.info('Webhook signature verified', { channelId, ip: req.ip });
    next();

  } catch (error) {
    logger.error('Webhook verification error:', error);
    return res.status(500).json({
      success: false,
      error: 'Webhook verification failed'
    });
  }
};

/**
 * Optional IP allowlist check
 * Can be enabled for additional security
 */
const ipAllowlist = (allowedIps = []) => {
  return (req, res, next) => {
    if (!allowedIps || allowedIps.length === 0) {
      return next();
    }

    const clientIp = req.ip || 
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.connection.remoteAddress;

    if (!allowedIps.includes(clientIp)) {
      logger.warn('Webhook IP not in allowlist', { clientIp, allowedIps });
      return res.status(403).json({
        success: false,
        error: 'IP not allowed'
      });
    }

    next();
  };
};

/**
 * Rate limiting for Dyno webhooks
 * 
 * STRICT: 1 request per minute per resId for status/items/categories endpoints
 * This dramatically reduces server load from Dyno client exe polling every second
 * 
 * Order webhooks (POST /orders) are NOT rate limited - they're critical
 */
/**
 * Dyno rate limiting middleware - 1 request per minute per resId
 * 
 * MUST be applied AFTER route matching so req.params.resId is available
 * Use this on individual routes, not as router.use()
 */
const dynoRateLimit = (() => {
  const lastRequestTime = new Map(); // key -> timestamp
  const WINDOW_MS = 60000; // 1 minute

  return (req, res, next) => {
    const resId = req.params.resId;
    if (!resId) {
      return next(); // Can't rate limit without resId
    }

    // Determine endpoint type from path
    const path = req.path;
    const endpointType = path.includes('/categories') ? 'categories' : 
                         path.includes('/items') ? 'items' : 'status';
    const key = `${resId}:${endpointType}`;
    const now = Date.now();

    // Clean old entries periodically
    if (lastRequestTime.size > 500) {
      for (const [k, timestamp] of lastRequestTime.entries()) {
        if (now - timestamp > WINDOW_MS) {
          lastRequestTime.delete(k);
        }
      }
    }

    // Check if within rate limit window (1 request per minute per resId:endpoint)
    const lastTime = lastRequestTime.get(key);
    if (lastTime && (now - lastTime) < WINDOW_MS) {
      // Return 200 with cached flag - Dyno doesn't need to retry
      return res.json({
        status: 200,
        message: 'Request throttled - cached response',
        cached: true,
        nextAllowedIn: Math.ceil((WINDOW_MS - (now - lastTime)) / 1000)
      });
    }

    // First request in this window - allow it
    lastRequestTime.set(key, now);
    logger.info(`Dyno: Processing ${key} (next allowed in 60s)`);
    next();
  };
})();

/**
 * Simplified webhook verification for Dyno endpoints
 * 
 * Validates requests by checking if resId in payload matches a registered channel.
 * This is the primary authentication method for Dyno webhooks.
 */
const verifyDynoWebhookSimple = async (req, res, next) => {
  try {
    // Extract resId from URL params or request body
    // Dyno sends: { orders: [{ resId: "489654", ... }] }
    let resId = req.params.resId || 
                req.body?.orders?.[0]?.resId ||
                req.body?.orders?.[0]?.res_id ||
                req.body?.res_id || 
                req.body?.restaurant_id || 
                req.body?.property_id;

    // Convert to string for consistent comparison
    if (resId !== undefined && resId !== null) {
      resId = String(resId);
    }

    const { getPool } = require('../database');
    const pool = getPool();

    // Validate by resId (primary method for Dyno webhooks)
    if (resId && resId !== 'string' && resId !== 'undefined') {
      const [channels] = await pool.query(
        `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
        [resId]
      );
      
      if (channels.length > 0) {
        logger.debug('Dyno webhook: Authenticated', { 
          resId, 
          channelId: channels[0].id 
        });
        req.webhookVerified = true;
        req.webhookChannel = channels[0];
        return next();
      }
    }

    // Development mode bypass
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('Dyno webhook: Dev mode - allowing request', { path: req.path, resId });
      req.webhookVerified = false;
      return next();
    }

    // No valid authentication
    logger.warn('Dyno webhook: Auth failed', { path: req.path, resId, ip: req.ip });
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Ensure resId matches a registered channel.'
    });

  } catch (error) {
    logger.error('Dyno webhook verification error:', error);
    return res.status(500).json({
      success: false,
      error: 'Webhook verification failed'
    });
  }
};

module.exports = {
  verifyDynoWebhook,
  verifyDynoWebhookSimple,
  ipAllowlist,
  dynoRateLimit
};
