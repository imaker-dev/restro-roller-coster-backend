const { getPool } = require('../database');
const { cache, pubsub } = require('../config/redis');
const { emit } = require('../config/socket');
const logger = require('../utils/logger');
const { prefixImageUrl } = require('../utils/helpers');

// In-memory cache for service charge config (per outlet, 5 min TTL)
const _scCache = {};
function _getCachedServiceCharge(pool, outletId) {
  const now = Date.now();
  const entry = _scCache[outletId];
  if (entry && entry.expiry > now) return Promise.resolve(entry.data);
  return pool.query(
    'SELECT name, rate, is_percentage, apply_on, is_taxable, is_optional FROM service_charges WHERE outlet_id = ? AND is_active = 1 LIMIT 1',
    [outletId]
  ).then(([rows]) => {
    const config = rows[0] ? {
      name: rows[0].name,
      rate: parseFloat(rows[0].rate),
      isPercentage: !!rows[0].is_percentage,
      applyOn: rows[0].apply_on,
      isTaxable: !!rows[0].is_taxable,
      isOptional: !!rows[0].is_optional
    } : null;
    _scCache[outletId] = { data: config, expiry: now + 300000 };
    return config;
  }).catch(() => null);
}

const BUSINESS_DAY_START_HOUR = 4;

/**
 * Get local date string (YYYY-MM-DD) for the current business day.
 * If the current time is before BUSINESS_DAY_START_HOUR (e.g. 4 AM),
 * the business day is still "yesterday".
 */
function getLocalDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const shifted = new Date(d.getTime() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const TABLE_STATUSES = ['available', 'occupied', 'running', 'reserved', 'billing', 'blocked', 'merged'];

/**
 * Table Service - Comprehensive table management with real-time updates
 */
const tableService = {
  // ========================
  // CRUD Operations
  // ========================

  /**
   * Create new table
   */
  async create(data, userId) {
    const pool = getPool();

    // Validate floor exists and belongs to outlet
    const [floors] = await pool.query(
      'SELECT id FROM floors WHERE id = ? AND outlet_id = ? AND is_active = 1',
      [data.floorId, data.outletId]
    );
    if (floors.length === 0) {
      const error = new Error('Floor not found or does not belong to this outlet');
      error.statusCode = 400;
      throw error;
    }

    // Validate section exists and is linked to the floor
    if (data.sectionId) {
      const [sections] = await pool.query(
        `SELECT s.id FROM sections s
         JOIN floor_sections fs ON s.id = fs.section_id
         WHERE s.id = ? AND s.outlet_id = ? AND fs.floor_id = ? AND s.is_active = 1 AND fs.is_active = 1`,
        [data.sectionId, data.outletId, data.floorId]
      );
      if (sections.length === 0) {
        const error = new Error('Section not found or does not belong to this floor');
        error.statusCode = 400;
        throw error;
      }
    }

    // Check duplicate table number in same outlet
    const [existing] = await pool.query(
      'SELECT id FROM tables WHERE outlet_id = ? AND table_number = ? AND is_active = 1',
      [data.outletId, data.tableNumber]
    );
    if (existing.length > 0) {
      const error = new Error('A table with this number already exists in this outlet');
      error.statusCode = 409;
      throw error;
    }

    const [result] = await pool.query(
      `INSERT INTO tables (
        outlet_id, floor_id, section_id, table_number, name,
        capacity, min_capacity, shape, status, is_mergeable, is_splittable,
        display_order, qr_code, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.outletId,
        data.floorId,
        data.sectionId || null,
        data.tableNumber,
        data.name || null,
        data.capacity || 4,
        data.minCapacity || 1,
        data.shape || 'square',
        'available',
        data.isMergeable !== false,
        data.isSplittable || false,
        data.displayOrder || 0,
        data.qrCode || null,
        data.isActive !== false
      ]
    );

    const tableId = result.insertId;

    // Create layout position if provided
    if (data.position) {
      await pool.query(
        `INSERT INTO table_layouts (table_id, position_x, position_y, width, height, rotation)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          tableId,
          data.position.x || 0,
          data.position.y || 0,
          data.position.width || 100,
          data.position.height || 100,
          data.position.rotation || 0
        ]
      );
    }

    await this.invalidateCache(data.outletId, data.floorId, tableId);
    return this.getById(tableId);
  },

  /**
   * Get table by ID with full details
   */
  async getById(id) {
    const pool = getPool();
    const [tables] = await pool.query(
      `SELECT t.*, 
        f.name as floor_name, 
        s.name as section_name, s.section_type,
        o.name as outlet_name,
        tl.position_x, tl.position_y, tl.width, tl.height, tl.rotation
       FROM tables t
       JOIN floors f ON t.floor_id = f.id
       JOIN outlets o ON t.outlet_id = o.id
       LEFT JOIN sections s ON t.section_id = s.id
       LEFT JOIN table_layouts tl ON t.id = tl.table_id
       WHERE t.id = ?`,
      [id]
    );
    return tables[0] || null;
  },

  /**
   * Get table by ID with comprehensive real-time details
   * Returns all status-specific information including orders, items, captain, KOTs, etc.
   */
  async getFullDetails(id) {
    // Short-lived cache (2s) — prevents thundering herd when 100+ tables polled at peak
    const _cacheKey = `table:detail:${id}`;
    const _cached = await cache.get(_cacheKey);
    if (_cached) return _cached;

    const pool = getPool();
    
    // Parallel: table + session + merges + history (all independent, all use only table id)
    const [tableResult, sessionResult, mergesResult, historyResult] = await Promise.all([
      pool.query(
        `SELECT t.*, 
          f.name as floor_name, 
          s.name as section_name, s.section_type,
          o.name as outlet_name,
          tl.position_x, tl.position_y, tl.width, tl.height, tl.rotation
         FROM tables t
         JOIN floors f ON t.floor_id = f.id
         JOIN outlets o ON t.outlet_id = o.id
         LEFT JOIN sections s ON t.section_id = s.id
         LEFT JOIN table_layouts tl ON t.id = tl.table_id
         WHERE t.id = ?`,
        [id]
      ),
      pool.query(
        `SELECT ts.*, 
          u.id as captain_id, u.name as captain_name, u.employee_code as captain_code, u.phone as captain_phone
         FROM table_sessions ts
         LEFT JOIN users u ON ts.started_by = u.id
         WHERE ts.table_id = ? AND ts.status IN ('active', 'billing')
         ORDER BY ts.started_at DESC LIMIT 1`,
        [id]
      ),
      pool.query(
        `SELECT tm.*, t.table_number, t.name as table_name, t.capacity
         FROM table_merges tm
         JOIN tables t ON tm.merged_table_id = t.id
         WHERE tm.primary_table_id = ? AND tm.unmerged_at IS NULL`,
        [id]
      ),
      pool.query(
        `SELECT * FROM table_history 
         WHERE table_id = ? 
         ORDER BY created_at DESC LIMIT 10`,
        [id]
      )
    ]);
    
    const table = tableResult[0][0];
    if (!table) return null;
    
    const sessions = sessionResult[0];
    const merges = mergesResult[0];
    const history = historyResult[0];

    const result = {
      // Basic table info
      id: table.id,
      tableNumber: table.table_number,
      name: table.name,
      status: table.status,
      capacity: table.capacity,
      minCapacity: table.min_capacity,
      shape: table.shape,
      isMergeable: !!table.is_mergeable,
      isSplittable: !!table.is_splittable,
      qrCode: table.qr_code,
      
      // Location info
      location: {
        outletId: table.outlet_id,
        outletName: table.outlet_name,
        floorId: table.floor_id,
        floorName: table.floor_name,
        sectionId: table.section_id,
        sectionName: table.section_name,
        sectionType: table.section_type
      },
      
      // Layout position
      position: table.position_x !== null ? {
        x: table.position_x,
        y: table.position_y,
        width: table.width,
        height: table.height,
        rotation: table.rotation
      } : null,

      // Status-specific details (populated below)
      session: null,
      captain: null,
      order: null,
      items: [],
      kots: [],
      billing: null,
      timeline: history.map(h => {
        const action = h.event_type || h.action || null;
        let details = null;
        const raw = h.event_data || h.details;
        if (raw) {
          try { details = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) {}
        }
        return { action, details, timestamp: h.created_at };
      }),
      mergedTables: merges.map(m => ({
        tableId: m.merged_table_id,
        tableNumber: m.table_number,
        tableName: m.table_name,
        capacity: m.capacity,
        mergedAt: m.merged_at
      }))
    };

    // Get active session if table is occupied/running/billing/reserved
    if (['occupied', 'running', 'billing', 'reserved'].includes(table.status) && sessions[0]) {
        const session = sessions[0];
        result.session = {
          id: session.id,
          guestCount: session.guest_count,
          guestName: session.guest_name,
          guestPhone: session.guest_phone,
          startedAt: session.started_at,
          duration: Math.floor((new Date() - new Date(session.started_at)) / 1000 / 60), // minutes
          notes: session.notes
        };

        result.captain = session.captain_id ? {
          id: session.captain_id,
          name: session.captain_name,
          employeeCode: session.captain_code,
          phone: session.captain_phone
        } : null;

        // Get order details if exists
        if (session.order_id) {
          const _orderId = session.order_id;

          // ── Parallel batch: order + SC + items + KOTs ──
          // (was 5 sequential queries → now 1 parallel batch + 1 addons follow-up)
          const [_orderRes, _scConfig, _itemsRes, _kotsRes] = await Promise.all([
            pool.query(
              `SELECT o.*, 
                inv.id as invoice_id, inv.invoice_number, inv.grand_total as invoice_total,
                p.id as payment_id, p.payment_number, p.amount as paid_amount_completed, p.payment_mode,
                uc.name as created_by_name, ub.name as billed_by_name, ux.name as cancelled_by_name
               FROM orders o
               LEFT JOIN invoices inv ON o.id = inv.order_id
               LEFT JOIN payments p ON o.id = p.order_id AND p.status = 'completed'
               LEFT JOIN users uc ON o.created_by = uc.id
               LEFT JOIN users ub ON o.billed_by = ub.id
               LEFT JOIN users ux ON o.cancelled_by = ux.id
               WHERE o.id = ?`,
              [_orderId]
            ),
            _getCachedServiceCharge(pool, table.outlet_id),
            pool.query(
              `SELECT oi.*, 
                i.name as catalog_name, i.short_name as catalog_short_name, i.image_url, i.item_type as catalog_item_type,
                i.base_price as menu_base_price, i.is_open_item as catalog_is_open_item,
                v.name as catalog_variant_name, v.price as variant_menu_price,
                ks.name as kitchen_station_name, ks.station_type,
                tg.name as tax_group_name, tg.total_rate as tax_total_rate,
                uc.name as cancelled_by_name,
                unc.name as nc_by_name
               FROM order_items oi
               JOIN items i ON oi.item_id = i.id
               LEFT JOIN variants v ON oi.variant_id = v.id
               LEFT JOIN kitchen_stations ks ON i.kitchen_station_id = ks.id
               LEFT JOIN tax_groups tg ON oi.tax_group_id = tg.id
               LEFT JOIN users uc ON oi.cancelled_by = uc.id
               LEFT JOIN users unc ON oi.nc_by = unc.id
               WHERE oi.order_id = ?
               ORDER BY oi.created_at`,
              [_orderId]
            ),
            pool.query(
              `SELECT kt.*, u.name as accepted_by_name,
                COUNT(ki.id) as total_item_count,
                SUM(CASE WHEN ki.status != 'cancelled' THEN 1 ELSE 0 END) as item_count,
                SUM(CASE WHEN ki.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_item_count
               FROM kot_tickets kt
               LEFT JOIN users u ON kt.accepted_by = u.id
               LEFT JOIN kot_items ki ON ki.kot_id = kt.id
               WHERE kt.order_id = ?
               GROUP BY kt.id
               ORDER BY kt.created_at`,
              [_orderId]
            )
          ]);

          const orders = _orderRes[0];
          const serviceChargeConfig = _scConfig;
          const items = _itemsRes[0];
          const _kots = _kotsRes[0];

          if (orders[0]) {
            const order = orders[0];

            result.order = {
              id: order.id,
              orderNumber: order.order_number,
              orderType: order.order_type,
              status: order.status,
              paymentStatus: order.payment_status,
              guestCount: order.guest_count,
              isPriority: !!order.is_priority,
              isComplimentary: !!order.is_complimentary,
              complimentaryReason: order.complimentary_reason,
              // NC (No Charge) - order level
              isNC: !!order.is_nc,
              ncAmount: parseFloat(order.nc_amount) || 0,
              totalAmount: parseFloat(order.total_amount) || 0,
              paidAmount: parseFloat(order.paid_amount) || 0,
              dueAmount: parseFloat(order.due_amount) || 0,

              // Customer info
              customerName: order.customer_name,
              customerPhone: order.customer_phone,
              specialInstructions: order.special_instructions,
              internalNotes: order.internal_notes,

              // Audit
              createdBy: order.created_by_name,
              createdAt: order.created_at,
              billedBy: order.billed_by_name,
              billedAt: order.billed_at,
              cancelledBy: order.cancelled_by_name,
              cancelledAt: order.cancelled_at,
              cancelReason: order.cancel_reason
            };

            // Add invoice info if exists
            if (order.invoice_id) {
              result.billing = {
                invoiceId: order.invoice_id,
                invoiceNumber: order.invoice_number,
                grandTotal: parseFloat(order.invoice_total) || 0,
                paymentId: order.payment_id,
                paymentNumber: order.payment_number,
                paidAmount: parseFloat(order.paid_amount_completed) || 0,
                paymentMode: order.payment_mode
              };
            }

            // Batch-fetch addons for ALL items in one query (eliminates N+1)
            const itemIds = items.map(i => i.id);
            let addonsMap = {};
            if (itemIds.length > 0) {
              const [allAddons] = await pool.query(
                'SELECT * FROM order_item_addons WHERE order_item_id IN (?)',
                [itemIds]
              );
              for (const addon of allAddons) {
                if (!addonsMap[addon.order_item_id]) addonsMap[addon.order_item_id] = [];
                addonsMap[addon.order_item_id].push(addon);
              }
            }
            for (const item of items) {
              item.addons = addonsMap[item.id] || [];
            }

            // Build internal items with full data (for charges computation)
            const _items = items.map(item => {
              let taxDetails = null;
              try { taxDetails = item.tax_details ? (typeof item.tax_details === 'string' ? JSON.parse(item.tax_details) : item.tax_details) : null; } catch (e) {}

              const addonTotal = item.addons.reduce((sum, a) => sum + parseFloat(a.unit_price || 0) * (a.quantity || 1), 0);
              const isOpenItem = !!(item.is_open_item || item.catalog_is_open_item);

              // For open items: use oi.item_name (custom name) and oi.unit_price (custom price)
              // For normal items: use catalog values as before
              const displayName = item.item_name || item.catalog_name;
              const displayShortName = isOpenItem ? (item.item_name || item.catalog_short_name) : item.catalog_short_name;
              const displayVariantName = item.variant_name || item.catalog_variant_name;
              const displayItemType = item.item_type || item.catalog_item_type;

              const menuPrice = isOpenItem
                ? parseFloat(item.unit_price || item.base_price || 0)
                : (item.variant_id
                  ? parseFloat(item.variant_menu_price || item.menu_base_price || 0)
                  : parseFloat(item.menu_base_price || 0));

              return {
                id: item.id, itemId: item.item_id,
                name: displayName, shortName: displayShortName,
                imageUrl: prefixImageUrl(item.image_url),
                variantId: item.variant_id, variantName: displayVariantName,
                quantity: parseFloat(item.quantity), itemType: displayItemType,
                isOpenItem,
                weight: item.weight || null,
                menuPrice,
                addonTotal: parseFloat(addonTotal.toFixed(2)),
                unitPrice: parseFloat(item.unit_price),
                totalPrice: parseFloat(item.total_price),
                taxAmount: parseFloat(item.tax_amount || 0),
                discountAmount: parseFloat(item.discount_amount || 0),
                taxGroupId: item.tax_group_id,
                taxGroupName: item.tax_group_name,
                taxRate: item.tax_total_rate ? parseFloat(item.tax_total_rate) : null,
                taxDetails,
                status: item.status, kotId: item.kot_id,
                station: item.kitchen_station_name, stationType: item.station_type,
                specialInstructions: item.special_instructions,
                isComplimentary: !!item.is_complimentary, complimentaryReason: item.complimentary_reason,
                // NC (No Charge) details
                isNC: !!item.is_nc,
                ncReasonId: item.nc_reason_id || null,
                ncReason: item.nc_reason || null,
                ncAmount: parseFloat(item.nc_amount || 0),
                ncBy: item.nc_by_name || null,
                ncAt: item.nc_at || null,
                cancelReason: item.cancel_reason,
                cancelQuantity: parseFloat(item.cancel_quantity || 0),
                cancelledBy: item.cancelled_by_name, cancelledAt: item.cancelled_at,
                createdAt: item.created_at,
                addons: item.addons
              };
            });

            // Items for response — menu-wise pricing only (no tax in item price)
            result.items = _items.map(item => ({
              id: item.id,
              itemId: item.itemId,
              name: item.name,
              shortName: item.shortName,
              imageUrl: item.imageUrl,
              variantId: item.variantId,
              variantName: item.variantName,
              quantity: item.quantity,
              itemType: item.itemType,
              menuPrice: item.menuPrice,
              addonTotal: item.addonTotal,
              itemTotal: parseFloat(((item.menuPrice + item.addonTotal) * item.quantity).toFixed(2)),
              status: item.status,
              kotId: item.kotId,
              station: item.station,
              stationType: item.stationType,
              specialInstructions: item.specialInstructions,
              isComplimentary: item.isComplimentary,
              complimentaryReason: item.complimentaryReason,
              isOpenItem: item.isOpenItem,
              // NC (No Charge) badge and details
              isNC: item.isNC,
              ncReason: item.ncReason,
              ncAmount: item.ncAmount,
              ncBy: item.ncBy,
              ncAt: item.ncAt,
              cancelReason: item.cancelReason,
              cancelQuantity: item.cancelQuantity,
              cancelledBy: item.cancelledBy,
              cancelledAt: item.cancelledAt,
              createdAt: item.createdAt,
              addons: item.addons.map(a => ({
                id: a.addon_id,
                name: a.addon_name,
                groupName: a.addon_group_name,
                price: parseFloat(a.unit_price),
                quantity: a.quantity,
                totalPrice: parseFloat(a.total_price || a.unit_price)
              }))
            }));

            // ── Build NC summary for quick badge display ──
            // const ncItems = _items.filter(i => i.isNC && i.status !== 'cancelled');
            // if (ncItems.length > 0) {
            //   result.ncSummary = {
            //     hasNcItems: true,
            //     ncItemCount: ncItems.length,
            //     totalNcAmount: ncItems.reduce((sum, i) => sum + i.ncAmount, 0),
            //     ncItems: ncItems.map(i => ({
            //       id: i.id,
            //       itemName: i.name,
            //       quantity: i.quantity,
            //       ncAmount: i.ncAmount,
            //       ncReason: i.ncReason,
            //       ncBy: i.ncBy,
            //       ncAt: i.ncAt
            //     }))
            //   };
            // } else {
            //   result.ncSummary = {
            //     hasNcItems: false,
            //     ncItemCount: 0,
            //     totalNcAmount: 0,
            //     ncItems: []
            //   };
            // }

            // ── Build clear order-level charges breakdown ──
            const activeItems = _items.filter(i => i.status !== 'cancelled');
            const cancelledItems = _items.filter(i => i.status === 'cancelled');

            // Separate chargeable (non-NC) and NC items
            const chargeableItems = activeItems.filter(i => !i.isNC);
            const ncItemsList = activeItems.filter(i => i.isNC);

            // itemsMenuTotal = sum of (menuPrice + addonTotal) * qty for CHARGEABLE items only
            const itemsMenuTotal = parseFloat(
              chargeableItems.reduce((s, i) => s + (i.menuPrice + i.addonTotal) * i.quantity, 0).toFixed(2)
            );
            
            // Subtotal = sum of totalPrice for CHARGEABLE (non-NC) items only
            const subtotal = parseFloat(
              chargeableItems.reduce((s, i) => s + i.totalPrice, 0).toFixed(2)
            );
            const priceAdjustment = parseFloat((subtotal - itemsMenuTotal).toFixed(2));

            // Group active NON-NC items by tax group for tax summary (NC items have zero tax)
            const taxGroupMap = {};
            for (const item of chargeableItems) {
              const gKey = item.taxGroupId || 0;
              if (!taxGroupMap[gKey]) {
                taxGroupMap[gKey] = {
                  taxGroup: item.taxGroupName || 'No Tax',
                  taxRate: item.taxRate || 0,
                  itemCount: 0,
                  taxableAmount: 0,
                  components: {},
                  totalTax: 0
                };
              }
              const g = taxGroupMap[gKey];
              g.itemCount += 1;
              g.taxableAmount += item.totalPrice;
              g.totalTax += item.taxAmount;

              // Aggregate component-level breakdown (CGST, SGST, VAT etc)
              if (item.taxDetails && Array.isArray(item.taxDetails)) {
                for (const comp of item.taxDetails) {
                  const cKey = comp.componentCode || comp.code || comp.componentName || comp.name || 'TAX';
                  if (!g.components[cKey]) {
                    g.components[cKey] = { name: comp.componentName || comp.name, code: cKey, rate: comp.rate, amount: 0 };
                  }
                  g.components[cKey].amount += parseFloat(comp.amount || 0);
                }
              }
            }

            // Calculate discount ratio to apply to tax amounts
            const discountAmount = parseFloat(order.discount_amount) || 0;
            const discountRatio = subtotal > 0 ? ((subtotal - discountAmount) / subtotal) : 1;

            // Convert to clean array with discount-adjusted amounts
            const taxSummary = Object.values(taxGroupMap).map(g => {
              const adjustedTaxableAmount = parseFloat((g.taxableAmount * discountRatio).toFixed(2));
              const adjustedTotalTax = parseFloat((g.totalTax * discountRatio).toFixed(2));
              return {
                taxGroup: g.taxGroup,
                taxRate: g.taxRate,
                itemCount: g.itemCount,
                taxableAmount: adjustedTaxableAmount,
                components: Object.values(g.components).map(c => ({
                  name: c.name,
                  code: c.code,
                  rate: c.rate,
                  amount: parseFloat((c.amount * discountRatio).toFixed(2))
                })),
                totalTax: adjustedTotalTax
              };
            });

            const scAmount = parseFloat(order.service_charge) || 0;

            // NC amount from NC items list (already filtered above)
            const ncAmount = parseFloat(ncItemsList.reduce((sum, i) => sum + i.totalPrice, 0).toFixed(2));

            // totalTax from tax summary (only non-NC items)
            const totalTax = parseFloat(taxSummary.reduce((sum, g) => sum + g.totalTax, 0).toFixed(2));

            // grandTotal = (subtotal - discount) + totalTax + charges
            // Note: subtotal already excludes NC items, so no need to subtract ncAmount
            const discountAmt = parseFloat(order.discount_amount) || 0;
            const packagingCharge = parseFloat(order.packaging_charge) || 0;
            const deliveryCharge = parseFloat(order.delivery_charge) || 0;
            const taxableAmount = subtotal - discountAmt;
            const preRound = taxableAmount + totalTax + scAmount + packagingCharge + deliveryCharge;
            const grandTotal = Math.max(0, Math.round(preRound));

            result.order.charges = {
              itemsMenuTotal,
              priceAdjustment,
              subtotal,
              discount: discountAmt,
              taxSummary,
              totalTax,
              serviceCharge: serviceChargeConfig ? {
                name: serviceChargeConfig.name,
                rate: serviceChargeConfig.rate,
                isPercentage: serviceChargeConfig.isPercentage,
                amount: scAmount
              } : { name: null, rate: 0, isPercentage: false, amount: scAmount },
              packagingCharge,
              deliveryCharge,
              roundOff: parseFloat((grandTotal - preRound).toFixed(2)),
              ncAmount,
              grandTotal
            };

            result.order.activeItemCount = activeItems.length;
            result.order.cancelledItemCount = cancelledItems.length;

            result.kots = _kots.map(kot => ({
              id: kot.id,
              kotNumber: kot.kot_number,
              status: kot.status,
              station: kot.station,
              itemCount: Number(kot.item_count),
              totalItemCount: Number(kot.total_item_count),
              cancelledItemCount: Number(kot.cancelled_item_count),
              priority: kot.priority,
              acceptedBy: kot.accepted_by_name,
              acceptedAt: kot.accepted_at,
              readyAt: kot.ready_at,
              servedAt: kot.served_at,
              createdAt: kot.created_at
            }));
          }
        }
    }

    // Add status-specific summary
    result.statusSummary = this.getStatusSummary(result);

    // Cache for 2s — short enough for freshness, long enough to absorb peak polling
    await cache.set(_cacheKey, result, 2);

    return result;
  },

  /**
   * Get human-readable status summary
   */
  getStatusSummary(tableData) {
    const { status, session, order, items, kots } = tableData;
    
    switch (status) {
      case 'available':
        return { message: 'Table is available for seating', canSeat: true };
      
      case 'reserved':
        return { 
          message: session ? `Reserved for ${session.guestName || 'guest'}` : 'Table is reserved',
          guestName: session?.guestName,
          reservedSince: session?.startedAt
        };
      
      case 'occupied':
      case 'running':
        const activeItems = items.filter(i => i.status !== 'cancelled');
        const cancelledCount = items.length - activeItems.length;
        const pendingKots = kots.filter(k => ['pending', 'preparing'].includes(k.status)).length;
        const readyKots = kots.filter(k => k.status === 'ready').length;
        const servedItems = activeItems.filter(i => i.status === 'served').length;
        return {
          message: status === 'running' 
            ? `Running - ${servedItems}/${activeItems.length} items served` 
            : `Occupied - ${activeItems.length} active items${cancelledCount ? `, ${cancelledCount} cancelled` : ''}`,
          guestCount: session?.guestCount,
          duration: session?.duration,
          orderNumber: order?.orderNumber,
          totalItems: items.length,
          activeItemCount: activeItems.length,
          cancelledItemCount: cancelledCount,
          servedItems,
          orderTotal: order?.totalAmount,
          pendingKots,
          readyKots,
          orderStatus: order?.status
        };
      
      case 'billing':
        return {
          message: 'Bill generated, awaiting payment',
          orderNumber: order?.orderNumber,
          grandTotal: tableData.billing?.grandTotal,
          invoiceNumber: tableData.billing?.invoiceNumber
        };
      
      case 'blocked':
        return { message: 'Table is blocked/unavailable', canSeat: false };
      
      default:
        return { message: `Status: ${status}` };
    }
  },

  /**
   * Get all tables for an outlet
   */
  async getByOutlet(outletId, filters = {}) {
    const pool = getPool();
    
    let query = `
      SELECT t.*, 
        f.name as floor_name, 
        s.name as section_name, s.section_type,
        tl.position_x, tl.position_y, tl.width, tl.height, tl.rotation
      FROM tables t
      JOIN floors f ON t.floor_id = f.id
      LEFT JOIN sections s ON t.section_id = s.id
      LEFT JOIN table_layouts tl ON t.id = tl.table_id
      WHERE t.outlet_id = ?
    `;
    const params = [outletId];

    if (filters.floorId) {
      query += ' AND t.floor_id = ?';
      params.push(filters.floorId);
    } else if (filters.floorIds && filters.floorIds.length > 0) {
      query += ` AND t.floor_id IN (${filters.floorIds.map(() => '?').join(',')})`;
      params.push(...filters.floorIds);
    }

    if (filters.sectionId) {
      query += ' AND t.section_id = ?';
      params.push(filters.sectionId);
    }

    if (filters.status) {
      query += ' AND t.status = ?';
      params.push(filters.status);
    }

    if (filters.isActive !== undefined) {
      query += ' AND t.is_active = ?';
      params.push(filters.isActive);
    } else {
      query += ' AND t.is_active = 1';
    }

    query += ' ORDER BY t.display_order, t.table_number';

    const [tables] = await pool.query(query, params);
    return tables;
  },

  /**
   * Get tables by floor with real-time data including KOT summary and shift status
   */
  async getByFloor(floorId) {
    // Short-lived cache (2s) — absorbs burst polling from multiple devices at peak
    const _cacheKey = `tables:floor:${floorId}`;
    const _cached = await cache.get(_cacheKey);
    if (_cached) return _cached;

    const pool = getPool();
    
    // Phase 1: All 4 independent queries in parallel (floor, tables, sections, direct orders)
    const [floorInfoResult, tablesResult, sectionsResult, directOrdersResult] = await Promise.all([
      pool.query(
        `SELECT f.id, f.name, f.outlet_id, f.floor_number,
          ds.id as shift_id, ds.status as shift_status, ds.cashier_id,
          u.name as cashier_name, ds.opening_cash
         FROM floors f
         LEFT JOIN day_sessions ds ON f.id = ds.floor_id AND ds.status = 'open'
         LEFT JOIN users u ON ds.cashier_id = u.id
         WHERE f.id = ?
         ORDER BY ds.id DESC
         LIMIT 1`,
        [floorId]
      ),
      pool.query(
        `SELECT t.*, 
          s.name as section_name, s.section_type,
          tl.position_x, tl.position_y, tl.width, tl.height, tl.rotation,
          ts.id as session_id, ts.guest_count, ts.guest_name, ts.started_at, ts.started_by,
          u.name as captain_name, u.employee_code as captain_code,
          o.id as current_order_id, o.order_number, o.subtotal, o.total_amount, o.status as order_status,
          TIMESTAMPDIFF(MINUTE, ts.started_at, NOW()) as session_duration
         FROM tables t
         LEFT JOIN sections s ON t.section_id = s.id
         LEFT JOIN table_layouts tl ON t.id = tl.table_id
         LEFT JOIN (
           SELECT ts1.* FROM table_sessions ts1
           INNER JOIN (
             SELECT table_id, MAX(id) as max_id 
             FROM table_sessions 
             WHERE status = 'active' 
             GROUP BY table_id
           ) ts2 ON ts1.id = ts2.max_id
         ) ts ON t.id = ts.table_id
         LEFT JOIN users u ON ts.started_by = u.id
         LEFT JOIN orders o ON ts.order_id = o.id
         WHERE t.floor_id = ? AND t.is_active = 1
         ORDER BY t.display_order, t.table_number`,
        [floorId]
      ),
      pool.query(
        `SELECT s.id, s.name, s.section_type, s.display_order
         FROM sections s
         JOIN floor_sections fs ON s.id = fs.section_id
         WHERE fs.floor_id = ? AND s.is_active = 1
         ORDER BY s.display_order, s.name`,
        [floorId]
      ),
      // Direct active orders by floor (fallback for session gaps) — uses floor_id JOIN, no table IDs needed
      pool.query(
        `SELECT o.table_id, MAX(o.id) as order_id FROM orders o
         JOIN tables t ON o.table_id = t.id
         WHERE t.floor_id = ? AND t.is_active = 1 AND o.status NOT IN ('paid', 'completed', 'cancelled')
         GROUP BY o.table_id`,
        [floorId]
      )
    ]);
    const floorInfo = floorInfoResult[0];
    const tables = tablesResult[0];
    const sections = sectionsResult[0];

    // Build direct orders lookup and fill missing current_order_id
    const directOrderByTable = {};
    for (const row of directOrdersResult[0]) directOrderByTable[row.table_id] = row.order_id;

    const allTableIds = tables.map(t => t.id);
    const mergedTableIds = tables.filter(t => t.status === 'merged').map(t => t.id);

    for (const table of tables) {
      if (!table.current_order_id && directOrderByTable[table.id]) {
        table.current_order_id = directOrderByTable[table.id];
      }
    }

    const activeOrderIds = tables.filter(t => t.current_order_id).map(t => t.current_order_id);

    // Parallel batch queries
    const [kotRows, itemCountRows, ncItemRows, mergesPrimaryRows, mergesSecondaryRows] = await Promise.all([
      activeOrderIds.length > 0 ? pool.query(
        `SELECT order_id,
            COUNT(*) as total_kots,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_kots,
            SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) as accepted_kots,
            SUM(CASE WHEN status = 'preparing' THEN 1 ELSE 0 END) as preparing_kots,
            SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready_kots,
            SUM(CASE WHEN status = 'served' THEN 1 ELSE 0 END) as served_kots
         FROM kot_tickets WHERE order_id IN (?)
         GROUP BY order_id`,
        [activeOrderIds]
      ).then(([r]) => r) : [],
      activeOrderIds.length > 0 ? pool.query(
        `SELECT order_id, COUNT(*) as count FROM order_items WHERE order_id IN (?) AND status != 'cancelled' GROUP BY order_id`,
        [activeOrderIds]
      ).then(([r]) => r) : [],
      activeOrderIds.length > 0 ? pool.query(
        `SELECT oi.order_id, oi.id, oi.item_name, oi.quantity, oi.unit_price, oi.total_price,
                oi.is_nc, oi.nc_reason, oi.nc_amount, oi.nc_at,
                u.name as nc_by_name
         FROM order_items oi
         LEFT JOIN users u ON oi.nc_by = u.id
         WHERE oi.order_id IN (?) AND oi.is_nc = 1 AND oi.status != 'cancelled'`,
        [activeOrderIds]
      ).then(([r]) => r) : [],
      allTableIds.length > 0 ? pool.query(
        `SELECT tm.id as merge_id, tm.primary_table_id, tm.merged_table_id, t.table_number as merged_table_number, t.name as merged_table_name, t.capacity as merged_table_capacity
         FROM table_merges tm
         JOIN tables t ON tm.merged_table_id = t.id
         WHERE tm.primary_table_id IN (?) AND tm.unmerged_at IS NULL`,
        [allTableIds]
      ).then(([r]) => r) : [],
      mergedTableIds.length > 0 ? pool.query(
        `SELECT tm.merged_table_id, tm.primary_table_id, t.table_number as primary_table_number, t.name as primary_table_name
         FROM table_merges tm
         JOIN tables t ON tm.primary_table_id = t.id
         WHERE tm.merged_table_id IN (?) AND tm.unmerged_at IS NULL`,
        [mergedTableIds]
      ).then(([r]) => r) : []
    ]);

    // Build lookup maps
    const kotByOrder = {};
    for (const k of kotRows) kotByOrder[k.order_id] = k;
    const itemCountByOrder = {};
    for (const ic of itemCountRows) itemCountByOrder[ic.order_id] = ic.count;
    const ncByOrder = {};
    for (const nc of ncItemRows) {
      if (!ncByOrder[nc.order_id]) ncByOrder[nc.order_id] = [];
      ncByOrder[nc.order_id].push(nc);
    }
    const mergesByPrimary = {};
    for (const m of mergesPrimaryRows) {
      if (!mergesByPrimary[m.primary_table_id]) mergesByPrimary[m.primary_table_id] = [];
      mergesByPrimary[m.primary_table_id].push(m);
    }
    const mergesBySecondary = {};
    for (const m of mergesSecondaryRows) mergesBySecondary[m.merged_table_id] = m;

    // Assign to tables from lookup maps (no more per-table DB calls)
    for (const table of tables) {
      if (table.current_order_id) {
        table.kotSummary = kotByOrder[table.current_order_id] || {
          total_kots: 0, pending_kots: 0, accepted_kots: 0, preparing_kots: 0, ready_kots: 0, served_kots: 0
        };
        table.item_count = itemCountByOrder[table.current_order_id] || 0;

        const ncItems = ncByOrder[table.current_order_id];
        if (ncItems && ncItems.length > 0) {
          const totalNcAmount = ncItems.reduce((sum, item) => sum + (parseFloat(item.nc_amount) || 0), 0);
          table.ncSummary = {
            hasNcItems: true,
            ncItemCount: ncItems.length,
            totalNcAmount: totalNcAmount,
            ncItems: ncItems.map(item => ({
              id: item.id,
              itemName: item.item_name,
              quantity: parseFloat(item.quantity) || 0,
              unitPrice: parseFloat(item.unit_price) || 0,
              totalPrice: parseFloat(item.total_price) || 0,
              ncAmount: parseFloat(item.nc_amount) || 0,
              ncReason: item.nc_reason || null,
              ncAt: item.nc_at || null,
              ncByName: item.nc_by_name || null
            }))
          };
        } else {
          table.ncSummary = { hasNcItems: false, ncItemCount: 0, totalNcAmount: 0, ncItems: [] };
        }
      }

      const primaryMerges = mergesByPrimary[table.id];
      if (primaryMerges && primaryMerges.length > 0) {
        table.mergedTables = primaryMerges;
        table.isMergedPrimary = true;
      }

      if (table.status === 'merged' && mergesBySecondary[table.id]) {
        table.mergedInto = mergesBySecondary[table.id];
      }
    }

    // Build response with floor info, shift status, sections, and tables
    const floor = floorInfo[0] || {};
    const result = {
      floor: {
        id: floor.id,
        name: floor.name,
        outletId: floor.outlet_id,
        floorNumber: floor.floor_number
      },
      shift: {
        isOpen: !!floor.shift_id,
        shiftId: floor.shift_id || null,
        cashierId: floor.cashier_id || null,
        cashierName: floor.cashier_name || null,
        openingCash: floor.opening_cash || null
      },
      sections: sections.map(s => ({
        id: s.id,
        name: s.name,
        sectionType: s.section_type,
        displayOrder: s.display_order
      })),
      tables
    };

    // Cache for 2s — short enough for freshness, long enough to absorb peak polling
    await cache.set(_cacheKey, result, 2);
    return result;
  },

  /**
   * Update table
   */
  async update(id, data, userId) {
    const pool = getPool();
    const table = await this.getById(id);
    if (!table) return null;

    const updates = [];
    const params = [];

    if (data.floorId !== undefined) { updates.push('floor_id = ?'); params.push(data.floorId); }
    if (data.sectionId !== undefined) { updates.push('section_id = ?'); params.push(data.sectionId); }
    if (data.tableNumber !== undefined) { updates.push('table_number = ?'); params.push(data.tableNumber); }
    if (data.name !== undefined) { updates.push('name = ?'); params.push(data.name); }
    if (data.capacity !== undefined) { updates.push('capacity = ?'); params.push(data.capacity); }
    if (data.minCapacity !== undefined) { updates.push('min_capacity = ?'); params.push(data.minCapacity); }
    if (data.shape !== undefined) { updates.push('shape = ?'); params.push(data.shape); }
    if (data.isMergeable !== undefined) { updates.push('is_mergeable = ?'); params.push(data.isMergeable); }
    if (data.isSplittable !== undefined) { updates.push('is_splittable = ?'); params.push(data.isSplittable); }
    if (data.displayOrder !== undefined) { updates.push('display_order = ?'); params.push(data.displayOrder); }
    if (data.isActive !== undefined) { updates.push('is_active = ?'); params.push(data.isActive); }

    if (updates.length > 0) {
      params.push(id);
      await pool.query(`UPDATE tables SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    // Update layout position
    if (data.position) {
      await pool.query(
        `INSERT INTO table_layouts (table_id, position_x, position_y, width, height, rotation)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           position_x = VALUES(position_x),
           position_y = VALUES(position_y),
           width = VALUES(width),
           height = VALUES(height),
           rotation = VALUES(rotation)`,
        [
          id,
          data.position.x || 0,
          data.position.y || 0,
          data.position.width || 100,
          data.position.height || 100,
          data.position.rotation || 0
        ]
      );
    }

    await this.invalidateCache(table.outlet_id, table.floor_id, id);
    return this.getById(id);
  },

  /**
   * Delete table
   */
  async delete(id, userId) {
    const pool = getPool();
    const table = await this.getById(id);
    if (!table) return false;

    // Check if table has active session
    const [sessions] = await pool.query(
      'SELECT COUNT(*) as count FROM table_sessions WHERE table_id = ? AND status = "active"',
      [id]
    );

    if (sessions[0].count > 0) {
      throw new Error('Cannot delete table with active session');
    }

    await pool.query('UPDATE tables SET is_active = 0 WHERE id = ?', [id]);
    await this.invalidateCache(table.outlet_id, table.floor_id, id);
    return true;
  },

  // ========================
  // Status Management
  // ========================

  /**
   * Update table status with real-time broadcast
   */
  async updateStatus(id, status, userId, additionalData = {}) {
    const pool = getPool();
    
    if (!TABLE_STATUSES.includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }

    // Lightweight query — only need status, floor_id, outlet_id, table_number for broadcast
    const [[table]] = await pool.query(
      'SELECT id, table_number, name, status, floor_id, outlet_id FROM tables WHERE id = ?',
      [id]
    );
    if (!table) throw new Error('Table not found');

    const oldStatus = table.status;

    await pool.query('UPDATE tables SET status = ? WHERE id = ?', [status, id]);

    // Fire-and-forget: log + cache (don't block response)
    Promise.all([
      this.logHistory(id, 'status_change', { from: oldStatus, to: status, changedBy: userId, ...additionalData }),
      this.invalidateCache(table.outlet_id, table.floor_id, id)
    ]).catch(err => logger.error('updateStatus post-update error:', err.message));

    this.broadcastTableUpdate(table.outlet_id, table.floor_id, {
      tableId: id,
      tableNumber: table.table_number,
      oldStatus,
      newStatus: status,
      changedBy: userId,
      timestamp: new Date()
    });

    // Return lightweight result instead of redundant getById (4 JOINs)
    return { id: table.id, tableNumber: table.table_number, name: table.name, status, floorId: table.floor_id, outletId: table.outlet_id };
  },

  /**
   * Get real-time status of all tables
   */
  async getRealTimeStatus(outletId, floorId = null) {
    const pool = getPool();
    
    let query = `
      SELECT t.id, t.table_number, t.status, t.capacity,
        f.id as floor_id, f.name as floor_name,
        s.name as section_name,
        ts.guest_count, ts.started_at,
        u.name as captain_name,
        o.order_number, o.total_amount,
        (SELECT COUNT(*) FROM kot_tickets kt WHERE kt.order_id = o.id AND kt.status IN ('pending', 'preparing')) as active_kots
      FROM tables t
      JOIN floors f ON t.floor_id = f.id
      LEFT JOIN sections s ON t.section_id = s.id
      LEFT JOIN table_sessions ts ON t.id = ts.table_id AND ts.status = 'active'
      LEFT JOIN users u ON ts.started_by = u.id
      LEFT JOIN orders o ON ts.order_id = o.id
      WHERE t.outlet_id = ? AND t.is_active = 1
    `;
    const params = [outletId];

    if (floorId) {
      query += ' AND t.floor_id = ?';
      params.push(floorId);
    }

    query += ' ORDER BY f.display_order, t.display_order';

    const [tables] = await pool.query(query, params);
    return tables;
  },

  // ========================
  // Session Management
  // ========================

  /**
   * Start table session (occupy table)
   * Validates that floor shift is open before allowing session start
   */
  async startSession(tableId, data, userId) {
    const pool = getPool();

    // ── Pre-transaction validation (no connection held) ──
    // Lightweight single-table query instead of getById (4 JOINs)
    const [[table]] = await pool.query(
      `SELECT id, table_number, name, status, floor_id, outlet_id
       FROM tables WHERE id = ? AND is_active = 1`,
      [tableId]
    );
    if (!table) throw new Error('Table not found');
    if (table.status !== 'available' && table.status !== 'reserved') {
      throw new Error(`Table is currently ${table.status}`);
    }

    // Validate floor shift BEFORE acquiring transaction connection
    if (table.floor_id) {
      const [[shift]] = await pool.query(
        `SELECT ds.id FROM day_sessions ds
         WHERE ds.floor_id = ? AND ds.outlet_id = ? AND ds.status = 'open'
         ORDER BY ds.id DESC LIMIT 1`,
        [table.floor_id, table.outlet_id]
      );
      if (!shift) {
        const [[floor]] = await pool.query('SELECT name FROM floors WHERE id = ?', [table.floor_id]);
        const floorName = floor?.name || `Floor ${table.floor_id}`;
        throw new Error(`Shift not opened for ${floorName}. Please ask the assigned cashier to open the shift first.`);
      }
    }

    // ── Transaction: only write operations (fast) ──
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      // Close any existing active sessions for this table to prevent duplicates
      await connection.query(
        `UPDATE table_sessions SET status = 'closed', ended_at = NOW() 
         WHERE table_id = ? AND status = 'active'`,
        [tableId]
      );

      // Create session
      const [result] = await connection.query(
        `INSERT INTO table_sessions (table_id, guest_count, guest_name, guest_phone, started_by, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          tableId,
          data.guestCount || 1,
          data.guestName || null,
          data.guestPhone || null,
          userId,
          data.notes || null
        ]
      );

      // Update table status
      await connection.query('UPDATE tables SET status = "occupied" WHERE id = ?', [tableId]);

      await connection.commit();

      const sessionId = result.insertId;

      // Fire-and-forget: log, broadcast, cache (don't block response)
      Promise.all([
        this.logHistory(tableId, 'session_started', { sessionId, guestCount: data.guestCount, startedBy: userId }),
        this.invalidateCache(table.outlet_id, table.floor_id, tableId)
      ]).catch(err => logger.error('startSession post-commit error:', err.message));

      this.broadcastTableUpdate(table.outlet_id, table.floor_id, {
        tableId,
        tableNumber: table.table_number,
        event: 'session_started',
        sessionId,
        captain: userId
      });

      // Return lightweight result (skip redundant getById with 4 JOINs)
      return {
        sessionId,
        table: {
          id: table.id,
          tableNumber: table.table_number,
          name: table.name,
          status: 'occupied',
          floorId: table.floor_id,
          outletId: table.outlet_id
        }
      };

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * End table session
   */
  async endSession(tableId, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const table = await this.getById(tableId);
      if (!table) throw new Error('Table not found');

      // Get active session
      const [sessions] = await connection.query(
        'SELECT * FROM table_sessions WHERE table_id = ? AND status = "active"',
        [tableId]
      );

      if (sessions.length === 0) throw new Error('No active session found');

      const session = sessions[0];

      // End session
      await connection.query(
        'UPDATE table_sessions SET status = "completed", ended_at = NOW(), ended_by = ? WHERE id = ?',
        [userId, session.id]
      );

      // Unmerge any merged tables and restore capacity
      const [activeMerges] = await connection.query(
        `SELECT tm.merged_table_id, t.capacity
         FROM table_merges tm
         JOIN tables t ON tm.merged_table_id = t.id
         WHERE tm.primary_table_id = ? AND tm.unmerged_at IS NULL`,
        [tableId]
      );

      if (activeMerges.length > 0) {
        // Mark merge records as unmerged
        await connection.query(
          'UPDATE table_merges SET unmerged_at = NOW(), unmerged_by = ? WHERE primary_table_id = ? AND unmerged_at IS NULL',
          [userId, tableId]
        );

        // Restore secondary tables to available
        const mergedIds = activeMerges.map(m => m.merged_table_id);
        await connection.query(
          'UPDATE tables SET status = "available" WHERE id IN (?)',
          [mergedIds]
        );

        // Restore primary table capacity
        const capacityToRemove = activeMerges.reduce((sum, m) => sum + (m.capacity || 0), 0);
        if (capacityToRemove > 0) {
          await connection.query(
            'UPDATE tables SET capacity = GREATEST(1, capacity - ?) WHERE id = ?',
            [capacityToRemove, tableId]
          );
        }
      }

      // Update primary table to available (session ended)
      await connection.query('UPDATE tables SET status = "available" WHERE id = ?', [tableId]);

      await connection.commit();

      // Log and broadcast
      await this.logHistory(tableId, 'session_ended', {
        sessionId: session.id,
        duration: Math.floor((new Date() - new Date(session.started_at)) / 1000 / 60),
        endedBy: userId
      });

      this.broadcastTableUpdate(table.outlet_id, table.floor_id, {
        tableId,
        tableNumber: table.table_number,
        event: 'session_ended'
      });

      await this.invalidateCache(table.outlet_id, table.floor_id, table.id);
      return true;

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Get active session for table (simple version for internal use)
   */
  async getActiveSession(tableId) {
    const pool = getPool();
    const [sessions] = await pool.query(
      `SELECT * FROM table_sessions WHERE table_id = ? AND status = 'active'`,
      [tableId]
    );
    return sessions[0] || null;
  },

  /**
   * Get current session for table (with full details)
   */
  async getCurrentSession(tableId) {
    const pool = getPool();
    const [sessions] = await pool.query(
      `SELECT ts.*, 
        u.name as captain_name, u.employee_code as captain_code,
        o.id as order_id, o.order_number, o.total_amount, o.status as order_status,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count,
        (SELECT COUNT(*) FROM kot_tickets kt WHERE kt.order_id = o.id AND kt.status IN ('pending', 'preparing')) as pending_kots
       FROM table_sessions ts
       LEFT JOIN users u ON ts.started_by = u.id
       LEFT JOIN orders o ON ts.order_id = o.id
       WHERE ts.table_id = ? AND ts.status = 'active'`,
      [tableId]
    );
    return sessions[0] || null;
  },

  /**
   * Transfer table session to another captain (Manager/Admin only)
   */
  async transferSession(tableId, newCaptainId, transferredBy) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // Verify transferredBy is admin/manager
      const [userRoles] = await connection.query(
        `SELECT r.slug as role_name FROM user_roles ur 
         JOIN roles r ON ur.role_id = r.id 
         WHERE ur.user_id = ? AND ur.is_active = 1`,
        [transferredBy]
      );
      const isAdminOrManager = userRoles.some(r => ['admin', 'manager', 'super_admin'].includes(r.role_name));
      if (!isAdminOrManager) {
        throw new Error('Only managers and admins can transfer tables');
      }

      // Get active session
      const session = await this.getActiveSession(tableId);
      if (!session) {
        throw new Error('No active session found on this table');
      }

      const oldCaptainId = session.started_by;

      // Verify new captain exists
      const [newCaptain] = await connection.query(
        `SELECT u.id, u.name FROM users u WHERE u.id = ? AND u.is_active = 1`,
        [newCaptainId]
      );
      if (!newCaptain[0]) {
        throw new Error('New captain not found or inactive');
      }

      // Update session owner
      await connection.query(
        'UPDATE table_sessions SET started_by = ? WHERE id = ?',
        [newCaptainId, session.id]
      );

      // Log transfer
      await connection.query(
        `INSERT INTO table_history (table_id, action, details, performed_by) 
         VALUES (?, 'session_transferred', ?, ?)`,
        [
          tableId,
          JSON.stringify({
            sessionId: session.id,
            fromCaptain: oldCaptainId,
            toCaptain: newCaptainId,
            newCaptainName: newCaptain[0].name
          }),
          transferredBy
        ]
      );

      await connection.commit();

      const table = await this.getById(tableId);

      // Broadcast update
      this.broadcastTableUpdate(table.outlet_id, table.floor_id, {
        tableId,
        tableNumber: table.table_number,
        event: 'session_transferred',
        fromCaptain: oldCaptainId,
        toCaptain: newCaptainId,
        newCaptainName: newCaptain[0].name
      });

      return {
        success: true,
        sessionId: session.id,
        newCaptainId,
        newCaptainName: newCaptain[0].name
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ========================
  // Table Merge Operations
  // ========================

  /**
   * Merge tables
   * - Secondary tables get status "merged" and are disabled for ordering
   * - Primary table capacity = original + sum of all merged table capacities
   * - Billing status on either table blocks the merge
   * - If both tables have active orders, items are consolidated into the primary order
   * - On unmerge, everything is restored (orders stay on primary)
   */
  async mergeTables(primaryTableId, tableIdsToMerge, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // 1. Batch-fetch primary + all secondary tables in one query (optimized)
      const allTableIds = [primaryTableId, ...tableIdsToMerge];
      const [allTables] = await connection.query(
        `SELECT t.id, t.table_number, t.capacity, t.status, t.is_mergeable,
                t.floor_id, t.section_id, t.outlet_id, t.is_active
         FROM tables t WHERE t.id IN (?)`,
        [allTableIds]
      );
      const tableMap = new Map(allTables.map(t => [t.id, t]));

      // 2. Validate primary table
      const primaryTable = tableMap.get(parseInt(primaryTableId));
      if (!primaryTable) throw new Error('Primary table not found');
      if (!primaryTable.is_mergeable) throw new Error('Primary table is not mergeable');
      if (primaryTable.status === 'merged') throw new Error('This table is already merged into another table');
      if (primaryTable.status === 'billing') throw new Error('Cannot merge tables with billing status');

      // 3. Validate all secondary tables (status-based rules)
      const secondaryTables = [];
      for (const tableId of tableIdsToMerge) {
        const table = tableMap.get(parseInt(tableId));
        if (!table) throw new Error(`Table ${tableId} not found`);
        if (!table.is_mergeable) throw new Error(`Table ${table.table_number} is not mergeable`);
        if (table.status === 'merged') throw new Error(`Table ${table.table_number} is already merged`);
        if (table.status === 'billing') throw new Error('Cannot merge tables with billing status');
        if (table.floor_id !== primaryTable.floor_id) {
          throw new Error('Cannot merge tables from different floors');
        }
        secondaryTables.push(table);
      }

      // 4. Get active sessions on ALL tables in one query (optimized)
      const [allSessions] = await connection.query(
        `SELECT ts.id, ts.table_id, ts.order_id, ts.status
         FROM table_sessions ts
         WHERE ts.table_id IN (?) AND ts.status = 'active'`,
        [allTableIds]
      );
      const primarySession = allSessions.find(s => s.table_id === parseInt(primaryTableId));
      const secondarySessions = allSessions.filter(s => s.table_id !== parseInt(primaryTableId));

      // 5. Order consolidation: merge orders from secondary tables into primary
      let primaryOrderId = primarySession?.order_id || null;
      const mergedOrderIds = []; // secondary orders whose items were moved

      if (secondarySessions.length > 0) {
        const secondaryOrderIds = secondarySessions
          .filter(s => s.order_id)
          .map(s => s.order_id);

        if (secondaryOrderIds.length > 0) {
          if (!primaryOrderId) {
            // Primary has no order — adopt the first secondary order
            primaryOrderId = secondaryOrderIds.shift();
            await connection.query(
              `UPDATE orders SET table_id = ?, floor_id = ?, section_id = ? WHERE id = ?`,
              [primaryTableId, primaryTable.floor_id, primaryTable.section_id, primaryOrderId]
            );
            // Move its session to primary table
            const adoptedSession = secondarySessions.find(s => s.order_id === primaryOrderId);
            if (adoptedSession) {
              await connection.query(
                'UPDATE table_sessions SET table_id = ? WHERE id = ?',
                [primaryTableId, adoptedSession.id]
              );
            }
          }

          // Move remaining secondary order items → primary order
          if (secondaryOrderIds.length > 0 && primaryOrderId) {
            // Move order_items
            await connection.query(
              'UPDATE order_items SET order_id = ? WHERE order_id IN (?)',
              [primaryOrderId, secondaryOrderIds]
            );
            // Move KOT tickets
            await connection.query(
              'UPDATE kot_tickets SET order_id = ? WHERE order_id IN (?)',
              [primaryOrderId, secondaryOrderIds]
            );
            // Move order_discounts
            await connection.query(
              'UPDATE order_discounts SET order_id = ? WHERE order_id IN (?)',
              [primaryOrderId, secondaryOrderIds]
            );
            // Cancel secondary orders (merged)
            await connection.query(
              `UPDATE orders SET status = 'cancelled', cancel_reason = 'Merged into another table order',
               cancelled_by = ?, cancelled_at = NOW() WHERE id IN (?)`,
              [userId, secondaryOrderIds]
            );
            mergedOrderIds.push(...secondaryOrderIds);

            // Recalculate primary order totals (lazy require to avoid circular dependency)
            const orderService = require('./order.service');
            await orderService.recalculateTotals(primaryOrderId, connection);
          }
        }

        // End all secondary table sessions (except the adopted one, which was moved above)
        const sessionsToEnd = secondarySessions
          .filter(s => !(!primarySession && s.order_id === primaryOrderId))
          .map(s => s.id);
        if (sessionsToEnd.length > 0) {
          await connection.query(
            `UPDATE table_sessions SET status = 'completed', ended_at = NOW(), ended_by = ? WHERE id IN (?)`,
            [userId, sessionsToEnd]
          );
        }
      }

      // 6. Create merge records + mark secondary tables as merged (batch)
      const mergeValues = secondaryTables.map(t =>
        [primaryTableId, t.id, primarySession?.id || null, userId]
      );
      if (mergeValues.length > 0) {
        await connection.query(
          `INSERT INTO table_merges (primary_table_id, merged_table_id, table_session_id, merged_by)
           VALUES ?`,
          [mergeValues]
        );
        await connection.query(
          'UPDATE tables SET status = "merged" WHERE id IN (?)',
          [tableIdsToMerge]
        );
      }

      // 7. Update primary table capacity + status
      const addedCapacity = secondaryTables.reduce((sum, t) => sum + (t.capacity || 0), 0);
      // If primary was available but now has an adopted order, set to running
      let newPrimaryStatus = primaryTable.status;
      if (primaryOrderId && primaryTable.status === 'available') {
        newPrimaryStatus = 'running';
      }
      await connection.query(
        'UPDATE tables SET capacity = capacity + ?, status = ? WHERE id = ?',
        [addedCapacity, newPrimaryStatus, primaryTableId]
      );

      await connection.commit();

      // Log and broadcast (non-blocking)
      this.logHistory(primaryTableId, 'tables_merged', {
        mergedTableIds: tableIdsToMerge,
        addedCapacity,
        originalCapacity: primaryTable.capacity,
        mergedOrderIds,
        primaryOrderId,
        mergedBy: userId
      }).catch(err => logger.error('Merge history log error:', err.message));

      this.broadcastTableUpdate(primaryTable.outlet_id, primaryTable.floor_id, {
        event: 'tables_merged',
        primaryTableId,
        mergedTableIds: tableIdsToMerge
      });

      await this.invalidateCache(primaryTable.outlet_id, primaryTable.floor_id, primaryTableId);
      return this.getMergedTables(primaryTableId);

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Unmerge tables
   * - Secondary tables restored to "available"
   * - Primary table capacity reduced by the sum of merged table capacities
   * - Handles both primary and secondary table IDs
   * - VALIDATION: Cannot unmerge if session is active or order exists
   */
  async unmergeTables(tableId, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // 1. Fetch table + check as primary in one query (optimized: use connection, not pool)
      const [[tableRow], [merges0]] = await Promise.all([
        connection.query(
          `SELECT id, table_number, capacity, status, floor_id, section_id, outlet_id
           FROM tables WHERE id = ?`, [tableId]
        ),
        connection.query(
          `SELECT tm.merged_table_id, tm.primary_table_id, t.capacity, t.table_number, t.floor_id
           FROM table_merges tm
           JOIN tables t ON tm.merged_table_id = t.id
           WHERE tm.primary_table_id = ? AND tm.unmerged_at IS NULL`, [tableId]
        )
      ]);

      if (!tableRow[0]) throw new Error('Table not found');

      let primaryTableId = tableId;
      let primaryTable = tableRow[0];
      let merges = merges0;

      // If no merges found as primary, check if this table is a secondary (merged) table
      if (merges.length === 0) {
        const [secondaryCheck] = await connection.query(
          `SELECT tm.primary_table_id FROM table_merges tm
           WHERE tm.merged_table_id = ? AND tm.unmerged_at IS NULL`, [tableId]
        );

        if (secondaryCheck.length > 0) {
          primaryTableId = secondaryCheck[0].primary_table_id;
          // Fetch primary table + its merges in parallel
          const [[primaryRow], [mergesFromPrimary]] = await Promise.all([
            connection.query(
              `SELECT id, table_number, capacity, status, floor_id, section_id, outlet_id
               FROM tables WHERE id = ?`, [primaryTableId]
            ),
            connection.query(
              `SELECT tm.merged_table_id, t.capacity, t.table_number, t.floor_id
               FROM table_merges tm
               JOIN tables t ON tm.merged_table_id = t.id
               WHERE tm.primary_table_id = ? AND tm.unmerged_at IS NULL`, [primaryTableId]
            )
          ]);
          primaryTable = primaryRow[0];
          merges = mergesFromPrimary;
        }
      }

      if (merges.length === 0) throw new Error('No merged tables found for this table');

      // VALIDATION: Block unmerge if primary has active session with order
      const blockedStatuses = ['occupied', 'running', 'billing'];
      if (blockedStatuses.includes(primaryTable.status)) {
        const [activeSessions] = await connection.query(
          `SELECT ts.id, ts.order_id, o.order_number
           FROM table_sessions ts
           LEFT JOIN orders o ON ts.order_id = o.id
           WHERE ts.table_id = ? AND ts.status = 'active'`,
          [primaryTableId]
        );
        if (activeSessions.length > 0) {
          const session = activeSessions[0];
          throw new Error(`Cannot unmerge: Table ${primaryTable.table_number} has active session${session.order_number ? ` with order ${session.order_number}` : ''}. Complete the order/payment first.`);
        }
      }

      // 2. Unmerge records + restore secondary tables + reduce capacity (batch)
      const mergedIds = merges.map(m => m.merged_table_id);
      const capacityToRemove = merges.reduce((sum, m) => sum + (m.capacity || 0), 0);

      await Promise.all([
        connection.query(
          'UPDATE table_merges SET unmerged_at = NOW(), unmerged_by = ? WHERE primary_table_id = ? AND unmerged_at IS NULL',
          [userId, primaryTableId]
        ),
        connection.query(
          'UPDATE tables SET status = "available" WHERE id IN (?)',
          [mergedIds]
        ),
        capacityToRemove > 0
          ? connection.query(
              'UPDATE tables SET capacity = GREATEST(1, capacity - ?) WHERE id = ?',
              [capacityToRemove, primaryTableId]
            )
          : Promise.resolve()
      ]);

      await connection.commit();

      // Non-blocking post-commit: log, emit, broadcast, cache
      const unmergedTables = merges.map(t => ({
        id: t.merged_table_id, tableNumber: t.table_number, floorId: t.floor_id
      }));

      this.logHistory(primaryTableId, 'tables_unmerged', {
        unmergedTableIds: mergedIds,
        removedCapacity: capacityToRemove,
        unmergedBy: userId
      }).catch(err => logger.error('Unmerge history log error:', err.message));

      const { publishMessage } = require('../config/redis');
      publishMessage('table:unmerge', {
        outletId: primaryTable.outlet_id,
        primaryTableId,
        primaryTableNumber: primaryTable.table_number,
        floorId: primaryTable.floor_id,
        unmergedTableIds: mergedIds,
        unmergedTables,
        event: 'tables_unmerged',
        unmergedBy: userId,
        timestamp: new Date().toISOString()
      }).catch(err => logger.error('Unmerge publish error:', err.message));

      this.broadcastTableUpdate(primaryTable.outlet_id, primaryTable.floor_id, {
        event: 'tables_unmerged',
        primaryTableId,
        unmergedTableIds: mergedIds
      });

      this.invalidateCache(primaryTable.outlet_id, primaryTable.floor_id, primaryTable.id)
        .catch(err => logger.error('Unmerge cache invalidation error:', err.message));

      return true;

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  /**
   * Get merged tables for a primary table
   */
  async getMergedTables(primaryTableId) {
    const pool = getPool();
    const [merges] = await pool.query(
      `SELECT tm.*, t.table_number, t.capacity
       FROM table_merges tm
       JOIN tables t ON tm.merged_table_id = t.id
       WHERE tm.primary_table_id = ? AND tm.unmerged_at IS NULL`,
      [primaryTableId]
    );
    return merges;
  },

  // ========================
  // Table History & Reports
  // ========================

  /**
   * Log table history
   */
  async logHistory(tableId, eventType, eventData) {
    const pool = getPool();
    try {
      await pool.query(
        `INSERT INTO table_history (table_id, event_type, event_data, created_at)
         VALUES (?, ?, ?, NOW())`,
        [tableId, eventType, JSON.stringify(eventData)]
      );
    } catch (error) {
      // Table might not exist yet, create it
      if (error.code === 'ER_NO_SUCH_TABLE') {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS table_history (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            table_id BIGINT UNSIGNED NOT NULL,
            event_type VARCHAR(50) NOT NULL,
            event_data JSON,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_table_history_table (table_id),
            INDEX idx_table_history_type (event_type),
            INDEX idx_table_history_created (created_at)
          )
        `);
        await pool.query(
          `INSERT INTO table_history (table_id, event_type, event_data, created_at)
           VALUES (?, ?, ?, NOW())`,
          [tableId, eventType, JSON.stringify(eventData)]
        );
      } else {
        logger.error('Error logging table history:', error);
      }
    }
  },

  /**
   * Get table history
   */
  async getHistory(tableId, limit = 50) {
    const pool = getPool();
    try {
      const [history] = await pool.query(
        `SELECT * FROM table_history 
         WHERE table_id = ? 
         ORDER BY created_at DESC 
         LIMIT ?`,
        [tableId, limit]
      );
      return history;
    } catch (error) {
      return [];
    }
  },

  /**
   * Get table session history
   */
  async getSessionHistory(tableId, fromDate, toDate, limit = 100) {
    const pool = getPool();
    
    let query = `
      SELECT ts.*, 
        u_start.name as started_by_name,
        u_end.name as ended_by_name,
        o.order_number, o.total_amount, o.payment_status,
        TIMESTAMPDIFF(MINUTE, ts.started_at, COALESCE(ts.ended_at, NOW())) as duration_minutes
      FROM table_sessions ts
      LEFT JOIN users u_start ON ts.started_by = u_start.id
      LEFT JOIN users u_end ON ts.ended_by = u_end.id
      LEFT JOIN orders o ON ts.order_id = o.id
      WHERE ts.table_id = ?
    `;
    const params = [tableId];

    if (fromDate) {
      query += ' AND ts.started_at >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      query += ' AND ts.started_at <= ?';
      params.push(toDate);
    }

    query += ' ORDER BY ts.started_at DESC LIMIT ?';
    params.push(limit);

    const [sessions] = await pool.query(query, params);
    return sessions;
  },

  /**
   * Get table-wise report
   */
  async getTableReport(tableId, fromDate, toDate) {
    const pool = getPool();
    
    const [report] = await pool.query(
      `SELECT 
        COUNT(DISTINCT ts.id) as total_sessions,
        SUM(ts.guest_count) as total_guests,
        AVG(ts.guest_count) as avg_guests,
        AVG(TIMESTAMPDIFF(MINUTE, ts.started_at, ts.ended_at)) as avg_duration_minutes,
        COUNT(DISTINCT o.id) as total_orders,
        SUM(o.total_amount) as total_sales,
        AVG(o.total_amount) as avg_order_value,
        COUNT(DISTINCT o.created_by) as unique_captains
       FROM table_sessions ts
       LEFT JOIN orders o ON ts.order_id = o.id
       WHERE ts.table_id = ?
         AND ts.started_at >= ?
         AND ts.started_at <= ?
         AND ts.status = 'completed'`,
      [tableId, fromDate, toDate]
    );

    // Get captain breakdown
    const [captains] = await pool.query(
      `SELECT u.id, u.name, u.employee_code,
        COUNT(DISTINCT ts.id) as sessions,
        COUNT(DISTINCT o.id) as orders,
        SUM(o.total_amount) as sales
       FROM table_sessions ts
       JOIN users u ON ts.started_by = u.id
       LEFT JOIN orders o ON ts.order_id = o.id
       WHERE ts.table_id = ?
         AND ts.started_at >= ?
         AND ts.started_at <= ?
       GROUP BY u.id
       ORDER BY sales DESC`,
      [tableId, fromDate, toDate]
    );

    // Get hourly distribution
    const [hourly] = await pool.query(
      `SELECT HOUR(ts.started_at) as hour, COUNT(*) as sessions
       FROM table_sessions ts
       WHERE ts.table_id = ?
         AND ts.started_at >= ?
         AND ts.started_at <= ?
       GROUP BY HOUR(ts.started_at)
       ORDER BY hour`,
      [tableId, fromDate, toDate]
    );

    return {
      summary: report[0],
      captains,
      hourlyDistribution: hourly
    };
  },

  /**
   * Get floor-wise report
   */
  async getFloorReport(floorId, fromDate, toDate) {
    const pool = getPool();
    
    const [tables] = await pool.query(
      `SELECT t.id, t.table_number, t.capacity,
        COUNT(DISTINCT ts.id) as sessions,
        SUM(ts.guest_count) as guests,
        COUNT(DISTINCT o.id) as orders,
        SUM(o.total_amount) as sales,
        AVG(TIMESTAMPDIFF(MINUTE, ts.started_at, ts.ended_at)) as avg_duration
       FROM tables t
       LEFT JOIN table_sessions ts ON t.id = ts.table_id 
         AND ts.started_at >= ? AND ts.started_at <= ? AND ts.status = 'completed'
       LEFT JOIN orders o ON ts.order_id = o.id
       WHERE t.floor_id = ? AND t.is_active = 1
       GROUP BY t.id
       ORDER BY sales DESC`,
      [fromDate, toDate, floorId]
    );

    const [summary] = await pool.query(
      `SELECT 
        COUNT(DISTINCT t.id) as total_tables,
        SUM(t.capacity) as total_capacity,
        COUNT(DISTINCT ts.id) as total_sessions,
        SUM(o.total_amount) as total_sales
       FROM tables t
       LEFT JOIN table_sessions ts ON t.id = ts.table_id 
         AND ts.started_at >= ? AND ts.started_at <= ? AND ts.status = 'completed'
       LEFT JOIN orders o ON ts.order_id = o.id
       WHERE t.floor_id = ? AND t.is_active = 1`,
      [fromDate, toDate, floorId]
    );

    return {
      summary: summary[0],
      tables
    };
  },

  /**
   * Get running KOTs for a table
   */
  async getRunningKots(tableId) {
    const pool = getPool();
    
    const [kots] = await pool.query(
      `SELECT kt.*, 
        u.name as created_by_name,
        (SELECT JSON_ARRAYAGG(
          JSON_OBJECT('id', ki.id, 'itemName', ki.item_name, 'quantity', ki.quantity, 'status', ki.status)
        ) FROM kot_items ki WHERE ki.kot_id = kt.id) as items
       FROM kot_tickets kt
       JOIN orders o ON kt.order_id = o.id
       JOIN table_sessions ts ON o.table_session_id = ts.id
       LEFT JOIN users u ON kt.created_by = u.id
       WHERE ts.table_id = ? AND ts.status = 'active' AND kt.status IN ('pending', 'accepted', 'preparing')
       ORDER BY kt.created_at ASC`,
      [tableId]
    );

    return kots;
  },

  // ========================
  // Table Transfer
  // ========================

  /**
   * Transfer table session from one table to another
   * Moves entire session including orders, KOTs, billing data
   * Only Cashier, Captain, Manager, Admin, Super Admin can perform this
   * 
   * @param {number} sourceTableId - Table to transfer FROM
   * @param {number} targetTableId - Table to transfer TO
   * @param {number} userId - User performing the transfer
   * @returns {Object} Transfer result with updated table info
   */
  async transferTable(sourceTableId, targetTableId, userId) {
    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      // 1. Validate user role - only authorized roles can transfer
      const [userRoles] = await connection.query(
        `SELECT r.slug as role_name FROM user_roles ur 
         JOIN roles r ON ur.role_id = r.id 
         WHERE ur.user_id = ? AND ur.is_active = 1`,
        [userId]
      );
      const allowedRoles = ['super_admin', 'admin', 'manager', 'cashier', 'captain'];
      const hasPermission = userRoles.some(r => allowedRoles.includes(r.role_name));
      if (!hasPermission) {
        throw new Error('Only Cashier, Captain, Manager, Admin, or Super Admin can transfer tables');
      }

      // 2. Get source table with active session
      const sourceTable = await this.getById(sourceTableId);
      if (!sourceTable) throw new Error('Source table not found');
      if (!['occupied', 'running', 'billing'].includes(sourceTable.status)) {
        throw new Error(`Source table is ${sourceTable.status}, must be occupied/running/billing to transfer`);
      }

      // 3. Get active session on source table
      const [sourceSessions] = await connection.query(
        `SELECT ts.*, o.id as order_id, o.order_number, o.status as order_status, 
                o.floor_id, o.section_id, o.customer_id, o.customer_name
         FROM table_sessions ts
         LEFT JOIN orders o ON ts.order_id = o.id
         WHERE ts.table_id = ? AND ts.status = 'active'`,
        [sourceTableId]
      );
      if (!sourceSessions[0]) {
        throw new Error('No active session found on source table');
      }
      const session = sourceSessions[0];

      // 4. Get target table and validate
      const targetTable = await this.getById(targetTableId);
      if (!targetTable) throw new Error('Target table not found');
      if (targetTable.status !== 'available') {
        throw new Error(`Target table is ${targetTable.status}, must be available for transfer`);
      }
      if (targetTable.outlet_id !== sourceTable.outlet_id) {
        throw new Error('Cannot transfer between different outlets');
      }

      // 5. Store old values for audit
      const transferDetails = {
        sourceTableId,
        sourceTableNumber: sourceTable.table_number,
        sourceFloorId: sourceTable.floor_id,
        targetTableId,
        targetTableNumber: targetTable.table_number,
        targetFloorId: targetTable.floor_id,
        sessionId: session.id,
        orderId: session.order_id,
        orderNumber: session.order_number,
        transferredBy: userId,
        transferredAt: new Date()
      };

      // 6. Update table_sessions - move to new table
      await connection.query(
        `UPDATE table_sessions SET table_id = ? WHERE id = ?`,
        [targetTableId, session.id]
      );

      // 7. Update orders - change table reference
      if (session.order_id) {
        await connection.query(
          `UPDATE orders SET 
            table_id = ?, 
            floor_id = ?, 
            section_id = ?
           WHERE id = ?`,
          [targetTableId, targetTable.floor_id, targetTable.section_id, session.order_id]
        );

        // 8. Update future KOT references - change table_number for new prints
        // Note: We update table_number on orders table reference, not on existing KOTs
        // Existing KOT history stays intact, new KOTs will get new table number from order
      }

      // 9. Update source table status to available
      await connection.query(
        `UPDATE tables SET status = 'available' WHERE id = ?`,
        [sourceTableId]
      );

      // 10. Update target table status to match source's previous status
      await connection.query(
        `UPDATE tables SET status = ? WHERE id = ?`,
        [sourceTable.status, targetTableId]
      );

      // 11. Handle merged tables - if source had merged tables, transfer them too
      const [mergedTables] = await connection.query(
        `SELECT merged_table_id FROM table_merges 
         WHERE primary_table_id = ? AND unmerged_at IS NULL`,
        [sourceTableId]
      );
      if (mergedTables.length > 0) {
        // Update merge records to point to new primary table
        await connection.query(
          `UPDATE table_merges SET primary_table_id = ? 
           WHERE primary_table_id = ? AND unmerged_at IS NULL`,
          [targetTableId, sourceTableId]
        );
        transferDetails.mergedTableIds = mergedTables.map(m => m.merged_table_id);
      }

      // 12. Log history for both tables
      await connection.query(
        `INSERT INTO table_history (table_id, event_type, event_data, created_at) VALUES (?, ?, ?, NOW())`,
        [sourceTableId, 'table_transferred_from', JSON.stringify(transferDetails)]
      );
      await connection.query(
        `INSERT INTO table_history (table_id, event_type, event_data, created_at) VALUES (?, ?, ?, NOW())`,
        [targetTableId, 'table_transferred_to', JSON.stringify(transferDetails)]
      );

      await connection.commit();

      // 13. Broadcast real-time updates to BOTH floors (source and target may be different)
      // Source table update - now available
      this.broadcastTableUpdate(sourceTable.outlet_id, sourceTable.floor_id, {
        event: 'table_transferred',
        type: 'source',
        tableId: sourceTableId,
        tableNumber: sourceTable.table_number,
        newStatus: 'available',
        transfer: transferDetails
      });

      // Target table update - now has session
      this.broadcastTableUpdate(targetTable.outlet_id, targetTable.floor_id, {
        event: 'table_transferred',
        type: 'target',
        tableId: targetTableId,
        tableNumber: targetTable.table_number,
        newStatus: sourceTable.status,
        transfer: transferDetails
      });

      // Also broadcast to outlet level for POS/Kitchen screens
      const { publishMessage } = require('../config/redis');
      await publishMessage('table:transfer', {
        outletId: sourceTable.outlet_id,
        ...transferDetails
      });

      // Invalidate cache for both tables and floors
      await this.invalidateCache(sourceTable.outlet_id, sourceTable.floor_id, sourceTableId);
      await this.invalidateCache(targetTable.outlet_id, targetTable.floor_id, targetTableId);

      // Get updated table info
      const updatedSourceTable = await this.getById(sourceTableId);
      const updatedTargetTable = await this.getById(targetTableId);

      return {
        success: true,
        message: `Table transferred from ${sourceTable.table_number} to ${targetTable.table_number}`,
        transfer: transferDetails,
        sourceTable: updatedSourceTable,
        targetTable: updatedTargetTable
      };

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },

  // ========================
  // Utilities
  // ========================

  /**
   * Broadcast table update via Socket.IO
   */
  broadcastTableUpdate(outletId, floorId, data) {
    try {
      emit.toFloor(outletId, floorId, 'table:update', data);
    } catch (error) {
      logger.error('Error broadcasting table update:', error);
    }
  },

  /**
   * Invalidate cache
   */
  async invalidateCache(outletId, floorId, tableId) {
    const delOps = [
      cache.del(`tables:outlet:${outletId}`),
      cache.del(`tables:floor:${floorId}`)
    ];
    if (tableId) delOps.push(cache.del(`table:detail:${tableId}`));
    await Promise.all(delOps);
  },

  /**
   * Get available table statuses
   */
  getStatuses() {
    return TABLE_STATUSES.map(s => ({
      value: s,
      label: s.charAt(0).toUpperCase() + s.slice(1)
    }));
  },

  /**
   * Get table shapes
   */
  getShapes() {
    return ['square', 'rectangle', 'round', 'oval', 'custom'].map(s => ({
      value: s,
      label: s.charAt(0).toUpperCase() + s.slice(1)
    }));
  }
};

module.exports = tableService;
