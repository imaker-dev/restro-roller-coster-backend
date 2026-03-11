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
const { loadOutletLogo } = require('../utils/escpos-image');

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
          connection_type, paper_width, characters_per_line,
          supports_cash_drawer, supports_cutter, supports_logo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid, outletId, data.name, code, printerType,
          stationValue, stationId,
          ipAddress, data.port || 9100, connectionType,
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

    // Priority 4: For bill station, find any bill printer
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

    // NO FALLBACK - Server-side app requires proper configuration
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

  async updatePrinter(id, data) {
    const pool = getPool();
    const updates = [];
    const params = [];

    const fields = ['name', 'code', 'printer_type', 'station', 'station_id',
                    'ip_address', 'port', 'connection_type', 'paper_width',
                    'characters_per_line', 'supports_cash_drawer', 'supports_cutter',
                    'supports_logo', 'is_active'];
    
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
      // Update last seen
      await pool.query(
        `UPDATE printer_bridges SET is_online = 1, last_poll_at = NOW() WHERE id = ?`,
        [bridges[0].id]
      );
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
      // Update last seen
      await pool.query(
        `UPDATE printer_bridges SET is_online = 1, last_poll_at = NOW() WHERE id = ?`,
        [bridges[0].id]
      );
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

      if (printerId && printerById.has(printerId)) {
        matchedPrinter = printerById.get(printerId);
      }

      if (!matchedPrinter && ipAddress) {
        const ipMatches = printers.filter((printer) => {
          if (!printer.ip_address || printer.ip_address !== ipAddress) return false;
          if (!Number.isInteger(port)) return true;
          return (printer.port || 9100) === port;
        });
        if (ipMatches.length === 1) {
          matchedPrinter = ipMatches[0];
        }
      }

      if (!matchedPrinter && station) {
        const stationMatches = printers.filter((printer) => printer.station === station);
        if (stationMatches.length === 1) {
          matchedPrinter = stationMatches[0];
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
      // Also include kitchen_station.station_type mappings for dynamic station names
      [rows] = await pool.query(
        `SELECT p.station, p.ip_address, p.port, ks.station_type as ks_station_type
         FROM printers p
         LEFT JOIN kitchen_stations ks ON ks.printer_id = p.id AND ks.is_active = 1
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
        `SELECT station, ip_address, port
         FROM printers
         WHERE outlet_id = ?
           AND is_active = 1
           AND station IN (${placeholders})
         ORDER BY station ASC, id ASC`,
        [outletId, ...uniqueStations]
      );
    }

    const printers = {};
    for (const row of rows) {
      const printerConfig = {
        ip: row.ip_address,
        port: row.port || 9100
      };
      
      // Add by printer.station (e.g., 'kot_kitchen', 'bill')
      const station = typeof row.station === 'string' ? row.station.trim() : '';
      if (station && !printers[station]) {
        printers[station] = printerConfig;
      }
      
      // Also add by kitchen_station.station_type for dynamic matching (e.g., 'tandoor', 'main_kitchen')
      const ksStationType = row.ks_station_type ? String(row.ks_station_type).trim() : '';
      if (ksStationType && !printers[ksStationType]) {
        printers[ksStationType] = printerConfig;
      }
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
    const isBarOrder = station === 'bar' || station === 'main_bar';
    const orderType = isBarOrder ? 'BOT' : 'KOT';
    const stationLabelMap = {
      kitchen: 'KITCHEN',
      main_kitchen: 'MAIN KITCHEN',
      tandoor: 'TANDOOR',
      wok: 'WOK',
      grill: 'GRILL',
      dessert: 'DESSERT',
      bar: 'BAR',
      main_bar: 'BAR',
      mocktail: 'MOCKTAIL'
    };
    const stationLabel = stationLabelMap[station] || (station ? station.replace(/_/g, ' ').toUpperCase() : 'KITCHEN');
    const title = `${stationLabel} ORDER (${orderType})`;
    lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + title);
    lines.push(cmd.BOLD_OFF + cmd.ALIGN_LEFT + 'KOT#: ' + kotData.kotNumber);
    lines.push(this.padBetween('Table: ' + (kotData.tableNumber || 'Takeaway'), kotData.time || '', w));
    lines.push(dash);

    for (const item of kotData.items || []) {
      const tag = item.itemType ? ` [${item.itemType.toUpperCase()}]` : '';
      lines.push(`${item.quantity} x ${item.itemName || ''}${tag}`);
      if (item.variantName) lines.push(`  (${item.variantName})`);
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

    lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + '*** CANCEL ***');
    lines.push(cmd.BOLD_OFF + cmd.ALIGN_LEFT + 'Order#: ' + (cancelData.orderNumber || 'N/A'));
    lines.push(this.padBetween(
      'Table: ' + (cancelData.tableNumber || 'Takeaway'),
      cancelData.kotNumber ? 'KOT#: ' + cancelData.kotNumber : '', w
    ));
    lines.push('Time: ' + (cancelData.time || ''));
    lines.push(dash);

    for (const item of cancelData.items || []) {
      const tag = item.itemType ? ` [${item.itemType.toUpperCase()}]` : '';
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
    // Use station name as-is (dynamic - matches kitchen_stations.station_type)
    const station = cancelData.station || 'kitchen';

    return this.createPrintJob({
      outletId: cancelData.outletId,
      jobType: 'cancel_slip',
      station,
      orderId: cancelData.orderId,
      content: this.wrapWithEscPos(content, { beep: true }),
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
    const w = 42;
    const dash = '-'.repeat(w);
    const cmd = this.getEscPosCommands();

    // Duplicate header (centered)
    if (billData.isDuplicate) {
      lines.push(cmd.ALIGN_CENTER + 'Duplicate');
      if (billData.duplicateNumber) {
        lines.push('Copy #' + billData.duplicateNumber);
      }
    }

    // Restaurant name (bold + double height, centered)
    lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + cmd.DOUBLE_HEIGHT + (billData.outletName || 'Restaurant'));

    // Address, phone, gstin (centered, normal size)
    const infoLines = [];
    if (billData.outletAddress) infoLines.push('Add.' + billData.outletAddress);
    if (billData.outletPhone) infoLines.push('Mob.' + billData.outletPhone);
    if (billData.outletGstin) infoLines.push('GSTIN: ' + billData.outletGstin);
    if (infoLines.length > 0) {
      lines.push(cmd.NORMAL + cmd.BOLD_OFF + infoLines[0]);
      for (let i = 1; i < infoLines.length; i++) lines.push(infoLines[i]);
    } else {
      lines.push(cmd.NORMAL + cmd.BOLD_OFF);
    }

    // Switch to left alignment
    lines.push(cmd.ALIGN_LEFT + dash);

    // Date/time + order type/table (order label bold)
    const orderLabel = billData.orderType === 'dine_in'
      ? 'Dine In: ' + (billData.tableNumber || '')
      : (billData.orderType === 'takeaway' ? 'Takeaway' : (billData.orderType || 'Takeaway'));
    const datePart = 'Date: ' + (billData.date || '');
    const dateSpace = Math.max(1, w - datePart.length - orderLabel.length);
    lines.push(datePart + ' '.repeat(dateSpace) + cmd.BOLD_ON + orderLabel + cmd.BOLD_OFF);
    lines.push(billData.time || '');

    // Cashier + bill number
    const cashier = 'Cashier: ' + (billData.cashierName || 'Staff');
    const billNo = 'Bill No.: ' + (billData.invoiceNumber || '');
    if (cashier.length + billNo.length + 1 <= w) {
      lines.push(this.padBetween(cashier, billNo, w));
    } else {
      lines.push(cashier);
      lines.push(billNo);
    }
    lines.push(dash);

    // Customer details section
    const custName = billData.customerName || 'Walk-in Customer';
    lines.push('Customer: ' + custName);
    if (billData.customerPhone) {
      lines.push('Phone: ' + billData.customerPhone);
    }
    // GST details for B2B customers
    if (billData.customerGstin) {
      if (billData.customerCompanyName) {
        lines.push('Company: ' + billData.customerCompanyName);
      }
      lines.push('GSTIN: ' + billData.customerGstin);
      if (billData.customerGstState) {
        lines.push('State: ' + billData.customerGstState + (billData.customerGstStateCode ? ' (' + billData.customerGstStateCode + ')' : ''));
      }
      if (billData.isInterstate) {
        lines.push(cmd.BOLD_ON + '** INTERSTATE SUPPLY **' + cmd.BOLD_OFF);
      }
    }
    lines.push(dash);

    // Item column header: Item | Qty | Price | Amount
    const cQ = 4, cP = 8, cA = 9;
    const cN = w - cQ - cP - cA;
    lines.push(
      'Item'.padEnd(cN) +
      this.rAlign('Qty.', cQ) +
      this.rAlign('Price', cP) +
      this.rAlign('Amount', cA)
    );
    lines.push(dash);

    // Items (preserve original case)
    let totalQty = 0;
    for (const item of billData.items || []) {
      const qty = parseInt(item.quantity) || 0;
      totalQty += qty;
      const cols =
        this.rAlign(qty.toString(), cQ) +
        this.rAlign(parseFloat(item.unitPrice).toFixed(2), cP) +
        this.rAlign(parseFloat(item.totalPrice).toFixed(2), cA);
      const name = item.itemName || '';

      if (name.length <= cN) {
        lines.push(name.padEnd(cN) + cols);
      } else {
        const wrapped = this.wrapText(name, cN);
        for (let i = 0; i < wrapped.length - 1; i++) lines.push(wrapped[i]);
        const last = wrapped[wrapped.length - 1] || '';
        lines.push(last.padEnd(cN) + cols);
      }
    }
    lines.push(dash);

    // Total qty + subtotal
    lines.push(this.padBetween('Total Qty: ' + totalQty, 'Sub ' + billData.subtotal, w));

    // Taxes (UPPERCASE base name, strip embedded rate)
    for (const tax of billData.taxes || []) {
      const baseName = (tax.name || 'Tax').replace(/\s*[\d.]+%?/g, '').trim().toUpperCase();
      const label = baseName + '@' + tax.rate + '%';
      lines.push(this.padBetween(label, tax.amount, w));
    }

    // Service charge
    if (billData.serviceCharge) {
      lines.push(this.padBetween('Service Charge:', billData.serviceCharge, w));
    }

    // Discount
    if (billData.discount) {
      lines.push(this.padBetween('Discount:', '-' + billData.discount, w));
    }

    lines.push(dash);

    // Round off
    if (billData.roundOff && parseFloat(billData.roundOff) !== 0) {
      lines.push(this.padBetween('Round Off', billData.roundOff, w));
      lines.push(dash);
    }

    // Grand total (bold + double height, centered)
    // Use "Rs." instead of Unicode ₹ (\u20B9) for thermal printer compatibility
    lines.push(cmd.ALIGN_CENTER + cmd.BOLD_ON + cmd.DOUBLE_HEIGHT + 'Grand Total Rs.' + billData.grandTotal);
    lines.push(cmd.NORMAL + cmd.BOLD_OFF + cmd.ALIGN_LEFT + dash);

    // Payment mode
    if (billData.paymentMode) {
      if (billData.paymentMode === 'split' && billData.splitBreakdown && billData.splitBreakdown.length > 0) {
        lines.push(cmd.ALIGN_CENTER + 'Paid: SPLIT PAYMENT');
        lines.push(cmd.ALIGN_LEFT + dash);
        for (const sp of billData.splitBreakdown) {
          const modeName = (sp.paymentMode || 'Unknown').toUpperCase();
          const amount = parseFloat(sp.amount || 0).toFixed(2);
          lines.push(this.padBetween('  ' + modeName + ':', 'Rs.' + amount, w));
        }
        lines.push(dash);
      } else {
        lines.push(cmd.ALIGN_CENTER + 'Paid: ' + billData.paymentMode.toUpperCase());
      }
    }

    // Footer
    lines.push(cmd.ALIGN_CENTER + 'THANKS VISIT AGAIN');

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
      NORMAL: '\x1B\x21\x00',        // Normal text
      FEED_LINES: '\x1B\x64\x05',    // Feed 5 lines
      CUT: '\x1D\x56\x00',           // Full cut
      PARTIAL_CUT: '\x1D\x56\x01',   // Partial cut
      OPEN_DRAWER: '\x1B\x70\x00\x19\xFA', // Open cash drawer
      BEEP: '\x1B\x42\x03\x02'       // Beep 3 times
    };
  },

  wrapWithEscPos(content, options = {}) {
    const cmd = this.getEscPosCommands();
    const parts = [];
    
    parts.push(Buffer.from(cmd.INIT, 'binary'));

    if (options.beep) {
      parts.push(Buffer.from(cmd.BEEP, 'binary'));
    }

    // Add logo if provided (must be ESC/POS bitmap Buffer)
    if (options.logo && Buffer.isBuffer(options.logo)) {
      parts.push(options.logo);
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
    // Use station name as-is from KOT (dynamic - matches kitchen_stations.station_type)
    const station = kotData.station || 'kitchen';

    return this.createPrintJob({
      outletId: kotData.outletId,
      jobType: station === 'bar' || station === 'main_bar' ? 'bot' : 'kot',
      station,
      stationId: kotData.stationId || null,
      isCounter: kotData.isCounter || false,
      kotId: kotData.kotId,
      orderId: kotData.orderId,
      content: this.wrapWithEscPos(content, { beep: true }),
      contentType: 'escpos',
      referenceNumber: kotData.kotNumber,
      tableNumber: kotData.tableNumber,
      priority: 10, // KOTs are high priority
      createdBy: userId
    });
  },

  async printBill(billData, userId) {
    const content = this.formatBillContent(billData);
    
    // Load logo if outlet has logo_url
    let logo = null;
    const logoSource = resolveLogoSource(billData.outletLogoUrl);
    if (logoSource) {
      try {
        logo = await loadOutletLogo(logoSource, { maxWidth: 280, maxHeight: 80 });
      } catch (err) {
        logger.warn('Failed to load logo for bill print:', err.message);
      }
    }

    return this.createPrintJob({
      outletId: billData.outletId,
      jobType: billData.isDuplicate ? 'duplicate_bill' : 'bill',
      station: 'bill',
      orderId: billData.orderId,
      invoiceId: billData.invoiceId,
      content: this.wrapWithEscPos(content, { openDrawer: billData.openDrawer, logo }),
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

  /**
   * Print KOT directly to network printer
   */
  async printKotDirect(kotData, printerIp, printerPort = 9100) {
    const content = this.formatKotContent(kotData);
    const escposData = this.wrapWithEscPos(content, { beep: true });
    
    try {
      const result = await this.printDirect(printerIp, printerPort, escposData);
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
      const result = await this.printDirect(printerIp, printerPort, escposData);
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
                 WHERE p.outlet_id = ? AND p.is_active = 1`;
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
