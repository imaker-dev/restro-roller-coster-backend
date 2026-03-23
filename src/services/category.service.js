/**
 * Category Service
 * Handles categories with visibility rules (outlet, floor, section, time slot)
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_TTL = 3600;

const categoryService = {
  // ========================
  // CATEGORY CRUD
  // ========================

  async create(data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const {
        outletId, parentId, name, slug, description,
        imageUrl, icon, colorCode, displayOrder = 0, isActive = true, isGlobal = false,
        serviceType = 'both', // 'restaurant', 'bar', or 'both'
        // Visibility rules
        floorIds = [], sectionIds = [], timeSlotIds = []
      } = data;

      const categorySlug = slug || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

      const [result] = await connection.query(
        `INSERT INTO categories (outlet_id, parent_id, name, slug, description, image_url, icon, color_code, display_order, is_active, is_global, service_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [outletId, parentId, name, categorySlug, description, imageUrl, icon, colorCode, displayOrder, isActive, isGlobal, serviceType]
      );

      const categoryId = result.insertId;

      // Add floor visibility rules
      for (const floorId of floorIds) {
        await connection.query(
          `INSERT INTO category_floors (category_id, floor_id, is_available) VALUES (?, ?, 1)`,
          [categoryId, floorId]
        );
      }

      // Add section visibility rules
      for (const sectionId of sectionIds) {
        await connection.query(
          `INSERT INTO category_sections (category_id, section_id, is_available) VALUES (?, ?, 1)`,
          [categoryId, sectionId]
        );
      }

      // Add time slot visibility rules
      for (const timeSlotId of timeSlotIds) {
        await connection.query(
          `INSERT INTO category_time_slots (category_id, time_slot_id, is_available) VALUES (?, ?, 1)`,
          [categoryId, timeSlotId]
        );
      }

      await connection.commit();
      await this.invalidateCache(outletId);

      return this.getById(categoryId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async getByOutlet(outletId, filters = {}) {
    const pool = getPool();
    
    // Base data query — includes subquery counts for filtering & display
    let query = `
      SELECT c.*,
        pc.name as parent_name,
        (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.is_active = 1 AND i.deleted_at IS NULL) as item_count,
        (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.is_active = 0 AND i.deleted_at IS NULL) as inactive_item_count,
        (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.deleted_at IS NULL AND i.has_variants = 1) as variant_item_count,
        (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.deleted_at IS NULL AND i.has_addons = 1) as addon_item_count,
        (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM recipes r WHERE r.menu_item_id = i.id AND r.is_active = 1)) as recipe_item_count
      FROM categories c
      LEFT JOIN categories pc ON c.parent_id = pc.id
      WHERE c.outlet_id = ? AND c.deleted_at IS NULL
    `;
    const params = [outletId];

    // Build WHERE conditions (applied to both count and data queries)
    let whereConditions = '';
    
    if (filters.search) {
      whereConditions += ' AND (c.name LIKE ? OR c.description LIKE ?)';
      const searchTerm = `%${filters.search}%`;
      params.push(searchTerm, searchTerm);
    }
    if (filters.serviceType && ['restaurant', 'bar', 'both'].includes(filters.serviceType)) {
      whereConditions += ' AND (c.service_type = ? OR c.service_type = ?)';
      params.push(filters.serviceType, 'both');
    }
    if (filters.parentId !== undefined) {
      if (filters.parentId === null || filters.parentId === 'null') {
        whereConditions += ' AND c.parent_id IS NULL';
      } else {
        whereConditions += ' AND c.parent_id = ?';
        params.push(parseInt(filters.parentId));
      }
    }

    query += whereConditions;

    // HAVING-style filters (applied after subqueries resolve)
    // We wrap the query in a subquery to filter on computed columns
    let havingFilters = [];
    if (filters.hasInactiveItems === true) havingFilters.push('inactive_item_count > 0');
    else if (filters.hasInactiveItems === false) havingFilters.push('inactive_item_count = 0');

    if (filters.hasRecipeItems === true) havingFilters.push('recipe_item_count > 0');
    else if (filters.hasRecipeItems === false) havingFilters.push('recipe_item_count = 0');

    if (filters.hasVariants === true) havingFilters.push('variant_item_count > 0');
    else if (filters.hasVariants === false) havingFilters.push('variant_item_count = 0');

    if (filters.hasAddons === true) havingFilters.push('addon_item_count > 0');
    else if (filters.hasAddons === false) havingFilters.push('addon_item_count = 0');

    query += ' ORDER BY c.display_order, c.name';

    // If HAVING-style filters exist, wrap query in subquery
    if (havingFilters.length > 0) {
      query = `SELECT * FROM (${query}) AS filtered WHERE ${havingFilters.join(' AND ')}`;
    }

    // Pagination — count from the filtered set
    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 50;
    const offset = (page - 1) * limit;

    const countSql = `SELECT COUNT(*) as total FROM (${query}) AS cnt`;
    const [[{ total }]] = await pool.query(countSql, params);
    
    query += ' LIMIT ? OFFSET ?';
    const [categories] = await pool.query(query, [...params, limit, offset]);
    
    return {
      categories,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1
      }
    };
  },

  async getById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT c.*,
        pc.name as parent_name,
        (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.is_active = 1 AND i.deleted_at IS NULL) as item_count
       FROM categories c
       LEFT JOIN categories pc ON c.parent_id = pc.id
       WHERE c.id = ? AND c.deleted_at IS NULL`,
      [id]
    );
    return rows[0] || null;
  },

  async getWithVisibility(id) {
    const category = await this.getById(id);
    if (!category) return null;

    const pool = getPool();

    // Get floor visibility
    const [floors] = await pool.query(
      `SELECT f.id, f.name, cf.is_available
       FROM category_floors cf
       JOIN floors f ON cf.floor_id = f.id
       WHERE cf.category_id = ?`,
      [id]
    );

    // Get section visibility
    const [sections] = await pool.query(
      `SELECT s.id, s.name, s.section_type, cs.is_available
       FROM category_sections cs
       JOIN sections s ON cs.section_id = s.id
       WHERE cs.category_id = ?`,
      [id]
    );

    // Get time slot visibility
    const [timeSlots] = await pool.query(
      `SELECT ts.id, ts.name, ts.start_time, ts.end_time, cts.is_available
       FROM category_time_slots cts
       JOIN time_slots ts ON cts.time_slot_id = ts.id
       WHERE cts.category_id = ?`,
      [id]
    );

    return {
      ...category,
      visibility: {
        floors,
        sections,
        timeSlots
      }
    };
  },

  async update(id, data) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const fields = [];
      const values = [];

      if (data.parentId !== undefined) { fields.push('parent_id = ?'); values.push(data.parentId); }
      if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
      if (data.slug !== undefined) { fields.push('slug = ?'); values.push(data.slug); }
      if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
      if (data.imageUrl !== undefined) { fields.push('image_url = ?'); values.push(data.imageUrl); }
      if (data.icon !== undefined) { fields.push('icon = ?'); values.push(data.icon); }
      if (data.colorCode !== undefined) { fields.push('color_code = ?'); values.push(data.colorCode); }
      if (data.displayOrder !== undefined) { fields.push('display_order = ?'); values.push(data.displayOrder); }
      if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive); }
      if (data.isGlobal !== undefined) { fields.push('is_global = ?'); values.push(data.isGlobal); }
      if (data.serviceType !== undefined) { fields.push('service_type = ?'); values.push(data.serviceType); }

      if (fields.length > 0) {
        values.push(id);
        await connection.query(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`, values);
      }

      // Update visibility rules
      if (data.floorIds !== undefined) {
        await connection.query('DELETE FROM category_floors WHERE category_id = ?', [id]);
        for (const floorId of data.floorIds) {
          await connection.query(
            `INSERT INTO category_floors (category_id, floor_id, is_available) VALUES (?, ?, 1)`,
            [id, floorId]
          );
        }
      }

      if (data.sectionIds !== undefined) {
        await connection.query('DELETE FROM category_sections WHERE category_id = ?', [id]);
        for (const sectionId of data.sectionIds) {
          await connection.query(
            `INSERT INTO category_sections (category_id, section_id, is_available) VALUES (?, ?, 1)`,
            [id, sectionId]
          );
        }
      }

      if (data.timeSlotIds !== undefined) {
        await connection.query('DELETE FROM category_time_slots WHERE category_id = ?', [id]);
        for (const timeSlotId of data.timeSlotIds) {
          await connection.query(
            `INSERT INTO category_time_slots (category_id, time_slot_id, is_available) VALUES (?, ?, 1)`,
            [id, timeSlotId]
          );
        }
      }

      await connection.commit();

      const category = await this.getById(id);
      if (category) await this.invalidateCache(category.outlet_id);
      return category;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  async delete(id) {
    const pool = getPool();
    const category = await this.getById(id);
    if (!category) return false;

    // Soft delete
    await pool.query('UPDATE categories SET deleted_at = NOW(), is_active = 0 WHERE id = ?', [id]);
    await this.invalidateCache(category.outlet_id);
    return true;
  },

  // ========================
  // VISIBILITY CHECKS
  // ========================

  /**
   * Check if category is visible for given context
   */
  async isVisible(categoryId, context = {}) {
    const { floorId, sectionId, timeSlotId, time, day } = context;
    const pool = getPool();

    // Check floor visibility
    if (floorId) {
      const [floors] = await pool.query(
        `SELECT is_available FROM category_floors WHERE category_id = ? AND floor_id = ?`,
        [categoryId, floorId]
      );
      // If floor rule exists and not available, hide category
      if (floors.length > 0 && !floors[0].is_available) return false;
      // If floor rules exist but this floor is not in the list, check if we should hide
      const [allFloorRules] = await pool.query(
        `SELECT COUNT(*) as count FROM category_floors WHERE category_id = ?`,
        [categoryId]
      );
      if (allFloorRules[0].count > 0 && floors.length === 0) return false;
    }

    // Check section visibility
    if (sectionId) {
      const [sections] = await pool.query(
        `SELECT is_available FROM category_sections WHERE category_id = ? AND section_id = ?`,
        [categoryId, sectionId]
      );
      if (sections.length > 0 && !sections[0].is_available) return false;
      const [allSectionRules] = await pool.query(
        `SELECT COUNT(*) as count FROM category_sections WHERE category_id = ?`,
        [categoryId]
      );
      if (allSectionRules[0].count > 0 && sections.length === 0) return false;
    }

    // Check time slot visibility
    if (timeSlotId) {
      const [timeSlots] = await pool.query(
        `SELECT is_available FROM category_time_slots WHERE category_id = ? AND time_slot_id = ?`,
        [categoryId, timeSlotId]
      );
      if (timeSlots.length > 0 && !timeSlots[0].is_available) return false;
      const [allTimeRules] = await pool.query(
        `SELECT COUNT(*) as count FROM category_time_slots WHERE category_id = ?`,
        [categoryId]
      );
      if (allTimeRules[0].count > 0 && timeSlots.length === 0) return false;
    }

    return true;
  },

  /**
   * Get categories filtered by context (floor, section, time, serviceType)
   */
  async getVisibleCategories(outletId, context = {}) {
    const { floorId, sectionId, timeSlotId, serviceType } = context;
    const pool = getPool();

    let query = `
      SELECT DISTINCT c.*,
        pc.name as parent_name,
        (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.is_active = 1 AND i.deleted_at IS NULL) as item_count
      FROM categories c
      LEFT JOIN categories pc ON c.parent_id = pc.id
      WHERE c.outlet_id = ? AND c.is_active = 1 AND c.deleted_at IS NULL
    `;
    const params = [outletId];

    // Service type filter (restaurant/bar/both)
    if (serviceType && serviceType !== 'all') {
      query += ` AND (c.service_type = ? OR c.service_type = 'both')`;
      params.push(serviceType);
    }

    // Floor filter - skip if category is global
    if (floorId) {
      query += `
        AND (
          c.is_global = 1
          OR NOT EXISTS (SELECT 1 FROM category_floors cf WHERE cf.category_id = c.id)
          OR EXISTS (SELECT 1 FROM category_floors cf WHERE cf.category_id = c.id AND cf.floor_id = ? AND cf.is_available = 1)
        )
      `;
      params.push(floorId);
    }

    // Section filter - skip if category is global
    if (sectionId) {
      query += `
        AND (
          c.is_global = 1
          OR NOT EXISTS (SELECT 1 FROM category_sections cs WHERE cs.category_id = c.id)
          OR EXISTS (SELECT 1 FROM category_sections cs WHERE cs.category_id = c.id AND cs.section_id = ? AND cs.is_available = 1)
        )
      `;
      params.push(sectionId);
    }

    // Time slot filter - skip if category is global
    if (timeSlotId) {
      query += `
        AND (
          c.is_global = 1
          OR NOT EXISTS (SELECT 1 FROM category_time_slots cts WHERE cts.category_id = c.id)
          OR EXISTS (SELECT 1 FROM category_time_slots cts WHERE cts.category_id = c.id AND cts.time_slot_id = ? AND cts.is_available = 1)
        )
      `;
      params.push(timeSlotId);
    }

    query += ' ORDER BY c.display_order, c.name';

    const [categories] = await pool.query(query, params);
    return categories;
  },

  // ========================
  // HIERARCHY
  // ========================

  async getTree(outletId) {
    const categories = await this.getByOutlet(outletId);
    
    const buildTree = (parentId = null) => {
      return categories
        .filter(c => c.parent_id === parentId)
        .map(c => ({
          ...c,
          children: buildTree(c.id)
        }));
    };

    return buildTree(null);
  },

  async invalidateCache(outletId) {
    await cache.del(`categories:${outletId}:true`);
    await cache.del(`categories:${outletId}:false`);
  }
};

module.exports = categoryService;
