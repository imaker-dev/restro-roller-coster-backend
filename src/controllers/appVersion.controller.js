const appVersionService = require('../services/appVersion.service');
const logger = require('../utils/logger');

const VALID_PLATFORMS = appVersionService.VALID_PLATFORMS; // ['global','app_store','play_store','exe','mac_os','offline_exe']
const VERSION_REGEX = /^\d+\.\d+(\.\d+)?$/;

const appVersionController = {
  /**
   * GET /api/v1/app/version
   * Public: Get latest version for a given platform and channel.
   * Query: ?platform=app_store|play_store|exe|mac_os|offline_exe|global  ?channel=stable|beta|alpha  ?version=1.0.0
   * Headers: x-platform, x-app-version (alternative to query params)
   * If ?version provided → returns full update-check result.
   * If no platform → returns latest per ALL platforms keyed by platform name.
   */
  async getLatestVersion(req, res) {
    try {
      const channel = req.query.channel || 'stable';
      const currentVersion = req.headers['x-app-version'] || req.query.version;
      const platform = req.headers['x-platform'] || req.query.platform || null;

      // Validate platform if provided
      if (platform && !VALID_PLATFORMS.includes(platform)) {
        return res.status(400).json({
          success: false,
          message: `Invalid platform. Valid values: ${VALID_PLATFORMS.join(', ')}`
        });
      }

      let result;
      if (currentVersion) {
        result = await appVersionService.checkForUpdate(currentVersion, platform, channel);
      } else {
        result = await appVersionService.getLatestVersion(platform, channel);
      }

      if (!result || (typeof result === 'object' && Object.keys(result).length === 0)) {
        return res.status(404).json({ success: false, message: 'No version information available' });
      }

      return res.json({ success: true, message: 'OK', data: result });
    } catch (error) {
      logger.error('Error fetching app version:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch update info' });
    }
  },

  /**
   * GET /api/v1/app/version/checksum
   * Get checksum for a specific platform and version.
   * Query: ?platform=app_store|play_store|exe|mac_os|offline_exe  ?version=1.0.0
   */
  async getChecksum(req, res) {
    try {
      const { platform, version } = req.query;

      if (!platform || !version) {
        return res.status(400).json({ success: false, message: 'platform and version query params are required' });
      }

      if (!VALID_PLATFORMS.includes(platform)) {
        return res.status(400).json({
          success: false,
          message: `Invalid platform. Valid values: ${VALID_PLATFORMS.join(', ')}`
        });
      }

      const result = await appVersionService.getChecksum(platform, version);
      if (!result) {
        return res.status(404).json({ success: false, message: 'Version or checksum not found' });
      }

      return res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Error fetching checksum:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch checksum' });
    }
  },

  /**
   * GET /api/v1/app/versions
   * Admin: List all versions with optional filters.
   * Query: ?platform=app_store|play_store|exe|mac_os|offline_exe|global  ?channel=stable|beta|alpha  ?is_active=1|0  ?limit=50  ?offset=0
   */
  async getAllVersions(req, res) {
    try {
      const { platform, channel, is_active, limit = 50, offset = 0 } = req.query;

      if (platform && !VALID_PLATFORMS.includes(platform)) {
        return res.status(400).json({
          success: false,
          message: `Invalid platform. Valid values: ${VALID_PLATFORMS.join(', ')}`
        });
      }

      const resolvedActive = is_active === undefined ? undefined : (String(is_active) === '1' || String(is_active).toLowerCase() === 'true');

      const result = await appVersionService.getAllVersions({
        platform,
        channel,
        is_active: resolvedActive,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      return res.json({ success: true, data: result.versions, pagination: result.pagination });
    } catch (error) {
      logger.error('Error fetching app versions:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch versions' });
    }
  },

  /**
   * GET /api/v1/app/versions/:id
   * Admin: Get single version record by ID.
   */
  async getVersionById(req, res) {
    try {
      const { id } = req.params;
      const version = await appVersionService.getVersionById(id);

      if (!version) {
        return res.status(404).json({ success: false, message: 'Version not found' });
      }

      return res.json({ success: true, data: version });
    } catch (error) {
      logger.error('Error fetching app version:', error);
      return res.status(500).json({ success: false, message: 'Failed to fetch version' });
    }
  },

  /**
   * POST /api/v1/app/versions
   * Admin: Create version(s).
   *
   * MODE 1 — Single platform:
   *   Body: { version, platform, channel, build, force_update, release_notes, download_url, min_version, sha256_hash, is_active }
   *   platform defaults to 'global' if omitted.
   *
   * MODE 2 — Multi-platform batch (include a 'platforms' key):
   *   Body: {
   *     channel, release_notes, force_update, build, is_active,  ← shared defaults
   *     platforms: {
   *       app_store:  { version, download_url, min_version, ... },
   *       play_store: { version, download_url, ... },
   *       exe:        { version, download_url, sha256_hash, force_update, ... }
   *     }
   *   }
   *   Per-platform fields override the shared defaults.
   *   When is_active=true (default), existing active records for each platform+channel are deactivated independently.
   */
  async createVersion(req, res) {
    try {
      const userId = req.user?.userId;
      const { platforms, ...common } = req.body;

      // ── MODE 2: Batch multi-platform ──────────────────────────────────────
      if (platforms && typeof platforms === 'object') {
        // Validate all platform keys and version formats before creating anything
        const platformKeys = Object.keys(platforms);
        if (platformKeys.length === 0) {
          return res.status(400).json({ success: false, message: 'platforms object must have at least one entry' });
        }

        for (const plat of platformKeys) {
          if (!VALID_PLATFORMS.includes(plat)) {
            return res.status(400).json({
              success: false,
              message: `Invalid platform "${plat}" in platforms. Valid values: ${VALID_PLATFORMS.join(', ')}`
            });
          }
          const v = platforms[plat].version || common.version;
          if (!v) {
            return res.status(400).json({ success: false, message: `version is required for platform "${plat}"` });
          }
          if (!VERSION_REGEX.test(v)) {
            return res.status(400).json({
              success: false,
              message: `Invalid version format for "${plat}": "${v}". Use e.g. 1.0.0 or 1.0`
            });
          }
        }

        const { results, errors } = await appVersionService.createVersionBatch(platforms, common, userId);
        const hasErrors   = Object.keys(errors).length > 0;
        const hasResults  = Object.keys(results).length > 0;

        return res.status(hasResults ? 201 : 400).json({
          success: hasResults,
          message: hasResults
            ? (hasErrors ? 'Versions created with some errors' : 'Versions created successfully for all platforms')
            : 'Failed to create any version',
          data: results,
          ...(hasErrors ? { errors } : {})
        });
      }

      // ── MODE 1: Single platform ───────────────────────────────────────────
      const { version, platform = 'global' } = req.body;

      if (!version) {
        return res.status(400).json({ success: false, message: 'version is required' });
      }
      if (!VERSION_REGEX.test(version)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid version format. Use semantic versioning e.g. 1.0.0 or 1.0'
        });
      }
      if (!VALID_PLATFORMS.includes(platform)) {
        return res.status(400).json({
          success: false,
          message: `Invalid platform "${platform}". Valid values: ${VALID_PLATFORMS.join(', ')}`
        });
      }

      const created = await appVersionService.createVersion(req.body, userId);
      return res.status(201).json({ success: true, message: 'Version created successfully', data: created });
    } catch (error) {
      logger.error('Error creating app version:', error);
      return res.status(500).json({ success: false, message: 'Failed to create version' });
    }
  },

  /**
   * PUT /api/v1/app/versions/:id
   * Admin: Update an existing version record.
   * Body: any subset of { version, platform, channel, build, force_update, release_notes, download_url, min_version, sha256_hash, is_active }
   * Setting is_active=true deactivates other active records for same platform+channel.
   */
  async updateVersion(req, res) {
    try {
      const { id } = req.params;

      const existing = await appVersionService.getVersionById(id);
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Version not found' });
      }

      if (req.body.version && !VERSION_REGEX.test(req.body.version)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid version format. Use semantic versioning e.g. 1.0.0 or 1.0'
        });
      }

      if (req.body.platform && !VALID_PLATFORMS.includes(req.body.platform)) {
        return res.status(400).json({
          success: false,
          message: `Invalid platform "${req.body.platform}". Valid values: ${VALID_PLATFORMS.join(', ')}`
        });
      }

      const updated = await appVersionService.updateVersion(id, req.body);
      return res.json({ success: true, message: 'Version updated successfully', data: updated });
    } catch (error) {
      logger.error('Error updating app version:', error);
      return res.status(500).json({ success: false, message: 'Failed to update version' });
    }
  },

  /**
   * DELETE /api/v1/app/versions/:id
   * Admin: Delete a version record.
   */
  async deleteVersion(req, res) {
    try {
      const { id } = req.params;
      const deleted = await appVersionService.deleteVersion(id);

      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Version not found' });
      }

      return res.json({ success: true, message: 'Version deleted successfully' });
    } catch (error) {
      logger.error('Error deleting app version:', error);
      return res.status(500).json({ success: false, message: 'Failed to delete version' });
    }
  }
};

module.exports = appVersionController;
