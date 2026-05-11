#!/usr/bin/env node
require('dotenv').config();
const Redis = require('ioredis');
const r = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

r.keys('subscription:status:*').then(async (keys) => {
  if (!keys.length) {
    console.log('No subscription cache keys found');
  } else {
    console.log('Deleting', keys.length, 'keys:', keys);
    await r.del(...keys);
    console.log('Done — cache cleared');
  }
  r.disconnect();
}).catch((e) => {
  console.error('Error:', e.message);
  r.disconnect();
  process.exit(1);
});
