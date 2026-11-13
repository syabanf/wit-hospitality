-- +goose Up
-- A property's late check-out fee, what a room stay pays to leave late (a mixed property charges it
-- on rooms only), and a villa-kind unit's default host, an employee id from people. Existing hotels
-- and mixed properties charge 500000, existing villas nothing; existing units have no host.
ALTER TABLE property.villas
    ADD COLUMN late_checkout_fee bigint NOT NULL DEFAULT 0 CHECK (late_checkout_fee >= 0);
UPDATE property.villas SET late_checkout_fee = 500000 WHERE operation IN ('hotel', 'mixed');

ALTER TABLE property.units
    ADD COLUMN host_id text;

ALTER TABLE property.rm_villas
    ADD COLUMN late_checkout_fee bigint NOT NULL DEFAULT 0;
UPDATE property.rm_villas SET late_checkout_fee = 500000 WHERE operation IN ('hotel', 'mixed');

ALTER TABLE property.rm_units
    ADD COLUMN host_id text;

-- +goose Down
ALTER TABLE property.rm_units DROP COLUMN host_id;
ALTER TABLE property.rm_villas DROP COLUMN late_checkout_fee;
ALTER TABLE property.units DROP COLUMN host_id;
ALTER TABLE property.villas DROP COLUMN late_checkout_fee;
