/**
 * Load Test Scenarios - Simulates Real Restaurant Operations
 * 
 * Scenarios:
 * 1. Lunch Rush - High order volume
 * 2. Normal Operations - Steady traffic
 * 3. End of Day - Reports and shift closing
 * 
 * Usage: node tests/stress/load-test-scenarios.js [scenario]
 */

const http = require('http');
const { performance } = require('perf_hooks');

const CONFIG = {
  baseUrl: process.env.TEST_URL || 'http://localhost:3005',
  authToken: process.env.AUTH_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInV1aWQiOiIwMTNiZWQ4Ni05ZDYzLTQ2ZjctYmExNy1mMTYxYjkwMGM0NzEiLCJlbWFpbCI6ImFkbWluQHJlc3Ryb3Bvcy5jb20iLCJyb2xlcyI6WyJzdXBlcl9hZG1pbiJdLCJvdXRsZXRJZCI6NDMsImlhdCI6MTc3NDk1ODk5OCwiZXhwIjoxNzc3NTUwOTk4LCJpc3MiOiJyZXN0cm8tcG9zIn0.wD0yos_XnTmFTrGhkMvZY-5O8zT8B3tYj_qPrWiMkdE',
  outletId: 43
};

// Scenarios definition
const SCENARIOS = {
  // Lunch Rush: Multiple waiters taking orders simultaneously
  lunchRush: {
    name: '🍽️  Lunch Rush Simulation',
    description: 'Simulates peak lunch hours with multiple concurrent orders',
    duration: 60000, // 1 minute
    concurrentUsers: 15,
    actions: [
      { weight: 25, action: 'getMenu' },
      { weight: 20, action: 'getTables' },
      { weight: 20, action: 'getActiveOrders' },
      { weight: 15, action: 'getOrderDetails' },
      { weight: 10, action: 'searchItems' },
      { weight: 10, action: 'getCategories' }
    ]
  },

  // Normal Operations: Steady state
  normal: {
    name: '☀️  Normal Operations',
    description: 'Simulates regular business hours',
    duration: 60000,
    concurrentUsers: 5,
    actions: [
      { weight: 20, action: 'getMenu' },
      { weight: 20, action: 'getTables' },
      { weight: 15, action: 'getActiveOrders' },
      { weight: 15, action: 'getCategories' },
      { weight: 10, action: 'getCustomers' },
      { weight: 10, action: 'getInventory' },
      { weight: 10, action: 'getShiftHistory' }
    ]
  },

  // End of Day: Heavy reporting
  endOfDay: {
    name: '🌙 End of Day Reports',
    description: 'Simulates shift closing and report generation',
    duration: 30000,
    concurrentUsers: 3,
    actions: [
      { weight: 25, action: 'getDayEndSummary' },
      { weight: 25, action: 'getDailySales' },
      { weight: 20, action: 'getShiftHistory' },
      { weight: 15, action: 'getShiftDetail' },
      { weight: 15, action: 'getInventory' }
    ]
  },

  // Spike Test: Sudden traffic surge
  spike: {
    name: '📈 Spike Test',
    description: 'Simulates sudden traffic surge',
    duration: 30000,
    concurrentUsers: 30,
    actions: [
      { weight: 30, action: 'getMenu' },
      { weight: 30, action: 'getTables' },
      { weight: 20, action: 'getActiveOrders' },
      { weight: 20, action: 'getCategories' }
    ]
  }
};

// Action implementations
const ACTIONS = {
  getMenu: () => ({ method: 'GET', path: `/api/v1/menu/${CONFIG.outletId}/items` }),
  getCategories: () => ({ method: 'GET', path: `/api/v1/menu/${CONFIG.outletId}/categories` }),
  getTables: () => ({ method: 'GET', path: `/api/v1/orders/${CONFIG.outletId}/tables` }),
  getActiveOrders: () => ({ method: 'GET', path: `/api/v1/orders/${CONFIG.outletId}/active` }),
  getOrderDetails: () => ({ method: 'GET', path: `/api/v1/orders/${CONFIG.outletId}/active` }),
  searchItems: () => ({ method: 'GET', path: `/api/v1/menu/${CONFIG.outletId}/items?search=chicken` }),
  getCustomers: () => ({ method: 'GET', path: `/api/v1/customers?outletId=${CONFIG.outletId}&limit=20` }),
  getInventory: () => ({ method: 'GET', path: `/api/v1/inventory/${CONFIG.outletId}/items` }),
  getShiftHistory: () => ({ method: 'GET', path: `/api/v1/orders/shifts/${CONFIG.outletId}/history?limit=10` }),
  getShiftDetail: () => ({ method: 'GET', path: `/api/v1/orders/shifts/119/detail` }),
  getDayEndSummary: () => ({ method: 'GET', path: `/api/v1/reports/day-end-summary/detail?outletId=${CONFIG.outletId}&date=2026-03-31` }),
  getDailySales: () => ({ method: 'GET', path: `/api/v1/orders/reports/${CONFIG.outletId}/daily-sales/detail?date=2026-03-31` })
};

