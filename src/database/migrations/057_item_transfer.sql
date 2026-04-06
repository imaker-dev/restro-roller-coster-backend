-- Migration 057: Item Transfer feature
-- Extends order_transfer_logs to support item-level transfers

-- Add 'item' to transfer_type ENUM
ALTER TABLE order_transfer_logs 
  MODIFY COLUMN transfer_type ENUM('table', 'waiter', 'both', 'item') NOT NULL;

-- Add transfer_details JSON column for item-level detail
ALTER TABLE order_transfer_logs
  ADD COLUMN target_order_id BIGINT UNSIGNED NULL AFTER to_table_id,
  ADD COLUMN transfer_details JSON NULL AFTER reason;

-- Add index on target_order_id for lookups
ALTER TABLE order_transfer_logs
  ADD INDEX idx_transfer_logs_target_order (target_order_id);
