-- Create a dedicated system user for self-order operations
-- This user is referenced by created_by=<id> in self-orders instead of created_by=0

INSERT IGNORE INTO users (uuid, employee_code, name, email, phone, pin_hash, password_hash, is_active, is_verified, created_by)
VALUES (
  UUID(),
  'SELF_ORDER',
  'Self Order',
  'selforder@system.local',
  '0000000000',
  '',
  '',
  1,
  1,
  1
);
