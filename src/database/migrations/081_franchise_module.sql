-- Migration 081: Franchise module tables
-- Public franchise listings and user enquiries

-- Franchises table
CREATE TABLE IF NOT EXISTS franchises (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  slug              VARCHAR(255) NOT NULL UNIQUE,
  category          VARCHAR(100) NOT NULL DEFAULT 'restaurant',
  description       TEXT DEFAULT NULL,
  short_description VARCHAR(500) DEFAULT NULL,
  logo_url          VARCHAR(500) DEFAULT NULL,
  cover_image_url   VARCHAR(500) DEFAULT NULL,
  gallery_images    JSON DEFAULT NULL,

  -- Financials
  investment_min    DECIMAL(15, 2) DEFAULT NULL,
  investment_max    DECIMAL(15, 2) DEFAULT NULL,
  franchise_fee     DECIMAL(15, 2) DEFAULT NULL,
  working_capital   DECIMAL(15, 2) DEFAULT NULL,
  monthly_revenue   DECIMAL(15, 2) DEFAULT NULL,
  expected_roi      DECIMAL(5, 2) DEFAULT NULL COMMENT 'Percentage, e.g. 24.00',
  break_even_months INT DEFAULT NULL,

  -- Business metrics
  outlets_live      INT DEFAULT 0,
  established_year  INT DEFAULT NULL,
  space_requirement VARCHAR(100) DEFAULT NULL,
  staff_required    INT DEFAULT NULL,

  -- Tags / labels
  tags              JSON DEFAULT NULL COMMENT 'e.g. ["Fast Growing","Trending"]',
  support_offered   JSON DEFAULT NULL COMMENT 'e.g. ["Site Selection","Staff Training"]',

  -- Location
  location_city     VARCHAR(100) DEFAULT NULL,
  location_state    VARCHAR(100) DEFAULT NULL,
  locations_available JSON DEFAULT NULL COMMENT 'List of cities/states where franchise is available',

  -- Contact
  contact_email     VARCHAR(255) DEFAULT NULL,
  contact_phone     VARCHAR(20) DEFAULT NULL,
  website           VARCHAR(500) DEFAULT NULL,

  -- Metadata
  status            ENUM('active', 'inactive', 'pending') NOT NULL DEFAULT 'pending',
  is_featured       BOOLEAN NOT NULL DEFAULT FALSE,
  created_by        INT DEFAULT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_category       (category),
  INDEX idx_status         (status),
  INDEX idx_is_featured    (is_featured),
  INDEX idx_investment_min (investment_min),
  INDEX idx_investment_max (investment_max),
  INDEX idx_location_state (location_state),
  INDEX idx_location_city  (location_city),
  INDEX idx_created_at     (created_at),
  FULLTEXT INDEX idx_search (name, description, short_description, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Franchise enquiries table
CREATE TABLE IF NOT EXISTS franchise_enquiries (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  franchise_id      INT NOT NULL,
  full_name         VARCHAR(255) NOT NULL,
  phone             VARCHAR(20) NOT NULL,
  email             VARCHAR(255) NOT NULL,
  city              VARCHAR(100) DEFAULT NULL,
  state             VARCHAR(100) DEFAULT NULL,
  investment_budget VARCHAR(100) DEFAULT NULL COMMENT 'e.g. "₹10L-₹20L" or raw range',
  business_experience VARCHAR(100) DEFAULT NULL COMMENT 'e.g. "0-2 years", "2-5 years"',
  message           TEXT DEFAULT NULL,
  agree_to_contact  BOOLEAN NOT NULL DEFAULT FALSE,

  status            ENUM('new', 'contacted', 'converted', 'ignored') NOT NULL DEFAULT 'new',
  admin_notes       TEXT DEFAULT NULL,
  ip_address        VARCHAR(45) DEFAULT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_franchise_id  (franchise_id),
  INDEX idx_status        (status),
  INDEX idx_email         (email),
  INDEX idx_created_at    (created_at),
  CONSTRAINT fk_enquiry_franchise FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
