-- +goose Up
-- Unit inventory lists and the pre-arrival and post-departure checks counted against them
-- (villa-operations-contract.md sections 1 and 2). Each row keeps the record as JSON plus the
-- columns commands look up by.
CREATE TABLE inventory.unit_items (
    seq      bigserial,
    id       text   PRIMARY KEY,
    unit_id  text   NOT NULL,
    villa_id text   NOT NULL,
    doc      jsonb  NOT NULL,
    version  bigint NOT NULL DEFAULT 1
);
CREATE INDEX unit_items_unit ON inventory.unit_items (unit_id);

CREATE TABLE inventory.unit_checks (
    seq        bigserial,
    id         text   PRIMARY KEY,
    number     text   NOT NULL UNIQUE,
    unit_id    text   NOT NULL,
    villa_id   text   NOT NULL,
    booking_id text   NOT NULL,
    kind       text   NOT NULL,
    doc        jsonb  NOT NULL,
    version    bigint NOT NULL DEFAULT 1,
    UNIQUE (booking_id, kind)
);

CREATE VIEW inventory.v_unit_items AS
    SELECT i.seq, i.doc, i.villa_id, coalesce(v.location_id, '') AS location_id
    FROM inventory.unit_items i LEFT JOIN inventory.ref_villas v ON v.id = i.villa_id;

CREATE VIEW inventory.v_unit_checks AS
    SELECT c.seq, c.doc, c.villa_id, coalesce(v.location_id, '') AS location_id
    FROM inventory.unit_checks c LEFT JOIN inventory.ref_villas v ON v.id = c.villa_id;

-- +goose Down
DROP VIEW inventory.v_unit_checks;
DROP VIEW inventory.v_unit_items;
DROP TABLE inventory.unit_checks;
DROP TABLE inventory.unit_items;
