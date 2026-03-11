const express = require('express');
const router = express.Router();
const outletController = require('../controllers/outlet.controller');
const tableController = require('../controllers/table.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares');
const outletValidation = require('../validations/outlet.validation');
const { singleImage } = require('../utils/upload');

// All routes require authentication
router.use(authenticate);

// ========================
// Utility Routes
// ========================

/**
 * @route   GET /api/v1/outlets/section-types
 * @desc    Get all section types
 * @access  Private
 */
router.get('/section-types', outletController.getSectionTypes);

/**
 * @route   GET /api/v1/outlets/table-statuses
 * @desc    Get all table statuses
 * @access  Private
 */
router.get('/table-statuses', tableController.getTableStatuses);

/**
 * @route   GET /api/v1/outlets/table-shapes
 * @desc    Get all table shapes
 * @access  Private
 */
router.get('/table-shapes', tableController.getTableShapes);

// ========================
// Outlet Routes
// ========================

/**
 * @route   GET /api/v1/outlets
 * @desc    Get all outlets
 * @access  Private (admin, manager)
 */
router.get('/', authorize('super_admin', 'admin', 'manager'), outletController.getOutlets);

/**
 * @route   POST /api/v1/outlets
 * @desc    Create new outlet
 * @access  Private (admin)
 */
router.post('/', authorize('super_admin', 'admin'), validate(outletValidation.createOutlet), outletController.createOutlet);

/**
 * @route   GET /api/v1/outlets/:id
 * @desc    Get outlet by ID
 * @access  Private
 */
router.get('/:id', outletController.getOutletById);

/**
 * @route   GET /api/v1/outlets/:id/details
 * @desc    Get outlet with full details (floors, sections, table stats)
 * @access  Private
 */
router.get('/:id/details', outletController.getOutletFullDetails);

/**
 * @route   PUT /api/v1/outlets/:id
 * @desc    Update outlet
 * @access  Private (admin)
 */
router.put('/:id', authorize('super_admin', 'admin'), validate(outletValidation.updateOutlet), outletController.updateOutlet);

/**
 * @route   DELETE /api/v1/outlets/:id
 * @desc    Delete outlet (soft delete)
 * @access  Private (admin)
 */
router.delete('/:id', authorize('super_admin', 'admin'), outletController.deleteOutlet);

/**
 * @route   GET /api/v1/outlets/:id/delete-preview
 * @desc    Preview what would be deleted - shows data counts before hard delete
 * @access  Private (super_admin only)
 */
router.get('/:id/delete-preview', authorize('super_admin'), outletController.getDeletePreview);

/**
 * @route   DELETE /api/v1/outlets/:id/hard-delete
 * @desc    PERMANENTLY delete outlet and ALL related data (staff, menu, orders, bills, etc.)
 *          Requires confirmationCode in body matching outlet code
 * @access  Private (super_admin only)
 * @body    { confirmationCode: string }
 */
router.delete('/:id/hard-delete', authorize('super_admin'), outletController.hardDeleteOutlet);

// ========================
// Floor Routes
// ========================

/**
 * @route   GET /api/v1/outlets/:outletId/floors
 * @desc    Get all floors for an outlet
 * @access  Private
 */
router.get('/:outletId/floors', outletController.getFloorsByOutlet);

/**
 * @route   POST /api/v1/outlets/floors
 * @desc    Create new floor
 * @access  Private (admin, manager)
 */
router.post('/floors', authorize('super_admin', 'admin', 'manager'), validate(outletValidation.createFloor), outletController.createFloor);

/**
 * @route   GET /api/v1/outlets/floors/:id
 * @desc    Get floor by ID
 * @access  Private
 */
router.get('/floors/:id', outletController.getFloorById);

/**
 * @route   GET /api/v1/outlets/floors/:id/details
 * @desc    Get floor with tables and sections
 * @access  Private
 */
router.get('/floors/:id/details', outletController.getFloorWithDetails);

