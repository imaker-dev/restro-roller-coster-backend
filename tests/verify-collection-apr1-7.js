const mysql = require('mysql2/promise');

async function main() {
  const pool = mysql.createPool({ host: 'localhost', user: 'root', password: '', database: 'restro', dateStrings: true });
  
  // 1. Get floors
  const [floors] = await pool.query('SELECT id, name FROM floors WHERE outlet_id = 46 ORDER BY id');
  console.log('\n=== FLOORS FOR OUTLET 46 ===');
  floors.forEach(f => console.log('  Floor ID:', f.id, '| Name:', f.name));

  // 2. Get shifts/sessions
  const [shifts] = await pool.query(
    `SELECT id, floor_id, cashier_id, opening_time, closing_time, session_date,
            total_sales, total_orders, total_cash_sales, total_card_sales, total_upi_sales,
            total_discounts, total_refunds, total_cancellations, opening_cash, closing_cash
     FROM day_sessions 
     WHERE outlet_id = 46 AND session_date BETWEEN '2026-04-01' AND '2026-04-07'
     ORDER BY session_date, floor_id`
  );
  console.log('\n=== SHIFTS (day_sessions) ===');
  shifts.forEach(s => {
    const d = new Date(s.session_date);
    const ds = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    console.log('  Shift', s.id, '| Date:', ds, '| Floor:', s.floor_id, '| Cashier:', s.cashier_id,
      '| Open:', s.opening_time, '| Close:', s.closing_time,
      '| StoredSales:', parseFloat(s.total_sales), '| Cash:', parseFloat(s.total_cash_sales),
      '| Card:', parseFloat(s.total_card_sales), '| UPI:', parseFloat(s.total_upi_sales));
  });

  // Restaurant provided data
  const provided = {
    '2026-04-01': { bar: 75509, restaurant: 99751, total: 175260 },
    '2026-04-02': { bar: 23430, restaurant: 36115, total: 59545 },
    '2026-04-03': { bar: 35370, restaurant: 39101, total: 74471 },
    '2026-04-04': { bar: 32702, restaurant: 70173, total: 102875 },
    '2026-04-05': { bar: 53522, restaurant: 51422, total: 104944 },
    '2026-04-06': { bar: 47498, restaurant: 35124, total: 82622 },
    '2026-04-07': { bar: 17120, restaurant: 37413, total: 54533 },
  };

  // Identify which floor is Bar and which is Restaurant
  // Floor 38 = First Floor, Floor 39 = Third Floor
  // Need to determine which is Bar and which is Restaurant
  // For now, try both mappings and let the user confirm
  // Assumption: First Floor (38) = Restaurant, Third Floor (39) = Bar (common layout)
  // Will show both floors separately so user can confirm
  const floor38 = floors.find(f => f.id === 38);
  const floor39 = floors.find(f => f.id === 39);
  const barFloor = floor39;  // Third Floor = Bar (assumption)
  const restFloor = floor38; // First Floor = Restaurant (assumption)
  console.log('\n=== FLOOR MAPPING ===');
  console.log('  Bar Floor:', barFloor ? barFloor.id + ' (' + barFloor.name + ')' : 'NOT FOUND');
  console.log('  Restaurant Floor:', restFloor ? restFloor.id + ' (' + restFloor.name + ')' : 'NOT FOUND');

  const barFloorId = barFloor ? barFloor.id : null;
  const restFloorId = restFloor ? restFloor.id : null;

  console.log('\n' + '='.repeat(120));
  console.log('DAY-WISE CROSS-VERIFICATION: PROVIDED vs DB');
  console.log('='.repeat(120));

  let grandTotalProvided = { bar: 0, rest: 0, total: 0 };
  let grandTotalDB = { bar: 0, rest: 0, total: 0 };
  let grandTotalDBPaid = { bar: 0, rest: 0, total: 0 };
  let grandTotalDBPayments = { bar: 0, rest: 0, total: 0 };

  for (const dateStr of Object.keys(provided)) {
    const startDt = dateStr + ' 00:00:00';
    const endDt = dateStr + ' 23:59:59';
    const prov = provided[dateStr];

    // --- METHOD 1: SUM(total_amount) from completed orders (total bill value) ---
    // Bar floor orders
    const [barOrders] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total_sales,
              COALESCE(SUM(paid_amount),0) as total_paid,
              COALESCE(SUM(due_amount),0) as total_due,
              COALESCE(SUM(discount_amount),0) as total_discount
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'completed'
         AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by IN 
              (SELECT cashier_id FROM day_sessions WHERE outlet_id = 46 AND floor_id = ? AND session_date = ?)))`,
      [startDt, endDt, barFloorId, barFloorId, dateStr]
    );

    // Restaurant floor orders
    const [restOrders] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total_sales,
              COALESCE(SUM(paid_amount),0) as total_paid,
              COALESCE(SUM(due_amount),0) as total_due,
              COALESCE(SUM(discount_amount),0) as total_discount
       FROM orders o
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'completed'
         AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by IN 
              (SELECT cashier_id FROM day_sessions WHERE outlet_id = 46 AND floor_id = ? AND session_date = ?)))`,
      [startDt, endDt, restFloorId, restFloorId, dateStr]
    );

    // --- METHOD 2: SUM(paid_amount) from completed orders (actual money received from orders) ---

    // --- METHOD 3: SUM payments (actual money received via payment records) ---
    const [barPayments] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as total_payments
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ? AND p.status = 'completed'
         AND p.payment_mode != 'split'
         AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by IN 
              (SELECT cashier_id FROM day_sessions WHERE outlet_id = 46 AND floor_id = ? AND session_date = ?)))`,
      [startDt, endDt, barFloorId, barFloorId, dateStr]
    );

    const [restPayments] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as total_payments
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ? AND p.status = 'completed'
         AND p.payment_mode != 'split'
         AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by IN 
              (SELECT cashier_id FROM day_sessions WHERE outlet_id = 46 AND floor_id = ? AND session_date = ?)))`,
      [startDt, endDt, restFloorId, restFloorId, dateStr]
    );

    // --- METHOD 4: Simple day-level (no floor split) ---
    const [dayTotal] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total_sales,
              COALESCE(SUM(paid_amount),0) as total_paid,
              COALESCE(SUM(due_amount),0) as total_due
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ? AND status = 'completed'`,
      [startDt, endDt]
    );

    const [dayPayments] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as total_payments
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ? AND p.status = 'completed'
         AND p.payment_mode != 'split' AND o.status = 'completed'`,
      [startDt, endDt]
    );

    // Due collections for the day
    const [dueColl] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as due_collected
       FROM payments p
       WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ? 
         AND p.status = 'completed' AND p.is_due_collection = 1 AND p.payment_mode != 'split'`,
      [startDt, endDt]
    );

    // Stored day_sessions totals for this date
    const dayShifts = shifts.filter(s => {
      const d = new Date(s.session_date);
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') === dateStr;
    });
    const storedBar = dayShifts.filter(s => s.floor_id === barFloorId).reduce((sum, s) => sum + parseFloat(s.total_sales || 0), 0);
    const storedRest = dayShifts.filter(s => s.floor_id === restFloorId).reduce((sum, s) => sum + parseFloat(s.total_sales || 0), 0);

    const dbBarSales = parseFloat(barOrders[0].total_sales);
    const dbRestSales = parseFloat(restOrders[0].total_sales);
    const dbBarPaid = parseFloat(barOrders[0].total_paid);
    const dbRestPaid = parseFloat(restOrders[0].total_paid);
    const dbBarPayments = parseFloat(barPayments[0].total_payments);
    const dbRestPayments = parseFloat(restPayments[0].total_payments);
    const dbDayTotalSales = parseFloat(dayTotal[0].total_sales);
    const dbDayTotalPaid = parseFloat(dayTotal[0].total_paid);
    const dbDayPayments = parseFloat(dayPayments[0].total_payments);
    const dbDueColl = parseFloat(dueColl[0].due_collected);

    grandTotalProvided.bar += prov.bar;
    grandTotalProvided.rest += prov.restaurant;
    grandTotalProvided.total += prov.total;
    grandTotalDB.bar += dbBarSales;
    grandTotalDB.rest += dbRestSales;
    grandTotalDB.total += dbDayTotalSales;
    grandTotalDBPaid.bar += dbBarPaid;
    grandTotalDBPaid.rest += dbRestPaid;
    grandTotalDBPaid.total += dbDayTotalPaid;
    grandTotalDBPayments.bar += dbBarPayments;
    grandTotalDBPayments.rest += dbRestPayments;
    grandTotalDBPayments.total += dbDayPayments;

    const r = (n) => Math.round(n * 100) / 100;

    console.log('\n--- ' + dateStr + ' ---');
    console.log('  PROVIDED:        Bar=' + prov.bar + '  Rest=' + prov.restaurant + '  Total=' + prov.total);
    console.log('  DB total_amount: Bar=' + r(dbBarSales) + '  Rest=' + r(dbRestSales) + '  Total=' + r(dbDayTotalSales) + '  (SUM of completed orders total_amount)');
    console.log('  DB paid_amount:  Bar=' + r(dbBarPaid) + '  Rest=' + r(dbRestPaid) + '  Total=' + r(dbDayTotalPaid) + '  (SUM of completed orders paid_amount)');
    console.log('  DB payments:     Bar=' + r(dbBarPayments) + '  Rest=' + r(dbRestPayments) + '  Total=' + r(dbDayPayments) + '  (SUM of payment records)');
    console.log('  Due collections: ' + r(dbDueColl));
    console.log('  Stored sessions: Bar=' + r(storedBar) + '  Rest=' + r(storedRest) + '  Total=' + r(storedBar + storedRest));
    console.log('  DIFF (Provided - DB total_amount): Bar=' + r(prov.bar - dbBarSales) + '  Rest=' + r(prov.restaurant - dbRestSales) + '  Total=' + r(prov.total - dbDayTotalSales));
    console.log('  DIFF (Provided - DB paid_amount):  Bar=' + r(prov.bar - dbBarPaid) + '  Rest=' + r(prov.restaurant - dbRestPaid) + '  Total=' + r(prov.total - dbDayTotalPaid));
    console.log('  DIFF (Provided - DB payments):     Bar=' + r(prov.bar - dbBarPayments) + '  Rest=' + r(prov.restaurant - dbRestPayments) + '  Total=' + r(prov.total - dbDayPayments));
    console.log('  Orders: Bar=' + barOrders[0].cnt + '  Rest=' + restOrders[0].cnt + '  DayTotal=' + dayTotal[0].cnt);
    console.log('  Due: Bar=' + r(parseFloat(barOrders[0].total_due)) + '  Rest=' + r(parseFloat(restOrders[0].total_due)));
    console.log('  Discount: Bar=' + r(parseFloat(barOrders[0].total_discount)) + '  Rest=' + r(parseFloat(restOrders[0].total_discount)));
  }

  console.log('\n' + '='.repeat(120));
  console.log('GRAND TOTALS (7 DAYS)');
  console.log('='.repeat(120));
  const r = (n) => Math.round(n * 100) / 100;
  console.log('  PROVIDED:        Bar=' + grandTotalProvided.bar + '  Rest=' + grandTotalProvided.rest + '  Total=' + grandTotalProvided.total);
  console.log('  DB total_amount: Bar=' + r(grandTotalDB.bar) + '  Rest=' + r(grandTotalDB.rest) + '  Total=' + r(grandTotalDB.total));
  console.log('  DB paid_amount:  Bar=' + r(grandTotalDBPaid.bar) + '  Rest=' + r(grandTotalDBPaid.rest) + '  Total=' + r(grandTotalDBPaid.total));
  console.log('  DB payments:     Bar=' + r(grandTotalDBPayments.bar) + '  Rest=' + r(grandTotalDBPayments.rest) + '  Total=' + r(grandTotalDBPayments.total));
  console.log('  DIFF (Provided - DB total_amount): Bar=' + r(grandTotalProvided.bar - grandTotalDB.bar) + '  Rest=' + r(grandTotalProvided.rest - grandTotalDB.rest) + '  Total=' + r(grandTotalProvided.total - grandTotalDB.total));
  console.log('  DIFF (Provided - DB paid_amount):  Bar=' + r(grandTotalProvided.bar - grandTotalDBPaid.bar) + '  Rest=' + r(grandTotalProvided.rest - grandTotalDBPaid.rest) + '  Total=' + r(grandTotalProvided.total - grandTotalDBPaid.total));
  console.log('  DIFF (Provided - DB payments):     Bar=' + r(grandTotalProvided.bar - grandTotalDBPayments.bar) + '  Rest=' + r(grandTotalProvided.rest - grandTotalDBPayments.rest) + '  Total=' + r(grandTotalProvided.total - grandTotalDBPayments.total));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
