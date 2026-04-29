# Self-Order QR System — Complete Flow Documentation

## Overview

The self-order system allows restaurant customers to scan a **static QR code** on their table, browse the menu, place orders, and track status — all from their phone without downloading an app.

**QR codes are permanent** — they encode only `outletId + tableId` and never expire. Session lifecycle is managed independently.

---

## 1. QR Code Structure

### Static URL Format
```
{SELF_ORDER_URL}/self-order?outlet={outletId}&table={tableId}
```

- No token or session parameter in URL
- Same physical QR sticker works forever
- QR images stored in `uploads/self-order-qr/`

### QR Generation Endpoints (Staff)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/v1/self-order/staff/qr/generate` | Generate QR for one table |
| `POST` | `/api/v1/self-order/staff/qr/generate-all` | Bulk generate for all tables |
| `GET`  | `/api/v1/self-order/staff/qr/tables/:outletId` | List all QR URLs by floor |

---

## 2. Session Lifecycle

### States
```
active → ordering → completed
                  → expired (timeout)
```

| State | Meaning |
|-------|---------|
| `active` | Session created, no order yet |
| `ordering` | Order placed, awaiting completion |
| `completed` | Order paid or session ended |
| `expired` | Session timed out (default: 120 min) |

### Session Init Flow (`POST /api/v1/self-order/init`)

```
Customer scans QR
        │
        ▼
  Validate outlet (exists, active, self-order enabled)
        │
        ▼
  Validate table (exists, active)
        │
        ▼
  Check shift open (restaurant must be open)
        │
        ▼
  Check active orders on table ─────────────────────┐
        │                                            │
        ▼                                            ▼
  No active order                          Active order found
        │                                    │           │
        ▼                                    ▼           ▼
  Create new session                   Self-order?    POS/Staff?
        │                                │               │
        ▼                                ▼               ▼
  Return token + session          Resume session    BLOCK: "managed
                                  (return existing    by staff"
                                   token + resumed    HTTP 409
                                   = true)
```

---

## 3. Validation Rules

### Case 1: Same Customer Re-scans (Allowed)
- Table has active self-order → session is **resumed**
- Returns same session token with `resumed: true`
- Customer continues with existing order

### Case 2: Different Customer, Table In Use (Blocked)
- Table has active self-order with expired/missing session
- Response: `"This table is currently in use. Please wait until the current order is completed."`
- HTTP 409

### Case 3: Staff/POS Order Running (Blocked)
- Table has active order from POS, captain, or admin
- Response: `"This table is currently managed by staff. Please ask your server for assistance."`
- HTTP 409

### Case 4: Self-Order Running → Staff Tries (Allowed)
- Staff can always create POS orders on any table (override)
- POS order creation is not blocked by self-order sessions
- Staff has full control over table management

### Case 5: Restaurant Closed (Blocked)
- No active shift (`day_sessions.status = 'open'`)
- Response: `"Restaurant is currently closed. Please try again during business hours."`
- HTTP 403

---

## 4. Order Flow

### Customer Side

```
Scan QR → Init Session → Browse Menu → Add to Cart → Place Order
                                                          │
                                               ┌─────────┴──────────┐
                                               ▼                    ▼
                                          Auto Accept          Manual Accept
                                               │                    │
                                               ▼                    ▼
                                          Direct KOT          Pending Approval
                                          (→ kitchen)          (staff reviews)
                                               │                    │
                                               ▼                    ▼
                                          Preparing...    Staff Accept/Reject
                                                                │         │
                                                                ▼         ▼
                                                            KOT sent   Order cancelled
                                                                │     (session reset →
                                                                ▼      can reorder)
                                                          Preparing...
```

### API Endpoints (Customer — Session Token Auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/init` | Initialize session from QR scan |
| `GET` | `/menu` | Browse menu |
| `GET` | `/session` | Get session info |
| `PUT` | `/customer` | Update name/phone |
| `POST` | `/cart` | Save cart |
| `GET` | `/cart` | Get cart |
| `POST` | `/order` | Place order |
| `POST` | `/order/add-items` | Add items to existing order |
| `POST` | `/order/cancel` | Cancel order (before preparation) |
| `PUT` | `/order/item/:id` | Update item quantity |
| `DELETE` | `/order/item/:id` | Remove item from order |
| `GET` | `/order/status` | Get order status + items |
| `GET` | `/orders` | Past orders for this table |

