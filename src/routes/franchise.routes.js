const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const {
  listFranchises,
  getFranchiseBySlug,
  getFranchiseById,
  adminGetFranchiseById,
  getFilterOptions,
  submitEnquiry,
  createFranchise,
  updateFranchise,
  deleteFranchise,
  adminListFranchises,
  adminListEnquiries,
  updateEnquiryStatus,
  getFranchiseStats,
} = require('../controllers/franchise.controller');

// Public enquiry rate limiter: 3 per IP per 15 minutes
const enquiryLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    success: false,
    message: 'Too many enquiry attempts. Please try again after 15 minutes.',
  },
});

// Relaxed limiter for public reads
const readLimiter = createRateLimiter({
  windowMs: 1 * 60 * 1000,
  max: 100,
});

/* ───────── PUBLIC ROUTES (no auth) ───────── */

/**
 * @route   GET /api/v1/franchises
 * @desc    List active franchises with search, filter, pagination
 * @access  Public
 */
router.get('/', readLimiter, listFranchises);

/**
 * @route   GET /api/v1/franchises/filters
 * @desc    Get available filter options (categories, states, cities, investment ranges)
 * @access  Public
 */
router.get('/filters', readLimiter, getFilterOptions);

/**
 * @route   POST /api/v1/franchises/enquiry
 * @desc    Submit an enquiry for a franchise
 * @access  Public
 */
router.post('/enquiry', enquiryLimiter, submitEnquiry);

/* ───────── ADMIN ROUTES (auth required) ───────── */

/**
 * @route   POST /api/v1/franchises
 * @desc    Create a new franchise
 * @access  Admin / Super Admin
 */
router.post('/', authenticate, authorize('admin', 'super_admin'), createFranchise);

/**
 * @route   PATCH /api/v1/franchises/:id
 * @desc    Update a franchise
 * @access  Admin / Super Admin
 */
router.patch('/:id', authenticate, authorize('admin', 'super_admin'), updateFranchise);

/**
 * @route   DELETE /api/v1/franchises/:id
 * @desc    Soft-delete a franchise (mark inactive)
 * @access  Admin / Super Admin
 */
router.delete('/:id', authenticate, authorize('admin', 'super_admin'), deleteFranchise);

/**
 * @route   GET /api/v1/franchises/admin/list
 * @desc    Admin list of all franchises (all statuses)
 * @access  Admin / Super Admin
 */
router.get('/admin/list', authenticate, authorize('admin', 'super_admin'), adminListFranchises);

/**
 * @route   GET /api/v1/franchises/admin/enquiries
 * @desc    Admin list of all enquiries
 * @access  Admin / Super Admin
 */
router.get('/admin/enquiries', authenticate, authorize('admin', 'super_admin'), adminListEnquiries);

/**
 * @route   PATCH /api/v1/franchises/admin/enquiries/:id/status
 * @desc    Update enquiry status
 * @access  Admin / Super Admin
 */
router.patch('/admin/enquiries/:id/status', authenticate, authorize('admin', 'super_admin'), updateEnquiryStatus);

/**
 * @route   GET /api/v1/franchises/admin/stats
 * @desc    Get franchise and enquiry stats
 * @access  Admin / Super Admin
 */
router.get('/admin/stats', authenticate, authorize('admin', 'super_admin'), getFranchiseStats);

/**
 * @route   GET /api/v1/franchises/admin/detail/:id
 * @desc    Get single franchise details by ID (admin — includes inactive/pending)
 * @access  Admin / Super Admin
 */
router.get('/admin/detail/:id', authenticate, authorize('admin', 'super_admin'), adminGetFranchiseById);

/**
 * @route   GET /api/v1/franchises/detail/:id
 * @desc    Get single franchise details by ID (public)
 * @access  Public
 */
router.get('/detail/:id', readLimiter, getFranchiseById);

/* ───────── DYNAMIC PUBLIC ROUTE — MUST BE LAST ───────── */

/**
 * @route   GET /api/v1/franchises/:slug
 * @desc    Get single franchise details by slug
 * @access  Public
 * @note    This catch-all must come AFTER all other GET routes
 */
router.get('/:slug', readLimiter, getFranchiseBySlug);

module.exports = router;
