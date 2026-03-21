/**
 * CSV Export Utility
 * Converts report data to CSV format with proper formatting
 */

/**
 * Escape CSV field value
 * @param {any} value - Value to escape
 * @returns {string} - Escaped value
 */
function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // If contains comma, newline, or quote, wrap in quotes and escape internal quotes
  if (str.includes(',') || str.includes('\n') || str.includes('"') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format date for CSV
 * @param {string|Date} date - Date to format
 * @returns {string} - Formatted date string
 */
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString('en-IN', { 
    day: '2-digit', 
    month: '2-digit', 
    year: 'numeric' 
  });
}

/**
 * Format datetime for CSV
 * @param {string|Date} datetime - Datetime to format
 * @returns {string} - Formatted datetime string
 */
function formatDateTime(datetime) {
  if (!datetime) return '';
  const d = new Date(datetime);
  if (isNaN(d.getTime())) return String(datetime);
  return d.toLocaleString('en-IN', { 
    day: '2-digit', 
    month: '2-digit', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Format currency for CSV
 * @param {number} amount - Amount to format
 * @returns {string} - Formatted amount
 */
function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '0.00';
  return parseFloat(amount).toFixed(2);
}

/**
 * Convert array of objects to CSV string
 * @param {Array} data - Array of objects
 * @param {Array} columns - Column definitions [{key, header, format?}]
 * @param {Object} options - Options {title?, filters?, summary?}
 * @returns {string} - CSV string
 */
function toCSV(data, columns, options = {}) {
  const lines = [];
  
  // Add title if provided
  if (options.title) {
    lines.push(escapeCSV(options.title));
    lines.push('');
  }
  
  // Add filter info if provided
  if (options.filters) {
    for (const [key, value] of Object.entries(options.filters)) {
      if (value) {
        lines.push(`${escapeCSV(key)},${escapeCSV(value)}`);
      }
    }
    lines.push('');
  }
  
  // Add summary section if provided
  if (options.summary && Object.keys(options.summary).length > 0) {
    lines.push('SUMMARY');
    for (const [key, value] of Object.entries(options.summary)) {
      lines.push(`${escapeCSV(key)},${escapeCSV(value)}`);
    }
    lines.push('');
  }
  
  // Add header row
  const headers = columns.map(col => escapeCSV(col.header || col.key));
  lines.push(headers.join(','));
  
  // Add data rows
  for (const row of data) {
    const values = columns.map(col => {
      let value = row[col.key];
      
      // Apply format function if provided
      if (col.format) {
        value = col.format(value, row);
      } else if (col.type === 'date') {
        value = formatDate(value);
      } else if (col.type === 'datetime') {
        value = formatDateTime(value);
      } else if (col.type === 'currency') {
        value = formatCurrency(value);
      } else if (col.type === 'number') {
        value = value !== null && value !== undefined ? Number(value) : '';
      }
      
      return escapeCSV(value);
    });
    lines.push(values.join(','));
  }
  
  // Add totals row if provided
  if (options.totals) {
    const totalsRow = columns.map(col => {
      if (options.totals[col.key] !== undefined) {
        return escapeCSV(col.type === 'currency' ? formatCurrency(options.totals[col.key]) : options.totals[col.key]);
      }
      return '';
    });
    lines.push('');
    lines.push(totalsRow.join(','));
  }
  
  return lines.join('\r\n');
}

/**
 * Generate filename for export
 * @param {string} reportName - Name of the report
 * @param {Object} filters - Filter parameters
 * @returns {string} - Filename
 */
function generateFilename(reportName, filters = {}) {
  const parts = [reportName.replace(/\s+/g, '_').toLowerCase()];
  
  if (filters.startDate) {
    parts.push(filters.startDate);
  }
  if (filters.endDate && filters.endDate !== filters.startDate) {
    parts.push('to');
    parts.push(filters.endDate);
  }
  
  parts.push(new Date().toISOString().slice(0, 10));
  
  return `${parts.join('_')}.csv`;
}

// ============================================================
// REPORT-SPECIFIC CSV FORMATTERS
// ============================================================

/**
 * Daily Sales Report CSV
 */
function dailySalesCSV(data, filters) {
  const columns = [
    { key: 'report_date', header: 'Date', type: 'date' },
    { key: 'total_orders', header: 'Total Orders', type: 'number' },
    { key: 'dine_in_orders', header: 'Dine-In', type: 'number' },
    { key: 'takeaway_orders', header: 'Takeaway', type: 'number' },
    { key: 'delivery_orders', header: 'Delivery', type: 'number' },
    { key: 'total_guests', header: 'Guests', type: 'number' },
    { key: 'gross_sales', header: 'Gross Sales (₹)', type: 'currency' },
    { key: 'discount_amount', header: 'Discount (₹)', type: 'currency' },
    { key: 'tax_amount', header: 'Tax (₹)', type: 'currency' },
    { key: 'nc_orders', header: 'NC Orders', type: 'number' },
    { key: 'nc_amount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'due_amount', header: 'Due Amount (₹)', type: 'currency' },
    { key: 'paid_amount', header: 'Paid Amount (₹)', type: 'currency' },
    { key: 'net_sales', header: 'Net Sales (₹)', type: 'currency' },
    { key: 'total_collection', header: 'Collection (₹)', type: 'currency' },
    { key: 'cash_collection', header: 'Cash (₹)', type: 'currency' },
    { key: 'card_collection', header: 'Card (₹)', type: 'currency' },
    { key: 'upi_collection', header: 'UPI (₹)', type: 'currency' },
    { key: 'making_cost', header: 'Making Cost (₹)', type: 'currency' },
    { key: 'profit', header: 'Profit (₹)', type: 'currency' },
    { key: 'food_cost_percentage', header: 'Food Cost %', format: (v) => v ? `${parseFloat(v).toFixed(2)}%` : '0%' },
    { key: 'wastage_count', header: 'Wastage Incidents', type: 'number' },
    { key: 'wastage_cost', header: 'Wastage Cost (₹)', type: 'currency' },
    { key: 'average_order_value', header: 'Avg Order (₹)', type: 'currency' }
  ];
  
  // Extract daily array from report structure
  const rows = data.daily || data.dailyData || data.data || [];
  
  const summary = data.summary || {};
  
  return toCSV(rows, columns, {
    title: 'Daily Sales Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Orders': summary.total_orders,
      'Gross Sales': formatCurrency(summary.gross_sales),
      'Net Sales': formatCurrency(summary.net_sales),
      'Total Tax': formatCurrency(summary.tax_amount),
      'Total Discount': formatCurrency(summary.discount_amount),
      'NC Orders': summary.nc_orders || 0,
      'NC Amount': formatCurrency(summary.nc_amount),
      'Due Amount': formatCurrency(summary.due_amount),
      'Paid Amount': formatCurrency(summary.paid_amount),
      'Total Collection': formatCurrency(summary.total_collection),
      'Making Cost': formatCurrency(summary.making_cost),
      'Profit': formatCurrency(summary.profit),
      'Food Cost %': summary.food_cost_percentage ? `${summary.food_cost_percentage}%` : '0%',
      'Wastage Count': summary.wastage_count || 0,
      'Wastage Cost': formatCurrency(summary.wastage_cost)
    }
  });
}

/**
 * Daily Sales Detail CSV
 */
function dailySalesDetailCSV(data, filters) {
  const columns = [
    { key: 'orderNumber', header: 'Order No' },
    { key: 'invoiceNumber', header: 'Invoice No', format: (v, row) => row.invoice?.invoiceNumber || '' },
    { key: 'createdAt', header: 'Date/Time', type: 'datetime' },
    { key: 'orderType', header: 'Order Type' },
    { key: 'tableNumber', header: 'Table' },
    { key: 'floorName', header: 'Floor' },
    { key: 'guestCount', header: 'Guests', type: 'number' },
    { key: 'customerName', header: 'Customer' },
    { key: 'captainName', header: 'Captain' },
    { key: 'cashierName', header: 'Cashier' },
    { key: 'itemCount', header: 'Items', type: 'number', format: (v, row) => row.items?.totalCount || 0 },
    { key: 'subtotal', header: 'Subtotal (₹)', type: 'currency' },
    { key: 'discountAmount', header: 'Discount (₹)', type: 'currency' },
    { key: 'taxAmount', header: 'Tax (₹)', type: 'currency' },
    { key: 'serviceCharge', header: 'Service Charge (₹)', type: 'currency' },
    { key: 'totalAmount', header: 'Grand Total (₹)', type: 'currency' },
    { key: 'isNC', header: 'Is NC', format: (v) => v ? 'Yes' : 'No' },
    { key: 'ncAmount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'ncReason', header: 'NC Reason' },
    { key: 'paidAmount', header: 'Paid (₹)', type: 'currency' },
    { key: 'dueAmount', header: 'Due (₹)', type: 'currency' },
    { key: 'paymentStatus', header: 'Payment Status' },
    { key: 'makingCost', header: 'Making Cost (₹)', type: 'currency' },
    { key: 'profit', header: 'Profit (₹)', type: 'currency' },
    { key: 'foodCostPercentage', header: 'Food Cost %', format: (v) => v ? `${parseFloat(v).toFixed(2)}%` : '0%' },
    { key: 'status', header: 'Order Status' }
  ];
  
  const rows = data.orders || data.data || [];
  
  return toCSV(rows, columns, {
    title: 'Daily Sales Detail Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: data.summary ? {
      'Total Orders': data.summary.totalOrders,
      'Gross Sales': formatCurrency(data.summary.grossSales),
      'Net Sales': formatCurrency(data.summary.netSales),
      'NC Orders': data.summary.ncOrders || 0,
      'NC Amount': formatCurrency(data.summary.ncAmount),
      'Total Paid': formatCurrency(data.summary.totalPaid),
      'Making Cost': formatCurrency(data.summary.makingCost),
      'Profit': formatCurrency(data.summary.profit),
      'Food Cost %': data.summary.foodCostPercentage ? `${data.summary.foodCostPercentage}%` : '0%',
      'Wastage Count': data.summary.wastageCount || 0,
      'Wastage Cost': formatCurrency(data.summary.wastageCost)
    } : {}
  });
}

/**
 * Item Sales Report CSV
 */
function itemSalesCSV(data, filters) {
  const columns = [
    { key: 'rank', header: 'Rank', type: 'number' },
    { key: 'item_name', header: 'Item Name' },
    { key: 'variant_name', header: 'Variant' },
    { key: 'category_name', header: 'Category' },
    { key: 'total_quantity', header: 'Qty Sold', type: 'number' },
    { key: 'gross_revenue', header: 'Gross Revenue (₹)', type: 'currency' },
    { key: 'avg_price', header: 'Avg Price (₹)', type: 'currency' },
    { key: 'tax_amount', header: 'Tax (₹)', type: 'currency' },
    { key: 'discount_amount', header: 'Discount (₹)', type: 'currency' },
    { key: 'net_revenue', header: 'Net Revenue (₹)', type: 'currency' },
    { key: 'nc_quantity', header: 'NC Qty', type: 'number' },
    { key: 'nc_amount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'making_cost', header: 'Making Cost (₹)', type: 'currency' },
    { key: 'item_profit', header: 'Profit (₹)', type: 'currency' },
    { key: 'avg_cost_per_unit', header: 'Avg Cost/Unit (₹)', type: 'currency' },
    { key: 'order_count', header: 'Orders', type: 'number' }
  ];
  
  let rows = data.items || data.data || [];
  rows = rows.map((item, idx) => ({ ...item, rank: idx + 1 }));
  
  const summary = data.summary || {};
  
  return toCSV(rows, columns, {
    title: 'Item Sales Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Items': summary.total_items,
      'Total Quantity': summary.total_quantity,
      'Gross Revenue': formatCurrency(summary.gross_revenue),
      'Net Revenue': formatCurrency(summary.net_revenue),
      'NC Orders': summary.nc_orders || 0,
      'NC Amount': formatCurrency(summary.nc_amount),
      'Due Amount': formatCurrency(summary.due_amount),
      'Paid Amount': formatCurrency(summary.paid_amount),
      'Making Cost': formatCurrency(summary.making_cost),
      'Profit': formatCurrency(summary.profit),
      'Food Cost %': summary.food_cost_percentage ? `${summary.food_cost_percentage}%` : '0%',
      'Top Seller': summary.top_seller
    }
  });
}

/**
 * Item Sales Detail Report CSV
 */
function itemSalesDetailCSV(data, filters) {
  const columns = [
    { key: 'itemName', header: 'Item Name' },
    { key: 'variantName', header: 'Variant' },
    { key: 'categoryName', header: 'Category' },
    { key: 'stationName', header: 'Station' },
    { key: 'totalQuantity', header: 'Qty Sold', type: 'number' },
    { key: 'cancelledQuantity', header: 'Cancelled Qty', type: 'number' },
    { key: 'grossRevenue', header: 'Gross Revenue (₹)', type: 'currency' },
    { key: 'discountAmount', header: 'Discount (₹)', type: 'currency' },
    { key: 'taxAmount', header: 'Tax (₹)', type: 'currency' },
    { key: 'netRevenue', header: 'Net Revenue (₹)', type: 'currency' },
    { key: 'makingCost', header: 'Making Cost (₹)', type: 'currency' },
    { key: 'profit', header: 'Profit (₹)', type: 'currency' },
    { key: 'foodCostPercentage', header: 'Food Cost %', format: (v) => v ? `${parseFloat(v).toFixed(2)}%` : '0%' },
    { key: 'avgUnitPrice', header: 'Avg Price (₹)', type: 'currency' },
    { key: 'orderCount', header: 'Orders', type: 'number' },
    { key: 'ncCount', header: 'NC Count', type: 'number' },
    { key: 'ncAmount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'occurrenceCount', header: 'Occurrences', type: 'number' }
  ];
  
  const rows = data.items || data.data || [];
  const summary = data.summary || {};
  
  return toCSV(rows, columns, {
    title: 'Item Sales Detail Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Unique Items': summary.totalUniqueItems,
      'Total Quantity': summary.totalQuantitySold,
      'Cancelled Quantity': summary.totalCancelledQuantity,
      'Gross Revenue': formatCurrency(summary.grossRevenue),
      'Net Revenue': formatCurrency(summary.netRevenue),
      'Making Cost': formatCurrency(summary.makingCost),
      'Profit': formatCurrency(summary.profit),
      'Food Cost %': summary.foodCostPercentage ? `${summary.foodCostPercentage}%` : '0%',
      'NC Count': summary.ncCount || 0,
      'NC Amount': formatCurrency(summary.ncAmount)
    }
  });
}

/**
 * Category Sales Report CSV
 */
function categorySalesCSV(data, filters) {
  const columns = [
    { key: 'category_name', header: 'Category' },
    { key: 'category_service_type', header: 'Service Type' },
    { key: 'item_count', header: 'Unique Items', type: 'number' },
    { key: 'total_quantity', header: 'Qty Sold', type: 'number' },
    { key: 'gross_revenue', header: 'Gross Revenue (₹)', type: 'currency' },
    { key: 'discount_amount', header: 'Discount (₹)', type: 'currency' },
    { key: 'net_revenue', header: 'Net Revenue (₹)', type: 'currency' },
    { key: 'nc_quantity', header: 'NC Qty', type: 'number' },
    { key: 'nc_amount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'order_count', header: 'Orders', type: 'number' },
    { key: 'contribution_percent', header: 'Contribution %', format: (v) => v ? `${parseFloat(v).toFixed(1)}%` : '0%' }
  ];
  
  const rows = data.categories || data.data || [];
  const summary = data.summary || {};
  
  return toCSV(rows, columns, {
    title: 'Category Sales Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Categories': summary.total_categories,
      'Total Quantity': summary.total_quantity,
      'Gross Revenue': formatCurrency(summary.gross_revenue),
      'Net Revenue': formatCurrency(summary.net_revenue),
      'NC Amount': formatCurrency(summary.nc_amount),
      'Due Amount': formatCurrency(summary.due_amount),
      'Paid Amount': formatCurrency(summary.paid_amount),
      'Top Category': summary.top_category
    }
  });
}

/**
 * Staff Performance Report CSV
 */
function staffReportCSV(data, filters) {
  const columns = [
    { key: 'user_name', header: 'Staff Name' },
    { key: 'total_orders', header: 'Total Orders', type: 'number' },
    { key: 'total_guests', header: 'Guests', type: 'number' },
    { key: 'total_sales', header: 'Total Sales (₹)', type: 'currency' },
    { key: 'avg_order_value', header: 'Avg Order (₹)', type: 'currency' },
    { key: 'avg_guest_spend', header: 'Avg Guest Spend (₹)', type: 'currency' },
    { key: 'total_discounts', header: 'Discounts (₹)', type: 'currency' },
    { key: 'total_tips', header: 'Tips (₹)', type: 'currency' },
    { key: 'cancelled_orders', header: 'Cancelled Orders', type: 'number' },
    { key: 'cancelled_amount', header: 'Cancelled Amt (₹)', type: 'currency' },
    { key: 'nc_orders', header: 'NC Orders', type: 'number' },
    { key: 'nc_amount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'due_amount', header: 'Due Amount (₹)', type: 'currency' },
    { key: 'paid_amount', header: 'Paid Amount (₹)', type: 'currency' }
  ];
  
  const rows = data.staff || data.data || [];
  const summary = data.summary || {};
  
  return toCSV(rows, columns, {
    title: 'Staff Performance Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Staff': summary.total_staff,
      'Total Orders': summary.total_orders,
      'Total Sales': formatCurrency(summary.total_sales),
      'NC Orders': summary.nc_orders || 0,
      'NC Amount': formatCurrency(summary.nc_amount),
      'Due Amount': formatCurrency(summary.due_amount),
      'Paid Amount': formatCurrency(summary.paid_amount)
    }
  });
}

/**
 * Payment Mode Report CSV
 */
function paymentModeCSV(data, filters) {
  const columns = [
    { key: 'payment_mode', header: 'Payment Mode' },
    { key: 'transaction_count', header: 'Transactions', type: 'number' },
    { key: 'base_amount', header: 'Base Amount (₹)', type: 'currency' },
    { key: 'tip_amount', header: 'Tips (₹)', type: 'currency' },
    { key: 'total_amount', header: 'Total Amount (₹)', type: 'currency' },
    { key: 'percentage_share', header: 'Share %', format: (v) => v ? `${parseFloat(v).toFixed(1)}%` : '0%' }
  ];
  
  const rows = data.modes || data.paymentModes || data.data || [];
  const summary = data.summary || {};
  
  return toCSV(rows, columns, {
    title: 'Payment Mode Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Transactions': summary.total_transactions,
      'Total Amount': formatCurrency(summary.total_collected || summary.total_amount)
    }
  });
}

/**
 * Tax Report CSV
 */
function taxReportCSV(data, filters) {
  const columns = [
    { key: 'report_date', header: 'Date', type: 'date' },
    { key: 'taxable_amount', header: 'Taxable Amount (₹)', type: 'currency' },
    { key: 'cgst_amount', header: 'CGST (₹)', type: 'currency' },
    { key: 'sgst_amount', header: 'SGST (₹)', type: 'currency' },
    { key: 'igst_amount', header: 'IGST (₹)', type: 'currency' },
    { key: 'vat_amount', header: 'VAT (₹)', type: 'currency' },
    { key: 'cess_amount', header: 'Cess (₹)', type: 'currency' },
    { key: 'total_tax', header: 'Total Tax (₹)', type: 'currency' },
    { key: 'invoice_count', header: 'Invoices', type: 'number' }
  ];
  
  // Tax report has daily breakdown
  const rows = data.daily || data.taxBreakdown || data.taxes || data.data || [];
  
  // Calculate summary from daily data
  const summary = rows.reduce((acc, r) => {
    acc.totalTaxable += parseFloat(r.taxable_amount) || 0;
    acc.totalCgst += parseFloat(r.cgst_amount) || 0;
    acc.totalSgst += parseFloat(r.sgst_amount) || 0;
    acc.totalIgst += parseFloat(r.igst_amount) || 0;
    acc.totalVat += parseFloat(r.vat_amount) || 0;
    acc.totalTax += parseFloat(r.total_tax) || 0;
    return acc;
  }, { totalTaxable: 0, totalCgst: 0, totalSgst: 0, totalIgst: 0, totalVat: 0, totalTax: 0 });
  
  return toCSV(rows, columns, {
    title: 'Tax Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Taxable': formatCurrency(summary.totalTaxable),
      'Total CGST': formatCurrency(summary.totalCgst),
      'Total SGST': formatCurrency(summary.totalSgst),
      'Total IGST': formatCurrency(summary.totalIgst),
      'Total VAT': formatCurrency(summary.totalVat),
      'Total Tax': formatCurrency(summary.totalTax)
    }
  });
}

