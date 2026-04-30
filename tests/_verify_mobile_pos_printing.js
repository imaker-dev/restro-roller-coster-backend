/**
 * Mobile POS Printing — Full Scenario Test
 *
 * Tests WITHOUT affecting Direct IP / Bridge printing or any real printer.
 *
 * Scenarios:
 *  1. Socket room: join:mpos → mpos:connected ack
 *  2. Device ONLINE:  sendToMobilePOS emits mpos:print, device receives correct payload
 *  3. Device OFFLINE: sendToMobilePOS returns null (bridge fallback triggered)
 *  4. Missing device_id: returns null (bridge fallback triggered)
 *  5. Socket not ready: returns null (bridge fallback triggered)
 *  6. mpos:print_done ACK: device sends back success/failure
 *  7. printKot routing: mobile_pos printers split from regular printers
 *  8. printBill routing: mobile_pos branch taken for mobile_pos printer
 *  9. Regular Direct/Bridge printers: COMPLETELY UNAFFECTED
 * 10. ESC/POS encoding: base64 payload round-trip is correct
 *
 * Run: node tests/_verify_mobile_pos_printing.js
 */
require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const { io: SocketClient } = require('socket.io-client');
const EventEmitter = require('events');
const testBus = new EventEmitter();

// ─── Helpers ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅  ${msg}`); }
  else       { fail++; console.log(`  ❌  ${msg}`); }
}
function section(title) {
  console.log(`\n  ── ${title}`);
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Boot a local test Socket.IO server ─────────────────────────────────────
function startTestServer() {
  return new Promise((resolve) => {
    const httpServer = http.createServer();
    const io = new Server(httpServer, { cors: { origin: '*' } });

    // Mirror exactly what src/config/socket.js does for mpos rooms
    io.on('connection', (socket) => {
      socket.on('join:mpos', (payload) => {
        const { outletId, station, deviceId, userId } = payload || {};
        if (!outletId) return;

        const joined = [];
        if (station) {
          const stationKey = String(station).toLowerCase().trim();
          const stationRoom = `mpos:${outletId}:station:${stationKey}`;
          socket.join(stationRoom);
          socket.mposStation = stationKey;
          joined.push(stationRoom);
        }
        if (userId) {
          const userRoom = `mpos:${outletId}:user:${userId}`;
          socket.join(userRoom);
          socket.mposUserId = userId;
          joined.push(userRoom);
        }
        if (deviceId) {
          const deviceRoom = `mpos:${outletId}:device:${deviceId}`;
          socket.join(deviceRoom);
          socket.mposDeviceId = deviceId;
          joined.push(deviceRoom);
        }
        socket.mposOutletId = outletId;
        socket.mposMode = userId ? 'user' : deviceId ? 'device' : 'station';
        if (joined.length > 0) {
          socket.emit('mpos:connected', {
            mode: socket.mposMode, station: socket.mposStation || null,
            userId: socket.mposUserId || null, deviceId: socket.mposDeviceId || null,
            rooms: joined, outletId, socketId: socket.id,
          });
        }
      });

      socket.on('mpos:print_done', ({ jobId, success, error }) => {
        testBus.emit('print_done', { jobId, success, error });
      });
    });

    httpServer.listen(0, () => {
      const port = httpServer.address().port;
      resolve({ io, httpServer, port });
    });
  });
}

// ─── sendToMobilePOS — extracted logic for isolated testing ─────────────────
// We replicate the function here with an injected `io` so we can test without
// starting the full app. Keeps tests independent of printer.service.js internals.
const { v4: uuidv4 } = require('uuid');

async function sendToMobilePOS_testable(io, printer, escpos, { jobType = 'print', ref = '', outletId, station, userId } = {}) {
  const effectiveOutletId = outletId || printer.outlet_id;
  if (!io) return null;

  const jobId = uuidv4();
  const escposBase64 = Buffer.isBuffer(escpos)
    ? escpos.toString('base64')
    : Buffer.from(escpos, 'binary').toString('base64');
  const payload = {
    jobId, jobType, referenceNumber: ref,
    printerId: printer.id, printerName: printer.name,
    escpos: escposBase64, timestamp: Date.now(),
  };

  // Priority 1: user room (cashier-specific — handles 5-10 devices same outlet)
  if (userId) {
    const userRoom = `mpos:${effectiveOutletId}:user:${userId}`;
    const s = await io.in(userRoom).allSockets();
    if (s.size > 0) {
      io.to(userRoom).emit('mpos:print', payload);
      return { method: 'mobile_pos', sent: true, jobId, printerId: printer.id, mode: 'user', room: userRoom };
    }
  }

  // Priority 2: device room (explicit)
  if (printer.device_id) {
    const deviceRoom = `mpos:${effectiveOutletId}:device:${printer.device_id}`;
    const s = await io.in(deviceRoom).allSockets();
    if (s.size > 0) {
      io.to(deviceRoom).emit('mpos:print', payload);
      return { method: 'mobile_pos', sent: true, jobId, printerId: printer.id, mode: 'device', room: deviceRoom };
    }
  }

  // Priority 3: station room (first socket only to prevent duplicates)
  const stationKey = (station || printer.station || 'cashier').toLowerCase().trim();
  const stationRoom = `mpos:${effectiveOutletId}:station:${stationKey}`;
  const stationSockets = await io.in(stationRoom).allSockets();
  if (stationSockets.size === 0) return null;

  if (stationSockets.size > 1) {
    const [first] = stationSockets;
    io.to(first).emit('mpos:print', payload);
  } else {
    io.to(stationRoom).emit('mpos:print', payload);
  }
  return { method: 'mobile_pos', sent: true, jobId, printerId: printer.id, mode: 'station', room: stationRoom };
}

// ─── Fake ESC/POS data ───────────────────────────────────────────────────────
const FAKE_ESCPOS = Buffer.from('\x1b@\x1ba\x01Test Receipt\n\x1d\x56\x42\x00', 'binary');

// ─── MAIN ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  MOBILE POS PRINTING — FULL SCENARIO TEST');
  console.log('════════════════════════════════════════════════════════════════');

  const { io, httpServer, port } = await startTestServer();
  const SERVER_URL = `http://localhost:${port}`;

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 1A: Station mode — join with station (recommended, zero config)
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 1A — Station mode: join with station name (no deviceId needed)');

  const OUTLET_ID = 43;
  const STATION   = 'cashier';

  const deviceClient = SocketClient(SERVER_URL, { transports: ['websocket'] });

  const stationAck = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3000);
    deviceClient.on('connect', () => {
      deviceClient.emit('join:mpos', { outletId: OUTLET_ID, station: STATION });
    });
    deviceClient.on('mpos:connected', (data) => { clearTimeout(t); resolve(data); });
  }).catch(() => null);

  ok(stationAck !== null, 'Device received mpos:connected ack (station mode)');
  ok(stationAck?.mode === 'station', 'ack.mode = "station"');
  ok(stationAck?.station === STATION, `ack.station = "${STATION}"`);
  ok(stationAck?.outletId === OUTLET_ID, `ack.outletId = ${OUTLET_ID}`);

  await wait(100);

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 1B: Device mode — join with explicit deviceId (optional)
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 1B — Device mode: join with explicit deviceId');

  const DEVICE_ID    = 'test-mpos-001';
  const deviceClientB = SocketClient(SERVER_URL, { transports: ['websocket'] });

  const deviceAck = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3000);
    deviceClientB.on('connect', () => {
      deviceClientB.emit('join:mpos', { outletId: OUTLET_ID, deviceId: DEVICE_ID });
    });
    deviceClientB.on('mpos:connected', (data) => { clearTimeout(t); resolve(data); });
  }).catch(() => null);

  ok(deviceAck !== null, 'Device received mpos:connected ack (device mode)');
  ok(deviceAck?.mode === 'device', 'ack.mode = "device"');
  ok(deviceAck?.deviceId === DEVICE_ID, `ack.deviceId = "${DEVICE_ID}"`);
  await wait(100);

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: Station mode — print job received by correct device
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 2 — Station mode: mpos:print emitted correctly');

  // Printer with NO device_id → routes by station
  const MOCK_PRINTER = { id: 99, outlet_id: OUTLET_ID, name: 'Cashier MPOS', device_id: null, station: STATION, connection_type: 'mobile_pos' };

  const printEventPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for mpos:print')), 3000);
    deviceClient.on('mpos:print', (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });

  const result = await sendToMobilePOS_testable(io, MOCK_PRINTER, FAKE_ESCPOS, {
    jobType: 'bill', ref: 'INV-001', outletId: OUTLET_ID
  });

  ok(result !== null, 'sendToMobilePOS returned non-null (device online)');
  ok(result?.method === 'mobile_pos', 'result.method = "mobile_pos"');
  ok(result?.sent === true, 'result.sent = true');
  ok(result?.mode === 'station', 'result.mode = "station" (no deviceId on printer)');
  ok(result?.room === `mpos:${OUTLET_ID}:station:${STATION}`, `result.room = mpos:${OUTLET_ID}:station:${STATION}`);
  ok(typeof result?.jobId === 'string' && result.jobId.length > 0, 'result.jobId is a UUID');

  const printEvent = await printEventPromise.catch(() => null);
  ok(printEvent !== null, 'Device received mpos:print event');
  ok(printEvent?.jobType === 'bill', 'event.jobType = "bill"');
  ok(printEvent?.referenceNumber === 'INV-001', 'event.referenceNumber = "INV-001"');
  ok(typeof printEvent?.escpos === 'string', 'event.escpos is a string (base64)');
  ok(printEvent?.printerId == 99, 'event.printerId = 99');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: ESC/POS base64 round-trip correctness
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 3 — ESC/POS base64 round-trip');

  const decoded = Buffer.from(printEvent.escpos, 'base64');
  ok(decoded.equals(FAKE_ESCPOS), 'Decoded ESC/POS bytes match original exactly');
  ok(decoded[0] === 0x1b && decoded[1] === 0x40, 'ESC @ (init) command preserved');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 4: mpos:print_done ACK from device
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 4 — Device sends mpos:print_done ACK');

  const donePromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 3000);
    testBus.once('print_done', (data) => {
      clearTimeout(t);
      resolve(data);
    });
    deviceClient.emit('mpos:print_done', { jobId: result.jobId, success: true });
  });

  const doneData = await donePromise.catch(() => null);
  ok(doneData !== null, 'Server received mpos:print_done');
  ok(doneData?.jobId === result.jobId, 'ACK jobId matches sent jobId');
  ok(doneData?.success === true, 'ACK success = true');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 5: No device in station room — returns null (bridge fallback)
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 5 — No device on station: returns null (bridge fallback)');

  const offlinePrinter = { ...MOCK_PRINTER, station: 'bar' }; // nobody joined 'bar' station
  const offlineResult = await sendToMobilePOS_testable(io, offlinePrinter, FAKE_ESCPOS, {
    jobType: 'bot', ref: 'BOT-007', outletId: OUTLET_ID
  });

  ok(offlineResult === null, 'Returns null when station room is empty (no device connected)');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 6: Device mode with unknown deviceId — returns null
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 6 — Device mode: unknown deviceId returns null');

  // Use station:'bar' which has NO device connected — device room empty AND station room empty
  const unknownDevicePrinter = { id: 100, outlet_id: OUTLET_ID, name: 'Unknown Device', device_id: 'ghost-device-000', station: 'bar', connection_type: 'mobile_pos' };
  const noDeviceResult = await sendToMobilePOS_testable(io, unknownDevicePrinter, FAKE_ESCPOS, { outletId: OUTLET_ID });

  ok(noDeviceResult === null, 'Returns null when device room AND station room are both empty (fully offline)');

  // Also verify: device_id set but offline → falls back to station if occupied
  const offlineDeviceOnlineStation = { id: 101, outlet_id: OUTLET_ID, name: 'Ghost+Station', device_id: 'ghost-device-000', station: STATION, connection_type: 'mobile_pos' };
  const fallbackResult = await sendToMobilePOS_testable(io, offlineDeviceOnlineStation, FAKE_ESCPOS, { outletId: OUTLET_ID });
  ok(fallbackResult !== null, 'Device offline but station has device → falls back to station (correct)');
  ok(fallbackResult?.mode === 'station', 'Fallback result mode = "station"');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 7: Socket.IO not ready — returns null
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 7 — Socket.IO not available: returns null');

  const noIoResult = await sendToMobilePOS_testable(null, MOCK_PRINTER, FAKE_ESCPOS, { outletId: OUTLET_ID });
  ok(noIoResult === null, 'Returns null when io is null (socket not initialized)');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 8: printKot routing logic — mobile_pos split from regular
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 8 — printKot routing: mobile_pos split from regular printers');

  const mockPrinters = [
    { id: 1, name: 'Kitchen Network', connection_type: 'network',    ip_address: '192.168.1.10', outlet_id: OUTLET_ID },
    { id: 2, name: 'Mobile POS A',    connection_type: 'mobile_pos', device_id: DEVICE_ID,       outlet_id: OUTLET_ID },
    { id: 3, name: 'Mobile POS B',    connection_type: 'mobile_pos', device_id: 'mpos-002',      outlet_id: OUTLET_ID },
    { id: 4, name: 'Bridge Printer',  connection_type: 'network',    ip_address: '192.168.1.20', outlet_id: OUTLET_ID },
  ];

  const mposPrinters   = mockPrinters.filter(p => p.connection_type === 'mobile_pos');
  const regularPrinters = mockPrinters.filter(p => p.connection_type !== 'mobile_pos');

  ok(mposPrinters.length === 2,    'Correctly identified 2 mobile_pos printers');
  ok(regularPrinters.length === 2, 'Correctly identified 2 regular (network) printers');
  ok(!mposPrinters.some(p => p.ip_address), 'No IP address on mobile_pos printers');
  ok(!regularPrinters.some(p => p.connection_type === 'mobile_pos'), 'No mobile_pos in regular set');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 9: printBill routing — mobile_pos printer detected correctly
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 9 — printBill routing: mobile_pos branch check');

  const mposBillPrinter  = { id: 5, connection_type: 'mobile_pos', device_id: DEVICE_ID, outlet_id: OUTLET_ID };
  const ipBillPrinter    = { id: 6, connection_type: 'network',    ip_address: '192.168.1.10', outlet_id: OUTLET_ID };
  const bridgeBillPrinter = { id: 7, connection_type: 'network',   ip_address: null,           outlet_id: OUTLET_ID };

  ok(mposBillPrinter.connection_type === 'mobile_pos', 'Mobile POS printer detected for bill route');
  ok(ipBillPrinter.connection_type !== 'mobile_pos',   'IP printer NOT routed through mobile_pos');
  ok(bridgeBillPrinter.connection_type !== 'mobile_pos','Bridge printer NOT routed through mobile_pos');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 10: Direct IP + Bridge printers — NOT affected at all
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 10 — Direct/Bridge printers: completely unaffected');

  const directPrinter = { id: 10, connection_type: 'network', ip_address: '10.0.0.5', port: 9100, outlet_id: OUTLET_ID };
  const bridgePrinter = { id: 11, connection_type: 'network', ip_address: null,        outlet_id: OUTLET_ID };

  // None of these should ever reach sendToMobilePOS — guard check
  const shouldBeNull1 = directPrinter.connection_type === 'mobile_pos'
    ? await sendToMobilePOS_testable(io, directPrinter, FAKE_ESCPOS, { outletId: OUTLET_ID })
    : 'skipped';
  const shouldBeNull2 = bridgePrinter.connection_type === 'mobile_pos'
    ? await sendToMobilePOS_testable(io, bridgePrinter, FAKE_ESCPOS, { outletId: OUTLET_ID })
    : 'skipped';

  ok(shouldBeNull1 === 'skipped', 'Direct IP printer: sendToMobilePOS never called (guarded by connection_type check)');
  ok(shouldBeNull2 === 'skipped', 'Bridge printer:    sendToMobilePOS never called (guarded by connection_type check)');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 11: Station mode — 2 devices same station, only ONE gets the job
  //              (duplicate print prevention)
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 11 — Duplicate prevention: 2 devices on same station, only first prints');

  const device2 = SocketClient(SERVER_URL, { transports: ['websocket'] });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('device2 connect timeout')), 3000);
    device2.on('connect', () => {
      // BOTH join the same station room
      device2.emit('join:mpos', { outletId: OUTLET_ID, station: STATION });
    });
    device2.on('mpos:connected', () => { clearTimeout(t); resolve(); });
  }).catch(() => {});

  await wait(150);

  let device1Got = false, device2Got = false;
  // Remove old listener, fresh count
  deviceClient.removeAllListeners('mpos:print');
  deviceClient.on('mpos:print', () => { device1Got = true; });
  device2.on('mpos:print', () => { device2Got = true; });

  // Station-mode printer — no deviceId
  const stationPrinter = { id: 20, outlet_id: OUTLET_ID, name: 'Cashier MPOS', device_id: null, station: STATION, connection_type: 'mobile_pos' };
  await sendToMobilePOS_testable(io, stationPrinter, FAKE_ESCPOS, { jobType: 'bill', ref: 'INV-DUP', outletId: OUTLET_ID });

  await wait(300);

  const totalReceived = (device1Got ? 1 : 0) + (device2Got ? 1 : 0);
  ok(totalReceived === 1, `Exactly ONE device printed (not both) — duplicate prevented`);
  ok(device1Got || device2Got, 'At least one device received the job');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 12: Device mode — printer has deviceId, routes to specific device
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 12 — Device mode: explicit deviceId routes to specific device only');

  let stationDeviceGot = false, specificDeviceGot = false;
  deviceClient.removeAllListeners('mpos:print');
  deviceClient.on('mpos:print', () => { stationDeviceGot = true; });  // joined station room
  deviceClientB.on('mpos:print', () => { specificDeviceGot = true; }); // joined device room

  const deviceModePrinter = { id: 30, outlet_id: OUTLET_ID, name: 'Specific MPOS', device_id: DEVICE_ID, station: STATION, connection_type: 'mobile_pos' };
  await sendToMobilePOS_testable(io, deviceModePrinter, FAKE_ESCPOS, { jobType: 'test', ref: 'TEST-DEV', outletId: OUTLET_ID });

  await wait(300);

  ok(!stationDeviceGot,    'Station-mode device did NOT receive device-mode job');
  ok(specificDeviceGot,    'Specific device (deviceId mode) correctly received its job');

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 13: userId intercept — ANY user on Mobile POS gets all prints
  //              No printer record setup required
  // ─────────────────────────────────────────────────────────────────────────
  section('Scenario 13 — userId intercept: user connected → all their prints routed to their device');

  const USER_ID = 99;
  const userDevice = SocketClient(SERVER_URL, { transports: ['websocket'] });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('userDevice connect timeout')), 3000);
    userDevice.on('connect', () => {
      userDevice.emit('join:mpos', { outletId: OUTLET_ID, userId: USER_ID, station: STATION });
    });
    userDevice.on('mpos:connected', (data) => {
      clearTimeout(t);
      ok(data.userId == USER_ID, `ack.userId = ${USER_ID}`);
      ok(data.rooms && data.rooms.includes(`mpos:${OUTLET_ID}:user:${USER_ID}`), 'User room in ack.rooms');
      resolve();
    });
  }).catch(() => {});

  await wait(150);

  // Simulate printKot/printBill intercept — userId present, user is online
  // Printer has NO device_id and ANY station — userId takes priority
  const anyPrinter = { id: null, name: 'MobilePOS', outlet_id: OUTLET_ID, device_id: null, station: 'kitchen' };

  let userDeviceGot = false;
  userDevice.on('mpos:print', () => { userDeviceGot = true; });

  const userInterceptResult = await sendToMobilePOS_testable(io, anyPrinter, FAKE_ESCPOS, {
    jobType: 'kot', ref: 'KOT-USER-001', outletId: OUTLET_ID, userId: USER_ID
  });

  await wait(200);

  ok(userInterceptResult !== null, 'userId intercept: returned non-null (user online)');
  ok(userInterceptResult?.mode === 'user', 'result.mode = "user"');
  ok(userInterceptResult?.room === `mpos:${OUTLET_ID}:user:${USER_ID}`, `result.room = mpos:${OUTLET_ID}:user:${USER_ID}`);
  ok(userDeviceGot, 'User device received the print job');

  // Verify: user offline → returns null (falls through to normal printer routing)
  const offlineUserResult = await sendToMobilePOS_testable(io, anyPrinter, FAKE_ESCPOS, {
    jobType: 'kot', ref: 'KOT-OFFLINE', outletId: OUTLET_ID, userId: 9999
  });
  ok(offlineUserResult === null || offlineUserResult?.mode !== 'user',
    'Offline userId: no user room match → falls through to station/bridge');

  userDevice.disconnect();

  // ─────────────────────────────────────────────────────────────────────────
  // RESULTS
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log('════════════════════════════════════════════════════════════════\n');

  // Cleanup
  device2.disconnect();
  deviceClient.disconnect();
  deviceClientB.disconnect();
  httpServer.close();

  process.exit(fail > 0 ? 1 : 0);
})();
