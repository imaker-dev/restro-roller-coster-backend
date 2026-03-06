const { getPool } = require('../database');
const authService = require('./auth.service');
const logger = require('../utils/logger');
const { cache } = require('../config/redis');
const { CACHE_KEYS } = require('../constants');
const { v4: uuidv4 } = require('uuid');

// Roles that only admin can manage (manager cannot create/update/delete these)
const ADMIN_ONLY_ROLES = ['super_admin', 'admin', 'manager'];

// Staff roles that manager can manage
const STAFF_ROLES = ['captain', 'waiter', 'bartender', 'kitchen', 'cashier', 'inventory'];

class UserService {
  /**
   * Check if the requesting user is a manager (not admin)
   */
  async isManagerOnly(userId) {
    const pool = getPool();
    const [roles] = await pool.query(
      `SELECT r.slug FROM user_roles ur 
       JOIN roles r ON ur.role_id = r.id 
       WHERE ur.user_id = ? AND ur.is_active = 1`,
      [userId]
    );
    
    const userRoles = roles.map(r => r.slug);
    // If user has super_admin or admin role, they are NOT manager-only
    if (userRoles.includes('super_admin') || userRoles.includes('admin')) {
      return false;
    }
    // If user has manager role but not admin, they are manager-only
    return userRoles.includes('manager');
  }

  /**
   * Check if target roles include admin-level roles
   */
  async containsAdminRoles(roleIds) {
    if (!roleIds || roleIds.length === 0) return false;
    
    const pool = getPool();
    const [roles] = await pool.query(
      `SELECT slug FROM roles WHERE id IN (?)`,
      [roleIds]
    );
    
    return roles.some(r => ADMIN_ONLY_ROLES.includes(r.slug));
  }

  /**
   * Check if a user has admin-level roles
   */
  async userHasAdminRoles(userId) {
    const pool = getPool();
    const [roles] = await pool.query(
      `SELECT r.slug FROM user_roles ur 
       JOIN roles r ON ur.role_id = r.id 
       WHERE ur.user_id = ? AND ur.is_active = 1`,
      [userId]
    );
    
    return roles.some(r => ADMIN_ONLY_ROLES.includes(r.slug));
  }

