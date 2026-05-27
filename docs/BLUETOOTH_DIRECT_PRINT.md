# Bluetooth Direct Print — Flutter Integration

Print KOTs and Bills directly from the backend to your Flutter app's Bluetooth printer using Socket.IO.

**Printer:** 58mm Bluetooth thermal printer  
**Flutter Package:** `bluetooth_print_plus`  
**Flow:** Backend → Socket.IO → Flutter App → Bluetooth Printer

---

## 1. Register the Bluetooth Printer

**POST** `/api/v1/printers`

```json
{
  "name": "Kitchen BT Printer",
  "printer_type": "thermal",
  "station": "kitchen",
  "connection_type": "bluetooth",
  "bluetooth_address": "00:1B:DC:0F:01:00",
  "device_id": "tablet_kitchen_01",
  "paper_width": "58mm",
  "characters_per_line": 32,
  "supports_cutter": true,
  "supports_cash_drawer": false,
  "is_active": true
}
```

> **Important:**
> - `bluetooth_address` — Replace with **your actual printer's MAC address** (found in phone/tablet Bluetooth settings)
> - `device_id` — Use a **unique ID for this Flutter device** (e.g., `tablet_kitchen_01`). Must match what the app sends in `join:bt_print`

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 42,
    "name": "Kitchen BT Printer",
    "connection_type": "bluetooth",
    "bluetooth_address": "00:1B:DC:0F:01:00",
    "device_id": "tablet_kitchen_01",
    "paper_width": "58mm",
    "characters_per_line": 32
  }
}
```

### Required Fields

| Field | Value | Why |
|-------|-------|-----|
| `connection_type` | `bluetooth` | Tells backend this is a Bluetooth printer |
| `bluetooth_address` | MAC address | Used if bridge agent is ever needed |
| `device_id` | Your app ID | Must match what Flutter sends in `join:bt_print` |
| `paper_width` | `58mm` | Backend auto-scales content to fit |
| `characters_per_line` | `32` | 58mm = 32 chars, 80mm = 48 chars |
| `station` | `kitchen` / `bar` / `bill` | Matches KOT/Bill routing |

---

## 2. Flutter: Connect to Socket.IO

Use your existing Socket.IO connection. No separate server needed.

```dart
import 'package:socket_io_client/socket_io_client.dart' as io;

final socket = io.io('wss://your-api-domain.com', <String, dynamic>{
  'transports': ['websocket'],
  'auth': {'token': accessToken},
});
```

---

## 3. Flutter: Join Bluetooth Print Room

Call this **once** after your app connects and the Bluetooth printer is paired:

```dart
socket.emit('join:bt_print', {
  'outletId': outletId,      // e.g., 123
  'station': 'kitchen',      // must match printer.station
  'deviceId': deviceId,      // must match printer.device_id
  'userId': userId,          // optional — for cashier-specific bills
});
```

### How Routing Works

When a KOT or Bill is generated, the backend finds your app in this order:

1. `bt:{outletId}:user:{userId}` — Bills for this cashier
2. `bt:{outletId}:device:{deviceId}` — Your specific device (best for KOTs)
3. `bt:{outletId}:station:{station}` — Any device on this station

---

## 4. Flutter: Handle Print Events

Listen for `bt:print`. The backend sends pre-formatted text ready for 58mm paper.

### Payload Structure

```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "jobType": "kot",
  "referenceNumber": "K-2026-001",
  "printerId": 42,
  "printerName": "Kitchen BT Printer",
  "paperWidth": "58mm",
  "charactersPerLine": 32,
  "text": "KITCHEN ORDER (KOT)\nKOT#: K-2026-001\n...",
  "escpos": "G0Az...base64...",
  "shouldCut": true,
  "openDrawer": false,
  "beep": true,
  "timestamp": 1716723600000
}
```

### Flutter Code

```dart
import 'package:bluetooth_print_plus/bluetooth_print_plus.dart';

