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
 * Dyno rate limiting middleware - Cache-based (NO 429)
 * 
 * IMPORTANT: Never return 429 to Dyno - it causes aggressive retries!
 * Always return 200 with valid/cached response.
 * 
 * Layer 1: Response cache (1 minute) - return cached valid response
 * Layer 2: In-progress deduplication - prevent duplicate execution
 */
const dynoRateLimit = (() => {
  const responseCache = new Map(); // key -> { response, timestamp }
  const inProgress = new Map();    // key -> Promise (for deduplication)
  
  const CACHE_WINDOW_MS = 60000;   // 1 minute cache

  // Default valid responses for each endpoint type (Dyno expected format)
  const getDefaultResponse = (endpointType) => {
    if (endpointType === 'categories' || endpointType === 'items') {
      // Dyno ItemStockUpdate format
      return { status: 200, message: 'Stock Updated Successfully' };
    }
    // Dyno OrderStatusResponse format
    return { orderHistory: false, orders: [] };
  };

  return (req, res, next) => {
    const resId = req.params.resId;
    if (!resId) {
      return next();
    }

    // Determine endpoint type
    const url = req.originalUrl;
    const endpointType = url.includes('/categories') ? 'categories' : 
                         url.includes('/items') ? 'items' : 'status';
    const key = `${resId}:${endpointType}`;
    const now = Date.now();

    // ========================================
    // LAYER 1: Response cache (1 minute)
    // Always return 200 - NEVER 429
    // ========================================
    const cached = responseCache.get(key);
    if (cached && (now - cached.timestamp) < CACHE_WINDOW_MS) {
      // Return cached response (always 200)
      return res.json(cached.response);
    }

    // ========================================
    // LAYER 2: In-progress deduplication
    // ========================================
    if (inProgress.has(key)) {
      // Another request is processing - wait for it or return default
      const pendingPromise = inProgress.get(key);
      pendingPromise
        .then(response => res.json(response))
        .catch(() => res.json(getDefaultResponse(endpointType)));
      return;
    }

    // First request in this window - process it
    let resolvePromise;
    const promise = new Promise(resolve => { resolvePromise = resolve; });
    inProgress.set(key, promise);

    // Intercept response to cache it
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      // Cache this valid response
      responseCache.set(key, { response: data, timestamp: now });
      // Resolve promise for any waiting requests
      resolvePromise(data);
      // Clean up
      inProgress.delete(key);
      logger.info(`dynoRateLimit: Processed & cached ${key}`);
      return originalJson(data);
    };

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
