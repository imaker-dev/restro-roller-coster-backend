const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const corsConfig = require('./cors.config');
const redisConfig = require('./redis.config');
const logger = require('../utils/logger');
const { pubsub, isRedisAvailable, publishMessage, registerLocalEmitter } = require('./redis');

let io = null;

const initializeSocket = (server) => {
  // Build Socket.IO CORS: allow mobile apps (no Origin header) + web origins
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) || [];
  const socketCors = {
    ...corsConfig,
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, server-to-server, curl)
      if (!origin) return callback(null, true);
      // In development, allow all
      if (process.env.NODE_ENV !== 'production') return callback(null, true);
      // Always allow localhost origins for development/testing
      if (origin.includes('localhost') || origin.includes('127.0.0.1')) return callback(null, true);
      // In production, check against allowed origins
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      logger.warn(`Socket.IO CORS rejected origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    },
  };

  io = new Server(server, {
    cors: socketCors,
    pingInterval: parseInt(process.env.WS_PING_INTERVAL, 10) || 25000,
    pingTimeout: parseInt(process.env.WS_PING_TIMEOUT, 10) || 60000,
    transports: ['polling', 'websocket'],
    allowEIO3: true,
    path: process.env.SOCKET_PATH || '/socket.io',
    // Mobile app compatibility settings
    cookie: false, // Disable cookies - mobile apps use query params for session tracking
    allowUpgrades: true, // Allow upgrades from polling to websocket
    httpCompression: false, // Disable compression for better mobile compatibility
    addTrailingSlash: false, // Some mobile HTTP clients don't handle trailing slashes well
    perMessageDeflate: false, // Disable compression for WebSocket (can cause issues with some clients)
    // Additional mobile-friendly settings
    connectTimeout: 45000, // Connection timeout for mobile clients
    maxHttpBufferSize: 1e6, // 1MB max buffer size
  });

  // Log Socket.IO initialization
  const port = server.address()?.port || process.env.PORT || process.env.PROD_PORT || 'unknown';
  logger.info(`Socket.IO server initialized on port ${port} at path ${process.env.SOCKET_PATH || '/socket.io/'}`);
  logger.info(`Socket.IO transports: ${['websocket', 'polling'].join(', ')}`);

  // Attach Redis adapter for PM2 cluster mode session sharing
  if (isRedisAvailable()) {
    try {
      const pubClient = new Redis({
        host: redisConfig.host,
        port: redisConfig.port,
        password: redisConfig.password,
        db: redisConfig.db,
      });
      const subClient = pubClient.duplicate();
      // Namespace adapter keys so multiple deployments on the same Redis don't leak events
      const adapterOptions = redisConfig.namespace
        ? { keyPrefix: `${redisConfig.namespace}:` }
        : {};
      io.adapter(createAdapter(pubClient, subClient, adapterOptions));
      logger.info('Socket.IO Redis adapter attached (cluster-safe)');
    } catch (err) {
      logger.warn('Socket.IO Redis adapter setup failed, cluster sync disabled:', err.message);
    }
  }

  // Log incoming requests only in development (too verbose for production at 1000+ connections)
  if (process.env.NODE_ENV !== 'production') {
    io.engine.on('initial_headers', (headers, req) => {
      logger.debug(`[Socket.IO] Incoming request: ${req.method} ${req.url}`);
    });
  }

  // Log connection errors at engine level (before 'connection' event)
  io.engine.on('connection_error', (err) => {
    logger.error(`[Socket.IO Engine] connection_error: code=${err.code} message=${err.message} context=${JSON.stringify(err.context || {})}`);
    if (err.req) {
      logger.error(`[Socket.IO Engine] Request URL: ${err.req.url}`);
      logger.error(`[Socket.IO Engine] Request method: ${err.req.method}`);
      logger.error(`[Socket.IO Engine] Request headers: ${JSON.stringify(err.req.headers || {})}`);
    }
  });

  // Log handshake attempts (debug level only — avoid I/O overhead at scale)
  io.use((socket, next) => {
    logger.debug(`[Socket.IO] Handshake: ${socket.handshake.address} transport=${socket.handshake.query?.transport || 'unknown'}`);
    next();
  });

  // Connection handler
  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} transport=${socket.conn.transport.name}`);

    // Join outlet room
    socket.on('join:outlet', (outletId) => {
      socket.join(`outlet:${outletId}`);
      logger.debug(`Socket ${socket.id} joined outlet:${outletId}`);
    });

    // Join floor room
    socket.on('join:floor', ({ outletId, floorId }) => {
      socket.join(`floor:${outletId}:${floorId}`);
      logger.debug(`Socket ${socket.id} joined floor:${outletId}:${floorId}`);
    });

    // Join kitchen room
    socket.on('join:kitchen', (outletId) => {
      socket.join(`kitchen:${outletId}`);
      logger.debug(`Socket ${socket.id} joined kitchen:${outletId}`);
    });

    // Join bar room
    socket.on('join:bar', (outletId) => {
      socket.join(`bar:${outletId}`);
      logger.debug(`Socket ${socket.id} joined bar:${outletId}`);
    });

    // Join station room by station_type (main_kitchen, tandoor, wok, dessert, bar, mocktail, etc.)
    // Also supports joining by station_id for precise routing
    socket.on('join:station', ({ outletId, station, stationId }) => {
      // If station is numeric, treat it as station_id
      if (station && !isNaN(station) && Number.isInteger(Number(station))) {
        const numericStationId = parseInt(station);
        socket.join(`station_id:${outletId}:${numericStationId}`);
        logger.info(`Socket ${socket.id} joined station_id:${outletId}:${numericStationId} (auto-detected from station param)`);
      } else if (station) {
        // Join by station_type (e.g., main_kitchen, dessert, bar)
        socket.join(`station:${outletId}:${station}`);
        logger.info(`Socket ${socket.id} joined station:${outletId}:${station}`);
      }
      
      // Also join by explicit stationId param for precise routing
      if (stationId) {
        socket.join(`station_id:${outletId}:${stationId}`);
        logger.info(`Socket ${socket.id} joined station_id:${outletId}:${stationId}`);
      }
    });

    // Join cashier room
    socket.on('join:cashier', (outletId) => {
      socket.join(`cashier:${outletId}`);
      logger.debug(`Socket ${socket.id} joined cashier:${outletId}`);
    });

    // Join pos_user room (mirrors cashier — receives all cashier events)
    socket.on('join:pos_user', (outletId) => {
      socket.join(`cashier:${outletId}`);
      logger.debug(`Socket ${socket.id} (pos_user) joined cashier:${outletId}`);
    });

    // Join captain room (for order updates)
    socket.on('join:captain', (outletId) => {
      socket.join(`captain:${outletId}`);
      logger.debug(`Socket ${socket.id} joined captain:${outletId}`);
    });

    // ========================
    // MOBILE POS PRINTING
    // ========================
    // Flutter app sends { outletId, userId } on login — no printer setup needed.
    // Backend intercepts ALL prints for that userId and routes to their device.
    // Works for any role: cashier, admin, captain, pos_user, etc.
    //
    //  PRIMARY (recommended — zero config):
    //    Device sends: { outletId, userId }
    //    Room:  mpos:{outletId}:user:{userId}
    //    All KOT/BOT/Bill for that user → their device, regardless of configured printers
    //
    //  OPTIONAL additions (can combine with userId):
    //    station: joins mpos:{outletId}:station:{station}  → station broadcast fallback
    //    deviceId: joins mpos:{outletId}:device:{deviceId} → explicit device targeting
    //
    socket.on('join:mpos', (payload) => {
      const { outletId, station, deviceId, userId } = payload || {};

      if (!outletId) {
        logger.warn(`Socket ${socket.id} join:mpos missing outletId`);
        return;
      }

      socket.mposOutletId = outletId;
      const joined = [];

      // Station room — for station-wide broadcast jobs (KOT to kitchen, etc.)
      // Also acts as fallback when userId not matched
      if (station) {
        const stationKey = String(station).toLowerCase().trim();
        const stationRoom = `mpos:${outletId}:station:${stationKey}`;
        socket.join(stationRoom);
        socket.mposStation = stationKey;
        joined.push(stationRoom);
      }

      // User room — for user-specific jobs (bills go to the cashier who created them)
      // This is the primary route when 5-10 devices share the same station
      if (userId) {
        const userRoom = `mpos:${outletId}:user:${userId}`;
        socket.join(userRoom);
        socket.mposUserId = userId;
        joined.push(userRoom);
      }

      // Device room — explicit targeting (advanced / edge cases)
      if (deviceId) {
        const deviceRoom = `mpos:${outletId}:device:${deviceId}`;
        socket.join(deviceRoom);
        socket.mposDeviceId = deviceId;
        joined.push(deviceRoom);
      }

      if (joined.length === 0) {
        logger.warn(`Socket ${socket.id} join:mpos: must provide station, userId, or deviceId`);
        return;
      }

      socket.mposMode = userId ? 'user' : deviceId ? 'device' : 'station';
      logger.info(`Socket ${socket.id} joined Mobile POS rooms: ${joined.join(', ')}`);
      socket.emit('mpos:connected', {
        mode:     socket.mposMode,
        station:  socket.mposStation  || null,
        userId:   socket.mposUserId   || null,
        deviceId: socket.mposDeviceId || null,
        rooms:    joined,
        outletId,
        socketId: socket.id,
      });
    });

    socket.on('leave:mpos', (payload) => {
      const { outletId, station, deviceId, userId } = payload || {};
      if (station)  socket.leave(`mpos:${outletId}:station:${String(station).toLowerCase()}`);
      if (userId)   socket.leave(`mpos:${outletId}:user:${userId}`);
      if (deviceId) socket.leave(`mpos:${outletId}:device:${deviceId}`);
    });

    // Mobile POS acknowledges print job completion
    socket.on('mpos:print_done', ({ jobId, success, error }) => {
      logger.info(`Mobile POS print ${success ? 'success' : 'failed'}: jobId=${jobId}${error ? ` error=${error}` : ''}`);
      publishMessage('mpos:print_result', {
        jobId, success, error,
        station:  socket.mposStation,
        deviceId: socket.mposDeviceId,
        outletId: socket.mposOutletId,
        mode:     socket.mposMode,
        socketId: socket.id,
      });
    });

    // Leave rooms
    socket.on('leave:outlet', (outletId) => {
      socket.leave(`outlet:${outletId}`);
    });

    socket.on('leave:floor', ({ outletId, floorId }) => {
      socket.leave(`floor:${outletId}:${floorId}`);
    });

    socket.on('leave:kitchen', (outletId) => {
      socket.leave(`kitchen:${outletId}`);
    });

    // Disconnect handler
    socket.on('disconnect', (reason) => {
      logger.info(`Socket disconnected: ${socket.id}, reason: ${reason}`);
    });

    // Error handler
    socket.on('error', (error) => {
      logger.error(`Socket error: ${socket.id}`, error);
    });
  });

  // Subscribe to Redis channels for cross-worker communication (if Redis available)
  if (isRedisAvailable()) {
    setupRedisPubSub();
  } else {
    logger.warn('Socket.IO running without Redis pub/sub - multi-instance sync disabled');
  }

  // Register local emitter as fallback when Redis is unavailable
  registerLocalEmitter(emitLocal);
  logger.info('Local socket emitter registered as fallback');

  return io;
};

