/**
 * Self-Order Session Authentication Middleware
 * Validates session tokens for public self-order endpoints.
 * No JWT / user account required — token-based auth for QR sessions.
 * 
 * DEVICE-BASED SESSION CONTROL:
 * - Each session is bound to a specific device (via deviceId)
 * - Requests from different devices are blocked
 * - Same device can resume session after refresh/re-scan
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');

/**
 * Verify self-order session token from Authorization header or query param.
 * Also validates deviceId to ensure same-device access only.
 * Attaches session info to req.selfOrderSession on success.
 */
const verifySelfOrderSession = async (req, res, next) => {
  try {
    // Extract token from header or query
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Self-order session token required'
      });
    }

    // Extract deviceId from header (X-Device-Id) or query param
    const deviceId = req.headers['x-device-id'] || req.query.deviceId;

    const pool = getPool();

    // Smart expiry: expire sessions based on rules (idle timeout, completion buffer)
    // Rule 1: Sessions without order that exceeded idle timeout (default 10 min)
    await pool.query(
      `UPDATE self_order_sessions s
       SET s.status = 'expired', s.updated_at = NOW()
       WHERE s.token = ? AND s.status IN ('active', 'ordering')
         AND s.order_id IS NULL
         AND s.created_at < NOW() - INTERVAL COALESCE(s.idle_timeout_minutes, 10) MINUTE`,
      [token]
    );

    // Rule 3: Sessions with completed orders that exceeded buffer (default 1 min)
    await pool.query(
      `UPDATE self_order_sessions s
       SET s.status = 'expired', s.updated_at = NOW()
       WHERE s.token = ? AND s.status IN ('active', 'ordering')
         AND s.order_completed_at IS NOT NULL
         AND s.order_completed_at < NOW() - INTERVAL COALESCE(s.completion_buffer_minutes, 1) MINUTE`,
      [token]
    );

    // Fetch session with order status for smart validation
    const [sessions] = await pool.query(
      `SELECT s.*, t.table_number, t.name as table_name, t.floor_id,
              f.name as floor_name, ou.name as outlet_name, o.status as order_status
       FROM self_order_sessions s
       JOIN tables t ON s.table_id = t.id
       JOIN outlets ou ON s.outlet_id = ou.id
       LEFT JOIN floors f ON t.floor_id = f.id
       LEFT JOIN orders o ON s.order_id = o.id
       WHERE s.token = ? AND s.status IN ('active', 'ordering')
       LIMIT 1`,
      [token]
    );

    if (sessions.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired session'
      });
    }

    const session = sessions[0];

    // Rule 2: If order exists and is completed/cancelled/paid, check if buffer exceeded
    if (session.order_id && ['paid', 'completed', 'cancelled'].includes(session.order_status)) {
      // If order_completed_at is not set, set it now
      if (!session.order_completed_at) {
        await pool.query(
          `UPDATE self_order_sessions SET order_completed_at = NOW() WHERE id = ?`,
          [session.id]
        );
      }
      // Session will be expired on next request after buffer
    }

    // ═══════════════════════════════════════════════════════════════
    // DEVICE-BASED SESSION CONTROL
    // ═══════════════════════════════════════════════════════════════
    // If session has a device_id and the request deviceId doesn't match, block
    if (session.device_id && deviceId && session.device_id !== deviceId) {
      logger.warn(`Device mismatch for session ${session.id}: expected ${session.device_id}, got ${deviceId}`);
      
      // Log the blocked attempt (fire-and-forget)
      pool.query(
        `INSERT INTO self_order_logs (session_id, outlet_id, table_id, action, ip_address, metadata)
         VALUES (?, ?, ?, 'device_blocked', ?, ?)`,
        [session.id, session.outlet_id, session.table_id, req.ip, JSON.stringify({
          blockedDeviceId: deviceId,
          originalDeviceId: session.device_id,
          endpoint: req.originalUrl
        })]
      ).catch(() => {});

      return res.status(403).json({
        success: false,
        message: 'This session is active on another device. Please use the original device.',
        code: 'DEVICE_MISMATCH'
      });
    }

    // Attach session to request
    req.selfOrderSession = {
      id: session.id,
      token: session.token,
      outletId: session.outlet_id,
      tableId: session.table_id,
      floorId: session.floor_id,
      tableNumber: session.table_number,
      tableName: session.table_name,
      floorName: session.floor_name,
      outletName: session.outlet_name,
      customerName: session.customer_name,
      customerPhone: session.customer_phone,
      orderId: session.order_id,
      status: session.status,
      expiresAt: session.expires_at,
      deviceId: session.device_id,
    };

    next();
  } catch (error) {
    logger.error('Self-order session verification error:', error);
    return res.status(500).json({
      success: false,
      message: 'Session verification failed'
    });
  }
};

module.exports = { verifySelfOrderSession };
