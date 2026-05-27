# Bluetooth Flutter Integration Guide

**Package:** `bluetooth_print_plus`  
**Paper width:** `58mm` (32 chars/line) or `80mm` (48 chars/line)  
**Zero impact on existing flows** — IP, USB, Windows, and Mobile POS printers work identically.

---

## Step 1: Register Bluetooth Printer (API)

**POST** `/api/v1/printers`

Register one printer per Flutter device + Bluetooth printer pair.

```json
{
  "name": "Kitchen Tablet BT Printer",
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

### Response

```json
{
  "success": true,
  "data": {
    "id": 42,
    "name": "Kitchen Tablet BT Printer",
    "connection_type": "bluetooth",
    "bluetooth_address": "00:1B:DC:0F:01:00",
    "device_id": "tablet_kitchen_01",
    "paper_width": "58mm",
    "characters_per_line": 32
  }
}
```

### Important Fields

| Field | Required | Description |
|-------|----------|-------------|
| `connection_type` | ✅ | Must be `bluetooth` |
| `bluetooth_address` | ✅ | MAC address of paired BT printer |
| `device_id` | ✅ | Your Flutter app's unique device ID |
| `paper_width` | ✅ | `58mm` or `80mm` |
| `characters_per_line` | ✅ | `32` for 58mm, `48` for 80mm |
| `station` | ✅ | `kitchen`, `bar`, `bill`, `cashier`, etc. |

---

## Step 2: Flutter Socket.IO Setup

Connect to the same Socket.IO server your app already uses for real-time features. No separate connection needed.

```dart
import 'package:socket_io_client/socket_io_client.dart' as io;

final socket = io.io('wss://your-api-domain.com', <String, dynamic>{
  'transports': ['websocket'],
  'autoConnect': true,
  'auth': {
    'token': accessToken,   // your existing auth token
  },
});
```

---

## Step 3: Join Bluetooth Print Rooms

Call this **once** when your app starts (after Bluetooth printer is paired and connected):

```dart
void joinBluetoothPrintRooms() {
  socket.emit('join:bt_print', {
    'outletId': outletId,           // e.g., 123
    'station': 'kitchen',           // must match printer.station
    'deviceId': deviceId,           // must match printer.device_id
    'userId': currentUserId,        // optional — for cashier-specific bills
  });
}
```

### Backend Room Routing (tried in order)

When a KOT or Bill is generated, the backend checks rooms in this priority:

1. `bt:{outletId}:user:{userId}` — Bills route here if `userId` is set
2. `bt:{outletId}:device:{deviceId}` — Explicit device targeting (best for KOTs)
3. `bt:{outletId}:station:{station}` — Station broadcast (first connected device wins)

If **no device is connected** in any room, the backend automatically falls back to the bridge agent.

---

## Step 4: Handle `bt:print` Event

Listen for incoming print jobs. The backend sends **both** plain text (recommended) and raw ESC/POS bytes (fallback).

### Event Payload Schema

```json
{
  "jobId": "uuid-v4-string",
  "jobType": "kot",
  "referenceNumber": "K-2026-001",
  "printerId": 42,
  "printerName": "Kitchen Tablet BT Printer",
  "paperWidth": "58mm",
  "charactersPerLine": 32,
  "supportsCutter": true,
  "supportsCashDrawer": false,
  "escpos": "G0Az...base64...",     // raw ESC/POS bytes — fallback only
  "text": "KITCHEN ORDER (KOT)\nKOT#: K-2026-001\n...",  // recommended
  "shouldCut": true,
  "openDrawer": false,
  "beep": true,
  "timestamp": 1716723600000
}
```

### Flutter Implementation (bluetooth_print_plus)

```dart
import 'package:bluetooth_print_plus/bluetooth_print_plus.dart';
import 'dart:convert';

void setupBluetoothPrintListener() {
  socket.on('bt:print', (data) {
    final jobId = data['jobId'] as String;
    final text = data['text'] as String?;
    final escposBase64 = data['escpos'] as String?;
    final shouldCut = data['shouldCut'] as bool? ?? true;
    final openDrawer = data['openDrawer'] as bool? ?? false;
    final beep = data['beep'] as bool? ?? false;

    // --- Recommended path: use pre-formatted text ---
    if (text != null && text.isNotEmpty) {
      _printText(jobId, text, shouldCut: shouldCut, openDrawer: openDrawer, beep: beep);
      return;
    }

    // --- Fallback: raw ESC/POS bytes ---
    if (escposBase64 != null) {
      final escposBytes = base64Decode(escposBase64);
      _printBytes(jobId, escposBytes);
      return;
    }

    // Nothing to print
    socket.emit('bt:print_done', {
      'jobId': jobId,
      'success': false,
      'error': 'No printable content received',
    });
  });
}

