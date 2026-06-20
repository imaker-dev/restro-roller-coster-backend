# Franchise API Documentation

Base path: `/api/v1/franchises`

All public endpoints are **open — no authentication required**.
All admin endpoints require a valid `Bearer <token>` header with `admin` or `super_admin` role.

---

## Public Endpoints

### 1. List Franchises

```
GET /api/v1/franchises
```

Browse active franchises with full-text search, filters, and pagination.

**Query Parameters**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `search` | string | No | Search by name, category, city, or state |
| `category` | string | No | e.g. `cafe`, `restaurant`, `bakery`, `qsr` |
| `state` | string | No | Filter by state name |
| `city` | string | No | Filter by city name |
| `min_investment` | decimal | No | Minimum investment amount (e.g. `500000`) |
| `max_investment` | decimal | No | Maximum investment amount |
| `min_roi` | decimal | No | Minimum expected ROI percentage |
| `featured` | boolean | No | `true` to show only featured franchises |
| `sort` | string | No | `featured` (default), `newest`, `oldest`, `investment_asc`, `investment_desc`, `roi` |
| `page` | int | No | Page number, default `1` |
| `limit` | int | No | Items per page, default `12`, max `50` |

**Example Request**
```http
GET /api/v1/franchises?category=cafe&state=Gujarat&sort=featured&page=1&limit=12
```

**Example Response**
```json
{
  "success": true,
  "data": {
    "franchises": [
      {
        "id": 1,
        "name": "Brew & Bean Co.",
        "slug": "brew-and-bean-co-abc1",
        "category": "cafe",
        "short_description": "Specialty coffee chain known for single-origin beans and a cozy co-working ambience.",
        "logo_url": "https://cdn.imaker.in/franchises/brew-logo.png",
        "cover_image_url": "https://cdn.imaker.in/franchises/brew-cover.jpg",
        "investment_min": 1800000.00,
        "investment_max": 2800000.00,
        "expected_roi": 24.00,
        "break_even_months": 30,
        "outlets_live": 86,
        "established_year": 2014,
        "tags": ["Fast Growing", "Trending"],
        "location_city": "Ahmedabad",
        "location_state": "Gujarat",
        "is_featured": 1,
        "created_at": "2026-06-18T06:30:00.000Z"
      }
    ],
    "pagination": {
      "total": 10,
      "page": 1,
      "limit": 12,
      "pages": 1
    }
  }
}
```

---

### 2. Get Filter Options

```
GET /api/v1/franchises/filters
```

Returns all distinct categories, states, cities, and pre-defined investment ranges. Useful for populating dropdowns on the frontend.

**Example Response**
```json
{
  "success": true,
  "data": {
    "categories": ["cafe", "restaurant", "bakery", "qsr"],
    "states": ["Gujarat", "Maharashtra", "Karnataka", "Delhi"],
    "cities": ["Ahmedabad", "Mumbai", "Bangalore", "Delhi"],
    "investment_ranges": [
      { "label": "Under ₹5L", "min": 0, "max": 500000 },
      { "label": "₹5L – ₹15L", "min": 500000, "max": 1500000 },
      { "label": "₹15L – ₹30L", "min": 1500000, "max": 3000000 },
      { "label": "₹30L – ₹50L", "min": 3000000, "max": 5000000 },
      { "label": "₹50L+", "min": 5000000, "max": null }
    ]
  }
}
```

---

### 3. Get Franchise Detail

```
GET /api/v1/franchises/:slug
```

Full detail view for a single franchise (the modal/detail page).

**Example Request**
```http
GET /api/v1/franchises/brew-and-bean-co-abc1
```

