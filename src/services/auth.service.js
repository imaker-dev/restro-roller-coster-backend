const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getPool } = require('../database');
const jwtConfig = require('../config/jwt.config');
const logger = require('../utils/logger');
const { cache } = require('../config/redis');
const { CACHE_KEYS, CACHE_TTL } = require('../constants');

const SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 30;

class AuthService {
  /**
   * Login with email and password
   */
  async loginWithEmail(email, password, deviceInfo = {}) {
    const pool = getPool();
    
    // Get user with roles
    const [users] = await pool.query(
      `SELECT u.*, GROUP_CONCAT(DISTINCT r.slug) as role_slugs
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id AND ur.is_active = 1
       LEFT JOIN roles r ON ur.role_id = r.id AND r.is_active = 1
       WHERE u.email = ? AND u.deleted_at IS NULL
       GROUP BY u.id`,
      [email.toLowerCase()]
    );

    if (users.length === 0) {
      await this.logAuthActivity(null, 'login_failed', deviceInfo, { reason: 'user_not_found', email });
      throw new Error('Invalid email or password');
    }

    const user = users[0];

    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainingMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      throw new Error(`Account is locked. Try again in ${remainingMinutes} minutes`);
    }

    // Check if user is active
    if (!user.is_active) {
      await this.logAuthActivity(user.id, 'login_failed', deviceInfo, { reason: 'account_inactive' });
      throw new Error('Account is deactivated. Contact administrator');
    }

    // Verify password
    if (!user.password_hash) {
      throw new Error('Password not set. Use PIN login or contact administrator');
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!isValidPassword) {
      await this.incrementLoginAttempts(user.id);
      await this.logAuthActivity(user.id, 'login_failed', deviceInfo, { reason: 'invalid_password' });
      
      const attemptsLeft = MAX_LOGIN_ATTEMPTS - user.login_attempts - 1;
      if (attemptsLeft <= 0) {
        throw new Error(`Account locked due to too many failed attempts`);
      }
      throw new Error(`Invalid email or password. ${attemptsLeft} attempts remaining`);
    }

    // Reset login attempts and update last login
    await this.resetLoginAttempts(user.id, deviceInfo.ip);

    // Get user's outlets
    const { outlets, outletId, outletName } = await this._getUserOutlets(user.id);

    // Check if user has any outlets assigned (unless master/super_admin)
    const isSuperAdmin = user.role_slugs && (user.role_slugs.includes('master') || user.role_slugs.includes('super_admin'));
    if (outlets.length === 0 && !isSuperAdmin) {
      await this.logAuthActivity(user.id, 'login_failed', deviceInfo, { reason: 'no_outlet_assigned' });
      throw new Error('No outlet assigned to this user. Contact administrator');
    }

    // Get assigned floors for the active outlet
    const assignedFloors = await this._getUserFloors(user.id, outletId);

    // Get assigned stations for the user
    const assignedStations = await this._getUserStations(user.id, outletId);

    // Return primary station or first station as single object
    const assignedStation = assignedStations.find(s => s.isPrimary) || assignedStations[0] || null;

    // Generate tokens with outletId
    const tokens = await this.generateTokens(user, { ...deviceInfo, outletId });

    // Log successful login
    await this.logAuthActivity(user.id, 'login', deviceInfo, { method: 'email' });

