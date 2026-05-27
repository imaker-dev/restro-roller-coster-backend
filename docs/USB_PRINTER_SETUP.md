# USB Printer Setup Guide

Complete step-by-step guide for configuring USB thermal printers for KOT, Bill, and Invoice printing.

---

## How It Works

```
Server receives print request (KOT / Bill / Invoice)
       │
       ▼
  Is it a USB printer? (connection_type = 'usb')
       │
       ├── YES ──→ Try direct USB write (fs.createWriteStream → usb_path)
       │                  │
       │         ┌────────┴─────────┐
       │       Success           Failure (device error / not found)
       │         │                  │
       │    ✅ Done               Mark path failed
       │                            │
       │                            ▼
       │                  createPrintJob() → bridge queue
       │                            │        (no delay, instant)
       │                            ▼
       │                     Bridge agent picks up via long-polling
       │                            ▼
       │                     Bridge writes to USB device
       │                            ▼
       │                          ✅ Printed
       │
       └── NO ──→ Mobile POS / Direct TCP / Bridge (unchanged)
```

> **Important:** The bridge fallback happens **immediately** — there is **no 30-second wait**. The 30s cooldown only means: "if another print arrives in the next 30 seconds, skip trying direct USB again and go straight to bridge." This avoids repeated failed attempts while the device is disconnected.

**Two scenarios:**

| Deployment | Behavior |
|---|---|
| On-premise server + USB printer on same machine | Direct write succeeds instantly (< 50ms) |
| Cloud server + USB printer at restaurant | Direct write fails → Bridge Agent on restaurant machine handles it |

---

## Step 1: Identify USB Device Path

> **Why device path and not printer name?**
> 
> Thermal printers use **raw ESC/POS byte commands** — not formatted documents. We write bytes directly to the USB device (like writing to a file). This is why you need the low-level device path (`/dev/usb/lp0` or `\\.\COM3`) rather than the Windows printer name shown in Control Panel.

---

### Windows — Finding the USB Path

USB thermal printers on Windows can appear in **two different ways**. You need to check both to find the right one.

#### Method 1: Check `Get-Printer` (Most Reliable — Try This First)

Open PowerShell and run:

```powershell
Get-Printer | Select-Object Name, PortName, Type, DriverName | Format-Table
```

**Look for your thermal printer** in the list. Common names:
- `Generic / Text Only`
- `USB Printer`
- Your brand name (e.g., `Xprinter`, `GPrinter`, `EPSON TM-T82`)

**Example output:**
```
Name                     PortName  Type   DriverName
----                     --------  ----   ----------
Generic / Text Only      USB001    Local  Generic / Text Only
OneNote (Desktop)        nul:      Local  Send to Microsoft OneNote
```

→ **Your `usb_path` = `\\.\USB001`** (use whatever `PortName` shows)

> ⚠️ **Important:** Do NOT confuse `Intel(R) Active Management Technology - SOL (COM3)` with your printer. That's Intel's management interface, not the printer.

#### Method 2: Device Manager → Ports (COM & LPT)

If your printer uses a **virtual COM port driver** (some brands install one):

1. Press `Win + X` → **Device Manager**
2. Expand **Ports (COM & LPT)**
3. Look for entries like:
   - `USB Serial Port (COM3)` ← this is your printer
   - `Prolific USB-to-Serial Comm Port (COM4)` ← this is your printer
4. Note the COM number — your `usb_path` is `\\.\COM3`

> 💡 If you only see `Intel(R) Active Management Technology - SOL (COM3)`, that's **NOT** your printer. Use Method 1 (`Get-Printer`) instead.

#### Method 3: Test the Path

**For USB001 type printers:**
```powershell
# Test raw write to USB001
$stream = [System.IO.StreamWriter]::new("\\.\TVS")
$stream.WriteLine("TEST PRINT")
$stream.Close()
```

**For COM port type printers:**
```powershell
# This sends a simple test command to the printer
# If the path is correct, the printer will beep or feed paper
$port = new-Object System.IO.Ports.SerialPort COM3,9600,None,8,one
$port.Open()
$port.Write([byte[]](0x1B,0x40,0x0A,0x1D,0x56,0x00),0,6)
$port.Close()
```

If the printer responds → the path is correct.

#### What if USB001 test doesn't work?

Some "Generic / Text Only" drivers don't support raw ESC/POS bytes. If the test above fails:

