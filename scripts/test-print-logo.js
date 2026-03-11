/**
 * Test Script: Print Bill with Logo
 * This script tests the complete flow of printing a bill with logo
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { imageToEscPos, wrapLogoWithAlignment } = require('../src/utils/escpos-image');
const net = require('net');

// Configuration
const PRINTER_IP = process.env.PRINTER_IP || '192.168.1.13';
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT, 10) || 9100;
const LOGO_PATH = path.resolve(__dirname, '../uploads/logos/logo.png');

// ESC/POS Commands
const ESC = 0x1B;
const GS = 0x1D;
const CMD = {
  INIT: Buffer.from([ESC, 0x40]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 0x01]),
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0x00]),
  BOLD_ON: Buffer.from([ESC, 0x45, 0x01]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0x00]),
  DOUBLE_HEIGHT: Buffer.from([GS, 0x21, 0x10]),
  NORMAL_SIZE: Buffer.from([GS, 0x21, 0x00]),
  LINE_FEED: Buffer.from([0x0A]),
  CUT: Buffer.from([GS, 0x56, 0x00]),
  PARTIAL_CUT: Buffer.from([GS, 0x56, 0x01])
};

// Logo size recommendations
const LOGO_SPECS = {
  '80mm': {
    maxWidthPixels: 384,  // 48mm printable area at 203 DPI
    maxHeightPixels: 120, // Keep logo compact
    dpi: 203,
    paperWidth: '80mm (3.15")',
    printableWidth: '72mm (2.83")',
    notes: 'Standard thermal receipt printer'
  },
  '57mm': {
    maxWidthPixels: 384,  // Scaled down for 57mm
    maxHeightPixels: 100,
    dpi: 203,
    paperWidth: '57mm (2.25")',
    printableWidth: '48mm (1.89")',
    notes: 'Compact/portable thermal printer'
  }
};

/**
 * Create sample bill content
 */
function createBillContent() {
  const lines = [];
  
  // Header (after logo)
  lines.push('');
  lines.push('THE CITYVIEW');
  lines.push('ROOFTOP RESTAURANT & BAR');
  lines.push('123 Skyline Avenue, Mumbai');
  lines.push('Tel: +91 98765 43210');
  lines.push('GSTIN: 27AABCU9603R1ZM');
  lines.push('--------------------------------');
  lines.push('TAX INVOICE');
  lines.push('--------------------------------');
  lines.push(`Date: ${new Date().toLocaleDateString('en-IN')}`);
  lines.push(`Time: ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`);
  lines.push('Invoice: INV/2425/00123');
  lines.push('Table: T-05 | Cashier: Admin');
  lines.push('--------------------------------');
  lines.push('ITEM              QTY    AMOUNT');
  lines.push('--------------------------------');
  lines.push('Butter Chicken     1     450.00');
  lines.push('Garlic Naan        2      80.00');
  lines.push('Dal Makhani        1     280.00');
  lines.push('Jeera Rice         1     150.00');
  lines.push('Masala Papad       1      60.00');
  lines.push('--------------------------------');
  lines.push('Subtotal              1,020.00');
  lines.push('CGST (2.5%)              25.50');
  lines.push('SGST (2.5%)              25.50');
  lines.push('--------------------------------');
  lines.push('GRAND TOTAL        Rs 1,071.00');
  lines.push('--------------------------------');
  lines.push('Payment: CASH');
  lines.push('');
  lines.push('Thank you for dining with us!');
  lines.push('Visit again soon.');
  lines.push('');
  lines.push('');
  
  return lines.join('\n');
}

/**
 * Convert text to ESC/POS buffer
 */
function textToEscPos(text) {
  const lines = text.split('\n');
  const buffers = [CMD.ALIGN_CENTER];
  
  for (const line of lines) {
    if (line.includes('GRAND TOTAL') || line.includes('TAX INVOICE')) {
      buffers.push(CMD.BOLD_ON);
      buffers.push(Buffer.from(line + '\n', 'utf8'));
      buffers.push(CMD.BOLD_OFF);
    } else {
      buffers.push(Buffer.from(line + '\n', 'utf8'));
    }
  }
  
  buffers.push(CMD.ALIGN_LEFT);
  return Buffer.concat(buffers);
}

/**
 * Send data to printer via TCP
 */
function sendToPrinter(ip, port, data) {
  return new Promise((resolve, reject) => {
    console.log(`\nConnecting to printer at ${ip}:${port}...`);
    
    const client = new net.Socket();
    client.setTimeout(10000);
    
    client.connect(port, ip, () => {
      console.log('Connected! Sending print data...');
      client.write(data);
      client.end();
    });
    
    client.on('close', () => {
      console.log('Print job sent successfully!');
      resolve();
    });
    
    client.on('error', (err) => {
      reject(new Error(`Printer connection failed: ${err.message}`));
    });
    
    client.on('timeout', () => {
      client.destroy();
      reject(new Error('Printer connection timed out'));
    });
  });
}

/**
 * Main test function
 */
