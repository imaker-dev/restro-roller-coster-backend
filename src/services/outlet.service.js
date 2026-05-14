const { getPool } = require('../database');
const { v4: uuidv4 } = require('uuid');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');
const appConfig = require('../config/app.config');

const CACHE_TTL = 3600; // 1 hour

/**
 * Outlet Service - CRUD and management for restaurant outlets
 */
const outletService = {
  /**
   * Create new outlet
   */
  async create(data, userId) {
    const pool = getPool();
    const uuid = uuidv4();
    const code = data.code || await this.generateCode(data.name);

    const [result] = await pool.query(
      `INSERT INTO outlets (
        uuid, code, name, legal_name, outlet_type, 
        address_line1, address_line2, city, state, country, postal_code,
        phone, email, gstin, fssai_number, pan_number,
        opening_time, closing_time, is_24_hours,
        currency_code, timezone, settings,
        is_active, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid, code, data.name, data.legalName || null, data.outletType || 'restaurant',
        data.addressLine1 || null, data.addressLine2 || null, data.city || null, 
        data.state || null, data.country || 'India', data.postalCode || null,
        data.phone || null, data.email || null, data.gstin || null, data.fssaiNumber || null,
        data.panNumber || null,
        data.openingTime || null, data.closingTime || null, data.is24Hours || false,
        data.currencyCode || 'INR', data.timezone || 'Asia/Kolkata',
        JSON.stringify(data.settings || {}),
        data.isActive !== false, userId
      ]
    );

    const outletId = result.insertId;

    // Auto-assign outlet to the creator if they're an admin without outlets
    if (userId) {
      try {
        // Check if user has admin role without any outlet assignments
        const [adminRoles] = await pool.query(
          `SELECT ur.id FROM user_roles ur
           JOIN roles r ON ur.role_id = r.id
           WHERE ur.user_id = ? AND ur.is_active = 1 
             AND r.slug = 'admin' AND ur.outlet_id IS NULL`,
          [userId]
        );
        
        // Update admin role to include this outlet
        if (adminRoles.length > 0) {
          await pool.query(
            `UPDATE user_roles SET outlet_id = ? WHERE id = ?`,
            [outletId, adminRoles[0].id]
          );
          logger.info(`Auto-assigned outlet ${outletId} to admin user ${userId}`);
        }
      } catch (err) {
        logger.warn(`Failed to auto-assign outlet to creator: ${err.message}`);
      }
    }

    await cache.del('outlets:all');
    return this.getById(outletId);
  },

  /**
   * Get all outlets (filtered by user's assigned outlets)
   * master:        outlets with NO user_roles entries (truly unassigned / regular outlets)
   * super_admin:   outlets they created OR are explicitly assigned via user_roles
   * admin/manager: only outlets assigned via user_roles
   *
   * Optimized: aggregate LEFT JOINs (one pass) + subscription plan object + creator name.
   */
  async getAll(filters = {}, userId = null, userRoles = []) {
    const pool = getPool();

    const isMaster     = userRoles && userRoles.includes('master');
    const isSuperAdmin = !isMaster && userRoles && userRoles.includes('super_admin');

    let query = `
      SELECT
        o.*,
        COALESCE(creator.name, 'System') AS created_by_name,
        COALESCE(f.floor_count, 0)       AS floor_count,
        COALESCE(t.table_count, 0)       AS table_count,
        os.status                          AS subscription_status,
        os.subscription_end,
        os.grace_period_end,
        sp.total_price                     AS subscription_plan_price,
        sp.base_price,
        sp.gst_percentage
      FROM outlets o
      LEFT JOIN users creator ON creator.id = o.created_by AND creator.deleted_at IS NULL
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS floor_count
        FROM floors GROUP BY outlet_id
      ) f ON f.outlet_id = o.id
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS table_count
        FROM tables WHERE is_active = 1 GROUP BY outlet_id
      ) t ON t.outlet_id = o.id
      LEFT JOIN outlet_subscriptions os ON os.outlet_id = o.id
      LEFT JOIN subscription_pricing sp ON sp.id = os.current_pricing_id
      WHERE o.deleted_at IS NULL AND o.is_active = 1
    `;
    const params = [];

    if (isMaster) {
      // master: exclude outlets owned by or assigned to super_admins
      // (1) created_by user is a super_admin, OR (2) outlet has explicit super_admin assignment
      query += ` AND o.created_by NOT IN (
        SELECT DISTINCT ur.user_id FROM user_roles ur
        INNER JOIN roles r ON r.id = ur.role_id
        WHERE r.slug = 'super_admin' AND ur.is_active = 1
      )`;
      query += ` AND o.id NOT IN (
        SELECT ur.outlet_id FROM user_roles ur
        INNER JOIN roles r ON r.id = ur.role_id
        WHERE r.slug = 'super_admin' AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
      )`;
    } else if (isSuperAdmin && userId) {
      // super_admin: outlets they created OR are assigned via user_roles
      query += ` AND (o.created_by = ? OR o.id IN (
        SELECT ur.outlet_id FROM user_roles ur
        WHERE ur.user_id = ? AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
      ))`;
      params.push(userId, userId);
    } else if (userId) {
      // admin/manager: only outlets assigned via user_roles
      query += ` AND o.id IN (
        SELECT DISTINCT ur.outlet_id
        FROM user_roles ur
        WHERE ur.user_id = ? AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
      )`;
      params.push(userId);
    }

    if (filters.isActive !== undefined) {
      query += ' AND o.is_active = ?';
      params.push(filters.isActive);
    }

    if (filters.outletType) {
      query += ' AND o.outlet_type = ?';
      params.push(filters.outletType);
    }

    if (filters.search) {
      query += ' AND (o.name LIKE ? OR o.code LIKE ? OR o.city LIKE ?)';
      const search = `%${filters.search}%`;
      params.push(search, search, search);
    }

    query += ' ORDER BY o.name ASC';

    const [rows] = await pool.query(query, params);

    // Post-process: replace created_by (id) with name, build subscription_plan object
    const outlets = rows.map((row) => {
      const outlet = { ...row };

      // Replace numeric created_by with creator name
      outlet.created_by = row.created_by_name;
      delete outlet.created_by_name;

      // Nest subscription plan fields
      outlet.subscription_plan = {
        status: row.subscription_status || null,
        end_date: row.subscription_end || null,
        grace_period_end: row.grace_period_end || null,
        price: row.subscription_plan_price || null,
        base_price: row.base_price || null,
        gst_percentage: row.gst_percentage || null,
      };
      delete outlet.subscription_status;
      delete outlet.subscription_end;
      delete outlet.grace_period_end;
      delete outlet.subscription_plan_price;
      delete outlet.base_price;
      delete outlet.gst_percentage;

      return outlet;
    });

    return outlets;
  },

  /**
   * Get all outlets for MASTER role.
   * Comprehensive dashboard view: all outlets in the system with
   * subscription status, pricing source, super admin info, and metrics.
   *
   * Supports: pagination, search, filters (status, subscription_status,
   * pricing_source, outlet_type, superAdminId, hasQrCodes).
   *
   * Optimized: single COUNT + single data query with indexed LEFT JOINs.
   */
  async getAllForMaster(filters = {}, pagination = { page: 1, limit: 50 }) {
    const pool = getPool();

    const {
      search,
      isActive,
      subscriptionStatus,
      pricingSource,
      outletType,
      superAdminId,
      hasQrCodes,
      sortBy = 'o.created_at',
      sortOrder = 'DESC',
    } = filters;

    const page = Math.max(1, parseInt(pagination.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(pagination.limit, 10) || 50));
    const offset = (page - 1) * limit;

    // Build WHERE clause
    let where = 'WHERE o.deleted_at IS NULL';
    const params = [];

    if (isActive !== undefined) {
      where += ' AND o.is_active = ?';
      params.push(isActive === 'true' || isActive === true ? 1 : 0);
    }

    if (outletType) {
      where += ' AND o.outlet_type = ?';
      params.push(outletType);
    }

    if (subscriptionStatus) {
      where += ' AND os.status = ?';
      params.push(subscriptionStatus);
    }

    if (pricingSource) {
      where += ' AND os.pricing_source = ?';
      params.push(pricingSource);
    }

    if (superAdminId) {
      where += ` AND o.id IN (
        SELECT DISTINCT ur.outlet_id FROM user_roles ur
        INNER JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ? AND r.slug = 'super_admin' AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
        UNION
        SELECT o2.id FROM outlets o2 WHERE o2.created_by = ? AND o2.deleted_at IS NULL
      )`;
      params.push(parseInt(superAdminId, 10), parseInt(superAdminId, 10));
    }

    if (hasQrCodes !== undefined) {
      const hasQr = hasQrCodes === 'true' || hasQrCodes === true;
      where += hasQr
        ? ` AND EXISTS (SELECT 1 FROM tables tq WHERE tq.outlet_id = o.id AND tq.qr_code IS NOT NULL AND tq.qr_code != '' AND tq.is_active = 1 LIMIT 1)`
        : ` AND NOT EXISTS (SELECT 1 FROM tables tq WHERE tq.outlet_id = o.id AND tq.qr_code IS NOT NULL AND tq.qr_code != '' AND tq.is_active = 1 LIMIT 1)`;
    }

    if (search) {
      where += ' AND (o.name LIKE ? OR o.code LIKE ? OR o.city LIKE ? OR o.phone LIKE ? OR o.email LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    // Valid sort columns whitelist
    const sortMap = {
      'o.name': 'o.name',
      'o.created_at': 'o.created_at',
      'o.updated_at': 'o.updated_at',
      'o.is_active': 'o.is_active',
      'subscription_end': 'os.subscription_end',
      'subscription_status': 'os.status',
      'table_count': 'COALESCE(t.table_count, 0)',
    };
    const orderCol = sortMap[sortBy] || 'o.created_at';
    const orderDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // ─── COUNT query ───
    const countQuery = `SELECT COUNT(*) AS total FROM outlets o
      LEFT JOIN outlet_subscriptions os ON os.outlet_id = o.id
      ${where}`;
    const [[{ total }]] = await pool.query(countQuery, params);

    // ─── DATA query ───
    // Super admin resolver: picks the first active super_admin via user_roles,
    // falls back to created_by if that user has a super_admin role.
    const dataQuery = `
      SELECT
        o.id, o.uuid, o.code, o.name, o.legal_name, o.outlet_type,
        o.address_line1, o.address_line2, o.city, o.state, o.country, o.postal_code,
        o.phone, o.email, o.gstin, o.fssai_number, o.pan_number,
        o.logo_url, o.currency_code, o.timezone,
        o.opening_time, o.closing_time, o.is_24_hours,
        o.settings, o.is_active, o.created_by, o.created_at, o.updated_at,

        -- Creator
        COALESCE(creator.name, 'System') AS creator_name,
        creator.email AS creator_email,

        -- Super admin (resolved via user_roles first, then created_by fallback)
        sa.super_admin_id,
        sa.super_admin_name,
        sa.super_admin_email,

        -- Subscription
        os.status AS subscription_status,
        os.subscription_start,
        os.subscription_end,
        os.grace_period_end,
        os.auto_renew,
        os.pricing_source,
        os.notes AS subscription_notes,

        -- Resolved pricing (outlet_override > super_admin > global)
        COALESCE(opo.base_price, sap.base_price, sp.base_price) AS resolved_base_price,
        COALESCE(opo.gst_percentage, sap.gst_percentage, sp.gst_percentage) AS resolved_gst_percentage,
        COALESCE(opo.total_price, sap.total_price, sp.total_price) AS resolved_total_price,
        CASE
          WHEN opo.id IS NOT NULL THEN 'outlet'
          WHEN sap.id IS NOT NULL THEN 'super_admin'
          WHEN sp.id IS NOT NULL THEN 'global'
          ELSE NULL
        END AS resolved_pricing_source,

        -- Metrics
        COALESCE(f.floor_count, 0) AS floor_count,
        COALESCE(t.table_count, 0) AS table_count,
        COALESCE(staff.staff_count, 0) AS staff_count,
        COALESCE(qr_tables.qr_count, 0) AS qr_generated_count,
        COALESCE(all_tables.total_table_count, 0) AS total_table_count

      FROM outlets o

      -- Creator info
      LEFT JOIN users creator ON creator.id = o.created_by AND creator.deleted_at IS NULL

      -- Super admin resolver (single row per outlet)
      LEFT JOIN (
        SELECT DISTINCT
          o.id AS outlet_id,
          u.id AS super_admin_id,
          u.name AS super_admin_name,
          u.email AS super_admin_email
        FROM outlets o
        INNER JOIN (
          SELECT o2.id,
            COALESCE(
              (SELECT ur.user_id FROM user_roles ur
                INNER JOIN roles r ON r.id = ur.role_id
                WHERE ur.outlet_id = o2.id AND r.slug = 'super_admin' AND ur.is_active = 1
                ORDER BY ur.id LIMIT 1),
              (SELECT o2.created_by FROM outlets o2b WHERE o2b.id = o2.id AND o2b.created_by IN (
                SELECT ur2.user_id FROM user_roles ur2 INNER JOIN roles r2 ON r2.id = ur2.role_id
                WHERE r2.slug = 'super_admin' AND ur2.is_active = 1
              ))
            ) AS sa_user_id
          FROM outlets o2
          WHERE o2.deleted_at IS NULL
        ) sa_resolve ON sa_resolve.id = o.id
        LEFT JOIN users u ON u.id = sa_resolve.sa_user_id AND u.deleted_at IS NULL
        WHERE sa_resolve.sa_user_id IS NOT NULL
      ) sa ON sa.outlet_id = o.id

      -- Subscription
      LEFT JOIN outlet_subscriptions os ON os.outlet_id = o.id

      -- Global pricing (always fetch latest active, not stale current_pricing_id)
      LEFT JOIN (
        SELECT id, base_price, gst_percentage, total_price
        FROM subscription_pricing
        WHERE is_active = 1
        ORDER BY effective_from DESC
        LIMIT 1
      ) sp ON 1=1

      -- Super admin pricing (linked to resolved SA)
      LEFT JOIN super_admin_pricing sap ON sap.user_id = sa.super_admin_id AND sap.is_active = 1

      -- Outlet pricing override
      LEFT JOIN outlet_pricing_override opo ON opo.outlet_id = o.id AND opo.is_active = 1

      -- Floor count
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS floor_count FROM floors GROUP BY outlet_id
      ) f ON f.outlet_id = o.id

      -- Table count (active)
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS table_count FROM tables WHERE is_active = 1 GROUP BY outlet_id
      ) t ON t.outlet_id = o.id

      -- Staff count (non-customer roles assigned)
      LEFT JOIN (
        SELECT ur.outlet_id, COUNT(DISTINCT ur.user_id) AS staff_count
        FROM user_roles ur
        INNER JOIN roles r ON r.id = ur.role_id
        WHERE r.slug IN ('admin', 'manager', 'pos_user', 'cashier', 'captain', 'waiter', 'chef', 'super_admin')
          AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
        GROUP BY ur.outlet_id
      ) staff ON staff.outlet_id = o.id

      -- QR generated count
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS qr_count
        FROM tables
        WHERE qr_code IS NOT NULL AND qr_code != '' AND is_active = 1
        GROUP BY outlet_id
      ) qr_tables ON qr_tables.outlet_id = o.id

      -- Total table count
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS total_table_count
        FROM tables
        WHERE is_active = 1
        GROUP BY outlet_id
      ) all_tables ON all_tables.outlet_id = o.id

      ${where}
      ORDER BY ${orderCol} ${orderDir}
      LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.query(dataQuery, [...params, parseInt(limit), parseInt(offset)]);

    // Post-process: nest objects
    const outlets = rows.map((row) => ({
      id: row.id,
      uuid: row.uuid,
      code: row.code,
      name: row.name,
      legalName: row.legal_name,
      outletType: row.outlet_type,
      address: {
        line1: row.address_line1,
        line2: row.address_line2,
        city: row.city,
        state: row.state,
        country: row.country,
        postalCode: row.postal_code,
      },
      contact: {
        phone: row.phone,
        email: row.email,
        gstin: row.gstin,
        fssaiNumber: row.fssai_number,
        panNumber: row.pan_number,
      },
      logoUrl: row.logo_url,
      currencyCode: row.currency_code,
      timezone: row.timezone,
      operatingHours: {
        openingTime: row.opening_time,
        closingTime: row.closing_time,
        is24Hours: !!row.is_24_hours,
      },
      settings: row.settings,
      isActive: !!row.is_active,
      createdBy: {
        id: row.created_by,
        name: row.creator_name,
        email: row.creator_email,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,

      superAdmin: row.super_admin_id ? {
        id: row.super_admin_id,
        name: row.super_admin_name,
        email: row.super_admin_email,
      } : null,

      subscription: row.subscription_status
        ? {
            status: row.subscription_status,
            startDate: row.subscription_start,
            endDate: row.subscription_end,
            gracePeriodEnd: row.grace_period_end,
            autoRenew: !!row.auto_renew,
            pricingSource: row.resolved_pricing_source || row.pricing_source || null,
            notes: row.subscription_notes,
          }
        : { status: 'no_subscription' },

      pricing: row.resolved_pricing_source
        ? {
            source: row.resolved_pricing_source,
            basePrice: row.resolved_base_price ? parseFloat(row.resolved_base_price) : null,
            gstPercentage: row.resolved_gst_percentage ? parseFloat(row.resolved_gst_percentage) : null,
            totalPrice: row.resolved_total_price ? parseFloat(row.resolved_total_price) : null,
          }
        : null,

      metrics: {
        floorCount: row.floor_count,
        tableCount: row.table_count,
        totalTableCount: row.total_table_count,
        staffCount: row.staff_count,
        qrGeneratedCount: row.qr_generated_count,
      },
    }));

    return {
      outlets,
      pagination: {
        page,
        limit,
        total: parseInt(total, 10),
        totalPages: Math.ceil(total / limit),
      },
    };
  },

  /**
   * Get outlet by ID
   */
  async getById(id) {
    const pool = getPool();
    const [outlets] = await pool.query(
      `SELECT o.* FROM outlets o WHERE o.id = ? AND o.deleted_at IS NULL`,
      [id]
    );
    return outlets[0] || null;
  },

  /**
   * Get outlet by ID with full details (subscription, super admin, pricing, metrics)
   */
  async getByIdWithDetails(id) {
    const pool = getPool();

    const [rows] = await pool.query(
      `SELECT
        o.id, o.uuid, o.code, o.name, o.legal_name, o.outlet_type,
        o.address_line1, o.address_line2, o.city, o.state, o.country, o.postal_code,
        o.phone, o.email, o.gstin, o.fssai_number, o.pan_number,
        o.logo_url, o.currency_code, o.timezone,
        o.opening_time, o.closing_time, o.is_24_hours,
        o.settings, o.is_active, o.created_by, o.created_at, o.updated_at,

        -- Creator
        COALESCE(creator.name, 'System') AS creator_name,
        creator.email AS creator_email,

        -- Super admin (resolved via user_roles first, then created_by fallback)
        sa.super_admin_id,
        sa.super_admin_name,
        sa.super_admin_email,

        -- Subscription
        os.status AS subscription_status,
        os.subscription_start,
        os.subscription_end,
        os.grace_period_end,
        os.auto_renew,
        os.pricing_source,
        os.notes AS subscription_notes,

        -- Resolved pricing (outlet_override > super_admin > global)
        COALESCE(opo.base_price, sap.base_price, sp.base_price) AS resolved_base_price,
        COALESCE(opo.gst_percentage, sap.gst_percentage, sp.gst_percentage) AS resolved_gst_percentage,
        COALESCE(opo.total_price, sap.total_price, sp.total_price) AS resolved_total_price,
        CASE
          WHEN opo.id IS NOT NULL THEN 'outlet'
          WHEN sap.id IS NOT NULL THEN 'super_admin'
          WHEN sp.id IS NOT NULL THEN 'global'
          ELSE NULL
        END AS resolved_pricing_source,

        -- Metrics
        COALESCE(f.floor_count, 0) AS floor_count,
        COALESCE(t.table_count, 0) AS table_count,
        COALESCE(staff.staff_count, 0) AS staff_count,
        COALESCE(qr_tables.qr_count, 0) AS qr_generated_count,
        COALESCE(all_tables.total_table_count, 0) AS total_table_count

      FROM outlets o

      -- Creator info
      LEFT JOIN users creator ON creator.id = o.created_by AND creator.deleted_at IS NULL

      -- Super admin resolver (single row per outlet)
      LEFT JOIN (
        SELECT DISTINCT
          o.id AS outlet_id,
          u.id AS super_admin_id,
          u.name AS super_admin_name,
          u.email AS super_admin_email
        FROM outlets o
        INNER JOIN (
          SELECT o2.id,
            COALESCE(
              (SELECT ur.user_id FROM user_roles ur
                INNER JOIN roles r ON r.id = ur.role_id
                WHERE ur.outlet_id = o2.id AND r.slug = 'super_admin' AND ur.is_active = 1
                ORDER BY ur.id LIMIT 1),
              (SELECT o2.created_by FROM outlets o2b WHERE o2b.id = o2.id AND o2b.created_by IN (
                SELECT ur2.user_id FROM user_roles ur2 INNER JOIN roles r2 ON r2.id = ur2.role_id
                WHERE r2.slug = 'super_admin' AND ur2.is_active = 1
              ))
            ) AS sa_user_id
          FROM outlets o2
          WHERE o2.deleted_at IS NULL
        ) sa_resolve ON sa_resolve.id = o.id
        LEFT JOIN users u ON u.id = sa_resolve.sa_user_id AND u.deleted_at IS NULL
        WHERE sa_resolve.sa_user_id IS NOT NULL
      ) sa ON sa.outlet_id = o.id

      -- Subscription
      LEFT JOIN outlet_subscriptions os ON os.outlet_id = o.id

      -- Global pricing (latest active)
      LEFT JOIN (
        SELECT id, base_price, gst_percentage, total_price
        FROM subscription_pricing
        WHERE is_active = 1
        ORDER BY effective_from DESC
        LIMIT 1
      ) sp ON 1=1

      -- Super admin pricing (linked to resolved SA)
      LEFT JOIN super_admin_pricing sap ON sap.user_id = sa.super_admin_id AND sap.is_active = 1

      -- Outlet pricing override
      LEFT JOIN outlet_pricing_override opo ON opo.outlet_id = o.id AND opo.is_active = 1

      -- Floor count
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS floor_count FROM floors GROUP BY outlet_id
      ) f ON f.outlet_id = o.id

      -- Table count (active)
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS table_count FROM tables WHERE is_active = 1 GROUP BY outlet_id
      ) t ON t.outlet_id = o.id

      -- Staff count
      LEFT JOIN (
        SELECT ur.outlet_id, COUNT(DISTINCT ur.user_id) AS staff_count
        FROM user_roles ur
        INNER JOIN roles r ON r.id = ur.role_id
        WHERE r.slug IN ('admin', 'manager', 'pos_user', 'cashier', 'captain', 'waiter', 'chef', 'super_admin')
          AND ur.is_active = 1 AND ur.outlet_id IS NOT NULL
        GROUP BY ur.outlet_id
      ) staff ON staff.outlet_id = o.id

      -- QR generated count
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS qr_count
        FROM tables
        WHERE qr_code IS NOT NULL AND qr_code != '' AND is_active = 1
        GROUP BY outlet_id
      ) qr_tables ON qr_tables.outlet_id = o.id

      -- Total table count
      LEFT JOIN (
        SELECT outlet_id, COUNT(*) AS total_table_count
        FROM tables
        WHERE is_active = 1
        GROUP BY outlet_id
      ) all_tables ON all_tables.outlet_id = o.id

      WHERE o.id = ? AND o.deleted_at IS NULL`,
      [id]
    );

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      uuid: row.uuid,
      code: row.code,
      name: row.name,
      legalName: row.legal_name,
      outletType: row.outlet_type,
      address: {
        line1: row.address_line1,
        line2: row.address_line2,
        city: row.city,
        state: row.state,
        country: row.country,
        postalCode: row.postal_code,
      },
      contact: {
        phone: row.phone,
        email: row.email,
        gstin: row.gstin,
        fssaiNumber: row.fssai_number,
        panNumber: row.pan_number,
      },
      logoUrl: row.logo_url,
      currencyCode: row.currency_code,
      timezone: row.timezone,
      operatingHours: {
        openingTime: row.opening_time,
        closingTime: row.closing_time,
        is24Hours: !!row.is_24_hours,
      },
      settings: row.settings,
      isActive: !!row.is_active,
      createdBy: {
        id: row.created_by,
        name: row.creator_name,
        email: row.creator_email,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,

      superAdmin: row.super_admin_id ? {
        id: row.super_admin_id,
        name: row.super_admin_name,
        email: row.super_admin_email,
      } : null,

      subscription: row.subscription_status
        ? {
            status: row.subscription_status,
            startDate: row.subscription_start,
            endDate: row.subscription_end,
            gracePeriodEnd: row.grace_period_end,
            autoRenew: !!row.auto_renew,
            pricingSource: row.resolved_pricing_source || row.pricing_source || null,
            notes: row.subscription_notes,
          }
        : { status: 'no_subscription' },

      pricing: row.resolved_pricing_source
        ? {
            source: row.resolved_pricing_source,
            basePrice: row.resolved_base_price ? parseFloat(row.resolved_base_price) : null,
            gstPercentage: row.resolved_gst_percentage ? parseFloat(row.resolved_gst_percentage) : null,
            totalPrice: row.resolved_total_price ? parseFloat(row.resolved_total_price) : null,
          }
        : null,

      metrics: {
        floorCount: row.floor_count,
        tableCount: row.table_count,
        totalTableCount: row.total_table_count,
        staffCount: row.staff_count,
        qrGeneratedCount: row.qr_generated_count,
      },
    };
  },

  /**
   * Get outlet by UUID
   */
  async getByUuid(uuid) {
    const pool = getPool();
    const [outlets] = await pool.query(
      `SELECT o.* FROM outlets o WHERE o.uuid = ? AND o.deleted_at IS NULL`,
      [uuid]
    );
    return outlets[0] || null;
  },

  /**
   * Update outlet
   */
  async update(id, data, userId) {
    const pool = getPool();
    
    const updates = [];
    const params = [];

    const allowedFields = [
      'name', 'legal_name', 'outlet_type', 'address_line1', 'address_line2',
      'city', 'state', 'country', 'postal_code', 'phone', 'email',
      'gstin', 'fssai_number', 'pan_number', 'opening_time', 'closing_time', 'is_24_hours',
      'currency_code', 'timezone', 'is_active', 'settings'
    ];

    const fieldMap = {
      legalName: 'legal_name',
      outletType: 'outlet_type',
      addressLine1: 'address_line1',
      addressLine2: 'address_line2',
      postalCode: 'postal_code',
      fssaiNumber: 'fssai_number',
      panNumber: 'pan_number',
      openingTime: 'opening_time',
      closingTime: 'closing_time',
      is24Hours: 'is_24_hours',
      currencyCode: 'currency_code',
      isActive: 'is_active'
    };

    Object.keys(data).forEach(key => {
      const dbField = fieldMap[key] || key;
      if (allowedFields.includes(dbField)) {
        updates.push(`${dbField} = ?`);
        params.push(key === 'settings' ? JSON.stringify(data[key]) : data[key]);
      }
    });

    if (updates.length === 0) return this.getById(id);

    updates.push('updated_by = ?');
    params.push(userId);
    params.push(id);

    await pool.query(
      `UPDATE outlets SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    await cache.del('outlets:all');
    await cache.del(`outlet:${id}`);
    return this.getById(id);
  },

  /**
   * Soft delete outlet
   */
  async delete(id, userId) {
    const pool = getPool();
    await pool.query(
      'UPDATE outlets SET deleted_at = NOW(), updated_by = ? WHERE id = ?',
      [userId, id]
    );
    await cache.del('outlets:all');
    await cache.del(`outlet:${id}`);
    return true;
  },

  /**
   * Generate unique outlet code
   */
  async generateCode(name) {
    const pool = getPool();
    const prefix = name.substring(0, 3).toUpperCase();
    const [rows] = await pool.query(
      'SELECT COUNT(*) as count FROM outlets WHERE code LIKE ?',
      [`${prefix}%`]
    );
    return `${prefix}${String(rows[0].count + 1).padStart(3, '0')}`;
  },

  /**
   * Get outlet with full details (floors, sections, tables)
   */
  async getFullDetails(id) {
    const pool = getPool();
    
    const outlet = await this.getById(id);
    if (!outlet) return null;

    // Get floors with tables
    const [floors] = await pool.query(
      `SELECT f.*, 
        (SELECT COUNT(*) FROM tables t WHERE t.floor_id = f.id AND t.is_active = 1) as table_count
       FROM floors f 
       WHERE f.outlet_id = ? AND f.is_active = 1 
       ORDER BY f.display_order, f.name`,
      [id]
    );

    // Get sections
    const [sections] = await pool.query(
      'SELECT * FROM sections WHERE outlet_id = ? AND is_active = 1 ORDER BY display_order, name',
      [id]
    );

    // Get table stats
    const [tableStats] = await pool.query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = 'occupied' THEN 1 ELSE 0 END) as occupied,
        SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) as reserved,
        SUM(CASE WHEN status = 'billing' THEN 1 ELSE 0 END) as billing,
        SUM(CASE WHEN status = 'cleaning' THEN 1 ELSE 0 END) as cleaning,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
       FROM tables WHERE outlet_id = ? AND is_active = 1`,
      [id]
    );

    return {
      ...outlet,
      floors,
      sections,
      tableStats: tableStats[0]
    };
  },

  /**
   * HARD DELETE outlet and ALL related data
   * WARNING: This permanently deletes all data - use with extreme caution
   * Only super_admin should have access to this function
   * 
   * @param {number} outletId - Outlet ID to delete
   * @param {string} confirmationCode - Must match outlet code for safety
   * @returns {object} Deletion summary with counts
   */
  async hardDelete(outletId, confirmationCode) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      // 1. Verify outlet exists and confirmation code matches
      const outlet = await this.getById(outletId);
      if (!outlet) {
        throw new Error(`Outlet ${outletId} not found`);
      }

      if (outlet.code !== confirmationCode) {
        throw new Error(`Confirmation code mismatch. Expected: ${outlet.code}`);
      }

      logger.warn(`HARD DELETE initiated for outlet ${outletId} (${outlet.name})`);

      await connection.beginTransaction();

      const deletionLog = {
        outletId,
        outletName: outlet.name,
        outletCode: outlet.code,
        deletedAt: new Date().toISOString(),
        tables: {}
      };

      // Tables to delete in order (child tables first, then parent tables)
      // Order matters for foreign key constraints
      const tablesToDelete = [
        // Level 1: Transaction/Log tables
        'activity_logs',
        'permission_logs',
        'error_logs',
        'notification_logs',
        'print_jobs',
        'duplicate_bill_logs',
        'bulk_upload_logs',
        
        // Level 2: User session/assignment tables
        'user_sessions',
        'user_stations',
        'user_floors',
        'user_sections',
        'user_menu_access',
        'user_permissions',
        
        // Level 3: KOT related
        'kot_tickets',
        
        // Level 4: Payment/Billing child tables
        'refunds',
        'payments',
        'invoices',
        
        // Level 5: Order related
        'orders',
        
        // Level 6: Cash management
        'cash_drawer',
        'day_sessions',
        
        // Level 7: Item related child tables (linking tables)
        'item_sales',
        
        // Level 8: Addon related
        'addon_groups',
        
        // Level 9: Items (has variants as child)
        'items',
        
        // Level 10: Categories
        'categories',
        
        // Level 11: Layout tables
        'tables',
        'sections',
        'floors',
        
        // Level 12: Kitchen/Printer infrastructure
        'kitchen_stations',
        'counters',
        'printers',
        'printer_bridges',
        'print_templates',
        
        // Level 13: Time/Schedule tables
        'time_slots',
        
        // Level 14: Inventory tables
        'stock',
        'stock_logs',
        'opening_stock',
        'closing_stock',
        'wastage_logs',
        'ingredients',
        'purchase_orders',
        'suppliers',
        
        // Level 15: Report/Summary tables
        'daily_sales',
        'hourly_sales',
        'item_sales',
        'category_sales',
        'staff_sales',
        'floor_section_sales',
        'payment_mode_summary',
        'tax_summary',
        'discount_summary',
        'cancellation_summary',
        'cash_summary',
        'top_selling_items',
        'inventory_consumption_summary',
        
        // Level 16: Config tables
        'tax_groups',
        'tax_rules',
        'price_rules',
        'discounts',
        'service_charges',
        'cancel_reasons',
        'system_settings',
        'notifications',
        'devices',
        'file_uploads',
        'table_reservations',
        'category_outlets',
        
        // Level 17: Customer related
        'customers',
        
        // Level 18: User roles (before users)
        'user_roles',
      ];

      // Delete from each table
      for (const tableName of tablesToDelete) {
        try {
          const [result] = await connection.query(
            `DELETE FROM ${tableName} WHERE outlet_id = ?`,
            [outletId]
          );
          deletionLog.tables[tableName] = result.affectedRows;
          if (result.affectedRows > 0) {
            logger.info(`Deleted ${result.affectedRows} rows from ${tableName}`);
          }
        } catch (err) {
          // Table might not exist or have different structure - continue
          if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') {
            logger.warn(`Error deleting from ${tableName}: ${err.message}`);
          }
          deletionLog.tables[tableName] = 0;
        }
      }

      // Finally delete the outlet itself
      const [outletResult] = await connection.query(
        'DELETE FROM outlets WHERE id = ?',
        [outletId]
      );
      deletionLog.tables['outlets'] = outletResult.affectedRows;

      await connection.commit();

      // Invalidate all caches for this outlet
      await cache.del(`outlet:${outletId}`);
      await cache.del(`categories:${outletId}:false`);
      await cache.del(`categories:${outletId}:true`);
      await cache.del(`items:${outletId}`);
      await cache.del(`addon_groups:${outletId}`);
      await cache.del(`kitchen_stations:${outletId}`);
      await cache.del(`counters:${outletId}`);

      logger.warn(`HARD DELETE completed for outlet ${outletId}. Summary:`, deletionLog);

      return {
        success: true,
        message: `Outlet "${outlet.name}" (${outlet.code}) and all related data permanently deleted`,
        summary: deletionLog
      };

    } catch (error) {
      await connection.rollback();
      logger.error(`HARD DELETE failed for outlet ${outletId}:`, error);
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Get deletion preview - shows what would be deleted without actually deleting
   * Use this to verify before hard delete
   */
  async getDeletePreview(outletId) {
    const pool = getPool();

    const outlet = await this.getById(outletId);
    if (!outlet) {
      throw new Error(`Outlet ${outletId} not found`);
    }

    const preview = {
      outlet: {
        id: outlet.id,
        code: outlet.code,
        name: outlet.name
      },
      tables: {}
    };

    // Tables to check
    const tablesToCheck = [
      'users', 'user_roles', 'categories', 'items', 'addon_groups',
      'floors', 'sections', 'tables', 'orders', 'payments', 'invoices',
      'kot_tickets', 'kitchen_stations', 'printers', 'customers',
      'cash_drawer', 'day_sessions', 'print_jobs', 'bulk_upload_logs'
    ];

    let totalRows = 0;
    for (const tableName of tablesToCheck) {
      try {
        const [result] = await pool.query(
          `SELECT COUNT(*) as count FROM ${tableName} WHERE outlet_id = ?`,
          [outletId]
        );
        preview.tables[tableName] = result[0].count;
        totalRows += result[0].count;
      } catch (err) {
        preview.tables[tableName] = 0;
      }
    }

    preview.totalRows = totalRows;
    preview.warning = `This will PERMANENTLY DELETE ${totalRows} rows across ${Object.keys(preview.tables).length} tables. This action CANNOT be undone.`;

    return preview;
  },

  // ========================
  // Print Logo Settings
  // ========================

  /**
   * Get print logo settings for an outlet
   */
  async getPrintLogoSettings(outletId) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, name, logo_url, print_logo_url, print_logo_enabled 
       FROM outlets WHERE id = ? AND deleted_at IS NULL`,
      [outletId]
    );
    
    if (!rows.length) return null;
    
    const outlet = rows[0];
    const baseUrl = appConfig.url;
    
    // Helper to add APP_URL prefix to relative paths
    const getFullUrl = (path) => {
      if (!path) return null;
      if (path.startsWith('http://') || path.startsWith('https://')) return path;
      return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    };
    
    return {
      outletId: outlet.id,
      outletName: outlet.name,
      logoUrl: getFullUrl(outlet.logo_url),
      printLogoUrl: getFullUrl(outlet.print_logo_url),
      printLogoEnabled: Boolean(outlet.print_logo_enabled)
    };
  },

  /**
   * Update print logo settings for an outlet
   */
  async updatePrintLogoSettings(outletId, data, userId) {
    const pool = getPool();
    
    // Verify outlet exists
    const [existing] = await pool.query(
      'SELECT id FROM outlets WHERE id = ? AND deleted_at IS NULL',
      [outletId]
    );
    if (!existing.length) return null;

    const updates = [];
    const params = [];

    if (data.printLogoEnabled !== undefined) {
      updates.push('print_logo_enabled = ?');
      params.push(data.printLogoEnabled ? 1 : 0);
    }

    if (data.printLogoUrl !== undefined) {
      updates.push('print_logo_url = ?');
      params.push(data.printLogoUrl);
    }

    if (updates.length > 0) {
      params.push(userId, outletId);
      
      await pool.query(
        `UPDATE outlets SET ${updates.join(', ')}, updated_by = ?, updated_at = NOW() WHERE id = ?`,
        params
      );
      
      logger.info(`Print logo settings updated for outlet ${outletId} by user ${userId}`);
    }

    return this.getPrintLogoSettings(outletId);
  },

  /**
   * Upload print logo image for an outlet
   */
  async uploadPrintLogo(outletId, file, userId) {
    const pool = getPool();
    
    // Verify outlet exists
    const [existing] = await pool.query(
      'SELECT id, code FROM outlets WHERE id = ? AND deleted_at IS NULL',
      [outletId]
    );
    if (!existing.length) return null;

    // Generate URL path for the uploaded file
    // File is already saved by multer, we just need to store the path
    const printLogoPath = `/uploads/logos/${file.filename}`;
    const baseUrl = appConfig.url;
    const printLogoUrl = `${baseUrl}${printLogoPath}`;

    await pool.query(
      `UPDATE outlets SET print_logo_url = ?, print_logo_enabled = 1, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [printLogoPath, userId, outletId]
    );

    logger.info(`Print logo uploaded for outlet ${outletId}: ${printLogoUrl}`);

    return {
      printLogoUrl,
      printLogoEnabled: true,
      filename: file.filename,
      originalName: file.originalname,
      size: file.size
    };
  },

  /**
   * Assign an unassigned outlet to a super_admin user.
   * After assignment:
   *   - master no longer sees the outlet (it has a user_roles entry)
   *   - the super_admin sees it in GET /api/v1/outlets
   */
  async assignToSuperAdmin(outletId, superAdminId, assignedBy) {
    const pool = getPool();

    // 1. Verify outlet exists and is active
    const [outlets] = await pool.query(
      `SELECT id, name FROM outlets WHERE id = ? AND deleted_at IS NULL AND is_active = 1`,
      [outletId]
    );
    if (outlets.length === 0) {
      throw new Error('Outlet not found or inactive');
    }

    // 2. Verify outlet is NOT already assigned to any super_admin
    const [existingSuperAdmin] = await pool.query(
      `SELECT ur.id, u.name
       FROM user_roles ur
       INNER JOIN roles r ON r.id = ur.role_id
       LEFT JOIN users u ON u.id = ur.user_id
       WHERE ur.outlet_id = ? AND r.slug = 'super_admin' AND ur.is_active = 1
       LIMIT 1`,
      [outletId]
    );
    if (existingSuperAdmin.length > 0) {
      throw new Error(`Outlet is already assigned to super admin: ${existingSuperAdmin[0].name}`);
    }

    // 3. Verify target user has super_admin role
    const [superAdminRoles] = await pool.query(
      `SELECT ur.role_id, r.name
       FROM user_roles ur
       INNER JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ? AND r.slug = 'super_admin' AND ur.is_active = 1
       LIMIT 1`,
      [superAdminId]
    );
    if (superAdminRoles.length === 0) {
      throw new Error('Target user is not a super admin');
    }

    const roleId = superAdminRoles[0].role_id;

    // 4. Check if this exact assignment already exists (inactive) and reactivate
    const [existingAssignment] = await pool.query(
      `SELECT id, is_active FROM user_roles
       WHERE user_id = ? AND role_id = ? AND outlet_id = ?`,
      [superAdminId, roleId, outletId]
    );

    if (existingAssignment.length > 0) {
      if (!existingAssignment[0].is_active) {
        await pool.query(
          `UPDATE user_roles SET is_active = 1, assigned_by = ? WHERE id = ?`,
          [assignedBy, existingAssignment[0].id]
        );
      }
    } else {
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id, outlet_id, assigned_by)
         VALUES (?, ?, ?, ?)`,
        [superAdminId, roleId, outletId, assignedBy]
      );
    }

    // 5. Invalidate caches
    await cache.del('outlets:all');
    await cache.del(`outlet:${outletId}`);

    logger.info(`Outlet ${outletId} assigned to super admin ${superAdminId} by ${assignedBy}`);

    return {
      success: true,
      message: 'Outlet assigned to super admin successfully',
      outletId,
      superAdminId,
    };
  }
};

module.exports = outletService;
