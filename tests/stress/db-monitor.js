/**
 * Database Query Monitor for Stress Testing
 * 
 * Monitors slow queries, connection pool, and query patterns
 * Usage: node tests/stress/db-monitor.js
 */

const dbConfig = require('../../src/config/database.config');
const mysql = require('mysql2/promise');

class DBMonitor {
  constructor() {
    this.pool = null;
    this.slowQueries = [];
    this.queryStats = {};
    this.startTime = null;
  }

  async connect() {
    this.pool = mysql.createPool({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      connectionLimit: 5
    });
    console.log('✅ Connected to database for monitoring');
  }

  async getProcessList() {
    const [rows] = await this.pool.query('SHOW FULL PROCESSLIST');
    return rows.filter(r => r.Command !== 'Sleep' && r.db === dbConfig.database);
  }

  async getSlowQueries() {
    try {
      const [rows] = await this.pool.query(`
        SELECT * FROM mysql.slow_log 
        WHERE start_time > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
        ORDER BY query_time DESC
        LIMIT 20
      `);
      return rows;
    } catch (e) {
      // Slow query log might not be enabled
      return [];
    }
  }

  async getConnectionStats() {
    const [threads] = await this.pool.query('SHOW STATUS LIKE "Threads_%"');
    const [connections] = await this.pool.query('SHOW STATUS LIKE "Connections"');
    const [maxConn] = await this.pool.query('SHOW VARIABLES LIKE "max_connections"');
    
    const stats = {};
    threads.forEach(r => stats[r.Variable_name] = r.Value);
    stats.Connections = connections[0]?.Value;
    stats.max_connections = maxConn[0]?.Value;
    
    return stats;
  }

  async getQueryCacheStats() {
    try {
      const [rows] = await this.pool.query('SHOW STATUS LIKE "Qcache%"');
      const stats = {};
      rows.forEach(r => stats[r.Variable_name] = r.Value);
      return stats;
    } catch (e) {
      return {};
    }
  }

  async getInnoDBStats() {
    const [rows] = await this.pool.query('SHOW STATUS LIKE "Innodb_%"');
    const stats = {};
    const important = [
      'Innodb_buffer_pool_reads',
      'Innodb_buffer_pool_read_requests',
      'Innodb_rows_read',
      'Innodb_rows_inserted',
      'Innodb_rows_updated',
      'Innodb_rows_deleted',
      'Innodb_deadlocks'
    ];
    rows.forEach(r => {
      if (important.includes(r.Variable_name)) {
        stats[r.Variable_name] = r.Value;
      }
    });
    return stats;
  }

  async getTableStats() {
    const [rows] = await this.pool.query(`
      SELECT 
        TABLE_NAME as table_name,
        TABLE_ROWS as row_count,
        ROUND(DATA_LENGTH / 1024 / 1024, 2) as data_mb,
        ROUND(INDEX_LENGTH / 1024 / 1024, 2) as index_mb
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY DATA_LENGTH DESC
      LIMIT 15
    `, [dbConfig.database]);
    return rows;
  }

  async getMissingIndexes() {
    // Check for tables without primary keys or indexes
    const [rows] = await this.pool.query(`
      SELECT 
        t.TABLE_NAME,
        t.TABLE_ROWS,
        GROUP_CONCAT(DISTINCT s.INDEX_NAME) as indexes
      FROM information_schema.TABLES t
      LEFT JOIN information_schema.STATISTICS s 
        ON t.TABLE_SCHEMA = s.TABLE_SCHEMA AND t.TABLE_NAME = s.TABLE_NAME
      WHERE t.TABLE_SCHEMA = ?
        AND t.TABLE_TYPE = 'BASE TABLE'
        AND t.TABLE_ROWS > 1000
      GROUP BY t.TABLE_NAME, t.TABLE_ROWS
      HAVING indexes IS NULL OR indexes = ''
    `, [dbConfig.database]);
    return rows;
  }