1. **Install your printer manufacturer's driver** — most USB thermal printers come with a driver that creates a virtual COM port:
   | Brand | Search for |
   |---|---|
   | Epson | "Epson Advanced Printer Driver" or "Epson Virtual COM Port" |
   | Xprinter | "Xprinter USB Driver" |
   | GPrinter | "GPrinter USB Driver" |
   | Generic (CH340/PL2303 chip) | "Prolific USB-to-Serial Driver" or "CH340 Driver" |

2. After installing, unplug and reconnect the printer.

3. Check Device Manager again — it should now show a **real COM port** (not Intel AMT).

4. Use that COM port path (e.g., `\\.\COM3`).

---

### Linux / Ubuntu / Raspberry Pi

```bash
# List USB printer devices
ls /dev/usb/lp*

# Typical paths:
# /dev/usb/lp0  (first USB printer)
# /dev/usb/lp1  (second USB printer)

# If not found, check with dmesg
dmesg | grep -i "usblp\|printer"

# Grant write permission (if permission denied)
sudo chmod 666 /dev/usb/lp0

# Or add user to lp group permanently
sudo usermod -aG lp $(whoami)
```

**Test:**
```bash
echo "TEST" > /dev/usb/lp0
```
If the printer prints "TEST" → path is correct.

---

### Common Paths Reference

| Printer Type | OS | Value to use | Field |
|---|---|---|---|
| USB COM port | Windows | `\\.\.\COM3` | `usb_path` |
| USB (device file) | Linux | `/dev/usb/lp0` | `usb_path` |
| **Windows spooler** | **Windows** | **`EPSON TM-T88IV Receipt`** | **`printer_name`** |
| USB (device file) | macOS | `/dev/usb/lp0` | `usb_path` |

> If your printer shows under **Print queues** in Device Manager (like `EPSON TM-T88IV Receipt`) → use `connection_type: "windows_printer"` + `printer_name`.  
> If your printer shows under **Ports (COM & LPT)** → use `connection_type: "usb"` + `usb_path`.

---

## Step 2: Register USB Printer via API

### Field Clarification

| Field | Purpose | Values |
|---|---|---|
| `printer_type` | **Physical type** of the printer hardware | `thermal`, `dot_matrix`, `laser`, `inkjet` |
| `connection_type` | **How** the printer connects | `usb`, `network`, `windows_printer`, `bluetooth`, `cloud` |
| `station` | **Which jobs** get routed to this printer | `kitchen`, `bar`, `bill`, `cashier` |
| `usb_path` | Raw device path (COM port or lp device) | `\\.\.\COM3`, `/dev/usb/lp0` |
| `printer_name` | Windows spooler printer name | `EPSON TM-T88IV Receipt` |

**Which connection_type to use?**

| Your setup | `connection_type` | Required field |
|---|---|---|
| Printer in **Print queues** in Device Manager | `windows_printer` | `printer_name` |
| Printer in **Ports (COM & LPT)** | `usb` | `usb_path: "\\\\.\\COM3"` |
| Printer on LAN with IP | `network` | `ip_address` + `port` |
| Linux USB device file | `usb` | `usb_path: "/dev/usb/lp0"` |

---

### Option A — Windows Printer by Name (Recommended for Windows PCs)

> Use this when your printer appears under **Print queues** in Device Manager (e.g. `EPSON TM-T88IV Receipt`).  
> The bridge agent sends raw ESC/POS bytes via the Windows spooler using the Win32 RAW API. **No COM port needed.**

**POST** `/api/v1/printers`

**Payload:**
```json
{
  "name": "Kitchen Printer",
  "printer_type": "thermal",
  "station": "kitchen",
  "connection_type": "windows_printer",
  "printer_name": "EPSON TM-T88IV Receipt",
  "paper_width": "80mm",
  "characters_per_line": 48,
  "supports_cutter": true,
  "supports_cash_drawer": false,
  "is_active": true
}
```

> `printer_name` must exactly match what `Get-Printer` shows in PowerShell.

**Bill printer with cash drawer:**
```json
{
  "name": "Cashier Printer",
  "printer_type": "thermal",
  "station": "bill",
  "connection_type": "windows_printer",
  "printer_name": "EPSON TM-T88IV Receipt",
  "paper_width": "80mm",
  "characters_per_line": 48,
  "supports_cutter": true,
  "supports_cash_drawer": true,
  "is_active": true
}
```

---

### Option B — USB Raw Device Path (Linux / Windows COM port)

