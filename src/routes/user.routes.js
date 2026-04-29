const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const permissionController = require('../controllers/permission.controller');
const { authenticate, authorize, requirePermission } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares');
const userValidation = require('../validations/user.validation');

// All routes require authentication
router.use(authenticate);

// =====================================================
// MASTER-ONLY ROUTES (must be before parameterized routes)
// =====================================================

/**
 * @route   GET /api/v1/users/super-admins
 * @desc    List all super_admin users
 * @access  Private (master only)
 */
router.get('/super-admins', authorize('master'), userController.getSuperAdmins);

/**
 * @route   POST /api/v1/users/super-admins
 * @desc    Create a new super_admin user
 * @access  Private (master only)
 */
router.post('/super-admins', authorize('master'), userController.createSuperAdmin);

/**
 * @route   PATCH /api/v1/users/super-admins/:id/toggle-active
 * @desc    Activate or deactivate a super_admin user
 * @access  Private (master only)
 */
router.patch('/super-admins/:id/toggle-active', authorize('master'), userController.toggleSuperAdminActive);

// =====================================================

/**
 * @route   GET /api/v1/users/roles
 * @desc    Get all available roles
 * @access  Private (admin, manager)
 */
router.get('/roles', authorize('super_admin', 'admin', 'manager'), userController.getRoles);

/**
 * @route   GET /api/v1/users/roles/:id
 * @desc    Get role with permissions
 * @access  Private (admin)
 */
router.get('/roles/:id', authorize('super_admin', 'admin'), userController.getRoleById);

/**
 * @route   GET /api/v1/users/permissions
 * @desc    Get all permissions grouped by module
 * @access  Private (admin)
 */
router.get('/permissions', authorize('super_admin', 'admin'), userController.getPermissions);

/**
 * @route   GET /api/v1/users
 * @desc    Get all users with pagination and filters
 * @access  Private (admin, manager)
 */
router.get('/', authorize('super_admin', 'admin', 'manager'), validate(userValidation.listUsers, 'query'), userController.getUsers);

/**
 * @route   GET /api/v1/users/:id
 * @desc    Get single user by ID
 * @access  Private (admin, manager)
 */
router.get('/:id', authorize('super_admin', 'admin', 'manager'), userController.getUserById);

/**
 * @route   POST /api/v1/users
 * @desc    Create new user
 * @access  Private (admin, manager - manager can only create staff, not other managers/admins)
 */
router.post('/', authorize('super_admin', 'admin', 'manager'), validate(userValidation.createUser), userController.createUser);

/**
 * @route   PUT /api/v1/users/:id
 * @desc    Update user
 * @access  Private (admin, manager - manager can only update staff, not other managers/admins)
 */
router.put('/:id', authorize('super_admin', 'admin', 'manager'), validate(userValidation.updateUser), userController.updateUser);

/**
 * @route   DELETE /api/v1/users/:id
 * @desc    Delete user (soft delete)
 * @access  Private (admin, manager - manager can only delete staff, not other managers/admins)
 */
router.delete('/:id', authorize('super_admin', 'admin', 'manager'), userController.deleteUser);

/**
 * @route   POST /api/v1/users/:id/roles
 * @desc    Assign role to user
 * @access  Private (admin, manager - manager can only assign staff roles)
 */
router.post('/:id/roles', authorize('super_admin', 'admin', 'manager'), validate(userValidation.assignRole), userController.assignRole);

/**
 * @route   DELETE /api/v1/users/:id/roles
 * @desc    Remove role from user
 * @access  Private (admin, manager - manager can only remove staff roles)
 */
router.delete('/:id/roles', authorize('super_admin', 'admin', 'manager'), validate(userValidation.removeRole), userController.removeRole);

// =====================================================
// USER PERMISSION ROUTES
// =====================================================

/**
 * @route   GET /api/v1/users/:id/permissions
 * @desc    Get user's permissions
 * @access  Private (admin, manager)
 */
router.get('/:id/permissions', authorize('super_admin', 'admin', 'manager'), permissionController.getUserPermissions);

/**
 * @route   PUT /api/v1/users/:id/permissions
 * @desc    Set user's permissions (replace all)
 * @access  Private (admin, manager - manager can only set staff permissions they have)
 */
router.put('/:id/permissions', authorize('super_admin', 'admin', 'manager'), permissionController.setUserPermissions);

/**
 * @route   POST /api/v1/users/:id/permissions/grant
 * @desc    Grant specific permissions to user
 * @access  Private (admin, manager - manager can only grant permissions they have)
 */
router.post('/:id/permissions/grant', authorize('super_admin', 'admin', 'manager'), permissionController.grantPermissions);

/**
 * @route   POST /api/v1/users/:id/permissions/revoke
 * @desc    Revoke specific permissions from user
 * @access  Private (admin, manager)
 */
router.post('/:id/permissions/revoke', authorize('super_admin', 'admin', 'manager'), permissionController.revokePermissions);

/**
 * @route   GET /api/v1/users/:id/permissions/history
 * @desc    Get permission change history for user
 * @access  Private (admin)
 */
router.get('/:id/permissions/history', authorize('super_admin', 'admin'), permissionController.getPermissionHistory);

// =====================================================
// USER STATION ROUTES (for kitchen/bar staff)
// =====================================================

/**
 * @route   GET /api/v1/users/:id/stations
 * @desc    Get user's assigned kitchen/bar stations with printer info
 * @access  Private (admin, manager, self)
 */
router.get('/:id/stations', authorize('super_admin', 'admin', 'manager', 'kitchen', 'bartender'), userController.getUserStations);

/**
 * @route   POST /api/v1/users/:id/stations
 * @desc    Assign station to user
 * @access  Private (admin, manager)
 */
router.post('/:id/stations', authorize('super_admin', 'admin', 'manager'), userController.assignStation);

/**
 * @route   DELETE /api/v1/users/:id/stations/:stationId
 * @desc    Remove station from user
 * @access  Private (admin, manager)
 */
router.delete('/:id/stations/:stationId', authorize('super_admin', 'admin', 'manager'), userController.removeStation);

/**
 * @route   GET /api/v1/users/:id/station-printer
 * @desc    Get the printer for user's primary station (for KOT printing)
 * @access  Private (kitchen, bartender, self)
 */
router.get('/:id/station-printer', authorize('super_admin', 'admin', 'manager', 'kitchen', 'bartender'), userController.getStationPrinter);

module.exports = router;
