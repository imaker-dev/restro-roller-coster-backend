# iMaker POS — 1000-Restaurant Peak-Load Architecture Review

## Executive Summary

| Layer | Grade | Risk Level |
|---|---|---|
| Database Schema & Indexes | **B+** | Medium |
| Connection Pooling | **B** | High |
| Query Patterns | **C+** | **Critical** |
| Redis Caching | **B+** | Medium |
| Socket.IO Realtime | **A-** | Low |
| BullMQ Queues | **B** | Medium |
| PM2 Cluster | **B** | Medium |
| **Overall** | **B** | **High** |

---

## 1. Database Configuration Analysis

### Current Config (`src/config/database.config.js`)

| Parameter | Value | Assessment |
|---|---|---|
| `connectionLimit` | 10 (default) | **Too low for 1000 outlets** |
| `queueLimit` | 100 | Acceptable |
| `idleTimeout` | 30s | Good |
| `waitForConnections` | `true` | Risky — can cause cascading delays |
| `timezone` | `+00:00` | Correct |
| `dateStrings` | `true` | Correct (avoids JS Date parsing bugs) |
| `charset` | `utf8mb4` | Correct |
| `multipleStatements` | `false` | Correct (security) |

### PM2 Ecosystem Config (`ecosystem.config.js`)

| Worker Type | Count | DB Conn/Worker | Total Conn |
|---|---|---|---|
| API (`cluster`) | 6 | 10 | 60 |
| Queue (`fork`) | 2 | 5 | 10 |
| **Total** | **8** | — | **70** |
| MySQL `max_connections` | — | — | 151 (default) |
| **Headroom** | — | — | **81 connections** |

**Problem:** At 1000 restaurants with ~20-50 tables each (20,000-50,000 tables), if even 5% poll the live dashboard every 3 seconds, that's **333-833 requests/second**. With 10 DB connections per API worker, each worker handles ~55-140 concurrent requests. MySQL will saturate quickly.

**Recommendation:**
- Increase `connectionLimit` to **25** per API worker (6 × 25 = 150)
- Increase MySQL `max_connections` to **500**
- Add a **read replica** for report queries (live dashboard, admin lists, CSV exports)
- Use `waitForConnections: false` with a short `acquireTimeout` (1000ms) to fail fast under spike load

---

## 2. Table Schema & Index Analysis

### 2.1 Key Table Sizes (Projected at 1000 Outlets)

| Table | Row Growth/Month | 12-Month Total | Row Size | Data Size |
|---|---|---|---|---|
| `orders` | ~300K (30 orders/outlet/day × 1000) | **3.6M** | ~300B | **~1.1 GB** |
| `order_items` | ~900K (3 items/order) | **10.8M** | ~200B | **~2.2 GB** |
| `kot_tickets` | ~600K | **7.2M** | ~150B | **~1.1 GB** |
| `payments` | ~450K | **5.4M** | ~180B | **~1.0 GB** |
| `invoices` | ~300K | **3.6M** | ~200B | **~0.7 GB** |
| `table_sessions` | ~600K | **7.2M** | ~100B | **~0.7 GB** |
| `table_history` | ~1.2M | **14.4M** | ~80B | **~1.2 GB** |
| `users` | Low (staff) | ~50K | ~200B | **~10 MB** |
| `outlets` | Low | 1,000 | ~500B | **~500 KB** |
| `tables` | Low | ~30K | ~100B | **~3 MB** |
| `daily_sales` (aggregated) | 30K (30 days × 1000) | 360K | ~300B | **~110 MB** |

**Total transactional data: ~7-8 GB / year.** This is manageable, but the `orders` family will grow to tens of millions within 3 years.

### 2.2 Indexes — What's Good

Migration **051** and **056** added excellent composite indexes:

