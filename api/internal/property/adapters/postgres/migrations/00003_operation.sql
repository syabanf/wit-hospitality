-- +goose Up
-- How a property operates (villa, hotel or both), its stayover cleaning gap, whether it is rented
-- whole and for what nightly price, whether it asks a deposit at check-in; a room type's kind
-- (room or villa) and a unit's floor. Existing villas operate as villas without stayover cleans,
-- are not rented whole and ask a deposit; existing room types are villas; existing units have no
-- floor.
ALTER TABLE property.villas
    ADD COLUMN operation           text    NOT NULL DEFAULT 'villa' CHECK (operation IN ('villa', 'hotel', 'mixed')),
    ADD COLUMN stayover_every      integer NOT NULL DEFAULT 0 CHECK (stayover_every BETWEEN 0 AND 7),
    ADD COLUMN whole_rental        boolean NOT NULL DEFAULT false,
    ADD COLUMN whole_nightly_rate  bigint  NOT NULL DEFAULT 0 CHECK (whole_nightly_rate >= 0),
    ADD COLUMN deposit_on_check_in boolean NOT NULL DEFAULT true,
    ADD CHECK (NOT (operation = 'hotel' AND whole_rental));

ALTER TABLE property.unit_groups
    ADD COLUMN kind text NOT NULL DEFAULT 'villa' CHECK (kind IN ('room', 'villa'));

ALTER TABLE property.units
    ADD COLUMN floor text NOT NULL DEFAULT '' CHECK (char_length(floor) <= 10);

ALTER TABLE property.rm_villas
    ADD COLUMN operation           text    NOT NULL DEFAULT 'villa',
    ADD COLUMN stayover_every      integer NOT NULL DEFAULT 0,
    ADD COLUMN whole_rental        boolean NOT NULL DEFAULT false,
    ADD COLUMN whole_nightly_rate  bigint  NOT NULL DEFAULT 0,
    ADD COLUMN deposit_on_check_in boolean NOT NULL DEFAULT true;

ALTER TABLE property.rm_unit_groups
    ADD COLUMN kind text NOT NULL DEFAULT 'villa';

ALTER TABLE property.rm_units
    ADD COLUMN floor text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE property.rm_units DROP COLUMN floor;
ALTER TABLE property.rm_unit_groups DROP COLUMN kind;
ALTER TABLE property.rm_villas
    DROP COLUMN operation, DROP COLUMN stayover_every, DROP COLUMN whole_rental, DROP COLUMN whole_nightly_rate,
    DROP COLUMN deposit_on_check_in;
ALTER TABLE property.units DROP COLUMN floor;
ALTER TABLE property.unit_groups DROP COLUMN kind;
ALTER TABLE property.villas
    DROP COLUMN operation, DROP COLUMN stayover_every, DROP COLUMN whole_rental, DROP COLUMN whole_nightly_rate,
    DROP COLUMN deposit_on_check_in;
