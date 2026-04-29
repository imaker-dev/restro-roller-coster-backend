const ORDER_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  BILLED: 'billed',
  PAID: 'paid',
  CANCELLED: 'cancelled',
};

const KOT_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  READY: 'ready',
  SERVED: 'served',
  CANCELLED: 'cancelled',
};

const TABLE_STATUS = {
  AVAILABLE: 'available',
  OCCUPIED: 'occupied',
  RUNNING: 'running',
  RESERVED: 'reserved',
  BILLING: 'billing',
  BLOCKED: 'blocked',
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  PARTIAL: 'partial',
  COMPLETED: 'completed',
  REFUNDED: 'refunded',
  FAILED: 'failed',
};

const PAYMENT_MODE = {
  CASH: 'cash',
  CARD: 'card',
  UPI: 'upi',
  WALLET: 'wallet',
  CREDIT: 'credit',
  COMPLIMENTARY: 'complimentary',
  SPLIT: 'split',
};

const TAX_TYPE = {
  GST: 'gst',
  VAT: 'vat',
  SERVICE_CHARGE: 'service_charge',
};

const TAX_COMPONENT = {
  CGST: 'cgst',
  SGST: 'sgst',
  IGST: 'igst',
  VAT: 'vat',
  CESS: 'cess',
};

const DISCOUNT_TYPE = {
  PERCENTAGE: 'percentage',
  FLAT: 'flat',
  ITEM_LEVEL: 'item_level',
  BILL_LEVEL: 'bill_level',
};

const USER_TYPE = {
  MASTER: 'master',
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  MANAGER: 'manager',
  CAPTAIN: 'captain',
  CASHIER: 'cashier',
  POS_USER: 'pos_user',
  KITCHEN: 'kitchen',
  BARTENDER: 'bartender',
  WAITER: 'waiter',
};

const OUTLET_TYPE = {
  RESTAURANT: 'restaurant',
  BAR: 'bar',
  CAFE: 'cafe',
  BANQUET: 'banquet',
  FOOD_COURT: 'food_court',
  PUB: 'pub',
  LOUNGE: 'lounge',
};

const SECTION_TYPE = {
  DINE_IN: 'dine_in',
  TAKEAWAY: 'takeaway',
  DELIVERY: 'delivery',
  BAR: 'bar',
  ROOFTOP: 'rooftop',
  PRIVATE: 'private',
  OUTDOOR: 'outdoor',
  AC: 'ac',
  NON_AC: 'non_ac',
  POOLSIDE: 'poolside',
  TERRACE: 'terrace',
  VIP: 'vip',
};

// Counter types for bar/beverage service points
const COUNTER_TYPE = {
  MAIN_BAR: 'main_bar',
  MOCKTAIL: 'mocktail',
  COCKTAIL: 'cocktail',
  WHISKY: 'whisky',
  WINE: 'wine',
  BEER: 'beer',
  JUICE: 'juice',
  COFFEE: 'coffee',
  DESSERT: 'dessert',
  LIVE_COUNTER: 'live_counter',
};

// Kitchen station types
const KITCHEN_STATION = {
  MAIN_KITCHEN: 'main_kitchen',
  TANDOOR: 'tandoor',
  CHINESE: 'chinese',
  CONTINENTAL: 'continental',
  GRILL: 'grill',
  SALAD: 'salad',
  DESSERT: 'dessert',
  BAKERY: 'bakery',
};

const ITEM_TYPE = {
  VEG: 'veg',
  NON_VEG: 'non_veg',
  EGG: 'egg',
  VEGAN: 'vegan',
};

const STOCK_MOVEMENT = {
  PURCHASE: 'purchase',
  CONSUMPTION: 'consumption',
  WASTAGE: 'wastage',
  TRANSFER_IN: 'transfer_in',
  TRANSFER_OUT: 'transfer_out',
  ADJUSTMENT: 'adjustment',
  OPENING: 'opening',
  CLOSING: 'closing',
  RETURN: 'return',
};

const UNIT_TYPE = {
  KG: 'kg',
  GRAM: 'gram',
  LITER: 'liter',
  ML: 'ml',
  PIECE: 'piece',
  DOZEN: 'dozen',
  PACKET: 'packet',
  BOX: 'box',
  BOTTLE: 'bottle',
  CAN: 'can',
};

const PRINT_TYPE = {
  KOT: 'kot',
  BILL: 'bill',
  DUPLICATE_BILL: 'duplicate_bill',
  DAY_END_REPORT: 'day_end_report',
  CASH_SUMMARY: 'cash_summary',
};

