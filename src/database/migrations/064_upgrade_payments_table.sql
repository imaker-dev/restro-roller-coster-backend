-- Migration 064: Razorpay Pro upgrade payment tracking table
-- Records every upgrade payment attempt. After payment is verified, the
-- upgrade token is generated automatically and stored here.
CREATE TABLE IF NOT EXISTS upgrade_payments (
  id                   INT          AUTO_INCREMENT PRIMARY KEY,
  license_id           VARCHAR(36)  NOT NULL,
  restaurant_name      VARCHAR(255) DEFAULT NULL,
  email                VARCHAR(255) DEFAULT NULL,
  phone                VARCHAR(30)  DEFAULT NULL,
  razorpay_order_id    VARCHAR(100) NOT NULL,
  razorpay_payment_id  VARCHAR(100) DEFAULT NULL,
  razorpay_signature   VARCHAR(512) DEFAULT NULL,
  amount_paise         INT          NOT NULL,
  currency             CHAR(3)      NOT NULL DEFAULT 'INR',
  status               ENUM('created','paid','failed','cancelled') NOT NULL DEFAULT 'created',
  upgrade_token        TEXT         DEFAULT NULL,
  new_license_id       VARCHAR(36)  DEFAULT NULL,
  notified_email       TINYINT(1)   NOT NULL DEFAULT 0,
  notified_whatsapp    TINYINT(1)   NOT NULL DEFAULT 0,
  ip_address           VARCHAR(45)  DEFAULT NULL,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_order       (razorpay_order_id),
  INDEX      idx_license    (license_id),
  INDEX      idx_status     (status),
  INDEX      idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
