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
router.use('/customers', require('./customer.routes'));
router.use('/settings', require('./settings.routes'));
router.use('/reports', require('./reports.routes'));
router.use('/bulk-upload', require('./bulkUpload.routes'));
router.use('/app', require('./appVersion.routes'));
router.use('/integrations', require('./integration.routes'));
router.use('/inventory', require('./inventory.routes'));

// Future routes (uncomment as modules are developed)
// router.use('/categories', require('./category.routes'));
// router.use('/items', require('./item.routes'));
// router.use('/kot', require('./kot.routes'));
// router.use('/payments', require('./payment.routes'));
// router.use('/reports', require('./report.routes'));

module.exports = router;