async function testPrintWithLogo() {
  console.log('='.repeat(50));
  console.log('THERMAL PRINTER LOGO TEST');
  console.log('='.repeat(50));
  
  // Display logo specifications
  console.log('\n📏 LOGO SIZE RECOMMENDATIONS:');
  console.log('-'.repeat(50));
  
  for (const [size, spec] of Object.entries(LOGO_SPECS)) {
    console.log(`\n${size} Thermal Printer:`);
    console.log(`  Paper Width: ${spec.paperWidth}`);
    console.log(`  Printable Width: ${spec.printableWidth}`);
    console.log(`  Resolution: ${spec.dpi} DPI`);
    console.log(`  Max Logo Size: ${spec.maxWidthPixels}x${spec.maxHeightPixels} pixels`);
    console.log(`  Notes: ${spec.notes}`);
  }
  
  console.log('\n💡 BEST PRACTICES:');
  console.log('  - Use PNG format (no transparency issues)');
  console.log('  - Black & white or grayscale logos work best');
  console.log('  - High contrast improves readability');
  console.log('  - Keep file size under 100KB');
  console.log('  - Recommended: 300x100 pixels at 203 DPI');
  
  // Check if logo exists
  console.log('\n📁 Checking logo file...');
  if (!fs.existsSync(LOGO_PATH)) {
    console.log(`Logo not found at: ${LOGO_PATH}`);
    console.log('Creating sample logo...');
    
    // Create a sample logo using sharp
    const logoDir = path.dirname(LOGO_PATH);
    if (!fs.existsSync(logoDir)) {
      fs.mkdirSync(logoDir, { recursive: true });
    }
    
    // Create a simple text-based logo
    const svgLogo = `
      <svg width="384" height="120" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <text x="192" y="30" text-anchor="middle" font-size="14" font-family="Arial" fill="#333">The</text>
        <text x="192" y="65" text-anchor="middle" font-size="32" font-family="Georgia" font-style="italic" font-weight="bold" fill="#222">Cityview</text>
        <text x="192" y="95" text-anchor="middle" font-size="12" font-family="Arial" letter-spacing="2" fill="#555">ROOFTOP RESTAURANT AND BAR</text>
      </svg>
    `;
    
    await sharp(Buffer.from(svgLogo))
      .png()
      .toFile(LOGO_PATH);
    
    console.log(`Sample logo created: ${LOGO_PATH}`);
  }
  
  // Get logo info
  const logoStats = fs.statSync(LOGO_PATH);
  const logoMeta = await sharp(LOGO_PATH).metadata();
  
  console.log(`\n📷 Logo Info:`);
  console.log(`  Path: ${LOGO_PATH}`);
  console.log(`  Size: ${(logoStats.size / 1024).toFixed(2)} KB`);
  console.log(`  Dimensions: ${logoMeta.width}x${logoMeta.height} pixels`);
  console.log(`  Format: ${logoMeta.format}`);
  
  // Convert logo to ESC/POS format (reduced size for compact printing)
  console.log('\n🔄 Converting logo to ESC/POS format...');
  const logoBuffer = await imageToEscPos(LOGO_PATH, {
    maxWidth: 280,
    maxHeight: 80,
    threshold: 128
  });
  
  if (!logoBuffer || logoBuffer.length === 0) {
    console.log('⚠️  Warning: Logo conversion returned empty buffer');
    return;
  }
  
  console.log(`Logo converted: ${logoBuffer.length} bytes`);
  
  // Wrap logo with alignment
  const wrappedLogo = wrapLogoWithAlignment(logoBuffer);
  
  // Create bill content
  console.log('\n📝 Creating bill content...');
  const billText = createBillContent();
  const billBuffer = textToEscPos(billText);
  
  // Combine all parts
  const fullPrintData = Buffer.concat([
    CMD.INIT,
    wrappedLogo,
    billBuffer,
    CMD.LINE_FEED,
    CMD.LINE_FEED,
    CMD.LINE_FEED,
    CMD.PARTIAL_CUT
  ]);
  
  console.log(`Total print data: ${fullPrintData.length} bytes`);
  
  // Save preview to file
  const previewPath = path.resolve(__dirname, '../uploads/logos/print-preview.bin');
  fs.writeFileSync(previewPath, fullPrintData);
  console.log(`\n💾 Print data saved to: ${previewPath}`);
  
  // Try to print
  const shouldPrint = process.argv.includes('--print');
  
  if (shouldPrint) {
    try {
      await sendToPrinter(PRINTER_IP, PRINTER_PORT, fullPrintData);
      console.log('\n✅ Print job completed successfully!');
    } catch (err) {
      console.log(`\n❌ Print failed: ${err.message}`);
      console.log('\nTo print, ensure:');
      console.log(`  1. Printer is connected at ${PRINTER_IP}:${PRINTER_PORT}`);
      console.log('  2. Printer is powered on and has paper');
      console.log('  3. Network firewall allows connection');
    }
  } else {
    console.log('\n📋 Test completed (dry run)');
    console.log(`To actually print, run: node scripts/test-print-logo.js --print`);
    console.log(`Set PRINTER_IP and PRINTER_PORT environment variables for your printer`);
  }
  
  console.log('\n' + '='.repeat(50));
}

// Run the test
testPrintWithLogo().catch(console.error);
