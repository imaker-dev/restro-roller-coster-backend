-- Migration: Add module flags, user limits, and upgrade tracking to activation_info
-- This supports the Free → Pro upgrade system.
--
-- FRESH INSTALL:  activation_info does not exist yet (it is normally created at
--                 activation time in license.service.js).  We CREATE it here with
--                 ALL columns so the schema is ready before the first activation.
--
-- EXISTING INSTALL (already activated): The table exists but may lack the new
--                 columns.  The ALTER TABLE statements below add them; duplicate-
--                 column errors (ER_DUP_FIELDNAME) are silently skipped by migrate.js.

-- 1. Ensure the table exists with the FULL schema (fresh install path)
CREATE TABLE IF NOT EXISTS activation_info (
  id INT AUTO_INCREMENT PRIMARY KEY,
  license_id VARCHAR(36) NOT NULL UNIQUE,
  plan VARCHAR(20) NOT NULL DEFAULT 'free',
  module_captain TINYINT(1) NOT NULL DEFAULT 0,
  module_inventory TINYINT(1) NOT NULL DEFAULT 0,
  module_advanced_reports TINYINT(1) NOT NULL DEFAULT 0,
  restaurant_name VARCHAR(255) NOT NULL DEFAULT '',
  admin_email VARCHAR(255) NOT NULL DEFAULT '',
  contact_phone VARCHAR(20),
  max_outlets INT DEFAULT 1,
  max_users INT NOT NULL DEFAULT 10,
  is_activated TINYINT(1) DEFAULT 1,
  activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  token_hash VARCHAR(64) NOT NULL DEFAULT '',
  upgraded_from VARCHAR(36) DEFAULT NULL,
  upgraded_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. For existing installs: add missing columns (safe — ER_DUP_FIELDNAME is skipped)
ALTER TABLE activation_info ADD COLUMN module_captain TINYINT(1) NOT NULL DEFAULT 0 AFTER plan;
ALTER TABLE activation_info ADD COLUMN module_inventory TINYINT(1) NOT NULL DEFAULT 0 AFTER module_captain;
ALTER TABLE activation_info ADD COLUMN module_advanced_reports TINYINT(1) NOT NULL DEFAULT 0 AFTER module_inventory;
ALTER TABLE activation_info ADD COLUMN max_users INT NOT NULL DEFAULT 10 AFTER max_outlets;
ALTER TABLE activation_info ADD COLUMN upgraded_from VARCHAR(36) DEFAULT NULL AFTER token_hash;
ALTER TABLE activation_info ADD COLUMN upgraded_at DATETIME DEFAULT NULL AFTER upgraded_from;

-- Upgrade history table for audit trail
CREATE TABLE IF NOT EXISTS upgrade_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  old_license_id VARCHAR(36) NOT NULL,
  new_license_id VARCHAR(36) NOT NULL,
  old_plan VARCHAR(20) NOT NULL,
  new_plan VARCHAR(20) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  upgraded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  upgraded_by_user_id INT DEFAULT NULL,
  payment_reference VARCHAR(100) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_old_license (old_license_id),
  INDEX idx_new_license (new_license_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Token hash table to prevent replay of any token (activation or upgrade)
CREATE TABLE IF NOT EXISTS used_token_hashes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  token_type ENUM('activation', 'upgrade') NOT NULL DEFAULT 'activation',
  license_id VARCHAR(36) NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_token_hash (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
