require('dotenv').config();
const { initializeDatabase, getPool } = require('../index');

(async () => {
  await initializeDatabase();
  const pool = getPool();

  const steps = [
    ["ALTER TABLE order_transfer_logs MODIFY COLUMN transfer_type ENUM('table','waiter','both','item') NOT NULL", 'Extend transfer_type ENUM'],
    ['ALTER TABLE order_transfer_logs ADD COLUMN target_order_id BIGINT UNSIGNED NULL AFTER to_table_id', 'Add target_order_id'],
    ['ALTER TABLE order_transfer_logs ADD COLUMN transfer_details JSON NULL AFTER reason', 'Add transfer_details'],
    ['ALTER TABLE order_transfer_logs ADD INDEX idx_transfer_logs_target_order (target_order_id)', 'Add index'],
  ];

  for (const [sql, label] of steps) {
    try {
      await pool.query(sql);
      console.log(`✅ ${label}`);
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME' || e.code === 'ER_DUP_FIELDNAME') {
        console.log(`⚠️ ${label} — already exists`);
      } else {
        console.error(`❌ ${label}: ${e.message}`);
      }
    }
  }

  process.exit(0);
})();
