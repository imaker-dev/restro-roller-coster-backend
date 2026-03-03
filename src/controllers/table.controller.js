const tableService = require('../services/table.service');
const { getPool } = require('../database');
const logger = require('../utils/logger');

/**
 * Get floor IDs a user is restricted to (empty array = no restriction / all floors)
 */
async function getUserFloorIds(userId, outletId) {
  if (!userId) return [];
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT floor_id FROM user_floors WHERE user_id = ? AND outlet_id = ? AND is_active = 1',
    [userId, outletId]
  );
  return rows.map(r => r.floor_id);
}

/**
 * Table Controller - Comprehensive table management
 */
const tableController = {
  // ========================
  // CRUD Operations
  // ========================

  async createTable(req, res, next) {
    try {
      const table = await tableService.create(req.body, req.user.userId);
      res.status(201).json({
        success: true,
        message: 'Table created successfully',
        data: table
      });
    } catch (error) {
      next(error);
    }
  },

  async getTablesByOutlet(req, res, next) {
    try {
      const outletId = parseInt(req.params.outletId);
      const filters = {
        floorId: req.query.floorId,
        sectionId: req.query.sectionId,
        status: req.query.status,
        isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined
      };
      // If user has floor restrictions and no specific floorId filter, restrict
      if (req.user && !filters.floorId) {
        const restrictedFloors = await getUserFloorIds(req.user.userId, outletId);
        if (restrictedFloors.length > 0) {
          filters.floorIds = restrictedFloors;
        }
      }
      const tables = await tableService.getByOutlet(outletId, filters);
      res.json({ success: true, data: tables });
    } catch (error) {
      next(error);
    }
  },

  async getTablesByFloor(req, res, next) {
    try {
      const floorId = parseInt(req.params.floorId);
      // Enforce floor restriction: if user has assigned floors, verify access
      if (req.user) {
        const pool = getPool();
        const [floorRow] = await pool.query('SELECT outlet_id FROM floors WHERE id = ?', [floorId]);
        if (floorRow.length > 0) {
          const restrictedFloors = await getUserFloorIds(req.user.userId, floorRow[0].outlet_id);
          if (restrictedFloors.length > 0 && !restrictedFloors.includes(floorId)) {
            return res.status(403).json({ success: false, message: 'You do not have access to this floor' });
          }
        }
      }
      const result = await tableService.getByFloor(floorId);
      // Return full response with floor, shift, sections, and tables
      res.json({ 
        success: true, 
        data: result.tables,
        floor: result.floor,
        shift: result.shift,
        sections: result.sections
      });
    } catch (error) {
      next(error);
    }
  },

  async getTableById(req, res, next) {
    try {
      // Use getFullDetails for comprehensive table info including orders, items, captain, etc.
      const table = await tableService.getFullDetails(req.params.id);
      if (!table) {
        return res.status(404).json({ success: false, message: 'Table not found' });
      }
      res.json({ success: true, data: table });
    } catch (error) {
      next(error);
    }
  },

  async updateTable(req, res, next) {
    try {
      const table = await tableService.update(req.params.id, req.body, req.user.userId);
      if (!table) {
        return res.status(404).json({ success: false, message: 'Table not found' });
      }
      res.json({ success: true, message: 'Table updated successfully', data: table });
    } catch (error) {
      next(error);
    }
  },

  async deleteTable(req, res, next) {
    try {
      await tableService.delete(req.params.id, req.user.userId);
      res.json({ success: true, message: 'Table deleted successfully' });
    } catch (error) {
      next(error);
    }
  },

  // ========================
  // Status Management
  // ========================

  async updateTableStatus(req, res, next) {
    try {
      const table = await tableService.updateStatus(
        req.params.id,
        req.body.status,
        req.user.userId,
        { reason: req.body.reason }
      );
      res.json({
        success: true,
        message: `Table status updated to ${req.body.status}`,
        data: table
      });
    } catch (error) {
      next(error);
    }
  },

  async getRealTimeStatus(req, res, next) {
    try {
      const outletId = parseInt(req.params.outletId);
      let floorId = req.query.floorId || null;

      // If no specific floor requested, check if user has floor restrictions
      if (!floorId && req.user) {
        const restrictedFloors = await getUserFloorIds(req.user.userId, outletId);
        if (restrictedFloors.length > 0) {
          // For real-time status, pass first restricted floor or let service handle array
          // We'll filter results after fetch
          const allTables = await tableService.getRealTimeStatus(outletId, null);
          const filtered = allTables.filter(t => restrictedFloors.includes(t.floor_id));
          return res.json({ success: true, data: filtered });
        }
      }

      const tables = await tableService.getRealTimeStatus(
        outletId,
        floorId
      );
      res.json({ success: true, data: tables });
    } catch (error) {
      next(error);
    }
  },

  async getTableStatuses(req, res, next) {
    try {
      const statuses = tableService.getStatuses();
      res.json({ success: true, data: statuses });
    } catch (error) {
      next(error);
    }
  },

  async getTableShapes(req, res, next) {
    try {
      const shapes = tableService.getShapes();
      res.json({ success: true, data: shapes });
    } catch (error) {
      next(error);
    }
  },

  // ========================
  // Session Management
  // ========================

  async startSession(req, res, next) {
    try {
      const result = await tableService.startSession(req.params.id, req.body, req.user.userId);
      res.status(201).json({
        success: true,
        message: 'Table session started',
        data: result
      });
    } catch (error) {
      next(error);
    }
  },

  async endSession(req, res, next) {
    try {
      await tableService.endSession(req.params.id, req.user.userId);
      res.json({ success: true, message: 'Table session ended' });
    } catch (error) {
      next(error);
    }
  },

  async getCurrentSession(req, res, next) {
    try {
      const session = await tableService.getCurrentSession(req.params.id);
      res.json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  },

  async transferSession(req, res, next) {
    try {
      const { newCaptainId } = req.body;
      if (!newCaptainId) {
        return res.status(400).json({ success: false, message: 'newCaptainId is required' });
      }
      const result = await tableService.transferSession(
        req.params.id,
        newCaptainId,
        req.user.userId
      );
      res.json({
        success: true,
        message: 'Table session transferred successfully',
        data: result
      });
    } catch (error) {
      next(error);
    }
  },

  // ========================
  // Table Transfer
  // ========================

  async transferTable(req, res, next) {
    try {
      const { targetTableId } = req.body;
      if (!targetTableId) {
        return res.status(400).json({ success: false, message: 'targetTableId is required' });
      }
      const result = await tableService.transferTable(
        parseInt(req.params.id),
        parseInt(targetTableId),
        req.user.userId
      );
      res.json({
        success: true,
        message: result.message,
        data: result
      });
    } catch (error) {
      next(error);
    }
  },

  // ========================
  // Merge Operations
  // ========================

  async mergeTables(req, res, next) {
    try {
      const result = await tableService.mergeTables(
        req.params.id,
        req.body.tableIds,
        req.user.userId
      );
      res.json({
        success: true,
        message: 'Tables merged successfully',
        data: result
      });
    } catch (error) {
      next(error);
    }
  },

  async unmergeTables(req, res, next) {
    try {
      await tableService.unmergeTables(req.params.id, req.user.userId);
      res.json({ success: true, message: 'Tables unmerged successfully' });
    } catch (error) {
      next(error);
    }
  },

  async getMergedTables(req, res, next) {
    try {
      const merges = await tableService.getMergedTables(req.params.id);
      res.json({ success: true, data: merges });
    } catch (error) {
      next(error);
    }
  },

  // ========================
  // History & Reports
  // ========================

  async getTableHistory(req, res, next) {
    try {
      const history = await tableService.getHistory(req.params.id, parseInt(req.query.limit) || 50);
      res.json({ success: true, data: history });
    } catch (error) {
      next(error);
    }
  },

  async getSessionHistory(req, res, next) {
    try {
      const sessions = await tableService.getSessionHistory(
        req.params.id,
        req.query.fromDate,
        req.query.toDate,
        parseInt(req.query.limit) || 100
      );
      res.json({ success: true, data: sessions });
    } catch (error) {
      next(error);
    }
  },

  async getTableReport(req, res, next) {
    try {
      const report = await tableService.getTableReport(
        req.params.id,
        req.query.fromDate,
        req.query.toDate
      );
      res.json({ success: true, data: report });
    } catch (error) {
      next(error);
    }
  },

  async getFloorReport(req, res, next) {
    try {
      const report = await tableService.getFloorReport(
        req.params.floorId,
        req.query.fromDate,
        req.query.toDate
      );
      res.json({ success: true, data: report });
    } catch (error) {
      next(error);
    }
  },

  async getRunningKots(req, res, next) {
    try {
      const kots = await tableService.getRunningKots(req.params.id);
      res.json({ success: true, data: kots });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = tableController;
