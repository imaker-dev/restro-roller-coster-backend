/**
 * Menu Management Validation Schemas
 */

const Joi = require('joi');

const ITEM_TYPES = ['veg', 'non_veg', 'egg', 'vegan'];
const ADJUSTMENT_TYPES = ['fixed', 'percentage', 'override'];
const RULE_TYPES = ['floor', 'section', 'time_slot', 'day_of_week', 'date_range', 'happy_hour'];
const DISCOUNT_TYPES = ['percentage', 'flat', 'item_level', 'bill_level', 'buy_x_get_y'];
const DAYS_OF_WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const SERVICE_TYPES = ['restaurant', 'bar', 'both'];

module.exports = {
  // ========================
  // TAX VALIDATION
  // ========================

  createTaxType: Joi.object({
    name: Joi.string().max(50).required(),
    code: Joi.string().max(20).required(),
    description: Joi.string().max(255).allow('', null),
    isActive: Joi.boolean().default(true)
  }),

  updateTaxType: Joi.object({
    name: Joi.string().max(50),
    code: Joi.string().max(20),
    description: Joi.string().max(255).allow('', null),
    isActive: Joi.boolean()
  }),

  createTaxComponent: Joi.object({
    taxTypeId: Joi.number().integer().positive().required(),
    name: Joi.string().max(50).required(),
    code: Joi.string().max(20).required(),
    rate: Joi.number().min(0).max(100).required(),
    description: Joi.string().max(255).allow('', null),
    isActive: Joi.boolean().default(true)
  }),

  createTaxGroup: Joi.object({
    outletId: Joi.number().integer().positive().allow(null),
    name: Joi.string().max(100).required(),
    code: Joi.string().max(20).allow('', null),
    description: Joi.string().max(255).allow('', null),
    isInclusive: Joi.boolean().default(false),
    isDefault: Joi.boolean().default(false),
    isActive: Joi.boolean().default(true),
    componentIds: Joi.array().items(Joi.number().integer().positive()).default([])
  }),

  updateTaxGroup: Joi.object({
    name: Joi.string().max(100),
    code: Joi.string().max(20).allow('', null),
    description: Joi.string().max(255).allow('', null),
    isInclusive: Joi.boolean(),
    isDefault: Joi.boolean(),
    isActive: Joi.boolean(),
    componentIds: Joi.array().items(Joi.number().integer().positive())
  }),

  // ========================
  // TIME SLOT VALIDATION
  // ========================

  createTimeSlot: Joi.object({
    outletId: Joi.number().integer().positive().required(),
    name: Joi.string().max(50).required(),
    code: Joi.string().max(20).allow('', null),
    description: Joi.string().max(255).allow('', null),
    startTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/).required(),
    endTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/).required(),
    activeDays: Joi.array().items(Joi.string().valid(...DAYS_OF_WEEK)).default(DAYS_OF_WEEK),
    isActive: Joi.boolean().default(true),
    displayOrder: Joi.number().integer().min(0).default(0)
  }),

  updateTimeSlot: Joi.object({
    name: Joi.string().max(50),
    code: Joi.string().max(20).allow('', null),
    description: Joi.string().max(255).allow('', null),
    startTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/),
    endTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/),
    activeDays: Joi.array().items(Joi.string().valid(...DAYS_OF_WEEK)),
    isActive: Joi.boolean(),
    displayOrder: Joi.number().integer().min(0)
  }),

  // ========================
  // CATEGORY VALIDATION
  // ========================

  createCategory: Joi.object({
    outletId: Joi.number().integer().positive().required(),
    parentId: Joi.number().integer().positive().allow(null),
    name: Joi.string().max(100).required(),
    slug: Joi.string().max(100).allow('', null),
    description: Joi.string().allow('', null),
    imageUrl: Joi.string().max(500).allow('', null),
    icon: Joi.string().max(50).allow('', null),
    colorCode: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).allow('', null),
    displayOrder: Joi.number().integer().min(0).default(0),
    isActive: Joi.boolean().default(true),
    isGlobal: Joi.boolean().default(false),
    serviceType: Joi.string().valid(...SERVICE_TYPES).default('both'),
    floorIds: Joi.array().items(Joi.number().integer().positive()).default([]),
    sectionIds: Joi.array().items(Joi.number().integer().positive()).default([]),
    timeSlotIds: Joi.array().items(Joi.number().integer().positive()).default([])
  }),

  updateCategory: Joi.object({
    parentId: Joi.number().integer().positive().allow(null),
    name: Joi.string().max(100),
    slug: Joi.string().max(100).allow('', null),
    description: Joi.string().allow('', null),
    imageUrl: Joi.string().max(500).allow('', null),
    icon: Joi.string().max(50).allow('', null),
    colorCode: Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/).allow('', null),
    displayOrder: Joi.number().integer().min(0),
    isActive: Joi.boolean(),
    isGlobal: Joi.boolean(),
    serviceType: Joi.string().valid(...SERVICE_TYPES),
    floorIds: Joi.array().items(Joi.number().integer().positive()),
    sectionIds: Joi.array().items(Joi.number().integer().positive()),
    timeSlotIds: Joi.array().items(Joi.number().integer().positive())
  }),

  // ========================
  // ITEM VALIDATION
  // ========================

  createItem: Joi.object({
    outletId: Joi.number().integer().positive().required(),
    categoryId: Joi.number().integer().positive().required(),
    sku: Joi.string().max(50).allow('', null),
    name: Joi.string().max(150).required(),
    shortName: Joi.string().max(50).allow('', null),
    description: Joi.string().allow('', null),
    itemType: Joi.string().valid(...ITEM_TYPES).default('veg'),
    basePrice: Joi.number().min(0).required(),
    costPrice: Joi.number().min(0).default(0),
    taxGroupId: Joi.number().integer().positive().allow(null, '').default(null),
    taxEnabled: Joi.boolean().default(true),
    imageUrl: Joi.string().allow('', null),
    preparationTimeMins: Joi.number().integer().min(0).default(15),
    spiceLevel: Joi.number().integer().min(0).max(5).default(0),
    calories: Joi.number().integer().min(0).allow(null),
    allergens: Joi.string().max(255).allow('', null),
    tags: Joi.string().max(255).allow('', null),
    isCustomizable: Joi.boolean().default(false),
    hasVariants: Joi.boolean().default(false),
    hasAddons: Joi.boolean().default(false),
    allowSpecialNotes: Joi.boolean().default(true),
    minQuantity: Joi.number().integer().min(1).default(1),
    maxQuantity: Joi.number().integer().min(1).allow(null),
    stepQuantity: Joi.number().integer().min(1).default(1),
    isAvailable: Joi.boolean().default(true),
    isRecommended: Joi.boolean().default(false),
    isBestseller: Joi.boolean().default(false),
    isNew: Joi.boolean().default(false),
    displayOrder: Joi.number().integer().min(0).default(0),
    isActive: Joi.boolean().default(true),
    isGlobal: Joi.boolean().default(false),
    isOpenItem: Joi.boolean().default(false),
    kitchenStationId: Joi.number().integer().positive().allow(null),
    counterId: Joi.number().integer().positive().allow(null),
    floorIds: Joi.array().items(Joi.number().integer().positive()).default([]),
    sectionIds: Joi.array().items(Joi.number().integer().positive()).default([]),
    timeSlotIds: Joi.array().items(Joi.number().integer().positive()).default([]),
    variants: Joi.array().items(Joi.object({
      name: Joi.string().max(50).required(),
      sku: Joi.string().max(50).allow('', null),
      price: Joi.number().min(0).required(),
      costPrice: Joi.number().min(0).default(0),
      taxGroupId: Joi.number().integer().positive().allow(null),
      isDefault: Joi.boolean().default(false),
      inventoryMultiplier: Joi.number().min(0).default(1),
      displayOrder: Joi.number().integer().min(0).default(0)
    })).default([]),
    addonGroupIds: Joi.array().items(Joi.number().integer().positive()).default([])
  }),

  updateItem: Joi.object({
    categoryId: Joi.number().integer().positive(),
    sku: Joi.string().max(50).allow('', null),
    name: Joi.string().max(150),
    shortName: Joi.string().max(50).allow('', null),
    description: Joi.string().allow('', null),
    itemType: Joi.string().valid(...ITEM_TYPES),
    basePrice: Joi.number().min(0),
    costPrice: Joi.number().min(0),
    taxGroupId: Joi.number().integer().positive().allow(null, ''),
    taxEnabled: Joi.boolean(),
    imageUrl: Joi.string().allow('', null),
    preparationTimeMins: Joi.number().integer().min(0),
    spiceLevel: Joi.number().integer().min(0).max(5),
    calories: Joi.number().integer().min(0).allow(null),
    allergens: Joi.string().max(255).allow('', null),
    tags: Joi.string().max(255).allow('', null),
    isCustomizable: Joi.boolean(),
    hasVariants: Joi.boolean(),
    hasAddons: Joi.boolean(),
    allowSpecialNotes: Joi.boolean(),
    minQuantity: Joi.number().integer().min(1),
    maxQuantity: Joi.number().integer().min(1).allow(null),
    stepQuantity: Joi.number().integer().min(1),
    isAvailable: Joi.boolean(),
    isRecommended: Joi.boolean(),
    isBestseller: Joi.boolean(),
    isNew: Joi.boolean(),
    displayOrder: Joi.number().integer().min(0),
    isActive: Joi.boolean(),
    isGlobal: Joi.boolean(),
    isOpenItem: Joi.boolean(),
    kitchenStationId: Joi.number().integer().positive().allow(null),
    counterId: Joi.number().integer().positive().allow(null),
    floorIds: Joi.array().items(Joi.number().integer().positive()),
    sectionIds: Joi.array().items(Joi.number().integer().positive()),
    timeSlotIds: Joi.array().items(Joi.number().integer().positive()),
    addonGroupIds: Joi.array().items(Joi.number().integer().positive())
  }),

  createVariant: Joi.object({
    name: Joi.string().max(50).required(),
    sku: Joi.string().max(50).allow('', null),
    price: Joi.number().min(0).required(),
    costPrice: Joi.number().min(0).default(0),
    taxGroupId: Joi.number().integer().positive().allow(null),
    isDefault: Joi.boolean().default(false),
    inventoryMultiplier: Joi.number().min(0).default(1),
    displayOrder: Joi.number().integer().min(0).default(0)
  }),

  // ========================
  // ADDON VALIDATION
  // ========================

  createAddonGroup: Joi.object({
    outletId: Joi.number().integer().positive().required(),
    name: Joi.string().max(100).required(),
    description: Joi.string().max(255).allow('', null),
    selectionType: Joi.string().valid('single', 'multiple').default('multiple'),
    minSelection: Joi.number().integer().min(0).default(0),
    maxSelection: Joi.number().integer().min(1).default(10),
    isRequired: Joi.boolean().default(false),
    displayOrder: Joi.number().integer().min(0).default(0),
    isActive: Joi.boolean().default(true)
  }),

  updateAddonGroup: Joi.object({
    name: Joi.string().max(100),
    description: Joi.string().max(255).allow('', null),
    selectionType: Joi.string().valid('single', 'multiple'),
    minSelection: Joi.number().integer().min(0),
    maxSelection: Joi.number().integer().min(1),
    isRequired: Joi.boolean(),
    displayOrder: Joi.number().integer().min(0),
    isActive: Joi.boolean()
  }),

  createAddon: Joi.object({
    addonGroupId: Joi.number().integer().positive().required(),
    name: Joi.string().max(100).required(),
    price: Joi.number().min(0).default(0),
    itemType: Joi.string().valid(...ITEM_TYPES).default('veg'),
    imageUrl: Joi.string().max(500).allow('', null),
    isDefault: Joi.boolean().default(false),
    displayOrder: Joi.number().integer().min(0).default(0),
    isActive: Joi.boolean().default(true)
  }),

  updateAddon: Joi.object({
    name: Joi.string().max(100),
    price: Joi.number().min(0),
    itemType: Joi.string().valid(...ITEM_TYPES),
    imageUrl: Joi.string().max(500).allow('', null),
    isDefault: Joi.boolean(),
    displayOrder: Joi.number().integer().min(0),
    isActive: Joi.boolean()
  }),

  // ========================
  // PRICE RULE VALIDATION
  // ========================

  createPriceRule: Joi.object({
    outletId: Joi.number().integer().positive().required(),
    name: Joi.string().max(100).required(),
    description: Joi.string().max(255).allow('', null),
    ruleType: Joi.string().valid(...RULE_TYPES).required(),
    itemId: Joi.number().integer().positive().allow(null),
    variantId: Joi.number().integer().positive().allow(null),
    categoryId: Joi.number().integer().positive().allow(null),
    floorId: Joi.number().integer().positive().allow(null),
    sectionId: Joi.number().integer().positive().allow(null),
    timeStart: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/).allow(null),
    timeEnd: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/).allow(null),
    daysOfWeek: Joi.string().max(100).allow('', null),
    dateStart: Joi.date().allow(null),
    dateEnd: Joi.date().allow(null),
    adjustmentType: Joi.string().valid(...ADJUSTMENT_TYPES).default('percentage'),
    adjustmentValue: Joi.number().required(),
    priority: Joi.number().integer().min(0).default(0),
    isActive: Joi.boolean().default(true)
  }),

  createHappyHour: Joi.object({
    name: Joi.string().max(100).required(),
    description: Joi.string().max(255).allow('', null),
    timeStart: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/).required(),
    timeEnd: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/).required(),
    daysOfWeek: Joi.string().max(100).allow('', null),
    discountPercent: Joi.number().min(0).max(100).required(),
    categoryIds: Joi.array().items(Joi.number().integer().positive()).default([]),
    itemIds: Joi.array().items(Joi.number().integer().positive()).default([]),
    priority: Joi.number().integer().min(0).default(10),
    isActive: Joi.boolean().default(true)
  }),

  // ========================
  // DISCOUNT VALIDATION
  // ========================

  createDiscount: Joi.object({
    outletId: Joi.number().integer().positive().required(),
    code: Joi.string().max(50).allow('', null),
    name: Joi.string().max(100).required(),
    description: Joi.string().max(255).allow('', null),
    discountType: Joi.string().valid(...DISCOUNT_TYPES).required(),
    value: Joi.number().min(0).required(),
    maxDiscountAmount: Joi.number().min(0).allow(null),
    minOrderAmount: Joi.number().min(0).default(0),
    minQuantity: Joi.number().integer().min(1).default(1),
    applicableOn: Joi.string().valid('all', 'category', 'item', 'order_type').default('all'),
    categoryIds: Joi.array().items(Joi.number().integer().positive()).allow(null),
    itemIds: Joi.array().items(Joi.number().integer().positive()).allow(null),
    orderTypes: Joi.array().items(Joi.string()).allow(null),
    validFrom: Joi.date().allow(null),
    validUntil: Joi.date().allow(null),
    usageLimit: Joi.number().integer().min(1).allow(null),
    perUserLimit: Joi.number().integer().min(1).allow(null),
    requiresApproval: Joi.boolean().default(false),
    approvalRoleId: Joi.number().integer().positive().allow(null),
    isAutoApply: Joi.boolean().default(false),
    isCombinable: Joi.boolean().default(false),
    priority: Joi.number().integer().min(0).default(0),
    isActive: Joi.boolean().default(true)
  }),

  // ========================
  // MENU ENGINE VALIDATION
  // ========================

  menuContext: Joi.object({
    floorId: Joi.number().integer().positive().allow(null),
    sectionId: Joi.number().integer().positive().allow(null),
    timeSlotId: Joi.number().integer().positive().allow(null),
    tableId: Joi.number().integer().positive().allow(null),
    time: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/).allow(null)
  }),

  calculateItemTotal: Joi.object({
    itemId: Joi.number().integer().positive().required(),
    variantId: Joi.number().integer().positive().allow(null),
    quantity: Joi.number().integer().min(1).required(),
    addons: Joi.array().items(Joi.number().integer().positive()).default([]),
    floorId: Joi.number().integer().positive().allow(null),
    sectionId: Joi.number().integer().positive().allow(null),
    timeSlotId: Joi.number().integer().positive().allow(null)
  }),

  searchItems: Joi.object({
    query: Joi.string().min(1).max(100).required(),
    floorId: Joi.number().integer().positive().allow(null),
    sectionId: Joi.number().integer().positive().allow(null),
    timeSlotId: Joi.number().integer().positive().allow(null),
    limit: Joi.number().integer().min(1).max(100).default(20)
  })
};
