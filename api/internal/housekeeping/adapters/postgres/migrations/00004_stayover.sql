-- +goose Up
-- How each villa operates and its stayover gap, and each room type's kind, copied from property's
-- events, so the day plan knows which stays get a stayover clean and when. NULL means the copy has
-- not seen an event that carries them yet: read as a villa without stayovers and a villa kind
-- until the snapshot catch-up fills those rows.
ALTER TABLE housekeeping.cat_villas
    ADD COLUMN operation      text,
    ADD COLUMN stayover_every integer;

ALTER TABLE housekeeping.cat_unit_groups
    ADD COLUMN kind text;

-- One planned stayover per unit per business day, however many times the day is planned.
CREATE TABLE housekeeping.planned_stayovers (
    unit_id text NOT NULL,
    day     date NOT NULL,
    PRIMARY KEY (unit_id, day)
);

-- +goose Down
DROP TABLE housekeeping.planned_stayovers;
ALTER TABLE housekeeping.cat_unit_groups DROP COLUMN kind;
ALTER TABLE housekeeping.cat_villas DROP COLUMN operation, DROP COLUMN stayover_every;