```sql
-- Hot path: live dashboard queries
idx_orders_outlet_created         (outlet_id, created_at)          -- ✓
idx_orders_outlet_floor_created   (outlet_id, floor_id, created_at) -- ✓
idx_orders_outlet_status_created  (outlet_id, status, created_at)   -- ✓

-- Hot path: table_sessions, table_history
idx_ts_table_status_started       (table_id, status, started_at DESC) -- ✓
idx_th_table_created              (table_id, created_at DESC)     -- ✓

-- Hot path: order_items with filesort elimination
idx_oi_order_created              (order_id, created_at)          -- ✓
idx_kt_order_created              (order_id, created_at)          -- ✓
```

### 2.3 Indexes — What's Missing

| Table | Missing Index | Query Pattern | Impact |
|---|---|---|---|
| `orders` | `(outlet_id, created_by, created_at)` | `getRunningOrders` cashier filter | **High** — `created_by` is not indexed |
| `orders` | `(outlet_id, status, created_at)` exists but `status` is enum — OK | live dashboard `status NOT IN` | Medium — `NOT IN` prevents index usage on status |
| `orders` | `(outlet_id, order_type, created_at)` | `getLiveDashboard` type breakdown | Medium — `order_type` not in composite |
| `payments` | `(outlet_id, received_by, created_at)` | cashier collection reports | Already exists: `idx_payments_outlet_received` ✓ |
| `invoices` | `(outlet_id, is_cancelled, created_at)` | tax reports | Already exists ✓ |
| `kot_tickets` | `(outlet_id, station, status, created_at)` | pending KOTs by station | Partial — `idx_kot_outlet_created` misses `status` |
| `order_items` | `(order_id, status)` | active/cancelled item counts per order | Already exists ✓ |
| `table_merges` | `(primary_table_id, unmerged_at)` | merge lookups | Already exists ✓ |
| `user_roles` | `(user_id, is_active, outlet_id)` | `_getUserOutlets`, auth me | **High** — no composite on this exact pattern |
| `user_floors` | `(user_id, outlet_id, is_active)` | `getUserFloorIds` helper | **High** — only `(user_id, floor_id)` exists |
| `user_sessions` | `(user_id, created_at DESC)` | last session lookup in `_getUserOutlets` | Medium |

### 2.4 Foreign Key Cascade — Dangerous at Scale

```sql
-- Migration 005: orders table
FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL,
```

**Risk:** `ON DELETE CASCADE` on `orders.outlet_id` means deleting 1 outlet triggers cascading deletes across:
- `orders` → `order_items` → `order_item_addons` → `order_item_costs` → `kot_tickets` → `payments` → `invoices` → etc.

At 3.6M orders per year per outlet, a single `DELETE FROM outlets WHERE id = X` could lock the database for **minutes** and potentially deadlock with active inserts.

**Recommendation:** Replace `ON DELETE CASCADE` with `ON DELETE RESTRICT` and implement **soft delete** (`deleted_at`) for outlets. The app already has `deleted_at` on outlets but the FK still has CASCADE.

---

## 3. Query Pattern Analysis

### 3.1 Critical Hot Path — `getLiveDashboard` (Called Every 3-5 Seconds)

```js
// reports.service.js:2616
// Runs 5 parallel queries per call
```

**Query 1 — Completed Sales:**
```sql
SELECT COUNT(*), SUM(total_amount), SUM(guest_count), ...
FROM orders o
WHERE o.outlet_id = ? AND o.status = 'completed'
  AND o.created_at >= ? AND o.created_at < ?
  AND (o.floor_id IN (...) OR (...))
```

- **Index usage:** `idx_orders_outlet_status_created` — **partially covered**
- **Filesort:** No (aggregation only)
- **Cost:** Low — single outlet, single day, index range scan

**Query 2 — Active Orders:**
```sql
SELECT COUNT(*) as active_orders, COUNT(CASE WHEN status = 'cancelled' THEN 1 END)
FROM orders o
WHERE o.outlet_id = ? AND o.status NOT IN ('completed', 'cancelled')
  AND o.created_at >= ? AND o.created_at < ?
  AND (o.floor_id IN (...) OR (...))
```

