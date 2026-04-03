-- =====================================================
-- ADD WEIGHT COLUMN TO ORDER ITEMS
-- Allows cashier to manually enter weight for open items
-- (e.g., "500gm", "50ml", "1.5kg")
-- =====================================================

ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS weight VARCHAR(50) DEFAULT NULL AFTER quantity;
