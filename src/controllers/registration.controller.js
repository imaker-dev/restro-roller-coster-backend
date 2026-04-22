const { getPool } = require('../database');
const logger = require('../utils/logger');

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
      plan_interest = 'free',
      message,
    } = req.body;

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

    // Plan validation
    if (!['free', 'pro'].includes(plan_interest)) {
      return res.status(400).json({
        success: false,
        message: 'plan_interest must be "free" or "pro"',
      });
    }

    const pool = getPool();
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;

    // Sanitize + length limits
    const cleanEmail = email.trim().toLowerCase().substring(0, 255);
    const cleanName  = restaurant_name.trim().substring(0, 255);
    const cleanPerson = contact_person.trim().substring(0, 255);
    const cleanPhone = phone.trim().substring(0, 20);
    const cleanCity  = city?.trim()?.substring(0, 100) || null;
    const cleanState = state?.trim()?.substring(0, 100) || null;
    const cleanMsg   = message?.trim()?.substring(0, 2000) || null;

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
        (restaurant_name, contact_person, email, phone, city, state, plan_interest, message, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cleanName, cleanPerson, cleanEmail, cleanPhone, cleanCity, cleanState, plan_interest, cleanMsg, ip]
    );

    logger.info(`[Registration] New request #${result.insertId} — ${cleanName} (${cleanEmail}) — plan: ${plan_interest}`);

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
    if (plan && ['free', 'pro'].includes(plan)) {
      where += ' AND plan_interest = ?';
      params.push(plan);
    }

    const pool = getPool();

    // Run count + data in parallel for faster response
    const [countResult, [rows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM restaurant_registrations WHERE ${where}`, params),
      pool.query(
      `SELECT id, restaurant_name, contact_person, email, phone,
              city, state, plan_interest, message, status, admin_notes,
              ip_address, created_at, updated_at
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

    const [rows] = await pool.execute(
      'SELECT id, restaurant_name, email FROM restaurant_registrations WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Registration request not found.' });
    }

    await pool.execute(
      'UPDATE restaurant_registrations SET status = ?, admin_notes = ? WHERE id = ?',
      [status, admin_notes?.trim()?.substring(0, 2000) || null, id]
    );

    logger.info(`[Registration] Request #${id} (${rows[0].email}) marked as ${status} by user #${req.user?.userId}`);

    return res.json({
      success: true,
      message: `Registration request ${status}.`,
      data: { id: parseInt(id), status },
    });

  } catch (err) {
    logger.error('[Registration] updateRegistrationStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update status.' });
  }
};

/**
 * GET /api/v1/registration/stats
 * Admin — summary counts per status and plan.
 */
const getRegistrationStats = async (req, res) => {
  try {
    const pool = getPool();

    const [rows] = await pool.query(`
      SELECT
        SUM(status = 'pending')  AS pending,
        SUM(status = 'approved') AS approved,
        SUM(status = 'rejected') AS rejected,
        SUM(plan_interest = 'free') AS free_plan,
        SUM(plan_interest = 'pro')  AS pro_plan,
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
