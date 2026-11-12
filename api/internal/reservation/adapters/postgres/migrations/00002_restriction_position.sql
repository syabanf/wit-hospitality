-- +goose Up
-- The stay restrictions list follows the order the write model added them (the mock's array
-- order). rm_restrictions.seq records when the projector saw a row, which two relays draining the
-- same outbox can interleave, so the row keeps the write model's seq as its position.
ALTER TABLE reservation.rm_restrictions ADD COLUMN position bigint;
UPDATE reservation.rm_restrictions r SET position = w.seq FROM reservation.restrictions w WHERE w.id = r.id;

-- +goose Down
ALTER TABLE reservation.rm_restrictions DROP COLUMN position;