- **Problem:** `status NOT IN ('completed', 'cancelled')` — MySQL **cannot use** the `status` portion of `(outlet_id, status, created_at)` efficiently with `NOT IN`
- **Workaround:** Add `idx_orders_outlet_created_status` with `status` at the end, or use an `is_active` boolean computed column
- **Alternative:** Add `idx_orders_outlet_active (outlet_id, created_at)` + `status IN (...)` instead of `NOT IN`

**Query 3 — Active Tables:**
```sql
SELECT COUNT(*) FROM tables t
WHERE t.outlet_id = ? AND t.status = 'occupied' AND t.floor_id IN (...)
```

- **Index:** `idx_tables_outlet_status` — ✓ Good, but misses `floor_id`
- **Missing:** `idx_tables_outlet_floor_status (outlet_id, floor_id, status)`

**Query 4 — Pending KOTs:**
```sql
SELECT kt.station, COUNT(*)
FROM kot_tickets kt JOIN orders o ON kt.order_id = o.id
WHERE kt.outlet_id = ? AND kt.status NOT IN ('served', 'cancelled')
  AND kt.created_at >= ? AND kt.created_at < ?
  AND (o.floor_id IN (...) OR (...))
GROUP BY kt.station
```

- **Join on `orders`** is unnecessary — KOT already has `outlet_id`
- **Missing index:** `idx_kot_outlet_status_created (outlet_id, status, created_at)`
- **Filesort:** Yes on `GROUP BY kt.station` — unavoidable at this scale

**Query 5 — Payments:**
```sql
SELECT p.payment_mode, SUM(p.total_amount)
FROM payments p JOIN orders o ON p.order_id = o.id
WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at < ?
  AND p.status = 'completed' AND p.payment_mode != 'split'
GROUP BY p.payment_mode
```

- **Join on `orders` is unnecessary** — `payments` already has `outlet_id`
- **Index:** `idx_payments_outlet_created` covers most of it, but `payment_mode != 'split'` prevents index use on `payment_mode`

### 3.2 Critical Hot Path — `getRunningOrders` (Called on Every Table Tap)

```sql
-- reports.service.js:6143
SELECT o.id, o.order_number, ...,
  (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as item_count,
  (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'ready') as ready_count,
  ...
FROM orders o
LEFT JOIN tables t ON ...
LEFT JOIN floors f ON ...
LEFT JOIN users u ON ...
LEFT JOIN invoices i ON ...
WHERE o.outlet_id = ?
  AND o.status NOT IN ('paid', 'completed', 'cancelled')
  AND (o.floor_id IN (...) OR ...)
ORDER BY o.is_priority DESC, o.created_at DESC
```

**N+1 Subquery Problem:**
- **Two correlated subqueries** on `order_items` per row — at 100 running orders per outlet, this becomes **200 additional queries**
- **Impact:** ~5-10ms per subquery × 200 = **1-2 seconds** per request

**Recommendation:** Replace subqueries with a single JOIN + GROUP BY:
```sql
SELECT o.id, ...,
  COUNT(CASE WHEN oi.status != 'cancelled' THEN 1 END) as item_count,
  COUNT(CASE WHEN oi.status = 'ready' THEN 1 END) as ready_count
FROM orders o
LEFT JOIN order_items oi ON oi.order_id = o.id
-- ... other joins
WHERE ...
GROUP BY o.id
ORDER BY o.is_priority DESC, o.created_at DESC
```

### 3.3 Critical Hot Path — `getAdminOrderList` (Called on Admin Panel Load)

```sql
-- order.service.js:3804
WHERE o.outlet_id = ?
  [AND o.status = ?]
  [AND o.order_type = ?]
  [AND o.payment_status = ?]
  [AND o.created_at >= ? AND o.created_at < ?]
  [AND o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?]
ORDER BY ...
LIMIT ? OFFSET ?
```

**Problem:** The `search` filter uses `LIKE '%search%'` — this forces a **full table scan** on the `orders` table even with the outlet index.

