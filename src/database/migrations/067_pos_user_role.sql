-- =====================================================
-- ADD POS USER ROLE
-- Identical permissions to cashier role
-- =====================================================

-- Insert the pos_user role
INSERT IGNORE INTO roles (name, slug, description, is_system_role, priority)
VALUES ('POS User', 'pos_user', 'POS User access — same as Cashier', TRUE, 100);

-- Copy all cashier role_permissions to pos_user
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT
  (SELECT id FROM roles WHERE slug = 'pos_user'),
  rp.permission_id
FROM role_permissions rp
JOIN roles r ON rp.role_id = r.id
WHERE r.slug = 'cashier';
