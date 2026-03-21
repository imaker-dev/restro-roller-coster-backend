# Cancel Stock Action: Reversal vs Wastage/Spoilage

## Overview

When an order item or full order is cancelled, the system decides what happens to the already-deducted stock:

| Scenario | Stock Action | Result |
|----------|-------------|--------|
| Cancel **within** configurable time window | **Reverse** | Stock restored to original batches |
| Cancel **after** time window | **Wastage (Spoilage)** | Stock stays deducted, logged as wastage |
| User explicitly chooses `reverse` | **Reverse** | Overrides auto-decision |
| User explicitly chooses `wastage` | **Wastage** | Overrides auto-decision |

## Decision Logic

```
IF user sent stockAction = 'reverse' or 'wastage'
  → Use user's choice (override)

ELSE (auto-decide based on time only)
  elapsed = NOW() - order_item.created_at
  window  = cancel_reversal_window_minutes setting (default 5)

  IF elapsed <= window
    → REVERSE (stock restored)
  ELSE
    → WASTAGE / SPOILAGE (stock stays deducted)
```

**Note:** The decision is purely time-based. KOT status is NOT used in the decision logic.

## Configuration

Two settings in `system_settings` (editable per outlet):

| Setting Key | Default | Type | Description |
|-------------|---------|------|-------------|
| `cancel_reversal_window_minutes` | `5` | number | Minutes after item creation within which cancel reverses stock. After this window, stock becomes wastage. Set to `0` for always-wastage, `999` for always-reverse. |
| `cancel_stock_action_mode` | `auto` | string | Reserved for future use. Currently only `auto` is implemented. |

### Change window via API

```
PUT /api/v1/settings
{
  "cancel_reversal_window_minutes": 10
}
```

## API Changes

### Cancel Item

```
PUT /api/v1/orders/:orderId/items/:itemId/cancel
```

**Body:**
```json
{
  "reason": "Customer changed mind",
  "reasonId": 1,
  "quantity": 2,
  "approvedBy": 5,
  "stockAction": "reverse"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `reason` | No | Cancel reason text (optional) |
| `reasonId` | No | FK to cancel_reasons table |
| `quantity` | No | For partial cancel (omit for full cancel) |
| `approvedBy` | No | Manager user ID (required if item is preparing/ready) |
| `stockAction` | No | `"reverse"` or `"wastage"`. If omitted, system auto-decides based on time window. |

### Cancel Order

```
PUT /api/v1/orders/:orderId/cancel
```

**Body:**
```json
{
  "reason": "Customer left",
  "stockAction": "wastage"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `reason` | No | Cancel reason text (optional) |
| `reasonId` | No | FK to cancel_reasons table |
| `approvedBy` | No | Manager user ID |
| `stockAction` | No | `"reverse"` or `"wastage"`. Applied per-item when cancelling full order. |

## What Happens Internally

### On REVERSE (stock restored)

1. Reads original `sale` movements for the order item
2. Restores quantity to the **same original batch** (no new batches created)
3. Creates `sale_reversal` movement records in `inventory_movements`
4. Updates `inventory_items.current_stock` (increases)
5. Sets `order_items.stock_deducted = 0` (for full cancel)

### On WASTAGE (stock stays deducted)

1. Reads original `sale` movements to know what was deducted per ingredient/batch
2. Creates `wastage_logs` entries with:
   - `wastage_type = 'spoilage'`
   - `reason = 'order_cancel'`
   - `reason_notes` = the cancel reason text
   - `order_id` and `order_item_id` for traceability
3. Stock is **NOT** restored (stays deducted as a loss)
4. No `sale_reversal` movements are created

### Partial Cancel

Same logic applies proportionally:
- **Reverse**: Restores `(cancelQuantity / originalQuantity)` of each ingredient
- **Wastage**: Logs `(cancelQuantity / originalQuantity)` of each ingredient as spoilage

### Full Order Cancel

Each item is evaluated independently based on its own `created_at`. A single order cancel can result in:
- Some items reversed (created recently)
- Some items as wastage (created earlier)

## Database Changes (Migration 044)

### `order_cancel_logs` — new columns

| Column | Type | Description |
|--------|------|-------------|
| `stock_action` | ENUM('reverse', 'wastage', 'none') | What happened to stock |
| `stock_action_auto` | TINYINT(1) | 1 = system auto-decided, 0 = user chose |

### `wastage_logs` — new columns

| Column | Type | Description |
|--------|------|-------------|
| `order_id` | BIGINT UNSIGNED | Reference to cancelled order |
| `order_item_id` | BIGINT UNSIGNED | Reference to cancelled order item |

### `wastage_logs` — modified columns

| Column | Change |
|--------|--------|
| `wastage_type` | Added `'order_cancel'` to ENUM |
| `reason` | Added `'order_cancel'` to ENUM |
| `ingredient_id` | Changed to nullable (not needed for order cancel wastage) |

### `system_settings` — new rows

| setting_key | setting_value | setting_type |
|-------------|---------------|-------------|
| `cancel_reversal_window_minutes` | `5` | number |
| `cancel_stock_action_mode` | `auto` | string |

## Files Modified

| File | Changes |
|------|---------|
| `src/services/stockDeduction.service.js` | Added `determineCancelStockAction()`, `recordWastageForCancelledItem()`, `recordWastageForPartialCancel()` |
| `src/services/order.service.js` | Modified `cancelItem()` and `cancelOrder()` to use decision logic |
| `src/services/settings.service.js` | Added new settings to `DEFAULT_SETTINGS` |
| `src/validations/order.validation.js` | Added `stockAction` field, made `reason` optional |
| `src/database/migrations/044_cancel_stock_action.sql` | Schema changes |

## Test Script

```bash
node scripts/test-cancel-stock-action.js
```

Covers 10 scenarios, 57 assertions:

1. **Immediate cancel** (within window) → auto REVERSE, stock restored
2. **Late cancel** (after window) → auto WASTAGE, stock unchanged, wastage_logs created
3. **User override reverse** → forces reversal even after window
4. **User override wastage** → forces wastage even within window
5. **Partial cancel within window** → proportional stock reversal (50%)
6. **Partial cancel after window** → proportional wastage logging (25%)
7. **Cancel log** stores `stock_action` and `stock_action_auto` correctly
8. **Window=0** → always wastage (even just-created items)
9. **No reason** → works with null/empty reason (optional)
10. **Window=999** → always reverse (even 30min-old items)
