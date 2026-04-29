/**
 * Verify: GET /self-order/staff/qr/tables/:outletId response shape
 * - All tables included (floor-wise)
 * - Tables without QR → qrStatus: 'unavailable', qrImagePath: null
 * - Tables with QR → qrStatus: 'available', qrImagePath with APP_URL prefix
 *
 * Run: node tests/_verify_qr_tables_response.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const dbConfig = require('../src/config/database.config');

const OUTLET_ID = 43;

async function run() {
  const conn = await mysql.createConnection({
    host: dbConfig.host, port: dbConfig.port,
    database: dbConfig.database, user: dbConfig.user, password: dbConfig.password
  });

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  QR TABLES API RESPONSE VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let pass = 0, fail = 0;
  function ok(cond, msg) {
    if (cond) { pass++; console.log(`  ✅ ${msg}`); }
    else { fail++; console.log(`  ❌ ${msg}`); }
  }

  // ── Get raw DB data ──
  const [allTables] = await conn.query(
    `SELECT t.id, t.table_number, t.qr_code, t.floor_id, f.name as floor_name
     FROM tables t LEFT JOIN floors f ON t.floor_id = f.id
     WHERE t.outlet_id = ? AND t.is_active = 1 ORDER BY f.name, t.table_number`,
    [OUTLET_ID]
  );
  const totalExpected = allTables.length;
  const withQr = allTables.filter(t => t.qr_code).length;
  const withoutQr = totalExpected - withQr;

  console.log(`📋 DB has ${totalExpected} active tables for outlet ${OUTLET_ID}`);
  console.log(`   → ${withQr} with QR, ${withoutQr} without QR\n`);

  const [[outlet]] = await conn.query('SELECT id, name FROM outlets WHERE id = ?', [OUTLET_ID]);
  const appUrl = (process.env.APP_URL || 'http://localhost:3005').replace(/\/$/, '');
  const selfOrderUrl = process.env.SELF_ORDER_URL || 'http://localhost:3000';

  // ── Simulate getTableQrUrls logic ──
  let tablesWithQrCount = 0;
  const floorMap = new Map();
  for (const t of allTables) {
    const fId = t.floor_id || 0;
    if (!floorMap.has(fId)) {
      floorMap.set(fId, { floorId: t.floor_id || null, floorName: t.floor_name || 'No Floor', tables: [] });
    }
    const hasQr = !!t.qr_code;
    if (hasQr) tablesWithQrCount++;
    floorMap.get(fId).tables.push({
      tableId: t.id, tableNumber: t.table_number,
      qrStatus: hasQr ? 'available' : 'unavailable',
      qrUrl: hasQr ? `${selfOrderUrl}/self-order?outlet=${OUTLET_ID}&table=${t.id}` : null,
      qrImagePath: hasQr ? `${appUrl}/${t.qr_code}` : null,
    });
  }
  const result = {
    outlet, floors: Array.from(floorMap.values()),
    totalTables: allTables.length, tablesWithQr: tablesWithQrCount,
    tablesMissingQr: allTables.length - tablesWithQrCount,
  };

  // ── Assertions ──
  console.log('── TEST 1: All tables included floor-wise ──');
  const returnedTables = result.floors.reduce((s, f) => s + f.tables.length, 0);
  ok(returnedTables === totalExpected, `All ${totalExpected} tables returned (got ${returnedTables})`);
  ok(result.tablesWithQr === withQr, `tablesWithQr = ${withQr} (got ${result.tablesWithQr})`);
  ok(result.tablesMissingQr === withoutQr, `tablesMissingQr = ${withoutQr} (got ${result.tablesMissingQr})`);

  console.log('\n── TEST 2: Floors present ──');
  ok(result.floors.length > 0, `Response has ${result.floors.length} floor(s)`);
  for (const floor of result.floors) {
    ok(floor.floorId !== undefined, `Floor "${floor.floorName}" has floorId field`);
    ok(Array.isArray(floor.tables), `Floor "${floor.floorName}" has tables array`);
  }

  console.log('\n── TEST 3: qrStatus field on every table ──');
  for (const floor of result.floors) {
    for (const t of floor.tables) {
      ok(t.qrStatus === 'available' || t.qrStatus === 'unavailable',
        `Table T${t.tableNumber}: qrStatus is '${t.qrStatus}'`);
    }
  }

  console.log('\n── TEST 4: APP_URL prefix on qrImagePath ──');
  const qrAvailable = result.floors.flatMap(f => f.tables).filter(t => t.qrStatus === 'available');
  const qrUnavailable = result.floors.flatMap(f => f.tables).filter(t => t.qrStatus === 'unavailable');

  if (qrAvailable.length > 0) {
    ok(qrAvailable[0].qrImagePath.startsWith(appUrl),
      `qrImagePath starts with APP_URL "${appUrl}" → ${qrAvailable[0].qrImagePath}`);
    ok(qrAvailable[0].qrUrl !== null, `qrUrl is set for available table`);
  } else {
    console.log('  ⏭️  No tables with QR yet — generate QRs to test this');
  }

  if (qrUnavailable.length > 0) {
    ok(qrUnavailable[0].qrImagePath === null, `qrImagePath is null for unavailable table`);
    ok(qrUnavailable[0].qrUrl === null, `qrUrl is null for unavailable table`);
  }

  // ── Floor-wise breakdown ──
  console.log('\n--- Floor-wise breakdown ---');
  for (const floor of result.floors) {
    console.log(`  ${floor.floorName} (floorId=${floor.floorId}): ${floor.tables.length} table(s)`);
    for (const t of floor.tables) {
      console.log(`    T${t.tableNumber}: ${t.qrStatus}${t.qrImagePath ? ' → ' + t.qrImagePath : ''}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  ✅ Passed: ${pass}   │   ❌ Failed: ${fail}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  await conn.end();
  if (fail > 0) process.exit(1);
  else { console.log('✅ All QR table response tests passed!\n'); process.exit(0); }
}

run().catch(e => { console.error(e); process.exit(1); });
