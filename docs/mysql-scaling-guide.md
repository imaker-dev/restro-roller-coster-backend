# MySQL Scaling Guide — Restro POS

> Last updated: May 2026  
> Environment: Plesk shared hosting, MariaDB 10.6.25, 46 GB RAM server

---

## 1. Current Production MySQL (Plesk Shared)

| Setting | Current Value | Source |
|---|---|---|
| MariaDB version | 10.6.25 | Plesk default |
| `innodb_buffer_pool_size` | **128 MB** | Factory default |
| `max_connections` | **151** | Factory default |
| `wait_timeout` | **28,800 sec (8 hrs)** | Factory default |
| `table_open_cache` | **2,000** | Factory default |
| `query_cache_type` | ON (deprecated) | Factory default |
| Server RAM | **46 GB** | Mostly unused by MariaDB |
| DB user privileges | No SUPER | Cannot change global vars |
| DB isolation | Shared | All Plesk domains share same MariaDB instance |

### What This Means

- **128 MB buffer pool** = 95%+ of queries read from disk, not RAM
- **151 max connections** = shared across ALL Plesk domains (not just yours)
- **8-hour wait_timeout** = idle connections stay open for 8 hours, wasting slots
- **No SUPER privilege** = you cannot tune MySQL yourself

### Safe Outlet Capacity with Current Config

| Active Outlets | Status | What Happens |
|---|---|---|
| 1–2 | ✅ Works | Disk I/O tolerable, connections sufficient |
| 2–10 | ⚠️ Slow | Queries take 200ms–1s, occasional timeouts |
| 10–100 | 🔴 Unstable | Frequent hangs, ghost orders, connection drops |
| 100+ | 🔴 Will Fail | "Too many connections", data loss risk |

---

## 2. Minimum Requirements for 100+ Outlets

### MySQL/MariaDB Configuration

```ini
[mysqld]
# Connections
max_connections = 500
wait_timeout = 600
interactive_timeout = 600

# Memory (assuming 8 GB available for MySQL)
innodb_buffer_pool_size = 4G
innodb_buffer_pool_instances = 4

# Redo log
innodb_log_file_size = 512M
innodb_log_files_in_group = 2
innodb_log_buffer_size = 32M

# I/O (SSD)
innodb_io_capacity = 2000
innodb_io_capacity_max = 4000
innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT

# Concurrency
innodb_read_io_threads = 4
innodb_write_io_threads = 4

# Table cache
table_open_cache = 8000
table_definition_cache = 4000

# Disable query cache (use Redis instead)
query_cache_type = 0
query_cache_size = 0

# Temp tables (for reports)
tmp_table_size = 128M
max_heap_table_size = 128M

# Slow query log
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 2
```

### Server Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Storage | 50 GB SSD | 100 GB NVMe SSD |
| DB access | Root or SUPER | Dedicated DB server |

### App Configuration (ecosystem.config.js)

```
6 API workers   × 10 conn = 60
2 Queue workers × 8 conn  = 16
MySQL internal/misc         = ~20
Total                       = 96 (safe under max_connections=500)
```
```

---

## 3. Requirements for 1000+ Outlets

### MySQL/MariaDB Configuration

```ini
[mysqld]
# Connections
max_connections = 1000
max_user_connections = 900
wait_timeout = 600
interactive_timeout = 600

# Memory (dedicated DB server with 64 GB RAM)
innodb_buffer_pool_size = 48G
innodb_buffer_pool_instances = 8

# Redo log
innodb_log_file_size = 2G
innodb_log_files_in_group = 2
innodb_log_buffer_size = 64M

# I/O (NVMe SSD)
innodb_io_capacity = 5000
innodb_io_capacity_max = 10000
innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT

# Concurrency
innodb_read_io_threads = 8
innodb_write_io_threads = 8
innodb_thread_concurrency = 32

# Table cache
table_open_cache = 8000
table_definition_cache = 4000

# Disable query cache
query_cache_type = 0
query_cache_size = 0

# Temp tables
tmp_table_size = 128M
max_heap_table_size = 128M

# Sort / join buffers
sort_buffer_size = 4M
join_buffer_size = 4M
read_buffer_size = 2M
read_rnd_buffer_size = 4M

# Slow query log
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 1

