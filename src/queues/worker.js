require('dotenv').config();

const { Worker } = require('bullmq');
const redisConfig = require('../config/redis.config');
const { QUEUE_NAMES } = require('../constants');
const logger = require('../utils/logger');

// Import processors
const printProcessor = require('./processors/print.processor');
const notificationProcessor = require('./processors/notification.processor');
const reportProcessor = require('./processors/report.processor');
const dynoWebhookProcessor = require('./processors/dynoWebhook.processor');

const redisConnection = {
  host: redisConfig.host,
  port: redisConfig.port,
  password: redisConfig.password || undefined,
};

const workers = {};

const processors = {
  [QUEUE_NAMES.PRINT]: printProcessor,
  [QUEUE_NAMES.NOTIFICATION]: notificationProcessor,
  [QUEUE_NAMES.REPORT]: reportProcessor,
  [QUEUE_NAMES.DYNO_WEBHOOK]: dynoWebhookProcessor,
  [QUEUE_NAMES.EMAIL]: async (job) => {
    logger.info(`Processing email job: ${job.id}`);
    // Email processor will be implemented
  },
  [QUEUE_NAMES.WHATSAPP]: async (job) => {
    logger.info(`Processing WhatsApp job: ${job.id}`);
    // WhatsApp processor will be implemented
  },
  [QUEUE_NAMES.INVENTORY]: async (job) => {
    logger.info(`Processing inventory job: ${job.id}`);
    // Inventory processor will be implemented
  },
};

const createWorker = (queueName, processor) => {
  const worker = new Worker(queueName, processor, {
    connection: redisConnection,
    prefix: process.env.QUEUE_PREFIX || 'restro-pos',
    concurrency: 5,
    limiter: {
      max: 100,
      duration: 1000,
    },
  });

  worker.on('completed', (job) => {
    logger.debug(`Job ${job.id} in queue ${queueName} completed`);
  });

  worker.on('failed', (job, error) => {
    logger.error(`Job ${job?.id} in queue ${queueName} failed:`, error);
  });

  worker.on('error', (error) => {
    logger.error(`Worker ${queueName} error:`, error);
  });

  return worker;
};

const startWorkers = () => {
  for (const [queueName, processor] of Object.entries(processors)) {
    workers[queueName] = createWorker(queueName, processor);
    logger.info(`Worker started for queue: ${queueName}`);
  }
};

const stopWorkers = async () => {
  for (const [name, worker] of Object.entries(workers)) {
    await worker.close();
    logger.info(`Worker ${name} stopped`);
  }
};

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down workers...');
  await stopWorkers();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start workers if this file is run directly
if (require.main === module) {
  logger.info('Starting queue workers...');
  startWorkers();
}

module.exports = {
  startWorkers,
  stopWorkers,
  workers,
};
