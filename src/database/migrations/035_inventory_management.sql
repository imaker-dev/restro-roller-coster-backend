-- =====================================================
-- INVENTORY MANAGEMENT SYSTEM
-- Module 1: Unit Conversion System
-- Module 2: Vendor Management
-- Module 3: Inventory Management (Items, Batches, Movements)
-- Module 4: Purchase Management
-- =====================================================

-- =====================================================
-- MODULE 1: UNIT CONVERSION SYSTEM
-- =====================================================

-- Units of measurement with conversion support
-- Restaurants buy in large units (kg, litre) and recipes use smaller units (g, ml)
-- conversion_factor = how many base units in 1 of this unit
-- e.g. kg: conversion_factor=1000 (1kg = 1000g base), g: conversion_factor=1 (base)
CREATE TABLE IF NOT EXISTS units (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(50) NOT NULL,
    abbreviation VARCHAR(10) NOT NULL,
    unit_type ENUM('weight', 'volume', 'count', 'length') NOT NULL,
    conversion_factor DECIMAL(15, 6) NOT NULL DEFAULT 1.000000,
    is_base_unit BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_unit_outlet_name (outlet_id, name),
    UNIQUE KEY uk_unit_outlet_abbr (outlet_id, abbreviation),
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    INDEX idx_units_outlet (outlet_id),
    INDEX idx_units_type (unit_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- MODULE 2: VENDOR MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS vendors (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(150) NOT NULL,
    contact_person VARCHAR(100),
    phone VARCHAR(20),
    alternate_phone VARCHAR(20),
    email VARCHAR(255),
    address TEXT,
    city VARCHAR(100),
    state VARCHAR(100),
    pincode VARCHAR(10),
    gst_number VARCHAR(20),
    pan_number VARCHAR(20),
    bank_name VARCHAR(100),
    bank_account VARCHAR(50),
    bank_ifsc VARCHAR(20),
    payment_terms VARCHAR(100),
    credit_days INT DEFAULT 0,
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    INDEX idx_vendors_outlet (outlet_id),
    INDEX idx_vendors_name (name),
    INDEX idx_vendors_phone (phone),
    INDEX idx_vendors_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- MODULE 3: INVENTORY MANAGEMENT
-- =====================================================

-- Inventory categories for organizing raw materials
CREATE TABLE IF NOT EXISTS inventory_categories (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    display_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_inv_cat_outlet_name (outlet_id, name),
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    INDEX idx_inv_cat_outlet (outlet_id),
    INDEX idx_inv_cat_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inventory items (raw materials / ingredients)
-- current_stock is always in base_unit terms
-- average_price and latest_price are per base_unit
CREATE TABLE IF NOT EXISTS inventory_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(150) NOT NULL,
    sku VARCHAR(50),
    category_id BIGINT UNSIGNED,
    base_unit_id BIGINT UNSIGNED NOT NULL,
    current_stock DECIMAL(15, 4) NOT NULL DEFAULT 0,
    latest_price DECIMAL(12, 4) DEFAULT 0,
    average_price DECIMAL(12, 4) DEFAULT 0,
    minimum_stock DECIMAL(15, 4) DEFAULT 0,
    maximum_stock DECIMAL(15, 4) DEFAULT 0,
    description VARCHAR(255),
    is_perishable BOOLEAN DEFAULT FALSE,
    shelf_life_days INT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_inv_item_outlet_name (outlet_id, name),
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES inventory_categories(id) ON DELETE SET NULL,
    FOREIGN KEY (base_unit_id) REFERENCES units(id),
    INDEX idx_inv_items_outlet (outlet_id),
    INDEX idx_inv_items_category (category_id),
    INDEX idx_inv_items_sku (sku),
    INDEX idx_inv_items_stock (current_stock),
    INDEX idx_inv_items_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inventory batches — each purchase creates a new batch
-- quantity and remaining_quantity are in base_unit of the inventory_item
-- purchase_price is per base_unit
CREATE TABLE IF NOT EXISTS inventory_batches (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    inventory_item_id BIGINT UNSIGNED NOT NULL,
    outlet_id BIGINT UNSIGNED NOT NULL,
    batch_code VARCHAR(50) NOT NULL,
    quantity DECIMAL(15, 4) NOT NULL,
    remaining_quantity DECIMAL(15, 4) NOT NULL,
    purchase_price DECIMAL(12, 4) NOT NULL DEFAULT 0,
    purchase_date DATE NOT NULL,
    expiry_date DATE,
    vendor_id BIGINT UNSIGNED,
    purchase_item_id BIGINT UNSIGNED,
    notes VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE SET NULL,
    INDEX idx_inv_batch_item (inventory_item_id),
    INDEX idx_inv_batch_outlet (outlet_id),
    INDEX idx_inv_batch_code (batch_code),
    INDEX idx_inv_batch_remaining (remaining_quantity),
    INDEX idx_inv_batch_expiry (expiry_date),
    INDEX idx_inv_batch_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inventory movements — golden rule: never change stock directly, always via movement
CREATE TABLE IF NOT EXISTS inventory_movements (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    inventory_item_id BIGINT UNSIGNED NOT NULL,
    inventory_batch_id BIGINT UNSIGNED,
    movement_type ENUM('purchase', 'sale', 'production', 'wastage', 'adjustment') NOT NULL,
    quantity DECIMAL(15, 4) NOT NULL,
    unit_id BIGINT UNSIGNED,
    quantity_in_base DECIMAL(15, 4) NOT NULL,
    unit_cost DECIMAL(12, 4) DEFAULT 0,
    total_cost DECIMAL(12, 2) DEFAULT 0,
    balance_before DECIMAL(15, 4) NOT NULL DEFAULT 0,
    balance_after DECIMAL(15, 4) NOT NULL DEFAULT 0,
    reference_type VARCHAR(50),
    reference_id BIGINT UNSIGNED,
    notes TEXT,
    created_by BIGINT UNSIGNED,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE,
    FOREIGN KEY (inventory_batch_id) REFERENCES inventory_batches(id) ON DELETE SET NULL,
    FOREIGN KEY (unit_id) REFERENCES units(id),
    INDEX idx_inv_mov_outlet (outlet_id),
    INDEX idx_inv_mov_item (inventory_item_id),
    INDEX idx_inv_mov_batch (inventory_batch_id),
    INDEX idx_inv_mov_type (movement_type),
    INDEX idx_inv_mov_ref (reference_type, reference_id),
    INDEX idx_inv_mov_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================
-- MODULE 4: PURCHASE MANAGEMENT
-- =====================================================

CREATE TABLE IF NOT EXISTS purchases (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    vendor_id BIGINT UNSIGNED NOT NULL,
    purchase_number VARCHAR(30) NOT NULL,
    invoice_number VARCHAR(50),
    purchase_date DATE NOT NULL,
    subtotal DECIMAL(12, 2) DEFAULT 0,
    tax_amount DECIMAL(12, 2) DEFAULT 0,
    discount_amount DECIMAL(12, 2) DEFAULT 0,
    total_amount DECIMAL(12, 2) DEFAULT 0,
    paid_amount DECIMAL(12, 2) DEFAULT 0,
    due_amount DECIMAL(12, 2) DEFAULT 0,
    payment_status ENUM('unpaid', 'partial', 'paid') DEFAULT 'unpaid',
    status ENUM('draft', 'confirmed', 'cancelled') DEFAULT 'confirmed',
    notes TEXT,
    created_by BIGINT UNSIGNED,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id),
    INDEX idx_purchases_outlet (outlet_id),
    INDEX idx_purchases_vendor (vendor_id),
    INDEX idx_purchases_number (purchase_number),
    INDEX idx_purchases_date (purchase_date),
    INDEX idx_purchases_status (status),
    INDEX idx_purchases_payment (payment_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS purchase_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    purchase_id BIGINT UNSIGNED NOT NULL,
    inventory_item_id BIGINT UNSIGNED NOT NULL,
    quantity DECIMAL(15, 4) NOT NULL,
    unit_id BIGINT UNSIGNED NOT NULL,
    quantity_in_base DECIMAL(15, 4) NOT NULL,
    price_per_unit DECIMAL(12, 4) NOT NULL,
    price_per_base_unit DECIMAL(12, 4) NOT NULL,
    tax_amount DECIMAL(10, 2) DEFAULT 0,
    discount_amount DECIMAL(10, 2) DEFAULT 0,
    total_cost DECIMAL(12, 2) NOT NULL,
    batch_code VARCHAR(50),
    expiry_date DATE,
    notes VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
    FOREIGN KEY (inventory_item_id) REFERENCES inventory_items(id) ON DELETE CASCADE,
    FOREIGN KEY (unit_id) REFERENCES units(id),
    INDEX idx_pi_purchase (purchase_id),
    INDEX idx_pi_item (inventory_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
