# Subscription API Documentation

**Base URL**: `/api/v1/subscriptions`

## Table of Contents

- [Subscription Lifecycle](#subscription-lifecycle)
- [Pricing Hierarchy](#pricing-hierarchy)
- [Authentication](#authentication)
- [1. Master APIs](#1-master-apis)
  - [1.1 Global Pricing](#11-global-pricing)
  - [1.2 Super Admin Pricing](#12-super-admin-pricing)
  - [1.3 Outlet Pricing Override](#13-outlet-pricing-override)
  - [1.4 Resolve Effective Pricing](#14-resolve-effective-pricing)
  - [1.5 Subscription Management](#15-subscription-management)
  - [1.6 Subscription Scanner (Cron)](#16-subscription-scanner-cron)
- [2. Super Admin APIs](#2-super-admin-apis)
  - [2.1 Dashboard](#21-dashboard)
- [3. Outlet APIs](#3-outlet-apis)
  - [3.1 View My Subscription](#31-view-my-subscription)
  - [3.2 Create Payment Order](#32-create-payment-order)
  - [3.3 Verify Payment](#33-verify-payment)
- [4. Webhook (Public)](#4-webhook-public)
  - [4.1 Razorpay Webhook](#41-razorpay-webhook)
- [Subscription Statuses](#subscription-statuses)
- [Middleware: Auto-Block on Expiry](#middleware-auto-block-on-expiry)

---

## Subscription Lifecycle

```
[expired] ──(payment)──> [active] ──(end date passed)──> [grace_period (7 days)] ──(grace ended)──> [expired]
                             │
                      (master force) ──> [suspended]
```

1. New outlet starts as `expired`
2. Outlet pays via Razorpay → becomes `active` for 1 year
3. After subscription end date → auto-transitions to `grace_period` (7 days)
4. After grace period → `expired` (blocked from all APIs except payment)
5. Master can manually `activate`, `deactivate` (suspend), or `extend`

---

## Pricing Hierarchy

Pricing resolution follows this priority (highest to lowest):

```
1. Outlet Override  → Custom price set for a specific outlet
2. Super Admin      → Custom price set for a super admin (inherited by all their outlets)
3. Global           → Default platform-wide pricing from subscription_pricing table
```

---

## Authentication

All APIs (except webhook) require a JWT Bearer token:

```
Authorization: Bearer <jwt_token>
```

**Role-based access**:
- **master** — Full access to all APIs
- **super_admin** — Dashboard read-only + outlet payment APIs
- **admin/cashier/captain** — Outlet-facing APIs only (my subscription, create-order, verify-payment)

---

## 1. Master APIs

### 1.1 Global Pricing

#### GET `/pricing` — View Current Global Pricing

**Auth**: `master`

**Response** (200):
```json
{
  "success": true,
  "pricing": {
    "id": 1,
    "basePrice": 12000,
    "gstPercentage": 18,
    "totalPrice": 14160,
    "effectiveFrom": "2025-01-01",
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

**Response** (200 — no pricing set yet):
```json
{
  "success": true,
  "pricing": null,
  "message": "No pricing set yet"
}
```

---

#### POST `/pricing` — Set New Global Pricing

**Auth**: `master`

**Request Body**:
```json
{
  "basePrice": 12000,
  "gstPercentage": 18
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `basePrice` | number | Yes | Base annual price in ₹ (must be > 0) |
| `gstPercentage` | number | Yes | GST percentage (must be >= 0) |

**Response** (200):
```json
{
  "success": true,
  "pricing": {
    "id": 2,
    "basePrice": 12000,
    "gstPercentage": 18
  },
  "message": "Pricing updated successfully"
}
```

> **Note**: Setting new pricing deactivates the previous pricing. `total_price` is auto-calculated as `basePrice + (basePrice * gstPercentage / 100)`.

---

### 1.2 Super Admin Pricing

#### GET `/pricing/super-admin` — List All Super Admin Pricings

**Auth**: `master`

**Response** (200):
```json
{
  "success": true,
  "pricings": [
    {
      "id": 1,
      "user_id": 5,
      "user_name": "John Doe",
      "user_email": "john@example.com",
      "user_phone": "9876543210",
      "base_price": "10000.00",
      "gst_percentage": "18.00",
      "total_price": "11800.00",
      "notes": "Special deal for early adopter",
      "outlet_count": 12,
      "created_at": "2025-03-01T00:00:00.000Z",
      "updated_at": "2025-03-01T00:00:00.000Z"
    }
  ]
}
```

---

#### GET `/pricing/super-admin/:userId` — Get Pricing for a Specific Super Admin

**Auth**: `master`

**URL Params**: `userId` (integer) — The super admin's user ID

**Response** (200):
```json
{
  "success": true,
  "pricing": {
    "id": 1,
    "user_id": 5,
    "base_price": "10000.00",
    "gst_percentage": "18.00",
    "total_price": "11800.00",
    "is_active": 1,
    "notes": "Special deal",
    "created_by": 1,
    "created_at": "2025-03-01T00:00:00.000Z",
    "updated_at": "2025-03-01T00:00:00.000Z"
  }
}
```

**Response** (200 — no custom pricing):
```json
{
  "success": true,
  "pricing": null
}
```

---

#### POST `/pricing/super-admin/:userId` — Set Custom Pricing for a Super Admin

**Auth**: `master`

**URL Params**: `userId` (integer) — The super admin's user ID

**Request Body**:
```json
{
  "basePrice": 10000,
  "gstPercentage": 18,
  "notes": "Special deal for bulk outlets"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `basePrice` | number | Yes | Base annual price in ₹ (must be > 0) |
| `gstPercentage` | number | Yes | GST percentage (must be >= 0) |
| `notes` | string | No | Optional notes |

**Response** (200):
```json
{
  "success": true,
  "pricing": {
    "id": 3,
    "userId": 5,
    "basePrice": 10000,
    "gstPercentage": 18
  },
  "message": "Super admin pricing updated"
}
```

---

#### DELETE `/pricing/super-admin/:userId` — Remove Super Admin Custom Pricing

**Auth**: `master`

**URL Params**: `userId` (integer)

**Response** (200):
```json
{
  "success": true,
  "userId": 5,
  "deleted": true,
  "message": "Super admin pricing removed, outlets will use global pricing"
}
```

> **Effect**: All outlets under this super admin will fall back to global pricing.

---

### 1.3 Outlet Pricing Override

#### GET `/pricing/outlet/:outletId` — Get Outlet Pricing Override

**Auth**: `master`

**URL Params**: `outletId` (integer)

**Response** (200):
```json
{
  "success": true,
  "pricing": {
    "id": 1,
    "outlet_id": 43,
    "base_price": "8000.00",
    "gst_percentage": "18.00",
    "total_price": "9440.00",
    "is_active": 1,
    "notes": "Promotional rate",
    "created_by": 1,
    "created_at": "2025-04-01T00:00:00.000Z",
    "updated_at": "2025-04-01T00:00:00.000Z"
  }
}
```

**Response** (200 — no override):
```json
{
  "success": true,
  "pricing": null
}
```

---

#### POST `/pricing/outlet/:outletId` — Set Outlet Pricing Override

**Auth**: `master`

**URL Params**: `outletId` (integer)

**Request Body**:
```json
{
  "basePrice": 8000,
  "gstPercentage": 18,
  "notes": "Promotional rate for first year"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `basePrice` | number | Yes | Base annual price in ₹ (must be > 0) |
| `gstPercentage` | number | Yes | GST percentage (must be >= 0) |
| `notes` | string | No | Optional notes |

**Response** (200):
```json
{
  "success": true,
  "pricing": {
    "id": 5,
    "outletId": 43,
    "basePrice": 8000,
    "gstPercentage": 18
  },
  "message": "Outlet pricing override set"
}
```

---

#### DELETE `/pricing/outlet/:outletId` — Remove Outlet Pricing Override

**Auth**: `master`

**URL Params**: `outletId` (integer)

**Response** (200):
```json
{
  "success": true,
  "outletId": 43,
  "deleted": true,
  "message": "Outlet pricing override removed"
}
```

> **Effect**: Outlet falls back to super admin pricing → global pricing.

---

### 1.4 Resolve Effective Pricing

#### GET `/pricing/resolve/:outletId` — Resolve Effective Pricing for an Outlet

**Auth**: `master`

Shows which pricing layer is active for a specific outlet.

**URL Params**: `outletId` (integer)

**Response** (200):
```json
{
  "success": true,
  "pricing": {
    "basePrice": 10000,
    "gstPercentage": 18,
    "totalPrice": 11800,
    "source": "super_admin",
    "sourceId": 3
  }
}
```

| `source` Value | Meaning |
|----------------|---------|
| `"outlet"` | Using outlet-level override |
| `"super_admin"` | Using super admin custom pricing |
| `"global"` | Using platform default pricing |

---

### 1.5 Subscription Management

#### GET `/` — List All Subscriptions (Paginated)

**Auth**: `master`

**Query Parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | integer | 1 | Page number |
| `limit` | integer | 50 | Items per page (max 100) |
| `status` | string | — | Filter: `active`, `expired`, `grace_period`, `suspended`, `trial` |
| `search` | string | — | Search by outlet name or code |
| `pricingSource` | string | — | Filter: `global`, `super_admin`, `outlet` |
| `expiringWithinDays` | integer | — | Show subscriptions expiring within N days |
| `expiringToday` | boolean | — | `true` or `1` to filter expiring today |
| `expiredOnly` | boolean | — | `true` or `1` for expired + grace_period only |
| `superAdminId` | integer | — | Filter by super admin user ID |

**Response** (200):
```json
{
  "success": true,
  "subscriptions": [
    {
      "id": 1,
      "outlet_id": 43,
      "status": "active",
      "subscription_start": "2025-01-01",
      "subscription_end": "2026-01-01",
      "grace_period_end": null,
      "auto_renew": 0,
      "pricing_source": "global",
      "notes": null,
      "created_at": "2025-01-01T00:00:00.000Z",
      "updated_at": "2025-05-01T00:00:00.000Z",
      "outlet_name": "My Restaurant",
      "outlet_code": "MR001",
      "outlet_phone": "9876543210",
      "outlet_email": "info@myrestaurant.com",
      "last_payment_id": 5,
      "last_paid_amount": "14160.00",
      "last_paid_at": "2025-01-01T00:00:00.000Z",
      "last_payment_status": "captured",
      "payment_pricing_source": "global"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 120,
    "totalPages": 3
  }
}
```

---

#### POST `/:outletId/activate` — Force Activate Subscription

**Auth**: `master`

**URL Params**: `outletId` (integer)

**Request Body**:
```json
{
  "startDate": "2025-05-05",
  "endDate": "2026-05-05",
  "notes": "Activated by master admin"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `startDate` | string (YYYY-MM-DD) | No | Defaults to today |
| `endDate` | string (YYYY-MM-DD) | No | Defaults to 1 year from start |
| `notes` | string | No | Admin notes |

**Response** (200):
```json
{
  "success": true,
  "outletId": 43,
  "status": "active",
  "subscriptionStart": "2025-05-05",
  "subscriptionEnd": "2026-05-05",
  "message": "Subscription activated"
}
```

---

#### POST `/:outletId/deactivate` — Force Deactivate (Suspend) Subscription

**Auth**: `master`

**URL Params**: `outletId` (integer)

**Request Body**:
```json
{
  "notes": "Non-payment"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `notes` | string | No | Reason for deactivation |

**Response** (200):
```json
{
  "success": true,
  "outletId": 43,
  "status": "suspended",
  "message": "Subscription deactivated"
}
```

---

#### POST `/:outletId/extend` — Extend Subscription by N Days

**Auth**: `master`

**URL Params**: `outletId` (integer)

**Request Body**:
```json
{
  "days": 30
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `days` | integer | Yes | Number of days to extend (must be > 0) |

**Response** (200):
```json
{
  "success": true,
  "outletId": 43,
  "newEnd": "2026-06-04",
  "message": "Subscription extended by 30 days"
}
```

---

### 1.6 Subscription Scanner (Cron)

#### GET `/scan` — Scan Expiring Subscriptions

**Auth**: `master`

Called by BullMQ cron job or manually. Scans all subscriptions and returns notification targets.

**Response** (200):
```json
{
  "success": true,
  "reminder10Days": [
    { "outletId": 43, "outletName": "My Restaurant", "subscriptionEnd": "2025-05-15" }
  ],
  "reminder3Days": [],
  "expiredToday": [],
  "graceEndedToday": []
}
```

---

## 2. Super Admin APIs

### 2.1 Dashboard

#### GET `/dashboard` — Super Admin Subscription Dashboard

**Auth**: `super_admin` or `master`

Shows all outlets owned by or assigned to the authenticated super admin.

**Query Parameters**:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | integer | 1 | Page number |
| `limit` | integer | 50 | Items per page (max 100) |
| `status` | string | — | Filter: `active`, `expired`, `grace_period`, `suspended` |
| `search` | string | — | Search by outlet name or code |

**Response** (200):
```json
{
  "success": true,
  "subscriptions": [
    {
      "id": 1,
      "outlet_id": 43,
      "status": "active",
      "subscription_start": "2025-01-01",
      "subscription_end": "2026-01-01",
      "grace_period_end": null,
      "pricing_source": "super_admin",
      "created_at": "2025-01-01T00:00:00.000Z",
      "updated_at": "2025-05-01T00:00:00.000Z",
      "outlet_name": "My Restaurant",
      "outlet_code": "MR001",
      "outlet_phone": "9876543210",
      "outlet_email": "info@myrestaurant.com",
      "last_paid_amount": "11800.00",
      "last_paid_at": "2025-01-01T00:00:00.000Z",
      "last_payment_status": "captured",
      "appliedPrice": 11800,
      "appliedPricingSource": "super_admin"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 12,
    "totalPages": 1
  }
}
```

---

## 3. Outlet APIs

### 3.1 View My Subscription

#### GET `/my` — View Current Outlet's Subscription

**Auth**: Any authenticated user with `outletId`

**Response** (200):
```json
{
  "success": true,
  "subscription": {
    "id": 1,
    "outlet_id": 43,
    "status": "active",
    "isBlocked": false,
    "graceDaysRemaining": null,
    "subscription_start": "2025-01-01",
    "subscription_end": "2026-01-01",
    "grace_period_end": null,
    "auto_renew": 0,
    "pricing_source": "global",
    "notes": null,
    "outlet_name": "My Restaurant",
    "base_amount": 12000,
    "gst_amount": 2160,
    "total_amount": 14160,
    "pricingInfo": {
      "basePrice": 12000,
      "gstPercentage": 18,
      "totalAmount": 14160,
      "pricingSource": "global",
      "paidAt": "2025-01-01T00:00:00.000Z",
      "paymentStatus": "captured"
    },
    "nextRenewalPricing": {
      "basePrice": 12000,
      "gstPercentage": 18,
      "totalPrice": 14160,
      "source": "global"
    }
  }
}
```

**Response** (200 — no subscription):
```json
{
  "success": true,
  "subscription": null
}
```

---

### 3.2 Create Payment Order

#### POST `/create-order` — Create Razorpay Payment Order

**Auth**: Any authenticated user with `outletId`

This is **Step 1** of the payment flow. Creates a Razorpay order with the resolved pricing for the outlet.

**Request Body**: None required (outlet is inferred from JWT token)

**Response** (200):
```json
{
  "success": true,
  "orderId": "order_SlftsglzWLBHWu",
  "amount": 1416000,
  "currency": "INR",
  "keyId": "rzp_live_xxxxx",
  "basePrice": 12000,
  "gstAmount": 2160,
  "totalPrice": 14160,
  "gstPercentage": 18,
  "receipt": "sub_43_1714896000000"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `orderId` | string | Razorpay order ID — pass to Razorpay checkout SDK |
| `amount` | integer | Amount in **paise** (₹14160 = 1416000 paise) |
| `currency` | string | Always `"INR"` |
| `keyId` | string | Razorpay **public** key for checkout |
| `basePrice` | number | Base price in ₹ |
| `gstAmount` | number | GST amount in ₹ |
| `totalPrice` | number | Total price in ₹ |
| `gstPercentage` | number | GST percentage applied |
| `receipt` | string | Unique receipt reference |

**Error** (500 — no pricing configured):
```json
{
  "success": false,
  "message": "No pricing configured — set global, super admin, or outlet pricing first"
}
```

---

### 3.3 Verify Payment

#### POST `/verify-payment` — Verify Razorpay Payment & Activate Subscription

**Auth**: Any authenticated user with `outletId`

This is **Step 2** of the payment flow. After Razorpay checkout completes in the Flutter app, send the payment details here to verify and activate the subscription.

**Request Body**:
```json
{
  "razorpayOrderId": "order_SlftsglzWLBHWu",
  "razorpayPaymentId": "pay_SlfuABCdef1234",
  "razorpaySignature": "a1b2c3d4e5f6..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `razorpayOrderId` | string | Yes | From Razorpay checkout response |
| `razorpayPaymentId` | string | Yes | From Razorpay checkout response |
| `razorpaySignature` | string | Yes | From Razorpay checkout response |

**Response** (200 — success):
```json
{
  "success": true,
  "message": "Payment verified and subscription activated",
  "subscriptionStart": "2025-05-05",
  "subscriptionEnd": "2026-05-05"
}
```

**Response** (200 — already processed):
```json
{
  "success": true,
  "message": "Payment already processed"
}
```

**Response** (400 — signature mismatch):
```json
{
  "success": false,
  "message": "Payment verification failed — signature mismatch"
}
```

---

## 4. Webhook (Public)

### 4.1 Razorpay Webhook

#### POST `/webhook` — Razorpay Async Payment Notification

**Auth**: None (public endpoint, verified via `x-razorpay-signature` header)

This is a **backup** payment confirmation. Razorpay calls this endpoint asynchronously after payment capture. If `verify-payment` was already called, this becomes a no-op.

**Headers**:
```
x-razorpay-signature: <hmac_sha256_hex>
Content-Type: application/json
```

**Request Body** (sent by Razorpay):
```json
{
  "event": "payment.captured",
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_SlfuABCdef1234",
        "order_id": "order_SlftsglzWLBHWu",
        "amount": 1416000,
        "currency": "INR",
        "status": "captured",
        "notes": {
          "outlet_id": "43",
          "user_id": "5",
          "type": "subscription_renewal"
        }
      }
    }
  }
}
```

**Response** (200):
```json
{
  "success": true,
  "processed": true
}
```

> **Note**: Always returns 200 to prevent Razorpay retries, even on errors.

---

## Subscription Statuses

| Status | Description | API Access |
|--------|-------------|------------|
| `trial` | Initial trial period | Full access |
| `active` | Paid and active subscription | Full access |
| `grace_period` | Subscription ended, 7-day grace | Full access + `X-Subscription-Grace-Days` header |
| `expired` | Grace period ended | **Blocked** — only subscription/payment APIs work |
| `suspended` | Manually suspended by master | **Blocked** — only subscription/payment APIs work |

---

## Middleware: Auto-Block on Expiry

Every authenticated API request passes through the subscription middleware:

1. **Master users** — always bypassed
2. **Subscription/auth/payment routes** — always bypassed
3. **Active/Trial** — passes through, adds `X-Subscription-Status` header
4. **Grace Period** — passes through, adds `X-Subscription-Status: grace_period` and `X-Subscription-Grace-Days: N` headers
5. **Expired/Suspended** — returns `403`:

```json
{
  "success": false,
  "code": "SUBSCRIPTION_EXPIRED",
  "message": "Your subscription has expired. Please renew to continue using the system.",
  "renewUrl": "/api/v1/subscriptions/create-order",
  "status": "expired",
  "graceDaysRemaining": 0
}
```

---

## Complete Payment Flow (Step by Step)

### For Flutter App:

```
Step 1: GET  /api/v1/subscriptions/my
        → Check current status, see nextRenewalPricing

Step 2: POST /api/v1/subscriptions/create-order
        → Get orderId, amount, keyId for Razorpay checkout

Step 3: Open Razorpay checkout in Flutter with orderId + keyId
        → User completes payment

Step 4: POST /api/v1/subscriptions/verify-payment
        → Send razorpayOrderId, razorpayPaymentId, razorpaySignature
        → Subscription activated for 1 year

Step 5: GET  /api/v1/subscriptions/my
        → Confirm active status
```

### For Master Admin:

```
Step 1: POST /api/v1/subscriptions/pricing
        → Set global pricing (required before any outlet can pay)

Step 2: POST /api/v1/subscriptions/pricing/super-admin/:userId (optional)
        → Set custom pricing for a super admin's outlets

Step 3: POST /api/v1/subscriptions/pricing/outlet/:outletId (optional)
        → Set custom pricing for a specific outlet

Step 4: GET  /api/v1/subscriptions?status=expired
        → Monitor expired subscriptions

Step 5: POST /api/v1/subscriptions/:outletId/activate (manual)
        → Force activate without payment if needed

Step 6: POST /api/v1/subscriptions/:outletId/extend
        → Extend subscription by N days
```

### For Super Admin:

```
Step 1: GET /api/v1/subscriptions/dashboard
        → View all their outlets' subscription status

Step 2: (Outlets pay individually via the outlet payment flow above)
```
