-- =====================================================
-- MIGRATION 080: Fix pricing unique key constraints
-- 
-- Problem: uk_outlet_active (outlet_id, is_active) and
--          uk_sa_user_active (user_id, is_active) allow
--          only ONE active + ONE inactive row per entity.
--          When deactivating, UPDATE is_active=0 fails if
--          an inactive row already exists.
--
-- Fix: Drop bad composite unique keys, deduplicate rows,
--      add proper single-column unique keys.
-- =====================================================

-- ─── outlet_pricing_override ───

-- 1. Deduplicate: keep only the latest row per outlet (by updated_at)
DELETE opo1 FROM outlet_pricing_override opo1
INNER JOIN outlet_pricing_override opo2
  ON opo1.outlet_id = opo2.outlet_id AND opo1.id < opo2.id;

-- 2. Drop the broken composite unique key
ALTER TABLE outlet_pricing_override DROP INDEX IF EXISTS uk_outlet_active;

-- 3. Add proper unique key on outlet_id only
ALTER TABLE outlet_pricing_override ADD UNIQUE KEY uk_outlet_id (outlet_id);

-- 4. Keep the regular index for fast lookups
ALTER TABLE outlet_pricing_override ADD INDEX IF NOT EXISTS idx_outlet_pricing_outlet (outlet_id, is_active);


-- ─── super_admin_pricing ───

-- 1. Deduplicate: keep only the latest row per user (by updated_at)
DELETE sap1 FROM super_admin_pricing sap1
INNER JOIN super_admin_pricing sap2
  ON sap1.user_id = sap2.user_id AND sap1.id < sap2.id;

-- 2. Drop the broken composite unique key
ALTER TABLE super_admin_pricing DROP INDEX IF EXISTS uk_sa_user_active;

-- 3. Add proper unique key on user_id only
ALTER TABLE super_admin_pricing ADD UNIQUE KEY uk_sa_user_id (user_id);

-- 4. Keep the regular index for fast lookups
ALTER TABLE super_admin_pricing ADD INDEX IF NOT EXISTS idx_sa_pricing_user (user_id, is_active);
