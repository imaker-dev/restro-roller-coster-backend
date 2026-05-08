/**
 * Subscription Service — Per-outlet subscription lifecycle + Razorpay integration
 *
 * Design goals for 1000+ outlets:
 *   - Redis-first status checks (5-min TTL) — avoids DB round-trip on every request
 *   - Single-query batch operations for cron jobs
 *   - Lazy outlet_subscriptions row creation (no missing rows)
 *   - Atomic transactions for payment verification → subscription extension
 */

const crypto = require('crypto');
const Razorpay = require('razorpay');
const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');
const emailService = require('./email.service');
const whatsappService = require('./whatsapp.service');
const { SUBSCRIPTION_STATUS, SUBSCRIPTION_NOTIFICATION_TYPE, GRACE_PERIOD_DAYS } = require('../constants');

// ─── Schema check: detect if migration 074 columns exist ─────────────────────
let _hasPricingColumns = null; // cached across requests
const hasPricingColumns = async () => {
  if (_hasPricingColumns !== null) return _hasPricingColumns;
  try {
    const pool = getPool();
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscription_payments' AND COLUMN_NAME = 'pricing_source'`
    );
    _hasPricingColumns = cols.length > 0;
  } catch {
    _hasPricingColumns = false;
  }
  return _hasPricingColumns;
};

// ─── Razorpay instance (lazy singleton, shared with upgradePayment) ───────────
let _razorpay = null;
const getRazorpay = () => {
  if (_razorpay) return _razorpay;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error('Razorpay not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
  }
  _razorpay = new Razorpay({ key_id, key_secret });
  return _razorpay;
};

// ─── Cache helpers ──────────────────────────────────────────────────────────
const _cacheKey = (outletId) => `subscription:status:${outletId}`;
const _invalidateCache = async (outletId) => cache.del(_cacheKey(outletId));

// ─── Lazy row creation ──────────────────────────────────────────────────────
const _ensureSubscriptionRow = async (pool, outletId) => {
  const [existing] = await pool.query(
    `SELECT id, status, subscription_start, subscription_end, grace_period_end, current_pricing_id
     FROM outlet_subscriptions WHERE outlet_id = ?`,
    [outletId]
  );
  if (existing.length > 0) return existing[0];

  // Insert default expired row
  await pool.query(
    `INSERT INTO outlet_subscriptions (outlet_id, status) VALUES (?, ?)`,
    [outletId, SUBSCRIPTION_STATUS.EXPIRED]
  );
  return { status: SUBSCRIPTION_STATUS.EXPIRED, subscription_start: null, subscription_end: null, grace_period_end: null, current_pricing_id: null };
};

// ─── Public: fast status check (Redis-first) ────────────────────────────────
/**
 * Returns subscription status for an outlet.
 * Uses Redis cache with 5-min TTL to avoid DB hits on every request.
 *
 * @param {number} outletId
 * @returns {Promise<{status:string, isBlocked:boolean, graceDaysRemaining:number|null, subscriptionEnd:string|null}>}
 */
const getSubscriptionStatus = async (outletId) => {
  const cached = await cache.get(_cacheKey(outletId));
  if (cached) return cached;

  const pool = getPool();
  const row = await _ensureSubscriptionRow(pool, outletId);

  const now = new Date();
  let status = row.status;
  let graceDaysRemaining = null;
  let isBlocked = false;

  // Auto-transition: active → grace_period → expired
  if (status === SUBSCRIPTION_STATUS.ACTIVE && row.subscription_end) {
    const end = new Date(row.subscription_end);
    if (end < now) {
      const graceEnd = new Date(end);
      graceEnd.setDate(graceEnd.getDate() + GRACE_PERIOD_DAYS);
      status = SUBSCRIPTION_STATUS.GRACE_PERIOD;
      await pool.query(
        `UPDATE outlet_subscriptions SET status = ?, grace_period_end = ? WHERE outlet_id = ?`,
        [status, graceEnd.toISOString().split('T')[0], outletId]
      );
      await _invalidateCache(outletId);
    }
  }

  if (status === SUBSCRIPTION_STATUS.GRACE_PERIOD && row.grace_period_end) {
    const graceEnd = new Date(row.grace_period_end);
    graceDaysRemaining = Math.max(0, Math.ceil((graceEnd - now) / (1000 * 60 * 60 * 24)));
    if (graceEnd < now) {
      status = SUBSCRIPTION_STATUS.EXPIRED;
      graceDaysRemaining = 0;
      await pool.query(
        `UPDATE outlet_subscriptions SET status = ?, grace_period_end = NULL WHERE outlet_id = ?`,
        [status, outletId]
      );
      await _invalidateCache(outletId);
    }
  }

  if ([SUBSCRIPTION_STATUS.EXPIRED, SUBSCRIPTION_STATUS.SUSPENDED].includes(status)) {
    isBlocked = true;
  }

  const result = {
    status,
    isBlocked,
    graceDaysRemaining,
    subscriptionEnd: row.subscription_end ? row.subscription_end.toISOString?.() || row.subscription_end : null,
  };

  await cache.set(_cacheKey(outletId), result, 300); // 5-min TTL
  return result;
};

