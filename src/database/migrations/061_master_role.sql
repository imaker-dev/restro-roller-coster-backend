-- =====================================================
-- MIGRATION 061: Add Master Role (Organization Level)
-- =====================================================
-- Master is the highest-level role in the system.
-- It has all super_admin capabilities PLUS the ability to
-- create, update, delete, and manage super_admin users.
-- =====================================================

-- Add master role (will not duplicate if already exists due to UNIQUE slug)
INSERT IGNORE INTO roles (name, slug, description, is_system_role, is_active, priority)
VALUES ('Master', 'master', 'Organization-level access, manages everything including super admins', 1, 1, 200);

-- Add raw_password column for super_admin credential visibility (master-only feature)
-- This stores the plain-text password ONLY for super_admin users created by master
ALTER TABLE users ADD COLUMN IF NOT EXISTS raw_password VARCHAR(255) DEFAULT NULL AFTER password_hash;
