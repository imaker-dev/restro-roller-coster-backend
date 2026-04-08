const mysql = require('mysql2/promise');

async function main() {
  const pool = mysql.createPool({ host: 'localhost', user: 'root', password: '', database: 'restro', dateStrings: true });

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

  // 1. SHIFT TIMING ANALYSIS
  console.log('=== SHIFT TIMING ANALYSIS ===');
  const [shifts] = await pool.query(
    `SELECT ds.id, ds.floor_id, ds.cashier_id, ds.session_date, ds.opening_time, ds.closing_time,
            ds.total_sales, u.name as cashier_name
     FROM day_sessions ds LEFT JOIN users u ON ds.cashier_id = u.id
     WHERE ds.outlet_id = 46 AND ds.session_date BETWEEN '2026-04-01' AND '2026-04-07'
     ORDER BY ds.session_date, ds.floor_id`
  );
  shifts.forEach(s => {
    const fl = s.floor_id === BAR_FLOOR ? 'BAR ' : 'REST';
    const openDate = s.opening_time ? s.opening_time.substring(0,10) : '?';
    const closeDate = s.closing_time ? s.closing_time.substring(0,10) : '?';
    const crossesMidnight = openDate !== closeDate ? ' *** CROSSES MIDNIGHT ***' : '';
    console.log('  Shift ' + s.id + ' | ' + s.session_date.substring(0,10) + ' | ' + fl +
      ' | ' + s.cashier_name + ' | Open: ' + (s.opening_time || '?') + ' | Close: ' + (s.closing_time || '?') +
      ' | Sales: ' + parseFloat(s.total_sales) + crossesMidnight);
  });

  // 2. DEEP DIVE: Check orders within shift time windows vs calendar day
  console.log('\n=== SHIFT-BASED vs CALENDAR-DAY ORDER COMPARISON ===');
  console.log('(Checking if using shift open/close times captures more orders than calendar day)');

  const r = n => Math.round(n * 100) / 100;

  for (const dateStr of Object.keys(provided)) {
    const prov = provided[dateStr];
    const dayStart = dateStr + ' 00:00:00';
    const dayEnd = dateStr + ' 23:59:59';

    const dayShifts = shifts.filter(s => s.session_date.substring(0,10) === dateStr);
    const barShifts = dayShifts.filter(s => s.floor_id === BAR_FLOOR);
    const restShifts = dayShifts.filter(s => s.floor_id === REST_FLOOR);

    // Calendar day orders (midnight to midnight)
    const [calDay] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as sales, status
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ? GROUP BY status`,
      [dayStart, dayEnd]
    );
    
    // Check if shift time window extends into next day
    let barShiftSales = 0, restShiftSales = 0;
    let barShiftOrders = 0, restShiftOrders = 0;

    for (const sh of barShifts) {
      if (!sh.opening_time || !sh.closing_time) continue;
      const [orders] = await pool.query(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
         FROM orders o LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = 46 AND o.created_at >= ? AND o.created_at <= ? AND o.status = 'completed'
           AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`,
        [sh.opening_time, sh.closing_time, BAR_FLOOR, sh.cashier_id]
      );
      barShiftSales += parseFloat(orders[0].sales);
      barShiftOrders += parseInt(orders[0].cnt);
    }

    for (const sh of restShifts) {
      if (!sh.opening_time || !sh.closing_time) continue;
      const [orders] = await pool.query(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
         FROM orders o LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = 46 AND o.created_at >= ? AND o.created_at <= ? AND o.status = 'completed'
           AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`,
        [sh.opening_time, sh.closing_time, REST_FLOOR, sh.cashier_id]
      );
      restShiftSales += parseFloat(orders[0].sales);
      restShiftOrders += parseInt(orders[0].cnt);
    }

    // Calendar day floor-wise
    const barCashiers = barShifts.map(s => s.cashier_id);
    const restCashiers = restShifts.map(s => s.cashier_id);
    const floorCond = (fid, cashiers) => {
      if (cashiers.length === 0) return `t.floor_id = ${fid}`;
      return `(t.floor_id = ${fid} OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by IN (${cashiers.join(',')})))`;
    };

    const [barCal] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'completed' AND ${floorCond(BAR_FLOOR, barCashiers)}`,
      [dayStart, dayEnd]
    );
    const [restCal] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'completed' AND ${floorCond(REST_FLOOR, restCashiers)}`,
      [dayStart, dayEnd]
    );

    const completedCal = calDay.find(r => r.status === 'completed');
    const cancelledCal = calDay.find(r => r.status === 'cancelled');

    console.log('\n--- ' + dateStr + ' ---');
    console.log('  PROVIDED:         Bar=' + prov.bar + '  Rest=' + prov.restaurant + '  Total=' + prov.total);
    console.log('  Calendar day:     Bar=' + r(parseFloat(barCal[0].sales)) + '(' + barCal[0].cnt + ')  Rest=' + r(parseFloat(restCal[0].sales)) + '(' + restCal[0].cnt + ')  Total=' + r(parseFloat(completedCal?.sales||0)) + '(' + (completedCal?.cnt||0) + ')  Cancelled=' + r(parseFloat(cancelledCal?.sales||0)) + '(' + (cancelledCal?.cnt||0) + ')');
    console.log('  Shift window:     Bar=' + r(barShiftSales) + '(' + barShiftOrders + ')  Rest=' + r(restShiftSales) + '(' + restShiftOrders + ')  Combined=' + r(barShiftSales + restShiftSales));
    console.log('  Stored sessions:  Bar=' + r(barShifts.reduce((s,x) => s + parseFloat(x.total_sales), 0)) + '  Rest=' + r(restShifts.reduce((s,x) => s + parseFloat(x.total_sales), 0)));
    console.log('  Diff(Prov-Shift): Bar=' + r(prov.bar - barShiftSales) + '  Rest=' + r(prov.restaurant - restShiftSales) + '  Total=' + r(prov.total - barShiftSales - restShiftSales));
    console.log('  Diff(Prov-CalDay):Bar=' + r(prov.bar - parseFloat(barCal[0].sales)) + '  Rest=' + r(prov.restaurant - parseFloat(restCal[0].sales)) + '  Total=' + r(prov.total - parseFloat(completedCal?.sales||0)));

    // Check for orders OUTSIDE shift window but within calendar day
    for (const sh of [...barShifts, ...restShifts]) {
      if (!sh.opening_time || !sh.closing_time) continue;
      const closeDate = sh.closing_time.substring(0, 10);
      const sessDate = sh.session_date.substring(0, 10);
      if (closeDate !== sessDate) {
        // Shift crosses midnight - find orders between midnight and close time that are on the NEXT day
        const nextDayStart = closeDate + ' 00:00:00';
        const [extraOrders] = await pool.query(
          `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
           FROM orders o LEFT JOIN tables t ON o.table_id = t.id
           WHERE o.outlet_id = 46 AND o.created_at > ? AND o.created_at <= ? AND o.status = 'completed'
             AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`,
          [nextDayStart, sh.closing_time, sh.floor_id, sh.cashier_id]
        );
        if (parseInt(extraOrders[0].cnt) > 0) {
          const fl = sh.floor_id === BAR_FLOOR ? 'BAR' : 'REST';
          console.log('  !! Shift ' + sh.id + ' (' + fl + ') crosses midnight: ' + extraOrders[0].cnt + ' extra orders worth ' + r(parseFloat(extraOrders[0].sales)) + ' after midnight (in next day)');
        }
      }
    }
  }

  // 3. Check if there are orders NOT captured by any shift
  console.log('\n=== UNACCOUNTED ORDERS CHECK ===');
  for (const dateStr of Object.keys(provided)) {
    const dayStart = dateStr + ' 00:00:00';
    const dayEnd = dateStr + ' 23:59:59';
    const dayShifts = shifts.filter(s => s.session_date.substring(0,10) === dateStr);

    // Check for orders that don't belong to any shift's time window
    let conditions = [];
    for (const sh of dayShifts) {
      if (!sh.opening_time || !sh.closing_time) continue;
      conditions.push(`(o.created_at >= '${sh.opening_time}' AND o.created_at <= '${sh.closing_time}')`);
    }
    if (conditions.length > 0) {
      const notInShift = `NOT (${conditions.join(' OR ')})`;
      const [orphanOrders] = await pool.query(
        `SELECT o.id, o.order_number, o.total_amount, o.status, o.created_at, o.order_type, t.floor_id
         FROM orders o LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND ${notInShift}
         ORDER BY o.created_at`,
        [dayStart, dayEnd]
      );
      if (orphanOrders.length > 0) {
        console.log('\n  ' + dateStr + ': ' + orphanOrders.length + ' orders NOT in any shift window:');
        let orphanTotal = 0;
        orphanOrders.forEach(o => {
          orphanTotal += parseFloat(o.total_amount);
          console.log('    Order #' + o.order_number + ' | ' + o.status + ' | ' + o.order_type + ' | Floor:' + o.floor_id + ' | Amt:' + parseFloat(o.total_amount) + ' | ' + o.created_at);
        });
        console.log('    Orphan total: ' + Math.round(orphanTotal * 100) / 100);
      } else {
        console.log('  ' + dateStr + ': All orders accounted for within shift windows');
      }
    }
  }

  // 4. Check ALL orders for this outlet (any status) for each day
  console.log('\n=== ALL ORDERS BY STATUS PER DAY ===');
  for (const dateStr of Object.keys(provided)) {
    const [allOrders] = await pool.query(
      `SELECT status, payment_status, COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total,
              COALESCE(SUM(paid_amount),0) as paid
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ?
       GROUP BY status, payment_status`,
      [dateStr + ' 00:00:00', dateStr + ' 23:59:59']
    );
    console.log('\n  ' + dateStr + ':');
    allOrders.forEach(o => {
      console.log('    status=' + o.status + ' payment_status=' + o.payment_status + ' | cnt=' + o.cnt + ' | total=' + r(parseFloat(o.total)) + ' | paid=' + r(parseFloat(o.paid)));
    });
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
