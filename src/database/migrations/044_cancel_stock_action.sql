-- ============================================================
-- Migration 044: Cancel Stock Action (Reversal vs Wastage)
-- ============================================================

-- 1. Add stock_action to order_cancel_logs to track what happened to stock
ALTER TABLE order_cancel_logs
    ADD COLUMN stock_action ENUM('reverse', 'wastage', 'none') DEFAULT 'none' AFTER reason_text,
    ADD COLUMN stock_action_auto TINYINT(1) DEFAULT 0 COMMENT 'Was stock_action auto-determined by system' AFTER stock_action;

-- 2. Add wastage_type 'order_cancel' to wastage_logs 
ALTER TABLE wastage_logs
    MODIFY COLUMN wastage_type ENUM('spoilage', 'expired', 'damaged', 'cooking_loss', 'order_cancel', 'other') NOT NULL DEFAULT 'spoilage';

-- 3. Add order reference columns to wastage_logs for traceability
ALTER TABLE wastage_logs
    ADD COLUMN order_id BIGINT UNSIGNED AFTER approved_by,
    ADD COLUMN order_item_id BIGINT UNSIGNED AFTER order_id,
    ADD INDEX idx_wastage_order (order_id),
    ADD INDEX idx_wastage_order_item (order_item_id);

-- 4. Add cancel_reversal_window_minutes setting (default 5 min)
INSERT IGNORE INTO system_settings (outlet_id, setting_key, setting_value, setting_type, description, is_editable)
VALUES (NULL, 'cancel_reversal_window_minutes', '5', 'number', 'Minutes after item creation within which cancel reverses stock (after this window, stock becomes wastage)', 1);

-- 5. Add cancel_stock_action_mode setting: 'auto' (system decides) or 'ask' (user chooses)
INSERT IGNORE INTO system_settings (outlet_id, setting_key, setting_value, setting_type, description, is_editable)
VALUES (NULL, 'cancel_stock_action_mode', 'auto', 'string', 'How to decide stock action on cancel: auto (system decides by time+KOT) or ask (user chooses)', 1);
