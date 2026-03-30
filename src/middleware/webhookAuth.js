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
 * Rate limiting for webhooks
 * Prevents abuse and DoS
 */
const webhookRateLimit = (() => {
  const requests = new Map();
  const WINDOW_MS = 60000; // 1 minute
  const MAX_REQUESTS = 100; // per window

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();

    // Clean old entries
    for (const [ip, data] of requests.entries()) {
      if (now - data.windowStart > WINDOW_MS) {
        requests.delete(ip);
      }
    }

    // Check rate
    const current = requests.get(key);
    if (current) {
      if (now - current.windowStart < WINDOW_MS) {
        current.count++;
        if (current.count > MAX_REQUESTS) {
          logger.warn('Webhook rate limit exceeded', { ip: key, count: current.count });
          return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded'
          });
        }
      } else {
        requests.set(key, { windowStart: now, count: 1 });
      }
    } else {
      requests.set(key, { windowStart: now, count: 1 });
    }

    next();
  };
})();

/**
 * Simplified webhook verification for Dyno endpoints
 * 
 * Dyno webhooks don't send signature headers by default.
 * This middleware validates requests by:
 * 1. Checking if resId in payload matches a registered channel
 * 2. Optionally verifying signature if headers are present
 * 3. Allowing access token authentication as fallback
 */
const verifyDynoWebhookSimple = async (req, res, next) => {
  try {
    const signature = req.headers['x-dyno-signature'];
    const timestamp = req.headers['x-dyno-timestamp'];
    
    // Extract resId from various possible locations in the request
    // Dyno sends: { orders: [{ resId: "489654", ... }] }
    const resId = req.params.resId || 
                  req.body?.res_id || 
                  req.body?.restaurant_id || 
                  req.body?.property_id ||
                  req.body?.orders?.[0]?.resId ||
                  req.body?.orders?.[0]?.res_id;

    const { getPool } = require('../database');
    const pool = getPool();

    // Method 1: Validate by resId (primary method for Dyno webhooks)
    // If the request contains a valid resId that matches a registered channel, allow it
    if (resId) {
      const [channels] = await pool.query(
        `SELECT * FROM integration_channels WHERE property_id = ? AND is_active = 1`,
        [resId]
      );
      
      if (channels.length > 0) {
        logger.info('Dyno webhook: Authenticated via resId', { 
          resId, 
          channelId: channels[0].id,
          channelName: channels[0].channel_name 
        });
        req.webhookVerified = true;
        req.webhookChannel = channels[0];
        return next();
      }
    }

    // Method 2: Check for access token in headers
    const accessToken = req.headers['authorization']?.replace('Bearer ', '') || 
                        req.headers['x-access-token'] ||
                        req.headers['x-dyno-access-token'];
    
    if (accessToken) {
      const [channels] = await pool.query(
        `SELECT * FROM integration_channels WHERE dyno_access_token = ? AND is_active = 1`,
        [accessToken]
      );
      
      if (channels.length > 0) {
        logger.info('Dyno webhook: Authenticated via access token', { 
          channelId: channels[0].id 
        });
        req.webhookVerified = true;
        req.webhookChannel = channels[0];
        return next();
      }
    }

    // Method 3: Verify signature if headers are present
    if (signature && timestamp) {
      // Check timestamp freshness (5 minute window)
      const now = Math.floor(Date.now() / 1000);
      const webhookTime = parseInt(timestamp, 10);
      
      if (isNaN(webhookTime) || Math.abs(now - webhookTime) > 300) {
        return res.status(401).json({
          success: false,
          error: 'Webhook timestamp expired'
        });
      }

      // Get webhook secret from environment
      const webhookSecret = process.env.DYNO_WEBHOOK_SECRET;

      if (webhookSecret) {
        // Verify signature
        const payload = JSON.stringify(req.body);
        const signatureData = `${timestamp}.${payload}`;
        const expectedSignature = crypto
          .createHmac('sha256', webhookSecret)
          .update(signatureData)
          .digest('hex');

        let isValid = false;
        try {
          isValid = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
          );
        } catch (err) {
          isValid = false;
        }

        if (isValid) {
          logger.info('Dyno webhook: Authenticated via signature');
          req.webhookVerified = true;
          req.webhookTimestamp = webhookTime;
          return next();
        }
      }
    }

    // Method 4: Development mode bypass
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('Dyno webhook: Development mode - allowing unauthenticated request', {
        path: req.path,
        resId,
        ip: req.ip
      });
      req.webhookVerified = false;
      return next();
    }

    // No valid authentication found
    logger.warn('Dyno webhook: Authentication failed', {
      path: req.path,
      resId,
      hasSignature: !!signature,
      hasAccessToken: !!accessToken,
      ip: req.ip
    });

    return res.status(401).json({
      success: false,
      error: 'Authentication required. Ensure resId matches a registered channel or provide valid access token.'
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
  webhookRateLimit
};
