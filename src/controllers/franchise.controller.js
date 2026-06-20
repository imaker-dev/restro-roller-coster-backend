const { getPool } = require('../database');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const { prefixImageUrl } = require('../utils/helpers');

/* ───────── helpers ───────── */

const _ensureFranchiseTables = async (pool) => {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS franchises (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL UNIQUE,
        category VARCHAR(100) NOT NULL DEFAULT 'restaurant',
        description TEXT DEFAULT NULL,
        short_description VARCHAR(500) DEFAULT NULL,
        logo_url VARCHAR(500) DEFAULT NULL,
        cover_image_url VARCHAR(500) DEFAULT NULL,
        gallery_images JSON DEFAULT NULL,
        investment_min DECIMAL(15,2) DEFAULT NULL,
        investment_max DECIMAL(15,2) DEFAULT NULL,
        franchise_fee DECIMAL(15,2) DEFAULT NULL,
        working_capital DECIMAL(15,2) DEFAULT NULL,
        monthly_revenue DECIMAL(15,2) DEFAULT NULL,
        expected_roi DECIMAL(5,2) DEFAULT NULL,
        break_even_months INT DEFAULT NULL,
        outlets_live INT DEFAULT 0,
        established_year INT DEFAULT NULL,
        space_requirement VARCHAR(100) DEFAULT NULL,
        staff_required INT DEFAULT NULL,
        tags JSON DEFAULT NULL,
        support_offered JSON DEFAULT NULL,
        location_city VARCHAR(100) DEFAULT NULL,
        location_state VARCHAR(100) DEFAULT NULL,
        locations_available JSON DEFAULT NULL,
        contact_email VARCHAR(255) DEFAULT NULL,
        contact_phone VARCHAR(20) DEFAULT NULL,
        website VARCHAR(500) DEFAULT NULL,
        status ENUM('active','inactive','pending') NOT NULL DEFAULT 'pending',
        is_featured BOOLEAN NOT NULL DEFAULT FALSE,
        created_by INT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_category(category),
        INDEX idx_status(status),
        INDEX idx_is_featured(is_featured),
        INDEX idx_investment_min(investment_min),
        INDEX idx_investment_max(investment_max),
        INDEX idx_location_state(location_state),
        INDEX idx_location_city(location_city),
        INDEX idx_created_at(created_at),
        FULLTEXT INDEX idx_search(name,description,short_description,category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    logger.warn('[Franchise] franchises CREATE warning:', e.message);
  }

  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS franchise_enquiries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        franchise_id INT NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        email VARCHAR(255) NOT NULL,
        city VARCHAR(100) DEFAULT NULL,
        state VARCHAR(100) DEFAULT NULL,
        investment_budget VARCHAR(100) DEFAULT NULL,
        business_experience VARCHAR(100) DEFAULT NULL,
        message TEXT DEFAULT NULL,
        agree_to_contact BOOLEAN NOT NULL DEFAULT FALSE,
        status ENUM('new','contacted','converted','ignored') NOT NULL DEFAULT 'new',
        admin_notes TEXT DEFAULT NULL,
        ip_address VARCHAR(45) DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_franchise_id(franchise_id),
        INDEX idx_status(status),
        INDEX idx_email(email),
        INDEX idx_created_at(created_at),
        CONSTRAINT fk_enquiry_franchise FOREIGN KEY (franchise_id) REFERENCES franchises(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (e) {
    logger.warn('[Franchise] franchise_enquiries CREATE warning:', e.message);
  }
};

const _generateSlug = (name) => {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 60);
  return `${base}-${Date.now().toString(36).slice(-4)}`;
};

const _sanitizeFranchiseInput = (body) => ({
  name: body.name?.trim().substring(0, 255) || null,
  category: body.category?.trim().substring(0, 100) || 'restaurant',
  description: body.description?.trim().substring(0, 5000) || null,
  short_description: body.short_description?.trim().substring(0, 500) || null,
  logo_url: body.logo_url?.trim().substring(0, 500) || null,
  cover_image_url: body.cover_image_url?.trim().substring(0, 500) || null,
  gallery_images: Array.isArray(body.gallery_images) ? JSON.stringify(body.gallery_images.slice(0, 10)) : null,
  investment_min: body.investment_min != null ? parseFloat(body.investment_min) : null,
  investment_max: body.investment_max != null ? parseFloat(body.investment_max) : null,
  franchise_fee: body.franchise_fee != null ? parseFloat(body.franchise_fee) : null,
  working_capital: body.working_capital != null ? parseFloat(body.working_capital) : null,
  monthly_revenue: body.monthly_revenue != null ? parseFloat(body.monthly_revenue) : null,
  expected_roi: body.expected_roi != null ? parseFloat(body.expected_roi) : null,
  break_even_months: body.break_even_months != null ? parseInt(body.break_even_months, 10) : null,
  outlets_live: body.outlets_live != null ? parseInt(body.outlets_live, 10) : 0,
  established_year: body.established_year != null ? parseInt(body.established_year, 10) : null,
  space_requirement: body.space_requirement?.trim().substring(0, 100) || null,
  staff_required: body.staff_required != null ? parseInt(body.staff_required, 10) : null,
  tags: Array.isArray(body.tags) ? JSON.stringify(body.tags.slice(0, 10)) : null,
  support_offered: Array.isArray(body.support_offered) ? JSON.stringify(body.support_offered.slice(0, 20)) : null,
  location_city: body.location_city?.trim().substring(0, 100) || null,
  location_state: body.location_state?.trim().substring(0, 100) || null,
  locations_available: Array.isArray(body.locations_available) ? JSON.stringify(body.locations_available.slice(0, 50)) : null,
  contact_email: body.contact_email?.trim().toLowerCase().substring(0, 255) || null,
  contact_phone: body.contact_phone?.trim().substring(0, 20) || null,
  website: body.website?.trim().substring(0, 500) || null,
  is_featured: body.is_featured === true || body.is_featured === 'true' || body.is_featured === 1,
});

const _sanitizeFranchiseUpdateInput = (body) => {
  const data = {};
  if ('name' in body) data.name = body.name?.trim().substring(0, 255) || null;
  if ('category' in body) data.category = body.category?.trim().substring(0, 100) || null;
  if ('description' in body) data.description = body.description?.trim().substring(0, 5000) || null;
  if ('short_description' in body) data.short_description = body.short_description?.trim().substring(0, 500) || null;
  if ('logo_url' in body) data.logo_url = body.logo_url?.trim().substring(0, 500) || null;
  if ('cover_image_url' in body) data.cover_image_url = body.cover_image_url?.trim().substring(0, 500) || null;
  if ('gallery_images' in body) data.gallery_images = Array.isArray(body.gallery_images) ? JSON.stringify(body.gallery_images.slice(0, 10)) : null;
  if ('investment_min' in body) data.investment_min = body.investment_min != null ? parseFloat(body.investment_min) : null;
  if ('investment_max' in body) data.investment_max = body.investment_max != null ? parseFloat(body.investment_max) : null;
  if ('franchise_fee' in body) data.franchise_fee = body.franchise_fee != null ? parseFloat(body.franchise_fee) : null;
  if ('working_capital' in body) data.working_capital = body.working_capital != null ? parseFloat(body.working_capital) : null;
  if ('monthly_revenue' in body) data.monthly_revenue = body.monthly_revenue != null ? parseFloat(body.monthly_revenue) : null;
  if ('expected_roi' in body) data.expected_roi = body.expected_roi != null ? parseFloat(body.expected_roi) : null;
  if ('break_even_months' in body) data.break_even_months = body.break_even_months != null ? parseInt(body.break_even_months, 10) : null;
  if ('outlets_live' in body) data.outlets_live = body.outlets_live != null ? parseInt(body.outlets_live, 10) : null;
  if ('established_year' in body) data.established_year = body.established_year != null ? parseInt(body.established_year, 10) : null;
  if ('space_requirement' in body) data.space_requirement = body.space_requirement?.trim().substring(0, 100) || null;
  if ('staff_required' in body) data.staff_required = body.staff_required != null ? parseInt(body.staff_required, 10) : null;
  if ('tags' in body) data.tags = Array.isArray(body.tags) ? JSON.stringify(body.tags.slice(0, 10)) : null;
  if ('support_offered' in body) data.support_offered = Array.isArray(body.support_offered) ? JSON.stringify(body.support_offered.slice(0, 20)) : null;
  if ('location_city' in body) data.location_city = body.location_city?.trim().substring(0, 100) || null;
  if ('location_state' in body) data.location_state = body.location_state?.trim().substring(0, 100) || null;
  if ('locations_available' in body) data.locations_available = Array.isArray(body.locations_available) ? JSON.stringify(body.locations_available.slice(0, 50)) : null;
  if ('contact_email' in body) data.contact_email = body.contact_email?.trim().toLowerCase().substring(0, 255) || null;
  if ('contact_phone' in body) data.contact_phone = body.contact_phone?.trim().substring(0, 20) || null;
  if ('website' in body) data.website = body.website?.trim().substring(0, 500) || null;
  if ('is_featured' in body) data.is_featured = body.is_featured === true || body.is_featured === 'true' || body.is_featured === 1;
  if ('status' in body) data.status = ['active', 'inactive', 'pending'].includes(body.status) ? body.status : null;
  return data;
};

const _validateRequired = (data) => {
  const missing = [];
  if (!data.name) missing.push('name');
  if (!data.category) missing.push('category');
  return missing;
};

const _parseJsonCols = (row) => {
  if (!row) return row;
  ['tags', 'support_offered', 'gallery_images', 'locations_available'].forEach((k) => {
    if (row[k] && typeof row[k] === 'string') {
      try { row[k] = JSON.parse(row[k]); } catch (e) { row[k] = null; }
    }
  });
  return row;
};

const _prefixImageUrls = (row) => {
  if (!row) return row;
  row.logo_url = prefixImageUrl(row.logo_url);
  row.cover_image_url = prefixImageUrl(row.cover_image_url);
  if (Array.isArray(row.gallery_images)) {
    row.gallery_images = row.gallery_images.map(prefixImageUrl).filter(Boolean);
  }
  return row;
};

/* ───────── PUBLIC ───────── */

const listFranchises = async (req, res) => {
  try {
    const {
      search,
      category,
      state,
      city,
      min_investment,
      max_investment,
      min_roi,
      featured,
      sort = 'featured',
      page = 1,
      limit = 12,
    } = req.query;

    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
    const offset = (pageNum - 1) * pageSize;

    const conditions = ['status = ?'];
    const params = ['active'];

    if (search?.trim()) {
      conditions.push('(name LIKE ? OR category LIKE ? OR location_city LIKE ? OR location_state LIKE ?)');
      const like = `%${search.trim()}%`;
      params.push(like, like, like, like);
    }
    if (category?.trim()) {
      conditions.push('category = ?');
      params.push(category.trim());
    }
    if (state?.trim()) {
      conditions.push('(location_state = ? OR JSON_CONTAINS(locations_available, JSON_QUOTE(?)))');
      params.push(state.trim(), state.trim());
    }
    if (city?.trim()) {
      conditions.push('(location_city = ? OR JSON_CONTAINS(locations_available, JSON_QUOTE(?)))');
      params.push(city.trim(), city.trim());
    }
    if (min_investment != null && !isNaN(min_investment)) {
      conditions.push('(investment_min >= ? OR investment_max >= ?)');
      params.push(parseFloat(min_investment), parseFloat(min_investment));
    }
    if (max_investment != null && !isNaN(max_investment)) {
      conditions.push('(investment_min <= ? OR investment_max <= ?)');
      params.push(parseFloat(max_investment), parseFloat(max_investment));
    }
    if (min_roi != null && !isNaN(min_roi)) {
      conditions.push('expected_roi >= ?');
      params.push(parseFloat(min_roi));
    }
    if (featured === 'true' || featured === '1') {
      conditions.push('is_featured = TRUE');
    }

    const where = conditions.join(' AND ');

    let orderBy;
    switch (sort) {
      case 'newest': orderBy = 'created_at DESC'; break;
      case 'oldest': orderBy = 'created_at ASC'; break;
      case 'investment_asc': orderBy = 'investment_min ASC'; break;
      case 'investment_desc': orderBy = 'investment_max DESC'; break;
      case 'roi': orderBy = 'expected_roi DESC'; break;
      default: orderBy = 'is_featured DESC, created_at DESC'; break;
    }

    const countSql = `SELECT COUNT(*) AS total FROM franchises WHERE ${where}`;
    const dataSql = `
      SELECT id, name, slug, category, short_description, logo_url, cover_image_url,
             investment_min, investment_max, expected_roi, break_even_months,
             outlets_live, established_year, tags, location_city, location_state, is_featured,
             created_at
      FROM franchises
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const [[[countRows]], [dataRows], [catRows], [stateRows], [cityRows], [rangeRows]] = await Promise.all([
      pool.query(countSql, params),
      pool.query(dataSql, [...params, pageSize, offset]),
      pool.query(`SELECT DISTINCT category FROM franchises WHERE status = 'active' ORDER BY category`),
      pool.query(`SELECT DISTINCT location_state AS state FROM franchises WHERE status = 'active' AND location_state IS NOT NULL ORDER BY location_state`),
      pool.query(`SELECT DISTINCT location_city AS city FROM franchises WHERE status = 'active' AND location_city IS NOT NULL ORDER BY location_city`),
      pool.query(`SELECT MIN(investment_min) AS min_inv, MAX(investment_max) AS max_inv, COUNT(*) AS total_active, SUM(is_featured) AS featured_count FROM franchises WHERE status = 'active'`),
    ]);

    const total = countRows[0]?.total || 0;
    const range = rangeRows[0] || {};

    return res.json({
      success: true,
      data: {
        franchises: dataRows.map((r) => _prefixImageUrls(_parseJsonCols(r))),
        app_url: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/g, ''),
        pagination: { total, page: pageNum, limit: pageSize, pages: Math.ceil(total / pageSize) },
        filters: {
          categories: catRows.map((r) => r.category),
          states: stateRows.map((r) => r.state).filter(Boolean),
          cities: cityRows.map((r) => r.city).filter(Boolean),
          investment_ranges: [
            { label: 'Under \u20B95L', min: 0, max: 500000 },
            { label: '\u20B95L – \u20B915L', min: 500000, max: 1500000 },
            { label: '\u20B915L – \u20B930L', min: 1500000, max: 3000000 },
            { label: '\u20B930L – \u20B950L', min: 3000000, max: 5000000 },
            { label: '\u20B950L+', min: 5000000, max: null },
          ],
          sort_options: [
            { value: 'featured', label: 'Featured' },
            { value: 'newest', label: 'Newest First' },
            { value: 'oldest', label: 'Oldest First' },
            { value: 'investment_asc', label: 'Investment: Low to High' },
            { value: 'investment_desc', label: 'Investment: High to Low' },
            { value: 'roi', label: 'Highest ROI' },
          ],
          stats: {
            total_active: parseInt(range.total_active || 0, 10),
            featured_count: parseInt(range.featured_count || 0, 10),
            min_investment: range.min_inv ? parseFloat(range.min_inv) : null,
            max_investment: range.max_inv ? parseFloat(range.max_inv) : null,
          },
        },
      },
    });
  } catch (err) {
    logger.error('[Franchise] listFranchises error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch franchises.' });
  }
};

const getFranchiseBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug?.trim()) {
      return res.status(400).json({ success: false, message: 'Slug is required.' });
    }

    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const [rows] = await pool.execute(
      `SELECT id, name, slug, category, description, short_description,
              logo_url, cover_image_url, gallery_images,
              investment_min, investment_max, franchise_fee, working_capital, monthly_revenue,
              expected_roi, break_even_months, outlets_live, established_year,
              space_requirement, staff_required,
              tags, support_offered,
              location_city, location_state, locations_available,
              contact_email, contact_phone, website,
              is_featured, created_at
       FROM franchises
       WHERE slug = ? AND status = ?
       LIMIT 1`,
      [slug.trim(), 'active']
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Franchise not found.' });
    }

    return res.json({
      success: true,
      data: _prefixImageUrls(_parseJsonCols(rows[0])),
      app_url: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/g, ''),
    });
  } catch (err) {
    logger.error('[Franchise] getFranchiseBySlug error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch franchise details.' });
  }
};

const getFranchiseById = async (req, res) => {
  try {
    const { id } = req.params;
    const franchiseId = parseInt(id, 10);
    if (!franchiseId || isNaN(franchiseId)) {
      return res.status(400).json({ success: false, message: 'Valid franchise ID is required.' });
    }

    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const [rows] = await pool.execute(
      `SELECT id, name, slug, category, description, short_description,
              logo_url, cover_image_url, gallery_images,
              investment_min, investment_max, franchise_fee, working_capital, monthly_revenue,
              expected_roi, break_even_months, outlets_live, established_year,
              space_requirement, staff_required,
              tags, support_offered,
              location_city, location_state, locations_available,
              contact_email, contact_phone, website,
              is_featured, created_at
       FROM franchises
       WHERE id = ? AND status = ?
       LIMIT 1`,
      [franchiseId, 'active']
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Franchise not found.' });
    }

    return res.json({
      success: true,
      data: _prefixImageUrls(_parseJsonCols(rows[0])),
      app_url: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/g, ''),
    });
  } catch (err) {
    logger.error('[Franchise] getFranchiseById error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch franchise details.' });
  }
};

const adminGetFranchiseById = async (req, res) => {
  try {
    const { id } = req.params;
    const franchiseId = parseInt(id, 10);
    if (!franchiseId || isNaN(franchiseId)) {
      return res.status(400).json({ success: false, message: 'Valid franchise ID is required.' });
    }

    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const [rows] = await pool.execute(
      `SELECT id, name, slug, category, description, short_description,
              logo_url, cover_image_url, gallery_images,
              investment_min, investment_max, franchise_fee, working_capital, monthly_revenue,
              expected_roi, break_even_months, outlets_live, established_year,
              space_requirement, staff_required,
              tags, support_offered,
              location_city, location_state, locations_available,
              contact_email, contact_phone, website,
              status, is_featured, created_by, created_at, updated_at
       FROM franchises
       WHERE id = ?
       LIMIT 1`,
      [franchiseId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Franchise not found.' });
    }

    return res.json({
      success: true,
      data: _prefixImageUrls(_parseJsonCols(rows[0])),
      app_url: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/g, ''),
    });
  } catch (err) {
    logger.error('[Franchise] adminGetFranchiseById error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch franchise details.' });
  }
};

const getFilterOptions = async (req, res) => {
  try {
    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const [categoryRows] = await pool.query(
      `SELECT DISTINCT category FROM franchises WHERE status = 'active' ORDER BY category`
    );
    const [stateRows] = await pool.query(
      `SELECT DISTINCT location_state AS state FROM franchises WHERE status = 'active' AND location_state IS NOT NULL ORDER BY location_state`
    );
    const [cityRows] = await pool.query(
      `SELECT DISTINCT location_city AS city FROM franchises WHERE status = 'active' AND location_city IS NOT NULL ORDER BY location_city`
    );

    const categories = categoryRows.map((r) => r.category);
    const states = stateRows.map((r) => r.state).filter(Boolean);
    const cities = cityRows.map((r) => r.city).filter(Boolean);

    return res.json({
      success: true,
      data: { categories, states, cities, investment_ranges: [
        { label: 'Under ₹5L', min: 0, max: 500000 },
        { label: '₹5L – ₹15L', min: 500000, max: 1500000 },
        { label: '₹15L – ₹30L', min: 1500000, max: 3000000 },
        { label: '₹30L – ₹50L', min: 3000000, max: 5000000 },
        { label: '₹50L+', min: 5000000, max: null },
      ],
      app_url: (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/g, '') },
    });
  } catch (err) {
    logger.error('[Franchise] getFilterOptions error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch filter options.' });
  }
};

const submitEnquiry = async (req, res) => {
  try {
    const { franchise_id, full_name, phone, email, city, state, investment_budget, business_experience, message, agree_to_contact } = req.body;

    const missing = [];
    if (!franchise_id) missing.push('franchise_id');
    if (!full_name?.trim()) missing.push('full_name');
    if (!phone?.trim()) missing.push('phone');
    if (!email?.trim()) missing.push('email');
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Invalid email address.' });
    }

    if (!agree_to_contact) {
      return res.status(400).json({ success: false, message: 'You must agree to be contacted.' });
    }

    const pool = getPool();
    await _ensureFranchiseTables(pool);

    // Verify franchise exists and is active
    const [franchiseRows] = await pool.execute(
      'SELECT id, name, contact_email FROM franchises WHERE id = ? AND status = ? LIMIT 1',
      [parseInt(franchise_id, 10), 'active']
    );
    if (franchiseRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Franchise not found or not active.' });
    }
    const franchise = franchiseRows[0];

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null;

    const [result] = await pool.execute(
      `INSERT INTO franchise_enquiries
        (franchise_id, full_name, phone, email, city, state, investment_budget, business_experience, message, agree_to_contact, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parseInt(franchise_id, 10),
        full_name.trim().substring(0, 255),
        phone.trim().substring(0, 20),
        email.trim().toLowerCase().substring(0, 255),
        city?.trim()?.substring(0, 100) || null,
        state?.trim()?.substring(0, 100) || null,
        investment_budget?.trim()?.substring(0, 100) || null,
        business_experience?.trim()?.substring(0, 100) || null,
        message?.trim()?.substring(0, 2000) || null,
        !!agree_to_contact,
        ip,
      ]
    );

    logger.info(`[Franchise] New enquiry #${result.insertId} for franchise #${franchise_id} (${franchise.name}) from ${email.trim()}`);

    // Fire-and-forget notification email
    try {
      const emailService = require('../services/email.service');
      const enquiryData = {
        franchiseName: franchise.name,
        fullName: full_name.trim(),
        phone: phone.trim(),
        email: email.trim().toLowerCase(),
        city: city?.trim() || '—',
        state: state?.trim() || '—',
        investmentBudget: investment_budget?.trim() || '—',
        businessExperience: business_experience?.trim() || '—',
        message: message?.trim() || '—',
      };
      if (franchise.contact_email) {
        await emailService.sendFranchiseEnquiryEmail(franchise.contact_email, enquiryData);
      }
    } catch (mailErr) {
      logger.warn('[Franchise] Enquiry notification email failed:', mailErr.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Enquiry submitted successfully. We will contact you soon.',
      data: { id: result.insertId },
    });
  } catch (err) {
    logger.error('[Franchise] submitEnquiry error:', err);
    return res.status(500).json({ success: false, message: 'Failed to submit enquiry.' });
  }
};

