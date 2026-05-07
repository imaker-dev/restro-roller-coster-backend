# iMaker POS — Per-Outlet Subscription System

## Architecture Overview

| Component | File | Purpose |
|---|---|---|
| DB Schema | `migrations/073_subscription_system.sql` | 4 tables: pricing, subscriptions, payments, notifications |
| Service | `services/subscription.service.js` | Core logic, Razorpay, Redis cache, lifecycle |
| Controller | `controllers/subscription.controller.js` | Master + outlet APIs + webhook |
| Routes | `routes/subscription.routes.js` | All endpoint definitions |
| Middleware | `middlewares/subscription.middleware.js` | Fast Redis-first check on every request |
| Auth Integration | `middlewares/auth.middleware.js` | `authenticate` now async + calls subscription check |
| Cron | `cron/index.js` | Daily 9 AM scan for notifications |

---

## Database Schema

### `subscription_pricing`
| Column | Type | Notes |
|---|---|---|
| `id` | PK | Auto-increment |
| `base_price` | DECIMAL(10,2) | Master-controlled |
| `gst_percentage` | DECIMAL(5,2) | e.g. 18.00 |
| `total_price` | Computed | `base + (base × GST%)` — stored |
| `is_active` | BOOLEAN | Only one active at a time |
| `effective_from` | DATE | Start date |
| `created_by` | FK | master user id |

### `outlet_subscriptions`
| Column | Type | Notes |
|---|---|---|
| `id` | PK | Auto-increment |
| `outlet_id` | FK → outlets | **UNIQUE** — one row per outlet |
| `status` | ENUM | `trial`, `active`, `grace_period`, `expired`, `suspended` |
| `subscription_start` | DATE | |
| `subscription_end` | DATE | |
| `grace_period_end` | DATE | 7 days after expiry |
| `last_payment_id` | FK | Links to `subscription_payments` |

### `subscription_payments`
| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `outlet_id` | FK | |
| `subscription_id` | FK → outlet_subscriptions | |
| `razorpay_order_id` | VARCHAR | Razorpay order ID |
| `razorpay_payment_id` | VARCHAR | Razorpay payment ID |
| `base_amount` | DECIMAL(10,2) | |
| `gst_amount` | DECIMAL(10,2) | |
| `total_amount` | DECIMAL(10,2) | |
| `status` | ENUM | `pending`, `captured`, `failed`, `refunded`, `manual` |

### `subscription_notifications`
| Column | Type | Notes |
|---|---|---|
| `id` | PK | |
| `outlet_id` | FK | |
| `type` | ENUM | `renewal_reminder_10d`, `renewal_reminder_3d`, `expired`, `grace_ending`, `grace_ended`, `manual_activation`, `manual_deactivation` |
| `channel` | VARCHAR | `in_app`, `email`, `whatsapp` |
| `metadata` | JSON | Extra data |

---

## Subscription Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│  OUTLET CREATED → status: expired (default)                      │
│                                                                  │
│  ├─ Master activates manually ───────→ status: active (1 year)    │
│  │                                                               │
│  └─ Outlet pays via Razorpay ───────→ status: active (1 year)    │
│                                                                  │
│  ACTIVE                                                          │
│  ├── 10 days before expiry → notification sent                  │
│  ├── 3 days before expiry → notification sent                   │
│  └── Expiry date ───────────────────→ status: grace_period (7d) │
│                                                                  │
│  GRACE PERIOD                                                    │
│  ├── Payment during grace ──────────→ status: active (extends)  │
│  └── Day 7 after expiry ────────────→ status: expired            │
│                                                                  │
│  EXPIRED → ALL APIs blocked (403) except subscription payment    │
└──────────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

### ─── MASTER APIs ─── (Requires `master` role)

---

#### 1. GET `/api/v1/subscriptions/pricing`
**View current subscription pricing.**

**Headers:**
```http
Authorization: Bearer {jwt_token}
```

**Response 200:**
```json
{
  "success": true,
  "pricing": {
    "id": 3,
    "basePrice": 9999.00,
    "gstPercentage": 18.00,
    "totalPrice": 11798.82,
    "effectiveFrom": "2026-05-01",
    "createdAt": "2026-05-01T06:30:00.000Z"
  }
}
```

**Response 200 (no pricing set):**
```json
{
  "success": true,
  "pricing": null,
  "message": "No pricing set yet"
}
```

---

#### 2. POST `/api/v1/subscriptions/pricing`
**Set new pricing (deactivates previous, only one active).**

**Headers:**
```http
Authorization: Bearer {jwt_token}
Content-Type: application/json
```

