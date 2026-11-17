-- +goose Up
-- Owner-paid electricity, water and gas, one row per meter reading maintenance billed to the owner
-- (maintenance.utility.billed.v1, consumer owners.utilities). A statement's draft reads the
-- villa's rows of its month.
CREATE TABLE owners.utility_charges (
    reading_id text   PRIMARY KEY,
    villa_id   text   NOT NULL,
    month      text   NOT NULL,
    line       jsonb  NOT NULL
);
CREATE INDEX utility_charges_month ON owners.utility_charges (villa_id, month);

-- +goose Down
DROP TABLE owners.utility_charges;
