-- Expand self_order_logs action ENUM to include customer-initiated actions
ALTER TABLE self_order_logs
  MODIFY COLUMN action ENUM(
    'session_init', 'menu_view', 'order_placed', 'order_accepted',
    'order_rejected', 'session_expired', 'session_completed',
    'order_cancelled', 'item_updated', 'item_removed'
  ) NOT NULL;
