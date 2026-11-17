-- +goose Up
-- The guest's stay page opens by a token the stay carries from check-in. The column follows the
-- document so the page finds its stay by an index, and no two stays share a token.
ALTER TABLE reservation.bookings
    ADD COLUMN stay_token text GENERATED ALWAYS AS (doc->>'stayToken') STORED;

CREATE UNIQUE INDEX bookings_stay_token ON reservation.bookings (stay_token) WHERE stay_token IS NOT NULL;

-- +goose Down
DROP INDEX reservation.bookings_stay_token;
ALTER TABLE reservation.bookings DROP COLUMN stay_token;
