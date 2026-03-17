# Inventory Management System — API Documentation

> **Base URL:** `/api/v1/inventory`
> **Auth:** All endpoints require `Bearer <token>` in Authorization header.
> **Roles:** `super_admin`, `admin`, `manager` (all endpoints).

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Step-by-Step Setup Flow](#step-by-step-setup-flow)
3. [Module 1: Units (3 APIs)](#module-1-units)
4. [Module 2: Vendors (4 APIs)](#module-2-vendors)
5. [Module 3: Inventory (12 APIs)](#module-3-inventory) — Categories (3) + Items (4) + Batches (1) + Movements (1) + Adjust (1) + Wastage (1) + Summary (1)
6. [Module 4: Purchases (5 APIs)](#module-4-purchases)
7. [Complete Purchase Flow Example](#complete-purchase-flow-example)
8. [Design Notes](#design-notes)

---

## System Overview

```
Vendor ──> Purchase ──> Batch Created ──> Stock Updated ──> Average Price Calculated
                                              │
                                    ┌─────────┴─────────┐
                                    │                     │
                              Adjustment (+/-)        Wastage (-)
                                    │                     │
                                    └─────────┬─────────┘
                                              │
                                    Movement Log (every change recorded)
```

**Key Concepts:**
- **Units** — kg, g, litre, ml, pcs etc. Auto-seeded on first access.
- **Vendors** — Suppliers you buy from.
- **Inventory Items** — Raw materials (Tomato, Oil, Flour). Stock tracked in **base units** (g, ml, pcs).
- **Batches** — Each purchase creates a batch with its own price. FIFO deduction.
- **Movements** — Every stock change is logged (purchase, adjustment, wastage).
- **Average Price** — Weighted average recalculated on every purchase.
- **No delete APIs** — Use `PUT` with `{ "isActive": false }` to deactivate anything.

---

## Step-by-Step Setup Flow

```
1. GET  /:outletId/units           → Get units (auto-seeds defaults: kg, g, ml, l, pcs, etc.)
2. POST /:outletId/vendors         → Create vendors (suppliers)
3. POST /:outletId/categories      → Create inventory categories (Vegetables, Spices, etc.)
4. POST /:outletId/items           → Create inventory items (Tomato, Onion, Oil, etc.)
5. POST /:outletId/purchases       → Record a purchase → auto-creates batch + updates stock + avg price
6. GET  /:outletId/stock-summary   → View stock levels, values, low-stock alerts
```

---

## Module 1: Units

### 1.1 List Units

Auto-seeds default units (kg, g, ml, l, pcs, dozen, etc.) on first call.

```
GET /:outletId/units
```

**Query Parameters:**

| Param    | Type   | Description                          |
|----------|--------|--------------------------------------|
| unitType | string | Filter: `weight`, `volume`, `count`  |
| isActive | bool   | Filter active/inactive               |
| search   | string | Search by name or abbreviation       |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "outletId": 4,
      "name": "Gram",
      "abbreviation": "g",
      "unitType": "weight",
      "conversionFactor": 1,
      "isBaseUnit": true,
      "isActive": true
    },
    {
      "id": 2,
      "outletId": 4,
      "name": "Kilogram",
      "abbreviation": "kg",
      "unitType": "weight",
      "conversionFactor": 1000,
      "isBaseUnit": false,
      "isActive": true
    }
  ]
}
```

**Conversion Logic:**
- `conversionFactor` = how many base units in 1 of this unit
- kg → `conversionFactor = 1000` (1 kg = 1000 g)
- litre → `conversionFactor = 1000` (1 litre = 1000 ml)
- dozen → `conversionFactor = 12` (1 dozen = 12 pcs)
- To convert: `quantity_in_base = quantity × conversionFactor`

---

### 1.2 Create Unit

```
POST /:outletId/units
```

**Payload:**
```json
{
  "name": "Quintal",
  "abbreviation": "qtl",
  "unitType": "weight",
  "conversionFactor": 100000,
  "isBaseUnit": false
}
```

**Response:** `201 Created`
```json
{
  "success": true,
  "data": {
    "id": 15,
    "name": "Quintal",
    "abbreviation": "qtl",
    "unitType": "weight",
    "conversionFactor": 100000,
    "isBaseUnit": false,
    "isActive": true
  }
}
```

---

### 1.3 Update Unit

```
PUT /units/:id
```

**Payload (any field):**
```json
{
  "name": "Quintal Updated",
  "isActive": false
}
```

**Response:**
```json
{
  "success": true,
  "data": { "id": 15, "name": "Quintal Updated", "isActive": false, "..." : "..." }
}
```

---

## Module 2: Vendors

### 2.1 List Vendors

```
GET /:outletId/vendors
```

**Query Parameters:**

| Param     | Type   | Description                |
|-----------|--------|----------------------------|
| page      | int    | Page number (default 1)    |
| limit     | int    | Per page (default 50)      |
| search    | string | Search name/phone/email    |
| isActive  | bool   | Filter active/inactive     |
| sortBy    | string | `name`, `created_at`       |
| sortOrder | string | `ASC` or `DESC`            |

**Response:**
```json
{
  "success": true,
  "vendors": [
    {
      "id": 1,
      "name": "Fresh Vegetables Co.",
      "contactPerson": "Rajesh",
      "phone": "9876543210",
      "email": "rajesh@freshveg.com",
      "gstNumber": "27AABCU9603R1ZM",
      "isActive": true,
      "purchaseCount": 5,
      "totalPurchaseAmount": 25000,
      "lastPurchaseDate": "2025-03-15"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 1, "totalPages": 1 }
}
```

---

### 2.2 Get Vendor Detail

```
GET /vendors/:id
```

**Response:** Same structure as list item, with all fields.

---

### 2.3 Create Vendor

```
POST /:outletId/vendors
```

**Payload:**
```json
{
  "name": "Fresh Vegetables Co.",
  "contactPerson": "Rajesh",
  "phone": "9876543210",
  "email": "rajesh@freshveg.com",
  "address": "APMC Market, Vashi",
  "city": "Navi Mumbai",
  "state": "Maharashtra",
  "pincode": "400703",
  "gstNumber": "27AABCU9603R1ZM",
  "panNumber": "AABCU9603R",
  "paymentTerms": "Net 15",
  "creditDays": 15,
  "notes": "Delivers daily at 6 AM"
}
```

**Required:** `name` only. All other fields are optional.

**Response:** `201 Created` with full vendor object.

---

### 2.4 Update Vendor

```
PUT /vendors/:id
```

**Payload (any field):**
```json
{
  "phone": "9876543211",
  "isActive": false
}
```

> To deactivate a vendor, send `{ "isActive": false }`. No separate delete API.

---

## Module 3: Inventory

### 3.1 List Categories

```
GET /:outletId/categories
```

**Query:** `?isActive=true&search=veg`

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Vegetables",
      "description": "Fresh vegetables",
      "itemCount": 12,
      "isActive": true
    }
  ]
}
```

---

### 3.2 Create Category

```
POST /:outletId/categories
```

**Payload:**
```json
{
  "name": "Vegetables",
  "description": "Fresh vegetables",
  "displayOrder": 1
}
```

---

### 3.3 Update Category

```
PUT /categories/:id
```

**Payload:** `{ "name": "Fresh Vegetables", "isActive": false }`

---

### 3.4 List Inventory Items

```
GET /:outletId/items
```

**Query Parameters:**

| Param      | Type   | Description                                  |
|------------|--------|----------------------------------------------|
| page       | int    | Page number                                  |
| limit      | int    | Per page                                     |
| search     | string | Search by name or SKU                        |
| categoryId | int    | Filter by category                           |
| isActive   | bool   | Filter active/inactive                       |
| lowStock   | bool   | `true` = only items where stock ≤ minimum    |
| sortBy     | string | `name`, `current_stock`, `average_price`, `latest_price` |
| sortOrder  | string | `ASC` or `DESC`                              |

**Response:**
```json
{
  "success": true,
  "items": [
    {
      "id": 1,
      "name": "Tomato",
      "sku": "VEG-001",
      "categoryId": 1,
      "categoryName": "Vegetables",
      "baseUnitId": 2,
      "unitName": "Kilogram",
      "unitAbbreviation": "kg",
      "currentStock": 50000,
      "latestPrice": 0.04,
      "averagePrice": 0.035,
      "minimumStock": 5000,
      "maximumStock": 100000,
      "isPerishable": true,
      "isActive": true,
      "activeBatchCount": 3,
      "isLowStock": false
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 25, "totalPages": 1 }
}
```

> **Note:** `currentStock`, `latestPrice`, `averagePrice` are all in **base unit** (g for weight, ml for volume).
> Example: 50000 g = 50 kg. Price 0.04/g = ₹40/kg.

---

### 3.5 Get Item Detail

```
GET /items/:id
```

**Response:** Same as list item, all fields.

---

### 3.6 Create Inventory Item

```
POST /:outletId/items
```

**Payload:**
```json
{
  "name": "Tomato",
  "sku": "VEG-001",
  "categoryId": 1,
  "baseUnitId": 1,
  "minimumStock": 5000,
  "maximumStock": 100000,
  "description": "Fresh tomatoes",
  "isPerishable": true,
  "shelfLifeDays": 7
}
```

**Required:** `name`, `baseUnitId`.

> `baseUnitId` should be the **smallest unit** you'll track in (e.g., `g` for weight items, `ml` for liquids, `pcs` for count items).

---

### 3.7 Update Inventory Item

```
PUT /items/:id
```

**Payload:** Any field from create + `{ "isActive": false }` to deactivate.

---

### 3.8 List Batches (per item)

```
GET /items/:itemId/batches
```

**Query:** `?activeOnly=true&page=1&limit=50`

**Response:**
```json
{
  "success": true,
  "batches": [
    {
      "id": 1,
      "inventoryItemId": 1,
      "batchCode": "B-1-250315-042",
      "quantity": 10000,
      "remainingQuantity": 7500,
      "purchasePrice": 0.04,
      "purchaseDate": "2025-03-15",
      "expiryDate": "2025-03-22",
      "vendorName": "Fresh Vegetables Co.",
      "unitAbbreviation": "g",
      "isExhausted": false
    }
  ],
  "pagination": { "..." : "..." }
}
```

---

### 3.9 List Movements

```
GET /:outletId/movements
```

**Query Parameters:**

| Param           | Type   | Description                                         |
|-----------------|--------|-----------------------------------------------------|
| inventoryItemId | int    | Filter by item (use this instead of separate ledger) |
| movementType    | string | `purchase`, `sale`, `production`, `wastage`, `adjustment` |
| startDate       | date   | `YYYY-MM-DD`                                        |
| endDate         | date   | `YYYY-MM-DD`                                        |
| batchId         | int    | Filter by batch                                     |
| page            | int    | Page number                                         |
| limit           | int    | Per page                                            |

**Response:**
```json
{
  "success": true,
  "movements": [
    {
      "id": 1,
      "inventoryItemId": 1,
      "itemName": "Tomato",
      "batchCode": "B-1-250315-042",
      "movementType": "purchase",
      "quantity": 10000,
      "quantityInBase": 10000,
      "unitCost": 0.04,
      "totalCost": 400,
      "balanceBefore": 0,
      "balanceAfter": 10000,
      "referenceType": "purchase_item",
      "referenceId": 1,
      "createdByName": "Admin",
      "createdAt": "2025-03-15T10:00:00.000Z"
    }
  ],
  "pagination": { "..." : "..." }
}
```

> **Tip:** To get a stock ledger for a single item, use `?inventoryItemId=1`.
> To get vendor's purchase history, use `GET /:outletId/purchases?vendorId=1`.

---

### 3.10 Record Stock Adjustment

```
POST /:outletId/adjustments
```

**Payload:**
```json
{
  "inventoryItemId": 1,
  "quantity": 500,
  "reason": "Physical stock count correction"
}
```

> Use **positive** quantity to add stock, **negative** to reduce.
> Negative adjustments deduct from batches using FIFO.

**Response:**
```json
{
  "success": true,
  "data": {
    "inventoryItemId": 1,
    "adjustment": 500,
    "balanceBefore": 10000,
    "balanceAfter": 10500,
    "movementType": "adjustment"
  }
}
```

---

### 3.11 Record Wastage

```
POST /:outletId/wastage
```

**Payload:**
```json
{
  "inventoryItemId": 1,
  "quantity": 200,
  "reason": "Spoiled tomatoes",
  "batchId": 1
}
```

> `quantity` must be **positive** (it always reduces stock).
> `batchId` is optional — if omitted, FIFO deduction from oldest batch.

**Response:**
```json
{
  "success": true,
  "data": {
    "inventoryItemId": 1,
    "wastageQuantity": 200,
    "balanceBefore": 10500,
    "balanceAfter": 10300,
    "movementType": "wastage"
  }
}
```

---

### 3.12 Stock Summary

```
GET /:outletId/stock-summary
```

**Response:**
```json
{
  "success": true,
  "items": [
    {
      "id": 1,
      "name": "Tomato",
      "categoryName": "Vegetables",
      "currentStock": 10300,
      "unitAbbreviation": "g",
      "averagePrice": 0.035,
      "stockValue": 360.50,
      "isLowStock": false
    }
  ],
  "summary": {
    "totalItems": 25,
    "totalStockValue": 45230.00,
    "lowStockCount": 3,
    "lowStockItems": [
      { "id": 5, "name": "Saffron", "currentStock": 10, "minimumStock": 50, "unitAbbreviation": "g" }
    ]
  }
}
```

---

## Module 4: Purchases

### 4.1 List Purchases

```
GET /:outletId/purchases
```

**Query Parameters:**

| Param         | Type   | Description                           |
|---------------|--------|---------------------------------------|
| vendorId      | int    | Filter by vendor                      |
| status        | string | `draft`, `confirmed`, `cancelled`     |
| paymentStatus | string | `unpaid`, `partial`, `paid`           |
| startDate     | date   | `YYYY-MM-DD`                          |
| endDate       | date   | `YYYY-MM-DD`                          |
| search        | string | Search purchase#, invoice#, vendor    |
| sortBy        | string | `purchase_date`, `total_amount`       |
| sortOrder     | string | `ASC` or `DESC`                       |
| page, limit   | int    | Pagination                            |

**Response:**
```json
{
  "success": true,
  "purchases": [
    {
      "id": 1,
      "vendorName": "Fresh Vegetables Co.",
      "purchaseNumber": "PUR-2503-0001",
      "invoiceNumber": "FV-2025-0342",
      "purchaseDate": "2025-03-15",
      "totalAmount": 4200,
      "paidAmount": 4200,
      "dueAmount": 0,
      "paymentStatus": "paid",
      "status": "confirmed",
      "itemCount": 3
    }
  ],
  "pagination": { "..." : "..." }
}
```

---

### 4.2 Get Purchase Detail

```
GET /purchases/:id
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "vendorName": "Fresh Vegetables Co.",
    "vendorPhone": "9876543210",
    "vendorGst": "27AABCU9603R1ZM",
    "purchaseNumber": "PUR-2503-0001",
    "invoiceNumber": "FV-2025-0342",
    "purchaseDate": "2025-03-15",
    "subtotal": 4000,
    "taxAmount": 200,
    "discountAmount": 0,
    "totalAmount": 4200,
    "paidAmount": 4200,
    "dueAmount": 0,
    "paymentStatus": "paid",
    "status": "confirmed",
    "notes": null,
    "createdByName": "Admin",
    "items": [
      {
        "id": 1,
        "inventoryItemId": 1,
        "itemName": "Tomato",
        "quantity": 10,
        "unitId": 2,
        "unitAbbreviation": "kg",
        "quantityInBase": 10000,
        "baseUnitAbbreviation": "g",
        "pricePerUnit": 40,
        "pricePerBaseUnit": 0.04,
        "taxAmount": 0,
        "discountAmount": 0,
        "totalCost": 400,
        "batchCode": "B-1-250315-042",
        "expiryDate": "2025-03-22"
      },
      {
        "id": 2,
        "inventoryItemId": 3,
        "itemName": "Cooking Oil",
        "quantity": 5,
        "unitId": 6,
        "unitAbbreviation": "l",
        "quantityInBase": 5000,
        "baseUnitAbbreviation": "ml",
        "pricePerUnit": 180,
        "pricePerBaseUnit": 0.18,
        "taxAmount": 0,
        "discountAmount": 0,
        "totalCost": 900,
        "batchCode": "B-3-250315-077",
        "expiryDate": null
      }
    ]
  }
}
```

---

### 4.3 Create Purchase ⭐ (Main API)

This is the core API. It does **everything** in one transaction:
1. Creates the purchase record
2. Creates purchase items
3. Creates inventory batches (one per item)
4. Updates stock (adds quantity in base units)
5. Calculates new weighted average price
6. Records purchase movements

```
POST /:outletId/purchases
```

**Payload:**
```json
{
  "vendorId": 1,
  "invoiceNumber": "FV-2025-0342",
  "purchaseDate": "2025-03-15",
  "taxAmount": 200,
  "discountAmount": 0,
  "paidAmount": 4200,
  "notes": "Weekly vegetable purchase",
  "items": [
    {
      "inventoryItemId": 1,
      "quantity": 10,
      "unitId": 2,
      "pricePerUnit": 40,
      "expiryDate": "2025-03-22",
      "notes": "Grade A tomatoes"
    },
    {
      "inventoryItemId": 3,
      "quantity": 5,
      "unitId": 6,
      "pricePerUnit": 180
    }
  ]
}
```

**Required fields:**
- `vendorId` — Which vendor you bought from
- `purchaseDate` — Date of purchase
- `items` — Array with at least 1 item
- Each item needs: `inventoryItemId`, `quantity`, `unitId`, `pricePerUnit`

**Optional fields:**
- `invoiceNumber`, `taxAmount`, `discountAmount`, `paidAmount`, `notes`
- Per item: `expiryDate`, `batchCode` (auto-generated if omitted), `taxAmount`, `discountAmount`, `notes`

**What happens internally:**

```
Item: 10 kg Tomato @ ₹40/kg
├── Unit conversion: 10 kg × 1000 = 10,000 g (base unit)
├── Price per base unit: ₹40 / 1000 = ₹0.04/g
├── New batch created: B-1-250315-042 (10,000g @ ₹0.04/g)
├── Stock updated: current_stock += 10,000
├── Avg price recalculated: ((old_qty × old_avg) + (10000 × 0.04)) / (old_qty + 10000)
├── Latest price updated: ₹0.04/g
└── Movement recorded: type=purchase, +10,000g
```

**Response:** `201 Created` — Full purchase object with items (same as GET /purchases/:id).

---

### 4.4 Cancel Purchase

Reverses all stock changes: deactivates batches, reduces stock, records reversal movements, recalculates average price.

```
POST /purchases/:id/cancel
```

**Payload:**
```json
{
  "reason": "Vendor sent wrong items"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Purchase cancelled",
  "data": { "id": 1, "status": "cancelled", "..." : "..." }
}
```

---

### 4.5 Update Purchase Payment

```
PUT /purchases/:id/payment
```

**Payload:**
```json
{
  "paidAmount": 2000
}
```

**Response:** Full purchase object with updated `paidAmount`, `dueAmount`, `paymentStatus`.

Payment status is auto-calculated:
- `paidAmount >= totalAmount` → `"paid"`
- `paidAmount > 0 but < totalAmount` → `"partial"`
- `paidAmount = 0` → `"unpaid"`

---

## Complete Purchase Flow Example

### Step 1: Setup (one-time)

```bash
# 1. Get units (auto-seeds)
GET /api/v1/inventory/4/units

# 2. Create vendor
POST /api/v1/inventory/4/vendors
{ "name": "Fresh Vegetables Co.", "phone": "9876543210" }
# → Returns vendor with id: 1

# 3. Create category
POST /api/v1/inventory/4/categories
{ "name": "Vegetables" }
# → Returns category with id: 1

# 4. Create inventory items
POST /api/v1/inventory/4/items
{ "name": "Tomato", "categoryId": 1, "baseUnitId": 1, "minimumStock": 5000 }
# → Returns item with id: 1 (baseUnitId=1 is Gram)

POST /api/v1/inventory/4/items
{ "name": "Onion", "categoryId": 1, "baseUnitId": 1, "minimumStock": 5000 }
# → Returns item with id: 2
```

### Step 2: Record a Purchase

```bash
POST /api/v1/inventory/4/purchases
{
  "vendorId": 1,
  "purchaseDate": "2025-03-15",
  "paidAmount": 1100,
  "items": [
    { "inventoryItemId": 1, "quantity": 10, "unitId": 2, "pricePerUnit": 40 },
    { "inventoryItemId": 2, "quantity": 20, "unitId": 2, "pricePerUnit": 35 }
  ]
}
```

**Result:**
- Tomato: +10,000g stock, avg price = ₹0.04/g, batch created
- Onion: +20,000g stock, avg price = ₹0.035/g, batch created
- Purchase total: ₹1,100 (400 + 700), paid ₹1,100, due ₹0

### Step 3: Check Stock

```bash
GET /api/v1/inventory/4/stock-summary
# → Shows all items with stock levels, values, and low-stock alerts
```

### Step 4: Record Wastage (if needed)

```bash
POST /api/v1/inventory/4/wastage
{ "inventoryItemId": 1, "quantity": 500, "reason": "Spoiled" }
# → Tomato stock: 10,000 → 9,500g
```

### Step 5: View Movement History

```bash
GET /api/v1/inventory/4/movements?inventoryItemId=1
# → Shows: purchase +10,000g, wastage -500g with running balances
```

---

## Design Notes

| Decision | Reason |
|----------|--------|
| No DELETE endpoints | Deactivate with `PUT { isActive: false }`. Safer, audit-friendly. |
| Units auto-seed | No separate setup step needed. First `GET /units` call creates defaults. |
| Stock in base units | Avoids conversion errors. Always stored as g/ml/pcs. |
| Batch-based inventory | Enables FIFO costing, expiry tracking, and accurate cost per batch. |
| Movements table | Golden rule: stock never changes directly. Every change is a movement log. |
| Average price formula | Weighted average: `((old_qty × old_avg) + (new_qty × new_price)) / total_qty` |
| Vendor purchases | Use `GET /:outletId/purchases?vendorId=X` instead of separate endpoint. |
| Item ledger | Use `GET /:outletId/movements?inventoryItemId=X` instead of separate endpoint. |

### API Count: 24 Total

| Module       | Endpoints | APIs |
|--------------|-----------|------|
| Units        | 3 | list, create, update |
| Vendors      | 4 | list, get, create, update |
| Categories   | 3 | list, create, update |
| Items        | 4 | list, get, create, update |
| Batches      | 1 | list per item |
| Movements    | 1 | list (filter by item = ledger) |
| Adjustments  | 1 | record (+/-) |
| Wastage      | 1 | record |
| Stock Summary| 1 | summary with values |
| Purchases    | 5 | list, get, create, cancel, payment |
| **Total**    | **24** | |
