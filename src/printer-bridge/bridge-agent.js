/**
 * Local Printer Bridge Agent
 * 
 * This script runs on a local machine at the restaurant to:
 * 1. Poll the cloud server for pending print jobs
 * 2. Send print commands to local thermal printers via network
 * 3. Report print status back to the server
 * 
 * Installation:
 * 1. Install Node.js on the local machine
 * 2. Copy this file to the local machine
 * 3. Run: npm init -y && npm install axios
 *    (For Bluetooth printers also run: npm install bluetooth-serial-port)
 * 4. Configure the settings below
 * 5. Run: node bridge-agent.js
 * 
 * For Windows service: use pm2 or nssm to run as service
 */

const axios = require('axios');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const BINARY_CONTENT_PREFIX = 'b64:';

// ========================
// CONFIGURATION
// ========================

const CONFIG = {
  // Cloud server URL (your backend API)
  // CLOUD_URL: process.env.CLOUD_URL || 'http://localhost:3005',
  CLOUD_URL: process.env.CLOUD_URL || 'https://backend.imakerrestro.com',
  
  // Outlet ID from your system
  OUTLET_ID: process.env.OUTLET_ID || '58',
  
  // Bridge code (created via API: POST /api/v1/printers/bridges)
  BRIDGE_CODE: process.env.BRIDGE_CODE || 'KITCHEN-BRIDGE-1',
  
  // API key (optional - bridge works without it now)
  API_KEY: process.env.API_KEY || '',
  
  // Polling interval in milliseconds (adaptive: starts here, slows to 10s when idle)
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 3000,

  // How often to report local printer status to cloud (reduced to save requests)
  STATUS_REPORT_INTERVAL: parseInt(process.env.STATUS_REPORT_INTERVAL) || 60000,

  // How often to refresh printer mapping from DB
  PRINTER_CONFIG_REFRESH_INTERVAL: parseInt(process.env.PRINTER_CONFIG_REFRESH_INTERVAL) || 60000,
  
  // Printers configuration - map stations to printer IP/port
  // Station names are DYNAMIC and match kitchen_stations.station_type or counter_type
  // Examples: main_kitchen, tandoor, bar, dessert, mocktail, bill, cashier
  // These are loaded dynamically from server via refreshPrinterConfigFromCloud()
  // Initial config is used as fallback if server is unreachable
  PRINTERS: {
    // KOT stations (from kitchen_stations.station_type)
    main_kitchen: { ip: '192.168.1.13', port: 9100 },
    kitchen: { ip: '192.168.1.13', port: 9100 },
    tandoor: { ip: '192.168.1.13', port: 9100 },
    bar: { ip: '192.168.1.13', port: 9100 },
    dessert: { ip: '192.168.1.13', port: 9100 },
    mocktail: { ip: '192.168.1.13', port: 9100 },
    // Bill/cashier stations
    bill: { ip: '192.168.1.13', port: 9100 },
    cashier: { ip: '192.168.1.13', port: 9100 },
    test: { ip: '192.168.1.13', port: 9100 }
  },
  
  // Fallback printer if station not found
  DEFAULT_PRINTER: { ip: '192.168.1.13', port: 9100 }
};

// Normalize critical config values to avoid auth mismatches from whitespace.
CONFIG.CLOUD_URL = String(CONFIG.CLOUD_URL || '').trim();
CONFIG.OUTLET_ID = String(CONFIG.OUTLET_ID || '').trim();
CONFIG.BRIDGE_CODE = String(CONFIG.BRIDGE_CODE || '').trim();
CONFIG.API_KEY = String(CONFIG.API_KEY || '').trim();

// ========================
// PRINTER COMMUNICATION
// ========================

// ─── Persistent Printer Socket Pool ────────────────────────────────────────
// Keeps TCP sockets open to thermal printers, eliminating ~200-500ms handshake
// per job. Sockets auto-reconnect on error and close after 30s idle.

