const dbConfig = require('./src/config/database.config');
const mysql = require('mysql2/promise');

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database
    });
    
    await conn.execute("ALTER TABLE app_versions MODIFY COLUMN platform ENUM('global', 'app_store', 'play_store', 'exe', 'mac_os') NOT NULL DEFAULT 'global'");
    console.log('Migration successful: mac_os added to platform ENUM');
    
    await conn.end();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
})();