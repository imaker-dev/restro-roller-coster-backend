const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const generateUUID = () => uuidv4();

const generateCode = (prefix = '', length = 8) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = prefix;
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

const generateOrderNumber = (outletCode = 'OUT') => {
  const date = new Date();
  const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${outletCode}-${dateStr}-${random}`;
};

const generateKOTNumber = (outletId) => {
  const timestamp = Date.now().toString(36).toUpperCase();
  return `KOT-${outletId}-${timestamp}`;
};

const generateInvoiceNumber = (outletCode, sequence) => {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${outletCode}/${year}${month}/${String(sequence).padStart(6, '0')}`;
};

const generatePIN = (length = 4) => {
  return crypto.randomInt(Math.pow(10, length - 1), Math.pow(10, length)).toString();
};

const hashString = (str) => {
  return crypto.createHash('sha256').update(str).digest('hex');
};

const slugify = (str) => {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const roundToTwo = (num) => {
  return Math.round((num + Number.EPSILON) * 100) / 100;
};

const calculatePercentage = (value, percentage) => {
  return roundToTwo((value * percentage) / 100);
};

const isEmpty = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
};

const pick = (obj, keys) => {
  return keys.reduce((acc, key) => {
    if (obj.hasOwnProperty(key)) {
      acc[key] = obj[key];
    }
    return acc;
  }, {});
};

const omit = (obj, keys) => {
  return Object.keys(obj).reduce((acc, key) => {
    if (!keys.includes(key)) {
      acc[key] = obj[key];
    }
    return acc;
  }, {});
};

const groupBy = (array, key) => {
  return array.reduce((acc, item) => {
    const groupKey = typeof key === 'function' ? key(item) : item[key];
    if (!acc[groupKey]) {
      acc[groupKey] = [];
    }
    acc[groupKey].push(item);
    return acc;
  }, {});
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retry = async (fn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await sleep(delay * Math.pow(2, i));
    }
  }
};

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true' || value === '1';
  }
  return Boolean(value);
};

const sanitizeInput = (str) => {
  if (typeof str !== 'string') return str;
  return str.replace(/[<>]/g, '').trim();
};

const appConfig = require('../config/app.config');

/**
 * Prefix APP_URL to a relative image path.
 * Returns full URL if path is relative (e.g. "uploads/images/xxx.jpg").
 * Returns as-is if already absolute URL, null, or empty.
 */
const prefixImageUrl = (path) => {
  if (!path || typeof path !== 'string') return null;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const base = (appConfig.url || 'http://localhost:3000').replace(/\/+$/, '');
  const clean = path.replace(/^\/+/, '');
  return `${base}/${clean}`;
};

/**
 * Get floor IDs a user is restricted to for a given outlet.
 * Returns empty array when the user has NO floor assignments (no restriction — sees all floors).
 * Works for ANY role (captain, cashier, manager, etc.) — role-agnostic.
 * Requires getPool from database module – caller must pass it or we lazy-require.
 */
const getUserFloorIds = async (userId, outletId) => {
  if (!userId || !outletId) return [];
  // Cache floor assignments (60s) — called on every request, rarely changes
  const { cache } = require('../config/redis');
  const cacheKey = `user:floors:${userId}:${outletId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const { getPool } = require('../database');
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT floor_id FROM user_floors WHERE user_id = ? AND outlet_id = ? AND is_active = 1',
    [userId, outletId]
  );
  const result = rows.map(r => r.floor_id);
  await cache.set(cacheKey, result, 60);
  return result;
};

module.exports = {
  generateUUID,
  generateCode,
  generateOrderNumber,
  generateKOTNumber,
  generateInvoiceNumber,
  generatePIN,
  hashString,
  slugify,
  roundToTwo,
  calculatePercentage,
  isEmpty,
  pick,
  omit,
  groupBy,
  sleep,
  retry,
  parseBoolean,
  sanitizeInput,
  prefixImageUrl,
  getUserFloorIds,
};
