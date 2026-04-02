const isProduction = process.env.NODE_ENV === 'production';

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
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 100,
  pool: {
    min: parseInt(process.env.DB_POOL_MIN, 10) || 5,
    max: parseInt(process.env.DB_POOL_MAX, 10) || 50,
  },
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: '+00:00',
  dateStrings: true,
  multipleStatements: false,
  charset: 'utf8mb4',
};
