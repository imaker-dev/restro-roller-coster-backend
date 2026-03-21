# Inventory, Recipes & Production — Complete Guide

This document covers **every scenario** for inventory management, recipe creation, and production runs — including kitchen semi-finished items (gravies, doughs, sauces) and bar items (bottles, pegs, cocktails).

---

## Table of Contents

1. [Core Concepts](#1-core-concepts)
2. [The outputInventoryItemId Question](#2-the-outputinventoryitemid-question)
3. [Kitchen: Semi-Finished Items (Gravies, Sauces, Doughs)](#3-kitchen-semi-finished-items)
4. [Bar: Bottles, Pegs & Cocktails](#4-bar-bottles-pegs--cocktails)
5. [Menu Item Recipes vs Production Recipes](#5-menu-item-recipes-vs-production-recipes)
6. [Step-by-Step API Flows](#6-step-by-step-api-flows)
7. [Vendor Detail API](#7-vendor-detail-api)
8. [Quick Reference: Which API for What](#8-quick-reference)

---

## 1. Core Concepts

### The 4 Layers

```
┌─────────────────────────────────────────────────────┐
│  Layer 1: INVENTORY ITEMS  (raw + semi-finished)    │
│  What you buy AND what you produce                  │
│  e.g., Tomato, Onion, Whiskey, Tomato Gravy         │
├─────────────────────────────────────────────────────┤
│  Layer 2: INGREDIENTS  (bridge to recipes)          │
│  Maps inventory_item → recipe system                │
│  e.g., Ingredient "Tomato Gravy" → inventory #15    │
├─────────────────────────────────────────────────────┤
│  Layer 3: RECIPES  (two types)                      │
│  Menu Recipe: linked to menu item (Paneer Butter)   │
│  Production Recipe: makes semi-finished inventory   │
├─────────────────────────────────────────────────────┤
│  Layer 4: PRODUCTION RUNS  (execute recipes)        │
│  Deducts raw materials → Creates output batch       │
│  Cost automatically derived from input ingredients  │
└─────────────────────────────────────────────────────┘
```

### Key Tables

| Table | Purpose |
|-------|---------|
| `inventory_items` | All trackable stock items (raw + semi-finished) |
| `inventory_batches` | FIFO batch tracking with purchase price |
| `ingredients` | Bridge: maps inventory_item to recipe system |
| `recipes` | Menu item recipes (linked to `items` table) |
| `recipe_ingredients` | Ingredients used in a menu recipe |
| `production_recipes` | Templates for producing semi-finished items |
| `production_recipe_ingredients` | Inputs for a production recipe |
| `productions` | Executed production runs |
| `production_inputs` | What was consumed in a production |

### Units System

Stock is always stored in **base units** (gram, ml, piece). The system auto-converts:

```
Purchase: 10 kg @ ₹400/kg  →  stored as 10,000 g @ ₹0.4/g
Recipe:   500 g of tomato   →  system reads 500 base units
```

---

## 2. The outputInventoryItemId Question

> "We make gravy from many ingredients, but gravy is used in many dishes. What do we give as outputInventoryItemId?"

**Answer: You MUST first create an inventory item for the output (e.g., "Tomato Gravy"), then use its ID.**

The production system produces INTO an inventory item. This is by design — the output needs to be trackable in inventory with stock levels, cost, and batches.

### The Workflow

```
Step 1: Create inventory item "Tomato Gravy"     → gets ID 15
Step 2: Create production recipe using ID 15       → recipe template
Step 3: Run production                             → deducts tomato, onion, oil
                                                   → creates batch of Gravy (5L)
Step 4: Create ingredient from "Tomato Gravy"      → ingredient bridge
Step 5: Use ingredient in menu recipes             → Paneer Butter Masala uses 100ml Gravy
```

### Why This Design?

| Benefit | Explanation |
|---------|-------------|
| **Stock tracking** | Know exactly how much gravy is left |
| **Cost accuracy** | Gravy cost = SUM of input ingredient costs (auto-calculated) |
| **FIFO batches** | Each production creates a batch with derived cost |
| **Reusability** | Same gravy used across 20 dishes — one inventory item |
| **Wastage tracking** | If gravy spoils, log wastage against the inventory item |

---

## 3. Kitchen: Semi-Finished Items

### Example: Tomato Gravy (used in Paneer Butter Masala, Dal Makhani, etc.)

#### Step 1: Create Inventory Items (raw materials + output)

```
POST /api/v1/inventory/:outletId/items

# Raw materials (if not already created)
{ "name": "Tomato",    "baseUnitId": 1,  "categoryId": 2 }  → id: 10
{ "name": "Onion",     "baseUnitId": 1,  "categoryId": 2 }  → id: 11
{ "name": "Oil",       "baseUnitId": 2,  "categoryId": 3 }  → id: 12
{ "name": "Spice Mix", "baseUnitId": 1,  "categoryId": 3 }  → id: 13

# Semi-finished output item
{ "name": "Tomato Gravy", "baseUnitId": 2, "categoryId": 5 }  → id: 15
```

> `baseUnitId: 1` = gram (g), `baseUnitId: 2` = millilitre (ml)

#### Step 2: Purchase raw materials

```
POST /api/v1/inventory/:outletId/purchases
{
  "vendorId": 1,
  "purchaseDate": "2026-03-20",
  "items": [
    { "inventoryItemId": 10, "quantity": 10, "unitId": 3, "pricePerUnit": 40 },
    { "inventoryItemId": 11, "quantity": 10, "unitId": 3, "pricePerUnit": 30 },
    { "inventoryItemId": 12, "quantity": 5,  "unitId": 4, "pricePerUnit": 180 },
    { "inventoryItemId": 13, "quantity": 1,  "unitId": 3, "pricePerUnit": 200 }
  ]
}
```

> `unitId: 3` = kg, `unitId: 4` = litre — auto-converted to base units on entry

#### Step 3: Create Production Recipe

```
POST /api/v1/production/:outletId/recipes
{
  "name": "Tomato Gravy",
  "outputInventoryItemId": 15,      ← THE KEY FIELD — must be an existing inventory item
  "outputQuantity": 5,
  "outputUnitId": 4,                 ← litre (produces 5L per batch)
  "preparationTimeMins": 45,
  "ingredients": [
    { "inventoryItemId": 10, "quantity": 2,   "unitId": 3 },   ← 2 kg Tomato
    { "inventoryItemId": 11, "quantity": 1,   "unitId": 3 },   ← 1 kg Onion
    { "inventoryItemId": 12, "quantity": 0.5, "unitId": 4 },   ← 500ml Oil
    { "inventoryItemId": 13, "quantity": 100, "unitId": 1 }    ← 100g Spice Mix
  ]
}
```

#### Step 4: Run Production

```
POST /api/v1/production/:outletId/produce
{
  "productionRecipeId": 1,
  "notes": "Morning batch"
}
```

**What happens internally:**
1. Deducts 2kg Tomato, 1kg Onion, 500ml Oil, 100g Spice from respective batches (FIFO)
2. Calculates total input cost (e.g., ₹280)
3. Creates batch `PROD-001` of Tomato Gravy: 5L at ₹56/L (= ₹280 / 5)
4. Updates Tomato Gravy stock: +5000ml
5. Updates Tomato Gravy average_price based on weighted average

#### Step 5: Create Ingredient from Gravy & Use in Menu Recipe

```
# Create ingredient bridge
POST /api/v1/recipes/:outletId/ingredients
{ "inventoryItemId": 15, "name": "Tomato Gravy" }  → ingredientId: 20

# Create menu recipe for "Paneer Butter Masala"
POST /api/v1/recipes/:outletId/recipes
{
  "name": "Paneer Butter Masala Recipe",
  "menuItemId": 42,                    ← links to menu item
  "ingredients": [
    { "ingredientId": 20, "quantity": 100, "unitId": 2 },   ← 100ml Gravy
    { "ingredientId": 5,  "quantity": 200, "unitId": 1 }    ← 200g Paneer
  ]
}
```

Now when Paneer Butter Masala is ordered:
- Stock deduction reads the recipe → deducts 100ml Tomato Gravy + 200g Paneer
- Making cost = (100ml × gravy avg price/ml) + (200g × paneer avg price/g)
- This cost is snapshot in `order_item_costs` at order time

---

## 4. Bar: Bottles, Pegs & Cocktails

### The Challenge

Bar works differently:
- **You purchase bottles/cartons** (750ml, 1L, case of 12)
- **You serve in pegs/shots** (30ml, 60ml, or full drinks)
- **Cocktails mix multiple spirits + mixers**

### How the System Handles This

#### Step 1: Create Inventory Items for Spirits

```
POST /api/v1/inventory/:outletId/items

{ "name": "Johnnie Walker Black Label", "baseUnitId": 2, "categoryId": 8 }  → id: 50
  ↑ base unit = ml (millilitre) — ALL liquor tracked in ml

{ "name": "Absolut Vodka",             "baseUnitId": 2, "categoryId": 8 }  → id: 51
{ "name": "Bacardi White Rum",         "baseUnitId": 2, "categoryId": 8 }  → id: 52
{ "name": "Coca Cola",                 "baseUnitId": 2, "categoryId": 9 }  → id: 53
{ "name": "Fresh Lime Juice",          "baseUnitId": 2, "categoryId": 9 }  → id: 54
{ "name": "Simple Syrup",              "baseUnitId": 2, "categoryId": 9 }  → id: 55
```

> **Critical: base unit for all liquor = ml (millilitre)**

#### Step 2: Set Up Units

The system needs units for bottles and cases:

```
POST /api/v1/inventory/:outletId/units

# These should already be seeded, but if not:
{ "name": "Bottle (750ml)", "abbreviation": "btl",  "conversionFactor": 750,  "baseUnitId": 2 }  → id: 10
{ "name": "Bottle (1L)",    "abbreviation": "btl1L","conversionFactor": 1000, "baseUnitId": 2 }  → id: 11
{ "name": "Case (12×750)",  "abbreviation": "case", "conversionFactor": 9000, "baseUnitId": 2 }  → id: 12
{ "name": "Peg (30ml)",     "abbreviation": "peg",  "conversionFactor": 30,   "baseUnitId": 2 }  → id: 13
{ "name": "Peg (60ml)",     "abbreviation": "lg",   "conversionFactor": 60,   "baseUnitId": 2 }  → id: 14
```

> `conversionFactor` = how many base units (ml) in 1 of this unit

#### Step 3: Purchase Bottles/Cartons

```
POST /api/v1/inventory/:outletId/purchases
{
  "vendorId": 3,
  "purchaseDate": "2026-03-20",
  "invoiceNumber": "BAR-2026-001",
  "items": [
    {
      "inventoryItemId": 50,          ← Johnnie Walker
      "quantity": 12,                  ← 12 bottles
      "unitId": 10,                    ← unit: Bottle (750ml)
      "pricePerUnit": 3500             ← ₹3,500 per bottle
    },
    {
      "inventoryItemId": 51,          ← Absolut Vodka
      "quantity": 1,                   ← 1 case
      "unitId": 12,                    ← unit: Case (12×750)
      "pricePerUnit": 18000            ← ₹18,000 per case
    }
  ]
}
```

**What the system does:**
- JW: 12 bottles × 750ml = 9000ml stored, ₹3500/750 = ₹4.667/ml
- Vodka: 1 case × 9000ml = 9000ml stored, ₹18000/9000 = ₹2.000/ml

#### Step 4: Create Ingredients for Bar Items

```
POST /api/v1/recipes/:outletId/ingredients/bulk
{
  "items": [
    { "inventoryItemId": 50, "name": "JW Black Label" },
    { "inventoryItemId": 51, "name": "Absolut Vodka" },
    { "inventoryItemId": 52, "name": "Bacardi White Rum" },
    { "inventoryItemId": 53, "name": "Coca Cola" },
    { "inventoryItemId": 54, "name": "Fresh Lime Juice" },
    { "inventoryItemId": 55, "name": "Simple Syrup" }
  ]
}
```

#### Step 5A: Simple Peg/Shot — Menu Recipe (No Production Needed)

For a straight pour (e.g., "JW Black Label 60ml Peg"):

```
POST /api/v1/recipes/:outletId/recipes
{
  "name": "JW Black Label Peg",
  "menuItemId": 101,                   ← "JW Black Label 60ml" menu item
  "ingredients": [
    { "ingredientId": 30, "quantity": 60, "unitId": 2 }    ← 60ml JW Black
  ]
}
```

> No production recipe needed — the menu recipe directly deducts from the bottle inventory

**Cost calculation:** 60ml × ₹4.667/ml = ₹280 making cost

#### Step 5B: Cocktail — Menu Recipe with Multiple Ingredients

For a cocktail (e.g., "Cuba Libre"):

```
POST /api/v1/recipes/:outletId/recipes
{
  "name": "Cuba Libre",
  "menuItemId": 120,                   ← "Cuba Libre" menu item
  "ingredients": [
    { "ingredientId": 32, "quantity": 60,  "unitId": 2 },   ← 60ml Rum
    { "ingredientId": 33, "quantity": 120, "unitId": 2 },   ← 120ml Cola
    { "ingredientId": 34, "quantity": 15,  "unitId": 2 }    ← 15ml Lime Juice
  ]
}
```

**Cost:** (60×rum_price) + (120×cola_price) + (15×lime_price) = auto-calculated

#### Step 5C: Pre-Mixed Items — Production Recipe (Rare for Bar)

If you pre-batch cocktails (e.g., large-batch Margarita mix):

```
# First create inventory item for the output
POST /api/v1/inventory/:outletId/items
{ "name": "Margarita Pre-Mix", "baseUnitId": 2 }  → id: 60

# Then create production recipe
POST /api/v1/production/:outletId/recipes
{
  "name": "Margarita Pre-Mix (5L)",
  "outputInventoryItemId": 60,
  "outputQuantity": 5,
  "outputUnitId": 4,                   ← litre
  "ingredients": [
    { "inventoryItemId": 51, "quantity": 2,    "unitId": 4 },   ← 2L Vodka
    { "inventoryItemId": 54, "quantity": 1.5,  "unitId": 4 },   ← 1.5L Lime
    { "inventoryItemId": 55, "quantity": 1.5,  "unitId": 4 }    ← 1.5L Syrup
  ]
}
```

### Bar Inventory Summary Table

| Scenario | What to Use | Production Recipe? |
|----------|-------------|-------------------|
| Whiskey Peg (30ml/60ml) | Menu Recipe → deducts from bottle inventory | No |
| Neat Pour / On the Rocks | Menu Recipe → single ingredient | No |
| Simple Cocktail (Rum + Cola) | Menu Recipe → multiple ingredients | No |
| Pre-Batched Cocktail Mix | Production Recipe → then Menu Recipe uses it | Yes |
| Beer (bottle/pint) | Menu Recipe → 1 ingredient (330ml or 500ml) | No |
| Wine (glass) | Menu Recipe → 1 ingredient (150ml or 180ml) | No |

### How Stock Looks After Service

```
Johnnie Walker Black Label:
  Purchased: 9000ml (12 bottles)
  Deducted:  60ml (1 peg sold) + 60ml (another) = 120ml
  Current:   8880ml = 11.84 bottles remaining
  
  Batches:
    BATCH-001: 9000ml initial, 8880ml remaining, ₹4.667/ml
```

---

## 5. Menu Item Recipes vs Production Recipes

| Feature | Menu Recipe | Production Recipe |
|---------|-------------|-------------------|
| **Purpose** | Calculate cost & deduct stock when menu item is ordered | Create semi-finished inventory items |
| **Linked to** | `items` table (menu item) | `inventory_items` table (output) |
| **Triggered by** | Customer order | Manual production run |
| **Uses** | `ingredients` table (bridge) | `inventory_items` directly |
| **Output** | No output — only deductions | Creates a new inventory batch |
| **API prefix** | `/api/v1/recipes/` | `/api/v1/production/` |
| **Key field** | `menuItemId` | `outputInventoryItemId` |

### When to Use Which

```
Customer orders "Paneer Butter Masala"
  → Menu Recipe kicks in
  → Deducts: 100ml Tomato Gravy + 200g Paneer
  → Cost snapshot saved to order_item_costs

Chef makes morning gravy batch
  → Production Recipe executed
  → Deducts: 2kg Tomato + 1kg Onion + 500ml Oil + 100g Spices
  → Creates: 5L Tomato Gravy batch (cost auto-derived)
```

---

## 6. Step-by-Step API Flows

### Flow A: Kitchen — Gravy Production + Menu Deduction

```
1. POST /api/v1/inventory/:outletId/items           ← Create "Tomato Gravy" inventory item
2. POST /api/v1/inventory/:outletId/purchases        ← Purchase raw materials
3. POST /api/v1/production/:outletId/recipes         ← Create production recipe template
4. POST /api/v1/production/:outletId/produce         ← Execute production (make gravy)
5. POST /api/v1/recipes/:outletId/ingredients        ← Create ingredient from gravy item
6. POST /api/v1/recipes/:outletId/recipes            ← Create menu recipe using gravy ingredient
7. Customer orders dish → auto stock deduction        ← Handled by order service
```

### Flow B: Bar — Bottle Purchase + Peg Service

```
1. POST /api/v1/inventory/:outletId/items            ← Create "JW Black Label" (base: ml)
2. POST /api/v1/inventory/:outletId/units            ← Ensure bottle/peg units exist
3. POST /api/v1/inventory/:outletId/purchases        ← Buy 12 bottles
4. POST /api/v1/recipes/:outletId/ingredients        ← Create ingredient from JW item
5. POST /api/v1/recipes/:outletId/recipes            ← Menu recipe: 60ml JW → "JW Peg 60ml"
6. Customer orders peg → auto stock deduction         ← Deducts 60ml from bottle batch
```

### Flow C: Bar — Cocktail with Multiple Spirits

```
1. Ensure all spirit/mixer inventory items exist
2. Ensure all ingredients created from inventory items
3. POST /api/v1/recipes/:outletId/recipes            ← Cocktail recipe: Rum + Cola + Lime
4. Customer orders cocktail → auto deduction          ← Deducts from all 3 items
```

### Flow D: Ad-Hoc Production (No Template)

```
POST /api/v1/production/:outletId/produce
{
  "name": "Emergency Gravy Batch",
  "outputInventoryItemId": 15,
  "outputQuantity": 2,
  "outputUnitId": 4,
  "ingredients": [
    { "inventoryItemId": 10, "quantity": 1,   "unitId": 3 },
    { "inventoryItemId": 11, "quantity": 0.5, "unitId": 3 }
  ]
}
```

> No `productionRecipeId` → system treats it as ad-hoc

---

## 7. Vendor Detail API

### GET /api/v1/inventory/vendors/:id/detail

Returns comprehensive vendor information including full purchase history, payment records, items supplied, financial summary, and monthly trends.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| purchasePage | number | 1 | Page for purchase history |
| purchaseLimit | number | 20 | Purchases per page |
| startDate | string | — | Filter purchases from date (YYYY-MM-DD) |
| endDate | string | — | Filter purchases to date (YYYY-MM-DD) |
| paymentStatus | string | — | Filter: `paid`, `partial`, `unpaid` |

**Response Structure:**

```json
{
  "success": true,
  "data": {
    "vendor": {
      "id": 1,
      "name": "Metro Cash & Carry",
      "contactPerson": "Rajesh Kumar",
      "phone": "9876543210",
      "email": "rajesh@metro.in",
      "address": "Industrial Area, Phase 2",
      "city": "Chandigarh",
      "state": "Punjab",
      "gstNumber": "03AABCU9603R1ZJ",
      "bankName": "HDFC Bank",
      "bankAccount": "50100123456789",
      "bankIfsc": "HDFC0001234",
      "paymentTerms": "Net 30",
      "creditDays": 30,
      "isActive": true,
      "purchaseCount": 45,
      "totalPurchaseAmount": 234500.00,
      "lastPurchaseDate": "2026-03-18"
    },

    "financialSummary": {
      "totalPurchases": 45,
      "totalPurchaseAmount": 234500.00,
      "totalPaidAmount": 200000.00,
      "totalDueAmount": 34500.00,
      "avgPurchaseValue": 5211.11,
      "maxPurchaseValue": 25000.00,
      "minPurchaseValue": 500.00,
      "firstPurchaseDate": "2025-06-15",
      "lastPurchaseDate": "2026-03-18",
      "paymentBreakdown": {
        "fullyPaid": 38,
        "partialPaid": 4,
        "unpaid": 3
      }
    },

    "purchases": {
      "data": [
        {
          "id": 89,
          "purchaseNumber": "PUR-2026-0089",
          "invoiceNumber": "INV-2026-045",
          "purchaseDate": "2026-03-18",
          "subtotal": 5200.00,
          "taxAmount": 936.00,
          "discountAmount": 0,
          "totalAmount": 6136.00,
          "paidAmount": 6136.00,
          "dueAmount": 0,
          "paymentStatus": "paid",
          "status": "confirmed",
          "itemCount": 4,
          "createdByName": "Admin",
          "items": [
            {
              "id": 201,
              "inventoryItemId": 10,
              "itemName": "Tomato",
              "itemSku": "VEG-001",
              "categoryName": "Vegetables",
              "quantity": 10,
              "unitName": "Kilogram",
              "unitAbbreviation": "kg",
              "pricePerUnit": 40.00,
              "taxAmount": 0,
              "discountAmount": 0,
              "totalCost": 400.00,
              "batchCode": "BATCH-089-1",
              "expiryDate": null
            }
          ]
        }
      ],
      "pagination": { "page": 1, "limit": 20, "total": 45, "totalPages": 3 }
    },

    "itemsSupplied": [
      {
        "inventoryItemId": 10,
        "itemName": "Tomato",
        "sku": "VEG-001",
        "categoryName": "Vegetables",
        "baseUnit": "g",
        "purchaseCount": 30,
        "totalQuantityPurchased": 300,
        "totalSpent": 12000.00,
        "avgPricePerUnit": 40.00,
        "maxPricePerUnit": 50.00,
        "minPricePerUnit": 30.00,
        "lastPurchasedDate": "2026-03-18"
      }
    ],

    "paymentHistory": [
      {
        "id": 56,
        "purchaseId": 89,
        "purchaseNumber": "PUR-2026-0089",
        "invoiceNumber": "INV-2026-045",
        "amount": 6136.00,
        "paymentMethod": "bank_transfer",
        "paymentReference": "UTR123456",
        "paymentDate": "2026-03-18",
        "createdByName": "Admin"
      }
    ],

    "monthlyTrend": [
      { "month": "2026-03", "purchaseCount": 5, "totalAmount": 28000.00, "paidAmount": 25000.00, "dueAmount": 3000.00 },
      { "month": "2026-02", "purchaseCount": 8, "totalAmount": 35000.00, "paidAmount": 35000.00, "dueAmount": 0 }
    ],

    "outstandingPurchases": [
      {
        "id": 85,
        "purchaseNumber": "PUR-2026-0085",
        "invoiceNumber": "INV-2026-040",
        "purchaseDate": "2026-03-10",
        "totalAmount": 15000.00,
        "paidAmount": 5000.00,
        "dueAmount": 10000.00,
        "paymentStatus": "partial"
      }
    ]
  }
}
```

---

## 8. Quick Reference

### Which API for What

| I want to... | API | Service |
|---------------|-----|---------|
| Create inventory item | `POST /inventory/:outletId/items` | inventory.service |
| Purchase stock | `POST /inventory/:outletId/purchases` | purchase.service |
| Create ingredient bridge | `POST /recipes/:outletId/ingredients` | ingredient.service |
| Create menu recipe | `POST /recipes/:outletId/recipes` | recipe.service |
| Create production recipe | `POST /production/:outletId/recipes` | production.service |
| Run production | `POST /production/:outletId/produce` | production.service |
| Reverse production | `POST /production/:id/reverse` | production.service |
| View vendor full details | `GET /inventory/vendors/:id/detail` | vendor.service |
| Record purchase payment | `PUT /inventory/purchases/:id/payment` | purchase.service |

### Cost Flow

```
Purchase → Batch (purchase_price/base_unit) → Weighted Average Price on inventory_item
                                                        ↓
                            Recipe reads average_price (or FIFO/latest per setting)
                                                        ↓
                            Order placed → costSnapshot saves making_cost + profit
                                                        ↓
                            Reports read from order_item_costs table
```

### Production Cost Flow

```
Raw Materials (Tomato ₹0.04/g + Onion ₹0.03/g + Oil ₹0.18/ml)
    ↓  FIFO deduction from batches
Total Input Cost = ₹280
    ↓  ÷ output quantity (5000ml)
Cost Per Output Unit = ₹0.056/ml
    ↓  Creates batch PROD-001 at ₹0.056/ml
Tomato Gravy average_price updated (weighted avg)
    ↓  When used in menu recipe
Menu item cost includes gravy at current avg price
```
