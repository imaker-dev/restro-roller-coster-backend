/**
 * Test: Bill Token Number Feature
 * 
 * Verifies:
 * 1. token_number column exists in invoices table
 * 2. generateTokenNumber method exists in billing service
 * 3. formatInvoice includes tokenNumber
 * 4. printBillToThermal includes tokenNumber in billPrintData
 * 5. printer.service formatBillContent displays TOKEN prominently
 * 
 * Run: node tests/_verify_bill_token_number.js
 */

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ ${msg}`); }
}

// Read source files
const billingServicePath = path.join(__dirname, '../src/services/billing.service.js');
const billingContent = fs.readFileSync(billingServicePath, 'utf8');

const printerServicePath = path.join(__dirname, '../src/services/printer.service.js');
const printerContent = fs.readFileSync(printerServicePath, 'utf8');

const migrationPath = path.join(__dirname, '../src/database/migrations/070_add_token_number_to_invoices.sql');
const migrationExists = fs.existsSync(migrationPath);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  BILL TOKEN NUMBER FEATURE VERIFICATION');
console.log('═══════════════════════════════════════════════════════════════\n');

// ═══════════════════════════════════════════════════════════════
// TEST 1: Migration exists
// ═══════════════════════════════════════════════════════════════
console.log('── TEST 1: Migration ──');
ok(migrationExists, 'Migration 070_add_token_number_to_invoices.sql exists');

if (migrationExists) {
  const migrationContent = fs.readFileSync(migrationPath, 'utf8');
  ok(migrationContent.includes('token_number'), 'Migration adds token_number column');
  ok(migrationContent.includes('idx_invoices_token'), 'Migration creates index');
}

// ═══════════════════════════════════════════════════════════════
// TEST 2: generateTokenNumber method
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 2: generateTokenNumber Method ──');
ok(billingContent.includes('async generateTokenNumber'), 'generateTokenNumber method exists');
ok(billingContent.includes('COALESCE(MAX(token_number), 0) + 1'), 'Uses COALESCE for safe increment');
ok(billingContent.includes('DATE(NOW())'), 'Uses SQL-side DATE(NOW()) for daily reset');
ok(billingContent.includes('FOR UPDATE'), 'Uses FOR UPDATE lock to prevent duplicates');

// ═══════════════════════════════════════════════════════════════
// TEST 3: generateBill uses tokenNumber
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 3: generateBill Integration ──');
ok(billingContent.includes('const tokenNumber = await this.generateTokenNumber'), 'generateBill calls generateTokenNumber');
ok(billingContent.includes('token_number = ?,'), 'Revive path includes token_number in UPDATE');
ok(billingContent.includes('invoice_number, token_number,'), 'INSERT includes token_number column');

// ═══════════════════════════════════════════════════════════════
// TEST 4: formatInvoice includes tokenNumber
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 4: formatInvoice Output ──');
ok(billingContent.includes('tokenNumber: invoice.token_number'), 'formatInvoice maps token_number to tokenNumber');

// ═══════════════════════════════════════════════════════════════
// TEST 5: printBillToThermal includes tokenNumber
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 5: printBillToThermal ──');
ok(billingContent.includes('tokenNumber: invoice.tokenNumber'), 'billPrintData includes tokenNumber');

// ═══════════════════════════════════════════════════════════════
// TEST 6: Printer service displays TOKEN prominently
// ═══════════════════════════════════════════════════════════════
console.log('\n── TEST 6: Printer Service Display ──');
ok(printerContent.includes("'TOKEN: ' + billData.tokenNumber"), 'formatBillContent displays TOKEN: X');
ok(printerContent.includes('cmd.DOUBLE_HW') && printerContent.includes('tokenNumber'), 'Token displayed in large font (DOUBLE_HW)');
ok(printerContent.includes('cmd.BOLD_ON') && printerContent.includes('TOKEN'), 'Token displayed in bold');

// ═══════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`  ✅ Passed: ${pass}   │   ❌ Failed: ${fail}`);
console.log('═══════════════════════════════════════════════════════════════\n');

if (fail > 0) {
  console.log('❌ Some tests failed!\n');
  process.exit(1);
} else {
  console.log('✅ All bill token number tests passed!\n');
  process.exit(0);
}
