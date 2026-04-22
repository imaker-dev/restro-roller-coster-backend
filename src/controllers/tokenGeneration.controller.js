const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../database');
const logger = require('../utils/logger');

// ─── Private key loader (only on the live server) ────────────────────────────
let PRIVATE_KEY = null;

const loadPrivateKey = () => {
  if (PRIVATE_KEY) return PRIVATE_KEY;

  const keyPaths = [
    path.join(__dirname, '..', '..', 'free-version', 'license', 'private.key'),
    path.join(process.cwd(), 'free-version', 'license', 'private.key'),
    path.join(process.cwd(), 'license', 'private.key'),
    path.join(process.cwd(), 'private.key'),
  ];

  for (const p of keyPaths) {
    if (fs.existsSync(p)) {
      PRIVATE_KEY = fs.readFileSync(p, 'utf8');
      logger.info(`[TokenGen] Private key loaded from ${p}`);
      return PRIVATE_KEY;
    }
  }

  throw new Error('Private key not found. Token generation unavailable.');
};

// ─── Helper: sign a payload ──────────────────────────────────────────────────
const signPayload = (payload) => {
  const privateKey = loadPrivateKey();
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadStr).toString('base64url');

  const sign = crypto.createSign('SHA256');
  sign.update(payloadStr);
  sign.end();
  const signature = sign.sign(privateKey, 'base64url');

  return `${payloadB64}.${signature}`;
};

/**
 * POST /api/v1/token-generation/activation
 * Admin — generate an activation token for a restaurant.
 *
 * Body: { email, password, restaurant, phone?, maxOutlets?, plan? }
 */
const generateActivationToken = async (req, res) => {
  try {
    const { email, password, restaurant, phone, maxOutlets = 1, plan = 'free' } = req.body;

    // Validate required fields
    if (!email?.trim() || !password?.trim() || !restaurant?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: email, password, restaurant',
      });
    }

    if (password.trim().length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
      });
    }

    if (!['free', 'pro'].includes(plan)) {
      return res.status(400).json({
        success: false,
        message: 'plan must be "free" or "pro"',
      });
    }

    const licenseId = crypto.randomUUID();
    const payload = {
      v: 1,
      lid: licenseId,
      plan,
      restaurant: restaurant.trim(),
      email: email.trim().toLowerCase(),
      password: password.trim(),
      phone: phone?.trim() || null,
      maxOutlets: parseInt(maxOutlets) || 1,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    };

    const token = signPayload(payload);

    // Log the generation (do NOT store token itself — only metadata)
    const pool = getPool();
    await pool.query(
      `INSERT INTO token_generation_log
        (license_id, token_type, plan, restaurant_name, email, generated_by_user_id, token_hash)
       VALUES (?, 'activation', ?, ?, ?, ?, ?)`,
      [
        licenseId,
        plan,
        restaurant.trim(),
        email.trim().toLowerCase(),
        req.user?.userId || null,
        crypto.createHash('sha256').update(token).digest('hex'),
      ]
    );

    logger.info(`[TokenGen] Activation token generated: lid=${licenseId} restaurant=${restaurant} by user #${req.user?.userId}`);

    return res.json({
      success: true,
      message: 'Activation token generated successfully',
      data: {
        licenseId,
        token,
        plan,
        restaurant: restaurant.trim(),
        adminEmail: email.trim().toLowerCase(),
        adminPassword: password.trim(),
        maxOutlets: payload.maxOutlets,
      },
    });

  } catch (err) {
    logger.error('[TokenGen] generateActivationToken error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate token: ' + err.message });
  }
};

/**
 * POST /api/v1/token-generation/upgrade
 * Admin — generate a Pro upgrade token for an existing Free restaurant.
 *
 * Body: { licenseId, restaurant?, maxOutlets? }
 */
const generateUpgradeToken = async (req, res) => {
  try {
    const { licenseId, restaurant = '', maxOutlets = 3 } = req.body;

    if (!licenseId?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: licenseId (the current Free license UUID)',
      });
    }

    const newLicenseId = crypto.randomUUID();
    const payload = {
      v: 1,
      lid: newLicenseId,
      plan: 'pro',
      restaurant: restaurant.trim(),
      upgradeOf: licenseId.trim(),
      modules: {
        captain: true,
        inventory: true,
        advancedReports: true,
      },
      maxOutlets: parseInt(maxOutlets) || 3,
      maxUsers: -1,
      createdAt: new Date().toISOString(),
      expiresAt: null,
    };

    const token = signPayload(payload);

    const pool = getPool();
    await pool.query(
      `INSERT INTO token_generation_log
        (license_id, token_type, plan, restaurant_name, email, generated_by_user_id, token_hash, upgrade_from_license_id)
       VALUES (?, 'upgrade', 'pro', ?, NULL, ?, ?, ?)`,
      [
        newLicenseId,
        restaurant.trim(),
        req.user?.userId || null,
        crypto.createHash('sha256').update(token).digest('hex'),
        licenseId.trim(),
      ]
    );

    logger.info(`[TokenGen] Upgrade token generated: newLid=${newLicenseId} upgradeOf=${licenseId} by user #${req.user?.userId}`);

    return res.json({
      success: true,
      message: 'Pro upgrade token generated successfully',
      data: {
        newLicenseId,
        token,
        upgradesFrom: licenseId.trim(),
        plan: 'pro',
        restaurant: restaurant.trim(),
        modules: payload.modules,
        maxOutlets: payload.maxOutlets,
        maxUsers: 'Unlimited',
      },
    });

  } catch (err) {
    logger.error('[TokenGen] generateUpgradeToken error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate token: ' + err.message });
  }
};

/**
 * GET /api/v1/token-generation/log
 * Admin — list all generated tokens (metadata only, never the raw token).
 * Query: ?type=activation|upgrade&page=1&limit=20
 */
const getTokenLog = async (req, res) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
    const pageSize = Math.min(100, parseInt(limit));

    let where = '1=1';
    const params = [];

    if (type && ['activation', 'upgrade'].includes(type)) {
      where += ' AND token_type = ?';
      params.push(type);
    }

    const pool = getPool();

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM token_generation_log WHERE ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT id, license_id, token_type, plan, restaurant_name, email,
              generated_by_user_id, upgrade_from_license_id, created_at
       FROM token_generation_log
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return res.json({
      success: true,
      data: {
        tokens: rows,
        pagination: { total, page: parseInt(page), limit: pageSize, pages: Math.ceil(total / pageSize) },
      },
    });

  } catch (err) {
    logger.error('[TokenGen] getTokenLog error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch token log.' });
  }
};

module.exports = {
  generateActivationToken,
  generateUpgradeToken,
  getTokenLog,
};
