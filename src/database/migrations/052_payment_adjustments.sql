-- =====================================================
-- PAYMENT ADJUSTMENTS
-- Track payment adjustments (write-offs) when orders
-- are closed with less than full payment.
-- =====================================================

-- payment_adjustments: stores each adjustment record
CREATE TABLE IF NOT EXISTS payment_adjustments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT UNSIGNED NOT NULL,
    order_id BIGINT UNSIGNED NOT NULL,
    invoice_id BIGINT UNSIGNED,
    payment_id BIGINT UNSIGNED,
    order_number VARCHAR(30),
    total_amount DECIMAL(12, 2) NOT NULL COMMENT 'Original bill amount',
    paid_amount DECIMAL(12, 2) NOT NULL COMMENT 'Actual money received',
    adjustment_amount DECIMAL(12, 2) NOT NULL COMMENT 'Amount written off',
    reason VARCHAR(255),
    adjusted_by BIGINT UNSIGNED NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (outlet_id) REFERENCES outlets(id) ON DELETE CASCADE,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
    FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL,
    FOREIGN KEY (adjusted_by) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_pa_outlet_created (outlet_id, created_at),
    INDEX idx_pa_order (order_id),
    INDEX idx_pa_adjusted_by (adjusted_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add adjustment columns to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS adjustment_amount DECIMAL(12, 2) DEFAULT 0 AFTER due_amount;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_adjustment TINYINT(1) DEFAULT 0 AFTER adjustment_amount;

-- Add adjustment columns to invoices
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS adjustment_amount DECIMAL(12, 2) DEFAULT 0 AFTER due_amount;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_adjustment TINYINT(1) DEFAULT 0 AFTER adjustment_amount;

-- Add adjustment columns to payments
ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_adjustment TINYINT(1) DEFAULT 0 AFTER notes;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS adjustment_amount DECIMAL(12, 2) DEFAULT 0 AFTER is_adjustment;
