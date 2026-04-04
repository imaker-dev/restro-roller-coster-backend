/**
 * Dashboard Routes
 */

const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboard.controller');
const { authenticate } = require('../middlewares/auth.middleware');

// Real-time dashboard
router.get('/realtime/:outletId', authenticate, dashboardController.getRealtime);

module.exports = router;
