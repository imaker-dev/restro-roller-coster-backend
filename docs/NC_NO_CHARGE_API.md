# NC (No Charge) Feature - API Documentation

## Overview

The NC (No Charge) feature allows marking items or entire orders as "No Charge" - meaning the customer doesn't pay for them, but the actual value is still recorded for reporting and analytics.

**Key Behavior:**
- NC items are visible everywhere (order screen, bill, KOT, reports)
- NC item **price AND tax** are excluded from payable total
- NC items are clearly marked with "NC" tag
- All NC actions are audit logged

---

## Database Schema

### Tables

| Table | Description |
|-------|-------------|
| `nc_reasons` | Predefined NC reasons (Staff Meal, Customer Complaint, etc.) |
| `nc_logs` | Audit trail for all NC actions |

### Columns Added

**order_items:**
- `is_nc` - BOOLEAN - Whether item is NC
- `nc_reason_id` - FK to nc_reasons
- `nc_reason` - VARCHAR(255) - Reason text
- `nc_amount` - DECIMAL(12,2) - NC amount (item price)
- `nc_by` - FK to users - Who applied NC
- `nc_at` - DATETIME - When NC was applied

**orders:**
- `is_nc` - BOOLEAN - Whether entire order is NC
- `nc_reason_id` - FK to nc_reasons
- `nc_reason` - VARCHAR(255) - Reason text
- `nc_amount` - DECIMAL(12,2) - Total NC amount
- `nc_approved_by` - FK to users
- `nc_at` - DATETIME

**invoices:**
- `is_nc` - BOOLEAN
- `nc_amount` - DECIMAL(12,2) - Item price excluded
- `nc_tax_amount` - DECIMAL(12,2) - Tax excluded
- `payable_amount` - DECIMAL(12,2) - What customer pays

---

## API Endpoints

### 1. Get NC Reasons

Get available NC reasons for an outlet.

```
GET /api/v1/orders/:outletId/nc/reasons
```