**Example Response**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Brew & Bean Co.",
    "slug": "brew-and-bean-co-abc1",
    "category": "cafe",
    "description": "Specialty coffee chain known for single-origin beans and a cozy co-working ambience, popular with urban professionals. Established in 2014, now operating across 4 states with 86 outlets.",
    "short_description": "Specialty coffee chain known for single-origin beans and a cozy co-working ambience.",
    "logo_url": "https://cdn.imaker.in/franchises/brew-logo.png",
    "cover_image_url": "https://cdn.imaker.in/franchises/brew-cover.jpg",
    "gallery_images": [
      "https://cdn.imaker.in/g1.jpg",
      "https://cdn.imaker.in/g2.jpg"
    ],
    "investment_min": 1800000.00,
    "investment_max": 2800000.00,
    "franchise_fee": 450000.00,
    "working_capital": 350000.00,
    "monthly_revenue": 950000.00,
    "expected_roi": 24.00,
    "break_even_months": 30,
    "outlets_live": 86,
    "established_year": 2014,
    "space_requirement": "800-1200 sq ft",
    "staff_required": 8,
    "tags": ["Fast Growing", "Trending"],
    "support_offered": [
      "Site Selection",
      "Staff Training",
      "Marketing Support",
      "Technology Support",
      "Operations Support",
      "Inventory Management"
    ],
    "location_city": "Ahmedabad",
    "location_state": "Gujarat",
    "locations_available": ["Ahmedabad", "Surat", "Vadodara", "Rajkot"],
    "contact_email": "franchise@brewbean.com",
    "contact_phone": "+91 98765 43210",
    "website": "https://brewbean.com/franchise",
    "is_featured": 1,
    "created_at": "2026-06-18T06:30:00.000Z"
  }
}
```

---

### 4. Submit Enquiry

```
POST /api/v1/franchises/enquiry
```

Submit a franchise enquiry from the public enquiry form.

**Rate Limit:** 3 requests per IP per 15 minutes.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `franchise_id` | int | Yes | Franchise being enquired about |
| `full_name` | string | Yes | Enquirer's full name |
| `phone` | string | Yes | Phone number |
| `email` | string | Yes | Valid email address |
| `city` | string | No | City |
| `state` | string | No | State |
| `investment_budget` | string | No | e.g. `"₹10L – ₹20L"` |
| `business_experience` | string | No | e.g. `"2-5 years"` |
| `message` | string | No | Free-text message (max 2000 chars) |
| `agree_to_contact` | boolean | Yes | Must be `true` |

**Example Request**
```json
{
  "franchise_id": 1,
  "full_name": "Aditya Sharma",
  "phone": "+91 98765 43210",
  "email": "aditya@example.com",
  "city": "Ahmedabad",
  "state": "Gujarat",
  "investment_budget": "₹15L – ₹25L",
  "business_experience": "2-5 years",
  "message": "I own a retail space in CG Road, Ahmedabad. Interested in opening a Brew & Bean outlet.",
  "agree_to_contact": true
}
```

**Example Response (201)**
```json
{
  "success": true,
  "message": "Enquiry submitted successfully. We will contact you soon.",
  "data": {
    "id": 45
  }
}
```

**Example Error (400)**
```json
{
  "success": false,
  "message": "Missing required fields: full_name, email"
}
```

**Example Error (404)**
```json
{
  "success": false,
  "message": "Franchise not found or not active."
}
```

**Example Error (429)**
```json
{
  "success": false,
  "message": "Too many enquiry attempts. Please try again after 15 minutes."
}
```

---

## Admin Endpoints

All admin endpoints require:
```
Authorization: Bearer <access_token>
```

Allowed roles: `admin`, `super_admin`

---

### 5. Create Franchise

```
POST /api/v1/franchises
```

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | **Yes** | Franchise brand name |
| `slug` | string | No | Custom slug. Auto-generated from name if omitted |
| `category` | string | **Yes** | e.g. `cafe`, `restaurant`, `bakery` |
| `description` | string | No | Full description (max 5000 chars) |
| `short_description` | string | No | Card summary (max 500 chars) |
| `logo_url` | string | No | Logo image URL |
| `cover_image_url` | string | No | Cover/banner image URL |
| `gallery_images` | array | No | Array of image URLs (max 10) |
| `investment_min` | decimal | No | Minimum investment amount |
| `investment_max` | decimal | No | Maximum investment amount |
| `franchise_fee` | decimal | No | One-time franchise fee |
| `working_capital` | decimal | No | Working capital required |
| `monthly_revenue` | decimal | No | Expected monthly revenue |
| `expected_roi` | decimal | No | Expected ROI percentage |
| `break_even_months` | int | No | Break-even period in months |
| `outlets_live` | int | No | Number of live outlets |
| `established_year` | int | No | Year established |
| `space_requirement` | string | No | e.g. `"800-1200 sq ft"` |
| `staff_required` | int | No | Staff count |
| `tags` | array | No | Label tags, e.g. `["Fast Growing", "Trending"]` |
| `support_offered` | array | No | Support services list |
| `location_city` | string | No | Primary city |
| `location_state` | string | No | Primary state |
| `locations_available` | array | No | Cities/states where franchise is available |
| `contact_email` | string | No | Franchise contact email |
| `contact_phone` | string | No | Franchise contact phone |
| `website` | string | No | Franchise website URL |
| `is_featured` | boolean | No | `true` to feature on homepage |

**Example Request**
```json
{
  "name": "Brew & Bean Co.",
  "category": "cafe",
  "description": "Specialty coffee chain known for single-origin beans...",
  "short_description": "Specialty coffee chain known for single-origin beans.",
  "logo_url": "https://cdn.imaker.in/logo.png",
  "cover_image_url": "https://cdn.imaker.in/cover.jpg",
  "investment_min": 1800000,
  "investment_max": 2800000,
  "franchise_fee": 450000,
  "working_capital": 350000,
  "monthly_revenue": 950000,
  "expected_roi": 24,
  "break_even_months": 30,
  "outlets_live": 86,
  "established_year": 2014,
  "tags": ["Fast Growing", "Trending"],
  "support_offered": [
    "Site Selection",
    "Staff Training",
    "Marketing Support",
    "Technology Support",
    "Operations Support",
    "Inventory Management"
  ],
  "location_city": "Ahmedabad",
  "location_state": "Gujarat",
  "locations_available": ["Ahmedabad", "Surat", "Vadodara"],
  "contact_email": "franchise@brewbean.com",
  "contact_phone": "+91 98765 43210",
  "is_featured": true
}
```

**Example Response (201)**
```json
{
  "success": true,
  "message": "Franchise created successfully.",
  "data": {
    "id": 1,
    "slug": "brew-and-bean-co-abc1"
  }
}
```

**Example Error (409)**
```json
{
  "success": false,
  "message": "A franchise with this slug already exists."
}
```

---

### 6. Update Franchise

```
PATCH /api/v1/franchises/:id
```

Partial update — only include fields you want to change.

**Example Request**
```json
{
  "investment_min": 2000000,
  "outlets_live": 90,
  "tags": ["Fast Growing", "Trending", "Award Winner"]
}
```

**Example Response**
```json
{
  "success": true,
  "message": "Franchise updated successfully."
}
```

---

### 7. Soft-Delete Franchise

```
DELETE /api/v1/franchises/:id
```

Sets franchise status to `inactive` (soft delete). Enquiries remain in database.

**Example Response**
```json
{
  "success": true,
  "message": "Franchise removed successfully."
}
```

---

### 8. Admin List Franchises

```
GET /api/v1/franchises/admin/list
```

List all franchises including inactive/pending. For admin dashboard.

**Query Parameters**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `active`, `inactive`, or `pending` |
| `search` | string | Search by name, category, city, state |
| `page` | int | Page number |
| `limit` | int | Items per page (max 100) |

**Example Response**
```json
{
  "success": true,
  "data": {
    "franchises": [
      {
        "id": 1,
        "name": "Brew & Bean Co.",
        "slug": "brew-and-bean-co-abc1",
        "category": "cafe",
        "status": "active",
        "is_featured": 1,
        "investment_min": 1800000,
        "investment_max": 2800000,
        "outlets_live": 86,
        "location_city": "Ahmedabad",
        "location_state": "Gujarat",
        "created_at": "2026-06-18T06:30:00.000Z"
      }
    ],
    "pagination": {
      "total": 11,
      "page": 1,
      "limit": 20,
      "pages": 1
    }
  }
}
```

---

### 9. Admin List Enquiries

```
GET /api/v1/franchises/admin/enquiries
```

List all franchise enquiries across all brands.

**Query Parameters**

| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `new`, `contacted`, `converted`, `ignored` |
| `franchise_id` | int | Filter by specific franchise |
| `search` | string | Search by name, email, or phone |
| `page` | int | Page number |
| `limit` | int | Items per page (max 100) |

**Example Response**
```json
{
  "success": true,
  "data": {
    "enquiries": [
      {
        "id": 45,
        "franchise_id": 1,
        "franchise_name": "Brew & Bean Co.",
        "franchise_slug": "brew-and-bean-co-abc1",
        "full_name": "Aditya Sharma",
        "phone": "+91 98765 43210",
        "email": "aditya@example.com",
        "city": "Ahmedabad",
        "state": "Gujarat",
        "investment_budget": "₹15L – ₹25L",
        "business_experience": "2-5 years",
        "message": "I own a retail space in CG Road...",
        "agree_to_contact": 1,
        "status": "new",
        "admin_notes": null,
        "ip_address": "192.168.1.1",
        "created_at": "2026-06-18T06:45:00.000Z"
      }
    ],
    "pagination": {
      "total": 45,
      "page": 1,
      "limit": 20,
      "pages": 3
    }
  }
}
```

---

### 10. Update Enquiry Status

```
PATCH /api/v1/franchises/admin/enquiries/:id/status
```

**Request Body**
```json
{
  "status": "contacted",
  "admin_notes": "Called Aditya. He will visit the Ahmedabad office on Monday."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | **Yes** | One of: `new`, `contacted`, `converted`, `ignored` |
| `admin_notes` | string | No | Internal notes (max 2000 chars) |

**Example Response**
```json
{
  "success": true,
  "message": "Enquiry status updated to contacted."
}
```

---

### 11. Get Dashboard Stats

```
GET /api/v1/franchises/admin/stats
```

Summary counts for admin dashboard.

**Example Response**
```json
{
  "success": true,
  "data": {
    "franchises": {
      "active": 8,
      "pending": 2,
      "inactive": 1,
      "featured": 3,
      "total": 11
    },
    "enquiries": {
      "new_count": 23,
      "contacted": 15,
      "converted": 4,
      "ignored": 3,
      "total": 45
    }
  }
}
```

---

## Data Types

### Franchise Status
| Value | Description |
|-------|-------------|
| `active` | Visible on public site |
| `inactive` | Soft-deleted, hidden from public |
| `pending` | Draft / awaiting approval |

### Enquiry Status
| Value | Description |
|-------|-------------|
| `new` | Just submitted |
| `contacted` | Admin has reached out |
| `converted` | Became a paying franchisee |
| `ignored` | Rejected / spam |

### Categories (suggested)
- `restaurant`
- `cafe`
- `bakery`
- `qsr` (Quick Service Restaurant)
- `bar`
- `cloud_kitchen`
- `food_truck`

---

## Error Codes

| HTTP | Message | Scenario |
|------|---------|----------|
| 400 | Missing required fields | Create/update with missing `name` or `category` |
| 400 | Invalid email address | Enquiry email format invalid |
| 400 | You must agree to be contacted | Enquiry without `agree_to_contact: true` |
| 404 | Franchise not found | Invalid slug or inactive franchise |
| 404 | Enquiry not found | Invalid enquiry ID on status update |
| 409 | A franchise with this slug already exists | Duplicate slug on create/update |
| 429 | Too many enquiry attempts | Enquiry rate limit exceeded |
| 500 | Internal server error | Database or unexpected error |
