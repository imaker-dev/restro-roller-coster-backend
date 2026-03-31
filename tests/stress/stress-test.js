/**
 * Stress Test Suite for Restaurant POS Backend
 * 
 * Monitors: CPU, RAM, DB queries, API response times
 * Usage: node tests/stress/stress-test.js
 */

const http = require('http');
const https = require('https');
const os = require('os');
const { performance } = require('perf_hooks');

// Configuration
const CONFIG = {
  baseUrl: process.env.TEST_URL || 'http://localhost:3005',
  authToken: process.env.AUTH_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInV1aWQiOiIwMTNiZWQ4Ni05ZDYzLTQ2ZjctYmExNy1mMTYxYjkwMGM0NzEiLCJlbWFpbCI6ImFkbWluQHJlc3Ryb3Bvcy5jb20iLCJyb2xlcyI6WyJzdXBlcl9hZG1pbiJdLCJvdXRsZXRJZCI6NDMsImlhdCI6MTc3NDk1ODk5OCwiZXhwIjoxNzc3NTUwOTk4LCJpc3MiOiJyZXN0cm8tcG9zIn0.wD0yos_XnTmFTrGhkMvZY-5O8zT8B3tYj_qPrWiMkdE',
  outletId: 43,
  
  // Test parameters
  concurrentUsers: 10,      // Simultaneous requests
  requestsPerUser: 20,      // Requests per user
  rampUpTime: 5000,         // Time to ramp up users (ms)
  thinkTime: 100,           // Delay between requests (ms)
};

// Metrics storage
const metrics = {
  requests: { total: 0, success: 0, failed: 0 },
  responseTimes: [],
  errors: [],
  startTime: null,
  endTime: null,
  systemMetrics: []
};

// API Endpoints to test (mix of read/write operations)
const ENDPOINTS = [
  // High-frequency read endpoints
  { method: 'GET', path: '/api/v1/menu/43/categories', weight: 20, name: 'Get Categories' },
  { method: 'GET', path: '/api/v1/menu/43/items', weight: 20, name: 'Get Menu Items' },
  { method: 'GET', path: '/api/v1/orders/43/tables', weight: 15, name: 'Get Tables' },
  { method: 'GET', path: '/api/v1/orders/43/active', weight: 15, name: 'Get Active Orders' },
  
  // Medium-frequency endpoints
  { method: 'GET', path: '/api/v1/orders/shifts/43/history?limit=10', weight: 10, name: 'Shift History' },
  { method: 'GET', path: '/api/v1/reports/day-end-summary/detail?outletId=43&date=2026-03-31', weight: 5, name: 'Day End Summary' },
  { method: 'GET', path: '/api/v1/orders/reports/43/daily-sales/detail?date=2026-03-31', weight: 5, name: 'Daily Sales' },
  
  // Low-frequency but heavy endpoints
  { method: 'GET', path: '/api/v1/inventory/43/items', weight: 5, name: 'Inventory Items' },
  { method: 'GET', path: '/api/v1/customers?outletId=43&limit=50', weight: 5, name: 'Customers List' },
];

// Weighted random endpoint selection
function selectEndpoint() {
  const totalWeight = ENDPOINTS.reduce((sum, e) => sum + e.weight, 0);
  let random = Math.random() * totalWeight;
  
  for (const endpoint of ENDPOINTS) {
    random -= endpoint.weight;
    if (random <= 0) return endpoint;
  }
  return ENDPOINTS[0];
}

