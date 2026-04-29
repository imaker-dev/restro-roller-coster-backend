require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

(async () => {
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port,
    database: dbConfig.database, user: dbConfig.user, password: dbConfig.password
  });

  console.log('\n=== MySQL Connection Settings ===');
  const [vars] = await conn.query(
    `SHOW VARIABLES WHERE Variable_name IN ('max_connections','wait_timeout','interactive_timeout','max_allowed_packet')`
  );
  console.table(vars);

  console.log('\n=== Current Connection Status ===');
  const [status] = await conn.query(
    `SHOW STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Max_used_connections','Connection_errors_max_connections','Aborted_connects')`
  );
  console.table(status);

  await conn.end();
})();
