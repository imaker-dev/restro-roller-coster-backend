-- =====================================================
-- Bluetooth Printer Support
-- Adds bluetooth_address to printers table for BLE/SPP thermal printers.
-- connection_type = 'bluetooth' routes prints via bridge agent which
-- connects to the paired Bluetooth device on the local machine.
--
-- The backend server NEVER attempts direct Bluetooth (range is too
-- short for cloud). Jobs always go through the bridge queue.
-- =====================================================

ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS bluetooth_address VARCHAR(17) NULL
        COMMENT 'Bluetooth MAC address for SPP thermal printer, e.g. 00:1B:DC:0F:01:00'
        AFTER printer_name;

ALTER TABLE printers
    ADD INDEX IF NOT EXISTS idx_printers_bluetooth_address (bluetooth_address);
