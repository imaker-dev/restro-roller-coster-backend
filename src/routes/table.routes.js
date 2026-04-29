const express = require('express');
const router = express.Router();
const tableController = require('../controllers/table.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares');
const outletValidation = require('../validations/outlet.validation');

// All routes require authentication
router.use(authenticate);

// ========================
// Table CRUD Routes
// ========================

/**
 * @route   POST /api/v1/tables
 * @desc    Create new table
 * @access  Private (admin, manager)
 */
router.post('/', authorize('super_admin', 'admin', 'manager'), validate(outletValidation.createTable), tableController.createTable);

/**
 * @route   GET /api/v1/tables/outlet/:outletId
 * @desc    Get all tables for an outlet
 * @access  Private
 */
router.get('/outlet/:outletId', tableController.getTablesByOutlet);

/**
 * @route   GET /api/v1/tables/floor/:floorId
 * @desc    Get all tables for a floor (with real-time data)
 * @access  Private
 */
router.get('/floor/:floorId', tableController.getTablesByFloor);

/**
 * @route   GET /api/v1/tables/realtime/:outletId
 * @desc    Get real-time status of all tables
 * @access  Private
 */
router.get('/realtime/:outletId', tableController.getRealTimeStatus);

/**
 * @route   GET /api/v1/tables/:id
 * @desc    Get table by ID
 * @access  Private
 */
router.get('/:id', tableController.getTableById);

/**
 * @route   PUT /api/v1/tables/:id
 * @desc    Update table
 * @access  Private (admin, manager)
 */
router.put('/:id', authorize('super_admin', 'admin', 'manager'), validate(outletValidation.updateTable), tableController.updateTable);

/**
 * @route   DELETE /api/v1/tables/:id
 * @desc    Delete table
 * @access  Private (admin)
 */
router.delete('/:id', authorize('super_admin', 'admin'), tableController.deleteTable);

// ========================
// Table Status Routes
// ========================

/**
 * @route   PATCH /api/v1/tables/:id/status
 * @desc    Update table status
 * @access  Private (captain, waiter, manager)
 */
router.patch('/:id/status', authorize('super_admin', 'admin', 'manager', 'captain', 'cashier', 'pos_user', 'waiter'), validate(outletValidation.updateTableStatus), tableController.updateTableStatus);

// ========================
// Table Session Routes
// ========================

/**
 * @route   POST /api/v1/tables/:id/session
 * @desc    Start table session (occupy table)
 * @access  Private (captain, waiter, manager)
 */
router.post('/:id/session', authorize('super_admin', 'admin', 'manager', 'captain', 'cashier', 'pos_user', 'waiter'), validate(outletValidation.startSession), tableController.startSession);

/**
 * @route   DELETE /api/v1/tables/:id/session
 * @desc    End table session
 * @access  Private (captain, waiter, manager, cashier)
 */
router.delete('/:id/session', authorize('super_admin', 'admin', 'manager', 'captain', 'waiter', 'cashier', 'pos_user'), tableController.endSession);

/**
 * @route   GET /api/v1/tables/:id/session
 * @desc    Get current session for table
 * @access  Private
 */
router.get('/:id/session', tableController.getCurrentSession);

/**
 * @route   POST /api/v1/tables/:id/session/transfer
 * @desc    Transfer table session to another captain (Manager/Admin only)
 * @access  Private (manager, admin)
 */
router.post('/:id/session/transfer', authorize('super_admin', 'admin', 'manager'), tableController.transferSession);

// ========================
// Table Transfer Routes
// ========================

/**
 * @route   POST /api/v1/tables/:id/transfer
 * @desc    Transfer table session from one table to another (T1 → T2)
 *          Moves entire session including orders, KOTs, billing data
 *          Source table becomes available, target table gets the session
 * @access  Private (cashier, captain, manager, admin, super_admin)
 */
router.post('/:id/transfer', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user', 'captain'), tableController.transferTable);

// ========================
// Table Merge Routes
// ========================

/**
 * @route   POST /api/v1/tables/:id/merge
 * @desc    Merge tables
 * @access  Private (captain, manager)
 */
router.post('/:id/merge', authorize('super_admin', 'admin', 'manager', 'captain', 'cashier', 'pos_user'), validate(outletValidation.mergeTables), tableController.mergeTables);

/**
 * @route   DELETE /api/v1/tables/:id/merge
 * @desc    Unmerge tables
 * @access  Private (captain, manager)
 */
router.delete('/:id/merge', authorize('super_admin', 'admin', 'manager', 'captain', 'cashier', 'pos_user'), tableController.unmergeTables);

/**
 * @route   GET /api/v1/tables/:id/merged
 * @desc    Get merged tables for a primary table
 * @access  Private
 */
router.get('/:id/merged', tableController.getMergedTables);

// ========================
// Table History & Reports
// ========================

/**
 * @route   GET /api/v1/tables/:id/history
 * @desc    Get table history
 * @access  Private (manager)
 */
router.get('/:id/history', authorize('super_admin', 'admin', 'manager'), tableController.getTableHistory);

/**
 * @route   GET /api/v1/tables/:id/sessions
 * @desc    Get table session history
 * @access  Private (manager)
 */
router.get('/:id/sessions', authorize('super_admin', 'admin', 'manager'), tableController.getSessionHistory);

/**
 * @route   GET /api/v1/tables/:id/report
 * @desc    Get table-wise report
 * @access  Private (manager)
 */
router.get('/:id/report', authorize('super_admin', 'admin', 'manager'), validate(outletValidation.tableReport, 'query'), tableController.getTableReport);

/**
 * @route   GET /api/v1/tables/floor/:floorId/report
 * @desc    Get floor-wise report
 * @access  Private (manager)
 */
router.get('/floor/:floorId/report', authorize('super_admin', 'admin', 'manager'), validate(outletValidation.tableReport, 'query'), tableController.getFloorReport);

/**
 * @route   GET /api/v1/tables/:id/kots
 * @desc    Get running KOTs for a table
 * @access  Private
 */
router.get('/:id/kots', tableController.getRunningKots);

module.exports = router;
