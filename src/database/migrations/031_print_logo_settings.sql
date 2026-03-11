-- =====================================================
-- PRINT LOGO SETTINGS MIGRATION
-- Adds print_logo_url column to outlets table for thermal printer logo
-- =====================================================

-- Add print_logo_url column to outlets (separate from main logo_url for print-optimized images)
ALTER TABLE outlets 
ADD COLUMN IF NOT EXISTS print_logo_url VARCHAR(500) AFTER logo_url;

-- Add print_logo_enabled flag directly on outlet for quick toggle
ALTER TABLE outlets 
ADD COLUMN IF NOT EXISTS print_logo_enabled BOOLEAN DEFAULT FALSE AFTER print_logo_url;

-- Insert default print_logo_on_bill setting
INSERT INTO system_settings (outlet_id, setting_key, setting_value, setting_type, description, is_editable)
VALUES (NULL, 'print_logo_on_bill', 'false', 'boolean', 'Print logo on bills and invoices', 1)
ON DUPLICATE KEY UPDATE description = 'Print logo on bills and invoices';
