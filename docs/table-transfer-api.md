# Table Transfer API Documentation

## Overview

The Table Transfer feature allows authorized users to move an entire table session (including orders, KOTs, billing data) from one table to another in real-time.

---

## API Endpoint

### Transfer Table

Transfers an active session from source table to target table.

```
POST /api/v1/tables/:sourceTableId/transfer
```

#### Authorization

**Required Roles:** `super_admin`, `admin`, `manager`, `cashier`, `captain`

**Header:**
```
Authorization: Bearer <token>
Content-Type: application/json
```

---

## Request

### URL Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourceTableId` | number | Yes | ID of the table to transfer FROM |

### Request Body

```json
{
  "targetTableId": 15
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `targetTableId` | number | Yes | ID of the table to transfer TO |

---

## Response

### Success Response (200 OK)

```json
{
  "success": true,
  "message": "Table transferred from T1 to T2",
  "data": {
    "success": true,
    "message": "Table transferred from T1 to T2",
    "transfer": {
      "sourceTableId": 10,
      "sourceTableNumber": "T1",
      "sourceFloorId": 1,
      "targetTableId": 15,
      "targetTableNumber": "T2",
      "targetFloorId": 1,
      "sessionId": 123,
      "orderId": 456,
      "orderNumber": "ORD-20260303-001",
      "transferredBy": 1,
      "transferredAt": "2026-03-03T06:15:00.000Z",
      "mergedTableIds": []
    },
    "sourceTable": {
      "id": 10,
      "tableNumber": "T1",
      "status": "available",
      "floorId": 1,
      "outletId": 43
    },
    "targetTable": {
      "id": 15,
      "tableNumber": "T2",
      "status": "running",
      "floorId": 1,
      "outletId": 43
    }
  }
}
```

### Error Responses

#### 400 Bad Request - Missing Target Table

```json
{
  "success": false,
  "message": "targetTableId is required"
}
```

#### 400 Bad Request - Source Table Not Occupied

```json
{
  "success": false,
  "message": "Source table is available, must be occupied/running/billing to transfer"
}
```

#### 400 Bad Request - Target Table Not Available

```json
{
  "success": false,
  "message": "Target table is occupied, must be available for transfer"
}
```

#### 400 Bad Request - No Active Session

```json
{
  "success": false,
  "message": "No active session found on source table"
}
```

#### 403 Forbidden - Unauthorized Role

```json
{
  "success": false,
  "message": "Only Cashier, Captain, Manager, Admin, or Super Admin can transfer tables"
}
```

#### 404 Not Found - Table Not Found

```json
{
  "success": false,
  "message": "Source table not found"
}
```

```json
{
  "success": false,
  "message": "Target table not found"
}
```

#### 400 Bad Request - Different Outlets

```json
{
  "success": false,
  "message": "Cannot transfer between different outlets"
}
```

---

## Socket Events

### Overview

| Redis Channel (Publish) | Socket Event (Emit) | Description |
|-------------------------|---------------------|-------------|
| `table:transfer` | `table:transferred` | Main transfer event to all rooms |
| `table:update` | `table:updated` | Individual table status updates |

---

### Event 1: `table:transferred`

**Redis Publish Channel:** `table:transfer`  
**Socket Emit Event:** `table:transferred`

Emitted to all relevant rooms for real-time UI updates.

**Rooms Notified:**

| Room Pattern | Example | Purpose |
|--------------|---------|---------|
| `floor:{outletId}:{sourceFloorId}` | `floor:43:1` | Source floor UI |
| `floor:{outletId}:{targetFloorId}` | `floor:43:2` | Target floor UI (if different) |
| `outlet:{outletId}` | `outlet:43` | All outlet screens |
| `kitchen:{outletId}` | `kitchen:43` | Kitchen display |
| `captain:{outletId}` | `captain:43` | Captain screens |
| `cashier:{outletId}` | `cashier:43` | Cashier/POS screens |

**Payload:**

```json
{
  "outletId": 43,
  "sourceTableId": 10,
  "sourceTableNumber": "T1",
  "sourceFloorId": 1,
  "targetTableId": 15,
  "targetTableNumber": "T2",
  "targetFloorId": 1,
  "sessionId": 123,
  "orderId": 456,
  "orderNumber": "ORD-20260303-001",
  "transferredBy": 1,
  "transferredAt": "2026-03-03T06:15:00.000Z"
}
```

---

### Event 2: `table:updated`

**Redis Publish Channel:** `table:update`  
**Socket Emit Event:** `table:updated`

Emitted separately for source and target tables via `broadcastTableUpdate()`.

**Rooms Notified:**

| Room Pattern | Example |
|--------------|---------|
| `floor:{outletId}:{floorId}` | `floor:43:1` |
| `outlet:{outletId}` | `outlet:43` |

**Source Table Payload:**
```json
{
  "event": "table_transferred",
  "type": "source",
  "tableId": 10,
  "tableNumber": "T1",
  "newStatus": "available",
  "transfer": {
    "sourceTableId": 10,
    "sourceTableNumber": "T1",
    "targetTableId": 15,
    "targetTableNumber": "T2",
    "sessionId": 123,
    "orderId": 456,
    "orderNumber": "ORD-20260303-001",
    "transferredBy": 1,
    "transferredAt": "2026-03-03T06:15:00.000Z"
  }
}
```

**Target Table Payload:**
```json
{
  "event": "table_transferred",
  "type": "target",
  "tableId": 15,
  "tableNumber": "T2",
  "newStatus": "occupied",
  "transfer": {
    "sourceTableId": 10,
    "sourceTableNumber": "T1",
    "targetTableId": 15,
    "targetTableNumber": "T2",
    "sessionId": 123,
    "orderId": 456,
    "orderNumber": "ORD-20260303-001",
    "transferredBy": 1,
    "transferredAt": "2026-03-03T06:15:00.000Z"
  }
}
```

---

## Socket Client Integration

### Joining Rooms

```javascript
// Connect to socket
const socket = io('http://localhost:3000', {
  auth: { token: authToken }
});

