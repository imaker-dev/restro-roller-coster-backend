-- =====================================================
-- MIGRATION 075: Offline Activation Token Support
-- Extends token_generation_log for offline annual subscription tokens
-- Optimized for 1000+ outlets — adds outlet_id index for fast lookups
-- =====================================================

-- 0. Ensure table exists (migration 061 may not have run yet)
CREATE TABLE IF NOT EXISTS token_generation_log (
  id                       INT AUTO_INCREMENT PRIMARY KEY,
  license_id               VARCHAR(36)  NOT NULL,
  token_type               ENUM('activation', 'upgrade') NOT NULL,
  plan                     VARCHAR(20)  NOT NULL DEFAULT 'free',
  restaurant_name          VARCHAR(255) DEFAULT NULL,
  email                    VARCHAR(255) DEFAULT NULL,
  generated_by_user_id     INT          DEFAULT NULL,
  token_hash               VARCHAR(64)  NOT NULL,
  upgrade_from_license_id  VARCHAR(36)  DEFAULT NULL,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_license_id (license_id),
  INDEX idx_token_type (token_type),
  INDEX idx_created_at_log (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1. Extend token_type enum to include offline_activation
--    (MODIFY COLUMN re-declares the full column definition)
ALTER TABLE token_generation_log
  MODIFY COLUMN token_type ENUM('activation', 'upgrade', 'offline_activation') NOT NULL DEFAULT 'activation';

-- 2. Add outlet_id for linking tokens to specific outlets
ALTER TABLE token_generation_log
  ADD COLUMN IF NOT EXISTS outlet_id BIGINT UNSIGNED NULL,
  ADD INDEX IF NOT EXISTS idx_outlet_id (outlet_id);

-- 3. Add subscription_expiry for audit / token regeneration decisions
ALTER TABLE token_generation_log
  ADD COLUMN IF NOT EXISTS subscription_expiry DATE NULL;

-- 4. Add device_hash for optional device-binding audit
ALTER TABLE token_generation_log
  ADD COLUMN IF NOT EXISTS device_hash VARCHAR(64) NULL;

-- 5. Add used_at for replay-protection (one-time activation)
ALTER TABLE token_generation_log
  ADD COLUMN IF NOT EXISTS used_at DATETIME NULL;

-- 6. Add index on license_id for reverse lookups (if not already present)
--    (MySQL 8.0.13+ supports ADD INDEX IF NOT EXISTS)
ALTER TABLE token_generation_log
  ADD INDEX IF NOT EXISTS idx_license_id (license_id);