**Headers:**
```json
{
  "Authorization": "Bearer <token>"
}
```

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| includeInactive | boolean | Include inactive reasons (default: false) |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Staff Meal",
      "description": "Food provided to staff members",
      "isActive": true,
      "displayOrder": 1
    },
    {
      "id": 2,
      "name": "Customer Complaint",
      "description": "Complimentary due to customer complaint",
      "isActive": true,
      "displayOrder": 2
    },
    {
      "id": 3,
      "name": "Complimentary",
      "description": "Complimentary item/order for guest",
      "isActive": true,
      "displayOrder": 3
    },
    {
      "id": 4,
      "name": "Owner Approval",
      "description": "NC approved by owner/management",
      "isActive": true,
      "displayOrder": 4
    },
    {
      "id": 5,
      "name": "Testing Order",
      "description": "Order created for testing purposes",
      "isActive": true,
      "displayOrder": 5
    },
    {
      "id": 6,
      "name": "Promotional",
      "description": "Promotional giveaway",
      "isActive": true,
      "displayOrder": 6
    }
  ]
}
```

---

### 2. Create NC Reason

Create a custom NC reason.

```
POST /api/v1/orders/:outletId/nc/reasons
```

**Headers:**
```json
{
  "Authorization": "Bearer <token>",
  "Content-Type": "application/json"
}
```

**Request Body:**
```json
{
  "name": "VIP Guest",
  "description": "Complimentary for VIP guests",
  "displayOrder": 7
}
```

**Response:**
```json
{
  "success": true,
  "message": "NC reason created",
  "data": {
    "id": 7,
    "name": "VIP Guest",
    "description": "Complimentary for VIP guests",
    "displayOrder": 7
  }
}
```

---

### 3. Mark Item as NC

Mark a specific order item as NC.

```
POST /api/v1/orders/:orderId/items/:orderItemId/nc
```

**Headers:**
```json
{
  "Authorization": "Bearer <token>",
  "Content-Type": "application/json"
}
```

**Request Body:**
```json
{
  "ncReasonId": 2,
  "ncReason": "Customer Complaint",
  "notes": "Customer found hair in dish"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Item marked as NC",
  "data": {
    "success": true,
    "orderItemId": 1743,
    "itemName": "Chilli Chicken Dry",
    "ncAmount": 319.00,
    "ncReason": "Customer Complaint"
  }
}
```

---

### 4. Remove NC from Item

Remove NC status from an item.

```
DELETE /api/v1/orders/:orderId/items/:orderItemId/nc
```

**Headers:**
```json
{
  "Authorization": "Bearer <token>",
  "Content-Type": "application/json"
}
```

**Request Body:**
```json
{
  "notes": "NC removed - customer agreed to pay"
}
```

**Response:**
```json
{
  "success": true,
  "message": "NC removed from item",
  "data": {
    "success": true,
    "orderItemId": 1743,
    "itemName": "Chilli Chicken Dry",
    "removedNCAmount": 319.00
  }
}
```

---

### 5. Mark Order as NC

Mark entire order as NC (all items become NC).

```
POST /api/v1/orders/:orderId/nc
```

**Headers:**
```json
{
  "Authorization": "Bearer <token>",
  "Content-Type": "application/json"
}
```

**Request Body:**
```json
{
  "ncReasonId": 1,
  "ncReason": "Staff Meal",
  "notes": "Kitchen staff lunch"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Order marked as NC",
  "data": {
    "success": true,
    "orderId": 844,
    "orderNumber": "ORD2603130006",
    "ncAmount": 1026.00,
    "ncReason": "Staff Meal"
  }
}
```

---

### 6. Remove NC from Order

Remove NC status from entire order.

```
DELETE /api/v1/orders/:orderId/nc
```

**Headers:**
```json
{
  "Authorization": "Bearer <token>",
  "Content-Type": "application/json"
}
```

**Request Body:**
```json
{
  "notes": "Order NC removed"
}
```

**Response:**
```json
{
  "success": true,
  "message": "NC removed from order",
  "data": {
    "success": true,
    "orderId": 844,
    "orderNumber": "ORD2603130006",
    "removedNCAmount": 1026.00
  }
}
```

---

### 7. Get NC Logs

Get audit logs for NC actions on an order.

```
GET /api/v1/orders/:orderId/nc/logs
```

**Headers:**
```json
{
  "Authorization": "Bearer <token>"
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "orderId": 844,
      "orderItemId": 1743,
      "actionType": "item_nc",
      "ncReasonId": 2,
      "ncReason": "Customer Complaint",
      "ncAmount": 319.00,
      "itemName": "Chilli Chicken Dry",
      "appliedBy": 1,
      "appliedByName": "Admin User",
      "appliedAt": "2026-03-13T12:10:48.000Z",
      "notes": "Customer found hair in dish"
    },
    {
      "id": 2,
      "orderId": 844,
      "orderItemId": 1743,
      "actionType": "item_nc_removed",
      "ncReasonId": null,
      "ncReason": "NC Removed",
      "ncAmount": 319.00,
      "itemName": "Chilli Chicken Dry",
      "appliedBy": 1,
      "appliedByName": "Admin User",
      "appliedAt": "2026-03-13T12:15:48.000Z",
      "notes": "Customer agreed to pay"
    }
  ]
}
```

---

### 8. Get NC Report

Get NC analytics report for an outlet.

```
GET /api/v1/orders/reports/:outletId/nc?startDate=2026-03-01&endDate=2026-03-13
```

**Headers:**
```json
{
  "Authorization": "Bearer <token>"
}
```

**Query Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| startDate | date | Yes | Start date (YYYY-MM-DD) |
| endDate | date | Yes | End date (YYYY-MM-DD) |
| groupBy | string | No | Group by: date, reason, staff, item |

**Response:**
```json
{
  "success": true,
  "data": {
    "dateRange": {
      "startDate": "2026-03-01",
      "endDate": "2026-03-13"
    },
    "summary": {
      "totalNCAmount": "1200.00",
      "totalNCOrders": 6,
      "totalNCItems": 15,
      "averageNCPerOrder": "200.00"
    },
    "byDate": [
      {
        "date": "2026-03-13",
        "ncOrders": 2,
        "ncItems": 4,
        "fullNCOrders": 1,
        "totalNCAmount": 500.00
      },
      {
        "date": "2026-03-12",
        "ncOrders": 4,
        "ncItems": 11,
        "fullNCOrders": 0,
        "totalNCAmount": 700.00
      }
    ],
    "byReason": [
      {
        "reason": "Staff Meal",
        "count": 10,
        "totalAmount": 800.00
      },
      {
        "reason": "Customer Complaint",
        "count": 5,
        "totalAmount": 400.00
      }
    ],
    "byStaff": [
      {
        "userId": 1,
        "userName": "Admin User",
        "count": 12,
        "totalAmount": 1000.00
      }
    ],
    "byItem": [
      {
        "itemName": "Cold Drink",
        "count": 8,
        "totalAmount": 640.00
      },
      {
        "itemName": "Paneer Tikka",
        "count": 2,
        "totalAmount": 500.00
      }
    ]
  }
}
```

---

## Bill Generation Flow with NC

### Step 1: Create Order with Items

```
POST /api/v1/orders
```

**Request:**
```json
{
  "outletId": 44,
  "orderType": "dine_in",
  "tableId": 5,
  "items": [
    { "itemId": 101, "quantity": 1 },
    { "itemId": 102, "quantity": 1 }
  ]
}
```

### Step 2: Mark Item as NC (Before Bill)

```
POST /api/v1/orders/844/items/1743/nc
```

**Request:**
```json
{
  "ncReason": "Customer Complaint"
}
```

### Step 3: Generate Bill

```
POST /api/v1/orders/844/bill
```

**Request:**
```json
{
  "generatedBy": 1
}
```

**Response (Bill with NC):**
```json
{
  "success": true,
  "data": {
    "id": 577,
    "invoiceNumber": "INV/2526/000064",
    "orderNumber": "ORD2603130006",
    "items": [
      {
        "id": 1743,
        "name": "Paneer Tikka",
        "quantity": 1,
        "unitPrice": 250.00,
        "totalPrice": 250.00,
        "taxAmount": 12.50,
        "isNC": false,
        "ncAmount": 0
      },
      {
        "id": 1744,
        "name": "Cold Drink",
        "quantity": 1,
        "unitPrice": 80.00,
        "totalPrice": 80.00,
        "taxAmount": 4.00,
        "isNC": true,
        "ncAmount": 80.00,
        "ncReason": "Customer Complaint"
      }
    ],
    "subtotal": 330.00,
    "taxableAmount": 250.00,
    "cgstAmount": 6.25,
    "sgstAmount": 6.25,
    "totalTax": 12.50,
    "grandTotal": 263.00,
    "ncAmount": 80.00,
    "ncTaxAmount": 4.00,
    "payableAmount": 263.00,
    "isNC": false,
    "amountInWords": "Two Hundred Sixty Three Rupees Only"
  }
}
```

### Bill Calculation Logic (Item NC)

```
Order Items:
┌─────────────────┬────────┬─────────┬────────┐
│ Item            │ Price  │ Tax 5%  │ Status │
├─────────────────┼────────┼─────────┼────────┤
│ Paneer Tikka    │ ₹250   │ ₹12.50  │ Normal │
│ Cold Drink      │ ₹80    │ ₹4.00   │ NC     │
└─────────────────┴────────┴─────────┴────────┘

