/**
 * Tax Controller
 * Handles tax types, components, groups, service charges, and discounts
 */

const taxService = require('../services/tax.service');
const timeSlotService = require('../services/timeSlot.service');
const priceRuleService = require('../services/priceRule.service');
const kitchenStationService = require('../services/kitchenStation.service');
const logger = require('../utils/logger');

const taxController = {
  // ========================
  // TAX TYPES
  // ========================

  async createTaxType(req, res) {
    try {
      const taxType = await taxService.createTaxType(req.body);
      res.status(201).json({ success: true, message: 'Tax type created', data: taxType });
    } catch (error) {
      logger.error('Create tax type error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getTaxTypes(req, res) {
    try {
      const types = await taxService.getTaxTypes();
      res.json({ success: true, data: types });
    } catch (error) {
      logger.error('Get tax types error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updateTaxType(req, res) {
    try {
      const taxType = await taxService.updateTaxType(req.params.id, req.body);
      if (!taxType) {
        return res.status(404).json({ success: false, message: 'Tax type not found' });
      }
      res.json({ success: true, message: 'Tax type updated', data: taxType });
    } catch (error) {
      logger.error('Update tax type error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // TAX COMPONENTS
  // ========================

  async createTaxComponent(req, res) {
    try {
      const component = await taxService.createTaxComponent(req.body);
      res.status(201).json({ success: true, message: 'Tax component created', data: component });
    } catch (error) {
      logger.error('Create tax component error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getTaxComponents(req, res) {
    try {
      const { taxTypeId } = req.query;
      const components = await taxService.getTaxComponents(taxTypeId ? parseInt(taxTypeId) : null);
      res.json({ success: true, data: components });
    } catch (error) {
      logger.error('Get tax components error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updateTaxComponent(req, res) {
    try {
      const component = await taxService.updateTaxComponent(req.params.id, req.body);
      if (!component) {
        return res.status(404).json({ success: false, message: 'Tax component not found' });
      }
      res.json({ success: true, message: 'Tax component updated', data: component });
    } catch (error) {
      logger.error('Update tax component error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // TAX GROUPS
  // ========================

  async createTaxGroup(req, res) {
    try {
      const group = await taxService.createTaxGroup(req.body);
      res.status(201).json({ success: true, message: 'Tax group created', data: group });
    } catch (error) {
      logger.error('Create tax group error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getTaxGroups(req, res) {
    try {
      const { outletId } = req.query;
      
      // Outlet-wise filtering based on user context
      let effectiveOutletId = outletId ? parseInt(outletId) : null;
      
      if (req.user) {
        const isSuperAdmin = req.user.roles?.includes('master') || req.user.roles?.includes('super_admin');
        
        if (!isSuperAdmin) {
          // Non-super_admin users can only see their outlet's tax groups
          if (req.user.outletId) {
            effectiveOutletId = req.user.outletId;
          } else {
            // Admin without outlet sees nothing
            return res.json({ success: true, data: [] });
          }
        }
        // super_admin can use query param or see all
      }
      
      const groups = await taxService.getTaxGroups(effectiveOutletId);
      res.json({ success: true, data: groups });
    } catch (error) {
      logger.error('Get tax groups error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getTaxGroupById(req, res) {
    try {
      const group = await taxService.getTaxGroupById(req.params.id);
      if (!group) {
        return res.status(404).json({ success: false, message: 'Tax group not found' });
      }
      res.json({ success: true, data: group });
    } catch (error) {
      logger.error('Get tax group error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updateTaxGroup(req, res) {
    try {
      const group = await taxService.updateTaxGroup(req.params.id, req.body);
      if (!group) {
        return res.status(404).json({ success: false, message: 'Tax group not found' });
      }
      res.json({ success: true, message: 'Tax group updated', data: group });
    } catch (error) {
      logger.error('Update tax group error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async deleteTaxGroup(req, res) {
    try {
      const deleted = await taxService.deleteTaxGroup(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Tax group not found' });
      }
      res.json({ success: true, message: 'Tax group deleted' });
    } catch (error) {
      logger.error('Delete tax group error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // SERVICE CHARGES
  // ========================

  async createServiceCharge(req, res) {
    try {
      const charge = await taxService.createServiceCharge(req.body);
      res.status(201).json({ success: true, message: 'Service charge created', data: charge });
    } catch (error) {
      logger.error('Create service charge error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getServiceCharges(req, res) {
    try {
      const { outletId } = req.params;
      const { floorId, sectionId } = req.query;
      const charges = await taxService.getServiceCharges(
        outletId,
        floorId ? parseInt(floorId) : null,
        sectionId ? parseInt(sectionId) : null
      );
      res.json({ success: true, data: charges });
    } catch (error) {
      logger.error('Get service charges error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // DISCOUNTS
  // ========================

  async createDiscount(req, res) {
    try {
      const discount = await taxService.createDiscount({
        ...req.body,
        createdBy: req.user?.id
      });
      res.status(201).json({ success: true, message: 'Discount created', data: discount });
    } catch (error) {
      logger.error('Create discount error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getDiscounts(req, res) {
    try {
      const { outletId } = req.params;
      const filters = {
        code: req.query.code,
        activeOnly: req.query.activeOnly === 'true',
        autoApplyOnly: req.query.autoApplyOnly === 'true'
      };
      const discounts = await taxService.getDiscounts(outletId, filters);
      res.json({ success: true, data: discounts });
    } catch (error) {
      logger.error('Get discounts error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async validateDiscountCode(req, res) {
    try {
      const { outletId } = req.params;
      const { code, orderAmount, orderType } = req.body;
      const result = await taxService.validateDiscountCode(outletId, code, orderAmount, orderType);
      res.json({ success: result.valid, data: result });
    } catch (error) {
      logger.error('Validate discount code error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // TIME SLOTS
  // ========================

  async createTimeSlot(req, res) {
    try {
      const slot = await timeSlotService.create(req.body);
      res.status(201).json({ success: true, message: 'Time slot created', data: slot });
    } catch (error) {
      logger.error('Create time slot error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getTimeSlots(req, res) {
    try {
      const { outletId } = req.params;
      const slots = await timeSlotService.getByOutlet(outletId);
      res.json({ success: true, data: slots });
    } catch (error) {
      logger.error('Get time slots error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCurrentTimeSlot(req, res) {
    try {
      const { outletId } = req.params;
      const slot = await timeSlotService.getCurrentSlot(outletId);
      res.json({ success: true, data: slot });
    } catch (error) {
      logger.error('Get current time slot error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updateTimeSlot(req, res) {
    try {
      const slot = await timeSlotService.update(req.params.id, req.body);
      if (!slot) {
        return res.status(404).json({ success: false, message: 'Time slot not found' });
      }
      res.json({ success: true, message: 'Time slot updated', data: slot });
    } catch (error) {
      logger.error('Update time slot error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async deleteTimeSlot(req, res) {
    try {
      const deleted = await timeSlotService.delete(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Time slot not found' });
      }
      res.json({ success: true, message: 'Time slot deleted' });
    } catch (error) {
      logger.error('Delete time slot error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // PRICE RULES
  // ========================

  async createPriceRule(req, res) {
    try {
      const rule = await priceRuleService.create(req.body);
      res.status(201).json({ success: true, message: 'Price rule created', data: rule });
    } catch (error) {
      logger.error('Create price rule error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getPriceRules(req, res) {
    try {
      const { outletId } = req.params;
      const filters = {
        ruleType: req.query.ruleType,
        itemId: req.query.itemId ? parseInt(req.query.itemId) : null,
        includeInactive: req.query.includeInactive === 'true'
      };
      const rules = await priceRuleService.getByOutlet(outletId, filters);
      res.json({ success: true, data: rules });
    } catch (error) {
      logger.error('Get price rules error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updatePriceRule(req, res) {
    try {
      const rule = await priceRuleService.update(req.params.id, req.body);
      if (!rule) {
        return res.status(404).json({ success: false, message: 'Price rule not found' });
      }
      res.json({ success: true, message: 'Price rule updated', data: rule });
    } catch (error) {
      logger.error('Update price rule error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async deletePriceRule(req, res) {
    try {
      const deleted = await priceRuleService.delete(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Price rule not found' });
      }
      res.json({ success: true, message: 'Price rule deleted' });
    } catch (error) {
      logger.error('Delete price rule error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async createHappyHour(req, res) {
    try {
      const { outletId } = req.params;
      const result = await priceRuleService.createHappyHourRule(outletId, req.body);
      res.status(201).json({ success: true, message: 'Happy hour created', data: result });
    } catch (error) {
      logger.error('Create happy hour error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getActiveHappyHours(req, res) {
    try {
      const { outletId } = req.params;
      const happyHours = await priceRuleService.getActiveHappyHours(outletId);
      res.json({ success: true, data: happyHours });
    } catch (error) {
      logger.error('Get active happy hours error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // KITCHEN STATIONS
  // ========================

  async createKitchenStation(req, res) {
    try {
      // Get outletId from body, query, or user context
      const outletId = req.body.outletId || req.body.outlet_id || req.query.outletId || req.user?.outletId;
      if (!outletId) {
        return res.status(400).json({ success: false, message: 'outletId is required' });
      }
      const station = await kitchenStationService.createStation({ ...req.body, outletId });
      res.status(201).json({ success: true, message: 'Kitchen station created', data: station });
    } catch (error) {
      logger.error('Create kitchen station error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getKitchenStations(req, res) {
    try {
      const { outletId } = req.params;
      const stations = await kitchenStationService.getStations(outletId);
      res.json({ success: true, data: stations });
    } catch (error) {
      logger.error('Get kitchen stations error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updateKitchenStation(req, res) {
    try {
      const station = await kitchenStationService.updateStation(req.params.id, req.body);
      if (!station) {
        return res.status(404).json({ success: false, message: 'Kitchen station not found' });
      }
      res.json({ success: true, message: 'Kitchen station updated', data: station });
    } catch (error) {
      logger.error('Update kitchen station error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async deleteKitchenStation(req, res) {
    try {
      const deleted = await kitchenStationService.deleteStation(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Kitchen station not found' });
      }
      res.json({ success: true, message: 'Kitchen station deleted' });
    } catch (error) {
      logger.error('Delete kitchen station error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // COUNTERS
  // ========================

  async createCounter(req, res) {
    try {
      const counter = await kitchenStationService.createCounter(req.body);
      res.status(201).json({ success: true, message: 'Counter created', data: counter });
    } catch (error) {
      logger.error('Create counter error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async getCounters(req, res) {
    try {
      const { outletId } = req.params;
      const { floorId } = req.query;
      const counters = await kitchenStationService.getCounters(
        outletId,
        floorId ? parseInt(floorId) : null
      );
      res.json({ success: true, data: counters });
    } catch (error) {
      logger.error('Get counters error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async updateCounter(req, res) {
    try {
      const counter = await kitchenStationService.updateCounter(req.params.id, req.body);
      if (!counter) {
        return res.status(404).json({ success: false, message: 'Counter not found' });
      }
      res.json({ success: true, message: 'Counter updated', data: counter });
    } catch (error) {
      logger.error('Update counter error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  async deleteCounter(req, res) {
    try {
      const deleted = await kitchenStationService.deleteCounter(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Counter not found' });
      }
      res.json({ success: true, message: 'Counter deleted' });
    } catch (error) {
      logger.error('Delete counter error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
};

module.exports = taxController;