/* ───────── ADMIN ───────── */

const createFranchise = async (req, res) => {
  try {
    const data = _sanitizeFranchiseInput(req.body);
    const missing = _validateRequired(data);
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });
    }

    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const slug = req.body.slug?.trim() || _generateSlug(data.name);

    // Check slug uniqueness
    const [existing] = await pool.execute('SELECT id FROM franchises WHERE slug = ? LIMIT 1', [slug]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'A franchise with this slug already exists.' });
    }

    const cols = Object.keys(data).filter((k) => data[k] !== null || ['is_featured'].includes(k));
    const placeholders = cols.map(() => '?').join(', ');
    const values = cols.map((k) => data[k]);

    const [result] = await pool.execute(
      `INSERT INTO franchises (slug, ${cols.join(', ')}, created_by) VALUES (?, ${placeholders}, ?)`,
      [slug, ...values, req.user?.userId || null]
    );

    logger.info(`[Franchise] Created franchise #${result.insertId} — ${data.name} by user #${req.user?.userId}`);

    return res.status(201).json({
      success: true,
      message: 'Franchise created successfully.',
      data: { id: result.insertId, slug },
    });
  } catch (err) {
    logger.error('[Franchise] createFranchise error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create franchise: ' + err.message });
  }
};

const updateFranchise = async (req, res) => {
  try {
    const { id } = req.params;
    const franchiseId = parseInt(id, 10);
    if (!franchiseId || isNaN(franchiseId)) {
      return res.status(400).json({ success: false, message: 'Valid franchise ID is required.' });
    }

    const data = _sanitizeFranchiseUpdateInput(req.body);
    const cols = Object.keys(data).filter((k) => data[k] !== null);
    if (cols.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update.' });
    }

    const setClause = cols.map((k) => `${k} = ?`).join(', ');
    const values = cols.map((k) => data[k]);

    const pool = getPool();
    await _ensureFranchiseTables(pool);

    // If slug is being updated, check uniqueness
    if (req.body.slug?.trim()) {
      const [dup] = await pool.execute('SELECT id FROM franchises WHERE slug = ? AND id != ? LIMIT 1', [
        req.body.slug.trim(),
        franchiseId,
      ]);
      if (dup.length > 0) {
        return res.status(409).json({ success: false, message: 'A franchise with this slug already exists.' });
      }
      values.push(req.body.slug.trim());
    }

    const [result] = await pool.execute(
      `UPDATE franchises SET ${setClause}${req.body.slug?.trim() ? ', slug = ?' : ''} WHERE id = ?`,
      [...values, franchiseId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Franchise not found.' });
    }

    logger.info(`[Franchise] Updated franchise #${franchiseId} by user #${req.user?.userId}`);
    return res.json({ success: true, message: 'Franchise updated successfully.' });
  } catch (err) {
    logger.error('[Franchise] updateFranchise error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update franchise: ' + err.message });
  }
};

