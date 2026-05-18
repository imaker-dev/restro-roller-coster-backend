-- =====================================================
-- USB Printer Path Support
-- Adds usb_path column so USB printers can be configured
-- without an IP address. The bridge agent reads this path
-- and writes ESC/POS bytes directly to the device.
--
-- Linux:   /dev/usb/lp0
-- Windows: \\.\COM1  (COM port emulation from USB driver)
-- =====================================================

ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS usb_path VARCHAR(100) NULL
        COMMENT 'USB device path: /dev/usb/lp0 (Linux) or \\.\COM1 (Windows)'
        AFTER port;

ALTER TABLE printers
    ADD INDEX IF NOT EXISTS idx_printers_usb_path (usb_path);
