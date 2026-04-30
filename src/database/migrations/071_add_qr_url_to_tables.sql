-- =====================================================
-- ADD qr_url TO TABLES
-- Stores the actual URL encoded inside the QR image.
-- Needed so getTableQrUrls returns the correct URL
-- after regeneration with a different baseUrl.
--
-- Compatible with MySQL 5.7+ (no IF NOT EXISTS on ADD COLUMN)
-- =====================================================

SET @dbname = DATABASE();
SET @col = 'qr_url';
SET @tbl = 'tables';
SET @stmt = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @dbname
        AND TABLE_NAME   = @tbl
        AND COLUMN_NAME  = @col
    ),
    'SELECT ''qr_url column already exists''',
    'ALTER TABLE tables ADD COLUMN qr_url VARCHAR(500) NULL AFTER qr_code'
  )
);
PREPARE migration_stmt FROM @stmt;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