> Use this when your printer appears under **Ports (COM & LPT)** (Windows COM port) or as `/dev/usb/lp0` (Linux).

**POST** `/api/v1/printers`

**Payload:**
```json
{
  "name": "Kitchen USB Printer",
  "printer_type": "thermal",
  "station": "kitchen",
  "connection_type": "usb",
  "usb_path": "/dev/usb/lp0",
  "paper_width": "80mm",
  "characters_per_line": 48,
  "supports_cutter": true,
  "supports_cash_drawer": false,
  "is_active": true
}
```

> `ip_address` is **not required** for USB printers — leave it out.

**Success Response (201):**
```json
{
  "success": true,
  "data": {
    "id": 12,
    "uuid": "a1b2c3d4-...",
    "outlet_id": 55,
    "name": "Kitchen USB Printer",
    "code": "PRNXYZ123",
    "printer_type": "kot",
    "station": "kitchen",
    "connection_type": "usb",
    "usb_path": "/dev/usb/lp0",
    "ip_address": null,
    "port": 9100,
    "paper_width": "80mm",
    "characters_per_line": 48,
    "supports_cutter": true,
    "supports_cash_drawer": false,
    "is_active": true,
    "is_online": false
  }
}
```

---

## Step 3: Station → USB Printer Mapping

### Common Station Configurations

> For all stations, set `printer_type: "thermal"` in the payload. The `station` field controls what gets printed.

| `station` value | Used for | `printer_type` |
|---|---|---|
| `kitchen` | Kitchen Order Tickets (KOT) | `thermal` |
| `bar` | Bar Order Tickets (BOT) | `thermal` |
| `bill` | Bill / Invoice printing | `thermal` |
| `cashier` | Cashier counter bills | `thermal` |

### Example: Bar Station USB Printer (KOT)

```json
{
  "name": "Bar USB Printer",
  "printer_type": "thermal",
  "station": "bar",
  "connection_type": "usb",
  "usb_path": "/dev/usb/lp1",
  "paper_width": "80mm",
  "characters_per_line": 48,
  "supports_cutter": true,
  "supports_cash_drawer": false
}
```

### Example: Bill USB Printer (with Cash Drawer)

```json
{
  "name": "Cashier USB Printer",
  "printer_type": "thermal",
  "station": "bill",
  "connection_type": "usb",
  "usb_path": "/dev/usb/lp0",
  "paper_width": "80mm",
  "characters_per_line": 48,
  "supports_cutter": true,
  "supports_cash_drawer": true
}
```

---

## Step 4: Link Printer to Kitchen Station (for KOT)

If your outlet uses **Kitchen Stations**, link the USB printer to it.

### Get Kitchen Stations