Calculation:
- Subtotal (all items): ₹330
- Taxable Amount (non-NC): ₹250
- Tax (on non-NC only): ₹12.50
- NC Amount: ₹80
- NC Tax Amount: ₹4.00 (NOT charged)
- Grand Total: ₹262.50 → ₹263 (rounded)
- Payable: ₹263

The Cold Drink (₹80) and its tax (₹4) are EXCLUDED from payment.
```

### Step 4: Process Payment

```
POST /api/v1/orders/payment
```

**Request:**
```json
{
  "orderId": 844,
  "invoiceId": 577,
  "outletId": 44,
  "amount": 263.00,
  "paymentMode": "cash",
  "receivedBy": 1
}
```

**Response:**
```json
{
  "success": true,
  "message": "Payment processed successfully",
  "data": {
    "paymentId": 450,
    "orderId": 844,
    "invoiceId": 577,
    "amount": 263.00,
    "paymentMode": "cash",
    "orderStatus": "completed",
    "paymentStatus": "completed"
  }
}
```

---

## Order Level NC Flow

### Mark Entire Order as NC (Staff Meal)

```
POST /api/v1/orders/844/nc
```

**Request:**
```json
{
  "ncReason": "Staff Meal"
}
```

### Generate Bill

```
POST /api/v1/orders/844/bill
```

**Response:**
```json
{
  "success": true,
  "data": {
    "invoiceNumber": "INV/2526/000065",
    "items": [
      {
        "name": "Paneer Tikka",
        "totalPrice": 250.00,
        "isNC": true,
        "ncAmount": 250.00
      },
      {
        "name": "Cold Drink",
        "totalPrice": 80.00,
        "isNC": true,
        "ncAmount": 80.00
      }
    ],
    "subtotal": 330.00,
    "totalTax": 16.50,
    "grandTotal": 347.00,
    "ncAmount": 330.00,
    "ncTaxAmount": 16.50,
    "payableAmount": 0,
    "isNC": true,
    "amountInWords": "Zero Rupees Only"
  }
}
```

### Bill Display (Order NC)

```
==========================================
              INVOICE
