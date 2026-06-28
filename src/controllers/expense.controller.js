/**
 * Expense Controller
 */

const expenseService = require('../services/expense.service');
const logger = require('../utils/logger');

const expenseController = {

  // ========================
  // CREATE
  // ========================

  async create(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const userId = req.user?.userId || null;
      const result = await expenseService.createExpense(outletId, req.body, userId);
      res.status(201).json({ success: true, data: result, message: 'Expense added successfully' });
    } catch (error) {
      logger.error('Error creating expense:', error);
      res.status(error.message.includes('required') ? 400 : 500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // LIST
  // ========================

  async list(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const { page, limit, search, paymentMethod, status, startDate, endDate, sortBy, sortOrder } = req.query;
      const result = await expenseService.listExpenses(outletId, {
        page, limit, search, paymentMethod, status, startDate, endDate, sortBy, sortOrder
      });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Error listing expenses:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // GET BY ID
  // ========================

  async getById(req, res) {
    try {
      const id = parseInt(req.params.id);
      const result = await expenseService.getExpenseById(id);
      if (!result) {
        return res.status(404).json({ success: false, message: 'Expense not found' });
      }
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Error getting expense:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

  // ========================
  // UPDATE
  // ========================

  async update(req, res) {
    try {
      const id = parseInt(req.params.id);
      const result = await expenseService.updateExpense(id, req.body);
      res.json({ success: true, data: result, message: 'Expense updated successfully' });
    } catch (error) {
      logger.error('Error updating expense:', error);
      const status = error.message.includes('not found') ? 404
        : error.message.includes('required') ? 400 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  // ========================
  // DELETE
  // ========================

  async remove(req, res) {
    try {
      const id = parseInt(req.params.id);
      const result = await expenseService.deleteExpense(id);
      res.json({ success: true, data: result, message: 'Expense deleted successfully' });
    } catch (error) {
      logger.error('Error deleting expense:', error);
      const status = error.message.includes('not found') ? 404 : 500;
      res.status(status).json({ success: false, message: error.message });
    }
  },

  // ========================
  // STATS
  // ========================

  async stats(req, res) {
    try {
      const outletId = parseInt(req.params.outletId);
      const { startDate, endDate, paymentMethod } = req.query;
      const result = await expenseService.getExpenseStats(outletId, { startDate, endDate, paymentMethod });
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Error getting expense stats:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  },

};

module.exports = expenseController;
