-- =====================================================
-- MIGRATION 049: Menu QR Codes
-- Adds menu_type to menu_media and creates menu_qr_codes table
-- for storing QR codes per outlet+menu_type with optional logo
-- =====================================================

-- 1. Add menu_type column to menu_media table
ALTER TABLE menu_media
ADD COLUMN menu_type VARCHAR(50) NOT NULL DEFAULT 'restaurant' AFTER outlet_id;

-- Add index for menu_type filtering
ALTER TABLE menu_media
ADD INDEX idx_menu_media_type (menu_type);

-- 2. Create menu_qr_codes table
-- One QR code per outlet+menu_type combination (created once, reused)
CREATE TABLE IF NOT EXISTS menu_qr_codes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    menu_type VARCHAR(50) NOT NULL DEFAULT 'restaurant',
    qr_path VARCHAR(500) NOT NULL COMMENT 'Path to generated QR code image',
    logo_path VARCHAR(500) NULL COMMENT 'Optional custom logo to overlay on QR',
    view_url VARCHAR(1000) NOT NULL COMMENT 'Full URL that QR points to',
    scan_count INT UNSIGNED NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_outlet_menu_type (outlet_id, menu_type),
    INDEX idx_qr_outlet (outlet_id),
    INDEX idx_qr_active (is_active),
    CONSTRAINT fk_menu_qr_outlet FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
