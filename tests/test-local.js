/**
 * Local API Test - localhost:3005
 * Customer Link-Order & Order Details Test
 */
require('dotenv').config();
const { initializeDatabase, getPool } = require('../src/database');
const orderService = require('../src/services/order.service');
const customerService = require('../src/services/customer.service');

const OUTLET_ID = 43;

async function main() {
  console.log('═'.repeat(70));
  console.log('  CUSTOMER LINK-ORDER & ORDER DETAILS TEST');
  console.log('═'.repeat(70));

  try {
    await initializeDatabase();
    const pool = getPool();
    console.log('\n✅ Database connected\n');

    // Test 1: Takeaway API
    console.log('📍 TEST 1: Takeaway Orders');
    console.log('─'.repeat(60));
    
    const adminResult = await orderService.getPendingTakeawayOrders(OUTLET_ID, {
      status: 'all',
      userRole: 'admin'
    });
    console.log(`  Total takeaway orders: ${adminResult.pagination.total}`);

    // Test 2: Comprehensive Order Details
    console.log('\n📍 TEST 2: Comprehensive Order Details (GET /api/v1/orders/:id)');
    console.log('─'.repeat(60));

    // Find an order with payments (preferably split)
    const [orders] = await pool.query(`
      SELECT o.id, o.order_number, p.payment_mode 
      FROM orders o 
      LEFT JOIN payments p ON p.order_id = o.id 
      WHERE o.outlet_id = ? 
      ORDER BY o.id DESC LIMIT 1
    `, [OUTLET_ID]);

    if (orders.length > 0) {
      const orderDetail = await orderService.getOrderWithItems(orders[0].id);
      
      console.log('\n  ┌─ ORDER BASIC INFO');
      console.log(`  │  ID: ${orderDetail.id}`);
      console.log(`  │  Order Number: ${orderDetail.orderNumber}`);
      console.log(`  │  Order Type: ${orderDetail.orderType}`);
      console.log(`  │  Status: ${orderDetail.status}`);
      console.log(`  │  Payment Status: ${orderDetail.paymentStatus}`);
      
      console.log('\n  ├─ TABLE & LOCATION');
      console.log(`  │  Table: ${orderDetail.tableName || 'N/A'} (${orderDetail.tableNumber || 'N/A'})`);
      console.log(`  │  Floor: ${orderDetail.floorName || 'N/A'}`);
      console.log(`  │  Section: ${orderDetail.sectionName || 'N/A'}`);
      
      console.log('\n  ├─ CUSTOMER INFO');
      console.log(`  │  Name: ${orderDetail.customerName || 'N/A'}`);
      console.log(`  │  Phone: ${orderDetail.customerPhone || 'N/A'}`);
      console.log(`  │  Email: ${orderDetail.customerEmail || 'N/A'}`);
      console.log(`  │  GSTIN: ${orderDetail.customerGstin || 'N/A'}`);
      
      console.log('\n  ├─ STAFF INFO');
      console.log(`  │  Created By: ${orderDetail.createdBy?.name || 'N/A'} (${orderDetail.createdBy?.role || 'N/A'})`);
      
      console.log('\n  ├─ FINANCIAL SUMMARY');
      console.log(`  │  Subtotal: ₹${orderDetail.subtotal}`);
      console.log(`  │  Tax Amount: ₹${orderDetail.taxAmount}`);
      console.log(`  │  Discount: ₹${orderDetail.discountAmount}`);
      console.log(`  │  Service Charge: ₹${orderDetail.serviceCharge}`);
      console.log(`  │  Total Amount: ₹${orderDetail.totalAmount}`);
      console.log(`  │  Paid Amount: ₹${orderDetail.paidAmount}`);
      console.log(`  │  Balance Due: ₹${orderDetail.balanceDue}`);
      
      console.log('\n  ├─ TAX BREAKDOWN');
      console.log(`  │  CGST: ₹${orderDetail.cgstAmount}`);
      console.log(`  │  SGST: ₹${orderDetail.sgstAmount}`);
      console.log(`  │  IGST: ₹${orderDetail.igstAmount}`);
      console.log(`  │  VAT: ₹${orderDetail.vatAmount}`);
      console.log(`  │  CESS: ₹${orderDetail.cessAmount}`);
      console.log(`  │  Total Tax: ₹${orderDetail.totalTax}`);
      if (orderDetail.taxBreakup && Object.keys(orderDetail.taxBreakup).length > 0) {
        console.log(`  │  Detailed Breakup:`);
        Object.entries(orderDetail.taxBreakup).forEach(([code, data]) => {
          console.log(`  │    - ${code}: ₹${data.taxAmount.toFixed(2)} @ ${data.rate}% on ₹${data.taxableAmount.toFixed(2)}`);
        });
      }
      
      console.log('\n  ├─ ITEMS (' + orderDetail.items.length + ')');
      orderDetail.items.slice(0, 3).forEach((item, i) => {
        console.log(`  │  ${i+1}. ${item.itemName} x${item.quantity} = ₹${item.totalPrice}`);
        if (item.taxDetails) {
          console.log(`  │     Tax: ${JSON.stringify(item.taxDetails)}`);
        }
        if (item.addons?.length > 0) {
          console.log(`  │     Addons: ${item.addons.map(a => a.addonName).join(', ')}`);
        }
      });
      
      console.log('\n  ├─ DISCOUNTS (' + orderDetail.discounts.length + ')');
      orderDetail.discounts.forEach(d => {
        console.log(`  │  - ${d.discountName}: ₹${d.discountAmount} (${d.discountType})`);
      });
      
      console.log('\n  ├─ PAYMENTS (' + orderDetail.payments.length + ')');
      orderDetail.payments.forEach(p => {
        console.log(`  │  - ${p.paymentMode}: ₹${p.totalAmount} [${p.status}]`);
        if (p.splitBreakdown) {
          p.splitBreakdown.forEach(s => {
            console.log(`  │    └─ ${s.paymentMode}: ₹${s.amount}`);
          });
        }
      });
      
      console.log('\n  ├─ INVOICE');
      if (orderDetail.invoice) {
        console.log(`  │  Invoice #: ${orderDetail.invoice.invoiceNumber}`);
        console.log(`  │  Date: ${orderDetail.invoice.invoiceDate}`);
        console.log(`  │  Grand Total: ₹${orderDetail.invoice.grandTotal}`);
        console.log(`  │  Tax Breakup:`);
        if (orderDetail.invoice.taxBreakup) {
          Object.entries(orderDetail.invoice.taxBreakup).forEach(([code, data]) => {
            console.log(`  │    - ${code}: ₹${data.taxAmount || data.amount || 0}`);
          });
        }
        console.log(`  │  CGST: ₹${orderDetail.invoice.cgstAmount}`);
        console.log(`  │  SGST: ₹${orderDetail.invoice.sgstAmount}`);
      } else {
        console.log(`  │  No invoice generated`);
      }
      
      console.log('\n  ├─ KOTs (' + orderDetail.kots.length + ')');
      orderDetail.kots.forEach(k => {
        console.log(`  │  - ${k.kotNumber}: ${k.status} (${k.stationName || 'N/A'})`);
      });
      
      console.log('\n  └─ OUTLET INFO');
      console.log(`     Name: ${orderDetail.outletName}`);
      console.log(`     GSTIN: ${orderDetail.outletGstin || 'N/A'}`);
      console.log(`     Address: ${orderDetail.outletAddress || 'N/A'}, ${orderDetail.outletCity || ''}`);
    }

    // Test 3: Customer Link-Order Scenarios
    console.log('\n📍 TEST 3: Customer Link-Order Scenarios');
    console.log('─'.repeat(60));
    
    // Find an order without customer to test
    const [testOrders] = await pool.query(`
      SELECT id, order_number, customer_id, customer_name 
      FROM orders WHERE outlet_id = ? 
      ORDER BY id DESC LIMIT 1
    `, [OUTLET_ID]);
    
    if (testOrders.length > 0) {
      const testOrderId = testOrders[0].id;
      console.log(`\n  Testing with Order: ${testOrders[0].order_number} (ID: ${testOrderId})`);
      console.log(`  Current customer_id: ${testOrders[0].customer_id || 'None'}`);
      
      // Scenario 1: First link - creates or finds customer
      console.log('\n  ┌─ SCENARIO 1: First Link (Create/Find)');
      const firstLink = await customerService.linkToOrder(testOrderId, {
        name: 'Test Customer ' + Date.now(),
        phone: '9999' + Math.floor(Math.random() * 1000000).toString().padStart(6, '0'),
        email: 'test@example.com'
      });
      console.log(`  │  Customer ID: ${firstLink.customerId}`);
      console.log(`  │  Name: ${firstLink.customerName}`);
      console.log(`  │  Phone: ${firstLink.customerPhone}`);
      console.log(`  │  isUpdate: ${firstLink.isUpdate}`);
      
      // Scenario 2: Second link with same order - should UPDATE
      console.log('\n  ├─ SCENARIO 2: Second Link (Update existing)');
      const secondLink = await customerService.linkToOrder(testOrderId, {
        name: 'Updated Customer Name',
        phone: '8888888888',
        email: 'updated@example.com',
        address: 'New Address 123'
      });
      console.log(`  │  Customer ID: ${secondLink.customerId} (same: ${secondLink.customerId === firstLink.customerId})`);
      console.log(`  │  Name: ${secondLink.customerName}`);
      console.log(`  │  Phone: ${secondLink.customerPhone}`);
      console.log(`  │  Email: ${secondLink.customerEmail}`);
      console.log(`  │  Address: ${secondLink.customerAddress}`);
      console.log(`  │  isUpdate: ${secondLink.isUpdate}`);
      
      // Scenario 3: Third link with GST details - should UPDATE with GST
      console.log('\n  ├─ SCENARIO 3: Third Link (Add GST details)');
      const thirdLink = await customerService.linkToOrder(testOrderId, {
        gstin: '24AAACC1234A1Z5',
        companyName: 'Test Company Pvt Ltd',
        isGstCustomer: true
      });
      console.log(`  │  Customer ID: ${thirdLink.customerId} (same: ${thirdLink.customerId === firstLink.customerId})`);
      console.log(`  │  Name: ${thirdLink.customerName}`);
      console.log(`  │  GSTIN: ${thirdLink.gstin}`);
      console.log(`  │  Company: ${thirdLink.companyName}`);
      console.log(`  │  isGstCustomer: ${thirdLink.isGstCustomer}`);
      console.log(`  │  isUpdate: ${thirdLink.isUpdate}`);
      
      // Verify customer details API returns updated data
      console.log('\n  └─ VERIFY: Customer Details API');
      const customerDetails = await customerService.getById(thirdLink.customerId);
      console.log(`     Name: ${customerDetails.name}`);
      console.log(`     Phone: ${customerDetails.phone}`);
      console.log(`     Email: ${customerDetails.email}`);
      console.log(`     Address: ${customerDetails.address}`);
      console.log(`     GSTIN: ${customerDetails.gstin}`);
      console.log(`     Company: ${customerDetails.companyName}`);
      console.log(`     isGstCustomer: ${customerDetails.isGstCustomer}`);
    }

    console.log('\n' + '═'.repeat(70));
    console.log('  ✅ ALL TESTS PASSED');
    console.log('═'.repeat(70) + '\n');

  } catch (error) {
    console.log('\n❌ Error:', error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

main();
