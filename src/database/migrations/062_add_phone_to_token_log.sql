-- Migration 062: Add phone column to token_generation_log
ALTER TABLE token_generation_log
  ADD COLUMN IF NOT EXISTS phone VARCHAR(30) DEFAULT NULL AFTER email;
