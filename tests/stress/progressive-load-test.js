/**
 * Progressive Load Test - Tests with 10, 100, and 1000 concurrent users
 * 
 * Usage: node tests/stress/progressive-load-test.js
 */

const http = require('http');
const os = require('os');
const { performance } = require('perf_hooks');

const CONFIG = {
  baseUrl: process.env.TEST_URL || 'http://localhost:3005',
  authToken: process.env.AUTH_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInV1aWQiOiIwMTNiZWQ4Ni05ZDYzLTQ2ZjctYmExNy1mMTYxYjkwMGM0NzEiLCJlbWFpbCI6ImFkbWluQHJlc3Ryb3Bvcy5jb20iLCJyb2xlcyI6WyJzdXBlcl9hZG1pbiJdLCJvdXRsZXRJZCI6NDMsImlhdCI6MTc3NDk1ODk5OCwiZXhwIjoxNzc3NTUwOTk4LCJpc3MiOiJyZXN0cm8tcG9zIn0.wD0yos_XnTmFTrGhkMvZY-5O8zT8B3tYj_qPrWiMkdE',
  outletId: 43
};

// Test levels
const TEST_LEVELS = [
  { users: 10, requestsPerUser: 10, name: '10 Users' },
  { users: 100, requestsPerUser: 5, name: '100 Users' },
  { users: 1000, requestsPerUser: 2, name: '1000 Users' }
];

// Endpoints to test (verified working endpoints)
const ENDPOINTS = [
  { method: 'GET', path: `/api/v1/menu/${CONFIG.outletId}`, name: 'Full Menu' },
  { method: 'GET', path: `/api/v1/menu/${CONFIG.outletId}/captain`, name: 'Captain Menu' },
  { method: 'GET', path: `/api/v1/orders/shifts/${CONFIG.outletId}/history?limit=5`, name: 'Shift History' },
  { method: 'GET', path: `/api/v1/inventory/${CONFIG.outletId}/items`, name: 'Inventory' },
  { method: 'GET', path: `/api/v1/orders/shifts/119/detail`, name: 'Shift Detail' },
  { method: 'GET', path: `/api/v1/reports/day-end-summary/detail?outletId=${CONFIG.outletId}&date=2026-03-31`, name: 'Day Summary' },
];

// Results storage
const allResults = [];

// Make HTTP request
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
      timeout: 60000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          endpoint: endpoint.name,
          status: res.statusCode,
          duration: performance.now() - startTime,
          success: res.statusCode >= 200 && res.statusCode < 400
        });
      });
    });
    
    req.on('error', (err) => {
      resolve({
        endpoint: endpoint.name,
        status: 0,
        duration: performance.now() - startTime,
        success: false,
        error: err.code || err.message
      });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({
        endpoint: endpoint.name,
        status: 0,
        duration: 60000,
        success: false,
        error: 'TIMEOUT'
      });
    });
    
    req.end();
  });
}

// Get system metrics
function getSystemMetrics() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  });
  
  return {
    cpuPercent: ((1 - totalIdle / totalTick) * 100).toFixed(1),
    memPercent: (((totalMem - freeMem) / totalMem) * 100).toFixed(1),
    memUsedGB: ((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(2)
  };
}

// Calculate statistics
function calcStats(times) {
  if (!times.length) return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0].toFixed(0),
    max: sorted[sorted.length - 1].toFixed(0),
    avg: (sum / sorted.length).toFixed(0),
    p50: sorted[Math.floor(sorted.length * 0.5)].toFixed(0),
    p95: sorted[Math.floor(sorted.length * 0.95)].toFixed(0),
    p99: sorted[Math.floor(sorted.length * 0.99)].toFixed(0)
  };
}

// Run single user simulation
async function simulateUser(requestCount) {
  const results = [];
  for (let i = 0; i < requestCount; i++) {
    const endpoint = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
    const result = await makeRequest(endpoint);
    results.push(result);
    // Small delay between requests
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
  }
  return results;
}