/// Print using text (recommended for bluetooth_print_plus)
Future<void> _printText(
  String jobId,
  String text, {
  required bool shouldCut,
  required bool openDrawer,
  required bool beep,
}) async {
  try {
    final command = EscPosCommand();

    if (beep) command.addBeep(3, 2);

    for (final line in text.split('\n')) {
      command.addText(line);
      command.addFeedLine(1);
    }

    if (openDrawer) command.addOpenCashDrawer();
    if (shouldCut) command.addCut();

    await BluetoothPrintPlus.write(command.getCommand());

    // Acknowledge success to backend
    socket.emit('bt:print_done', {
      'jobId': jobId,
      'success': true,
    });
  } catch (err) {
    socket.emit('bt:print_done', {
      'jobId': jobId,
      'success': false,
      'error': err.toString(),
    });
  }
}

/// Print raw ESC/POS bytes (fallback)
Future<void> _printBytes(String jobId, List<int> bytes) async {
  try {
    await BluetoothPrintPlus.write(Uint8List.fromList(bytes));
    socket.emit('bt:print_done', {
      'jobId': jobId,
      'success': true,
    });
  } catch (err) {
    socket.emit('bt:print_done', {
      'jobId': jobId,
      'success': false,
      'error': err.toString(),
    });
  }
}
```

---

## Step 5: Leave Rooms on Disconnect

When the app closes or the printer disconnects, clean up:

```dart
void leaveBluetoothPrintRooms() {
  socket.emit('leave:bt_print', {
    'outletId': outletId,
    'station': 'kitchen',
    'deviceId': deviceId,
    'userId': currentUserId,
  });
}
```

---

## 58mm vs 80mm Auto-Scaling

When you register a printer with `paper_width: "58mm"` and `characters_per_line: 32`:

| Content Type | 80mm (default) | 58mm (auto-scaled) |
|-------------|----------------|-------------------|
| KOT width | 42 chars | 32 chars |
| Bill item columns | N=24 Q=5 R=9 A=10 | N=16 Q=3 R=6 A=7 |
| Dashes | `----------------` | `--------------------------------` |
| Text field | Already formatted at correct width | Same — no truncation |

You do **not** need to handle width in Flutter. The `text` field arrives ready to print.

---

## Full Lifecycle Example

```dart
class BluetoothPrintService {
  late io.Socket socket;
  final String deviceId;
  final String outletId;
  String? currentUserId;

  BluetoothPrintService({required this.deviceId, required this.outletId});

  void connect(String accessToken) {
    socket = io.io('wss://your-api-domain.com', <String, dynamic>{
      'transports': ['websocket'],
      'auth': {'token': accessToken},
    });

    socket.onConnect((_) {
      print('Socket connected');
      joinRooms();
      setupPrintListener();
    });

    socket.onDisconnect((_) {
      print('Socket disconnected');
    });
  }

  void joinRooms() {
    socket.emit('join:bt_print', {
      'outletId': outletId,
      'station': 'kitchen',
      'deviceId': deviceId,
      'userId': currentUserId,
    });
  }

  void setupPrintListener() {
    socket.on('bt:print', (data) {
      final jobId = data['jobId'] as String;
      final text = data['text'] as String?;
      final shouldCut = data['shouldCut'] as bool? ?? true;

      if (text == null || text.isEmpty) {
        socket.emit('bt:print_done', {
          'jobId': jobId,
          'success': false,
          'error': 'No text content',
        });
        return;
      }

      final command = EscPosCommand();
      for (final line in text.split('\n')) {
        command.addText(line);
        command.addFeedLine(1);
      }
      if (shouldCut) command.addCut();

      BluetoothPrintPlus.write(command.getCommand()).then((_) {
        socket.emit('bt:print_done', {'jobId': jobId, 'success': true});
      }).catchError((err) {
        socket.emit('bt:print_done', {
          'jobId': jobId,
          'success': false,
          'error': err.toString(),
        });
      });
    });
  }

  void dispose() {
    socket.emit('leave:bt_print', {
      'outletId': outletId,
      'station': 'kitchen',
      'deviceId': deviceId,
      'userId': currentUserId,
    });
    socket.disconnect();
  }
}
```

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| App never receives `bt:print` | Wrong `deviceId` or `station` in `join:bt_print` | Ensure `deviceId` matches printer.device_id and `station` matches printer.station |
| Content overflows 58mm paper | `paper_width` not set on printer record | Update printer: `"paper_width": "58mm"`, `"characters_per_line": 32` |
| Prints duplicate KOTs | Multiple devices on same station room | Use explicit `deviceId` targeting instead of station-only |
| Backend falls back to bridge | App not connected or wrong room | Check backend logs: `no device in any room — bridge fallback` |
| Raw bytes print garbled | `bluetooth_print_plus` expects commands, not raw bytes | Use the `text` field path, not `escpos` fallback |

---

## Socket.IO Events Summary

| Event | Direction | Payload |
|-------|-----------|---------|
| `join:bt_print` | Flutter → Backend | `{ outletId, station, deviceId, userId? }` |
| `leave:bt_print` | Flutter → Backend | `{ outletId, station, deviceId, userId? }` |
| `bt:print` | Backend → Flutter | `{ jobId, text, escpos, paperWidth, shouldCut, ... }` |
| `bt:print_done` | Flutter → Backend | `{ jobId, success, error? }` |
