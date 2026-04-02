-- =====================================================
-- PERFORMANCE INDEXES FOR REPORT QUERIES
-- Composite indexes to support the most common report
-- query patterns: (outlet_id, created_at) filtering.
-- =====================================================

-- orders: most queried table in reports — (outlet_id, created_at) covers 80% of report WHERE clauses
CREATE INDEX IF NOT EXISTS idx_orders_outlet_created ON orders (outlet_id, created_at);
-- orders: floor-restricted queries
CREATE INDEX IF NOT EXISTS idx_orders_outlet_floor_created ON orders (outlet_id, floor_id, created_at);
-- orders: status-filtered queries (running orders, completed, cancelled)
CREATE INDEX IF NOT EXISTS idx_orders_outlet_status_created ON orders (outlet_id, status, created_at);

-- payments: payment mode breakdown, collection reports
CREATE INDEX IF NOT EXISTS idx_payments_outlet_created ON payments (outlet_id, created_at, status);
-- payments: tip/staff queries
CREATE INDEX IF NOT EXISTS idx_payments_outlet_received ON payments (outlet_id, received_by, created_at);

-- invoices: tax report queries
CREATE INDEX IF NOT EXISTS idx_invoices_outlet_created ON invoices (outlet_id, created_at, is_cancelled);

-- kot_tickets: counter/station report
CREATE INDEX IF NOT EXISTS idx_kot_outlet_created ON kot_tickets (outlet_id, created_at, station);

-- order_items: item sales, category sales, NC queries
CREATE INDEX IF NOT EXISTS idx_order_items_order_status ON order_items (order_id, status);
CREATE INDEX IF NOT EXISTS idx_order_items_item_status ON order_items (item_id, status);
CREATE INDEX IF NOT EXISTS idx_order_items_nc ON order_items (is_nc, status);

-- order_cancel_logs: cancellation detail report
CREATE INDEX IF NOT EXISTS idx_cancel_logs_outlet_created ON order_cancel_logs (order_id, created_at);

-- nc_logs: NC report
CREATE INDEX IF NOT EXISTS idx_nc_logs_outlet_applied ON nc_logs (outlet_id, applied_at, action_type);

-- order_discounts: discount report
CREATE INDEX IF NOT EXISTS idx_order_discounts_created ON order_discounts (order_id, created_at);

-- split_payments: split payment breakdown
CREATE INDEX IF NOT EXISTS idx_split_payments_mode ON split_payments (payment_id, payment_mode);

-- order_item_costs: food cost / profit reports
CREATE INDEX IF NOT EXISTS idx_oic_order_item ON order_item_costs (order_id, order_item_id);

-- tables: running tables queries
CREATE INDEX IF NOT EXISTS idx_tables_outlet_status ON tables (outlet_id, status);

-- wastage_logs: wastage in daily sales
CREATE INDEX IF NOT EXISTS idx_wastage_outlet_date ON wastage_logs (outlet_id, wastage_date);
