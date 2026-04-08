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

  const r = n => Math.round(n * 100) / 100;

  // Get shifts
  const [shifts] = await pool.query(
    `SELECT id, floor_id, cashier_id, session_date, opening_time, closing_time, total_sales
     FROM day_sessions WHERE outlet_id = 46 AND session_date BETWEEN '2026-04-01' AND '2026-04-07'
     ORDER BY session_date, floor_id`
  );

  console.log('='.repeat(140));
  console.log('COMPREHENSIVE MISMATCH ANALYSIS: PROVIDED vs POS SYSTEM');
  console.log('Floor 38 (First Floor) = BAR | Floor 39 (Third Floor) = RESTAURANT');
  console.log('='.repeat(140));

  let totalDiffBar = 0, totalDiffRest = 0;
  let totalMissing = 0;

  for (const dateStr of Object.keys(provided)) {
    const prov = provided[dateStr];
    const dayShifts = shifts.filter(s => s.session_date.substring(0,10) === dateStr);
    const barShifts = dayShifts.filter(s => s.floor_id === BAR_FLOOR);
    const restShifts = dayShifts.filter(s => s.floor_id === REST_FLOOR);
    
    const storedBar = barShifts.reduce((s, x) => s + parseFloat(x.total_sales), 0);
    const storedRest = restShifts.reduce((s, x) => s + parseFloat(x.total_sales), 0);
    const storedTotal = storedBar + storedRest;

    // Due collections RECEIVED today (for ANY previous order)
    const [dueColl] = await pool.query(
      `SELECT COALESCE(SUM(p.total_amount),0) as amt, COUNT(*) as cnt
       FROM payments p WHERE p.outlet_id = 46 AND p.created_at BETWEEN ? AND ?
         AND p.status = 'completed' AND p.is_due_collection = 1 AND p.payment_mode != 'split'`,
      [dateStr + ' 00:00:00', dateStr + ' 23:59:59']
    );

    // Cancelled orders for the day
    const [cancelled] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ? AND status = 'cancelled'`,
      [dateStr + ' 00:00:00', dateStr + ' 23:59:59']
    );

    // NC (no charge) orders
    const [ncOrders] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(nc_amount),0) as amt
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ? AND is_nc = 1 AND status = 'completed'`,
      [dateStr + ' 00:00:00', dateStr + ' 23:59:59']
    );

    // Adjustment orders
    const [adjOrders] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(adjustment_amount),0) as amt
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ? AND is_adjustment = 1 AND status = 'completed'`,
      [dateStr + ' 00:00:00', dateStr + ' 23:59:59']
    );

    // Partial/due orders (completed but not fully paid)
    const [partialOrders] = await pool.query(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(total_amount),0) as total, COALESCE(SUM(due_amount),0) as due
       FROM orders WHERE outlet_id = 46 AND created_at BETWEEN ? AND ? AND status = 'completed' AND payment_status = 'partial'`,
      [dateStr + ' 00:00:00', dateStr + ' 23:59:59']
    );

    const diffBar = prov.bar - storedBar;
    const diffRest = prov.restaurant - storedRest;
    const diffTotal = prov.total - storedTotal;
    totalDiffBar += diffBar;
    totalDiffRest += diffRest;

    const dc = parseFloat(dueColl[0].amt);
    const canc = parseFloat(cancelled[0].total);

    // Hypotheses
    const h1 = storedTotal + dc; // stored + due collections
    const h2 = storedTotal + canc; // stored + cancelled
    const h3 = storedTotal + dc + canc; // stored + due + cancelled

    console.log('\n--- ' + dateStr + ' ---');
    console.log('  PROVIDED:    Bar=' + prov.bar + '  Rest=' + prov.restaurant + '  Total=' + prov.total);
    console.log('  POS STORED:  Bar=' + r(storedBar) + '  Rest=' + r(storedRest) + '  Total=' + r(storedTotal));
    console.log('  DIFFERENCE:  Bar=' + r(diffBar) + '  Rest=' + r(diffRest) + '  Total=' + r(diffTotal));
    console.log('  ---');
    console.log('  Due collected today:     ' + r(dc) + ' (' + dueColl[0].cnt + ' payments)');
    console.log('  Cancelled orders:        ' + r(canc) + ' (' + cancelled[0].cnt + ' orders)');
    console.log('  NC orders:               ' + r(parseFloat(ncOrders[0].amt)) + ' (' + ncOrders[0].cnt + ' orders)');
    console.log('  Adjustment orders:       ' + r(parseFloat(adjOrders[0].amt)) + ' (' + adjOrders[0].cnt + ' orders)');
    console.log('  Partial/due orders:      due=' + r(parseFloat(partialOrders[0].due)) + ' (' + partialOrders[0].cnt + ' orders, total=' + r(parseFloat(partialOrders[0].total)) + ')');
    console.log('  ---');
    console.log('  H1 (Stored+DueColl):     ' + r(h1) + '  diff from provided=' + r(prov.total - h1));
    console.log('  H2 (Stored+Cancelled):   ' + r(h2) + '  diff from provided=' + r(prov.total - h2));
    console.log('  H3 (Stored+Due+Cancel):  ' + r(h3) + '  diff from provided=' + r(prov.total - h3));

    if (Math.abs(diffTotal) > 1000) {
      totalMissing += diffTotal;
      console.log('  *** SIGNIFICANT MISMATCH: ' + r(diffTotal) + ' ***');
    } else {
      console.log('  OK (within 1000)');
    }
  }

  // Check if there are other outlets or orders outside outlet 46
  const [outlets] = await pool.query('SELECT id, name FROM outlets ORDER BY id');
  console.log('\n=== ALL OUTLETS ===');
  outlets.forEach(o => console.log('  Outlet ' + o.id + ': ' + o.name));

  // Check if there are orders in OTHER outlets that share the same physical location
  const [otherOutletOrders] = await pool.query(
    `SELECT o.outlet_id, out.name as outlet_name, COUNT(*) as cnt, COALESCE(SUM(o.total_amount),0) as total
     FROM orders o JOIN outlets out ON o.outlet_id = out.id
     WHERE o.outlet_id != 46 AND o.created_at BETWEEN '2026-04-01' AND '2026-04-07 23:59:59' AND o.status = 'completed'
     GROUP BY o.outlet_id, out.name`
  );
  console.log('\n=== ORDERS IN OTHER OUTLETS (Apr 1-7) ===');
  if (otherOutletOrders.length === 0) {
    console.log('  None');
  } else {
    otherOutletOrders.forEach(o => console.log('  Outlet ' + o.outlet_id + ' (' + o.outlet_name + '): ' + o.cnt + ' orders, total=' + r(parseFloat(o.total))));
  }

  console.log('\n=== SUMMARY ===');
  console.log('  Total Bar diff (7 days):  ' + r(totalDiffBar));
  console.log('  Total Rest diff (7 days): ' + r(totalDiffRest));
  console.log('  Total Overall diff:       ' + r(totalDiffBar + totalDiffRest));
  console.log('  Total "missing" revenue:  ' + r(totalMissing) + ' (days with >1000 diff)');

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