/**
 * Service Type Breakdown CSV
 */
function serviceTypeCSV(data, filters) {
  const columns = [
    { key: 'serviceType', header: 'Service Type' },
    { key: 'quantity', header: 'Quantity', type: 'number' },
    { key: 'order_count', header: 'Orders', type: 'number' },
    { key: 'unique_items', header: 'Unique Items', type: 'number' },
    { key: 'gross_revenue', header: 'Gross Revenue (₹)', type: 'currency' },
    { key: 'discount', header: 'Discount (₹)', type: 'currency' },
    { key: 'tax', header: 'Tax (₹)', type: 'currency' },
    { key: 'net_revenue', header: 'Net Revenue (₹)', type: 'currency' },
    { key: 'nc_quantity', header: 'NC Qty', type: 'number' },
    { key: 'nc_amount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'percentage', header: 'Share %', format: (v) => v ? `${parseFloat(v).toFixed(1)}%` : '0%' }
  ];
  
  // Handle breakdown object structure: { restaurant: {...}, bar: {...}, both: {...} }
  let rows = [];
  if (data.breakdown && typeof data.breakdown === 'object' && !Array.isArray(data.breakdown)) {
    // Service type name mapping
    const typeNames = {
      'restaurant': 'Restaurant',
      'bar': 'Bar',
      'both': 'Both (Shared)'
    };
    
    // Convert object to array with proper field mapping
    rows = Object.entries(data.breakdown).map(([key, val]) => ({
      serviceType: typeNames[key] || key,
      quantity: val.quantity || 0,
      order_count: val.order_count || val.orderCount || 0,
      unique_items: val.unique_items || val.uniqueItems || 0,
      gross_revenue: parseFloat(val.gross_revenue) || parseFloat(val.grossRevenue) || 0,
      discount: parseFloat(val.discount) || 0,
      tax: parseFloat(val.tax) || 0,
      net_revenue: parseFloat(val.net_revenue) || parseFloat(val.netRevenue) || 0,
      percentage: val.percentage || 0
    }));
  } else {
    rows = data.breakdown || data.serviceTypes || data.data || [];
  }
  
  const summary = data.summary || {};
  
  return toCSV(rows, columns, {
    title: 'Service Type Breakdown Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Quantity': summary.total_quantity || summary.totalQuantity || 0,
      'Total Revenue': formatCurrency(summary.total_revenue || summary.totalRevenue),
      'Restaurant Revenue': formatCurrency(summary.restaurant_revenue || summary.restaurantRevenue),
      'Bar Revenue': formatCurrency(summary.bar_revenue || summary.barRevenue),
      'Shared Revenue': formatCurrency(summary.shared_revenue || summary.sharedRevenue)
    }
  });
}

