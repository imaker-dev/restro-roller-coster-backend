const { getPool } = require('../database');
const logger = require('../utils/logger');

const VALID_PLATFORMS = ['global', 'app_store', 'play_store', 'exe', 'mac_os'];

const appVersionService = {
  /**
   * Compare two semantic versions
   * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  compareVersions(v1, v2) {
    if (!v1 || !v2) return 0;
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    const maxLen = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < maxLen; i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 > p2) return 1;
      if (p1 < p2) return -1;
    }
    return 0;
  },

  /**
   * Get the latest active version for a specific platform and channel.
   * If platform is null/undefined, returns latest for ALL platforms keyed by platform name.
   * Falls back to 'global' record if no platform-specific record found.
   */
  async getLatestVersion(platform = null, channel = 'stable') {
    const pool = getPool();

    if (platform && platform !== 'all') {
      // Return single platform's latest active version
      const [rows] = await pool.query(
        `SELECT * FROM app_versions 
         WHERE is_active = TRUE AND channel = ? AND platform = ?
         ORDER BY released_at DESC LIMIT 1`,
        [channel, platform]
      );
      if (rows.length > 0) return this._formatRow(rows[0]);

      // Fallback to global if no platform-specific record exists
      const [globalRows] = await pool.query(
        `SELECT * FROM app_versions 
         WHERE is_active = TRUE AND channel = ? AND platform = 'global'
         ORDER BY released_at DESC LIMIT 1`,
        [channel]
      );
      return globalRows.length > 0 ? this._formatRow(globalRows[0]) : null;
    }

    // Return all active versions per platform
    const [rows] = await pool.query(
      `SELECT * FROM app_versions
       WHERE is_active = TRUE AND channel = ?
       ORDER BY platform ASC, released_at DESC`,
      [channel]
    );

    // Deduplicate: pick only the latest per platform
    const seen = {};
    const result = {};
    for (const row of rows) {
      if (!seen[row.platform]) {
        seen[row.platform] = true;
        result[row.platform] = this._formatRow(row);
      }
    }
    return result;
  },

  /**
   * Format a DB row into a clean API response object
   */
  _formatRow(row) {
    return {
      id: row.id,
      version: row.version,
      build: row.build,
      platform: row.platform,
      channel: row.channel,
      force_update: Boolean(row.force_update),
      release_notes: row.release_notes,
      release_date: row.released_at,
      download_url: row.download_url || null,
      min_version: row.min_version || null,
      sha256: row.sha256_hash || null,
      // Legacy multi-platform URL fields (for global records)
      android_url: row.android_url || null,
      ios_url: row.ios_url || null,
      windows_url: row.windows_url || null,
      mac_url: row.mac_url || null,
      linux_url: row.linux_url || null,
      is_active: Boolean(row.is_active),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  },

  /**
   * Check if an update is available for a given platform and current version.
   * If platform is null, returns per-platform update check keyed by platform name.
   */
  async checkForUpdate(currentVersion, platform = null, channel = 'stable') {
    const latest = await this.getLatestVersion(platform, channel);

    if (!latest) {
      return { update_available: false, message: 'No version information available' };
    }

    // No platform specified → latest is a map keyed by platform name
    if (!platform || platform === 'all') {
      if (typeof latest === 'object' && !latest.version) {
        // Map of { app_store: {...}, play_store: {...}, ... }
        const result = {};
        for (const [plat, info] of Object.entries(latest)) {
          const isNewer = this.compareVersions(info.version, currentVersion) > 0;
          let forceUpdate = info.force_update;
          if (isNewer && info.min_version) {
            forceUpdate = forceUpdate || this.compareVersions(info.min_version, currentVersion) > 0;
          }
          result[plat] = {
            update_available: isNewer,
            force_update: isNewer ? forceUpdate : false,
            current_version: currentVersion,
            latest_version: info.version,
            ...info
          };
        }
        return result;
      }
    }

    // Single platform
    if (!latest.version) {
      return { update_available: false, message: 'No version information available' };
    }

    const isNewer = this.compareVersions(latest.version, currentVersion) > 0;
    let forceUpdate = latest.force_update;
    if (isNewer && latest.min_version) {
      forceUpdate = forceUpdate || this.compareVersions(latest.min_version, currentVersion) > 0;
    }

    return {
      update_available: isNewer,
      force_update: isNewer ? forceUpdate : false,
      current_version: currentVersion,
      latest_version: latest.version,
      ...latest
    };
  },

  /**
   * Get all versions (for admin panel)
   * Supports filters: platform, channel, is_active
   */
  async getAllVersions(options = {}) {
    const pool = getPool();
    const { platform, channel, is_active, limit = 50, offset = 0 } = options;

    const where = [];
    const params = [];

    if (platform) { where.push('platform = ?'); params.push(platform); }
    if (channel)  { where.push('channel = ?');  params.push(channel); }
    if (is_active !== undefined && is_active !== null) {
      where.push('is_active = ?');
      params.push(is_active ? 1 : 0);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
      `SELECT * FROM app_versions ${whereClause} ORDER BY platform ASC, released_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM app_versions ${whereClause}`,
      params
    );

    return {
      versions: rows.map(r => this._formatRow(r)),
      pagination: { total, limit: parseInt(limit), offset: parseInt(offset), hasMore: offset + rows.length < total }
    };
  },

  /**
   * Get version by ID
   */
  async getVersionById(id) {
    const pool = getPool();
    const [rows] = await pool.query(`SELECT * FROM app_versions WHERE id = ?`, [id]);
    return rows[0] ? this._formatRow(rows[0]) : null;
  },

  /**
   * Create a new version for a specific platform.
   * When is_active=true, deactivates all other active records for the SAME platform+channel.
   */
  async createVersion(data, userId = null) {
    const pool = getPool();

    const {
      version,
      build          = null,
      platform       = 'global',
      force_update   = false,
      release_notes  = null,
      download_url   = null,
      min_version    = null,
      sha256_hash    = null,
      is_active      = true,
      channel        = 'stable',
      // Legacy global fields
      android_url         = null,
      ios_url             = null,
      windows_url         = null,
      mac_url             = null,
      linux_url           = null,
      android_min_version = null,
      ios_min_version     = null,
      windows_min_version = null,
      mac_min_version     = null,
      linux_min_version   = null,
      android_sha256      = null,
      ios_sha256          = null,
      windows_sha256      = null,
      mac_sha256          = null,
      linux_sha256        = null
    } = data;

    // Deactivate existing active records for same platform+channel
    if (is_active) {
      await pool.query(
        `UPDATE app_versions SET is_active = FALSE WHERE platform = ? AND channel = ?`,
        [platform, channel]
      );
    }

    const [result] = await pool.query(
      `INSERT INTO app_versions (
        version, build, platform, force_update, release_notes,
        download_url, min_version, sha256_hash,
        android_url, ios_url, windows_url, mac_url, linux_url,
        android_min_version, ios_min_version, windows_min_version, mac_min_version, linux_min_version,
        android_sha256, ios_sha256, windows_sha256, mac_sha256, linux_sha256,
        is_active, channel, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        version, build, platform, force_update, release_notes,
        download_url, min_version, sha256_hash,
        android_url, ios_url, windows_url, mac_url, linux_url,
        android_min_version, ios_min_version, windows_min_version, mac_min_version, linux_min_version,
        android_sha256, ios_sha256, windows_sha256, mac_sha256, linux_sha256,
        is_active, channel, userId
      ]
    );

    logger.info(`App version ${version} (${platform}/${channel}) created by user ${userId}`);
    return this.getVersionById(result.insertId);
  },

  /**
   * Update a version record.
   * If setting is_active=true, deactivates other records for same platform+channel.
   */
  async updateVersion(id, data) {
    const pool = getPool();

    const allowedFields = [
      'version', 'build', 'platform', 'force_update', 'release_notes',
      'download_url', 'min_version', 'sha256_hash',
      'android_url', 'ios_url', 'windows_url', 'mac_url', 'linux_url',
      'android_min_version', 'ios_min_version', 'windows_min_version', 'mac_min_version', 'linux_min_version',
      'android_sha256', 'ios_sha256', 'windows_sha256', 'mac_sha256', 'linux_sha256',
      'is_active', 'channel'
    ];

    const fields = [];
    const values = [];
    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(data[field]);
      }
    }

    if (fields.length === 0) return this.getVersionById(id);

    // Deactivate others in same platform+channel if activating this record
    if (data.is_active === true) {
      const [existing] = await pool.query(
        `SELECT platform, channel FROM app_versions WHERE id = ?`, [id]
      );
      if (existing.length > 0) {
        const { platform, channel } = existing[0];
        await pool.query(
          `UPDATE app_versions SET is_active = FALSE WHERE platform = ? AND channel = ? AND id != ?`,
          [platform, channel, id]
        );
      }
    }

    values.push(id);
    await pool.query(`UPDATE app_versions SET ${fields.join(', ')} WHERE id = ?`, values);

    logger.info(`App version id=${id} updated`);
    return this.getVersionById(id);
  },

  /**
   * Delete a version
   */
  async deleteVersion(id) {
    const pool = getPool();
    const [result] = await pool.query(`DELETE FROM app_versions WHERE id = ?`, [id]);
    return result.affectedRows > 0;
  },

  /**
   * Get checksum for a platform + version string.
   * For platform-specific records: returns sha256_hash + download_url.
   * For global records: uses legacy platform-specific columns.
   */
  async getChecksum(platform, version) {
    const pool = getPool();

    // Try platform-specific record first
    const [platformRows] = await pool.query(
      `SELECT sha256_hash as sha256, download_url as url FROM app_versions 
       WHERE platform = ? AND version = ? ORDER BY released_at DESC LIMIT 1`,
      [platform, version]
    );
    if (platformRows.length > 0 && platformRows[0].sha256) return platformRows[0];

    // Fallback to global record with legacy columns
    // Map platform names to database column prefixes (mac_url, mac_sha256, etc.)
    const legacyMap = { app_store: 'ios', play_store: 'android', exe: 'windows', mac_os: 'mac' };
    const legacyKey = legacyMap[platform] || platform;
    const sha256Field = `${legacyKey}_sha256`;
    const urlField    = `${legacyKey}_url`;

    const validLegacy = ['android', 'ios', 'windows', 'mac', 'linux'];
    if (!validLegacy.includes(legacyKey)) return null;

    const [rows] = await pool.query(
      `SELECT ?? as sha256, ?? as url FROM app_versions 
       WHERE platform = 'global' AND version = ? ORDER BY released_at DESC LIMIT 1`,
      [sha256Field, urlField, version]
    );
    return rows.length > 0 ? rows[0] : null;
  },

  /**
   * Create versions for multiple platforms in a single call.
   * Common fields (channel, release_notes, force_update, build) apply to all platforms
   * unless overridden per-platform.
   *
   * @param {Object} platformsData  - { app_store: { version, download_url, ... }, play_store: {...}, exe: {...} }
   * @param {Object} common         - { channel, release_notes, force_update, build, is_active, min_version }
   * @param {number} userId
   * @returns {Object} - { app_store: {...}, play_store: {...}, exe: {...} } — created records
   */
  async createVersionBatch(platformsData, common = {}, userId = null) {
    const results = {};
    const errors  = {};

    for (const [platform, overrides] of Object.entries(platformsData)) {
      if (!VALID_PLATFORMS.includes(platform)) {
        errors[platform] = `Invalid platform: ${platform}`;
        continue;
      }
      const merged = { ...common, ...overrides, platform };
      if (!merged.version) {
        errors[platform] = 'version is required';
        continue;
      }
      try {
        results[platform] = await this.createVersion(merged, userId);
      } catch (err) {
        logger.error(`createVersionBatch failed for ${platform}:`, err.message);
        errors[platform] = err.message;
      }
    }

    return { results, errors };
  },

  VALID_PLATFORMS
};

module.exports = appVersionService;
