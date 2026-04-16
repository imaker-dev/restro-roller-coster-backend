const express = require('express');
const router = express.Router();
const orderController = require('../controllers/order.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { reportCache } = require('../middleware/reportCache');
const { validate } = require('../middlewares');
const orderValidation = require('../validations/order.validation');

// All routes require authentication
router.use(authenticate);

// ========================
// ORDER MANAGEMENT
// ========================

/**
 * @route   POST /api/v1/orders
 * @desc    Create new order
 * @access  Private (captain, waiter, manager)
 */
router.post('/', validate(orderValidation.createOrder), orderController.createOrder);

/**
 * @route   GET /api/v1/orders/active/:outletId
 * @desc    Get active orders for outlet
 * @access  Private
 */
router.get('/active/:outletId', orderController.getActiveOrders);

// ========================
// CAPTAIN BILLS
// ========================

/**
 * @route   GET /api/v1/orders/captain/bills/:outletId
 * @desc    Get captain's own bills (pending/completed/all)
 * @access  Private (captain, waiter)
 * @query   status - 'pending' (default) | 'completed' | 'all'
 * @query   search - Search by table number, order number, invoice number
 * @query   page, limit, sortBy, sortOrder
 */
router.get('/captain/bills/:outletId', orderController.getCaptainBills);

// ========================
// CAPTAIN ORDER HISTORY
// ========================

/**
 * @route   GET /api/v1/orders/captain/history/:outletId
 * @desc    Get captain's own order history with filters
 * @access  Private (captain, waiter)
 * @query   status - 'running' | 'completed' | 'cancelled' | 'all'
 * @query   search - Search by order number, table number, customer name
 * @query   startDate - Filter from date (YYYY-MM-DD)
 * @query   endDate - Filter to date (YYYY-MM-DD)
 * @query   page - Page number (default: 1)
 * @query   limit - Items per page (default: 20)
 * @query   sortBy - Sort column (created_at, order_number, total_amount)
 * @query   sortOrder - ASC or DESC (default: DESC)
 */
router.get('/captain/history/:outletId', orderController.getCaptainOrderHistory);

/**
 * @route   GET /api/v1/orders/captain/stats/:outletId
 * @desc    Get captain's order statistics
 * @access  Private (captain, waiter)
 * @query   startDate - Filter from date (YYYY-MM-DD)
 * @query   endDate - Filter to date (YYYY-MM-DD)
 */
router.get('/captain/stats/:outletId', orderController.getCaptainOrderStats);

/**
 * @route   GET /api/v1/orders/captain/detail/:orderId
 * @desc    Get detailed order view with time logs (captain's own orders only)
 * @access  Private (captain, waiter)
 */
router.get('/captain/detail/:orderId', orderController.getCaptainOrderDetail);

/**
 * @route   GET /api/v1/orders/takeaway/pending/:outletId
 * @desc    Get pending takeaway orders for cashier
 * @access  Private (cashier, manager, admin)
 * @query   status - 'pending' (default) | 'completed' | 'cancelled' | 'all'
 * @query   search - Search by order number, customer name, phone
 * @query   page, limit, sortBy, sortOrder
 */
router.get('/takeaway/pending/:outletId', orderController.getPendingTakeawayOrders);

/**
 * @route   GET /api/v1/orders/takeaway/detail/:id
 * @desc    Get detailed takeaway order — items, KOTs, discounts, payments, invoice
 * @access  Private (cashier, manager, admin)
 */
router.get('/takeaway/detail/:id', orderController.getTakeawayOrderDetail);

/**
 * @route   GET /api/v1/orders/table/:tableId
 * @desc    Get orders by table
 * @access  Private
 */
router.get('/table/:tableId', orderController.getOrdersByTable);

/**
 * @route   GET /api/v1/orders/cancel-reasons/:outletId
 * @desc    Get cancel reasons
 * @access  Private
 */
router.get('/cancel-reasons/:outletId', reportCache('order-cancel-reasons', 300), orderController.getCancelReasons);

/**
 * @route   GET /api/v1/orders/open-item-templates/:outletId
 * @desc    Get open item templates for outlet (cashier/manager/admin)
 * @access  Private (cashier, manager, admin)
 */
router.get('/open-item-templates/:outletId', authorize('super_admin', 'admin', 'manager', 'cashier'), orderController.getOpenItemTemplates);

/**
 * @route   GET /api/v1/orders/open-item-ingredients/:outletId
 * @desc    Get available ingredients for open items (cashier picks to deduct stock)
 * @access  Private (cashier, manager, admin)
 * @query   search - Filter by ingredient name
 */
router.get('/open-item-ingredients/:outletId', authorize('super_admin', 'admin', 'manager', 'cashier'), orderController.getIngredientsForOpenItem);

// ========================
// PAYMENTS (before :id routes to prevent conflict)
// ========================

/**
 * @route   POST /api/v1/orders/payment
 * @desc    Process payment
 * @access  Private (cashier, manager)
 */
router.post('/payment', validate(orderValidation.processPayment), orderController.processPayment);

/**
 * @route   POST /api/v1/orders/payment/split
 * @desc    Process split payment
 * @access  Private (cashier, manager)
 */
router.post('/payment/split', validate(orderValidation.splitPayment), orderController.processSplitPayment);

/**
 * @route   POST /api/v1/orders/refund
 * @desc    Initiate refund
 * @access  Private (manager)
 */
router.post('/refund', authorize('super_admin', 'admin', 'manager'), validate(orderValidation.initiateRefund), orderController.initiateRefund);

/**
 * @route   POST /api/v1/orders/refund/:id/approve
 * @desc    Approve refund
 * @access  Private (manager, admin)
 */
router.post('/refund/:id/approve', authorize('super_admin', 'admin', 'manager'), orderController.approveRefund);

/**
 * @route   GET /api/v1/orders/:id
 * @desc    Get order with items
 * @access  Private
 */
router.get('/:id', orderController.getOrder);

/**
 * @route   POST /api/v1/orders/:id/items
 * @desc    Add items to order
 * @access  Private
 */
router.post('/:id/items', validate(orderValidation.addItems), orderController.addItems);

/**
 * @route   PUT /api/v1/orders/:id/status
 * @desc    Update order status
 * @access  Private
 */
router.put('/:id/status', validate(orderValidation.updateStatus), orderController.updateStatus);

/**
 * @route   POST /api/v1/orders/:id/transfer
 * @desc    Transfer order to another table
 * @access  Private
 */
router.post('/:id/transfer', validate(orderValidation.transferTable), orderController.transferTable);

/**
 * @route   POST /api/v1/orders/:id/transfer-items
 * @desc    Transfer specific items from this order to another table
 * @access  Private (Cashier, Captain, Manager, Admin, Super Admin)
 * @body    { targetTableId: number, items: [{ orderItemId: number, quantity: number }] }
 */
router.post('/:id/transfer-items', validate(orderValidation.transferItems), orderController.transferItems);

/**
 * @route   POST /api/v1/orders/:id/cancel
 * @desc    Cancel entire order
 * @access  Private (manager approval may be required)
 */
router.post('/:id/cancel', validate(orderValidation.cancelOrder), orderController.cancelOrder);

/**
 * @route   PUT /api/v1/orders/items/:itemId/quantity
 * @desc    Update item quantity (before KOT)
 * @access  Private
 */
router.put('/items/:itemId/quantity', validate(orderValidation.updateItemQuantity), orderController.updateItemQuantity);

/**
 * @route   POST /api/v1/orders/items/:itemId/cancel
 * @desc    Cancel order item
 * @access  Private
 */
router.post('/items/:itemId/cancel', validate(orderValidation.cancelItem), orderController.cancelItem);

// ========================
// KOT MANAGEMENT
// ========================

/**
 * @route   POST /api/v1/orders/:id/kot
 * @desc    Send KOT for order
 * @access  Private
 */
router.post('/:id/kot', orderController.sendKot);

/**
 * @route   GET /api/v1/orders/kot/active
 * @desc    Get active KOTs for user's outlet (polling fallback for socket)
 * @access  Private (kitchen, bar staff)
 * @query   station - Filter by station (kitchen, bar, mocktail, dessert)
 * @query   status - Filter by status (pending, accepted, preparing, ready)
 */
router.get('/kot/active', orderController.getActiveKotsForUser);

/**
 * @route   GET /api/v1/orders/kot/active/:outletId
 * @desc    Get active KOTs for specific outlet (legacy/admin)
 * @access  Private
 * @query   station - Filter by station (kitchen, bar, mocktail, dessert)
 * @query   status - Filter by status (pending, accepted, preparing, ready)
 */
router.get('/kot/active/:outletId', orderController.getActiveKots);

/**
 * @route   GET /api/v1/orders/:orderId/kots
 * @desc    Get KOTs for order
 * @access  Private
 */
router.get('/:orderId/kots', orderController.getKotsByOrder);

/**
 * @route   GET /api/v1/orders/kot/:id
 * @desc    Get KOT by ID
 * @access  Private
 */
router.get('/kot/:id', orderController.getKotById);

/**
 * @route   POST /api/v1/orders/kot/:id/accept
 * @desc    Accept KOT (kitchen acknowledges)
 * @access  Private (kitchen, bar)
 */
router.post('/kot/:id/accept', orderController.acceptKot);

/**
 * @route   POST /api/v1/orders/kot/:id/preparing
 * @desc    Start preparing KOT
 * @access  Private (kitchen, bar)
 */
router.post('/kot/:id/preparing', orderController.startPreparingKot);

/**
 * @route   POST /api/v1/orders/kot/:id/ready
 * @desc    Mark entire KOT as ready
 * @access  Private (kitchen, bar)
 */
router.post('/kot/:id/ready', orderController.markKotReady);

/**
 * @route   POST /api/v1/orders/kot/:id/served
 * @desc    Mark KOT as served
 * @access  Private
 */
router.post('/kot/:id/served', orderController.markKotServed);

/**
 * @route   POST /api/v1/orders/kot/:id/reprint
 * @desc    Reprint KOT
 * @access  Private
 */
router.post('/kot/:id/reprint', orderController.reprintKot);

/**
 * @route   POST /api/v1/orders/kot/items/:itemId/ready
 * @desc    Mark single KOT item as ready
 * @access  Private (kitchen, bar)
 */
router.post('/kot/items/:itemId/ready', orderController.markItemReady);

/**
 * @route   GET /api/v1/orders/station/:station
 * @desc    Get station dashboard for user's outlet (kitchen, bar, mocktail)
 * @access  Private (kitchen, bar staff)
 */
router.get('/station/:station', orderController.getStationDashboardForUser);

/**
 * @route   GET /api/v1/orders/station/:outletId/:station
 * @desc    Get station dashboard for specific outlet (legacy/admin)
 * @access  Private
 */
router.get('/station/:outletId/:station', orderController.getStationDashboard);

// ========================
// BILLING
// ========================

/**
 * @route   GET /api/v1/orders/bills/pending/:outletId
 * @desc    Get all pending (unpaid) bills for cashier real-time view
 * @access  Private (cashier, manager, admin)
 */
router.get('/bills/pending/:outletId', orderController.getPendingBills);

/**
 * @route   POST /api/v1/orders/:id/bill
 * @desc    Generate bill for order
 * @access  Private
 */
router.post('/:id/bill', validate(orderValidation.generateBill), orderController.generateBill);

/**
 * @route   GET /api/v1/orders/:orderId/invoice
 * @desc    Get invoice by order
 * @access  Private
 */
router.get('/:orderId/invoice', orderController.getInvoiceByOrder);

/**
 * @route   GET /api/v1/orders/invoice/:id
 * @desc    Get invoice by ID
 * @access  Private
 */
router.get('/invoice/:id', orderController.getInvoice);

/**
 * @route   PUT /api/v1/orders/invoice/:id/charges
 * @desc    Update invoice charges — remove/restore service charge & GST
 * @access  Private (cashier, manager, admin)
 */
router.put('/invoice/:id/charges', validate(orderValidation.updateInvoiceCharges), orderController.updateInvoiceCharges);

/**
 * @route   GET|POST /api/v1/orders/invoice/:id/download
 * @desc    Download invoice as PDF (accepts invoice ID or order ID)
 * @access  Private (cashier, manager, admin)
 */
router.get('/invoice/:id/download', orderController.downloadInvoicePDF);
router.post('/invoice/:id/download', orderController.downloadInvoicePDF);

/**
 * @route   POST /api/v1/orders/invoice/:id/print
 * @desc    Print invoice to thermal printer
 * @access  Private (cashier, manager, admin)
 */
router.post('/invoice/:id/print', orderController.printInvoice);

/**
 * @route   POST /api/v1/orders/invoice/:id/duplicate
 * @desc    Print duplicate bill
 * @access  Private
 */
router.post('/invoice/:id/duplicate', orderController.printDuplicateBill);

/**
 * @route   POST /api/v1/orders/:id/split-bill
 * @desc    Split bill into multiple invoices
 * @access  Private
 */
router.post('/:id/split-bill', validate(orderValidation.splitBill), orderController.splitBill);

/**
 * @route   POST /api/v1/orders/invoice/:id/cancel
 * @desc    Cancel invoice
 * @access  Private (manager, admin)
 */
router.post('/invoice/:id/cancel', authorize('super_admin', 'admin', 'manager', 'cashier'), orderController.cancelInvoice);

/**
 * @route   GET /api/v1/orders/:id/discounts
 * @desc    Get all discounts applied to an order
 * @access  Private
 */
router.get('/:id/discounts', orderController.getOrderDiscounts);

/**
 * @route   POST /api/v1/orders/:id/discount
 * @desc    Apply manual discount (percentage or fixed) to order
 * @access  Private
 */
router.post('/:id/discount', validate(orderValidation.applyDiscount), orderController.applyDiscount);

/**
 * @route   POST /api/v1/orders/:id/discount/code
 * @desc    Apply discount by code from discounts master table
 * @access  Private (cashier, manager, admin)
 */
router.post('/:id/discount/code', validate(orderValidation.applyDiscountCode), orderController.applyDiscountByCode);

/**
 * @route   DELETE /api/v1/orders/:id/discount/:discountId
 * @desc    Remove a discount from an order
 * @access  Private
 */
router.delete('/:id/discount/:discountId', orderController.removeDiscount);

/**
 * @route   GET /api/v1/orders/:orderId/payments
 * @desc    Get payments for order
 * @access  Private
 */
router.get('/:orderId/payments', orderController.getPaymentsByOrder);

// ========================
// CASH DRAWER
// ========================

/**
 * @route   POST /api/v1/orders/cash-drawer/:outletId/open
 * @desc    Open cash drawer (day start)
 * @access  Private (cashier, manager)
 */
router.post('/cash-drawer/:outletId/open', validate(orderValidation.openCashDrawer), orderController.openCashDrawer);

/**
 * @route   POST /api/v1/orders/cash-drawer/:outletId/close
 * @desc    Close cash drawer (day end)
 * @access  Private (cashier, manager)
 */
router.post('/cash-drawer/:outletId/close', validate(orderValidation.closeCashDrawer), orderController.closeCashDrawer);

/**
 * @route   GET /api/v1/orders/cash-drawer/:outletId/status
 * @desc    Get cash drawer status for user's assigned floor
 * @access  Private
 * @query   floorId - Optional floor ID (defaults to user's assigned floor)
 */
router.get('/cash-drawer/:outletId/status', orderController.getCashDrawerStatus);

// ========================
// OUTSIDE COLLECTIONS
// ========================

/**
 * @route   POST /api/v1/orders/outside-collections/:outletId
 * @desc    Add an outside collection (Party Hall, Kitty Party, etc.)
 * @access  Private (cashier, manager, admin)
 * @body    amount, paymentMode, reason, description, collectionDate, floorId
 */
router.post('/outside-collections/:outletId', authorize('super_admin', 'admin', 'manager', 'cashier'), orderController.addOutsideCollection);

/**
 * @route   GET /api/v1/orders/outside-collections/:outletId
 * @desc    List outside collections with filters
 * @access  Private (cashier, manager, admin)
 * @query   startDate, endDate, floorId, collectedBy, status, page, limit
 */
router.get('/outside-collections/:outletId', authorize('super_admin', 'admin', 'manager', 'cashier'), orderController.getOutsideCollections);

/**
 * @route   GET /api/v1/orders/outside-collections/:outletId/export
 * @desc    Export outside collections as CSV
 * @access  Private (manager, admin)
 */
router.get('/outside-collections/:outletId/export', authorize('super_admin', 'admin', 'manager'), orderController.exportOutsideCollections);

/**
 * @route   GET /api/v1/orders/outside-collections/:outletId/:id
 * @desc    Get single outside collection
 * @access  Private (cashier, manager, admin)
 */
router.get('/outside-collections/:outletId/:id', authorize('super_admin', 'admin', 'manager', 'cashier'), orderController.getOutsideCollectionById);

/**
 * @route   PUT /api/v1/orders/outside-collections/:outletId/:id
 * @desc    Update an outside collection
 * @access  Private (manager, admin)
 */
router.put('/outside-collections/:outletId/:id', authorize('super_admin', 'admin', 'manager'), orderController.updateOutsideCollection);

/**
 * @route   DELETE /api/v1/orders/outside-collections/:outletId/:id
 * @desc    Cancel (soft-delete) an outside collection
 * @access  Private (manager, admin)
 */
router.delete('/outside-collections/:outletId/:id', authorize('super_admin', 'admin', 'manager'), orderController.cancelOutsideCollection);

/**
 * @route   GET /api/v1/orders/shifts/:outletId/floors
 * @desc    Get all floor shifts status for an outlet
 * @access  Private (cashier, manager, admin)
 */
router.get('/shifts/:outletId/floors', authorize('super_admin', 'admin', 'manager', 'cashier'), orderController.getAllFloorShiftsStatus);

/**
 * @route   GET /api/v1/orders/shifts/:outletId/floor/:floorId/status
 * @desc    Check if shift is open for a specific floor
 * @access  Private
 */
router.get('/shifts/:outletId/floor/:floorId/status', orderController.getFloorShiftStatus);

// ========================
// REPORTS
// ========================

/**
 * @route   GET /api/v1/orders/reports/:outletId/dashboard
 * @desc    Get live dashboard
 * @access  Private
 */
router.get('/reports/:outletId/dashboard', reportCache('order-dashboard', 30), orderController.getLiveDashboard);

/**
 * @route   GET /api/v1/orders/reports/:outletId/daily-sales
 * @desc    Get daily sales report
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/daily-sales', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-daily-sales', 30), orderController.getDailySalesReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/daily-sales/detail
 * @desc    Detailed daily sales — per-order with items, captain, cashier, tax, payments
 * @query   startDate, endDate
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/daily-sales/detail', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-daily-sales-detail', 30), orderController.getDailySalesDetail);

/**
 * @route   GET /api/v1/orders/reports/:outletId/item-sales
 * @desc    Get item sales report
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/item-sales', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-item-sales', 30), orderController.getItemSalesReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/item-sales/detail
 * @desc    Detailed item sales — per-item with every order occurrence, table, captain, tax, addons
 * @query   startDate, endDate, limit
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/item-sales/detail', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-item-sales-detail', 30), orderController.getItemSalesDetail);

/**
 * @route   GET /api/v1/orders/reports/:outletId/staff
 * @desc    Get staff performance report
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/staff', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-staff', 120), orderController.getStaffReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/category-sales
 * @desc    Get category sales report
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/category-sales', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-category-sales', 120), orderController.getCategorySalesReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/category-sales/detail
 * @desc    Detailed category sales — per-category with items, every order occurrence, table, captain, tax, addons
 * @query   startDate, endDate
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/category-sales/detail', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-category-sales-detail', 120), orderController.getCategorySalesDetail);

/**
 * @route   GET /api/v1/orders/reports/:outletId/payment-modes
 * @desc    Get payment mode report
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/payment-modes', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-payment-modes', 120), orderController.getPaymentModeReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/payment-modes/detail
 * @desc    Detailed payment modes — per-mode with every transaction, order/table/captain/items, daily & hourly breakdown
 * @query   startDate, endDate
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/payment-modes/detail', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-payment-modes-detail', 120), orderController.getPaymentModeDetail);

/**
 * @route   GET /api/v1/orders/reports/:outletId/tax
 * @desc    Get tax report
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/tax', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-tax', 120), orderController.getTaxReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/tax/detail
 * @desc    Detailed tax report — per-invoice with items, tax components, HSN, daily/rate breakdowns
 * @query   startDate, endDate
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/tax/detail', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-tax-detail', 120), orderController.getTaxDetail);

/**
 * @route   GET /api/v1/orders/reports/:outletId/hourly
 * @desc    Get hourly sales report
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/hourly', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-hourly', 120), orderController.getHourlySalesReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/floor-section
 * @desc    Get floor/section sales report
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/floor-section', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-floor-section', 120), orderController.getFloorSectionReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/counter
 * @desc    Get counter sales report (Kitchen vs Bar)
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/counter', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-counter', 120), orderController.getCounterSalesReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/counter/detail
 * @desc    Detailed counter report — per-KOT ticket with items, staff, prep time, station breakdowns
 * @query   startDate, endDate, page, limit, search, station, status, orderType, captainName, floorName, tableNumber, sortBy, sortOrder
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/counter/detail', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-counter-detail', 120), orderController.getCounterSalesDetail);

/**
 * @route   GET /api/v1/orders/reports/:outletId/cancellations
 * @desc    Get cancellation report
 * @access  Private (manager, admin)
 */
router.get('/reports/:outletId/cancellations', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-cancellations', 120), orderController.getCancellationReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/cancellations/detail
 * @desc    Detailed cancellation report — per-log with order context, items, KOT, staff, approval, breakdowns
 * @query   startDate, endDate, page, limit, search, cancelType, cancelledByName, approvedByName, captainName, cashierName, orderType, floorName, tableNumber, sortBy, sortOrder
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/cancellations/detail', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-cancellations-detail', 120), orderController.getCancellationDetail);

