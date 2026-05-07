const userService = require('../services/user.service');
const { getSuperAdminOutletIds } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * GET /api/v1/users
 * Get all users with pagination and filters
 * Outlet-wise: super_admin sees only their own outlets' users
 */
const getUsers = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const roles  = req.user.roles || [];

    // If a specific outletId is requested, verify super_admin owns it
    const requestedOutletId = req.query.outletId ? parseInt(req.query.outletId, 10) : null;
    if (requestedOutletId) {
      const allowedOutletIds = await getSuperAdminOutletIds(userId, roles);
      if (allowedOutletIds !== null && !allowedOutletIds.includes(requestedOutletId)) {
        return res.status(403).json({ success: false, message: 'You do not have access to this outlet' });
      }
    }

    const userContext = {
      userId,
      roles,
      outletId: req.user.outletId,
    };

    const result = await userService.getUsers(req.query, userContext);

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Get users failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/users/:id
 * Get single user by ID
 */
const getUserById = async (req, res, next) => {
  try {
    const user = await userService.getUserById(parseInt(req.params.id, 10));

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    if (error.message === 'User not found') {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Get user failed:', error);
    next(error);
  }
};

/**
 * POST /api/v1/users
 * Create new user
 */
const createUser = async (req, res, next) => {
  try {
    const user = await userService.createUser(req.body, req.user.userId);

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: user,
    });
  } catch (error) {
    if (error.message.includes('already exists')) {
      return res.status(409).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Create user failed:', error);
    next(error);
  }
};

/**
 * PUT /api/v1/users/:id
 * Update user
 */
