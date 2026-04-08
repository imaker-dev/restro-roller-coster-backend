const mysql = require('mysql2/promise');

async function main() {
  const pool = mysql.createPool({ host: 'localhost', user: 'root', password: '', database: 'restro', dateStrings: true });

  // CONFIRMED MAPPING from stored data:
  // Floor 38 (First Floor) = BAR  (Apr 7: stored 17120 = provided Bar 17120)
  // Floor 39 (Third Floor) = RESTAURANT
  const BAR_FLOOR = 38;
  const REST_FLOOR = 39;

  const provided = {
    '2026-04-01': { bar: 75509, restaurant: 99751, total: 175260 },
    '2026-04-02': { bar: 23430, restaurant: 36115, total: 59545 },
    '2026-04-03': { bar: 35370, restaurant: 39101, total: 74471 },
    '2026-04-04': { bar: 32702, restaurant: 70173, total: 102875 },
    '2026-04-05': { bar: 53522, restaurant: 51422, total: 104944 },
    '2026-04-06': { bar: 47498, restaurant: 35124, total: 82622 },
    '2026-04-07': { bar: 17120, restaurant: 37413, total: 54533 },
  };

  // Get cashier-floor mapping from shifts
  const [shifts] = await pool.query(
    `SELECT id, floor_id, cashier_id, opening_time, closing_time, session_date, total_sales,
            total_cash_sales, total_card_sales, total_upi_sales, total_discounts
     FROM day_sessions WHERE outlet_id = 46 AND session_date BETWEEN '2026-04-01' AND '2026-04-07'
     ORDER BY session_date, floor_id`
  );

  console.log('=== SHIFTS ===');
  shifts.forEach(s => {
    const floorLabel = s.floor_id === BAR_FLOOR ? 'BAR' : 'REST';
    console.log('  Shift ' + s.id + ' | ' + s.session_date.substring(0,10) + ' | ' + floorLabel + '(F' + s.floor_id + ') | Cashier:' + s.cashier_id +
      ' | Sales:' + parseFloat(s.total_sales) + ' | Cash:' + parseFloat(s.total_cash_sales) + ' Card:' + parseFloat(s.total_card_sales) + ' UPI:' + parseFloat(s.total_upi_sales));
  });

  const r = n => Math.round(n * 100) / 100;

  console.log('\n' + '='.repeat(140));
  console.log('DAY-WISE DETAILED CROSS-VERIFICATION');
  console.log('='.repeat(140));

  let grandProv = { bar: 0, rest: 0, total: 0 };
  let grandDB = { barSales: 0, restSales: 0, barPay: 0, restPay: 0, barAllPay: 0, restAllPay: 0, dayTotal: 0, dayPay: 0, dayAllPay: 0 };

  for (const dateStr of Object.keys(provided)) {
    const startDt = dateStr + ' 00:00:00';
    const endDt = dateStr + ' 23:59:59';
    const prov = provided[dateStr];

    // Get cashiers for each floor on this date
    const dayShifts = shifts.filter(s => s.session_date.substring(0,10) === dateStr);
    const barCashiers = dayShifts.filter(s => s.floor_id === BAR_FLOOR).map(s => s.cashier_id);
    const restCashiers = dayShifts.filter(s => s.floor_id === REST_FLOOR).map(s => s.cashier_id);

    // Helper to build floor condition
    const floorCond = (floorId, cashiers) => {
      if (cashiers.length === 0) return `t.floor_id = ${floorId}`;
      return `(t.floor_id = ${floorId} OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by IN (${cashiers.join(',')})))`;
    };

    // ===== A) COMPLETED ORDERS: total_amount (bill value) =====
    const [barOrderSales] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales, COALESCE(SUM(o.paid_amount),0) as paid, COALESCE(SUM(o.due_amount),0) as due
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'completed' AND ${floorCond(BAR_FLOOR, barCashiers)}`,
      [startDt, endDt]
    );
    const [restOrderSales] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales, COALESCE(SUM(o.paid_amount),0) as paid, COALESCE(SUM(o.due_amount),0) as due
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'completed' AND ${floorCond(REST_FLOOR, restCashiers)}`,
      [startDt, endDt]
    );

    // ===== B) ALL PAYMENTS for completed orders (money actually received for orders created today) =====
    const [barPayCompleted] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as amt
       FROM payments p JOIN orders o ON p.order_id = o.id LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND p.status = 'completed' AND p.payment_mode != 'split'
         AND o.status = 'completed' AND ${floorCond(BAR_FLOOR, barCashiers)}`,
      [startDt, endDt]
    );
    const [restPayCompleted] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as amt
       FROM payments p JOIN orders o ON p.order_id = o.id LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND p.status = 'completed' AND p.payment_mode != 'split'
         AND o.status = 'completed' AND ${floorCond(REST_FLOOR, restCashiers)}`,
      [startDt, endDt]
    );

    // ===== C) ALL PAYMENTS created today (regardless of order date) — this is "money collected today" =====
    const [barPayToday] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as amt
       FROM payments p JOIN orders o ON p.order_id = o.id LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ? AND p.status = 'completed' AND p.payment_mode != 'split'
         AND ${floorCond(BAR_FLOOR, barCashiers)}`,
      [startDt, endDt]
    );
    const [restPayToday] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as amt
       FROM payments p JOIN orders o ON p.order_id = o.id LEFT JOIN tables t ON o.table_id = t.id
       WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ? AND p.status = 'completed' AND p.payment_mode != 'split'
         AND ${floorCond(REST_FLOOR, restCashiers)}`,
      [startDt, endDt]
    );

    // ===== D) Simple day total (no floor split) =====
    const [dayTotal] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as sales, COALESCE(SUM(paid_amount),0) as paid
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ? AND status = 'completed'`,
      [startDt, endDt]
    );
    const [dayAllPayments] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as amt
       FROM payments p WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ? AND p.status = 'completed' AND p.payment_mode != 'split'`,
      [startDt, endDt]
    );

    // ===== E) Due collections received today =====
    const [dueColl] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as amt
       FROM payments p WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ? AND p.status = 'completed' AND p.is_due_collection = 1 AND p.payment_mode != 'split'`,
      [startDt, endDt]
    );

    // ===== F) Cancelled orders =====
    const [cancelled] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as sales
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ? AND status = 'cancelled'`,
      [startDt, endDt]
    );

    // Stored session totals
    const storedBar = dayShifts.filter(s => s.floor_id === BAR_FLOOR).reduce((sum, s) => sum + parseFloat(s.total_sales || 0), 0);
    const storedRest = dayShifts.filter(s => s.floor_id === REST_FLOOR).reduce((sum, s) => sum + parseFloat(s.total_sales || 0), 0);

    const bs = parseFloat(barOrderSales[0].sales);
    const rs = parseFloat(restOrderSales[0].sales);
    const bp = parseFloat(barOrderSales[0].paid);
    const rp = parseFloat(restOrderSales[0].paid);
    const bpc = parseFloat(barPayCompleted[0].amt);
    const rpc = parseFloat(restPayCompleted[0].amt);
    const bpt = parseFloat(barPayToday[0].amt);
    const rpt = parseFloat(restPayToday[0].amt);
    const dts = parseFloat(dayTotal[0].sales);
    const dap = parseFloat(dayAllPayments[0].amt);
    const dc = parseFloat(dueColl[0].amt);
    const canc = parseFloat(cancelled[0].sales);

    grandProv.bar += prov.bar; grandProv.rest += prov.restaurant; grandProv.total += prov.total;
    grandDB.barSales += bs; grandDB.restSales += rs;
    grandDB.barPay += bpt; grandDB.restPay += rpt;
    grandDB.dayTotal += dts; grandDB.dayPay += dap;

    console.log('\n--- ' + dateStr + ' ---');
    console.log('  PROVIDED:                  Bar=' + prov.bar + '    Rest=' + prov.restaurant + '    Total=' + prov.total);
    console.log('  Stored day_sessions:       Bar=' + r(storedBar) + '    Rest=' + r(storedRest) + '    Total=' + r(storedBar + storedRest));
    console.log('  DB order total_amount:     Bar=' + r(bs) + '    Rest=' + r(rs) + '    Total=' + r(dts) + '  (completed orders bill value)');
    console.log('  DB order paid_amount:      Bar=' + r(bp) + '    Rest=' + r(rp) + '    Total=' + r(parseFloat(dayTotal[0].paid)) + '  (paid by customers from orders)');
    console.log('  DB payments(order date):   Bar=' + r(bpc) + '    Rest=' + r(rpc) + '    Total=' + r(bpc+rpc) + '  (payments for today\'s completed orders)');
    console.log('  DB payments(payment date): Bar=' + r(bpt) + '    Rest=' + r(rpt) + '    Total=' + r(dap) + '  (ALL payments made today)');
    console.log('  Due collections today:     ' + r(dc));
    console.log('  Cancelled orders:          ' + cancelled[0].cnt + ' orders, value=' + r(canc));
    console.log('  ---');
    console.log('  MATCH CHECK (Provided vs Stored):      Bar diff=' + r(prov.bar - storedBar) + '  Rest diff=' + r(prov.restaurant - storedRest) + '  Total diff=' + r(prov.total - storedBar - storedRest));
    console.log('  MATCH CHECK (Provided vs order sales): Bar diff=' + r(prov.bar - bs) + '  Rest diff=' + r(prov.restaurant - rs) + '  Total diff=' + r(prov.total - dts));
    console.log('  MATCH CHECK (Provided vs payments):    Bar diff=' + r(prov.bar - bpt) + '  Rest diff=' + r(prov.restaurant - rpt) + '  Total diff=' + r(prov.total - dap));
    
    // Check if Bar+Rest = Total in provided data
    if (prov.bar + prov.restaurant !== prov.total) {
      console.log('  WARNING: Provided Bar+Rest (' + (prov.bar + prov.restaurant) + ') != Provided Total (' + prov.total + ')');
    }
  }

  console.log('\n' + '='.repeat(140));
  console.log('GRAND TOTALS');
  console.log('='.repeat(140));
  console.log('  PROVIDED:               Bar=' + grandProv.bar + '  Rest=' + grandProv.rest + '  Total=' + grandProv.total);
  console.log('  DB order total_amount:  Bar=' + r(grandDB.barSales) + '  Rest=' + r(grandDB.restSales) + '  Total=' + r(grandDB.dayTotal));
  console.log('  DB payments(pay date):  Bar=' + r(grandDB.barPay) + '  Rest=' + r(grandDB.restPay) + '  Total=' + r(grandDB.dayPay));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