// ─── Master: Pricing management ─────────────────────────────────────────────
const getActivePricing = async () => {
  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT id, base_price, gst_percentage, total_price, is_active, effective_from, created_by, created_at
       FROM subscription_pricing WHERE is_active = 1 ORDER BY effective_from DESC LIMIT 1`
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      logger.warn('subscription_pricing table missing');
      return null;
    }
    throw err;
  }
};

const setPricing = async (basePrice, gstPercentage, createdBy) => {
  const pool = getPool();
  // Deactivate old pricing, insert new
  await pool.query(`UPDATE subscription_pricing SET is_active = 0 WHERE is_active = 1`);
  const [result] = await pool.query(
    `INSERT INTO subscription_pricing (base_price, gst_percentage, is_active, effective_from, created_by)
     VALUES (?, ?, 1, CURDATE(), ?)`,
    [basePrice, gstPercentage, createdBy]
  );
  return { id: result.insertId, basePrice, gstPercentage };
};

// ─── Hierarchical pricing: resolve outlet → SA → global ──────────────────────
/**
 * Resolve the effective pricing for an outlet.
 * Priority: outlet_pricing_override > super_admin_pricing > global subscription_pricing
 *
 * @param {number} outletId
 * @returns {Promise<{basePrice:number, gstPercentage:number, totalPrice:number, source:string, sourceId:number|null}>}
 */
const resolveOutletPricing = async (outletId) => {
  const pool = getPool();

  // 1. Check outlet-level override (gracefully skip if table doesn't exist yet)
  try {
    const [[outletOverride]] = await pool.query(
      `SELECT id, base_price, gst_percentage, total_price FROM outlet_pricing_override WHERE outlet_id = ? AND is_active = 1 LIMIT 1`,
      [outletId]
    );
    if (outletOverride) {
      return {
        basePrice: parseFloat(outletOverride.base_price),
        gstPercentage: parseFloat(outletOverride.gst_percentage),
        totalPrice: parseFloat(outletOverride.total_price),
        source: 'outlet',
        sourceId: outletOverride.id,
      };
    }
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      logger.warn(`outlet_pricing_override table missing — falling back to super_admin/global pricing for outlet ${outletId}`);
    } else {
      throw err;
    }
  }

  // 2. Check super_admin pricing (find SA who owns/is assigned to this outlet)
  try {
    const [[saRow]] = await pool.query(
      `SELECT sap.id, sap.base_price, sap.gst_percentage, sap.total_price
       FROM super_admin_pricing sap
       INNER JOIN (
         SELECT DISTINCT ur.user_id
         FROM user_roles ur
         WHERE ur.outlet_id = ? AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
         UNION
         SELECT DISTINCT o.created_by
         FROM outlets o
         WHERE o.id = ? AND o.created_by IS NOT NULL
       ) sa ON sap.user_id = sa.user_id
       WHERE sap.is_active = 1
       LIMIT 1`,
      [outletId, outletId]
    );
    if (saRow) {
      return {
        basePrice: parseFloat(saRow.base_price),
        gstPercentage: parseFloat(saRow.gst_percentage),
        totalPrice: parseFloat(saRow.total_price),
        source: 'super_admin',
        sourceId: saRow.id,
      };
    }
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      logger.warn(`super_admin_pricing table missing — falling back to global pricing for outlet ${outletId}`);
    } else {
      throw err;
    }
  }

  // 3. Fallback to global pricing
  const globalPricing = await getActivePricing();
  if (globalPricing) {
    return {
      basePrice: parseFloat(globalPricing.base_price),
      gstPercentage: parseFloat(globalPricing.gst_percentage),
      totalPrice: parseFloat(globalPricing.total_price),
      source: 'global',
      sourceId: globalPricing.id,
    };
  }

  throw new Error('No pricing configured — set global, super admin, or outlet pricing first');
};

// ─── Super Admin pricing CRUD ───────────────────────────────────────────────

const getSuperAdminPricing = async (userId) => {
  const pool = getPool();
  try {
    const [[row]] = await pool.query(
      `SELECT id, user_id, base_price, gst_percentage, total_price, is_active, notes, created_by, created_at, updated_at
       FROM super_admin_pricing WHERE user_id = ? AND is_active = 1 LIMIT 1`,
      [userId]
    );
    return row || null;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return null;
    }
    throw err;
  }
};

const setSuperAdminPricing = async (userId, basePrice, gstPercentage, createdBy, notes = null) => {
  const pool = getPool();
  // Deactivate old pricing for this SA
  await pool.query(`UPDATE super_admin_pricing SET is_active = 0 WHERE user_id = ? AND is_active = 1`, [userId]);
  const [result] = await pool.query(
    `INSERT INTO super_admin_pricing (user_id, base_price, gst_percentage, is_active, notes, created_by)
     VALUES (?, ?, ?, 1, ?, ?)`,
    [userId, basePrice, gstPercentage, notes, createdBy]
  );
  // Invalidate cache for all outlets under this SA
  await _invalidateSAOutletCaches(userId);
  return { id: result.insertId, userId, basePrice, gstPercentage };
};

const deleteSuperAdminPricing = async (userId) => {
  const pool = getPool();
  await pool.query(`UPDATE super_admin_pricing SET is_active = 0 WHERE user_id = ? AND is_active = 1`, [userId]);
  await _invalidateSAOutletCaches(userId);
  return { userId, deleted: true };
};

const getAllSuperAdminPricings = async () => {
  const pool = getPool();
  try {
    const [rows] = await pool.query(
      `SELECT sap.id, sap.user_id, u.name as user_name, u.email as user_email, u.phone as user_phone,
              sap.base_price, sap.gst_percentage, sap.total_price, sap.notes, sap.created_at, sap.updated_at,
              (SELECT COUNT(DISTINCT x.outlet_id) FROM (
                SELECT ur.outlet_id FROM user_roles ur
                WHERE ur.user_id = sap.user_id AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
                UNION
                SELECT o3.id FROM outlets o3 WHERE o3.created_by = sap.user_id
              ) x) as outlet_count
       FROM super_admin_pricing sap
       JOIN users u ON sap.user_id = u.id
       WHERE sap.is_active = 1
       ORDER BY u.name`
    );
    return rows;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return [];
    }
    throw err;
  }
};

// ─── Outlet pricing override CRUD ───────────────────────────────────────────

const getOutletPricingOverride = async (outletId) => {
  const pool = getPool();
  try {
    const [[row]] = await pool.query(
      `SELECT id, outlet_id, base_price, gst_percentage, total_price, is_active, notes, created_by, created_at, updated_at
       FROM outlet_pricing_override WHERE outlet_id = ? AND is_active = 1 LIMIT 1`,
      [outletId]
    );
    return row || null;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return null;
    }
    throw err;
  }
};

const setOutletPricingOverride = async (outletId, basePrice, gstPercentage, createdBy, notes = null) => {
  const pool = getPool();
  // Deactivate old override for this outlet
  await pool.query(`UPDATE outlet_pricing_override SET is_active = 0 WHERE outlet_id = ? AND is_active = 1`, [outletId]);
  const [result] = await pool.query(
    `INSERT INTO outlet_pricing_override (outlet_id, base_price, gst_percentage, is_active, notes, created_by)
     VALUES (?, ?, ?, 1, ?, ?)`,
    [outletId, basePrice, gstPercentage, notes, createdBy]
  );
  await _invalidateCache(outletId);
  return { id: result.insertId, outletId, basePrice, gstPercentage };
};

const deleteOutletPricingOverride = async (outletId) => {
  const pool = getPool();
  await pool.query(`UPDATE outlet_pricing_override SET is_active = 0 WHERE outlet_id = ? AND is_active = 1`, [outletId]);
  await _invalidateCache(outletId);
  return { outletId, deleted: true };
};

// ─── Helper: invalidate caches for all outlets under a super_admin ──────────
const _invalidateSAOutletCaches = async (saUserId) => {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT DISTINCT ur.outlet_id
     FROM user_roles ur
     WHERE ur.user_id = ? AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
     UNION
     SELECT DISTINCT o.id FROM outlets o WHERE o.created_by = ?`,
    [saUserId, saUserId]
  );
  for (const row of rows) {
    await _invalidateCache(row.outlet_id);
  }
};