const deleteFranchise = async (req, res) => {
  try {
    const { id } = req.params;
    const franchiseId = parseInt(id, 10);
    if (!franchiseId || isNaN(franchiseId)) {
      return res.status(400).json({ success: false, message: 'Valid franchise ID is required.' });
    }

    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const [result] = await pool.execute('UPDATE franchises SET status = ? WHERE id = ?', ['inactive', franchiseId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Franchise not found.' });
    }

    logger.info(`[Franchise] Soft-deleted franchise #${franchiseId} by user #${req.user?.userId}`);
    return res.json({ success: true, message: 'Franchise removed successfully.' });
  } catch (err) {
    logger.error('[Franchise] deleteFranchise error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete franchise.' });
  }
};

const adminListFranchises = async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, parseInt(limit, 10) || 20);
    const offset = (pageNum - 1) * pageSize;

    const conditions = ['1=1'];
    const params = [];

    if (status && ['active', 'inactive', 'pending'].includes(status)) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (search?.trim()) {
      conditions.push('(name LIKE ? OR category LIKE ? OR location_city LIKE ? OR location_state LIKE ?)');
      const like = `%${search.trim()}%`;
      params.push(like, like, like, like);
    }

    const where = conditions.join(' AND ');
    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const [[countRows], [dataRows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM franchises WHERE ${where}`, params),
      pool.query(
        `SELECT id, name, slug, category, status, is_featured, contact_email, contact_phone,
                investment_min, investment_max, outlets_live, location_city, location_state, created_at
         FROM franchises WHERE ${where}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      ),
    ]);

    const total = countRows[0]?.total || 0;

    return res.json({
      success: true,
      data: {
        franchises: dataRows,
        pagination: { total, page: pageNum, limit: pageSize, pages: Math.ceil(total / pageSize) },
      },
    });
  } catch (err) {
    logger.error('[Franchise] adminListFranchises error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch franchises.' });
  }
};

