# Mobile POS Printing Integration Guide

> **Zero config. No printer setup. No device ID. No manual registration.**  
> Any user (cashier, admin, captain, pos_user) on a Mobile POS device gets  
> ALL their prints — KOT, BOT, Bill — routed to their device automatically.

---

## How it works

```
Flutter logs in → connects socket → emits join:mpos { outletId, userId }
                                    Backend: device is now in mpos:43:user:15

User creates KOT/Bill in app
    ↓
printKot() / printBill() called with userId
    ↓
Is userId connected via Mobile POS socket?
    ├── YES → ESC/POS sent to mpos:43:user:15 → device prints 
    └── NO  → normal printer routing (TCP/bridge) — unchanged 
```

**No `connection_type = 'mobile_pos'` printer record needed.**  
**Configured printers (IP/bridge) work as before for desktop/non-mobile users.**

---

## Backend — no setup required

Nothing to configure. The intercept is automatic in `printKot` and `printBill`.

Run migrations (one-time):
```bash
node scripts/run-migration-072.js
pm2 reload ecosystem.config.js --env production
```

---

## Flutter Setup — only 3 steps

### Step 1 — Add dependency
```yaml
dependencies:
  socket_io_client: ^2.0.3+1
```

### Step 2 — Connect and join on login
```dart
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'dart:convert';
import 'dart:typed_data';

class MobilePosService {
  late IO.Socket socket;
  final String serverUrl;
  final int outletId;
  final int userId;     // from JWT / login response
  final String station; // 'cashier' for POS staff, 'kitchen' for kitchen display

  MobilePosService({
    required this.serverUrl,
    required this.outletId,
    required this.userId,
    required this.station,
  });

  void connect() {
    socket = IO.io(serverUrl,
      IO.OptionBuilder().setTransports(['websocket']).disableAutoConnect().build());

    socket.onConnect((_) {
      // Send outletId + userId + station
      // station is required for self-order auto-KOT to reach kitchen devices
      // Use: 'cashier', 'kitchen', 'bar' — must match kitchen_stations.station_type
      socket.emit('join:mpos', {
        'outletId': outletId,
        'userId': userId,
        'station': station,   // e.g. 'cashier' for POS, 'kitchen' for kitchen display
      });
    });

    socket.on('mpos:connected', (data) {
      print('[MPOS] Ready → userId: ${data['userId']}, rooms: ${data['rooms']}');
    });

    socket.on('mpos:print', (data) => _onPrintJob(data));

    socket.onDisconnect((_) => print('[MPOS] Disconnected'));
    socket.onReconnect((_) => print('[MPOS] Reconnected'));

    socket.connect();
  }

  void _onPrintJob(dynamic data) async {
    final String jobId = data['jobId'];
    final bool shouldCut = data['shouldCut'] == true;
    try {
      // Decode base64 ESC/POS → Uint8List → print via SDK
      final Uint8List bytes = base64Decode(data['escpos'] as String);
      await _printEscpos(bytes, shouldCut: shouldCut);
      socket.emit('mpos:print_done', {'jobId': jobId, 'success': true});
    } catch (e) {
      socket.emit('mpos:print_done', {'jobId': jobId, 'success': false, 'error': e.toString()});
    }
  }

  Future<void> _printEscpos(Uint8List bytes, {bool shouldCut = false}) async {
    // Sunmi / Nyx built-in printer SDK
    const channel = MethodChannel('com.yourapp/printer');
    await channel.invokeMethod('printEscpos', {'data': bytes});
    // IMPORTANT: Sunmi ignores the ESC/POS cut command inside printEscposData.
    // Call cutPaper() separately to trigger the physical cutter.
    if (shouldCut) {
      await channel.invokeMethod('cutPaper');
    }
  }

  void disconnect() => socket.disconnect();
}

### Step 3 — Use in main screen
```dart
@override
void initState() {
  super.initState();
  // station = 'cashier' for POS/cashier role, 'kitchen' for kitchen staff
  // Required so self-order auto-KOT reaches kitchen devices via station room
  MobilePosService(
    serverUrl: 'https://demo.imakerrestro.com',
    outletId: currentUser.outletId,
    userId: currentUser.id,
    station: currentUser.role == 'kitchen' ? 'kitchen' : 'cashier',
  ).connect();
}
```

That is all. **No printer configuration. No device ID. No setup.**

---

## Socket events reference

| Event | Direction | Payload |
|---|---|---|
| `join:mpos` | Flutter → Server | `{ outletId, userId, station }` |
| `mpos:connected` | Server → Flutter | `{ mode, userId, rooms, outletId, socketId }` |
| `mpos:print` | Server → Flutter | `{ jobId, jobType, referenceNumber, escpos (base64), shouldCut }` |
| `mpos:print_done` | Flutter → Server | `{ jobId, success, error? }` |

---

## Routing priority (inside sendToMobilePOS)

| Priority | Room | When used |
|---|---|---|
| **1 — User** | `mpos:{outletId}:user:{userId}` | Bill/KOT for specific user — their device |
| 2 — Device | `mpos:{outletId}:device:{deviceId}` | Explicit device targeting (optional) |
| 3 — Station | `mpos:{outletId}:station:{station}` | Broadcast, first device only (no duplicates) |
| 4 — Bridge | print_jobs table | Any of above offline → bridge agent picks up |

---

## Behaviour matrix

| Situation | Result |
|---|---|
| User is on Mobile POS, creates KOT/Bill | Prints on their device instantly |
| User on Mobile POS, goes offline | Bridge job created → prints when reconnects |
| 10 cashiers on Mobile POS, same outlet | Each gets only their own prints |
| Desktop user, no Mobile POS | Normal TCP/bridge printing, completely unchanged |
| Device reset / app restart | Reconnects, re-joins user room, printing resumes |

---

## Testing

```bash
node tests/_verify_mobile_pos_printing.js
# 48/48 passed
```

Manual test with wscat:
```
42["join:mpos",{"outletId":43,"userId":15}]
# → 42["mpos:connected",{"mode":"user","userId":15,"rooms":["mpos:43:user:15"],"outletId":43}]

