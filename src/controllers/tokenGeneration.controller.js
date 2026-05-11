const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../database');
const logger = require('../utils/logger');
const whatsappService = require('../services/whatsapp.service');
const emailService = require('../services/email.service');
const { SUBSCRIPTION_STATUS } = require('../constants');
const { getSubscriptionStatus } = require('../services/subscription.service');

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

// ─── Helper: ensure token_generation_log table exists ────────────────────────
const _ensureTokenLogTable = async (pool) => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS token_generation_log (
        id                 INT AUTO_INCREMENT PRIMARY KEY,
        license_id         VARCHAR(36)  NOT NULL,
        token_type         ENUM('upgrade', 'offline_activation') NOT NULL DEFAULT 'upgrade',
        plan               ENUM('free', 'pro', 'offline_annual')  NOT NULL DEFAULT 'pro',
        restaurant_name    VARCHAR(255) NOT NULL,
        email              VARCHAR(255) NOT NULL,
        outlet_id          BIGINT UNSIGNED NULL,
        subscription_expiry DATE DEFAULT NULL,
        device_hash        VARCHAR(64)  NULL,
        generated_by_user_id INT DEFAULT NULL,
        token_hash         VARCHAR(64)  NOT NULL,
        used_at            DATETIME DEFAULT NULL,
        created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_license  (license_id),
        INDEX idx_email    (email),
        INDEX idx_created  (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (createErr) {
    const isOrphaned = createErr.errno === 1932 || /doesn't exist in engine/i.test(createErr.message);
    if (isOrphaned) {
      logger.warn('[TokenGen] Detected orphaned token_generation_log. Dropping and recreating...');
      try {
        await pool.execute('DROP TABLE IF EXISTS token_generation_log');
        await pool.execute(`
          CREATE TABLE token_generation_log (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            license_id         VARCHAR(36)  NOT NULL,
            token_type         ENUM('upgrade', 'offline_activation') NOT NULL DEFAULT 'upgrade',
            plan               ENUM('free', 'pro', 'offline_annual')  NOT NULL DEFAULT 'pro',
            restaurant_name    VARCHAR(255) NOT NULL,
            email              VARCHAR(255) NOT NULL,
            phone              VARCHAR(30)  NULL,
            outlet_id          BIGINT UNSIGNED NULL,
            subscription_expiry DATE DEFAULT NULL,
            device_hash        VARCHAR(64)  NULL,
            generated_by_user_id INT DEFAULT NULL,
            token_hash         VARCHAR(64)  NOT NULL,
            used_at            DATETIME DEFAULT NULL,
            created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_license  (license_id),
            INDEX idx_email    (email),
            INDEX idx_created  (created_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        logger.info('[TokenGen] Recreated token_generation_log successfully.');
      } catch (recreateErr) {
        logger.error('[TokenGen] Failed to recreate token_generation_log:', recreateErr.message);
      }
    } else {
      logger.warn('[TokenGen] CREATE TABLE warning:', createErr.message);
    }
  }

  // Verify table is usable
  try {
    await pool.execute('SELECT 1 FROM token_generation_log LIMIT 0');
  } catch (verifyErr) {
    const isOrphaned = verifyErr.errno === 1932 || /doesn't exist in engine/i.test(verifyErr.message);
    if (isOrphaned) {
      try {
        await pool.execute('DROP TABLE IF EXISTS token_generation_log');
        await pool.execute(`
          CREATE TABLE token_generation_log (
            id                 INT AUTO_INCREMENT PRIMARY KEY,
            license_id         VARCHAR(36)  NOT NULL,
            token_type         ENUM('upgrade', 'offline_activation') NOT NULL DEFAULT 'upgrade',
            plan               ENUM('free', 'pro', 'offline_annual')  NOT NULL DEFAULT 'pro',
            restaurant_name    VARCHAR(255) NOT NULL,
            email              VARCHAR(255) NOT NULL,
            phone              VARCHAR(30)  NULL,
            outlet_id          BIGINT UNSIGNED NULL,
            subscription_expiry DATE DEFAULT NULL,
            device_hash        VARCHAR(64)  NULL,
            generated_by_user_id INT DEFAULT NULL,
            token_hash         VARCHAR(64)  NOT NULL,
            used_at            DATETIME DEFAULT NULL,
            created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_license  (license_id),
            INDEX idx_email    (email),
            INDEX idx_created  (created_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        logger.info('[TokenGen] Recreated token_generation_log after verification failure.');
      } catch (recreateErr) {
        logger.error('[TokenGen] Failed to recreate token_generation_log after verification:', recreateErr.message);
      }
    }
  }
};

// ─── Helper: derive public key from private key ──────────────────────────────
const getPublicKey = () => {
  const privateKey = loadPrivateKey();
  return crypto.createPublicKey(privateKey).export({ type: 'pkcs1', format: 'pem' });
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

// ─── Helper: send token notifications — awaited, returns real status ─────────
const _runNotification = async (label, fn) => {
  try {
    await fn();
    logger.info(`[TokenGen] ${label} sent ✓`);
    return { ok: true };
  } catch (err) {
    logger.warn(`[TokenGen] ${label} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
};

const notifyActivation = async (phone, email, data) => {
  const msg =
    `🎉 Welcome to RestroPOS!\n\n` +
    `Restaurant: ${data.restaurant}\n` +
    `Plan: ${data.plan === 'pro' ? '🚀 Pro' : '🆓 Free'}\n` +
    `License ID: ${data.licenseId}\n\n` +
    `🔑 Activation Token:\n${data.token}\n\n` +
    `📋 Login Details:\n` +
    `• Email: ${data.adminEmail}\n` +
    `• Password: ${data.adminPassword}\n\n` +
    `Paste the token in the RestroPOS activation screen.\n` +
    `⚠️ Keep this token confidential.`;

  const [waResult, emResult] = await Promise.all([
    phone
      ? _runNotification(`WhatsApp activation → ${phone}`, () => whatsappService.sendText(phone, msg))
      : Promise.resolve({ ok: null, error: 'no phone provided' }),
    email
      ? _runNotification(`Email activation → ${email}`, () => emailService.sendActivationTokenEmail(email, data))
      : Promise.resolve({ ok: null, error: 'no email provided' }),
  ]);

  return { whatsapp: waResult, email: emResult };
};

const notifyOfflineActivation = async (phone, email, data) => {
  const msg =
    `🎉 Your RestroPOS Offline Activation Token is Ready!\n\n` +
    `Restaurant: ${data.restaurant}\n` +
    `Plan: 🚀 Pro (Offline Annual)\n` +
    `License ID: ${data.licenseId}\n` +
    `Subscription Expiry: ${data.subscriptionExpiry || '—'}\n` +
    `Grace Period End: ${data.gracePeriodEnd || '—'}\n\n` +
    `🔑 Offline Activation Token:\n${data.token}\n\n` +
    `📋 Login Details:\n` +
    `• Email: ${data.adminEmail}\n` +
    `• Password: ${data.adminPassword}\n\n` +
    `Paste this token in the RestroPOS activation screen on your offline device.\n` +
    `⚠️ Keep this token confidential. Do not share it.`;

  const [waResult, emResult] = await Promise.all([
    phone
      ? _runNotification(`WhatsApp offline activation → ${phone}`, () => whatsappService.sendText(phone, msg))
      : Promise.resolve({ ok: null, error: 'no phone provided' }),
    email
      ? _runNotification(`Email offline activation → ${email}`, () => emailService.sendActivationTokenEmail(email, data))
      : Promise.resolve({ ok: null, error: 'no email provided' }),
  ]);

  return { whatsapp: waResult, email: emResult };
};

const notifyUpgrade = async (phone, email, data) => {
  const msg =
    `🚀 Your RestroPOS Pro Upgrade Token is Ready!\n\n` +
    `Restaurant: ${data.restaurant || '—'}\n` +
    `New License ID: ${data.newLicenseId}\n` +
    `Upgraded From: ${data.upgradesFrom}\n\n` +
    `🔑 Upgrade Token:\n${data.token}\n\n` +
    `Apply this token in Settings → License → Upgrade to Pro.\n` +
    `⚠️ Keep this token confidential.`;

  const [waResult, emResult] = await Promise.all([
    phone
      ? _runNotification(`WhatsApp upgrade → ${phone}`, () => whatsappService.sendText(phone, msg))
      : Promise.resolve({ ok: null, error: 'no phone provided' }),
    email
      ? _runNotification(`Email upgrade → ${email}`, () => emailService.sendUpgradeTokenEmail(email, data))
      : Promise.resolve({ ok: null, error: 'no email provided' }),
  ]);

  return { whatsapp: waResult, email: emResult };
};

const _notifStatus = (r) => r.ok === true ? 'sent' : r.ok === false ? `failed: ${r.error}` : `skipped: ${r.error}`;

/**
 * POST /api/v1/token-generation/activation
 * Admin — generate an activation token for a restaurant.
 *
 * Body: { email, password, restaurant, phone?, maxOutlets?, plan? }
 *       notify_whatsapp: true|false (default true if phone provided)
 *       notify_email: true|false (default true if email provided)
 */
const generateActivationToken = async (req, res) => {
  try {
    const { email, password, restaurant, phone, maxOutlets = 1, plan = 'free',
          notify_whatsapp = true, notify_email = true } = req.body;

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

    const notifData = {
      restaurant: restaurant.trim(), licenseId, token, plan,
      adminEmail: email.trim().toLowerCase(), adminPassword: password.trim(),
      maxOutlets: payload.maxOutlets,
    };
    const notifResult = await notifyActivation(
      notify_whatsapp !== false && phone?.trim() ? phone.trim() : null,
      notify_email !== false ? email.trim().toLowerCase() : null,
      notifData
    );

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
        notifications: {
          whatsapp: _notifStatus(notifResult.whatsapp),
          email: _notifStatus(notifResult.email),
        },
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
 * Body: { licenseId, restaurant?, email?, phone?, maxOutlets? }
 *        notify_whatsapp: true|false (default true if phone provided)
 *        notify_email: true|false (default true if email provided)
 */
const generateUpgradeToken = async (req, res) => {
  try {
    const { licenseId, restaurant: bodyRestaurant = '', email: bodyEmail, phone: bodyPhone,
            maxOutlets = 3, notify_whatsapp = true, notify_email = true } = req.body;

    if (!licenseId?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: licenseId (the current Free license UUID)',
      });
    }

    // Auto-lookup restaurant, email, phone from the original activation record
    const pool = getPool();
    const [logRows] = await pool.query(
      `SELECT restaurant_name, email, phone FROM token_generation_log
       WHERE license_id = ? AND token_type = 'activation'
       ORDER BY created_at DESC LIMIT 1`,
      [licenseId.trim()]
    );

    const dbRecord = logRows[0] || {};
    const restaurant = bodyRestaurant?.trim() || dbRecord.restaurant_name || '';
    const email = bodyEmail?.trim().toLowerCase() || dbRecord.email || null;
    const phone = bodyPhone?.trim() || dbRecord.phone || null;

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

    await pool.query(
      `INSERT INTO token_generation_log
        (license_id, token_type, plan, restaurant_name, email, phone, generated_by_user_id, token_hash, upgrade_from_license_id)
       VALUES (?, 'upgrade', 'pro', ?, ?, ?, ?, ?, ?)`,
      [
        newLicenseId,
        restaurant,
        email,
        phone,
        req.user?.userId || null,
        crypto.createHash('sha256').update(token).digest('hex'),
        licenseId.trim(),
      ]
    );

    logger.info(`[TokenGen] Upgrade token generated: newLid=${newLicenseId} upgradeOf=${licenseId} by user #${req.user?.userId}`);

    const upgradeNotifData = {
      restaurant: restaurant.trim(),
      newLicenseId,
      token,
      upgradesFrom: licenseId.trim(),
    };
    const upgradeNotifResult = await notifyUpgrade(
      notify_whatsapp !== false && phone?.trim() ? phone.trim() : null,
      notify_email !== false && email?.trim() ? email.trim().toLowerCase() : null,
      upgradeNotifData
    );

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
        notifications: {
          whatsapp: _notifStatus(upgradeNotifResult.whatsapp),
          email: _notifStatus(upgradeNotifResult.email),
        },
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

    if (type && ['activation', 'upgrade', 'offline_activation'].includes(type)) {
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
              generated_by_user_id, created_at
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

/**
 * Internal helper — generate a Pro upgrade token programmatically (no admin auth).
 * Called by the upgrade payment controller after Razorpay payment is verified.
 */
const internalGenerateUpgradeToken = async ({ licenseId, restaurant = '', email = null, phone = null, maxOutlets = 3 }) => {
  const newLicenseId = crypto.randomUUID();
  const payload = {
    v: 1,
    lid: newLicenseId,
    plan: 'pro',
    restaurant: restaurant || '',
    upgradeOf: licenseId,
    modules: { captain: true, inventory: true, advancedReports: true },
    maxOutlets: parseInt(maxOutlets) || 3,
    maxUsers: -1,
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };

  const token = signPayload(payload);

  const pool = getPool();
  await _ensureTokenLogTable(pool);
  await pool.query(
    `INSERT INTO token_generation_log
      (license_id, token_type, plan, restaurant_name, email, generated_by_user_id, token_hash, upgrade_from_license_id)
     VALUES (?, 'upgrade', 'pro', ?, ?, NULL, ?, ?)`,
    [newLicenseId, restaurant || '', email || null,
     crypto.createHash('sha256').update(token).digest('hex'), licenseId]
  );

  logger.info(`[TokenGen] Internal upgrade token: newLid=${newLicenseId} upgradeOf=${licenseId}`);
  return { token, newLicenseId };
};

/**
 * POST /api/v1/token-generation/offline-activation
 * Admin/Master — generate an offline annual-subscription activation token
 * for a specific outlet. The token is signed with the production private key
 * and includes subscription expiry + grace period from outlet_subscriptions.
 *
 * The offline POS validates this token locally (signature + expiry) and
 * blocks usage when the subscription expires.
 *
 * Body: { outletId, password, deviceHash?, restaurant?, email?, phone?, maxOutlets?,
 *          notify_whatsapp?: true|false, notify_email?: true|false }
 */
const generateOfflineActivationToken = async (req, res) => {
  try {
    const {
      outletId,
      password,
      deviceHash,
      restaurant: bodyRestaurant,
      email: bodyEmail,
      phone: bodyPhone,
      maxOutlets = -1,
      notify_whatsapp = true,
      notify_email = true,
    } = req.body;

    if (!outletId || isNaN(parseInt(outletId, 10))) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid required field: outletId (numeric)',
      });
    }

    if (!password?.trim() || password.trim().length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid field: password (minimum 6 characters)',
      });
    }

    const parsedOutletId = parseInt(outletId, 10);
    const pool = getPool();

    // ─── 1. Verify outlet exists and fetch details (single PK lookup) ─────────
    const [[outlet]] = await pool.query(
      `SELECT id, name, email, phone FROM outlets WHERE id = ?`,
      [parsedOutletId]
    );

    if (!outlet) {
      return res.status(404).json({
        success: false,
        message: 'Outlet not found',
      });
    }

    // ─── 2. Check subscription status (Redis-first, 5-min TTL) ────────────────
    const subStatus = await getSubscriptionStatus(parsedOutletId);

    const isMaster = req.user?.roles?.includes('master');
    const allowedStatuses = [
      SUBSCRIPTION_STATUS.TRIAL,
      SUBSCRIPTION_STATUS.ACTIVE,
      SUBSCRIPTION_STATUS.GRACE_PERIOD,
    ];

    if (!allowedStatuses.includes(subStatus.status) && !isMaster) {
      return res.status(403).json({
        success: false,
        code: 'SUBSCRIPTION_NOT_ACTIVE',
        message: `Cannot generate offline token: subscription status is '${subStatus.status}'. Please renew or activate the subscription first.`,
        status: subStatus.status,
        graceDaysRemaining: subStatus.graceDaysRemaining,
        subscriptionEnd: subStatus.subscriptionEnd,
      });
    }

    if (isMaster && !allowedStatuses.includes(subStatus.status)) {
      logger.warn(
        `[TokenGen] MASTER OVERRIDE: generating offline token for outlet ${parsedOutletId} ` +
        `despite subscription status '${subStatus.status}' by user #${req.user?.userId}`
      );
    }

    // ─── 3. Fetch subscription dates directly from DB ─────────────────────────
    const [[subRow]] = await pool.query(
      `SELECT subscription_end, grace_period_end
       FROM outlet_subscriptions WHERE outlet_id = ?`,
      [parsedOutletId]
    );

    const subscriptionExpiry = subRow?.subscription_end
      ? (subRow.subscription_end.toISOString
          ? subRow.subscription_end.toISOString().split('T')[0]
          : String(subRow.subscription_end).split('T')[0])
      : null;

    const gracePeriodEnd = subRow?.grace_period_end
      ? (subRow.grace_period_end.toISOString
          ? subRow.grace_period_end.toISOString().split('T')[0]
          : String(subRow.grace_period_end).split('T')[0])
      : null;

    // ─── 4. Resolve display fields (override > outlet DB > empty) ─────────────
    const restaurant = bodyRestaurant?.trim() || outlet.name || '';
    const email = bodyEmail?.trim().toLowerCase() || outlet.email || '';
    const phone = bodyPhone?.trim() || outlet.phone || '';

    // ─── 5. Build signed payload ────────────────────────────────────────────────
    const licenseId = crypto.randomUUID();
    const issuedAt = new Date().toISOString();

    const payload = {
      v: 1,
      lid: licenseId,
      plan: 'pro',               // offline POS always gets full Pro features
      type: 'offline_annual',    // discriminator for offline backend
      outletId: parsedOutletId,
      restaurant,
      email: email || null,
      phone: phone || null,
      password: password.trim(), // for admin user creation on offline POS
      subscriptionExpiry,       // from outlet_subscriptions
      gracePeriodEnd,           // from outlet_subscriptions
      issuedAt,
      deviceHash: deviceHash || null,
      modules: {
        captain: true,
        inventory: true,
        advancedReports: true,
      },
      maxOutlets: parseInt(maxOutlets, 10) || 1,  // offline POS: 1 outlet by default
      maxUsers: -1,  // -1 = unlimited users
    };

    const token = signPayload(payload);

    // ─── 6. Log to token_generation_log (audit only — never store raw token) ───
    await _ensureTokenLogTable(pool);

    await pool.query(
      `INSERT INTO token_generation_log
        (license_id, token_type, plan, restaurant_name, email,
         outlet_id, subscription_expiry, device_hash, generated_by_user_id, token_hash)
       VALUES (?, 'offline_activation', 'pro', ?, ?, ?, ?, ?, ?, ?)`,
      [
        licenseId,
        restaurant,
        email || null,
        parsedOutletId,
        subscriptionExpiry,
        deviceHash || null,
        req.user?.userId || null,
        crypto.createHash('sha256').update(token).digest('hex'),
      ]
    );

    // ─── 7. Send WhatsApp + Email notifications ────────────────────────────────
    const notification = await notifyOfflineActivation(
      notify_whatsapp ? phone : null,
      notify_email ? email : null,
      {
        token,
        licenseId,
        restaurant,
        subscriptionExpiry,
        gracePeriodEnd,
        adminEmail: email || '—',
        adminPassword: password.trim(),
      }
    );

    logger.info(
      `[TokenGen] Offline activation token: lid=${licenseId} outlet=${parsedOutletId} ` +
      `subExpiry=${subscriptionExpiry || 'none'} device=${deviceHash ? 'yes' : 'no'} ` +
      `wa=${_notifStatus(notification.whatsapp)} em=${_notifStatus(notification.email)} ` +
      `by user #${req.user?.userId}`
    );

    return res.json({
      success: true,
      message: 'Offline activation token generated successfully',
      data: {
        licenseId,
        token,
        outletId: parsedOutletId,
        plan: 'pro',
        type: 'offline_annual',
        restaurant,
        email: email || null,
        phone: phone || null,
        subscriptionExpiry,
        gracePeriodEnd,
        deviceHash: payload.deviceHash,
        modules: payload.modules,
        maxOutlets: payload.maxOutlets,
        maxUsers: payload.maxUsers,
        issuedAt,
        notifications: {
          whatsapp: notification.whatsapp.ok === true ? 'sent' : notification.whatsapp.ok === false ? 'failed' : 'skipped',
          email: notification.email.ok === true ? 'sent' : notification.email.ok === false ? 'failed' : 'skipped',
        },
      },
    });

  } catch (err) {
    logger.error('[TokenGen] generateOfflineActivationToken error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate offline token: ' + err.message,
    });
  }
};

/**
 * GET /api/v1/token-generation/public-key
 * Public — returns the RSA public key for offline token signature verification.
 *
 * The offline POS backend downloads this once and caches it locally.
 * Response is plain text PEM for easy consumption.
 */
const getOfflinePublicKey = async (req, res) => {
  try {
    const publicKey = getPublicKey();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h client cache
    return res.send(publicKey);
  } catch (err) {
    logger.error('[TokenGen] getOfflinePublicKey error:', err);
    return res.status(500).json({
      success: false,
      message: 'Public key unavailable: ' + err.message,
    });
  }
};

module.exports = {
  generateActivationToken,
  generateUpgradeToken,
  getTokenLog,
  internalGenerateUpgradeToken,
  generateOfflineActivationToken,
  getOfflinePublicKey,
};
