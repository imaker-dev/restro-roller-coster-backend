-- Migration 063: Add business identity fields to restaurant_registrations
-- GST number, FSSAI license, and PAN card are optional fields submitted during
-- restaurant registration to help iMaker verify the business identity.
ALTER TABLE restaurant_registrations
  ADD COLUMN IF NOT EXISTS gst_number   VARCHAR(20)  DEFAULT NULL AFTER message,
  ADD COLUMN IF NOT EXISTS fssai_number VARCHAR(20)  DEFAULT NULL AFTER gst_number,
  ADD COLUMN IF NOT EXISTS pan_number   VARCHAR(15)  DEFAULT NULL AFTER fssai_number;