**GET** `/api/v1/kitchen-stations?outletId=55`

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 3, "name": "Main Kitchen", "code": "kitchen", "printer_id": null }
  ]
}
```

### Update Kitchen Station with Printer

**PATCH** `/api/v1/kitchen-stations/3`

```json
{
  "printer_id": 12
}
```

---

## Step 5: Update USB Printer via API

**PATCH** `/api/v1/printers/:id`

```json
{
  "usb_path": "/dev/usb/lp1",
  "is_active": true
}
```

---

## Step 6: Test Print via API

**POST** `/api/v1/printers/:id/test`

**Response (direct USB success):**
```json
{
  "success": true,
  "data": {
    "id": 45,
    "uuid": "...",
    "method": "bridge"
  }
}
```

---

## Step 7: Bridge Agent Setup (for Cloud Deployments)

When the server is in the cloud and the USB printer is at the restaurant, set up the **Bridge Agent** on the restaurant's local machine.

### Install

```bash
# On the restaurant PC / Raspberry Pi / local server
cd /opt/printer-bridge
npm init -y
npm install axios
```

Copy `bridge-agent.js` to this folder.

### Configure

Edit `bridge-agent.js` top section:

```js
const CONFIG = {
  CLOUD_URL: 'https://your-backend.com',   // Your cloud backend URL
  OUTLET_ID: '55',                          // Your outlet ID
  BRIDGE_CODE: 'KITCHEN-BRIDGE-1',         // From printer_bridges table
  API_KEY: 'your-api-key-here',
  PRINTERS: {
    // Optional local fallback (overridden by DB config on startup)
    kitchen: { ip: null, port: 9100, usbPath: '/dev/usb/lp0', connectionType: 'usb' }
  }
};
```

### Run

```bash
node bridge-agent.js
```

**Expected startup output:**
```
╔══════════════════════════════════════════════════════════╗
║           RESTAURANT POS - PRINTER BRIDGE AGENT          ║
╠══════════════════════════════════════════════════════════╣
║  Server:      https://your-backend.com                   ║
║  Outlet ID:   55                                         ║
║  Bridge Code: KITCHEN-BRIDGE-1                           ║
╠══════════════════════════════════════════════════════════╣
║  Configured Printers:                                    ║
║    - kitchen: USB:/dev/usb/lp0                           ║
║    - bar:     USB:/dev/usb/lp1                           ║
╚══════════════════════════════════════════════════════════╝
🟢 Bridge agent started. Waiting for print jobs...
```

### Run as Windows Service (optional)

```bash
npm install -g pm2
pm2 start bridge-agent.js --name printer-bridge
pm2 startup
pm2 save
```

---

## API Reference Summary

### Create Printer

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✅ | Display name |
| `printer_type` | enum | ✅ | Physical type: `thermal`, `dot_matrix`, `laser`, `inkjet` |
| `station` | string | ✅ | Job routing: `kitchen`, `bar`, `bill`, `cashier` |
| `connection_type` | enum | ✅ | How it connects: **`usb`** for USB printers |
| `usb_path` | string | ✅ for USB | `/dev/usb/lp0` (Linux) or `\\\\.\\.\\COM3` (Windows) |
| `ip_address` | string | ❌ | Not needed for USB — omit entirely |
| `paper_width` | enum | — | `58mm` or `80mm` (default: `80mm`) |
| `characters_per_line` | int | — | `32` for 58mm paper, `48` for 80mm |
| `supports_cutter` | bool | — | Auto-cut after print (default: `true`) |
| `supports_cash_drawer` | bool | — | Open cash drawer on bill (default: `false`) |

### Get All Printers for Outlet

**GET** `/api/v1/printers?outletId=55`

### Get Printer Bridge Config (used by bridge agent)

**GET** `/api/v1/printers/bridge/:outletId/:bridgeCode/config`

**Response includes USB printers:**
```json
{
  "success": true,
  "data": {
    "printers": {
      "kitchen": {
        "ip": null,
        "port": 9100,
        "usbPath": "/dev/usb/lp0",
        "connectionType": "usb",
        "printerId": 12
      },
      "bill": {
        "ip": null,
        "port": 9100,
        "usbPath": "/dev/usb/lp1",
        "connectionType": "usb",
        "printerId": 13
      }
    }
  }
}
```

### Bridge Poll Response (job with USB info)

**GET** `/api/v1/printers/bridge/:outletId/:bridgeCode/poll`

```json
{
  "success": true,
  "data": [
    {
      "id": 101,
      "job_type": "kot",
      "station": "kitchen",
      "reference_number": "K-0042",
      "content": "b64:G0A...",
      "ip_address": null,
      "port": 9100,
      "usb_path": "/dev/usb/lp0",
      "connection_type": "usb"
    }
  ]
}
```

---

## Print Flow Logging

When a KOT or Bill is sent:

| Log Message | Meaning |
|---|---|
| `KOT K-001 printed DIRECT via USB /dev/usb/lp0` | Direct USB write succeeded |
| `USB direct failed ... falling back to bridge` | Device not reachable, queued for bridge |
| `✅ Printed via USB /dev/usb/lp0 in 12ms` | Bridge agent printed via USB |

---

## Troubleshooting

### USB device not found

```bash
# Check device is recognized
lsusb

# Check printer device file
ls /dev/usb/

# Test raw write
echo "Test" > /dev/usb/lp0
```

### Permission denied on Linux

```bash
sudo chmod 666 /dev/usb/lp0
# Or permanently:
sudo usermod -aG lp $USER
```

### COM port not printing on Windows

1. Open Device Manager → check COM port number
2. Set baud rate: `mode COM3 BAUD=9600 PARITY=N DATA=8 STOP=1`
3. Use `usb_path: "\\\\.\\COM3"` in printer config

### Bridge agent shows USB device not found

- The printer may be off or disconnected
- The bridge agent checks `fs.existsSync(usbPath)` on each status report
- Once printer reconnected, it auto-recovers on next poll (30s cooldown clears)

---

# Bluetooth Printer Setup Guide

## How It Works — Two Paths

Bluetooth thermal printers use the **SPP (Serial Port Profile)**. There are **two ways** to connect them, and the backend tries the fastest one first:

### Path A — Flutter App Direct (Recommended, Zero Latency)

Your Flutter tablet/phone connects to the Bluetooth printer locally and joins Socket.IO rooms. When a KOT or bill is generated, the backend emits `bt:print` directly to the app. The app prints via its own Bluetooth SDK.

```
Server generates KOT / Bill
       │
       ▼
  sendToBluetoothDevice() ──→ Socket.IO emit 'bt:print'
       │                           │
       │                           ▼
       │                    Flutter app receives base64 ESC/POS
       │                    App decodes → sends to BT printer via SDK
       │                           │
       │                         ✅ Printed (zero latency)
       │
       └── Device offline? ──→ createPrintJob() → bridge queue
                                              │
                                              ▼
                                       Bridge agent prints (Path B)