// Run test level
async function runTestLevel(level) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🔄 Testing: ${level.name} (${level.users} concurrent × ${level.requestsPerUser} requests each)`);
  console.log(`   Total requests: ${level.users * level.requestsPerUser}`);
  console.log(`${'─'.repeat(60)}`);
  
  const metrics = {
    level: level.name,
    users: level.users,
    total: 0,
    success: 0,
    failed: 0,
    times: [],
    errors: {},
    systemMetrics: []
  };
  
  const startTime = Date.now();
  
  // Collect system metrics during test
  const metricsInterval = setInterval(() => {
    metrics.systemMetrics.push(getSystemMetrics());
  }, 500);
  
  // Progress tracking
  let completed = 0;
  const totalRequests = level.users * level.requestsPerUser;
  const progressInterval = setInterval(() => {
    const pct = ((completed / totalRequests) * 100).toFixed(0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r   Progress: ${pct}% | ${completed}/${totalRequests} | ${elapsed}s`);
  }, 200);
  
  // Start all users concurrently
  const userPromises = [];
  
  // Batch users to avoid overwhelming the system
  const batchSize = Math.min(level.users, 100);
  const batches = Math.ceil(level.users / batchSize);
  
  for (let batch = 0; batch < batches; batch++) {
    const batchUsers = Math.min(batchSize, level.users - batch * batchSize);
    const batchPromises = [];
    
    for (let i = 0; i < batchUsers; i++) {
      batchPromises.push(
        simulateUser(level.requestsPerUser).then(results => {
          results.forEach(r => {
            metrics.total++;
            completed++;
            if (r.success) {
              metrics.success++;
            } else {
              metrics.failed++;
              const errKey = r.error || `HTTP_${r.status}`;
              metrics.errors[errKey] = (metrics.errors[errKey] || 0) + 1;
            }
            metrics.times.push(r.duration);
          });
        })
      );
    }
    
    // Wait for batch to complete before starting next
    await Promise.all(batchPromises);
  }
  
  clearInterval(metricsInterval);
  clearInterval(progressInterval);
  
  const duration = (Date.now() - startTime) / 1000;
  const stats = calcStats(metrics.times);
  const rps = (metrics.total / duration).toFixed(1);
  
  // Calculate avg system metrics
  const avgCpu = metrics.systemMetrics.length > 0
    ? (metrics.systemMetrics.reduce((s, m) => s + parseFloat(m.cpuPercent), 0) / metrics.systemMetrics.length).toFixed(1)
    : 'N/A';
  const maxCpu = metrics.systemMetrics.length > 0
    ? Math.max(...metrics.systemMetrics.map(m => parseFloat(m.cpuPercent))).toFixed(1)
    : 'N/A';
  const avgMem = metrics.systemMetrics.length > 0
    ? (metrics.systemMetrics.reduce((s, m) => s + parseFloat(m.memPercent), 0) / metrics.systemMetrics.length).toFixed(1)
    : 'N/A';
  
  // Print results
  console.log(`\n\n   📊 Results for ${level.name}:`);
  console.log(`   ${'─'.repeat(50)}`);
  console.log(`   Requests:      ${metrics.total} total | ${metrics.success} success | ${metrics.failed} failed`);
  console.log(`   Success Rate:  ${((metrics.success / metrics.total) * 100).toFixed(1)}%`);
  console.log(`   Duration:      ${duration.toFixed(1)}s`);
  console.log(`   Throughput:    ${rps} req/s`);
  console.log(`   ${'─'.repeat(50)}`);
  console.log(`   Response Times (ms):`);
  console.log(`     Min: ${stats.min} | Avg: ${stats.avg} | Max: ${stats.max}`);
  console.log(`     P50: ${stats.p50} | P95: ${stats.p95} | P99: ${stats.p99}`);
  console.log(`   ${'─'.repeat(50)}`);
  console.log(`   System Metrics:`);
  console.log(`     CPU: ${avgCpu}% avg | ${maxCpu}% max`);
  console.log(`     Memory: ${avgMem}%`);
  
  if (Object.keys(metrics.errors).length > 0) {
    console.log(`   ${'─'.repeat(50)}`);
    console.log(`   Errors:`);
    Object.entries(metrics.errors).forEach(([err, count]) => {
      console.log(`     ${err}: ${count}`);
    });
  }
  
  // Store for final summary
  allResults.push({
    level: level.name,
    users: level.users,
    total: metrics.total,
    success: metrics.success,
    failed: metrics.failed,
    successRate: ((metrics.success / metrics.total) * 100).toFixed(1),
    duration: duration.toFixed(1),
    rps,
    avgMs: stats.avg,
    p95Ms: stats.p95,
    p99Ms: stats.p99,
    avgCpu,
    maxCpu,
    avgMem,
    errors: metrics.errors
  });
  
  // Cool down between levels
  console.log(`\n   ⏳ Cooling down for 3 seconds...`);
  await new Promise(r => setTimeout(r, 3000));
}

