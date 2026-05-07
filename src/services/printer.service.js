/**
 * Printer Service
 * Handles print job queue for KOT, BOT, Bills
 * Supports local bridge agent polling pattern
 */

const { getPool } = require('../database');
const { v4: uuidv4 } = require('uuid');
const { pubsub, publishMessage } = require('../config/redis');
const logger = require('../utils/logger');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { loadOutletLogo } = require('../utils/escpos-image');
const { getSocketIO } = require('../config/socket');

// In-memory event emitter for long-polling bridge notification.
// When a print job is created, we emit so waiting bridgePoll requests respond instantly.
const printJobNotifier = new EventEmitter();
printJobNotifier.setMaxListeners(50);

// Direct TCP print: only works when the server is on the SAME NETWORK as printers.
// In production (cloud server), printers are behind restaurant NAT — direct TCP cannot reach them.
// Set DIRECT_PRINT_ENABLED=true only for on-premise / local server deployments.
const DIRECT_PRINT_ENABLED = process.env.DIRECT_PRINT_ENABLED === 'true';

// Health cache: tracks which printer IPs are unreachable.
// If direct TCP fails for an IP, skip it for DIRECT_TCP_COOLDOWN_MS to avoid
// blocking KOT/bill printing with repeated 2-second timeouts.
const DIRECT_TCP_COOLDOWN_MS = 60000; // 60 seconds
const directTcpFailures = new Map(); // key: "ip:port" → value: timestamp of last failure

function isDirectTcpHealthy(ip, port) {
  const key = `${ip}:${port || 9100}`;
  const lastFail = directTcpFailures.get(key);
  if (!lastFail) return true; // never failed → try it
  if (Date.now() - lastFail > DIRECT_TCP_COOLDOWN_MS) {
    directTcpFailures.delete(key); // cooldown expired → retry
    return true;
  }
  return false; // recently failed → skip
}

function markDirectTcpFailed(ip, port) {
  directTcpFailures.set(`${ip}:${port || 9100}`, Date.now());
}

function markDirectTcpOk(ip, port) {
  directTcpFailures.delete(`${ip}:${port || 9100}`);
}

const BRIDGE_STATUS_STALE_SECONDS = parseInt(process.env.BRIDGE_STATUS_STALE_SECONDS, 10) || 90;
const BRIDGE_ONLINE_WINDOW_SECONDS = parseInt(process.env.BRIDGE_ONLINE_WINDOW_SECONDS, 10) || 90;
const DEFAULT_PRINT_LOGO_PATH = path.resolve(__dirname, '../../public/Whatsapp.bmp');
const BINARY_CONTENT_PREFIX = 'b64:';
const AUTO_BRIDGE_NAME = 'Kitchen Bridge';
const AUTO_BRIDGE_CODE = 'KITCHEN-BRIDGE-1';
const AUTO_BRIDGE_API_KEY = '855242e269ca0ba825f22a58306ee63bef7d4f75c710ee8d081c24e474989509';
// Use '*' to indicate the bridge should poll for ALL pending stations dynamically
const AUTO_BRIDGE_ASSIGNED_STATIONS = ['*'];

function resolveExistingLocalPath(source) {
  if (typeof source !== 'string') return null;
  const value = source.trim();
  if (!value) return null;

  const normalized = value.replace(/\\/g, '/');
  const candidates = [];

  // Absolute filesystem path
  if (path.isAbsolute(value)) {
    candidates.push(value);
  }

  // Relative to project root
  candidates.push(path.resolve(process.cwd(), value.replace(/^\/+/, '')));

  // Friendly fallback for values like "/logo.bmp" or "logo.bmp"
  const stripped = value.replace(/^\/+/, '');
  candidates.push(path.resolve(process.cwd(), 'public', stripped));
  candidates.push(path.resolve(process.cwd(), 'uploads', stripped));

  // Additional explicit cases for paths that already contain folder segments
  if (normalized.startsWith('/public/')) {
    candidates.push(path.resolve(process.cwd(), normalized.replace(/^\/+/, '')));
  }
  if (normalized.startsWith('/uploads/')) {
    candidates.push(path.resolve(process.cwd(), normalized.replace(/^\/+/, '')));
  }

  const uniqueCandidates = Array.from(new Set(candidates));
  for (const candidate of uniqueCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveLogoSource(preferredLogoUrl) {
  const candidates = [];
  if (typeof preferredLogoUrl === 'string' && preferredLogoUrl.trim()) {
    candidates.push(preferredLogoUrl.trim());
  }
  candidates.push(DEFAULT_PRINT_LOGO_PATH);

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
      return candidate;
    }
    const localPath = resolveExistingLocalPath(candidate);
    if (localPath) {
      return localPath;
    }
  }

  return null;
}

function encodePrintContentForStorage(content) {
  if (Buffer.isBuffer(content)) {
    return `${BINARY_CONTENT_PREFIX}${content.toString('base64')}`;
  }
  return content;
}

function parseDbDateToUtcMs(value) {
  if (!value) return null;

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return null;

    // mysql DATETIME often comes as "YYYY-MM-DD HH:mm:ss" without timezone.
    // Treat it as UTC to avoid local-time offset drift in stale checks.
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
    const isoLike = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const normalized = hasTimezone ? isoLike : `${isoLike}Z`;
    const ms = Date.parse(normalized);
    if (!Number.isNaN(ms)) return ms;

    const fallback = Date.parse(raw);
    return Number.isNaN(fallback) ? null : fallback;
  }

  return null;
}

