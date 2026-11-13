-- +goose Up
-- A stay's service window (the schedule, a window the guest picked, or do not disturb), copied from
-- reservation's events. NULL means the copy has not seen an event that carries it yet; the
-- snapshot catch-up fills those rows. Tasks carry the window of the stay they serve: existing
-- tasks start without one.
ALTER TABLE housekeeping.stays
    ADD COLUMN service_window jsonb;

UPDATE housekeeping.tasks SET doc = doc || '{"serviceWindow": null}'::jsonb WHERE NOT doc ? 'serviceWindow';

-- +goose Down
UPDATE housekeeping.tasks SET doc = doc - 'serviceWindow';
ALTER TABLE housekeeping.stays DROP COLUMN service_window;
