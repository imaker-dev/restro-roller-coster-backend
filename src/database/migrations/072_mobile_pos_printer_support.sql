-- =====================================================
-- Mobile POS Support
-- Adds device_id to printers table for identifying mobile POS devices
-- connection_type = 'mobile_pos' routes prints via Socket.IO to device
-- =====================================================

-- Add device_id column for mobile POS identification
ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS device_id VARCHAR(100) NULL AFTER connection_type,
    ADD INDEX idx_printers_device_id (device_id);

-- Add index for connection_type lookup
ALTER TABLE printers
    ADD INDEX IF NOT EXISTS idx_printers_connection_type (connection_type);