**Recommendation:**
- Add a **FULLTEXT index** on `(outlet_id, order_number, customer_name, customer_phone)` and use `MATCH ... AGAINST`
- Or denormalize search into a `orders_search` table with Elasticsearch/OpenSearch

### 3.4 Critical Hot Path — `placeOrder` Transaction

```sql
-- order.service.js (typical pattern)
BEGIN;
INSERT INTO orders (...);
INSERT INTO order_items (...);
INSERT INTO order_item_addons (...);
UPDATE tables SET status = 'occupied' WHERE id = ?;
UPDATE table_sessions SET ... WHERE id = ?;
INSERT INTO kot_tickets (...);
INSERT INTO kot_items (...);
COMMIT;
```

**Good:** Uses `transaction()` helper with `BEGIN ... COMMIT` — prevents partial state.

**Risk at Scale:**
- `UPDATE tables SET status = 'occupied'` uses `idx_tables_outlet_status` — but the PK lookup on `id` is fast
- `UPDATE table_sessions` — if table has a long-running session with 1000 rows, this could cause lock contention
- `INSERT INTO kot_tickets` — auto-increment lock on `kot_tickets` is a bottleneck if many outlets insert simultaneously

**Recommendation:** Consider using **UUID primary keys** for `orders` and `kot_tickets` to distribute auto-increment contention, or use `innodb_autoinc_lock_mode = 2` (interleaved) in MySQL 8.

---

## 4. Redis Cache Analysis

### Current Strategy

| Feature | Status | TTL |
|---|---|---|
| Individual cache get/set | ✓ | 30s–30min |
| Cache invalidation (`del`, `delPattern`) | ✓ | Manual |
| Report cache middleware | ✓ | Variable |
| Live dashboard cache | ✗ | **Not cached** |
| `auth/me` outlets | ✗ | **Not cached** |
| `users` list | ✗ | **Not cached** |
| `orders/admin/list` | ✗ | **Not cached** |

### Cache Key Patterns

```js
// From redis.js
cache.set(key, value, ttlSeconds = 3600)
cache.del(key)
cache.delPattern(pattern)  // Uses KEYS command — O(N) on all keys!
```

**Critical Problem:** `cache.delPattern('*super_admin:dashboard:*')` uses `redisClient.keys()` which is **O(N)** on ALL keys in Redis. At 1000 outlets with 100 keys each, this scans **100,000 keys** synchronously.

**Recommendation:**
- Replace `KEYS` with `SCAN` for pattern deletion
- Cache the live dashboard for **5-10 seconds** per outlet (not per user — the data is the same for all users of an outlet)
- Cache `auth/me` outlets for **5 minutes**
- Use Redis hashes for structured data instead of JSON strings (saves serialization cost)

### Redis Connection Pool

Current setup creates **2 connections** per Node.js process (1 client + 1 subscriber). At 8 PM2 processes, that's 16 Redis connections — fine for a single Redis instance, but needs a Redis Sentinel or Cluster for HA.

---

## 5. Socket.IO Real-Time Architecture

### Current Design

| Feature | Implementation | Assessment |
|---|---|---|
| Redis adapter | ✓ `@socket.io/redis-adapter` | Good for PM2 cluster |
| Room-based routing | ✓ `outlet:${id}`, `floor:${id}:${floorId}` | Efficient |
| Debouncing | ✓ 200ms on `order:update`, `table:update`, `kot:update` | Critical for scale |
| Mobile POS rooms | ✓ `mpos:${outletId}:user:${userId}` | Good |
| Ping interval | 25s | Good |
| Ping timeout | 60s | Good |
| `httpCompression` | Disabled | Good for mobile |
| `perMessageDeflate` | Disabled | Good for mobile |

### Room Count Projection (1000 Outlets)

