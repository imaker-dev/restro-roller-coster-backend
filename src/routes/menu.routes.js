const express = require('express');
const router = express.Router();
const menuController = require('../controllers/menu.controller');
const taxController = require('../controllers/tax.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares');
const menuValidation = require('../validations/menu.validation');
const { reportCache } = require('../middleware/reportCache');

// All routes require authentication
router.use(authenticate);

// ========================
// MENU ENGINE (Captain View)
// ========================

/**
 * @route   GET /api/v1/menu/:outletId
 * @desc    Get dynamic menu for outlet (with context filters)
 * @access  Private
 */
router.get('/:outletId', menuController.getMenu);

/**
 * @route   GET /api/v1/menu/:outletId/captain
 * @desc    Get simplified captain menu
 * @access  Private
 */
router.get('/:outletId/captain', reportCache('menu-captain', 1800), menuController.getCaptainMenu);

/**
 * @route   GET /api/v1/menu/:outletId/preview
 * @desc    Preview menu for admin
 * @access  Private (admin, manager)
 */
router.get('/:outletId/preview', authorize('super_admin', 'admin', 'manager'), menuController.previewMenu);

/**
 * @route   GET /api/v1/menu/:outletId/rules
 * @desc    Get menu rules summary
 * @access  Private (admin, manager)
 */
router.get('/:outletId/rules', authorize('super_admin', 'admin', 'manager'), menuController.getMenuRulesSummary);

/**
 * @route   GET /api/v1/menu/:outletId/search
 * @desc    Search menu items
 * @access  Private
 */
router.get('/:outletId/search', reportCache('menu-search', 1800), menuController.searchItems);

/**
 * @route   GET /api/v1/menu/:outletId/featured
 * @desc    Get featured items (bestsellers, recommended)
 * @access  Private
 */
router.get('/:outletId/featured', menuController.getFeaturedItems);

/**
 * @route   GET /api/v1/menu/item/:itemId/order
 * @desc    Get item details for ordering
 * @access  Private
 */
router.get('/item/:itemId/order', menuController.getItemForOrder);

/**
 * @route   POST /api/v1/menu/calculate
 * @desc    Calculate item total with tax
 * @access  Private
 */
router.post('/calculate', validate(menuValidation.calculateItemTotal), menuController.calculateItemTotal);

// ========================
// CATEGORIES
// ========================

/**
 * @route   POST /api/v1/menu/categories
 * @desc    Create category
 * @access  Private (admin, manager)
 */
router.post('/categories', authorize('super_admin', 'admin', 'manager'), validate(menuValidation.createCategory), menuController.createCategory);

/**
 * @route   GET /api/v1/menu/categories/outlet/:outletId
 * @desc    Get categories by outlet
 * @access  Private
 */
router.get('/categories/outlet/:outletId', menuController.getCategories);

/**
 * @route   GET /api/v1/menu/categories/outlet/:outletId/tree
 * @desc    Get category tree
 * @access  Private
 */
router.get('/categories/outlet/:outletId/tree', menuController.getCategoryTree);

/**
 * @route   GET /api/v1/menu/categories/:id
 * @desc    Get category by ID with visibility rules
 * @access  Private
 */
router.get('/categories/:id', menuController.getCategoryById);

/**
 * @route   PUT /api/v1/menu/categories/:id
 * @desc    Update category
 * @access  Private (admin, manager)
 */
router.put('/categories/:id', authorize('super_admin', 'admin', 'manager'), validate(menuValidation.updateCategory), menuController.updateCategory);

/**
 * @route   DELETE /api/v1/menu/categories/:id
 * @desc    Delete category
 * @access  Private (admin)
 */
router.delete('/categories/:id', authorize('super_admin', 'admin'), menuController.deleteCategory);

// ========================
// ITEMS
// ========================

/**
 * @route   POST /api/v1/menu/items
 * @desc    Create item
 * @access  Private (admin, manager)
 */
router.post('/items', authorize('super_admin', 'admin', 'manager'), validate(menuValidation.createItem), menuController.createItem);

/**
 * @route   GET /api/v1/menu/items/outlet/:outletId
 * @desc    Get items by outlet
 * @access  Private
 */
router.get('/items/outlet/:outletId', menuController.getItems);

/**
 * @route   GET /api/v1/menu/items/category/:categoryId
 * @desc    Get items by category
 * @access  Private
 */
router.get('/items/category/:categoryId', menuController.getItemsByCategory);

/**
 * @route   GET /api/v1/menu/items/:id
 * @desc    Get item by ID
 * @access  Private
 */
router.get('/items/:id', menuController.getItemById);

/**
 * @route   GET /api/v1/menu/items/:id/details
 * @desc    Get item full details
 * @access  Private
 */