const setupRedisPubSub = () => {
  if (!isRedisAvailable()) return;
  // Table updates
  pubsub.subscribe('table:update', (data) => {
    io.to(`floor:${data.outletId}:${data.floorId}`).emit('table:updated', data);
    io.to(`outlet:${data.outletId}`).emit('table:updated', data);
  });

  // Table unmerge - broadcast when merged tables are unmerged (manual or after payment)
  pubsub.subscribe('table:unmerge', (data) => {
    logger.info(`[RedisPubSub] table:unmerge - outlet: ${data.outletId}, primary: ${data.primaryTableId}, unmerged: ${data.unmergedTableIds?.join(',')}`);
    
    // Broadcast to floor room
    if (data.floorId) {
      io.to(`floor:${data.outletId}:${data.floorId}`).emit('table:unmerged', data);
    }
    
    // Also broadcast to unmerged tables' floors if different
    if (data.unmergedTables) {
      const uniqueFloors = [...new Set(data.unmergedTables.map(t => t.floorId).filter(f => f && f !== data.floorId))];
      uniqueFloors.forEach(floorId => {
        io.to(`floor:${data.outletId}:${floorId}`).emit('table:unmerged', data);
      });
    }
    
    // Broadcast to outlet, captain, and cashier
    io.to(`outlet:${data.outletId}`).emit('table:unmerged', data);
    io.to(`captain:${data.outletId}`).emit('table:unmerged', data);
    io.to(`cashier:${data.outletId}`).emit('table:unmerged', data);
  });

  // Table transfer - broadcast to all relevant rooms for real-time UI update
  pubsub.subscribe('table:transfer', (data) => {
    logger.info(`[RedisPubSub] table:transfer - outlet: ${data.outletId}, from: ${data.sourceTableNumber} to: ${data.targetTableNumber}`);
    
    // Broadcast to both source and target floors
    if (data.sourceFloorId) {
      io.to(`floor:${data.outletId}:${data.sourceFloorId}`).emit('table:transferred', data);
    }
    if (data.targetFloorId && data.targetFloorId !== data.sourceFloorId) {
      io.to(`floor:${data.outletId}:${data.targetFloorId}`).emit('table:transferred', data);
    }
    
    // Broadcast to outlet, kitchen, captain, and cashier for POS/KDS updates
    io.to(`outlet:${data.outletId}`).emit('table:transferred', data);
    io.to(`kitchen:${data.outletId}`).emit('table:transferred', data);
    io.to(`captain:${data.outletId}`).emit('table:transferred', data);
    io.to(`cashier:${data.outletId}`).emit('table:transferred', data);
  });

  // Order updates - broadcast to outlet, captain, and cashier
  pubsub.subscribe('order:update', (data) => {
    io.to(`outlet:${data.outletId}`).emit('order:updated', data);
    io.to(`captain:${data.outletId}`).emit('order:updated', data);
    io.to(`cashier:${data.outletId}`).emit('order:updated', data);
  });

  // KOT updates - route to specific station, kitchen, captain, and cashier
  pubsub.subscribe('kot:update', (data) => {
    const kotNum = data.kot?.kotNumber || data.kot?.id || 'unknown';
    logger.info(`[RedisPubSub] kot:update received - outlet: ${data.outletId}, station: ${data.station}, stationId: ${data.stationId}, type: ${data.type}, kotNumber: ${kotNum}`);
    
    // Track rooms we're emitting to
    const emittedRooms = [];
    
    // Send to general kitchen room (backward compatibility)
    io.to(`kitchen:${data.outletId}`).emit('kot:updated', data);
    emittedRooms.push(`kitchen:${data.outletId}`);
    
    // Send to specific station room by station_type (main_kitchen, dessert, bar, etc.)
    if (data.station) {
      io.to(`station:${data.outletId}:${data.station}`).emit('kot:updated', data);
      emittedRooms.push(`station:${data.outletId}:${data.station}`);
      
      // Also send to bar room if bar station type (backward compatibility)
      if (data.station === 'bar' || data.station.includes('bar')) {
        io.to(`bar:${data.outletId}`).emit('kot:updated', data);
        emittedRooms.push(`bar:${data.outletId}`);
      }
    }
    
    // Send to specific station by station_id for precise routing
    if (data.stationId) {
      io.to(`station_id:${data.outletId}:${data.stationId}`).emit('kot:updated', data);
      emittedRooms.push(`station_id:${data.outletId}:${data.stationId}`);
    }
    
    // Send ALL KOT status updates to captain and cashier for real-time tracking
    io.to(`captain:${data.outletId}`).emit('kot:updated', data);
    io.to(`cashier:${data.outletId}`).emit('kot:updated', data);
    emittedRooms.push(`captain:${data.outletId}`, `cashier:${data.outletId}`);

    // Keep backward-compatible item:ready event for captain
    if (data.type === 'kot:item_ready' || data.type === 'kot:ready') {
      io.to(`captain:${data.outletId}`).emit('item:ready', data);
    }
    
    logger.info(`[RedisPubSub] KOT ${kotNum} emitted to rooms: ${emittedRooms.join(', ')}`);
  });

  // Bill status updates - send to captain and cashier
  pubsub.subscribe('bill:status', (data) => {
    io.to(`captain:${data.outletId}`).emit('bill:status', data);
    io.to(`cashier:${data.outletId}`).emit('bill:status', data);
    io.to(`outlet:${data.outletId}`).emit('bill:status', data);
  });

  // Payment updates - send to cashier and outlet
  pubsub.subscribe('payment:update', (data) => {
    io.to(`cashier:${data.outletId}`).emit('payment:updated', data);
    io.to(`outlet:${data.outletId}`).emit('payment:updated', data);
  });

  // Notification
  pubsub.subscribe('notification', (data) => {
    io.to(`outlet:${data.outletId}`).emit('notification', data);
  });

  // Self-order updates - notify outlet, captain, and cashier for approval/visibility
  pubsub.subscribe('selforder:update', (data) => {
    logger.info(`[RedisPubSub] selforder:update - outlet: ${data.outletId}, type: ${data.type}, order: ${data.orderNumber || 'N/A'}`);
    io.to(`outlet:${data.outletId}`).emit('selforder:updated', data);
    io.to(`captain:${data.outletId}`).emit('selforder:updated', data);
    io.to(`cashier:${data.outletId}`).emit('selforder:updated', data);
  });

  // Shift open - notify floor captains/staff on SAME floor + the cashier who opened it
  pubsub.subscribe('shift:open', (data) => {
    logger.info(`[RedisPubSub] shift:open - outlet: ${data.outletId}, floor: ${data.floorId}, cashier: ${data.cashierName}`);
    // Send to specific floor room (captains/staff on this floor only)
    if (data.floorId) {
      io.to(`floor:${data.outletId}:${data.floorId}`).emit('shift:opened', data);
      logger.info(`[RedisPubSub] shift:opened emitted to floor:${data.outletId}:${data.floorId}`);
    }
    // Also send to cashier room so the opening cashier receives confirmation
    io.to(`cashier:${data.outletId}`).emit('shift:opened', data);
    logger.info(`[RedisPubSub] shift:opened emitted to cashier:${data.outletId}`);
  });

  // Shift close - notify floor captains/staff on SAME floor + the cashier who closed it
  pubsub.subscribe('shift:close', (data) => {
    logger.info(`[RedisPubSub] shift:close - outlet: ${data.outletId}, floor: ${data.floorId}, cashier: ${data.cashierName}`);
    // Send to specific floor room (captains/staff on this floor only)
    if (data.floorId) {
      io.to(`floor:${data.outletId}:${data.floorId}`).emit('shift:closed', data);
      logger.info(`[RedisPubSub] shift:closed emitted to floor:${data.outletId}:${data.floorId}`);
    }
    // Also send to cashier room so the closing cashier receives confirmation
    io.to(`cashier:${data.outletId}`).emit('shift:closed', data);
    logger.info(`[RedisPubSub] shift:closed emitted to cashier:${data.outletId}`);
  });
};