| Room Type | Per Outlet | Total Rooms |
|---|---|---|
| `outlet:${id}` | 1 | 1,000 |
| `floor:${id}:${floorId}` | ~3 | 3,000 |
| `kitchen:${id}` | 1 | 1,000 |
| `station:${id}:${type}` | ~3 | 3,000 |
| `captain:${id}` | 1 | 1,000 |
| `cashier:${id}` | 1 | 1,000 |
| `mpos:${id}:user:${uid}` | ~5 | 5,000 |
| **Total** | | **~15,000 rooms** |

**Assessment:** 15,000 rooms is well within Socket.IO + Redis adapter capacity (tested to 100K+ rooms). **Not a bottleneck.**

### Connection Count Projection

| Client Type | Per Outlet | Total at Peak |
|---|---|---|
| POS terminals | ~3 | 3,000 |
| Kitchen displays | ~2 | 2,000 |
| Captain apps | ~3 | 3,000 |
| Cashier terminals | ~2 | 2,000 |
| Mobile POS (Flutter) | ~5 | 5,000 |
| Admin dashboard | ~1 | 1,000 |
| **Total WebSocket connections** | | **~16,000** |

**Assessment:** 16,000 concurrent WebSocket connections on an 8-CPU server with 6 API workers is **very tight**. Each worker handles ~2,700 connections. Node.js is single-threaded; even with `cluster`, each worker still handles its own event loop.

**Recommendation:**
- Separate Socket.IO into its own **dedicated service** (e.g., 2-4 workers only for WebSocket)
- Or use a **message queue** (NATS, RabbitMQ) for pub/sub and lightweight WebSocket workers
- Or scale horizontally with a **load balancer** that uses IP hash for WebSocket sticky sessions

---

## 6. BullMQ Queue Analysis

### Current Setup

| Queue | Processor | Concurrency | Rate Limit | Status |
|---|---|---|---|---|
| `print` | ✓ Implemented | 5 | 100/s | Active |
| `notification` | ✓ Implemented | 5 | 100/s | Active |
| `report` | ✓ Implemented | 5 | 100/s | Active |
| `dyno-webhook` | ✓ Implemented | 5 | 100/s | Active |
| `email` | ✗ Stub | 5 | 100/s | Not implemented |
| `whatsapp` | ✗ Stub | 5 | 100/s | Not implemented |
| `inventory` | ✗ Stub | 5 | 100/s | Not implemented |

### Capacity at Peak

At 1000 outlets × 30 orders/hour during rush = **30,000 orders/hour** = **8.3 orders/second**.

Each order triggers:
- 1 print job (KOT/bill) = 8.3/s
- 1 notification job = 8.3/s
- 0.1 report jobs (aggregated) = 0.8/s
- 0.5 dyno-webhook jobs (online orders) = 4.2/s

**Total: ~22 jobs/second.**

BullMQ with 5 concurrency per queue can handle **500 jobs/second** total. **Not a bottleneck.**

**However:** Print jobs are I/O bound (network to printer). If printers are offline, jobs accumulate. The `removeOnComplete` keeps 1000 completed jobs, and `removeOnFail` keeps 5000 failed jobs. At 22/s, this is ~41 seconds of history — too short for debugging.

**Recommendation:**
- Increase `removeOnComplete.count` to **50,000** (2 hours of history)
- Implement dead-letter queues for failed print jobs
- Implement the `inventory` queue for real-time stock deduction (currently missing — stock deduction happens synchronously in `placeOrder` transaction!)

---

## 7. PM2 Cluster & Process Architecture

### Current Setup

```js
// ecosystem.config.js
apps: [
  { name: 'restro-pos-api', instances: 6, exec_mode: 'cluster', max_memory_restart: '1.5G' },
  { name: 'restro-pos-queue', instances: 2, exec_mode: 'fork', max_memory_restart: '512M' }
]
```

### Assessment

