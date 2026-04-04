-- =====================================================
-- ADD COMPOSITE INDEX ON table_sessions(table_id, status)
-- Optimizes the frequent lookup: WHERE table_id = ? AND status IN ('active','billing')
-- Used by getFullDetails which is called for every table at peak time
-- =====================================================

ALTER TABLE table_sessions
    ADD INDEX IF NOT EXISTS idx_table_sessions_table_status (table_id, status);
