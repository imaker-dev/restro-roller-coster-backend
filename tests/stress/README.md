# Stress Testing Suite for Restaurant POS

A comprehensive stress testing toolkit to identify bottlenecks and optimize performance.

## Quick Start

```bash
# Run basic stress test
node tests/stress/stress-test.js

# Run specific scenario
node tests/stress/load-test-scenarios.js normal
node tests/stress/load-test-scenarios.js lunchRush
node tests/stress/load-test-scenarios.js endOfDay
node tests/stress/load-test-scenarios.js spike

# Monitor database during tests (run in separate terminal)
node tests/stress/db-monitor.js
```

## Test Files

| File | Purpose |
|------|---------|
| `stress-test.js` | General stress test with configurable users/requests |
| `load-test-scenarios.js` | Real-world scenario simulations |
| `db-monitor.js` | Live database monitoring during tests |

## Scenarios

### 1. Normal Operations (`normal`)
- **Users:** 5 concurrent
- **Duration:** 60 seconds
- Simulates regular business hours

### 2. Lunch Rush (`lunchRush`)
- **Users:** 15 concurrent
- **Duration:** 60 seconds
- Simulates peak lunch hours with heavy order activity

### 3. End of Day (`endOfDay`)
- **Users:** 3 concurrent
- **Duration:** 30 seconds
- Simulates shift closing and report generation

### 4. Spike Test (`spike`)
- **Users:** 30 concurrent
- **Duration:** 30 seconds
- Simulates sudden traffic surge

## Configuration

Set environment variables to customize:

```bash
# Custom server URL
set TEST_URL=http://localhost:3005

# Custom auth token
set AUTH_TOKEN=your_jwt_token
```

Or modify `CONFIG` in the test files.

## Metrics Monitored

### API Metrics
- ⏱️ Response times (min, max, avg, P50, P95, P99)
- 📊 Requests per second (throughput)
- ❌ Error rate
- 📈 Per-endpoint breakdown

### System Metrics
- 🧠 CPU usage
- 💾 RAM usage
- 🔄 Active threads

### Database Metrics
- 🗄️ Connection pool status
- 📋 Query patterns
- 🐌 Slow queries
- 📊 Table sizes and indexes

## Interpreting Results

### Response Time Thresholds
| Metric | Good | Warning | Critical |
|--------|------|---------|----------|
| P50 | < 100ms | 100-300ms | > 300ms |
| P95 | < 500ms | 500-1000ms | > 1000ms |
| P99 | < 1000ms | 1-3s | > 3s |

### Bottleneck Indicators

| Symptom | Likely Cause | Solution |
|---------|--------------|----------|
| CPU > 90% | CPU bottleneck | Scale horizontally, optimize code |
| Memory > 85% | Memory leak | Check for leaks, increase RAM |
| P95 > 1s | Slow queries | Add indexes, optimize queries |
| Error rate > 1% | Capacity issue | Scale up, check connection pool |
| DB connections maxed | Pool exhaustion | Increase pool size |

## Recommended Test Workflow

1. **Baseline Test**
   ```bash
   node tests/stress/load-test-scenarios.js normal
   ```
   Record baseline metrics.

2. **Start DB Monitor** (separate terminal)
   ```bash
   node tests/stress/db-monitor.js
   ```

3. **Run Stress Test**
   ```bash
   node tests/stress/stress-test.js
   ```

4. **Run Peak Simulation**
   ```bash
   node tests/stress/load-test-scenarios.js lunchRush
   ```

5. **Spike Test**
   ```bash
   node tests/stress/load-test-scenarios.js spike
   ```

6. **Analyze Results**
   - Check for slow endpoints
   - Review error patterns
   - Identify optimization opportunities

## Common Optimizations

Based on test results, consider:

1. **Database**
   - Add missing indexes
   - Enable query caching
   - Optimize N+1 queries
   - Increase connection pool

2. **Application**
   - Add Redis caching for menu/categories
   - Implement response compression
   - Use connection pooling

3. **Infrastructure**
   - Horizontal scaling (PM2 cluster)
   - Load balancer
   - CDN for static assets