# After creating a KOT/Bill in the app:
# → 42["mpos:print",{"jobId":"...","jobType":"kot","escpos":"...base64..."}]

42["mpos:print_done",{"jobId":"...","success":true}]
```

---

## Checklist

### Backend
- [x] No printer setup needed
- [ ] `node scripts/run-migration-072.js` on production
- [ ] `pm2 reload` after deploy

### Flutter
- [ ] Add `socket_io_client` to `pubspec.yaml`
- [ ] On login: call `MobilePosService(outletId, userId, station).connect()`
- [ ] `station = 'cashier'` for POS/cashier, `'kitchen'` for kitchen staff
- [ ] Listen `mpos:print` → base64Decode → `printEscposData(bytes)`
- [ ] If `shouldCut == true` → call `cutPaper()` after `printEscposData`
- [ ] Emit `mpos:print_done` after every attempt

---

## Troubleshooting

**No print received on device**
- Check log: `MPOS[MobilePOS]: no device in any room — bridge fallback`
- Verify socket connected: log should show `joined Mobile POS rooms: mpos:43:user:15`
- Verify `userId` sent in `join:mpos` matches JWT userId in backend order context

**ESC/POS not printing**
- Test SDK directly: `printEscposData('\x1b\x40Hello\n\x1d\x56\x42\x00')`
- Confirm AIDL `IPrinterService` is bound before printing

**Autocut not working**
- Sunmi's `printEscposData` ignores embedded `\x1D\x56` cut commands
- Flutter must call `cutPaper()` when `shouldCut == true` in the `mpos:print` payload

**Extra space between lines**
- Caused by large line spacing (`\x1B\x33\x38` = 56 dot = 7mm gap) — fixed to 30 dot in this version
- If still occurring: check that Flutter is calling `printEscposData` with raw bytes, not wrapping in extra text calls

**Self-order auto mode KOT not printing on kitchen device**
- Kitchen device MUST send `station: 'kitchen'` in `join:mpos`
- Backend routes auto-KOT to `mpos:{outletId}:station:kitchen` room
- Without `station`, kitchen device is not in any station room → bridge fallback

**Desktop users printing unexpectedly to mobile**
- Should not happen — intercept only fires if `userId` has an active socket
- Desktop users don't call `join:mpos` so no socket exists for them