/**
 * Running Tables CSV
 */
function runningTablesCSV(data, filters) {
  const columns = [
    { key: 'tableNumber', header: 'Table No' },
    { key: 'tableName', header: 'Table Name' },
    { key: 'floorName', header: 'Floor' },
    { key: 'status', header: 'Status' },
    { key: 'captainName', header: 'Captain' },
    { key: 'guestCount', header: 'Guests', type: 'number' },
    { key: 'orderNumber', header: 'Order No' },
    { key: 'orderStartTime', header: 'Started At', type: 'datetime' },
    { key: 'runningTime', header: 'Duration' },
    { key: 'itemCount', header: 'Items', type: 'number' },
    { key: 'subtotal', header: 'Subtotal (₹)', type: 'currency' },
    { key: 'totalAmount', header: 'Total (₹)', type: 'currency' },
    { key: 'isNC', header: 'Is NC', format: (v) => v ? 'Yes' : '' },
    { key: 'ncAmount', header: 'NC Amount (₹)', type: 'currency' }
  ];
  
  // Handle floors array structure - flatten tables from all floors
  let rows = [];
  if (data.floors && Array.isArray(data.floors)) {
    for (const floor of data.floors) {
      const floorName = floor.floorName || floor.name || '';
      const tables = floor.tables || [];
      for (const table of tables) {
        rows.push({
          ...table,
          floorName: floorName,
          tableNumber: table.tableNumber || table.table_number,
          tableName: table.tableName || table.table_name,
          captainName: table.captainName || table.captain_name,
          guestCount: table.guestCount || table.guest_count,
          orderNumber: table.order?.orderNumber || table.orderNumber || table.order_number,
          orderStartTime: table.order?.startedAt || table.orderStartTime || table.started_at || table.created_at,
          runningTime: table.order?.durationFormatted || table.runningTime || table.duration,
          itemCount: table.itemCount || table.item_count,
          subtotal: table.subtotal,
          totalAmount: table.order?.totalAmount || table.totalAmount || table.total_amount,
          isNC: table.order?.isNC || false,
          ncAmount: table.order?.ncAmount || 0
        });
      }
    }
  } else {
    rows = data.tables || data.data || [];
  }
  
  const totalAmount = rows.reduce((s, t) => s + (parseFloat(t.totalAmount) || 0), 0);
  
  return toCSV(rows, columns, {
    title: 'Running Tables Report',
    filters: {
      'Outlet': filters.outletName || filters.outletId,
      'Generated At': formatDateTime(new Date())
    },
    summary: {
      'Total Running Tables': rows.length,
      'Total Running Amount': formatCurrency(totalAmount)
    }
  });
}

