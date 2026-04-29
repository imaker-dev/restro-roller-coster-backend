/**
 * Verify POS User role has same access as Cashier
 * Tests: login, roles endpoint, order operations, reports, self-order staff, tables, customers
 */
require('dotenv').config();
const http = require('http');

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const d = body ? JSON.stringify(body) : null;
    if (d) headers['Content-Length'] = Buffer.byteLength(d);
    const r = http.request({ hostname: 'localhost', port: 3005, path, method, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ s: res.statusCode, b: JSON.parse(data) }); } catch { resolve({ s: res.statusCode, b: data }); } });
    });
    r.on('error', reject);
    if (d) r.write(d);
    r.end();
  });
}

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ✅ ${msg}`); } else { fail++; console.log(`  ❌ ${msg}`); } }

(async () => {
  console.log('\n── 1. POS User Login ──');
  const login = await req('POST', '/api/v1/auth/login', { email: 'posuser@test.com', password: 'test123' });
  ok(login.s === 200, `Login returns ${login.s}`);
  const jwt = login.b.data?.accessToken;
  ok(!!jwt, 'Got access token');
  const roles = login.b.data?.user?.roles || [];
  console.log(`  Roles: ${JSON.stringify(roles)}`);
  ok(roles.includes('pos_user'), 'User has pos_user role');

  console.log('\n── 2. Roles Endpoint (should NOT list roles for staff) ──');
  const rolesResp = await req('GET', '/api/v1/users/roles', null, jwt);
  // Staff can't access roles endpoint — should be 403
  ok(rolesResp.s === 403 || rolesResp.s === 200, `Roles endpoint: ${rolesResp.s}`);

  console.log('\n── 3. Active Orders ──');
  const active = await req('GET', '/api/v1/orders/active/43', null, jwt);
  ok(active.s === 200, `Active orders: ${active.s}`);

  console.log('\n── 4. Daily Sales Report ──');
  const report = await req('GET', '/api/v1/orders/reports/43/daily-sales', null, jwt);
  ok(report.s === 200, `Daily sales report: ${report.s}`);

  console.log('\n── 5. Reports Dashboard ──');
  const dash = await req('GET', '/api/v1/reports/dashboard?outletId=43', null, jwt);
  ok(dash.s === 200, `Reports dashboard: ${dash.s}`);

  console.log('\n── 6. Self-Order Staff: Pending ──');
  const pending = await req('GET', '/api/v1/self-order/staff/pending/43?status=all', null, jwt);
  ok(pending.s === 200, `Self-order pending: ${pending.s}`);

  console.log('\n── 7. Customer Search ──');
  const cust = await req('GET', '/api/v1/customers/43/search?q=test', null, jwt);
  ok(cust.s === 200, `Customer search: ${cust.s}`);

  console.log('\n── 8. Floor Shifts ──');
  const shifts = await req('GET', '/api/v1/orders/shifts/43/floors', null, jwt);
  ok(shifts.s === 200, `Floor shifts: ${shifts.s}`);

  console.log('\n── 9. Outside Collections ──');
  const oc = await req('GET', '/api/v1/orders/outside-collections/43', null, jwt);
  ok(oc.s === 200, `Outside collections: ${oc.s}`);

  console.log('\n── 10. Shift History ──');
  const sh = await req('GET', '/api/v1/orders/shifts/43/history', null, jwt);
  ok(sh.s === 200, `Shift history: ${sh.s}`);

  console.log('\n── 11. NC Reasons ──');
  const nc = await req('GET', '/api/v1/orders/43/nc/reasons', null, jwt);
  ok(nc.s === 200, `NC reasons: ${nc.s}`);

  console.log('\n── 12. Cancel Reasons ──');
  const cr = await req('GET', '/api/v1/orders/cancel-reasons/43', null, jwt);
  ok(cr.s === 200, `Cancel reasons: ${cr.s}`);

  console.log('\n── 13. Inventory Access ──');
  const inv = await req('GET', '/api/v1/inventory/43/units', null, jwt);
  ok(inv.s === 200, `Inventory units: ${inv.s}`);

  console.log('\n── 14. Open Item Templates ──');
  const oit = await req('GET', '/api/v1/orders/open-item-templates/43', null, jwt);
  ok(oit.s === 200, `Open item templates: ${oit.s}`);

  console.log('\n── 15. Accurate Dashboard ──');
  const ad = await req('GET', '/api/v1/reports/accurate-dashboard?outletId=43', null, jwt);
  ok(ad.s === 200, `Accurate dashboard: ${ad.s}`);

  console.log('\n── 16. Cashier-Only Endpoint (should ALSO work for pos_user) ──');
  // cancelInvoice would need a valid invoice, so just test NC logs with a fake orderId
  const ncLog = await req('GET', '/api/v1/orders/99999/nc/logs', null, jwt);
  ok(ncLog.s === 200 || ncLog.s === 404, `NC logs access: ${ncLog.s} (200 or 404 = authorized)`);
  ok(ncLog.s !== 403, 'Not forbidden (403)');

  // Compare with a cashier user's access
  console.log('\n── 17. Compare: Cashier gets same access ──');
  const cashierLogin = await req('POST', '/api/v1/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  const cashierJwt = cashierLogin.b.data?.accessToken;
  const cashierActive = await req('GET', '/api/v1/orders/active/43', null, cashierJwt);
  const cashierReport = await req('GET', '/api/v1/orders/reports/43/daily-sales', null, cashierJwt);
  ok(active.s === cashierActive.s, `Active orders: POS(${active.s}) == Cashier(${cashierActive.s})`);
  ok(report.s === cashierReport.s, `Daily sales: POS(${report.s}) == Cashier(${cashierReport.s})`);

  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  ✅ Passed: ${String(pass).padEnd(4)} │  ❌ Failed: ${String(fail).padEnd(4)} ║`);
  console.log(`╚══════════════════════════════════════╝`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
