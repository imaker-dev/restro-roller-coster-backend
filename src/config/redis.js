const Redis = require('ioredis');
const redisConfig = require('./redis.config');
const logger = require('../utils/logger');

let redisClient = null;
let redisSubscriber = null;
let redisAvailable = false;

const createRedisClient = (options = {}) => {
  const client = new Redis({
    host: redisConfig.host,
    port: redisConfig.port,
    password: redisConfig.password,
    db: redisConfig.db,
    keyPrefix: redisConfig.keyPrefix,
    retryStrategy: (times) => {
      if (times > redisConfig.maxRetries) {
        logger.error('Redis max retries reached');
        return null;
      }
      return Math.min(times * redisConfig.retryDelayMs, 3000);
    },
    ...options,
  });

  client.on('error', (err) => {
    logger.error('Redis error:', err);
  });

  client.on('connect', () => {
    logger.info('Redis connected');
  });

  client.on('close', () => {
    logger.warn('Redis connection closed');
  });

  return client;
};

const initializeRedis = async () => {
  try {
    redisClient = createRedisClient();
    redisSubscriber = createRedisClient({ keyPrefix: '' });
    // socket.js subscribes 9+ channels — each adds a 'message' listener;
    // default limit is 10, so bump to unlimited on this shared subscriber
    redisSubscriber.setMaxListeners(0);

    await redisClient.ping();
    redisAvailable = true;
    return { redisClient, redisSubscriber, available: true };
  } catch (error) {
    logger.warn('Redis not available - running without cache/pubsub features');
    logger.warn('To enable Redis, run: docker-compose -f docker-compose.dev.yml up -d redis');
    redisAvailable = false;
    return { redisClient: null, redisSubscriber: null, available: false };
  }
};

const isRedisAvailable = () => redisAvailable;

const getRedisClient = () => {
  if (!redisClient || !redisAvailable) {
    return null;
  }
  return redisClient;
};

const getRedisSubscriber = () => {
  if (!redisSubscriber || !redisAvailable) {
    return null;
  }
  return redisSubscriber;
};

// Cache helpers (gracefully handle when Redis is not available)
const cache = {
  async get(key) {
    if (!redisAvailable || !redisClient) return null;
    try {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.warn('Cache get failed:', error.message);
      return null;
    }
  },

  async set(key, value, ttlSeconds = 3600) {
    if (!redisAvailable || !redisClient) return;
    try {
      await redisClient.setex(key, ttlSeconds, JSON.stringify(value));
    } catch (error) {
      logger.warn('Cache set failed:', error.message);
    }
  },

  async del(key) {
    if (!redisAvailable || !redisClient) return;
    try {
      await redisClient.del(key);
    } catch (error) {
      logger.warn('Cache del failed:', error.message);
    }
  },

  async delPattern(pattern) {
    if (!redisAvailable || !redisClient) return;
    try {
      let cursor = '0';
      const fullPattern = `${redisConfig.keyPrefix}${pattern}`;
      do {
        const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          const pipeline = redisClient.pipeline();
          keys.forEach((key) => pipeline.del(key.replace(redisConfig.keyPrefix, '')));
          await pipeline.exec();
        }
      } while (cursor !== '0');
    } catch (error) {
      logger.warn('Cache delPattern failed:', error.message);
    }
  },

  async flush() {
    if (!redisAvailable || !redisClient) return;
    try {
      await redisClient.flushdb();
    } catch (error) {
      logger.warn('Cache flush failed:', error.message);
    }
  },
};

// Build namespaced channel name so multiple deployments can share one Redis
const _nsChannel = (channel) => redisConfig.namespace ? `${redisConfig.namespace}:${channel}` : channel;

// Pub/Sub helpers (gracefully handle when Redis is not available)
const pubsub = {
  async publish(channel, message) {
    if (!redisAvailable || !redisClient) return;
    try {
      await redisClient.publish(_nsChannel(channel), JSON.stringify(message));
    } catch (error) {
      logger.warn('Pubsub publish failed:', error.message);
    }
  },

  subscribe(channel, callback) {
    if (!redisAvailable || !redisSubscriber) return;
    const nsChannel = _nsChannel(channel);
    try {
      redisSubscriber.subscribe(nsChannel);
      redisSubscriber.on('message', (ch, message) => {
        if (ch === nsChannel) {
          callback(JSON.parse(message));
        }
      });
    } catch (error) {
      logger.warn('Pubsub subscribe failed:', error.message);
    }
  },

  unsubscribe(channel) {
    if (!redisAvailable || !redisSubscriber) return;
    try {
      redisSubscriber.unsubscribe(_nsChannel(channel));
    } catch (error) {
      logger.warn('Pubsub unsubscribe failed:', error.message);
    }
  },
};

// Local Socket.IO emitter fallback (registered by socket.js after init)
let _localEmitter = null;
const registerLocalEmitter = (emitterFn) => {
  _localEmitter = emitterFn;
};

// Debounce map for high-frequency socket events (prevents flooding at 1000+ tables)
// Key: "channel:outletId:entityId" → Value: { timer, message }
const _debounceMap = new Map();
const DEBOUNCE_CHANNELS = new Set(['order:update', 'table:update', 'kot:update']);
const DEBOUNCE_MS = 200;

const _getDebounceKey = (channel, message) => {
  const outletId = message.outletId || '';
  const entityId = message.orderId || message.tableId || message.kotId || '';
  return `${channel}:${outletId}:${entityId}`;
};

const _doPublish = async (channel, message) => {
  if (redisAvailable && redisClient) {
    return pubsub.publish(channel, message);
  }
  if (_localEmitter) {
    const delivered = _localEmitter(channel, message);
    if (delivered) {
      logger.debug(`publishMessage: delivered '${channel}' via local emitter (Redis unavailable)`);
    }
    return;
  }
  logger.warn(`publishMessage: dropped '${channel}' — Redis unavailable and no local emitter registered`);
};

// Helper alias for services — falls back to local emit when Redis is down
// High-frequency channels are debounced (200ms) to prevent socket flooding
const publishMessage = async (channel, message) => {
  // Non-debounced channels → emit immediately
  if (!DEBOUNCE_CHANNELS.has(channel)) {
    return _doPublish(channel, message);
  }

  // Debounced channels → coalesce rapid-fire events
  const key = _getDebounceKey(channel, message);
  const existing = _debounceMap.get(key);
  if (existing) {
    clearTimeout(existing.timer);
  }
  _debounceMap.set(key, {
    message,
    timer: setTimeout(async () => {
      _debounceMap.delete(key);
      await _doPublish(channel, message);
    }, DEBOUNCE_MS),
  });
};

// Close all Redis connections (graceful shutdown)
const closeRedis = async () => {
  try {
    if (redisSubscriber) {
      await redisSubscriber.quit();
      redisSubscriber = null;
    }
    if (redisClient) {
      await redisClient.quit();
      redisClient = null;
    }
    redisAvailable = false;
    logger.info('Redis connections closed');
  } catch (error) {
    logger.warn('Redis close error:', error.message);
  }
};

module.exports = {
  initializeRedis,
  getRedisClient,
  getRedisSubscriber,
  isRedisAvailable,
  cache,
  pubsub,
  publishMessage,
  registerLocalEmitter,
  closeRedis,
};
