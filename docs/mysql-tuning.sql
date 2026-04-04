-- ============================================================
-- MySQL Server Tuning for Peak Performance
-- Target: 50+ restaurants, 1000+ tables, 8-CPU server
-- ============================================================
-- Run these on the MySQL server (requires SUPER privilege)
-- After running, restart MySQL or use SET GLOBAL for runtime changes.
--
-- PM2 connection math:
--   6 API workers  × 15 connections =  90
--   2 Queue workers ×  8 connections =  16
--   Admin/monitoring/misc            =  10
--   Total needed                     = 116
--   Safety margin (~2.5x)           = 300
-- ============================================================

-- 1. Connection limits
SET GLOBAL max_connections = 300;
SET GLOBAL thread_cache_size = 64;

-- 2. InnoDB Buffer Pool — THE most important setting for performance
--    Caches table data + indexes in RAM. Reduces disk I/O dramatically.
--    Current: 16MB (way too low). Set to 1-2GB depending on server RAM.
--    Rule: 50-70% of total server RAM if MySQL is the only major service.
--    For shared server (Node.js + Redis + MySQL): use 25-40% of RAM.
--    Rule: 1 instance per 1GB of buffer pool.
SET GLOBAL innodb_buffer_pool_size = 1073741824;  -- 1 GB (adjust based on server RAM)
SET GLOBAL innodb_buffer_pool_instances = 1;       -- 1 per 1GB (avoids fragmentation)

-- 3. InnoDB I/O capacity — how aggressively InnoDB flushes dirty pages
--    Default: 200 (HDD). For SSD: 2000-4000. For NVMe: 10000+
SET GLOBAL innodb_io_capacity = 2000;
SET GLOBAL innodb_io_capacity_max = 4000;

-- 4. InnoDB write performance — durability vs speed tradeoff
--    0 = fastest (unsafe), 1 = safest (slow), 2 = balanced (lose ~1s data on crash)
--    For POS: value 2 is ideal — fast writes, acceptable risk.
SET GLOBAL innodb_flush_log_at_trx_commit = 2;

-- 5. InnoDB log file size — larger = fewer checkpoints = faster writes
--    Critical for heavy write workloads (orders, billing, KOTs)
--    NOTE: Requires MySQL restart. Cannot be changed at runtime.
-- innodb_log_file_size = 256M  (add to my.cnf, restart required)

-- 6. Connection timeouts — close idle connections faster to free up pool
SET GLOBAL wait_timeout = 300;           -- 5 minutes (was 8 hours!)
SET GLOBAL interactive_timeout = 300;    -- 5 minutes

-- 7. Packet size — allow larger result sets (order details, reports)
SET GLOBAL max_allowed_packet = 16777216;  -- 16 MB

-- 8. Slow query log — essential for finding bottlenecks
--    WARNING: Do NOT enable log_queries_not_using_indexes in production!
--    It floods the log at peak and can fill disk / slow MySQL.
--    Only enable temporarily for debugging.
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 1;            -- Log queries taking > 1 second
SET GLOBAL log_queries_not_using_indexes = 'OFF';

-- 9. Table open cache — how many tables MySQL keeps open
--    50+ restaurants × ~30 tables each = 1500+ tables
--    IMPORTANT: Ensure OS file descriptor limit is high enough:
--      ulimit -n 65535  (or set in /etc/security/limits.conf)
--    If ulimit is low, MySQL cannot open this many files.
SET GLOBAL table_open_cache = 4000;
SET GLOBAL table_open_cache_instances = 16;

-- 10. Sort/join buffers — per-connection memory for sorting and joins
SET GLOBAL sort_buffer_size = 2097152;     -- 2 MB (default 256KB)
SET GLOBAL join_buffer_size = 2097152;     -- 2 MB

-- 11. Temp table size — for complex GROUP BY / ORDER BY queries
SET GLOBAL tmp_table_size = 67108864;      -- 64 MB
SET GLOBAL max_heap_table_size = 67108864; -- 64 MB

-- ============================================================
-- MAKE PERSISTENT — Add to my.cnf / my.ini [mysqld] section:
-- ============================================================
-- [mysqld]
-- max_connections = 300
-- thread_cache_size = 64
-- innodb_buffer_pool_size = 1G
-- innodb_buffer_pool_instances = 1
-- innodb_io_capacity = 2000
-- innodb_io_capacity_max = 4000
-- innodb_flush_log_at_trx_commit = 2
-- innodb_log_file_size = 256M
-- wait_timeout = 300
-- interactive_timeout = 300
-- max_allowed_packet = 16M
-- slow_query_log = ON
-- long_query_time = 1
-- log_queries_not_using_indexes = OFF
-- table_open_cache = 4000
-- table_open_cache_instances = 16
-- sort_buffer_size = 2M
-- join_buffer_size = 2M
-- tmp_table_size = 64M
-- max_heap_table_size = 64M
