-- Expenses Management Table
-- Created: 2025-06-28

CREATE TABLE IF NOT EXISTS expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  outlet_id INT NOT NULL,
  expense_name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'Piece',
  quantity DECIMAL(10, 3) NOT NULL DEFAULT 1,
  total_amount DECIMAL(12, 2) NOT NULL,
  paid_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
  due_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'Cash',
  expense_date DATE NOT NULL,
  notes TEXT,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_outlet_id (outlet_id),
  INDEX idx_expense_date (expense_date),
  INDEX idx_payment_method (payment_method),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