const getSocketIO = () => {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
};

/**
 * Emit events directly via Socket.IO (bypasses Redis pub/sub).
 * Used as fallback when Redis is unavailable, ensuring KDS/clients
 * always receive events even without Redis.
 */
const emitLocal = (channel, data) => {
  if (!io) return false;

  try {
    switch (channel) {
      case 'table:update':
        io.to(`floor:${data.outletId}:${data.floorId}`).emit('table:updated', data);
        io.to(`outlet:${data.outletId}`).emit('table:updated', data);
        break;

      case 'order:update':
        io.to(`outlet:${data.outletId}`).emit('order:updated', data);
        io.to(`captain:${data.outletId}`).emit('order:updated', data);
        io.to(`cashier:${data.outletId}`).emit('order:updated', data);
        break;

      case 'kot:update': {
        const kotNum = data.kot?.kotNumber || data.kot?.id || 'unknown';
        const emittedRooms = [];
        
        logger.info(`[emitLocal] kot:update received - outlet: ${data.outletId}, station: ${data.station}, stationId: ${data.stationId}, type: ${data.type}, kotNumber: ${kotNum}`);
        
        io.to(`kitchen:${data.outletId}`).emit('kot:updated', data);
        emittedRooms.push(`kitchen:${data.outletId}`);
        
        if (data.station) {
          io.to(`station:${data.outletId}:${data.station}`).emit('kot:updated', data);
          emittedRooms.push(`station:${data.outletId}:${data.station}`);
          if (data.station === 'bar' || data.station.includes('bar')) {
            io.to(`bar:${data.outletId}`).emit('kot:updated', data);
            emittedRooms.push(`bar:${data.outletId}`);
          }
        }
        if (data.stationId) {
          io.to(`station_id:${data.outletId}:${data.stationId}`).emit('kot:updated', data);
          emittedRooms.push(`station_id:${data.outletId}:${data.stationId}`);
        }
        io.to(`captain:${data.outletId}`).emit('kot:updated', data);
        io.to(`cashier:${data.outletId}`).emit('kot:updated', data);
        emittedRooms.push(`captain:${data.outletId}`, `cashier:${data.outletId}`);
        
        if (data.type === 'kot:item_ready' || data.type === 'kot:ready') {
          io.to(`captain:${data.outletId}`).emit('item:ready', data);
        }
        
        logger.info(`[emitLocal] KOT ${kotNum} emitted to rooms: ${emittedRooms.join(', ')}`);
        break;
      }

      case 'bill:status':
        io.to(`captain:${data.outletId}`).emit('bill:status', data);
        io.to(`cashier:${data.outletId}`).emit('bill:status', data);
        io.to(`outlet:${data.outletId}`).emit('bill:status', data);
        break;

      case 'payment:update':
        io.to(`cashier:${data.outletId}`).emit('payment:updated', data);
        io.to(`outlet:${data.outletId}`).emit('payment:updated', data);
        break;

      case 'notification':
        io.to(`outlet:${data.outletId}`).emit('notification', data);
        break;

      case 'print:new_job':
        io.to(`outlet:${data.outletId}`).emit('print:new_job', data);
        break;

      case 'selforder:update':
        io.to(`outlet:${data.outletId}`).emit('selforder:updated', data);
        io.to(`captain:${data.outletId}`).emit('selforder:updated', data);
        io.to(`cashier:${data.outletId}`).emit('selforder:updated', data);
        break;

      case 'shift:open':
        // Send to floor room (same floor captains/staff) + cashier room
        logger.info(`[emitLocal] shift:open - outlet: ${data.outletId}, floor: ${data.floorId}, cashier: ${data.cashierName}`);
        if (data.floorId) {
          io.to(`floor:${data.outletId}:${data.floorId}`).emit('shift:opened', data);
        }
        io.to(`cashier:${data.outletId}`).emit('shift:opened', data);
        break;

      case 'shift:close':
        // Send to floor room (same floor captains/staff) + cashier room
        logger.info(`[emitLocal] shift:close - outlet: ${data.outletId}, floor: ${data.floorId}, cashier: ${data.cashierName}`);
        if (data.floorId) {
          io.to(`floor:${data.outletId}:${data.floorId}`).emit('shift:closed', data);
        }
        io.to(`cashier:${data.outletId}`).emit('shift:closed', data);
        break;

      default:
        logger.warn(`emitLocal: unhandled channel '${channel}'`);
        return false;
    }
    return true;
  } catch (error) {
    logger.error(`emitLocal failed for channel '${channel}':`, error.message);
    return false;
  }
};

// Emit helpers (use publishMessage for local fallback when Redis is unavailable)
const emit = {
  toOutlet(outletId, event, data) {
    publishMessage(event.split(':')[0] + ':update', { outletId, ...data });
  },

  toFloor(outletId, floorId, event, data) {
    publishMessage('table:update', { outletId, floorId, ...data });
  },

  toKitchen(outletId, event, data) {
    publishMessage('kot:update', { outletId, ...data });
  },

  notification(outletId, message, type = 'info') {
    publishMessage('notification', { outletId, message, type, timestamp: new Date() });
  },
};

module.exports = {
  initializeSocket,
  getSocketIO,
  emitLocal,
  emit,
};
