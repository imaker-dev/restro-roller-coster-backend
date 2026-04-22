const express = require('express');
const router = express.Router();
const { authenticate } = require('../middlewares/auth.middleware');
const { createRateLimiter } = require('../middlewares/rateLimiter');
const {
  submitRegistration,
  listRegistrations,
  updateRegistrationStatus,
  getRegistrationStats,
} = require('../controllers/registration.controller');

// Public registration: 5 requests per IP per 15 minutes
const registerLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: 'Too many registration attempts. Please try again after 15 minutes.',
  },
});

/**
 * @route   POST /api/v1/registration/register
 * @desc    Submit a restaurant registration request (no token yet)
 * @access  Public
 */
router.post('/register', registerLimiter, submitRegistration);

/**
 * @route   GET /api/v1/registration/requests
 * @desc    List all registration requests
 * @access  Admin (authenticated)
 */
router.get('/requests', authenticate, listRegistrations);

/**
 * @route   GET /api/v1/registration/stats
 * @desc    Get summary stats (pending/approved/rejected counts)
 * @access  Admin (authenticated)
 */
router.get('/stats', authenticate, getRegistrationStats);

/**
 * @route   PATCH /api/v1/registration/:id/status
 * @desc    Approve or reject a registration request
 * @access  Admin (authenticated)
 */
router.patch('/:id/status', authenticate, updateRegistrationStatus);

module.exports = router;