/**
 * Running Orders CSV
 */
function runningOrdersCSV(data, filters) {
  const columns = [
    { key: 'orderNumber', header: 'Order No' },
    { key: 'orderType', header: 'Order Type' },
    { key: 'tableNumber', header: 'Table' },
    { key: 'floorName', header: 'Floor' },
    { key: 'captainName', header: 'Captain' },
    { key: 'customerName', header: 'Customer' },
    { key: 'status', header: 'Status' },
    { key: 'createdAt', header: 'Started At', type: 'datetime' },
    { key: 'itemCount', header: 'Items', type: 'number' },
    { key: 'subtotal', header: 'Subtotal (₹)', type: 'currency' },
    { key: 'totalAmount', header: 'Total (₹)', type: 'currency' },
    { key: 'isNC', header: 'Is NC', format: (v) => v ? 'Yes' : '' },
    { key: 'ncAmount', header: 'NC Amount (₹)', type: 'currency' }
  ];
  
  const rawOrders = data.orders || data.data || data || [];
  const rows = rawOrders.map(o => ({
    ...o,
    orderNumber: o.order_number || o.orderNumber,
    orderType: o.order_type || o.orderType,
    tableNumber: o.table_number || o.tableNumber,
    floorName: o.floor_name || o.floorName,
    captainName: o.created_by_name || o.captainName,
    customerName: o.customer_name || o.customerName,
    itemCount: o.item_count || o.itemCount,
    totalAmount: parseFloat(o.total_amount || o.totalAmount) || 0,
    isNC: !!o.is_nc,
    ncAmount: parseFloat(o.nc_amount || o.ncAmount) || 0
  }));
  
  return toCSV(rows, columns, {
    title: 'Running Orders Report',
    filters: {
      'Outlet': filters.outletName || filters.outletId,
      'Generated At': formatDateTime(new Date())
    },
    summary: {
      'Total Running Orders': rows.length,
      'Total Running Amount': formatCurrency(rows.reduce((s, o) => s + (parseFloat(o.totalAmount) || 0), 0))
    }
  });
}

/**
 * Floor Section Report CSV
 */
function floorSectionCSV(data, filters) {
  const columns = [
    { key: 'floorName', header: 'Floor' },
    { key: 'sectionName', header: 'Section' },
    { key: 'orderCount', header: 'Orders', type: 'number' },
    { key: 'guestCount', header: 'Guests', type: 'number' },
    { key: 'netSales', header: 'Net Sales (₹)', type: 'currency' },
    { key: 'avgOrderValue', header: 'Avg Order (₹)', type: 'currency' },
    { key: 'cancelledOrders', header: 'Cancelled', type: 'number' },
    { key: 'ncOrders', header: 'NC Orders', type: 'number' },
    { key: 'ncAmount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'dueAmount', header: 'Due Amount (₹)', type: 'currency' },
    { key: 'paidAmount', header: 'Paid Amount (₹)', type: 'currency' }
  ];
  
  // Flatten floors with sections
  let rows = [];
  const floorsData = data.floors || [];
  for (const floor of floorsData) {
    // Add floor-level row
    rows.push({
      floorName: floor.floorName,
      sectionName: '(All Sections)',
      orderCount: floor.orderCount,
      guestCount: floor.guestCount,
      netSales: floor.netSales,
      avgOrderValue: floor.avgOrderValue,
      cancelledOrders: floor.cancelledOrders,
      ncOrders: floor.ncOrders || 0,
      ncAmount: floor.ncAmount || 0,
      dueAmount: floor.dueAmount || 0,
      paidAmount: floor.paidAmount || 0
    });
    // Add section-level rows
    if (floor.sections && Array.isArray(floor.sections)) {
      for (const section of floor.sections) {
        rows.push({
          floorName: floor.floorName,
          sectionName: section.sectionName,
          orderCount: section.orderCount,
          guestCount: section.guestCount,
          netSales: section.netSales,
          avgOrderValue: section.avgOrderValue,
          cancelledOrders: section.cancelledOrders,
          ncOrders: section.ncOrders || 0,
          ncAmount: section.ncAmount || 0,
          dueAmount: section.dueAmount || 0,
          paidAmount: section.paidAmount || 0
        });
      }
    }
  }
  
  return toCSV(rows, columns, {
    title: 'Floor/Section Sales Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: data.summary ? {
      'Total Floors': data.summary.total_floors,
      'Total Orders': data.summary.total_orders,
      'Net Sales': formatCurrency(data.summary.total_sales),
      'NC Amount': formatCurrency(data.summary.nc_amount),
      'Due Amount': formatCurrency(data.summary.due_amount),
      'Paid Amount': formatCurrency(data.summary.paid_amount)
    } : {}
  });
}

/**
 * Counter Sales Report CSV
 */
function counterSalesCSV(data, filters) {
  const columns = [
    { key: 'stationName', header: 'Station' },
    { key: 'stationType', header: 'Type' },
    { key: 'ticketCount', header: 'Tickets', type: 'number' },
    { key: 'itemCount', header: 'Items', type: 'number' },
    { key: 'totalQuantity', header: 'Total Qty', type: 'number' },
    { key: 'avgPrepTimeMins', header: 'Avg Prep Time (min)' },
    { key: 'servedCount', header: 'Served', type: 'number' },
    { key: 'cancelledCount', header: 'Cancelled', type: 'number' }
  ];
  
  const rows = data.stations || data.counters || data.data || [];
  const summary = data.summary || {};
  
  return toCSV(rows, columns, {
    title: 'Station/Counter Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Stations': summary.total_stations,
      'Total Tickets': summary.total_tickets,
      'Total Items': summary.total_items
    }
  });
}

/**
 * Cancellation Report CSV
 */
function cancellationCSV(data, filters) {
  const columns = [
    { key: 'cancelled_at', header: 'Date/Time', type: 'datetime' },
    { key: 'order_number', header: 'Order No' },
    { key: 'order_type', header: 'Order Type' },
    { key: 'cancel_type', header: 'Cancel Type' },
    { key: 'item_name', header: 'Item' },
    { key: 'qty', header: 'Qty' },
    { key: 'amount', header: 'Amount (₹)', type: 'currency' },
    { key: 'reason', header: 'Reason' },
    { key: 'cancelled_by_name', header: 'Cancelled By' },
    { key: 'captain_name', header: 'Captain' },
    { key: 'floor_name', header: 'Floor' },
    { key: 'table_number', header: 'Table' }
  ];
  
  // Combine order and item cancellations
  let rows = [];
  
  // Add order cancellations
  if (data.order_cancellations && Array.isArray(data.order_cancellations)) {
    for (const c of data.order_cancellations) {
      rows.push({
        cancelled_at: c.cancelled_at,
        order_number: c.order_number,
        order_type: c.order_type,
        cancel_type: 'Full Order',
        item_name: '-',
        qty: '-',
        amount: parseFloat(c.total_amount) || 0,
        reason: c.reason,
        cancelled_by_name: c.cancelled_by_name,
        captain_name: c.captain_name,
        floor_name: c.floor_name,
        table_number: c.table_number
      });
    }
  }
  
  // Add item cancellations
  if (data.item_cancellations && Array.isArray(data.item_cancellations)) {
    for (const c of data.item_cancellations) {
      rows.push({
        cancelled_at: c.cancelled_at,
        order_number: c.order_number,
        order_type: c.order_type,
        cancel_type: 'Item',
        item_name: c.item_name + (c.variant_name ? ` (${c.variant_name})` : ''),
        qty: parseFloat(c.cancelled_quantity) || 0,
        amount: parseFloat(c.cancelled_amount) || 0,
        reason: c.reason,
        cancelled_by_name: c.cancelled_by_name,
        captain_name: c.captain_name,
        floor_name: c.floor_name,
        table_number: c.table_number
      });
    }
  }
  
  // Fallback to simple array
  if (rows.length === 0) {
    rows = data.cancellations || data.data || [];
  }
  
  const summary = data.summary || {};
  
  return toCSV(rows, columns, {
    title: 'Cancellation Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Order Cancellations': summary.total_order_cancellations || summary.orderCancellations || 0,
      'Item Cancellations': summary.total_item_cancellations || summary.itemCancellations || 0,
      'Total Cancellations': summary.total_cancellations || 0,
      'Order Cancel Amount': formatCurrency(summary.total_order_cancel_amount),
      'Item Cancel Amount': formatCurrency(summary.total_item_cancel_amount),
      'Total Cancel Amount': formatCurrency(summary.total_cancel_amount || summary.totalAmount)
    }
  });
}

