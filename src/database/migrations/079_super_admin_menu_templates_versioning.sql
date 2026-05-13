-- =====================================================
-- MIGRATION 079: Add versioning to super_admin_menu_templates
-- =====================================================

-- Step 1: Add version and is_active columns to existing table
ALTER TABLE super_admin_menu_templates
  ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1 AFTER user_id,
  ADD COLUMN label VARCHAR(100) NULL AFTER version,
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 0 AFTER label;

-- Step 2: Mark all existing rows as version 1 and set them active
UPDATE super_admin_menu_templates SET version = 1, is_active = 1;

-- Step 3: Drop the old unique key that only allowed one row per user
ALTER TABLE super_admin_menu_templates DROP INDEX uk_user_id;

-- Step 4: Add new unique key allowing multiple versions per user
ALTER TABLE super_admin_menu_templates
  ADD UNIQUE KEY uk_user_version (user_id, version),
  ADD INDEX idx_user_active (user_id, is_active);
