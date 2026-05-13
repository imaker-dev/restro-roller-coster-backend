/**
 * Bulk Upload Controller
 * Handles CSV-based bulk menu upload endpoints
 */

const bulkUploadService = require('../services/bulkUpload.service');
const logger = require('../utils/logger');

const bulkUploadController = {
  /**
   * POST /api/v1/bulk-upload/menu/validate
   * Validate CSV without inserting data
   */
  async validateUpload(req, res) {
    try {
      const outletId = parseInt(req.body.outletId || req.query.outletId || req.user?.outletId);
      
      if (!outletId) {
        return res.status(400).json({ success: false, message: 'outletId is required' });
      }

      if (!req.file && !req.body.csvContent) {
        return res.status(400).json({ success: false, message: 'CSV file or csvContent is required' });
      }

      const csvContent = req.file ? req.file.buffer.toString('utf-8') : req.body.csvContent;

      // Parse CSV
      const parseResult = bulkUploadService.parseCSV(csvContent);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, message: parseResult.error });
      }

      // Validate records
      const validation = await bulkUploadService.validateRecords(parseResult.records, outletId);

      res.json({
        success: true,
        data: {
          isValid: validation.isValid,
          summary: validation.summary,
          errors: validation.errors,
          warnings: validation.warnings
        }
      });
    } catch (error) {
      logger.error('Bulk upload validation error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /api/v1/bulk-upload/menu
   * Upload and process CSV to create menu items
   */
  async uploadMenu(req, res) {
    try {
      const outletId = parseInt(req.body.outletId || req.query.outletId || req.user?.outletId);
      const userId = req.user?.userId;

      if (!outletId) {
        return res.status(400).json({ success: false, message: 'outletId is required' });
      }

      if (!req.file && !req.body.csvContent) {
        return res.status(400).json({ success: false, message: 'CSV file or csvContent is required' });
      }

      const csvContent = req.file ? req.file.buffer.toString('utf-8') : req.body.csvContent;
      const filename = req.file?.originalname || 'inline-upload.csv';
      const skipValidation = req.body.skipValidation === 'true' || req.body.skipValidation === true;

      // Parse CSV
      const parseResult = bulkUploadService.parseCSV(csvContent);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, message: parseResult.error });
      }

      // Validate records (unless skipped)
      if (!skipValidation) {
        const validation = await bulkUploadService.validateRecords(parseResult.records, outletId);
        if (!validation.isValid) {
          return res.status(400).json({
            success: false,
            message: 'Validation failed. Fix errors before uploading.',
            data: {
              summary: validation.summary,
              errors: validation.errors,
              warnings: validation.warnings
            }
          });
        }
      }

      // Process records
      const result = await bulkUploadService.processRecords(parseResult.records, outletId, userId);

      // Log the upload
      await bulkUploadService.logUpload(outletId, userId, filename, result);

      if (result.success) {
        res.status(201).json({
          success: true,
          message: 'Bulk upload completed successfully',
          data: {
            created: result.created,
            skipped: result.skipped,
            errors: result.errors
          }
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Bulk upload failed',
          data: {
            created: result.created,
            skipped: result.skipped,
            errors: result.errors
          }
        });
      }
    } catch (error) {
      logger.error('Bulk upload error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /api/v1/bulk-upload/menu/template
   * Download CSV template — outlet-specific if outletId provided,
   * otherwise falls back to the sample/default template.
   */
  async getTemplate(req, res) {
    try {
      const outletId = parseInt(req.query.outletId || req.user?.outletId);
      const template = await bulkUploadService.generateTemplate(outletId);
      const filename = outletId ? `menu-template-outlet-${outletId}.csv` : 'menu-upload-template.csv';

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.send(template);
    } catch (error) {
      logger.error('Get template error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /api/v1/bulk-upload/menu/template/json
   * Get template structure as JSON (for frontend form building)
   */
  async getTemplateStructure(req, res) {
    try {
      const structure = bulkUploadService.getTemplateStructure();
      res.json({ success: true, data: structure });
    } catch (error) {
      logger.error('Get template structure error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /api/v1/bulk-upload/history
   * Get upload history for outlet
   */
  async getHistory(req, res) {
    try {
      const outletId = parseInt(req.query.outletId || req.user?.outletId);
      const limit = parseInt(req.query.limit) || 20;

      if (!outletId) {
        return res.status(400).json({ success: false, message: 'outletId is required' });
      }

      const history = await bulkUploadService.getUploadHistory(outletId, limit);
      res.json({ success: true, data: history });
    } catch (error) {
      logger.error('Get upload history error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /api/v1/bulk-upload/menu/preview
   * Parse CSV and return preview of what will be created
   */
  async previewUpload(req, res) {
    try {
      const outletId = parseInt(req.body.outletId || req.query.outletId || req.user?.outletId);

      if (!outletId) {
        return res.status(400).json({ success: false, message: 'outletId is required' });
      }

      if (!req.file && !req.body.csvContent) {
        return res.status(400).json({ success: false, message: 'CSV file or csvContent is required' });
      }

      const csvContent = req.file ? req.file.buffer.toString('utf-8') : req.body.csvContent;

      // Parse CSV
      const parseResult = bulkUploadService.parseCSV(csvContent);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, message: parseResult.error });
      }

      // Group records by type for preview
      const preview = {
        categories: [],
        items: [],
        variants: [],
        addonGroups: [],
        addons: []
      };

      let currentCategory = null;
      let currentItem = null;
      let currentGroup = null;

      for (const row of parseResult.records) {
        const type = (row.Type || row.type || '').toUpperCase().trim();
        const name = row.Name || row.name;

        switch (type) {
          case 'CATEGORY':
            currentCategory = name;
            preview.categories.push({
              name,
              parent: row.Parent || row.parent || null,
              description: row.Description || row.description,
              serviceType: row.ServiceType || row.servicetype || 'both'
            });
            break;

          case 'ITEM':
            currentItem = name;
            preview.items.push({
              name,
              category: row.Category || row.category || currentCategory,
              price: row.Price || row.price,
              foodType: row.ItemType || row.itemtype || row.FoodType || row.foodtype || 'veg',
              gst: row.GST || row.gst || null,
              vat: row.VAT || row.vat || null,
              station: row.Station || row.station,
              serviceType: row.ServiceType || row.servicetype || 'both'
            });
            break;

          case 'VARIANT':
            preview.variants.push({
              name,
              item: row.Item || row.item || currentItem,
              price: row.Price || row.price,
              isDefault: row.Default || row.default
            });
            break;

          case 'ADDON_GROUP':
            currentGroup = name;
            preview.addonGroups.push({
              name,
              selectionType: row.SelectionType || row.selectiontype || 'multiple',
              min: row.Min || row.min || 0,
              max: row.Max || row.max || 10
            });
            break;

          case 'ADDON':
            preview.addons.push({
              name,
              group: row.Group || row.group || currentGroup,
              price: row.Price || row.price || 0,
              foodType: row.FoodType || row.foodtype || 'veg'
            });
            break;
        }
      }

      res.json({
        success: true,
        data: {
          totalRows: parseResult.records.length,
          preview
        }
      });
    } catch (error) {
      logger.error('Preview upload error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * POST /api/v1/bulk-upload/menu/super-admin-template
   * Super admin uploads their master menu template CSV.
   * All outlets under this super_admin will receive this template on download.
   */
  async uploadSuperAdminTemplate(req, res) {
    try {
      const userId = req.user?.userId;

      if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }

      if (!req.file && !req.body.csvContent) {
        return res.status(400).json({ success: false, message: 'CSV file or csvContent is required' });
      }

      const csvContent = req.file ? req.file.buffer.toString('utf-8') : req.body.csvContent;

      // Basic CSV validation
      const parseResult = bulkUploadService.parseCSV(csvContent);
      if (!parseResult.success) {
        return res.status(400).json({ success: false, message: parseResult.error });
      }

      // Optional: validate records structure (no DB needed, just format check)
      const hasValidRows = parseResult.records.some(r => {
        const type = (r.Type || r.type || '').toUpperCase().trim();
        return ['CATEGORY', 'ITEM', 'VARIANT', 'ADDON_GROUP', 'ADDON'].includes(type);
      });

      if (!hasValidRows) {
        return res.status(400).json({
          success: false,
          message: 'CSV must contain at least one valid row (CATEGORY, ITEM, VARIANT, ADDON_GROUP, or ADDON)'
        });
      }

      const label = req.body.label || null;
      const result = await bulkUploadService.saveSuperAdminTemplate(userId, csvContent, label);
      res.status(200).json(result);
    } catch (error) {
      logger.error('Upload super admin template error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /api/v1/bulk-upload/menu/super-admin-template/versions
   * List all template versions for the logged-in super admin.
   */
  async listSuperAdminTemplateVersions(req, res) {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }
      const versions = await bulkUploadService.listSuperAdminTemplateVersions(userId);
      res.json({ success: true, data: versions });
    } catch (error) {
      logger.error('List template versions error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /api/v1/bulk-upload/menu/super-admin-template
   * Download the super admin's active template CSV.
   * For super_admin — returns their own active template as CSV.
   * For admin/manager — resolves outlet's super admin and returns their active template.
   */
  async getSuperAdminTemplate(req, res) {
    try {
      const userId = req.user?.userId;
      const userRoles = req.user?.roles || [];
      const outletId = parseInt(req.query.outletId || req.user?.outletId);

      if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }

      let template;
      let filename = 'super-admin-menu-template.csv';

      if (userRoles.includes('super_admin')) {
        template = await bulkUploadService.getSuperAdminTemplate(userId);
      } else {
        if (!outletId) {
          return res.status(400).json({ success: false, message: 'outletId is required' });
        }
        template = await bulkUploadService.getSuperAdminTemplateForOutlet(outletId);
        filename = `super-admin-menu-template-outlet-${outletId}.csv`;
      }

      if (!template) {
        return res.status(404).json({ success: false, message: 'No super admin template found' });
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      res.send(template);
    } catch (error) {
      logger.error('Get super admin template error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * GET /api/v1/bulk-upload/menu/super-admin-template/versions/:version/download
   * Download a specific version of the super admin's template as CSV.
   */
  async downloadSuperAdminTemplateVersion(req, res) {
    try {
      const userId = req.user?.userId;
      const version = parseInt(req.params.version);
      if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }
      if (!version || isNaN(version)) {
        return res.status(400).json({ success: false, message: 'Invalid version number' });
      }
      const row = await bulkUploadService.getSuperAdminTemplateByVersion(userId, version);
      if (!row) {
        return res.status(404).json({ success: false, message: `Version ${version} not found` });
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=super-admin-template-v${version}.csv`);
      res.send(row.template_data);
    } catch (error) {
      logger.error('Download template version error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * PATCH /api/v1/bulk-upload/menu/super-admin-template/versions/:version/activate
   * Set a specific version as the active (published) template.
   */
  async activateSuperAdminTemplateVersion(req, res) {
    try {
      const userId = req.user?.userId;
      const version = parseInt(req.params.version);
      if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }
      if (!version || isNaN(version)) {
        return res.status(400).json({ success: false, message: 'Invalid version number' });
      }
      const result = await bulkUploadService.activateSuperAdminTemplateVersion(userId, version);
      res.json(result);
    } catch (error) {
      logger.error('Activate template version error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * DELETE /api/v1/bulk-upload/menu/super-admin-template/versions/:version
   * Delete a specific version of the super admin's template.
   */
  async deleteSuperAdminTemplateVersion(req, res) {
    try {
      const userId = req.user?.userId;
      const version = parseInt(req.params.version);
      if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }
      if (!version || isNaN(version)) {
        return res.status(400).json({ success: false, message: 'Invalid version number' });
      }
      const result = await bulkUploadService.deleteSuperAdminTemplateVersion(userId, version);
      res.json(result);
    } catch (error) {
      logger.error('Delete template version error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  /**
   * DELETE /api/v1/bulk-upload/menu/super-admin-template
   * Delete ALL versions of the super admin's template.
   */
  async deleteSuperAdminTemplate(req, res) {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
      }
      const result = await bulkUploadService.deleteSuperAdminTemplate(userId);
      res.json(result);
    } catch (error) {
      logger.error('Delete super admin template error:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
};

module.exports = bulkUploadController;
