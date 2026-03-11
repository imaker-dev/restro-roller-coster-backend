const outletService = require('../services/outlet.service');
const floorService = require('../services/floor.service');
const sectionService = require('../services/section.service');
const tableService = require('../services/table.service');
const logger = require('../utils/logger');

/**
 * Outlet Controller
 */
const outletController = {
  // ========================
  // Outlet Operations
  // ========================

  async createOutlet(req, res, next) {
    try {
      const outlet = await outletService.create(req.body, req.user.userId);
      res.status(201).json({
        success: true,
        message: 'Outlet created successfully',
        data: outlet
      });
    } catch (error) {
      next(error);
    }
  },

  async getOutlets(req, res, next) {
    try {
      const filters = {
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
        outletType: req.query.outletType,
        search: req.query.search
      };
      // Pass user info to filter outlets based on user's access
      const outlets = await outletService.getAll(filters, req.user.userId, req.user.roles);
      res.json({ success: true, data: outlets });
    } catch (error) {
      next(error);
    }
  },

  async getOutletById(req, res, next) {
    try {
      const outlet = await outletService.getById(req.params.id);
      if (!outlet) {
        return res.status(404).json({ success: false, message: 'Outlet not found' });
      }
      res.json({ success: true, data: outlet });
    } catch (error) {
      next(error);
    }
  },

  async getOutletFullDetails(req, res, next) {
    try {
      const outlet = await outletService.getFullDetails(req.params.id);
      if (!outlet) {
        return res.status(404).json({ success: false, message: 'Outlet not found' });
      }
      res.json({ success: true, data: outlet });
    } catch (error) {
      next(error);
    }
  },

  async updateOutlet(req, res, next) {
    try {
      const outlet = await outletService.update(req.params.id, req.body, req.user.userId);
      if (!outlet) {
        return res.status(404).json({ success: false, message: 'Outlet not found' });
      }
      res.json({ success: true, message: 'Outlet updated successfully', data: outlet });
    } catch (error) {
      next(error);
    }
  },

  async deleteOutlet(req, res, next) {
    try {
      await outletService.delete(req.params.id, req.user.userId);
      res.json({ success: true, message: 'Outlet deleted successfully' });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Get deletion preview for an outlet
   * Shows what data would be deleted without actually deleting
   * @route GET /api/v1/outlets/:id/delete-preview
   * @access Super Admin only
   */
  async getDeletePreview(req, res, next) {
    try {
      const preview = await outletService.getDeletePreview(req.params.id);
      res.json({ 
        success: true, 
        message: 'Deletion preview generated',
        data: preview 
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * HARD DELETE outlet and ALL related data
   * WARNING: This permanently deletes all data - cannot be undone
   * @route DELETE /api/v1/outlets/:id/hard-delete
   * @access Super Admin only
   * @body { confirmationCode: string } - Must match outlet code for safety
   */
  async hardDeleteOutlet(req, res, next) {
    try {
      const { confirmationCode } = req.body;
      
      if (!confirmationCode) {
        return res.status(400).json({
          success: false,
          message: 'Confirmation code is required. Use the outlet code to confirm deletion.'
        });
      }

      const result = await outletService.hardDelete(req.params.id, confirmationCode);
      
      logger.warn(`Super Admin ${req.user.userId} performed HARD DELETE on outlet ${req.params.id}`);
      
      res.json({
        success: true,
        message: result.message,
        data: result.summary
      });
    } catch (error) {
      next(error);
    }
  },

  // ========================
  // Floor Operations
  // ========================

  async createFloor(req, res, next) {
    try {
      const floor = await floorService.create(req.body, req.user.userId);
      res.status(201).json({
        success: true,
        message: 'Floor created successfully',
        data: floor
      });
    } catch (error) {
      next(error);
    }
  },

  async getFloorsByOutlet(req, res, next) {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const userId = req.user ? req.user.userId : null;
      const floors = await floorService.getByOutlet(req.params.outletId, includeInactive, userId);
      res.json({ success: true, data: floors });
    } catch (error) {
      next(error);
    }
  },

  async getFloorById(req, res, next) {
    try {
      const floor = await floorService.getById(req.params.id);
      if (!floor) {
        return res.status(404).json({ success: false, message: 'Floor not found' });
      }
      res.json({ success: true, data: floor });
    } catch (error) {
      next(error);
    }
  },

  async getFloorWithDetails(req, res, next) {
    try {
      const floor = await floorService.getWithDetails(req.params.id);
      if (!floor) {
        return res.status(404).json({ success: false, message: 'Floor not found' });
      }
      res.json({ success: true, data: floor });
    } catch (error) {
      next(error);
    }
  },

  async updateFloor(req, res, next) {
    try {
      const floor = await floorService.update(req.params.id, req.body, req.user.userId);
      if (!floor) {
        return res.status(404).json({ success: false, message: 'Floor not found' });
      }
      res.json({ success: true, message: 'Floor updated successfully', data: floor });
    } catch (error) {
      next(error);
    }
  },

  async deleteFloor(req, res, next) {
    try {
      await floorService.delete(req.params.id);
      res.json({ success: true, message: 'Floor deleted successfully' });
    } catch (error) {
      next(error);
    }
  },

  async linkSectionToFloor(req, res, next) {
    try {
      await floorService.linkSection(req.params.id, req.body.sectionId, req.body.priceModifier || 0);
      res.json({ success: true, message: 'Section linked to floor successfully' });
    } catch (error) {
      next(error);
    }
  },

  async unlinkSectionFromFloor(req, res, next) {
    try {
      await floorService.unlinkSection(req.params.id, req.params.sectionId);
      res.json({ success: true, message: 'Section unlinked from floor successfully' });
    } catch (error) {
      next(error);
    }
  },

  // ========================
  // Section Operations
  // ========================

  async createSection(req, res, next) {
    try {
      const section = await sectionService.create(req.body, req.user.userId);
      res.status(201).json({
        success: true,
        message: 'Section created successfully',
        data: section
      });
    } catch (error) {
      next(error);
    }
  },

  async getSectionsByOutlet(req, res, next) {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const sections = await sectionService.getByOutlet(req.params.outletId, includeInactive);
      res.json({ success: true, data: sections });
    } catch (error) {
      next(error);
    }
  },

  async getSectionsByFloor(req, res, next) {
    try {
      const includeInactive = req.query.includeInactive === 'true';
      const sections = await sectionService.getByFloor(req.params.floorId, includeInactive);
      res.json({ success: true, data: sections });
    } catch (error) {
      next(error);
    }
  },

  async getSectionById(req, res, next) {
    try {
      const section = await sectionService.getById(req.params.id);
      if (!section) {
        return res.status(404).json({ success: false, message: 'Section not found' });
      }
      res.json({ success: true, data: section });
    } catch (error) {
      next(error);
    }
  },

  async getSectionTypes(req, res, next) {
    try {
      const types = sectionService.getSectionTypes();
      res.json({ success: true, data: types });
    } catch (error) {
      next(error);
    }
  },

  async updateSection(req, res, next) {
    try {
      const section = await sectionService.update(req.params.id, req.body, req.user.userId);
      if (!section) {
        return res.status(404).json({ success: false, message: 'Section not found' });
      }
      res.json({ success: true, message: 'Section updated successfully', data: section });
    } catch (error) {
      next(error);
    }
  },

  async deleteSection(req, res, next) {
    try {
      await sectionService.delete(req.params.id);
      res.json({ success: true, message: 'Section deleted successfully' });
    } catch (error) {
      next(error);
    }
  },

  async getFloorSectionsWithTables(req, res, next) {
    try {
      const data = await floorService.getFloorSectionsWithTables(req.params.floorId);
      if (!data) {
        return res.status(404).json({ success: false, message: 'Floor not found' });
      }
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  },

  // ========================
  // Print Logo Settings
  // ========================

  /**
   * Get print logo settings for an outlet
   * @route GET /api/v1/outlets/:id/print-logo
   */
  async getPrintLogoSettings(req, res, next) {
    try {
      const settings = await outletService.getPrintLogoSettings(req.params.id);
      if (!settings) {
        return res.status(404).json({ success: false, message: 'Outlet not found' });
      }
      res.json({ success: true, data: settings });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Update print logo settings for an outlet
   * @route PUT /api/v1/outlets/:id/print-logo
   * @body { printLogoEnabled: boolean, printLogoUrl?: string }
   */
  async updatePrintLogoSettings(req, res, next) {
    try {
      const { printLogoEnabled, printLogoUrl } = req.body;
      const settings = await outletService.updatePrintLogoSettings(
        req.params.id, 
        { printLogoEnabled, printLogoUrl },
        req.user.userId
      );
      if (!settings) {
        return res.status(404).json({ success: false, message: 'Outlet not found' });
      }
      res.json({ 
        success: true, 
        message: 'Print logo settings updated successfully',
        data: settings 
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Upload print logo image for an outlet
   * @route POST /api/v1/outlets/:id/print-logo/upload
   */
  async uploadPrintLogo(req, res, next) {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }
      
      const result = await outletService.uploadPrintLogo(
        req.params.id,
        req.file,
        req.user.userId
      );
      
      if (!result) {
        return res.status(404).json({ success: false, message: 'Outlet not found' });
      }
      
      res.json({
        success: true,
        message: 'Print logo uploaded successfully',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = outletController;