```

### Path B — Bridge Agent (Fallback, No Flutter App Needed)

If the Flutter app is offline or you want a dedicated local PC to handle printing, the bridge agent connects to the Bluetooth printer via `bluetooth-serial-port`.

```
Server receives print request
       │
       ▼
  createPrintJob() → bridge queue
                          │
                          ▼
                   Bridge agent picks up via long-polling
                          │
                          ▼
                   Bluetooth SPP connect → write ESC/POS → disconnect
                          │
                        ✅ Printed
```

## Step 1: Find the Bluetooth MAC Address

### Windows

1. Pair the printer with Windows first (Settings → Bluetooth & devices)
2. Open PowerShell and run:

```powershell
Get-PnpDevice -Class Bluetooth | Where-Object {$_.FriendlyName -like "*printer*"}
```

Or use `bluetooth-serial-port` discovery:

```bash
npm install -g bluetooth-serial-port
node -e "new (require('bluetooth-serial-port').BluetoothSerialPort).inquire()"
```

**MAC address format:** `00:1B:DC:0F:01:00`

### Linux / Raspberry Pi

```bash
# Make sure Bluetooth is on
sudo systemctl start bluetooth

# Scan for the printer
bluetoothctl scan on
# Look for a device name like "XP-58", "EPSON", "TM-P20", etc.

# Note the MAC address, e.g. 00:1B:DC:0F:01:00
# Pair and trust it
bluetoothctl pair 00:1B:DC:0F:01:00
bluetoothctl trust 00:1B:DC:0F:01:00
```

## Step 2: Register Bluetooth Printer via API

**POST** `/api/v1/printers`

```json
{
  "name": "Kitchen Bluetooth Printer",
  "printer_type": "thermal",
  "station": "kitchen",
  "connection_type": "bluetooth",
  "bluetooth_address": "00:1B:DC:0F:01:00",
  "paper_width": "80mm",
  "characters_per_line": 48,
  "supports_cutter": true,
  "supports_cash_drawer": false,
  "is_active": true
}
```

| Field | Required | Description |
|---|---|---|
| `connection_type` | ✅ | Must be `bluetooth` |
| `bluetooth_address` | ✅ | MAC address of the paired printer |
| `device_id` | — | Flutter device ID for explicit targeting (recommended) |
| `ip_address` | ❌ | Omit entirely |
| `usb_path` | ❌ | Omit entirely |

## Step 3: Flutter App Integration (Path A — Direct)

### 3.1 Join Bluetooth Print Rooms

When your Flutter app starts and the user has paired a Bluetooth printer, emit `join:bt_print` on the existing Socket.IO connection:

```dart
socket.emit('join:bt_print', {
  'outletId': outletId,
  'station': 'kitchen',      // or 'bar', 'bill', 'cashier'
  'deviceId': deviceId,      // your app's unique device ID
  'userId': userId,          // optional, for user-specific routing
});
```

### 3.2 Listen for `bt:print` Event (bluetooth_print_plus)

The backend sends two forms of content:
- `text` — plain text already formatted to the correct width (recommended for `bluetooth_print_plus`)
- `escpos` — pre-formatted ESC/POS bytes as base64 (fallback for raw-byte SDKs)

For **58mm printers** (32 chars per line), the backend automatically narrows the content so nothing overflows. Your Flutter app should use the `text` field with `bluetooth_print_plus`'s command builder:

```dart
import 'package:bluetooth_print_plus/bluetooth_print_plus.dart';