// Make HTTP request with timing
function makeRequest(endpoint) {
  return new Promise((resolve) => {
    const startTime = performance.now();
    const url = new URL(endpoint.path, CONFIG.baseUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: endpoint.method,
      headers: {
        'Authorization': `Bearer ${CONFIG.authToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    };
    
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const endTime = performance.now();
        const duration = endTime - startTime;
        
        resolve({
          endpoint: endpoint.name,
          status: res.statusCode,
          duration,
          success: res.statusCode >= 200 && res.statusCode < 400,
          size: data.length
        });
      });
    });
    
    req.on('error', (error) => {
      const endTime = performance.now();
      resolve({
        endpoint: endpoint.name,
        status: 0,
        duration: endTime - startTime,
        success: false,
        error: error.message
      });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({
        endpoint: endpoint.name,
        status: 0,
        duration: 30000,
        success: false,
        error: 'Timeout'
      });
    });
    
    req.end();
  });
}

// Collect system metrics
function collectSystemMetrics() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  // Calculate CPU usage
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  const cpuUsage = ((1 - totalIdle / totalTick) * 100).toFixed(2);
  
  return {
    timestamp: Date.now(),
    cpu: parseFloat(cpuUsage),
    memUsed: (usedMem / 1024 / 1024 / 1024).toFixed(2),
    memTotal: (totalMem / 1024 / 1024 / 1024).toFixed(2),
    memPercent: ((usedMem / totalMem) * 100).toFixed(2)
  };
}

// Simulate a single user
async function simulateUser(userId, requestCount) {
  const userMetrics = [];
  
  for (let i = 0; i < requestCount; i++) {
    const endpoint = selectEndpoint();
    const result = await makeRequest(endpoint);
    
    metrics.requests.total++;
    if (result.success) {
      metrics.requests.success++;
    } else {
      metrics.requests.failed++;
      metrics.errors.push({ user: userId, request: i, ...result });
    }
    
    metrics.responseTimes.push({
      endpoint: result.endpoint,
      duration: result.duration,
      status: result.status
    });
    
    userMetrics.push(result);
    
    // Think time between requests
    if (CONFIG.thinkTime > 0) {
      await new Promise(r => setTimeout(r, CONFIG.thinkTime));
    }
  }
  
  return userMetrics;
}

// Print progress bar
function printProgress(current, total, startTime) {
  const percent = Math.round((current / total) * 100);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const bar = '█'.repeat(Math.floor(percent / 2)) + '░'.repeat(50 - Math.floor(percent / 2));
  
  process.stdout.write(`\r[${bar}] ${percent}% | ${current}/${total} requests | ${elapsed}s elapsed`);
}

// Calculate statistics
function calculateStats(times) {
  if (times.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  
  return {
    min: sorted[0].toFixed(2),
    max: sorted[sorted.length - 1].toFixed(2),
    avg: (sum / sorted.length).toFixed(2),
    p50: sorted[Math.floor(sorted.length * 0.5)].toFixed(2),
    p95: sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
    p99: sorted[Math.floor(sorted.length * 0.99)].toFixed(2)
  };
}

// Print results
function printResults() {
  const duration = (metrics.endTime - metrics.startTime) / 1000;
  const rps = (metrics.requests.total / duration).toFixed(2);
  
  console.log('\n\n' + '='.repeat(70));
  console.log('                    🔥 STRESS TEST RESULTS 🔥');
  console.log('='.repeat(70));
  
  // Summary
  console.log('\n📊 SUMMARY');
  console.log('-'.repeat(40));
  console.log(`  Total Requests:     ${metrics.requests.total}`);
  console.log(`  Successful:         ${metrics.requests.success} (${((metrics.requests.success/metrics.requests.total)*100).toFixed(1)}%)`);
  console.log(`  Failed:             ${metrics.requests.failed} (${((metrics.requests.failed/metrics.requests.total)*100).toFixed(1)}%)`);
  console.log(`  Duration:           ${duration.toFixed(2)}s`);
  console.log(`  Requests/sec:       ${rps}`);
  console.log(`  Concurrent Users:   ${CONFIG.concurrentUsers}`);
  
  // Response Time Stats
  const allTimes = metrics.responseTimes.map(r => r.duration);
  const stats = calculateStats(allTimes);
  
  console.log('\n⏱️  RESPONSE TIMES (ms)');
  console.log('-'.repeat(40));
  console.log(`  Min:                ${stats.min}`);
  console.log(`  Max:                ${stats.max}`);
  console.log(`  Average:            ${stats.avg}`);
  console.log(`  Median (P50):       ${stats.p50}`);
  console.log(`  P95:                ${stats.p95}`);
  console.log(`  P99:                ${stats.p99}`);
  
  // Per-endpoint breakdown
  console.log('\n📈 PER-ENDPOINT BREAKDOWN');
  console.log('-'.repeat(70));
  console.log('  Endpoint'.padEnd(30) + 'Count'.padEnd(8) + 'Avg(ms)'.padEnd(10) + 'P95(ms)'.padEnd(10) + 'Errors');
  console.log('-'.repeat(70));
  
  const endpointGroups = {};
  metrics.responseTimes.forEach(r => {
    if (!endpointGroups[r.endpoint]) {
      endpointGroups[r.endpoint] = { times: [], errors: 0 };
    }
    endpointGroups[r.endpoint].times.push(r.duration);
    if (r.status < 200 || r.status >= 400) {
      endpointGroups[r.endpoint].errors++;
    }
  });
  
  Object.entries(endpointGroups).forEach(([name, data]) => {
    const epStats = calculateStats(data.times);
    console.log(`  ${name.padEnd(28)} ${String(data.times.length).padEnd(8)} ${epStats.avg.padEnd(10)} ${epStats.p95.padEnd(10)} ${data.errors}`);
  });
  
  // System Metrics
  if (metrics.systemMetrics.length > 0) {
    const avgCpu = (metrics.systemMetrics.reduce((s, m) => s + m.cpu, 0) / metrics.systemMetrics.length).toFixed(2);
    const maxCpu = Math.max(...metrics.systemMetrics.map(m => m.cpu)).toFixed(2);
    const avgMem = (metrics.systemMetrics.reduce((s, m) => s + parseFloat(m.memPercent), 0) / metrics.systemMetrics.length).toFixed(2);
    
    console.log('\n🖥️  SYSTEM METRICS');
    console.log('-'.repeat(40));
    console.log(`  Avg CPU Usage:      ${avgCpu}%`);
    console.log(`  Max CPU Usage:      ${maxCpu}%`);
    console.log(`  Avg Memory Usage:   ${avgMem}%`);
  }
  
  // Bottleneck Analysis
  console.log('\n🔍 BOTTLENECK ANALYSIS');
  console.log('-'.repeat(40));
  
  const issues = [];
  
  if (parseFloat(stats.p95) > 1000) {
    issues.push('⚠️  P95 > 1000ms: API response times are slow');
  }
  if (parseFloat(stats.p99) > 3000) {
    issues.push('🔴 P99 > 3000ms: Severe latency spikes detected');
  }
  if (metrics.requests.failed / metrics.requests.total > 0.01) {
    issues.push('🔴 Error rate > 1%: API stability issues');
  }
  if (metrics.systemMetrics.length > 0) {
    const maxCpu = Math.max(...metrics.systemMetrics.map(m => m.cpu));
    if (maxCpu > 90) {
      issues.push('🔴 CPU > 90%: CPU bottleneck detected');
    }
    const maxMem = Math.max(...metrics.systemMetrics.map(m => parseFloat(m.memPercent)));
    if (maxMem > 85) {
      issues.push('⚠️  Memory > 85%: Memory pressure detected');
    }
  }
  
  // Check slow endpoints
  Object.entries(endpointGroups).forEach(([name, data]) => {
    const epStats = calculateStats(data.times);
    if (parseFloat(epStats.avg) > 500) {
      issues.push(`⚠️  Slow endpoint: ${name} (avg: ${epStats.avg}ms)`);
    }
  });
  
  if (issues.length === 0) {
    console.log('  ✅ No major bottlenecks detected!');
  } else {
    issues.forEach(issue => console.log(`  ${issue}`));
  }
  
  // Recommendations
  console.log('\n💡 RECOMMENDATIONS');
  console.log('-'.repeat(40));
  
  if (parseFloat(stats.avg) > 200) {
    console.log('  • Consider adding database indexes for slow queries');
    console.log('  • Enable query caching for frequently accessed data');
  }
  if (metrics.requests.failed > 0) {
    console.log('  • Review error logs for failed requests');
    console.log('  • Check database connection pool settings');
  }
  if (parseFloat(rps) < 50) {
    console.log('  • Consider horizontal scaling for higher throughput');
    console.log('  • Review async operations and connection pooling');
  }
  
  console.log('\n' + '='.repeat(70));
  
  // Show errors if any
  if (metrics.errors.length > 0 && metrics.errors.length <= 10) {
    console.log('\n❌ ERRORS (first 10):');
    metrics.errors.slice(0, 10).forEach(e => {
      console.log(`  [${e.endpoint}] ${e.error || `Status ${e.status}`}`);
    });
  }
}

// Main test runner
async function runStressTest() {
  console.log('='.repeat(70));
  console.log('           🚀 RESTAURANT POS STRESS TEST SUITE 🚀');
  console.log('='.repeat(70));
  console.log(`\n📋 Configuration:`);
  console.log(`   Base URL:          ${CONFIG.baseUrl}`);
  console.log(`   Concurrent Users:  ${CONFIG.concurrentUsers}`);
  console.log(`   Requests/User:     ${CONFIG.requestsPerUser}`);
  console.log(`   Total Requests:    ${CONFIG.concurrentUsers * CONFIG.requestsPerUser}`);
  console.log(`   Think Time:        ${CONFIG.thinkTime}ms`);
  console.log(`   Ramp-up Time:      ${CONFIG.rampUpTime}ms`);
  console.log('\n🔄 Starting test...\n');
  
  metrics.startTime = Date.now();
  
  // Start system metrics collection
  const metricsInterval = setInterval(() => {
    metrics.systemMetrics.push(collectSystemMetrics());
  }, 1000);
  
  // Progress tracking
  const totalRequests = CONFIG.concurrentUsers * CONFIG.requestsPerUser;
  const progressInterval = setInterval(() => {
    printProgress(metrics.requests.total, totalRequests, metrics.startTime);
  }, 500);
  
  // Ramp up users gradually
  const userPromises = [];
  const delayPerUser = CONFIG.rampUpTime / CONFIG.concurrentUsers;
  
  for (let i = 0; i < CONFIG.concurrentUsers; i++) {
    await new Promise(r => setTimeout(r, delayPerUser));
    userPromises.push(simulateUser(i + 1, CONFIG.requestsPerUser));
  }
  
  // Wait for all users to complete
  await Promise.all(userPromises);
  
  metrics.endTime = Date.now();
  
  // Stop intervals
  clearInterval(metricsInterval);
  clearInterval(progressInterval);
  
  // Print final results
  printResults();
}

// Run the test
runStressTest().catch(console.error);
