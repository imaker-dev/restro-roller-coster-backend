/**
 * SigNoz OpenTelemetry Tracing Configuration
 * 
 * This file MUST be imported at the very top of the application entry point
 * BEFORE any other imports (including Sentry) to ensure proper instrumentation.
 * 
 * SigNoz uses OpenTelemetry for distributed tracing, metrics, and logs.
 * For self-hosted SigNoz, the OTEL collector endpoint is typically:
 * - http://<signoz-host>:4318/v1/traces (HTTP)
 * - http://<signoz-host>:4317 (gRPC)
 */

'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT } = require('@opentelemetry/semantic-conventions');

// Check if SigNoz/OTEL is enabled
const OTEL_ENABLED = process.env.OTEL_ENABLED === 'true';
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'restro-pos-backend';

let sdk = null;

if (OTEL_ENABLED) {
  console.log('🔧 Initializing SigNoz/OpenTelemetry tracing...');
  console.log(`   Service: ${SERVICE_NAME}`);
  console.log(`   Endpoint: ${OTEL_ENDPOINT}`);

  try {
    // Configure the OTLP exporter for SigNoz
    const traceExporter = new OTLPTraceExporter({
      url: OTEL_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS 
        ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS) 
        : {},
    });

    // Define service resource attributes
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: require('../package.json').version || '1.0.0',
      [ATTR_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
      'service.namespace': 'restro-pos',
      'service.instance.id': process.env.HOSTNAME || process.env.COMPUTERNAME || 'local',
    });

    // Initialize the OpenTelemetry SDK
    sdk = new NodeSDK({
      resource: resource,
      traceExporter: traceExporter,
      instrumentations: [
        getNodeAutoInstrumentations({
          // Instrument HTTP requests (Express routes)
          '@opentelemetry/instrumentation-http': {
            enabled: true,
            ignoreIncomingRequestHook: (req) => {
              // Ignore health checks and static files to reduce noise
              const url = req.url || '';
              return url === '/health' || 
                     url.startsWith('/uploads/') ||
                     url === '/favicon.ico';
            },
          },
          // Instrument Express framework
          '@opentelemetry/instrumentation-express': {
            enabled: true,
          },
          // Instrument MySQL queries
          '@opentelemetry/instrumentation-mysql2': {
            enabled: true,
          },
          // Instrument Redis operations
          '@opentelemetry/instrumentation-redis-4': {
            enabled: true,
          },
          '@opentelemetry/instrumentation-ioredis': {
            enabled: true,
          },
          // Instrument DNS lookups
          '@opentelemetry/instrumentation-dns': {
            enabled: true,
          },
          // Instrument net/socket operations
          '@opentelemetry/instrumentation-net': {
            enabled: true,
          },
          // Disable fs instrumentation (too noisy)
          '@opentelemetry/instrumentation-fs': {
            enabled: false,
          },
        }),
      ],
    });

    // Start the SDK
    sdk.start();
    console.log('✅ SigNoz/OpenTelemetry tracing initialized successfully');

    // Graceful shutdown
    const shutdown = async () => {
      try {
        await sdk.shutdown();
        console.log('🔧 OpenTelemetry SDK shut down successfully');
      } catch (err) {
        console.error('Error shutting down OpenTelemetry SDK:', err);
      }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (err) {
    console.error('❌ Failed to initialize SigNoz/OpenTelemetry:', err.message);
    console.log('   Tracing will be disabled. Application will continue without tracing.');
  }
} else {
  console.log('ℹ️  SigNoz/OpenTelemetry tracing disabled');
  console.log('   To enable: Set OTEL_ENABLED=true in .env');
}

module.exports = { sdk };
