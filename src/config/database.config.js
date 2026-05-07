const isProduction = process.env.NODE_ENV === 'production';

/**
 * Database config — tuned for 100-200 outlets at rush hour
 *
 * Connection math for 100-200 outlets (rush = ~1,000 req/s):
 *   6 API workers  × 20 conn = 120
 *   2 Queue workers × 8 conn =  16
 *   Internal/tools/misc         =  20
 *   Total                       = 156 (safe under MySQL max_connections=300)
 *
 * MySQL MUST have:
 *   max_connections = 300
 *   innodb_buffer_pool_size = 4G (or 70% of RAM)
 *   wait_timeout = 600
 *   innodb_io_capacity = 2000 (SSD)
 *
 * Pool tuning:
 *   connectionLimit: 20 per worker (from DB_CONNECTION_LIMIT env)
 *   acquireTimeout: 3000ms — fail fast when pool exhausted (prevents cascade hangs)
 *   queueLimit: 200 — queue short bursts, reject sustained overload
 *   idleTimeout: 60000 — release idle connections after 1 min (low traffic relief)
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
  // CRITICAL: radix must be 10 (decimal), NOT 100. 100 is invalid radix → NaN → fallback 10.
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 20,
  waitForConnections: true,
  queueLimit: parseInt(process.env.DB_QUEUE_LIMIT, 10) || 200,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  idleTimeout: 60000,
  connectTimeout: 10000,
  acquireTimeout: 3000,          // fail fast — don't hang requests when pool is full
  timezone: '+00:00',
  dateStrings: true,
  multipleStatements: false,
  charset: 'utf8mb4',
};
