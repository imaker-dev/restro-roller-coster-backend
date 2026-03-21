#!/usr/bin/env node
/**
 * Generate Master Restaurant Excel Workbook — v3 (Production Grade)
 * 
 * VERIFIED AGAINST: bulkUpload.service.js, inventory.service.js, ingredient.service.js,
 * recipe.service.js, production.service.js, wastage.service.js, unit.service.js
 *
 * FORMULA: INDEX/MATCH (works in Excel 2007+, Google Sheets, LibreOffice)
 * Usage: node scripts/generate-master-workbook-v3.js
 */

const ExcelJS = require('exceljs');
const path = require('path');

// ═══ HELPERS ═══
function IM(cell, sheet, lCol, rCol, fb) {
  const f = fb === undefined ? '""' : typeof fb === 'string' ? `"${fb}"` : fb;
  return `IFERROR(INDEX(${sheet}!$${rCol}:$${rCol},MATCH(${cell},${sheet}!$${lCol}:$${lCol},0)),${f})`;
}

const HFILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
const HFONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const FFILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
const LFILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
const PFILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2D9F3' } };
const CFILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6E4F0' } };
const IFILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
const BDR = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} };

function sH(ws) {
  const r = ws.getRow(1);
  r.eachCell(c => { c.fill=HFILL; c.font=HFONT; c.border=BDR; c.alignment={vertical:'middle',horizontal:'center',wrapText:true}; });
  r.height = 30;
  ws.autoFilter = { from:'A1', to:{row:1,column:ws.columnCount} };
  ws.views = [{ state:'frozen', ySplit:1 }];
}
function mF(ws,cols,s,e) { for(let r=s;r<=e;r++) for(const c of cols) ws.getRow(r).getCell(c).fill=FFILL; }
function pR(ws,r,fill,n) { for(let c=1;c<=n;c++) ws.getRow(r).getCell(c).fill=fill; }

const INV='INVENTORY_ITEMS', ING='INGREDIENTS', UR='UNIT_REFERENCE';