// ─── Master: List all subscriptions (paginated, optimized) ──────────────────
const getAllSubscriptions = async (filters = {}, pagination = { page: 1, limit: 50 }) => {
  const pool = getPool();
  const { status, search, pricingSource, expiringWithinDays, expiredOnly, expiringToday, superAdminId } = filters;
  const { page, limit } = pagination;
  const offset = (page - 1) * limit;

  let where = 'WHERE 1=1';
  const params = [];

  if (status) {
    where += ' AND os.status = ?';
    params.push(status);
  }
  if (search) {
    where += ' AND (o.name LIKE ? OR o.code LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (pricingSource && await hasPricingColumns()) {
    where += ' AND os.pricing_source = ?';
    params.push(pricingSource);
  }
  if (expiringToday) {
    where += ' AND os.subscription_end = CURDATE()';
  }
  if (expiringWithinDays && parseInt(expiringWithinDays) > 0) {
    where += ' AND os.status = ? AND os.subscription_end BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)';
    params.push(SUBSCRIPTION_STATUS.ACTIVE, parseInt(expiringWithinDays));
  }
  if (expiredOnly) {
    where += ' AND os.status IN (?, ?)';
    params.push(SUBSCRIPTION_STATUS.EXPIRED, SUBSCRIPTION_STATUS.GRACE_PERIOD);
  }
  if (superAdminId) {
    where += ` AND os.outlet_id IN (
      SELECT DISTINCT ur.outlet_id FROM user_roles ur
      WHERE ur.user_id = ? AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
      UNION
      SELECT DISTINCT o2.id FROM outlets o2 WHERE o2.created_by = ?
    )`;
    params.push(parseInt(superAdminId), parseInt(superAdminId));
  }

  // Single query: subscriptions + outlet info + last payment + pricing source
  const _hpc = await hasPricingColumns();
  const [data] = await pool.query(
    `SELECT
      os.id, os.outlet_id, os.status, os.subscription_start, os.subscription_end,
      os.grace_period_end, os.auto_renew, ${_hpc ? 'os.pricing_source,' : "'global' as pricing_source,"} os.notes, os.created_at, os.updated_at,
      o.name as outlet_name, o.code as outlet_code, o.phone as outlet_phone, o.email as outlet_email,
      sp.id as last_payment_id, sp.total_amount as last_paid_amount, sp.paid_at as last_paid_at,
      sp.status as last_payment_status${_hpc ? ', sp.pricing_source as payment_pricing_source' : ''}
     FROM outlet_subscriptions os
     JOIN outlets o ON os.outlet_id = o.id
     LEFT JOIN subscription_payments sp ON os.last_payment_id = sp.id
     ${where}
     ORDER BY os.updated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), parseInt(offset)]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM outlet_subscriptions os JOIN outlets o ON os.outlet_id = o.id ${where}`,
    params
  );

  return {
    subscriptions: data,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / limit) },
  };
};