socket.on('bt:print', (data) {
  final jobId = data['jobId'] as String;
  final text = data['text'] as String?;
  final shouldCut = data['shouldCut'] as bool? ?? true;
  final openDrawer = data['openDrawer'] as bool? ?? false;
  final beep = data['beep'] as bool? ?? false;

  if (text == null || text.isEmpty) {
    socket.emit('bt:print_done', {
      'jobId': jobId,
      'success': false,
      'error': 'No text content',
    });
    return;
  }

  final command = EscPosCommand();

  if (beep) command.addBeep(3, 2);

  for (final line in text.split('\n')) {
    command.addText(line);
    command.addFeedLine(1);
  }

  if (openDrawer) command.addOpenCashDrawer();
  if (shouldCut) command.addCut();

  BluetoothPrintPlus.write(command.getCommand()).then((_) {
    socket.emit('bt:print_done', {
      'jobId': jobId,
      'success': true,
    });
  }).catchError((err) {
    socket.emit('bt:print_done', {
      'jobId': jobId,
      'success': false,
      'error': err.toString(),
    });
  });
});
```

---

## 5. Flutter: Leave Room on Disconnect

```dart
socket.emit('leave:bt_print', {
  'outletId': outletId,
  'station': 'kitchen',
  'deviceId': deviceId,
  'userId': userId,
});
```

---

## 58mm Content Scaling

When `paper_width` is `"58mm"` and `characters_per_line` is `32`:

| What | 80mm Default | 58mm Scaled |
|------|-------------|-------------|
| KOT line width | 42 chars | 32 chars |
| Bill item name column | 24 chars | 16 chars |
| Dashes | `--------------------------------` | `--------------------------------` (scaled to 32) |

The `text` field arrives already formatted. You print it line-by-line. No width calculations needed in Flutter.

---

## Complete Minimal Example

```dart
class BtPrintService {
  late io.Socket socket;
  final String deviceId;
  final String outletId;

  BtPrintService({required this.deviceId, required this.outletId});

  void connect(String token) {
    socket = io.io('wss://your-api.com', <String, dynamic>{
      'transports': ['websocket'],
      'auth': {'token': token},
    });

    socket.onConnect((_) {
      // Join room
      socket.emit('join:bt_print', {
        'outletId': outletId,
        'station': 'kitchen',
        'deviceId': deviceId,
      });

      // Listen for print jobs
      socket.on('bt:print', (data) => _handlePrint(data));
    });
  }

  void _handlePrint(dynamic data) {
    final jobId = data['jobId'];
    final text = data['text'] as String?;
    final shouldCut = data['shouldCut'] as bool? ?? true;

    if (text == null || text.isEmpty) {
      socket.emit('bt:print_done', {'jobId': jobId, 'success': false});
      return;
    }

    final cmd = EscPosCommand();
    for (final line in text.split('\n')) {
      cmd.addText(line);
      cmd.addFeedLine(1);
    }
    if (shouldCut) cmd.addCut();

    BluetoothPrintPlus.write(cmd.getCommand()).then((_) {
      socket.emit('bt:print_done', {'jobId': jobId, 'success': true});
    }).catchError((err) {
      socket.emit('bt:print_done', {
        'jobId': jobId,
        'success': false,
        'error': err.toString(),
      });
    });
  }

  void dispose() {
    socket.emit('leave:bt_print', {
      'outletId': outletId,
      'station': 'kitchen',
      'deviceId': deviceId,
    });
    socket.disconnect();
  }
}
```

---

## Socket.IO Events

| Event | Direction | When |
|-------|-----------|------|
| `join:bt_print` | App → Backend | After app starts and BT printer is ready |
| `leave:bt_print` | App → Backend | Before app closes or printer disconnects |
| `bt:print` | Backend → App | When KOT/Bill is generated for this printer |
| `bt:print_done` | App → Backend | After printing succeeds or fails |