const NOTIFICATION_TYPE = {
  ORDER: 'order',
  KOT: 'kot',
  PAYMENT: 'payment',
  TABLE: 'table',
  INVENTORY: 'inventory',
  ALERT: 'alert',
  SYSTEM: 'system',
};
// waiter call

const CACHE_KEYS = {
  MENU: 'menu',
  CATEGORIES: 'categories',
  ITEMS: 'items',
  TABLES: 'tables',
  FLOORS: 'floors',
  TAX_RULES: 'tax_rules',
  PRICE_RULES: 'price_rules',
  ACTIVE_ORDERS: 'active_orders',
  USER_SESSION: 'user_session',
  OUTLET_CONFIG: 'outlet_config',
};

const CACHE_TTL = {
  SHORT: 300,        // 5 minutes
  MEDIUM: 1800,      // 30 minutes
  LONG: 3600,        // 1 hour
  EXTRA_LONG: 86400, // 24 hours
};

const QUEUE_NAMES = {
  PRINT: 'print',
  NOTIFICATION: 'notification',
  REPORT: 'report',
  EMAIL: 'email',
  WHATSAPP: 'whatsapp',
  INVENTORY: 'inventory',
  DYNO_WEBHOOK: 'dyno-webhook',
};

const REPORT_TYPE = {
  DAILY_SALES: 'daily_sales',
  ITEM_SALES: 'item_sales',
  CASH_SUMMARY: 'cash_summary',
  TAX_SUMMARY: 'tax_summary',
  CATEGORY_WISE: 'category_wise',
  WAITER_WISE: 'waiter_wise',
  PAYMENT_MODE: 'payment_mode',
  DISCOUNT_REPORT: 'discount_report',
  CANCELLATION: 'cancellation',
  INVENTORY: 'inventory',
};

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const MEAL_SLOTS = {
  BREAKFAST: { name: 'breakfast', start: '06:00', end: '11:00' },
  LUNCH: { name: 'lunch', start: '11:00', end: '16:00' },
  SNACKS: { name: 'snacks', start: '16:00', end: '19:00' },
  DINNER: { name: 'dinner', start: '19:00', end: '23:00' },
  LATE_NIGHT: { name: 'late_night', start: '23:00', end: '06:00' },
};

// ========================
// SELF ORDER SYSTEM
// ========================
const SELF_ORDER = {
  SESSION_STATUS: {
    ACTIVE: 'active',
    ORDERING: 'ordering',
    COMPLETED: 'completed',
    EXPIRED: 'expired',
  },
  ORDER_SOURCE: {
    POS: 'pos',
    SELF_ORDER: 'self_order',
    ONLINE: 'online',
    QR: 'qr',
  },
  ACCEPT_MODE: {
    AUTO: 'auto',
    MANUAL: 'manual',
  },
  SYSTEM_USER_EMAIL: 'selforder@system.local',
  SESSION_TTL_MINUTES: 120,
  SETTINGS_KEYS: {
    ENABLED: 'self_order_enabled',
    ACCEPT_MODE: 'self_order_accept_mode',
    SESSION_TIMEOUT: 'self_order_session_timeout_minutes',
    REQUIRE_PHONE: 'self_order_require_phone',
    REQUIRE_NAME: 'self_order_require_name',
    MAX_SESSIONS_PER_TABLE: 'self_order_max_sessions_per_table',
    ALLOW_REORDER: 'self_order_allow_reorder',
    IDLE_TIMEOUT: 'self_order_idle_timeout_minutes',           // Session expires if no order placed (default: 10)
    COMPLETION_BUFFER: 'self_order_completion_buffer_minutes', // Session expires after order completion (default: 1)
  },
};

module.exports = {
  ORDER_STATUS,
  KOT_STATUS,
  TABLE_STATUS,
  PAYMENT_STATUS,
  PAYMENT_MODE,
  TAX_TYPE,
  TAX_COMPONENT,
  DISCOUNT_TYPE,
  USER_TYPE,
  OUTLET_TYPE,
  SECTION_TYPE,
  COUNTER_TYPE,
  KITCHEN_STATION,
  ITEM_TYPE,
  STOCK_MOVEMENT,
  UNIT_TYPE,
  PRINT_TYPE,
  NOTIFICATION_TYPE,
  CACHE_KEYS,
  CACHE_TTL,
  QUEUE_NAMES,
  REPORT_TYPE,
  DAY_NAMES,
  MEAL_SLOTS,
  SELF_ORDER,
};
