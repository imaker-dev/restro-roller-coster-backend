const express = require('express');
const router = express.Router();
const { authenticate } = require('../middlewares/auth.middleware');
const {
  generateActivationToken,
  generateUpgradeToken,
  getTokenLog,
  generateOfflineActivationToken,
  getOfflinePublicKey,
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

/**
 * @route   POST /api/v1/token-generation/offline-activation
 * @desc    Generate offline annual-subscription activation token for an outlet
 *          Verifies outlet has active/trial/grace subscription before signing.
 * @access  Admin (authenticated)
 */
router.post('/offline-activation', authenticate, generateOfflineActivationToken);

/**
 * @route   GET /api/v1/token-generation/public-key
 * @desc    Get the RSA public key used to verify offline token signatures.
 *          Offline POS backend fetches this once and caches it locally.
 * @access  Public (no authentication required)
 */
router.get('/public-key', getOfflinePublicKey);

module.exports = router;