socket.on('bt:print', (data) {
  final jobId = data['jobId'] as String;
  final paperWidth = data['paperWidth'] as String;          // '58mm' or '80mm'
  final charsPerLine = data['charactersPerLine'] as int;    // 32 or 48
  final shouldCut = data['shouldCut'] as bool;
  final openDrawer = data['openDrawer'] as bool? ?? false;
  final beep = data['beep'] as bool? ?? false;

  // Use the plain text content formatted at correct width
  final text = data['text'] as String?;
  final escposBase64 = data['escpos'] as String?;

  if (text != null && text.isNotEmpty) {
    // --- Build commands with bluetooth_print_plus ---
    final command = EscPosCommand();

    // Optional beep
    if (beep) command.addBeep(3, 2);

    // Add each line of text
    for (final line in text.split('\n')) {
      command.addText(line);
      command.addFeedLine(1);
    }

    // Open cash drawer if requested (bills)
    if (openDrawer) command.addOpenCashDrawer();

    // Cut paper if supported
    if (shouldCut) command.addCut();

    // Send to printer
    BluetoothPrintPlus.write(command.getCommand()).then((_) {
      socket.emit('bt:print_done', {'jobId': jobId, 'success': true});
    }).catchError((err) {
      socket.emit('bt:print_done', {
        'jobId': jobId,
        'success': false,
        'error': err.toString(),
      });
    });
  } else if (escposBase64 != null) {
    // Fallback: print raw ESC/POS bytes
    final escposBytes = base64Decode(escposBase64);
    BluetoothPrintPlus.write(escposBytes).then((_) {
      socket.emit('bt:print_done', {'jobId': jobId, 'success': true});
    }).catchError((err) {
      socket.emit('bt:print_done', {
        'jobId': jobId,
        'success': false,
        'error': err.toString(),
      });
    });
  }
});
```

> **58mm vs 80mm:** When you register the printer with `"paper_width": "58mm"` and `"characters_per_line": 32`, the backend automatically scales KOT/Bill content to 32 characters wide. The `text` field arrives ready for 58mm paper — no overflow, no truncation.

### 3.3 Routing Behaviour

The backend tries rooms in this order:

1. **`bt:{outletId}:user:{userId}`** — If your app sends `userId`, bills for that cashier route here
2. **`bt:{outletId}:device:{deviceId}`** — Explicit device targeting (most reliable for KOTs)
3. **`bt:{outletId}:station:{station}`** — Station broadcast (first connected device wins)

If **no device is connected** in any room, the backend automatically falls back to the bridge agent (Path B).

## Step 4: Bridge Agent — Install Bluetooth Dependency (Path B — Fallback)

On the local bridge machine (the PC/Raspberry Pi that is within Bluetooth range of the printer):

```bash
cd /opt/printer-bridge
npm install bluetooth-serial-port
```

> **Note:** `bluetooth-serial-port` requires native compilation tools.
> - **Windows:** Visual Studio Build Tools or Visual C++ Redistributable
> - **Linux:** `sudo apt-get install build-essential libbluetooth-dev`
> - **macOS:** Xcode Command Line Tools

## Troubleshooting

### Flutter app not receiving `bt:print` events

- Verify the app emitted `join:bt_print` with the correct `outletId` and `station`
- Check that the printer record in DB has `connection_type: 'bluetooth'` and the correct `station`
- Look at backend logs for `BT[...]: job → ... room ...` to confirm routing
- If logs say `no device in any room — bridge fallback`, the app hasn't joined the right room

### Flutter app receives event but printer doesn't print

- Confirm the Bluetooth printer is paired and connected in the Flutter app **before** joining the room
- Ensure `base64Decode` produces a `Uint8List` and your BT SDK accepts that type
- The payload has `shouldCut: true` — make sure your SDK calls `cutPaper()` after writing the data

### `bluetooth-serial-port package is not installed` (Bridge Agent)

Run `npm install bluetooth-serial-port` in the same folder as `bridge-agent.js`.

### `Bluetooth connect failed` (Bridge Agent)

- Make sure the printer is paired with the local machine
- Check that the MAC address is correct
- Ensure no other app is already connected to the printer (Bluetooth SPP usually allows only one connection at a time)

### `Bluetooth serial port channel not found` (Bridge Agent)

- Some printers expose SPP on a non-standard channel. Try pairing first via OS settings, then run the bridge agent.
- On Linux, you can bind the printer to a virtual serial port: `rfcomm bind 0 00:1B:DC:0F:01:00 1` and then use `connection_type: 'usb'` with `usb_path: '/dev/rfcomm0'` instead.
