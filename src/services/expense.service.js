/**
 * Expense Service
 * Handles expense management (add, edit, delete, list, stats, filter, search)
 */

const { getPool } = require('../database');
const logger = require('../utils/logger');

const expenseService = {

  // ========================
  // CREATE
  // ========================

  async createExpense(outletId, data, userId) {
    const pool = getPool();
    const {
      expenseName,
      unit,
      quantity,
      totalAmount,
      paidAmount,
      paymentMethod,
      expenseDate,
      notes
    } = data;

    const qty = parseFloat(quantity) || 1;
    const total = parseFloat(totalAmount) || 0;
    const paid = parseFloat(paidAmount) || 0;
    const due = total - paid;

    const [result] = await pool.query(
      `INSERT INTO expenses (
        outlet_id, expense_name, unit, quantity, total_amount, paid_amount, due_amount,
        payment_method, expense_date, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outletId, expenseName, unit || 'Piece', qty, total, paid, due,
        paymentMethod, expenseDate || new Date().toISOString().slice(0, 10), notes || null, userId
      ]
    );

    logger.info(`Expense created: id=${result.insertId}, outlet=${outletId}, name=${expenseName}`);
    return this.getExpenseById(result.insertId);
  },

  // ========================
  // READ (Single)
  // ========================

  async getExpenseById(id) {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, outlet_id, expense_name, unit, quantity, total_amount, paid_amount, due_amount,
              payment_method, expense_date, notes, created_by, created_at, updated_at
       FROM expenses WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  },

  // ========================
  // LIST (with filters, search, pagination)
  // ========================

  async listExpenses(outletId, options = {}) {
    const pool = getPool();
    const {
      page = 1,
      limit = 25,
      search,
      paymentMethod,
      status,
      startDate,
      endDate,
      sortBy = 'created_at',
      sortOrder = 'DESC'
    } = options;

    const safePage = Math.max(1, parseInt(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit) || 25));
    const offset = (safePage - 1) * safeLimit;

    const allowedSort = ['id', 'expense_name', 'quantity', 'total_amount', 'paid_amount', 'due_amount', 'payment_method', 'expense_date', 'created_at'];
    const safeSortBy = allowedSort.includes(sortBy) ? sortBy : 'created_at';
    const safeSortOrder = String(sortOrder).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    let where = 'WHERE outlet_id = ?';
    const params = [outletId];

    if (search) {
      where += ' AND (expense_name LIKE ? OR id LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s);
    }

    if (paymentMethod) {
      where += ' AND payment_method = ?';
      params.push(paymentMethod);
    }

    if (startDate) {
      where += ' AND expense_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      where += ' AND expense_date <= ?';
      params.push(endDate);
    }

    // Status filter: paid = due=0, partial = paid>0 AND due>0, due = due>0
    if (status === 'paid') {
      where += ' AND due_amount <= 0';
    } else if (status === 'partial') {
      where += ' AND paid_amount > 0 AND due_amount > 0';
    } else if (status === 'due') {
      where += ' AND due_amount > 0';
    }

    // Count total
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM expenses ${where}`,
      params
    );

    // Fetch data
    const [rows] = await pool.query(
      `SELECT id, outlet_id, expense_name, unit, quantity, total_amount, paid_amount, due_amount,
              payment_method, expense_date, notes, created_at, updated_at
       FROM expenses
       ${where}
       ORDER BY ${safeSortBy} ${safeSortOrder}
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, offset]
    );

    return {
      expenses: rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: total,
        totalPages: Math.ceil(total / safeLimit),
      }
    };
  },

  // ========================
  // UPDATE
  // ========================

  async updateExpense(id, data) {
    const pool = getPool();
    const existing = await this.getExpenseById(id);
    if (!existing) throw new Error('Expense not found');

    const {
      expenseName,
      unit,
      quantity,
      totalAmount,
      paidAmount,
      paymentMethod,
      expenseDate,
      notes
    } = data;

    const qty = quantity !== undefined ? (parseFloat(quantity) || 1) : existing.quantity;
    const total = totalAmount !== undefined ? (parseFloat(totalAmount) || 0) : existing.total_amount;
    const paid = paidAmount !== undefined ? (parseFloat(paidAmount) || 0) : existing.paid_amount;
    const due = total - paid;

    await pool.query(
      `UPDATE expenses SET
        expense_name = ?, unit = ?, quantity = ?, total_amount = ?, paid_amount = ?, due_amount = ?,
        payment_method = ?, expense_date = ?, notes = ?
       WHERE id = ?`,
      [
        expenseName !== undefined ? expenseName : existing.expense_name,
        unit !== undefined ? unit : existing.unit,
        qty, total, paid, due,
        paymentMethod !== undefined ? paymentMethod : existing.payment_method,
        expenseDate !== undefined ? expenseDate : existing.expense_date,
        notes !== undefined ? notes : existing.notes,
        id
      ]
    );

    logger.info(`Expense updated: id=${id}`);
    return this.getExpenseById(id);
  },

  // ========================
  // DELETE
  // ========================

  async deleteExpense(id) {
    const pool = getPool();
    const existing = await this.getExpenseById(id);
    if (!existing) throw new Error('Expense not found');

    await pool.query('DELETE FROM expenses WHERE id = ?', [id]);
    logger.info(`Expense deleted: id=${id}`);
    return { id, deleted: true };
  },

  // ========================
  // STATS / DASHBOARD
  // ========================

  async getExpenseStats(outletId, options = {}) {
    const pool = getPool();
    const { startDate, endDate, paymentMethod } = options;

    let where = 'WHERE outlet_id = ?';
    const params = [outletId];

    if (startDate) {
      where += ' AND expense_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND expense_date <= ?';
      params.push(endDate);
    }
    if (paymentMethod) {
      where += ' AND payment_method = ?';
      params.push(paymentMethod);
    }

    const [[stats]] = await pool.query(
      `SELECT
        COUNT(*) as total_expenses,
        COALESCE(SUM(total_amount), 0) as total_amount,
        COALESCE(SUM(paid_amount), 0) as total_paid,
        COALESCE(SUM(due_amount), 0) as total_due
       FROM expenses
       ${where}`,
      params
    );

    const [[statusCounts]] = await pool.query(
      `SELECT
        SUM(CASE WHEN due_amount <= 0 THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN paid_amount > 0 AND due_amount > 0 THEN 1 ELSE 0 END) as partial_count,
        SUM(CASE WHEN due_amount > 0 THEN 1 ELSE 0 END) as due_count
       FROM expenses
       ${where}`,
      params
    );

    return {
      totalExpenses: parseInt(stats.total_expenses) || 0,
      totalAmount: parseFloat(stats.total_amount) || 0,
      totalPaid: parseFloat(stats.total_paid) || 0,
      totalDue: parseFloat(stats.total_due) || 0,
      paidCount: parseInt(statusCounts.paid_count) || 0,
      partialCount: parseInt(statusCounts.partial_count) || 0,
      dueCount: parseInt(statusCounts.due_count) || 0,
    };
  },
};

module.exports = expenseService;