  /**
   * Get all users with pagination and filters
   * Outlet-wise filtering based on userContext:
   * - super_admin: sees all users
   * - admin/manager with outlet: sees users assigned to their outlet
   * - admin/manager without outlet: sees only users without outlet assignments
   */
  async getUsers(options = {}, userContext = null) {
    const pool = getPool();
    const {
      page = 1,
      limit = 20,
      search = '',
      roleId = null,
      outletId = null,
      isActive = null,
      sortBy = 'created_at',
      sortOrder = 'DESC',
    } = options;

    const offset = (page - 1) * limit;
    const params = [];
    let whereClause = 'WHERE u.deleted_at IS NULL';

    // Outlet-wise filtering based on user's role and outlet access
    let effectiveOutletId = outletId; // Query param takes precedence if super_admin
    
    if (userContext) {
      const isSuperAdmin = userContext.roles.includes('super_admin');
      
      if (!isSuperAdmin) {
        // Non-super_admin users can only see users from their outlet
        if (userContext.outletId) {
          // Admin/manager with outlet: filter by their outlet
          effectiveOutletId = userContext.outletId;
        } else {
          // Admin without outlet: can only see users without outlet assignments
          whereClause += ' AND (ur.outlet_id IS NULL OR ur.id IS NULL)';
        }
      }
      // super_admin: no automatic filtering, can use query param or see all
    }

    if (search) {
      whereClause += ' AND (u.name LIKE ? OR u.email LIKE ? OR u.employee_code LIKE ? OR u.phone LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    if (isActive !== null) {
      whereClause += ' AND u.is_active = ?';
      params.push(isActive);
    }

    if (roleId) {
      whereClause += ' AND ur.role_id = ?';
      params.push(roleId);
    }

    if (effectiveOutletId) {
      // ONLY show users assigned to this specific outlet (not NULL outlet users)
      whereClause += ' AND ur.outlet_id = ?';
      params.push(effectiveOutletId);
    }

    // Get total count
    const [countResult] = await pool.query(
      `SELECT COUNT(DISTINCT u.id) as total
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id AND ur.is_active = 1
       ${whereClause}`,
      params
    );

    const total = countResult[0].total;

    // Get users with roles
    const allowedSortColumns = ['name', 'email', 'employee_code', 'created_at', 'last_login_at'];
    const sortColumn = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const [users] = await pool.query(
      `SELECT u.id, u.uuid, u.employee_code, u.name, u.email, u.phone, 
              u.avatar_url, u.is_active, u.is_verified, u.last_login_at, u.created_at,
              GROUP_CONCAT(DISTINCT r.name) as role_names,
              GROUP_CONCAT(DISTINCT r.slug) as role_slugs
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id AND ur.is_active = 1
       LEFT JOIN roles r ON ur.role_id = r.id AND r.is_active = 1
       ${whereClause}
       GROUP BY u.id
       ORDER BY u.${sortColumn} ${order}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Get station assignments for all users in one query (primary station only)
    const userIds = users.map(u => u.id);
    let stationMap = {};
    if (userIds.length > 0) {
      const [stations] = await pool.query(
        `SELECT us.user_id, us.station_id, us.is_primary,
                ks.name as station_name, ks.code as station_code, ks.station_type,
                us.outlet_id
         FROM user_stations us
         JOIN kitchen_stations ks ON us.station_id = ks.id
         WHERE us.user_id IN (?) AND us.is_active = 1
         ORDER BY us.is_primary DESC`,
        [userIds]
      );
      for (const s of stations) {
        // Only store the first (primary) station per user
        if (!stationMap[s.user_id]) {
          stationMap[s.user_id] = {
            stationId: s.station_id,
            stationName: s.station_name,
            stationCode: s.station_code,
            stationType: s.station_type,
            outletId: s.outlet_id,
            isPrimary: Boolean(s.is_primary)
          };
        }
      }
    }

    return {
      data: users.map(u => ({
        ...this.formatUser(u),
        station: stationMap[u.id] || null
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get single user by ID
   */
  async getUserById(id) {
    const pool = getPool();

    const [users] = await pool.query(
      `SELECT u.id, u.uuid, u.employee_code, u.name, u.email, u.phone, 
              u.avatar_url, u.is_active, u.is_verified, u.last_login_at, 
              u.created_at, u.created_by, u.updated_at, u.updated_by
       FROM users u
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [id]
    );

    if (users.length === 0) {
      throw new Error('User not found');
    }

    const user = users[0];

    // Get roles with outlet info
    const [roles] = await pool.query(
      `SELECT ur.id as user_role_id, r.id, r.name, r.slug, ur.outlet_id, 
              o.name as outlet_name, ur.assigned_at, ur.expires_at
       FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       LEFT JOIN outlets o ON ur.outlet_id = o.id
       WHERE ur.user_id = ? AND ur.is_active = 1`,
      [id]
    );

    // Get permissions from roles
    const [permissions] = await pool.query(
      `SELECT DISTINCT p.slug, p.name, p.module, p.category
       FROM user_roles ur
       JOIN role_permissions rp ON ur.role_id = rp.role_id
       JOIN permissions p ON rp.permission_id = p.id
       WHERE ur.user_id = ? AND ur.is_active = 1 AND p.is_active = 1
       ORDER BY p.category, p.display_order`,
      [id]
    );

    // Get floor and section assignments
    const assignedFloors = await this.getUserFloors(id);
    const assignedSections = await this.getUserSections(id);
    
    // Get station assignment (primary station only)
    const stations = await this.getUserStations(id);
    const assignedStation = stations.find(s => s.isPrimary) || stations[0] || null;

    return {
      ...this.formatUser(user),
      roles: roles.map(r => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        outletId: r.outlet_id,
        outletName: r.outlet_name,
        assignedAt: r.assigned_at,
        expiresAt: r.expires_at,
      })),
      permissions: permissions.map(p => p.slug),
      permissionCount: permissions.length,
      assignedFloors,
      assignedSections,
      assignedStation,
    };
  }

  /**
   * Create new user
   */
  async createUser(data, createdBy) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Check if manager is trying to create admin-level users
      const isManager = await this.isManagerOnly(createdBy);
      if (isManager && data.roles && data.roles.length > 0) {
        const roleIds = data.roles.map(r => r.roleId);
        const hasAdminRoles = await this.containsAdminRoles(roleIds);
        if (hasAdminRoles) {
          throw new Error('Managers can only create staff users (captain, waiter, bartender, kitchen, cashier)');
        }
      }

      // Check for duplicate email
      if (data.email) {
        const [existing] = await connection.query(
          'SELECT id FROM users WHERE email = ? AND deleted_at IS NULL',
          [data.email.toLowerCase()]
        );
        if (existing.length > 0) {
          throw new Error('Email already exists');
        }
      }

      // Check for duplicate employee code
      if (data.employeeCode) {
        const [existing] = await connection.query(
          'SELECT id FROM users WHERE employee_code = ? AND deleted_at IS NULL',
          [data.employeeCode]
        );
        if (existing.length > 0) {
          throw new Error('Employee code already exists');
        }
      }

      // Generate employee code if not provided
      const employeeCode = data.employeeCode || await this.generateEmployeeCode(connection);

      // Hash password and PIN
      const passwordHash = data.password ? await authService.hashPassword(data.password) : null;
      const pinHash = data.pin ? await authService.hashPin(data.pin) : null;

      const uuid = uuidv4();

      // Insert user
      const [result] = await connection.query(
        `INSERT INTO users 
         (uuid, employee_code, name, email, phone, password_hash, pin_hash, 
          avatar_url, is_active, is_verified, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid,
          employeeCode,
          data.name,
          data.email?.toLowerCase() || null,
          data.phone || null,
          passwordHash,
          pinHash,
          data.avatarUrl || null,
          data.isActive !== false,
          data.isVerified || false,
          createdBy,
        ]
      );

      const userId = result.insertId;

      // Assign roles
      if (data.roles && data.roles.length > 0) {
        for (const role of data.roles) {
          await connection.query(
            `INSERT INTO user_roles (user_id, role_id, outlet_id, assigned_by)
             VALUES (?, ?, ?, ?)`,
            [userId, role.roleId, role.outletId || null, createdBy]
          );
        }
      }

      // Assign floors
      if (data.floors && data.floors.length > 0) {
        for (const floor of data.floors) {
          await connection.query(
            `INSERT INTO user_floors (user_id, floor_id, outlet_id, is_primary, assigned_by)
             VALUES (?, ?, ?, ?, ?)`,
            [userId, floor.floorId, floor.outletId, floor.isPrimary || false, createdBy]
          );
        }
      }

      // Assign sections
      if (data.sections && data.sections.length > 0) {
        for (const section of data.sections) {
          await connection.query(
            `INSERT INTO user_sections (user_id, section_id, outlet_id, can_view_menu, can_take_orders, is_primary, assigned_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, section.sectionId, section.outletId, section.canViewMenu !== false, section.canTakeOrders !== false, section.isPrimary || false, createdBy]
          );
        }
      }

      await connection.commit();

      logger.info(`User created: ${userId} by ${createdBy}`);

      return this.getUserById(userId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Update user
   */
  async updateUser(id, data, updatedBy) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Check if manager is trying to update admin-level users
      const isManager = await this.isManagerOnly(updatedBy);
      if (isManager) {
        const targetHasAdminRoles = await this.userHasAdminRoles(id);
        if (targetHasAdminRoles) {
          throw new Error('Managers cannot update admin or manager users');
        }
      }
      
      // Check if manager is trying to assign admin-level roles
      if (isManager && data.roles && data.roles.length > 0) {
        const roleIds = data.roles.map(r => r.id);
        const hasAdminRoles = await this.containsAdminRoles(roleIds);
        if (hasAdminRoles) {
          throw new Error('Managers can only assign staff roles (captain, waiter, bartender, kitchen, cashier)');
        }
      }

      // Check user exists
      const [users] = await connection.query(
        'SELECT id, email, employee_code FROM users WHERE id = ? AND deleted_at IS NULL',
        [id]
      );

      if (users.length === 0) {
        throw new Error('User not found');
      }

      const user = users[0];

      // Check for duplicate email
      if (data.email && data.email.toLowerCase() !== user.email) {
        const [existing] = await connection.query(
          'SELECT id FROM users WHERE email = ? AND id != ? AND deleted_at IS NULL',
          [data.email.toLowerCase(), id]
        );
        if (existing.length > 0) {
          throw new Error('Email already exists');
        }
      }

      // Check for duplicate employee code
      if (data.employeeCode && data.employeeCode !== user.employee_code) {
        const [existing] = await connection.query(
          'SELECT id FROM users WHERE employee_code = ? AND id != ? AND deleted_at IS NULL',
          [data.employeeCode, id]
        );
        if (existing.length > 0) {
          throw new Error('Employee code already exists');
        }
      }

      // Build update query
      const updates = [];
      const params = [];

      if (data.name !== undefined) {
        updates.push('name = ?');
        params.push(data.name);
      }
      if (data.email !== undefined) {
        updates.push('email = ?');
        params.push(data.email?.toLowerCase() || null);
      }
      if (data.phone !== undefined) {
        updates.push('phone = ?');
        params.push(data.phone);
      }
      if (data.employeeCode !== undefined) {
        updates.push('employee_code = ?');
        params.push(data.employeeCode);
      }
      if (data.avatarUrl !== undefined) {
        updates.push('avatar_url = ?');
        params.push(data.avatarUrl);
      }
      if (data.isActive !== undefined) {
        updates.push('is_active = ?');
        params.push(data.isActive);
      }
      if (data.isVerified !== undefined) {
        updates.push('is_verified = ?');
        params.push(data.isVerified);
      }
      if (data.password) {
        updates.push('password_hash = ?');
        params.push(await authService.hashPassword(data.password));
      }
      if (data.pin) {
        updates.push('pin_hash = ?');
        params.push(await authService.hashPin(data.pin));
      }

      if (updates.length > 0) {
        updates.push('updated_by = ?', 'updated_at = NOW()');
        params.push(updatedBy, id);

        await connection.query(
          `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
          params
        );
      }

      // Update floor assignments if provided
      if (data.floors !== undefined) {
        // Remove existing floor assignments for this user
        await connection.query('DELETE FROM user_floors WHERE user_id = ?', [id]);
        // Insert new floor assignments
        if (data.floors && data.floors.length > 0) {
          for (const floor of data.floors) {
            await connection.query(
              `INSERT INTO user_floors (user_id, floor_id, outlet_id, is_primary, assigned_by)
               VALUES (?, ?, ?, ?, ?)`,
              [id, floor.floorId, floor.outletId, floor.isPrimary || false, updatedBy]
            );
          }
        }
      }

      // Update role assignments if provided
      if (data.roles !== undefined) {
        // Remove existing role assignments for this user
        await connection.query('DELETE FROM user_roles WHERE user_id = ?', [id]);
        // Insert new role assignments
        if (data.roles && data.roles.length > 0) {
          for (const role of data.roles) {
            await connection.query(
              `INSERT INTO user_roles (user_id, role_id, outlet_id, assigned_by)
               VALUES (?, ?, ?, ?)`,
              [id, role.id, role.outletId || null, updatedBy]
            );
          }
        }
      }

      // Update section assignments if provided
      if (data.sections !== undefined) {
        await connection.query('DELETE FROM user_sections WHERE user_id = ?', [id]);
        if (data.sections && data.sections.length > 0) {
          for (const section of data.sections) {
            await connection.query(
              `INSERT INTO user_sections (user_id, section_id, outlet_id, can_view_menu, can_take_orders, is_primary, assigned_by)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [id, section.sectionId, section.outletId, section.canViewMenu !== false, section.canTakeOrders !== false, section.isPrimary || false, updatedBy]
            );
          }
        }
      }

      await connection.commit();

      // Clear cache
      await cache.del(`${CACHE_KEYS.USER_SESSION}:${id}`);

      logger.info(`User updated: ${id} by ${updatedBy}`);

      return this.getUserById(id);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Delete user (soft delete)
   */
  async deleteUser(id, deletedBy) {
    const pool = getPool();

    // Prevent deleting self
    if (id === deletedBy) {
      throw new Error('Cannot delete your own account');
    }

    // Check if manager is trying to delete admin-level users
    const isManager = await this.isManagerOnly(deletedBy);
    if (isManager) {
      const targetHasAdminRoles = await this.userHasAdminRoles(id);
      if (targetHasAdminRoles) {
        throw new Error('Managers cannot delete admin or manager users');
      }
    }

    const [result] = await pool.query(
      `UPDATE users 
       SET deleted_at = NOW(), updated_by = ?, is_active = 0
       WHERE id = ? AND deleted_at IS NULL`,
      [deletedBy, id]
    );

    if (result.affectedRows === 0) {
      throw new Error('User not found');
    }

    // Revoke all sessions
    await pool.query(
      `UPDATE user_sessions 
       SET is_revoked = 1, revoked_at = NOW(), revoked_reason = 'user_deleted'
       WHERE user_id = ?`,
      [id]
    );

    // Clear cache
    await cache.del(`${CACHE_KEYS.USER_SESSION}:${id}`);

    logger.info(`User deleted: ${id} by ${deletedBy}`);

    return { message: 'User deleted successfully' };
  }

  /**
   * Assign role to user
   */
  async assignRole(userId, roleId, outletId, assignedBy) {
    const pool = getPool();

    // Check if manager is trying to assign admin-level roles
    const isManager = await this.isManagerOnly(assignedBy);
    if (isManager) {
      const hasAdminRoles = await this.containsAdminRoles([roleId]);
      if (hasAdminRoles) {
        throw new Error('Managers can only assign staff roles (captain, waiter, bartender, kitchen, cashier)');
      }
    }

    // Check if assignment already exists
    const [existing] = await pool.query(
      `SELECT id, is_active FROM user_roles 
       WHERE user_id = ? AND role_id = ? AND (outlet_id = ? OR (outlet_id IS NULL AND ? IS NULL))`,
      [userId, roleId, outletId, outletId]
    );

    if (existing.length > 0) {
      if (existing[0].is_active) {
        throw new Error('Role already assigned');
      }
      // Reactivate existing assignment
      await pool.query(
        'UPDATE user_roles SET is_active = 1, assigned_by = ?, assigned_at = NOW() WHERE id = ?',
        [assignedBy, existing[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id, outlet_id, assigned_by)
         VALUES (?, ?, ?, ?)`,
        [userId, roleId, outletId, assignedBy]
      );
    }

    await cache.del(`${CACHE_KEYS.USER_SESSION}:${userId}`);

    logger.info(`Role ${roleId} assigned to user ${userId} by ${assignedBy}`);

    return this.getUserById(userId);
  }

  /**
   * Remove role from user
   */
  async removeRole(userId, roleId, outletId, removedBy) {
    const pool = getPool();

    // Check if manager is trying to remove admin-level roles
    const isManager = await this.isManagerOnly(removedBy);
    if (isManager) {
      const hasAdminRoles = await this.containsAdminRoles([roleId]);
      if (hasAdminRoles) {
        throw new Error('Managers can only remove staff roles (captain, waiter, bartender, kitchen, cashier)');
      }
    }

    const [result] = await pool.query(
      `UPDATE user_roles 
       SET is_active = 0 
       WHERE user_id = ? AND role_id = ? AND (outlet_id = ? OR (outlet_id IS NULL AND ? IS NULL))`,
      [userId, roleId, outletId, outletId]
    );

    if (result.affectedRows === 0) {
      throw new Error('Role assignment not found');
    }

    await cache.del(`${CACHE_KEYS.USER_SESSION}:${userId}`);

    logger.info(`Role ${roleId} removed from user ${userId} by ${removedBy}`);

    return this.getUserById(userId);
  }

  /**
   * Get user's default outlet ID from their roles
   * Returns the first outlet_id found in user's active roles
   */
  async getUserOutletId(userId) {
    const pool = getPool();
    
    const [result] = await pool.query(
      `SELECT ur.outlet_id 
       FROM user_roles ur
       WHERE ur.user_id = ? AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
       ORDER BY ur.assigned_at DESC
       LIMIT 1`,
      [userId]
    );
    
    return result.length > 0 ? result[0].outlet_id : null;
  }

  /**
   * Get all roles (filtered by requester's role)
   * Role Hierarchy - users can only see roles BELOW them:
   * - super_admin sees: admin, manager, staff roles
   * - admin sees: manager, staff roles (NOT admin or super_admin)
   * - manager sees: only staff roles
   */
  async getRoles(requesterRole) {
    const pool = getPool();

    // Define role hierarchy
    const STAFF_ROLES = ['captain', 'waiter', 'bartender', 'kitchen', 'cashier', 'inventory'];

    const [allRoles] = await pool.query(
      `SELECT id, name, slug, description, is_system_role, is_active, priority
       FROM roles
       WHERE is_active = 1
       ORDER BY priority DESC, name ASC`
    );

    // Determine which roles the requester can SEE and MANAGE
    // Users can only see roles BELOW their level
    let visibleRoleSlugs = [];
    let manageableRoles = [];

    if (requesterRole === 'super_admin') {
      // Super admin can see and manage: admin, manager, staff
      visibleRoleSlugs = ['admin', 'manager', ...STAFF_ROLES];
      manageableRoles = ['admin', 'manager', ...STAFF_ROLES];
    } else if (requesterRole === 'admin') {
      // Admin can see and manage: manager, staff (NOT admin or super_admin)
      visibleRoleSlugs = ['manager', ...STAFF_ROLES];
      manageableRoles = ['manager', ...STAFF_ROLES];
    } else if (requesterRole === 'manager') {
      // Manager can see and manage: only staff roles
      visibleRoleSlugs = STAFF_ROLES;
      manageableRoles = STAFF_ROLES;
    } else {
      // Staff roles see nothing
      visibleRoleSlugs = [];
      manageableRoles = [];
    }

    // Filter roles to only show visible ones
    const visibleRoles = allRoles
      .filter(role => visibleRoleSlugs.includes(role.slug))
      .map(role => ({
        ...role,
        category: ['super_admin', 'admin', 'manager'].includes(role.slug) ? 'admin' : 'staff',
        canManage: manageableRoles.includes(role.slug)
      }));

    return {
      roles: visibleRoles,
      hierarchy: {
        staffRoles: STAFF_ROLES,
        requesterRole,
        visibleRoles: visibleRoleSlugs,
        canManageRoles: manageableRoles
      }
    };
  }

  /**
   * Get role with permissions
   */
  async getRoleById(id) {
    const pool = getPool();

    const [roles] = await pool.query(
      'SELECT * FROM roles WHERE id = ?',
      [id]
    );

    if (roles.length === 0) {
      throw new Error('Role not found');
    }

    const [permissions] = await pool.query(
      `SELECT p.id, p.name, p.slug, p.module, p.description
       FROM role_permissions rp
       JOIN permissions p ON rp.permission_id = p.id
       WHERE rp.role_id = ?
       ORDER BY p.module, p.name`,
      [id]
    );

    return {
      ...roles[0],
      permissions,
    };
  }

  /**
   * Get all permissions grouped by module
   */
  async getPermissions() {
    const pool = getPool();

    const [permissions] = await pool.query(
      `SELECT id, name, slug, module, description
       FROM permissions
       ORDER BY module, name`
    );

    // Group by module
    const grouped = permissions.reduce((acc, p) => {
      if (!acc[p.module]) {
        acc[p.module] = [];
      }
      acc[p.module].push(p);
      return acc;
    }, {});

    return {
      all: permissions,
      byModule: grouped,
    };
  }

  /**
   * Get assigned floors for a user (optionally filtered by outlet)
   */
  async getUserFloors(userId, outletId = null) {
    const pool = getPool();
    let query = `SELECT uf.id, uf.floor_id, uf.outlet_id, uf.is_primary, uf.is_active,
                        f.name as floor_name, f.floor_number, f.code as floor_code,
                        o.name as outlet_name
                 FROM user_floors uf
                 JOIN floors f ON uf.floor_id = f.id
                 LEFT JOIN outlets o ON uf.outlet_id = o.id
                 WHERE uf.user_id = ? AND uf.is_active = 1`;
    const params = [userId];
    if (outletId) {
      query += ' AND uf.outlet_id = ?';
      params.push(outletId);
    }
    query += ' ORDER BY uf.is_primary DESC, f.display_order, f.floor_number';
    const [rows] = await pool.query(query, params);
    return rows.map(r => ({
      id: r.id,
      floorId: r.floor_id,
      floorName: r.floor_name,
      floorNumber: r.floor_number,
      floorCode: r.floor_code,
      outletId: r.outlet_id,
      outletName: r.outlet_name,
      isPrimary: !!r.is_primary,
    }));
  }

  /**
   * Get assigned sections for a user (optionally filtered by outlet)
   */
  async getUserSections(userId, outletId = null) {
    const pool = getPool();
    let query = `SELECT us.id, us.section_id, us.outlet_id, us.is_primary, us.can_view_menu, us.can_take_orders,
                        s.name as section_name, s.section_type,
                        o.name as outlet_name
                 FROM user_sections us
                 JOIN sections s ON us.section_id = s.id
                 LEFT JOIN outlets o ON us.outlet_id = o.id
                 WHERE us.user_id = ? AND us.is_active = 1`;
    const params = [userId];
    if (outletId) {
      query += ' AND us.outlet_id = ?';
      params.push(outletId);
    }
    query += ' ORDER BY us.is_primary DESC, s.name';
    const [rows] = await pool.query(query, params);
    return rows.map(r => ({
      id: r.id,
      sectionId: r.section_id,
      sectionName: r.section_name,
      sectionType: r.section_type,
      outletId: r.outlet_id,
      outletName: r.outlet_name,
      isPrimary: !!r.is_primary,
      canViewMenu: !!r.can_view_menu,
      canTakeOrders: !!r.can_take_orders,
    }));
  }

  // ==================== Helper Methods ====================

  async generateEmployeeCode(connection) {
    const [result] = await connection.query(
      "SELECT MAX(CAST(SUBSTRING(employee_code, 4) AS UNSIGNED)) as maxCode FROM users WHERE employee_code LIKE 'EMP%'"
    );
    const nextNum = (result[0].maxCode || 0) + 1;
    return `EMP${String(nextNum).padStart(4, '0')}`;
  }

  // =====================================================
  // USER STATION METHODS (for kitchen/bar staff)
  // =====================================================

  /**
   * Get user's assigned stations with printer info
   */
  async getUserStations(userId, outletId = null) {
    const pool = getPool();
    let query = `
      SELECT us.id, us.station_id, us.outlet_id, us.is_primary, us.is_active,
             ks.name as station_name, ks.code as station_code, ks.station_type,
             ks.printer_id,
             p.name as printer_name, p.ip_address as printer_ip, p.port as printer_port,
             p.station as printer_station,
             o.name as outlet_name
      FROM user_stations us
      JOIN kitchen_stations ks ON us.station_id = ks.id
      LEFT JOIN printers p ON ks.printer_id = p.id
      LEFT JOIN outlets o ON us.outlet_id = o.id
      WHERE us.user_id = ? AND us.is_active = 1
    `;
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
      isPrimary: Boolean(r.is_primary),
      printer: r.printer_id ? {
        id: r.printer_id,
        name: r.printer_name,
        ip: r.printer_ip,
        port: r.printer_port,
        station: r.printer_station
      } : null
    }));
  }

  /**
   * Assign station to user
   */
  async assignStation(userId, stationId, outletId, assignedBy, isPrimary = false) {
    const pool = getPool();
    
    // Verify station exists and belongs to outlet
    const [station] = await pool.query(
      'SELECT id FROM kitchen_stations WHERE id = ? AND outlet_id = ? AND is_active = 1',
      [stationId, outletId]
    );
    if (!station.length) {
      throw new Error('Station not found or not active in this outlet');
    }

    // If setting as primary, unset other primaries for this user in this outlet
    if (isPrimary) {
      await pool.query(
        'UPDATE user_stations SET is_primary = 0 WHERE user_id = ? AND outlet_id = ?',
        [userId, outletId]
      );
    }

    // Insert or update
    await pool.query(
      `INSERT INTO user_stations (user_id, station_id, outlet_id, is_primary, assigned_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_primary = VALUES(is_primary), is_active = 1, assigned_by = VALUES(assigned_by)`,
      [userId, stationId, outletId, isPrimary ? 1 : 0, assignedBy]
    );

    return this.getUserStations(userId, outletId);
  }

  /**
   * Remove station from user
   */
  async removeStation(userId, stationId) {
    const pool = getPool();
    await pool.query(
      'UPDATE user_stations SET is_active = 0 WHERE user_id = ? AND station_id = ?',
      [userId, stationId]
    );
    return { success: true };
  }

  /**
   * Get station's printer for a user role
   * Used when kitchen/bar user needs to know which printer to use
   */
  async getStationPrinterForUser(userId, outletId) {
    const pool = getPool();
    
    // Get user's primary station with printer
    const [rows] = await pool.query(`
      SELECT p.id, p.name, p.ip_address, p.port, p.station, p.printer_type
      FROM user_stations us
      JOIN kitchen_stations ks ON us.station_id = ks.id
      JOIN printers p ON ks.printer_id = p.id
      WHERE us.user_id = ? AND us.outlet_id = ? AND us.is_active = 1
      ORDER BY us.is_primary DESC
      LIMIT 1
    `, [userId, outletId]);

    if (rows.length) {
      return {
        printerId: rows[0].id,
        printerName: rows[0].name,
        printerIp: rows[0].ip_address,
        printerPort: rows[0].port,
        printerStation: rows[0].station,
        printerType: rows[0].printer_type
      };
    }

    // Fallback: get printer by role-station mapping
    const [userRoles] = await pool.query(`
      SELECT r.slug FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = ? AND ur.is_active = 1
    `, [userId]);

    const roleSlug = userRoles[0]?.slug;
    let stationFilter = 'kot_kitchen';
    if (roleSlug === 'bartender') stationFilter = 'kot_bar';
    else if (roleSlug === 'cashier') stationFilter = 'bill';

    const [printers] = await pool.query(`
      SELECT id, name, ip_address, port, station, printer_type
      FROM printers WHERE outlet_id = ? AND station = ? AND is_active = 1 LIMIT 1
    `, [outletId, stationFilter]);

    if (printers.length) {
      return {
        printerId: printers[0].id,
        printerName: printers[0].name,
        printerIp: printers[0].ip_address,
        printerPort: printers[0].port,
        printerStation: printers[0].station,
        printerType: printers[0].printer_type
      };
    }

    return null;
  }

  formatUser(user) {
    return {
      id: user.id,
      uuid: user.uuid,
      employeeCode: user.employee_code,
      name: user.name,
      email: user.email,
      phone: user.phone,
      avatarUrl: user.avatar_url,
      isActive: Boolean(user.is_active),
      isVerified: Boolean(user.is_verified),
      lastLoginAt: user.last_login_at,
      createdAt: user.created_at,
      roles: user.role_names ? user.role_names.split(',') : [],
      roleSlugs: user.role_slugs ? user.role_slugs.split(',') : [],
    };
  }
}

module.exports = new UserService();