    return {
      user: {
        ...this.sanitizeUser(user),
        outletId,
        outletName,
        outlets,
        assignedFloors,
        assignedStations: assignedStation,
      },
      ...tokens,
    };
  }

  /**
   * Login with PIN (for staff quick access)
   */
  async loginWithPin(employeeCode, pin, outletId, deviceInfo = {}) {
    const pool = getPool();
    
    // Get user by employee code - fetch ALL roles (not filtered by outlet)
    // so user can access endpoints with any valid role they have
    const [users] = await pool.query(
      `SELECT u.*, GROUP_CONCAT(DISTINCT r.slug) as role_slugs
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id AND ur.is_active = 1
       LEFT JOIN roles r ON ur.role_id = r.id AND r.is_active = 1
       WHERE u.employee_code = ? AND u.deleted_at IS NULL
       GROUP BY u.id`,
      [employeeCode]
    );

    if (users.length === 0) {
      await this.logAuthActivity(null, 'login_failed', deviceInfo, { reason: 'user_not_found', employeeCode });
      throw new Error('Invalid employee code or PIN');
    }

    const user = users[0];

    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainingMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      throw new Error(`Account is locked. Try again in ${remainingMinutes} minutes`);
    }

    // Check if user is active
    if (!user.is_active) {
      throw new Error('Account is deactivated. Contact administrator');
    }

    // Verify PIN
    if (!user.pin_hash) {
      throw new Error('PIN not set. Contact administrator');
    }

    const isValidPin = await bcrypt.compare(pin, user.pin_hash);
    
    if (!isValidPin) {
      await this.incrementLoginAttempts(user.id);
      await this.logAuthActivity(user.id, 'login_failed', deviceInfo, { reason: 'invalid_pin' });
      throw new Error('Invalid employee code or PIN');
    }

    // Reset login attempts
    await this.resetLoginAttempts(user.id, deviceInfo.ip);

    // Get user's outlets (PIN login passes a specific outletId)
    const userOutlets = await this._getUserOutlets(user.id);

    // Check if user has any outlets assigned
    if (userOutlets.outlets.length === 0) {
      throw new Error('No outlet assigned to this user. Contact administrator');
    }

    // Validate outletId if provided
    let activeOutletId = null;
    let activeOutletName = null;

    if (outletId) {
      // Ensure outletId is a number for comparison
      const requestedOutletId = parseInt(outletId, 10);
      const match = userOutlets.outlets.find(o => o.id === requestedOutletId);
      if (!match) {
        throw new Error('You do not have access to the selected outlet');
      }
      activeOutletId = match.id;
      activeOutletName = match.name;
    } else {
      // No outletId provided - use default outlet
      activeOutletId = userOutlets.outletId;
      activeOutletName = userOutlets.outletName;
    }

    // Parallel: floors + stations (both depend on activeOutletId, independent of each other)
    const [assignedFloors, assignedStations] = await Promise.all([
      this._getUserFloors(user.id, activeOutletId),
      this._getUserStations(user.id, activeOutletId)
    ]);

    // Return primary station or first station as single object
    const assignedStation = assignedStations.find(s => s.isPrimary) || assignedStations[0] || null;

    // Generate tokens (shorter expiry for PIN login)
    const tokens = await this.generateTokens(user, { ...deviceInfo, outletId: activeOutletId }, true);

    // Log successful login
    await this.logAuthActivity(user.id, 'login', deviceInfo, { method: 'pin', outletId: activeOutletId });

    return {
      user: {
        ...this.sanitizeUser(user),
        outletId: activeOutletId,
        outletName: activeOutletName,
        outlets: userOutlets.outlets,
        assignedFloors,
        assignedStations: assignedStation,
      },
      ...tokens,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(refreshToken, deviceInfo = {}) {
    const pool = getPool();
    
    // Hash the refresh token to compare
    const tokenHash = this.hashToken(refreshToken);

    // Find valid session
    const [sessions] = await pool.query(
      `SELECT s.*, u.id as user_id, u.uuid, u.name, u.email, u.employee_code, 
              u.is_active, u.avatar_url, GROUP_CONCAT(DISTINCT r.slug) as role_slugs
       FROM user_sessions s
       JOIN users u ON s.user_id = u.id
       LEFT JOIN user_roles ur ON u.id = ur.user_id AND ur.is_active = 1
       LEFT JOIN roles r ON ur.role_id = r.id AND r.is_active = 1
       WHERE s.refresh_token_hash = ? 
         AND s.is_revoked = 0 
         AND s.expires_at > NOW()
         AND u.deleted_at IS NULL
         AND u.is_active = 1
       GROUP BY s.id`,
      [tokenHash]
    );

    if (sessions.length === 0) {
      throw new Error('Invalid or expired refresh token');
    }

    const session = sessions[0];

    // Update last activity
    await pool.query(
      'UPDATE user_sessions SET last_activity_at = NOW() WHERE id = ?',
      [session.id]
    );

    // Generate new access token
    const accessToken = this.generateAccessToken({
      id: session.user_id,
      uuid: session.uuid,
      email: session.email,
      role_slugs: session.role_slugs,
    }, session.outlet_id);

    await this.logAuthActivity(session.user_id, 'token_refresh', deviceInfo);

    return {
      accessToken,
      user: {
        id: session.user_id,
        uuid: session.uuid,
        name: session.name,
        email: session.email,
        employeeCode: session.employee_code,
        avatarUrl: session.avatar_url,
        roles: session.role_slugs ? session.role_slugs.split(',') : [],
      },
    };
  }

  /**
   * Logout - revoke refresh token
   */
  async logout(userId, refreshToken, deviceInfo = {}) {
    const pool = getPool();
    
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await pool.query(
        `UPDATE user_sessions 
         SET is_revoked = 1, revoked_at = NOW(), revoked_reason = 'logout'
         WHERE user_id = ? AND refresh_token_hash = ?`,
        [userId, tokenHash]
      );
    }

    // Clear user session cache
    await cache.del(`${CACHE_KEYS.USER_SESSION}:${userId}`);

    await this.logAuthActivity(userId, 'logout', deviceInfo);

    return { message: 'Logged out successfully' };
  }

  /**
   * Logout from all devices
   */
  async logoutAll(userId, deviceInfo = {}) {
    const pool = getPool();
    
    await pool.query(
      `UPDATE user_sessions 
       SET is_revoked = 1, revoked_at = NOW(), revoked_reason = 'logout_all'
       WHERE user_id = ? AND is_revoked = 0`,
      [userId]
    );

    await cache.del(`${CACHE_KEYS.USER_SESSION}:${userId}`);
    await this.logAuthActivity(userId, 'session_revoke', deviceInfo, { reason: 'logout_all' });

    return { message: 'Logged out from all devices' };
  }

  /**
   * Get current user with permissions
   */
  async getCurrentUser(userId) {
    const pool = getPool();
    
    // NOTE: Caching disabled for /auth/me to ensure real-time data
    // Changes to outlets, stations, floors should reflect immediately

    const [users] = await pool.query(
      `SELECT u.id, u.uuid, u.employee_code, u.name, u.email, u.phone, 
              u.avatar_url, u.is_active, u.is_verified, u.last_login_at
       FROM users u
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [userId]
    );

    if (users.length === 0) {
      throw new Error('User not found');
    }

    const user = users[0];

    // Parallel: roles + permissions + outlets (all independent, all use only userId)
    const [rawRolesRes, permissionsRes, outletsResult] = await Promise.all([
      pool.query(
        `SELECT DISTINCT r.id, r.name, r.slug, ur.outlet_id, o.name as outlet_name
         FROM user_roles ur
         JOIN roles r ON ur.role_id = r.id
         LEFT JOIN outlets o ON ur.outlet_id = o.id
         WHERE ur.user_id = ? AND ur.is_active = 1 AND r.is_active = 1
           AND (ur.outlet_id IS NULL OR o.is_active = 1)`,
        [userId]
      ),
      pool.query(
        `SELECT DISTINCT p.slug, p.module
         FROM user_roles ur
         JOIN role_permissions rp ON ur.role_id = rp.role_id
         JOIN permissions p ON rp.permission_id = p.id
         WHERE ur.user_id = ? AND ur.is_active = 1`,
        [userId]
      ),
      this._getUserOutlets(userId)
    ]);
    const rawRoles = rawRolesRes[0];
    const permissions = permissionsRes[0];
    const { outlets, outletId, outletName } = outletsResult;

    // Deduplicate roles by slug + outlet_id
    const seen = new Set();
    const roles = rawRoles.filter(r => {
      const key = `${r.slug}:${r.outlet_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Parallel: floors + stations (both depend on outletId from above)
    const [assignedFloors, assignedStations] = await Promise.all([
      this._getUserFloors(userId, outletId),
      this._getUserStations(userId, outletId)
    ]);

    // Return primary station or first station as single object
    const assignedStation = assignedStations.find(s => s.isPrimary) || assignedStations[0] || null;

    const result = {
      ...this.sanitizeUser(user),
      outletId,
      outletName,
      outlets,
      assignedFloors,
      assignedStations: assignedStation,
      roles: roles.map(r => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        outletId: r.outlet_id,
        outletName: r.outlet_name,
      })),
      object_role: roles.reduce((acc, r) => {
        acc[r.slug] = {
          id: r.id,
          name: r.name,
          slug: r.slug,
          outletId: r.outlet_id,
          outletName: r.outlet_name,
        };
        return acc;
      }, {}),
      permissions: permissions.map(p => p.slug),
      permissionsByModule: permissions.reduce((acc, p) => {
        if (!acc[p.module]) acc[p.module] = [];
        acc[p.module].push(p.slug);
        return acc;
      }, {}),
    };

    // NOTE: No caching - data should always be fresh for /auth/me

    return result;
  }

  /**
   * Change password
   */
  async changePassword(userId, currentPassword, newPassword, deviceInfo = {}) {
    const pool = getPool();
    
    const [users] = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = ? AND deleted_at IS NULL',
      [userId]
    );

    if (users.length === 0) {
      throw new Error('User not found');
    }

    const user = users[0];

    // Verify current password
    if (user.password_hash) {
      const isValid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!isValid) {
        throw new Error('Current password is incorrect');
      }
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    await pool.query(
      'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?',
      [passwordHash, userId]
    );

    // Revoke all sessions except current
    await pool.query(
      `UPDATE user_sessions 
       SET is_revoked = 1, revoked_at = NOW(), revoked_reason = 'password_change'
       WHERE user_id = ? AND is_revoked = 0`,
      [userId]
    );

    await this.logAuthActivity(userId, 'password_change', deviceInfo);

    return { message: 'Password changed successfully' };
  }

  /**
   * Change PIN
   */
  async changePin(userId, currentPin, newPin, deviceInfo = {}) {
    const pool = getPool();
    
    const [users] = await pool.query(
      'SELECT id, pin_hash FROM users WHERE id = ? AND deleted_at IS NULL',
      [userId]
    );

    if (users.length === 0) {
      throw new Error('User not found');
    }

    const user = users[0];

    // Verify current PIN if exists
    if (user.pin_hash) {
      const isValid = await bcrypt.compare(currentPin, user.pin_hash);
      if (!isValid) {
        throw new Error('Current PIN is incorrect');
      }
    }

    // Hash new PIN
    const pinHash = await bcrypt.hash(newPin, SALT_ROUNDS);

    await pool.query(
      'UPDATE users SET pin_hash = ?, updated_at = NOW() WHERE id = ?',
      [pinHash, userId]
    );

    await this.logAuthActivity(userId, 'pin_change', deviceInfo);

    return { message: 'PIN changed successfully' };
  }

  /**
   * Get active sessions for user
   */
  async getActiveSessions(userId) {
    const pool = getPool();
    
    const [sessions] = await pool.query(
      `SELECT id, device_name, device_type, ip_address, last_activity_at, created_at
       FROM user_sessions
       WHERE user_id = ? AND is_revoked = 0 AND expires_at > NOW()
       ORDER BY last_activity_at DESC`,
      [userId]
    );

    return sessions;
  }

  /**
   * Revoke specific session
   */
  async revokeSession(userId, sessionId, deviceInfo = {}) {
    const pool = getPool();
    
    const [result] = await pool.query(
      `UPDATE user_sessions 
       SET is_revoked = 1, revoked_at = NOW(), revoked_reason = 'manual_revoke'
       WHERE id = ? AND user_id = ?`,
      [sessionId, userId]
    );

    if (result.affectedRows === 0) {
      throw new Error('Session not found');
    }

    await this.logAuthActivity(userId, 'session_revoke', deviceInfo, { sessionId });

    return { message: 'Session revoked successfully' };
  }

  // ==================== Helper Methods ====================

  generateAccessToken(user, outletId = null) {
    const payload = {
      userId: user.id,
      uuid: user.uuid,
      email: user.email,
      roles: user.role_slugs ? user.role_slugs.split(',') : [],
      outletId,
    };

    return jwt.sign(payload, jwtConfig.secret, {
      expiresIn: jwtConfig.accessExpiry,
      algorithm: jwtConfig.algorithm,
      issuer: jwtConfig.issuer,
    });
  }

  generateRefreshToken() {
    return crypto.randomBytes(64).toString('hex');
  }

  hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  async generateTokens(user, deviceInfo = {}, isPinLogin = false) {
    const pool = getPool();
    
    const accessToken = this.generateAccessToken(user, deviceInfo.outletId);
    const refreshToken = this.generateRefreshToken();
    const refreshTokenHash = this.hashToken(refreshToken);

    // Calculate expiry (shorter for PIN login)
    const expiryHours = isPinLogin ? 8 : 168; // 8 hours for PIN, 7 days for email
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    // Store session
    await pool.query(
      `INSERT INTO user_sessions 
       (user_id, outlet_id, refresh_token_hash, device_id, device_name, device_type, 
        ip_address, user_agent, last_activity_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [
        user.id,
        deviceInfo.outletId || null,
        refreshTokenHash,
        deviceInfo.deviceId || null,
        deviceInfo.deviceName || 'Unknown Device',
        deviceInfo.deviceType || 'other',
        deviceInfo.ip || null,
        deviceInfo.userAgent || null,
        expiresAt,
      ]
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: jwtConfig.accessExpiry,
      tokenType: 'Bearer',
    };
  }

  async incrementLoginAttempts(userId) {
    const pool = getPool();
    
    const [result] = await pool.query(
      `UPDATE users 
       SET login_attempts = login_attempts + 1,
           locked_until = CASE 
             WHEN login_attempts + 1 >= ? THEN DATE_ADD(NOW(), INTERVAL ? MINUTE)
             ELSE locked_until
           END
       WHERE id = ?`,
      [MAX_LOGIN_ATTEMPTS, LOCK_DURATION_MINUTES, userId]
    );

    return result;
  }

  async resetLoginAttempts(userId, ip) {
    const pool = getPool();
    
    await pool.query(
      `UPDATE users 
       SET login_attempts = 0, locked_until = NULL, 
           last_login_at = NOW(), last_login_ip = ?
       WHERE id = ?`,
      [ip, userId]
    );
  }

  async logAuthActivity(userId, action, deviceInfo = {}, metadata = {}) {
    const pool = getPool();
    
    try {
      await pool.query(
        `INSERT INTO auth_audit_logs (user_id, action, ip_address, user_agent, device_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          userId,
          action,
          deviceInfo.ip || null,
          deviceInfo.userAgent || null,
          deviceInfo.deviceId || null,
          JSON.stringify(metadata),
        ]
      );
    } catch (error) {
      logger.error('Failed to log auth activity:', error);
    }
  }

  /**
   * Get all outlets a user has access to + determine primary outlet.
   * super_admin: all active outlets (global access)
   * admin with outletId: only assigned outlets
   * admin without outletId: empty array (must create own outlet)
   * Staff: outlets from user_roles
   * Primary outlet: from most recent session, else first in list.
   */
  async _getUserOutlets(userId) {
    const pool = getPool();

    // Check if user has master or super_admin role
    const [superAdminCheck] = await pool.query(
      `SELECT 1 FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE ur.user_id = ? AND ur.is_active = 1 AND r.slug IN ('master', 'super_admin')
       LIMIT 1`,
      [userId]
    );
    const isSuperAdmin = superAdminCheck.length > 0;

    // Get outlets assigned via roles
    const [roleOutlets] = await pool.query(
      `SELECT DISTINCT o.id, o.name
       FROM user_roles ur
       JOIN outlets o ON ur.outlet_id = o.id AND o.is_active = 1
       WHERE ur.user_id = ? AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
       ORDER BY o.id`,
      [userId]
    );

    let outlets;
    if (roleOutlets.length > 0) {
      outlets = roleOutlets;
    } else if (isSuperAdmin) {
      // Only super_admin gets all active outlets
      const [allOutlets] = await pool.query(
        `SELECT id, name FROM outlets WHERE is_active = 1 ORDER BY id`
      );
      outlets = allOutlets;
    } else {
      // Regular admin/user without assigned outlets gets empty array
      outlets = [];
    }

    if (outlets.length === 0) {
      return { outlets: [], outletId: null, outletName: null };
    }

    // Determine primary outlet from most recent session
    let outletId = outlets[0].id;
    let outletName = outlets[0].name;

    const [lastSession] = await pool.query(
      `SELECT us.outlet_id, o.name as outlet_name
       FROM user_sessions us
       JOIN outlets o ON us.outlet_id = o.id AND o.is_active = 1
       WHERE us.user_id = ? AND us.outlet_id IS NOT NULL
       ORDER BY us.created_at DESC LIMIT 1`,
      [userId]
    );
    if (lastSession.length > 0) {
      // Use last session outlet only if it's in the user's allowed list
      const match = outlets.find(o => o.id === lastSession[0].outlet_id);
      if (match) {
        outletId = match.id;
        outletName = match.name;
      }
    }

    return {
      outlets: outlets.map(o => ({ id: o.id, name: o.name })),
      outletId,
      outletName,
    };
  }

  /**
   * Get assigned floors for a user (for login / me responses)
   */
  async _getUserFloors(userId, outletId = null) {
    const pool = getPool();
    let query = `SELECT uf.floor_id, uf.outlet_id, uf.is_primary,
                        f.name as floor_name, f.floor_number, f.code as floor_code
                 FROM user_floors uf
                 JOIN floors f ON uf.floor_id = f.id AND f.is_active = 1
                 WHERE uf.user_id = ? AND uf.is_active = 1`;
    const params = [userId];
    if (outletId) {
      query += ' AND uf.outlet_id = ?';
      params.push(outletId);
    }
    query += ' ORDER BY uf.is_primary DESC, f.display_order, f.floor_number';
    const [rows] = await pool.query(query, params);
    return rows.map(r => ({
      floorId: r.floor_id,
      floorName: r.floor_name,
      floorNumber: r.floor_number,
      floorCode: r.floor_code,
      outletId: r.outlet_id,
      isPrimary: !!r.is_primary,
    }));
  }

  /**
   * Get assigned stations for a user (for login / me responses)
   */
  async _getUserStations(userId, outletId = null) {
    const pool = getPool();
    let query = `SELECT us.id, us.station_id, us.outlet_id, us.is_primary,
                        ks.name as station_name, ks.code as station_code, ks.station_type,
                        ks.printer_id, o.name as outlet_name
                 FROM user_stations us
                 JOIN kitchen_stations ks ON us.station_id = ks.id AND ks.is_active = 1
                 LEFT JOIN outlets o ON us.outlet_id = o.id
                 WHERE us.user_id = ? AND us.is_active = 1`;
    const params = [userId];
    if (outletId) {
      query += ' AND us.outlet_id = ?';
      params.push(outletId);
    }
    query += ' ORDER BY us.is_primary DESC, ks.name';
    const [rows] = await pool.query(query, params);
    return rows.map(r => ({
      id: r.id,
      stationId: r.station_id,
      stationName: r.station_name,
      stationCode: r.station_code,
      stationType: r.station_type,
      outletId: r.outlet_id,
      outletName: r.outlet_name,
      isPrimary: !!r.is_primary,
      printerId: r.printer_id,
    }));
  }

  sanitizeUser(user) {
    return {
      id: user.id,
      uuid: user.uuid,
      employeeCode: user.employee_code,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatar_url,
      isActive: user.is_active,
      isVerified: user.is_verified,
      lastLoginAt: user.last_login_at,
      roles: user.role_slugs ? user.role_slugs.split(',') : [],
    };
  }

  /**
   * Hash password (for user creation)
   */
  async hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  /**
   * Hash PIN (for user creation)
   */
  async hashPin(pin) {
    return bcrypt.hash(pin, SALT_ROUNDS);
  }
}

module.exports = new AuthService();
