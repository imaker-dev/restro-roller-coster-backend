/**
 * Report Cache Middleware
 * Redis-based caching layer for report endpoints.
 * Falls back gracefully when Redis is unavailable.
 *
 * TTL tiers:
 *   - live/dashboard endpoints: 30 seconds
 *   - historical/date-range reports: 300 seconds (5 min)
 *   - detail/paginated reports: 120 seconds (2 min)
 */

const { cache } = require('../config/redis');
const crypto = require('crypto');

/**
 * Build a deterministic cache key from request params.
 * Format: report:<outletId>:<tag>:<hash>
 */
function buildKey(req, tag) {
  const outletId = req.query.outletId || req.params.outletId || '0';
  const userId = req.user?.userId || '0';
  const params = { ...req.query, ...req.params };
  // Remove non-deterministic fields
  delete params.outletId;
  const sorted = JSON.stringify(params, Object.keys(params).sort());
  const hash = crypto.createHash('md5').update(sorted).digest('hex').slice(0, 12);
  return `report:${outletId}:${tag}:u${userId}:${hash}`;
}

/**
 * Express middleware factory for caching report responses.
 *
 * @param {string} tag   - short identifier, e.g. 'daily-sales', 'dashboard'
 * @param {number} ttl   - cache TTL in seconds (default 300)
 */
function reportCache(tag, ttl = 300) {
  return async (req, res, next) => {
    const key = buildKey(req, tag);

    try {
      const cached = await cache.get(key);
      if (cached) {
        return res.status(200).json(cached);
      }
    } catch (_) {
      // Redis down — proceed without cache
    }

    // Monkey-patch res.json to capture the response and cache it
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only cache successful responses
      if (res.statusCode === 200 && body && body.success !== false) {
        cache.set(key, body, ttl).catch(() => {});
      }
      return originalJson(body);
    };

    next();
  };
}

/**
 * Invalidate all report caches for a given outlet.
 * Call this after order create/update/cancel, payment, etc.
 *
 * @param {number|string} outletId
 */
async function invalidateReportCache(outletId) {
  if (!outletId) return;
  try {
    await cache.delPattern(`report:${outletId}:*`);
  } catch (_) {
    // Redis down — nothing to invalidate
  }
}

module.exports = { reportCache, invalidateReportCache };
