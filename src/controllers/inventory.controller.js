/**
 * Inventory Controller — 16 endpoints
 * Module 1: Units  |  Module 2: Vendors  |  Module 3: Inventory  |  Module 4: Purchases
 */

const unitService = require('../services/unit.service');
const vendorService = require('../services/vendor.service');
const inventoryService = require('../services/inventory.service');
const purchaseService = require('../services/purchase.service');
const logger = require('../utils/logger');

function parseBool(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(n)) return true;
  if (['false', '0', 'no'].includes(n)) return false;
  return undefined;
}

const inventoryController = {

  // ======================== MODULE 1: UNITS ========================

  async listUnits(req, res) {
    try {
      const oid = parseInt(req.params.outletId);
      // Auto-seed default units on first access
      await unitService.seedDefaults(oid);
      const units = await unitService.list(oid, {
        unitType: req.query.unitType || undefined,
        isActive: parseBool(req.query.isActive),
        search: req.query.search || undefined
      });
      res.json({ success: true, data: units });
    } catch (error) {
      logger.error('List units error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async createUnit(req, res) {
    try {
      const unit = await unitService.create(parseInt(req.params.outletId), req.body);
      res.status(201).json({ success: true, data: unit });
    } catch (error) {
      logger.error('Create unit error:', error);
      res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 400).json({ success: false, message: error.message });
    }
  },

  async updateUnit(req, res) {
    try {
      const unit = await unitService.update(parseInt(req.params.id), req.body);
      if (!unit) return res.status(404).json({ success: false, message: 'Unit not found' });
      res.json({ success: true, data: unit });
    } catch (error) {
      logger.error('Update unit error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  // ======================== MODULE 2: VENDORS ========================

  async listVendors(req, res) {
    try {
      const { page, limit, search, isActive, sortBy, sortOrder } = req.query;
      const result = await vendorService.list(parseInt(req.params.outletId), {
        page, limit, search, isActive: parseBool(isActive), sortBy, sortOrder
      });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('List vendors error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getVendor(req, res) {
    try {
      const vendor = await vendorService.getById(parseInt(req.params.id));
      if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
      res.json({ success: true, data: vendor });
    } catch (error) {
      logger.error('Get vendor error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async createVendor(req, res) {
    try {
      const vendor = await vendorService.create(parseInt(req.params.outletId), req.body);
      res.status(201).json({ success: true, data: vendor });
    } catch (error) {
      logger.error('Create vendor error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async updateVendor(req, res) {
    try {
      const vendor = await vendorService.update(parseInt(req.params.id), req.body);
      if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });
      res.json({ success: true, data: vendor });
    } catch (error) {
      logger.error('Update vendor error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  // ======================== MODULE 3: INVENTORY ========================

  async listCategories(req, res) {
    try {
      const categories = await inventoryService.listCategories(parseInt(req.params.outletId), {
        isActive: parseBool(req.query.isActive), search: req.query.search
      });
      res.json({ success: true, data: categories });
    } catch (error) {
      logger.error('List inventory categories error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async createCategory(req, res) {
    try {
      const category = await inventoryService.createCategory(parseInt(req.params.outletId), req.body);
      res.status(201).json({ success: true, data: category });
    } catch (error) {
      logger.error('Create inventory category error:', error);
      res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 400).json({ success: false, message: error.message });
    }
  },

  async updateCategory(req, res) {
    try {
      const result = await inventoryService.updateCategory(parseInt(req.params.id), req.body);
      if (!result) return res.status(404).json({ success: false, message: 'Category not found' });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Update inventory category error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async listItems(req, res) {
    try {
      const { page, limit, search, categoryId, isActive, lowStock, sortBy, sortOrder } = req.query;
      const result = await inventoryService.listItems(parseInt(req.params.outletId), {
        page, limit, search, categoryId: categoryId ? parseInt(categoryId) : undefined,
        isActive: parseBool(isActive), lowStock: parseBool(lowStock), sortBy, sortOrder
      });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('List inventory items error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getItem(req, res) {
    try {
      const item = await inventoryService.getItemById(parseInt(req.params.id));
      if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
      res.json({ success: true, data: item });
    } catch (error) {
      logger.error('Get inventory item error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async createItem(req, res) {
    try {
      const item = await inventoryService.createItem(parseInt(req.params.outletId), req.body);
      res.status(201).json({ success: true, data: item });
    } catch (error) {
      logger.error('Create inventory item error:', error);
      res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 400).json({ success: false, message: error.message });
    }
  },

  async updateItem(req, res) {
    try {
      const item = await inventoryService.updateItem(parseInt(req.params.id), req.body);
      if (!item) return res.status(404).json({ success: false, message: 'Item not found' });
      res.json({ success: true, data: item });
    } catch (error) {
      logger.error('Update inventory item error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async listBatches(req, res) {
    try {
      const { activeOnly, page, limit } = req.query;
      const result = await inventoryService.listBatches(parseInt(req.params.itemId), {
        activeOnly: parseBool(activeOnly), page, limit
      });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('List batches error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async listMovements(req, res) {
    try {
      const { page, limit, inventoryItemId, movementType, startDate, endDate, batchId } = req.query;
      const result = await inventoryService.listMovements(parseInt(req.params.outletId), {
        page, limit,
        inventoryItemId: inventoryItemId ? parseInt(inventoryItemId) : undefined,
        movementType, startDate, endDate,
        batchId: batchId ? parseInt(batchId) : undefined
      });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('List movements error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async recordAdjustment(req, res) {
    try {
      const result = await inventoryService.recordAdjustment(
        parseInt(req.params.outletId), req.body, req.user.userId
      );
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Record adjustment error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async recordWastage(req, res) {
    try {
      const result = await inventoryService.recordWastage(
        parseInt(req.params.outletId), req.body, req.user.userId
      );
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Record wastage error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async getStockSummary(req, res) {
    try {
      const result = await inventoryService.getStockSummary(parseInt(req.params.outletId));
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('Get stock summary error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ======================== MODULE 4: PURCHASES ========================

  async listPurchases(req, res) {
    try {
      const { page, limit, vendorId, status, paymentStatus, startDate, endDate, search, sortBy, sortOrder } = req.query;
      const result = await purchaseService.list(parseInt(req.params.outletId), {
        page, limit, vendorId: vendorId ? parseInt(vendorId) : undefined,
        status, paymentStatus, startDate, endDate, search, sortBy, sortOrder
      });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error('List purchases error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getPurchase(req, res) {
    try {
      const purchase = await purchaseService.getById(parseInt(req.params.id));
      if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found' });
      res.json({ success: true, data: purchase });
    } catch (error) {
      logger.error('Get purchase error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async createPurchase(req, res) {
    try {
      const purchase = await purchaseService.create(parseInt(req.params.outletId), req.body, req.user.userId);
      res.status(201).json({ success: true, data: purchase });
    } catch (error) {
      logger.error('Create purchase error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  },

  async cancelPurchase(req, res) {
    try {
      const purchase = await purchaseService.cancel(parseInt(req.params.id), req.user.userId, req.body.reason);
      res.json({ success: true, message: 'Purchase cancelled', data: purchase });
    } catch (error) {
      logger.error('Cancel purchase error:', error);
      const status = error.message.includes('not found') ? 404
        : error.message.includes('already') ? 409 : 400;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  async updatePurchasePayment(req, res) {
    try {
      const purchase = await purchaseService.updatePayment(parseInt(req.params.id), req.body);
      res.json({ success: true, data: purchase });
    } catch (error) {
      logger.error('Update purchase payment error:', error);
      res.status(400).json({ success: false, message: error.message });
    }
  }
};

module.exports = inventoryController;
