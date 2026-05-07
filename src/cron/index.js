const cron = require('node-cron');
const logger = require('../utils/logger');
const config = require('../config');
const { addJob } = require('../queues');
const { QUEUE_NAMES, REPORT_TYPE } = require('../constants');
const dynoService = require('../services/dyno.service');
const onlineOrderService = require('../services/onlineOrder.service');
const subscriptionService = require('../services/subscription.service');
const { SUBSCRIPTION_NOTIFICATION_TYPE } = require('../constants');

const jobs = [];

const initializeCronJobs = () => {
  // Report aggregation - every 5 minutes
  const reportAggregation = cron.schedule(
    config.app.reportAggregationInterval,
    async () => {
      logger.info('Running report aggregation cron job');
      try {
        await addJob(QUEUE_NAMES.REPORT, 'aggregate-reports', {
          type: REPORT_TYPE.DAILY_SALES,
          dateRange: { start: new Date().toISOString().split('T')[0] },
        });
      } catch (error) {
        logger.error('Report aggregation cron failed:', error);
      }
    },
    { scheduled: false }
  );
  jobs.push(reportAggregation);

  // Daily cleanup - every day at 3 AM
  const dailyCleanup = cron.schedule(
    '0 3 * * *',
    async () => {
      logger.info('Running daily cleanup cron job');
      try {
        // Cleanup old sessions, logs, etc.
        await cleanupOldSessions();
        await cleanupOldLogs();
      } catch (error) {
        logger.error('Daily cleanup cron failed:', error);
      }
    },
    { scheduled: false }
  );
  jobs.push(dailyCleanup);

  // Hourly inventory check
  const inventoryCheck = cron.schedule(
    '0 * * * *',
    async () => {
      logger.info('Running inventory check cron job');
      try {
        await addJob(QUEUE_NAMES.INVENTORY, 'check-low-stock', {});
      } catch (error) {
        logger.error('Inventory check cron failed:', error);
      }
    },
    { scheduled: false }
  );
  jobs.push(inventoryCheck);

  // NOTE: Dyno order polling disabled - Dyno is a push-based system
  // Dyno client pushes orders to POST /api/v1/dyno/orders
  // No polling needed - orders come via webhook

  // Self-order session cleanup - every 10 minutes
  const selfOrderCleanup = cron.schedule(
    '*/10 * * * *',
    async () => {
      try {
        const selfOrderService = require('../services/selfOrder.service');
        await selfOrderService.expireStaleSessions();
      } catch (error) {
        logger.error('Self-order session cleanup cron failed:', error);
      }
    },
    { scheduled: false }
  );
  jobs.push(selfOrderCleanup);

  // Subscription renewal scan — daily at 9 AM
  //   • 10-day reminder  • 3-day reminder  • Expiry → grace  • Grace end → hard stop
  const subscriptionScan = cron.schedule(
    '0 9 * * *',
    async () => {
      logger.info('Running subscription renewal scan');
      try {
        const result = await subscriptionService.scanExpiringSubscriptions();
        const totalNotifications =
          result.reminder10Days.length +
          result.reminder3Days.length +
          result.expiredToday.length +
          result.graceEndedToday.length;

        // Log notifications (downstream email/WhatsApp via BullMQ)
        for (const item of result.reminder10Days) {
          await subscriptionService.logNotification(
            item.outletId,
            SUBSCRIPTION_NOTIFICATION_TYPE.RENEWAL_REMINDER_10D,
            'in_app',
            { subscriptionEnd: item.subscriptionEnd }
          );
          await addJob(QUEUE_NAMES.NOTIFICATION, 'subscription-reminder-10d', { outletId: item.outletId });
        }
        for (const item of result.reminder3Days) {
          await subscriptionService.logNotification(
            item.outletId,
            SUBSCRIPTION_NOTIFICATION_TYPE.RENEWAL_REMINDER_3D,
            'in_app',
            { subscriptionEnd: item.subscriptionEnd }
          );
          await addJob(QUEUE_NAMES.NOTIFICATION, 'subscription-reminder-3d', { outletId: item.outletId });
        }
        for (const item of result.expiredToday) {
          await subscriptionService.logNotification(
            item.outletId,
            SUBSCRIPTION_NOTIFICATION_TYPE.EXPIRED,
            'in_app',
            { subscriptionEnd: item.subscriptionEnd }
          );
          await addJob(QUEUE_NAMES.NOTIFICATION, 'subscription-expired', { outletId: item.outletId });
        }
        for (const item of result.graceEndedToday) {
          await subscriptionService.logNotification(
            item.outletId,
            SUBSCRIPTION_NOTIFICATION_TYPE.GRACE_ENDED,
            'in_app',
            { gracePeriodEnd: item.gracePeriodEnd }
          );
          await addJob(QUEUE_NAMES.NOTIFICATION, 'subscription-grace-ended', { outletId: item.outletId });
        }

        logger.info(`Subscription scan complete: ${totalNotifications} notifications queued`);
      } catch (error) {
        logger.error('Subscription scan cron failed:', error);
      }
    },
    { scheduled: false }
  );
  jobs.push(subscriptionScan);

  // Start all jobs
  jobs.forEach((job) => job.start());
  logger.info(`Started ${jobs.length} cron jobs`);
};

