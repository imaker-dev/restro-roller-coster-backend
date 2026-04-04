require('dotenv').config();

// IMPORTANT: OpenTelemetry/SigNoz tracing must be imported FIRST, before any other modules
// This ensures all HTTP, DB, and Redis calls are properly instrumented
// require('./tracing');

// Sentry for error monitoring (after tracing)
const Sentry = require('./instrument');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const http = require('http');

const config = require('./config');
const logger = require('./utils/logger');
const { initializeDatabase } = require('./database');
const { initializeRedis, registerLocalEmitter } = require('./config/redis');
const { initializeSocket, emitLocal } = require('./config/socket');
const { initializeQueues } = require('./queues');
const { initializeCronJobs } = require('./cron');

const app = express();

// Trust first proxy (NGINX) — required for correct client IP behind reverse proxy
app.set('trust proxy', 1);

const server = http.createServer(app);

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS — handle preflight OPTIONS for all routes
app.use(cors(config.cors));
app.options('*', cors(config.cors));

// Request parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression
app.use(compression());

// Response time header (X-Response-Time in ms)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  const origEnd = res.end;
  res.end = function (...args) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (!res.headersSent) {
      res.setHeader('X-Response-Time', `${ms.toFixed(2)}ms`);
    }
    return origEnd.apply(this, args);
  };
  next();
});

// Logging — use short format in production to reduce I/O at 1000+ tables
if (config.app.env !== 'test') {
  const morganFormat = config.app.env === 'production' ? 'short' : 'combined';
  app.use(morgan(morganFormat, { stream: logger.stream }));
}

// Serve uploaded files statically (with CORS headers)
const path = require('path');
app.use('/uploads', cors(config.cors), express.static(path.resolve(config.app.uploadPath || './uploads')));

// WebSocket diagnostic endpoint — shows what headers reach Node.js
app.get('/ws-debug', (req, res) => {
  const hdrs = req.headers;
  res.json({
    upgrade: hdrs.upgrade || null,
    connection: hdrs.connection || null,
    'sec-websocket-version': hdrs['sec-websocket-version'] || null,
    'sec-websocket-key': hdrs['sec-websocket-key'] || null,
    'x-forwarded-for': hdrs['x-forwarded-for'] || null,
    'x-forwarded-proto': hdrs['x-forwarded-proto'] || null,
    host: hdrs.host || null,
    allHeaders: hdrs,
  });
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Dyno Webhook Routes (at root level - Dyno expects /orders, /{resId}/orders/status, etc.)
// Base URL configured in Dyno: https://restro-backend.imaker.in
const dynoRoutes = require('./routes/dyno.routes');
app.use('/', dynoRoutes);

// API Routes — load handled internally via Redis cache + socket debouncing (no rate limiting on POS APIs)
const routes = require('./routes');
app.use('/api/v1', routes);

// Sentry test endpoint for verification (must be before 404 handler)
app.get('/sentry-debug', function mainHandler(req, res) {
  throw new Error("Sentry test error - verification endpoint");
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Resource not found',
  });
});

// Sentry error handler (must be before custom error handler)
Sentry.setupExpressErrorHandler(app);

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  
  res.status(err.statusCode || 500).json({
    success: false,
    message: config.app.env === 'production' 
      ? 'Internal server error' 
      : err.message,
    ...(config.app.env !== 'production' && { stack: err.stack }),
  });
});

// Graceful shutdown — drain all connections to prevent leaks on PM2 restart
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  // Force close after 10 seconds (PM2 kill_timeout is 5s, this is safety net)
  const forceTimer = setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  try {
    // 1. Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // 2. Close DB pool (drain active queries, release connections)
    const { closePool } = require('./database');
    await closePool();
    logger.info('Database pool drained');

    // 3. Close Redis connections
    const { closeRedis } = require('./config/redis');
    if (typeof closeRedis === 'function') {
      await closeRedis();
      logger.info('Redis connections closed');
    }

    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown:', err.message);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Initialize and start server
const startServer = async () => {
  try {
    // Initialize database connection
    await initializeDatabase();
    logger.info('Database connected successfully');

    // Initialize Redis (optional - app works without it)
    const redisResult = await initializeRedis();
    if (redisResult.available) {
      logger.info('Redis connected successfully');
    } else {
      logger.warn('Redis not available - caching and pub/sub disabled');
    }

    // Initialize WebSocket
    initializeSocket(server);
    logger.info('WebSocket initialized');

    // Register local Socket.IO emitter as fallback when Redis is unavailable
    registerLocalEmitter(emitLocal);
    logger.info('Local socket emitter registered (Redis fallback)');

    // Log raw HTTP upgrade events (WebSocket diagnostic)
    server.on('upgrade', (req, socket, head) => {
      logger.info(`[WS-DIAG] Upgrade event: url=${req.url} upgrade=${req.headers.upgrade} connection=${req.headers.connection}`);
    });

    // Initialize Queues
    await initializeQueues();
    logger.info('Queues initialized');

    // Initialize Cron Jobs
    if (config.app.enableCronJobs) {
      initializeCronJobs();
      logger.info('Cron jobs initialized');
    }

    // Start HTTP server
    server.listen(config.app.port, () => {
      logger.info(`Server running on port ${config.app.port} in ${config.app.env} mode`);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = { app, server };
