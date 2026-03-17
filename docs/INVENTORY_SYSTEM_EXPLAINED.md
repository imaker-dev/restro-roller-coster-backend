# Inventory System - Complete Guide

## Table of Contents
1. [System Overview](#system-overview)
2. [Base Unit Concept](#base-unit-concept)
3. [Auto SKU Generation](#auto-sku-generation)
4. [Stock & Price Calculations](#stock--price-calculations)
5. [Complete Purchase Flow](#complete-purchase-flow)
6. [API Examples](#api-examples)
7. [Common Scenarios](#common-scenarios)

---

## System Overview

The inventory system manages raw materials and ingredients with:
- **Units hierarchy** (base units + conversion factors)
- **Categories** for organization
- **Items** with stock tracking
- **Batches** for FIFO and expiry tracking
- **Purchases** that update stock and prices
- **Movements** for audit trail

**Golden Rule:** Never change stock directly — always use movements (purchase, usage, adjustment, wastage).

---

## Base Unit Concept

### What is a Base Unit?

Every inventory item has a **base unit** — the smallest unit used for stock tracking. All quantities are stored internally in base units.

**Example:**

| Item | Base Unit | Why? |
|------|-----------|------|
| Rice | **gram (g)** | Stock tracked in grams, even if you buy in kg or bags |
| Milk | **milliliter (ml)** | Stock tracked in ml, even if you buy in liters |
| Eggs | **piece (pcs)** | Stock tracked in pieces, even if you buy in dozens |
| Flour | **gram (g)** | Stock tracked in grams, even if you buy in kg or quintals |

### Why Base Units?

1. **Consistency** — Stock is always in one unit (e.g., grams), no matter how you purchase
2. **Accurate calculations** — Average price is per base unit (₹/g, ₹/ml, ₹/pcs)
3. **FIFO tracking** — Batches use the same unit for remaining quantity
4. **Recipe costing** — Menu items consume stock in base units

### Unit Conversion

Units have a **conversion factor** relative to the base unit.

**Example for weight:**
```
Base Unit: gram (g) — conversion_factor = 1
├─ Kilogram (kg) — conversion_factor = 1000  (1 kg = 1000 g)
├─ Quintal (qtl) — conversion_factor = 100000  (1 qtl = 100,000 g)
└─ Metric Ton (MT) — conversion_factor = 1000000  (1 MT = 1,000,000 g)
```

**Example for volume:**
```
Base Unit: milliliter (ml) — conversion_factor = 1
├─ Liter (L) — conversion_factor = 1000  (1 L = 1000 ml)
└─ Gallon (gal) — conversion_factor = 3785  (1 gal ≈ 3785 ml)
```

**Example for count:**
```
Base Unit: piece (pcs) — conversion_factor = 1
├─ Dozen (dz) — conversion_factor = 12  (1 dozen = 12 pcs)
└─ Crate (crate) — conversion_factor = 30  (1 crate = 30 pcs)
```

---

## Auto SKU Generation

### When Creating an Item

**Without SKU:**
```json
POST /api/v1/inventory/:outletId/items
{
  "name": "Basmati Rice",
  "baseUnitId": 1,  // gram
  "categoryId": 5
}
```

**System generates:**
```
SKU-44-260317-1234
 │   │   │      └─ Random 4-digit suffix
 │   │   └─ Date (YYMMDD = March 17, 2026)
 │   └─ Outlet ID
 └─ Prefix
```

**With custom SKU:**
```json
{
  "name": "Basmati Rice",
  "sku": "RICE-BASMATI-001",  // Custom SKU
  "baseUnitId": 1
}
```
System uses your custom SKU.

### SKU Rules
- **Unique per outlet** (recommended, not enforced)
- **Alphanumeric + hyphens** allowed
- **Max 50 characters**

---

## Stock & Price Calculations

### Stock Tracking

**All stock is stored in base units:**

```sql
-- inventory_items table
current_stock DECIMAL(15,4)  -- Always in base_unit
```

**Example:**
- Item: Rice, Base Unit: gram (g)
- Purchase: 50 kg at ₹60/kg
- System converts: 50 kg × 1000 = **50,000 g**
- `current_stock` updated: 0 → **50,000**

### Price Calculations

**Two prices tracked:**

1. **latest_price** — Price from most recent purchase (per base unit)
2. **average_price** — Weighted average of all active batches (per base unit)

#### Latest Price

Updated on every purchase:
```
latest_price = price_per_base_unit from newest batch
```

**Example:**
- Purchase 50 kg rice at ₹60/kg
- `price_per_base_unit = ₹60 / 1000 = ₹0.06/g`
- `latest_price = ₹0.06`

#### Average Price (Weighted)

Formula:
```
average_price = (Σ(batch_qty × batch_price)) / Σ(batch_qty)
```

**Example:**

| Batch | Qty (base) | Price (base) | Value |
|-------|------------|--------------|-------|
| B1 | 30,000 g | ₹0.05/g | ₹1,500 |
| B2 | 50,000 g | ₹0.06/g | ₹3,000 |
| **Total** | **80,000 g** | — | **₹4,500** |

```
average_price = ₹4,500 / 80,000 = ₹0.05625/g
```

When B1 is consumed:
- Remaining: B2 (50,000 g at ₹0.06/g)
- `average_price = ₹3,000 / 50,000 = ₹0.06/g`

### Why Both Prices?

| Price | Use Case |
|-------|----------|
| **latest_price** | "Market rate" — useful for reorder decisions |
| **average_price** | "True cost" — used for recipe costing & profit calculation |

---

## Complete Purchase Flow

### Step-by-Step

**1. Create Purchase**
```
POST /api/v1/inventory/:outletId/purchases
{
  "vendorId": 10,
  "invoiceNumber": "INV-2026-001",
  "purchaseDate": "2026-03-17",
  "items": [
    {
      "inventoryItemId": 25,  // Rice
      "quantity": 50,         // 50 kg
      "unitId": 2,            // kg
      "pricePerUnit": 60      // ₹60/kg
    }
  ]
}
```

**2. System Processes:**

a. **Convert to base unit:**
   - Lookup: `units.conversion_factor` for `unitId=2` (kg) → `1000`
   - Calculate: `quantityInBase = 50 × 1000 = 50,000 g`

b. **Calculate price per base unit:**
   - `price_per_base_unit = ₹60 / 1000 = ₹0.06/g`

c. **Create purchase_item:**
   ```sql
   INSERT INTO purchase_items (
     purchase_id, inventory_item_id, 
     quantity, unit_id, quantity_in_base,
     price_per_unit, price_per_base_unit, 
     total_cost, batch_code
   ) VALUES (
     123, 25, 
     50, 2, 50000,
     60, 0.06, 
     3000, 'B-25-260317-456'
   )
   ```

d. **Create inventory_batch:**
   ```sql
   INSERT INTO inventory_batches (
     inventory_item_id, outlet_id, batch_code,
     quantity, remaining_quantity,
     purchase_price, purchase_date, vendor_id
   ) VALUES (
     25, 44, 'B-25-260317-456',
     50000, 50000,
     0.06, '2026-03-17', 10
   )
   ```

e. **Update stock & prices:**
   ```sql
   -- Get current state
   SELECT current_stock, average_price FROM inventory_items WHERE id=25
   -- Returns: current_stock=0, average_price=0
   
   -- Calculate new weighted average
   new_avg = ((0 × 0) + (50000 × 0.06)) / 50000 = 0.06
   
   UPDATE inventory_items SET
     current_stock = current_stock + 50000,  -- 0 → 50,000
     average_price = 0.06,
     latest_price = 0.06
   WHERE id = 25
   ```

f. **Record movement:**
   ```sql
   INSERT INTO inventory_movements (
     outlet_id, inventory_item_id, inventory_batch_id,
     movement_type, quantity, quantity_in_base,
     unit_cost, total_cost,
     balance_before, balance_after,
     reference_type, reference_id
   ) VALUES (
     44, 25, 456,
     'purchase', 50000, 50000,
     0.06, 3000,
     0, 50000,
     'purchase_item', 789
   )
   ```

**3. Response:**
```json
{
  "success": true,
  "data": {
    "id": 123,
    "purchaseNumber": "PUR-2603-0045",
    "totalAmount": 3000,
    "items": [
      {
        "inventoryItemId": 25,
        "itemName": "Basmati Rice",
        "quantity": 50,
        "unitAbbreviation": "kg",
        "quantityInBase": 50000,
        "baseUnitAbbreviation": "g",
        "pricePerUnit": 60,
        "pricePerBaseUnit": 0.06,
        "totalCost": 3000,
        "batchCode": "B-25-260317-456"
      }
    ]
  }
}
```

---

## API Examples

### 1. Create Item (Auto SKU)

```http
POST /api/v1/inventory/44/items
Content-Type: application/json

{
  "name": "Basmati Rice Premium",
  "baseUnitId": 1,
  "categoryId": 5,
  "minimumStock": 10000,
  "isPerishable": false
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 25,
    "outletId": 44,
    "name": "Basmati Rice Premium",
    "sku": "SKU-44-260317-1234",
    "categoryId": 5,
    "baseUnitId": 1,
    "unitName": "Gram",
    "unitAbbreviation": "g",
    "currentStock": 0,
    "latestPrice": 0,
    "averagePrice": 0,
    "minimumStock": 10000,
    "isLowStock": false
  }
}
```

### 2. Get Item (After Purchase)

```http
GET /api/v1/inventory/items/25
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 25,
    "name": "Basmati Rice Premium",
    "sku": "SKU-44-260317-1234",
    "currentStock": 50000,
    "latestPrice": 0.06,
    "averagePrice": 0.06,
    "unitAbbreviation": "g",
    "minimumStock": 10000,
    "isLowStock": false,
    "activeBatchCount": 1
  }
}
```

### 3. List Items with Stock/Prices

```http
GET /api/v1/inventory/44/items?page=1&limit=10&lowStock=true
```

**Response:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 25,
        "name": "Basmati Rice Premium",
        "sku": "SKU-44-260317-1234",
        "currentStock": 50000,
        "latestPrice": 0.06,
        "averagePrice": 0.06,
        "unitAbbreviation": "g",
        "isLowStock": false
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 1,
      "totalPages": 1
    }
  }
}
```

---

## Common Scenarios

### Scenario 1: Multiple Purchases at Different Prices

**Purchase 1:**
- 30 kg at ₹50/kg → 30,000 g at ₹0.05/g
- Stock: 30,000 g
- Average: ₹0.05/g
- Latest: ₹0.05/g

**Purchase 2:**
- 50 kg at ₹60/kg → 50,000 g at ₹0.06/g
- Stock: 80,000 g (30k + 50k)
- Average: `((30k×0.05) + (50k×0.06)) / 80k = ₹0.05625/g`
- Latest: ₹0.06/g

**Usage: Consume 40,000 g (FIFO - from oldest batch first)**
- Batch 1: 30,000 g consumed (exhausted)
- Batch 2: 10,000 g consumed, 40,000 g remaining
- Stock: 40,000 g
- Average: ₹0.06/g (only Batch 2 remains)
- Latest: ₹0.06/g (unchanged)

### Scenario 2: Buying in Different Units

**Setup:**
- Item: Cooking Oil
- Base Unit: ml
- Units: ml (×1), L (×1000), Gallon (×3785)

**Purchase 1: 20 L at ₹120/L**
- Qty in base: 20 × 1000 = 20,000 ml
- Price per base: ₹120 / 1000 = ₹0.12/ml
- Total: ₹2,400

**Purchase 2: 5 Gallons at ₹450/gal**
- Qty in base: 5 × 3785 = 18,925 ml
- Price per base: ₹450 / 3785 = ₹0.119/ml
- Total: ₹2,250

**Result:**
- Stock: 38,925 ml
- Average: `((20k×0.12) + (18925×0.119)) / 38925 = ₹0.1195/ml`
- Latest: ₹0.119/ml

### Scenario 3: Low Stock Alert

**Item: Tomatoes**
- Base Unit: kg
- Minimum Stock: 50 kg
- Current Stock: 45 kg
- `isLowStock: true` ✓

**API returns:**
```json
{
  "currentStock": 45,
  "minimumStock": 50,
  "isLowStock": true
}
```

### Scenario 4: Perishable Items with Expiry

**Purchase:**
```json
{
  "inventoryItemId": 30,
  "quantity": 100,
  "unitId": 1,
  "pricePerUnit": 5,
  "expiryDate": "2026-04-15"
}
```

**Batch created:**
- `expiry_date: 2026-04-15`
- System can alert on near-expiry items
- FIFO ensures older batches consumed first

### Scenario 5: Unit Conversion in Display

**Internal (database):**
- current_stock: 50,000 g
- average_price: ₹0.06/g

**Display to user (in kg):**
- Stock: 50,000 / 1000 = **50 kg**
- Avg Price: ₹0.06 × 1000 = **₹60/kg**

**Formula:**
```
display_quantity = current_stock / conversion_factor
display_price = average_price × conversion_factor
```

---

## Best Practices

### 1. Choose Base Unit Wisely
- Use the **smallest practical unit** for accuracy
- Avoid fractions (use g instead of kg, ml instead of L)

### 2. SKU Naming
- Include category or item type: `RICE-BASMATI-001`
- Or use auto-generated for consistency

### 3. Stock Adjustments
- Always provide a reason: "Spillage", "Theft", "Inventory count correction"
- Use negative quantity for decrease, positive for increase

### 4. Price Monitoring
- Compare `latest_price` vs `average_price` to spot price trends
- High difference → significant price change recently

### 5. Batch Tracking
- Perishable items → always set `expiryDate`
- FIFO consumption ensures old stock used first
- Monitor `active_batch_count` — too many batches = unused stock

---

## Technical Details

### Database Schema Summary

**inventory_items:**
```sql
current_stock DECIMAL(15,4)    -- Always in base_unit
latest_price DECIMAL(12,4)     -- Per base_unit, from newest batch
average_price DECIMAL(12,4)    -- Per base_unit, weighted avg
base_unit_id BIGINT            -- FK to units table
```

**inventory_batches:**
```sql
quantity DECIMAL(15,4)          -- Original qty (in base_unit)
remaining_quantity DECIMAL(15,4) -- Current qty (FIFO deduction)
purchase_price DECIMAL(12,4)    -- Per base_unit
```

**purchase_items:**
```sql
quantity DECIMAL(15,4)          -- Qty in purchase_unit
unit_id BIGINT                  -- Purchase unit (can differ from base)
quantity_in_base DECIMAL(15,4)  -- Converted to base_unit
price_per_unit DECIMAL(12,4)    -- In purchase_unit
price_per_base_unit DECIMAL(12,4) -- Converted to base_unit
```

**inventory_movements:**
```sql
quantity DECIMAL(15,4)          -- In base_unit
balance_before DECIMAL(15,4)    -- Stock before movement
balance_after DECIMAL(15,4)     -- Stock after movement
unit_cost DECIMAL(12,4)         -- Per base_unit
```

---

## Troubleshooting

### Stock shows 0 after purchase
- Check `purchase_items.quantity_in_base` — should be > 0
- Verify unit conversion: `quantity × units.conversion_factor`
- Check transaction committed successfully

### Average price is 0
- Ensure `inventory_batches.purchase_price` is set
- Check batch `is_active = 1` and `remaining_quantity > 0`
- Average recalculates when batches are consumed

### Latest price not updating
- Verify newest batch has `purchase_date` as most recent
- Check batch `is_active = 1`

### Wrong stock quantity
- Review `inventory_movements` for audit trail
- Check for manual database edits (prohibited!)
- Verify FIFO batch consumption in movement records

---

## API Reference Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/:outletId/items` | POST | Create item (auto SKU) |
| `/items/:id` | GET | Get item with stock/prices |
| `/:outletId/items` | GET | List items with filters |
| `/:outletId/purchases` | POST | Create purchase (updates stock) |
| `/purchases/:id` | GET | Get purchase details |
| `/:outletId/items/:itemId/ledger` | GET | Stock movement history |

**All responses include:**
- `currentStock` (in base_unit)
- `latestPrice` (per base_unit)
- `averagePrice` (per base_unit)
- `unitAbbreviation` (base unit name)

---

## Summary

✅ **Base Unit** — All stock in one consistent unit (g, ml, pcs)  
✅ **Auto SKU** — Generated if not provided: `SKU-{outlet}-{date}-{random}`  
✅ **Stock Tracking** — Always in base units, updated via movements  
✅ **Latest Price** — From most recent purchase (market rate)  
✅ **Average Price** — Weighted average of active batches (true cost)  
✅ **Unit Conversion** — Purchase in any unit, stored in base unit  
✅ **FIFO** — Oldest batches consumed first  
✅ **Audit Trail** — Every stock change recorded in movements  

**Need help?** Check API responses for `currentStock`, `latestPrice`, `averagePrice` — they should always reflect accurate values after purchase.