| Concern | Status |
|---|---|
| 6 API workers on 8-CPU server | **Good** — leaves 2 cores for OS + queue workers |
| Queue workers in `fork` mode | **Correct** — prevents duplicate job processing in cluster mode |
| Memory limit 1.5G per API worker | **Good** — 6 × 1.5G = 9G total, fits on a 16G server |
| No health check endpoint | **Missing** — PM2 `kill_timeout` is 5s but no HTTP health check |
| Graceful shutdown | **Partial** — DB pool close + queue close, but no request draining |

### Missing Pieces

1. **Health check endpoint** (`GET /health` or `/ready`) for load balancer
2. **Request draining** on SIGTERM — stop accepting new requests, finish in-flight, then exit
3. **Separate API tier** — Admin/report APIs should run on separate workers from POS order APIs
4. **Rate limiting** per outlet (not just per IP) — prevents one busy outlet from starving others

---

## 8. Critical Bottlenecks for 1000 Restaurants at Rush Hour

### 🔴 CRITICAL (Fix Immediately)

#### 8.1 `getRunningOrders` N+1 Subqueries

**File:** `src/services/reports.service.js:6153-6155`

```sql
(SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status != 'cancelled') as item_count,
(SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'ready') as ready_count,
```

**Impact:** At 100 running orders per outlet, 200 extra queries per request. With 1000 outlets polling every 3s, this is **200,000 queries/second**.

**Fix:** Replace with JOIN + GROUP BY.

#### 8.2 `orders` Table `status NOT IN` Kills Index

**File:** `src/services/reports.service.js:2655`

```sql
WHERE o.status NOT IN ('completed', 'cancelled')
```

MySQL can only use the `outlet_id` portion of `(outlet_id, status, created_at)` when `NOT IN` is used on `status`.

**Fix:** Add a **partial index** or **virtual column**:
```sql
ALTER TABLE orders ADD COLUMN is_active BOOLEAN AS (
  status NOT IN ('completed', 'cancelled')
) STORED;
CREATE INDEX idx_orders_outlet_active_created ON orders (outlet_id, is_active, created_at);
```

Or use `status IN ('pending', 'confirmed', 'preparing', 'ready', 'served', 'billed', 'paid')` explicitly.

#### 8.3 `getAdminOrderList` Search with `LIKE '%term%'`

**File:** `src/services/order.service.js:3850`

```sql
AND (o.order_number LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)
```

This is a **full table scan** on the outlet's orders.

**Fix:** Add FULLTEXT index or Elasticsearch.

#### 8.4 Database Connection Pool Exhaustion

**File:** `src/config/database.config.js:28`

`connectionLimit: 10` with 6 API workers = 60 connections. At 1000 outlets, with 16,000 WebSocket clients + dashboard polling, this is insufficient.

**Fix:**
- Increase to 25 per worker (150 total)
- Add MySQL read replica for reports
- Add PgBouncer or ProxySQL for connection pooling

### 🟡 HIGH (Fix Before Scaling)

#### 8.5 No Live Dashboard Cache

`getLiveDashboard` runs 5 complex queries on **every poll**. At 1000 outlets × 3s poll = **333 requests/second** hitting the DB.

**Fix:** Cache for 5-10 seconds per outlet:
```js
const cacheKey = `live_dashboard:${outletId}:${today}`;
const cached = await cache.get(cacheKey);
if (cached) return cached;
// ... run queries ...
await cache.set(cacheKey, result, 5); // 5 seconds
```

#### 8.6 `cache.delPattern` Uses `KEYS` Command

**File:** `src/config/redis.js:107`

```js
const keys = await redisClient.keys(`${redisConfig.keyPrefix}${pattern}`);
```

At 100K+ keys, `KEYS` blocks Redis for **100-500ms**.

**Fix:** Use `SCAN` with a cursor:
```js
async function delPattern(pattern) {
  let cursor = '0';
  do {
    const res = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = res[0];
    const keys = res[1];
    if (keys.length) await redisClient.del(...keys);
  } while (cursor !== '0');
}
```

#### 8.7 Missing Indexes on `user_roles` and `user_floors`