==========================================
Order: ORD2603130006
Date: 13-Mar-2026 12:30 PM

Items:
------------------------------------------
Paneer Tikka          1 x ₹250    ₹250 (NC)
Cold Drink            1 x ₹80      ₹80 (NC)
------------------------------------------
Subtotal:                          ₹330
Tax (CGST 2.5% + SGST 2.5%):       ₹16.50
------------------------------------------
Total:                             ₹347

*** ORDER TYPE: NC (Staff Meal) ***
NC Amount:                         ₹330
NC Tax:                            ₹16.50
------------------------------------------
PAYABLE:                           ₹0.00
==========================================
```

---

## Split Payment with NC

### Generate Bill with NC Item

```
POST /api/v1/orders/844/bill
```

(Same as above - bill shows payableAmount: 263.00)

### Process Split Payment

```
POST /api/v1/orders/payment/split
```

**Request:**
```json
{
  "orderId": 844,
  "invoiceId": 577,
  "outletId": 44,
  "splits": [
    { "paymentMode": "cash", "amount": 150 },
    { "paymentMode": "upi", "amount": 113 }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Split payment processed",
  "data": {
    "paymentId": 451,
    "orderId": 844,
    "invoiceId": 577,
    "totalAmount": 263.00,
    "splits": [
      { "paymentMode": "cash", "amount": 150 },
      { "paymentMode": "upi", "amount": 113 }
    ],
    "orderStatus": "completed",
    "paymentStatus": "completed"
  }
}
```

---

## Reports with NC Tracking

### Daily Sales Report

```
GET /api/v1/orders/reports/44/daily-sales?startDate=2026-03-13&endDate=2026-03-13
```

**Response includes NC tracking:**
```json
{
  "success": true,
  "data": {
    "daily": [...],
    "summary": {
      "total_orders": 50,
      "nc_orders": 5,
      "nc_amount": "1500.00",
      "gross_sales": "25000.00",
      "net_sales": "23500.00",
      "total_collection": "23500.00"
    }
  }
}
```

---

## Permissions

| Action | Roles Allowed |
|--------|---------------|
| View NC Reasons | Admin, Manager, Cashier |
| Create NC Reason | Admin, Manager |
| Update NC Reason | Admin, Manager |
| Mark Item as NC | Admin, Manager, Cashier |
| Remove Item NC | Admin, Manager |
| Mark Order as NC | Admin, Manager, Cashier |
| Remove Order NC | Admin, Manager |
| View NC Logs | Admin, Manager, Cashier |
| View NC Report | Admin, Manager |

---

## Error Responses

### Item Already NC
```json
{
  "success": false,
  "message": "Item is already marked as NC"
}
```

### Order Already NC
```json
{
  "success": false,
  "message": "Order is already marked as NC"
}
```

### Cannot NC Cancelled Item
```json
{
  "success": false,
  "message": "Cannot mark cancelled item as NC"
}
```

### NC Reason Required
```json
{
  "success": false,
  "message": "NC reason is required"
}
```