// Join relevant rooms
socket.emit('join:outlet', outletId);
socket.emit('join:floor', { outletId, floorId });
socket.emit('join:captain', outletId);
socket.emit('join:kitchen', outletId);
socket.emit('join:cashier', outletId);
```

### Listening for Transfer Events

```javascript
// Listen for table transfer events
socket.on('table:transferred', (data) => {
  console.log('Table transferred:', data);
  
  // Update UI for source table (now available)
  updateTableUI(data.sourceTableId, 'available');
  
  // Update UI for target table (now has session)
  updateTableUI(data.targetTableId, data.newStatus || 'running');
  
  // Update order display if showing this order
  if (currentOrderId === data.orderId) {
    refreshOrderDetails();
  }
});

// Also listen for individual table updates
socket.on('table:updated', (data) => {
  if (data.event === 'table_transferred') {
    refreshTableLayout();
  }
});
```

---

## Workflow Example

### Complete Table Transfer Flow

```
1. Customer at Table T1 wants to move to Table T2
   └── T1: occupied/running, has Order #ORD-001
   └── T2: available

2. Authorized user (Cashier/Captain/Manager) initiates transfer
   └── POST /api/v1/tables/10/transfer { targetTableId: 15 }

3. System performs transfer:
   └── Moves table_session from T1 to T2
   └── Updates order's table_id to T2
   └── Updates T1 status → available
   └── Updates T2 status → running (same as T1 was)
   └── Logs audit trail in table_history
   └── Broadcasts socket events

4. Real-time updates:
   └── POS screens refresh table layout
   └── Kitchen display shows new table number
   └── All terminals update instantly

5. After transfer:
   └── T1: available, ready for new customers
   └── T2: running, has Order #ORD-001
   └── All existing KOTs preserved
   └── New KOTs will show T2
   └── Bill remains same, only table reference changed
