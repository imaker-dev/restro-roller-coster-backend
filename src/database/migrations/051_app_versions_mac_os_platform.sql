-- =====================================================
-- MIGRATION 051: Add mac_os platform to app_versions
-- Adds mac_os to the platform ENUM for macOS app support
-- =====================================================

-- Modify platform ENUM to include mac_os
ALTER TABLE app_versions
MODIFY COLUMN platform ENUM('global', 'app_store', 'play_store', 'exe', 'mac_os') NOT NULL DEFAULT 'global';
