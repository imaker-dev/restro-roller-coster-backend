-- Fix: Increase price-per-base-unit precision from DECIMAL(12,4) to DECIMAL(12,6)
-- Root cause: When dividing price by large conversion factors (e.g. 1200ml bottle),
-- 4 decimal places loses precision → rounding error when converting back for display.
-- Example: ₹1000/btl1200 → 1000/1200 = 0.8333 (4dp) → 0.8333*1200 = 999.96 (BUG)
-- Fix:     ₹1000/btl1200 → 1000/1200 = 0.833333 (6dp) → 0.833333*1200 = 999.9996 → rounds to 1000 ✓

-- inventory_batches: purchase_price is per-base-unit
ALTER TABLE inventory_batches
  MODIFY COLUMN purchase_price DECIMAL(12, 6) NOT NULL DEFAULT 0;

-- inventory_items: average_price and latest_price are per-base-unit
ALTER TABLE inventory_items
  MODIFY COLUMN average_price DECIMAL(12, 6) DEFAULT 0,
  MODIFY COLUMN latest_price DECIMAL(12, 6) DEFAULT 0;

-- inventory_movements: unit_cost is per-base-unit
ALTER TABLE inventory_movements
  MODIFY COLUMN unit_cost DECIMAL(12, 6) DEFAULT 0;

-- purchase_items: price_per_base_unit
ALTER TABLE purchase_items
  MODIFY COLUMN price_per_base_unit DECIMAL(12, 6) NOT NULL;

-- Recalculate existing batch prices from original purchase data
-- purchase_items.price_per_unit is the original user-entered price (intact)
-- Recalculate: price_per_base_unit = price_per_unit / unit.conversion_factor
UPDATE purchase_items pi
  JOIN units u ON pi.unit_id = u.id
  SET pi.price_per_base_unit = ROUND(pi.price_per_unit / u.conversion_factor, 6);

-- Recalculate batch purchase_price from the linked purchase_item
UPDATE inventory_batches ib
  JOIN purchase_items pi ON ib.purchase_item_id = pi.id
  SET ib.purchase_price = pi.price_per_base_unit;

-- Recalculate inventory_items average_price using weighted average from active batches
UPDATE inventory_items ii
  SET average_price = COALESCE((
    SELECT ROUND(SUM(ib.remaining_quantity * ib.purchase_price) / NULLIF(SUM(ib.remaining_quantity), 0), 6)
    FROM inventory_batches ib
    WHERE ib.inventory_item_id = ii.id AND ib.remaining_quantity > 0 AND ib.is_active = 1
  ), ii.average_price),
  latest_price = COALESCE((
    SELECT ib2.purchase_price
    FROM inventory_batches ib2
    WHERE ib2.inventory_item_id = ii.id AND ib2.is_active = 1
    ORDER BY ib2.purchase_date DESC, ib2.id DESC LIMIT 1
  ), ii.latest_price);

-- Recalculate movement unit_cost from the linked batch
UPDATE inventory_movements im
  JOIN inventory_batches ib ON im.inventory_batch_id = ib.id
  SET im.unit_cost = ib.purchase_price
  WHERE im.movement_type IN ('purchase', 'sale', 'wastage');
