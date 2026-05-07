-- =====================================================
-- MIGRATION 074: Hierarchical Subscription Pricing
-- Adds super_admin-level and outlet-level pricing overrides
-- Priority: outlet_override > super_admin_pricing > global pricing
-- Optimized for 1000+ outlets with proper indexes
-- =====================================================

-- Super Admin pricing override (Group Layer)
-- Master assigns a custom annual price to a specific super_admin user.
-- All outlets under that super_admin inherit this pricing unless outlet-level override exists.
CREATE TABLE IF NOT EXISTS super_admin_pricing (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL COMMENT 'Super admin user who gets this pricing',
    base_price DECIMAL(10, 2) NOT NULL,
    gst_percentage DECIMAL(5, 2) NOT NULL DEFAULT 18.00,
    total_price DECIMAL(10, 2) AS (ROUND(base_price + (base_price * gst_percentage / 100), 2)) STORED,
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_by BIGINT UNSIGNED NOT NULL COMMENT 'Master user who set this pricing',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    -- Only one active pricing per super_admin
    UNIQUE KEY uk_sa_user_active (user_id, is_active),
    INDEX idx_sa_pricing_user (user_id, is_active),
    INDEX idx_sa_pricing_created (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outlet-level pricing override (Override Layer)
-- Master assigns a custom annual price to a specific outlet.
-- This overrides both global and super_admin pricing for that outlet only.
CREATE TABLE IF NOT EXISTS outlet_pricing_override (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL COMMENT 'Outlet that gets this custom pricing',
    base_price DECIMAL(10, 2) NOT NULL,
    gst_percentage DECIMAL(5, 2) NOT NULL DEFAULT 18.00,
    total_price DECIMAL(10, 2) AS (ROUND(base_price + (base_price * gst_percentage / 100), 2)) STORED,
    is_active BOOLEAN DEFAULT TRUE,
    notes TEXT,
    created_by BIGINT UNSIGNED NOT NULL COMMENT 'Master user who set this pricing',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    -- Only one active pricing per outlet
    UNIQUE KEY uk_outlet_active (outlet_id, is_active),
    INDEX idx_outlet_pricing_outlet (outlet_id, is_active),
    INDEX idx_outlet_pricing_created (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add pricing_source to outlet_subscriptions for traceability
ALTER TABLE outlet_subscriptions
    ADD COLUMN IF NOT EXISTS pricing_source ENUM('global', 'super_admin', 'outlet') DEFAULT 'global' AFTER current_pricing_id;

-- Add resolved_pricing_id to subscription_payments for audit
ALTER TABLE subscription_payments
    ADD COLUMN IF NOT EXISTS pricing_source ENUM('global', 'super_admin', 'outlet') DEFAULT 'global' AFTER total_amount,
    ADD COLUMN IF NOT EXISTS pricing_ref_id BIGINT UNSIGNED NULL COMMENT 'ID from the pricing table used (global/sa/outlet)' AFTER pricing_source;

-- Index on user_roles for fast super_admin→outlet lookups
-- (may already exist, IF NOT EXISTS handles gracefully)
ALTER TABLE user_roles
    ADD INDEX IF NOT EXISTS idx_user_roles_user_outlet (user_id, outlet_id, is_active);