const adminListEnquiries = async (req, res) => {
  try {
    const { status, franchise_id, search, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, parseInt(limit, 10) || 20);
    const offset = (pageNum - 1) * pageSize;

    const conditions = ['1=1'];
    const params = [];

    if (status && ['new', 'contacted', 'converted', 'ignored'].includes(status)) {
      conditions.push('e.status = ?');
      params.push(status);
    }
    if (franchise_id && !isNaN(parseInt(franchise_id, 10))) {
      conditions.push('e.franchise_id = ?');
      params.push(parseInt(franchise_id, 10));
    }
    if (search?.trim()) {
      conditions.push('(e.full_name LIKE ? OR e.email LIKE ? OR e.phone LIKE ?)');
      const like = `%${search.trim()}%`;
      params.push(like, like, like);
    }

    const where = conditions.join(' AND ');
    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const [[countRows], [dataRows]] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total FROM franchise_enquiries e WHERE ${where}`,
        params
      ),
      pool.query(
        `SELECT e.*, f.name AS franchise_name, f.slug AS franchise_slug
         FROM franchise_enquiries e
         JOIN franchises f ON f.id = e.franchise_id
         WHERE ${where}
         ORDER BY e.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      ),
    ]);

    const total = countRows[0]?.total || 0;

    return res.json({
      success: true,
      data: {
        enquiries: dataRows,
        pagination: { total, page: pageNum, limit: pageSize, pages: Math.ceil(total / pageSize) },
      },
    });
  } catch (err) {
    logger.error('[Franchise] adminListEnquiries error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch enquiries.' });
  }
};

const updateEnquiryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const enquiryId = parseInt(id, 10);
    const { status, admin_notes } = req.body;

    if (!enquiryId || isNaN(enquiryId)) {
      return res.status(400).json({ success: false, message: 'Valid enquiry ID is required.' });
    }
    if (!status || !['new', 'contacted', 'converted', 'ignored'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be one of: new, contacted, converted, ignored' });
    }

    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const [result] = await pool.execute(
      'UPDATE franchise_enquiries SET status = ?, admin_notes = ? WHERE id = ?',
      [status, admin_notes?.trim()?.substring(0, 2000) || null, enquiryId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Enquiry not found.' });
    }

    logger.info(`[Franchise] Enquiry #${enquiryId} marked as ${status} by user #${req.user?.userId}`);
    return res.json({ success: true, message: `Enquiry status updated to ${status}.` });
  } catch (err) {
    logger.error('[Franchise] updateEnquiryStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update enquiry status.' });
  }
};

const getFranchiseStats = async (req, res) => {
  try {
    const pool = getPool();
    await _ensureFranchiseTables(pool);

    const [[franchiseStats]] = await pool.query(`
      SELECT
        SUM(status = 'active') AS active,
        SUM(status = 'pending') AS pending,
        SUM(status = 'inactive') AS inactive,
        SUM(is_featured = TRUE) AS featured,
        COUNT(*) AS total
      FROM franchises
    `);

    const [[enquiryStats]] = await pool.query(`
      SELECT
        SUM(status = 'new') AS new_count,
        SUM(status = 'contacted') AS contacted,
        SUM(status = 'converted') AS converted,
        SUM(status = 'ignored') AS ignored,
        COUNT(*) AS total
      FROM franchise_enquiries
    `);

    return res.json({
      success: true,
      data: { franchises: franchiseStats, enquiries: enquiryStats },
    });
  } catch (err) {
    logger.error('[Franchise] getFranchiseStats error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
};

module.exports = {
  listFranchises,
  getFranchiseBySlug,
  getFranchiseById,
  adminGetFranchiseById,
  getFilterOptions,
  submitEnquiry,
  createFranchise,
  updateFranchise,
  deleteFranchise,
  adminListFranchises,
  adminListEnquiries,
  updateEnquiryStatus,
  getFranchiseStats,
};