const updateUser = async (req, res, next) => {
  try {
    const user = await userService.updateUser(
      parseInt(req.params.id, 10),
      req.body,
      req.user.userId
    );

    res.status(200).json({
      success: true,
      message: 'User updated successfully',
      data: user,
    });
  } catch (error) {
    if (error.message === 'User not found') {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }
    if (error.message.includes('already exists')) {
      return res.status(409).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Update user failed:', error);
    next(error);
  }
};

/**
 * DELETE /api/v1/users/:id
 * Delete user (soft delete)
 */
const deleteUser = async (req, res, next) => {
  try {
    const result = await userService.deleteUser(
      parseInt(req.params.id, 10),
      req.user.userId
    );

    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    if (error.message === 'User not found') {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }
    if (error.message.includes('Cannot delete')) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Delete user failed:', error);
    next(error);
  }
};

/**
 * POST /api/v1/users/:id/roles
 * Assign role to user
 */
const assignRole = async (req, res, next) => {
  try {
    const { roleId, outletId } = req.body;
    const user = await userService.assignRole(
      parseInt(req.params.id, 10),
      roleId,
      outletId || null,
      req.user.userId
    );

    res.status(200).json({
      success: true,
      message: 'Role assigned successfully',
      data: user,
    });
  } catch (error) {
    if (error.message === 'Role already assigned') {
      return res.status(409).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Assign role failed:', error);
    next(error);
  }
};

/**
 * DELETE /api/v1/users/:id/roles
 * Remove role from user
 */
const removeRole = async (req, res, next) => {
  try {
    const { roleId, outletId } = req.body;
    const user = await userService.removeRole(
      parseInt(req.params.id, 10),
      roleId,
      outletId || null,
      req.user.userId
    );

    res.status(200).json({
      success: true,
      message: 'Role removed successfully',
      data: user,
    });
  } catch (error) {
    if (error.message === 'Role assignment not found') {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Remove role failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/users/roles
 * Get all available roles (filtered by requester's role)
 * Role hierarchy: super_admin > admin > manager > staff
 * Users can only see roles BELOW their level
 */
const getRoles = async (req, res, next) => {
  try {
    // req.user.roles is array of role slugs like ['admin', 'manager']
    // Use the highest priority role (first in array)
    const requesterRole = req.user.roles?.[0] || 'staff';
    const roles = await userService.getRoles(requesterRole);

    res.status(200).json({
      success: true,
      data: roles,
    });
  } catch (error) {
    logger.error('Get roles failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/users/roles/:id
 * Get role with permissions
 */
const getRoleById = async (req, res, next) => {
  try {
    const role = await userService.getRoleById(parseInt(req.params.id, 10));

    res.status(200).json({
      success: true,
      data: role,
    });
  } catch (error) {
    if (error.message === 'Role not found') {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Get role failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/users/permissions
 * Get all permissions grouped by module
 */
const getPermissions = async (req, res, next) => {
  try {
    const permissions = await userService.getPermissions();

    res.status(200).json({
      success: true,
      data: permissions,
    });
  } catch (error) {
    logger.error('Get permissions failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/users/:id/stations
 * Get user's assigned stations with printer info
 */
const getUserStations = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const outletId = req.query.outletId ? parseInt(req.query.outletId, 10) : null;
    const stations = await userService.getUserStations(userId, outletId);

    res.status(200).json({
      success: true,
      data: stations,
    });
  } catch (error) {
    logger.error('Get user stations failed:', error);
    next(error);
  }
};

/**
 * POST /api/v1/users/:id/stations
 * Assign station to user
 */
const assignStation = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { stationId, outletId, isPrimary } = req.body;
    
    if (!stationId || !outletId) {
      return res.status(400).json({
        success: false,
        message: 'stationId and outletId are required',
      });
    }

    const stations = await userService.assignStation(
      userId,
      stationId,
      outletId,
      req.user.userId,
      isPrimary || false
    );

    res.status(200).json({
      success: true,
      message: 'Station assigned successfully',
      data: stations,
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Assign station failed:', error);
    next(error);
  }
};

/**
 * DELETE /api/v1/users/:id/stations/:stationId
 * Remove station from user
 */
const removeStation = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const stationId = parseInt(req.params.stationId, 10);
    
    await userService.removeStation(userId, stationId);

    res.status(200).json({
      success: true,
      message: 'Station removed successfully',
    });
  } catch (error) {
    logger.error('Remove station failed:', error);
    next(error);
  }
};

/**
 * GET /api/v1/users/:id/station-printer
 * Get user's station printer for KOT printing
 */
const getStationPrinter = async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const outletId = req.query.outletId ? parseInt(req.query.outletId, 10) : null;
    
    if (!outletId) {
      return res.status(400).json({
        success: false,
        message: 'outletId query parameter is required',
      });
    }

    const printer = await userService.getStationPrinterForUser(userId, outletId);

    res.status(200).json({
      success: true,
      data: printer,
    });
  } catch (error) {
    logger.error('Get station printer failed:', error);
    next(error);
  }
};

// =====================================================
// MASTER-ONLY: Super Admin Management
// =====================================================

/**
 * GET /api/v1/users/super-admins
 * List all super_admin users (master only)
 */
const getSuperAdmins = async (req, res, next) => {
  try {
    const result = await userService.getSuperAdmins(req.query);

    res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error('Get super admins failed:', error);
    next(error);
  }
};

/**
 * POST /api/v1/users/super-admins
 * Create a new super_admin user (master only)
 */
const createSuperAdmin = async (req, res, next) => {
  try {
    const user = await userService.createSuperAdmin(req.body, req.user.userId);

    res.status(201).json({
      success: true,
      message: 'Super Admin created successfully',
      data: user,
    });
  } catch (error) {
    if (error.message.includes('already exists')) {
      return res.status(409).json({
        success: false,
        message: error.message,
      });
    }
    if (error.message.includes('Only master')) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Create super admin failed:', error);
    next(error);
  }
};

/**
 * PATCH /api/v1/users/super-admins/:id/toggle-active
 * Enable or disable a super_admin user (master only)
 */
const toggleSuperAdminActive = async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive (boolean) is required',
      });
    }

    const user = await userService.updateUser(targetId, { isActive }, req.user.userId);

    res.status(200).json({
      success: true,
      message: `Super Admin ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: user,
    });
  } catch (error) {
    if (error.message.includes('Only master')) {
      return res.status(403).json({
        success: false,
        message: error.message,
      });
    }
    logger.error('Toggle super admin active failed:', error);
    next(error);
  }
};

module.exports = {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  assignRole,
  removeRole,
  getRoles,
  getRoleById,
  getPermissions,
  getUserStations,
  assignStation,
  removeStation,
  getStationPrinter,
  getSuperAdmins,
  createSuperAdmin,
  toggleSuperAdminActive,
};
