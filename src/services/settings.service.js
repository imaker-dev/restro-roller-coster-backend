const { getPool } = require('../database');
const logger = require('../utils/logger');

/**
 * Settings Service
 * Manages all application settings for admin/super_admin
 */
class SettingsService {
  
  // Setting categories for organized management
  static CATEGORIES = {
    GENERAL: 'general',
    BILLING: 'billing',
    TAX: 'tax',
    PRINTING: 'printing',
    INVENTORY: 'inventory',
    ORDER: 'order',
    NOTIFICATION: 'notification',
    DISPLAY: 'display',
    SELF_ORDER: 'self_order'
  };

  // Default settings with categories
  static DEFAULT_SETTINGS = [
    // General Settings
    { key: 'currency_symbol', value: '₹', type: 'string', category: 'general', description: 'Currency symbol' },
    { key: 'currency_code', value: 'INR', type: 'string', category: 'general', description: 'Currency code (ISO 4217)' },
    { key: 'decimal_places', value: '2', type: 'number', category: 'general', description: 'Decimal places for amounts' },
    { key: 'date_format', value: 'DD/MM/YYYY', type: 'string', category: 'general', description: 'Date format' },
    { key: 'time_format', value: 'HH:mm', type: 'string', category: 'general', description: 'Time format (12h/24h)' },
    { key: 'timezone', value: 'Asia/Kolkata', type: 'string', category: 'general', description: 'Default timezone' },
    
    // Billing Settings
    { key: 'round_off_enabled', value: 'true', type: 'boolean', category: 'billing', description: 'Enable bill round off' },
    { key: 'round_off_to', value: '1', type: 'number', category: 'billing', description: 'Round off to nearest value (1, 5, 10)' },
    { key: 'invoice_prefix', value: 'INV', type: 'string', category: 'billing', description: 'Invoice number prefix' },
    { key: 'invoice_start_number', value: '1', type: 'number', category: 'billing', description: 'Invoice starting number' },
    { key: 'show_item_tax_on_bill', value: 'false', type: 'boolean', category: 'billing', description: 'Show individual item tax on bill' },
    { key: 'show_hsn_on_bill', value: 'true', type: 'boolean', category: 'billing', description: 'Show HSN/SAC code on bill' },
    { key: 'bill_footer_text', value: 'Thank you for visiting!', type: 'string', category: 'billing', description: 'Footer text on bills' },
    { key: 'terms_and_conditions', value: '', type: 'string', category: 'billing', description: 'Terms and conditions on invoice' },
    
    // Tax Settings
    { key: 'gst_enabled', value: 'true', type: 'boolean', category: 'tax', description: 'Enable GST' },
    { key: 'default_cgst_rate', value: '2.5', type: 'number', category: 'tax', description: 'Default CGST rate (%)' },
    { key: 'default_sgst_rate', value: '2.5', type: 'number', category: 'tax', description: 'Default SGST rate (%)' },
    { key: 'default_igst_rate', value: '5', type: 'number', category: 'tax', description: 'Default IGST rate (%)' },
    { key: 'vat_enabled', value: 'false', type: 'boolean', category: 'tax', description: 'Enable VAT' },
    { key: 'default_vat_rate', value: '5', type: 'number', category: 'tax', description: 'Default VAT rate (%)' },
    { key: 'cess_enabled', value: 'false', type: 'boolean', category: 'tax', description: 'Enable CESS' },
    { key: 'default_cess_rate', value: '0', type: 'number', category: 'tax', description: 'Default CESS rate (%)' },
    { key: 'tax_inclusive_pricing', value: 'false', type: 'boolean', category: 'tax', description: 'Prices include tax' },
    
    // Discount Security
    { key: 'discount_security_key', value: '000000', type: 'string', category: 'billing', description: 'Security key required to apply manual discounts at POS (default: 000000)' },

    // Service Charge Settings
    { key: 'service_charge_enabled', value: 'false', type: 'boolean', category: 'billing', description: 'Enable service charge' },
    { key: 'service_charge_percent', value: '10', type: 'number', category: 'billing', description: 'Service charge percentage' },
    { key: 'service_charge_on_takeaway', value: 'false', type: 'boolean', category: 'billing', description: 'Apply SC on takeaway orders' },
    { key: 'service_charge_on_delivery', value: 'false', type: 'boolean', category: 'billing', description: 'Apply SC on delivery orders' },
    
    // Printing Settings
    { key: 'kot_auto_print', value: 'true', type: 'boolean', category: 'printing', description: 'Auto print KOT on order' },
    { key: 'bill_auto_print', value: 'false', type: 'boolean', category: 'printing', description: 'Auto print bill on generate' },
    { key: 'print_customer_copy', value: 'true', type: 'boolean', category: 'printing', description: 'Print customer copy' },
    { key: 'print_merchant_copy', value: 'false', type: 'boolean', category: 'printing', description: 'Print merchant copy' },
    { key: 'kot_print_copies', value: '1', type: 'number', category: 'printing', description: 'Number of KOT copies' },
    { key: 'bill_print_copies', value: '1', type: 'number', category: 'printing', description: 'Number of bill copies' },
    { key: 'print_logo_on_bill', value: 'false', type: 'boolean', category: 'printing', description: 'Print logo on bills and invoices' },
    
    // Inventory Settings
    { key: 'allow_negative_stock', value: 'false', type: 'boolean', category: 'inventory', description: 'Allow negative stock' },
    { key: 'low_stock_alert_enabled', value: 'true', type: 'boolean', category: 'inventory', description: 'Enable low stock alerts' },
    { key: 'low_stock_threshold', value: '10', type: 'number', category: 'inventory', description: 'Default low stock threshold' },
    { key: 'auto_deduct_stock', value: 'true', type: 'boolean', category: 'inventory', description: 'Auto deduct stock on order' },
    { key: 'cancel_reversal_window_minutes', value: '5', type: 'number', category: 'inventory', description: 'Minutes after item creation within which cancel reverses stock (after = wastage)' },
    { key: 'cancel_stock_action_mode', value: 'auto', type: 'string', category: 'inventory', description: 'How to decide stock action on cancel: auto (system decides) or ask (user chooses)' },
    
    // Order Settings
    { key: 'require_customer_for_order', value: 'false', type: 'boolean', category: 'order', description: 'Require customer details for orders' },
    { key: 'allow_order_edit_after_kot', value: 'true', type: 'boolean', category: 'order', description: 'Allow editing order after KOT' },
    { key: 'allow_order_cancel', value: 'true', type: 'boolean', category: 'order', description: 'Allow order cancellation' },
    { key: 'cancel_reason_required', value: 'true', type: 'boolean', category: 'order', description: 'Require reason for cancellation' },
    { key: 'default_order_type', value: 'dine_in', type: 'string', category: 'order', description: 'Default order type' },
    { key: 'order_number_prefix', value: 'ORD', type: 'string', category: 'order', description: 'Order number prefix' },
    { key: 'order_number_reset_daily', value: 'true', type: 'boolean', category: 'order', description: 'Reset order number daily' },
    { key: 'modification_password', value: '000000', type: 'string', category: 'order', description: 'Password required for cashier to modify a billed order' },
    
    // Notification Settings
    { key: 'email_notifications_enabled', value: 'false', type: 'boolean', category: 'notification', description: 'Enable email notifications' },
    { key: 'sms_notifications_enabled', value: 'false', type: 'boolean', category: 'notification', description: 'Enable SMS notifications' },
    { key: 'push_notifications_enabled', value: 'true', type: 'boolean', category: 'notification', description: 'Enable push notifications' },
    { key: 'notify_on_low_stock', value: 'true', type: 'boolean', category: 'notification', description: 'Notify on low stock' },
    { key: 'notify_on_new_order', value: 'true', type: 'boolean', category: 'notification', description: 'Notify on new order' },
    
    // Display Settings
    { key: 'show_item_images', value: 'true', type: 'boolean', category: 'display', description: 'Show item images in menu' },
    { key: 'show_item_description', value: 'true', type: 'boolean', category: 'display', description: 'Show item descriptions' },
    { key: 'menu_layout', value: 'grid', type: 'string', category: 'display', description: 'Menu layout (grid/list)' },
    { key: 'items_per_page', value: '20', type: 'number', category: 'display', description: 'Items per page in lists' },
    { key: 'theme_mode', value: 'light', type: 'string', category: 'display', description: 'Theme mode (light/dark)' },
    { key: 'primary_color', value: '#1976d2', type: 'string', category: 'display', description: 'Primary theme color' },
    
    // Display Options (Configurable toggles)
    { key: 'display_option_1', value: 'false', type: 'boolean', category: 'display', description: 'Display option 1' },
    { key: 'display_option_2', value: 'false', type: 'boolean', category: 'display', description: 'Display option 2' },
    { key: 'display_option_3', value: 'false', type: 'boolean', category: 'display', description: 'Display option 3' },
    { key: 'display_option_4', value: 'false', type: 'boolean', category: 'display', description: 'Display option 4' },
    
    // Self Order Settings (QR Table Ordering)
    { key: 'self_order_enabled', value: 'false', type: 'boolean', category: 'self_order', description: 'Enable QR self-ordering for customers' },
    { key: 'self_order_accept_mode', value: 'manual', type: 'string', category: 'self_order', description: 'Order accept mode: auto (instant KOT) or manual (staff approval)' },
    { key: 'self_order_session_timeout_minutes', value: '120', type: 'number', category: 'self_order', description: 'Session expiry in minutes after QR scan' },
    { key: 'self_order_require_phone', value: 'true', type: 'boolean', category: 'self_order', description: 'Require phone number before placing order' },
    { key: 'self_order_require_name', value: 'true', type: 'boolean', category: 'self_order', description: 'Require customer name before placing order' },
    { key: 'self_order_max_sessions_per_table', value: '1', type: 'number', category: 'self_order', description: 'Max active self-order sessions per table (0 = unlimited)' },
    { key: 'self_order_allow_reorder', value: 'true', type: 'boolean', category: 'self_order', description: 'Allow adding items to existing order from same session' },
    { key: 'self_order_idle_timeout_minutes', value: '10', type: 'number', category: 'self_order', description: 'Minutes before a session with no order placed is expired (idle timeout)' },
    { key: 'self_order_completion_buffer_minutes', value: '1', type: 'number', category: 'self_order', description: 'Minutes after order completion before session is expired' }
  ];

