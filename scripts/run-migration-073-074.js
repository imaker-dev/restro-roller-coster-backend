/**
 * Migration runner for 073 and 074
 * 073 — Add usb_path column + index to printers table
 * 074 — Add printer_name column + windows_printer to connection_type ENUM
 *
 * Run: node scripts/run-migration-073-074.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const connection = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: false
  });

  console.log(`\n🔌 Connected to ${process.env.DB_NAME} @ ${process.env.DB_HOST}\n`);

  const steps = [
    {
      label: '073 — Add usb_path column',
      sql: `ALTER TABLE printers
              ADD COLUMN IF NOT EXISTS usb_path VARCHAR(100) NULL
                COMMENT 'USB device path: /dev/usb/lp0 (Linux) or \\\\.\\\\COM1 (Windows)'
              AFTER port`
    },
    {
      label: '073 — Add index on usb_path',
      sql: `ALTER TABLE printers
              ADD INDEX IF NOT EXISTS idx_printers_usb_path (usb_path)`
    },
    {
      label: '074 — Add printer_name column',
      sql: `ALTER TABLE printers
              ADD COLUMN IF NOT EXISTS printer_name VARCHAR(200) NULL
                COMMENT 'Windows printer name from Get-Printer (e.g. EPSON TM-T88IV Receipt)'
              AFTER usb_path`
    },
    {
      label: "074 — Add 'windows_printer' to connection_type ENUM",
      sql: `ALTER TABLE printers
              MODIFY COLUMN connection_type
                ENUM('usb','network','bluetooth','serial','cloud','mobile_pos','windows_printer')
                DEFAULT 'network'`
    }
  ];

  for (const step of steps) {
    try {
      await connection.query(step.sql);
      console.log(`  ✅ ${step.label}`);
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME' || err.message.includes('Duplicate column')) {
        console.log(`  ⏭️  ${step.label} — column already exists, skipped`);
      } else {
        console.error(`  ❌ ${step.label} — FAILED: ${err.message}`);
        await connection.end();
        process.exit(1);
      }
    }
  }

  // Verify final schema
  const [cols] = await connection.query(
    `SHOW COLUMNS FROM printers WHERE Field IN ('usb_path','printer_name','connection_type')`
  );
  console.log('\n📋 Verified columns:');
  cols.forEach(c => console.log(`   ${c.Field.padEnd(18)} ${c.Type}`));

  await connection.end();
  console.log('\n✅ Migrations 073 & 074 complete.\n');
}

run().catch(err => {
  console.error('Migration error:', err.message);
  process.exit(1);
});
