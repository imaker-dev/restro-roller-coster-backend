-- Add purchase_unit_id to inventory_items
-- purchase_unit_id = the unit user selects (KG, Litre, pcs) for display/purchase
-- base_unit_id = auto-determined smallest unit (gram, ml, pcs) for internal storage
-- All stock/prices stored internally in base units, converted to purchase unit for API responses

ALTER TABLE inventory_items
  ADD COLUMN purchase_unit_id BIGINT UNSIGNED AFTER base_unit_id;

ALTER TABLE inventory_items
  ADD CONSTRAINT fk_inv_items_purchase_unit FOREIGN KEY (purchase_unit_id) REFERENCES units(id);

-- Backfill existing items: set purchase_unit_id = base_unit_id (no conversion change)
UPDATE inventory_items SET purchase_unit_id = base_unit_id WHERE purchase_unit_id IS NULL;