async function generate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Restro POS'; wb.created = new Date();

  // ═══ SHEET 1: MENU_ITEMS — exact CSV format for bulkUpload.service.js ═══
  const ws1 = wb.addWorksheet('MENU_ITEMS', {properties:{tabColor:{argb:'FF00B050'}}});
  ws1.columns = [
    {header:'Type',key:'t',width:14},{header:'Name',key:'n',width:30},{header:'Category',key:'c',width:26},
    {header:'Price',key:'p',width:10},{header:'ItemType',key:'it',width:12},{header:'GST',key:'g',width:6},
    {header:'VAT',key:'v',width:6},{header:'Station',key:'s',width:10},{header:'Description',key:'d',width:28},
    {header:'Parent',key:'pa',width:20},{header:'ShortName',key:'sn',width:16},{header:'SKU',key:'sk',width:12},
    {header:'Default',key:'df',width:8},{header:'SelectionType',key:'st',width:14},{header:'Min',key:'mi',width:5},
    {header:'Max',key:'mx',width:5},{header:'Required',key:'rq',width:10},{header:'Group',key:'gr',width:20},
    {header:'Item',key:'im',width:26},{header:'ServiceType',key:'sv',width:14}
  ];

  const M = [
    // CATEGORIES
    {t:'CATEGORY',n:'Chinese Non Veg Starter',d:'Chinese Non Veg Starter',sv:'restaurant'},
    {t:'CATEGORY',n:'Chinese Veg Starter',d:'Chinese Veg Starter',sv:'restaurant'},
    {t:'CATEGORY',n:'Main Course Non Veg',d:'Main Course Non Veg',sv:'restaurant'},
    {t:'CATEGORY',n:'Main Course Veg',d:'Main Course Veg',sv:'restaurant'},
    {t:'CATEGORY',n:'Tandoor Non Veg Starter',d:'Tandoor Non Veg Starter',sv:'restaurant'},
    {t:'CATEGORY',n:'Breads',d:'Breads',sv:'restaurant'},
    {t:'CATEGORY',n:'Dal',d:'Dal',sv:'restaurant'},
    {t:'CATEGORY',n:'Khushbu & Basmati',d:'Khushbu & Basmati',sv:'restaurant'},
    {t:'CATEGORY',n:'Eggs',d:'Eggs',sv:'restaurant'},
    {t:'CATEGORY',n:'Beverage',d:'Beverage',sv:'both'},
    {t:'CATEGORY',n:'Whisky',d:'Whisky',sv:'bar'},
    {t:'CATEGORY',n:'Rum',d:'Rum',sv:'bar'},
    {t:'CATEGORY',n:'Gin',d:'Gin',sv:'bar'},
    {t:'CATEGORY',n:'Vodka',d:'Vodka',sv:'bar'},
    {t:'CATEGORY',n:'Beer',d:'Beer',sv:'bar'},
    {t:'CATEGORY',n:'Single Malt',d:'Single Malt',sv:'bar'},
    {t:'CATEGORY',n:'Blended Scotch',d:'Blended Scotch',sv:'bar'},
    // RESTAURANT ITEMS (GST 5%, Kitchen)
    {t:'ITEM',n:'Chilli Chicken Dry',c:'Chinese Non Veg Starter',p:319,it:'non_veg',g:5,s:'Kitchen',sn:'Chil Chic Dry',sk:'CHI001',sv:'restaurant'},
    {t:'ITEM',n:'Chilli Paneer Dry',c:'Chinese Veg Starter',p:289,it:'veg',g:5,s:'Kitchen',sn:'Chil Pane Dry',sk:'CHI032',sv:'restaurant'},
    {t:'ITEM',n:'Butter Chicken',c:'Main Course Non Veg',p:329,it:'non_veg',g:5,s:'Kitchen',sn:'Butt Chic',sk:'MNC001',sv:'restaurant'},
    {t:'VARIANT',n:'Single',p:329,df:'no',im:'Butter Chicken'},
    {t:'VARIANT',n:'Family',p:499,df:'no',im:'Butter Chicken'},
    {t:'ITEM',n:'Kadhai Paneer',c:'Main Course Veg',p:329,it:'veg',g:5,s:'Kitchen',sn:'Kadh Pane',sk:'MCV001',sv:'restaurant'},
    {t:'ITEM',n:'Chicken Tikka',c:'Tandoor Non Veg Starter',p:379,it:'non_veg',g:5,s:'Kitchen',sn:'Chic Tikk',sk:'TND001',sv:'restaurant'},
    {t:'ITEM',n:'Tandoori Roti',c:'Breads',p:30,it:'veg',g:5,s:'Kitchen',sn:'Tand Roti',sk:'BRD001',sv:'restaurant'},
    {t:'ITEM',n:'Butter Naan',c:'Breads',p:50,it:'veg',g:5,s:'Kitchen',sn:'Butt Naan',sk:'BRD002',sv:'restaurant'},
    {t:'ITEM',n:'Dal Makhani',c:'Dal',p:289,it:'veg',g:5,s:'Kitchen',sn:'Dal Makh',sk:'DAL001',sv:'restaurant'},
    {t:'ITEM',n:'Jeera Rice',c:'Khushbu & Basmati',p:159,it:'veg',g:5,s:'Kitchen',sn:'Jeer Rice',sk:'KHB001',sv:'restaurant'},
    {t:'ITEM',n:'Egg Bhurji',c:'Eggs',p:149,it:'egg',g:5,s:'Kitchen',sn:'Egg Bhur',sk:'EGG001',sv:'restaurant'},
    {t:'ITEM',n:'Fresh Lime Soda',c:'Beverage',p:99,it:'veg',g:5,s:'Kitchen',sn:'Fres Lime',sk:'BEV001',sv:'both'},
    // BAR ITEMS (VAT 18%, Bar station)
    {t:'ITEM',n:'Monkey Shoulder',c:'Whisky',it:'veg',v:18,s:'Bar',sn:'Monk Shou',sk:'WHI001',sv:'bar'},
    {t:'VARIANT',n:'Small 30 ML',p:335,df:'no',im:'Monkey Shoulder'},
    {t:'VARIANT',n:'Large 60 ML',p:570,df:'no',im:'Monkey Shoulder'},
    {t:'ITEM',n:'Royal Stag',c:'Whisky',it:'veg',v:18,s:'Bar',sn:'Roya Stag',sk:'WHI002',sv:'bar'},
    {t:'VARIANT',n:'Small 30 ML',p:110,df:'no',im:'Royal Stag'},
    {t:'VARIANT',n:'Large 60 ML',p:210,df:'no',im:'Royal Stag'},
    {t:'ITEM',n:'Bacardi White',c:'Rum',it:'veg',v:18,s:'Bar',sn:'Baca Whit',sk:'RUM001',sv:'bar'},
    {t:'VARIANT',n:'Small 30 ML',p:110,df:'no',im:'Bacardi White'},
    {t:'VARIANT',n:'Large 60 ML',p:220,df:'no',im:'Bacardi White'},
    {t:'ITEM',n:'Bombay Sapphire',c:'Gin',it:'veg',v:18,s:'Bar',sn:'Bomb Sapp',sk:'GIN001',sv:'bar'},
    {t:'VARIANT',n:'Small 30 ML',p:200,df:'no',im:'Bombay Sapphire'},
    {t:'VARIANT',n:'Large 60 ML',p:360,df:'no',im:'Bombay Sapphire'},
    {t:'ITEM',n:'Absolut',c:'Vodka',it:'veg',v:18,s:'Bar',sn:'Absolut',sk:'VOD001',sv:'bar'},
    {t:'VARIANT',n:'Small 30 ML',p:195,df:'no',im:'Absolut'},
    {t:'VARIANT',n:'Large 60 ML',p:335,df:'no',im:'Absolut'},
    {t:'ITEM',n:'Glenfiddich',c:'Single Malt',it:'veg',v:18,s:'Bar',sn:'Glenfiddic',sk:'SIN001',sv:'bar'},
    {t:'VARIANT',n:'Small 30 ML',p:380,df:'no',im:'Glenfiddich'},
    {t:'VARIANT',n:'Large 60 ML',p:715,df:'no',im:'Glenfiddich'},
    {t:'ITEM',n:'Black Label',c:'Blended Scotch',it:'veg',v:18,s:'Bar',sn:'Blac Labe',sk:'BLE001',sv:'bar'},
    {t:'VARIANT',n:'Small 30 ML',p:285,df:'no',im:'Black Label'},
    {t:'VARIANT',n:'Large 60 ML',p:525,df:'no',im:'Black Label'},
    {t:'ITEM',n:'Budweiser 650ml',c:'Beer',p:480,it:'veg',v:18,s:'Bar',sn:'Budw 650',sk:'BER001',sv:'bar'},
    {t:'ITEM',n:'Kingfisher Ultra',c:'Beer',p:430,it:'veg',v:18,s:'Bar',sn:'King Ultr',sk:'BER002',sv:'bar'},
    // ADDON GROUP example
    {t:'ADDON_GROUP',n:'Extra Cheese',st:'single',mi:0,mx:1,rq:'no'},
    {t:'ADDON',n:'Add Cheese',p:49,it:'veg',gr:'Extra Cheese'},
  ];
  for (const d of M) ws1.addRow(d);
  sH(ws1);
  for (let r=2;r<=ws1.rowCount;r++) {
    const t = String(ws1.getRow(r).getCell(1).value||'');
    if(t==='CATEGORY') pR(ws1,r,CFILL,20);
    if(t==='VARIANT') pR(ws1,r,FFILL,20);
    if(t==='ADDON_GROUP'||t==='ADDON') pR(ws1,r,PFILL,20);
    if(t==='ITEM'&&ws1.getRow(r).getCell(7).value) pR(ws1,r,LFILL,20);
  }

  // ═══ SHEET 2: INVENTORY_ITEMS — matches inventory.service.js createItem() ═══
  const ws2 = wb.addWorksheet(INV, {properties:{tabColor:{argb:'FFED7D31'}}});
  ws2.columns = [
    {header:'Name',key:'name',width:28},{header:'SKU',key:'sku',width:14},
    {header:'Category',key:'cat',width:22},{header:'Purchase_Unit',key:'pu',width:16},
    {header:'Base_Unit (auto)',key:'bu',width:16},{header:'Conv_Factor (auto)',key:'cf',width:18},
    {header:'Min_Stock',key:'mn',width:12},{header:'Max_Stock',key:'mx',width:12},
    {header:'Current_Stock',key:'st',width:14},{header:'Is_Perishable',key:'pr',width:14},
    {header:'Shelf_Life_Days',key:'sl',width:16},{header:'Description',key:'ds',width:30}
  ];
  // [name, sku, cat, purchUnit, min, max, stock, perishable, shelfDays, desc]
  const IV = [
    ['Chicken Boneless','INV-001','Meat & Poultry','kg',5,50,20,'yes',2,'Boneless pieces'],
    ['Chicken With Bone','INV-002','Meat & Poultry','kg',5,50,10,'yes',2,null],
    ['Mutton','INV-003','Meat & Poultry','kg',3,30,8,'yes',2,null],
    ['Paneer','INV-004','Dairy & Cream','kg',3,30,15,'yes',3,null],
    ['Tomato','INV-005','Raw Vegetables','kg',10,100,40,'yes',5,null],
    ['Onion','INV-006','Raw Vegetables','kg',10,100,50,'no',30,null],
    ['Capsicum','INV-007','Raw Vegetables','kg',2,20,5,'yes',5,null],
    ['Butter','INV-008','Dairy & Cream','kg',2,20,10,'yes',30,null],
    ['Cream','INV-009','Dairy & Cream','l',2,20,8,'yes',7,null],
    ['Curd','INV-010','Dairy & Cream','l',2,20,10,'yes',5,null],
    ['Cooking Oil','INV-011','Oils & Fats','l',5,50,20,'no',180,null],
    ['Ghee','INV-012','Oils & Fats','kg',2,20,5,'no',180,null],
    ['Wheat Flour','INV-013','Grains & Flour','kg',10,100,25,'no',90,null],
    ['Maida','INV-014','Grains & Flour','kg',5,50,10,'no',90,null],
    ['Basmati Rice','INV-015','Grains & Flour','kg',10,100,30,'no',365,null],
    ['Kashmiri Chilli','INV-016','Spices','kg',1,10,3,'no',180,null],
    ['Garam Masala','INV-017','Spices','kg',0.5,5,2,'no',180,null],
    ['Turmeric Powder','INV-018','Spices','kg',0.5,5,2,'no',365,null],
    ['Cumin Powder','INV-019','Spices','kg',0.5,5,2,'no',180,null],
    ['Coriander Powder','INV-020','Spices','kg',0.5,5,2,'no',180,null],
    ['Salt','INV-021','Spices','kg',5,50,10,'no',365,null],
    ['Kasuri Methi','INV-022','Spices','kg',0.2,2,1,'no',180,null],
    ['Ginger-Garlic Paste','INV-023','Spices','kg',2,20,5,'yes',15,null],
    ['Cashew','INV-024','Dry Fruits','kg',1,10,3,'no',180,null],
    ['Sugar','INV-025','Spices','kg',5,50,5,'no',365,null],
    ['Lemon','INV-026','Raw Vegetables','kg',2,20,5,'yes',10,null],
    ['Mint Leaves','INV-027','Raw Vegetables','kg',0.5,5,1,'yes',3,null],
    ['Soda Water','INV-028','Mixers','btl',20,200,50,'no',180,null],
    ['Egg','INV-029','Meat & Poultry','pcs',50,500,100,'yes',7,null],
    // Spirits: purchase_unit=l → base_unit=ml (enables ml peg deduction)
    ['Monkey Shoulder 750ml','LIQ-001','Spirits','l',0,20,3,'no',365,'4btl×0.75L=3L'],
    ['Royal Stag 750ml','LIQ-002','Spirits','l',0,30,7.5,'no',365,'10btl'],
    ['Bacardi White 750ml','LIQ-003','Spirits','l',0,20,4.5,'no',365,'6btl'],
    ['Bombay Sapphire 750ml','LIQ-004','Spirits','l',0,15,2.25,'no',365,'3btl'],
    ['Absolut 750ml','LIQ-005','Spirits','l',0,20,3.75,'no',365,'5btl'],
    ['Glenfiddich 750ml','LIQ-006','Spirits','l',0,10,1.5,'no',365,'2btl'],
    ['Black Label 750ml','LIQ-007','Spirits','l',0,15,2.25,'no',365,'3btl'],
    // Beer: purchase_unit=btl → base_unit=pcs (whole bottle tracking)
    ['Budweiser 650ml','LIQ-008','Spirits','btl',10,200,48,'yes',180,'650ml/btl'],
    ['Kingfisher Ultra 650ml','LIQ-009','Spirits','btl',10,200,48,'yes',180,'650ml/btl'],
    // Semi-Finished
    ['Tomato Gravy','PRD-001','Semi-Finished','l',0,50,0,'yes',3,null],
    ['Makhani Gravy','PRD-002','Semi-Finished','l',0,50,0,'yes',3,null],
    ['Tikka Marinade','PRD-003','Semi-Finished','kg',0,20,0,'yes',3,null],
  ];
  for(let i=0;i<IV.length;i++){
    const d=IV[i], r=i+2;
    ws2.addRow({name:d[0],sku:d[1],cat:d[2],pu:d[3],bu:'',cf:'',mn:d[4],mx:d[5],st:d[6],pr:d[7],sl:d[8],ds:d[9]});
    // Base_Unit auto-resolve
    ws2.getRow(r).getCell(5).value={formula:`IFERROR(IF(${IM(`D${r}`,UR,'A','C','x')}="weight","g",IF(${IM(`D${r}`,UR,'A','C','x')}="volume","ml","pcs")),"")`};
    ws2.getRow(r).getCell(6).value={formula:IM(`D${r}`,UR,'A','D','1')};
  }
  sH(ws2); mF(ws2,[5,6],2,ws2.rowCount);
  for(let r=2;r<=ws2.rowCount;r++){
    const c=String(ws2.getRow(r).getCell(3).value||'');
    if(c==='Spirits') pR(ws2,r,LFILL,12);
    if(c==='Semi-Finished') pR(ws2,r,PFILL,12);
  }

  // ═══ SHEET 3: INGREDIENTS — matches ingredient.service.js create() ═══
  const ws3 = wb.addWorksheet(ING, {properties:{tabColor:{argb:'FF7030A0'}}});
  ws3.columns = [
    {header:'Ingredient_Name',key:'n',width:26},{header:'Inventory_Item',key:'i',width:28},
    {header:'Base_Unit (auto)',key:'u',width:14},{header:'Yield_%',key:'y',width:10},
    {header:'Wastage_%',key:'w',width:12},{header:'Preparation_Notes',key:'p',width:32}
  ];
  const IG = [
    ['Chicken Boneless','Chicken Boneless',95,5,'Wash cut pieces'],
    ['Chicken With Bone','Chicken With Bone',90,10,'Clean marinate'],
    ['Mutton','Mutton',90,10,'Clean cut'],['Paneer','Paneer',95,5,'Cut cubes'],
    ['Tomato','Tomato',90,10,'Wash chop'],['Onion','Onion',90,10,'Peel chop'],
    ['Capsicum','Capsicum',85,15,'Deseed slice'],['Butter','Butter',100,0,null],
    ['Cream','Cream',100,0,null],['Curd','Curd',100,0,null],
    ['Cooking Oil','Cooking Oil',100,0,null],['Ghee','Ghee',100,0,null],
    ['Wheat Flour','Wheat Flour',100,0,'Sieve'],['Maida','Maida',100,0,null],
    ['Basmati Rice','Basmati Rice',95,5,'Wash soak 30min'],
    ['Kashmiri Chilli','Kashmiri Chilli',100,0,null],['Garam Masala','Garam Masala',100,0,null],
    ['Turmeric','Turmeric Powder',100,0,null],['Cumin','Cumin Powder',100,0,null],
    ['Coriander','Coriander Powder',100,0,null],['Salt','Salt',100,0,null],
    ['Kasuri Methi','Kasuri Methi',100,0,'Crush'],['GG Paste','Ginger-Garlic Paste',100,0,null],
    ['Cashew','Cashew',100,0,'Soak grind paste'],['Sugar','Sugar',100,0,null],
    ['Lemon','Lemon',80,20,'Squeeze'],['Mint','Mint Leaves',70,30,'Pick leaves'],
    ['Soda Water','Soda Water',100,0,null],['Egg','Egg',100,0,null],
    ['Monkey Shoulder','Monkey Shoulder 750ml',100,0,'Pegs'],
    ['Royal Stag','Royal Stag 750ml',100,0,null],['Bacardi White','Bacardi White 750ml',100,0,null],
    ['Bombay Sapphire','Bombay Sapphire 750ml',100,0,null],['Absolut','Absolut 750ml',100,0,null],
    ['Glenfiddich','Glenfiddich 750ml',100,0,null],['Black Label','Black Label 750ml',100,0,null],
    ['Budweiser','Budweiser 650ml',100,0,'Full bottle'],['Kingfisher','Kingfisher Ultra 650ml',100,0,'Full bottle'],
    ['Tomato Gravy','Tomato Gravy',100,0,'Pre-made'],['Makhani Gravy','Makhani Gravy',100,0,'Pre-made'],
    ['Tikka Marinade','Tikka Marinade',100,0,'Pre-made'],
  ];
  for(let i=0;i<IG.length;i++){
    const d=IG[i],r=i+2;
    ws3.addRow({n:d[0],i:d[1],u:'',y:d[2],w:d[3],p:d[4]});
    ws3.getRow(r).getCell(3).value={formula:IM(`B${r}`,INV,'A','E','')};
  }
  sH(ws3); mF(ws3,[3],2,ws3.rowCount);

  // ═══ Remaining sheets built in buildRemainingSheets() below ═══
  await buildRemainingSheets(wb);

  const out = path.join(__dirname,'..','csv-templates','MASTER_RESTAURANT_WORKBOOK.xlsx');
  await wb.xlsx.writeFile(out);
  console.log(`\n  ✅ MASTER WORKBOOK v3 GENERATED: ${out}`);
  console.log(`  Sheets: MENU_ITEMS, INVENTORY_ITEMS, INGREDIENTS, RECIPES,`);
  console.log(`          PRODUCTION_RECIPES, SALES_SIMULATION, STOCK_MOVEMENT,`);
  console.log(`          WASTAGE_TRACKING, UNIT_REFERENCE, LIQUOR_CALCULATOR, HOW_TO_USE\n`);
  console.log(`  Formula: INDEX/MATCH (all Excel versions)\n`);
}

