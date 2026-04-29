-- =====================================================
-- ADD token_number TO INVOICES
-- Daily sequential bill token per outlet (1, 2, 3...)
-- Resets every day. Displayed prominently on bill print.
-- =====================================================

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS token_number INT UNSIGNED NULL AFTER invoice_number;

CREATE INDEX IF NOT EXISTS idx_invoices_token ON invoices (outlet_id, invoice_date, token_number);
