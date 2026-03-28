const { getPool } = require('../database');
const logger = require('../utils/logger');

const menuMediaService = {
  async getById(id) {
    const pool = getPool();
    const [[row]] = await pool.query('SELECT * FROM menu_media WHERE id = ?', [id]);
    return row || null;
  },
  async create(outletId, { fileType, title = null, path, displayOrder = 0, isActive = 1, menuType = 'restaurant' }) {
    const pool = getPool();
    try {
      // Store only relative path, no url column needed
      const [res] = await pool.query(
        `INSERT INTO menu_media (outlet_id, menu_type, file_type, title, path, display_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [outletId, menuType, fileType, title, path, displayOrder, isActive ? 1 : 0]
      );
      const id = res.insertId;
      const [[row]] = await pool.query('SELECT * FROM menu_media WHERE id = ?', [id]);
      return row;
    } catch (error) {
      logger.error('menuMediaService.create error:', error);
      throw error;
    }
  },

  async list(outletId, { type = 'all', isActive = null, menuType = null } = {}) {
    const pool = getPool();
    let where = 'WHERE outlet_id = ?';
    const params = [outletId];

    if (menuType) {
      where += ' AND menu_type = ?';
      params.push(menuType);
    }
    if (type && ['image', 'pdf'].includes(String(type))) {
      where += ' AND file_type = ?';
      params.push(type);
    }
    if (typeof isActive !== 'undefined' && isActive !== null) {
      where += ' AND is_active = ?';
      params.push(isActive ? 1 : 0);
    }

    const [rows] = await pool.query(
      `SELECT id, outlet_id, menu_type, file_type, title, path, display_order, is_active, created_at
       FROM menu_media ${where}
       ORDER BY display_order ASC, created_at DESC`,
      params
    );
    return rows;
  },

  /**
   * Check if any media exists for outlet+menuType (used to determine if QR needs creation)
   */
  async hasMediaForType(outletId, menuType) {
    const pool = getPool();
    const [[row]] = await pool.query(
      'SELECT COUNT(*) as cnt FROM menu_media WHERE outlet_id = ? AND menu_type = ?',
      [outletId, menuType]
    );
    return row.cnt > 0;
  },

  /**
   * Get distinct menu types for an outlet
   */
  async getMenuTypes(outletId) {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT DISTINCT menu_type FROM menu_media WHERE outlet_id = ? ORDER BY menu_type',
      [outletId]
    );
    return rows.map(r => r.menu_type);
  },

  async setActive(id, isActive) {
    const pool = getPool();
    await pool.query('UPDATE menu_media SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
    const [[row]] = await pool.query('SELECT * FROM menu_media WHERE id = ?', [id]);
    return row;
  },

  async updateMeta(id, { title, displayOrder }) {
    const pool = getPool();
    await pool.query('UPDATE menu_media SET title = ?, display_order = ? WHERE id = ?', [title || null, displayOrder || 0, id]);
    const [[row]] = await pool.query('SELECT * FROM menu_media WHERE id = ?', [id]);
    return row;
  },

  async replaceFile(id, { fileType, path }) {
    const pool = getPool();
    // Store only relative path
    await pool.query('UPDATE menu_media SET file_type = ?, path = ? WHERE id = ?', [fileType, path, id]);
    const [[row]] = await pool.query('SELECT * FROM menu_media WHERE id = ?', [id]);
    return row;
  },

  async delete(id) {
    const pool = getPool();
    const [[row]] = await pool.query('SELECT * FROM menu_media WHERE id = ?', [id]);
    if (!row) return { row: null, deleted: false };
    await pool.query('DELETE FROM menu_media WHERE id = ?', [id]);
    return { row, deleted: true };
  }
};

module.exports = menuMediaService;