/**
 * Shift History Report CSV
 */
function shiftHistoryCSV(data, filters) {
  const columns = [
    { key: 'id', header: 'Shift ID', type: 'number' },
    { key: 'sessionDate', header: 'Date', type: 'date' },
    { key: 'openingTime', header: 'Opening Time', type: 'datetime' },
    { key: 'closingTime', header: 'Closing Time', type: 'datetime' },
    { key: 'cashierName', header: 'Cashier' },
    { key: 'floorName', header: 'Floor' },
    { key: 'status', header: 'Status' },
    { key: 'openingCash', header: 'Opening Cash (₹)', type: 'currency' },
    { key: 'totalSales', header: 'Total Sales (₹)', type: 'currency' },
    { key: 'totalCashSales', header: 'Cash Sales (₹)', type: 'currency' },
    { key: 'totalCardSales', header: 'Card Sales (₹)', type: 'currency' },
    { key: 'totalUpiSales', header: 'UPI Sales (₹)', type: 'currency' },
    { key: 'expectedCash', header: 'Expected Cash (₹)', type: 'currency' },
    { key: 'closingCash', header: 'Closing Cash (₹)', type: 'currency' },
    { key: 'cashVariance', header: 'Variance (₹)', type: 'currency' },
    { key: 'totalOrders', header: 'Orders', type: 'number' },
    { key: 'totalDiscounts', header: 'Discounts (₹)', type: 'currency' },
    { key: 'totalRefunds', header: 'Refunds (₹)', type: 'currency' },
    { key: 'ncOrders', header: 'NC Orders', type: 'number' },
    { key: 'ncAmount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'makingCost', header: 'Making Cost (₹)', type: 'currency' },
    { key: 'profit', header: 'Profit (₹)', type: 'currency' },
    { key: 'foodCostPercentage', header: 'Food Cost %', format: (v) => v ? `${parseFloat(v).toFixed(2)}%` : '0%' },
    { key: 'wastageCount', header: 'Wastage Incidents', type: 'number' },
    { key: 'wastageCost', header: 'Wastage Cost (₹)', type: 'currency' },
    { key: 'openedByName', header: 'Opened By' },
    { key: 'closedByName', header: 'Closed By' }
  ];
  
  const rows = data.shifts || data.data || [];
  
  // Calculate summary
  const summary = rows.reduce((acc, s) => {
    acc.totalSales += parseFloat(s.totalSales) || 0;
    acc.totalCash += parseFloat(s.totalCashSales) || 0;
    acc.totalCard += parseFloat(s.totalCardSales) || 0;
    acc.totalUpi += parseFloat(s.totalUpiSales) || 0;
    acc.totalVariance += parseFloat(s.cashVariance) || 0;
    acc.ncOrders += parseInt(s.ncOrders) || 0;
    acc.ncAmount += parseFloat(s.ncAmount) || 0;
    acc.makingCost += parseFloat(s.makingCost) || 0;
    acc.profit += parseFloat(s.profit) || 0;
    acc.wastageCount += parseInt(s.wastageCount) || 0;
    acc.wastageCost += parseFloat(s.wastageCost) || 0;
    return acc;
  }, { totalSales: 0, totalCash: 0, totalCard: 0, totalUpi: 0, totalVariance: 0, ncOrders: 0, ncAmount: 0, makingCost: 0, profit: 0, wastageCount: 0, wastageCost: 0 });
  
  return toCSV(rows, columns, {
    title: 'Shift History Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Shifts': rows.length,
      'Total Sales': formatCurrency(summary.totalSales),
      'Total Cash': formatCurrency(summary.totalCash),
      'Total Card': formatCurrency(summary.totalCard),
      'Total UPI': formatCurrency(summary.totalUpi),
      'Total Variance': formatCurrency(summary.totalVariance),
      'Total NC Orders': summary.ncOrders,
      'Total NC Amount': formatCurrency(summary.ncAmount),
      'Making Cost': formatCurrency(summary.makingCost),
      'Profit': formatCurrency(summary.profit),
      'Food Cost %': summary.totalSales > 0 ? `${((summary.makingCost / summary.totalSales) * 100).toFixed(2)}%` : '0%',
      'Wastage Count': summary.wastageCount || 0,
      'Wastage Cost': formatCurrency(summary.wastageCost)
    }
  });
}

/**
 * Shift Detail Report CSV
 */
