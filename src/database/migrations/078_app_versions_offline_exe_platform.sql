-- =====================================================
-- MIGRATION 078: Add offline_exe platform to app_versions
-- Adds offline_exe to the platform ENUM for offline Windows EXE support
-- =====================================================

-- Modify platform ENUM to include offline_exe
ALTER TABLE app_versions
MODIFY COLUMN platform ENUM('global', 'app_store', 'play_store', 'exe', 'mac_os', 'offline_exe') NOT NULL DEFAULT 'global';