  /**
   * Get all settings (optionally filtered by category or outlet)
   */
  async getAll(outletId = null, category = null) {
    const pool = getPool();
    
    let query = 'SELECT * FROM system_settings WHERE 1=1';
    const params = [];
    
    if (outletId) {
      query += ' AND (outlet_id = ? OR outlet_id IS NULL)';
      params.push(outletId);
    } else {
      query += ' AND outlet_id IS NULL';
    }
    
    if (category) {
      // Filter by key prefix for category
      query += ' AND setting_key LIKE ?';
      params.push(`${category}_%`);
    }
    
    query += ' ORDER BY setting_key';
    
    const [rows] = await pool.query(query, params);
    
    // Group by category
    const grouped = {};
    const settings = {};
    
    for (const row of rows) {
      const key = row.setting_key;
      const value = this.parseValue(row.setting_value, row.setting_type);
      settings[key] = value;
      
      // Determine category from key or default
      const cat = this.getCategoryFromKey(key);
      if (!grouped[cat]) grouped[cat] = {};
      grouped[cat][key] = {
        value,
        type: row.setting_type,
        description: row.description,
        isEditable: Boolean(row.is_editable)
      };
    }
    
    return {
      settings,
      grouped,
      categories: Object.keys(grouped)
    };
  }

