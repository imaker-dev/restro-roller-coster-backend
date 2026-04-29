/**
 * PM2 Ecosystem Config — Optimized for 8-CPU server
 *
 * Scale target: 50+ restaurants, 1000+ tables at peak
 *
 * DB connection math (critical):
 *   6 API workers  × 10 conn =  60
 *   2 Queue workers ×  5 conn =  10
 *   MySQL internal/tools/misc =  10
 *   Total                     =  80  (safe under MySQL max_connections=151)
 *
 * MySQL MUST have: max_connections >= 151 (default) — increase to 300 if possible.
 * MySQL SHOULD have: wait_timeout=600 to release stale connections from PM2 restarts.
 * Previous config had 8 × 100 = 800 connections — caused DB exhaustion at peak.
 * Previous config had 6 × 15 = 90 + 2×8 = 16 = 106 — too close to 151 limit.
 *
 * UV_THREADPOOL_SIZE: Only used for fs, crypto, DNS lookups.
 *   MySQL queries use their own TCP sockets, NOT the UV thread pool.
 *   8 is sufficient for API workers, 4 for queue workers.
 *
 * Queue workers use fork mode (not cluster) to prevent duplicate job execution.
 */
module.exports = {
  apps: [
    {
      name: 'restro-pos-api',
      script: 'src/app.js',
      instances: 6,
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '1.5G',
      node_args: '--max-old-space-size=1536',
      env: {
        NODE_ENV: 'development',
        UV_THREADPOOL_SIZE: 8,
        DB_CONNECTION_LIMIT: 10,
        LOG_LEVEL: 'debug',
      },
      env_production: {
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: 8,
        DB_CONNECTION_LIMIT: 10,
        LOG_LEVEL: 'warn',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      listen_timeout: 10000,
      kill_timeout: 5000,
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
        DB_CONNECTION_LIMIT: 5,
      },
      env_production: {
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: 4,
        DB_CONNECTION_LIMIT: 5,
      },
    },
  ],
};
