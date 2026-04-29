/**
 * Migration 069b: Update Self-Order Defaults in Database
 *
 * 1. Update self_order_sessions column defaults (idle=10, buffer=1)
 * 2. Update existing sessions that still have old defaults (20/5)
 * 3. Seed self_order_idle_timeout_minutes and self_order_completion_buffer_minutes
 *    into system_settings for all existing outlets (and global)
 *
 * Run: node scripts/run-migration-069b.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

async function run() {
  console.log('\n🚀 Migration 069b: Update Self-Order Default Settings\n');

  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port, database: dbConfig.database,
    user: dbConfig.user, password: dbConfig.password
  });

  try {
    // ─── 1. Update column defaults on self_order_sessions ─────────────────
    console.log('📄 Updating column defaults on self_order_sessions...');

    await conn.query(`
      ALTER TABLE self_order_sessions
        ALTER COLUMN idle_timeout_minutes SET DEFAULT 10,
        ALTER COLUMN completion_buffer_minutes SET DEFAULT 1
    `);
    console.log('✅  idle_timeout_minutes DEFAULT → 10');
    console.log('✅  completion_buffer_minutes DEFAULT → 1');

    // ─── 2. Back-fill existing sessions that have old defaults ─────────────
    console.log('\n📄 Back-filling existing sessions...');

    const [r1] = await conn.query(`
      UPDATE self_order_sessions
      SET idle_timeout_minutes = 10
      WHERE idle_timeout_minutes = 20
    `);
    console.log(`✅  ${r1.affectedRows} session(s) updated: idle_timeout_minutes 20 → 10`);

    const [r2] = await conn.query(`
      UPDATE self_order_sessions
      SET completion_buffer_minutes = 1
      WHERE completion_buffer_minutes = 5
    `);
    console.log(`✅  ${r2.affectedRows} session(s) updated: completion_buffer_minutes 5 → 1`);

    // ─── 3. Seed settings into system_settings ─────────────────────────────
    console.log('\n📄 Seeding settings into system_settings...');

    const newSettings = [
      {
        key: 'self_order_idle_timeout_minutes',
        value: '10',
        type: 'number',
        description: 'Minutes before a session with no order placed is expired (idle timeout)'
      },
      {
        key: 'self_order_completion_buffer_minutes',
        value: '1',
        type: 'number',
        description: 'Minutes after order completion before session is expired'
      },
    ];

    // Get all active outlets
    const [outlets] = await conn.query(`SELECT id FROM outlets WHERE is_active = 1`);
    const outletIds = outlets.map(o => o.id);

    // Also seed at global level (outlet_id = NULL)
    const targets = [null, ...outletIds];

    let inserted = 0, skipped = 0;
    for (const outletId of targets) {
      for (const s of newSettings) {
        const [existing] = await conn.query(
          `SELECT id FROM system_settings WHERE setting_key = ? AND outlet_id ${outletId === null ? 'IS NULL' : '= ?'}`,
          outletId === null ? [s.key] : [s.key, outletId]
        );

        if (existing.length > 0) {
          skipped++;
          continue;
        }

        await conn.query(
          `INSERT INTO system_settings (outlet_id, setting_key, setting_value, setting_type, description, is_editable, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())`,
          [outletId, s.key, s.value, s.type, s.description]
        );
        inserted++;
      }
    }

    console.log(`✅  ${inserted} setting row(s) inserted`);
    if (skipped > 0) console.log(`⚠️   ${skipped} row(s) already existed — skipped`);

    // ─── 4. Verification ───────────────────────────────────────────────────
    console.log('\n📋 Verification:');

    const [cols] = await conn.query(`
      SELECT COLUMN_NAME, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'self_order_sessions'
        AND COLUMN_NAME IN ('idle_timeout_minutes', 'completion_buffer_minutes')
    `, [dbConfig.database]);

    for (const c of cols) {
      console.log(`   ${c.COLUMN_NAME}: DEFAULT = ${c.COLUMN_DEFAULT}`);
    }

    const [rows] = await conn.query(`
      SELECT setting_key, setting_value, outlet_id
      FROM system_settings
      WHERE setting_key IN ('self_order_idle_timeout_minutes', 'self_order_completion_buffer_minutes')
      ORDER BY setting_key, outlet_id
    `);

    for (const r of rows) {
      console.log(`   [outlet ${r.outlet_id ?? 'global'}] ${r.setting_key} = ${r.setting_value}`);
    }

    console.log('\n✅ Migration 069b completed successfully!\n');

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

run();