### Staff Side

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/staff/pending/:outletId` | List self-orders (filterable) |
| `POST` | `/staff/accept` | Accept pending order → KOT |
| `POST` | `/staff/reject` | Reject pending order |
| `GET` | `/staff/settings/:outletId` | Get settings |
| `PATCH` | `/staff/settings/:outletId` | Update settings |
| `POST` | `/staff/session/:id/complete` | Complete session |

---

## 5. Order Modification (Customer)

### Conditions
- Only items with status `pending` can be modified
- Only orders with status `pending` or `confirmed` can be modified
- Once KOT is sent and items are `preparing`/`ready` → modification blocked
- Customer sees: *"This item has already been sent to the kitchen and cannot be modified."*

### Update Quantity (`PUT /order/item/:orderItemId`)
- Body: `{ "quantity": 3 }`
- Recalculates item price, tax, and order totals
- Emits `selforder:item_updated` + `order:items_updated`

### Remove Item (`DELETE /order/item/:orderItemId`)
- Cannot remove last remaining item (use cancel instead)
- Marks item as `cancelled`, subtracts from order totals
- Emits `selforder:item_removed` + `order:items_updated`

### Add Items (`POST /order/add-items`)
- Adds new items to existing order
- Supports auto-accept (direct KOT) or manual mode
- Emits `selforder:items_added` + `order:items_added`

---

## 6. Order Cancellation

### Customer Cancel (`POST /order/cancel`)
- Body: `{ "reason": "Changed my mind" }` (optional)
- **Allowed when:** order status is `pending` or `confirmed`
- **Blocked when:** order status is `preparing`, `ready`, `served`, `paid`, `completed`
- On cancel:
  - Order status → `cancelled`
  - All pending items → `cancelled`
  - Self-order session → reset to `active` (can place new order)
  - Table session → ended (if no other active orders)
  - Table status → `available` (if no other active orders)
- Emits: `selforder:cancelled`, `order:cancelled`, `table:update`
- Error message when blocked: *"Order cannot be cancelled — it is already being prepared. Please ask staff for assistance."*

### Staff Reject (`POST /staff/reject`)
- Staff can reject pending self-orders
- Session is reset so customer can place a new order
- Emits: `selforder:rejected`, `order:cancelled`

---

## 7. Real-Time Events (Socket.IO)

### Self-Order Channel (`selforder:updated`)
All events include `outletId`, `tableId`, `orderId`, `orderNumber`.

| Event Type | Trigger |
|------------|---------|
| `selforder:new` | Order placed |
| `selforder:accepted` | Staff accepts |
| `selforder:rejected` | Staff rejects |
| `selforder:items_added` | Customer adds items |
| `selforder:item_updated` | Customer updates item qty |
| `selforder:item_removed` | Customer removes item |
| `selforder:cancelled` | Customer cancels order |
| `selforder:completed` | Order paid/completed |

### Order Channel (`order:updated`)
| Event Type | Trigger |
|------------|---------|
| `order:created` | New self-order |
| `order:confirmed` | Order accepted |
| `order:cancelled` | Order rejected/cancelled |
| `order:items_added` | Items added to order |
| `order:items_updated` | Item qty changed or removed |
| `order:payment_received` | Payment completed |

### Table Channel (`table:updated`)
- Emitted on: order placement, accept, cancel, payment
- Syncs table status across POS, KDS, and customer UI

### Socket Rooms
- `outlet:{outletId}` — all events for an outlet
- `floor:{floorId}` — floor-specific events
- `kitchen:{outletId}` — kitchen display events
- `cashier:{outletId}` — cashier events

---

## 8. Settings

Configurable per outlet via `system_settings` table:

| Setting | Default | Description |
|---------|---------|-------------|
| `self_order_enabled` | `false` | Master toggle |
| `self_order_accept_mode` | `manual` | `auto` (direct KOT) or `manual` (staff approval) |
| `self_order_session_timeout_minutes` | `120` | Session expiry in minutes |
| `self_order_require_phone` | `true` | Require phone before ordering |
| `self_order_require_name` | `true` | Require name before ordering |
| `self_order_max_sessions_per_table` | `1` | Max concurrent sessions per table |
| `self_order_allow_reorder` | `true` | Allow adding items to existing order |

---

## 9. Rate Limits

Per-IP limits with **short 5-second sliding windows** — if hit, the customer just waits ~5 seconds and the limit auto-resets (no long blocking):

| Endpoint Group | Limit | Window | Resumes In |
|----------------|-------|--------|------------|
| Session init (`/init`) | 8 req | 5 sec | ~5s |
| Menu browsing (`/menu`) | 10 req | 5 sec | ~5s |
| Order actions (`/order/*`) | 5 req | 5 sec | ~5s |
| Status polling (`/status`, `/cart`, `/session`) | 15 req | 5 sec | ~5s |

---

## 10. Database Schema

### `self_order_sessions`
| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGINT PK | Auto-increment |
| `token` | VARCHAR(64) UNIQUE | Session auth token |
| `outlet_id` | BIGINT FK | Outlet |
| `table_id` | BIGINT FK | Table |
| `floor_id` | BIGINT FK | Floor (nullable) |
| `customer_name` | VARCHAR(100) | Customer name |
| `customer_phone` | VARCHAR(20) | Customer phone |
| `status` | ENUM | active, ordering, completed, expired |
| `order_id` | BIGINT FK | Linked order (nullable) |
| `expires_at` | DATETIME | Session expiry (DB clock) |

### `self_order_logs`
Audit trail for all self-order actions:
- `session_init`, `menu_view`, `order_placed`, `order_accepted`
- `order_rejected`, `session_expired`, `session_completed`
- `order_cancelled`, `item_updated`, `item_removed`

### `self_order_cart`
Redis-first with DB fallback. Stores cart JSON per session.

---

## 11. Complete End-to-End Flow

```
1. Staff generates QR codes (one-time)
   POST /staff/qr/generate-all

2. Customer scans QR on table
   → Opens: /self-order?outlet=43&table=67

3. Frontend calls: POST /init { outletId: 43, tableId: 67 }
   → Returns: { token, sessionId, outlet, table, settings }

4. Customer browses menu: GET /menu (Bearer: session_token)

5. Customer saves cart: POST /cart { items: [...] }

6. Customer sets details: PUT /customer { name, phone }

7. Customer places order: POST /order { items: [...] }
   → Socket: selforder:new, order:created, table:updated

8a. AUTO MODE: Order → confirmed → KOT → kitchen
8b. MANUAL MODE: Order → pending → staff reviews
    Staff accepts: POST /staff/accept { orderId }
    → Socket: selforder:accepted, order:confirmed

9. Customer can:
   - Add items: POST /order/add-items
   - Update qty: PUT /order/item/:id { quantity }
   - Remove item: DELETE /order/item/:id
   - Cancel order: POST /order/cancel
   (All only before preparation starts)

10. Kitchen prepares → ready → served

11. Staff generates bill: POST /orders/:id/bill
12. Staff processes payment: POST /orders/payment
    → Auto: session completed, table freed
    → Socket: selforder:completed, order:payment_received

13. Customer scans SAME QR again → new session → new order cycle
```

---

## 12. Error Reference

| Error Message | HTTP | Cause |
|---------------|------|-------|
| "Outlet not found or inactive" | 404 | Invalid outlet ID |
| "Table not found" | 404 | Invalid table ID |
| "Table is not active" | 400 | Table deactivated |
| "Self-ordering is not enabled" | 403 | Setting disabled |
| "Restaurant is currently closed" | 403 | No active shift |
| "This table is currently managed by staff" | 409 | POS order on table |
| "This table is currently in use" | 409 | Self-order in progress |
| "Maximum active sessions reached" | 409 | Session limit hit |
| "Order cannot be cancelled — already being prepared" | 409 | Status past confirmed |
| "Item has already been sent to kitchen" | 409 | Item not pending |
| "Cannot remove the last item" | 422 | Use cancel instead |
| "No active order to cancel" | 400 | No order in session |
| "Too many order requests" | 429 | Rate limit exceeded |

---

## 13. Files Reference

| File | Purpose |
|------|---------|
| `src/services/selfOrder.service.js` | Core business logic |
| `src/controllers/selfOrder.controller.js` | HTTP handlers |
| `src/routes/selfOrder.routes.js` | Route definitions + rate limits |
| `src/validations/selfOrder.validation.js` | Joi schemas |
| `src/middlewares/selfOrderAuth.js` | Session token middleware |
| `src/constants/index.js` | SELF_ORDER constants |
| `src/services/settings.service.js` | Settings management |
| `src/database/migrations/060_self_order_system.sql` | DB schema |
| `src/database/migrations/066_expand_self_order_log_actions.sql` | Log ENUM expansion |
| `tests/test-self-order.js` | Full integration test (84 tests) |
| `tests/test-order-modifications.js` | Cancel/modify tests (28 tests) |
| `tests/test-static-qr.js` | Multi-cycle QR reuse test (19 tests) |
