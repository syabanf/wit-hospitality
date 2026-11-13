-- +goose Up
-- A unit's capacity, for the UNIT_CAPACITY rule, and a villa's house times, for the guest's online
-- check-in page, copied from property's events. NULL means the copy has not seen an event that
-- carries them yet; the snapshot catch-up fills those rows, and the capacity rule skips a unit
-- whose capacity is unknown.
ALTER TABLE reservation.cat_units
    ADD COLUMN max_adults   integer,
    ADD COLUMN max_children integer,
    ADD COLUMN extra_beds   integer;

ALTER TABLE reservation.cat_villas
    ADD COLUMN check_in_time  text,
    ADD COLUMN check_out_time text;

-- +goose Down
ALTER TABLE reservation.cat_villas
    DROP COLUMN check_in_time,
    DROP COLUMN check_out_time;
ALTER TABLE reservation.cat_units
    DROP COLUMN max_adults,
    DROP COLUMN max_children,
    DROP COLUMN extra_beds;