// HTTP request helper
function makeRequest(endpoint) {
  return new Promise((resolve) => {
    const startTime = performance.now();
    const url = new URL(endpoint.path, CONFIG.baseUrl);
    
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: endpoint.method,
      headers: {
        'Authorization': `Bearer ${CONFIG.authToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          duration: performance.now() - startTime,
          success: res.statusCode >= 200 && res.statusCode < 400
        });
      });
    });
    
    req.on('error', () => resolve({ status: 0, duration: performance.now() - startTime, success: false }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, duration: 30000, success: false }); });
    req.end();
  });
}

// Select weighted action
function selectAction(actions) {
  const total = actions.reduce((s, a) => s + a.weight, 0);
  let r = Math.random() * total;
  for (const a of actions) {
    r -= a.weight;
    if (r <= 0) return a.action;
  }
  return actions[0].action;
}

// Run scenario
async function runScenario(scenarioName) {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.log('Available scenarios:', Object.keys(SCENARIOS).join(', '));
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log(`           ${scenario.name}`);
  console.log('='.repeat(70));
  console.log(`\n📋 ${scenario.description}`);
  console.log(`   Duration: ${scenario.duration / 1000}s | Users: ${scenario.concurrentUsers}`);
  console.log('\n🔄 Running...\n');

  const metrics = { total: 0, success: 0, failed: 0, times: [], byAction: {} };
  const startTime = Date.now();
  const endTime = startTime + scenario.duration;

  // User simulation
  const userLoop = async (userId) => {
    while (Date.now() < endTime) {
      const actionName = selectAction(scenario.actions);
      const endpoint = ACTIONS[actionName]();
      const result = await makeRequest(endpoint);

      metrics.total++;
      if (result.success) metrics.success++;
      else metrics.failed++;
      
      metrics.times.push(result.duration);
      
      if (!metrics.byAction[actionName]) {
        metrics.byAction[actionName] = { count: 0, times: [], errors: 0 };
      }
      metrics.byAction[actionName].count++;
      metrics.byAction[actionName].times.push(result.duration);
      if (!result.success) metrics.byAction[actionName].errors++;

      // Random think time 50-200ms
      await new Promise(r => setTimeout(r, 50 + Math.random() * 150));
    }
  };

  // Progress display
  const progressInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const remaining = Math.max(0, (endTime - Date.now()) / 1000).toFixed(0);
    process.stdout.write(`\r⏱️  Elapsed: ${elapsed}s | Remaining: ${remaining}s | Requests: ${metrics.total} | Errors: ${metrics.failed}`);
  }, 500);

  // Start all users
  const users = [];
  for (let i = 0; i < scenario.concurrentUsers; i++) {
    users.push(userLoop(i));
  }
  await Promise.all(users);

  clearInterval(progressInterval);

  // Calculate stats
  const duration = (Date.now() - startTime) / 1000;
  const sorted = [...metrics.times].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];

  // Print results
  console.log('\n\n' + '='.repeat(70));
  console.log('                         📊 RESULTS');
  console.log('='.repeat(70));
  console.log(`\n  Total Requests:     ${metrics.total}`);
  console.log(`  Success Rate:       ${((metrics.success / metrics.total) * 100).toFixed(1)}%`);
  console.log(`  Requests/sec:       ${(metrics.total / duration).toFixed(2)}`);
  console.log(`  Avg Response:       ${avg.toFixed(2)}ms`);
  console.log(`  P95 Response:       ${p95.toFixed(2)}ms`);
  console.log(`  P99 Response:       ${p99.toFixed(2)}ms`);

  console.log('\n📈 BY ACTION:');
  console.log('-'.repeat(60));
  console.log('  Action'.padEnd(25) + 'Count'.padEnd(10) + 'Avg(ms)'.padEnd(12) + 'Errors');
  console.log('-'.repeat(60));
  
  Object.entries(metrics.byAction).forEach(([name, data]) => {
    const actionAvg = data.times.reduce((a, b) => a + b, 0) / data.times.length;
    console.log(`  ${name.padEnd(23)} ${String(data.count).padEnd(10)} ${actionAvg.toFixed(2).padEnd(12)} ${data.errors}`);
  });

  // Bottleneck detection
  console.log('\n🔍 ANALYSIS:');
  console.log('-'.repeat(40));
  
  if (p95 > 1000) console.log('  ⚠️  P95 > 1s: Consider caching');
  if (metrics.failed / metrics.total > 0.01) console.log('  🔴 Error rate > 1%: Check logs');
  if (avg > 500) console.log('  ⚠️  High avg latency: Review DB queries');
  
  Object.entries(metrics.byAction).forEach(([name, data]) => {
    const actionAvg = data.times.reduce((a, b) => a + b, 0) / data.times.length;
    if (actionAvg > 500) console.log(`  ⚠️  Slow: ${name} (${actionAvg.toFixed(0)}ms avg)`);
  });

  if (p95 < 500 && metrics.failed === 0) {
    console.log('  ✅ All metrics within acceptable range!');
  }

  console.log('\n' + '='.repeat(70));
}

// Main
const scenario = process.argv[2] || 'normal';
runScenario(scenario).catch(console.error);