class PrinterSocketPool {
  constructor() {
    this.sockets = new Map(); // key "ip:port" → { socket, lastUsed, busy }
    this.idleTimeoutMs = 30000;
    this.connectTimeoutMs = 3000;
    this._cleanupTimer = setInterval(() => this._cleanupIdle(), 10000);
  }

  _key(ip, port) { return `${ip}:${port}`; }

  async send(ip, port, data) {
    const key = this._key(ip, port);
    const entry = this.sockets.get(key);

    // Reuse healthy open socket
    if (entry && !entry.socket.destroyed && entry.socket.readyState === 'open') {
      return this._write(entry, data);
    }

    // Destroy stale entry
    if (entry) {
      this._destroy(entry);
      this.sockets.delete(key);
    }

    // Create new persistent connection
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let resolved = false;

      socket.setTimeout(this.connectTimeoutMs);

      socket.connect(port, ip, () => {
        socket.setTimeout(0); // connected — clear connect timeout
        const newEntry = { socket, lastUsed: Date.now(), busy: false };
        this.sockets.set(key, newEntry);
        this._write(newEntry, data).then(resolve).catch(reject);
      });

      socket.on('error', (err) => {
        if (!resolved) { resolved = true; reject(err); }
        this._remove(key);
      });

      socket.on('timeout', () => {
        if (!resolved) { resolved = true; reject(new Error('Connection timeout')); }
        socket.destroy();
        this._remove(key);
      });

      socket.on('close', () => { this._remove(key); });
    });
  }

  _write(entry, data) {
    return new Promise((resolve, reject) => {
      const socket = entry.socket;
      if (socket.destroyed || socket.readyState !== 'open') {
        return reject(new Error('Socket not connected'));
      }

      entry.busy = true;
      let resolved = false;

      const onError = (err) => {
        if (!resolved) { resolved = true; reject(err); }
        entry.busy = false;
      };

      socket.once('error', onError);

      const flushed = socket.write(data, (err) => {
        if (err) {
          if (!resolved) { resolved = true; reject(err); }
        } else {
          if (!resolved) { resolved = true; resolve(); }
        }
        entry.busy = false;
        entry.lastUsed = Date.now();
        socket.off('error', onError);
      });

      if (!flushed) {
        socket.once('drain', () => { entry.lastUsed = Date.now(); });
      }
    });
  }

  _destroy(entry) {
    try { entry.socket.destroy(); } catch (e) {}
  }

  _remove(key) {
    const entry = this.sockets.get(key);
    if (entry) {
      this._destroy(entry);
      this.sockets.delete(key);
    }
  }

  _cleanupIdle() {
    const now = Date.now();
    for (const [key, entry] of this.sockets) {
      if (!entry.busy && (now - entry.lastUsed > this.idleTimeoutMs)) {
        this._destroy(entry);
        this.sockets.delete(key);
      }
    }
  }

  closeAll() {
    clearInterval(this._cleanupTimer);
    for (const entry of this.sockets.values()) this._destroy(entry);
    this.sockets.clear();
  }
}

const printerPool = new PrinterSocketPool();

/**
 * Send raw data to thermal printer via TCP socket (uses persistent pool)
 */
function sendToPrinter(printerIp, printerPort, data) {
  return printerPool.send(printerIp, printerPort, data);
}

/**
 * Send raw data to USB printer by writing directly to the device path.
 * Linux: /dev/usb/lp0   Windows: \\.\COM1
 */