// Print final summary
function printFinalSummary() {
  console.log('\n' + '═'.repeat(70));
  console.log('                    📊 PROGRESSIVE LOAD TEST SUMMARY');
  console.log('═'.repeat(70));
  
  console.log('\n┌─────────────┬─────────┬──────────┬─────────┬─────────┬─────────┬─────────┐');
  console.log('│ Level       │ Success │ Req/s    │ Avg(ms) │ P95(ms) │ CPU Max │ Errors  │');
  console.log('├─────────────┼─────────┼──────────┼─────────┼─────────┼─────────┼─────────┤');
  
  allResults.forEach(r => {
    const level = r.level.padEnd(11);
    const success = `${r.successRate}%`.padEnd(7);
    const rps = r.rps.padEnd(8);
    const avg = r.avgMs.padEnd(7);
    const p95 = r.p95Ms.padEnd(7);
    const cpu = `${r.maxCpu}%`.padEnd(7);
    const errors = String(r.failed).padEnd(7);
    console.log(`│ ${level} │ ${success} │ ${rps} │ ${avg} │ ${p95} │ ${cpu} │ ${errors} │`);
  });
  
  console.log('└─────────────┴─────────┴──────────┴─────────┴─────────┴─────────┴─────────┘');
  
  // Analysis
  console.log('\n🔍 ANALYSIS:');
  console.log('─'.repeat(50));
  
  const issues = [];
  
  allResults.forEach(r => {
    if (parseFloat(r.successRate) < 99) {
      issues.push(`⚠️  ${r.level}: Success rate ${r.successRate}% (below 99%)`);
    }
    if (parseFloat(r.p95Ms) > 1000) {
      issues.push(`⚠️  ${r.level}: P95 latency ${r.p95Ms}ms (above 1s)`);
    }
    if (parseFloat(r.maxCpu) > 90) {
      issues.push(`🔴 ${r.level}: CPU peaked at ${r.maxCpu}% (bottleneck)`);
    }
    if (r.failed > 0) {
      Object.entries(r.errors).forEach(([err, count]) => {
        issues.push(`❌ ${r.level}: ${count}x ${err}`);
      });
    }
  });
  
  if (issues.length === 0) {
    console.log('✅ All tests passed without issues!');
  } else {
    issues.forEach(i => console.log(`  ${i}`));
  }
  
  // Recommendations
  console.log('\n💡 RECOMMENDATIONS:');
  console.log('─'.repeat(50));
  
  const lastResult = allResults[allResults.length - 1];
  if (lastResult) {
    if (parseFloat(lastResult.successRate) < 95) {
      console.log('  • Consider horizontal scaling (PM2 cluster mode)');
      console.log('  • Increase database connection pool size');
    }
    if (parseFloat(lastResult.p95Ms) > 500) {
      console.log('  • Add Redis caching for frequently accessed data');
      console.log('  • Review and optimize slow database queries');
      console.log('  • Add database indexes for common query patterns');
    }
    if (parseFloat(lastResult.maxCpu) > 80) {
      console.log('  • Consider load balancing across multiple instances');
      console.log('  • Profile CPU-intensive operations');
    }
  }
  
  console.log('\n' + '═'.repeat(70));
}

// Main
async function main() {
  console.log('═'.repeat(70));
  console.log('        🚀 PROGRESSIVE LOAD TEST (10 → 100 → 1000 Users)');
  console.log('═'.repeat(70));
  console.log(`\n📋 Configuration:`);
  console.log(`   Server: ${CONFIG.baseUrl}`);
  console.log(`   Endpoints: ${ENDPOINTS.length} APIs`);
  console.log(`   Test Levels: ${TEST_LEVELS.map(l => l.users).join(' → ')} users`);
  
  // Verify server is running
  console.log('\n🔄 Verifying server connectivity...');
  const testResult = await makeRequest(ENDPOINTS[0]);
  if (!testResult.success) {
    console.log(`❌ Server not responding: ${testResult.error || testResult.status}`);
    process.exit(1);
  }
  console.log('✅ Server is responding');
  
  // Run all test levels
  for (const level of TEST_LEVELS) {
    await runTestLevel(level);
  }
  
  // Print final summary
  printFinalSummary();
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