  /**
   * Get a single setting by key
   */
  async get(key, outletId = null) {
    const pool = getPool();
    
    let query = 'SELECT * FROM system_settings WHERE setting_key = ?';
    const params = [key];
    
    if (outletId) {
      query += ' AND (outlet_id = ? OR outlet_id IS NULL) ORDER BY outlet_id DESC LIMIT 1';
      params.push(outletId);
    } else {
      query += ' AND outlet_id IS NULL';
    }
    
    const [rows] = await pool.query(query, params);
    
    if (!rows.length) {
      // Check if it's a valid default setting
      const defaultSetting = SettingsService.DEFAULT_SETTINGS.find(s => s.key === key);
      if (defaultSetting) {
        return {
          key,
          value: this.parseValue(defaultSetting.value, defaultSetting.type),
          type: defaultSetting.type,
          category: defaultSetting.category,
          description: defaultSetting.description,
          isDefault: true
        };
      }
      return null;
    }
    
    const row = rows[0];
    return {
      id: row.id,
      key: row.setting_key,
      value: this.parseValue(row.setting_value, row.setting_type),
      type: row.setting_type,
      category: this.getCategoryFromKey(row.setting_key),
      description: row.description,
      isEditable: Boolean(row.is_editable),
      outletId: row.outlet_id
    };
  }

