-- =====================================================
-- ADD nc_tax_amount COLUMN TO INVOICES
-- This column was referenced in billing.service.js but
-- was never added via a migration (only via a one-off
-- script). Adding it here so all fresh installs and
-- existing installs that missed the script get it.
-- =====================================================

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS nc_tax_amount DECIMAL(12, 2) DEFAULT 0 AFTER nc_amount;