**Payload:**
```json
{
  "basePrice": 12000.00,
  "gstPercentage": 18.00
}
```

**Response 200:**
```json
{
  "success": true,
  "pricing": {
    "id": 4,
    "basePrice": 12000.00,
    "gstPercentage": 18.00
  },
  "message": "Pricing updated successfully"
}
```

**Validation:** `basePrice > 0`, `gstPercentage >= 0`

---

#### 3. GET `/api/v1/subscriptions`
**List all outlet subscriptions (paginated, filterable).**

**Headers:**
```http
Authorization: Bearer {jwt_token}
```

**Query Params:**
```
?page=1&limit=50&status=active&search=restaurant_name
```

**Response 200:**
```json
{
  "success": true,
  "subscriptions": [
    {
      "id": 15,
      "outlet_id": 43,
      "status": "active",
      "subscription_start": "2026-01-15",
      "subscription_end": "2027-01-15",
      "grace_period_end": null,
      "auto_renew": false,
      "notes": null,
      "created_at": "2026-01-15T04:00:00.000Z",
      "updated_at": "2026-01-15T04:00:00.000Z",
      "outlet_name": "Royal Cafe",
      "outlet_code": "RC001",
      "outlet_phone": "+91-9876543210",
      "outlet_email": "royal@example.com",
      "last_payment_id": 42,
      "last_paid_amount": 11798.82,
      "last_paid_at": "2026-01-15T04:30:00.000Z",
      "last_payment_status": "captured"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 147,
    "totalPages": 3
  }
}
```

---

#### 4. POST `/api/v1/subscriptions/:outletId/activate`
**Force activate a subscription (manual, by master).**

**Headers:**
```http
Authorization: Bearer {jwt_token}
Content-Type: application/json
```

**URL Params:** `outletId=43`

**Payload (optional):**
```json
{
  "startDate": "2026-05-01",
  "endDate": "2027-05-01",
  "notes": "Complimentary activation for pilot program"
}
```

**Response 200:**
```json
{
  "success": true,
  "outletId": 43,
  "status": "active",
  "subscriptionStart": "2026-05-01",
  "subscriptionEnd": "2027-05-01",
  "message": "Subscription activated"
}
```

**Defaults (if not provided):**
- `startDate`: today
- `endDate`: 1 year from today

---

#### 5. POST `/api/v1/subscriptions/:outletId/deactivate`
**Force suspend/deactivate an outlet subscription.**

**Headers:**
```http
Authorization: Bearer {jwt_token}
Content-Type: application/json
```

**URL Params:** `outletId=43`

**Payload (optional):**
```json
{
  "notes": "Deactivated for non-payment after multiple reminders"
}
```

**Response 200:**
```json
{
  "success": true,
  "outletId": 43,
  "status": "suspended",
  "message": "Subscription deactivated"
}
```

---

#### 6. POST `/api/v1/subscriptions/:outletId/extend`
**Extend subscription by N days (master override).**

**Headers:**
```http
Authorization: Bearer {jwt_token}
Content-Type: application/json
```

**URL Params:** `outletId=43`

**Payload:**
```json
{
  "days": 30
}
```

**Response 200:**
```json
{
  "success": true,
  "outletId": 43,
  "newEnd": "2027-02-14",
  "message": "Subscription extended by 30 days"
}
```

---

### ─── OUTLET APIs ─── (Any authenticated user with `outletId`)

---

#### 7. GET `/api/v1/subscriptions/my`
**View my outlet's subscription details.**

**Headers:**
```http
Authorization: Bearer {jwt_token}
```

**Response 200 (active):**
```json
{
  "success": true,
  "subscription": {
    "id": 15,
    "outlet_id": 43,
    "status": "active",
    "subscription_start": "2026-01-15",
    "subscription_end": "2027-01-15",
    "grace_period_end": null,
    "auto_renew": false,
    "notes": null,
    "created_at": "2026-01-15T04:00:00.000Z",
    "updated_at": "2026-01-15T04:00:00.000Z",
    "base_amount": 9999.00,
    "gst_amount": 1799.82,
    "total_amount": 11798.82,
    "paid_at": "2026-01-15T04:30:00.000Z",
    "payment_status": "captured",
    "outlet_name": "Royal Cafe",
    "isBlocked": false,
    "graceDaysRemaining": null
  }
}
```

**Response 200 (expired, no grace):**
```json
{
  "success": true,
  "subscription": {
    "id": 15,
    "outlet_id": 43,
    "status": "expired",
    "subscription_start": "2025-01-15",
    "subscription_end": "2026-01-15",
    "grace_period_end": null,
    "outlet_name": "Royal Cafe",
    "isBlocked": true,
    "graceDaysRemaining": 0
  }
}
```