  /**
   * Get multiple settings by keys
   */
  async getMultiple(keys, outletId = null) {
    const result = {};
    for (const key of keys) {
      const setting = await this.get(key, outletId);
      result[key] = setting ? setting.value : null;
    }
    return result;
  }

  /**
   * Update a single setting
   */
  async update(key, value, outletId = null, updatedBy = null) {
    const pool = getPool();
    
    // Check if setting exists
    let query = 'SELECT id, is_editable FROM system_settings WHERE setting_key = ?';
    const params = [key];
    
    if (outletId) {
      query += ' AND outlet_id = ?';
      params.push(outletId);
    } else {
      query += ' AND outlet_id IS NULL';
    }
    
    const [existing] = await pool.query(query, params);
    
    if (existing.length && !existing[0].is_editable) {
      throw new Error(`Setting '${key}' is not editable`);
    }
    
    const stringValue = String(value);
    const settingType = this.inferType(value);
    
    if (existing.length) {
      // Update existing
      await pool.query(
        'UPDATE system_settings SET setting_value = ?, updated_at = NOW() WHERE id = ?',
        [stringValue, existing[0].id]
      );
    } else {
      // Insert new (outlet-specific or global)
      const defaultSetting = SettingsService.DEFAULT_SETTINGS.find(s => s.key === key);
      await pool.query(
        `INSERT INTO system_settings (outlet_id, setting_key, setting_value, setting_type, description, is_editable)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [outletId, key, stringValue, settingType, defaultSetting?.description || key]
      );
    }
    
    logger.info(`Setting updated: ${key} = ${stringValue}${outletId ? ` (outlet: ${outletId})` : ''}`);
    
    return this.get(key, outletId);
  }

  /**
   * Update multiple settings at once
   */
  async updateMultiple(settings, outletId = null, updatedBy = null) {
    const results = {};
    const errors = [];
    
    for (const [key, value] of Object.entries(settings)) {
      try {
        results[key] = await this.update(key, value, outletId, updatedBy);
      } catch (error) {
        errors.push({ key, error: error.message });
      }
    }
    
    return { updated: results, errors };
  }

  /**
   * Update settings by category
   */
  async updateByCategory(category, settings, outletId = null, updatedBy = null) {
    const validKeys = SettingsService.DEFAULT_SETTINGS
      .filter(s => s.category === category)
      .map(s => s.key);
    
    const filteredSettings = {};
    for (const [key, value] of Object.entries(settings)) {
      if (validKeys.includes(key) || key.startsWith(`${category}_`)) {
        filteredSettings[key] = value;
      }
    }
    
    return this.updateMultiple(filteredSettings, outletId, updatedBy);
  }

  /**
   * Reset setting to default
   */
  async resetToDefault(key, outletId = null) {
    const pool = getPool();
    
    const defaultSetting = SettingsService.DEFAULT_SETTINGS.find(s => s.key === key);
    if (!defaultSetting) {
      throw new Error(`No default value for setting '${key}'`);
    }
    
    let query = 'DELETE FROM system_settings WHERE setting_key = ?';
    const params = [key];
    
    if (outletId) {
      query += ' AND outlet_id = ?';
      params.push(outletId);
    } else {
      query += ' AND outlet_id IS NULL';
    }
    
    await pool.query(query, params);
    
    return {
      key,
      value: this.parseValue(defaultSetting.value, defaultSetting.type),
      isDefault: true
    };
  }

  /**
   * Get settings grouped by category with metadata
   */
  async getByCategory(category, outletId = null) {
    const allSettings = await this.getAll(outletId);
    
    // Get default settings for this category
    const categoryDefaults = SettingsService.DEFAULT_SETTINGS.filter(s => s.category === category);
    
    const result = {};
    for (const def of categoryDefaults) {
      const existing = allSettings.grouped[category]?.[def.key];
      result[def.key] = {
        value: existing?.value ?? this.parseValue(def.value, def.type),
        type: def.type,
        description: def.description,
        isEditable: existing?.isEditable ?? true,
        isDefault: !existing
      };
    }
    
    return {
      category,
      settings: result
    };
  }

  /**
   * Get all categories with setting counts and settings
   */
  async getCategories() {
    const categories = {};
    
    for (const setting of SettingsService.DEFAULT_SETTINGS) {
      if (!categories[setting.category]) {
        categories[setting.category] = {
          name: setting.category,
          displayName: this.formatCategoryName(setting.category),
          count: 0,
          settings: []
        };
      }
      categories[setting.category].count++;
      categories[setting.category].settings.push({
        key: setting.key,
        value: setting.value,
        type: setting.type,
        description: setting.description
      });
    }
    
    return Object.values(categories);
  }

  /**
   * Initialize default settings for an outlet
   */
  async initializeDefaults(outletId = null) {
    const pool = getPool();
    
    for (const setting of SettingsService.DEFAULT_SETTINGS) {
      const existing = await this.get(setting.key, outletId);
      if (!existing || existing.isDefault) {
        await pool.query(
          `INSERT IGNORE INTO system_settings (outlet_id, setting_key, setting_value, setting_type, description, is_editable)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [outletId, setting.key, setting.value, setting.type, setting.description]
        );
      }
    }
    
