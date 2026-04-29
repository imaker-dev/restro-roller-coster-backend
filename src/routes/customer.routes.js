/**
 * Customer Routes
 * Handles customer management, GST details, and order history
 */

const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customer.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

// All routes require authentication
router.use(authenticate);

/**
 * @route   POST /api/v1/customers/:outletId
 * @desc    Create a new customer
 * @access  Private (admin, manager, cashier)
 */
router.post('/:outletId', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.create);

/**
 * @route   GET /api/v1/customers/:outletId/search
 * @desc    Search customers by name, phone, company name or GSTIN
 * @access  Private (admin, manager, cashier)
 * @query   q - Search query (min 2 chars)
 * @query   limit - Max results (default 20)
 */
router.get('/:outletId/search', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user', 'captain'), customerController.search);

/**
 * @route   GET /api/v1/customers/:outletId/by-phone
 * @desc    Get customer by phone number
 * @access  Private (admin, manager, cashier)
 * @query   phone - Phone number
 */
router.get('/:outletId/by-phone', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user', 'captain'), customerController.getByPhone);

/**
 * @route   GET /api/v1/customers/:outletId/list
 * @desc    List all customers for an outlet
 * @access  Private (admin, manager, cashier)
 * @query   page, limit, gstOnly, sortBy, sortOrder
 */
router.get('/:outletId/list', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user', 'captain'), customerController.list);

/**
 * @route   GET /api/v1/customers/:outletId/details/:customerId
 * @desc    Get complete customer details with full order history
 * @access  Private (admin, manager, cashier)
 * @query   includeOrders, includeItems, includePayments, includeCancelledOrders, paginate, page, limit
 * @query   search, status, paymentStatus, orderType, fromDate, toDate, minAmount, maxAmount, sortBy, sortOrder
 */
router.get('/:outletId/details/:customerId', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.getDetails);

/**
 * @route   GET /api/v1/customers/:id
 * @desc    Get customer by ID
 * @access  Private (admin, manager, cashier)
 */
router.get('/:id', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.getById);

/**
 * @route   PUT /api/v1/customers/:id
 * @desc    Update customer
 * @access  Private (admin, manager, cashier)
 */
router.put('/:id', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.update);

/**
 * @route   GET /api/v1/customers/:id/orders
 * @desc    Get customer order history
 * @access  Private (admin, manager, cashier)
 * @query   page, limit
 */
router.get('/:id/orders', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.getOrderHistory);

/**
 * @route   POST /api/v1/customers/link-order/:orderId
 * @desc    Link customer to an order (create if not exists)
 * @access  Private (admin, manager, cashier)
 */
router.post('/link-order/:orderId', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user', 'captain'), customerController.linkToOrder);

/**
 * @route   PUT /api/v1/customers/order-gst/:orderId
 * @desc    Update order with customer GST details
 * @access  Private (admin, manager, cashier)
 */
router.put('/order-gst/:orderId', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.updateOrderGst);

// ========================
// DUE PAYMENT MANAGEMENT
// ========================

/**
 * @route   GET /api/v1/customers/:outletId/due/:customerId
 * @desc    Get customer due balance and pending orders
 * @access  Private (admin, manager, cashier)
 */
router.get('/:outletId/due/:customerId', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.getDueBalance);

/**
 * @route   GET /api/v1/customers/:outletId/due/:customerId/transactions
 * @desc    Get customer due transaction history
 * @access  Private (admin, manager, cashier)
 * @query   page, limit, type (due_created, due_collected, due_waived)
 */
router.get('/:outletId/due/:customerId/transactions', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.getDueTransactions);

/**
 * @route   POST /api/v1/customers/:outletId/due/:customerId/collect
 * @desc    Collect due payment from customer
 * @access  Private (admin, manager, cashier)
 * @body    { amount, paymentMode, transactionId?, referenceNumber?, orderId?, invoiceId?, notes? }
 */
router.post('/:outletId/due/:customerId/collect', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.collectDue);

/**
 * @route   POST /api/v1/customers/:outletId/due/:customerId/waive
 * @desc    Waive customer due (manager only)
 * @access  Private (admin, manager)
 * @body    { amount, reason }
 */
router.post('/:outletId/due/:customerId/waive', authorize('super_admin', 'admin', 'manager'), customerController.waiveDue);

/**
 * @route   GET /api/v1/customers/:outletId/due-list
 * @desc    List all customers with due balance
 * @access  Private (admin, manager, cashier)
 * @query   page, limit, minDue, sortBy, sortOrder
 */
router.get('/:outletId/due-list', authorize('super_admin', 'admin', 'manager', 'cashier', 'pos_user'), customerController.listWithDue);

module.exports = router;