# Binary log (for replication)
log_bin = /var/log/mysql/mysql-bin
binlog_format = ROW
expire_logs_days = 7
```

### Server Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 16 cores | 32 cores |
| RAM | 64 GB | 128 GB |
| Storage | 500 GB NVMe SSD | 1 TB NVMe SSD |
| Network | 1 Gbps | 10 Gbps |

### Architecture for 1000+

```
                    ┌─────────────┐
                    │  Nginx LB   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐┌─────┴─────┐┌─────┴─────┐
        │ API Srv 1 ││ API Srv 2 ││ API Srv 3 │
        │ (PM2: 10) ││ (PM2: 10) ││ (PM2: 10) │
        └─────┬─────┘└─────┬─────┘└─────┬─────┘
              │            │            │
              └────────────┼────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴──────┐ ┌───┴──────┐ ┌──┴────────┐
        │ WS Server  │ │ WS Server │ │ WS Server │
        │ (4 workers)│ │ (4 workers│ │ (4 workers│
        └─────┬──────┘ └───┬──────┘ └──┬────────┘
              │             │            │
              └─────────────┼───────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
        ┌─────┴──────┐┌────┴──────┐┌─────┴──────┐
        │ Redis      ││ MySQL     ││ MySQL      │
        │ (ElastiC.) ││ Primary   ││ Read Replica│
        └────────────┘└───────────┘└────────────┘
```

### App Configuration (per API server)

```
10 API workers  × 40 conn = 400
4 WS workers    × 10 conn =  40
4 Queue workers × 15 conn =  60
MySQL internal/misc          = 100
Total                        = 600 (safe under max_connections=1000)
```

---

## 4. Cloud Provider Options

### Option A: Managed Cloud Database (Recommended)

Move only MySQL to a managed service — keep your Plesk server for the app.

| Provider | Service | Plan | RAM | Cost/month | Why |
|---|---|---|---|---|---|
| **DigitalOcean** | Managed MySQL | Basic-2vCPU-4GB | 4 GB | ~$60 | Same datacenter as Plesk, easy setup |
| **DigitalOcean** | Managed MySQL | Basic-4vCPU-8GB | 8 GB | ~$120 | Good for 100+ outlets |
| **AWS RDS** | db.t3.medium | 2 vCPU | 4 GB | ~$50 | Auto backups, monitoring |
| **AWS RDS** | db.r6g.xlarge | 4 vCPU | 32 GB | ~$250 | For 1000+ outlets |
| **Google Cloud SQL** | MySQL 8 | db-n1-standard-2 | 7.5 GB | ~$70 | Auto scaling |
| **Aiven** | MySQL Business | 4 vCPU | 8 GB | ~$80 | Simple pricing, good support |
| **Azure** | Database for MySQL | General Purpose | 4 GB | ~$50 | Good if already on Azure |
| **PlanetScale** | MySQL-compatible | Scaler Pro | — | ~$29 | Serverless, auto-scale |

**Setup is simple** — just change your `.env`:

```env
PROD_DB_HOST=your-db-host.ondigitalocean.com
PROD_DB_PORT=25060
PROD_DB_NAME=defaultdb
PROD_DB_USER=doadmin
PROD_DB_PASSWORD=your-secure-password
```

### Option B: VPS with Root Access (Full Control)

Move everything (app + DB) to your own VPS.

| Provider | Plan | CPU | RAM | Storage | Cost/month |
|---|---|---|---|---|---|
| **DigitalOcean** | Droplet | 4 vCPU | 8 GB | 160 GB SSD | ~$48 |
| **DigitalOcean** | Droplet | 8 vCPU | 16 GB | 320 GB SSD | ~$96 |
| **Hetzner** | CX41 | 8 vCPU | 16 GB | 160 GB SSD | ~€18 |
| **Hetzner** | CCX33 | 8 vCPU | 32 GB | 200 GB NVMe | ~€47 |
| **Vultr** | Compute | 6 vCPU | 16 GB | 320 GB SSD | ~$96 |
| **Linode/Akamai** | Dedicated | 8 vCPU | 32 GB | 400 GB SSD | ~$192 |

**Best value: Hetzner** — German provider, excellent price/performance.  
**Best ecosystem: DigitalOcean** — managed DB + app server in same datacenter.

### Option C: Ask Plesk Provider to Tune (Free, If They Agree)

Send this ticket to your hosting provider:

> **Subject:** Request MariaDB tuning for high-traffic POS application
>
> Our application is a restaurant POS system handling 100+ active restaurants.  
> The current MariaDB configuration uses factory defaults which causes performance issues.
>
> Please update the following global settings in MariaDB:
>
> ```
> [mysqld]
> max_connections = 500
> wait_timeout = 600
> interactive_timeout = 600
> innodb_buffer_pool_size = 8G
> innodb_buffer_pool_instances = 4
> innodb_log_file_size = 512M
> innodb_io_capacity = 2000
> innodb_flush_log_at_trx_commit = 2
> table_open_cache = 8000
> table_definition_cache = 4000
> query_cache_type = 0
> tmp_table_size = 128M
> max_heap_table_size = 128M
> ```
>
> Our database: `demorestro`  
> Current buffer pool: 128MB (factory default)  
> Server RAM: 46GB (mostly unused by MariaDB)

---

## 5. Decision Matrix

| Scenario | Best Option | Cost | Effort |
|---|---|---|---|
| Provider agrees to tune | **Option C** | Free | Low (just send ticket) |
| Provider refuses, < 100 outlets | **Option A** (managed DB) | $50-120/mo | Low (change .env) |
| Provider refuses, 100+ outlets | **Option B** (VPS) | $48-96/mo | Medium (migrate app + DB) |
| Scaling to 1000+ | **Option B** (VPS) + **Option A** (managed DB) | $150-300/mo | High (full architecture) |

---

## 6. Quick Commands to Check Current MySQL Capacity

Run these on your Plesk server:

```bash
# Basic health check
mysql -u demorestro -p'iMaker2026' -h 127.0.0.1 -e "
SELECT 'max_connections' AS config, @@max_connections AS value UNION ALL
SELECT 'Threads_connected', (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Threads_connected') UNION ALL
SELECT 'Max_used_connections', (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME='Max_used_connections') UNION ALL
SELECT 'buffer_pool_MB', ROUND(@@innodb_buffer_pool_size/1024/1024, 0) UNION ALL
SELECT 'table_open_cache', @@table_open_cache UNION ALL
SELECT 'wait_timeout_sec', @@wait_timeout UNION ALL
SELECT 'version', VERSION();
"

# Buffer pool hit ratio (after running for a while)
mysql -u demorestro -p'iMaker2026' -h 127.0.0.1 -e "
SELECT 
  ROUND(100 - (SELECT VARIABLE_VALUE FROM performance_schema.global_status 
    WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') * 100 
    / (SELECT VARIABLE_VALUE FROM performance_schema.global_status 
    WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'), 2) AS 'buffer_pool_hit_ratio_pct';
"
# > 99% = good, < 95% = need more RAM

# Slow queries
mysql -u demorestro -p'iMaker2026' -h 127.0.0.1 -e "
SELECT VARIABLE_VALUE AS slow_queries 
FROM performance_schema.global_status 
WHERE VARIABLE_NAME = 'Slow_queries';
"

# Connection usage
mysql -u demorestro -p'iMaker2026' -h 127.0.0.1 -e "
SELECT 
  (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected') AS current_connections,
  @@max_connections AS max_connections,
  ROUND((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected') * 100 / @@max_connections, 1) AS usage_pct;
"
```

---

## 7. Migration Checklist (When Moving to Managed DB)

- [ ] Provision managed MySQL instance (same region as app server)
- [ ] Export current database: `mysqldump -u demorestro -p demorestro > backup.sql`
- [ ] Import to new DB: `mysql -h new-host -u admin -p dbname < backup.sql`
- [ ] Run the 10 CREATE INDEX statements on new DB
- [ ] Update `.env` with new `PROD_DB_HOST`, `PROD_DB_USER`, `PROD_DB_PASSWORD`
- [ ] Update `PROD_DB_PORT` (managed DBs often use non-3306 ports)
- [ ] Test connection from app server: `mysql -h new-host -u admin -p -e "SELECT 1"`
- [ ] Deploy app with new `.env`
- [ ] Monitor for 24 hours — check slow query log and connection usage
- [ ] Keep old DB as backup for 7 days before decommissioning
