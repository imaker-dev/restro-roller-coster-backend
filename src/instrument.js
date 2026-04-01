/**
 * Sentry Instrumentation File
 * 
 * This file MUST be imported at the very top of the application entry point
 * before any other imports to ensure proper instrumentation.
 */

const Sentry = require("@sentry/node");

// Try to load profiling integration (may fail on some platforms)
let nodeProfilingIntegration = null;
try {
  nodeProfilingIntegration = require("@sentry/profiling-node").nodeProfilingIntegration;
} catch (err) {
  console.log('⚠️  Sentry profiling not available on this platform (optional feature)');
}

// DSN from environment or fallback to configured value
const dsn = process.env.SENTRY_DSN || "https://c8c38f99a22e486f71ca51d1cc9c3adb@o4511139135488000.ingest.de.sentry.io/4511139148070992";

if (dsn) {
  // Build integrations array
  const integrations = [];
  if (nodeProfilingIntegration) {
    integrations.push(nodeProfilingIntegration());
  }

  console.log('🔧 Initializing Sentry with DSN:', dsn.substring(0, 30) + '...');
  
  Sentry.init({
    dsn: dsn,
    
    // Enable debug mode to see what's happening
    debug: process.env.SENTRY_DEBUG === 'true',
    
    integrations: integrations,

    // Environment - auto-detect from NODE_ENV
    environment: process.env.NODE_ENV || 'development',
    
    // Release version - use package version or env variable
    release: process.env.SENTRY_RELEASE || require('../package.json').version || '1.0.0',
    
    // Server name for identifying production server
    serverName: process.env.SENTRY_SERVER_NAME || 'restro-backend',

    // Tracing - capture transactions for performance monitoring
    // Production: 20% sampling to stay within free tier limits
    // Development: 100% for full visibility
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    
    // Profiling - capture CPU profiles (only if profiling is available)
    profileSessionSampleRate: nodeProfilingIntegration ? (process.env.NODE_ENV === 'production' ? 0.1 : 1.0) : 0,
    profileLifecycle: 'trace',
    
    // Send default PII data (IP addresses, user agents, etc.)
    // Enable in production for better debugging
    sendDefaultPii: true,
    
    // Filter sensitive data
    beforeSend(event, hint) {
      // Remove sensitive headers
      if (event.request && event.request.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      
      // Remove sensitive data from request body
      if (event.request && event.request.data) {
        const sensitiveFields = ['password', 'token', 'secret', 'api_key', 'apiKey'];
        sensitiveFields.forEach(field => {
          if (typeof event.request.data === 'object' && event.request.data[field]) {
            event.request.data[field] = '[FILTERED]';
          }
        });
      }
      
      return event;
    },
    
    // Filter transactions - skip health checks
    beforeSendTransaction(event) {
      if (event.transaction && event.transaction.includes('/health')) {
        return null;
      }
      return event;
    },
    
    // Ignore common non-critical errors
    ignoreErrors: [
      'ECONNRESET',
      'ECONNREFUSED', 
      'ETIMEDOUT',
      'Network request failed',
      'Failed to fetch',
    ],
    
    // Additional context
    initialScope: {
      tags: {
        app: 'restro-pos-backend',
        component: 'api'
      }
    }
  });

  console.log('✅ Sentry initialized successfully');
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Traces: ${process.env.NODE_ENV === 'production' ? '20%' : '100%'}`);
} else {
  console.log('⚠️  Sentry DSN not configured. Monitoring disabled.');
  console.log('   To enable: Add SENTRY_DSN to .env file');
}

module.exports = Sentry;
