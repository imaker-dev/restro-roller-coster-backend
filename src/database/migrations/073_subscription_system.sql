-- =====================================================
-- SUBSCRIPTION SYSTEM (Per-Outlet)
-- Optimized for 1000+ outlets — composite indexes on hot paths
-- =====================================================

-- Master-controlled pricing (single active row at a time)
CREATE TABLE IF NOT EXISTS subscription_pricing (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    base_price DECIMAL(10, 2) NOT NULL DEFAULT 9999.00,
    gst_percentage DECIMAL(5, 2) NOT NULL DEFAULT 18.00,
    -- Computed total (base + GST) — stored for fast reads
    total_price DECIMAL(10, 2) AS (ROUND(base_price + (base_price * gst_percentage / 100), 2)) STORED,
    is_active BOOLEAN DEFAULT TRUE,
    effective_from DATE NOT NULL DEFAULT (CURDATE()),
    effective_to DATE,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_pricing_active (is_active, effective_from),
    INDEX idx_pricing_created (created_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-outlet subscription state (one row per outlet — UNIQUE on outlet_id)
CREATE TABLE IF NOT EXISTS outlet_subscriptions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL UNIQUE,
    status ENUM('trial', 'active', 'grace_period', 'expired', 'suspended') DEFAULT 'expired',
    current_pricing_id BIGINT UNSIGNED,
    subscription_start DATE,
    subscription_end DATE,
    grace_period_end DATE,
    last_payment_id BIGINT UNSIGNED,
    auto_renew BOOLEAN DEFAULT FALSE,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    FOREIGN KEY (current_pricing_id) REFERENCES subscription_pricing(id) ON DELETE SET NULL,
    -- Hot query: check if outlet is active (used by middleware every request)
    INDEX idx_outlet_status (outlet_id, status),
    -- Hot query: cron job scanning for expiring subscriptions
    INDEX idx_subscription_end (status, subscription_end),
    -- Hot query: cron job scanning for grace period ending
    INDEX idx_grace_end (status, grace_period_end),
    INDEX idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Subscription payment history (Razorpay + manual)
CREATE TABLE IF NOT EXISTS subscription_payments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    subscription_id BIGINT UNSIGNED NOT NULL,
    razorpay_order_id VARCHAR(255),
    razorpay_payment_id VARCHAR(255),
    razorpay_signature VARCHAR(512),
    base_amount DECIMAL(10, 2) NOT NULL,
    gst_amount DECIMAL(10, 2) NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    amount_paid DECIMAL(10, 2),
    status ENUM('pending', 'captured', 'failed', 'refunded', 'manual') DEFAULT 'pending',
    payment_method VARCHAR(50) DEFAULT 'razorpay',
    paid_at DATETIME,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    FOREIGN KEY (subscription_id) REFERENCES outlet_subscriptions(id) ON DELETE CASCADE,
    UNIQUE KEY uk_razorpay_order (razorpay_order_id),
    INDEX idx_payments_outlet (outlet_id, created_at),
    INDEX idx_payments_status (status),
    INDEX idx_payments_subscription (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notification log (prevents duplicate notifications)
CREATE TABLE IF NOT EXISTS subscription_notifications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    type ENUM('renewal_reminder_10d', 'renewal_reminder_3d', 'expired', 'grace_ending', 'grace_ended', 'manual_activation', 'manual_deactivation') NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    channel VARCHAR(20) DEFAULT 'in_app',
    status VARCHAR(20) DEFAULT 'sent',
    metadata JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    -- Prevent duplicate: one notification type per outlet per day window
    INDEX idx_outlet_type_sent (outlet_id, type, sent_at),
    INDEX idx_sent_at (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