// ─── Outlet: My subscription ────────────────────────────────────────────────
const getMySubscription = async (outletId) => {
  const pool = getPool();
  const _hpc = await hasPricingColumns();
  const pricingSourceCol = _hpc ? 'os.pricing_source,' : "'global' as pricing_source,";
  let rows;
  try {
    const [result] = await pool.query(
      `SELECT
        os.id, os.outlet_id, os.status, os.subscription_start, os.subscription_end,
        os.grace_period_end, os.auto_renew, ${pricingSourceCol} os.notes, os.created_at, os.updated_at,
        os.current_pricing_id,
        sp.base_amount, sp.gst_amount, sp.total_amount, sp.paid_at, sp.status as payment_status,
        pr.base_price, pr.gst_percentage, pr.total_price as pricing_total,
        o.name as outlet_name
       FROM outlet_subscriptions os
       JOIN outlets o ON os.outlet_id = o.id
       LEFT JOIN subscription_payments sp ON os.last_payment_id = sp.id
       LEFT JOIN subscription_pricing pr ON os.current_pricing_id = pr.id
       WHERE os.outlet_id = ?`,
      [outletId]
    );
    rows = result;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      // subscription_pricing missing — retry without that LEFT JOIN
      const [result] = await pool.query(
        `SELECT
          os.id, os.outlet_id, os.status, os.subscription_start, os.subscription_end,
          os.grace_period_end, os.auto_renew, ${pricingSourceCol} os.notes, os.created_at, os.updated_at,
          os.current_pricing_id,
          sp.base_amount, sp.gst_amount, sp.total_amount, sp.paid_at, sp.status as payment_status,
          NULL as base_price, NULL as gst_percentage, NULL as pricing_total,
          o.name as outlet_name
         FROM outlet_subscriptions os
         JOIN outlets o ON os.outlet_id = o.id
         LEFT JOIN subscription_payments sp ON os.last_payment_id = sp.id
         WHERE os.outlet_id = ?`,
        [outletId]
      );
      rows = result;
    } else {
      throw err;
    }
  }
  if (!rows.length) return null;

  const row = rows[0];
  const status = await getSubscriptionStatus(outletId); // Ensures auto-transitions

  // Build pricing info from last payment (what was actually paid)
  let basePrice = row.base_amount !== null ? parseFloat(row.base_amount) : (row.base_price !== null ? parseFloat(row.base_price) : null);
  let gstPercentage = row.gst_amount !== null && row.base_amount > 0
    ? Math.round((parseFloat(row.gst_amount) / parseFloat(row.base_amount)) * 100)
    : (row.gst_percentage !== null ? parseFloat(row.gst_percentage) : null);
  let totalAmount = row.total_amount !== null ? parseFloat(row.total_amount) : (row.pricing_total !== null ? parseFloat(row.pricing_total) : null);

  // If still no pricing, resolve via hierarchical pricing
  let resolvedSource = row.pricing_source || 'global';
  if (basePrice === null || totalAmount === null) {
    try {
      const resolved = await resolveOutletPricing(outletId);
      basePrice = basePrice !== null ? basePrice : resolved.basePrice;
      gstPercentage = gstPercentage !== null ? gstPercentage : resolved.gstPercentage;
      totalAmount = totalAmount !== null ? totalAmount : resolved.totalPrice;
      resolvedSource = resolved.source;
    } catch (_) {
      // No pricing configured at all — leave as null
    }
  }

  // Next renewal pricing (what they will pay on next renewal)
  let nextRenewalPricing = null;
  try {
    const resolved = await resolveOutletPricing(outletId);
    nextRenewalPricing = {
      basePrice: resolved.basePrice,
      gstPercentage: resolved.gstPercentage,
      totalPrice: resolved.totalPrice,
      source: resolved.source,
    };
  } catch (_) { /* no pricing */ }

  const pricingInfo = {
    basePrice,
    gstPercentage,
    totalAmount,
    pricingSource: resolvedSource,
    paidAt: row.paid_at,
    paymentStatus: row.payment_status
  };

  return {
    ...row,
    status: status.status,
    isBlocked: status.isBlocked,
    graceDaysRemaining: status.graceDaysRemaining,
    pricing_source: resolvedSource,
    // Backward-compatible pricing fields (Flutter app reads these directly)
    base_amount: basePrice,
    gst_amount: basePrice && gstPercentage ? Math.round(basePrice * gstPercentage / 100) : null,
    total_amount: totalAmount,
    pricingInfo,
    nextRenewalPricing,
  };
};

// ─── Razorpay: Create payment order ─────────────────────────────────────────
const createRazorpayOrder = async (outletId, userId) => {
  // Resolve hierarchical pricing: outlet override > super_admin > global
  const pricing = await resolveOutletPricing(outletId);

  const pool = getPool();
  const subRow = await _ensureSubscriptionRow(pool, outletId);

  // Total amount in paise (₹1 = 100 paise)
  const amountPaise = Math.round(pricing.totalPrice * 100);
  const receipt = `sub_${outletId}_${Date.now()}`;

  const razorpay = getRazorpay();
  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt,
    notes: { outlet_id: String(outletId), user_id: String(userId), type: 'subscription_renewal', pricing_source: pricing.source },
  });

  // Record pending payment with pricing source traceability
  const gstAmount = pricing.totalPrice - pricing.basePrice;

  if (await hasPricingColumns()) {
    await pool.query(
      `INSERT INTO subscription_payments
        (outlet_id, subscription_id, razorpay_order_id, base_amount, gst_amount, total_amount, pricing_source, pricing_ref_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [outletId, subRow.id, order.id, pricing.basePrice, gstAmount, pricing.totalPrice, pricing.source, pricing.sourceId]
    );
  } else {
    await pool.query(
      `INSERT INTO subscription_payments
        (outlet_id, subscription_id, razorpay_order_id, base_amount, gst_amount, total_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [outletId, subRow.id, order.id, pricing.basePrice, gstAmount, pricing.totalPrice]
    );
  }

  return {
    orderId: order.id,
    amount: amountPaise,
    currency: 'INR',
    keyId: process.env.RAZORPAY_KEY_ID,
    basePrice: pricing.basePrice,
    gstAmount,
    totalPrice: pricing.totalPrice,
    gstPercentage: pricing.gstPercentage,
    pricingSource: pricing.source,
    receipt,
  };
};