**Response 200 (grace period):**
```json
{
  "success": true,
  "subscription": {
    "id": 15,
    "outlet_id": 43,
    "status": "grace_period",
    "subscription_end": "2026-05-01",
    "grace_period_end": "2026-05-08",
    "outlet_name": "Royal Cafe",
    "isBlocked": false,
    "graceDaysRemaining": 3
  }
}
```

---

#### 8. POST `/api/v1/subscriptions/create-order`
**Create Razorpay order for subscription payment.**

**Headers:**
```http
Authorization: Bearer {jwt_token}
Content-Type: application/json
```

**Response 200:**
```json
{
  "success": true,
  "orderId": "order_NxLkY8mPqz7aB1",
  "amount": 1179882,
  "currency": "INR",
  "keyId": "rzp_live_SR53cU3nE2O1gl",
  "basePrice": 9999.00,
  "gstAmount": 1799.82,
  "totalPrice": 11798.82,
  "gstPercentage": 18.00,
  "receipt": "sub_43_1714567890123"
}
```

**Note:** `amount` is in **paise** (₹11,798.82 × 100 = 1,179,882). Pass this to Razorpay checkout in Flutter.

---

#### 9. POST `/api/v1/subscriptions/verify-payment`
**Verify Razorpay payment + extend subscription.**

**Headers:**
```http
Authorization: Bearer {jwt_token}
Content-Type: application/json
```

**Payload:**
```json
{
  "razorpayOrderId": "order_NxLkY8mPqz7aB1",
  "razorpayPaymentId": "pay_NxLkZ9mPqz7aB2",
  "razorpaySignature": "2b9f7e..."
}
```

**Response 200 (new subscription):**
```json
{
  "success": true,
  "message": "Payment verified and subscription activated",
  "subscriptionStart": "2026-05-02",
  "subscriptionEnd": "2027-05-02"
}
```

**Response 200 (already processed):**
```json
{
  "success": true,
  "message": "Payment already processed"
}
```

**Response 400 (invalid signature):**
```json
{
  "success": false,
  "message": "Razorpay signature verification failed"
}
```

---

### ─── WEBHOOK ─── (Public, signature-verified)

---

#### 10. POST `/api/v1/subscriptions/webhook`
**Razorpay async webhook for payment confirmation.**

**Headers:**
```http
x-razorpay-signature: t=1714567890,v1=2b9f7e...
```

**Payload (from Razorpay):**
```json
{
  "event": "payment.captured",
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_NxLkZ9mPqz7aB2",
        "order_id": "order_NxLkY8mPqz7aB1",
        "amount": 1179882,
        "currency": "INR",
        "status": "captured"
      }
    }
  }
}
```

**Response 200 (always — prevents Razorpay retries):**
```json
{
  "success": true,
  "processed": true
}
```

---

## Middleware Behavior

### Subscription Check Flow (Every Authenticated Request)

```
Request arrives
    │
    ├─ No token → skip (auth handles)
    │
    ├─ master role → BYPASS (always allowed)
    │
    ├─ URL starts with /api/v1/subscriptions/* → SKIP (payment must work)
    ├─ URL starts with /api/v1/auth/* → SKIP
    ├─ URL starts with /api/v1/health → SKIP
    │
    ├─ No outletId in token/query/params → skip (can't check)
    │
    └─ Check Redis: subscription:status:{outletId} (5-min TTL)
         │
         ├─ Cache HIT → use cached status
         └─ Cache MISS → DB lookup + auto-transition + write cache
              │
              ├─ status = active → allow, set X-Subscription-Status header
              ├─ status = grace_period → allow, set X-Subscription-Grace-Days header
              └─ status = expired/suspended → 403 SUBSCRIPTION_EXPIRED
```

### Response Headers

| Header | When | Value |
|---|---|---|
| `X-Subscription-Status` | Always (non-expired) | `active`, `trial`, `grace_period` |
| `X-Subscription-End` | Active/trial | `2027-01-15` |
| `X-Subscription-Grace-Days` | Grace period | `3` |

### 403 Response (Subscription Expired)
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

## Cron Job — Daily at 9 AM

| Trigger | Action | Notification Queued |
|---|---|---|
| 10 days before expiry | Log + BullMQ job | `subscription-reminder-10d` |
| 3 days before expiry | Log + BullMQ job | `subscription-reminder-3d` |
| Expiry date | Status → `grace_period` | `subscription-expired` |
| Grace day 7 | Status → `expired` (hard stop) | `subscription-grace-ended` |