  async analyzeSlowPatterns() {
    // Get recent query patterns from performance schema if available
    try {
      const [rows] = await this.pool.query(`
        SELECT 
          DIGEST_TEXT as query_pattern,
          COUNT_STAR as exec_count,
          ROUND(AVG_TIMER_WAIT/1000000000, 2) as avg_ms,
          ROUND(MAX_TIMER_WAIT/1000000000, 2) as max_ms,
          SUM_ROWS_EXAMINED as rows_examined,
          SUM_ROWS_SENT as rows_sent
        FROM performance_schema.events_statements_summary_by_digest
        WHERE SCHEMA_NAME = ?
          AND AVG_TIMER_WAIT > 100000000
        ORDER BY AVG_TIMER_WAIT DESC
        LIMIT 10
      `, [dbConfig.database]);
      return rows;
    } catch (e) {
      return [];
    }
  }

  printStats(connStats, innoStats, tableStats) {
    console.clear();
    console.log('='.repeat(70));
    console.log('           🗄️  DATABASE MONITOR - LIVE STATS 🗄️');
    console.log('='.repeat(70));
    console.log(`  Time: ${new Date().toLocaleTimeString()}`);
    
    console.log('\n📊 CONNECTION POOL');
    console.log('-'.repeat(40));
    console.log(`  Active Threads:     ${connStats.Threads_running || 0}`);
    console.log(`  Connected Threads:  ${connStats.Threads_connected || 0}`);
    console.log(`  Max Connections:    ${connStats.max_connections || 0}`);
    console.log(`  Total Connections:  ${connStats.Connections || 0}`);
    
    console.log('\n📈 INNODB STATS');
    console.log('-'.repeat(40));
    console.log(`  Rows Read:          ${innoStats.Innodb_rows_read || 0}`);
    console.log(`  Rows Inserted:      ${innoStats.Innodb_rows_inserted || 0}`);
    console.log(`  Rows Updated:       ${innoStats.Innodb_rows_updated || 0}`);
    console.log(`  Buffer Pool Reads:  ${innoStats.Innodb_buffer_pool_reads || 0}`);
    console.log(`  Deadlocks:          ${innoStats.Innodb_deadlocks || 0}`);
    
    console.log('\n📋 TOP TABLES BY SIZE');
    console.log('-'.repeat(70));
    console.log('  Table'.padEnd(30) + 'Rows'.padEnd(12) + 'Data(MB)'.padEnd(12) + 'Index(MB)');
    console.log('-'.repeat(70));
    tableStats.slice(0, 10).forEach(t => {
      console.log(`  ${t.table_name.padEnd(28)} ${String(t.row_count || 0).padEnd(12)} ${String(t.data_mb || 0).padEnd(12)} ${t.index_mb || 0}`);
    });
    
    console.log('\n' + '='.repeat(70));
    console.log('  Press Ctrl+C to stop monitoring');
  }

  async startMonitoring(intervalMs = 2000) {
    await this.connect();
    this.startTime = Date.now();
    
    console.log('🔄 Starting database monitoring...\n');
    
    const monitor = async () => {
      try {
        const connStats = await this.getConnectionStats();
        const innoStats = await this.getInnoDBStats();
        const tableStats = await this.getTableStats();
        
        this.printStats(connStats, innoStats, tableStats);
      } catch (e) {
        console.error('Monitor error:', e.message);
      }
    };
    
    // Initial run
    await monitor();
    
    // Continuous monitoring
    const interval = setInterval(monitor, intervalMs);
    
    // Handle exit
    process.on('SIGINT', async () => {
      clearInterval(interval);
      console.log('\n\n📊 Final Analysis...\n');
      
      const slowPatterns = await this.analyzeSlowPatterns();
      if (slowPatterns.length > 0) {
        console.log('🐌 SLOW QUERY PATTERNS:');
        console.log('-'.repeat(70));
        slowPatterns.forEach(p => {
          console.log(`  Avg: ${p.avg_ms}ms | Max: ${p.max_ms}ms | Count: ${p.exec_count}`);
          console.log(`  Query: ${(p.query_pattern || '').substring(0, 80)}...`);
          console.log('');
        });
      }
      
      const missingIdx = await this.getMissingIndexes();
      if (missingIdx.length > 0) {
        console.log('⚠️  TABLES WITHOUT INDEXES (>1000 rows):');
        missingIdx.forEach(t => console.log(`  - ${t.TABLE_NAME} (${t.TABLE_ROWS} rows)`));
      }
      
      await this.pool.end();
      console.log('\n✅ Monitoring stopped');
      process.exit(0);
    });
  }
}

// Run monitor
const monitor = new DBMonitor();
monitor.startMonitoring(2000).catch(console.error);
