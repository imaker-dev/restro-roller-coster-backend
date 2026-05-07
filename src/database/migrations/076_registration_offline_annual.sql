-- =====================================================
-- MIGRATION 076: Support offline_annual plan interest + outlet linkage
--
-- 1. Add 'offline_annual' to plan_interest ENUM
-- 2. Add outlet_id to restaurant_registrations for tracking
-- 3. Add offline_token for storing generated token
-- =====================================================

-- Step 1: Update plan_interest ENUM to include offline_annual
-- MySQL handles ENUM additions by modifying the column definition
ALTER TABLE restaurant_registrations
  MODIFY COLUMN plan_interest ENUM('free', 'pro', 'offline_annual') NOT NULL DEFAULT 'free';

-- Step 2: Add outlet_id to link registration to created outlet
ALTER TABLE restaurant_registrations
  ADD COLUMN outlet_id BIGINT UNSIGNED NULL AFTER plan_interest,
  ADD COLUMN offline_token TEXT NULL AFTER outlet_id,
  ADD COLUMN token_generated_at DATETIME NULL AFTER offline_token,
  ADD INDEX idx_outlet_id (outlet_id);

-- Step 3: Add foreign key constraint (optional — keep loose to allow manual cleanup)
-- ALTER TABLE restaurant_registrations
--   ADD CONSTRAINT fk_reg_outlet FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE SET NULL;
