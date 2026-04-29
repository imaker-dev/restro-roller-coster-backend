-- =====================================================
-- SELF ORDER SYSTEM (QR Table Ordering)
-- Migration 050 — run via: node src/database/migrations/run-050-migration.js
-- =====================================================

-- 1. Self-order sessions: tracks QR scan sessions without requiring user auth
CREATE TABLE IF NOT EXISTS self_order_sessions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    token VARCHAR(64) NOT NULL UNIQUE,
    outlet_id BIGINT UNSIGNED NOT NULL,
    table_id BIGINT UNSIGNED NOT NULL,
    floor_id BIGINT UNSIGNED,
    customer_name VARCHAR(100),
    customer_phone VARCHAR(20),
    status ENUM('active', 'ordering', 'completed', 'expired') DEFAULT 'active',
    order_id BIGINT UNSIGNED,
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
    INDEX idx_so_sessions_token (token),
    INDEX idx_so_sessions_outlet (outlet_id),
    INDEX idx_so_sessions_table (table_id),
    INDEX idx_so_sessions_status (status),
    INDEX idx_so_sessions_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Self-order activity log (lightweight audit for public endpoints)
CREATE TABLE IF NOT EXISTS self_order_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    session_id BIGINT UNSIGNED,
    outlet_id BIGINT UNSIGNED NOT NULL,
    table_id BIGINT UNSIGNED,
    action ENUM('session_init', 'menu_view', 'order_placed', 'order_accepted', 'order_rejected', 'session_expired') NOT NULL,
    order_id BIGINT UNSIGNED,
    ip_address VARCHAR(45),
    metadata JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES self_order_sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    INDEX idx_so_logs_outlet (outlet_id),
    INDEX idx_so_logs_session (session_id),
    INDEX idx_so_logs_action (action),
    INDEX idx_so_logs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Self-order cart (persists cart per session in Redis-backed DB fallback)
CREATE TABLE IF NOT EXISTS self_order_cart (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    session_id BIGINT UNSIGNED NOT NULL,
    outlet_id BIGINT UNSIGNED NOT NULL,
    table_id BIGINT UNSIGNED NOT NULL,
    cart_data JSON NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_cart_session (session_id),
    FOREIGN KEY (session_id) REFERENCES self_order_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    INDEX idx_so_cart_outlet (outlet_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