router.get('/items/:id/details', menuController.getItemFullDetails);

/**
 * @route   PUT /api/v1/menu/items/:id
 * @desc    Update item
 * @access  Private (admin, manager)
 */
router.put('/items/:id', authorize('super_admin', 'admin', 'manager'), validate(menuValidation.updateItem), menuController.updateItem);

/**
 * @route   DELETE /api/v1/menu/items/:id
 * @desc    Delete item
 * @access  Private (admin)
 */
router.delete('/items/:id', authorize('super_admin', 'admin'), menuController.deleteItem);

// ========================
// VARIANTS
// ========================

/**
 * @route   POST /api/v1/menu/items/:itemId/variants
 * @desc    Add variant to item
 * @access  Private (admin, manager)
 */
router.post('/items/:itemId/variants', authorize('super_admin', 'admin', 'manager'), validate(menuValidation.createVariant), menuController.addVariant);

/**
 * @route   GET /api/v1/menu/items/:itemId/variants
 * @desc    Get variants for item
 * @access  Private
 */
router.get('/items/:itemId/variants', menuController.getVariants);

/**
 * @route   PUT /api/v1/menu/variants/:variantId
 * @desc    Update variant
 * @access  Private (admin, manager)
 */
router.put('/variants/:variantId', authorize('super_admin', 'admin', 'manager'), menuController.updateVariant);

/**
 * @route   DELETE /api/v1/menu/variants/:variantId
 * @desc    Delete variant
 * @access  Private (admin)
 */
router.delete('/variants/:variantId', authorize('super_admin', 'admin'), menuController.deleteVariant);

// ========================
// ADDON GROUPS
// ========================

/**
 * @route   POST /api/v1/menu/addon-groups
 * @desc    Create addon group
 * @access  Private (admin, manager)
 */
router.post('/addon-groups', authorize('super_admin', 'admin', 'manager'), validate(menuValidation.createAddonGroup), menuController.createAddonGroup);

/**
 * @route   GET /api/v1/menu/addon-groups/outlet/:outletId
 * @desc    Get addon groups by outlet
 * @access  Private
 */
router.get('/addon-groups/outlet/:outletId', menuController.getAddonGroups);

/**
 * @route   GET /api/v1/menu/addon-groups/:id
 * @desc    Get addon group with addons
 * @access  Private
 */
router.get('/addon-groups/:id', menuController.getAddonGroupById);

/**
 * @route   PUT /api/v1/menu/addon-groups/:id
 * @desc    Update addon group
 * @access  Private (admin, manager)
 */
router.put('/addon-groups/:id', authorize('super_admin', 'admin', 'manager'), validate(menuValidation.updateAddonGroup), menuController.updateAddonGroup);

/**
 * @route   DELETE /api/v1/menu/addon-groups/:id
 * @desc    Delete addon group
 * @access  Private (admin)
 */
router.delete('/addon-groups/:id', authorize('super_admin', 'admin'), menuController.deleteAddonGroup);

// ========================
// ADDONS
// ========================

/**
 * @route   POST /api/v1/menu/addons
 * @desc    Create addon
 * @access  Private (admin, manager)
 */
router.post('/addons', authorize('super_admin', 'admin', 'manager'), validate(menuValidation.createAddon), menuController.createAddon);

/**
 * @route   GET /api/v1/menu/addons/group/:groupId
 * @desc    Get addons by group
 * @access  Private
 */
router.get('/addons/group/:groupId', menuController.getAddons);

/**
 * @route   PUT /api/v1/menu/addons/:id
 * @desc    Update addon
 * @access  Private (admin, manager)
 */
router.put('/addons/:id', authorize('super_admin', 'admin', 'manager'), validate(menuValidation.updateAddon), menuController.updateAddon);

/**
 * @route   DELETE /api/v1/menu/addons/:id
 * @desc    Delete addon
 * @access  Private (admin)
 */
router.delete('/addons/:id', authorize('super_admin', 'admin'), menuController.deleteAddon);

/**
 * @route   POST /api/v1/menu/items/:itemId/addon-groups/:groupId
 * @desc    Map addon group to item
 * @access  Private (admin, manager)
 */
router.post('/items/:itemId/addon-groups/:groupId', authorize('super_admin', 'admin', 'manager'), menuController.mapAddonToItem);

/**
 * @route   DELETE /api/v1/menu/items/:itemId/addon-groups/:groupId
 * @desc    Unmap addon group from item
 * @access  Private (admin, manager)
 */
router.delete('/items/:itemId/addon-groups/:groupId', authorize('super_admin', 'admin', 'manager'), menuController.unmapAddonFromItem);

module.exports = router;
