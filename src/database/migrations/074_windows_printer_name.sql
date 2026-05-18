-- =====================================================
-- Windows Printer Name Support
-- Adds printer_name column and 'windows_printer' to
-- connection_type ENUM so printers can be addressed
-- by their Windows spooler name (e.g. "EPSON TM-T88IV Receipt")
-- instead of requiring a raw device path or COM port.
--
-- The bridge agent uses Win32 RawPrinterHelper API to
-- send ESC/POS bytes directly through the Windows spooler.
-- =====================================================

ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS printer_name VARCHAR(200) NULL
        COMMENT 'Windows printer name from Get-Printer (e.g. EPSON TM-T88IV Receipt)'
        AFTER usb_path;

ALTER TABLE printers
    MODIFY COLUMN connection_type
        ENUM('usb','network','bluetooth','serial','cloud','mobile_pos','windows_printer')
        DEFAULT 'network';
