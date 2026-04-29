const isProduction = process.env.NODE_ENV === 'production';

/**
 * Database config — optimized for PM2 cluster mode (multiple workers share MySQL)
 *
 * connectionLimit per worker (set via PM2 env DB_CONNECTION_LIMIT):
 *   Production: 15 per API worker (6 × 15 = 90 total)
 *   Queue: 8 per worker (2 × 8 = 16 total)
 *   Fallback: 15 (safe default — old value of 100 caused DB exhaustion)
 *
 * idleTimeout: release unused connections after 60s to free pool under low traffic.
 * queueLimit: cap waiting requests at 200 to fail fast instead of hanging.
 */
module.exports = {
  host: isProduction 
    ? (process.env.PROD_DB_HOST || '127.0.0.1')
    : (process.env.DB_HOST || 'localhost'),
  port: parseInt(process.env.DB_PORT, 10) || 3306,
  database: isProduction
    ? (process.env.PROD_DB_NAME || 'restro')
    : (process.env.DB_NAME || 'restro'),
  user: isProduction
    ? (process.env.PROD_DB_USER || 'restro')
    : (process.env.DB_USER || 'root'),
  password: isProduction
    ? (process.env.PROD_DB_PASSWORD || '')
    : (process.env.DB_PASSWORD || ''),
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 10,
  waitForConnections: true,
  queueLimit: 100,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  idleTimeout: 30000,
  connectTimeout: 10000,
  timezone: '+00:00',
  dateStrings: true,
  multipleStatements: false,
  charset: 'utf8mb4',
};
