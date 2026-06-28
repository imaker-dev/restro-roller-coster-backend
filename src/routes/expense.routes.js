/**
 * Expense Routes
 */

const express = require('express');
const router = express.Router();
const expenseController = require('../controllers/expense.controller');
const { authenticate } = require('../middlewares/auth.middleware');

// All routes require authentication
router.use(authenticate);

// List & Create
router.get('/:outletId', expenseController.list);
router.post('/:outletId', expenseController.create);

// Stats
router.get('/:outletId/stats', expenseController.stats);

// Single operations
router.get('/detail/:id', expenseController.getById);
router.put('/:id', expenseController.update);
router.delete('/:id', expenseController.remove);

module.exports = router;
