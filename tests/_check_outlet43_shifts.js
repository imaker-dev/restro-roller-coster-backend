require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

(async () => {
  const conn = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password
  });

  console.log('=== Open Shifts for Outlet 43 ===');
  const [shifts] = await conn.query(
    `SELECT id, floor_id, session_date, status, opened_by, cashier_id 
     FROM day_sessions WHERE outlet_id = 43 AND status = 'open'`
  );
  console.table(shifts);

  console.log('\n=== All Floors for Outlet 43 ===');
  const [floors] = await conn.query('SELECT id, name FROM floors WHERE outlet_id = 43');
  console.table(floors);

  console.log('\n=== User Floor Assignments for Outlet 43 ===');
  const [userFloors] = await conn.query(
    `SELECT uf.user_id, u.name as user_name, uf.floor_id, f.name as floor_name, uf.is_primary 
     FROM user_floors uf 
     JOIN users u ON uf.user_id = u.id 
     LEFT JOIN floors f ON uf.floor_id = f.id 
     WHERE uf.outlet_id = 43 AND uf.is_active = 1`
  );
  console.table(userFloors);

  await conn.end();
})();
