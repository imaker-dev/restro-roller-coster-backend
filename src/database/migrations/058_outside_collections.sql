-- Outside Collections: Record payments collected outside POS (Party Hall, Kitty Party, etc.)
-- These amounts are added to the cashier's total collection and reflected in DSR, shift reports, and dashboards.

CREATE TABLE IF NOT EXISTS outside_collections (
  id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid CHAR(36) NOT NULL,
  outlet_id BIGINT(20) UNSIGNED NOT NULL,
  shift_id BIGINT(20) UNSIGNED DEFAULT NULL,
  floor_id BIGINT(20) UNSIGNED DEFAULT NULL,
  collected_by BIGINT(20) UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  payment_mode ENUM('cash','card','upi','wallet','other') NOT NULL DEFAULT 'cash',
  reason VARCHAR(255) NOT NULL,
  description TEXT DEFAULT NULL,
  collection_date DATE NOT NULL,
  status ENUM('active','cancelled') NOT NULL DEFAULT 'active',
  cancelled_by BIGINT(20) UNSIGNED DEFAULT NULL,
  cancelled_at DATETIME DEFAULT NULL,
  cancel_reason VARCHAR(255) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_uuid (uuid),
  KEY idx_outlet_date (outlet_id, collection_date),
  KEY idx_outlet_shift (outlet_id, shift_id),
  KEY idx_outlet_floor_date (outlet_id, floor_id, collection_date),
  KEY idx_collected_by (collected_by),
  KEY idx_status (status),
  CONSTRAINT fk_oc_outlet FOREIGN KEY (outlet_id) REFERENCES outlets(id),
  CONSTRAINT fk_oc_shift FOREIGN KEY (shift_id) REFERENCES day_sessions(id),
  CONSTRAINT fk_oc_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_oc_collected_by FOREIGN KEY (collected_by) REFERENCES users(id),
  CONSTRAINT fk_oc_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
