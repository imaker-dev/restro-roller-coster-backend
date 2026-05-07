const { getPool } = require('../database');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Ensure restaurant_registrations table exists.
 * Migration 061 may not have run on fresh installs or older databases.
 */
const _ensureRegistrationTable = async (pool) => {
  // Step 1: Try to create (idempotent — no-op if table already exists cleanly)
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS restaurant_registrations (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        restaurant_name VARCHAR(255) NOT NULL,
        contact_person  VARCHAR(255) NOT NULL,
        email           VARCHAR(255) NOT NULL,
        phone           VARCHAR(20)  NOT NULL,
        city            VARCHAR(100) DEFAULT NULL,
        state           VARCHAR(100) DEFAULT NULL,
        plan_interest   ENUM('free', 'pro', 'offline_annual') NOT NULL DEFAULT 'free',
        message         TEXT         DEFAULT NULL,
        status          ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        admin_notes     TEXT         DEFAULT NULL,
        gst_number      VARCHAR(20)  DEFAULT NULL,
        fssai_number    VARCHAR(20)  DEFAULT NULL,
        pan_number      VARCHAR(15)  DEFAULT NULL,
        ip_address      VARCHAR(45)  DEFAULT NULL,
        outlet_id       BIGINT UNSIGNED NULL,
        offline_token   TEXT NULL,
        token_generated_at DATETIME NULL,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status      (status),
        INDEX idx_email       (email),
        INDEX idx_created_at  (created_at),
        INDEX idx_outlet_id   (outlet_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (createErr) {
    // If CREATE itself failed with 1932, drop and recreate immediately
    const isOrphanedCreate = createErr.errno === 1932 ||
                             /doesn't exist in engine/i.test(createErr.message);
    if (isOrphanedCreate) {
      logger.warn('[Registration] CREATE failed with orphaned table reference. Dropping and recreating...');
      try {
        await pool.execute('DROP TABLE IF EXISTS restaurant_registrations');
        await pool.execute(`
          CREATE TABLE restaurant_registrations (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            restaurant_name VARCHAR(255) NOT NULL,
            contact_person  VARCHAR(255) NOT NULL,
            email           VARCHAR(255) NOT NULL,
            phone           VARCHAR(20)  NOT NULL,
            city            VARCHAR(100) DEFAULT NULL,
            state           VARCHAR(100) DEFAULT NULL,
            plan_interest   ENUM('free', 'pro', 'offline_annual') NOT NULL DEFAULT 'free',
            message         TEXT         DEFAULT NULL,
            status          ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
            admin_notes     TEXT         DEFAULT NULL,
            gst_number      VARCHAR(20)  DEFAULT NULL,
            fssai_number    VARCHAR(20)  DEFAULT NULL,
            pan_number      VARCHAR(15)  DEFAULT NULL,
            ip_address      VARCHAR(45)  DEFAULT NULL,
            outlet_id       BIGINT UNSIGNED NULL,
            offline_token   TEXT NULL,
            token_generated_at DATETIME NULL,
            created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status      (status),
            INDEX idx_email       (email),
            INDEX idx_created_at  (created_at),
            INDEX idx_outlet_id   (outlet_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        logger.info('[Registration] Recreated restaurant_registrations table after orphaned CREATE.');
        return;
      } catch (recreateErr) {
        logger.error('[Registration] Failed to recreate after orphaned CREATE:', recreateErr.message);
        return;
      }
    }
    // Non-1932 CREATE error — log and continue (table may already exist normally)
    logger.warn('[Registration] CREATE TABLE warning:', createErr.message);
  }

  // Step 1b: Ensure all columns exist (for tables created before migration 063)
  try {
    await pool.execute(`ALTER TABLE restaurant_registrations ADD COLUMN IF NOT EXISTS gst_number VARCHAR(20) DEFAULT NULL`);
    await pool.execute(`ALTER TABLE restaurant_registrations ADD COLUMN IF NOT EXISTS fssai_number VARCHAR(20) DEFAULT NULL`);
    await pool.execute(`ALTER TABLE restaurant_registrations ADD COLUMN IF NOT EXISTS pan_number VARCHAR(15) DEFAULT NULL`);
  } catch (alterErr) {
    // MariaDB < 10.219 may not support IF NOT EXISTS in ALTER — ignore
    logger.warn('[Registration] ALTER TABLE warning:', alterErr.message);
  }

  // Step 2: Verify the table is actually usable in InnoDB
  // (CREATE IF NOT EXISTS returns success even with an orphaned .frm file)
  try {
    await pool.execute('SELECT 1 FROM restaurant_registrations LIMIT 0');
    // Table is healthy — nothing more to do
    return;
  } catch (verifyErr) {
    const isOrphaned = verifyErr.errno === 1932 ||
                       /doesn't exist in engine/i.test(verifyErr.message) ||
                       /exists in engine.*not in data dictionary/i.test(verifyErr.message);
    if (!isOrphaned) {
      // Some other error — log but don't block
      logger.warn('[Registration] Table verification warning:', verifyErr.message);
      return;
    }
  }

  // Step 3: Orphaned .frm detected — DROP + CREATE
  logger.warn('[Registration] Detected orphaned table reference for restaurant_registrations. Dropping and recreating...');
  try {
    await pool.execute('DROP TABLE IF EXISTS restaurant_registrations');
    await pool.execute(`
      CREATE TABLE restaurant_registrations (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        restaurant_name VARCHAR(255) NOT NULL,
        contact_person  VARCHAR(255) NOT NULL,
        email           VARCHAR(255) NOT NULL,
        phone           VARCHAR(20)  NOT NULL,
        city            VARCHAR(100) DEFAULT NULL,
        state           VARCHAR(100) DEFAULT NULL,
        plan_interest   ENUM('free', 'pro', 'offline_annual') NOT NULL DEFAULT 'free',
        message         TEXT         DEFAULT NULL,
        status          ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        admin_notes     TEXT         DEFAULT NULL,
        gst_number      VARCHAR(20)  DEFAULT NULL,
        fssai_number    VARCHAR(20)  DEFAULT NULL,
        pan_number      VARCHAR(15)  DEFAULT NULL,
        ip_address      VARCHAR(45)  DEFAULT NULL,
        outlet_id       BIGINT UNSIGNED NULL,
        offline_token   TEXT NULL,
        token_generated_at DATETIME NULL,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status      (status),
        INDEX idx_email       (email),
        INDEX idx_created_at  (created_at),
        INDEX idx_outlet_id   (outlet_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // Final verification
    await pool.execute('SELECT 1 FROM restaurant_registrations LIMIT 0');
    logger.info('[Registration] Recreated restaurant_registrations table successfully.');
  } catch (recreateErr) {
    logger.error('[Registration] Failed to recreate restaurant_registrations table:', recreateErr.message);
  }
};

/**
 * POST /api/v1/registration/register
 * Public — no auth required.
 * Restaurant submits a registration request from the Flutter app.
 */
const submitRegistration = async (req, res) => {
  try {
    const {
      restaurant_name,
      contact_person,
      email,
      phone,
      city,
      state,
      plan_interest,
      message,
      gst_number,
      fssai_number,
      pan_number,
    } = req.body;

    // Normalize plan_interest (empty/null defaults to 'free')
    const normalizedPlan = (plan_interest || 'free').trim().toLowerCase();

    // Basic required field validation
    const missing = [];
    if (!restaurant_name?.trim()) missing.push('restaurant_name');
    if (!contact_person?.trim())  missing.push('contact_person');
    if (!email?.trim())           missing.push('email');
    if (!phone?.trim())           missing.push('phone');

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(', ')}`,
      });
    }

    // Email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email address',
      });
    }

    // Plan validation (offline_annual for offline POS, free/pro for production)
    if (!['free', 'pro', 'offline_annual'].includes(normalizedPlan)) {
      return res.status(400).json({
        success: false,
        message: 'plan_interest must be "free", "pro", or "offline_annual"',
      });
    }

    const pool = getPool();
    await _ensureRegistrationTable(pool);

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;

    // Sanitize + length limits
    const cleanEmail = email.trim().toLowerCase().substring(0, 255);
    const cleanName  = restaurant_name.trim().substring(0, 255);
    const cleanPerson = contact_person.trim().substring(0, 255);
    const cleanPhone = phone.trim().substring(0, 20);
    const cleanCity    = city?.trim()?.substring(0, 100) || null;
    const cleanState   = state?.trim()?.substring(0, 100) || null;
    const cleanMsg     = message?.trim()?.substring(0, 2000) || null;
    const cleanGst     = gst_number?.trim()?.toUpperCase().substring(0, 20) || null;
    const cleanFssai   = fssai_number?.trim()?.substring(0, 20) || null;
    const cleanPan     = pan_number?.trim()?.toUpperCase().substring(0, 15) || null;

    // Prevent duplicate pending requests from the same email (uses idx_email index)
    const [existing] = await pool.execute(
      `SELECT id FROM restaurant_registrations
       WHERE email = ? AND status = 'pending' LIMIT 1`,
      [cleanEmail]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'A registration request with this email is already pending. We will contact you soon.',
      });
    }

    const [result] = await pool.execute(
      `INSERT INTO restaurant_registrations
        (restaurant_name, contact_person, email, phone, city, state, plan_interest, message,
         gst_number, fssai_number, pan_number, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cleanName, cleanPerson, cleanEmail, cleanPhone, cleanCity, cleanState, normalizedPlan, cleanMsg,
       cleanGst, cleanFssai, cleanPan, ip]
    );

    logger.info(`[Registration] New request #${result.insertId} — ${cleanName} (${cleanEmail}) — plan: ${normalizedPlan}`);

    return res.status(201).json({
      success: true,
      message: 'Registration request submitted successfully. We will contact you within 24 hours.',
      data: { id: result.insertId },
    });

  } catch (err) {
    logger.error('[Registration] submitRegistration error:', err);
    return res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
};

/**
 * GET /api/v1/registration/requests
 * Admin — requires auth.
 * List all registration requests with optional filters.
 * Query: ?status=pending|approved|rejected&plan=free|pro&page=1&limit=20
 */
const listRegistrations = async (req, res) => {
  try {
    const { status, plan, page = 1, limit = 20 } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
    const pageSize = Math.min(100, parseInt(limit));

    let where = '1=1';
    const params = [];

    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      where += ' AND status = ?';
      params.push(status);
    }
    if (plan && ['free', 'pro', 'offline_annual'].includes(plan)) {
      where += ' AND plan_interest = ?';
      params.push(plan);
    }

    const pool = getPool();
    await _ensureRegistrationTable(pool);

    // Run count + data in parallel for faster response
    const [countResult, [rows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM restaurant_registrations WHERE ${where}`, params),
      pool.query(
      `SELECT id, restaurant_name, contact_person, email, phone,
              city, state, plan_interest, message,
              gst_number, fssai_number, pan_number,
              status, outlet_id, admin_notes, ip_address, created_at, updated_at
       FROM restaurant_registrations
       WHERE ${where}
       ORDER BY
         CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
         created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]),
    ]);
    const total = countResult[0][0].total;

    return res.json({
      success: true,
      data: {
        registrations: rows,
        pagination: {
          total,
          page: parseInt(page),
          limit: pageSize,
          pages: Math.ceil(total / pageSize),
        },
      },
    });

  } catch (err) {
    logger.error('[Registration] listRegistrations error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch registrations.' });
  }
};

/**
 * PATCH /api/v1/registration/:id/status
 * Admin — requires auth.
 * Update status and optionally add admin notes.
 * For offline_annual registrations, approving auto-creates the outlet + subscription.
 *
 * Body: { status: 'approved'|'rejected', admin_notes: '...' }
 */
const updateRegistrationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_notes } = req.body;

    if (!status || !['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'status must be "approved", "rejected", or "pending"',
      });
    }

    const pool = getPool();
    await _ensureRegistrationTable(pool);

    // Fetch full registration details
    const [rows] = await pool.execute(
      `SELECT id, restaurant_name, contact_person, email, phone, city, state,
              plan_interest, message, gst_number, fssai_number, pan_number,
              outlet_id, status as current_status
       FROM restaurant_registrations WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Registration request not found.' });
    }

    const reg = rows[0];
    let createdOutletId = null;

    // Normalize stored plan_interest (handle empty strings from old records)
    const storedPlan = (reg.plan_interest || 'free').trim().toLowerCase();

    // ─── Auto-create outlet for offline_annual on approval ────────────────────
    if (status === 'approved' && storedPlan === 'offline_annual' && !reg.outlet_id) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // 1. Generate outlet code
        const codePrefix = reg.restaurant_name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase() || 'RESTRO';
        const code = `${codePrefix}-${Date.now().toString(36).toUpperCase().slice(-4)}`;

        // 2. Create outlet
        const [outletResult] = await conn.execute(
          `INSERT INTO outlets (
            uuid, code, name, legal_name, outlet_type,
            address_line1, address_line2, city, state, country, postal_code,
            phone, email, gstin, fssai_number, pan_number,
            opening_time, closing_time, is_24_hours,
            currency_code, timezone, settings,
            is_active, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            uuidv4(), code, reg.restaurant_name, null, 'restaurant',
            null, null, reg.city || null, reg.state || null, 'India', null,
            reg.phone || null, reg.email || null, reg.gst_number || null, reg.fssai_number || null,
            reg.pan_number || null,
            '10:00:00', '23:00:00', false,
            'INR', 'Asia/Kolkata', '{}',
            true, req.user?.userId || 1,
          ]
        );
        createdOutletId = outletResult.insertId;

        // 3. Create 1-year subscription (active)
        const subStart = new Date();
        const subEnd = new Date();
        subEnd.setFullYear(subEnd.getFullYear() + 1);
        const graceEnd = new Date(subEnd);
        graceEnd.setDate(graceEnd.getDate() + 7);

        await conn.execute(
          `INSERT INTO outlet_subscriptions (
            outlet_id, status, subscription_start, subscription_end, grace_period_end,
            auto_renew, notes, created_at
          ) VALUES (?, 'active', ?, ?, ?, FALSE, 'Auto-created on offline POS registration approval.', NOW())`,
          [
            createdOutletId,
            subStart.toISOString().split('T')[0],
            subEnd.toISOString().split('T')[0],
            graceEnd.toISOString().split('T')[0],
          ]
        );

        // 4. Link registration to outlet
        await conn.execute(
          'UPDATE restaurant_registrations SET outlet_id = ? WHERE id = ?',
          [createdOutletId, id]
        );

        await conn.commit();

        logger.info(
          `[Registration] Auto-created outlet ${createdOutletId} (code: ${code}) ` +
          `for offline_annual registration #${id} — ${reg.restaurant_name} by user #${req.user?.userId}`
        );
      } catch (txErr) {
        await conn.rollback();
        throw txErr;
      } finally {
        conn.release();
      }
    }

    // ─── Update registration status ──────────────────────────────────────────
    await pool.execute(
      'UPDATE restaurant_registrations SET status = ?, admin_notes = ? WHERE id = ?',
      [status, admin_notes?.trim()?.substring(0, 2000) || null, id]
    );

    logger.info(`[Registration] Request #${id} (${reg.email}) marked as ${status} by user #${req.user?.userId}`);

    return res.json({
      success: true,
      message: `Registration request ${status}.`,
      data: {
        id: parseInt(id),
        status,
        outletId: createdOutletId,
        autoCreated: !!createdOutletId,
      },
    });

  } catch (err) {
    logger.error('[Registration] updateRegistrationStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update status: ' + err.message });
  }
};

/**
 * GET /api/v1/registration/stats
 * Admin — summary counts per status and plan.
 */
const getRegistrationStats = async (req, res) => {
  try {
    const pool = getPool();
    await _ensureRegistrationTable(pool);

    const [rows] = await pool.query(`
      SELECT
        SUM(status = 'pending')  AS pending,
        SUM(status = 'approved') AS approved,
        SUM(status = 'rejected') AS rejected,
        SUM(plan_interest = 'free') AS free_plan,
        SUM(plan_interest = 'pro')  AS pro_plan,
        SUM(plan_interest = 'offline_annual') AS offline_annual_plan,
        COUNT(*) AS total
      FROM restaurant_registrations
    `);

    return res.json({ success: true, data: rows[0] });

  } catch (err) {
    logger.error('[Registration] getRegistrationStats error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
};

module.exports = {
  submitRegistration,
  listRegistrations,
  updateRegistrationStatus,
  getRegistrationStats,
};
