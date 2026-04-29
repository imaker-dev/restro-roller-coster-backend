const Joi = require('joi');

const initSession = Joi.object({
  outletId: Joi.number().integer().positive().required(),
  tableId: Joi.number().integer().positive().required(),
  qrToken: Joi.string().trim().hex().max(64).allow('', null),
  deviceId: Joi.string().trim().uuid().required()
    .messages({ 'any.required': 'Device ID is required. Please ensure your browser supports local storage.' }),
});

const updateCustomer = Joi.object({
  customerName: Joi.string().trim().max(100).required(),
  customerPhone: Joi.string().trim().pattern(/^[0-9]{10,15}$/).required()
    .messages({ 'string.pattern.base': 'Phone number must be 10-15 digits' }),
});

const placeOrder = Joi.object({
  customerName: Joi.string().trim().max(100).allow('', null),
  customerPhone: Joi.string().trim().pattern(/^[0-9]{10,15}$/).allow('', null)
    .messages({ 'string.pattern.base': 'Phone number must be 10-15 digits' }),
  specialInstructions: Joi.string().trim().max(500).allow('', null),
  items: Joi.array().items(
    Joi.object({
      itemId: Joi.number().integer().positive().required(),
      variantId: Joi.number().integer().positive().allow(null),
      quantity: Joi.number().integer().min(1).max(50).required(),
      specialInstructions: Joi.string().trim().max(200).allow('', null),
      addons: Joi.array().items(
        Joi.object({
          addonId: Joi.number().integer().positive().required(),
          addonGroupId: Joi.number().integer().positive().required(),
          quantity: Joi.number().integer().min(1).max(10).default(1),
        })
      ).default([]),
    })
  ).min(1).max(100).required(),
});

const addItems = Joi.object({
  specialInstructions: Joi.string().trim().max(500).allow('', null),
  items: Joi.array().items(
    Joi.object({
      itemId: Joi.number().integer().positive().required(),
      variantId: Joi.number().integer().positive().allow(null),
      quantity: Joi.number().integer().min(1).max(50).required(),
      specialInstructions: Joi.string().trim().max(200).allow('', null),
      addons: Joi.array().items(
        Joi.object({
          addonId: Joi.number().integer().positive().required(),
          addonGroupId: Joi.number().integer().positive().required(),
          quantity: Joi.number().integer().min(1).max(10).default(1),
        })
      ).default([]),
    })
  ).min(1).max(100).required(),
});

const acceptOrder = Joi.object({
  orderId: Joi.number().integer().positive().required(),
});

const rejectOrder = Joi.object({
  orderId: Joi.number().integer().positive().required(),
  reason: Joi.string().trim().max(255).allow('', null),
});

const saveCart = Joi.object({
  items: Joi.array().items(
    Joi.object({
      itemId: Joi.number().integer().positive().required(),
      variantId: Joi.number().integer().positive().allow(null),
      name: Joi.string().trim().max(150).allow('', null),
      variantName: Joi.string().trim().max(50).allow('', null),
      quantity: Joi.number().integer().min(1).max(50).required(),
      unitPrice: Joi.number().min(0).required(),
      specialInstructions: Joi.string().trim().max(200).allow('', null),
      addons: Joi.array().items(
        Joi.object({
          addonId: Joi.number().integer().positive().required(),
          addonGroupId: Joi.number().integer().positive().required(),
          name: Joi.string().trim().max(100).allow('', null),
          price: Joi.number().min(0).allow(null),
          quantity: Joi.number().integer().min(1).max(10).default(1),
        })
      ).default([]),
    })
  ).max(100).required(),
});

const cancelOrder = Joi.object({
  reason: Joi.string().trim().max(255).allow('', null),
});

const updateItemQuantity = Joi.object({
  quantity: Joi.number().integer().min(1).max(50).required(),
});

const generateQr = Joi.object({
  outletId: Joi.number().integer().positive().required(),
  tableId: Joi.number().integer().positive().allow(null),
  baseUrl: Joi.string().uri().trim().allow('', null),
});

const updateSettings = Joi.object({
  enabled: Joi.boolean(),
  acceptMode: Joi.string().valid('auto', 'manual'),
  sessionTimeoutMinutes: Joi.number().integer().min(10).max(480),
  requirePhone: Joi.boolean(),
  requireName: Joi.boolean(),
  maxSessionsPerTable: Joi.number().integer().min(1).max(10),
  allowReorder: Joi.boolean(),
  idleTimeoutMinutes: Joi.number().integer().min(1).max(120)
    .messages({ 'number.min': 'Idle timeout must be at least 1 minute', 'number.max': 'Idle timeout cannot exceed 120 minutes' }),
  completionBufferMinutes: Joi.number().integer().min(1).max(60)
    .messages({ 'number.min': 'Completion buffer must be at least 1 minute', 'number.max': 'Completion buffer cannot exceed 60 minutes' }),
}).min(1);

module.exports = {
  initSession,
  updateCustomer,
  placeOrder,
  addItems,
  cancelOrder,
  updateItemQuantity,
  acceptOrder,
  rejectOrder,
  saveCart,
  generateQr,
  updateSettings,
};