/**
 * @route   POST /api/v1/orders/reports/:outletId/aggregate
 * @desc    Aggregate daily sales (manual trigger)
 * @access  Private (admin)
 */
router.post('/reports/:outletId/aggregate', authorize('super_admin', 'admin'), reportCache('order-aggregate', 120), orderController.aggregateDailySales);

/**
 * @route   GET /api/v1/orders/reports/:outletId/service-type-breakdown
 * @desc    Get sales breakdown by service type (restaurant vs bar)
 * @access  Private (admin, manager, cashier)
 * @query   startDate - Filter from date (YYYY-MM-DD)
 * @query   endDate - Filter to date (YYYY-MM-DD)
 */
router.get('/reports/:outletId/service-type-breakdown', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-service-type-breakdown', 120), orderController.getServiceTypeSalesBreakdown);

/**
 * @route   GET /api/v1/orders/reports/:outletId/due
 * @desc    Get due report - customers with outstanding due amounts
 * @access  Private (admin, manager)
 * @query   page, limit, search, customerId, minDue, maxDue, sortBy, sortOrder
 */
router.get('/reports/:outletId/due', authorize('super_admin', 'admin', 'manager'), reportCache('order-due', 120), orderController.getDueReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/due/export
 * @desc    Export due report as CSV
 * @access  Private (admin, manager)
 */
router.get('/reports/:outletId/due/export', authorize('super_admin', 'admin', 'manager'), orderController.exportDueReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/nc
 * @desc    NC (No Charge) report — order-level and item-level NC with filters, pagination, sorting
 * @access  Private (admin, manager, cashier, captain)
 * @query   startDate, endDate, page, limit, search, ncType (order|item|all), ncReason, appliedByName, orderType, floorName, sortBy, sortOrder
 */
router.get('/reports/:outletId/nc', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('order-nc', 120), orderController.getNCReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/nc/export
 * @desc    Export NC report as CSV
 * @access  Private (admin, manager)
 */
router.get('/reports/:outletId/nc/export', authorize('super_admin', 'admin', 'manager'), orderController.exportNCReport);

// ========================
// SHIFT HISTORY
// ========================

/**
 * @route   GET /api/v1/orders/shifts/:outletId/history
 * @desc    Get shift history with pagination and filters
 * @access  Private (cashier, manager, admin)
 * @query   userId - Filter by specific user (opened_by or closed_by)
 * @query   startDate - Filter from date (YYYY-MM-DD)
 * @query   endDate - Filter to date (YYYY-MM-DD)
 * @query   status - 'open' | 'closed' | 'all'
 * @query   page - Page number (default: 1)
 * @query   limit - Items per page (default: 20)
 * @query   sortBy - session_date | opening_time | closing_time | total_sales | total_orders | cash_variance
 * @query   sortOrder - ASC | DESC (default: DESC)
 */
router.get('/shifts/:outletId/history', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('shift-history', 30), orderController.getShiftHistory);

/**
 * @route   GET /api/v1/orders/shifts/:shiftId/detail
 * @desc    Get detailed shift information with transactions, payments, staff activity
 * @access  Private (cashier, manager, admin)
 */
router.get('/shifts/:shiftId/detail', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('shift-detail', 30), orderController.getShiftDetail);

/**
 * @route   GET /api/v1/orders/shifts/:shiftId/summary
 * @desc    Get single shift summary with shift-time-based calculations
 * @access  Private (cashier, manager, admin)
 */
router.get('/shifts/:shiftId/summary', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('shift-summary', 30), orderController.getShiftSummaryById);

/**
 * @route   GET /api/v1/orders/shifts/:outletId/outlet-summary
 * @desc    Get shift summary statistics across date range for an outlet
 * @access  Private (cashier, manager, admin)
 * @query   startDate - Filter from date (YYYY-MM-DD)
 * @query   endDate - Filter to date (YYYY-MM-DD)
 */
router.get('/shifts/:outletId/outlet-summary', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), reportCache('shift-outlet-summary', 30), orderController.getShiftSummary);

/**
 * @route   GET /api/v1/orders/shifts/:outletId/history/export
 * @desc    Export shift history as CSV
 * @access  Private (cashier, manager, admin)
 * @query   startDate, endDate - Date range filters
 */
router.get('/shifts/:outletId/history/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportShiftHistory);

/**
 * @route   GET /api/v1/orders/shifts/:shiftId/detail/export
 * @desc    Export shift detail as CSV
 * @access  Private (cashier, manager, admin)
 */
router.get('/shifts/:shiftId/detail/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportShiftDetail);

// ========================
// ADMIN ORDER MANAGEMENT
// ========================

/**
 * @route   GET /api/v1/orders/admin/list
 * @desc    Get all orders for admin with comprehensive filters, pagination, sorting
 * @access  Private (admin, manager)
 * @query   outletId - Filter by outlet
 * @query   status - pending | confirmed | preparing | ready | served | billed | paid | completed | cancelled | all
 * @query   orderType - dine_in | takeaway | delivery | all
 * @query   paymentStatus - pending | partial | completed | all
 * @query   startDate - Filter from date (YYYY-MM-DD)
 * @query   endDate - Filter to date (YYYY-MM-DD)
 * @query   search - Search by order number, table number, customer name/phone, invoice number
 * @query   captainId - Filter by captain who created order
 * @query   cashierId - Filter by cashier who processed payment
 * @query   tableId - Filter by specific table
 * @query   floorId - Filter by floor
 * @query   minAmount - Minimum order amount
 * @query   maxAmount - Maximum order amount
 * @query   page - Page number (default: 1)
 * @query   limit - Items per page (default: 20)
 * @query   sortBy - created_at | order_number | total_amount | status | order_type | table_number
 * @query   sortOrder - ASC | DESC (default: DESC)
 */
router.get('/admin/list', authorize('super_admin', 'admin', 'manager'), orderController.getAdminOrderList);

/**
 * @route   GET /api/v1/orders/admin/list/export
 * @desc    Export orders list as CSV for admin/manager (respects floor permissions)
 * @access  Private (admin, manager)
 * @query   Same filters as /admin/list (outletId, status, orderType, etc.)
 */
router.get('/admin/list/export', authorize('super_admin', 'admin', 'manager'), orderController.exportAdminOrderList);

/**
 * @route   GET /api/v1/orders/admin/detail/:orderId
 * @desc    Get comprehensive order details for admin — items, KOTs, payments, discounts, cancellations, timeline
 * @access  Private (admin, manager)
 */
router.get('/admin/detail/:orderId', authorize('super_admin', 'admin', 'manager'), orderController.getAdminOrderDetail);

// ========================
// CSV EXPORT ENDPOINTS
// ========================

/**
 * @route   GET /api/v1/orders/reports/:outletId/daily-sales/export
 * @desc    Export daily sales report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/daily-sales/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportDailySales);

/**
 * @route   GET /api/v1/orders/reports/:outletId/daily-sales/detail/export
 * @desc    Export detailed daily sales as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/daily-sales/detail/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportDailySalesDetail);

/**
 * @route   GET /api/v1/orders/reports/:outletId/item-sales/export
 * @desc    Export item sales report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/item-sales/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportItemSales);

/**
 * @route   GET /api/v1/orders/reports/:outletId/item-sales/detail/export
 * @desc    Export detailed item sales report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/item-sales/detail/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportItemSalesDetail);

/**
 * @route   GET /api/v1/orders/reports/:outletId/category-sales/export
 * @desc    Export category sales report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/category-sales/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportCategorySales);

/**
 * @route   GET /api/v1/orders/reports/:outletId/staff/export
 * @desc    Export staff performance report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/staff/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportStaffReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/payment-modes/export
 * @desc    Export payment mode report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/payment-modes/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportPaymentModes);

/**
 * @route   GET /api/v1/orders/reports/:outletId/tax/export
 * @desc    Export tax report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/tax/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportTaxReport);

/**
 * @route   GET /api/v1/orders/reports/:outletId/service-type-breakdown/export
 * @desc    Export service type breakdown as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/service-type-breakdown/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportServiceTypeBreakdown);

/**
 * @route   GET /api/v1/orders/reports/:outletId/floor-section/export
 * @desc    Export floor/section sales report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/floor-section/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportFloorSection);

/**
 * @route   GET /api/v1/orders/reports/:outletId/counter/export
 * @desc    Export counter sales report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/counter/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportCounterSales);

/**
 * @route   GET /api/v1/orders/reports/:outletId/cancellations/export
 * @desc    Export cancellation report as CSV
 * @access  Private (manager, admin, cashier)
 */
router.get('/reports/:outletId/cancellations/export', authorize('super_admin', 'admin', 'manager', 'cashier', 'captain'), orderController.exportCancellations);

// ========================
// NC (NO CHARGE) MANAGEMENT
// ========================

const ncController = require('../controllers/nc.controller');

/**
 * @route   GET /api/v1/orders/:outletId/nc/reasons
 * @desc    Get NC reasons for an outlet
 * @access  Private (admin, manager, cashier)
 */
router.get('/:outletId/nc/reasons', authorize('super_admin', 'admin', 'manager', 'cashier'), reportCache('order-nc-reasons', 300), ncController.getNCReasons);

/**
 * @route   POST /api/v1/orders/:outletId/nc/reasons
 * @desc    Create NC reason
 * @access  Private (admin, manager)
 */
router.post('/:outletId/nc/reasons', authorize('super_admin', 'admin', 'manager'), ncController.createNCReason);

/**
 * @route   PUT /api/v1/orders/:outletId/nc/reasons/:reasonId
 * @desc    Update NC reason
 * @access  Private (admin, manager)
 */
router.put('/:outletId/nc/reasons/:reasonId', authorize('super_admin', 'admin', 'manager'), ncController.updateNCReason);

/**
 * @route   POST /api/v1/orders/:orderId/nc
 * @desc    Mark entire order as NC
 * @access  Private (admin, manager, cashier)
 */
router.post('/:orderId/nc', authorize('super_admin', 'admin', 'manager', 'cashier'), ncController.markOrderAsNC);

/**
 * @route   DELETE /api/v1/orders/:orderId/nc
 * @desc    Remove NC from entire order
 * @access  Private (admin, manager)
 */
router.delete('/:orderId/nc', authorize('super_admin', 'admin', 'manager', 'cashier'), ncController.removeOrderNC);

/**
 * @route   GET /api/v1/orders/:orderId/nc/logs
 * @desc    Get NC logs for an order
 * @access  Private (admin, manager, cashier)
 */
router.get('/:orderId/nc/logs', authorize('super_admin', 'admin', 'manager', 'cashier'), reportCache('order-nc-logs', 120), ncController.getNCLogs);

/**
 * @route   POST /api/v1/orders/:orderId/items/:orderItemId/nc
 * @desc    Mark an order item as NC
 * @access  Private (admin, manager, cashier)
 */
router.post('/:orderId/items/:orderItemId/nc', authorize('super_admin', 'admin', 'manager', 'cashier'), ncController.markItemAsNC);

/**
 * @route   DELETE /api/v1/orders/:orderId/items/:orderItemId/nc
 * @desc    Remove NC from an order item
 * @access  Private (admin, manager)
 */
router.delete('/:orderId/items/:orderItemId/nc', authorize('super_admin', 'admin', 'manager'), ncController.removeItemNC);

/**
 * @route   POST /api/v1/orders/:orderId/items/nc/bulk
 * @desc    Mark multiple order items as NC (bulk operation)
 * @access  Private (admin, manager, cashier)
 * @body    { items: [{ orderItemId, ncReasonId?, ncReason? }], ncReasonId?, ncReason?, notes? }
 */
router.post('/:orderId/items/nc/bulk', authorize('super_admin', 'admin', 'manager', 'cashier'), ncController.markItemsAsNC);

/**
 * @route   DELETE /api/v1/orders/:orderId/items/nc/bulk
 * @desc    Remove NC from multiple order items (bulk operation)
 * @access  Private (admin, manager)
 * @body    { orderItemIds: [1, 2, 3], notes? }
 */
router.delete('/:orderId/items/nc/bulk', authorize('super_admin', 'admin', 'manager', 'cashier'), ncController.removeItemsNC);

/**
 * @route   GET /api/v1/orders/reports/:outletId/nc
 * @desc    Get NC report for an outlet
 * @access  Private (admin, manager)
 * @query   startDate, endDate - Date range (required)
 * @query   groupBy - 'date' | 'reason' | 'staff' | 'item'
 */
router.get('/reports/:outletId/nc', authorize('super_admin', 'admin', 'manager'), reportCache('order-nc-report', 120), ncController.getNCReport);

// ========================
// COST SNAPSHOT
// ========================

/**
 * @route   GET /api/v1/orders/:orderId/costs
 * @desc    Get making cost snapshot for an order (frozen at order time)
 * @access  Private (admin, manager)
 */
router.get('/:orderId/costs', authorize('super_admin', 'admin', 'manager'), orderController.getOrderCosts);

module.exports = router;
