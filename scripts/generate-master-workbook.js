#!/usr/bin/env node
/**
 * Generate Master Restaurant Excel Workbook
 * 
 * Creates a multi-sheet .xlsx file that behaves like a mini relational database.
 * All sheets are connected via XLOOKUP formulas on Item_ID.
 * 
 * Sheets:
 *   1. MASTER_ITEMS       — Single source of truth for every item
 *   2. MENU_ITEMS         — Sellable menu items with variants & prices
 *   3. INVENTORY_STOCK    — Current stock with unit conversion
 *   4. INGREDIENTS        — Ingredient-to-inventory mapping
 *   5. RECIPES            — Menu item recipes with ingredient quantities
 *   6. PRODUCTION_RECIPES — Batch production (gravies, marinades)
 *   7. SALES_SIMULATION   — Order simulation with auto ingredient consumption
 *   8. STOCK_MOVEMENT     — Purchase/Sale/Production/Wastage/Cancel ledger
 *   9. WASTAGE_TRACKING   — Spoilage & wastage log
 *  10. UNIT_REFERENCE     — All available units & conversion factors
 *
 * Usage: node scripts/generate-master-workbook.js
 */

const ExcelJS = require('exceljs');
const path = require('path');

// ════════════════════════════════════════════════════════════════
// STYLING CONSTANTS
// ════════════════════════════════════════════════════════════════

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6E4F0' } };
const FORMULA_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
const READONLY_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
const LIQUOR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
const PRODUCTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2D9F3' } };
const BORDER_THIN = {
  top: { style: 'thin' }, bottom: { style: 'thin' },
  left: { style: 'thin' }, right: { style: 'thin' }
};

function styleHeaders(sheet) {
  const headerRow = sheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = BORDER_THIN;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  headerRow.height = 30;
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: sheet.columnCount } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function markFormulaColumns(sheet, colNums, startRow, endRow) {
  for (let r = startRow; r <= endRow; r++) {
    for (const c of colNums) {
      const cell = sheet.getRow(r).getCell(c);
      cell.fill = FORMULA_FILL;
    }
  }
}

// ════════════════════════════════════════════════════════════════
// MASTER DATA
// ════════════════════════════════════════════════════════════════

const MASTER_ITEMS = [
  // ─── Inventory: Kitchen Raw Materials ───
  ['INV001', 'Chicken Boneless',      'Inventory', 'Meat & Poultry',    'g',   'kg',  1000, 'No',  'Yes', 2,  95,  5],
  ['INV002', 'Chicken With Bone',     'Inventory', 'Meat & Poultry',    'g',   'kg',  1000, 'No',  'Yes', 2,  90, 10],
  ['INV003', 'Mutton',                'Inventory', 'Meat & Poultry',    'g',   'kg',  1000, 'No',  'Yes', 2,  90, 10],
  ['INV004', 'Paneer',                'Inventory', 'Dairy & Cream',     'g',   'kg',  1000, 'No',  'Yes', 3,  95,  5],
  ['INV005', 'Tomato',                'Inventory', 'Raw Vegetables',    'g',   'kg',  1000, 'No',  'Yes', 5,  90, 10],
  ['INV006', 'Onion',                 'Inventory', 'Raw Vegetables',    'g',   'kg',  1000, 'No',  'No',  30, 90, 10],
  ['INV007', 'Capsicum',              'Inventory', 'Raw Vegetables',    'g',   'kg',  1000, 'No',  'Yes', 5,  85, 15],
  ['INV008', 'Butter',                'Inventory', 'Dairy & Cream',     'g',   'kg',  1000, 'No',  'Yes', 30, 100, 0],
  ['INV009', 'Cream',                 'Inventory', 'Dairy & Cream',     'ml',  'l',   1000, 'No',  'Yes', 7,  100, 0],
  ['INV010', 'Curd',                  'Inventory', 'Dairy & Cream',     'ml',  'l',   1000, 'No',  'Yes', 5,  100, 0],
  ['INV011', 'Cooking Oil',           'Inventory', 'Oils & Fats',       'ml',  'l',   1000, 'No',  'No',  180,100, 0],
  ['INV012', 'Ghee',                  'Inventory', 'Oils & Fats',       'g',   'kg',  1000, 'No',  'No',  180,100, 0],
  ['INV013', 'Wheat Flour',           'Inventory', 'Grains & Flour',    'g',   'kg',  1000, 'No',  'No',  90, 100, 0],
  ['INV014', 'Maida',                 'Inventory', 'Grains & Flour',    'g',   'kg',  1000, 'No',  'No',  90, 100, 0],
  ['INV015', 'Basmati Rice',          'Inventory', 'Grains & Flour',    'g',   'kg',  1000, 'No',  'No',  365,95,  5],
  ['INV016', 'Kashmiri Chilli Powder','Inventory', 'Spices & Seasonings','g',  'kg',  1000, 'No',  'No',  180,100, 0],
  ['INV017', 'Garam Masala',          'Inventory', 'Spices & Seasonings','g',  'kg',  1000, 'No',  'No',  180,100, 0],
  ['INV018', 'Turmeric Powder',       'Inventory', 'Spices & Seasonings','g',  'kg',  1000, 'No',  'No',  365,100, 0],
  ['INV019', 'Cumin Powder',          'Inventory', 'Spices & Seasonings','g',  'kg',  1000, 'No',  'No',  180,100, 0],
  ['INV020', 'Coriander Powder',      'Inventory', 'Spices & Seasonings','g',  'kg',  1000, 'No',  'No',  180,100, 0],
  ['INV021', 'Salt',                  'Inventory', 'Spices & Seasonings','g',  'kg',  1000, 'No',  'No',  365,100, 0],
  ['INV022', 'Kasuri Methi',          'Inventory', 'Spices & Seasonings','g',  'kg',  1000, 'No',  'No',  180,100, 0],
  ['INV023', 'Ginger-Garlic Paste',   'Inventory', 'Spices & Seasonings','g',  'kg',  1000, 'No',  'Yes', 15, 100, 0],
  ['INV024', 'Cashew',                'Inventory', 'Dry Fruits & Nuts', 'g',   'kg',  1000, 'No',  'No',  180,100, 0],
  ['INV025', 'Sugar',                 'Inventory', 'Spices & Seasonings','g',  'kg',  1000, 'No',  'No',  365,100, 0],
  ['INV026', 'Lemon',                 'Inventory', 'Raw Vegetables',    'g',   'kg',  1000, 'No',  'Yes', 10, 80, 20],
  ['INV027', 'Mint Leaves',           'Inventory', 'Raw Vegetables',    'g',   'kg',  1000, 'No',  'Yes', 3,  70, 30],
  ['INV028', 'Soda Water',            'Inventory', 'Soft Drinks & Mixers','pcs','btl', 1,   'No',  'No',  180,100, 0],
  ['INV029', 'Egg',                   'Inventory', 'Meat & Poultry',    'pcs', 'pcs', 1,    'No',  'Yes', 7,  100, 0],

  // ─── Inventory: Liquor (CRITICAL — bottle → ml conversion) ───
  ['INV030', 'Monkey Shoulder 750ml', 'Inventory', 'Spirits & Liquor',  'ml',  'btl', 750, 'No',  'No',  365,100, 0],
  ['INV031', 'Royal Stag 750ml',      'Inventory', 'Spirits & Liquor',  'ml',  'btl', 750, 'No',  'No',  365,100, 0],
  ['INV032', 'Bacardi White 750ml',   'Inventory', 'Spirits & Liquor',  'ml',  'btl', 750, 'No',  'No',  365,100, 0],
  ['INV033', 'Bombay Sapphire 750ml', 'Inventory', 'Spirits & Liquor',  'ml',  'btl', 750, 'No',  'No',  365,100, 0],
  ['INV034', 'Absolut 750ml',         'Inventory', 'Spirits & Liquor',  'ml',  'btl', 750, 'No',  'No',  365,100, 0],
  ['INV035', 'Glenfiddich 750ml',     'Inventory', 'Spirits & Liquor',  'ml',  'btl', 750, 'No',  'No',  365,100, 0],
  ['INV036', 'Black Label 750ml',     'Inventory', 'Spirits & Liquor',  'ml',  'btl', 750, 'No',  'No',  365,100, 0],
  ['INV037', 'Budweiser 650ml',       'Inventory', 'Spirits & Liquor',  'ml',  'btl', 650, 'No',  'Yes', 180,100, 0],
  ['INV038', 'Kingfisher Ultra 650ml','Inventory', 'Spirits & Liquor',  'ml',  'btl', 650, 'No',  'Yes', 180,100, 0],

  // ─── Semi-Finished / Production Output ───
  ['PRD001', 'Tomato Gravy',          'Production','Semi-Finished',     'ml',  'l',   1000, 'No',  'Yes', 3,  100, 0],
  ['PRD002', 'Makhani Gravy',         'Production','Semi-Finished',     'ml',  'l',   1000, 'No',  'Yes', 3,  100, 0],
  ['PRD003', 'Tikka Marinade',        'Production','Semi-Finished',     'g',   'kg',  1000, 'No',  'Yes', 3,  100, 0],

  // ─── Menu Items: Restaurant ───
  ['MNU001', 'Butter Chicken',        'Menu',      'Main Course Non Veg','—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU002', 'Kadhai Paneer',         'Menu',      'Main Course Veg',   '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU003', 'Chicken Tikka',         'Menu',      'Tandoor Non Veg',   '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU004', 'Tandoori Roti',         'Menu',      'Breads',            '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU005', 'Butter Naan',           'Menu',      'Breads',            '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU006', 'Dal Makhani',           'Menu',      'Dal',               '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU007', 'Jeera Rice',            'Menu',      'Khushbu & Basmati', '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU008', 'Egg Bhurji',            'Menu',      'Eggs',              '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU009', 'Fresh Lime Soda',       'Menu',      'Beverage',          '—',  '—',   0,    'Yes', '—',   0,  0,   0],

  // ─── Menu Items: Bar (Liquor) ───
  ['MNU010', 'Monkey Shoulder',       'Menu',      'Whisky',            '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU011', 'Royal Stag',            'Menu',      'Whisky',            '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU012', 'Bacardi White',         'Menu',      'Rum',               '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU013', 'Bombay Sapphire',       'Menu',      'Gin',               '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU014', 'Absolut',               'Menu',      'Vodka',             '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU015', 'Glenfiddich',           'Menu',      'Single Malt',       '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU016', 'Black Label',           'Menu',      'Blended Scotch',    '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU017', 'Budweiser 650ml',       'Menu',      'Beer',              '—',  '—',   0,    'Yes', '—',   0,  0,   0],
  ['MNU018', 'Kingfisher Ultra 650ml','Menu',      'Beer',              '—',  '—',   0,    'Yes', '—',   0,  0,   0],
];

