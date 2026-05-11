module.exports = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB, 10) || 0,
  keyPrefix: 'restro:',
  // Deployment namespace — isolates pub/sub channels and Socket.IO adapter keys
  // when multiple deployments share the same Redis server (e.g. demo + prod)
  namespace: process.env.REDIS_NAMESPACE || '',
  retryDelayMs: 100,
  maxRetries: 3,
  connectTimeout: 10000,
  lazyConnect: true,
  enableReadyCheck: true,
  enableOfflineQueue: true,
};