/**
 * @route   PUT /api/v1/outlets/floors/:id
 * @desc    Update floor
 * @access  Private (admin, manager)
 */
router.put('/floors/:id', authorize('super_admin', 'admin', 'manager'), validate(outletValidation.updateFloor), outletController.updateFloor);

/**
 * @route   DELETE /api/v1/outlets/floors/:id
 * @desc    Delete floor
 * @access  Private (admin)
 */
router.delete('/floors/:id', authorize('super_admin', 'admin'), outletController.deleteFloor);

/**
 * @route   POST /api/v1/outlets/floors/:id/sections
 * @desc    Link section to floor
 * @access  Private (admin, manager)
 */
router.post('/floors/:id/sections', authorize('super_admin', 'admin', 'manager'), outletController.linkSectionToFloor);

/**
 * @route   DELETE /api/v1/outlets/floors/:id/sections/:sectionId
 * @desc    Unlink section from floor
 * @access  Private (admin, manager)
 */
router.delete('/floors/:id/sections/:sectionId', authorize('super_admin', 'admin', 'manager'), outletController.unlinkSectionFromFloor);

/**
 * @route   GET /api/v1/outlets/floors/:floorId/sections
 * @desc    Get all sections for a floor
 * @access  Private (admin, manager)
 */
router.get('/floors/:floorId/sections', authorize('super_admin', 'admin', 'manager'), outletController.getSectionsByFloor);

/**
 * @route   GET /api/v1/outlets/floors/:floorId/sections-with-tables
 * @desc    Get floor sections with tables and real-time order info
 * @access  Private
 */
router.get('/floors/:floorId/sections-with-tables', outletController.getFloorSectionsWithTables);

// ========================
// Section Routes
// ========================

/**
 * @route   GET /api/v1/outlets/:outletId/sections
 * @desc    Get all sections for an outlet
 * @access  Private
 */
router.get('/:outletId/sections', outletController.getSectionsByOutlet);

/**
 * @route   POST /api/v1/outlets/sections
 * @desc    Create new section
 * @access  Private (admin, manager)
 */
router.post('/sections', authorize('super_admin', 'admin', 'manager'), validate(outletValidation.createSection), outletController.createSection);

/**
 * @route   GET /api/v1/outlets/sections/:id
 * @desc    Get section by ID
 * @access  Private
 */
router.get('/sections/:id', outletController.getSectionById);

/**
 * @route   PUT /api/v1/outlets/sections/:id
 * @desc    Update section
 * @access  Private (admin, manager)
 */
router.put('/sections/:id', authorize('super_admin', 'admin', 'manager'), validate(outletValidation.updateSection), outletController.updateSection);

/**
 * @route   DELETE /api/v1/outlets/sections/:id
 * @desc    Delete section
 * @access  Private (admin)
 */
router.delete('/sections/:id', authorize('super_admin', 'admin'), outletController.deleteSection);

// ========================
// Print Logo Routes
// ========================

/**
 * @route   GET /api/v1/outlets/:id/print-logo
 * @desc    Get print logo settings for an outlet
 * @access  Private (admin, manager)
 */
router.get('/:id/print-logo', authorize('super_admin', 'admin', 'manager'), outletController.getPrintLogoSettings);

/**
 * @route   PUT /api/v1/outlets/:id/print-logo
 * @desc    Update print logo settings (enable/disable, set URL)
 * @access  Private (admin)
 * @body    { printLogoEnabled: boolean, printLogoUrl?: string }
 */
router.put('/:id/print-logo', authorize('super_admin', 'admin'), outletController.updatePrintLogoSettings);

/**
 * @route   POST /api/v1/outlets/:id/print-logo/upload
 * @desc    Upload print logo image for thermal printer
 * @access  Private (admin)
 * @body    multipart/form-data with 'logo' field
 */
router.post('/:id/print-logo/upload', authorize('super_admin', 'admin'), singleImage('logo', 'logos'), outletController.uploadPrintLogo);

module.exports = router;