const cleanupOldSessions = async () => {
  logger.debug('Cleaning up old sessions');
  // Implementation will delete expired sessions from database/redis
};

const cleanupOldLogs = async () => {
  logger.debug('Cleaning up old logs');
  // Implementation will archive/delete old log entries
};

/**
 * Poll Dyno APIs for new orders from all active channels
 */
const pollDynoOrders = async () => {
  const { getPool } = require('../database');
  const pool = getPool();
  
  try {
    // Get all active integration channels
    const [channels] = await pool.query(
      `SELECT id, channel_name, property_id, outlet_id 
       FROM integration_channels 
       WHERE is_active = 1 AND dyno_access_token IS NOT NULL`
    );

    if (channels.length === 0) {
      return;
    }

    logger.debug(`Polling ${channels.length} Dyno channels for orders`);

    for (const channel of channels) {
      try {
        // Fetch orders from Dyno API
        const orders = await dynoService.pollNewOrders(channel.id);
        
        if (orders && orders.length > 0) {
          logger.info(`Dyno polling: Found ${orders.length} orders from ${channel.channel_name}`, {
            channelId: channel.id,
            propertyId: channel.property_id
          });

          // Process each order
          for (const order of orders) {
            try {
              const orderId = order.orderId || order.order_id || order.id;
              
              // Check if order already exists
              const [existing] = await pool.query(
                'SELECT id FROM online_orders WHERE external_order_id = ? AND channel_id = ?',
                [orderId, channel.id]
              );

              if (existing.length > 0) {
                logger.debug(`Dyno polling: Order ${orderId} already exists, skipping`);
                continue;
              }

              // Normalize and process the order
              const normalizedData = {
                external_order_id: orderId,
                platform: channel.channel_name.toLowerCase(),
                channel_id: channel.id,
                outlet_id: channel.outlet_id,
                customer: {
                  name: order.customer?.name || order.customerName || `${channel.channel_name} Customer`,
                  phone: order.customer?.phone || order.customerPhone || order.customer?.mobile,
                  address: order.customer?.address || order.deliveryAddress || '',
                  instructions: order.instructions || order.special_instructions || ''
                },
                items: (order.items || order.cart?.items || []).map(item => ({
                  external_item_id: item.id || item.item_id,
                  name: item.name || item.item_name,
                  quantity: parseInt(item.quantity) || 1,
                  unit_price: parseFloat(item.price || item.unit_price || 0),
                  total_price: parseFloat(item.total || item.total_price || 0),
                  variant_id: item.variant?.id || item.variant_id,
                  variant_name: item.variant?.name || item.variant_name,
                  instructions: item.instructions || '',
                  addons: (item.addons || item.add_ons || []).map(addon => ({
                    external_addon_id: addon.id || addon.addon_id,
                    name: addon.name || addon.addon_name,
                    price: parseFloat(addon.price || 0)
                  }))
                })),
                payment: {
                  method: order.paymentMethod || order.payment?.method || 'online',
                  is_paid: order.isPaid !== false,
                  subtotal: parseFloat(order.subtotal || order.charges?.subtotal || 0),
                  taxes: parseFloat(order.taxes || order.charges?.taxes || 0),
                  delivery_charge: parseFloat(order.deliveryCharge || order.charges?.delivery_charge || 0),
                  packaging_charge: parseFloat(order.packagingCharge || order.charges?.packaging_charge || 0),
                  discount: parseFloat(order.discount || order.charges?.discount || 0),
                  total: parseFloat(order.total || order.orderTotal || order.charges?.total || 0)
                },
                timing: {
                  placed_at: order.orderTime || order.created_at || new Date().toISOString(),
                  expected_delivery: order.expectedDeliveryTime || order.delivery_time
                },
                raw_data: order
              };

              // Process via onlineOrderService
              const webhookPayload = {
                event: 'order.new',
                data: normalizedData
              };

              const result = await onlineOrderService.processIncomingOrder(webhookPayload, channel.id);
              
              logger.info(`Dyno polling: Order ${orderId} processed successfully`, {
                onlineOrderId: result.onlineOrderId,
                posOrderNumber: result.orderNumber
              });

            } catch (orderError) {
              logger.error(`Dyno polling: Failed to process order`, {
                orderId: order.orderId || order.order_id,
                error: orderError.message
              });
            }
          }
        }
      } catch (channelError) {
        logger.error(`Dyno polling: Failed for channel ${channel.id}`, {
          channel: channel.channel_name,
          error: channelError.message
        });
      }
    }
  } catch (error) {
    logger.error('Dyno polling: Database error', { error: error.message });
  }
};

const stopCronJobs = () => {
  jobs.forEach((job) => job.stop());
  logger.info('All cron jobs stopped');
};

module.exports = {
  initializeCronJobs,
  stopCronJobs,
};
