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
 * 4. Configure the settings below
 * 5. Run: node bridge-agent.js
 * 
 * For Windows service: use pm2 or nssm to run as service
 */

const axios = require('axios');
const net = require('net');
const BINARY_CONTENT_PREFIX = 'b64:';

// ========================
// CONFIGURATION
// ========================

const CONFIG = {
  // Cloud server URL (your backend API)
  // CLOUD_URL: process.env.CLOUD_URL || 'http://localhost:3005',
  CLOUD_URL: process.env.CLOUD_URL || 'https://assess-portions-popular-harvest.trycloudflare.com',
  
  // Outlet ID from your system
  OUTLET_ID: process.env.OUTLET_ID || '43',
  
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

/**
 * Send raw data to thermal printer via TCP socket
 */
function sendToPrinter(printerIp, printerPort, data) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let connected = false;
    
    // Set timeout — 5s is enough for local network printers; faster failure detection
    client.setTimeout(10000);
    
    client.connect(printerPort, printerIp, () => {
      connected = true;
      console.log(`  Connected to printer ${printerIp}:${printerPort}`);
      client.write(data);
      client.end();
    });
    
    client.on('close', () => {
      if (connected) {
        resolve();
      }
    });
    
    client.on('error', (err) => {
      console.error(`  Printer error: ${err.message}`);
      reject(err);
    });
    
    client.on('timeout', () => {
      console.error('  Printer connection timeout');
      client.destroy();
      reject(new Error('Connection timeout'));
    });
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

async function refreshPrinterConfigFromCloud() {
  try {
    const response = await api.get(
      `/api/v1/printers/bridge/${CONFIG.OUTLET_ID}/${CONFIG.BRIDGE_CODE}/config`
    );

    const configData = response?.data?.data;
    const printersFromDb = configData?.printers;
    if (!printersFromDb || typeof printersFromDb !== 'object') {
      return;
    }

    const normalizedPrinters = {};
    for (const [station, printer] of Object.entries(printersFromDb)) {
      if (!station || !printer || !printer.ip) continue;
      const port = Number.isInteger(printer.port) ? printer.port : parseInt(printer.port, 10);
      normalizedPrinters[station] = {
        ip: String(printer.ip).trim(),
        port: Number.isInteger(port) ? port : 9100,
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
    console.error(`Printer config refresh failed: ${message}`);
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
// Delay before reconnecting after an error (avoids tight error loops)
const ERROR_RETRY_DELAY = 5000;

/**
 * Process a single print job: resolve printer → send TCP → acknowledge (fire-and-forget)
 */
async function processJob(job) {
  const t0 = Date.now();
  console.log(`  📄 Job #${job.id}: ${job.job_type} for ${job.station} (ref: ${job.reference_number || 'N/A'})`);

  // Resolve printer: prefer job's assigned printer IP, fall back to local config
  let printer;
  if (job.ip_address) {
    printer = { ip: job.ip_address, port: job.port || 9100 };
  } else {
    printer = getPrinterForStation(job.station);
  }

  if (!printer || !printer.ip) {
    console.log(`     ❌ No printer for station "${job.station}"`);
    acknowledgeJob(job.id, 'failed', `No printer configured for station: ${job.station}`);
    jobsFailed++;
    return;
  }

  try {
    const printableContent = decodeJobContent(job.content);
    await sendToPrinter(printer.ip, printer.port, printableContent);
    acknowledgeJob(job.id, 'printed'); // fire-and-forget — don't wait for HTTP round-trip
    jobsProcessed++;
    console.log(`     ✅ Printed to ${printer.ip}:${printer.port} in ${Date.now() - t0}ms (total: ${jobsProcessed})`);
  } catch (printError) {
    acknowledgeJob(job.id, 'failed', printError.message); // fire-and-forget
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
    } catch (error) {
      if (error.response?.status === 429) {
        console.warn('⚠️  Rate limited (429) — waiting 30s');
        await sleep(30000);
      } else if (error.response?.status === 401) {
        console.error('❌ Auth failed. Check bridge code/API key. Retrying in 30s...');
        await sleep(30000);
      } else if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        // Normal: long-poll timeout, just reconnect
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        console.error(`❌ Server unreachable (${error.code}). Retrying in ${ERROR_RETRY_DELAY / 1000}s...`);
        await sleep(ERROR_RETRY_DELAY);
      } else {
        console.error('Poll error:', error.message);
        await sleep(ERROR_RETRY_DELAY);
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
    const line = `${station}: ${printer.ip}:${printer.port}`;
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
      console.log(`   ⚠️ ${station}: ${printer.ip}:${printer.port} - Timeout`);
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
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});


