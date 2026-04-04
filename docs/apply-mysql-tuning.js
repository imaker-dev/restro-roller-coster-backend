/**
 * MySQL Server Tuning — Audit & Apply
 * Run: node docs/apply-mysql-tuning.js
 *
 * 1. Detects if the DB user has SUPER privilege
 * 2. If YES  → applies settings via SET GLOBAL (runtime, non-persistent)
 * 3. If NO   → prints current vs recommended values + generates my.cnf block
 *
 * Either way, the my.cnf block is printed so the server admin can make
 * settings persistent across MySQL restarts.
 */
require('dotenv').config();
const { initializeDatabase, getPool } = require('../src/database');

// Recommended settings (variable → value as it would appear in my.cnf)
const recommended = [
  // Connections
  { variable: 'max_connections',                value: '300' },
  { variable: 'thread_cache_size',              value: '64' },
  // InnoDB engine
  { variable: 'innodb_buffer_pool_size',        value: '1G',    raw: '1073741824' },
  { variable: 'innodb_io_capacity',             value: '2000' },
  { variable: 'innodb_io_capacity_max',         value: '4000' },
  { variable: 'innodb_flush_log_at_trx_commit', value: '2' },
  { variable: 'innodb_log_file_size',           value: '256M',  restartOnly: true },
  // Timeouts
  { variable: 'wait_timeout',                   value: '300' },
  { variable: 'interactive_timeout',            value: '300' },
  // Packet
  { variable: 'max_allowed_packet',             value: '16M',   raw: '16777216' },
  // Slow query log
  { variable: 'slow_query_log',                 value: 'ON',    mycnf: '1' },
  { variable: 'long_query_time',                value: '1' },
  { variable: 'log_queries_not_using_indexes',  value: 'OFF',   mycnf: '0' },
  // Table cache
  { variable: 'table_open_cache',               value: '4000' },
  // Buffers
  { variable: 'sort_buffer_size',               value: '2M',    raw: '2097152' },
  { variable: 'join_buffer_size',               value: '2M',    raw: '2097152' },
  // Temp tables
  { variable: 'tmp_table_size',                 value: '64M',   raw: '67108864' },
  { variable: 'max_heap_table_size',            value: '64M',   raw: '67108864' },
];

function humanize(variable, val) {
  const num = parseInt(val, 10);
  if (isNaN(num)) return val;
  if (variable.includes('size') || variable.includes('packet') || variable.includes('heap')) {
    if (num >= 1073741824) return `${(num / 1073741824).toFixed(0)} GB`;
    if (num >= 1048576) return `${(num / 1048576).toFixed(0)} MB`;
    if (num >= 1024) return `${(num / 1024).toFixed(0)} KB`;
  }
  return val;
}

(async () => {
  try {
    await initializeDatabase();
    const pool = getPool();

    // --- Detect MySQL version ---
    const [[verRow]] = await pool.query('SELECT VERSION() as ver');
    console.log(`\n  MySQL version: ${verRow.ver}`);

    // --- Detect SUPER privilege ---
    let hasSuper = false;
    try {
      await pool.query("SET GLOBAL wait_timeout = 28800"); // harmless default
      await pool.query("SET GLOBAL wait_timeout = 28800"); // restore
      hasSuper = true;
    } catch { hasSuper = false; }

    if (hasSuper) {
      console.log('  Privilege: SUPER ✅ — can apply settings at runtime\n');
    } else {
      console.log('  Privilege: NO SUPER ❌ — cannot SET GLOBAL; showing audit only\n');
      console.log('  ➡️  Give the my.cnf block (printed below) to your server admin / DevOps.\n');
    }

    // --- Fetch current values ---
    console.log('=== Current vs Recommended ===\n');
    console.log('  Variable                            Current            Recommended');
    console.log('  ' + '─'.repeat(75));

    const varNames = recommended.map(r => r.variable);
    const [allVars] = await pool.query(
      `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${varNames.map(() => '?').join(',')})`,
      varNames
    );
    const currentMap = {};
    for (const row of allVars) currentMap[row.Variable_name] = row.Value;

    let needsChange = 0;
    for (const rec of recommended) {
      const current = currentMap[rec.variable] || '(not set)';
      const currentH = humanize(rec.variable, current);
      const recH = rec.value;
      // Compare: exact match, raw match, mycnf match, humanized match, or numeric equivalence
      const numCurrent = parseFloat(current);
      const numRec = parseFloat(rec.raw || rec.value);
      const match = (rec.raw ? current === rec.raw : current === rec.value) ||
                    (rec.mycnf && current === rec.mycnf) ||
                    currentH === recH ||
                    (!isNaN(numCurrent) && !isNaN(numRec) && numCurrent === numRec);
      const icon = match ? '✅' : '⚠️';
      if (!match) needsChange++;
      const tag = rec.restartOnly ? ' (restart)' : '';
      console.log(`  ${icon} ${rec.variable.padEnd(36)} ${currentH.padEnd(18)} ${recH}${tag}`);
    }

    // --- Apply at runtime if SUPER available ---
    if (hasSuper && needsChange > 0) {
      console.log('\n=== Applying Runtime Changes ===\n');
      let applied = 0, skipped = 0;

      for (const rec of recommended) {
        if (rec.restartOnly) { skipped++; continue; }
        // Use raw SQL (values are hardcoded constants, not user input)
        const sqlVal = rec.raw || rec.value;
        // String variables need quoting; numeric ones must NOT be quoted
        const needsQuote = isNaN(Number(sqlVal));
        const quoted = needsQuote ? `'${sqlVal}'` : sqlVal;
        try {
          await pool.query(`SET GLOBAL ${rec.variable} = ${quoted}`);
          console.log(`  ✅ ${rec.variable} = ${rec.value}`);
          applied++;
        } catch (e) {
          console.log(`  ❌ ${rec.variable} — ${e.message}`);
        }
      }
      console.log(`\n  Applied: ${applied} | Skipped (restart-only): ${skipped}`);
    }

    // --- Always print my.cnf block ---
    console.log('\n=== Copy-paste into my.cnf under [mysqld] section ===');
    console.log('=== Location: /etc/mysql/mysql.conf.d/mysqld.cnf (Ubuntu)');
    console.log('===       or: /etc/my.cnf (CentOS/RHEL/Amazon Linux) ===\n');
    console.log('[mysqld]');
    for (const rec of recommended) {
      const val = rec.mycnf || rec.value;
      console.log(`${rec.variable} = ${val}`);
    }

    console.log('\n# After editing my.cnf, restart MySQL:');
    console.log('# sudo systemctl restart mysql    (Ubuntu/Debian)');
    console.log('# sudo systemctl restart mysqld   (CentOS/RHEL)');

    if (!hasSuper) {
      console.log('\n# To grant SUPER to your DB user (run as root):');
      console.log(`# GRANT SUPER ON *.* TO '${process.env.DB_USER || 'your_user'}'@'%';`);
      console.log('# FLUSH PRIVILEGES;');
    }

    console.log('');
    process.exit(0);
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
})();