function sendToUsbPrinter(usbPath, data) {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(usbPath, { flags: 'a' });
    stream.once('error', (err) => { stream.destroy(); reject(err); });
    stream.write(data, (err) => {
      stream.end();
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Send raw ESC/POS bytes to a Windows printer by name via Win32 RAW spooler API.
 * Uses inline C# compiled by PowerShell — works with "EPSON TM-T88IV Receipt" style names.
 * Only works on Windows (process.platform === 'win32').
 */
/**
 * Send raw ESC/POS bytes to a Bluetooth SPP thermal printer by MAC address.
 * Requires 'bluetooth-serial-port' npm package on the bridge machine.
 */
function sendToBluetoothPrinter(address, data) {
  return new Promise((resolve, reject) => {
    let BluetoothSerialPort;
    try {
      BluetoothSerialPort = require('bluetooth-serial-port').BluetoothSerialPort;
    } catch (err) {
      return reject(new Error(
        `bluetooth-serial-port package is not installed. ` +
        `Run: npm install bluetooth-serial-port  (${err.message})`
      ));
    }

    const btSerial = new BluetoothSerialPort();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');

    btSerial.findSerialPortChannel(address, (channel) => {
      btSerial.connect(address, channel, () => {
        btSerial.write(buf, (err) => {
          if (err) {
            btSerial.close();
            return reject(new Error(`Bluetooth write failed: ${err.message || err}`));
          }
          // Allow printer buffer to drain before disconnecting
          setTimeout(() => {
            btSerial.close();
            resolve();
          }, 500);
        });
      }, (err) => {
        reject(new Error(`Bluetooth connect failed for ${address}: ${err.message || err}`));
      });
    }, (err) => {
      reject(new Error(`Bluetooth serial port channel not found for ${address}: ${err.message || err}`));
    });
  });
}

function sendToWindowsPrinter(printerName, data) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `pos_${Date.now()}_${Math.random().toString(36).slice(2,8)}.bin`);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');
    fs.writeFileSync(tmpFile, buf);

    const esc = (s) => s.replace(/"/g, '`"');
    const escFile = tmpFile.replace(/\\/g, '\\\\');
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential)] public struct DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool OpenPrinter(string p,out IntPtr h,IntPtr d);
  [DllImport("winspool.drv",SetLastError=true)] public static extern bool StartDocPrinter(IntPtr h,int l,ref DOCINFOA i);
  [DllImport("winspool.drv",SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv",SetLastError=true)] public static extern bool WritePrinter(IntPtr h,IntPtr b,int c,out int w);
  [DllImport("winspool.drv",SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv",SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv",SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  public static bool Send(string name,byte[] data) {
    IntPtr h; if(!OpenPrinter(name,out h,IntPtr.Zero)) return false;
    var di=new DOCINFOA{pDocName="POS",pDataType="RAW"};
    StartDocPrinter(h,1,ref di); StartPagePrinter(h);
    IntPtr p=System.Runtime.InteropServices.Marshal.AllocCoTaskMem(data.Length);
    System.Runtime.InteropServices.Marshal.Copy(data,0,p,data.Length);
    int w; WritePrinter(h,p,data.Length,out w);
    System.Runtime.InteropServices.Marshal.FreeCoTaskMem(p);
    EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h);
    return w==data.Length;
  }
}
"@
$bytes=[System.IO.File]::ReadAllBytes("${escFile}")
$ok=[RawPrint]::Send("${esc(printerName)}",$bytes)
Remove-Item "${escFile}" -ErrorAction SilentlyContinue
if(-not $ok){throw "RawPrint failed: ${esc(printerName)}"}
Write-Output "OK"
`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        if (err) return reject(new Error(`Windows print failed ("${printerName}"): ${stderr || err.message}`));
        if (stdout.trim() === 'OK') return resolve();
        reject(new Error(`Windows print failed ("${printerName}"): ${stderr || stdout}`));
      }
    );
  });
}

function decodeJobContent(content) {
  if (content === null || content === undefined) {
    throw new Error('Missing print content');
  }

  if (Buffer.isBuffer(content)) {
    return content;
  }

  // Safety for APIs that serialize Buffer as { type: 'Buffer', data: [...] }.
  if (typeof content === 'object' && content.type === 'Buffer' && Array.isArray(content.data)) {
    return Buffer.from(content.data);
  }

  if (typeof content === 'string' && content.startsWith(BINARY_CONTENT_PREFIX)) {
    const base64Payload = content.slice(BINARY_CONTENT_PREFIX.length);
    if (!base64Payload) {
      throw new Error('Empty base64 print content');
    }
    return Buffer.from(base64Payload, 'base64');
  }

  // Backward compatibility for old jobs already stored as plain text.
  return content;
}

/**
 * Get printer config for a station (dynamic lookup)
 * Station names come directly from kitchen_stations.station_type (e.g., main_kitchen, tandoor, bar)
 */
function getPrinterForStation(station) {
  const printer = CONFIG.PRINTERS[station];
  if (printer) {
    return printer;
  }
  
  // Log when using default printer for unknown station
  console.log(`   ⚠️ No dedicated printer for station "${station}", using default printer`);
  return CONFIG.DEFAULT_PRINTER;
}

// ========================
// API COMMUNICATION
// ========================

// Build headers - only include API key if provided
const apiHeaders = { 'Content-Type': 'application/json' };
if (CONFIG.API_KEY) {
  apiHeaders['x-api-key'] = CONFIG.API_KEY;
  apiHeaders['Authorization'] = `Bearer ${CONFIG.API_KEY}`;
}

// Use HTTP keep-alive to reuse TCP/TLS connections (saves ~100-200ms per request)
const http = require('http');
const https = require('https');
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

const api = axios.create({
  baseURL: CONFIG.CLOUD_URL,
  headers: apiHeaders,
  timeout: 10000,
  httpAgent: keepAliveHttpAgent,
  httpsAgent: keepAliveHttpsAgent
});

/**
 * Test API connectivity on startup
 */
async function testApiConnection() {
  console.log(`🔗 Testing connection to ${CONFIG.CLOUD_URL}...`);
  try {
    const response = await axios.get(`${CONFIG.CLOUD_URL}/health`, { timeout: 10000 });
    console.log(`✅ API server is reachable (status: ${response.status})`);
    return true;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error(`❌ Connection refused - server might not be running`);
    } else if (error.code === 'ENOTFOUND') {
      console.error(`❌ DNS lookup failed - check CLOUD_URL: ${CONFIG.CLOUD_URL}`);
    } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      console.error(`❌ Connection timeout - server not responding or firewall blocking`);
    } else {
      console.error(`⚠️ API test: ${error.message}`);
    }
    return false;
  }
}

/**
 * Poll for next pending print job
 */
async function pollForJob() {
  try {
    const response = await api.get(
      `/api/v1/printers/bridge/${CONFIG.OUTLET_ID}/${CONFIG.BRIDGE_CODE}/poll`
    );
    
    return response.data;
  } catch (error) {
    if (error.response?.status === 401) {
      const serverMessage = error.response?.data?.message || 'Invalid credentials';
      console.error(`Authentication failed (${serverMessage}). Check API key, outlet ID, and bridge code.`);
    }
    throw error;
  }
}

/**
 * Acknowledge job completion.
 * Fire-and-forget by default — caller doesn't wait for the HTTP round-trip.
 * Retries once on failure to avoid lost acks.
 */
function acknowledgeJob(jobId, status, error = null) {
  const doAck = async (attempt) => {
    try {
      await api.post(
        `/api/v1/printers/bridge/${CONFIG.OUTLET_ID}/${CONFIG.BRIDGE_CODE}/jobs/${jobId}/ack`,
        { status, error },
        { timeout: 8000 }
      );
    } catch (err) {
      if (attempt < 2) {
        // Retry once after 1s
        setTimeout(() => doAck(attempt + 1), 1000);
      } else {
        console.error(`  Failed to acknowledge job ${jobId} after ${attempt} attempts:`, err.message);
      }
    }
  };
  // Fire and forget — don't block caller
  doAck(1);
}

function testPrinterConnection(printerIp, printerPort) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    const start = Date.now();

    client.setTimeout(3000);

    client.connect(printerPort, printerIp, () => {
      const latency = Date.now() - start;
      client.destroy();
      resolve({ isOnline: true, latency, error: null });
    });

    client.on('error', (err) => {
      resolve({ isOnline: false, latency: null, error: err.message });
    });

    client.on('timeout', () => {
      client.destroy();
      resolve({ isOnline: false, latency: null, error: 'Connection timeout' });
    });
  });
}

async function reportPrinterStatuses() {
  const printerEntries = Object.entries(CONFIG.PRINTERS || {});
  if (printerEntries.length === 0) return;

  // De-duplicate by printerId to avoid reporting same physical printer multiple times
  const seenPrinterIds = new Set();
  const uniqueEntries = [];
  for (const [station, printer] of printerEntries) {
    const key = printer.printerId ? String(printer.printerId) : `${printer.ip}:${printer.port}:${station}`;
    if (!seenPrinterIds.has(key)) {
      seenPrinterIds.add(key);
      uniqueEntries.push([station, printer]);
    }
  }

  const statuses = await Promise.all(
    uniqueEntries.map(async ([station, printer]) => {
      // Windows spooler printers: report as online (spooler manages connectivity)
      if (printer.printerName || printer.connectionType === 'windows_printer') {
        return {
          station,
          printerId: printer.printerId || null,
          printerName: printer.printerName,
          connectionType: 'windows_printer',
          isOnline: true,
          latency: null,
          error: null,
          checkedAt: new Date().toISOString()
        };
      }
      // USB printers: check device path existence instead of TCP
      if (printer.usbPath || printer.connectionType === 'usb') {
        const exists = fs.existsSync(printer.usbPath);
        return {
          station,
          printerId: printer.printerId || null,
          usbPath: printer.usbPath,
          connectionType: 'usb',
          isOnline: exists,
          latency: null,
          error: exists ? null : `USB device not found: ${printer.usbPath}`,
          checkedAt: new Date().toISOString()
        };
      }
      // Bluetooth printers: we can't easily test RFCOMM from here without connecting,
      // so report as online and let the actual print attempt fail if disconnected
      if (printer.bluetoothAddress || printer.connectionType === 'bluetooth') {
        return {
          station,
          printerId: printer.printerId || null,
          bluetoothAddress: printer.bluetoothAddress,
          connectionType: 'bluetooth',
          isOnline: true,
          latency: null,
          error: null,
          checkedAt: new Date().toISOString()
        };
      }
      const result = await testPrinterConnection(printer.ip, printer.port);
      return {
        station,
        printerId: printer.printerId || null,
        ipAddress: printer.ip,
        port: printer.port,
        isOnline: result.isOnline,
        latency: result.latency,
        error: result.error,
        checkedAt: new Date().toISOString()
      };
    })
  );

  try {
    await api.post(
      `/api/v1/printers/bridge/${CONFIG.OUTLET_ID}/${CONFIG.BRIDGE_CODE}/status`,
      { statuses }
    );
  } catch (err) {
    console.error('Status report error:', err.response?.data?.message || err.message);
  }
}

let _configRefreshFailCount = 0;
let _configRefreshLastErrMsg = '';

async function refreshPrinterConfigFromCloud() {
  try {
    const response = await api.get(
      `/api/v1/printers/bridge/${CONFIG.OUTLET_ID}/${CONFIG.BRIDGE_CODE}/config`
    );

    if (_configRefreshFailCount > 0) {
      console.log('✅ Printer config refresh recovered.');
      _configRefreshFailCount = 0;
      _configRefreshLastErrMsg = '';
    }

    const configData = response?.data?.data;
    const printersFromDb = configData?.printers;
    if (!printersFromDb || typeof printersFromDb !== 'object') {
      return;
    }

    const normalizedPrinters = {};
    for (const [station, printer] of Object.entries(printersFromDb)) {
      if (!station || !printer) continue;
      const isUsb = printer.connectionType === 'usb' || (printer.usbPath && !printer.ip);
      const isWin = printer.connectionType === 'windows_printer' || !!printer.printerName;
      const isBt  = printer.connectionType === 'bluetooth' || !!printer.bluetoothAddress;
      // USB, Windows, and Bluetooth printers don't need an IP
      if (!printer.ip && !isUsb && !isWin && !isBt) continue;
      const port = Number.isInteger(printer.port) ? printer.port : parseInt(printer.port, 10);
      normalizedPrinters[station] = {
        ip: printer.ip ? String(printer.ip).trim() : null,
        port: Number.isInteger(port) ? port : 9100,
        usbPath: printer.usbPath || null,
        printerName: printer.printerName || null,
        bluetoothAddress: printer.bluetoothAddress || null,
        connectionType: printer.connectionType || (isUsb ? 'usb' : isWin ? 'windows_printer' : isBt ? 'bluetooth' : 'network'),
        printerId: printer.printerId || null
      };
    }

    const stations = Object.keys(normalizedPrinters);
    if (stations.length === 0) {
      console.log('⚠️  No active printer mappings returned from DB. Keeping existing local configuration.');
      return;
    }

    CONFIG.PRINTERS = normalizedPrinters;
    CONFIG.DEFAULT_PRINTER = normalizedPrinters[stations[0]];
    console.log(`🔄 Printer config refreshed from DB (${stations.length} stations: ${stations.join(', ')})`);
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    _configRefreshFailCount++;
    // Log every failure for the first 3, then only when the message changes, then every 10th
    if (_configRefreshFailCount <= 3 || message !== _configRefreshLastErrMsg || _configRefreshFailCount % 10 === 0) {
      console.error(`Printer config refresh failed (attempt ${_configRefreshFailCount}): ${message}`);
      if (_configRefreshFailCount === 3) {
        console.warn('  ⚠ Suppressing repeated config-refresh errors. Run: node scripts/run-migration-075-bluetooth.js');
      }
      _configRefreshLastErrMsg = message;
    }
  }
}

// ========================
// MAIN LOOP — Long-polling + batch processing
// ========================

let jobsProcessed = 0;
let jobsFailed = 0;
// How long the server holds the connection when no jobs are pending (ms).
// The server will respond instantly if a job arrives during this window.
const LONG_POLL_WAIT = 25000;
// How many jobs to fetch per poll (reduces round-trips for multi-printer KOTs)
const BATCH_SIZE = 10;
// Base retry delay after a transient error — doubles on each consecutive failure (max 30s)
const BASE_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY  = 30000;
let consecutiveErrors  = 0;

function nextRetryDelay() {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap)
  const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, consecutiveErrors), MAX_RETRY_DELAY);
  consecutiveErrors++;
  return delay;
}
function resetRetry() { consecutiveErrors = 0; }

/**
 * Process a single print job: resolve printer → send TCP → acknowledge (fire-and-forget)
 */
async function processJob(job) {
  const t0 = Date.now();
  console.log(`  📄 Job #${job.id}: ${job.job_type} for ${job.station} (ref: ${job.reference_number || 'N/A'})`);

  // Resolve printer: prefer job's assigned printer, fall back to local config
  let printer;
  if (job.connection_type === 'windows_printer' || job.windows_printer_name) {
    printer = { printerName: job.windows_printer_name, connectionType: 'windows_printer' };
  } else if (job.usb_path || job.connection_type === 'usb') {
    printer = { usbPath: job.usb_path, connectionType: 'usb' };
  } else if (job.bluetooth_address || job.connection_type === 'bluetooth') {
    printer = { bluetoothAddress: job.bluetooth_address, connectionType: 'bluetooth' };
  } else if (job.ip_address) {
    printer = { ip: job.ip_address, port: job.port || 9100, connectionType: 'network' };
  } else {
    printer = getPrinterForStation(job.station);
  }

  if (!printer || (!printer.ip && !printer.usbPath && !printer.printerName && !printer.bluetoothAddress)) {
    console.log(`     ❌ No printer for station "${job.station}"`);
    acknowledgeJob(job.id, 'failed', `No printer configured for station: ${job.station}`);
    jobsFailed++;
    return;
  }

  try {
    const printableContent = decodeJobContent(job.content);
    if (printer.connectionType === 'windows_printer' || printer.printerName) {
      await sendToWindowsPrinter(printer.printerName, printableContent);
      acknowledgeJob(job.id, 'printed');
      jobsProcessed++;
      console.log(`     ✅ Printed via Windows "${printer.printerName}" in ${Date.now() - t0}ms (total: ${jobsProcessed})`);
    } else if (printer.connectionType === 'usb' || printer.usbPath) {
      await sendToUsbPrinter(printer.usbPath, printableContent);
      acknowledgeJob(job.id, 'printed');
      jobsProcessed++;
      console.log(`     ✅ Printed via USB ${printer.usbPath} in ${Date.now() - t0}ms (total: ${jobsProcessed})`);
    } else if (printer.connectionType === 'bluetooth' || printer.bluetoothAddress) {
      await sendToBluetoothPrinter(printer.bluetoothAddress, printableContent);
      acknowledgeJob(job.id, 'printed');
      jobsProcessed++;
      console.log(`     ✅ Printed via Bluetooth ${printer.bluetoothAddress} in ${Date.now() - t0}ms (total: ${jobsProcessed})`);
    } else {
      await sendToPrinter(printer.ip, printer.port, printableContent);
      acknowledgeJob(job.id, 'printed');
      jobsProcessed++;
      console.log(`     ✅ Printed to ${printer.ip}:${printer.port} in ${Date.now() - t0}ms (total: ${jobsProcessed})`);
    }
  } catch (printError) {
    acknowledgeJob(job.id, 'failed', printError.message);
    jobsFailed++;
    console.log(`     ❌ Failed: ${printError.message} in ${Date.now() - t0}ms (failed: ${jobsFailed})`);
  }
}

/**
 * Main polling loop — uses long polling with batch fetching.
 * Server holds the connection for up to LONG_POLL_WAIT ms when idle,
 * responds instantly when a new job is created.
 * Result: near-zero latency when jobs arrive, ~2 requests/min when idle.
 */
async function pollLoop() {
  while (true) {
    try {
      const response = await api.get(
        `/api/v1/printers/bridge/${CONFIG.OUTLET_ID}/${CONFIG.BRIDGE_CODE}/poll`,
        {
          params: { wait: LONG_POLL_WAIT, batch: BATCH_SIZE },
          timeout: LONG_POLL_WAIT + 10000 // HTTP timeout > server hold time
        }
      );

      const result = response.data;
      const jobs = result.data;

      // Batch mode: data is an array
      if (Array.isArray(jobs) && jobs.length > 0) {
        console.log(`\n📦 Received ${jobs.length} job(s)`);
        // Process all jobs in parallel for speed (each goes to a different printer)
        await Promise.all(jobs.map(job => processJob(job)));
        // Immediately poll again — there may be more jobs
        continue;
      }

      // Single-job mode (backward compat): data is an object or null
      if (jobs && typeof jobs === 'object' && !Array.isArray(jobs) && jobs.id) {
        console.log(`\n📦 Received 1 job`);
        await processJob(jobs);
        continue;
      }

      // No jobs — server already waited LONG_POLL_WAIT ms, reconnect immediately
      resetRetry();
    } catch (error) {
      const status = error.response?.status;
      if (status === 429) {
        console.warn('⚠️  Rate limited (429) — waiting 30s');
        consecutiveErrors = 0;
        await sleep(30000);
      } else if (status === 401) {
        console.error('❌ Auth failed. Check bridge code/API key. Retrying in 30s...');
        consecutiveErrors = 0;
        await sleep(30000);
      } else if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        // Normal: long-poll timed out with no jobs — reconnect immediately, no backoff
        resetRetry();
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        const delay = nextRetryDelay();
        console.error(`❌ Server unreachable (${error.code}). Retry in ${delay / 1000}s...`);
        await sleep(delay);
      } else if (status === 502 || status === 503 || status === 504) {
        // Gateway/proxy error — server restarting or overloaded, retry quickly
        const delay = nextRetryDelay();
        if (consecutiveErrors <= 2) console.warn(`⚠️  Server returned ${status}. Retry in ${delay / 1000}s...`);
        await sleep(delay);
      } else {
        const delay = nextRetryDelay();
        console.error(`Poll error (${delay / 1000}s retry): ${error.message}`);
        await sleep(delay);
      }
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========================
// STARTUP
// ========================

function printBanner() {  
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           RESTAURANT POS - PRINTER BRIDGE AGENT          ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Server:      ${CONFIG.CLOUD_URL.padEnd(43)}║`);
  console.log(`║  Outlet ID:   ${CONFIG.OUTLET_ID.padEnd(43)}║`);
  console.log(`║  Bridge Code: ${CONFIG.BRIDGE_CODE.padEnd(43)}║`);
  console.log(`║  Mode:        Long-poll (${LONG_POLL_WAIT / 1000}s hold, batch=${BATCH_SIZE})`.padEnd(59) + '║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Configured Printers:                                    ║');
  
  for (const [station, printer] of Object.entries(CONFIG.PRINTERS)) {
    let dest;
    if (printer.printerName || printer.connectionType === 'windows_printer') dest = `WIN:${printer.printerName}`;
    else if (printer.usbPath) dest = `USB:${printer.usbPath}`;
    else dest = `${printer.ip}:${printer.port}`;
    const line = `${station}: ${dest}`;
    console.log(`║    - ${line.padEnd(52)}║`);
  }
  
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('🟢 Bridge agent started. Waiting for print jobs...');
  console.log('   Press Ctrl+C to stop.\n');
}

function testPrinterConnections() {
  console.log('🔍 Testing printer connections...\n');
  
  for (const [station, printer] of Object.entries(CONFIG.PRINTERS)) {
    if (printer.printerName || printer.connectionType === 'windows_printer') {
      console.log(`   🖨️  ${station}: Windows printer "${printer.printerName}" - check via Get-Printer`);
      continue;
    }
    if (printer.usbPath || printer.connectionType === 'usb') {
      const exists = fs.existsSync(printer.usbPath);
      console.log(`   ${exists ? '✅' : '⚠️ '} ${station}: USB ${printer.usbPath} - ${exists ? 'device found' : 'device not found'}`);
      continue;
    }
    const client = new net.Socket();
    client.setTimeout(3000);
    
    client.connect(printer.port, printer.ip, () => {
      console.log(`   ✅ ${station}: ${printer.ip}:${printer.port} - Connected`);
      client.destroy();
    });
    
    client.on('error', () => {
      console.log(`   ❌ ${station}: ${printer.ip}:${printer.port} - Not reachable`);
    });
    
    client.on('timeout', () => {
      console.log(`   ⚠️  ${station}: ${printer.ip}:${printer.port} - Timeout`);
      client.destroy();
    });
  }
}

// Start the agent
printBanner();

// Log API key status
if (CONFIG.API_KEY) {
  console.log('🔑 Using API key authentication');
} else {
  console.log('🌐 Running in public mode (no API key)');
}

// Main startup function
async function startAgent() {
  // Test API connectivity first
  const apiReachable = await testApiConnection();
  if (!apiReachable) {
    console.log('\n⚠️  API server not reachable. Will retry in background...\n');
  }

  // Optional: Test printer connections on startup
  if (process.argv.includes('--test')) {
    testPrinterConnections();
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('\nStarting polling...\n');
  }

  // Refresh printer config from cloud
  refreshPrinterConfigFromCloud();
  setInterval(refreshPrinterConfigFromCloud, CONFIG.PRINTER_CONFIG_REFRESH_INTERVAL);
  
  // Status reporting at longer intervals to reduce requests
  setInterval(reportPrinterStatuses, CONFIG.STATUS_REPORT_INTERVAL);
  reportPrinterStatuses();
  
  console.log(`🟢 Long-poll loop starting (hold=${LONG_POLL_WAIT / 1000}s, batch=${BATCH_SIZE}). ~2 req/min when idle, instant on new job.\n`);

  // Start the long-polling loop (runs forever)
  pollLoop();
}

startAgent();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🔴 Shutting down bridge agent...');
  console.log(`   Jobs processed: ${jobsProcessed}`);
  console.log(`   Jobs failed: ${jobsFailed}`);
  printerPool.closeAll();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});