function shiftDetailCSV(data, filters) {
  const lines = [];
  
  // Header
  lines.push('Shift Detail Report');
  lines.push('');
  
  // Shift Info
  lines.push('SHIFT INFORMATION');
  lines.push(`Shift ID,${data.id}`);
  lines.push(`Date,${formatDate(data.sessionDate)}`);
  lines.push(`Cashier,${escapeCSV(data.cashierName || '')}`);
  lines.push(`Floor,${escapeCSV(data.floorName || '')}`);
  lines.push(`Status,${data.status || ''}`);
  lines.push(`Opening Time,${formatDateTime(data.openingTime)}`);
  lines.push(`Closing Time,${data.closingTime ? formatDateTime(data.closingTime) : 'Still Open'}`);
  lines.push('');
  
  // Cash Summary
  lines.push('CASH SUMMARY');
  lines.push(`Opening Cash,${formatCurrency(data.openingCash)}`);
  lines.push(`Total Sales,${formatCurrency(data.totalSales)}`);
  lines.push(`Cash Sales,${formatCurrency(data.totalCashSales)}`);
  lines.push(`Card Sales,${formatCurrency(data.totalCardSales)}`);
  lines.push(`UPI Sales,${formatCurrency(data.totalUpiSales)}`);
  lines.push(`Other Sales,${formatCurrency(data.totalOtherSales)}`);
  lines.push(`Expected Cash,${formatCurrency(data.expectedCash)}`);
  lines.push(`Closing Cash,${formatCurrency(data.closingCash)}`);
  lines.push(`Cash Variance,${formatCurrency(data.cashVariance)}`);
  lines.push('');
  
  // Order Stats
  if (data.orderStats) {
    lines.push('ORDER STATISTICS');
    lines.push(`Total Orders,${data.orderStats.totalOrders || 0}`);
    lines.push(`Completed Orders,${data.orderStats.completedOrders || 0}`);
    lines.push(`Cancelled Orders,${data.orderStats.cancelledOrders || 0}`);
    lines.push(`Dine-In Orders,${data.orderStats.dineInOrders || 0}`);
    lines.push(`Takeaway Orders,${data.orderStats.takeawayOrders || 0}`);
    lines.push(`Delivery Orders,${data.orderStats.deliveryOrders || 0}`);
    lines.push(`NC Orders,${data.orderStats.ncOrders || 0}`);
    lines.push(`NC Amount,${formatCurrency(data.orderStats.ncAmount)}`);
    lines.push('');
  }
  
  // Payment Breakdown
  if (data.paymentBreakdown && data.paymentBreakdown.length > 0) {
    lines.push('PAYMENT BREAKDOWN');
    lines.push('Payment Mode,Transactions,Amount (₹)');
    for (const p of data.paymentBreakdown) {
      lines.push(`${escapeCSV(p.mode || '')},${p.count || 0},${formatCurrency(p.total)}`);
    }
    lines.push('');
  }
  
  // Transactions
  if (data.transactions && data.transactions.length > 0) {
    lines.push('TRANSACTIONS');
    lines.push('Time,Type,Amount (₹),Description,User');
    for (const t of data.transactions) {
      lines.push(`${formatDateTime(t.createdAt)},${escapeCSV(t.type || '')},${formatCurrency(t.amount)},${escapeCSV(t.description || '')},${escapeCSV(t.userName || '')}`);
    }
    lines.push('');
  }
  
  // Orders
  if (data.orders && data.orders.length > 0) {
    lines.push('ORDERS IN THIS SHIFT');
    lines.push('Order No,Time,Type,Table,Items,Subtotal (₹),Tax (₹),Total (₹),Is NC,NC Amount (₹),Paid (₹),Due (₹),Status,Payment');
    for (const o of data.orders) {
      lines.push(`${escapeCSV(o.orderNumber || '')},${formatDateTime(o.createdAt)},${escapeCSV(o.orderType || '')},${escapeCSV(o.tableNumber || '')},${(o.items || []).length},${formatCurrency(o.subtotal)},${formatCurrency(o.taxAmount)},${formatCurrency(o.totalAmount)},${o.isNC ? 'Yes' : 'No'},${formatCurrency(o.ncAmount)},${formatCurrency(o.paidAmount)},${formatCurrency(o.dueAmount)},${escapeCSV(o.status || '')},${escapeCSV(o.paymentMode || '')}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Day End Summary Report CSV
 */
function dayEndSummaryCSV(data, filters) {
  const columns = [
    { key: 'date', header: 'Date', type: 'date' },
    { key: 'totalOrders', header: 'Total Orders', type: 'number' },
    { key: 'completedOrders', header: 'Completed', type: 'number' },
    { key: 'cancelledOrders', header: 'Cancelled', type: 'number' },
    { key: 'dineIn', header: 'Dine-In', type: 'number', format: (v, row) => row.ordersByType?.dineIn || 0 },
    { key: 'takeaway', header: 'Takeaway', type: 'number', format: (v, row) => row.ordersByType?.takeaway || 0 },
    { key: 'delivery', header: 'Delivery', type: 'number', format: (v, row) => row.ordersByType?.delivery || 0 },
    { key: 'totalGuests', header: 'Guests', type: 'number' },
    { key: 'grossSales', header: 'Gross Sales (₹)', type: 'currency' },
    { key: 'totalDiscount', header: 'Discount (₹)', type: 'currency' },
    { key: 'totalTax', header: 'Tax (₹)', type: 'currency' },
    { key: 'ncOrders', header: 'NC Orders', type: 'number' },
    { key: 'ncAmount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'totalSales', header: 'Net Sales (₹)', type: 'currency' },
    { key: 'makingCost', header: 'Making Cost (₹)', type: 'currency' },
    { key: 'profit', header: 'Profit (₹)', type: 'currency' },
    { key: 'foodCostPercentage', header: 'Food Cost %', format: (v) => v ? `${parseFloat(v).toFixed(2)}%` : '0%' },
    { key: 'wastageCount', header: 'Wastage Incidents', type: 'number' },
    { key: 'wastageCost', header: 'Wastage Cost (₹)', type: 'currency' },
    { key: 'avgOrderValue', header: 'Avg Order (₹)', type: 'currency' },
    { key: 'cashPayment', header: 'Cash (₹)', type: 'currency', format: (v, row) => row.payments?.cash || 0 },
    { key: 'cardPayment', header: 'Card (₹)', type: 'currency', format: (v, row) => row.payments?.card || 0 },
    { key: 'upiPayment', header: 'UPI (₹)', type: 'currency', format: (v, row) => row.payments?.upi || 0 }
  ];
  
  const rows = data.days || data.data || [];
  const grandTotal = data.grandTotal || {};
  
  return toCSV(rows, columns, {
    title: 'Day End Summary Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Days': data.dayCount || rows.length,
      'Total Orders': grandTotal.totalOrders,
      'Gross Sales': formatCurrency(grandTotal.grossSales),
      'Net Sales': formatCurrency(grandTotal.totalSales),
      'Total Discount': formatCurrency(grandTotal.totalDiscount),
      'Total Tax': formatCurrency(grandTotal.totalTax),
      'NC Orders': grandTotal.ncOrders || 0,
      'NC Amount': formatCurrency(grandTotal.ncAmount),
      'Making Cost': formatCurrency(grandTotal.makingCost),
      'Profit': formatCurrency(grandTotal.profit),
      'Food Cost %': grandTotal.foodCostPercentage ? `${grandTotal.foodCostPercentage}%` : '0%',
      'Wastage Count': grandTotal.wastageCount || 0,
      'Wastage Cost': formatCurrency(grandTotal.wastageCost)
    }
  });
}

/**
 * Day End Summary Detail Report CSV
 */
function dayEndSummaryDetailCSV(data, filters) {
  const lines = [];
  
  // Header
  lines.push('Day End Summary Detail Report');
  lines.push('');
  lines.push(`Date,${formatDate(data.date)}`);
  lines.push(`Outlet,${filters.outletName || filters.outletId || ''}`);
  lines.push('');
  
  // Summary Section
  const summary = data.summary || {};
  lines.push('SUMMARY');
  lines.push(`Total Orders,${summary.totalOrders || 0}`);
  lines.push(`Completed Orders,${summary.completedOrders || 0}`);
  lines.push(`Cancelled Orders,${summary.cancelledOrders || 0}`);
  lines.push(`Dine-In Orders,${summary.ordersByType?.dineIn || 0}`);
  lines.push(`Takeaway Orders,${summary.ordersByType?.takeaway || 0}`);
  lines.push(`Delivery Orders,${summary.ordersByType?.delivery || 0}`);
  lines.push(`Total Guests,${summary.totalGuests || 0}`);
  lines.push(`Gross Sales,${formatCurrency(summary.grossSales)}`);
  lines.push(`Total Discount,${formatCurrency(summary.totalDiscount)}`);
  lines.push(`Total Tax,${formatCurrency(summary.totalTax)}`);
  lines.push(`NC Orders,${summary.ncOrders || 0}`);
  lines.push(`NC Amount,${formatCurrency(summary.ncAmount)}`);
  lines.push(`Net Sales,${formatCurrency(summary.netSales || summary.totalSales)}`);
  lines.push(`Making Cost,${formatCurrency(summary.makingCost)}`);
  lines.push(`Profit,${formatCurrency(summary.profit)}`);
  lines.push(`Food Cost %,${summary.foodCostPercentage ? summary.foodCostPercentage + '%' : '0%'}`);
  lines.push(`Wastage Count,${summary.wastageCount || 0}`);
  lines.push(`Wastage Cost,${formatCurrency(summary.wastageCost)}`);
  lines.push(`Avg Order Value,${formatCurrency(summary.avgOrderValue)}`);
  lines.push('');
  
  // Payment Breakdown
  if (data.paymentBreakdown) {
    lines.push('PAYMENT BREAKDOWN');
    lines.push('Payment Mode,Transactions,Amount (₹)');
    for (const [mode, info] of Object.entries(data.paymentBreakdown)) {
      if (typeof info === 'object') {
        lines.push(`${escapeCSV(mode)},${info.count || 0},${formatCurrency(info.amount)}`);
      }
    }
    lines.push('');
  }
  
  // Hourly Breakdown
  if (data.hourlyBreakdown && data.hourlyBreakdown.length > 0) {
    lines.push('HOURLY BREAKDOWN');
    lines.push('Time Slot,Orders,Sales (₹),Guests');
    for (const h of data.hourlyBreakdown) {
      lines.push(`${escapeCSV(h.timeSlot || '')},${h.orderCount || 0},${formatCurrency(h.sales)},${h.guests || 0}`);
    }
    lines.push('');
  }
  
  // Category Breakdown
  if (data.categoryBreakdown && data.categoryBreakdown.length > 0) {
    lines.push('CATEGORY BREAKDOWN');
    lines.push('Category,Items Sold,Total Qty,Sales (₹)');
    for (const c of data.categoryBreakdown) {
      lines.push(`${escapeCSV(c.categoryName || '')},${c.itemsSold || 0},${c.totalQuantity || 0},${formatCurrency(c.totalSales)}`);
    }
    lines.push('');
  }
  
  // Top Selling Items
  if (data.topSellingItems && data.topSellingItems.length > 0) {
    lines.push('TOP SELLING ITEMS');
    lines.push('Item,Category,Qty Sold,Sales (₹),Orders');
    for (const item of data.topSellingItems) {
      lines.push(`${escapeCSV(item.itemName || '')},${escapeCSV(item.categoryName || '')},${item.quantitySold || 0},${formatCurrency(item.totalSales)},${item.orderCount || 0}`);
    }
    lines.push('');
  }
  
  // Staff Performance
  if (data.staffPerformance && data.staffPerformance.length > 0) {
    lines.push('STAFF PERFORMANCE');
    lines.push('Staff Name,Role,Orders,Sales (₹)');
    for (const s of data.staffPerformance) {
      lines.push(`${escapeCSV(s.userName || s.staffName || '')},${escapeCSV(s.role || '')},${s.orderCount || s.totalOrders || 0},${formatCurrency(s.totalSales)}`);
    }
    lines.push('');
  }
  
  // Floor Breakdown
  if (data.floorBreakdown && data.floorBreakdown.length > 0) {
    lines.push('FLOOR BREAKDOWN');
    lines.push('Floor,Orders,Sales (₹),Guests');
    for (const f of data.floorBreakdown) {
      lines.push(`${escapeCSV(f.floorName || '')},${f.orderCount || 0},${formatCurrency(f.totalSales)},${f.guestCount || 0}`);
    }
    lines.push('');
  }
  
  // Discounts Applied
  if (data.discountsApplied && data.discountsApplied.length > 0) {
    lines.push('DISCOUNTS APPLIED');
    lines.push('Discount Name,Type,Times Used,Total Amount (₹)');
    for (const d of data.discountsApplied) {
      lines.push(`${escapeCSV(d.discountName || '')},${escapeCSV(d.discountType || '')},${d.usageCount || 0},${formatCurrency(d.totalAmount)}`);
    }
    lines.push('');
  }
  
  // Cancelled Orders
  if (data.cancelledOrders && data.cancelledOrders.length > 0) {
    lines.push('CANCELLED ORDERS');
    lines.push('Order No,Time,Amount (₹),Reason,Cancelled By');
    for (const o of data.cancelledOrders) {
      lines.push(`${escapeCSV(o.orderNumber || '')},${formatDateTime(o.cancelledAt)},${formatCurrency(o.totalAmount)},${escapeCSV(o.cancelReason || '')},${escapeCSV(o.cancelledByName || '')}`);
    }
    lines.push('');
  }
  
  // Order List
  if (data.orders && data.orders.length > 0) {
    lines.push('ALL ORDERS');
    lines.push('Order No,Time,Type,Table,Subtotal (₹),Tax (₹),Total (₹),Is NC,NC Amount (₹),Paid (₹),Due (₹),Status,Payment');
    for (const o of data.orders) {
      lines.push(`${escapeCSV(o.orderNumber || '')},${formatDateTime(o.createdAt)},${escapeCSV(o.orderType || '')},${escapeCSV(o.tableNumber || '')},${formatCurrency(o.subtotal)},${formatCurrency(o.taxAmount)},${formatCurrency(o.totalAmount)},${o.isNC ? 'Yes' : 'No'},${formatCurrency(o.ncAmount)},${formatCurrency(o.paidAmount)},${formatCurrency(o.dueAmount)},${escapeCSV(o.status || '')},${escapeCSV(o.paymentMode || '')}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Admin Order List CSV Export - Comprehensive order data
 */
function adminOrderListCSV(data, filters) {
  const lines = [];
  
  // Header
  lines.push('Orders List Export');
  lines.push('');
  if (filters.startDate) lines.push(`Start Date,${filters.startDate}`);
  if (filters.endDate) lines.push(`End Date,${filters.endDate}`);
  if (filters.outletId) lines.push(`Outlet ID,${filters.outletId}`);
  lines.push(`Generated,${formatDateTime(new Date())}`);
  lines.push('');
  
  // Summary
  const summary = data.summary || {};
  lines.push('SUMMARY');
  lines.push(`Total Orders,${summary.totalOrders || 0}`);
  lines.push(`Dine-In Orders,${summary.dineInCount || 0}`);
  lines.push(`Takeaway Orders,${summary.takeawayCount || 0}`);
  lines.push(`Delivery Orders,${summary.deliveryCount || 0}`);
  lines.push(`Cancelled Orders,${summary.cancelledCount || 0}`);
  lines.push(`Total Subtotal,${formatCurrency(summary.totalSubtotal)}`);
  lines.push(`Total Discount,${formatCurrency(summary.totalDiscount)}`);
  lines.push(`Total Tax,${formatCurrency(summary.totalTax)}`);
  lines.push(`Total Amount,${formatCurrency(summary.totalAmount)}`);
  lines.push(`Total Paid,${formatCurrency(summary.totalPaid)}`);
  lines.push(`Total Due,${formatCurrency(summary.totalDue || 0)}`);
  lines.push(`NC Orders,${summary.ncCount || 0}`);
  lines.push(`NC Amount,${formatCurrency(summary.ncAmount || 0)}`);
  lines.push('');
  
  // Orders data with all fields
  const orders = data.orders || [];
  if (orders.length > 0) {
    lines.push('ORDER DETAILS');
    // Header row with all possible columns
    lines.push([
      'Order No',
      'Date',
      'Time',
      'Outlet',
      'Order Type',
      'Status',
      'Payment Status',
      'Table No',
      'Floor',
      'Section',
      'Customer Name',
      'Customer Phone',
      'Guests',
      'Items',
      'Items Summary',
      'Subtotal (₹)',
      'Discount (₹)',
      'Discount Details',
      'Tax (₹)',
      'Service Charge (₹)',
      'Packaging (₹)',
      'Delivery (₹)',
      'Round Off (₹)',
      'Total Amount (₹)',
      'Paid Amount (₹)',
      'Due Amount (₹)',
      'Payment Modes',
      'Split Breakdown',
      'Invoice No',
      'Captain',
      'Cashier',
      'Source',
      'External Order ID',
      'Special Instructions',
      'Is NC',
      'NC Amount (₹)',
      'NC Reason'
    ].join(','));
    
    // Data rows
    for (const o of orders) {
      const orderDate = o.createdAt ? new Date(o.createdAt) : null;
      lines.push([
        escapeCSV(o.orderNumber || ''),
        orderDate ? formatDate(orderDate) : '',
        orderDate ? orderDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '',
        escapeCSV(o.outletName || ''),
        escapeCSV(o.orderType || ''),
        escapeCSV(o.status || ''),
        escapeCSV(o.paymentStatus || ''),
        escapeCSV(o.tableNumber || ''),
        escapeCSV(o.floorName || ''),
        escapeCSV(o.sectionName || ''),
        escapeCSV(o.customerName || ''),
        escapeCSV(o.customerPhone || ''),
        o.guestCount || '',
        o.itemCount || 0,
        escapeCSV(o.itemsSummary || ''),
        formatCurrency(o.subtotal),
        formatCurrency(o.discountAmount),
        escapeCSV(o.discountDetails || ''),
        formatCurrency(o.taxAmount),
        formatCurrency(o.serviceCharge),
        formatCurrency(o.packagingCharge),
        formatCurrency(o.deliveryCharge),
        formatCurrency(o.roundOff),
        formatCurrency(o.totalAmount),
        formatCurrency(o.totalPaid || o.paidAmount),
        formatCurrency(o.dueAmount || 0),
        escapeCSV(o.paymentModes || ''),
        escapeCSV(o.splitBreakdown || ''),
        escapeCSV(o.invoiceNumber || ''),
        escapeCSV(o.captainName || ''),
        escapeCSV(o.cashierName || ''),
        escapeCSV(o.source || 'pos'),
        escapeCSV(o.externalOrderId || ''),
        escapeCSV(o.specialInstructions || ''),
        o.isNC ? 'Yes' : 'No',
        formatCurrency(o.ncAmount || 0),
        escapeCSV(o.ncReason || '')
      ].join(','));
    }
  }
  
  return lines.join('\n');
}

/**
 * Due Report CSV Export
 */
function dueReportCSV(data) {
  const lines = [];
  
  // Header
  lines.push('Due Report Export');
  lines.push(`Generated,${formatDateTime(new Date())}`);
  lines.push('');
  
  // Summary
  const summary = data.summary || {};
  lines.push('SUMMARY');
  lines.push(`Total Customers with Due,${summary.totalCustomersWithDue || 0}`);
  lines.push(`Total Outstanding Due,${formatCurrency(summary.totalOutstandingDue)}`);
  lines.push(`Total Collected,${formatCurrency(summary.totalCollected)}`);
  lines.push('');
  
  // Customer data
  const customers = data.customers || [];
  if (customers.length > 0) {
    lines.push('CUSTOMER DUE DETAILS');
    lines.push([
      'Customer ID',
      'Name',
      'Phone',
      'Email',
      'Due Balance (₹)',
      'Total Due Collected (₹)',
      'Total Orders',
      'Total Spent (₹)',
      'Pending Due Orders',
      'Last Due Date',
      'Pending Orders Summary',
      'Customer Since'
    ].join(','));
    
    for (const c of customers) {
      const lastDueDate = c.lastDueDate ? formatDate(new Date(c.lastDueDate)) : '';
      const createdAt = c.createdAt ? formatDate(new Date(c.createdAt)) : '';
      lines.push([
        c.id,
        escapeCSV(c.name || ''),
        escapeCSV(c.phone || ''),
        escapeCSV(c.email || ''),
        formatCurrency(c.dueBalance),
        formatCurrency(c.totalDueCollected),
        c.totalOrders || 0,
        formatCurrency(c.totalSpent),
        c.totalDueOrders || 0,
        lastDueDate,
        escapeCSV(c.pendingOrdersSummary || ''),
        createdAt
      ].join(','));
    }
  }
  
  return lines.join('\n');
}

/**
 * Biller-Wise Report CSV
 */
function billerWiseCSV(data, filters) {
  const columns = [
    { key: 'billerName', header: 'Biller Name' },
    { key: 'totalBills', header: 'Total Bills', type: 'number' },
    { key: 'totalPax', header: 'Total Pax', type: 'number' },
    { key: 'totalSales', header: 'Total Sales (₹)', type: 'currency' },
    { key: 'totalDiscount', header: 'Discount (₹)', type: 'currency' },
    { key: 'totalTax', header: 'Tax (₹)', type: 'currency' },
    { key: 'totalServiceCharge', header: 'Service Charge (₹)', type: 'currency' },
    { key: 'avgBillValue', header: 'Avg Bill (₹)', type: 'currency' },
    { key: 'paxPerBill', header: 'Pax/Bill' },
    { key: 'cancelledBills', header: 'Cancelled', type: 'number' },
    { key: 'ncOrders', header: 'NC Orders', type: 'number' },
    { key: 'ncAmount', header: 'NC Amount (₹)', type: 'currency' },
    { key: 'dueAmount', header: 'Due Amount (₹)', type: 'currency' },
    { key: 'paidAmount', header: 'Paid Amount (₹)', type: 'currency' }
  ];

  const rows = data.billers || data.data || [];
  const grandTotal = data.grandTotal || {};

  return toCSV(rows, columns, {
    title: 'Biller-Wise Sales Report',
    filters: {
      'Start Date': filters.startDate,
      'End Date': filters.endDate,
      'Outlet': filters.outletName || filters.outletId
    },
    summary: {
      'Total Billers': data.billerCount || rows.length,
      'Total Bills': grandTotal.totalBills || 0,
      'Total Pax': grandTotal.totalPax || 0,
      'Total Sales': formatCurrency(grandTotal.totalSales),
      'Total Discount': formatCurrency(grandTotal.totalDiscount),
      'NC Orders': grandTotal.ncOrders || 0,
      'NC Amount': formatCurrency(grandTotal.ncAmount),
      'Due Amount': formatCurrency(grandTotal.dueAmount),
      'Paid Amount': formatCurrency(grandTotal.paidAmount)
    }
  });
}

/**
 * NC (No Charge) Report CSV
 */
function ncReportCSV(data, filters) {
  const lines = [];

  // Header
  lines.push('NC (No Charge) Report');
  lines.push('');
  if (filters.startDate) lines.push(`Start Date,${filters.startDate}`);
  if (filters.endDate) lines.push(`End Date,${filters.endDate}`);
  if (filters.outletId) lines.push(`Outlet ID,${filters.outletId}`);
  lines.push(`Generated,${formatDateTime(new Date())}`);
  lines.push('');

  // Summary
  const summary = data.summary || {};
  lines.push('SUMMARY');
  lines.push(`Total Order-Level NC,${summary.totalOrderNC || 0}`);
  lines.push(`Order NC Amount,${formatCurrency(summary.orderNCAmount)}`);
  lines.push(`Total Item-Level NC,${summary.totalItemNC || 0}`);
  lines.push(`Item NC Amount,${formatCurrency(summary.itemNCAmount)}`);
  lines.push(`Total NC Amount,${formatCurrency(summary.totalNCAmount)}`);
  lines.push(`Total NC Entries,${summary.totalNCEntries || 0}`);
  lines.push('');

  // Order-Level NC
  const orderNC = (data.orderNC && data.orderNC.data) || [];
  if (orderNC.length > 0) {
    lines.push('ORDER-LEVEL NC (Whole Order Marked NC)');
    lines.push('Order No,Order Type,Status,Subtotal (₹),Tax (₹),Discount (₹),Total Amount (₹),NC Amount (₹),NC Reason,NC Approved By,NC At,Floor,Table,Captain,Created At');
    for (const o of orderNC) {
      lines.push([
        escapeCSV(o.orderNumber || ''),
        escapeCSV(o.orderType || ''),
        escapeCSV(o.status || ''),
        formatCurrency(o.subtotal),
        formatCurrency(o.taxAmount),
        formatCurrency(o.discountAmount),
        formatCurrency(o.totalAmount),
        formatCurrency(o.ncAmount),
        escapeCSV(o.ncReason || ''),
        escapeCSV(o.ncApprovedBy || ''),
        o.ncAt ? formatDateTime(o.ncAt) : '',
        escapeCSV(o.floorName || ''),
        escapeCSV(o.tableNumber || ''),
        escapeCSV(o.captainName || ''),
        o.createdAt ? formatDateTime(o.createdAt) : ''
      ].join(','));
    }
    lines.push('');
  }

  // Item-Level NC
  const itemNC = (data.itemNC && data.itemNC.data) || [];
  if (itemNC.length > 0) {
    lines.push('ITEM-LEVEL NC (Individual Items Marked NC)');
    lines.push('Order No,Item Name,Variant,Qty,Unit Price (₹),Total Price (₹),NC Amount (₹),NC Reason,NC By,NC At,Order Type,Order Status,Floor,Table,Captain');
    for (const i of itemNC) {
      lines.push([
        escapeCSV(i.orderNumber || ''),
        escapeCSV(i.itemName || ''),
        escapeCSV(i.variantName || ''),
        i.quantity || 0,
        formatCurrency(i.unitPrice),
        formatCurrency(i.totalPrice),
        formatCurrency(i.ncAmount),
        escapeCSV(i.ncReason || ''),
        escapeCSV(i.ncBy || ''),
        i.ncAt ? formatDateTime(i.ncAt) : '',
        escapeCSV(i.orderType || ''),
        escapeCSV(i.orderStatus || ''),
        escapeCSV(i.floorName || ''),
        escapeCSV(i.tableNumber || ''),
        escapeCSV(i.captainName || '')
      ].join(','));
    }
    lines.push('');
  }

  // By Reason Breakdown
  const byReason = (data.breakdowns && data.breakdowns.byReason) || [];
  if (byReason.length > 0) {
    lines.push('NC BY REASON');
    lines.push('Reason,Count,Total Amount (₹),Type');
    for (const r of byReason) {
      lines.push(`${escapeCSV(r.reason || '')},${r.count || 0},${formatCurrency(r.totalAmount)},${escapeCSV(r.type || '')}`);
    }
    lines.push('');
  }

  // By Staff Breakdown
  const byStaff = (data.breakdowns && data.breakdowns.byStaff) || [];
  if (byStaff.length > 0) {
    lines.push('NC BY STAFF');
    lines.push('Staff Name,Count,Total Amount (₹)');
    for (const s of byStaff) {
      lines.push(`${escapeCSV(s.userName || '')},${s.count || 0},${formatCurrency(s.totalAmount)}`);
    }
    lines.push('');
  }

  // By Date Breakdown
  const byDate = (data.breakdowns && data.breakdowns.byDate) || [];
  if (byDate.length > 0) {
    lines.push('NC BY DATE');
    lines.push('Date,Order NC Count,Order NC Amount (₹),Item NC Count,Item NC Amount (₹),Total NC Amount (₹)');
    for (const d of byDate) {
      lines.push(`${formatDate(d.date)},${d.orderNCCount || 0},${formatCurrency(d.orderNCAmount)},${d.itemNCCount || 0},${formatCurrency(d.itemNCAmount)},${formatCurrency(d.totalNCAmount)}`);
    }
    lines.push('');
  }

  // Top NC Items
  const topItems = (data.breakdowns && data.breakdowns.topNCItems) || [];
  if (topItems.length > 0) {
    lines.push('TOP NC ITEMS');
    lines.push('Item Name,Variant,NC Count,Total NC Amount (₹),Total Quantity');
    for (const i of topItems) {
      lines.push(`${escapeCSV(i.itemName || '')},${escapeCSV(i.variantName || '')},${i.ncCount || 0},${formatCurrency(i.totalNCAmount)},${i.totalQuantity || 0}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  toCSV,
  escapeCSV,
  formatDate,
  formatDateTime,
  formatCurrency,
  generateFilename,
  // Report-specific formatters
  dailySalesCSV,
  dailySalesDetailCSV,
  itemSalesCSV,
  itemSalesDetailCSV,
  categorySalesCSV,
  staffReportCSV,
  paymentModeCSV,
  taxReportCSV,
  serviceTypeCSV,
  runningTablesCSV,
  runningOrdersCSV,
  floorSectionCSV,
  counterSalesCSV,
  cancellationCSV,
  // Shift reports
  shiftHistoryCSV,
  shiftDetailCSV,
  // Day-end reports
  dayEndSummaryCSV,
  dayEndSummaryDetailCSV,
  // Admin exports
  adminOrderListCSV,
  // Due report
  dueReportCSV,
  // Biller-wise report
  billerWiseCSV,
  // NC report
  ncReportCSV
};
