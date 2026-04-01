-- Migration: Add tax_enabled flag to items and variants tables
-- This allows disabling tax calculation for specific items even if they have a tax group assigned

-- Add tax_enabled column to items table
ALTER TABLE items 
ADD COLUMN tax_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether tax should be calculated for this item (1=enabled, 0=disabled)' 
AFTER tax_group_id;

-- Add tax_enabled column to variants table
ALTER TABLE variants 
ADD COLUMN tax_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether tax should be calculated for this variant (1=enabled, 0=disabled)' 
AFTER tax_group_id;

-- Add index for filtering items by tax status
CREATE INDEX idx_items_tax_enabled ON items(tax_enabled);
