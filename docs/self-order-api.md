# Self-Order System — API Documentation

> **Base URL:** `{HOST}/api/v1/self-order`
> **Menu URL:** `{HOST}/api/v1/menu`

---

## Table of Contents

1. [Session Init](#1-session-init)
2. [Get Menu (Public)](#2-get-menu-public)
3. [Get Session Info](#3-get-session-info)
4. [Update Customer Details](#4-update-customer-details)
5. [Save Cart](#5-save-cart)
6. [Get Cart](#6-get-cart)
7. [Place Order](#7-place-order)
8. [Add Items to Order (Reorder)](#8-add-items-to-order-reorder)
9. [Get Order Status](#9-get-order-status)
10. [Get Past Orders](#10-get-past-orders)
11. [Staff — Get Pending Orders](#11-staff--get-pending-orders)
12. [Staff — Accept Order](#12-staff--accept-order)
13. [Staff — Reject Order](#13-staff--reject-order)
14. [Staff — Get Settings](#14-staff--get-settings)
15. [Staff — Generate QR for Table](#15-staff--generate-qr-for-table)
16. [Staff — Bulk Generate QR](#16-staff--bulk-generate-qr)
17. [Staff — Complete Session](#17-staff--complete-session)

---

## Authentication

| Endpoint Type | Auth Method |
|---|---|
| **Public (customer)** | `Authorization: Bearer <session_token>` (from `/init`) or `?token=<session_token>` |
| **Staff** | `Authorization: Bearer <jwt_token>` (standard JWT login) |
| **Menu** | No auth required (public) |

### Device-Based Session Control

Each self-order session is bound to a specific device. This prevents:
- Multiple devices accessing the same table's active order
- Unauthorized modifications from other customers' phones

**Frontend Requirements:**
1. Generate a unique `deviceId` (UUID) on first app load
2. Store in `localStorage.setItem('deviceId', uuid)`
3. Send with every request:
   - `/init`: in request body as `deviceId`
   - All other endpoints: in header `X-Device-Id: <deviceId>`

**Behavior:**
| Scenario | Result |
|---|---|
| Same device re-scans QR | ✅ Resumes existing session |
| Same device refreshes page | ✅ Resumes existing session |
| Different device scans QR | ❌ Blocked with 409 error |
| Different device uses stolen token | ❌ Blocked with 403 error |

### Smart Session Expiry

Sessions automatically expire based on configurable rules:

| Rule | Condition | Default Timeout | Configurable |
|------|-----------|-----------------|--------------|
| **Idle Timeout** | Session created but no order placed | 10 minutes | `idleTimeoutMinutes` (1-120) |
| **Active Order** | Order in progress (pending/confirmed/preparing/ready) | Never expires | N/A |
| **Completion Buffer** | Order completed/cancelled/paid | 1 minute | `completionBufferMinutes` (1-60) |

**Configure via Settings API:**
```json
PATCH /api/v1/self-order/staff/settings/:outletId
{
  "idleTimeoutMinutes": 10,
  "completionBufferMinutes": 1
}
```

---

## Step-by-Step Customer Flow

```
1. Customer scans QR → frontend generates/retrieves deviceId from localStorage
2. Calls POST /init with deviceId → receives session token
3. Stores token + deviceId in local storage
4. Fetches menu → GET /menu/{outletId}/captain (public, no token needed)
5. Browses, adds to cart → POST /cart (with X-Device-Id header)
6. Places order → POST /order (with X-Device-Id header)
7. Tracks status → GET /order/status (polling or via WebSocket)
8. Wants more food → POST /order/add-items (with X-Device-Id header)
9. Views history → GET /orders
```

---

## 1. Session Init

Initializes a self-order session when customer scans the QR code.

```
POST /api/v1/self-order/init
```

**Rate Limit:** 10 requests/minute per IP

**Request Body:**
```json
{
  "outletId": 43,
  "tableId": 12,
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",  // REQUIRED: UUID from localStorage
  "qrToken": "a1b2c3d4e5f6..."  // optional, from QR URL
}
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "f8a3b1c2d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1",
    "sessionId": 1,
    "outlet": { "id": 43, "name": "Main Restaurant" },
    "table": {
      "id": 12,
      "number": "T-05",
      "name": "Window Table 5",
      "floorName": "Ground Floor"
    },
    "orderId": null,
    "status": "active",
    "customerName": null,
    "customerPhone": null,
    "expiresAt": "2026-04-27T13:30:00.000Z",
    "settings": {
      "requirePhone": true,
      "requireName": true,
      "acceptMode": "auto",
      "allowReorder": true
    }
  }
}
```

**Error Responses:**
| Status | Condition |
|---|---|
| 403 | Self-ordering not enabled for outlet |
| 404 | Outlet or table not found |
| 409 | Max active sessions reached for this table |
| 410 | QR code expired (token rotated) |

---

## 2. Get Menu (Public)

Fetches the full menu for the outlet. **No authentication required.**

```
GET /api/v1/menu/:outletId/captain
```

**Query Parameters (optional):**
| Param | Type | Description |
|---|---|---|
| `filter` | string | `veg`, `non_veg`, `egg`, `vegan` |
| `serviceType` | string | `dine_in`, `takeaway`, `delivery` |

**Example:**
```
GET /api/v1/menu/43/captain?filter=veg
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "categories": [
      {
        "id": 1,
        "name": "Starters",
        "displayOrder": 1,
        "items": [
          {
            "id": 101,
            "name": "Paneer Tikka",
            "shortName": "P.Tikka",
            "basePrice": 280.00,
            "itemType": "veg",
            "imageUrl": "https://...",
            "description": "...",
            "isAvailable": true,
            "variants": [
              { "id": 201, "name": "Half", "price": 160.00 },
              { "id": 202, "name": "Full", "price": 280.00 }
            ],
            "addonGroups": [
              {
                "id": 50,
                "name": "Extra Toppings",
                "minSelect": 0,
                "maxSelect": 3,
                "addons": [
                  { "id": 501, "name": "Extra Cheese", "price": 40.00 },
                  { "id": 502, "name": "Jalapeños", "price": 20.00 }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}
```

---

## 3. Get Session Info

Returns current session details (table, outlet, order status).

```
GET /api/v1/self-order/session
Authorization: Bearer <session_token>
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "token": "f8a3b1c2...",
    "outletId": 43,
    "tableId": 12,
    "floorId": 1,
    "tableNumber": "T-05",
    "tableName": "Window Table 5",
    "floorName": "Ground Floor",
    "outletName": "Main Restaurant",
    "customerName": "Rahul",
    "customerPhone": "9876543210",
    "orderId": 501,
    "status": "ordering",
    "expiresAt": "2026-04-27T13:30:00.000Z"
  }
}
```

---

## 4. Update Customer Details

Update customer name and phone on the session. Required before placing order if settings enforce it.

```
PUT /api/v1/self-order/customer
Authorization: Bearer <session_token>
```

**Request Body:**
```json
{
  "customerName": "Rahul Sharma",
  "customerPhone": "9876543210"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "customerName": "Rahul Sharma",
    "customerPhone": "9876543210"
  }
}
```

**Error:** 400 if phone format invalid (must be 10–15 digits).

---

## 5. Save Cart

Persists the customer's cart server-side (Redis + DB). Cart auto-clears on order placement.

```
POST /api/v1/self-order/cart
Authorization: Bearer <session_token>
```

**Request Body:**
```json
{
  "items": [
    {
      "itemId": 101,
      "variantId": 202,
      "name": "Paneer Tikka",
      "variantName": "Full",
      "quantity": 2,
      "unitPrice": 280.00,
      "specialInstructions": "Less spicy",
      "addons": [
        { "addonId": 501, "addonGroupId": 50, "name": "Extra Cheese", "price": 40.00, "quantity": 1 }
      ]
    },
    {
      "itemId": 105,
      "variantId": null,
      "name": "Butter Naan",
      "variantName": null,
      "quantity": 4,
      "unitPrice": 45.00,
      "addons": []
    }
  ]
}
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "items": [ ... ],
    "updatedAt": "2026-04-27T11:35:00.000Z"
  }
}
```

---

## 6. Get Cart

Retrieve the saved cart for the current session.

```
GET /api/v1/self-order/cart
Authorization: Bearer <session_token>
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "itemId": 101,
        "variantId": 202,
        "name": "Paneer Tikka",
        "variantName": "Full",
        "quantity": 2,
        "unitPrice": 280.00,
        "specialInstructions": "Less spicy",
        "addons": [
          { "addonId": 501, "addonGroupId": 50, "name": "Extra Cheese", "price": 40.00, "quantity": 1 }
        ]
      }
    ],
    "updatedAt": "2026-04-27T11:35:00.000Z"
  }
}
```

**Empty cart:**
```json
{
  "success": true,
  "data": { "items": [], "updatedAt": null }
}
```

---

## 7. Place Order

Submit the order. Cart is automatically cleared. In **auto-accept** mode, KOT is generated immediately. In **manual** mode, order goes to pending for staff approval.

```
POST /api/v1/self-order/order
Authorization: Bearer <session_token>
```

**Rate Limit:** 5 requests/minute per IP

**Request Body:**
```json
{
  "customerName": "Rahul Sharma",
  "customerPhone": "9876543210",
  "specialInstructions": "No onion in all items",
  "items": [
    {
      "itemId": 101,
      "variantId": 202,
      "quantity": 2,
      "specialInstructions": "Less spicy",
      "addons": [
        { "addonId": 501, "addonGroupId": 50, "quantity": 1 }
      ]
    },
    {
      "itemId": 105,
      "variantId": null,
      "quantity": 4,
      "specialInstructions": null,
      "addons": []
    }
  ]
}
```

**Success Response (201):**
```json
{
  "success": true,
  "message": "Order placed successfully",
  "data": {
    "id": 501,
    "uuid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "orderNumber": "ORD-0042",
    "outletId": 43,
    "tableId": 12,
    "tableNumber": "T-05",
    "tableName": "Window Table 5",
    "floorId": 1,
    "floorName": "Ground Floor",
    "customerName": "Rahul Sharma",
    "customerPhone": "9876543210",
    "status": "confirmed",
    "orderSource": "self_order",
    "subtotal": 740.00,
    "taxAmount": 37.00,
    "totalAmount": 777.00,
    "itemCount": 2,
    "specialInstructions": "No onion in all items",
    "createdAt": "2026-04-27T11:40:00.000Z"
  }
}
```

| `status` value | Meaning |
|---|---|
| `confirmed` | Auto-accept mode — KOT sent to kitchen |
| `pending` | Manual mode — waiting for staff approval |

**Error Responses:**
| Status | Condition |
|---|---|
| 409 | Order already placed for this session |
| 422 | Customer details required but missing |
| 400 | Item not found or unavailable |

---

## 8. Add Items to Order (Reorder)

Add more items to an existing order (same session). Only works if `allowReorder` is enabled.

```
POST /api/v1/self-order/order/add-items
Authorization: Bearer <session_token>
```

**Rate Limit:** 5 requests/minute per IP

**Request Body:**
```json
{
  "specialInstructions": "Extra raita",
  "items": [
    {
      "itemId": 110,
      "variantId": null,
      "quantity": 1,
      "addons": []
    }
  ]
}
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "orderId": 501,
    "orderNumber": "ORD-0042",
    "addedItems": 1,
    "addedSubtotal": 150.00,
    "addedTax": 7.50,
    "addedTotal": 157.50,
    "message": "Items added and sent to kitchen"
  }
}
```

**Error:** 400 if no active order in this session.

---

## 9. Get Order Status

Track the current order status. Use for polling. For real-time, listen to WebSocket `selforder:update` events.

```
GET /api/v1/self-order/order/status
Authorization: Bearer <session_token>
```

**Rate Limit:** 60 requests/minute per IP

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "orderId": 501,
    "orderNumber": "ORD-0042",
    "status": "preparing",
    "subtotal": 740.00,
    "taxAmount": 37.00,
    "totalAmount": 777.00,
    "items": [
      {
        "id": 1001,
        "name": "Paneer Tikka",
        "variantName": "Full",
        "quantity": 2,
        "status": "preparing",
        "unitPrice": 280.00,
        "totalPrice": 560.00
      },
      {
        "id": 1002,
        "name": "Butter Naan",
        "quantity": 4,
        "status": "sent_to_kitchen",
        "unitPrice": 45.00,
        "totalPrice": 180.00
      }
    ],
    "createdAt": "2026-04-27T11:40:00.000Z"
  }
}
```

---

## 10. Get Past Orders

Get all self-orders placed for this table (current + previous sessions).

```
GET /api/v1/self-order/orders
Authorization: Bearer <session_token>
```

**Query Parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 10 | Max orders to return |

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "orders": [
      {
        "id": 501,
        "orderNumber": "ORD-0042",
        "status": "preparing",
        "subtotal": 740.00,
        "taxAmount": 37.00,
        "totalAmount": 777.00,
        "cancelReason": null,
        "createdAt": "2026-04-27T11:40:00.000Z",
        "isCurrentSession": true,
        "items": [
          {
            "id": 1001,
            "name": "Paneer Tikka",
            "variantName": "Full",
            "quantity": 2,
            "unitPrice": 280.00,
            "totalPrice": 560.00,
            "status": "preparing",
            "itemType": "veg",
            "specialInstructions": "Less spicy"
          }
        ]
      }
    ]
  }
}
```

---

## 11. Staff — Get Pending Orders

List self-orders awaiting approval (manual mode).

```
GET /api/v1/self-order/staff/pending/:outletId
Authorization: Bearer <jwt_token>
```

**Roles:** `super_admin`, `admin`, `manager`, `cashier`, `captain`

**Query Parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `status` | string | `pending` | Filter: `pending`, `confirmed`, etc. |
| `limit` | number | 50 | Max results |
| `offset` | number | 0 | Pagination offset |

**Success Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": 501,
      "orderNumber": "ORD-0042",
      "tableNumber": "T-05",
      "tableName": "Window Table 5",
      "floorName": "Ground Floor",
      "customerName": "Rahul Sharma",
      "customerPhone": "9876543210",
      "status": "pending",
      "totalAmount": 777.00,
      "itemCount": 2,
      "createdAt": "2026-04-27T11:40:00.000Z"
    }
  ]
}
```

---

## 12. Staff — Accept Order

Accept a pending self-order. Generates KOT and notifies kitchen.

```
POST /api/v1/self-order/staff/accept
Authorization: Bearer <jwt_token>
```

**Roles:** `super_admin`, `admin`, `manager`, `cashier`

**Request Body:**
```json
{
  "orderId": 501
}
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "orderId": 501,
    "status": "confirmed",
    "kotSent": true,
    "message": "Order accepted and sent to kitchen"
  }
}
```

**Errors:** 404 (not found), 409 (already accepted/rejected)

---

## 13. Staff — Reject Order

Reject a pending self-order with an optional reason. Customer is notified via WebSocket.

```
POST /api/v1/self-order/staff/reject
Authorization: Bearer <jwt_token>
```

**Roles:** `super_admin`, `admin`, `manager`, `cashier`

**Request Body:**
```json
{
  "orderId": 501,
  "reason": "Kitchen closed for this category"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "orderId": 501,
    "status": "cancelled",
    "message": "Order rejected"
  }
}
```

---

## 14. Staff — Get Settings

Retrieve all self-order settings for an outlet.

```
GET /api/v1/self-order/staff/settings/:outletId
Authorization: Bearer <jwt_token>
```

**Roles:** `super_admin`, `admin`, `manager`

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "enabled": true,
    "acceptMode": "auto",
    "sessionTimeoutMinutes": 120,
    "requirePhone": true,
    "requireName": true,
    "maxSessionsPerTable": 1,
    "allowReorder": true
  }
}
```

---

## 14b. Staff — Update Settings

Update self-order settings for an outlet. Only provided fields are updated.

```
PATCH /api/v1/self-order/staff/settings/:outletId
Authorization: Bearer <jwt_token>
```

**Roles:** `super_admin`, `admin`, `manager`

**Request Body (all fields optional):**
```json
{
  "enabled": true,
  "acceptMode": "manual",
  "sessionTimeoutMinutes": 120,
  "requirePhone": true,
  "requireName": true,
  "maxSessionsPerTable": 3,
  "allowReorder": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable self-ordering for this outlet |
| `acceptMode` | string | `"auto"` (auto-accept + send KOT) or `"manual"` (staff must accept) |
| `sessionTimeoutMinutes` | number | Session expiry time in minutes |
| `requirePhone` | boolean | Require customer phone to place order |
| `requireName` | boolean | Require customer name to place order |
| `maxSessionsPerTable` | number | Max concurrent sessions per table |
| `allowReorder` | boolean | Allow adding items to existing order |

**Success Response (200):**
```json
{
  "success": true,
  "message": "Settings updated",
  "data": {
    "enabled": true,
    "acceptMode": "manual",
    "sessionTimeoutMinutes": 120,
    "requirePhone": true,
    "requireName": true,
    "maxSessionsPerTable": 3,
    "allowReorder": true
  }
}
```

**Error Response (400):**
```json
{
  "success": false,
  "message": "Invalid acceptMode. Must be one of: auto, manual"
}
```

---

## 15. Staff — Generate QR for Table

Generate a self-order QR code image for a specific table.

```
POST /api/v1/self-order/staff/qr/generate
Authorization: Bearer <jwt_token>
```

**Roles:** `super_admin`, `admin`, `manager`

**Request Body:**
```json
{
  "outletId": 43,
  "tableId": 12,
  "baseUrl": "https://order.myrestaurant.com"
}
```

> `baseUrl` is optional. Defaults to `SELF_ORDER_URL` or `APP_URL` env variable.

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "tableId": 12,
    "tableNumber": "T-05",
    "tableName": "Window Table 5",
    "floorName": "Ground Floor",
    "qrUrl": "https://order.myrestaurant.com/self-order?outlet=43&table=12&token=a1b2c3d4...",
    "qrImagePath": "uploads/self-order-qr/so_qr_43_12.png",
    "qrToken": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
  }
}
```

The QR image is a 600×680 PNG with the QR code + table label.

---

## 16. Staff — Bulk Generate QR

Generate QR codes for **all active tables** in an outlet at once.

```
POST /api/v1/self-order/staff/qr/generate-all
Authorization: Bearer <jwt_token>
```

**Roles:** `super_admin`, `admin`, `manager`

**Request Body:**
```json
{
  "outletId": 43,
  "baseUrl": "https://order.myrestaurant.com"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "tables": [
      { "tableId": 12, "tableNumber": "T-05", "qrUrl": "...", "qrImagePath": "...", "qrToken": "..." },
      { "tableId": 13, "tableNumber": "T-06", "qrUrl": "...", "qrImagePath": "...", "qrToken": "..." }
    ],
    "count": 2
  }
}
```

---

## 17. Staff — Complete Session

Complete a self-order session and rotate the QR token. Old QR URLs become invalid (HTTP 410).

```
POST /api/v1/self-order/staff/session/:sessionId/complete
Authorization: Bearer <jwt_token>
```

**Roles:** `super_admin`, `admin`, `manager`, `cashier`

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "sessionId": 1,
    "completed": true,
    "qrTokenRotated": true
  }
}
```

---

## WebSocket Events

Subscribe to Socket.IO room: `outlet:{outletId}`, `captain:{outletId}`, `cashier:{outletId}`

| Event | Payload | Trigger |
|---|---|---|
| `selforder:update` | `{ type, outletId, order, timestamp }` | New order, accepted, rejected, status change |

**Event types:** `new_self_order`, `self_order_accepted`, `self_order_rejected`, `self_order_status_update`

---

## Migration

Run the database migration before first use:

```bash
node src/database/migrations/run-060-migration.js
```

This creates:
- `self_order_sessions` table
- `self_order_logs` table
- `self_order_cart` table
- `orders.order_source` column
- `orders.self_order_session_id` column
- `tables.qr_token` column (+ generates tokens for existing tables)

---

## Settings Keys

Configure via the Settings API or directly in `system_settings` table:

| Key | Type | Default | Description |
|---|---|---|---|
| `self_order_enabled` | boolean | `false` | Enable self-ordering for the outlet |
| `self_order_accept_mode` | string | `manual` | `auto` or `manual` |
| `self_order_session_timeout_minutes` | number | `120` | Session expiry time |
| `self_order_require_phone` | boolean | `true` | Require phone before order |
| `self_order_require_name` | boolean | `true` | Require name before order |
| `self_order_max_sessions_per_table` | number | `1` | Max concurrent sessions per table |
| `self_order_allow_reorder` | boolean | `true` | Allow adding items to existing order |
