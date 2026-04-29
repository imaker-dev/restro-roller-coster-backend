-- =====================================================
-- ADD qr_url TO TABLES
-- Stores the actual URL encoded inside the QR image.
-- Needed so getTableQrUrls returns the correct URL
-- after regeneration with a different baseUrl.
-- =====================================================

ALTER TABLE tables
    ADD COLUMN IF NOT EXISTS qr_url VARCHAR(500) NULL AFTER qr_code;