    return { initialized: true, count: SettingsService.DEFAULT_SETTINGS.length };
  }

  /**
   * Get business profile
   */
  async getBusinessProfile() {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM business_profile LIMIT 1');
    
    if (!rows.length) return null;
    
    const bp = rows[0];
    return {
      id: bp.id,
      businessName: bp.business_name,
      legalName: bp.legal_name,
      gstin: bp.gstin,
      panNumber: bp.pan_number,
      cinNumber: bp.cin_number,
      state: bp.state,
      stateCode: bp.state_code,
      country: bp.country,
      currencyCode: bp.currency_code,
      currencySymbol: bp.currency_symbol,
      logoUrl: bp.logo_url,
      address: bp.address,
      phone: bp.phone,
      email: bp.email,
      website: bp.website,
      financialYearStart: bp.financial_year_start,
      dateFormat: bp.date_format,
      timeFormat: bp.time_format,
      timezone: bp.timezone
    };
  }

  /**
   * Update business profile
   */
  async updateBusinessProfile(data) {
    const pool = getPool();
    
    const fields = [];
    const values = [];
    
    const fieldMap = {
      businessName: 'business_name',
      legalName: 'legal_name',
      gstin: 'gstin',
      panNumber: 'pan_number',
      cinNumber: 'cin_number',
      state: 'state',
      stateCode: 'state_code',
      country: 'country',
      currencyCode: 'currency_code',
      currencySymbol: 'currency_symbol',
      logoUrl: 'logo_url',
      address: 'address',
      phone: 'phone',
      email: 'email',
      website: 'website',
      financialYearStart: 'financial_year_start',
      dateFormat: 'date_format',
      timeFormat: 'time_format',
      timezone: 'timezone'
    };
    
    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (data[key] !== undefined) {
        fields.push(`${dbField} = ?`);
        values.push(data[key]);
      }
    }
    
    if (fields.length === 0) {
      throw new Error('No fields to update');
    }
    
    const [existing] = await pool.query('SELECT id FROM business_profile LIMIT 1');
    
    if (existing.length) {
      values.push(existing[0].id);
      await pool.query(
        `UPDATE business_profile SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
        values
      );
    } else {
      await pool.query(
        `INSERT INTO business_profile (${Object.values(fieldMap).filter((_, i) => data[Object.keys(fieldMap)[i]] !== undefined).join(', ')})
         VALUES (${values.map(() => '?').join(', ')})`,
        values
      );
    }
    
    return this.getBusinessProfile();
  }

  // ==================== Helper Methods ====================

  parseValue(value, type) {
    if (value === null || value === undefined) return null;
    
    switch (type) {
      case 'boolean':
        return value === 'true' || value === '1' || value === true;
      case 'number':
        return parseFloat(value);
      case 'json':
        try { return JSON.parse(value); } catch { return value; }
      default:
        return value;
    }
  }

  inferType(value) {
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'object') return 'json';
    return 'string';
  }

  getCategoryFromKey(key) {
    const defaultSetting = SettingsService.DEFAULT_SETTINGS.find(s => s.key === key);
    if (defaultSetting) return defaultSetting.category;
    
    // Infer from key prefix
    for (const cat of Object.values(SettingsService.CATEGORIES)) {
      if (key.startsWith(cat)) return cat;
    }
    return 'general';
  }

  formatCategoryName(category) {
    return category.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
}

module.exports = new SettingsService();
