/**
 * Sentry Integration Verification Test
 * 
 * Tests that Sentry integration doesn't affect existing functionality
 * Usage: node tests/stress/sentry-verification.js
 */

const http = require('http');
const { performance } = require('perf_hooks');

const CONFIG = {
  baseUrl: 'http://localhost:3005',
  authToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInV1aWQiOiIwMTNiZWQ4Ni05ZDYzLTQ2ZjctYmExNy1mMTYxYjkwMGM0NzEiLCJlbWFpbCI6ImFkbWluQHJlc3Ryb3Bvcy5jb20iLCJyb2xlcyI6WyJzdXBlcl9hZG1pbiJdLCJvdXRsZXRJZCI6NDMsImlhdCI6MTc3NDk1ODk5OCwiZXhwIjoxNzc3NTUwOTk4LCJpc3MiOiJyZXN0cm8tcG9zIn0.wD0yos_XnTmFTrGhkMvZY-5O8zT8B3tYj_qPrWiMkdE'
};

// Core API endpoints to verify
const CORE_ENDPOINTS = [
  { path: '/health', name: 'Health Check', auth: false },
  { path: '/api/v1/health', name: 'API Health', auth: false },
  { path: '/api/v1/menu/43', name: 'Menu', auth: true },
  { path: '/api/v1/menu/43/captain', name: 'Captain Menu', auth: true },
  { path: '/api/v1/orders/shifts/43/history?limit=5', name: 'Shift History', auth: true },
  { path: '/api/v1/orders/shifts/119/detail', name: 'Shift Detail', auth: true },
  { path: '/api/v1/inventory/43/items', name: 'Inventory', auth: true },
  { path: '/api/v1/app/versions', name: 'App Versions', auth: true },
  { path: '/api/v1/reports/day-end-summary/detail?outletId=43&date=2026-03-31', name: 'Day Summary', auth: true },
];

// Sentry-specific endpoints
const SENTRY_ENDPOINTS = [
  { path: '/api/v1/debug/sentry-test', name: 'Sentry Test API', auth: false, expectSuccess: true },
  { path: '/sentry-debug', name: 'Sentry Debug', auth: false, expectError: true },
];

function makeRequest(endpoint, expectError = false) {
  return new Promise((resolve) => {
    const startTime = performance.now();
    const url = new URL(endpoint.path, CONFIG.baseUrl);
    
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: 'GET',
      headers: endpoint.auth ? { 'Authorization': `Bearer ${CONFIG.authToken}` } : {},
      timeout: 10000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const duration = performance.now() - startTime;
        const success = expectError ? res.statusCode === 500 : (res.statusCode >= 200 && res.statusCode < 400);
        resolve({
          name: endpoint.name,
          path: endpoint.path,
          status: res.statusCode,
          duration: duration.toFixed(0),
          success,
          expectError
        });
      });
    });
    
    req.on('error', (err) => {
      resolve({
        name: endpoint.name,
        path: endpoint.path,
        status: 0,
        duration: 0,
        success: false,
        error: err.message
      });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({
        name: endpoint.name,
        path: endpoint.path,
        status: 0,
        duration: 10000,
        success: false,
        error: 'Timeout'
      });
    });
    
    req.end();
  });
}

async function runVerification() {
  console.log('═'.repeat(70));
  console.log('        🔍 SENTRY INTEGRATION VERIFICATION TEST');
  console.log('═'.repeat(70));
  console.log(`\nServer: ${CONFIG.baseUrl}\n`);
  
  // Test core endpoints
  console.log('📋 CORE API ENDPOINTS');
  console.log('─'.repeat(70));
  console.log('  Endpoint'.padEnd(25) + 'Status'.padEnd(10) + 'Time(ms)'.padEnd(12) + 'Result');
  console.log('─'.repeat(70));
  
  let corePass = 0, coreFail = 0;
  
  for (const endpoint of CORE_ENDPOINTS) {
    const result = await makeRequest(endpoint);
    const status = result.success ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${result.name.padEnd(23)} ${String(result.status).padEnd(10)} ${result.duration.padEnd(12)} ${status}`);
    if (result.success) corePass++; else coreFail++;
  }
  
  console.log('─'.repeat(70));
  console.log(`  Core APIs: ${corePass} passed, ${coreFail} failed\n`);
  
  // Test Sentry endpoints
  console.log('🔧 SENTRY ENDPOINTS');
  console.log('─'.repeat(70));
  
  for (const endpoint of SENTRY_ENDPOINTS) {
    const result = await makeRequest(endpoint, endpoint.expectError);
    const status = result.success ? '✅ PASS' : '❌ FAIL';
    const note = endpoint.expectError ? '(500 expected)' : '';
    console.log(`  ${result.name.padEnd(23)} ${String(result.status).padEnd(10)} ${result.duration.padEnd(12)} ${status} ${note}`);
  }
  
  console.log('─'.repeat(70));
  
  // Summary
  console.log('\n📊 SUMMARY');
  console.log('─'.repeat(40));
  
  if (coreFail === 0) {
    console.log('  ✅ All core APIs working correctly');
    console.log('  ✅ Sentry integration has NO impact on existing functionality');
  } else {
    console.log(`  ⚠️  ${coreFail} core API(s) failed - check server logs`);
  }
  
  console.log('\n' + '═'.repeat(70));
  
  // Check if Sentry is sending data
  console.log('\n💡 NEXT STEPS:');
  console.log('   1. Check Sentry dashboard: https://sentry.io');
  console.log('   2. Look for "Sentry test error" in Issues tab');
  console.log('   3. Verify environment shows as "development"');
  console.log('\n' + '═'.repeat(70));
}

runVerification().catch(console.error);
