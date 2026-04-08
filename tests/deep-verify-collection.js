const mysql = require('mysql2/promise');

async function main() {
  const pool = mysql.createPool({ host: 'localhost', user: 'root', password: '', database: 'restro', dateStrings: true });

  const BAR = 38, REST = 39; // Floor 38 = Bar (First Floor), Floor 39 = Restaurant (Third Floor)
  const r = n => Math.round(n * 100) / 100;

  const provided = [
    { date: '2026-04-01', bar: 75509, rest: 99751, total: 175260 },
    { date: '2026-04-02', bar: 23430, rest: 36115, total: 59545 },
    { date: '2026-04-03', bar: 35370, rest: 39101, total: 74471 },
    { date: '2026-04-04', bar: 32702, rest: 70173, total: 102875 },
    { date: '2026-04-05', bar: 53522, rest: 51422, total: 104944 },
    { date: '2026-04-06', bar: 47498, rest: 35124, total: 82622 },
    { date: '2026-04-07', bar: 17120, rest: 37413, total: 54533 },
  ];

  // ===== 1. GET ALL SHIFTS =====
  const [shifts] = await pool.query(
    `SELECT ds.id, ds.floor_id, ds.cashier_id, ds.session_date, ds.opening_time, ds.closing_time,
            ds.total_sales, ds.total_orders, ds.total_discounts, ds.total_refunds, ds.total_cancellations,
            ds.opening_cash, ds.closing_cash, ds.expected_cash, ds.cash_variance,
            u.name as cashier_name
     FROM day_sessions ds LEFT JOIN users u ON ds.cashier_id = u.id
     WHERE ds.outlet_id = 46 AND ds.session_date BETWEEN '2026-04-01' AND '2026-04-07'
     ORDER BY ds.opening_time`
  );

  console.log('='.repeat(140));
  console.log('DEEP ANALYSIS: OUTLET 46 — PROVIDED COLLECTION vs POS DATA (Apr 1-7, 2026)');
  console.log('Floor 38 (First Floor) = BAR  |  Floor 39 (Third Floor) = RESTAURANT');
  console.log('='.repeat(140));

  // ===== 2. SHIFT TIMELINE =====
  console.log('\n[1] SHIFT TIMELINE');
  console.log('-'.repeat(140));
  shifts.forEach(s => {
    const fl = s.floor_id === BAR ? 'BAR ' : 'REST';
    const sessDate = s.session_date.substring(0, 10);
    const closeDate = s.closing_time ? s.closing_time.substring(0, 10) : '?';
    const cross = sessDate !== closeDate ? ' ** CROSSES MIDNIGHT **' : '';
    console.log('  Shift ' + s.id + ' | sess_date=' + sessDate + ' | ' + fl + ' | ' + s.cashier_name +
      ' | OPEN: ' + s.opening_time + ' | CLOSE: ' + s.closing_time +
      ' | stored_sales=' + parseFloat(s.total_sales) + ' | orders=' + s.total_orders + cross);
  });

  // ===== 3. DAY-BY-DAY DEEP ANALYSIS =====
  let grandProvided = 0, grandStored = 0, grandCalendar = 0, grandShiftWindow = 0;

  for (const day of provided) {
    const ds = day.date;
    const dayStart = ds + ' 00:00:00';
    const dayEnd = ds + ' 23:59:59';

    const dayShifts = shifts.filter(s => s.session_date.substring(0, 10) === ds);
    const barShifts = dayShifts.filter(s => s.floor_id === BAR);
    const restShifts = dayShifts.filter(s => s.floor_id === REST);

    // ----- A. STORED shift totals -----
    const storedBar = barShifts.reduce((s, x) => s + parseFloat(x.total_sales), 0);
    const storedRest = restShifts.reduce((s, x) => s + parseFloat(x.total_sales), 0);
    const storedTotal = storedBar + storedRest;

    // ----- B. SHIFT WINDOW: actual orders within each shift's open-close time -----
    let shiftBarSales = 0, shiftBarOrders = 0, shiftRestSales = 0, shiftRestOrders = 0;
    for (const sh of barShifts) {
      if (!sh.opening_time || !sh.closing_time) continue;
      const [res] = await pool.query(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
         FROM orders o LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = 46 AND o.created_at >= ? AND o.created_at <= ? AND o.status = 'completed'
           AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`,
        [sh.opening_time, sh.closing_time, BAR, sh.cashier_id]
      );
      shiftBarSales += parseFloat(res[0].sales);
      shiftBarOrders += parseInt(res[0].cnt);
    }
    for (const sh of restShifts) {
      if (!sh.opening_time || !sh.closing_time) continue;
      const [res] = await pool.query(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
         FROM orders o LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = 46 AND o.created_at >= ? AND o.created_at <= ? AND o.status = 'completed'
           AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`,
        [sh.opening_time, sh.closing_time, REST, sh.cashier_id]
      );
      shiftRestSales += parseFloat(res[0].sales);
      shiftRestOrders += parseInt(res[0].cnt);
    }

    // ----- C. CALENDAR DAY: all completed orders created today (midnight-midnight) -----
    const barCashiers = barShifts.map(s => s.cashier_id);
    const restCashiers = restShifts.map(s => s.cashier_id);
    const floorCond = (fid, cashiers) => {
      if (cashiers.length === 0) return `t.floor_id = ${fid}`;
      return `(t.floor_id = ${fid} OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by IN (${cashiers.join(',')})))`;
    };

    const [barCal] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales, COALESCE(SUM(o.paid_amount),0) as paid
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'completed' AND ${floorCond(BAR, barCashiers)}`,
      [dayStart, dayEnd]
    );
    const [restCal] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales, COALESCE(SUM(o.paid_amount),0) as paid
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'completed' AND ${floorCond(REST, restCashiers)}`,
      [dayStart, dayEnd]
    );

    // ----- D. CANCELLED orders today -----
    const [cancelledBar] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'cancelled' AND ${floorCond(BAR, barCashiers)}`,
      [dayStart, dayEnd]
    );
    const [cancelledRest] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND o.status = 'cancelled' AND ${floorCond(REST, restCashiers)}`,
      [dayStart, dayEnd]
    );

    // ----- E. DUE COLLECTIONS received today -----
    const [dueColl] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as amt, COUNT(*) as cnt
       FROM payments p WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ?
         AND p.status = 'completed' AND p.is_due_collection = 1 AND p.payment_mode != 'split'`,
      [dayStart, dayEnd]
    );

    // ----- F. ORPHAN orders (in calendar day but NOT in any shift window) -----
    let orphanConds = dayShifts.map(sh => {
      if (!sh.opening_time || !sh.closing_time) return null;
      return `(o.created_at >= '${sh.opening_time}' AND o.created_at <= '${sh.closing_time}')`;
    }).filter(Boolean);
    let orphanOrders = [];
    if (orphanConds.length > 0) {
      const [orph] = await pool.query(
        `SELECT o.id, o.order_number, o.total_amount, o.status, o.order_type, o.created_at, t.floor_id
         FROM orders o LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = 46 AND o.created_at BETWEEN ? AND ? AND NOT (${orphanConds.join(' OR ')})
         ORDER BY o.created_at`,
        [dayStart, dayEnd]
      );
      orphanOrders = orph;
    }

    // ----- G. Orders from PREVIOUS day's shift that crossed midnight into this day -----
    const prevDate = new Date(ds);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDs = prevDate.toISOString().substring(0, 10);
    const prevShifts = shifts.filter(s => s.session_date.substring(0, 10) === prevDs);
    let spilloverTotal = 0, spilloverOrders = 0;
    for (const sh of prevShifts) {
      if (!sh.closing_time) continue;
      const closeDate = sh.closing_time.substring(0, 10);
      if (closeDate === ds) {
        // This shift from previous day closes today — find orders between midnight and close
        const [spill] = await pool.query(
          `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
           FROM orders o LEFT JOIN tables t ON o.table_id = t.id
           WHERE o.outlet_id = 46 AND o.created_at >= ? AND o.created_at <= ? AND o.status = 'completed'
             AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`,
          [dayStart, sh.closing_time, sh.floor_id, sh.cashier_id]
        );
        spilloverTotal += parseFloat(spill[0].sales);
        spilloverOrders += parseInt(spill[0].cnt);
      }
    }

    // ----- H. Orders from THIS day's shift that spill into NEXT day (after midnight) -----
    let spilloutTotal = 0, spilloutOrders = 0;
    for (const sh of dayShifts) {
      if (!sh.closing_time) continue;
      const closeDate = sh.closing_time.substring(0, 10);
      if (closeDate !== ds) {
        const nextDayStart = closeDate + ' 00:00:00';
        const [spillout] = await pool.query(
          `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
           FROM orders o LEFT JOIN tables t ON o.table_id = t.id
           WHERE o.outlet_id = 46 AND o.created_at >= ? AND o.created_at <= ? AND o.status = 'completed'
             AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`,
          [nextDayStart, sh.closing_time, sh.floor_id, sh.cashier_id]
        );
        spilloutTotal += parseFloat(spillout[0].sales);
        spilloutOrders += parseInt(spillout[0].cnt);
      }
    }

    // ----- CALCULATIONS -----
    const calBarSales = parseFloat(barCal[0].sales);
    const calRestSales = parseFloat(restCal[0].sales);
    const calTotal = calBarSales + calRestSales;
    const shiftTotal = shiftBarSales + shiftRestSales;
    const cancBar = parseFloat(cancelledBar[0].sales);
    const cancRest = parseFloat(cancelledRest[0].sales);
    const dc = parseFloat(dueColl[0].amt);
    const orphanCompletedTotal = orphanOrders.filter(o => o.status === 'completed').reduce((s, o) => s + parseFloat(o.total_amount), 0);

    const diffFromStored = day.total - storedTotal;
    const diffFromShiftWindow = day.total - shiftTotal;
    const diffFromCalendar = day.total - calTotal;

    grandProvided += day.total;
    grandStored += storedTotal;
    grandCalendar += calTotal;
    grandShiftWindow += shiftTotal;

    // ===== PRINT =====
    console.log('\n' + '='.repeat(140));
    console.log('[' + ds + ']  PROVIDED: Bar=' + day.bar + '  Rest=' + day.rest + '  Total=' + day.total);
    console.log('='.repeat(140));

    console.log('\n  [A] POS STORED (day_sessions.total_sales):');
    console.log('      Bar=' + r(storedBar) + '  Rest=' + r(storedRest) + '  Total=' + r(storedTotal));
    console.log('      GAP from provided: Bar=' + r(day.bar - storedBar) + '  Rest=' + r(day.rest - storedRest) + '  Total=' + r(diffFromStored));

    console.log('\n  [B] SHIFT WINDOW (orders within open-close time):');
    console.log('      Bar=' + r(shiftBarSales) + '(' + shiftBarOrders + ' orders)  Rest=' + r(shiftRestSales) + '(' + shiftRestOrders + ' orders)  Total=' + r(shiftTotal));
    console.log('      Matches stored? Bar: ' + (r(shiftBarSales) === r(storedBar) ? 'YES' : 'NO(diff=' + r(shiftBarSales - storedBar) + ')') +
      '  Rest: ' + (r(shiftRestSales) === r(storedRest) ? 'YES' : 'NO(diff=' + r(shiftRestSales - storedRest) + ')'));

    console.log('\n  [C] CALENDAR DAY (midnight-midnight, completed):');
    console.log('      Bar=' + r(calBarSales) + '(' + barCal[0].cnt + ')  Rest=' + r(calRestSales) + '(' + restCal[0].cnt + ')  Total=' + r(calTotal));
    console.log('      GAP from provided: ' + r(diffFromCalendar));

    console.log('\n  [D] CANCELLED ORDERS (calendar day):');
    console.log('      Bar=' + r(cancBar) + '(' + cancelledBar[0].cnt + ')  Rest=' + r(cancRest) + '(' + cancelledRest[0].cnt + ')  Combined=' + r(cancBar + cancRest));

    console.log('\n  [E] DUE COLLECTIONS received today: ' + r(dc) + ' (' + dueColl[0].cnt + ' payments)');

    console.log('\n  [F] MIDNIGHT SPILLOVER (prev day shift orders landing in today):');
    console.log('      ' + spilloverOrders + ' orders, total=' + r(spilloverTotal));

    console.log('\n  [G] MIDNIGHT SPILLOUT (today shift orders landing in next day):');
    console.log('      ' + spilloutOrders + ' orders, total=' + r(spilloutTotal));

    console.log('\n  [H] ORPHAN ORDERS (in calendar day, not in any shift window):');
    if (orphanOrders.length === 0) {
      console.log('      None');
    } else {
      orphanOrders.forEach(o => {
        const fl = o.floor_id === BAR ? 'BAR' : (o.floor_id === REST ? 'REST' : 'F' + o.floor_id);
        console.log('      #' + o.order_number + ' | ' + o.status + ' | ' + o.order_type + ' | ' + fl + ' | ' + parseFloat(o.total_amount) + ' | ' + o.created_at);
      });
    }

    // Try to explain the gap
    console.log('\n  [ANALYSIS] Trying to explain the gap:');
    console.log('      Provided total:                 ' + day.total);
    console.log('      POS stored total:               ' + r(storedTotal));
    console.log('      GAP:                            ' + r(diffFromStored));
    console.log('      + Cancelled orders:             ' + r(cancBar + cancRest));
    console.log('      + Due collections today:        ' + r(dc));
    console.log('      + Spillover from prev day:      ' + r(spilloverTotal));
    console.log('      - Spillout to next day:         ' + r(spilloutTotal));
    const explained = storedTotal + cancBar + cancRest + dc + spilloverTotal - spilloutTotal;
    console.log('      = Explained total:              ' + r(explained));
    console.log('      REMAINING UNEXPLAINED GAP:      ' + r(day.total - explained));
  }

  // ===== 4. GRAND SUMMARY =====
  console.log('\n' + '='.repeat(140));
  console.log('GRAND SUMMARY (7 DAYS)');
  console.log('='.repeat(140));
  console.log('  PROVIDED grand total:      ' + grandProvided);
  console.log('  POS stored grand total:    ' + r(grandStored));
  console.log('  Calendar day grand total:  ' + r(grandCalendar));
  console.log('  Shift window grand total:  ' + r(grandShiftWindow));
  console.log('  GAP (Provided - Stored):   ' + r(grandProvided - grandStored));
  console.log('  GAP (Provided - Calendar): ' + r(grandProvided - grandCalendar));

  // ===== 5. CHECK: Does the app report match stored? =====
  console.log('\n' + '='.repeat(140));
  console.log('VERIFICATION: Does closeCashDrawer stored value match actual orders?');
  console.log('='.repeat(140));
  for (const sh of shifts) {
    if (!sh.opening_time || !sh.closing_time) continue;
    const [actual] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as sales
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = 46 AND o.created_at >= ? AND o.created_at <= ? AND o.status = 'completed'
         AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`,
      [sh.opening_time, sh.closing_time, sh.floor_id, sh.cashier_id]
    );
    const actualSales = parseFloat(actual[0].sales);
    const storedSales = parseFloat(sh.total_sales);
    const diff = r(storedSales - actualSales);
    const fl = sh.floor_id === BAR ? 'BAR ' : 'REST';
    if (Math.abs(diff) > 1) {
      console.log('  Shift ' + sh.id + ' ' + sh.session_date.substring(0, 10) + ' ' + fl + ': stored=' + storedSales + ' actual=' + actualSales + ' DIFF=' + diff + ' ***MISMATCH***');
    } else {
      console.log('  Shift ' + sh.id + ' ' + sh.session_date.substring(0, 10) + ' ' + fl + ': stored=' + storedSales + ' actual=' + actualSales + ' OK');
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
