const http = require('http');
const BASE = 'http://localhost:3005/api/v1';
let token;

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const req = http.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const lr = await api('POST', '/auth/login', { email: 'admin@restropos.com', password: 'admin123' });
  token = lr.data.accessToken;

  // Check running-dashboard response structure
  const rd = await api('GET', '/reports/accurate-running-dashboard?outletId=46&startDate=2026-04-01&endDate=2026-04-07');
  console.log('Running Dashboard (1-7):');
  console.log(JSON.stringify(rd, null, 2).slice(0, 3000));

  // Also daily-sales full structure
  const ds = await api('GET', '/orders/reports/46/daily-sales?startDate=2026-04-01&endDate=2026-04-07');
  console.log('\n\nDaily Sales summary:');
  console.log(JSON.stringify(ds.data?.summary, null, 2));
  console.log('\nDaily Sales per-day data (first 2):');
  if (ds.data?.data) {
    ds.data.data.slice(0, 2).forEach(d => console.log(JSON.stringify(d, null, 2).slice(0, 500)));
  }
})();
