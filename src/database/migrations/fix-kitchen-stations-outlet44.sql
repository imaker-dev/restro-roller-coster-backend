-- Fix kitchen_stations for outlet 44
-- Problem: ALL station_type values are 'main_kitchen' (wrong for Bar, Dessert, Tandoor)
--          ALL printer_id values are NULL (no printer linked)

-- Step 1: Fix station_type based on station code/name
UPDATE kitchen_stations SET station_type = 'main_kitchen' WHERE outlet_id = 44 AND UPPER(code) = 'KITCHEN';
UPDATE kitchen_stations SET station_type = 'dessert'      WHERE outlet_id = 44 AND UPPER(code) = 'DESSERT';
UPDATE kitchen_stations SET station_type = 'tandoor'      WHERE outlet_id = 44 AND UPPER(code) = 'TANDOOR';
UPDATE kitchen_stations SET station_type = 'bar'          WHERE outlet_id = 44 AND UPPER(code) = 'BAR';

-- Step 2: Link printer_id — match kitchen_station name (lowercased) to printers.station
-- Kitchen station → printer with station='kitchen'
UPDATE kitchen_stations ks
  JOIN printers p ON p.outlet_id = ks.outlet_id AND p.station = 'kitchen' AND p.is_active = 1
SET ks.printer_id = p.id
WHERE ks.outlet_id = 44 AND UPPER(ks.code) = 'KITCHEN';

-- Bar station → printer with station='bar'
UPDATE kitchen_stations ks
  JOIN printers p ON p.outlet_id = ks.outlet_id AND p.station = 'bar' AND p.is_active = 1
SET ks.printer_id = p.id
WHERE ks.outlet_id = 44 AND UPPER(ks.code) = 'BAR';

-- Dessert station → kitchen printer (no dedicated dessert printer)
UPDATE kitchen_stations ks
  JOIN printers p ON p.outlet_id = ks.outlet_id AND p.station = 'kitchen' AND p.is_active = 1
SET ks.printer_id = p.id
WHERE ks.outlet_id = 44 AND UPPER(ks.code) = 'DESSERT';

-- Tandoor station → kitchen printer (no dedicated tandoor printer)
UPDATE kitchen_stations ks
  JOIN printers p ON p.outlet_id = ks.outlet_id AND p.station = 'kitchen' AND p.is_active = 1
SET ks.printer_id = p.id
WHERE ks.outlet_id = 44 AND UPPER(ks.code) = 'TANDOOR';

-- Verify
SELECT ks.id, ks.outlet_id, ks.name, ks.code, ks.station_type, ks.printer_id,
       p.name as printer_name, p.station as printer_station, p.ip_address
FROM kitchen_stations ks
LEFT JOIN printers p ON ks.printer_id = p.id
WHERE ks.outlet_id = 44;
