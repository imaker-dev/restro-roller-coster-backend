-- =====================================================
-- MIGRATION 050: App Versions Per-Platform Support
-- Adds platform column to app_versions so each platform
-- (app_store, play_store, exe) has its own independent version
-- Existing rows are assigned platform = 'global' for backward compat
-- =====================================================

-- 1. Add platform column
ALTER TABLE app_versions
ADD COLUMN platform ENUM('global', 'app_store', 'play_store', 'exe') NOT NULL DEFAULT 'global' AFTER channel;

-- 2. Add per-platform single download_url, min_version, sha256
--    (replaces the multi-column android_url/ios_url/windows_url pattern for new rows)
ALTER TABLE app_versions
ADD COLUMN download_url VARCHAR(500) NULL COMMENT 'Download URL for this specific platform' AFTER platform,
ADD COLUMN min_version  VARCHAR(20)  NULL COMMENT 'Minimum supported version for this platform' AFTER download_url,
ADD COLUMN sha256_hash  VARCHAR(64)  NULL COMMENT 'SHA256 checksum for this platform build' AFTER min_version;

-- 3. Add index for platform queries
ALTER TABLE app_versions
ADD INDEX idx_platform_channel_active (platform, channel, is_active);

-- 4. Existing rows: mark as platform = 'global' (already the DEFAULT, just confirming)
UPDATE app_versions SET platform = 'global' WHERE platform = 'global' OR platform IS NULL;
