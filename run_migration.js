require('dotenv').config();
const dbConfig = require('./src/config/database.config');
const mysql = require('mysql2/promise');

(async () => {
  try {
    console.log('Connecting to database...');
    console.log(`  Host: ${dbConfig.host}`);
    console.log(`  User: ${dbConfig.user}`);
    console.log(`  Database: ${dbConfig.database}`);
    console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
    
    const conn = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database
    });
    
    // Migration 052: Add tax_enabled column to items and variants tables
    console.log('Running migration 052: Add tax_enabled to items and variants...');
    
    // Check if column already exists in items table
    const [itemsCols] = await conn.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'items' AND COLUMN_NAME = 'tax_enabled'",
      [dbConfig.database]
    );
    
    if (itemsCols.length === 0) {
      await conn.execute("ALTER TABLE items ADD COLUMN tax_enabled TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether tax should be calculated for this item' AFTER tax_group_id");
      console.log('  Added tax_enabled column to items table');
    } else {
      console.log('  - tax_enabled column already exists in items table');
    }
    
    // Check if column already exists in variants table
    const [variantsCols] = await conn.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'variants' AND COLUMN_NAME = 'tax_enabled'",
      [dbConfig.database]
    );
    
    if (variantsCols.length === 0) {
      await conn.execute("ALTER TABLE variants ADD COLUMN tax_enabled TINYINT(1) DEFAULT NULL COMMENT 'Override item tax_enabled setting for this variant' AFTER tax_group_id");
      console.log('  Added tax_enabled column to variants table');
    } else {
      console.log('  - tax_enabled column already exists in variants table');
    }
    
    // Add index if not exists
    const [indexes] = await conn.execute(
      "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'items' AND INDEX_NAME = 'idx_items_tax_enabled'",
      [dbConfig.database]
    );
    
    if (indexes.length === 0) {
      await conn.execute("CREATE INDEX idx_items_tax_enabled ON items(tax_enabled)");
      console.log('  Added index idx_items_tax_enabled');
    } else {
      console.log('  - Index idx_items_tax_enabled already exists');
    }
    
    console.log('Migration 052 completed successfully!');
    
    await conn.end();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
})();