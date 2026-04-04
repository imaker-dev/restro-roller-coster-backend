/**
 * MySQL Server Tuning Script
 * Run: node docs/apply-mysql-tuning.js
 * 
 * Applies all runtime-tunable MySQL settings for peak performance.
 * For innodb_log_file_size=256M, you must edit my.cnf and restart MySQL.
 */
require('dotenv').config();
const { initializeDatabase, getPool } = require('../src/database');

const tuningCommands = [
  // 1. Connection limits
  { sql: "SET GLOBAL max_connections = 300", desc: "max_connections → 300" },
  { sql: "SET GLOBAL thread_cache_size = 64", desc: "thread_cache_size → 64" },

  // 2. InnoDB Buffer Pool (1 GB)
  { sql: "SET GLOBAL innodb_buffer_pool_size = 1073741824", desc: "innodb_buffer_pool_size → 1 GB" },
  { sql: "SET GLOBAL innodb_buffer_pool_instances = 1", desc: "innodb_buffer_pool_instances → 1" },

  // 3. InnoDB I/O capacity (SSD)
  { sql: "SET GLOBAL innodb_io_capacity = 2000", desc: "innodb_io_capacity → 2000" },
  { sql: "SET GLOBAL innodb_io_capacity_max = 4000", desc: "innodb_io_capacity_max → 4000" },

  // 4. Write performance (balanced durability)
  { sql: "SET GLOBAL innodb_flush_log_at_trx_commit = 2", desc: "innodb_flush_log_at_trx_commit → 2" },

  // 5. Connection timeouts (5 min instead of 8 hours)
  { sql: "SET GLOBAL wait_timeout = 300", desc: "wait_timeout → 300" },
  { sql: "SET GLOBAL interactive_timeout = 300", desc: "interactive_timeout → 300" },

  // 6. Packet size (16 MB for large result sets)
  { sql: "SET GLOBAL max_allowed_packet = 16777216", desc: "max_allowed_packet → 16 MB" },

  // 7. Slow query log
  { sql: "SET GLOBAL slow_query_log = 'ON'", desc: "slow_query_log → ON" },
  { sql: "SET GLOBAL long_query_time = 1", desc: "long_query_time → 1 sec" },
  { sql: "SET GLOBAL log_queries_not_using_indexes = 'OFF'", desc: "log_queries_not_using_indexes → OFF" },

  // 8. Table open cache
  { sql: "SET GLOBAL table_open_cache = 4000", desc: "table_open_cache → 4000" },
  { sql: "SET GLOBAL table_open_cache_instances = 16", desc: "table_open_cache_instances → 16" },

  // 9. Sort/join buffers (2 MB each)
  { sql: "SET GLOBAL sort_buffer_size = 2097152", desc: "sort_buffer_size → 2 MB" },
  { sql: "SET GLOBAL join_buffer_size = 2097152", desc: "join_buffer_size → 2 MB" },

  // 10. Temp table size (64 MB)
  { sql: "SET GLOBAL tmp_table_size = 67108864", desc: "tmp_table_size → 64 MB" },
  { sql: "SET GLOBAL max_heap_table_size = 67108864", desc: "max_heap_table_size → 64 MB" },
];

(async () => {
  try {
    await initializeDatabase();
    const pool = getPool();

    console.log('=== Applying MySQL Tuning ===\n');

    let success = 0;
    let failed = 0;

    for (const cmd of tuningCommands) {
      try {
        await pool.query(cmd.sql);
        console.log(`  ✅ ${cmd.desc}`);
        success++;
      } catch (e) {
        console.log(`  ❌ ${cmd.desc} — ${e.message}`);
        failed++;
      }
    }

    console.log(`\n=== Done: ${success} applied, ${failed} failed ===`);

    // Verify key settings
    console.log('\n=== Verification ===');
    const checks = [
      'max_connections', 'innodb_buffer_pool_size', 'innodb_buffer_pool_instances',
      'innodb_flush_log_at_trx_commit', 'wait_timeout', 'slow_query_log',
      'long_query_time', 'innodb_io_capacity'
    ];
    for (const v of checks) {
      const [rows] = await pool.query(`SHOW GLOBAL VARIABLES LIKE ?`, [v]);
      if (rows[0]) {
        console.log(`  ${rows[0].Variable_name} = ${rows[0].Value}`);
      }
    }

    console.log('\n⚠️  REMINDER: Add settings to my.cnf to make them persistent across MySQL restarts.');
    console.log('⚠️  innodb_log_file_size = 256M requires my.cnf edit + MySQL restart.\n');

    process.exit(0);
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
})();
