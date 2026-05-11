/**
 * Bulk Upload Routes
 * CSV-based bulk menu upload endpoints
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const bulkUploadController = require('../controllers/bulkUpload.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

// Configure multer for CSV file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || 
        file.mimetype === 'application/vnd.ms-excel' ||
        file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  }
});

/**
 * @route   GET /api/v1/bulk-upload/menu/template
 * @desc    Download CSV template for menu upload
 * @access  Private (admin, super_admin)
 */
router.get('/menu/template', authenticate, authorize('super_admin', 'admin','manager'), bulkUploadController.getTemplate);

/**
 * @route   GET /api/v1/bulk-upload/menu/template/json
 * @desc    Get template structure as JSON
 * @access  Private (admin, super_admin)
 */
router.get('/menu/template/json', authenticate, authorize('super_admin', 'admin','manager'), bulkUploadController.getTemplateStructure);

/**
 * @route   POST /api/v1/bulk-upload/menu/validate
 * @desc    Validate CSV without inserting data
 * @access  Private (admin, super_admin)
 * @body    csvContent (string) OR file upload
 * @query   outletId
 */
router.post('/menu/validate', authenticate, authorize('super_admin', 'admin','manager'), upload.single('file'), bulkUploadController.validateUpload);

/**
 * @route   POST /api/v1/bulk-upload/menu/preview
 * @desc    Preview what will be created from CSV
 * @access  Private (admin, super_admin)
 * @body    csvContent (string) OR file upload
 * @query   outletId
 */
router.post('/menu/preview', authenticate, authorize('super_admin', 'admin','manager'), upload.single('file'), bulkUploadController.previewUpload);

/**
 * @route   POST /api/v1/bulk-upload/menu
 * @desc    Upload and process CSV to create menu items
 * @access  Private (admin, super_admin)
 * @body    csvContent (string) OR file upload, outletId, skipValidation (optional)
 */
router.post('/menu', authenticate, authorize('super_admin', 'admin','manager'), upload.single('file'), bulkUploadController.uploadMenu);

/**
 * @route   GET /api/v1/bulk-upload/history
 * @desc    Get upload history for outlet
 * @access  Private (admin, super_admin)
 * @query   outletId, limit
 */
router.get('/history', authenticate, authorize('super_admin', 'admin','manager'), bulkUploadController.getHistory);

/**
 * @route   POST /api/v1/bulk-upload/menu/super-admin-template
 * @desc    Super admin uploads master menu template CSV
 * @access  Private (super_admin only)
 * @body    csvContent (string) OR file upload
 */
router.post('/menu/super-admin-template', authenticate, authorize('super_admin'), upload.single('file'), bulkUploadController.uploadSuperAdminTemplate);

/**
 * @route   GET /api/v1/bulk-upload/menu/super-admin-template
 * @desc    Get super admin's current master template metadata
 * @access  Private (super_admin only)
 */
router.get('/menu/super-admin-template', authenticate, authorize('super_admin'), bulkUploadController.getSuperAdminTemplate);

/**
 * @route   DELETE /api/v1/bulk-upload/menu/super-admin-template
 * @desc    Delete super admin's master template
 * @access  Private (super_admin only)
 */
router.delete('/menu/super-admin-template', authenticate, authorize('super_admin'), bulkUploadController.deleteSuperAdminTemplate);

module.exports = router;