```

---

## Database Changes

### Tables Updated

| Table | Column | Change |
|-------|--------|--------|
| `table_sessions` | `table_id` | Updated to target table ID |
| `orders` | `table_id`, `floor_id`, `section_id` | Updated to target table references |
| `tables` (source) | `status` | Set to 'available' |
| `tables` (target) | `status` | Set to source's previous status |
| `table_merges` | `primary_table_id` | Updated if source had merged tables |
| `table_history` | - | New entries for audit trail |

### Audit Trail

Two entries are created in `table_history`:

1. **Source table:** `action = 'table_transferred_from'`
2. **Target table:** `action = 'table_transferred_to'`

Both contain full transfer details in JSON format.

---

## Restrictions

| Condition | Behavior |
|-----------|----------|
| Source table must be `occupied`, `running`, or `billing` | Error if `available` or other status |
| Target table must be `available` | Error if occupied/running/etc |
| Must have active session on source | Error if no session |
| Same outlet required | Error if different outlets |
| Role check | Only authorized roles can transfer |

---

## Testing with cURL

```bash
# Login first
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Transfer table (replace TOKEN and IDs)
curl -X POST http://localhost:3000/api/v1/tables/10/transfer \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetTableId": 15}'
```

---

## Related APIs

| API | Description |
|-----|-------------|
| `GET /api/v1/tables/:id` | Get table details |
| `GET /api/v1/tables/:id/session` | Get current session |
| `POST /api/v1/tables/:id/session` | Start new session |
| `DELETE /api/v1/tables/:id/session` | End session |
| `GET /api/v1/tables/realtime/:outletId` | Real-time table status |
| `POST /api/v1/tables/:id/session/transfer` | Transfer session to another captain |
| `POST /api/v1/tables/:id/merge` | Merge tables |
| `DELETE /api/v1/tables/:id/merge` | Unmerge tables |

---

# Table Unmerge API

## Endpoint

```
DELETE /api/v1/tables/:tableId/merge
```

## Validation Rules

| Rule | Description |
|------|-------------|
| Table must be `available` | Cannot unmerge if table is occupied/running/billing |
| No active session | Cannot unmerge if table has active session |
| No active order | Cannot unmerge if order exists on table |

## Error Responses

### Session Active
```json
{
  "success": false,
  "message": "Cannot unmerge: Table T1 is occupied. Tables must be available to unmerge. Complete the order/payment first."
}
```

### Order Exists
```json
{
  "success": false,
  "message": "Cannot unmerge: Table has active session with order ORD2603030001. End the session first."
}
```

## Auto-Unmerge After Payment

When payment is completed on a merged table:
1. Order status → `completed`
2. Table session → ended
3. **Merged tables → automatically unmerged**
4. All tables → `available`
5. Socket events emitted

## Socket Events

### Event: `table:unmerged`

**Redis Publish Channel:** `table:unmerge`  
**Socket Emit Event:** `table:unmerged`

**Rooms Notified:**
| Room | Purpose |
|------|---------|
| `floor:{outletId}:{floorId}` | Floor UI update |
| `outlet:{outletId}` | Outlet screens |
| `captain:{outletId}` | Captain screens |
| `cashier:{outletId}` | Cashier/POS |

**Payload:**
```json
{
  "outletId": 43,
  "primaryTableId": 10,
  "primaryTableNumber": "T1",
  "floorId": 1,
  "unmergedTableIds": [11, 12],
  "unmergedTables": [
    { "id": 11, "tableNumber": "T2", "floorId": 1 },
    { "id": 12, "tableNumber": "T3", "floorId": 1 }
  ],
  "event": "tables_unmerged",
  "unmergedBy": 1,
  "timestamp": "2026-03-03T07:00:00.000Z"
}
```

### After Payment (Auto-Unmerge)

```json
{
  "outletId": 43,
  "primaryTableId": 10,
  "floorId": 1,
  "unmergedTableIds": [11, 12],
  "unmergedTables": [
    { "id": 11, "tableNumber": "T2", "floorId": 1 },
    { "id": 12, "tableNumber": "T3", "floorId": 1 }
  ],
  "event": "tables_unmerged_after_payment",
  "timestamp": "2026-03-03T07:00:00.000Z"
}
```

## Client Integration

```javascript
// Listen for unmerge events
socket.on('table:unmerged', (data) => {
  console.log('Tables unmerged:', data);
  
  // Update primary table UI
  updateTableUI(data.primaryTableId, 'available');
  
  // Update all unmerged tables UI
  data.unmergedTables.forEach(table => {
    updateTableUI(table.id, 'available');
  });
  
  // Refresh table layout
  refreshTableLayout();
});
```

## Workflow

```
1. Merge Tables (T1 + T2 + T3)
   └── T1 becomes primary with combined capacity
   └── T2, T3 become 'merged' status

2. Start Session & Create Order on T1
   └── Order created on merged table

3. Try Manual Unmerge (DELETE /tables/T1/merge)
   └── ❌ BLOCKED: "Cannot unmerge: Table T1 is occupied"

4. Complete Payment
   └── Order status → completed
   └── Session → ended
   └── AUTO-UNMERGE triggered
   └── T1, T2, T3 all → 'available'
   └── Socket: table:unmerged emitted

5. All Tables Ready for New Customers
```
