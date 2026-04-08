/**
 * Cross-verification: DSR vs Shift totals for Outlet 46, Apr 1–6 2026
 * For each business day (4am→4am):
 *   1. DSR total = SUM(total_amount) of completed orders
 *   2. Floor-wise breakdown
 *   3. Shift totals (recalculated with FIXED filter — cashier-based takeaway)
 *   4. Stored shift values (from day_sessions — may have old buggy values)
 *   5. Check: SUM(shift recalc) == DSR total
 *   6. Payment cross-verification per shift
 */
const mysql = require('mysql2/promise');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dc = require('../src/config/database.config');

const OUTLET = 46;
const DATES = ['2026-04-01','2026-04-02','2026-04-03','2026-04-04','2026-04-05','2026-04-06'];

function api(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL('http://localhost:3005/api/v1' + url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } }); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const pool = await mysql.createPool({ host: dc.host, port: dc.port, user: dc.user, password: dc.password, database: dc.database });

  // Login
  const lr = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  const token = lr.data.accessToken;

  // Get all floors
  const [floors] = await pool.query('SELECT id, name FROM floors WHERE outlet_id = ?', [OUTLET]);
  const floorMap = {};
  for (const f of floors) floorMap[f.id] = f.name;

  // Get all shifts
  const [allShifts] = await pool.query(
    `SELECT ds.*, u.name as cashier_name FROM day_sessions ds 
     LEFT JOIN users u ON ds.cashier_id = u.id
     WHERE ds.outlet_id = ? AND ds.session_date >= ? AND ds.session_date <= ? 
     ORDER BY ds.session_date, ds.id`,
    [OUTLET, '2026-04-01', '2026-04-06']
  );

  let totalPass = 0, totalFail = 0;
  const results = [];

  for (const dateStr of DATES) {
    const bd_start = `${dateStr} 04:00:00`;
    const nextDate = new Date(dateStr);
    nextDate.setDate(nextDate.getDate() + 1);
    const nd = nextDate.toISOString().slice(0, 10);
    const bd_end = `${nd} 04:00:00`;

    console.log('\n' + '═'.repeat(90));
    console.log(`  BUSINESS DAY: ${dateStr} (4:00 AM → ${nd} 3:59:59 AM)`);
    console.log('═'.repeat(90));

    // 1. DSR total from DB
    const [dsrRow] = await pool.query(
      `SELECT COUNT(*) as cnt, SUM(total_amount) as total_sale, SUM(paid_amount) as paid, 
              SUM(due_amount) as due, SUM(discount_amount) as disc
       FROM orders WHERE outlet_id = ? AND created_at >= ? AND created_at < ? AND status = 'completed'`,
      [OUTLET, bd_start, bd_end]
    );
    const dsr = dsrRow[0];
    console.log(`\n  DB Orders: ${dsr.cnt} completed | total_sale=${dsr.total_sale} | paid=${dsr.paid} | due=${dsr.due}`);

    // 2. Floor-wise breakdown
    const [floorBreak] = await pool.query(
      `SELECT COALESCE(t.floor_id, 0) as fid, COUNT(*) as cnt, SUM(o.total_amount) as total
       FROM orders o LEFT JOIN tables t ON o.table_id = t.id
       WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at < ? AND o.status = 'completed'
       GROUP BY COALESCE(t.floor_id, 0)`,
      [OUTLET, bd_start, bd_end]
    );
    let floorSum = 0;
    console.log('\n  Floor breakdown:');
    for (const f of floorBreak) {
      const name = f.fid === 0 ? 'Takeaway/No-floor' : (floorMap[f.fid] || `floor_${f.fid}`);
      console.log(`    ${name.padEnd(20)} orders=${String(f.cnt).padStart(3)} total=${f.total}`);
      floorSum += parseFloat(f.total || 0);
    }
    console.log(`    ${'SUM'.padEnd(20)} ${' '.repeat(11)} total=${floorSum}`);

    // 3. Get shifts for this session_date
    const dayShifts = allShifts.filter(s => {
      let sd;
      if (s.session_date instanceof Date) {
        sd = `${s.session_date.getFullYear()}-${String(s.session_date.getMonth()+1).padStart(2,'0')}-${String(s.session_date.getDate()).padStart(2,'0')}`;
      } else {
        sd = String(s.session_date).slice(0, 10);
      }
      return sd === dateStr;
    });

    console.log(`\n  Shifts for this day: ${dayShifts.length}`);

    let shiftRecalcSum = 0;
    let shiftStoredSum = 0;
    let shiftRecalcOrders = 0;

    for (const shift of dayShifts) {
      const floorName = floorMap[shift.floor_id] || 'All';
      const shiftStart = shift.opening_time;
      const shiftEnd = shift.closing_time || new Date();

      console.log(`\n  ── Shift #${shift.id} (${floorName}, ${shift.cashier_name}) ──`);
      console.log(`     Status: ${shift.status} | Open: ${new Date(shiftStart).toLocaleString('en-IN', { hour12: false })} → Close: ${new Date(shiftEnd).toLocaleString('en-IN', { hour12: false })}`);
      console.log(`     Stored: total_sales=${shift.total_sales} orders=${shift.total_orders}`);

      // Recalculate with FIXED filter
      const floorFilter = shift.floor_id
        ? `AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`
        : '';
      const floorParams = shift.floor_id ? [shift.floor_id, shift.cashier_id] : [];

      // Orders recalc (using shift time range, same as closeCashDrawer)
      const [recalcRow] = await pool.query(
        `SELECT COUNT(*) as cnt, SUM(o.total_amount) as total_sale, SUM(o.paid_amount) as paid
         FROM orders o LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at <= ? AND o.status IN ('completed','paid')
         ${floorFilter}`,
        [OUTLET, shiftStart, shiftEnd, ...floorParams]
      );
      const recalc = recalcRow[0];
      const recalcTotal = parseFloat(recalc.total_sale || 0);
      const storedTotal = parseFloat(shift.total_sales || 0);

      console.log(`     Recalc: total_sales=${recalcTotal} orders=${recalc.cnt}`);
      const shiftMatch = Math.abs(recalcTotal - storedTotal) < 0.01;
      console.log(`     Stored vs Recalc: ${shiftMatch ? '✅ MATCH' : `❌ MISMATCH (stored=${storedTotal}, recalc=${recalcTotal}, diff=${storedTotal - recalcTotal})`}`);

      // Payment breakdown recalc (during shift time)
      const [payBreak] = await pool.query(
        `SELECT p.payment_mode, SUM(p.total_amount) as amt, COUNT(*) as cnt,
                SUM(CASE WHEN p.is_due_collection = 1 THEN p.total_amount ELSE 0 END) as due_coll
         FROM payments p JOIN orders o ON p.order_id = o.id LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? AND p.status = 'completed' AND p.payment_mode != 'split'
         ${floorFilter}`,
        [OUTLET, shiftStart, shiftEnd, ...floorParams]
      );
      const [splitBreak] = await pool.query(
        `SELECT sp.payment_mode, SUM(sp.amount) as amt, COUNT(*) as cnt
         FROM split_payments sp JOIN payments p ON sp.payment_id = p.id 
         JOIN orders o ON p.order_id = o.id LEFT JOIN tables t ON o.table_id = t.id
         WHERE p.outlet_id = ? AND p.created_at >= ? AND p.created_at <= ? AND p.status = 'completed' AND p.payment_mode = 'split'
         ${floorFilter}
         GROUP BY sp.payment_mode`,
        [OUTLET, shiftStart, shiftEnd, ...floorParams]
      );

      let payTotal = 0;
      for (const p of payBreak) {
        if (p.payment_mode) {
          console.log(`     Pay: ${p.payment_mode.padEnd(6)} = ${String(p.amt).padStart(8)} (${p.cnt} txns, due_coll=${p.due_coll})`);
          payTotal += parseFloat(p.amt || 0);
        }
      }
      for (const sp of splitBreak) {
        console.log(`     Split: ${sp.payment_mode.padEnd(5)} = ${String(sp.amt).padStart(7)} (${sp.cnt} txns)`);
        payTotal += parseFloat(sp.amt || 0);
      }
      console.log(`     Payment total = ${payTotal}`);

      if (!shiftMatch) totalFail++;
      else totalPass++;

      shiftRecalcSum += recalcTotal;
      shiftStoredSum += storedTotal;
      shiftRecalcOrders += parseInt(recalc.cnt || 0);
    }

    // 4. Also recalc using BUSINESS DAY boundaries (4am-4am) with fixed filter
    let bdShiftSum = 0;
    let bdShiftOrders = 0;
    console.log('\n  ── Business Day recalc (4am→4am, fixed filter) ──');
    for (const shift of dayShifts) {
      const floorFilter = shift.floor_id
        ? `AND (t.floor_id = ? OR (o.table_id IS NULL AND o.order_type != 'dine_in' AND o.created_by = ?))`
        : '';
      const floorParams = shift.floor_id ? [shift.floor_id, shift.cashier_id] : [];

      const [bdRow] = await pool.query(
        `SELECT COUNT(*) as cnt, SUM(o.total_amount) as total
         FROM orders o LEFT JOIN tables t ON o.table_id = t.id
         WHERE o.outlet_id = ? AND o.created_at >= ? AND o.created_at < ? AND o.status = 'completed'
         ${floorFilter}`,
        [OUTLET, bd_start, bd_end, ...floorParams]
      );
      const floorName = floorMap[shift.floor_id] || 'All';
      console.log(`    Shift#${shift.id} (${floorName}, ${shift.cashier_name}): orders=${bdRow[0].cnt} total=${bdRow[0].total}`);
      bdShiftSum += parseFloat(bdRow[0].total || 0);
      bdShiftOrders += parseInt(bdRow[0].cnt || 0);
    }

    // 5. API cross-check
    const dsrApi = await api('GET', `/reports/accurate-dsr?outletId=${OUTLET}&startDate=${dateStr}&endDate=${dateStr}`, null, token);
    const apiSummary = dsrApi.data?.summary || {};

    console.log(`\n  ── API DSR ──`);
    console.log(`    total_sale=${apiSummary.total_sale} paid=${apiSummary.total_paid_amount} due=${apiSummary.total_due_amount} orders=${apiSummary.total_orders}`);

    // 6. Final comparison
    const dsrTotal = parseFloat(dsr.total_sale || 0);
    const apiTotal = parseFloat(apiSummary.total_sale || 0);

    console.log('\n  ══ DAY SUMMARY ══');
    console.log(`    DSR DB total_sale          = ${dsrTotal}`);
    console.log(`    DSR API total_sale         = ${apiTotal}`);
    console.log(`    SUM shift stored           = ${shiftStoredSum}`);
    console.log(`    SUM shift recalc (shift TW)= ${shiftRecalcSum}`);
    console.log(`    SUM shift recalc (BD 4am)  = ${bdShiftSum}`);

    const dbApiMatch = Math.abs(dsrTotal - apiTotal) < 0.01;
    const bdShiftMatch = Math.abs(dsrTotal - bdShiftSum) < 0.01;
    const storedDelta = shiftStoredSum - dsrTotal;

    console.log(`\n    DB == API?                  ${dbApiMatch ? '✅ YES' : '❌ NO (diff=' + (dsrTotal - apiTotal) + ')'}`);
    console.log(`    SUM(shift BD recalc) == DSR?  ${bdShiftMatch ? '✅ YES' : '❌ NO (diff=' + (bdShiftSum - dsrTotal) + ')'}`);
    console.log(`    Stored shift sum - DSR     = ${storedDelta} ${Math.abs(storedDelta) < 0.01 ? '✅' : '⚠️  (takeaway double-count in stored values)'}`);

    if (dbApiMatch) totalPass++; else totalFail++;
    if (bdShiftMatch) totalPass++; else totalFail++;

    results.push({
      date: dateStr,
      dsrTotal,
      apiTotal,
      shiftStoredSum,
      bdShiftSum,
      dbApiMatch,
      bdShiftMatch,
      storedDelta,
      orders: parseInt(dsr.cnt),
      shifts: dayShifts.length
    });
  }

  // GRAND SUMMARY
  console.log('\n\n' + '═'.repeat(90));
  console.log('  GRAND SUMMARY — Outlet 46, Apr 1–6 2026');
  console.log('═'.repeat(90));
  console.log('  Date       | Orders | DSR Total | API Total | Shift Stored | BD Recalc | DB=API | Shifts=DSR | StoredΔ');
  console.log('  ' + '─'.repeat(105));
  for (const r of results) {
    console.log(
      `  ${r.date} | ${String(r.orders).padStart(6)} | ${String(r.dsrTotal).padStart(9)} | ${String(r.apiTotal).padStart(9)} | ` +
      `${String(r.shiftStoredSum).padStart(12)} | ${String(r.bdShiftSum).padStart(9)} | ` +
      `${r.dbApiMatch ? '  ✅  ' : '  ❌  '} | ${r.bdShiftMatch ? '    ✅    ' : '    ❌    '} | ${r.storedDelta}`
    );
  }

  const allDbApi = results.every(r => r.dbApiMatch);
  const allBdShift = results.every(r => r.bdShiftMatch);
  console.log('\n  All DB == API?           ' + (allDbApi ? '✅ ALL PASS' : '❌ SOME FAIL'));
  console.log('  All shifts == DSR?       ' + (allBdShift ? '✅ ALL PASS' : '❌ SOME FAIL'));
  console.log(`\n  Total checks: ${totalPass} pass, ${totalFail} fail`);

  await pool.end();
  process.exit(totalFail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
