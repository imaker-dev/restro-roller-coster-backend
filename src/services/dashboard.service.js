/**
 * Dashboard Service
 * Real-time dashboard data — orders, KOTs, tables, amounts
 * Optimized: 2 parallel queries + in-memory join/aggregation + 5s Redis cache
 *
 * Key design:
 *  - Tables linked to orders via in-memory map (order.table_id) with session.order_id fallback
 *    (same robust pattern as table.service.getByFloor)
 *  - Table amounts come from the SAME orders data as orders summary → always match
 *  - Table status filter: NOT IN ('available') catches running, occupied, billing, reserved, blocked, merged
 *  - Session join uses MAX(id) subquery to prevent duplicate rows on edge-case multi-session
 */

const { getPool } = require('../database');
const { cache } = require('../config/redis');
const logger = require('../utils/logger');

const CACHE_TTL = 5; // 5 seconds

const dashboardService = {
  /**
   * Get real-time dashboard data for an outlet
   * @param {number} outletId
   * @param {object} filters - { floorId, orderType }
   */
  async getRealtime(outletId, filters = {}) {
    const { floorId, orderType } = filters;

    // ── 5-second Redis cache ──
    const cacheKey = `dashboard:rt:${outletId}:${floorId || 0}:${orderType || 'all'}`;
    try {
      const cached = await cache.get(cacheKey);
      if (cached) return cached;
    } catch (_) { /* redis down — continue without cache */ }

    const pool = getPool();

    // ── Build dynamic WHERE clauses ──
    let orderWhere = `o.outlet_id = ? AND o.status NOT IN ('paid', 'completed', 'cancelled')`;
    const orderParams = [outletId];

    // Tables: ALL non-available active tables (running, occupied, billing, reserved, blocked, merged)
    let tableWhere = `t.outlet_id = ? AND t.is_active = 1 AND t.status NOT IN ('available')`;
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

    // ── 2 parallel queries ──
    const [ordersResult, tablesResult] = await Promise.all([
      // Query 1: Active orders with KOT counts
      pool.query(
        `SELECT o.id, o.order_number, o.order_type, o.status, o.table_id, o.floor_id,
                o.table_session_id, o.subtotal, o.discount_amount, o.tax_amount,
                o.total_amount, o.guest_count, o.customer_name, o.created_at,
                COUNT(DISTINCT kt.id) as kot_count,
                COALESCE(SUM(CASE WHEN kt.status IN ('pending', 'accepted', 'preparing') THEN 1 ELSE 0 END), 0) as pending_kot_count
         FROM orders o
         LEFT JOIN kot_tickets kt ON o.id = kt.order_id AND kt.status != 'cancelled'
         WHERE ${orderWhere}
         GROUP BY o.id`,
        orderParams
      ),
      // Query 2: ALL non-available tables with latest session + floor info
      // Uses MAX(id) subquery to guarantee 1 row per table even with edge-case duplicate sessions
      pool.query(
        `SELECT t.id, t.table_number, t.name, t.status, t.capacity, t.floor_id,
                f.name as floor_name,
                ts.id as session_id, ts.guest_count, ts.guest_name, ts.started_at,
                ts.order_id as session_order_id, ts.status as session_status,
                u.name as captain_name,
                TIMESTAMPDIFF(MINUTE, ts.started_at, NOW()) as session_duration
         FROM tables t
         JOIN floors f ON t.floor_id = f.id
         LEFT JOIN (
           SELECT ts1.* FROM table_sessions ts1
           INNER JOIN (
             SELECT table_id, MAX(id) as max_id
             FROM table_sessions
             WHERE status IN ('active', 'billing')
             GROUP BY table_id
           ) ts2 ON ts1.id = ts2.max_id
         ) ts ON t.id = ts.table_id
         LEFT JOIN users u ON ts.started_by = u.id
         WHERE ${tableWhere}
         ORDER BY f.floor_number, t.display_order, t.table_number`,
        tableParams
      )
    ]);

    const orders = ordersResult[0];
    const tables = tablesResult[0];

    // ── Build order lookup maps for table→order linking ──
    // Primary: order.table_id → order  (most recent active order per table)
    const orderByTableId = {};
    for (const o of orders) {
      if (o.table_id) {
        // If multiple orders on same table, keep the latest (highest ID)
        if (!orderByTableId[o.table_id] || o.id > orderByTableId[o.table_id].id) {
          orderByTableId[o.table_id] = o;
        }
      }
    }
    // Secondary: order.id → order  (for session.order_id lookup)
    const orderById = {};
    for (const o of orders) {
      orderById[o.id] = o;
    }

    // ── In-memory aggregation ──

    // Orders breakdown
    let totalOrderCount = 0;
    let totalOrderAmount = 0;
    let pendingCount = 0;

    let dineInCount = 0, dineInKots = 0, dineInAmount = 0;
    let pickupCount = 0, pickupAmount = 0;
    let deliveryCount = 0, deliveryAmount = 0;

    let notReadyCount = 0, notReadyAmount = 0;
    let notPickedUpCount = 0, notPickedUpAmount = 0;
    let notDeliveredCount = 0, notDeliveredAmount = 0;

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

    // ── Tables: link to orders via in-memory map ──
    let totalTables = 0;
    let totalGuests = 0;
    let totalTableAmount = 0;

    // Floor-wise breakdown
    const floorMap = {};

    const formattedTables = [];
    for (const t of tables) {
      totalTables++;

      // Find linked order: try session.order_id first, then fallback to order.table_id map
      let linkedOrder = null;
      if (t.session_order_id && orderById[t.session_order_id]) {
        linkedOrder = orderById[t.session_order_id];
      }
      if (!linkedOrder && orderByTableId[t.id]) {
        linkedOrder = orderByTableId[t.id];
      }

      const guests = parseInt(t.guest_count) || (linkedOrder ? (parseInt(linkedOrder.guest_count) || 0) : 0);
      const orderAmt = linkedOrder ? (parseFloat(linkedOrder.total_amount) || 0) : 0;
      const orderSubtotal = linkedOrder ? (parseFloat(linkedOrder.subtotal) || 0) : 0;

      totalGuests += guests;
      totalTableAmount += orderAmt;

      // Floor breakdown
      const fKey = t.floor_id;
      if (!floorMap[fKey]) {
        floorMap[fKey] = { floorId: t.floor_id, floorName: t.floor_name, tables: 0, guests: 0, amount: 0 };
      }
      floorMap[fKey].tables++;
      floorMap[fKey].guests += guests;
      floorMap[fKey].amount += orderAmt;

      formattedTables.push({
        id: t.id,
        tableNumber: t.table_number,
        name: t.name,
        status: t.status,
        capacity: t.capacity,
        floorId: t.floor_id,
        floorName: t.floor_name,
        sessionId: t.session_id || null,
        sessionStatus: t.session_status || null,
        guestCount: guests,
        guestName: t.guest_name || null,
        captainName: t.captain_name || null,
        sessionDuration: t.session_duration || 0,
        startedAt: t.started_at || null,
        orderId: linkedOrder ? linkedOrder.id : null,
        orderNumber: linkedOrder ? linkedOrder.order_number : null,
        orderType: linkedOrder ? linkedOrder.order_type : null,
        orderStatus: linkedOrder ? linkedOrder.status : null,
        orderAmount: orderAmt,
        orderSubtotal: orderSubtotal,
        kotCount: linkedOrder ? (parseInt(linkedOrder.kot_count) || 0) : 0,
        pendingKotCount: linkedOrder ? (parseInt(linkedOrder.pending_kot_count) || 0) : 0
      });
    }

    const r2 = (n) => Math.round(n * 100) / 100;

    const result = {
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
        },
        // Floor-wise breakdown
        floors: Object.values(floorMap).map(f => ({
          ...f,
          amount: r2(f.amount)
        }))
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

    // ── Store in Redis cache (5s TTL) — fire-and-forget ──
    cache.set(cacheKey, result, CACHE_TTL).catch(() => {});

    return result;
  }
};

module.exports = dashboardService;
