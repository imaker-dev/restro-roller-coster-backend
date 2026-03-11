/**
 * Migration: Print Logo Settings
 * Adds print_logo_url and print_logo_enabled columns to outlets table
 * Also adds print_logo_on_bill setting to system_settings
 */

const { getPool } = require('../index');

async function up() {
  const pool = getPool();
  
  console.log('Running migration: 031_print_logo_settings');
  
  try {
    // Add print_logo_url column to outlets
    console.log('Adding print_logo_url column...');
    await pool.query(`
      ALTER TABLE outlets 
      ADD COLUMN IF NOT EXISTS print_logo_url VARCHAR(500) AFTER logo_url
    `);
    
    // Add print_logo_enabled flag
    console.log('Adding print_logo_enabled column...');
    await pool.query(`
      ALTER TABLE outlets 
      ADD COLUMN IF NOT EXISTS print_logo_enabled BOOLEAN DEFAULT FALSE AFTER print_logo_url
    `);
    
    // Insert default print_logo_on_bill setting
    console.log('Adding print_logo_on_bill setting...');
    await pool.query(`
      INSERT INTO system_settings (outlet_id, setting_key, setting_value, setting_type, description, is_editable)
      VALUES (NULL, 'print_logo_on_bill', 'false', 'boolean', 'Print logo on bills and invoices', 1)
      ON DUPLICATE KEY UPDATE description = 'Print logo on bills and invoices'
    `);
    
    console.log('Migration 031_print_logo_settings completed successfully');
    return { success: true };
  } catch (error) {
    console.error('Migration failed:', error.message);
    throw error;
  }
}

async function down() {
  const pool = getPool();
  
  console.log('Rolling back migration: 031_print_logo_settings');
  
  try {
    // Remove print_logo_enabled column
    console.log('Removing print_logo_enabled column...');
    await pool.query(`ALTER TABLE outlets DROP COLUMN IF EXISTS print_logo_enabled`);
    
    // Remove print_logo_url column
    console.log('Removing print_logo_url column...');
    await pool.query(`ALTER TABLE outlets DROP COLUMN IF EXISTS print_logo_url`);
    
    // Remove print_logo_on_bill setting
    console.log('Removing print_logo_on_bill setting...');
    await pool.query(`DELETE FROM system_settings WHERE setting_key = 'print_logo_on_bill'`);
    
    console.log('Rollback 031_print_logo_settings completed successfully');
    return { success: true };
  } catch (error) {
    console.error('Rollback failed:', error.message);
    throw error;
  }
}

// Run migration if executed directly
if (require.main === module) {
  const action = process.argv[2] || 'up';
  
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
  
  const runMigration = async () => {
    try {
      if (action === 'down' || action === 'rollback') {
        await down();
      } else {
        await up();
      }
      process.exit(0);
    } catch (error) {
      console.error('Migration error:', error);
      process.exit(1);
    }
  };
  
  runMigration();
}

module.exports = { up, down };
