-- =====================================================
-- SHIFT & REPORT OPTIMIZATION INDEXES
-- Composite indexes for shift detail, DSR, DNS queries
-- =====================================================

-- day_sessions: shift history queries (outlet + date sorting)
CREATE INDEX IF NOT EXISTS idx_day_sessions_outlet_date ON day_sessions (outlet_id, session_date);
-- day_sessions: open shift lookup
CREATE INDEX IF NOT EXISTS idx_day_sessions_outlet_status ON day_sessions (outlet_id, status);

-- payments: due collection queries (is_due_collection filter within outlet + time)
CREATE INDEX IF NOT EXISTS idx_payments_due_collection ON payments (outlet_id, is_due_collection, status, created_at);

-- orders: adjustment queries
CREATE INDEX IF NOT EXISTS idx_orders_adjustment ON orders (outlet_id, is_adjustment, status);

-- user_floors + user_roles: staff activity join optimization
CREATE INDEX IF NOT EXISTS idx_user_floors_floor_outlet ON user_floors (floor_id, outlet_id, is_active);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_outlet ON user_roles (user_id, outlet_id, is_active);

-- payment_adjustments: report queries by outlet + date
CREATE INDEX IF NOT EXISTS idx_payment_adj_outlet_created ON payment_adjustments (outlet_id, created_at);

-- customer_due_transactions: due collection report queries by outlet + date
CREATE INDEX IF NOT EXISTS idx_cdt_outlet_created ON customer_due_transactions (outlet_id, created_at, transaction_type);
