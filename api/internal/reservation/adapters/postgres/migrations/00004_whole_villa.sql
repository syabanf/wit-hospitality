-- +goose Up
-- How a villa operates, whether it is rented whole at what nightly price and whether it asks a
-- deposit at check-in, and a room type's kind (room or villa), copied from property's events for
-- whole villa bookings and the room or villa rules. A NULL operation or kind means the copy has
-- not seen an event that carries them yet: read as a villa that is not rented whole, asks a
-- deposit, and a villa kind, until the snapshot catch-up fills those rows.
ALTER TABLE reservation.cat_villas
    ADD COLUMN operation           text,
    ADD COLUMN whole_rental        boolean NOT NULL DEFAULT false,
    ADD COLUMN whole_nightly_rate  bigint  NOT NULL DEFAULT 0,
    ADD COLUMN deposit_on_check_in boolean NOT NULL DEFAULT true;

ALTER TABLE reservation.cat_unit_groups
    ADD COLUMN kind text;

-- Existing booking groups are not whole villa rentals.
UPDATE reservation.booking_groups SET doc = doc || '{"wholeVilla": false}'::jsonb WHERE NOT doc ? 'wholeVilla';
UPDATE reservation.rm_booking_groups SET doc = doc || '{"wholeVilla": false}'::jsonb WHERE NOT doc ? 'wholeVilla';

-- +goose Down
UPDATE reservation.rm_booking_groups SET doc = doc - 'wholeVilla';
UPDATE reservation.booking_groups SET doc = doc - 'wholeVilla';
ALTER TABLE reservation.cat_unit_groups DROP COLUMN kind;
ALTER TABLE reservation.cat_villas
    DROP COLUMN operation, DROP COLUMN whole_rental, DROP COLUMN whole_nightly_rate, DROP COLUMN deposit_on_check_in;
