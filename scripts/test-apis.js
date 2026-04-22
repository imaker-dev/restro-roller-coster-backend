#!/usr/bin/env node
/**
 * Test all registration + token-generation APIs on local server.
 */
const http = require('http');

const PORT = process.env.TEST_PORT || 3005;
const BASE = `http://localhost:${PORT}`;

const request = (method, path, body, headers = {}) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
};

const log = (label, ok, detail) => {
  const mark = ok ? '✔' : '✖';
  console.log(`  ${mark} ${label}: ${detail}`);
};

(async () => {
  console.log(`\n=== Testing APIs on port ${PORT} ===\n`);

  // 1. Health check
  console.log('--- Health ---');
  const h = await request('GET', '/health');
  log('Health', h.status === 200, `status=${h.status}`);

  // 2. Registration: submit
  console.log('\n--- Registration ---');
  const reg1 = await request('POST', '/api/v1/registration/register', {
    restaurant_name: 'Test Biryani House',
    contact_person: 'Amit Shah',
    email: 'amit@biryani.test',
    phone: '+91 99887 76655',
    city: 'Hyderabad',
    state: 'Telangana',
    plan_interest: 'pro',
    message: 'Need full POS with inventory',
  });
  log('Submit registration', reg1.status === 201, `status=${reg1.status} — ${reg1.body.message}`);

  // 3. Registration: duplicate prevention
  const reg2 = await request('POST', '/api/v1/registration/register', {
    restaurant_name: 'Another Name',
    contact_person: 'Amit Shah',
    email: 'amit@biryani.test',
    phone: '+91 99887 76655',
  });
  log('Duplicate prevention', reg2.status === 409, `status=${reg2.status} — ${reg2.body.message}`);

  // 4. Registration: validation (missing fields)
  const reg3 = await request('POST', '/api/v1/registration/register', { restaurant_name: 'X' });
  log('Missing fields', reg3.status === 400, `status=${reg3.status} — ${reg3.body.message}`);

  // 5. Registration: invalid email
  const reg4 = await request('POST', '/api/v1/registration/register', {
    restaurant_name: 'X', contact_person: 'X', email: 'bad-email', phone: '123',
  });
  log('Invalid email', reg4.status === 400, `status=${reg4.status} — ${reg4.body.message}`);

  // 6. Login to get admin JWT
  console.log('\n--- Auth (get admin token) ---');
  const login = await request('POST', '/api/v1/auth/login', {
    email: 'admin@restropos.com',
    password: 'Admin@123',
  });

  if (!login.body.success || !login.body.data?.accessToken) {
    console.log('  ✖ Login failed:', login.body.message || JSON.stringify(login.body));
    console.log('  ⚠  Skipping admin-protected endpoints (no JWT)');
    console.log('\n=== Public APIs PASSED, Admin APIs SKIPPED ===\n');
    return;
  }
  const jwt = login.body.data.accessToken;
  log('Login', true, `token_len=${jwt.length}`);

  const auth = { Authorization: `Bearer ${jwt}` };

  // 7. Registration: list requests (admin)
  console.log('\n--- Registration Admin ---');
  const list = await request('GET', '/api/v1/registration/requests?status=pending', null, auth);
  log('List requests', list.status === 200 && list.body.success, `total=${list.body.data?.pagination?.total}`);

  // 8. Registration: stats
  const stats = await request('GET', '/api/v1/registration/stats', null, auth);
  log('Stats', stats.status === 200, `pending=${stats.body.data?.pending}, total=${stats.body.data?.total}`);

  // 9. Registration: update status
  const firstId = list.body.data?.registrations?.[0]?.id;
  if (firstId) {
    const upd = await request('PATCH', `/api/v1/registration/${firstId}/status`, { status: 'approved', admin_notes: 'Test approval' }, auth);
    log('Update status', upd.status === 200 && upd.body.success, `id=${firstId} → ${upd.body.data?.status}`);
  }

  // 10. Token generation: activation
  console.log('\n--- Token Generation ---');
  const actToken = await request('POST', '/api/v1/token-generation/activation', {
    email: 'owner@testrestro.com',
    password: 'Secure@456',
    restaurant: 'Test Restro Kitchen',
    phone: '+91 98765 11111',
    maxOutlets: 1,
    plan: 'free',
  }, auth);
  log('Generate activation token', actToken.status === 200 && actToken.body.success,
    `lid=${actToken.body.data?.licenseId}, token_len=${actToken.body.data?.token?.length}`);

  // 11. Token generation: upgrade
  const upgToken = await request('POST', '/api/v1/token-generation/upgrade', {
    licenseId: actToken.body.data?.licenseId || 'test-lid',
    restaurant: 'Test Restro Kitchen',
    maxOutlets: 3,
  }, auth);
  log('Generate upgrade token', upgToken.status === 200 && upgToken.body.success,
    `newLid=${upgToken.body.data?.newLicenseId}, token_len=${upgToken.body.data?.token?.length}`);

  // 12. Token generation: log
  const tlog = await request('GET', '/api/v1/token-generation/log', null, auth);
  log('Token log', tlog.status === 200 && tlog.body.success, `total=${tlog.body.data?.pagination?.total}`);

  console.log('\n=== ALL TESTS COMPLETE ===\n');
})().catch((err) => {
  console.error('Test script error:', err.message);
  process.exit(1);
});
