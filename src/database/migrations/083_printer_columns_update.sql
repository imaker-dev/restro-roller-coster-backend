-- =====================================================
-- Combined Printer Columns Update
-- Adds missing columns from reference migrations 072-075
-- (device_id, usb_path, printer_name, bluetooth_address)
-- and updates connection_type ENUM.
-- =====================================================

-- 1. Mobile POS device_id
ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS device_id VARCHAR(100) NULL AFTER connection_type;



-- 2. USB device path
ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS usb_path VARCHAR(100) NULL AFTER port;

-- 3. Windows printer spooler name
ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS printer_name VARCHAR(200) NULL AFTER usb_path;

-- 4. Bluetooth MAC address
ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS bluetooth_address VARCHAR(17) NULL AFTER printer_name;

-- 5. Update connection_type ENUM to support all connection modes
ALTER TABLE printers
    MODIFY COLUMN connection_type
        ENUM('usb','network','bluetooth','serial','cloud','mobile_pos','windows_printer')
        DEFAULT 'network';

-- 6. Add indexes for new columns
ALTER TABLE printers ADD INDEX IF NOT EXISTS idx_printers_device_id (device_id);
ALTER TABLE printers ADD INDEX IF NOT EXISTS idx_printers_usb_path (usb_path);
ALTER TABLE printers ADD INDEX IF NOT EXISTS idx_printers_bluetooth_address (bluetooth_address);
