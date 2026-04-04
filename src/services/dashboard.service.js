/**
 * Dashboard Service
 * Real-time dashboard data — orders, KOTs, tables, amounts
 * Optimized: 2 parallel queries + in-memory aggregation
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const dashboardService = {
  /**
   * Get real-time dashboard data for an outlet
   * @param {number} outletId
   * @param {object} filters - { floorId, orderType }
   */
  async getRealtime(outletId, filters = {}) {
    const pool = getPool();
    const { floorId, orderType } = filters;

    // ── Build dynamic WHERE clauses ──
    let orderWhere = `o.outlet_id = ? AND o.status NOT IN ('paid', 'completed', 'cancelled')`;
    const orderParams = [outletId];

    let tableWhere = `t.outlet_id = ? AND t.is_active = 1 AND t.status IN ('occupied', 'billing', 'reserved')`;
    const tableParams = [outletId];

    if (floorId) {
      orderWhere += ' AND o.floor_id = ?';
      orderParams.push(floorId);
      tableWhere += ' AND t.floor_id = ?';
      tableParams.push(floorId);
    }
    if (orderType) {
      orderWhere += ' AND o.order_type = ?';
      orderParams.push(orderType);
    }

    // ── 2 parallel queries (all data in 2 round-trips) ──
    const [ordersResult, tablesResult] = await Promise.all([
      // Query 1: Active orders with KOT counts
      pool.query(
        `SELECT o.id, o.order_number, o.order_type, o.status, o.table_id, o.floor_id,
                o.subtotal, o.total_amount, o.guest_count, o.customer_name, o.created_at,
                COUNT(DISTINCT kt.id) as kot_count,
                SUM(CASE WHEN kt.status IN ('pending', 'accepted', 'preparing') THEN 1 ELSE 0 END) as pending_kot_count
         FROM orders o
         LEFT JOIN kot_tickets kt ON o.id = kt.order_id AND kt.status != 'cancelled'
         WHERE ${orderWhere}
         GROUP BY o.id`,
        orderParams
      ),
      // Query 2: Occupied/billing/reserved tables with session + order info
      pool.query(
        `SELECT t.id, t.table_number, t.name, t.status, t.capacity, t.floor_id,
                f.name as floor_name,
                ts.id as session_id, ts.guest_count, ts.guest_name, ts.started_at,
                u.name as captain_name,
                o.id as order_id, o.order_number, o.total_amount as order_amount,
                o.subtotal as order_subtotal, o.status as order_status, o.order_type,
                TIMESTAMPDIFF(MINUTE, ts.started_at, NOW()) as session_duration
         FROM tables t
         JOIN floors f ON t.floor_id = f.id
         LEFT JOIN table_sessions ts ON t.id = ts.table_id AND ts.status IN ('active', 'billing')
         LEFT JOIN users u ON ts.started_by = u.id
         LEFT JOIN orders o ON ts.order_id = o.id AND o.status NOT IN ('paid', 'completed', 'cancelled')
         WHERE ${tableWhere}
         ORDER BY f.floor_number, t.display_order, t.table_number`,
        tableParams
      )
    ]);

    const orders = ordersResult[0];
    const tables = tablesResult[0];

    // ── In-memory aggregation (zero additional DB calls) ──

    // Orders breakdown
    let totalOrderCount = 0;
    let totalOrderAmount = 0;
    let pendingCount = 0; // orders with at least 1 pending KOT

    let dineInCount = 0, dineInKots = 0, dineInAmount = 0;
    let pickupCount = 0, pickupAmount = 0;
    let deliveryCount = 0, deliveryAmount = 0;

    // Pending breakdown
    let notReadyCount = 0, notReadyAmount = 0;       // KOTs not ready yet
    let notPickedUpCount = 0, notPickedUpAmount = 0;  // takeaway ready but not served
    let notDeliveredCount = 0, notDeliveredAmount = 0; // delivery ready but not delivered

    for (const o of orders) {
      const amount = parseFloat(o.total_amount) || 0;
      const kots = parseInt(o.kot_count) || 0;
      const pendingKots = parseInt(o.pending_kot_count) || 0;

      totalOrderCount++;
      totalOrderAmount += amount;

      if (pendingKots > 0) pendingCount++;

      switch (o.order_type) {
        case 'dine_in':
          dineInCount++;
          dineInKots += kots;
          dineInAmount += amount;
          break;
        case 'takeaway':
          pickupCount++;
          pickupAmount += amount;
          break;
        case 'delivery':
        case 'online':
          deliveryCount++;
          deliveryAmount += amount;
          break;
      }

      // Pending sub-categories
      if (pendingKots > 0) {
        // Has KOTs that are not ready
        notReadyCount++;
        notReadyAmount += amount;
      } else if (o.order_type === 'takeaway' && o.status === 'ready') {
        notPickedUpCount++;
        notPickedUpAmount += amount;
      } else if ((o.order_type === 'delivery' || o.order_type === 'online') && o.status === 'ready') {
        notDeliveredCount++;
        notDeliveredAmount += amount;
      }
    }

    // Tables summary
    let totalTables = 0;
    let totalGuests = 0;
    let totalTableAmount = 0;

    const formattedTables = [];
    for (const t of tables) {
      totalTables++;
      const guests = parseInt(t.guest_count) || 0;
      const orderAmt = parseFloat(t.order_amount) || 0;
      totalGuests += guests;
      totalTableAmount += orderAmt;

      formattedTables.push({
        id: t.id,
        tableNumber: t.table_number,
        name: t.name,
        status: t.status,
        capacity: t.capacity,
        floorId: t.floor_id,
        floorName: t.floor_name,
        sessionId: t.session_id || null,
        guestCount: guests,
        guestName: t.guest_name || null,
        captainName: t.captain_name || null,
        sessionDuration: t.session_duration || 0,
        startedAt: t.started_at || null,
        orderId: t.order_id || null,
        orderNumber: t.order_number || null,
        orderType: t.order_type || null,
        orderStatus: t.order_status || null,
        orderAmount: orderAmt,
        orderSubtotal: parseFloat(t.order_subtotal) || 0
      });
    }

    // Round amounts to 2 decimal places
    const r2 = (n) => Math.round(n * 100) / 100;

    return {
      summary: {
        orders: {
          totalCount: totalOrderCount,
          totalAmount: r2(totalOrderAmount),
          pendingCount
        },
        tables: {
          totalTables,
          totalGuests,
          totalAmount: r2(totalTableAmount)
        }
      },
      orders: {
        dineIn: {
          count: dineInCount,
          kots: dineInKots,
          amount: r2(dineInAmount)
        },
        pickup: {
          count: pickupCount,
          amount: r2(pickupAmount)
        },
        delivery: {
          count: deliveryCount,
          amount: r2(deliveryAmount)
        },
        pending: {
          notReady: {
            count: notReadyCount,
            amount: r2(notReadyAmount)
          },
          notPickedUp: {
            count: notPickedUpCount,
            amount: r2(notPickedUpAmount)
          },
          notDelivered: {
            count: notDeliveredCount,
            amount: r2(notDeliveredAmount)
          }
        }
      },
      tables: formattedTables
    };
  }
};

module.exports = dashboardService;