```sql
-- _getUserOutlets does:
SELECT r.slug FROM user_roles ur
JOIN roles r ON ur.role_id = r.id
WHERE ur.user_id = ? AND ur.is_active = 1

-- getUserFloorIds does:
SELECT floor_id FROM user_floors
WHERE user_id = ? AND outlet_id = ? AND is_active = 1
```

**Fix:**
```sql
CREATE INDEX idx_user_roles_user_active ON user_roles (user_id, is_active, role_id, outlet_id);
CREATE INDEX idx_user_floors_user_outlet ON user_floors (user_id, outlet_id, is_active, floor_id);
```

#### 8.8 `ON DELETE CASCADE` on `orders.outlet_id`

Deleting an outlet triggers cascading deletes across millions of rows.

**Fix:** Change to `ON DELETE RESTRICT` and implement soft delete.

#### 8.9 `getSuperAdminOutletIds` Called Synchronously on Every Request

**File:** `src/utils/helpers.js:173`

The new `getSuperAdminOutletIds` helper queries the database on **every** super_admin request to `/users`, `/orders/admin/list`, and `/outlets`.

**Fix:** Cache the result in Redis for 5 minutes per user:
```js
async function getSuperAdminOutletIds(userId, roles) {
  const cacheKey = `super_admin:outlets:${userId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;
  // ... query ...
  await cache.set(cacheKey, result, 300);
  return result;
}
```

### 🟢 MEDIUM (Optimize When Time Allows)

#### 8.10 `kot_tickets` Join on `orders` in Live Dashboard

```sql
FROM kot_tickets kt JOIN orders o ON kt.order_id = o.id
WHERE kt.outlet_id = ? AND ...
```

The `orders` join is only for the floor filter. Since `kot_tickets` already has `outlet_id`, the join is unnecessary unless floor filtering is needed.

#### 8.11 `payments` Join on `orders` in Live Dashboard

Same issue — `payments` has `outlet_id`, no need to join `orders` unless floor filtering.

#### 8.12 No Read Replica for Reports

All queries hit the primary database. Report queries (long-running aggregations) compete with real-time order placement.

#### 8.13 No Connection Pool Metrics

No monitoring of:
- Pool utilization (% of connections in use)
- Queue depth (waiting requests)
- Query latency P50/P95/P99
- Slow query log integration

#### 8.14 `user_sessions` Table Grows Unbounded

`user_sessions` tracks every login. At 1000 outlets × 20 staff × 2 logins/day = **40,000 rows/day**.

No cleanup policy observed. Will grow to millions.

**Fix:** Add a nightly cron to delete sessions older than 90 days.

#### 8.15 `print_jobs` Table Grows Unbounded

Print jobs are not cleaned up. At 8.3 print jobs/second = **720K/day**.

**Fix:** Archive old jobs to S3 or delete after 30 days.

---

## 9. Focus Areas for Rush Hour (Prioritized)

### Phase 1 — Immediate (This Week)

1. **Fix `getRunningOrders` N+1** — Replace correlated subqueries with JOIN + GROUP BY
2. **Fix `cache.delPattern` to use `SCAN`** — Prevents Redis blocking
3. **Add missing indexes** — `user_roles`, `user_floors`, `tables` floor composite
4. **Cache `getSuperAdminOutletIds`** — 5-minute Redis cache
5. **Increase DB pool limit** — 25 per worker, MySQL `max_connections` = 500

### Phase 2 — Short Term (Next 2 Weeks)

6. **Add live dashboard cache** — 5-10 second per-outlet cache
7. **Fix `orders` `NOT IN` index issue** — Use `is_active` virtual column or explicit `IN`
8. **Add `auth/me` cache** — 5-minute per-user cache
9. **Remove unnecessary JOINs** in `getLiveDashboard` (kot → orders, payments → orders)
10. **Implement `inventory` queue** — Async stock deduction instead of sync in transaction

### Phase 3 — Medium Term (Next Month)

11. **Add MySQL read replica** for reports and admin queries
12. **Separate Socket.IO service** from API workers
13. **Add health check endpoint** and request draining
14. **Implement data retention policies** — Archive old `orders`, `print_jobs`, `user_sessions`
15. **Add rate limiting per outlet** — Prevent one busy outlet from starving others

### Phase 4 — Long Term (Next Quarter)

16. **Shard by outlet** — Partition `orders`, `order_items`, `payments` by `outlet_id`
17. **Elasticsearch for order search** — Replace `LIKE '%term%'`
18. **Separate API tiers** — POS API (fast, low latency) vs Admin API (can be slower)
19. **Redis Cluster** for cache + pub/sub at 100K+ keys
20. **CDN for menu images** — `menu_media` table stores images locally

---

## 10. Infrastructure Recommendations for 1000 Restaurants

### Minimum Spec (Current Traffic)

| Component | Spec | Cost (India) |
|---|---|---|
| Application Server | 8 vCPU, 16GB RAM | ₹12,000/mo |
| MySQL Primary | 4 vCPU, 8GB RAM, SSD | ₹8,000/mo |
| Redis | 2 vCPU, 4GB RAM | ₹4,000/mo |
| **Total** | | **~₹24,000/mo** |

### Recommended Spec (1000 Outlets at Rush)

| Component | Spec | Role |
|---|---|---|
| API Tier | 4 × 8 vCPU, 16GB RAM (16 workers) | POS API only |
| Admin Tier | 2 × 8 vCPU, 16GB RAM (8 workers) | Dashboard, reports, exports |
| Socket.IO Tier | 2 × 4 vCPU, 8GB RAM | Real-time only |
| MySQL Primary | 8 vCPU, 32GB RAM, NVMe SSD | Writes + real-time reads |
| MySQL Replica | 8 vCPU, 32GB RAM, NVMe SSD | Reports + analytics |
| Redis | Redis Cluster 3 × 4GB | Cache + pub/sub |
| Load Balancer | AWS ALB / Nginx | Sticky sessions for WS |
| **Total** | | **~₹80,000-1,00,000/mo** |

---

## 11. Monitoring & Alerting (Currently Missing)

| Metric | Threshold | Action |
|---|---|---|
| DB pool utilization > 80% | Alert | Scale workers or increase pool |
| Redis memory > 80% | Alert | Evict old keys or scale |
| API P95 latency > 500ms | Alert | Investigate slow queries |
| Socket.IO connections > 10K/worker | Alert | Add Socket.IO workers |
| Queue depth > 1000 | Alert | Scale queue workers |
| MySQL slow queries > 10/min | Alert | Run EXPLAIN on top queries |
| Error rate > 1% | Alert | Check logs |

---

## Conclusion

The iMaker POS architecture is **well-designed for 50-200 restaurants** but has **critical bottlenecks** that will manifest at 1000+ outlets during rush hour:

1. **Database query patterns** are the #1 risk — N+1 subqueries, `NOT IN` index misses, and `LIKE '%term%'` scans will cause exponential latency growth.
2. **Connection pooling** is undersized for the expected concurrent load.
3. **Caching** is underutilized — the live dashboard, user lists, and auth endpoints hit the DB on every request.
4. **Socket.IO** is well-designed but will need dedicated workers at 16K+ concurrent connections.
5. **Queue system** is not a bottleneck but needs the `inventory` queue implemented.

**The most impactful fixes (in order):**
1. Fix `getRunningOrders` N+1 subqueries (immediate, 10x speedup)
2. Add live dashboard caching (immediate, 5x speedup)
3. Fix `cache.delPattern` `KEYS` command (immediate, prevents Redis lockups)
4. Increase DB pool + add read replica (short term, prevents connection exhaustion)
5. Add missing indexes on `user_roles`, `user_floors`, `tables` (short term, faster auth)

With these fixes, the system can comfortably handle **1000 restaurants** during rush hour. Without them, expect **500ms+ latency spikes** and **intermittent 500 errors** within the first month of scaling.
