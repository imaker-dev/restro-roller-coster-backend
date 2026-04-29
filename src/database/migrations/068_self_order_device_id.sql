-- =====================================================
-- ADD DEVICE ID TO SELF ORDER SESSIONS
-- Enables device-based session control:
-- - Same device can resume session
-- - Different device is blocked from accessing active session
-- =====================================================

-- Add device_id column to track which device owns the session
ALTER TABLE self_order_sessions
ADD COLUMN device_id VARCHAR(64) NULL AFTER user_agent,
ADD INDEX idx_so_sessions_device (device_id);

-- Add device_id to self_order_logs action enum for tracking
ALTER TABLE self_order_logs
MODIFY COLUMN action ENUM(
  'session_init',
  'menu_view',
  'order_placed',
  'order_accepted',
  'order_rejected',
  'session_expired',
  'items_added',
  'item_removed',
  'item_updated',
  'order_cancelled',
  'device_blocked'
) NOT NULL;
