/**
 * Order Management Validation Schemas
 */

const Joi = require('joi');

const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery', 'online'];
const ORDER_STATUS = ['pending', 'confirmed', 'preparing', 'ready', 'served', 'billed', 'paid', 'cancelled'];
const ITEM_STATUS = ['pending', 'sent_to_kitchen', 'preparing', 'ready', 'served', 'cancelled'];
const PAYMENT_MODES = ['cash', 'card', 'upi', 'wallet', 'credit', 'complimentary', 'split'];
const KOT_STATUS = ['pending', 'accepted', 'preparing', 'ready', 'served', 'cancelled'];

module.exports = {
  // ========================
  // ORDER VALIDATION
  // ========================

  createOrder: Joi.object({
    outletId: Joi.number().integer().positive().required(),
    tableId: Joi.number().integer().positive().allow(null),
    floorId: Joi.number().integer().positive().allow(null),
    sectionId: Joi.number().integer().positive().allow(null),
    orderType: Joi.string().valid(...ORDER_TYPES).default('dine_in'),
    customerId: Joi.number().integer().positive().allow(null),
    customerName: Joi.string().max(100).allow('', null),
    customerPhone: Joi.string().max(20).allow('', null),
    guestCount: Joi.number().integer().min(1).default(1),
    specialInstructions: Joi.string().max(500).allow('', null)
  }),

  addItems: Joi.object({
    items: Joi.array().items(Joi.object({
      itemId: Joi.number().integer().positive().required(),
      variantId: Joi.number().integer().positive().allow(null),
      quantity: Joi.number().min(0.5).required(),
      addons: Joi.array().items(Joi.number().integer().positive()).default([]),
      specialInstructions: Joi.string().max(255).allow('', null),
      isComplimentary: Joi.boolean().default(false),
      complimentaryReason: Joi.string().max(255).allow('', null)
    })).min(1).required()
  }),

  updateItemQuantity: Joi.object({
    quantity: Joi.number().min(0.5).required()
  }),

  cancelItem: Joi.object({
    reason: Joi.string().max(255).required(),
    reasonId: Joi.number().integer().positive().allow(null),
    quantity: Joi.number().min(0.5).allow(null),
    approvedBy: Joi.number().integer().positive().allow(null)
  }),

  cancelOrder: Joi.object({
    reason: Joi.string().max(255).required(),
    reasonId: Joi.number().integer().positive().allow(null),
    approvedBy: Joi.number().integer().positive().allow(null)
  }),

  transferTable: Joi.object({
    toTableId: Joi.number().integer().positive().required()
  }),

  updateStatus: Joi.object({
    status: Joi.string().valid(...ORDER_STATUS).required()
  }),

  // ========================
  // KOT VALIDATION
  // ========================

  updateKotStatus: Joi.object({
    status: Joi.string().valid(...KOT_STATUS).required()
  }),

  // ========================
  // BILLING VALIDATION
  // ========================

  generateBill: Joi.object({
    customerId: Joi.number().integer().positive().allow(null),
    customerName: Joi.string().max(100).allow('', null),
    customerPhone: Joi.string().max(20).allow('', null),
    customerEmail: Joi.string().email().allow('', null),
    customerGstin: Joi.string().max(20).allow('', null),
    customerAddress: Joi.string().allow('', null),
    billingAddress: Joi.string().allow('', null),
    applyServiceCharge: Joi.boolean().default(true),
    notes: Joi.string().allow('', null),
    termsConditions: Joi.string().allow('', null)
  }),

  splitBill: Joi.object({
    splits: Joi.array().items(Joi.object({
      itemIds: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
      customerName: Joi.string().max(100).allow('', null),
      customerPhone: Joi.string().max(20).allow('', null)
    })).min(2).required()
  }),

  applyDiscount: Joi.object({
    discountId: Joi.number().integer().positive().allow(null),
    discountCode: Joi.string().max(50).allow('', null),
    discountName: Joi.string().max(100).required(),
    discountType: Joi.string().valid('percentage', 'flat').required(),
    discountValue: Joi.number().min(0).required(),
    appliedOn: Joi.string().valid('subtotal', 'item').default('subtotal'),
    orderItemId: Joi.number().integer().positive().allow(null),
    approvedBy: Joi.number().integer().positive().allow(null),
    approvalReason: Joi.string().max(255).allow('', null),
    securityKey: Joi.string().required().messages({
      'any.required': 'Security key is required to apply discount',
      'string.empty': 'Security key is required to apply discount'
    })
  }),

  applyDiscountCode: Joi.object({
    discountCode: Joi.string().max(50).required()
  }),

  updateInvoiceCharges: Joi.object({
    removeServiceCharge: Joi.boolean().default(false),
    removeGst: Joi.boolean().default(false),
    customerGstin: Joi.string().max(20).when('removeGst', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.allow('', null)
    })
  }),

  // ========================
  // PAYMENT VALIDATION
  // ========================

  processPayment: Joi.object({
    orderId: Joi.number().integer().positive().required(),
    invoiceId: Joi.number().integer().positive().allow(null),
    outletId: Joi.number().integer().positive().allow(null),
    paymentMode: Joi.string().valid(...PAYMENT_MODES).required(),
    amount: Joi.number().min(0).required(),
    tipAmount: Joi.number().min(0).default(0),
    transactionId: Joi.string().max(100).allow('', null),
    referenceNumber: Joi.string().max(100).allow('', null),
    cardLastFour: Joi.string().max(4).allow('', null),
    cardType: Joi.string().max(20).allow('', null),
    upiId: Joi.string().max(100).allow('', null),
    walletName: Joi.string().max(50).allow('', null),
    bankName: Joi.string().max(100).allow('', null),
    notes: Joi.string().max(255).allow('', null)
  }),

  splitPayment: Joi.object({
    orderId: Joi.number().integer().positive().required(),
    invoiceId: Joi.number().integer().positive().allow(null),
    outletId: Joi.number().integer().positive().allow(null),
    splits: Joi.array().items(Joi.object({
      paymentMode: Joi.string().valid('cash', 'card', 'upi', 'wallet').required(),
      amount: Joi.number().min(0).required(),
      transactionId: Joi.string().max(100).allow('', null),
      referenceNumber: Joi.string().max(100).allow('', null),
      cardLastFour: Joi.string().max(4).allow('', null),
      upiId: Joi.string().max(100).allow('', null),
      notes: Joi.string().max(255).allow('', null)
    })).min(2).required()
  }),

  initiateRefund: Joi.object({
    orderId: Joi.number().integer().positive().required(),
    paymentId: Joi.number().integer().positive().required(),
    refundAmount: Joi.number().min(0).required(),
    refundMode: Joi.string().valid('cash', 'card', 'upi', 'wallet', 'original_mode').required(),
    reason: Joi.string().max(255).required()
  }),

  openCashDrawer: Joi.object({
    openingCash: Joi.number().min(0).required()
  }),

  closeCashDrawer: Joi.object({
    actualCash: Joi.number().min(0).required(),
    notes: Joi.string().allow('', null)
  }),

  // ========================
  // REPORT VALIDATION
  // ========================

  dateRange: Joi.object({
    startDate: Joi.date().required(),
    endDate: Joi.date().min(Joi.ref('startDate')).required()
  }),

  singleDate: Joi.object({
    date: Joi.date().required()
  })
};
