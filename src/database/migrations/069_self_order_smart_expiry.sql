-- =====================================================
-- SMART SESSION EXPIRY FOR SELF-ORDER
-- 
-- Rules:
-- 1. Session without order: expires after 20 minutes (idle timeout)
-- 2. Session with active order: stays active until order completes
-- 3. Session after order completion: expires after 5 minutes buffer
-- =====================================================

-- Add columns for smart expiry tracking
ALTER TABLE self_order_sessions
ADD COLUMN idle_timeout_minutes INT UNSIGNED DEFAULT 20 AFTER expires_at,
ADD COLUMN order_completed_at DATETIME NULL AFTER idle_timeout_minutes,
ADD COLUMN completion_buffer_minutes INT UNSIGNED DEFAULT 5 AFTER order_completed_at;

-- Create index for efficient expiry queries
ALTER TABLE self_order_sessions
ADD INDEX idx_so_sessions_order_completed (order_completed_at);

-- Update existing sessions to have default idle timeout
UPDATE self_order_sessions SET idle_timeout_minutes = 20 WHERE idle_timeout_minutes IS NULL;