// ─── Razorpay: Verify payment & extend subscription ─────────────────────────
const verifyAndExtendSubscription = async (outletId, razorpayOrderId, razorpayPaymentId, razorpaySignature) => {
  // Verify signature server-side (never trust client)
  const secret = process.env.RAZORPAY_KEY_SECRET;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expectedSig !== razorpaySignature) {
    throw new Error('Razorpay signature verification failed');
  }

  const pool = getPool();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Lock the payment row
    const [[payment]] = await connection.query(
      `SELECT id, outlet_id, subscription_id, status FROM subscription_payments
       WHERE razorpay_order_id = ? FOR UPDATE`,
      [razorpayOrderId]
    );

    if (!payment) throw new Error('Payment record not found');
    if (payment.outlet_id !== outletId) throw new Error('Outlet mismatch');
    if (payment.status === 'captured') {
      await connection.commit();
      return { alreadyProcessed: true, message: 'Payment already processed' };
    }

    // Update payment record
    await connection.query(
      `UPDATE subscription_payments
       SET razorpay_payment_id = ?, razorpay_signature = ?, status = 'captured', paid_at = NOW()
       WHERE id = ?`,
      [razorpayPaymentId, razorpaySignature, payment.id]
    );

    // Calculate new subscription period
    const [[sub]] = await connection.query(
      `SELECT subscription_start, subscription_end, status FROM outlet_subscriptions WHERE outlet_id = ?`,
      [outletId]
    );

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const nextYear = new Date(now);
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    const endStr = nextYear.toISOString().split('T')[0];

    // If active → extend from current end; if expired/grace → start today
    let newStart = todayStr;
    let newEnd = endStr;

    if (sub && sub.subscription_end) {
      const currentEnd = new Date(sub.subscription_end);
      if (currentEnd > now && sub.status === SUBSCRIPTION_STATUS.ACTIVE) {
        // Extend from current end
        const extended = new Date(currentEnd);
        extended.setFullYear(extended.getFullYear() + 1);
        newStart = sub.subscription_start;
        newEnd = extended.toISOString().split('T')[0];
      }
    }

    // Get pricing source from the payment record for traceability (if column exists)
    let pSource = 'global';
    if (await hasPricingColumns()) {
      try {
        const [[paymentPricing]] = await connection.query(
          `SELECT pricing_source, pricing_ref_id FROM subscription_payments WHERE id = ?`,
          [payment.id]
        );
        pSource = paymentPricing?.pricing_source || 'global';
      } catch { /* column missing */ }
    }

    // Resolve current pricing ID safely (getActivePricing handles missing table)
    const activePricing = await getActivePricing();
    const currentPricingId = activePricing?.id || null;

    // Activate / extend subscription
    if (await hasPricingColumns()) {
      await connection.query(
        `UPDATE outlet_subscriptions
         SET status = ?, subscription_start = ?, subscription_end = ?, grace_period_end = NULL,
             last_payment_id = ?, pricing_source = ?,
             current_pricing_id = ?,
             updated_at = NOW()
         WHERE outlet_id = ?`,
        [SUBSCRIPTION_STATUS.ACTIVE, newStart, newEnd, payment.id, pSource, currentPricingId, outletId]
      );
    } else {
      await connection.query(
        `UPDATE outlet_subscriptions
         SET status = ?, subscription_start = ?, subscription_end = ?, grace_period_end = NULL,
             last_payment_id = ?,
             updated_at = NOW()
         WHERE outlet_id = ?`,
        [SUBSCRIPTION_STATUS.ACTIVE, newStart, newEnd, payment.id, outletId]
      );
    }

    await connection.commit();
    await _invalidateCache(outletId);

    // ─── Send invoice email + WhatsApp (fire-and-forget with delay) ────────────────
    // Delay 3 seconds to ensure DB replication/consistency before sending notifications
    setTimeout(async () => {
      try {
        logger.info('[SubscriptionNotify] Starting notification process (delayed)...');
        const pool = getPool();

        // Fetch outlet info
        logger.info('[SubscriptionNotify] Fetching outlet info...');
        const [outletRows] = await pool.query(
          `SELECT name, email, phone,
                  CONCAT_WS(', ', NULLIF(address_line1,''), NULLIF(address_line2,''), NULLIF(city,''), NULLIF(state,''), NULLIF(postal_code,'')) AS address,
                  gstin, logo_url
           FROM outlets WHERE id = ?`,
          [outletId]
        );
        const outlet = outletRows[0] || {};
        logger.info(`[SubscriptionNotify] outlet=${outletId} email=${outlet.email} phone=${outlet.phone}`);

        // Fetch payment record - use correct column names
        logger.info('[SubscriptionNotify] Fetching payment record...');
        const [[payRow]] = await pool.query(
          `SELECT base_amount, gst_amount, total_amount FROM subscription_payments WHERE id = ?`,
          [payment.id]
        );
        const receiptNo = `sub_${outletId}_${Date.now()}`;
        const baseAmount = parseFloat(payRow?.base_amount || 0); // already in rupees (DECIMAL)
        const gstAmount = parseFloat(payRow?.gst_amount || 0);
        const totalAmount = parseFloat(payRow?.total_amount || 0);
        const gstPercentage = baseAmount > 0 ? Math.round((gstAmount / baseAmount) * 100) : 18;
        logger.info(`[SubscriptionNotify] payment data: receipt=${receiptNo}, base=${baseAmount}, gst=${gstAmount}, total=${totalAmount}`);

        const invoiceDate = new Date().toLocaleDateString('en-IN', {
          day: '2-digit', month: 'short', year: 'numeric'
        });
        const subStartStr = new Date(newStart).toLocaleDateString('en-IN', {
          day: '2-digit', month: 'short', year: 'numeric'
        });
        const subEndStr = new Date(newEnd).toLocaleDateString('en-IN', {
          day: '2-digit', month: 'short', year: 'numeric'
        });

        // Build receipt data
        const receiptData = {
          receiptNo,
          date: invoiceDate,
          outletName: outlet.name || 'Restaurant',
          outletAddress: outlet.address || 'N/A',
          baseAmount,
          gstAmount,
          totalAmount,
          gstPercentage,
          subscriptionStart: subStartStr,
          subscriptionEnd: subEndStr,
          paymentMode: 'Online (Razorpay)',
          paymentId: razorpayPaymentId,
        };
        logger.info('[SubscriptionNotify] Receipt data built successfully');

        // Generate PDF receipt
        let receiptPDFBuffer = null;
        try {
          logger.info('[SubscriptionNotify] Loading PDF generator...');
          const { generateSubscriptionReceiptPDF } = require('../utils/subscription-receipt-pdf');
          logger.info('[SubscriptionNotify] Generating PDF...');
          receiptPDFBuffer = await generateSubscriptionReceiptPDF(receiptData, outlet);
          logger.info(`[SubscriptionNotify] PDF generated ${receiptPDFBuffer.length} bytes`);
        } catch (pdfErr) {
          logger.warn('[SubscriptionNotify] PDF generation failed (continuing without PDF):', pdfErr.message || pdfErr);
        }

        // Email receipt
        if (outlet.email) {
          try {
            logger.info(`[SubscriptionNotify] Sending email to ${outlet.email}`);
            if (receiptPDFBuffer) {
              logger.info('[SubscriptionNotify] Calling sendSubscriptionReceiptEmail with PDF...');
              await emailService.sendSubscriptionReceiptEmail(outlet.email, {
                ...receiptData,
                attachment: {
                  filename: `Subscription-Receipt-${receiptNo}.pdf`,
                  buffer: receiptPDFBuffer,
                  contentType: 'application/pdf',
                },
              });
            } else {
              // Plain text email if PDF failed
              logger.info('[SubscriptionNotify] Calling sendMail (plain text)...');
              await emailService.sendMail(
                outlet.email,
                `iMakerRestro — Subscription Receipt`,
                `Hi ${outlet.name || 'Valued Customer'},\n\nThank you for your subscription payment!\n\nReceipt #: ${receiptNo}\nAmount: ₹${totalAmount.toFixed(2)}\nValid From: ${subStartStr}\nExpires On: ${subEndStr}\nPayment ID: ${razorpayPaymentId}\n\nBest regards,\niMakerRestro Team`,
                `<h2>iMakerRestro — Subscription Receipt</h2><p>Hi ${outlet.name || 'Valued Customer'},</p><p>Thank you for your subscription payment!</p><table border='0' cellpadding='8'><tr><td><b>Receipt #:</b></td><td>${receiptNo}</td></tr><tr><td><b>Amount:</b></td><td>₹${totalAmount.toFixed(2)}</td></tr><tr><td><b>Valid From:</b></td><td>${subStartStr}</td></tr><tr><td><b>Expires On:</b></td><td>${subEndStr}</td></tr><tr><td><b>Payment ID:</b></td><td>${razorpayPaymentId}</td></tr></table><br><p>Best regards,<br><b>iMakerRestro Team</b></p>`
              );
            }
            logger.info(`[SubscriptionNotify] Email sent successfully`);
          } catch (emailErr) {
            logger.error('[SubscriptionNotify] Email send failed:', emailErr.message || emailErr);
          }
        } else {
          logger.warn(`[SubscriptionNotify] Outlet ${outletId} has no email, skipping email`);
        }

        // WhatsApp receipt
        if (outlet.phone) {
          try {
            logger.info(`[SubscriptionNotify] Sending WhatsApp to ${outlet.phone}`);
            const caption = `🧾 Subscription Receipt #${receiptNo}\nAmount Paid: ₹${totalAmount.toFixed(2)}\nValid From: ${subStartStr}\nExpires On: ${subEndStr}\nPayment ID: ${razorpayPaymentId}\n\nThank you for choosing iMakerRestro!`;

            if (receiptPDFBuffer) {
              logger.info('[SubscriptionNotify] Calling sendSubscriptionReceiptPDF...');
              await whatsappService.sendSubscriptionReceiptPDF(
                outlet.phone,
                receiptData,
                outlet,
                caption
              );
            } else {
              // Send plain text if PDF failed
              logger.info('[SubscriptionNotify] Calling sendText...');
              await whatsappService.sendText(
                outlet.phone,
                caption
              );
            }
            logger.info(`[SubscriptionNotify] WhatsApp sent successfully`);
          } catch (waErr) {
            logger.error('[SubscriptionNotify] WhatsApp send failed:', waErr.message || waErr);
          }
        } else {
          logger.warn(`[SubscriptionNotify] Outlet ${outletId} has no phone, skipping WhatsApp`);
        }
      } catch (notifyErr) {
        // Non-blocking: log but don't fail the payment
        logger.error('[SubscriptionNotify] Notification error (non-blocking):', notifyErr?.message || notifyErr?.stack || JSON.stringify(notifyErr) || String(notifyErr));
      }
    }, 3000); // 3 second delay for DB consistency

    return {
      success: true,
      subscriptionStart: newStart,
      subscriptionEnd: newEnd,
      paymentId: payment.id,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

// ─── Master: Force activate / deactivate / extend ───────────────────────────
const activateSubscription = async (outletId, masterUserId, options = {}) => {
  const pool = getPool();
  const subRow = await _ensureSubscriptionRow(pool, outletId);

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const nextYear = new Date(now);
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  const endStr = nextYear.toISOString().split('T')[0];

  const startDate = options.startDate || todayStr;
  const endDate = options.endDate || endStr;
  const notes = options.notes || `Manual activation by master user ${masterUserId}`;

  await pool.query(
    `UPDATE outlet_subscriptions
     SET status = ?, subscription_start = ?, subscription_end = ?, grace_period_end = NULL,
         notes = ?, updated_at = NOW()
     WHERE outlet_id = ?`,
    [SUBSCRIPTION_STATUS.ACTIVE, startDate, endDate, notes, outletId]
  );

  // Log notification (gracefully skip if outlet FK missing)
  try {
    await pool.query(
      `INSERT INTO subscription_notifications (outlet_id, type, metadata)
       VALUES (?, ?, ?)`,
      [outletId, SUBSCRIPTION_NOTIFICATION_TYPE.MANUAL_ACTIVATION, JSON.stringify({ by: masterUserId })]
    );
  } catch (notifyErr) {
    logger.warn(`[activateSubscription] Skipped notification for outlet ${outletId}: ${notifyErr.message}`);
  }

  await _invalidateCache(outletId);
  return { outletId, status: SUBSCRIPTION_STATUS.ACTIVE, subscriptionStart: startDate, subscriptionEnd: endDate };
};

const deactivateSubscription = async (outletId, masterUserId, options = {}) => {
  const pool = getPool();
  const notes = options.notes || `Manual deactivation by master user ${masterUserId}`;

  await pool.query(
    `UPDATE outlet_subscriptions
     SET status = ?, subscription_end = NULL, grace_period_end = NULL, notes = ?, updated_at = NOW()
     WHERE outlet_id = ?`,
    [SUBSCRIPTION_STATUS.SUSPENDED, notes, outletId]
  );

  // Log notification (gracefully skip if outlet FK missing)
  try {
    await pool.query(
      `INSERT INTO subscription_notifications (outlet_id, type, metadata)
       VALUES (?, ?, ?)`,
      [outletId, SUBSCRIPTION_NOTIFICATION_TYPE.MANUAL_DEACTIVATION, JSON.stringify({ by: masterUserId })]
    );
  } catch (notifyErr) {
    logger.warn(`[deactivateSubscription] Skipped notification for outlet ${outletId}: ${notifyErr.message}`);
  }

  await _invalidateCache(outletId);
  return { outletId, status: SUBSCRIPTION_STATUS.SUSPENDED };
};

const extendSubscription = async (outletId, days, masterUserId) => {
  const pool = getPool();
  const [[sub]] = await pool.query(
    `SELECT subscription_end FROM outlet_subscriptions WHERE outlet_id = ?`,
    [outletId]
  );

  const now = new Date();
  const baseDate = sub?.subscription_end && new Date(sub.subscription_end) > now
    ? new Date(sub.subscription_end)
    : now;

  baseDate.setDate(baseDate.getDate() + parseInt(days));
  const newEnd = baseDate.toISOString().split('T')[0];

  await pool.query(
    `UPDATE outlet_subscriptions
     SET status = ?, subscription_end = ?, grace_period_end = NULL, updated_at = NOW()
     WHERE outlet_id = ?`,
    [SUBSCRIPTION_STATUS.ACTIVE, newEnd, outletId]
  );

  await _invalidateCache(outletId);
  return { outletId, newEnd };
};

// ─── Cron: Batch notification scanner (optimized single-query) ───────────────
const scanExpiringSubscriptions = async () => {
  const pool = getPool();
  const today = new Date().toISOString().split('T')[0];

  // 1. 10-day reminder (not yet notified)
  const [rem10] = await pool.query(
    `SELECT os.outlet_id, os.subscription_end
     FROM outlet_subscriptions os
     LEFT JOIN subscription_notifications sn
       ON sn.outlet_id = os.outlet_id AND sn.type = ?
       AND sn.sent_at >= DATE_SUB(CURDATE(), INTERVAL 11 DAY)
     WHERE os.status = 'active'
       AND os.subscription_end = DATE_ADD(CURDATE(), INTERVAL 10 DAY)
       AND (sn.id IS NULL OR sn.id = 0)`,
    [SUBSCRIPTION_NOTIFICATION_TYPE.RENEWAL_REMINDER_10D]
  );

  // 2. 3-day reminder (not yet notified)
  const [rem3] = await pool.query(
    `SELECT os.outlet_id, os.subscription_end
     FROM outlet_subscriptions os
     LEFT JOIN subscription_notifications sn
       ON sn.outlet_id = os.outlet_id AND sn.type = ?
       AND sn.sent_at >= DATE_SUB(CURDATE(), INTERVAL 4 DAY)
     WHERE os.status = 'active'
       AND os.subscription_end = DATE_ADD(CURDATE(), INTERVAL 3 DAY)
       AND (sn.id IS NULL OR sn.id = 0)`,
    [SUBSCRIPTION_NOTIFICATION_TYPE.RENEWAL_REMINDER_3D]
  );

  // 3. Expired today → start grace
  const [expiredToday] = await pool.query(
    `SELECT outlet_id, subscription_end FROM outlet_subscriptions
     WHERE status = 'active' AND subscription_end <= CURDATE() AND subscription_end IS NOT NULL`
  );

  // 4. Grace ending today → hard stop
  const [graceEnding] = await pool.query(
    `SELECT outlet_id, grace_period_end FROM outlet_subscriptions
     WHERE status = 'grace_period' AND grace_period_end <= CURDATE() AND grace_period_end IS NOT NULL`
  );

  // Update expired today → grace_period
  for (const row of expiredToday) {
    const graceEnd = new Date();
    graceEnd.setDate(graceEnd.getDate() + GRACE_PERIOD_DAYS);
    await pool.query(
      `UPDATE outlet_subscriptions SET status = ?, grace_period_end = ? WHERE outlet_id = ?`,
      [SUBSCRIPTION_STATUS.GRACE_PERIOD, graceEnd.toISOString().split('T')[0], row.outlet_id]
    );
    await _invalidateCache(row.outlet_id);
  }

  // Update grace ending today → expired
  for (const row of graceEnding) {
    await pool.query(
      `UPDATE outlet_subscriptions SET status = ?, grace_period_end = NULL WHERE outlet_id = ?`,
      [SUBSCRIPTION_STATUS.EXPIRED, row.outlet_id]
    );
    await _invalidateCache(row.outlet_id);
  }

  return {
    reminder10Days: rem10.map((r) => ({ outletId: r.outlet_id, subscriptionEnd: r.subscription_end })),
    reminder3Days: rem3.map((r) => ({ outletId: r.outlet_id, subscriptionEnd: r.subscription_end })),
    expiredToday: expiredToday.map((r) => ({ outletId: r.outlet_id, subscriptionEnd: r.subscription_end })),
    graceEndedToday: graceEnding.map((r) => ({ outletId: r.outlet_id, gracePeriodEnd: r.grace_period_end })),
  };
};

// ─── Log notification (prevents duplicates) ─────────────────────────────────
const logNotification = async (outletId, type, channel = 'in_app', metadata = null) => {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO subscription_notifications (outlet_id, type, channel, metadata)
       VALUES (?, ?, ?, ?)`,
      [outletId, type, channel, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (err) {
    logger.warn(`[logNotification] Skipped notification for outlet ${outletId}: ${err.message}`);
  }
};

// ─── Razorpay webhook: async payment confirmation ────────────────────────────
const processWebhook = async (payload) => {
  const { event, payload: eventPayload } = payload;

  if (event === 'payment.captured') {
    const { order_id, id: payment_id } = eventPayload.payment.entity;

    const pool = getPool();
    const [[payment]] = await pool.query(
      `SELECT id, outlet_id, subscription_id, status FROM subscription_payments WHERE razorpay_order_id = ?`,
      [order_id]
    );

    if (!payment || payment.status === 'captured') return { processed: false };

    // Use the verify function (signature already verified by Razorpay webhook auth)
    // For webhook, we trust the event but still verify the order exists
    await pool.query(
      `UPDATE subscription_payments
       SET razorpay_payment_id = ?, status = 'captured', paid_at = NOW()
       WHERE id = ?`,
      [payment_id, payment.id]
    );

    // Extend subscription (same logic as verifyAndExtendSubscription)
    const [[sub]] = await pool.query(
      `SELECT subscription_start, subscription_end, status FROM outlet_subscriptions WHERE outlet_id = ?`,
      [payment.outlet_id]
    );

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const nextYear = new Date(now);
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    const endStr = nextYear.toISOString().split('T')[0];

    let newStart = todayStr;
    let newEnd = endStr;
    if (sub && sub.subscription_end) {
      const currentEnd = new Date(sub.subscription_end);
      if (currentEnd > now && sub.status === SUBSCRIPTION_STATUS.ACTIVE) {
        const extended = new Date(currentEnd);
        extended.setFullYear(extended.getFullYear() + 1);
        newStart = sub.subscription_start;
        newEnd = extended.toISOString().split('T')[0];
      }
    }

    // Get pricing source from payment for traceability (if column exists)
    let wpSource = 'global';
    if (await hasPricingColumns()) {
      try {
        const [[wpPricing]] = await pool.query(
          `SELECT pricing_source FROM subscription_payments WHERE id = ?`, [payment.id]
        );
        wpSource = wpPricing?.pricing_source || 'global';
      } catch { /* column missing */ }
    }

    if (await hasPricingColumns()) {
      await pool.query(
        `UPDATE outlet_subscriptions
         SET status = ?, subscription_start = ?, subscription_end = ?, grace_period_end = NULL,
             last_payment_id = ?, pricing_source = ?, updated_at = NOW()
         WHERE outlet_id = ?`,
        [SUBSCRIPTION_STATUS.ACTIVE, newStart, newEnd, payment.id, wpSource, payment.outlet_id]
      );
    } else {
      await pool.query(
        `UPDATE outlet_subscriptions
         SET status = ?, subscription_start = ?, subscription_end = ?, grace_period_end = NULL,
             last_payment_id = ?, updated_at = NOW()
         WHERE outlet_id = ?`,
        [SUBSCRIPTION_STATUS.ACTIVE, newStart, newEnd, payment.id, payment.outlet_id]
      );
    }

    await _invalidateCache(payment.outlet_id);
    return { processed: true, outletId: payment.outlet_id };
  }

  return { processed: false };
};

// ─── Super Admin: View their outlets' subscriptions (read-only) ──────────────
const getSuperAdminDashboardSubscriptions = async (saUserId, filters = {}, pagination = { page: 1, limit: 50 }) => {
  const pool = getPool();
  const { status, search } = filters;
  const { page, limit } = pagination;
  const offset = (page - 1) * limit;

  let where = `WHERE os.outlet_id IN (
    SELECT DISTINCT ur.outlet_id FROM user_roles ur
    WHERE ur.user_id = ? AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
    UNION
    SELECT DISTINCT o2.id FROM outlets o2 WHERE o2.created_by = ?
  )`;
  const params = [saUserId, saUserId];

  if (status) {
    where += ' AND os.status = ?';
    params.push(status);
  }
  if (search) {
    where += ' AND (o.name LIKE ? OR o.code LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const _hpc2 = await hasPricingColumns();
  const [data] = await pool.query(
    `SELECT
      os.id, os.outlet_id, os.status, os.subscription_start, os.subscription_end,
      os.grace_period_end, ${_hpc2 ? 'os.pricing_source,' : "'global' as pricing_source,"} os.created_at, os.updated_at,
      o.name as outlet_name, o.code as outlet_code, o.phone as outlet_phone, o.email as outlet_email,
      sp.total_amount as last_paid_amount, sp.paid_at as last_paid_at, sp.status as last_payment_status
     FROM outlet_subscriptions os
     JOIN outlets o ON os.outlet_id = o.id
     LEFT JOIN subscription_payments sp ON os.last_payment_id = sp.id
     ${where}
     ORDER BY os.updated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, parseInt(limit), parseInt(offset)]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM outlet_subscriptions os JOIN outlets o ON os.outlet_id = o.id ${where}`,
    params
  );

  // Enrich with resolved pricing for each outlet (batch-friendly)
  const enriched = await Promise.all(data.map(async (row) => {
    let resolvedPricing = null;
    try {
      resolvedPricing = await resolveOutletPricing(row.outlet_id);
    } catch (_) { /* no pricing */ }
    return {
      ...row,
      appliedPrice: resolvedPricing ? resolvedPricing.totalPrice : null,
      appliedPricingSource: resolvedPricing ? resolvedPricing.source : row.pricing_source || 'global',
    };
  }));

  return {
    subscriptions: enriched,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / limit) },
  };
};

module.exports = {
  getSubscriptionStatus,
  getActivePricing,
  setPricing,
  resolveOutletPricing,
  getSuperAdminPricing,
  setSuperAdminPricing,
  deleteSuperAdminPricing,
  getAllSuperAdminPricings,
  getOutletPricingOverride,
  setOutletPricingOverride,
  deleteOutletPricingOverride,
  getAllSubscriptions,
  getMySubscription,
  createRazorpayOrder,
  verifyAndExtendSubscription,
  activateSubscription,
  deactivateSubscription,
  extendSubscription,
  scanExpiringSubscriptions,
  logNotification,
  processWebhook,
  getSuperAdminDashboardSubscriptions,
  _invalidateCache, // exported for external cache invalidation
};
