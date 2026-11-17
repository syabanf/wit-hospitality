-- +goose Up
-- Meters, their readings and the long-stay length per villa (villa-operations-contract.md
-- section 3), and the copy of reservation's stays that readings and upkeep generation read.
CREATE TABLE maintenance.meters (
    seq      bigserial,
    id       text   PRIMARY KEY,
    villa_id text   NOT NULL,
    doc      jsonb  NOT NULL,
    version  bigint NOT NULL DEFAULT 1
);

CREATE TABLE maintenance.meter_readings (
    seq      bigserial,
    id       text   PRIMARY KEY,
    meter_id text   NOT NULL,
    villa_id text   NOT NULL,
    doc      jsonb  NOT NULL
);
CREATE INDEX meter_readings_meter ON maintenance.meter_readings (meter_id, seq);

CREATE TABLE maintenance.utility_settings (
    villa_id         text    PRIMARY KEY,
    long_stay_nights integer NOT NULL
);

-- What maintenance knows of reservation's stays, projected from booking.saved and status_changed
-- (consumer maintenance.stays); the start-up catch-up fills it on a database seeded before it.
CREATE TABLE maintenance.ref_stays (
    id             text   PRIMARY KEY,
    code           text   NOT NULL,
    status         text   NOT NULL,
    unit_id        text   NOT NULL,
    check_in       text   NOT NULL,
    check_out      text   NOT NULL,
    service_window jsonb,
    version        bigint NOT NULL
);
CREATE INDEX ref_stays_unit ON maintenance.ref_stays (unit_id, status);

CREATE VIEW maintenance.v_meters AS
    SELECT m.seq, m.doc, m.villa_id, coalesce(v.location_id, '') AS location_id
    FROM maintenance.meters m LEFT JOIN maintenance.ref_villas v ON v.id = m.villa_id;

CREATE VIEW maintenance.v_meter_readings AS
    SELECT r.seq, r.doc, r.villa_id, coalesce(v.location_id, '') AS location_id
    FROM maintenance.meter_readings r LEFT JOIN maintenance.ref_villas v ON v.id = r.villa_id;

-- +goose Down
DROP VIEW maintenance.v_meter_readings;
DROP VIEW maintenance.v_meters;
DROP TABLE maintenance.ref_stays;
DROP TABLE maintenance.utility_settings;
DROP TABLE maintenance.meter_readings;
DROP TABLE maintenance.meters;
