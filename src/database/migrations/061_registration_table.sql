-- Migration: Restaurant self-registration requests table
-- Restaurants without an activation token can submit a registration request
-- from the Flutter app. iMaker admin reviews and generates a token.
--
-- Public endpoint: POST /api/v1/registration/register
-- Admin endpoints:  GET  /api/v1/registration/requests
--                  PATCH /api/v1/registration/:id/status

CREATE TABLE IF NOT EXISTS restaurant_registrations (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  restaurant_name VARCHAR(255) NOT NULL,
  contact_person  VARCHAR(255) NOT NULL,
  email           VARCHAR(255) NOT NULL,
  phone           VARCHAR(20)  NOT NULL,
  city            VARCHAR(100) DEFAULT NULL,
  state           VARCHAR(100) DEFAULT NULL,
  plan_interest   ENUM('free', 'pro') NOT NULL DEFAULT 'free',
  message         TEXT         DEFAULT NULL,
  status          ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  admin_notes     TEXT         DEFAULT NULL,
  ip_address      VARCHAR(45)  DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_status      (status),
  INDEX idx_email       (email),
  INDEX idx_created_at  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Token generation audit log (admin generates tokens via API)
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
