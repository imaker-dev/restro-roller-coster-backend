const mysql = require('mysql2/promise');
const dbConfig = require('../config/database.config');
const logger = require('../utils/logger');

let pool = null;

const initializeDatabase = async () => {
  pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    connectionLimit: dbConfig.connectionLimit,
    waitForConnections: dbConfig.waitForConnections,
    queueLimit: dbConfig.queueLimit,
    enableKeepAlive: dbConfig.enableKeepAlive,
    keepAliveInitialDelay: dbConfig.keepAliveInitialDelay,
    idleTimeout: dbConfig.idleTimeout,
    connectTimeout: dbConfig.connectTimeout,
    acquireTimeout: dbConfig.acquireTimeout,
    timezone: dbConfig.timezone,
    dateStrings: dbConfig.dateStrings,
    charset: dbConfig.charset,
  });

  // Test connection
  const connection = await pool.getConnection();
  await connection.ping();
  connection.release();

  logger.info('Database pool created successfully');
  return pool;
};

const getPool = () => {
  if (!pool) {
    throw new Error('Database pool not initialized');
  }
  return pool;
};

const query = async (sql, params = []) => {
  const [results] = await getPool().query(sql, params);
  return results;
};

const execute = async (sql, params = []) => {
  const [results] = await getPool().execute(sql, params);
  return results;
};

const getConnection = async () => {
  return getPool().getConnection();
};

const transaction = async (callback) => {
  const connection = await getConnection();
  await connection.beginTransaction();

  try {
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// Batch insert helper
const batchInsert = async (table, columns, rows, chunkSize = 1000) => {
  if (rows.length === 0) return [];

  const results = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ');
    const values = chunk.flat();
    
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`;
    const result = await execute(sql, values);
    results.push(result);
  }
  
  return results;
};

// Close pool
const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
};

module.exports = {
  initializeDatabase,
  getPool,
  query,
  execute,
  getConnection,
  transaction,
  batchInsert,
  closePool,
};