const printerService = {
  // ========================
  // PRINTER MANAGEMENT
  // ========================

  async createPrinter(data) {
    const pool = getPool();
    const connection = await pool.getConnection();
    const uuid = uuidv4();
    const code = data.code || `PRN${Date.now().toString(36).toUpperCase()}`;

    // Support both camelCase and snake_case field names
    const printerType = data.printerType || data.printer_type || 'thermal';
    const stationId = data.stationId || data.station_id || null;
    const ipAddress = data.ipAddress || data.ip_address || null;
    const connectionType = data.connectionType || data.connection_type || 'network';
    const deviceId = data.deviceId || data.device_id || null; // Mobile POS device identifier
    const paperWidth = data.paperWidth || data.paper_width || '80mm';
    const charactersPerLine = data.charactersPerLine || data.characters_per_line || 48;
    const supportsCashDrawer = data.supportsCashDrawer || data.supports_cash_drawer || false;
    const supportsCutter = data.supportsCutter !== undefined ? data.supportsCutter : (data.supports_cutter !== undefined ? data.supports_cutter : true);
    const supportsLogo = data.supportsLogo || data.supports_logo || false;
    const outletId = data.outletId;

    try {
      await connection.beginTransaction();

      // Resolve printer station from kitchen_stations.code by stationId.
      // Store station in lowercase for consistent routing keys.
      let stationValue = typeof data.station === 'string' && data.station.trim()
        ? data.station.trim().toLowerCase()
        : null;

      if (stationId) {
        const [stationRows] = await connection.query(
          `SELECT code
           FROM kitchen_stations
           WHERE id = ? AND outlet_id = ?
           LIMIT 1`,
          [stationId, outletId]
        );

        const stationCode = stationRows[0]?.code;
        if (typeof stationCode === 'string' && stationCode.trim()) {
          stationValue = stationCode.trim().toLowerCase();
        }
      }

      const [result] = await connection.query(
        `INSERT INTO printers (
          uuid, outlet_id, name, code, printer_type, station,
          station_id, ip_address, port,
          connection_type, device_id, paper_width, characters_per_line,
          supports_cash_drawer, supports_cutter, supports_logo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid, outletId, data.name, code, printerType,
          stationValue, stationId,
          ipAddress, data.port || 9100, connectionType, deviceId,
          paperWidth, charactersPerLine,
          supportsCashDrawer, supportsCutter,
          supportsLogo
        ]
      );

      // Auto-create default bridge when first printer is created for an outlet.
      const [[printerCountRow]] = await connection.query(
        `SELECT COUNT(*) as total FROM printers WHERE outlet_id = ?`,
        [outletId]
      );

      if ((printerCountRow?.total || 0) === 1) {
        const [bridgeRows] = await connection.query(
          `SELECT id FROM printer_bridges WHERE outlet_id = ? LIMIT 1`,
          [outletId]
        );

        if (!bridgeRows[0]) {
          await connection.query(
            `INSERT INTO printer_bridges (
              uuid, outlet_id, name, bridge_code, api_key, assigned_stations
            ) VALUES (?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              outletId,
              AUTO_BRIDGE_NAME,
              AUTO_BRIDGE_CODE,
              AUTO_BRIDGE_API_KEY,
              JSON.stringify(AUTO_BRIDGE_ASSIGNED_STATIONS)
            ]
          );
        }
      }

      await connection.commit();
      return this.getPrinterById(result.insertId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async getPrinters(outletId, filters = {}) {
    const pool = getPool();
    let query = `SELECT * FROM printers WHERE outlet_id = ?`;
    const params = [outletId];

    if (filters.station) {
      query += ` AND station = ?`;
      params.push(filters.station);
    }
    if (filters.printerType) {
      query += ` AND printer_type = ?`;
      params.push(filters.printerType);
    }
    if (filters.isActive !== undefined) {
      query += ` AND is_active = ?`;
      params.push(filters.isActive);
    }

    query += ` ORDER BY name`;
    const [printers] = await pool.query(query, params);
    return printers;
  },

  async getPrinterById(id) {
    const pool = getPool();
    const [printers] = await pool.query('SELECT * FROM printers WHERE id = ?', [id]);
    return printers[0];
  },

  /**
   * Get printer for a station (dynamic lookup)
   * Priority:
   * 1. Exact match on printers.station
   * 2. Kitchen station with matching station_type that has printer_id
   * 3. Counter with matching counter_type that has printer_id
   * 4. Any active KOT/bill printer for the outlet
   */
  async getPrinterByStation(outletId, station) {
    const pool = getPool();
    
    // Priority 1: Exact match on printers.station
    let [printers] = await pool.query(
      `SELECT * FROM printers WHERE outlet_id = ? AND station = ? AND is_active = 1 LIMIT 1`,
      [outletId, station]
    );
    if (printers[0]) {
      logger.debug(`Printer lookup [${station}]: Found by exact station match (id: ${printers[0].id})`);
      return printers[0];
    }

    // Priority 2: Find printer via kitchen_stations with matching station_type
    [printers] = await pool.query(
      `SELECT p.* FROM printers p
       JOIN kitchen_stations ks ON ks.printer_id = p.id
       WHERE ks.outlet_id = ? AND ks.station_type = ? AND p.is_active = 1 AND ks.is_active = 1
       LIMIT 1`,
      [outletId, station]
    );
    if (printers[0]) {
      logger.debug(`Printer lookup [${station}]: Found via kitchen_station (id: ${printers[0].id})`);
      return printers[0];
    }

    // Priority 3: Find printer via counters with matching counter_type
    [printers] = await pool.query(
      `SELECT p.* FROM printers p
       JOIN counters c ON c.printer_id = p.id
       WHERE c.outlet_id = ? AND c.counter_type = ? AND p.is_active = 1 AND c.is_active = 1
       LIMIT 1`,
      [outletId, station]
    );
    if (printers[0]) {
      logger.debug(`Printer lookup [${station}]: Found via counter (id: ${printers[0].id})`);
      return printers[0];
    }

    // Priority 4: For bill station, find any bill/cashier printer
    if (station === 'bill' || station === 'cashier') {
      [printers] = await pool.query(
        `SELECT * FROM printers WHERE outlet_id = ? AND (station = 'bill' OR station = 'cashier') AND is_active = 1 LIMIT 1`,
        [outletId]
      );
      if (printers[0]) {
        logger.debug(`Printer lookup [${station}]: Found bill printer (id: ${printers[0].id})`);
        return printers[0];
      }
    }

    // Priority 5: Final fallback — any active network printer for this outlet
    // Ensures jobs always get a printer_id so the bridge receives ip_address in the poll response
    [printers] = await pool.query(
      `SELECT * FROM printers WHERE outlet_id = ? AND is_active = 1 AND ip_address IS NOT NULL ORDER BY id LIMIT 1`,
      [outletId]
    );
    if (printers[0]) {
      logger.warn(`Printer lookup [${station}]: Using fallback network printer (id: ${printers[0].id}, station: ${printers[0].station})`);
      return printers[0];
    }

    logger.error(`Printer lookup [${station}]: No printer configured for outlet ${outletId}. Configure station-to-printer mapping.`);
    return null;
  },

  /**
   * Get printer for a station with optional stationId for precise lookup
   * This is used by createPrintJob for KOT printing where we have the exact station ID
   * @param {number} outletId
   * @param {string} station - Station type name (e.g., 'main_kitchen', 'bar')
   * @param {number} stationId - Optional specific kitchen_station or counter ID
   * @param {boolean} isCounter - Whether stationId refers to a counter (vs kitchen station)
   */
  async getPrinterByStationWithId(outletId, station, stationId = null, isCounter = false) {
    const pool = getPool();
    
    // Priority 1a: If stationId provided and it's a counter, get printer from counters table
    if (stationId && isCounter) {
      const [counterPrinters] = await pool.query(
        `SELECT p.* FROM printers p
         JOIN counters c ON c.printer_id = p.id
         WHERE c.id = ? AND c.outlet_id = ? AND p.is_active = 1
         LIMIT 1`,
        [stationId, outletId]
      );
      if (counterPrinters[0]) {
        logger.info(`Printer lookup [${station}]: Found via counter id=${stationId} (printer: ${counterPrinters[0].id})`);
        return counterPrinters[0];
      }
    }
    
    // Priority 1b: If stationId provided (kitchen station), get printer from kitchen_stations table
    if (stationId && !isCounter) {
      const [stationPrinters] = await pool.query(
        `SELECT p.* FROM printers p
         JOIN kitchen_stations ks ON ks.printer_id = p.id
         WHERE ks.id = ? AND ks.outlet_id = ? AND p.is_active = 1
         LIMIT 1`,
        [stationId, outletId]
      );
      if (stationPrinters[0]) {
        logger.info(`Printer lookup [${station}]: Found via kitchen_station id=${stationId} (printer: ${stationPrinters[0].id})`);
        return stationPrinters[0];
      }
      // Station exists but no printer assigned
      logger.error(`Printer lookup [${station}]: Kitchen station id=${stationId} has NO printer_id assigned!`);
    }

    // If stationId was provided but lookup failed, try station name as last resort
    if (stationId) {
      logger.warn(`Printer lookup [${station}]: stationId=${stationId} lookup failed, trying station_type match`);
    }
    return this.getPrinterByStation(outletId, station);
  },

  /**
   * Get ALL printers that should receive a KOT for a given station.
   * Unlike getPrinterByStationWithId (returns 1), this returns ALL matching printers
   * so KOTs can be sent to multiple printers per station.
   *
   * Lookup:
   *  1. Station's directly assigned printer (kitchen_stations.printer_id or counters.printer_id)
   *  2. All active printers with matching station column for the outlet
   *  Deduplicates by printer ID.
   */
  async getAllPrintersForStation(outletId, station, stationId = null, isCounter = false) {
    const pool = getPool();
    const printerMap = new Map();

    // 1. Direct assignment from kitchen_station or counter
    if (stationId && isCounter) {
      const [rows] = await pool.query(
        `SELECT p.* FROM printers p
         JOIN counters c ON c.printer_id = p.id
         WHERE c.id = ? AND c.outlet_id = ? AND p.is_active = 1`,
        [stationId, outletId]
      );
      for (const p of rows) printerMap.set(p.id, p);
    } else if (stationId) {
      const [rows] = await pool.query(
        `SELECT p.* FROM printers p
         JOIN kitchen_stations ks ON ks.printer_id = p.id
         WHERE ks.id = ? AND ks.outlet_id = ? AND p.is_active = 1`,
        [stationId, outletId]
      );
      for (const p of rows) printerMap.set(p.id, p);
    }

    // 2. All printers with matching station column for this outlet
    const stationMatches = [station];
    const kotVariantMap = {
      'kitchen': 'kot_kitchen',
      'main_kitchen': 'kot_kitchen',
      'bar': 'kot_bar',
      'main_bar': 'kot_bar',
      'dessert': 'kot_dessert'
    };
    if (kotVariantMap[station]) {
      stationMatches.push(kotVariantMap[station]);
    }

    const [stationPrinters] = await pool.query(
      `SELECT * FROM printers
       WHERE outlet_id = ? AND station IN (?) AND is_active = 1
       ORDER BY id`,
      [outletId, stationMatches]
    );
    for (const p of stationPrinters) printerMap.set(p.id, p);

    const result = Array.from(printerMap.values());
    if (result.length > 1) {
      logger.info(`getAllPrintersForStation: outlet=${outletId}, station="${station}", stationId=${stationId} → ${result.length} printers: [${result.map(p => p.id + ':' + p.name).join(', ')}]`);
    }
    return result;
  },

  async updatePrinter(id, data) {
    const pool = getPool();
    const updates = [];
    const params = [];

    const fields = ['name', 'code', 'printer_type', 'station', 'station_id',
                    'ip_address', 'port', 'connection_type', 'device_id',
                    'paper_width', 'characters_per_line', 'supports_cash_drawer',
                    'supports_cutter', 'supports_logo', 'is_active'];
    
    for (const field of fields) {
      const camelField = field.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
      // Support both camelCase and snake_case field names
      const value = data[camelField] !== undefined ? data[camelField] : data[field];
      if (value !== undefined) {
        updates.push(`${field} = ?`);
        params.push(value);
      }
    }

    if (updates.length === 0) {
      logger.warn(`updatePrinter(${id}): No fields to update. Received data keys:`, Object.keys(data));
      return;
    }

    params.push(id);
    logger.info(`updatePrinter(${id}): Updating fields: ${updates.join(', ')} with params:`, params.slice(0, -1));
    await pool.query(`UPDATE printers SET ${updates.join(', ')} WHERE id = ?`, params);
  },

  async updatePrinterStatus(id, isOnline) {
    const pool = getPool();
    await pool.query(
      `UPDATE printers SET is_online = ?, last_seen_at = NOW() WHERE id = ?`,
      [isOnline, id]
    );
  },

  // ========================
  // PRINT JOB QUEUE
  // ========================

  async createPrintJob(data) {
    const pool = getPool();
    
    // Prevent duplicate pending jobs for same reference (invoice/KOT number)
    // When printerId is provided (multi-printer KOT), include it in the check so
    // the same KOT going to different printers is NOT considered a duplicate.
    if (data.referenceNumber) {
      let dupQuery = `SELECT id FROM print_jobs 
         WHERE outlet_id = ? AND reference_number = ? AND job_type = ? AND status = 'pending'`;
      const dupParams = [data.outletId, data.referenceNumber, data.jobType];

      if (data.printerId) {
        dupQuery += ' AND printer_id = ?';
        dupParams.push(data.printerId);
      }
      dupQuery += ' LIMIT 1';

      const [existing] = await pool.query(dupQuery, dupParams);
      if (existing[0]) {
        logger.info(`Print job already pending for ${data.referenceNumber} (${data.jobType}, printer: ${data.printerId || 'any'}), skipping duplicate`);
        return { id: existing[0].id, duplicate: true };
      }
    }
    
    const uuid = uuidv4();
    const contentForStorage = encodePrintContentForStorage(data.content);

    // Find appropriate printer for this station
    let printerId = data.printerId;
    if (!printerId && data.station) {
      // Use stationId for precise lookup if available
      const printer = await this.getPrinterByStationWithId(data.outletId, data.station, data.stationId, data.isCounter);
      printerId = printer?.id;
      if (!printerId) {
        logger.warn(`Print job for station "${data.station}" (id: ${data.stationId}, outlet ${data.outletId}): No printer found, job will have NULL printer_id`);
      } else {
        logger.info(`Print job printer assigned: station="${data.station}", stationId=${data.stationId}, printer_id=${printerId}`);
      }
    }

    const [result] = await pool.query(
      `INSERT INTO print_jobs (
        uuid, outlet_id, printer_id, job_type, station,
        kot_id, order_id, invoice_id, content, content_type,
        reference_number, table_number, priority, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid, data.outletId, printerId, data.jobType, data.station,
        data.kotId, data.orderId, data.invoiceId, contentForStorage,
        data.contentType || 'text', data.referenceNumber,
        data.tableNumber, data.priority || 0, data.createdBy
      ]
    );

    const jobId = result.insertId;

    // Log creation
    await pool.query(
      `INSERT INTO print_job_logs (print_job_id, action, details) VALUES (?, 'created', ?)`,
      [jobId, JSON.stringify({ station: data.station, type: data.jobType })]
    );

    // Notify bridges via pub/sub (uses local emitter fallback if Redis unavailable)
    publishMessage('print:new_job', {
      outletId: data.outletId,
      station: data.station,
      jobId,
      jobType: data.jobType,
      referenceNumber: data.referenceNumber
    });

    // Notify any long-polling bridge requests instantly
    printJobNotifier.emit(`outlet:${data.outletId}`);

    logger.info(`Print job created: id=${jobId}, uuid=${uuid}, station=${data.station}, type=${data.jobType}, ref=${data.referenceNumber || 'N/A'}`);
    return { id: jobId, uuid };
  },

  async getPendingJobs(outletId, station, limit = 10) {
    const pool = getPool();
    
    const [jobs] = await pool.query(
      `SELECT pj.*, p.name as printer_name, p.ip_address, p.port
       FROM print_jobs pj
       LEFT JOIN printers p ON pj.printer_id = p.id
       WHERE pj.outlet_id = ? 
         AND pj.station = ?
         AND pj.status = 'pending'
         AND pj.attempts < pj.max_attempts
       ORDER BY pj.priority DESC, pj.created_at ASC
       LIMIT ?`,
      [outletId, station, limit]
    );

    return jobs;
  },

  async getNextPendingJob(outletId, station) {
    const pool = getPool();
    
    const [jobs] = await pool.query(
      `SELECT pj.*, p.name as printer_name, p.ip_address, p.port
       FROM print_jobs pj
       LEFT JOIN printers p ON pj.printer_id = p.id
       WHERE pj.outlet_id = ? 
         AND pj.station = ?
         AND pj.status = 'pending'
         AND pj.attempts < pj.max_attempts
       ORDER BY pj.priority DESC, pj.created_at ASC
       LIMIT 1`,
      [outletId, station]
    );

    if (jobs[0]) {
      // Mark as processing
      await pool.query(
        `UPDATE print_jobs SET status = 'processing', processed_at = NOW(), attempts = attempts + 1 WHERE id = ?`,
        [jobs[0].id]
      );
      logger.debug(`Bridge poll found job: id=${jobs[0].id}, station=${station}, type=${jobs[0].job_type}, ref=${jobs[0].reference_number}`);
    }

    return jobs[0] || null;
  },

  /**
   * Get next pending job for ANY station (dynamic polling)
   * Used when bridge has '*' in assigned_stations
   */
  async getNextPendingJobAny(outletId) {
    const pool = getPool();
    
    const [jobs] = await pool.query(
      `SELECT pj.*, p.name as printer_name, p.ip_address, p.port
       FROM print_jobs pj
       LEFT JOIN printers p ON pj.printer_id = p.id
       WHERE pj.outlet_id = ? 
         AND pj.status = 'pending'
         AND pj.attempts < pj.max_attempts
       ORDER BY pj.priority DESC, pj.created_at ASC
       LIMIT 1`,
      [outletId]
    );

    if (jobs[0]) {
      // Mark as processing
      await pool.query(
        `UPDATE print_jobs SET status = 'processing', processed_at = NOW(), attempts = attempts + 1 WHERE id = ?`,
        [jobs[0].id]
      );
      logger.debug(`Bridge poll (dynamic) found job: id=${jobs[0].id}, station=${jobs[0].station}, type=${jobs[0].job_type}, ref=${jobs[0].reference_number}`);
    }

    return jobs[0] || null;
  },

  /**
   * Get a batch of pending jobs for ANY station (long-polling bridge).
   * Marks all returned jobs as 'processing' atomically.
   * @param {number} outletId
   * @param {number} limit - max jobs to return (default 10)
   */
  async getNextPendingJobsBatch(outletId, limit = 10) {
    const pool = getPool();

    const [jobs] = await pool.query(
      `SELECT pj.*, p.name as printer_name, p.ip_address, p.port
       FROM print_jobs pj
       LEFT JOIN printers p ON pj.printer_id = p.id
       WHERE pj.outlet_id = ?
         AND pj.status = 'pending'
         AND pj.attempts < pj.max_attempts
       ORDER BY pj.priority DESC, pj.created_at ASC
       LIMIT ?`,
      [outletId, limit]
    );

    if (jobs.length === 0) return [];

    // Mark all as processing in one query
    const ids = jobs.map(j => j.id);
    await pool.query(
      `UPDATE print_jobs SET status = 'processing', processed_at = NOW(), attempts = attempts + 1 WHERE id IN (?)`,
      [ids]
    );
    logger.debug(`Bridge batch poll: ${jobs.length} jobs for outlet ${outletId} [${ids.join(',')}]`);

    return jobs;
  },

  async markJobPrinted(jobId, bridgeId = null) {
    const pool = getPool();

    await pool.query(
      `UPDATE print_jobs SET status = 'printed', printed_at = NOW() WHERE id = ?`,
      [jobId]
    );

    await pool.query(
      `INSERT INTO print_job_logs (print_job_id, action, bridge_id) VALUES (?, 'printed', ?)`,
      [jobId, bridgeId]
    );

    // Update bridge stats
    if (bridgeId) {
      await pool.query(
        `UPDATE printer_bridges SET total_jobs_printed = total_jobs_printed + 1, last_poll_at = NOW() WHERE id = ?`,
        [bridgeId]
      );
    }

    logger.info(`Print job ${jobId} marked as printed`);
  },

  async markJobFailed(jobId, error, bridgeId = null) {
    const pool = getPool();

    const [job] = await pool.query('SELECT attempts, max_attempts FROM print_jobs WHERE id = ?', [jobId]);
    
    const newStatus = job[0].attempts >= job[0].max_attempts ? 'failed' : 'pending';

    await pool.query(
      `UPDATE print_jobs SET status = ?, last_error = ? WHERE id = ?`,
      [newStatus, error, jobId]
    );

    await pool.query(
      `INSERT INTO print_job_logs (print_job_id, action, details, bridge_id) VALUES (?, 'failed', ?, ?)`,
      [jobId, error, bridgeId]
    );

    if (bridgeId) {
      await pool.query(
        `UPDATE printer_bridges SET failed_jobs = failed_jobs + 1 WHERE id = ?`,
        [bridgeId]
      );
    }
  },

  async cancelJob(jobId, reason) {
    const pool = getPool();

    await pool.query(
      `UPDATE print_jobs SET status = 'cancelled' WHERE id = ?`,
      [jobId]
    );

    await pool.query(
      `INSERT INTO print_job_logs (print_job_id, action, details) VALUES (?, 'cancelled', ?)`,
      [jobId, reason]
    );
  },

  async retryJob(jobId) {
    const pool = getPool();

    await pool.query(
      `UPDATE print_jobs SET status = 'pending', attempts = 0 WHERE id = ?`,
      [jobId]
    );

    await pool.query(
      `INSERT INTO print_job_logs (print_job_id, action) VALUES (?, 'retried')`,
      [jobId]
    );
  },

  // ========================
  // BRIDGE MANAGEMENT
  // ========================

  async createBridge(data) {
    const pool = getPool();
    const uuid = uuidv4();
    const apiKey = crypto.randomBytes(32).toString('hex');
    const hashedKey = crypto.createHash('sha256').update(apiKey).digest('hex');

    const [result] = await pool.query(
      `INSERT INTO printer_bridges (
        uuid, outlet_id, name, bridge_code, api_key, assigned_stations
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uuid, data.outletId, data.name, data.bridgeCode,
        hashedKey, JSON.stringify(data.assignedStations || [])
      ]
    );

    return { 
      id: result.insertId, 
      uuid, 
      bridgeCode: data.bridgeCode,
      apiKey // Return plain key only on creation
    };
  },

  /**
   * Get bridge by outlet and code (no API key required)
   * Used for public/global bridge access
   */
  async getBridgeByCode(outletId, bridgeCode) {
    const pool = getPool();

    const [bridges] = await pool.query(
      `SELECT * FROM printer_bridges 
       WHERE outlet_id = ? AND bridge_code = ? AND is_active = 1
       LIMIT 1`,
      [outletId, bridgeCode]
    );

    if (bridges[0]) {
      // Update last seen (fire-and-forget — don't block the response)
      pool.query(
        `UPDATE printer_bridges SET is_online = 1, last_poll_at = NOW() WHERE id = ?`,
        [bridges[0].id]
      ).catch(() => {});
    }

    return bridges[0] || null;
  },

  async validateBridgeApiKey(outletId, bridgeCode, apiKey) {
    const pool = getPool();
    // If no API key provided, use simple lookup (global/public mode)
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return this.getBridgeByCode(outletId, bridgeCode);
    }
    const normalizedApiKey = apiKey.trim();
    const hashedKey = crypto.createHash('sha256').update(normalizedApiKey).digest('hex');

    const [bridges] = await pool.query(
      `SELECT * FROM printer_bridges 
       WHERE outlet_id = ? AND bridge_code = ? AND is_active = 1
         AND api_key IN (?, ?)
       LIMIT 1`,
      [outletId, bridgeCode, hashedKey, normalizedApiKey]
    );

    if (bridges[0]) {
      // Update last seen (fire-and-forget — don't block the response)
      pool.query(
        `UPDATE printer_bridges SET is_online = 1, last_poll_at = NOW() WHERE id = ?`,
        [bridges[0].id]
      ).catch(() => {});
    }

    return bridges[0] || null;
  },

  async getBridges(outletId) {
    const pool = getPool();
    const [bridges] = await pool.query(
      `SELECT id, uuid, outlet_id, name, bridge_code, assigned_stations,
              is_active, is_online, last_poll_at, total_jobs_printed, failed_jobs,
              created_at
       FROM printer_bridges WHERE outlet_id = ?`,
      [outletId]
    );
    return bridges;
  },

  async updateBridgeStatus(bridgeId, isOnline, lastIp = null) {
    const pool = getPool();
    await pool.query(
      `UPDATE printer_bridges SET is_online = ?, last_poll_at = NOW(), last_ip = ? WHERE id = ?`,
      [isOnline, lastIp, bridgeId]
    );
  },

  async hasRecentlyOnlineBridge(outletId) {
    const pool = getPool();
    const [bridges] = await pool.query(
      `SELECT id
       FROM printer_bridges
       WHERE outlet_id = ?
         AND is_active = 1
         AND is_online = 1
         AND last_poll_at IS NOT NULL
         AND TIMESTAMPDIFF(SECOND, last_poll_at, NOW()) <= ?
       LIMIT 1`,
      [outletId, BRIDGE_ONLINE_WINDOW_SECONDS]
    );
    return bridges.length > 0;
  },

  async reportBridgePrinterStatus({ outletId, bridgeId, statuses = [] }) {
    const pool = getPool();
    const normalizedStatuses = Array.isArray(statuses) ? statuses.filter((s) => s && typeof s === 'object') : [];

    if (normalizedStatuses.length === 0) {
      return {
        bridgeId,
        received: 0,
        updated: 0,
        unmatched: 0
      };
    }

    const [printers] = await pool.query(
      `SELECT id, station, ip_address, port
       FROM printers
       WHERE outlet_id = ? AND is_active = 1`,
      [outletId]
    );

    const printerById = new Map(printers.map((printer) => [String(printer.id), printer]));
    const updatesByPrinterId = new Map();
    const unmatched = [];

    for (const item of normalizedStatuses) {
      const station = typeof item.station === 'string' ? item.station.trim() : null;
      const ipAddress = typeof item.ipAddress === 'string' ? item.ipAddress.trim() : null;
      const port = Number.isInteger(item.port) ? item.port : parseInt(item.port, 10);
      const printerId = item.printerId !== undefined && item.printerId !== null ? String(item.printerId) : null;

      let matchedPrinter = null;

      // 1. Direct printer ID match (bridge config now includes printerId)
      if (printerId && printerById.has(printerId)) {
        matchedPrinter = printerById.get(printerId);
      }

      // 2. Station name match (preferred over IP when multiple printers share same IP)
      if (!matchedPrinter && station) {
        const stationMatches = printers.filter((printer) => printer.station === station);
        if (stationMatches.length === 1) {
          matchedPrinter = stationMatches[0];
        }
      }

      // 3. IP+port match (only if unique match found)
      if (!matchedPrinter && ipAddress) {
        const ipMatches = printers.filter((printer) => {
          if (!printer.ip_address || printer.ip_address !== ipAddress) return false;
          if (!Number.isInteger(port)) return true;
          return (printer.port || 9100) === port;
        });
        if (ipMatches.length === 1) {
          matchedPrinter = ipMatches[0];
        } else if (ipMatches.length > 1 && station) {
          // Multiple printers on same IP — try to narrow by station
          matchedPrinter = ipMatches.find((p) => p.station === station) || null;
        }
      }

      if (!matchedPrinter) {
        unmatched.push({
          printerId: item.printerId || null,
          station: station || null,
          ipAddress: ipAddress || null
        });
        continue;
      }

      const parsedCheckedAt = item.checkedAt ? new Date(item.checkedAt) : new Date();
      const checkedAt = Number.isNaN(parsedCheckedAt.getTime()) ? new Date() : parsedCheckedAt;

      updatesByPrinterId.set(matchedPrinter.id, {
        isOnline: Boolean(item.isOnline),
        checkedAt
      });
    }

    await Promise.all(
      Array.from(updatesByPrinterId.entries()).map(([printerId, payload]) =>
        pool.query(
          `UPDATE printers
           SET is_online = ?, last_seen_at = ?
           WHERE id = ? AND outlet_id = ?`,
          [payload.isOnline, payload.checkedAt, printerId, outletId]
        )
      )
    );

    return {
      bridgeId,
      received: normalizedStatuses.length,
      updated: updatesByPrinterId.size,
      unmatched: unmatched.length,
      unmatchedItems: unmatched.slice(0, 10)
    };
  },

  async getBridgePrinterConfig(outletId, bridgeCode, apiKey) {
    const pool = getPool();
    const bridge = await this.validateBridgeApiKey(outletId, bridgeCode, apiKey);
    if (!bridge) {
      return null;
    }

    let assignedStations = [];
    try {
      assignedStations = bridge.assigned_stations ? JSON.parse(bridge.assigned_stations) : [];
      if (!Array.isArray(assignedStations)) {
        assignedStations = [];
      }
    } catch (err) {
      assignedStations = [];
    }

    // Check for dynamic mode ('*' or empty = all printers)
    const isDynamicMode = assignedStations.includes('*') || assignedStations.length === 0;

    let rows;
    if (isDynamicMode) {
      // Dynamic mode: return ALL active printers for this outlet
      // Join kitchen_stations AND counters to get all station_type / counter_type mappings
      [rows] = await pool.query(
        `SELECT p.id as printer_id, p.station, p.ip_address, p.port,
                ks.station_type as ks_station_type,
                c.counter_type as counter_type
         FROM printers p
         LEFT JOIN kitchen_stations ks ON ks.printer_id = p.id AND ks.is_active = 1
         LEFT JOIN counters c ON c.printer_id = p.id AND c.is_active = 1
         WHERE p.outlet_id = ? AND p.is_active = 1 AND p.ip_address IS NOT NULL
         ORDER BY p.station ASC, p.id ASC`,
        [outletId]
      );
    } else {
      // Fixed mode: return only printers matching assigned stations
      const uniqueStations = Array.from(
        new Set(
          assignedStations
            .map((station) => (typeof station === 'string' ? station.trim() : ''))
            .filter(Boolean)
        )
      );

      if (uniqueStations.length === 0) {
        return {
          bridgeId: bridge.id,
          bridgeCode: bridge.bridge_code,
          assignedStations: [],
          printers: {},
          isDynamic: false,
          fetchedAt: new Date().toISOString()
        };
      }

      const placeholders = uniqueStations.map(() => '?').join(',');
      [rows] = await pool.query(
        `SELECT p.id as printer_id, p.station, p.ip_address, p.port,
                ks.station_type as ks_station_type,
                c.counter_type as counter_type
         FROM printers p
         LEFT JOIN kitchen_stations ks ON ks.printer_id = p.id AND ks.is_active = 1
         LEFT JOIN counters c ON c.printer_id = p.id AND c.is_active = 1
         WHERE p.outlet_id = ?
           AND p.is_active = 1
           AND p.station IN (${placeholders})
         ORDER BY p.station ASC, p.id ASC`,
        [outletId, ...uniqueStations]
      );
    }

    const printers = {};
    for (const row of rows) {
      const printerConfig = {
        ip: row.ip_address,
        port: row.port || 9100,
        printerId: row.printer_id
      };
      
      // Add by printer.station (e.g., 'bar', 'kitchen', 'bill')
      // If two printers share the same station, use station:printerId as key for the duplicate
      // so ALL printers appear in the bridge config (needed for status reporting)
      const station = typeof row.station === 'string' ? row.station.trim() : '';
      if (station) {
        if (!printers[station]) {
          printers[station] = printerConfig;
        } else if (printers[station].printerId !== row.printer_id) {
          printers[`${station}:${row.printer_id}`] = printerConfig;
        }
      }
      
      // Add by kitchen_station.station_type (e.g., 'main_kitchen', 'tandoor')
      const ksType = row.ks_station_type ? String(row.ks_station_type).trim() : '';
      if (ksType && !printers[ksType]) {
        printers[ksType] = printerConfig;
      }

      // Add by counter.counter_type (e.g., 'main_bar', 'mocktail')
      const cType = row.counter_type ? String(row.counter_type).trim() : '';
      if (cType && !printers[cType]) {
        printers[cType] = printerConfig;
      }
    }

    // ---- Map kitchen station NAMES to printers (KOTs use station_name.toLowerCase()) ----
    // kitchen_stations.printer_id may be NULL, so the JOIN above misses them.
    // Query all station names and map each to the best matching printer.
    const firstPrinter = rows.length > 0
      ? { ip: rows[0].ip_address, port: rows[0].port || 9100, printerId: rows[0].printer_id }
      : null;

    try {
      // Parallel: kitchen stations + counters (both independent, both use outletId)
      const [ksRowsRes, cRowsRes] = await Promise.all([
        pool.query(
          `SELECT ks.name, ks.station_type, ks.printer_id,
                  p.id as linked_printer_id, p.station as linked_station, p.ip_address as linked_ip, p.port as linked_port
           FROM kitchen_stations ks
           LEFT JOIN printers p ON ks.printer_id = p.id AND p.is_active = 1
           WHERE ks.outlet_id = ? AND ks.is_active = 1`,
          [outletId]
        ),
        pool.query(
          `SELECT c.name, c.counter_type, c.printer_id,
                  p.id as linked_printer_id, p.station as linked_station, p.ip_address as linked_ip, p.port as linked_port
           FROM counters c
           LEFT JOIN printers p ON c.printer_id = p.id AND p.is_active = 1
           WHERE c.outlet_id = ? AND c.is_active = 1`,
          [outletId]
        )
      ]);
      const ksRows = ksRowsRes[0];
      const cRows = cRowsRes[0];

      for (const ks of ksRows) {
        const nameKey = ks.name ? ks.name.toLowerCase().replace(/\s+/g, '_') : '';
        if (!nameKey) continue;
        // If this station name isn't already mapped, find the best printer
        if (!printers[nameKey]) {
          if (ks.linked_ip) {
            // Station has a linked printer
            printers[nameKey] = { ip: ks.linked_ip, port: ks.linked_port || 9100, printerId: ks.linked_printer_id };
          } else {
            // No linked printer — map to printer with matching station name, or first available
            printers[nameKey] = printers[nameKey] || printers[ks.station_type] || firstPrinter;
          }
        }
      }
      for (const c of cRows) {
        const nameKey = c.name ? c.name.toLowerCase().replace(/\s+/g, '_') : '';
        if (!nameKey || printers[nameKey]) continue;
        if (c.linked_ip) {
          printers[nameKey] = { ip: c.linked_ip, port: c.linked_port || 9100, printerId: c.linked_printer_id };
        } else {
          printers[nameKey] = printers[c.counter_type] || printers['bar'] || firstPrinter;
        }
      }
    } catch (err) {
      // Non-fatal: bridge still works with printer.station-based mapping
      logger.warn('getBridgePrinterConfig: station name mapping query failed:', err.message);
    }

    // ---- Auto-add common station aliases so bridge can route every job type ----

    // bill / cashier — jobs hardcode station='bill'; map to bill/cashier printer or first available
    if (!printers['bill'] && firstPrinter) {
      printers['bill'] = printers['cashier'] || firstPrinter;
    }
    if (!printers['cashier'] && printers['bill']) {
      printers['cashier'] = printers['bill'];
    }

    // main_kitchen ↔ kitchen cross-alias
    if (!printers['main_kitchen'] && printers['kitchen']) {
      printers['main_kitchen'] = printers['kitchen'];
    }
    if (!printers['kitchen'] && printers['main_kitchen']) {
      printers['kitchen'] = printers['main_kitchen'];
    }

    // kot_kitchen / kot_bar legacy aliases
    if (!printers['kot_kitchen'] && (printers['kitchen'] || printers['main_kitchen'])) {
      printers['kot_kitchen'] = printers['kitchen'] || printers['main_kitchen'];
    }
    if (!printers['kot_bar'] && printers['bar']) {
      printers['kot_bar'] = printers['bar'];
    }

    return {
      bridgeId: bridge.id,
      bridgeCode: bridge.bridge_code,
      assignedStations: isDynamicMode ? ['*'] : assignedStations,
      printers,
      isDynamic: isDynamicMode,
      fetchedAt: new Date().toISOString()
    };
  },

  // ========================
  // CONTENT FORMATTING
  // ========================

  formatKotContent(kotData) {
    const lines = [];
    const w = 42;
    const dash = '-'.repeat(w);
    const cmd = this.getEscPosCommands();

    const station = String(kotData.station || '').trim().toLowerCase();
    const stationName = String(kotData.stationName || '').trim();
    const stationNameLower = stationName.toLowerCase();
    const isCounter = kotData.isCounter === true;
    
    // Determine if this is a bar order (BOT) based on:
    // 1. isCounter flag (item has counter_id)
    // 2. station type contains 'bar'
    // 3. station NAME contains 'bar' (e.g., station named "Bar" but type is "main_kitchen")
    const isBarOrder = isCounter || 
      station === 'bar' || station === 'main_bar' || station.includes('bar') ||
      stationNameLower === 'bar' || stationNameLower.includes('bar');
    const orderType = isBarOrder ? 'BOT' : 'KOT';
    
    // PRIORITY: Use actual stationName from database FIRST, then fall back to formatted station type
    // stationName = actual name like "Main Kitchen", "Bar Counter 1" from ks.name or c.name
    // station = station_type like "main_kitchen", "bar" 
    let stationLabel;
    if (stationName && stationName !== station) {
      // Use actual station name from database (e.g., "Main Kitchen", "Bar Counter")
      stationLabel = stationName.toUpperCase();
    } else {
      // Fall back to formatted station type
      stationLabel = station ? station.replace(/_/g, ' ').toUpperCase() : 'KITCHEN';
    }
    const title = `${stationLabel} ORDER (${orderType})`;
    lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + title);
    lines.push(cmd.BOLD_OFF + cmd.ALIGN_LEFT + `${orderType}#: ` + kotData.kotNumber);
    lines.push(this.padBetween('Table: ' + (kotData.tableNumber || 'Takeaway'), kotData.time || '', w));
    lines.push(dash);

    for (const item of kotData.items || []) {
      // Show food type (veg/non-veg) only for KOT (kitchen), not for BOT (bar)
      const tag = (!isBarOrder && item.itemType) ? ` [${item.itemType.toUpperCase()}]` : '';
      lines.push(`${item.quantity} x ${item.itemName || ''}${tag}`);
      if (item.variantName) lines.push(`  (${item.variantName})`);
      if (item.weight) lines.push(`  Wt: ${item.weight}`);
      if (item.addonsText) lines.push(`  + ${item.addonsText}`);
      if (item.instructions) lines.push(`  >> ${item.instructions}`);
    }

    lines.push(dash);
    lines.push('Captain: ' + (kotData.captainName || 'N/A'));
    lines.push(dash);

    return lines.join('\n');
  },

  formatCancelSlipContent(cancelData) {
    const lines = [];
    const w = 42;
    const dash = '-'.repeat(w);
    const cmd = this.getEscPosCommands();

    // Check if this is a bar order (BOT) - don't show item type for bar orders
    const station = (cancelData.station || '').toLowerCase();
    const isBarOrder = station.includes('bar') || station.includes('bot');

    lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + '*** CANCEL ***');
    lines.push(cmd.BOLD_OFF + cmd.ALIGN_LEFT + 'Order#: ' + (cancelData.orderNumber || 'N/A'));
    lines.push(this.padBetween(
      'Table: ' + (cancelData.tableNumber || 'Takeaway'),
      cancelData.kotNumber ? 'KOT#: ' + cancelData.kotNumber : '', w
    ));
    lines.push('Time: ' + (cancelData.time || ''));
    lines.push(dash);

    for (const item of cancelData.items || []) {
      // Show food type (veg/non-veg) only for KOT (kitchen), not for BOT (bar)
      const tag = (!isBarOrder && item.itemType) ? ` [${item.itemType.toUpperCase()}]` : '';
      lines.push(`${item.quantity} x ${item.itemName || ''}${tag}`);
      if (item.variantName) lines.push(`  (${item.variantName})`);
    }

    lines.push(dash);
    lines.push('Reason: ' + (cancelData.reason || 'N/A'));
    lines.push('Cancelled By: ' + (cancelData.cancelledBy || 'Staff'));
    lines.push(dash);

    return lines.join('\n');
  },

  async printCancelSlip(cancelData, userId) {
    const content = this.formatCancelSlipContent(cancelData);
    const station = cancelData.station || 'kitchen';

    // ── Mobile POS intercept ────────────────────────────────────────────────
    const mposWrapped = this.wrapWithEscPos(content, { beep: true, mobilePOS: true });
    const mposResult = await this.sendToMobilePOS(
      { id: null, name: 'MobilePOS', outlet_id: cancelData.outletId, device_id: null, station },
      mposWrapped,
      { jobType: 'cancel_slip', ref: cancelData.orderNumber, outletId: cancelData.outletId, userId }
    );
    if (mposResult) {
      logger.info(`printCancelSlip: intercepted by Mobile POS (${mposResult.mode}) ref=${cancelData.orderNumber}`);
      return mposResult;
    }
    // ───────────────────────────────────────────────────────────────────────

    // Bridge fallback — regular wrapping for non-Mobile-POS printers
    const wrappedContent = this.wrapWithEscPos(content, { beep: true });
    return this.createPrintJob({
      outletId: cancelData.outletId,
      jobType: 'cancel_slip',
      station,
      orderId: cancelData.orderId,
      content: wrappedContent,
      contentType: 'escpos',
      referenceNumber: cancelData.orderNumber,
      tableNumber: cancelData.tableNumber,
      priority: 10,
      createdBy: userId
    });
  },

  async printCancelSlipDirect(cancelData, printerIp, printerPort = 9100) {
    const content = this.formatCancelSlipContent(cancelData);
    const escposData = this.wrapWithEscPos(content, { beep: true });

    try {
      const result = await this.printDirect(printerIp, printerPort, escposData);
      logger.info(`Cancel slip printed directly to ${printerIp}:${printerPort}`);
      return result;
    } catch (error) {
      logger.error(`Direct cancel slip print failed:`, error.message);
      throw error;
    }
  },

  formatBillContent(billData) {
    const lines = [];
    const w = 48; // 48-char full width for Font A on 80mm (zero char spacing fills the paper)
    const dash = '-'.repeat(w);
    const cmd = this.getEscPosCommands();
    const FONT_A = '\x1B\x4D\x00'; // Standard font (12x24) — bigger, clearer text
    const CHAR_SPACE_0 = '\x1B\x20\x00'; // Zero right-side character spacing — fills full paper width
    const LS_BODY = '\x1B\x33\x38'; // 56-dot line spacing — clean, readable spacing for Font A

    // ── 1. HEADER ───────────────────────────────
    if (billData.isDuplicate) {
      lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + '*** DUPLICATE ***');
      if (billData.duplicateNumber) lines.push('Copy #' + billData.duplicateNumber);
      lines.push(cmd.BOLD_OFF);
    }

    // Restaurant name (double height, bold, centered)
    lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + cmd.DOUBLE_HEIGHT + (billData.outletName || 'Restaurant'));
    // Switch to FONT_A + zero char spacing + body line spacing — stays for entire bill body
    lines.push(cmd.NORMAL + cmd.BOLD_OFF + FONT_A + CHAR_SPACE_0 + LS_BODY);
    if (billData.outletAddress) lines.push(billData.outletAddress);
    if (billData.outletPhone) lines.push('Ph: ' + billData.outletPhone);
    if (billData.outletGstin) lines.push('GSTIN: ' + billData.outletGstin);

    // ── 2. TOKEN NUMBER (prominent, centered, large) ────
    if (billData.tokenNumber) {
      lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + cmd.DOUBLE_HW + 'TOKEN: ' + billData.tokenNumber);
      lines.push(cmd.NORMAL + cmd.BOLD_OFF + FONT_A + CHAR_SPACE_0 + LS_BODY);
    }

    // ── 3. BILL META ────────────────────────────
    lines.push(cmd.ALIGN_LEFT + dash);
    const orderLabel = billData.orderType === 'dine_in'
      ? 'Dine In: ' + (billData.tableNumber || '')
      : (billData.orderType === 'takeaway' ? 'Takeaway' : (billData.orderType || ''));
    lines.push(cmd.BOLD_ON + this.padBetween(
      billData.date + ' ' + (billData.time || ''),
      orderLabel,
      w
    ) + cmd.BOLD_OFF);
    // Bill and Cashier on separate lines for cleaner look
    lines.push('Bill: ' + (billData.invoiceNumber || ''));
    lines.push('Cashier: ' + (billData.cashierName || 'Staff'));

    // ── 3. CUSTOMER (strict 2-column) ───────────
    lines.push(dash);
    const custName = billData.customerName || 'Walk-in';
    const custPhone = billData.customerPhone || '';
    const company = billData.customerCompanyName || '';
    const gstin = billData.customerGstin || '';
    const state = billData.customerGstState
      ? billData.customerGstState + (billData.customerGstStateCode ? ' (' + billData.customerGstStateCode + ')' : '')
      : '';

    if (company || gstin) {
      lines.push(this.padBetween('Name: ' + custName, 'Co: ' + (company || ''), w));
      if (custPhone || gstin) {
        lines.push(this.padBetween(
          custPhone ? 'Ph: ' + custPhone : '',
          gstin ? 'GSTIN: ' + gstin : '',
          w
        ));
      }
      if (billData.isInterstate || state) {
        lines.push(cmd.BOLD_ON + this.padBetween(
          billData.isInterstate ? '** INTERSTATE **' : '',
          state ? 'State: ' + state : '',
          w
        ) + cmd.BOLD_OFF);
      }
    } else {
      if (custPhone) {
        lines.push(this.padBetween('Name: ' + custName, 'Ph: ' + custPhone, w));
      } else {
        lines.push('Name: ' + custName);
      }
    }

    // ── 4. ITEM TABLE (full width fixed grid) ───
    // ITEM=24  QTY=5  RATE=9  AMT=10  = 48
    lines.push(dash);
    const cN = 24, cQ = 5, cP = 9, cA = 10;
    lines.push(cmd.BOLD_ON +
      'ITEM'.padEnd(cN) +
      this.rAlign('QTY', cQ) +
      this.rAlign('RATE', cP) +
      this.rAlign('AMT', cA) +
      cmd.BOLD_OFF
    );
    lines.push(dash);

    let totalQty = 0;
    for (const item of billData.items || []) {
      const qty = parseInt(item.quantity) || 0;
      totalQty += qty;
      const price = parseFloat(item.unitPrice).toFixed(2);
      const amount = parseFloat(item.totalPrice).toFixed(2);
      const cols =
        this.rAlign(qty.toString(), cQ) +
        this.rAlign(price, cP) +
        this.rAlign(amount, cA);
      let name = item.itemName || '';
      if (item.variantName) name += ' (' + item.variantName + ')';
      if (item.taxRate && item.taxRate >= 18) name += '*';
      if (item.isNC) name += ' [NC]';

      if (name.length <= cN) {
        lines.push(name.padEnd(cN) + cols);
      } else {
        const wrapped = this.wrapText(name, cN);
        for (let i = 0; i < wrapped.length - 1; i++) lines.push(wrapped[i]);
        lines.push((wrapped[wrapped.length - 1] || '').padEnd(cN) + cols);
      }
    }
    lines.push(dash);

    // ── 5. SUMMARY (right-aligned values) ───────
    lines.push(cmd.BOLD_ON + this.padBetween('Total Qty: ' + totalQty, '', w) + cmd.BOLD_OFF);
    lines.push(this.padBetween('Subtotal:', billData.subtotal, w));

    for (const tax of billData.taxes || []) {
      const baseName = (tax.name || 'Tax').replace(/\s*[\d.]+%?/g, '').trim().toUpperCase();
      lines.push(this.padBetween(baseName + ' @' + tax.rate + '%:', tax.amount, w));
    }

    if (billData.serviceCharge) {
      lines.push(this.padBetween('Service Charge:', billData.serviceCharge, w));
    }

    if (billData.discounts && billData.discounts.length > 0) {
      for (const disc of billData.discounts) {
        const discAmt = parseFloat(disc.amount).toFixed(2);
        let label = 'Discount';
        if (disc.type === 'percentage') label += ' (' + disc.value + '%)';
        else if (disc.value > 0) label += ' (Flat ' + (billData.currencySymbol || '₹') + parseFloat(disc.value).toFixed(0) + ')';
        lines.push(this.padBetween(label + ':', '-' + discAmt, w));
      }
    } else if (billData.discount) {
      lines.push(this.padBetween('Discount:', '-' + billData.discount, w));
    }

    if (billData.roundOff && parseFloat(billData.roundOff) !== 0) {
      lines.push(this.padBetween('Round Off:', billData.roundOff, w));
    }

    if (billData.ncAmount && parseFloat(billData.ncAmount) > 0) {
      lines.push(cmd.BOLD_ON + this.padBetween('NO CHARGE (NC):', '-' + parseFloat(billData.ncAmount).toFixed(2), w) + cmd.BOLD_OFF);
    }

    // ── 6. GRAND TOTAL (center, bold, double width + double height — max size)
    const eqDash = '='.repeat(w);
    lines.push(eqDash);
    lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + cmd.DOUBLE_HW + 'GRAND TOTAL');
    lines.push((billData.currencySymbol || '₹') + billData.grandTotal);
    // Restore FONT_A + zero char spacing + body spacing after DOUBLE_HW resets print mode
    lines.push(cmd.NORMAL + cmd.BOLD_OFF + FONT_A + CHAR_SPACE_0 + LS_BODY + cmd.ALIGN_LEFT + eqDash);

    // ── 7. PAYMENT (full width) ─────────────────
    if (billData.dueAmount && parseFloat(billData.dueAmount) > 0) {
      lines.push(this.padBetween('PAID:', (billData.currencySymbol || '₹') + parseFloat(billData.paidAmount || 0).toFixed(2), w));
      lines.push(this.padBetween('DUE:', (billData.currencySymbol || '₹') + parseFloat(billData.dueAmount).toFixed(2), w));
      lines.push(dash);
    }

    if (billData.paymentMode) {
      if (billData.paymentMode === 'split' && billData.splitBreakdown && billData.splitBreakdown.length > 0) {
        lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + 'SPLIT PAYMENT' + cmd.BOLD_OFF);
        lines.push(cmd.ALIGN_LEFT);
        for (const sp of billData.splitBreakdown) {
          lines.push(this.padBetween(
            (sp.paymentMode || '').toUpperCase(),
            (billData.currencySymbol || '₹') + parseFloat(sp.amount || 0).toFixed(2),
            w
          ));
        }
        lines.push(dash);
      } else {
        lines.push(this.padBetween('Payment:', billData.paymentMode.toUpperCase(), w));
      }
    }

    // ── 8. FOOTER ───────────────────────────────
    lines.push(cmd.ALIGN_CENTER + 'THANK YOU! VISIT AGAIN');

    return lines.join('\n');
  },

  formatBillContentForMobilePOS(billData) {
    // Identical to formatBillContent with 3 Mobile POS tweaks:
    //   1. LS_BODY = 30-dot (removes extra line gaps)
    //   2. No extra reset line after TOKEN (removes gap after token)
    //   3. GRAND TOTAL on one bold line (not two double-HW lines)
    const lines = [];
    const w = 48;
    const dash = '-'.repeat(w);
    const cmd = this.getEscPosCommands();
    const FONT_A = '\x1B\x4D\x00';
    const CHAR_SPACE_0 = '\x1B\x20\x00';
    const LS_BODY = '\x1B\x33\x1E'; // [MPOS tweak 1] 30-dot — compact, no extra gaps

    // ── 1. HEADER ───────────────────────────────
    if (billData.isDuplicate) {
      lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + '*** DUPLICATE ***');
      if (billData.duplicateNumber) lines.push('Copy #' + billData.duplicateNumber);
      lines.push(cmd.BOLD_OFF);
    }

    lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + cmd.DOUBLE_HEIGHT + (billData.outletName || 'Restaurant') + cmd.NORMAL + cmd.BOLD_OFF + FONT_A + CHAR_SPACE_0 + LS_BODY);
    if (billData.outletAddress) lines.push(billData.outletAddress);
    if (billData.outletPhone) lines.push('Ph: ' + billData.outletPhone);
    if (billData.outletGstin) lines.push('GSTIN: ' + billData.outletGstin);

    // ── 2. TOKEN NUMBER ─────────────────────────
    if (billData.tokenNumber) {
      // [MPOS tweak 2] reset appended inline — no separate line entry, avoids blank line after token
      lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + cmd.DOUBLE_HW + 'TOKEN: ' + billData.tokenNumber + cmd.NORMAL + cmd.BOLD_OFF + FONT_A + CHAR_SPACE_0 + LS_BODY);
    }

    // ── 3. BILL META ────────────────────────────
    lines.push(cmd.ALIGN_LEFT + dash);
    const orderLabel = billData.orderType === 'dine_in'
      ? 'Dine In: ' + (billData.tableNumber || '')
      : (billData.orderType === 'takeaway' ? 'Takeaway' : (billData.orderType || ''));
    lines.push(cmd.BOLD_ON + this.padBetween(
      billData.date + ' ' + (billData.time || ''),
      orderLabel,
      w
    ) + cmd.BOLD_OFF);
    lines.push('Bill: ' + (billData.invoiceNumber || ''));
    lines.push('Cashier: ' + (billData.cashierName || 'Staff'));

    // ── 4. CUSTOMER (strict 2-column) ───────────
    lines.push(dash);
    const custName = billData.customerName || 'Walk-in';
    const custPhone = billData.customerPhone || '';
    const company = billData.customerCompanyName || '';
    const gstin = billData.customerGstin || '';
    const state = billData.customerGstState
      ? billData.customerGstState + (billData.customerGstStateCode ? ' (' + billData.customerGstStateCode + ')' : '')
      : '';

    if (company || gstin) {
      lines.push(this.padBetween('Name: ' + custName, 'Co: ' + (company || ''), w));
      if (custPhone || gstin) {
        lines.push(this.padBetween(
          custPhone ? 'Ph: ' + custPhone : '',
          gstin ? 'GSTIN: ' + gstin : '',
          w
        ));
      }
      if (billData.isInterstate || state) {
        lines.push(cmd.BOLD_ON + this.padBetween(
          billData.isInterstate ? '** INTERSTATE **' : '',
          state ? 'State: ' + state : '',
          w
        ) + cmd.BOLD_OFF);
      }
    } else {
      if (custPhone) {
        lines.push(this.padBetween('Name: ' + custName, 'Ph: ' + custPhone, w));
      } else {
        lines.push('Name: ' + custName);
      }
    }

    // ── 5. ITEM TABLE (full width fixed grid) ───
    lines.push(dash);
    const cN = 24, cQ = 5, cP = 9, cA = 10;
    lines.push(cmd.BOLD_ON +
      'ITEM'.padEnd(cN) +
      this.rAlign('QTY', cQ) +
      this.rAlign('RATE', cP) +
      this.rAlign('AMT', cA) +
      cmd.BOLD_OFF
    );
    lines.push(dash);

    let totalQty = 0;
    for (const item of billData.items || []) {
      const qty = parseInt(item.quantity) || 0;
      totalQty += qty;
      const price = parseFloat(item.unitPrice).toFixed(2);
      const amount = parseFloat(item.totalPrice).toFixed(2);
      const cols =
        this.rAlign(qty.toString(), cQ) +
        this.rAlign(price, cP) +
        this.rAlign(amount, cA);
      let name = item.itemName || '';
      if (item.variantName) name += ' (' + item.variantName + ')';
      if (item.taxRate && item.taxRate >= 18) name += '*';
      if (item.isNC) name += ' [NC]';

      if (name.length <= cN) {
        lines.push(name.padEnd(cN) + cols);
      } else {
        const wrapped = this.wrapText(name, cN);
        for (let i = 0; i < wrapped.length - 1; i++) lines.push(wrapped[i]);
        lines.push((wrapped[wrapped.length - 1] || '').padEnd(cN) + cols);
      }
    }
    lines.push(dash);

    // ── 6. SUMMARY (right-aligned values) ───────
    lines.push(cmd.BOLD_ON + this.padBetween('Total Qty: ' + totalQty, '', w) + cmd.BOLD_OFF);
    lines.push(this.padBetween('Subtotal:', billData.subtotal, w));

    for (const tax of billData.taxes || []) {
      const baseName = (tax.name || 'Tax').replace(/\s*[\d.]+%?/g, '').trim().toUpperCase();
      lines.push(this.padBetween(baseName + ' @' + tax.rate + '%:', tax.amount, w));
    }

    if (billData.serviceCharge) {
      lines.push(this.padBetween('Service Charge:', billData.serviceCharge, w));
    }

    if (billData.discounts && billData.discounts.length > 0) {
      for (const disc of billData.discounts) {
        const discAmt = parseFloat(disc.amount).toFixed(2);
        let label = 'Discount';
        if (disc.type === 'percentage') label += ' (' + disc.value + '%)';
        else if (disc.value > 0) label += ' (Flat ' + (billData.currencySymbol || '₹') + parseFloat(disc.value).toFixed(0) + ')';
        lines.push(this.padBetween(label + ':', '-' + discAmt, w));
      }
    } else if (billData.discount) {
      lines.push(this.padBetween('Discount:', '-' + billData.discount, w));
    }

    if (billData.roundOff && parseFloat(billData.roundOff) !== 0) {
      lines.push(this.padBetween('Round Off:', billData.roundOff, w));
    }

    if (billData.ncAmount && parseFloat(billData.ncAmount) > 0) {
      lines.push(cmd.BOLD_ON + this.padBetween('NO CHARGE (NC):', '-' + parseFloat(billData.ncAmount).toFixed(2), w) + cmd.BOLD_OFF);
    }

    // ── 7. GRAND TOTAL — [MPOS tweak 3] single bold line, no double-HW ──
    const eqDash = '='.repeat(w);
    lines.push(eqDash);
    lines.push(cmd.BOLD_ON + this.padBetween('GRAND TOTAL:', (billData.currencySymbol || '₹') + billData.grandTotal, w) + cmd.BOLD_OFF);
    lines.push(eqDash);

    // ── 8. PAYMENT (full width) ─────────────────
    if (billData.dueAmount && parseFloat(billData.dueAmount) > 0) {
      lines.push(this.padBetween('PAID:', (billData.currencySymbol || '₹') + parseFloat(billData.paidAmount || 0).toFixed(2), w));
      lines.push(this.padBetween('DUE:', (billData.currencySymbol || '₹') + parseFloat(billData.dueAmount).toFixed(2), w));
      lines.push(dash);
    }

    if (billData.paymentMode) {
      if (billData.paymentMode === 'split' && billData.splitBreakdown && billData.splitBreakdown.length > 0) {
        lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + 'SPLIT PAYMENT' + cmd.BOLD_OFF);
        lines.push(cmd.ALIGN_LEFT);
        for (const sp of billData.splitBreakdown) {
          lines.push(this.padBetween(
            (sp.paymentMode || '').toUpperCase(),
            (billData.currencySymbol || '₹') + parseFloat(sp.amount || 0).toFixed(2),
            w
          ));
        }
        lines.push(dash);
      } else {
        lines.push(this.padBetween('Payment:', billData.paymentMode.toUpperCase(), w));
      }
    }

    // ── 9. FOOTER ───────────────────────────────
    lines.push(cmd.ALIGN_CENTER + 'THANK YOU! VISIT AGAIN');

    return lines.join('\n');
  },

  centerText(text, width) {
    const padding = Math.max(0, Math.floor((width - text.length) / 2));
    return ' '.repeat(padding) + text;
  },

  padBetween(left, right, width) {
    const l = left.toString();
    const r = right.toString();
    const pad = Math.max(1, width - l.length - r.length);
    return l + ' '.repeat(pad) + r;
  },

  rAlign(text, width) {
    const s = text.toString();
    return s.length >= width ? s : ' '.repeat(width - s.length) + s;
  },

  wrapText(text, maxWidth) {
    if (text.length <= maxWidth) return [text];
    const words = text.split(' ');
    const result = [];
    let line = '';
    for (const word of words) {
      if (line.length + word.length + (line ? 1 : 0) <= maxWidth) {
        line += (line ? ' ' : '') + word;
      } else {
        if (line) result.push(line);
        line = word.length > maxWidth ? word.substring(0, maxWidth) : word;
      }
    }
    if (line) result.push(line);
    return result.length ? result : [''];
  },

  // ========================
  // ESC/POS COMMANDS
  // ========================

  getEscPosCommands() {
    return {
      INIT: '\x1B\x40',              // Initialize printer
      BOLD_ON: '\x1B\x45\x01',       // Bold on
      BOLD_OFF: '\x1B\x45\x00',      // Bold off
      ALIGN_LEFT: '\x1B\x61\x00',    // Align left
      ALIGN_CENTER: '\x1B\x61\x01', // Align center
      ALIGN_RIGHT: '\x1B\x61\x02',  // Align right
      DOUBLE_HEIGHT: '\x1B\x21\x10', // Double height
      DOUBLE_HW: '\x1B\x21\x30',      // Double height + double width (4x size)
      NORMAL: '\x1B\x21\x00',        // Normal text
      FEED_LINES: '\x1B\x64\x05',    // Feed 5 lines
      CUT: '\x1D\x56\x00',           // Full cut
      PARTIAL_CUT: '\x1D\x56\x01',   // Partial cut
      OPEN_DRAWER: '\x1B\x70\x00\x19\xFA', // Open cash drawer
      BEEP: '\x1B\x42\x03\x02'       // Beep 3 times
    };
  },

  getMobilePosCommands() {
    return {
      ...this.getEscPosCommands(),
      FEED_LINES: '\x1B\x64\x03',    // 3 lines — minimal feed before cut for Mobile POS
      CUT: '\x1D\x56\x42\x00',       // Partial cut with feed — Sunmi honours this
      PARTIAL_CUT: '\x1D\x56\x42\x00',
    };
  },

  wrapWithEscPos(content, options = {}) {
    // mobilePOS option: uses Sunmi-safe commands (minimal feed, correct cut byte)
    const cmd = options.mobilePOS ? this.getMobilePosCommands() : this.getEscPosCommands();
    const parts = [];
    
    parts.push(Buffer.from(cmd.INIT, 'binary'));

    if (options.beep) {
      parts.push(Buffer.from(cmd.BEEP, 'binary'));
    }

    // Add logo if provided (must be ESC/POS bitmap Buffer)
    if (options.logo && Buffer.isBuffer(options.logo)) {
      parts.push(Buffer.from('\x1B\x33\x00', 'binary')); // Zero spacing — logo rows must be contiguous
      parts.push(Buffer.from('\x1B\x61\x01', 'binary')); // Center align for logo
      parts.push(options.logo);
      parts.push(Buffer.from('\x1B\x32', 'binary')); // Reset to default spacing after logo
    }

    // Add text content
    parts.push(Buffer.from(content, 'binary'));
    parts.push(Buffer.from(cmd.FEED_LINES, 'binary'));

    if (options.cut !== false) {
      parts.push(Buffer.from(options.partialCut ? cmd.PARTIAL_CUT : cmd.CUT, 'binary'));
    }

    if (options.openDrawer) {
      parts.push(Buffer.from(cmd.OPEN_DRAWER, 'binary'));
    }

    return Buffer.concat(parts);
  },

  // ========================
  // HIGH-LEVEL PRINT METHODS
  // ========================

  async printKot(kotData, userId) {
    const content = this.formatKotContent(kotData);
    const station = kotData.station || 'kitchen';
    const jobType = station === 'bar' || station === 'main_bar' ? 'bot' : 'kot';

    // ── Mobile POS intercept ────────────────────────────────────────────────
    // Uses mobilePOS:true wrapping — Sunmi-safe cut + minimal feed.
    // Priority: userId room → device room → station room → null (→ normal printers)
    // Works for:
    //   - Staff on Mobile POS (userId online): routes to their device directly
    //   - Self-order auto-KOT (system userId, no socket): falls to station room →
    //     kitchen staff who joined with { station: 'kitchen' } receives the print
    const mposWrapped = this.wrapWithEscPos(content, { beep: true, mobilePOS: true });
    const mposResult = await this.sendToMobilePOS(
      { id: null, name: 'MobilePOS', outlet_id: kotData.outletId, device_id: null, station },
      mposWrapped,
      { jobType, ref: kotData.kotNumber, outletId: kotData.outletId, userId }
    );
    if (mposResult) {
      logger.info(`printKot: intercepted by Mobile POS (${mposResult.mode}) ref=${kotData.kotNumber}`);
      return mposResult;
    }
    // ───────────────────────────────────────────────────────────────────────

    // Regular printers — use standard wrapping (full cut, 5-line feed)
    const wrappedContent = this.wrapWithEscPos(content, { beep: true });

    // Find ALL printers for this station (multi-printer support)
    const printers = await this.getAllPrintersForStation(
      kotData.outletId, station, kotData.stationId || null, kotData.isCounter || false
    );

    if (printers.length === 0) {
      // No printers found — create bridge job without explicit printerId (fallback)
      logger.warn(`printKot: No printers found for station "${station}" (stationId: ${kotData.stationId}), creating bridge job`);
      return this.createPrintJob({
        outletId: kotData.outletId,
        jobType,
        station,
        stationId: kotData.stationId || null,
        isCounter: kotData.isCounter || false,
        kotId: kotData.kotId,
        orderId: kotData.orderId,
        content: wrappedContent,
        contentType: 'escpos',
        referenceNumber: kotData.kotNumber,
        tableNumber: kotData.tableNumber,
        priority: 10,
        createdBy: userId
      });
    }

    // Step 1: Mobile POS printers — emit via Socket.IO directly to device
    // Falls back to bridge if device is offline. Non-blocking per printer.
    const mposPrinters = printers.filter(p => p.connection_type === 'mobile_pos');
    const regularPrinters = printers.filter(p => p.connection_type !== 'mobile_pos');
    const results = [];

    for (const printer of mposPrinters) {
      const mposResult = await this.sendToMobilePOS(printer, wrappedContent, {
        jobType, ref: kotData.kotNumber, outletId: kotData.outletId
      });
      if (mposResult) {
        results.push(mposResult);
        continue;
      }
      // Device offline — fall back to bridge job
      try {
        const bridgeResult = await this.createPrintJob({
          outletId: kotData.outletId, printerId: printer.id, jobType, station,
          stationId: kotData.stationId || null, isCounter: kotData.isCounter || false,
          kotId: kotData.kotId, orderId: kotData.orderId, content: wrappedContent,
          contentType: 'escpos', referenceNumber: kotData.kotNumber,
          tableNumber: kotData.tableNumber, priority: 10, createdBy: userId
        });
        results.push({ ...bridgeResult, printerId: printer.id, method: 'bridge' });
      } catch (err) {
        logger.error(`printKot: MPOS bridge fallback failed for printer ${printer.id} (${printer.name}):`, err.message);
      }
    }

    // Step 2: Try direct TCP in PARALLEL for regular printers with healthy IPs
    // Only when server is on same network as printers (DIRECT_PRINT_ENABLED=true)
    const directResults = new Map(); // printerId → true/false
    const directCandidates = DIRECT_PRINT_ENABLED
      ? regularPrinters.filter(p => p.ip_address && isDirectTcpHealthy(p.ip_address, p.port))
      : [];

    if (directCandidates.length > 0) {
      const directAttempts = directCandidates.map(async (printer) => {
        try {
          await this.printDirect(printer.ip_address, printer.port || 9100, wrappedContent, 2000);
          markDirectTcpOk(printer.ip_address, printer.port);
          logger.info(`KOT ${kotData.kotNumber} printed DIRECT to ${printer.name} (${printer.ip_address}:${printer.port || 9100})`);
          directResults.set(printer.id, true);
        } catch (directErr) {
          markDirectTcpFailed(printer.ip_address, printer.port);
          logger.warn(`KOT ${kotData.kotNumber} direct print failed for ${printer.name} (${printer.ip_address}): ${directErr.message}, falling back to bridge`);
          directResults.set(printer.id, false);
        }
      });
      await Promise.all(directAttempts);
    }

    // Step 3: Create bridge jobs for regular printers that didn't print directly
    for (const printer of regularPrinters) {
      if (directResults.get(printer.id) === true) {
        results.push({ printerId: printer.id, method: 'direct' });
        continue;
      }
      // Bridge fallback
      try {
        const result = await this.createPrintJob({
          outletId: kotData.outletId,
          printerId: printer.id,
          jobType,
          station,
          stationId: kotData.stationId || null,
          isCounter: kotData.isCounter || false,
          kotId: kotData.kotId,
          orderId: kotData.orderId,
          content: wrappedContent,
          contentType: 'escpos',
          referenceNumber: kotData.kotNumber,
          tableNumber: kotData.tableNumber,
          priority: 10,
          createdBy: userId
        });
        results.push({ ...result, printerId: printer.id, method: 'bridge' });
      } catch (err) {
        logger.error(`printKot: Failed to create bridge job for printer ${printer.id} (${printer.name}):`, err.message);
      }
    }

    const mposCount = results.filter(r => r.method === 'mobile_pos').length;
    const directCount = results.filter(r => r.method === 'direct').length;
    const bridgeCount = results.filter(r => r.method === 'bridge').length;
    if (printers.length > 1 || bridgeCount > 0 || mposCount > 0) {
      logger.info(`printKot: ${kotData.kotNumber} → ${results.length} prints (${mposCount} mpos, ${directCount} direct, ${bridgeCount} bridge)`);
    }
    return results[0] || null;
  },

  async printBill(billData, userId, resolvedPrinter = null) {
    // Load logo once — shared by both Mobile POS and regular printers
    let logo = null;
    const logoSource = resolveLogoSource(billData.outletLogoUrl);
    if (logoSource) {
      try {
        logo = await loadOutletLogo(logoSource, { maxWidth: 280, maxHeight: 80 });
      } catch (err) {
        logger.warn('Failed to load logo for bill print:', err.message);
      }
    }

    const printerId = resolvedPrinter?.id || null;
    const station = resolvedPrinter?.station || 'bill';
    logger.info(`[BILL-PRINT] printBill: resolvedPrinter=${resolvedPrinter ? `id=${resolvedPrinter.id} name=${resolvedPrinter.name} type=${resolvedPrinter.connection_type}` : 'NULL'}, printerId=${printerId}, station=${station}`);

    // ── Mobile POS intercept ─────────────────────────────────────────────────
    // Uses Mobile POS-specific formatter (32-char, compact) + mobilePOS:true wrap.
    // Grand Total on one line, no extra Token space, minimal feed then cut.
    const mposContent = this.formatBillContentForMobilePOS(billData);
    const mposWrapped = this.wrapWithEscPos(mposContent, { openDrawer: billData.openDrawer, mobilePOS: true, logo });
    if (userId) {
      const mposResult = await this.sendToMobilePOS(
        { id: printerId, name: 'MobilePOS', outlet_id: billData.outletId, device_id: null, station },
        mposWrapped,
        { jobType: billData.isDuplicate ? 'duplicate_bill' : 'bill', ref: billData.invoiceNumber, outletId: billData.outletId, userId }
      );
      if (mposResult) {
        logger.info(`[BILL-PRINT] Bill ${billData.invoiceNumber || 'N/A'} intercepted by Mobile POS for user ${userId}`);
        return mposResult;
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Regular printers (IP/bridge) — use full 80mm formatter + standard wrapping
    const content = this.formatBillContent(billData);
    const wrappedContent = this.wrapWithEscPos(content, { openDrawer: billData.openDrawer, logo });

    // Mobile POS printer record: emit ESC/POS via Socket.IO — fallback to bridge if offline
    if (resolvedPrinter?.connection_type === 'mobile_pos') {
      const mposResult = await this.sendToMobilePOS(resolvedPrinter, mposWrapped, {
        jobType: billData.isDuplicate ? 'duplicate_bill' : 'bill',
        ref: billData.invoiceNumber,
        outletId: billData.outletId
      });
      if (mposResult) {
        logger.info(`[BILL-PRINT] Bill ${billData.invoiceNumber || 'N/A'} sent to Mobile POS device "${resolvedPrinter.device_id}"`);
        return mposResult;
      }
      logger.warn(`[BILL-PRINT] Mobile POS device offline for bill ${billData.invoiceNumber}, falling back to bridge`);
    }

    // Try direct TCP first if enabled and printer has IP configured and is healthy
    // DIRECT_PRINT_ENABLED must be true (server on same network as printers)
    if (DIRECT_PRINT_ENABLED && resolvedPrinter?.ip_address && isDirectTcpHealthy(resolvedPrinter.ip_address, resolvedPrinter.port)) {
      try {
        await this.printDirect(resolvedPrinter.ip_address, resolvedPrinter.port || 9100, wrappedContent, 2000);
        markDirectTcpOk(resolvedPrinter.ip_address, resolvedPrinter.port);
        logger.info(`[BILL-PRINT] Bill ${billData.invoiceNumber || 'N/A'} printed DIRECT to ${resolvedPrinter.name} (${resolvedPrinter.ip_address}:${resolvedPrinter.port || 9100})`);
        return { method: 'direct', printerId };
      } catch (directErr) {
        markDirectTcpFailed(resolvedPrinter.ip_address, resolvedPrinter.port);
        logger.warn(`[BILL-PRINT] Direct print failed for ${billData.invoiceNumber || 'N/A'}: ${directErr.message}, falling back to bridge`);
      }
    }

    // Fallback: create bridge job
    return this.createPrintJob({
      outletId: billData.outletId,
      jobType: billData.isDuplicate ? 'duplicate_bill' : 'bill',
      station,
      printerId,
      orderId: billData.orderId,
      invoiceId: billData.invoiceId,
      content: wrappedContent,
      contentType: 'escpos',
      referenceNumber: billData.invoiceNumber,
      tableNumber: billData.tableNumber,
      priority: 5,
      createdBy: userId
    });
  },

  async openCashDrawer(outletId, userId) {
    const cmd = this.getEscPosCommands();
    
    return this.createPrintJob({
      outletId,
      jobType: 'cash_drawer',
      station: 'cashier',
      content: cmd.INIT + cmd.OPEN_DRAWER,
      contentType: 'escpos',
      referenceNumber: 'DRAWER',
      priority: 15, // Highest priority
      createdBy: userId
    });
  },

  async printTestPage(outletId, station, userId) {
    const content = [
      '================================',
      '        PRINTER TEST PAGE',
      '================================',
      '',
      `Station: ${station}`,
      `Time: ${new Date().toLocaleString()}`,
      '',
      'If you can read this,',
      'the printer is working correctly!',
      '',
      '================================'
    ].join('\n');

    return this.createPrintJob({
      outletId,
      jobType: 'test',
      station,
      content: this.wrapWithEscPos(content),
      contentType: 'escpos',
      referenceNumber: 'TEST',
      createdBy: userId
    });
  },

  // ========================
  // STATS & MONITORING
  // ========================

  // ========================
  // DIRECT NETWORK PRINTING
  // ========================

  /**
   * Send data directly to a network printer via TCP
   * @param {string} ipAddress - Printer IP address
   * @param {number} port - Printer port (default 9100)
   * @param {string|Buffer} data - ESC/POS data to print
   * @param {number} timeout - Connection timeout in ms (default 5000)
   */
  async printDirect(ipAddress, port = 9100, data, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      let connected = false;

      const timeoutId = setTimeout(() => {
        if (!connected) {
          client.destroy();
          reject(new Error(`Connection timeout to printer ${ipAddress}:${port}`));
        }
      }, timeout);

      client.connect(port, ipAddress, () => {
        connected = true;
        clearTimeout(timeoutId);
        logger.info(`Connected to printer ${ipAddress}:${port}`);
        
        client.write(data, (err) => {
          if (err) {
            client.destroy();
            reject(err);
          } else {
            // Give printer time to process before closing
            setTimeout(() => {
              client.end();
              resolve({ success: true, message: 'Print job sent successfully' });
            }, 100);
          }
        });
      });

      client.on('error', (err) => {
        clearTimeout(timeoutId);
        logger.error(`Printer error ${ipAddress}:${port}:`, err.message);
        reject(new Error(`Printer connection failed: ${err.message}`));
      });

      client.on('close', () => {
        logger.info(`Disconnected from printer ${ipAddress}:${port}`);
      });
    });
  },

  // ========================
  // MOBILE POS PRINTING
  // ========================

  /**
   * Returns true if the given user has an active Mobile POS socket connected.
   * Used by printKot/printBill to intercept prints before normal printer routing.
   * No printer record needed — just a live socket from the user's device.
   */
  async isUserOnMobilePOS(outletId, userId) {
    if (!userId || !outletId) return false;
    const io = getSocketIO();
    if (!io) return false;
    const room = `mpos:${outletId}:user:${userId}`;
    const sockets = await io.in(room).allSockets();
    return sockets.size > 0;
  },

  /**
   * Routing priority (highest → lowest):
   *  1. User room   mpos:{outletId}:user:{userId}    — cashier's specific device
   *                 Use for bills: routes to the cashier who created it
   *                 Handles 5-10 devices on same outlet with no duplicates
   *
   *  2. Device room mpos:{outletId}:device:{deviceId} — explicit targeting
   *                 Use when you must target one specific device by ID
   *
   *  3. Station room mpos:{outletId}:station:{station} — station broadcast
   *                 Picks FIRST socket only to prevent duplicate prints
   *                 Use for KOT to kitchen, test prints, no-user context
   *
   *  4. Bridge fallback — if no socket found in any room above
   */
  async sendToMobilePOS(printer, escpos, { jobType = 'print', ref = '', outletId, station, userId } = {}) {
    const io = getSocketIO();
    const effectiveOutletId = outletId || printer.outlet_id;

    if (!io) {
      logger.warn(`MPOS[${printer.name}]: Socket.IO not ready — bridge fallback`);
      return null;
    }

    const jobId = uuidv4();
    const escposBase64 = Buffer.isBuffer(escpos)
      ? escpos.toString('base64')
      : Buffer.from(escpos, 'binary').toString('base64');

    const payload = {
      jobId, jobType,
      referenceNumber: ref,
      printerId: printer.id,
      printerName: printer.name,
      escpos: escposBase64,   // Flutter: base64Decode → Uint8List → printEscposData()
      shouldCut: true,        // Flutter must call cutPaper() after printEscposData (Sunmi ignores embedded cut)
      timestamp: Date.now(),
    };

    // Build room names up front
    const userRoom = userId ? `mpos:${effectiveOutletId}:user:${userId}` : null;
    const deviceRoom = printer.device_id ? `mpos:${effectiveOutletId}:device:${printer.device_id}` : null;
    const stationKey = (station || printer.station || 'cashier').toLowerCase().trim();
    const stationRoom = `mpos:${effectiveOutletId}:station:${stationKey}`;

    // ── Check all rooms in parallel (single Redis round-trip instead of 3 sequential) ──
    const [userSockets, deviceSockets, stationSockets] = await Promise.all([
      userRoom   ? io.in(userRoom).allSockets()   : Promise.resolve(new Set()),
      deviceRoom ? io.in(deviceRoom).allSockets() : Promise.resolve(new Set()),
      io.in(stationRoom).allSockets(),
    ]);

    // ── Priority 1: User room (cashier-specific) ────────────────────────────
    if (userSockets.size > 0) {
      io.to(userRoom).emit('mpos:print', payload);
      logger.info(`MPOS[${printer.name}]: job → user room ${userRoom} (userId=${userId}) ref=${ref}`);
      return { method: 'mobile_pos', sent: true, jobId, printerId: printer.id, mode: 'user', room: userRoom };
    }
    if (userId) logger.warn(`MPOS[${printer.name}]: user ${userId} offline — trying device/station`);

    // ── Priority 2: Device room (explicit) ─────────────────────────────────
    if (deviceSockets.size > 0) {
      io.to(deviceRoom).emit('mpos:print', payload);
      logger.info(`MPOS[${printer.name}]: job → device room ${deviceRoom} ref=${ref}`);
      return { method: 'mobile_pos', sent: true, jobId, printerId: printer.id, mode: 'device', room: deviceRoom };
    }

    // ── Priority 3: Station room (broadcast, first socket only) ────────────
    if (stationSockets.size === 0) {
      logger.warn(`MPOS[${printer.name}]: no device in any room — bridge fallback`);
      return null;
    }

    if (stationSockets.size > 1) {
      // Multiple devices on station — pick first only to prevent duplicate prints
      const [firstSocketId] = stationSockets;
      io.to(firstSocketId).emit('mpos:print', payload);
      logger.info(`MPOS[${printer.name}]: job → first socket on station ${stationRoom} (${stationSockets.size} devices) ref=${ref}`);
    } else {
      io.to(stationRoom).emit('mpos:print', payload);
      logger.info(`MPOS[${printer.name}]: job → station room ${stationRoom} ref=${ref}`);
    }

    return { method: 'mobile_pos', sent: true, jobId, printerId: printer.id, mode: 'station', room: stationRoom };
  },

  /**
   * Print KOT directly to network printer
   */
  async printKotDirect(kotData, printerIp, printerPort = 9100) {
    const content = this.formatKotContent(kotData);
    const escposData = this.wrapWithEscPos(content, { beep: true });
    
    try {
      // Use shorter timeout (2s) for faster response - print usually completes in <1s
      const result = await this.printDirect(printerIp, printerPort, escposData, 2000);
      logger.info(`KOT ${kotData.kotNumber} printed directly to ${printerIp}:${printerPort}`);
      return result;
    } catch (error) {
      logger.error(`Direct KOT print failed for ${kotData.kotNumber}:`, error.message);
      throw error;
    }
  },

  /**
   * Print Bill directly to network printer
   */
  async printBillDirect(billData, printerIp, printerPort = 9100) {
    const content = this.formatBillContent(billData);
    
    // Load logo if outlet has logo_url
    let logo = null;
    const logoSource = resolveLogoSource(billData.outletLogoUrl);
    if (logoSource) {
      try {
        logo = await loadOutletLogo(logoSource, { maxWidth: 280, maxHeight: 80 });
      } catch (err) {
        logger.warn('Failed to load logo for direct bill print:', err.message);
      }
    }
    
    const escposData = this.wrapWithEscPos(content, { openDrawer: billData.openDrawer, logo });
    
    try {
      // Use shorter timeout (2s) for faster response - print usually completes in <1s
      const result = await this.printDirect(printerIp, printerPort, escposData, 2000);
      logger.info(`Bill ${billData.invoiceNumber} printed directly to ${printerIp}:${printerPort}`);
      return result;
    } catch (error) {
      logger.error(`Direct Bill print failed for ${billData.invoiceNumber}:`, error.message);
      throw error;
    }
  },

  /**
   * Test printer connectivity
   */
  async testPrinterConnection(ipAddress, port = 9100) {
    return new Promise((resolve) => {
      const client = new net.Socket();
      const timeout = setTimeout(() => {
        client.destroy();
        resolve({ success: false, message: 'Connection timeout' });
      }, 3000);

      client.connect(port, ipAddress, () => {
        clearTimeout(timeout);
        client.end();
        resolve({ success: true, message: 'Printer is reachable' });
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ success: false, message: err.message });
      });
    });
  },

  /**
   * Check live status of all printers for an outlet
   * @param {number} outletId - Outlet ID
   * @param {string|string[]|null} stationFilter - Optional station filter
   * @returns {Array} - Printer status array with connectivity info
   */
  async getPrintersForStatus(outletId, stationFilter = null) {
    const pool = getPool();

    let query = `SELECT p.id, p.name, p.station, p.printer_type, p.station_id, 
                        p.ip_address, p.port, p.is_active, p.is_online, p.last_seen_at,
                        ks.name as station_name, ks.code as station_code, ks.station_type
                 FROM printers p
                 LEFT JOIN kitchen_stations ks ON p.station_id = ks.id
                 WHERE p.outlet_id = ?`;
    const params = [outletId];

    if (Array.isArray(stationFilter) && stationFilter.length > 0) {
      query += ` AND p.station IN (${stationFilter.map(() => '?').join(',')})`;
      params.push(...stationFilter);
    } else if (typeof stationFilter === 'string' && stationFilter.trim()) {
      query += ` AND p.station = ?`;
      params.push(stationFilter.trim());
    }

    query += ` ORDER BY p.station, p.name`;
    const [printers] = await pool.query(query, params);
    return printers;
  },

  async checkPrinterStatusDirect(outletId, stationFilter = null) {
    const printers = await this.getPrintersForStatus(outletId, stationFilter);

    // Check connectivity for each printer in parallel
    const statusChecks = printers.map(async (printer) => {
      let isOnline = false;
      let latency = null;
      let error = null;
      
      if (printer.ip_address) {
        const startTime = Date.now();
        try {
          const result = await this.testPrinterConnection(printer.ip_address, printer.port || 9100);
          isOnline = result.success;
          latency = Date.now() - startTime;
          if (!result.success) {
            error = result.message;
          }
        } catch (err) {
          error = err.message;
        }
      } else {
        error = 'No IP address configured';
      }

      await this.updatePrinterStatus(printer.id, isOnline);

      return {
        id: printer.id,
        name: printer.name,
        station: printer.station,
        printerType: printer.printer_type,
        stationId: printer.station_id,
        assignedStation: printer.station_id ? {
          id: printer.station_id,
          name: printer.station_name,
          code: printer.station_code,
          type: printer.station_type
        } : null,
        ipAddress: printer.ip_address,
        port: printer.port || 9100,
        isActive: printer.is_active === 1,
        source: 'direct',
        isOnline,
        latency: latency ? `${latency}ms` : null,
        error
      };
    });

    return Promise.all(statusChecks);
  },

  async checkPrinterStatusFromBridge(outletId, stationFilter = null) {
    const printers = await this.getPrintersForStatus(outletId, stationFilter);
    const nowMs = Date.now();

    return printers.map((printer) => {
      const lastSeenMs = parseDbDateToUtcMs(printer.last_seen_at);
      const statusAgeSeconds = lastSeenMs ? Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000)) : null;
      const stale = !lastSeenMs || statusAgeSeconds > BRIDGE_STATUS_STALE_SECONDS;
      const isOnline = !stale && Boolean(printer.is_online);

      return {
        id: printer.id,
        name: printer.name,
        station: printer.station,
        printerType: printer.printer_type,
        stationId: printer.station_id,
        assignedStation: printer.station_id ? {
          id: printer.station_id,
          name: printer.station_name,
          code: printer.station_code,
          type: printer.station_type
        } : null,
        ipAddress: printer.ip_address,
        port: printer.port || 9100,
        isActive: printer.is_active === 1,
        source: 'bridge',
        isOnline,
        latency: null,
        lastSeenAt: lastSeenMs ? new Date(lastSeenMs).toISOString() : null,
        statusAgeSeconds,
        error: stale
          ? (statusAgeSeconds === null
              ? 'No bridge status reported yet'
              : `Stale bridge status (${statusAgeSeconds}s old)`)
          : null
      };
    });
  },

  /**
   * Check printer status by source:
   * - direct: backend does TCP checks
   * - bridge: uses status reported by bridge agent
   * - auto: bridge when active, else direct
   */
  async checkPrinterStatus(outletId, stationFilter = null, source = 'auto') {
    const normalizedSource = typeof source === 'string' ? source.toLowerCase().trim() : 'auto';

    if (normalizedSource === 'direct') {
      return this.checkPrinterStatusDirect(outletId, stationFilter);
    }

    if (normalizedSource === 'bridge') {
      return this.checkPrinterStatusFromBridge(outletId, stationFilter);
    }

    const shouldUseBridge = await this.hasRecentlyOnlineBridge(outletId);
    return shouldUseBridge
      ? this.checkPrinterStatusFromBridge(outletId, stationFilter)
      : this.checkPrinterStatusDirect(outletId, stationFilter);
  },

  /**
   * Check live status for a specific station type
   * @param {number} outletId - Outlet ID
   * @param {string} stationType - captain | cashier | kitchen | bar | bill
   * @param {string} source - auto | bridge | direct
   * @returns {Object} - Station printer status
   */
  async checkStationPrinterStatus(outletId, stationType, source = 'auto') {
    // Map station type to actual station values
    const stationMap = {
      'captain': ['kot_kitchen', 'kot_bar'],
      'cashier': ['bill', 'report'],
      'kitchen': ['kot_kitchen'],
      'bar': ['kot_bar'],
      'bill': ['bill'],
      'all': null
    };

    const stations = stationMap[stationType] || [stationType];
    const results = await this.checkPrinterStatus(outletId, stations, source);

    if (results.length === 0) {
      return {
        stationType,
        source,
        hasConfiguredPrinter: false,
        printers: [],
        summary: { total: 0, online: 0, offline: 0 }
      };
    }

    const onlineCount = results.filter(p => p.isOnline).length;

    return {
      stationType,
      source: results[0]?.source || source,
      hasConfiguredPrinter: true,
      allOnline: onlineCount === results.length,
      anyOnline: onlineCount > 0,
      printers: results,
      summary: {
        total: results.length,
        online: onlineCount,
        offline: results.length - onlineCount
      }
    };
  },

  async getJobStats(outletId, date = null) {
    const pool = getPool();
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const [stats] = await pool.query(
      `SELECT 
         station,
         job_type,
         status,
         COUNT(*) as count
       FROM print_jobs
       WHERE outlet_id = ? AND DATE(created_at) = ?
       GROUP BY station, job_type, status`,
      [outletId, targetDate]
    );

    const [pendingCount] = await pool.query(
      `SELECT COUNT(*) as count FROM print_jobs 
       WHERE outlet_id = ? AND status = 'pending'`,
      [outletId]
    );

    return {
      date: targetDate,
      pending: pendingCount[0].count,
      breakdown: stats
    };
  }
};

module.exports = printerService;
module.exports.printJobNotifier = printJobNotifier;
