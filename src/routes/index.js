const express = require('express');
const router = express.Router();

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is running',
    timestamp: new Date().toISOString(),
  });
});

// Sentry test endpoint (for verifying Sentry integration)
router.get('/debug/sentry-test', async (req, res) => {
  const Sentry = require('../instrument');
  
  try {
    // Capture a test message
    const messageId = Sentry.captureMessage('Sentry test message from Restaurant POS', 'info');
    console.log('Sentry message captured, ID:', messageId);
    
    // Capture a test exception
    const error = new Error('Sentry test error - this is intentional');
    const exceptionId = Sentry.captureException(error);
    console.log('Sentry exception captured, ID:', exceptionId);
    
    // Flush to ensure events are sent before response
    await Sentry.flush(2000);
    console.log('Sentry events flushed');
    
    res.json({
      success: true,
      message: 'Test error sent to Sentry. Check your Sentry dashboard.',
      environment: process.env.NODE_ENV || 'development',
      messageId: messageId,
      exceptionId: exceptionId
    });
  } catch (err) {
    console.error('Sentry test error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to send test error to Sentry',
      error: err.message
    });
  }
});

// API Routes
router.use('/auth', require('./auth.routes'));
router.use('/users', require('./user.routes'));
router.use('/permissions', require('./permission.routes'));
router.use('/outlets', require('./outlet.routes'));
router.use('/tables', require('./table.routes'));
router.use('/menu', require('./menu.routes'));
router.use('/tax', require('./tax.routes'));
router.use('/orders', require('./order.routes'));
router.use('/printers', require('./printer.routes'));
router.use('/upload', require('./upload.routes'));
router.use('/menu-media', require('./menuMedia.routes'));
router.use('/customers', require('./customer.routes'));
router.use('/settings', require('./settings.routes'));
router.use('/reports', require('./reports.routes'));
router.use('/bulk-upload', require('./bulkUpload.routes'));
router.use('/app', require('./appVersion.routes'));
router.use('/integrations', require('./integration.routes'));
router.use('/dyno', require('./dyno.routes'));
router.use('/inventory', require('./inventory.routes'));
router.use('/recipes', require('./recipe.routes'));
router.use('/production', require('./production.routes'));
router.use('/wastage', require('./wastage.routes'));
router.use('/inventory-reports', require('./inventoryReports.routes'));
router.use('/dashboard', require('./dashboard.routes'));
router.use('/registration', require('./registration.routes'));
router.use('/token-generation', require('./tokenGeneration.routes'));
router.use('/upgrade-payment', require('./upgradePayment.routes'));

// Future routes (uncomment as modules are developed)
// router.use('/categories', require('./category.routes'));
// router.use('/items', require('./item.routes'));
// router.use('/kot', require('./kot.routes'));
// router.use('/payments', require('./payment.routes'));
// router.use('/reports', require('./report.routes'));

module.exports = router;