---

## Environment Variables

```bash
# Razorpay (subscription payments)
RAZORPAY_KEY_ID=rzp_live_SR53cU3nE2O1gl
RAZORPAY_KEY_SECRET=eWfR8jfsNHPhJ0QVrz4c8

# Optional: webhook secret for signature verification
RAZORPAY_WEBHOOK_SECRET=whsec_your_webhook_secret_here
```

---

## Database Indexes (Optimized for 1000+ Outlets)

| Table | Index | Query |
|---|---|---|
| `outlet_subscriptions` | `(outlet_id, status)` | Middleware check (every request) |
| `outlet_subscriptions` | `(status, subscription_end)` | Cron: find expiring |
| `outlet_subscriptions` | `(status, grace_period_end)` | Cron: find grace ending |
| `subscription_payments` | `(razorpay_order_id)` | Unique, webhook lookup |
| `subscription_payments` | `(outlet_id, created_at)` | Payment history |
| `subscription_notifications` | `(outlet_id, type, sent_at)` | Prevent duplicates |
| `subscription_pricing` | `(is_active, effective_from)` | Get current pricing |

---

## Redis Cache Strategy

| Key Pattern | TTL | Invalidation |
|---|---|---|
| `subscription:status:{outletId}` | 300s (5 min) | On payment, activation, deactivation |

**Why 5 minutes?** Balance between DB load reduction and responsiveness. Subscription status changes infrequently (max once per day during cron), so 5 min is safe.

---

## Testing Commands

### 1. Set pricing (master)
```bash
curl -X POST http://localhost:3005/api/v1/subscriptions/pricing \
  -H "Authorization: Bearer {master_token}" \
  -H "Content-Type: application/json" \
  -d '{"basePrice":9999,"gstPercentage":18}'
```

### 2. View current pricing
```bash
curl http://localhost:3005/api/v1/subscriptions/pricing \
  -H "Authorization: Bearer {master_token}"
```

### 3. Create Razorpay order (outlet admin)
```bash
curl -X POST http://localhost:3005/api/v1/subscriptions/create-order \
  -H "Authorization: Bearer {outlet_token}"
```

### 4. Check my subscription
```bash
curl http://localhost:3005/api/v1/subscriptions/my \
  -H "Authorization: Bearer {outlet_token}"
```

### 5. Master: List all subscriptions
```bash
curl "http://localhost:3005/api/v1/subscriptions?page=1&limit=20&status=active" \
  -H "Authorization: Bearer {master_token}"
```

### 6. Master: Force activate
```bash
curl -X POST http://localhost:3005/api/v1/subscriptions/43/activate \
  -H "Authorization: Bearer {master_token}" \
  -H "Content-Type: application/json" \
  -d '{"notes":"Pilot program activation"}'
```

### 7. Master: Force deactivate
```bash
curl -X POST http://localhost:3005/api/v1/subscriptions/43/deactivate \
  -H "Authorization: Bearer {master_token}"
```

---

## Security Checklist

- ✅ Razorpay secret key never exposed in API responses
- ✅ Signature verification server-side (HMAC-SHA256)
- ✅ Webhook always returns 200 (prevents Razorpay retries on errors)
- ✅ `master` role bypasses subscription check (platform admin)
- ✅ Subscription routes are exempt from check (payment flow must work)
- ✅ All amounts use `DECIMAL(10,2)` — no floating-point errors
- ✅ Transactions wrap payment + subscription updates (atomic)
- ✅ `FOR UPDATE` lock on payment row during verification (prevents double-processing)

---

## Implementation Files Summary

| # | File | Lines | Status |
|---|---|---|---|
| 1 | `database/migrations/073_subscription_system.sql` | 75 | ✅ Migrated |
| 2 | `services/subscription.service.js` | 592 | ✅ Created |
| 3 | `controllers/subscription.controller.js` | 324 | ✅ Created |
| 4 | `routes/subscription.routes.js` | 37 | ✅ Created |
| 5 | `middlewares/subscription.middleware.js` | 107 | ✅ Created |
| 6 | `middlewares/auth.middleware.js` | 275 | ✅ Modified (async + sub check) |
| 7 | `routes/index.js` | 88 | ✅ Modified (+/subscriptions) |
| 8 | `cron/index.js` | 230 | ✅ Modified (daily scan job) |
| 9 | `constants/index.js` | 325 | ✅ Modified (new constants) |
| 10 | `database/index.js` | 110 | ✅ Modified (+connectTimeout, acquireTimeout) |
