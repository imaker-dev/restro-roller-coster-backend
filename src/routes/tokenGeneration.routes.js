const express = require('express');
const router = express.Router();
const { authenticate } = require('../middlewares/auth.middleware');
const {
  generateActivationToken,
  generateUpgradeToken,
  getTokenLog,
} = require('../controllers/tokenGeneration.controller');

/**
 * @route   POST /api/v1/token-generation/activation
 * @desc    Generate activation token for a restaurant
 * @access  Admin (authenticated)
 */
router.post('/activation', authenticate, generateActivationToken);

/**
 * @route   POST /api/v1/token-generation/upgrade
 * @desc    Generate Pro upgrade token for an existing Free restaurant
 * @access  Admin (authenticated)
 */
router.post('/upgrade', authenticate, generateUpgradeToken);

/**
 * @route   GET /api/v1/token-generation/log
 * @desc    View token generation history (metadata only)
 * @access  Admin (authenticated)
 */
router.get('/log', authenticate, getTokenLog);

module.exports = router;
