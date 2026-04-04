-- ============================================================
-- Migration 056: Composite indexes for hot query paths
-- Target: Eliminate filesort, temp tables, and full scans
--         on the most frequently called queries (getFullDetails)
--
-- At 1000+ tables polling every few seconds, these queries
-- run thousands of times per minute. Every filesort or scan
-- adds latency that compounds under load.
-- ============================================================

-- 1. table_sessions: WHERE table_id=? AND status IN(...) ORDER BY started_at DESC
--    Current: idx_table_sessions_table_status(table_id, status) — covers WHERE but not ORDER BY
--    Fix: Add started_at to eliminate filesort
ALTER TABLE table_sessions
  ADD INDEX idx_ts_table_status_started (table_id, status, started_at DESC);

-- 2. table_history: WHERE table_id=? ORDER BY created_at DESC LIMIT 10
--    Current: idx_table_history_table(table_id) — single column, filesort on created_at
--    Fix: Composite covers both WHERE and ORDER BY
ALTER TABLE table_history
  ADD INDEX idx_th_table_created (table_id, created_at DESC);

-- 3. order_items: WHERE order_id=? ORDER BY created_at
--    Current: idx_order_items_order(order_id) — single column, filesort on created_at
--    Fix: Composite eliminates filesort
ALTER TABLE order_items
  ADD INDEX idx_oi_order_created (order_id, created_at);

-- 4. kot_tickets: WHERE order_id=? GROUP BY kt.id ORDER BY created_at
--    Current: idx_kot_order(order_id) — single column, creates temp table + filesort
--    Fix: Composite on (order_id, created_at) helps avoid filesort
ALTER TABLE kot_tickets
  ADD INDEX idx_kt_order_created (order_id, created_at);

-- 5. order_item_addons: WHERE order_item_id IN (...)
--    Current: idx_order_item_addons_item(order_item_id) exists but may not be used
--    for small tables. Force-verify the index is correct type.
--    If table grows, MySQL will auto-use the index.
--    No change needed — index exists, just small table currently.

-- 6. table_merges: WHERE primary_table_id=? AND unmerged_at IS NULL
--    Current: idx_table_merges_primary(primary_table_id) — doesn't cover unmerged_at
--    Fix: Composite for the exact WHERE clause
ALTER TABLE table_merges
  ADD INDEX idx_tm_primary_unmerged (primary_table_id, unmerged_at);