async function buildRemainingSheets(wb) {
  // ═══ SHEET 4: RECIPES — matches recipe.service.js create() ═══
  const ws4 = wb.addWorksheet('RECIPES', {properties:{tabColor:{argb:'FF00B0F0'}}});
  ws4.columns = [
    {header:'Recipe_Name',key:'rn',width:24},{header:'Menu_Item',key:'mi',width:22},
    {header:'Variant',key:'vr',width:16},{header:'Ingredient',key:'ig',width:22},
    {header:'Qty',key:'qt',width:10},{header:'Unit',key:'un',width:8},
    {header:'Prep_Time_Min',key:'pt',width:14},{header:'Notes',key:'nt',width:28}
  ];
  const RC = [
    ['Butter Chicken','Butter Chicken','Single','Chicken Boneless',250,'g',30,'Boneless in makhani'],
    ['Butter Chicken','Butter Chicken','Single','Makhani Gravy',200,'ml',null,null],
    ['Butter Chicken','Butter Chicken','Single','Cream',30,'ml',null,null],
    ['Butter Chicken','Butter Chicken','Single','Butter',20,'g',null,null],
    ['Butter Chicken','Butter Chicken','Single','Kasuri Methi',2,'g',null,null],
    ['Butter Chicken','Butter Chicken','Single','Salt',3,'g',null,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'Paneer',200,'g',20,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'Capsicum',50,'g',null,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'Onion',80,'g',null,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'Tomato',100,'g',null,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'GG Paste',10,'g',null,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'Kashmiri Chilli',5,'g',null,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'Coriander',3,'g',null,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'Garam Masala',2,'g',null,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'Cooking Oil',30,'ml',null,null],
    ['Kadhai Paneer','Kadhai Paneer',null,'Salt',3,'g',null,null],
    ['Chicken Tikka','Chicken Tikka',null,'Chicken Boneless',250,'g',25,null],
    ['Chicken Tikka','Chicken Tikka',null,'Tikka Marinade',60,'g',null,null],
    ['Chicken Tikka','Chicken Tikka',null,'Curd',40,'ml',null,null],
    ['Chicken Tikka','Chicken Tikka',null,'Cooking Oil',15,'ml',null,null],
    ['Chicken Tikka','Chicken Tikka',null,'Lemon',15,'g',null,null],
    ['Chicken Tikka','Chicken Tikka',null,'Salt',3,'g',null,null],
    ['Tandoori Roti','Tandoori Roti',null,'Wheat Flour',80,'g',5,null],
    ['Tandoori Roti','Tandoori Roti',null,'Salt',1,'g',null,null],
    ['Tandoori Roti','Tandoori Roti',null,'Ghee',5,'g',null,null],
    ['Butter Naan','Butter Naan',null,'Maida',80,'g',5,null],
    ['Butter Naan','Butter Naan',null,'Butter',10,'g',null,null],
    ['Butter Naan','Butter Naan',null,'Curd',10,'ml',null,null],
    ['Butter Naan','Butter Naan',null,'Salt',1,'g',null,null],
    ['Butter Naan','Butter Naan',null,'Sugar',3,'g',null,null],
    ['Dal Makhani','Dal Makhani',null,'Butter',40,'g',45,null],
    ['Dal Makhani','Dal Makhani',null,'Cream',30,'ml',null,null],
    ['Dal Makhani','Dal Makhani',null,'Tomato Gravy',100,'ml',null,null],
    ['Dal Makhani','Dal Makhani',null,'GG Paste',10,'g',null,null],
    ['Dal Makhani','Dal Makhani',null,'Kashmiri Chilli',5,'g',null,null],
    ['Dal Makhani','Dal Makhani',null,'Garam Masala',2,'g',null,null],
    ['Dal Makhani','Dal Makhani',null,'Kasuri Methi',2,'g',null,null],
    ['Dal Makhani','Dal Makhani',null,'Salt',3,'g',null,null],
    ['Jeera Rice','Jeera Rice',null,'Basmati Rice',100,'g',20,null],
    ['Jeera Rice','Jeera Rice',null,'Ghee',10,'g',null,null],
    ['Jeera Rice','Jeera Rice',null,'Cumin',3,'g',null,null],
    ['Jeera Rice','Jeera Rice',null,'Salt',2,'g',null,null],
    ['Egg Bhurji','Egg Bhurji',null,'Egg',3,'pcs',10,null],
    ['Egg Bhurji','Egg Bhurji',null,'Onion',50,'g',null,null],
    ['Egg Bhurji','Egg Bhurji',null,'Tomato',30,'g',null,null],
    ['Egg Bhurji','Egg Bhurji',null,'Turmeric',2,'g',null,null],
    ['Egg Bhurji','Egg Bhurji',null,'Cooking Oil',15,'ml',null,null],
    ['Egg Bhurji','Egg Bhurji',null,'Salt',2,'g',null,null],
    ['Fresh Lime Soda','Fresh Lime Soda',null,'Lemon',50,'g',5,null],
    ['Fresh Lime Soda','Fresh Lime Soda',null,'Sugar',20,'g',null,null],
    ['Fresh Lime Soda','Fresh Lime Soda',null,'Soda Water',1,'btl',null,null],
    ['Fresh Lime Soda','Fresh Lime Soda',null,'Salt',1,'g',null,null],
    ['Fresh Lime Soda','Fresh Lime Soda',null,'Mint',3,'g',null,null],
    // LIQUOR: qty in ml for spirits, btl for beer
    ['Monkey Shoulder 30ml','Monkey Shoulder','Small 30 ML','Monkey Shoulder',30,'ml',0,'1 peg'],
    ['Monkey Shoulder 60ml','Monkey Shoulder','Large 60 ML','Monkey Shoulder',60,'ml',0,'2 pegs'],
    ['Royal Stag 30ml','Royal Stag','Small 30 ML','Royal Stag',30,'ml',0,null],
    ['Royal Stag 60ml','Royal Stag','Large 60 ML','Royal Stag',60,'ml',0,null],
    ['Bacardi White 30ml','Bacardi White','Small 30 ML','Bacardi White',30,'ml',0,null],
    ['Bacardi White 60ml','Bacardi White','Large 60 ML','Bacardi White',60,'ml',0,null],
    ['Bombay Sapphire 30ml','Bombay Sapphire','Small 30 ML','Bombay Sapphire',30,'ml',0,null],
    ['Bombay Sapphire 60ml','Bombay Sapphire','Large 60 ML','Bombay Sapphire',60,'ml',0,null],
    ['Absolut 30ml','Absolut','Small 30 ML','Absolut',30,'ml',0,null],
    ['Absolut 60ml','Absolut','Large 60 ML','Absolut',60,'ml',0,null],
    ['Glenfiddich 30ml','Glenfiddich','Small 30 ML','Glenfiddich',30,'ml',0,null],
    ['Glenfiddich 60ml','Glenfiddich','Large 60 ML','Glenfiddich',60,'ml',0,null],
    ['Black Label 30ml','Black Label','Small 30 ML','Black Label',30,'ml',0,null],
    ['Black Label 60ml','Black Label','Large 60 ML','Black Label',60,'ml',0,null],
    ['Budweiser Bottle','Budweiser 650ml',null,'Budweiser',1,'btl',0,'Full 650ml bottle'],
    ['Kingfisher Bottle','Kingfisher Ultra',null,'Kingfisher',1,'btl',0,'Full 650ml bottle'],
  ];
  for(const d of RC) ws4.addRow({rn:d[0],mi:d[1],vr:d[2],ig:d[3],qt:d[4],un:d[5],pt:d[6],nt:d[7]});
  sH(ws4);
  for(let r=2;r<=ws4.rowCount;r++){
    const u=String(ws4.getRow(r).getCell(6).value||'');
    if(u==='ml'&&ws4.getRow(r).getCell(5).value<=60) pR(ws4,r,LFILL,8);
    if(u==='btl'&&String(ws4.getRow(r).getCell(4).value||'').match(/Bud|King/)) pR(ws4,r,LFILL,8);
  }

  // ═══ SHEET 5: PRODUCTION_RECIPES — matches production.service.js createRecipe() ═══
  const ws5 = wb.addWorksheet('PRODUCTION_RECIPES', {properties:{tabColor:{argb:'FFB381D9'}}});
  ws5.columns = [
    {header:'Recipe_Name',key:'rn',width:20},{header:'Output_Item',key:'oi',width:20},
    {header:'Output_Qty',key:'oq',width:12},{header:'Output_Unit',key:'ou',width:12},
    {header:'Input_Item',key:'ii',width:24},{header:'Input_Qty',key:'iq',width:12},
    {header:'Input_Unit',key:'iu',width:10},{header:'Prep_Time_Min',key:'pt',width:14},
    {header:'Instructions',key:'in',width:35}
  ];
  const PR = [
    ['Tomato Gravy','Tomato Gravy',5,'l','Tomato',2000,'g',45,'Blanch cook blend'],
    ['Tomato Gravy','Tomato Gravy',5,'l','Onion',1000,'g',null,null],
    ['Tomato Gravy','Tomato Gravy',5,'l','Cooking Oil',200,'ml',null,null],
    ['Tomato Gravy','Tomato Gravy',5,'l','GG Paste',100,'g',null,null],
    ['Tomato Gravy','Tomato Gravy',5,'l','Kashmiri Chilli',30,'g',null,null],
    ['Tomato Gravy','Tomato Gravy',5,'l','Turmeric',10,'g',null,null],
    ['Tomato Gravy','Tomato Gravy',5,'l','Coriander',20,'g',null,null],
    ['Tomato Gravy','Tomato Gravy',5,'l','Salt',40,'g',null,null],
    ['Makhani Gravy','Makhani Gravy',5,'l','Tomato Gravy',3000,'ml',30,'Cook with butter cream cashew'],
    ['Makhani Gravy','Makhani Gravy',5,'l','Butter',300,'g',null,null],
    ['Makhani Gravy','Makhani Gravy',5,'l','Cream',500,'ml',null,null],
    ['Makhani Gravy','Makhani Gravy',5,'l','Cashew',200,'g',null,null],
    ['Makhani Gravy','Makhani Gravy',5,'l','Kashmiri Chilli',20,'g',null,null],
    ['Makhani Gravy','Makhani Gravy',5,'l','Garam Masala',15,'g',null,null],
    ['Makhani Gravy','Makhani Gravy',5,'l','Kasuri Methi',10,'g',null,null],
    ['Makhani Gravy','Makhani Gravy',5,'l','Sugar',20,'g',null,null],
    ['Makhani Gravy','Makhani Gravy',5,'l','Salt',30,'g',null,null],
    ['Tikka Marinade','Tikka Marinade',2,'kg','Curd',1000,'ml',15,'Mix smooth paste'],
    ['Tikka Marinade','Tikka Marinade',2,'kg','GG Paste',200,'g',null,null],
    ['Tikka Marinade','Tikka Marinade',2,'kg','Kashmiri Chilli',100,'g',null,null],
    ['Tikka Marinade','Tikka Marinade',2,'kg','Garam Masala',50,'g',null,null],
    ['Tikka Marinade','Tikka Marinade',2,'kg','Turmeric',20,'g',null,null],
    ['Tikka Marinade','Tikka Marinade',2,'kg','Cooking Oil',200,'ml',null,null],
    ['Tikka Marinade','Tikka Marinade',2,'kg','Lemon',100,'g',null,null],
    ['Tikka Marinade','Tikka Marinade',2,'kg','Salt',40,'g',null,null],
  ];
  for(const d of PR) ws5.addRow({rn:d[0],oi:d[1],oq:d[2],ou:d[3],ii:d[4],iq:d[5],iu:d[6],pt:d[7],in:d[8]});
  sH(ws5);

  // ═══ SHEET 6: SALES_SIMULATION ═══
  const ws6 = wb.addWorksheet('SALES_SIMULATION', {properties:{tabColor:{argb:'FFFF0000'}}});
  ws6.columns = [
    {header:'Order_ID',key:'o',width:12},{header:'Menu_Item',key:'m',width:22},
    {header:'Variant',key:'v',width:16},{header:'Qty',key:'q',width:8},
    {header:'Price',key:'p',width:10},{header:'Total',key:'t',width:12},
    {header:'Ingredients_Consumed',key:'i',width:55}
  ];
  const SL = [
    ['ORD001','Butter Chicken','Single',2,329,null,'Chicken 500g, Makhani 400ml, Cream 60ml, Butter 40g'],
    ['ORD001','Tandoori Roti',null,4,30,null,'Wheat Flour 320g, Salt 4g, Ghee 20g'],
    ['ORD001','Butter Naan',null,2,50,null,'Maida 160g, Butter 20g, Curd 20ml'],
    ['ORD001','Jeera Rice',null,2,159,null,'Rice 200g, Ghee 20g, Cumin 6g'],
    ['ORD002','Kadhai Paneer',null,1,329,null,'Paneer 200g, Capsicum 50g, Onion 80g, Tomato 100g'],
    ['ORD002','Dal Makhani',null,1,289,null,'Butter 40g, Cream 30ml, Tomato Gravy 100ml'],
    ['ORD002','Monkey Shoulder','Large 60 ML',2,570,null,'Monkey Shoulder 120ml (2×60ml)'],
    ['ORD003','Monkey Shoulder','Small 30 ML',3,335,null,'Monkey Shoulder 90ml (3×30ml)'],
    ['ORD003','Royal Stag','Large 60 ML',1,210,null,'Royal Stag 60ml (1×60ml)'],
    ['ORD003','Budweiser 650ml',null,2,480,null,'Budweiser 2btl (2×650ml)'],
    ['ORD004','Chicken Tikka',null,2,379,null,'Chicken 500g, Tikka Marinade 120g, Curd 80ml'],
    ['ORD004','Fresh Lime Soda',null,2,99,null,'Lemon 100g, Sugar 40g, Soda 2btl'],
    ['ORD004','Glenfiddich','Small 30 ML',1,380,null,'Glenfiddich 30ml (1×30ml)'],
    ['ORD005','Egg Bhurji',null,3,149,null,'Egg 9pcs, Onion 150g, Tomato 90g'],
  ];
  for(let i=0;i<SL.length;i++){
    const d=SL[i],r=i+2;
    ws6.addRow({o:d[0],m:d[1],v:d[2],q:d[3],p:d[4],t:'',i:d[6]});
    ws6.getRow(r).getCell(6).value={formula:`D${r}*E${r}`};
  }
  sH(ws6); mF(ws6,[6],2,ws6.rowCount);

  // ═══ SHEET 7: STOCK_MOVEMENT — correct movement_type ENUMs ═══
  const ws7 = wb.addWorksheet('STOCK_MOVEMENT', {properties:{tabColor:{argb:'FF808080'}}});
  ws7.columns = [
    {header:'Txn_ID',key:'tx',width:14},{header:'Item_Name',key:'nm',width:26},
    {header:'Movement_Type',key:'mt',width:18},{header:'Qty',key:'qt',width:12},
    {header:'Unit',key:'un',width:8},{header:'Reference',key:'rf',width:14},
    {header:'Date',key:'dt',width:12},{header:'Notes',key:'nt',width:35}
  ];
  // movement_type: purchase|sale|production_in|production_out|wastage|adjustment|sale_reversal|production_reversal
  const SM = [
    ['TXN001','Chicken Boneless','purchase',20,'kg','PO-001','2026-03-15','Opening stock'],
    ['TXN002','Paneer','purchase',15,'kg','PO-001','2026-03-15','Opening stock'],
    ['TXN003','Monkey Shoulder 750ml','purchase',3,'l','PO-002','2026-03-15','4btl=3L'],
    ['TXN004','Royal Stag 750ml','purchase',7.5,'l','PO-002','2026-03-15','10btl=7.5L'],
    ['TXN005','Budweiser 650ml','purchase',48,'btl','PO-002','2026-03-15','48 bottles'],
    ['TXN006','Tomato','production_out',2,'kg','PRC-001','2026-03-20','For tomato gravy'],
    ['TXN007','Onion','production_out',1,'kg','PRC-001','2026-03-20','For tomato gravy'],
    ['TXN008','Tomato Gravy','production_in',5,'l','PRC-001','2026-03-20','5L produced'],
    ['TXN009','Chicken Boneless','sale',0.5,'kg','ORD001','2026-03-20','2×Butter Chicken'],
    ['TXN010','Monkey Shoulder 750ml','sale',0.12,'l','ORD002','2026-03-20','2×60ml pegs=120ml'],
    ['TXN011','Budweiser 650ml','sale',2,'btl','ORD003','2026-03-20','2 bottles'],
    ['TXN012','Tomato','wastage',0.5,'kg','WST-001','2026-03-20','Rotten'],
    ['TXN013','Chicken Boneless','sale_reversal',0.25,'kg','ORD005-C','2026-03-20','Cancel reversal'],
    ['TXN014','Wheat Flour','adjustment',2,'kg','ADJ-001','2026-03-20','Stock count correction'],
  ];
  for(const d of SM) ws7.addRow({tx:d[0],nm:d[1],mt:d[2],qt:d[3],un:d[4],rf:d[5],dt:d[6],nt:d[7]});
  sH(ws7);

  // ═══ SHEET 8: WASTAGE_TRACKING — correct wastage_type ENUMs ═══
  const ws8 = wb.addWorksheet('WASTAGE_TRACKING', {properties:{tabColor:{argb:'FFFF6600'}}});
  ws8.columns = [
    {header:'Wastage_ID',key:'w',width:12},{header:'Item_Name',key:'n',width:26},
    {header:'Qty',key:'q',width:10},{header:'Unit',key:'u',width:8},
    {header:'Wastage_Type',key:'t',width:16},{header:'Reason',key:'r',width:30},
    {header:'Date',key:'d',width:12}
  ];
  // wastage_type: spoilage|expiry|damage|order_cancel
  const WT = [
    ['WST-001','Tomato',0.5,'kg','spoilage','Rotten tomatoes','2026-03-20'],
    ['WST-002','Cream',0.2,'l','expiry','Past expiry date','2026-03-20'],
    ['WST-003','Monkey Shoulder 750ml',0.015,'l','damage','Bottle spillage (15ml)','2026-03-20'],
    ['WST-004','Chicken Boneless',0.25,'kg','order_cancel','KOT cancelled after prep','2026-03-20'],
    ['WST-005','Egg',2,'pcs','damage','Broken during handling','2026-03-20'],
  ];
  for(const d of WT) ws8.addRow({w:d[0],n:d[1],q:d[2],u:d[3],t:d[4],r:d[5],d:d[6]});
  sH(ws8);

  // ═══ SHEET 9: UNIT_REFERENCE — all 13 seeded units from unit.service.js ═══
  const ws9 = wb.addWorksheet('UNIT_REFERENCE', {properties:{tabColor:{argb:'FF404040'}}});
  ws9.columns = [
    {header:'Abbreviation',key:'a',width:14},{header:'Full_Name',key:'n',width:14},
    {header:'Unit_Type',key:'t',width:12},{header:'Conv_Factor',key:'f',width:14},
    {header:'Is_Base_Unit',key:'b',width:14},{header:'Example',key:'e',width:35}
  ];
  const UD = [
    ['g','Gram','weight',1,true,'Base unit for weight'],
    ['kg','Kilogram','weight',1000,false,'1 kg = 1000 g'],
    ['mg','Milligram','weight',0.001,false,'1 mg = 0.001 g'],
    ['qtl','Quintal','weight',100000,false,'1 qtl = 100 kg'],
    ['ml','Millilitre','volume',1,true,'Base unit for volume'],
    ['l','Litre','volume',1000,false,'1 l = 1000 ml'],
    ['cl','Centilitre','volume',10,false,'1 cl = 10 ml'],
    ['pcs','Piece','count',1,true,'Base unit for countable items'],
    ['dz','Dozen','count',12,false,'1 dozen = 12 pcs'],
    ['box','Box','count',1,false,'Varies by product'],
    ['pkt','Packet','count',1,false,'Varies by product'],
    ['btl','Bottle','count',1,false,'1 btl = 1 pcs (count)'],
    ['can','Can','count',1,false,'1 can = 1 pcs (count)'],
  ];
  for(const d of UD) ws9.addRow({a:d[0],n:d[1],t:d[2],f:d[3],b:d[4],e:d[5]});
  sH(ws9);

  // ═══ SHEET 10: LIQUOR_CALCULATOR ═══
  const ws10 = wb.addWorksheet('LIQUOR_CALCULATOR', {properties:{tabColor:{argb:'FFFF0000'}}});
  ws10.columns = [
    {header:'Liquor_Name',key:'n',width:26},{header:'Bottles',key:'b',width:10},
    {header:'ML_Per_Bottle',key:'m',width:16},{header:'Total_ML',key:'t',width:12},
    {header:'Total_Litres',key:'l',width:14},{header:'Pegs_30ml_Sold',key:'p3',width:16},
    {header:'Pegs_60ml_Sold',key:'p6',width:16},{header:'ML_Sold',key:'ms',width:12},
    {header:'ML_Remaining',key:'mr',width:14},{header:'Bottles_Left',key:'bl',width:14},
    {header:'Pegs_30ml_Left',key:'l3',width:16},{header:'Pegs_60ml_Left',key:'l6',width:16}
  ];
  const LC = [
    ['Monkey Shoulder',4,750,8,3],['Royal Stag',10,750,15,5],
    ['Bacardi White',6,750,5,4],['Bombay Sapphire',3,750,3,2],
    ['Absolut',5,750,6,3],['Glenfiddich',2,750,2,1],['Black Label',3,750,4,2],
  ];
  for(let i=0;i<LC.length;i++){
    const d=LC[i],r=i+2;
    ws10.addRow({n:d[0],b:d[1],m:d[2],t:'',l:'',p3:d[3],p6:d[4],ms:'',mr:'',bl:'',l3:'',l6:''});
    ws10.getRow(r).getCell(4).value={formula:`B${r}*C${r}`};           // Total_ML
    ws10.getRow(r).getCell(5).value={formula:`D${r}/1000`};            // Total_Litres
    ws10.getRow(r).getCell(8).value={formula:`(F${r}*30)+(G${r}*60)`}; // ML_Sold
    ws10.getRow(r).getCell(9).value={formula:`D${r}-H${r}`};           // ML_Remaining
    ws10.getRow(r).getCell(10).value={formula:`ROUND(I${r}/C${r},2)`}; // Bottles_Left
    ws10.getRow(r).getCell(11).value={formula:`INT(I${r}/30)`};        // Pegs_30_Left
    ws10.getRow(r).getCell(12).value={formula:`INT(I${r}/60)`};        // Pegs_60_Left
  }
  sH(ws10); mF(ws10,[4,5,8,9,10,11,12],2,ws10.rowCount);
  for(let r=2;r<=ws10.rowCount;r++) pR(ws10,r,LFILL,12);

  // ═══ SHEET 11: HOW_TO_USE — step-by-step documentation ═══
  const ws11 = wb.addWorksheet('HOW_TO_USE', {properties:{tabColor:{argb:'FF00B050'}}});
  ws11.columns = [{header:'Step',key:'s',width:6},{header:'Action',key:'a',width:100}];
  const HU = [
    ['','═══ HOW THIS WORKBOOK MAPS TO YOUR APPLICATION ═══'],
    ['',''],
    ['','STEP-BY-STEP: Setting up your restaurant in the application'],
    ['',''],
    ['1','MENU_ITEMS → Export as CSV and import via Bulk Upload API (POST /api/v1/bulk-upload)'],
    ['','  • Fill CATEGORY rows first (Name + Description + ServiceType)'],
    ['','  • Then ITEM rows under each category (Name, Category, Price, ItemType, GST/VAT, Station, ShortName, SKU, ServiceType)'],
    ['','  • Then VARIANT rows referencing parent Item name in the "Item" column'],
    ['','  • Bar items use VAT (not GST), Station=Bar, ServiceType=bar'],
    ['','  • Restaurant food uses GST=5, Station=Kitchen, ServiceType=restaurant'],
    ['','  • Valid ItemType: veg, non_veg, egg, vegan | Valid GST: 0,5,12,18,28 | Valid VAT: 0,5,12,18,20,25,28'],
    ['',''],
    ['2','UNIT_REFERENCE → Units are auto-seeded when you first access inventory (13 default units)'],
    ['','  • Weight: g(base), kg, mg, qtl | Volume: ml(base), l, cl | Count: pcs(base), dz, box, pkt, btl, can'],
    ['',''],
    ['3','INVENTORY_ITEMS → Create via Inventory API (POST /api/v1/inventory/items)'],
    ['','  • Each row = one inventory item with purchase_unit (what you buy in: kg, l, btl)'],
    ['','  • App AUTO-RESOLVES base_unit: kg→g, l→ml, btl→pcs'],
    ['','  • CRITICAL FOR LIQUOR SPIRITS: Use purchase_unit=l (litre) so base=ml, enabling 30ml/60ml peg deductions'],
    ['','  • FOR BEER: Use purchase_unit=btl so base=pcs (whole bottle tracking)'],
    ['','  • Stock is stored internally in BASE units (grams/ml/pcs), displayed in purchase units'],
    ['',''],
    ['4','INGREDIENTS → Create via Ingredients API (POST /api/v1/ingredients)'],
    ['','  • Maps 1:1 to inventory items (inventoryItemId + name + yield% + wastage% + preparationNotes)'],
    ['','  • Yield/wastage affect recipe cost calculations'],
    ['',''],
    ['5','RECIPES → Create via Recipes API (POST /api/v1/recipes)'],
    ['','  • Links menu items to ingredients with quantities and units'],
    ['','  • Each ingredient: {ingredientId, quantity, unitId} — qty in the unit specified (g, ml, pcs)'],
    ['','  • Liquor recipe: qty=30, unit=ml → deducts 30ml from inventory'],
    ['','  • Beer recipe: qty=1, unit=btl → deducts 1 bottle from inventory'],
    ['',''],
    ['6','PRODUCTION_RECIPES → Create via Production API (POST /api/v1/production/recipes)'],
    ['','  • Semi-finished items (gravies, marinades) produced from raw materials'],
    ['','  • Output item must exist in INVENTORY_ITEMS first'],
    ['','  • Running production: deducts inputs (production_out), adds output (production_in)'],
    ['',''],
    ['7','SALES_SIMULATION → Reference only — shows how orders consume ingredients'],
    ['','  • When order placed: recipe ingredients auto-deducted from inventory (FIFO batches)'],
    ['','  • Movement type: "sale" recorded in inventory_movements table'],
    ['','  • Cancel reverses: "sale_reversal" restores stock to SAME batches'],
    ['',''],
    ['8','STOCK_MOVEMENT → Reference for movement_type values used in the app'],
    ['','  • purchase: Stock IN from vendor | sale: Stock OUT from order'],
    ['','  • production_in: Semi-finished produced | production_out: Raw materials consumed'],
    ['','  • wastage: Spoilage/damage/expiry | adjustment: Manual stock correction'],
    ['','  • sale_reversal: Order cancel | production_reversal: Production undo'],
    ['',''],
    ['9','WASTAGE_TRACKING → Log via Wastage API (POST /api/v1/wastage)'],
    ['','  • wastage_type: spoilage | expiry | damage | order_cancel'],
    ['','  • Deducts from inventory (FIFO or specific batch) and records movement'],
    ['',''],
    ['10','LIQUOR_CALCULATOR → Helper sheet for bottle-to-ml conversions'],
    ['','  • Not imported — use to calculate how many litres to enter when purchasing bottles'],
    ['','  • Example: 4 bottles × 750ml ÷ 1000 = 3 litres to enter in inventory'],
    ['',''],
    ['','═══ IMPORT ORDER ═══'],
    ['','1. Seed units (automatic) → 2. Bulk upload MENU_ITEMS CSV → 3. Create INVENTORY_ITEMS'],
    ['','4. Create INGREDIENTS → 5. Create RECIPES → 6. Create PRODUCTION_RECIPES'],
    ['','7. Purchase stock → 8. Run production → 9. Start taking orders!'],
  ];
  for(const d of HU) ws11.addRow({s:d[0],a:d[1]});
  sH(ws11);
  // Style step numbers
  for(let r=2;r<=ws11.rowCount;r++){
    const v=String(ws11.getRow(r).getCell(1).value||'').trim();
    if(v&&!isNaN(v)) { pR(ws11,r,IFILL,2); ws11.getRow(r).getCell(1).font={bold:true,size:12}; }
    if(String(ws11.getRow(r).getCell(2).value||'').startsWith('═══')) {
      pR(ws11,r,HFILL,2); ws11.getRow(r).getCell(2).font={bold:true,color:{argb:'FFFFFFFF'},size:12};
      ws11.getRow(r).getCell(1).font={bold:true,color:{argb:'FFFFFFFF'},size:12};
    }
  }
}

generate().catch(e => { console.error('Error:', e); process.exit(1); });
