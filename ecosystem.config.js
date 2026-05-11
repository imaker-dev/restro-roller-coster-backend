/**
 * PM2 Ecosystem Config — Tuned for 100-200 outlets at rush hour
 *
 * Scale target: 100-200 restaurants, 3,000-6,000 tables at peak
 * Peak load: ~1,000 req/s, 3,000+ concurrent WebSocket connections
 *
 * DB connection math (critical):
 *   6 API workers  × 20 conn = 120  (POS + admin APIs)
 *   2 Queue workers ×  8 conn =  16  (print, notify, reports, webhooks)
 *   MySQL internal/tools/misc =  20
 *   Total                       = 156 (safe under MySQL max_connections=300)
 *
 * MySQL MUST have:
 *   max_connections = 300
 *   innodb_buffer_pool_size = 4G (or 70% of total RAM)
 *   innodb_io_capacity = 2000 (SSD)
 *   wait_timeout = 600
 *
 * UV_THREADPOOL_SIZE: Only used for fs, crypto, DNS.
 *   MySQL uses its own TCP sockets, NOT the UV thread pool.
 *   16 gives headroom for file uploads, crypto (JWT), DNS.
 *
 * Queue workers use fork mode (not cluster) to prevent duplicate job execution.
 */
module.exports = {
  apps: [
    {
      name: 'restro-pos-api',
      script: 'src/app.js',
      instances: 6,                  // 6 workers on 8-CPU server (reserve 2 for OS + queue)
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '2G',      // Increased for 100-200 outlets
      node_args: '--max-old-space-size=2048',
      env: {
        NODE_ENV: 'development',
        UV_THREADPOOL_SIZE: 16,
        DB_CONNECTION_LIMIT: 20,   // 6 × 20 = 120 total (safe under MySQL 300)
        DB_QUEUE_LIMIT: 200,
        LOG_LEVEL: 'debug',
      },
     env_production: {
  NODE_ENV: 'production',
  UV_THREADPOOL_SIZE: 16,
  DB_CONNECTION_LIMIT: 10,    // ← reduce from 20 to 10
  DB_QUEUE_LIMIT: 100,        // ← reduce from 200 to 100
  LOG_LEVEL: 'warn',          // ← saves RAM
},
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      listen_timeout: 10000,
      kill_timeout: 10000,         // 10s graceful shutdown (drain in-flight requests)
      kill_signal: 'SIGTERM',
    },
    {
      name: 'restro-pos-queue',
      script: 'src/queues/worker.js',
      instances: 2,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'development',
        UV_THREADPOOL_SIZE: 4,
        DB_CONNECTION_LIMIT: 8,    // 2 × 8 = 16 total
      },
      env_production: {
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: 4,
        DB_CONNECTION_LIMIT: 8,
      },
    },
  ],
};