// ════════════════════════════════════════════════════════════════
// MAIN GENERATOR
// ════════════════════════════════════════════════════════════════

async function generate() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Restro POS';
  workbook.created = new Date();

  // ──────────────────────────────────────────────────────────────
  // SHEET 1: MASTER_ITEMS
  // ──────────────────────────────────────────────────────────────
  const ws1 = workbook.addWorksheet('MASTER_ITEMS', { properties: { tabColor: { argb: 'FF1F4E79' } } });
  ws1.columns = [
    { header: 'Item_ID',          key: 'id',          width: 12 },
    { header: 'Item_Name',        key: 'name',        width: 28 },
    { header: 'Item_Type',        key: 'type',        width: 14 },
    { header: 'Category',         key: 'category',    width: 22 },
    { header: 'Base_Unit',        key: 'baseUnit',    width: 12 },
    { header: 'Purchase_Unit',    key: 'purchUnit',   width: 14 },
    { header: 'Conversion_Value', key: 'conversion',  width: 18 },
    { header: 'Is_Sellable',      key: 'sellable',    width: 12 },
    { header: 'Is_Perishable',    key: 'perishable',  width: 14 },
    { header: 'Shelf_Life_Days',  key: 'shelfLife',   width: 16 },
    { header: 'Yield_Percent',    key: 'yield',       width: 14 },
    { header: 'Wastage_Percent',  key: 'wastage',     width: 16 },
  ];

  for (const item of MASTER_ITEMS) {
    ws1.addRow({
      id: item[0], name: item[1], type: item[2], category: item[3],
      baseUnit: item[4], purchUnit: item[5], conversion: item[6],
      sellable: item[7], perishable: item[8], shelfLife: item[9],
      yield: item[10], wastage: item[11]
    });
  }
  styleHeaders(ws1);

  // Highlight liquor rows
  for (let r = 2; r <= ws1.rowCount; r++) {
    const cat = ws1.getRow(r).getCell(4).value;
    if (cat === 'Spirits & Liquor') {
      for (let c = 1; c <= 12; c++) ws1.getRow(r).getCell(c).fill = LIQUOR_FILL;
    }
    if (cat === 'Semi-Finished') {
      for (let c = 1; c <= 12; c++) ws1.getRow(r).getCell(c).fill = PRODUCTION_FILL;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // SHEET 2: MENU_ITEMS  (sellable items with variants & prices)
  // ──────────────────────────────────────────────────────────────
  const ws2 = workbook.addWorksheet('MENU_ITEMS', { properties: { tabColor: { argb: 'FF00B050' } } });
  ws2.columns = [
    { header: 'Menu_Item_ID',   key: 'menuId',    width: 14 },
    { header: 'Item_Name',      key: 'name',      width: 28 },  // XLOOKUP
    { header: 'Category',       key: 'category',  width: 22 },  // XLOOKUP
    { header: 'Variant_Name',   key: 'variant',   width: 18 },
    { header: 'Selling_Price',  key: 'price',     width: 14 },
    { header: 'Item_Type',      key: 'itemType',  width: 12 },
    { header: 'GST_%',          key: 'gst',       width: 8 },
    { header: 'VAT_%',          key: 'vat',       width: 8 },
    { header: 'Station',        key: 'station',   width: 10 },
    { header: 'Service_Type',   key: 'service',   width: 14 },
  ];

  const menuData = [
    // Restaurant items
    ['MNU001', null, null, 'Single',         329, 'non_veg', 5,  '', 'Kitchen', 'restaurant'],
    ['MNU001', null, null, 'Family',         499, 'non_veg', 5,  '', 'Kitchen', 'restaurant'],
    ['MNU002', null, null, '—',              329, 'veg',     5,  '', 'Kitchen', 'restaurant'],
    ['MNU003', null, null, '—',              379, 'non_veg', 5,  '', 'Kitchen', 'restaurant'],
    ['MNU004', null, null, '—',               30, 'veg',     5,  '', 'Kitchen', 'restaurant'],
    ['MNU005', null, null, '—',               50, 'veg',     5,  '', 'Kitchen', 'restaurant'],
    ['MNU006', null, null, '—',              289, 'veg',     5,  '', 'Kitchen', 'restaurant'],
    ['MNU007', null, null, '—',              159, 'veg',     5,  '', 'Kitchen', 'restaurant'],
    ['MNU008', null, null, '—',              149, 'egg',     5,  '', 'Kitchen', 'restaurant'],
    ['MNU009', null, null, '—',               99, 'veg',     5,  '', 'Kitchen', 'both'],
    // Bar items (Liquor) — with 30ml/60ml variants
    ['MNU010', null, null, 'Small 30 ML',    335, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU010', null, null, 'Large 60 ML',    570, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU011', null, null, 'Small 30 ML',    110, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU011', null, null, 'Large 60 ML',    210, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU012', null, null, 'Small 30 ML',    110, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU012', null, null, 'Large 60 ML',    220, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU013', null, null, 'Small 30 ML',    200, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU013', null, null, 'Large 60 ML',    360, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU014', null, null, 'Small 30 ML',    195, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU014', null, null, 'Large 60 ML',    335, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU015', null, null, 'Small 30 ML',    380, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU015', null, null, 'Large 60 ML',    715, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU016', null, null, 'Small 30 ML',    285, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU016', null, null, 'Large 60 ML',    525, 'veg',     '', 18, 'Bar',     'bar'],
    ['MNU017', null, null, '650 ML (Bottle)', 480,'veg',     '', 18, 'Bar',     'bar'],
    ['MNU018', null, null, '650 ML (Bottle)', 430,'veg',     '', 18, 'Bar',     'bar'],
  ];

  for (let i = 0; i < menuData.length; i++) {
    const d = menuData[i];
    const r = i + 2;
    ws2.addRow({
      menuId: d[0],
      name: null,     // formula
      category: null, // formula
      variant: d[3], price: d[4], itemType: d[5], gst: d[6], vat: d[7], station: d[8], service: d[9]
    });
    // XLOOKUP formulas for Item_Name and Category
    ws2.getRow(r).getCell(2).value = { formula: `XLOOKUP(A${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws2.getRow(r).getCell(3).value = { formula: `XLOOKUP(A${r},MASTER_ITEMS!A:A,MASTER_ITEMS!D:D,"")` };
  }
  styleHeaders(ws2);
  markFormulaColumns(ws2, [2, 3], 2, ws2.rowCount);

  // ──────────────────────────────────────────────────────────────
  // SHEET 3: INVENTORY_STOCK
  // ──────────────────────────────────────────────────────────────
  const ws3 = workbook.addWorksheet('INVENTORY_STOCK', { properties: { tabColor: { argb: 'FFED7D31' } } });
  ws3.columns = [
    { header: 'Item_ID',            key: 'id',        width: 12 },
    { header: 'Item_Name',          key: 'name',      width: 28 },  // XLOOKUP
    { header: 'Category',           key: 'cat',       width: 20 },  // XLOOKUP
    { header: 'Stock_Qty',          key: 'stockQty',  width: 12 },  // user enters
    { header: 'Purchase_Unit',      key: 'purchUnit', width: 14 },  // XLOOKUP
    { header: 'Base_Unit',          key: 'baseUnit',  width: 12 },  // XLOOKUP
    { header: 'Conversion_Value',   key: 'convVal',   width: 18 },  // XLOOKUP
    { header: 'Total_Base_Stock',   key: 'totalBase', width: 18 },  // formula
    { header: 'Min_Stock (Purch)',  key: 'minStock',  width: 16 },
    { header: 'Max_Stock (Purch)',  key: 'maxStock',  width: 16 },
    { header: 'Remaining_After_Sales', key: 'remaining', width: 22 }, // advanced formula
  ];

  const stockData = [
    // [Item_ID, Stock_Qty, MinStock, MaxStock]
    ['INV001', 20,  5,  50],
    ['INV002', 10,  5,  50],
    ['INV003',  8,  3,  30],
    ['INV004', 15,  3,  30],
    ['INV005', 40, 10, 100],
    ['INV006', 50, 10, 100],
    ['INV007',  5,  2,  20],
    ['INV008', 10,  2,  20],
    ['INV009',  8,  2,  20],
    ['INV010', 10,  2,  20],
    ['INV011', 20,  5,  50],
    ['INV012',  5,  2,  20],
    ['INV013', 25, 10, 100],
    ['INV014', 10,  5,  50],
    ['INV015', 30, 10, 100],
    ['INV016',  3,  1,  10],
    ['INV017',  2,  0.5, 5],
    ['INV018',  2,  0.5, 5],
    ['INV019',  2,  0.5, 5],
    ['INV020',  2,  0.5, 5],
    ['INV021', 10,  5,  50],
    ['INV022',  1,  0.2, 2],
    ['INV023',  5,  2,  20],
    ['INV024',  3,  1,  10],
    ['INV025',  5,  5,  50],
    ['INV026',  5,  2,  20],
    ['INV027',  1,  0.5, 5],
    ['INV028', 50, 20, 200],
    ['INV029',100, 50, 500],
    // Liquor stock
    ['INV030',  4,  0,  20],
    ['INV031', 10,  0,  30],
    ['INV032',  6,  0,  20],
    ['INV033',  3,  0,  15],
    ['INV034',  5,  0,  20],
    ['INV035',  2,  0,  10],
    ['INV036',  3,  0,  15],
    ['INV037', 48, 10, 200],
    ['INV038', 48, 10, 200],
    // Semi-finished
    ['PRD001',  0,  0,  50],
    ['PRD002',  0,  0,  50],
    ['PRD003',  0,  0,  20],
  ];

  for (let i = 0; i < stockData.length; i++) {
    const d = stockData[i];
    const r = i + 2;
    ws3.addRow({ id: d[0], name: null, cat: null, stockQty: d[1], purchUnit: null, baseUnit: null, convVal: null, totalBase: null, minStock: d[2], maxStock: d[3], remaining: null });

    // XLOOKUP formulas
    ws3.getRow(r).getCell(2).value = { formula: `XLOOKUP(A${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws3.getRow(r).getCell(3).value = { formula: `XLOOKUP(A${r},MASTER_ITEMS!A:A,MASTER_ITEMS!D:D,"")` };
    ws3.getRow(r).getCell(5).value = { formula: `XLOOKUP(A${r},MASTER_ITEMS!A:A,MASTER_ITEMS!F:F,"")` };
    ws3.getRow(r).getCell(6).value = { formula: `XLOOKUP(A${r},MASTER_ITEMS!A:A,MASTER_ITEMS!E:E,"")` };
    ws3.getRow(r).getCell(7).value = { formula: `XLOOKUP(A${r},MASTER_ITEMS!A:A,MASTER_ITEMS!G:G,0)` };
    // Total_Base_Stock = Stock_Qty * Conversion_Value
    ws3.getRow(r).getCell(8).value = { formula: `D${r}*G${r}` };
    // Remaining_After_Sales = Total_Base_Stock - SUMPRODUCT of sales consumption
    // This is an advanced formula that sums all consumption from STOCK_MOVEMENT
    ws3.getRow(r).getCell(11).value = { formula: `H${r}-SUMPRODUCT((STOCK_MOVEMENT!B:B=A${r})*(STOCK_MOVEMENT!C:C="Sale")*STOCK_MOVEMENT!D:D)+SUMPRODUCT((STOCK_MOVEMENT!B:B=A${r})*(STOCK_MOVEMENT!C:C="Purchase")*STOCK_MOVEMENT!D:D)` };
  }
  styleHeaders(ws3);
  markFormulaColumns(ws3, [2, 3, 5, 6, 7, 8, 11], 2, ws3.rowCount);

  // ──────────────────────────────────────────────────────────────
  // SHEET 4: INGREDIENTS
  // ──────────────────────────────────────────────────────────────
  const ws4 = workbook.addWorksheet('INGREDIENTS', { properties: { tabColor: { argb: 'FF7030A0' } } });
  ws4.columns = [
    { header: 'Ingredient_ID',   key: 'ingId',    width: 14 },
    { header: 'Item_ID',         key: 'itemId',   width: 12 },
    { header: 'Ingredient_Name', key: 'name',     width: 28 },  // XLOOKUP
    { header: 'Base_Unit',       key: 'unit',     width: 12 },  // XLOOKUP
    { header: 'Yield_%',         key: 'yield',    width: 10 },  // XLOOKUP
    { header: 'Wastage_%',       key: 'wastage',  width: 12 },  // XLOOKUP
    { header: 'Prep_Notes',      key: 'notes',    width: 30 },
  ];

  const ingredientData = [
    ['ING001', 'INV001', 'Wash cut to pieces'],
    ['ING002', 'INV002', 'Clean and marinate'],
    ['ING003', 'INV003', 'Clean and cut'],
    ['ING004', 'INV004', 'Cut to cubes'],
    ['ING005', 'INV005', 'Wash and chop'],
    ['ING006', 'INV006', 'Peel and chop'],
    ['ING007', 'INV007', 'Deseed and slice'],
    ['ING008', 'INV008', ''],
    ['ING009', 'INV009', ''],
    ['ING010', 'INV010', ''],
    ['ING011', 'INV011', ''],
    ['ING012', 'INV012', ''],
    ['ING013', 'INV013', 'Sieve before use'],
    ['ING014', 'INV014', ''],
    ['ING015', 'INV015', 'Wash and soak 30 min'],
    ['ING016', 'INV016', ''],
    ['ING017', 'INV017', ''],
    ['ING018', 'INV018', ''],
    ['ING019', 'INV019', ''],
    ['ING020', 'INV020', ''],
    ['ING021', 'INV021', ''],
    ['ING022', 'INV022', 'Crush before adding'],
    ['ING023', 'INV023', ''],
    ['ING024', 'INV024', 'Soak and grind to paste'],
    ['ING025', 'INV025', ''],
    ['ING026', 'INV026', 'Cut and squeeze'],
    ['ING027', 'INV027', 'Wash pick leaves'],
    ['ING028', 'INV028', ''],
    ['ING029', 'INV029', ''],
    // Liquor ingredients (bottle → ml)
    ['ING030', 'INV030', 'Scotch whisky'],
    ['ING031', 'INV031', 'Indian whisky'],
    ['ING032', 'INV032', 'White rum'],
    ['ING033', 'INV033', 'London dry gin'],
    ['ING034', 'INV034', 'Swedish vodka'],
    ['ING035', 'INV035', 'Single malt scotch'],
    ['ING036', 'INV036', 'Blended scotch'],
    ['ING037', 'INV037', 'Beer bottle'],
    ['ING038', 'INV038', 'Beer bottle'],
    // Semi-finished as ingredients for recipes
    ['ING039', 'PRD001', 'Pre-made tomato base'],
    ['ING040', 'PRD002', 'Pre-made makhani base'],
    ['ING041', 'PRD003', 'Pre-made tikka paste'],
  ];

  for (let i = 0; i < ingredientData.length; i++) {
    const d = ingredientData[i];
    const r = i + 2;
    ws4.addRow({ ingId: d[0], itemId: d[1], name: null, unit: null, yield: null, wastage: null, notes: d[2] });

    ws4.getRow(r).getCell(3).value = { formula: `XLOOKUP(B${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws4.getRow(r).getCell(4).value = { formula: `XLOOKUP(B${r},MASTER_ITEMS!A:A,MASTER_ITEMS!E:E,"")` };
    ws4.getRow(r).getCell(5).value = { formula: `XLOOKUP(B${r},MASTER_ITEMS!A:A,MASTER_ITEMS!K:K,0)` };
    ws4.getRow(r).getCell(6).value = { formula: `XLOOKUP(B${r},MASTER_ITEMS!A:A,MASTER_ITEMS!L:L,0)` };
  }
  styleHeaders(ws4);
  markFormulaColumns(ws4, [3, 4, 5, 6], 2, ws4.rowCount);

  // ──────────────────────────────────────────────────────────────
  // SHEET 5: RECIPES  (Menu item recipes with ingredient quantities)
  // ──────────────────────────────────────────────────────────────
  const ws5 = workbook.addWorksheet('RECIPES', { properties: { tabColor: { argb: 'FF00B0F0' } } });
  ws5.columns = [
    { header: 'Recipe_ID',        key: 'recipeId', width: 12 },
    { header: 'Recipe_Name',      key: 'name',     width: 24 },
    { header: 'Menu_Item_ID',     key: 'menuId',   width: 14 },
    { header: 'Menu_Item_Name',   key: 'menuName', width: 24 },  // XLOOKUP
    { header: 'Variant',          key: 'variant',  width: 16 },
    { header: 'Ingredient_ID',    key: 'ingId',    width: 14 },
    { header: 'Ingredient_Name',  key: 'ingName',  width: 24 },  // XLOOKUP
    { header: 'Qty_Required',     key: 'qty',      width: 14 },
    { header: 'Unit',             key: 'unit',     width: 8  },   // XLOOKUP
    { header: 'Inv_Item_ID',      key: 'invId',    width: 12 },   // XLOOKUP (for stock deduction)
    { header: 'Prep_Time_Min',    key: 'prep',     width: 14 },
  ];

  const recipeData = [
    // Butter Chicken Recipe (Single portion)
    ['RCP001', 'Butter Chicken',        'MNU001', null, 'Single', 'ING001', null, 250, null, null, 30],
    ['RCP001', 'Butter Chicken',        'MNU001', null, 'Single', 'ING040', null, 200, null, null, ''],
    ['RCP001', 'Butter Chicken',        'MNU001', null, 'Single', 'ING009', null,  30, null, null, ''],
    ['RCP001', 'Butter Chicken',        'MNU001', null, 'Single', 'ING008', null,  20, null, null, ''],
    ['RCP001', 'Butter Chicken',        'MNU001', null, 'Single', 'ING022', null,   2, null, null, ''],
    ['RCP001', 'Butter Chicken',        'MNU001', null, 'Single', 'ING021', null,   3, null, null, ''],
    // Kadhai Paneer Recipe
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING004', null, 200, null, null, 20],
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING007', null,  50, null, null, ''],
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING006', null,  80, null, null, ''],
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING005', null, 100, null, null, ''],
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING023', null,  10, null, null, ''],
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING016', null,   5, null, null, ''],
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING020', null,   3, null, null, ''],
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING017', null,   2, null, null, ''],
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING011', null,  30, null, null, ''],
    ['RCP002', 'Kadhai Paneer',         'MNU002', null, '—',      'ING021', null,   3, null, null, ''],
    // Chicken Tikka Recipe
    ['RCP003', 'Chicken Tikka',         'MNU003', null, '—',      'ING001', null, 250, null, null, 25],
    ['RCP003', 'Chicken Tikka',         'MNU003', null, '—',      'ING041', null,  60, null, null, ''],
    ['RCP003', 'Chicken Tikka',         'MNU003', null, '—',      'ING010', null,  40, null, null, ''],
    ['RCP003', 'Chicken Tikka',         'MNU003', null, '—',      'ING011', null,  15, null, null, ''],
    ['RCP003', 'Chicken Tikka',         'MNU003', null, '—',      'ING026', null,  15, null, null, ''],
    ['RCP003', 'Chicken Tikka',         'MNU003', null, '—',      'ING021', null,   3, null, null, ''],
    // Tandoori Roti Recipe
    ['RCP004', 'Tandoori Roti',         'MNU004', null, '—',      'ING013', null,  80, null, null,  5],
    ['RCP004', 'Tandoori Roti',         'MNU004', null, '—',      'ING021', null,   1, null, null, ''],
    ['RCP004', 'Tandoori Roti',         'MNU004', null, '—',      'ING012', null,   5, null, null, ''],
    // Butter Naan Recipe
    ['RCP005', 'Butter Naan',           'MNU005', null, '—',      'ING014', null,  80, null, null,  5],
    ['RCP005', 'Butter Naan',           'MNU005', null, '—',      'ING008', null,  10, null, null, ''],
    ['RCP005', 'Butter Naan',           'MNU005', null, '—',      'ING010', null,  10, null, null, ''],
    ['RCP005', 'Butter Naan',           'MNU005', null, '—',      'ING021', null,   1, null, null, ''],
    ['RCP005', 'Butter Naan',           'MNU005', null, '—',      'ING025', null,   3, null, null, ''],
    // Dal Makhani Recipe
    ['RCP006', 'Dal Makhani',           'MNU006', null, '—',      'ING008', null,  40, null, null, 45],
    ['RCP006', 'Dal Makhani',           'MNU006', null, '—',      'ING009', null,  30, null, null, ''],
    ['RCP006', 'Dal Makhani',           'MNU006', null, '—',      'ING039', null, 100, null, null, ''],
    ['RCP006', 'Dal Makhani',           'MNU006', null, '—',      'ING023', null,  10, null, null, ''],
    ['RCP006', 'Dal Makhani',           'MNU006', null, '—',      'ING016', null,   5, null, null, ''],
    ['RCP006', 'Dal Makhani',           'MNU006', null, '—',      'ING017', null,   2, null, null, ''],
    ['RCP006', 'Dal Makhani',           'MNU006', null, '—',      'ING022', null,   2, null, null, ''],
    ['RCP006', 'Dal Makhani',           'MNU006', null, '—',      'ING021', null,   3, null, null, ''],
    // Jeera Rice Recipe
    ['RCP007', 'Jeera Rice',            'MNU007', null, '—',      'ING015', null, 100, null, null, 20],
    ['RCP007', 'Jeera Rice',            'MNU007', null, '—',      'ING012', null,  10, null, null, ''],
    ['RCP007', 'Jeera Rice',            'MNU007', null, '—',      'ING019', null,   3, null, null, ''],
    ['RCP007', 'Jeera Rice',            'MNU007', null, '—',      'ING021', null,   2, null, null, ''],
    // Egg Bhurji Recipe
    ['RCP008', 'Egg Bhurji',            'MNU008', null, '—',      'ING029', null,   3, null, null, 10],
    ['RCP008', 'Egg Bhurji',            'MNU008', null, '—',      'ING006', null,  50, null, null, ''],
    ['RCP008', 'Egg Bhurji',            'MNU008', null, '—',      'ING005', null,  30, null, null, ''],
    ['RCP008', 'Egg Bhurji',            'MNU008', null, '—',      'ING018', null,   2, null, null, ''],
    ['RCP008', 'Egg Bhurji',            'MNU008', null, '—',      'ING011', null,  15, null, null, ''],
    ['RCP008', 'Egg Bhurji',            'MNU008', null, '—',      'ING021', null,   2, null, null, ''],
    // Fresh Lime Soda Recipe
    ['RCP009', 'Fresh Lime Soda',       'MNU009', null, '—',      'ING026', null,  50, null, null,  5],
    ['RCP009', 'Fresh Lime Soda',       'MNU009', null, '—',      'ING025', null,  20, null, null, ''],
    ['RCP009', 'Fresh Lime Soda',       'MNU009', null, '—',      'ING028', null,   1, null, null, ''],
    ['RCP009', 'Fresh Lime Soda',       'MNU009', null, '—',      'ING021', null,   1, null, null, ''],
    ['RCP009', 'Fresh Lime Soda',       'MNU009', null, '—',      'ING027', null,   3, null, null, ''],
    // ─── LIQUOR RECIPES (CRITICAL: peg → ml deduction) ───
    ['RCP010', 'Monkey Shoulder 30ml',  'MNU010', null, 'Small 30 ML', 'ING030', null,  30, null, null, 0],
    ['RCP011', 'Monkey Shoulder 60ml',  'MNU010', null, 'Large 60 ML', 'ING030', null,  60, null, null, 0],
    ['RCP012', 'Royal Stag 30ml',       'MNU011', null, 'Small 30 ML', 'ING031', null,  30, null, null, 0],
    ['RCP013', 'Royal Stag 60ml',       'MNU011', null, 'Large 60 ML', 'ING031', null,  60, null, null, 0],
    ['RCP014', 'Bacardi White 30ml',    'MNU012', null, 'Small 30 ML', 'ING032', null,  30, null, null, 0],
    ['RCP015', 'Bacardi White 60ml',    'MNU012', null, 'Large 60 ML', 'ING032', null,  60, null, null, 0],
    ['RCP016', 'Bombay Sapphire 30ml',  'MNU013', null, 'Small 30 ML', 'ING033', null,  30, null, null, 0],
    ['RCP017', 'Bombay Sapphire 60ml',  'MNU013', null, 'Large 60 ML', 'ING033', null,  60, null, null, 0],
    ['RCP018', 'Absolut 30ml',          'MNU014', null, 'Small 30 ML', 'ING034', null,  30, null, null, 0],
    ['RCP019', 'Absolut 60ml',          'MNU014', null, 'Large 60 ML', 'ING034', null,  60, null, null, 0],
    ['RCP020', 'Glenfiddich 30ml',      'MNU015', null, 'Small 30 ML', 'ING035', null,  30, null, null, 0],
    ['RCP021', 'Glenfiddich 60ml',      'MNU015', null, 'Large 60 ML', 'ING035', null,  60, null, null, 0],
    ['RCP022', 'Black Label 30ml',      'MNU016', null, 'Small 30 ML', 'ING036', null,  30, null, null, 0],
    ['RCP023', 'Black Label 60ml',      'MNU016', null, 'Large 60 ML', 'ING036', null,  60, null, null, 0],
    ['RCP024', 'Budweiser 650ml',       'MNU017', null, '650 ML (Bottle)','ING037',null,650, null, null, 0],
    ['RCP025', 'Kingfisher Ultra 650ml','MNU018', null, '650 ML (Bottle)','ING038',null,650, null, null, 0],
  ];

  for (let i = 0; i < recipeData.length; i++) {
    const d = recipeData[i];
    const r = i + 2;
    ws5.addRow({
      recipeId: d[0], name: d[1], menuId: d[2], menuName: null, variant: d[4],
      ingId: d[5], ingName: null, qty: d[7], unit: null, invId: null, prep: d[10]
    });
    // XLOOKUP formulas
    ws5.getRow(r).getCell(4).value  = { formula: `XLOOKUP(C${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws5.getRow(r).getCell(7).value  = { formula: `XLOOKUP(F${r},INGREDIENTS!A:A,INGREDIENTS!C:C,"NOT FOUND")` };
    ws5.getRow(r).getCell(9).value  = { formula: `XLOOKUP(F${r},INGREDIENTS!A:A,INGREDIENTS!D:D,"")` };
    ws5.getRow(r).getCell(10).value = { formula: `XLOOKUP(F${r},INGREDIENTS!A:A,INGREDIENTS!B:B,"")` };
  }
  styleHeaders(ws5);
  markFormulaColumns(ws5, [4, 7, 9, 10], 2, ws5.rowCount);

  // Highlight liquor recipe rows
  for (let r = 2; r <= ws5.rowCount; r++) {
    const id = ws5.getRow(r).getCell(1).value;
    if (id && parseInt(id.replace('RCP', '')) >= 10) {
      for (let c = 1; c <= 11; c++) ws5.getRow(r).getCell(c).fill = LIQUOR_FILL;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // SHEET 6: PRODUCTION_RECIPES
  // ──────────────────────────────────────────────────────────────
  const ws6 = workbook.addWorksheet('PRODUCTION_RECIPES', { properties: { tabColor: { argb: 'FFB381D9' } } });
  ws6.columns = [
    { header: 'Production_ID',    key: 'prodId',    width: 14 },
    { header: 'Production_Name',  key: 'name',      width: 22 },
    { header: 'Output_Item_ID',   key: 'outId',     width: 14 },
    { header: 'Output_Item_Name', key: 'outName',   width: 22 },  // XLOOKUP
    { header: 'Output_Qty',       key: 'outQty',    width: 12 },
    { header: 'Output_Unit',      key: 'outUnit',   width: 12 },  // XLOOKUP
    { header: 'Input_Item_ID',    key: 'inItemId',  width: 14 },
    { header: 'Input_Item_Name',  key: 'inName',    width: 24 },  // XLOOKUP
    { header: 'Input_Qty',        key: 'inQty',     width: 12 },
    { header: 'Input_Unit',       key: 'inUnit',    width: 12 },  // XLOOKUP
    { header: 'Prep_Time_Min',    key: 'prep',      width: 14 },
    { header: 'Instructions',     key: 'notes',     width: 35 },
  ];

  const prodData = [
    // Tomato Gravy Production (output 5L)
    ['PRC001', 'Tomato Gravy',   'PRD001', null, 5, null, 'INV005', null, 2000, null, 45, 'Blanch tomatoes cook and blend'],
    ['PRC001', 'Tomato Gravy',   'PRD001', null, 5, null, 'INV006', null, 1000, null, '',  ''],
    ['PRC001', 'Tomato Gravy',   'PRD001', null, 5, null, 'INV011', null,  200, null, '',  ''],
    ['PRC001', 'Tomato Gravy',   'PRD001', null, 5, null, 'INV023', null,  100, null, '',  ''],
    ['PRC001', 'Tomato Gravy',   'PRD001', null, 5, null, 'INV016', null,   30, null, '',  ''],
    ['PRC001', 'Tomato Gravy',   'PRD001', null, 5, null, 'INV018', null,   10, null, '',  ''],
    ['PRC001', 'Tomato Gravy',   'PRD001', null, 5, null, 'INV020', null,   20, null, '',  ''],
    ['PRC001', 'Tomato Gravy',   'PRD001', null, 5, null, 'INV021', null,   40, null, '',  ''],
    // Makhani Gravy Production (output 5L)
    ['PRC002', 'Makhani Gravy',  'PRD002', null, 5, null, 'PRD001', null, 3000, null, 30, 'Cook tomato gravy with butter cream cashew'],
    ['PRC002', 'Makhani Gravy',  'PRD002', null, 5, null, 'INV008', null,  300, null, '',  ''],
    ['PRC002', 'Makhani Gravy',  'PRD002', null, 5, null, 'INV009', null,  500, null, '',  ''],
    ['PRC002', 'Makhani Gravy',  'PRD002', null, 5, null, 'INV024', null,  200, null, '',  ''],
    ['PRC002', 'Makhani Gravy',  'PRD002', null, 5, null, 'INV016', null,   20, null, '',  ''],
    ['PRC002', 'Makhani Gravy',  'PRD002', null, 5, null, 'INV017', null,   15, null, '',  ''],
    ['PRC002', 'Makhani Gravy',  'PRD002', null, 5, null, 'INV022', null,   10, null, '',  ''],
    ['PRC002', 'Makhani Gravy',  'PRD002', null, 5, null, 'INV025', null,   20, null, '',  ''],
    ['PRC002', 'Makhani Gravy',  'PRD002', null, 5, null, 'INV021', null,   30, null, '',  ''],
    // Tikka Marinade Production (output 2kg)
    ['PRC003', 'Tikka Marinade', 'PRD003', null, 2, null, 'INV010', null, 1000, null, 15, 'Mix all into smooth paste'],
    ['PRC003', 'Tikka Marinade', 'PRD003', null, 2, null, 'INV023', null,  200, null, '',  ''],
    ['PRC003', 'Tikka Marinade', 'PRD003', null, 2, null, 'INV016', null,  100, null, '',  ''],
    ['PRC003', 'Tikka Marinade', 'PRD003', null, 2, null, 'INV017', null,   50, null, '',  ''],
    ['PRC003', 'Tikka Marinade', 'PRD003', null, 2, null, 'INV018', null,   20, null, '',  ''],
    ['PRC003', 'Tikka Marinade', 'PRD003', null, 2, null, 'INV011', null,  200, null, '',  ''],
    ['PRC003', 'Tikka Marinade', 'PRD003', null, 2, null, 'INV026', null,  100, null, '',  ''],
    ['PRC003', 'Tikka Marinade', 'PRD003', null, 2, null, 'INV021', null,   40, null, '',  ''],
  ];

  for (let i = 0; i < prodData.length; i++) {
    const d = prodData[i];
    const r = i + 2;
    ws6.addRow({
      prodId: d[0], name: d[1], outId: d[2], outName: null, outQty: d[4], outUnit: null,
      inItemId: d[6], inName: null, inQty: d[8], inUnit: null, prep: d[10], notes: d[11]
    });
    ws6.getRow(r).getCell(4).value  = { formula: `XLOOKUP(C${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws6.getRow(r).getCell(6).value  = { formula: `XLOOKUP(C${r},MASTER_ITEMS!A:A,MASTER_ITEMS!E:E,"")` };
    ws6.getRow(r).getCell(8).value  = { formula: `XLOOKUP(G${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws6.getRow(r).getCell(10).value = { formula: `XLOOKUP(G${r},MASTER_ITEMS!A:A,MASTER_ITEMS!E:E,"")` };
  }
  styleHeaders(ws6);
  markFormulaColumns(ws6, [4, 6, 8, 10], 2, ws6.rowCount);

  // ──────────────────────────────────────────────────────────────
  // SHEET 7: SALES_SIMULATION
  // ──────────────────────────────────────────────────────────────
  const ws7 = workbook.addWorksheet('SALES_SIMULATION', { properties: { tabColor: { argb: 'FFFF0000' } } });
  ws7.columns = [
    { header: 'Order_ID',            key: 'orderId',   width: 12 },
    { header: 'Menu_Item_ID',        key: 'menuId',    width: 14 },
    { header: 'Menu_Item_Name',      key: 'menuName',  width: 24 },  // XLOOKUP
    { header: 'Variant',             key: 'variant',   width: 16 },
    { header: 'Qty_Sold',            key: 'qtySold',   width: 10 },
    { header: 'Selling_Price',       key: 'price',     width: 14 },
    { header: 'Total_Revenue',       key: 'revenue',   width: 14 },  // formula
    { header: 'Recipe_ID',           key: 'recipeId',  width: 12 },
    { header: 'Ingredients_Used',    key: 'ingUsed',   width: 45 },  // text summary
  ];

  const salesData = [
    ['ORD001', 'MNU001', null, 'Single',          2, 329, null, 'RCP001', 'Chicken 500g, Makhani 400ml, Cream 60ml, Butter 40g'],
    ['ORD001', 'MNU004', null, '—',               4,  30, null, 'RCP004', 'Wheat Flour 320g, Salt 4g, Ghee 20g'],
    ['ORD001', 'MNU005', null, '—',               2,  50, null, 'RCP005', 'Maida 160g, Butter 20g, Curd 20ml'],
    ['ORD001', 'MNU007', null, '—',               2, 159, null, 'RCP007', 'Rice 200g, Ghee 20g, Cumin 6g'],
    ['ORD002', 'MNU002', null, '—',               1, 329, null, 'RCP002', 'Paneer 200g, Capsicum 50g, Onion 80g'],
    ['ORD002', 'MNU006', null, '—',               1, 289, null, 'RCP006', 'Butter 40g, Cream 30ml, Tomato Gravy 100ml'],
    ['ORD002', 'MNU010', null, 'Large 60 ML',     2, 570, null, 'RCP011', 'Monkey Shoulder 120ml (2 x 60ml pegs)'],
    ['ORD003', 'MNU010', null, 'Small 30 ML',     3, 335, null, 'RCP010', 'Monkey Shoulder 90ml (3 x 30ml pegs)'],
    ['ORD003', 'MNU011', null, 'Large 60 ML',     1, 210, null, 'RCP013', 'Royal Stag 60ml (1 x 60ml peg)'],
    ['ORD003', 'MNU017', null, '650 ML (Bottle)', 2, 480, null, 'RCP024', 'Budweiser 1300ml (2 bottles)'],
    ['ORD004', 'MNU003', null, '—',               2, 379, null, 'RCP003', 'Chicken 500g, Tikka Marinade 120g, Curd 80ml'],
    ['ORD004', 'MNU009', null, '—',               2,  99, null, 'RCP009', 'Lemon 100g, Sugar 40g, Soda 2btl'],
    ['ORD004', 'MNU015', null, 'Small 30 ML',     1, 380, null, 'RCP020', 'Glenfiddich 30ml (1 x 30ml peg)'],
    ['ORD005', 'MNU008', null, '—',               3, 149, null, 'RCP008', 'Egg 9pcs, Onion 150g, Tomato 90g'],
  ];

  for (let i = 0; i < salesData.length; i++) {
    const d = salesData[i];
    const r = i + 2;
    ws7.addRow({
      orderId: d[0], menuId: d[1], menuName: null, variant: d[3],
      qtySold: d[4], price: d[5], revenue: null, recipeId: d[7], ingUsed: d[8]
    });
    ws7.getRow(r).getCell(3).value = { formula: `XLOOKUP(B${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws7.getRow(r).getCell(7).value = { formula: `E${r}*F${r}` };
  }
  styleHeaders(ws7);
  markFormulaColumns(ws7, [3, 7], 2, ws7.rowCount);

  // ──────────────────────────────────────────────────────────────
  // SHEET 8: STOCK_MOVEMENT
  // ──────────────────────────────────────────────────────────────
  const ws8 = workbook.addWorksheet('STOCK_MOVEMENT', { properties: { tabColor: { argb: 'FF808080' } } });
  ws8.columns = [
    { header: 'Transaction_ID',   key: 'txnId',    width: 16 },
    { header: 'Item_ID',          key: 'itemId',   width: 12 },
    { header: 'Transaction_Type', key: 'type',     width: 18 },
    { header: 'Qty_Change',       key: 'qty',      width: 14 },
    { header: 'Item_Name',        key: 'name',     width: 26 },  // XLOOKUP
    { header: 'Unit',             key: 'unit',     width: 8  },   // XLOOKUP
    { header: 'Reference_ID',     key: 'refId',    width: 14 },
    { header: 'Date',             key: 'date',     width: 14 },
    { header: 'Notes',            key: 'notes',    width: 30 },
  ];

  const movementData = [
    // Purchase movements
    ['TXN001', 'INV001', 'Purchase',   20000, null, null, 'PO-001',  '2026-03-15', 'Opening stock 20kg chicken'],
    ['TXN002', 'INV004', 'Purchase',   15000, null, null, 'PO-001',  '2026-03-15', 'Opening stock 15kg paneer'],
    ['TXN003', 'INV030', 'Purchase',    3000, null, null, 'PO-002',  '2026-03-15', 'Monkey Shoulder 4 bottles (4x750ml)'],
    ['TXN004', 'INV031', 'Purchase',    7500, null, null, 'PO-002',  '2026-03-15', 'Royal Stag 10 bottles (10x750ml)'],
    ['TXN005', 'INV037', 'Purchase',   31200, null, null, 'PO-002',  '2026-03-15', 'Budweiser 48 bottles (48x650ml)'],
    // Sale deductions (from ORD001)
    ['TXN006', 'INV001', 'Sale',         500, null, null, 'ORD001',  '2026-03-20', '2x Butter Chicken (2x250g)'],
    ['TXN007', 'PRD002', 'Sale',         400, null, null, 'ORD001',  '2026-03-20', '2x Makhani Gravy (2x200ml)'],
    ['TXN008', 'INV013', 'Sale',         320, null, null, 'ORD001',  '2026-03-20', '4x Tandoori Roti flour (4x80g)'],
    // Liquor sale movements (from ORD002 & ORD003)
    ['TXN009', 'INV030', 'Sale',         120, null, null, 'ORD002',  '2026-03-20', 'Monkey Shoulder 2x60ml pegs'],
    ['TXN010', 'INV030', 'Sale',          90, null, null, 'ORD003',  '2026-03-20', 'Monkey Shoulder 3x30ml pegs'],
    ['TXN011', 'INV031', 'Sale',          60, null, null, 'ORD003',  '2026-03-20', 'Royal Stag 1x60ml peg'],
    ['TXN012', 'INV037', 'Sale',        1300, null, null, 'ORD003',  '2026-03-20', 'Budweiser 2 bottles (2x650ml)'],
    // Production movements
    ['TXN013', 'INV005', 'Production',  2000, null, null, 'PRC001',  '2026-03-20', 'Tomato for gravy production'],
    ['TXN014', 'INV006', 'Production',  1000, null, null, 'PRC001',  '2026-03-20', 'Onion for gravy production'],
    ['TXN015', 'PRD001', 'Production',  5000, null, null, 'PRC001',  '2026-03-20', 'Tomato Gravy produced 5L'],
    // Wastage
    ['TXN016', 'INV005', 'Wastage',      500, null, null, 'WST001',  '2026-03-20', 'Rotten tomatoes 500g'],
    // Cancel reversal
    ['TXN017', 'INV001', 'Cancel',        250, null, null, 'ORD005-C','2026-03-20', 'Order cancelled — chicken returned'],
  ];

  for (let i = 0; i < movementData.length; i++) {
    const d = movementData[i];
    const r = i + 2;
    ws8.addRow({
      txnId: d[0], itemId: d[1], type: d[2], qty: d[3],
      name: null, unit: null, refId: d[6], date: d[7], notes: d[8]
    });
    ws8.getRow(r).getCell(5).value = { formula: `XLOOKUP(B${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws8.getRow(r).getCell(6).value = { formula: `XLOOKUP(B${r},MASTER_ITEMS!A:A,MASTER_ITEMS!E:E,"")` };
  }
  styleHeaders(ws8);
  markFormulaColumns(ws8, [5, 6], 2, ws8.rowCount);

  // ──────────────────────────────────────────────────────────────
  // SHEET 9: WASTAGE_TRACKING
  // ──────────────────────────────────────────────────────────────
  const ws9 = workbook.addWorksheet('WASTAGE_TRACKING', { properties: { tabColor: { argb: 'FFFF6600' } } });
  ws9.columns = [
    { header: 'Wastage_ID',   key: 'wstId',   width: 12 },
    { header: 'Item_ID',      key: 'itemId',  width: 12 },
    { header: 'Item_Name',    key: 'name',    width: 26 },  // XLOOKUP
    { header: 'Qty_Wasted',   key: 'qty',     width: 14 },
    { header: 'Unit',         key: 'unit',    width: 8  },   // XLOOKUP
    { header: 'Wastage_Type', key: 'type',    width: 16 },
    { header: 'Reason',       key: 'reason',  width: 30 },
    { header: 'Date',         key: 'date',    width: 14 },
  ];

  const wastageData = [
    ['WST001', 'INV005', null,  500, null, 'Spoilage',     'Rotten tomatoes',          '2026-03-20'],
    ['WST002', 'INV009', null,  200, null, 'Spoilage',     'Cream expired',            '2026-03-20'],
    ['WST003', 'INV030', null,   15, null, 'Spillage',     'Bottle handling spillage',  '2026-03-20'],
    ['WST004', 'INV001', null,  250, null, 'Order Cancel', 'Item cancelled after KOT',  '2026-03-20'],
    ['WST005', 'INV029', null,    2, null, 'Spoilage',     'Broken eggs',              '2026-03-20'],
  ];

  for (let i = 0; i < wastageData.length; i++) {
    const d = wastageData[i];
    const r = i + 2;
    ws9.addRow({ wstId: d[0], itemId: d[1], name: null, qty: d[3], unit: null, type: d[5], reason: d[6], date: d[7] });
    ws9.getRow(r).getCell(3).value = { formula: `XLOOKUP(B${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws9.getRow(r).getCell(5).value = { formula: `XLOOKUP(B${r},MASTER_ITEMS!A:A,MASTER_ITEMS!E:E,"")` };
  }
  styleHeaders(ws9);
  markFormulaColumns(ws9, [3, 5], 2, ws9.rowCount);

  // ──────────────────────────────────────────────────────────────
  // SHEET 10: UNIT_REFERENCE
  // ──────────────────────────────────────────────────────────────
  const ws10 = workbook.addWorksheet('UNIT_REFERENCE', { properties: { tabColor: { argb: 'FF404040' } } });
  ws10.columns = [
    { header: 'Abbreviation',     key: 'abbr',   width: 14 },
    { header: 'Full_Name',        key: 'name',   width: 16 },
    { header: 'Unit_Type',        key: 'type',   width: 12 },
    { header: 'Conversion_Factor',key: 'factor', width: 20 },
    { header: 'Is_Base_Unit',     key: 'base',   width: 14 },
    { header: 'Example',          key: 'ex',     width: 35 },
  ];

  const unitData = [
    ['g',   'Gram',       'weight', 1,      'Yes', 'Base unit for weight'],
    ['kg',  'Kilogram',   'weight', 1000,   'No',  '1 kg = 1000 g'],
    ['mg',  'Milligram',  'weight', 0.001,  'No',  '1 mg = 0.001 g'],
    ['qtl', 'Quintal',    'weight', 100000, 'No',  '1 qtl = 100 kg = 100000 g'],
    ['ml',  'Millilitre', 'volume', 1,      'Yes', 'Base unit for volume'],
    ['l',   'Litre',      'volume', 1000,   'No',  '1 l = 1000 ml'],
    ['cl',  'Centilitre', 'volume', 10,     'No',  '1 cl = 10 ml'],
    ['pcs', 'Piece',      'count',  1,      'Yes', 'Base unit for countable items'],
    ['dz',  'Dozen',      'count',  12,     'No',  '1 dozen = 12 pieces'],
    ['btl', 'Bottle',     'count',  1,      'No',  'Varies: 750ml whisky, 650ml beer'],
    ['pkt', 'Packet',     'count',  1,      'No',  'Varies by product'],
    ['box', 'Box',        'count',  1,      'No',  'Varies by product'],
    ['can', 'Can',        'count',  1,      'No',  'Varies by product'],
  ];

  for (const u of unitData) {
    ws10.addRow({ abbr: u[0], name: u[1], type: u[2], factor: u[3], base: u[4], ex: u[5] });
  }
  styleHeaders(ws10);

  // ──────────────────────────────────────────────────────────────
  // SHEET 11: LIQUOR_CALCULATION (Special calculator sheet)
  // ──────────────────────────────────────────────────────────────
  const ws11 = workbook.addWorksheet('LIQUOR_CALCULATOR', { properties: { tabColor: { argb: 'FFFF0000' } } });
  ws11.columns = [
    { header: 'Item_ID',           key: 'id',          width: 12 },
    { header: 'Liquor_Name',       key: 'name',        width: 26 },  // XLOOKUP
    { header: 'Bottles_In_Stock',  key: 'bottles',     width: 18 },
    { header: 'ML_Per_Bottle',     key: 'mlPerBottle', width: 16 },  // XLOOKUP
    { header: 'Total_ML',          key: 'totalMl',     width: 12 },  // formula
    { header: 'Pegs_30ml_Sold',    key: 'pegs30',      width: 16 },
    { header: 'Pegs_60ml_Sold',    key: 'pegs60',      width: 16 },
    { header: 'Total_ML_Sold',     key: 'mlSold',      width: 14 },  // formula
    { header: 'ML_Remaining',      key: 'mlRemain',    width: 14 },  // formula
    { header: 'Bottles_Remaining', key: 'btlRemain',   width: 18 },  // formula
    { header: 'Pegs_30ml_Left',    key: 'pegsLeft30',  width: 16 },  // formula
    { header: 'Pegs_60ml_Left',    key: 'pegsLeft60',  width: 16 },  // formula
  ];

  const liquorCalcData = [
    ['INV030', null,  4, null, null, 8, 3, null, null, null, null, null],
    ['INV031', null, 10, null, null, 15, 5, null, null, null, null, null],
    ['INV032', null,  6, null, null, 5, 4, null, null, null, null, null],
    ['INV033', null,  3, null, null, 3, 2, null, null, null, null, null],
    ['INV034', null,  5, null, null, 6, 3, null, null, null, null, null],
    ['INV035', null,  2, null, null, 2, 1, null, null, null, null, null],
    ['INV036', null,  3, null, null, 4, 2, null, null, null, null, null],
  ];

  for (let i = 0; i < liquorCalcData.length; i++) {
    const d = liquorCalcData[i];
    const r = i + 2;
    ws11.addRow({
      id: d[0], name: null, bottles: d[2], mlPerBottle: null, totalMl: null,
      pegs30: d[5], pegs60: d[6], mlSold: null, mlRemain: null, btlRemain: null,
      pegsLeft30: null, pegsLeft60: null
    });
    // XLOOKUP formulas
    ws11.getRow(r).getCell(2).value  = { formula: `XLOOKUP(A${r},MASTER_ITEMS!A:A,MASTER_ITEMS!B:B,"NOT FOUND")` };
    ws11.getRow(r).getCell(4).value  = { formula: `XLOOKUP(A${r},MASTER_ITEMS!A:A,MASTER_ITEMS!G:G,0)` };
    // Total_ML = Bottles * ML_Per_Bottle
    ws11.getRow(r).getCell(5).value  = { formula: `C${r}*D${r}` };
    // Total_ML_Sold = (Pegs_30ml * 30) + (Pegs_60ml * 60)
    ws11.getRow(r).getCell(8).value  = { formula: `(F${r}*30)+(G${r}*60)` };
    // ML_Remaining = Total_ML - Total_ML_Sold
    ws11.getRow(r).getCell(9).value  = { formula: `E${r}-H${r}` };
    // Bottles_Remaining = ML_Remaining / ML_Per_Bottle
    ws11.getRow(r).getCell(10).value = { formula: `ROUND(I${r}/D${r},2)` };
    // Pegs_30ml_Left = FLOOR(ML_Remaining / 30)
    ws11.getRow(r).getCell(11).value = { formula: `INT(I${r}/30)` };
    // Pegs_60ml_Left = FLOOR(ML_Remaining / 60)
    ws11.getRow(r).getCell(12).value = { formula: `INT(I${r}/60)` };
  }
  styleHeaders(ws11);
  markFormulaColumns(ws11, [2, 4, 5, 8, 9, 10, 11, 12], 2, ws11.rowCount);
  // Highlight whole sheet with liquor color
  for (let r = 2; r <= ws11.rowCount; r++) {
    for (let c = 1; c <= 12; c++) {
      if (!ws11.getRow(r).getCell(c).fill || !ws11.getRow(r).getCell(c).fill.fgColor) {
        ws11.getRow(r).getCell(c).fill = LIQUOR_FILL;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // SAVE
  // ──────────────────────────────────────────────────────────────
  const outputPath = path.join(__dirname, '..', 'csv-templates', 'MASTER_RESTAURANT_WORKBOOK.xlsx');
  await workbook.xlsx.writeFile(outputPath);
  console.log(`\n✅ Master workbook generated: ${outputPath}`);
  console.log(`\n📊 Sheets created:`);
  console.log(`   1. MASTER_ITEMS        — ${MASTER_ITEMS.length} items (single source of truth)`);
  console.log(`   2. MENU_ITEMS          — ${menuData.length} rows with XLOOKUP names`);
  console.log(`   3. INVENTORY_STOCK     — ${stockData.length} items with conversion formulas`);
  console.log(`   4. INGREDIENTS         — ${ingredientData.length} ingredient-to-inventory mappings`);
  console.log(`   5. RECIPES             — ${recipeData.length} recipe ingredient rows`);
  console.log(`   6. PRODUCTION_RECIPES  — ${prodData.length} production input rows`);
  console.log(`   7. SALES_SIMULATION    — ${salesData.length} sample orders`);
  console.log(`   8. STOCK_MOVEMENT      — ${movementData.length} transaction records`);
  console.log(`   9. WASTAGE_TRACKING    — ${wastageData.length} wastage entries`);
  console.log(`  10. UNIT_REFERENCE      — ${unitData.length} unit definitions`);
  console.log(`  11. LIQUOR_CALCULATOR   — ${liquorCalcData.length} liquor items with peg calculation`);
  console.log(`\n🔗 All sheets connected via XLOOKUP on Item_ID`);
  console.log(`🥃 Liquor logic: bottle(750ml) → pegs(30/60ml) with remaining calculation`);
  console.log(`🏭 Production chain: Raw materials → Semi-finished → Menu recipes`);
  console.log(`\n💡 Open in Excel/Google Sheets — yellow cells are auto-calculated formulas`);
}

generate().catch(err => {
  console.error('Error generating workbook:', err);
  process.exit(1);
});
