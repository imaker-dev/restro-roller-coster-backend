/**
 * Permission Service
 * Handles feature-based permissions with inheritance rules
 * 
 * Rules:
 * - Admin has ALL permissions (superuser)
 * - Manager permissions assigned by Admin
 * - Captain permissions assigned by Admin or Manager
 * - Manager can ONLY grant permissions they have
 * - Changes apply immediately (no re-login required)
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');
const { cache } = require('../config/redis');
const { CACHE_KEYS } = require('../constants');

// Superuser roles that have all permissions
const SUPERUSER_ROLES = ['master', 'super_admin', 'admin'];

// Admin-only manageable roles
const ADMIN_ONLY_ROLES = ['master', 'super_admin', 'admin', 'manager'];

class PermissionService {
  
  /**
   * Get all available permissions grouped by category
   */
  async getAllPermissions() {
    const pool = getPool();
    
    const [permissions] = await pool.query(
      `SELECT id, name, slug, module, category, display_order, description
       FROM permissions 
       WHERE is_active = 1
       ORDER BY category, display_order, name`
    );
    
    // Group by category
    const grouped = {};
    for (const perm of permissions) {
      if (!grouped[perm.category]) {
        grouped[perm.category] = [];
      }
      grouped[perm.category].push(perm);
    }
    
    return { permissions, grouped };
  }

  /**
   * Check if user is a superuser (admin/super_admin)
   */
  async isSuperuser(userId) {
    const pool = getPool();
    
    const [roles] = await pool.query(
      `SELECT r.slug FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE ur.user_id = ? AND ur.is_active = 1`,
      [userId]
    );
    
    return roles.some(r => SUPERUSER_ROLES.includes(r.slug));
  }

  /**
   * Get user's effective permissions (role + individual overrides)
   */
  async getUserPermissions(userId, outletId = null) {
    const pool = getPool();
    
    // Check cache first
    const cacheKey = `${CACHE_KEYS.USER_SESSION}:${userId}:permissions:${outletId || 'all'}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return cached; // cache.get already returns parsed object
    }
    
    // Check if superuser
    const isSuperuser = await this.isSuperuser(userId);
    if (isSuperuser) {
      // Return all permissions
      const { permissions } = await this.getAllPermissions();
      const result = {
        isSuperuser: true,
        permissions: permissions.map(p => p.slug),
        permissionDetails: permissions
      };
      await cache.set(cacheKey, result, 300); // 5 min cache
      return result;
    }
    
    // Get permissions from roles
    let query = `
      SELECT DISTINCT p.id, p.name, p.slug, p.module, p.category
      FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      JOIN user_roles ur ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND ur.is_active = 1 AND p.is_active = 1
    `;
    const params = [userId];
    
    if (outletId) {
      query += ' AND (ur.outlet_id = ? OR ur.outlet_id IS NULL)';
      params.push(outletId);
    }
    
    const [rolePerms] = await pool.query(query, params);
    
    // Get individual user permission overrides
    let overrideQuery = `
      SELECT p.id, p.slug, up.granted
      FROM user_permissions up
      JOIN permissions p ON up.permission_id = p.id
      WHERE up.user_id = ? AND up.is_active = 1
    `;
    const overrideParams = [userId];
    
    if (outletId) {
      overrideQuery += ' AND (up.outlet_id = ? OR up.outlet_id IS NULL)';
      overrideParams.push(outletId);
    }
    
    const [overrides] = await pool.query(overrideQuery, overrideParams);
    
    // Merge: role permissions + grants - revokes
    const permMap = new Map();
    
    // Add role permissions
    for (const p of rolePerms) {
      permMap.set(p.slug, { ...p, granted: true });
    }
    
    // Apply overrides
    for (const o of overrides) {
      if (o.granted) {
        // Grant override
        if (!permMap.has(o.slug)) {
          permMap.set(o.slug, { id: o.id, slug: o.slug, granted: true });
        }
      } else {
        // Revoke override
        permMap.delete(o.slug);
      }
    }
    
    const permissions = Array.from(permMap.keys());
    const permissionDetails = Array.from(permMap.values());
    
    const result = {
      isSuperuser: false,
      permissions,
      permissionDetails
    };
    
    await cache.set(cacheKey, result, 300);
    return result;
  }

  /**
   * Check if user has a specific permission
   */
  async hasPermission(userId, permissionSlug, outletId = null) {
    const userPerms = await this.getUserPermissions(userId, outletId);
    return userPerms.isSuperuser || userPerms.permissions.includes(permissionSlug);
  }

  /**
   * Check if user has any of the specified permissions
   */
  async hasAnyPermission(userId, permissionSlugs, outletId = null) {
    const userPerms = await this.getUserPermissions(userId, outletId);
    if (userPerms.isSuperuser) return true;
    return permissionSlugs.some(slug => userPerms.permissions.includes(slug));
  }

  /**
   * Check if user has all of the specified permissions
   */
  async hasAllPermissions(userId, permissionSlugs, outletId = null) {
    const userPerms = await this.getUserPermissions(userId, outletId);
    if (userPerms.isSuperuser) return true;
    return permissionSlugs.every(slug => userPerms.permissions.includes(slug));
  }

  /**
   * Grant permissions to a user
   * Enforces inheritance rules (Manager can only grant what they have)
   */
  async grantPermissions(targetUserId, permissionSlugs, grantedBy, outletId = null, options = {}) {
    const pool = getPool();
    
    // Validate granter has permission to manage staff
    const granterPerms = await this.getUserPermissions(grantedBy);
    if (!granterPerms.isSuperuser && !granterPerms.permissions.includes('STAFF_PERMISSIONS')) {
      throw new Error('You do not have permission to manage staff permissions');
    }
    
    // Check target user's role
    const targetRoles = await this.getUserRoles(targetUserId);
    const targetIsAdmin = targetRoles.some(r => ADMIN_ONLY_ROLES.includes(r.slug));
    
    // Non-superuser cannot modify admin/manager permissions
    if (!granterPerms.isSuperuser && targetIsAdmin) {
      throw new Error('You cannot modify permissions for admin or manager users');
    }
    
    // Manager can only grant permissions they have
    if (!granterPerms.isSuperuser) {
      const invalidPerms = permissionSlugs.filter(slug => !granterPerms.permissions.includes(slug));
      if (invalidPerms.length > 0) {
        throw new Error(`You cannot grant permissions you don't have: ${invalidPerms.join(', ')}`);
      }
    }
    
    // Get permission IDs
    const [permissions] = await pool.query(
      'SELECT id, slug FROM permissions WHERE slug IN (?) AND is_active = 1',
      [permissionSlugs]
    );
    
    if (permissions.length !== permissionSlugs.length) {
      const found = permissions.map(p => p.slug);
      const notFound = permissionSlugs.filter(s => !found.includes(s));
      throw new Error(`Invalid permissions: ${notFound.join(', ')}`);
    }
    
    // Get old permissions for audit log
    const oldPerms = await this.getUserPermissions(targetUserId, outletId);
    
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      
      const grantedIds = [];
      for (const perm of permissions) {
        // Upsert user permission
        await connection.query(
          `INSERT INTO user_permissions (user_id, permission_id, outlet_id, granted, granted_by, is_active)
           VALUES (?, ?, ?, TRUE, ?, TRUE)
           ON DUPLICATE KEY UPDATE granted = TRUE, granted_by = ?, is_active = TRUE, updated_at = NOW()`,
          [targetUserId, perm.id, outletId, grantedBy, grantedBy]
        );
        grantedIds.push(perm.id);
      }
      
      // Log the change
      await this.logPermissionChange(connection, {
        changedBy: grantedBy,
        targetUserId,
        action: 'grant',
        permissionIds: grantedIds,
        oldPermissions: oldPerms.permissions,
        newPermissions: [...new Set([...oldPerms.permissions, ...permissionSlugs])],
        outletId,
        reason: options.reason,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent
      });
      
      await connection.commit();
      
      // Clear cache
      await this.clearUserPermissionCache(targetUserId);
      
      // Emit realtime event
      await this.emitPermissionUpdate(targetUserId);
      
      logger.info(`Permissions granted to user ${targetUserId} by ${grantedBy}: ${permissionSlugs.join(', ')}`);
      
      return this.getUserPermissions(targetUserId, outletId);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Revoke permissions from a user
   */
  async revokePermissions(targetUserId, permissionSlugs, revokedBy, outletId = null, options = {}) {
    const pool = getPool();
    
    // Validate revoker has permission
    const revokerPerms = await this.getUserPermissions(revokedBy);
    if (!revokerPerms.isSuperuser && !revokerPerms.permissions.includes('STAFF_PERMISSIONS')) {
      throw new Error('You do not have permission to manage staff permissions');
    }
    
    // Check target user's role
    const targetRoles = await this.getUserRoles(targetUserId);
    const targetIsAdmin = targetRoles.some(r => ADMIN_ONLY_ROLES.includes(r.slug));
    
    // Non-superuser cannot modify admin/manager permissions
    if (!revokerPerms.isSuperuser && targetIsAdmin) {
      throw new Error('You cannot modify permissions for admin or manager users');
    }
    
    // Get permission IDs
    const [permissions] = await pool.query(
      'SELECT id, slug FROM permissions WHERE slug IN (?) AND is_active = 1',
      [permissionSlugs]
    );
    
    // Get old permissions for audit log
    const oldPerms = await this.getUserPermissions(targetUserId, outletId);
    
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      
      const revokedIds = [];
      for (const perm of permissions) {
        // Set granted = FALSE (revoke override)
        await connection.query(
          `INSERT INTO user_permissions (user_id, permission_id, outlet_id, granted, granted_by, is_active)
           VALUES (?, ?, ?, FALSE, ?, TRUE)
           ON DUPLICATE KEY UPDATE granted = FALSE, granted_by = ?, is_active = TRUE, updated_at = NOW()`,
          [targetUserId, perm.id, outletId, revokedBy, revokedBy]
        );
        revokedIds.push(perm.id);
      }
      
      // Log the change
      await this.logPermissionChange(connection, {
        changedBy: revokedBy,
        targetUserId,
        action: 'revoke',
        permissionIds: revokedIds,
        oldPermissions: oldPerms.permissions,
        newPermissions: oldPerms.permissions.filter(p => !permissionSlugs.includes(p)),
        outletId,
        reason: options.reason,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent
      });
      
      await connection.commit();
      
      // Clear cache
      await this.clearUserPermissionCache(targetUserId);
      
      // Emit realtime event
      await this.emitPermissionUpdate(targetUserId);
      
      logger.info(`Permissions revoked from user ${targetUserId} by ${revokedBy}: ${permissionSlugs.join(', ')}`);
      
      return this.getUserPermissions(targetUserId, outletId);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Set user permissions (replace all)
   */
  async setUserPermissions(targetUserId, permissionSlugs, setBy, outletId = null, options = {}) {
    const pool = getPool();
    
    // Validate setter has permission
    const setterPerms = await this.getUserPermissions(setBy);
    if (!setterPerms.isSuperuser && !setterPerms.permissions.includes('STAFF_PERMISSIONS')) {
      throw new Error('You do not have permission to manage staff permissions');
    }
    
    // Check target user's role
    const targetRoles = await this.getUserRoles(targetUserId);
    const targetIsAdmin = targetRoles.some(r => ADMIN_ONLY_ROLES.includes(r.slug));
    
    // Non-superuser cannot modify admin/manager permissions
    if (!setterPerms.isSuperuser && targetIsAdmin) {
      throw new Error('You cannot modify permissions for admin or manager users');
    }
    
    // Manager can only set permissions they have
    if (!setterPerms.isSuperuser) {
      const invalidPerms = permissionSlugs.filter(slug => !setterPerms.permissions.includes(slug));
      if (invalidPerms.length > 0) {
        throw new Error(`You cannot grant permissions you don't have: ${invalidPerms.join(', ')}`);
      }
    }
    
    // Get old permissions for audit log
    const oldPerms = await this.getUserPermissions(targetUserId, outletId);
    
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      
      // Clear existing user permissions for this outlet
      await connection.query(
        `DELETE FROM user_permissions WHERE user_id = ? AND (outlet_id = ? OR (outlet_id IS NULL AND ? IS NULL))`,
        [targetUserId, outletId, outletId]
      );
      
      // Get all permission IDs
      const [allPerms] = await connection.query(
        'SELECT id, slug FROM permissions WHERE is_active = 1'
      );
      const permMap = new Map(allPerms.map(p => [p.slug, p.id]));
      
      // Insert new permissions
      const grantedIds = [];
      for (const slug of permissionSlugs) {
        const permId = permMap.get(slug);
        if (permId) {
          await connection.query(
            `INSERT INTO user_permissions (user_id, permission_id, outlet_id, granted, granted_by)
             VALUES (?, ?, ?, TRUE, ?)`,
            [targetUserId, permId, outletId, setBy]
          );
          grantedIds.push(permId);
        }
      }
      
      // Log the change
      await this.logPermissionChange(connection, {
        changedBy: setBy,
        targetUserId,
        action: 'bulk_update',
        permissionIds: grantedIds,
        oldPermissions: oldPerms.permissions,
        newPermissions: permissionSlugs,
        outletId,
        reason: options.reason,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent
      });
      
      await connection.commit();
      
      // Clear cache
      await this.clearUserPermissionCache(targetUserId);
      
      // Emit realtime event
      await this.emitPermissionUpdate(targetUserId);
      
      logger.info(`Permissions set for user ${targetUserId} by ${setBy}: ${permissionSlugs.length} permissions`);
      
      return this.getUserPermissions(targetUserId, outletId);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Get user's roles
   */
  async getUserRoles(userId) {
    const pool = getPool();
    const [roles] = await pool.query(
      `SELECT r.id, r.name, r.slug, ur.outlet_id
       FROM roles r
       JOIN user_roles ur ON r.id = ur.role_id
       WHERE ur.user_id = ? AND ur.is_active = 1`,
      [userId]
    );
    return roles;
  }

  /**
   * Get role's default permissions
   */
  async getRolePermissions(roleId) {
    const pool = getPool();
    const [permissions] = await pool.query(
      `SELECT p.id, p.name, p.slug, p.module, p.category
       FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       WHERE rp.role_id = ? AND p.is_active = 1
       ORDER BY p.category, p.display_order`,
      [roleId]
    );
    return permissions;
  }

  /**
   * Log permission change for audit
   */
  async logPermissionChange(connection, data) {
    await connection.query(
      `INSERT INTO permission_logs 
       (changed_by, target_user_id, action, permission_ids, old_permissions, new_permissions, outlet_id, reason, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.changedBy,
        data.targetUserId,
        data.action,
        JSON.stringify(data.permissionIds),
        JSON.stringify(data.oldPermissions),
        JSON.stringify(data.newPermissions),
        data.outletId,
        data.reason || null,
        data.ipAddress || null,
        data.userAgent || null
      ]
    );
  }

  /**
   * Get permission change history for a user
   */
  async getPermissionHistory(userId, limit = 50) {
    const pool = getPool();
    const [logs] = await pool.query(
      `SELECT pl.*, u.name as changed_by_name
       FROM permission_logs pl
       LEFT JOIN users u ON pl.changed_by = u.id
       WHERE pl.target_user_id = ?
       ORDER BY pl.created_at DESC
       LIMIT ?`,
      [userId, limit]
    );
    return logs;
  }

  /**
   * Clear user permission cache
   */
  async clearUserPermissionCache(userId) {
    // Clear permission cache pattern - using delPattern
    await cache.delPattern(`${userId}:permissions:*`);
  }

  /**
   * Emit realtime permission update event
   */
  async emitPermissionUpdate(userId) {
    // This will be handled by Socket.IO in the socket service
    // For now, just log it - the socket integration will be added
    logger.info(`Permission update event for user ${userId}`);
    
    // If socket.io is available, emit the event
    try {
      const io = require('../socket').getIO();
      if (io) {
        io.to(`user:${userId}`).emit('permissions.updated', {
          userId,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      // Socket not initialized yet, skip
    }
  }

  /**
   * Get permissions available for a granter to assign
   * (Only permissions the granter has)
   */
  async getGrantablePermissions(granterId, outletId = null) {
    const granterPerms = await this.getUserPermissions(granterId, outletId);
    
    if (granterPerms.isSuperuser) {
      // Superuser can grant all
      return this.getAllPermissions();
    }
    
    // Return only permissions the granter has
    const { grouped } = await this.getAllPermissions();
    
    const grantable = {};
    for (const [category, perms] of Object.entries(grouped)) {
      const available = perms.filter(p => granterPerms.permissions.includes(p.slug));
      if (available.length > 0) {
        grantable[category] = available;
      }
    }
    
    return {
      permissions: granterPerms.permissionDetails,
      grouped: grantable
    };
  }
}

module.exports = new PermissionService();
