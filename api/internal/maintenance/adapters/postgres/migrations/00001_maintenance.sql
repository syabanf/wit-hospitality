-- +goose Up
-- Write model: one table per aggregate. Each row keeps the aggregate as a JSON document plus the
-- columns the commands look up by, and a version for optimistic concurrency.
CREATE TABLE maintenance.work_orders (
    seq      bigserial,
    id       text   PRIMARY KEY,
    number   text   NOT NULL UNIQUE,
    villa_id text   NOT NULL,
    plan_id  text,
    status   text   NOT NULL,
    doc      jsonb  NOT NULL,
    version  bigint NOT NULL DEFAULT 1
);
CREATE INDEX work_orders_plan ON maintenance.work_orders (plan_id) WHERE plan_id IS NOT NULL;

CREATE TABLE maintenance.assets (
    seq      bigserial,
    id       text   PRIMARY KEY,
    code     text   NOT NULL UNIQUE,
    villa_id text   NOT NULL,
    doc      jsonb  NOT NULL,
    version  bigint NOT NULL DEFAULT 1
);

CREATE TABLE maintenance.vendors (
    seq     bigserial,
    id      text   PRIMARY KEY,
    name    text   NOT NULL,
    doc     jsonb  NOT NULL,
    version bigint NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX vendors_name ON maintenance.vendors (lower(name));

CREATE TABLE maintenance.plans (
    seq      bigserial,
    id       text    PRIMARY KEY,
    villa_id text    NOT NULL,
    active   boolean NOT NULL,
    next_due text    NOT NULL,
    doc      jsonb   NOT NULL,
    version  bigint  NOT NULL DEFAULT 1
);

-- Counters keep the mock's numbering (wo-12 / WO-512, ast-9, ven-6, plan-8).
CREATE TABLE maintenance.counters (
    key  text   PRIMARY KEY,
    next bigint NOT NULL
);

-- Cash-outs this context asked finance for, with the status finance last reported.
CREATE TABLE maintenance.cash_outs (
    id              text   PRIMARY KEY,
    number          text   NOT NULL UNIQUE,
    status          text   NOT NULL,
    origin          text   NOT NULL,
    source_id       text   NOT NULL,
    amount          bigint NOT NULL,
    created_by_id   text   NOT NULL,
    created_by      text   NOT NULL,
    request         jsonb  NOT NULL,
    finance_version bigint NOT NULL DEFAULT 0,
    version         bigint NOT NULL DEFAULT 1
);

-- What maintenance knows of property's catalog, projected from property events.
CREATE TABLE maintenance.ref_villas (
    id          text   PRIMARY KEY,
    location_id text   NOT NULL,
    name        text   NOT NULL,
    version     bigint NOT NULL
);

CREATE TABLE maintenance.ref_units (
    id       text   PRIMARY KEY,
    villa_id text   NOT NULL,
    code     text   NOT NULL,
    version  bigint NOT NULL
);

-- Read side: views over the write tables carry the villa's location for the scope filter.
CREATE VIEW maintenance.v_work_orders AS
    SELECT w.seq, w.doc, w.villa_id, coalesce(v.location_id, '') AS location_id
    FROM maintenance.work_orders w LEFT JOIN maintenance.ref_villas v ON v.id = w.villa_id;

CREATE VIEW maintenance.v_assets AS
    SELECT a.seq, a.doc, a.villa_id, coalesce(v.location_id, '') AS location_id
    FROM maintenance.assets a LEFT JOIN maintenance.ref_villas v ON v.id = a.villa_id;

CREATE VIEW maintenance.v_plans AS
    SELECT p.seq, p.doc, p.villa_id, coalesce(v.location_id, '') AS location_id
    FROM maintenance.plans p LEFT JOIN maintenance.ref_villas v ON v.id = p.villa_id;

-- +goose Down
DROP VIEW maintenance.v_plans;
DROP VIEW maintenance.v_assets;
DROP VIEW maintenance.v_work_orders;
DROP TABLE maintenance.ref_units;
DROP TABLE maintenance.ref_villas;
DROP TABLE maintenance.cash_outs;
DROP TABLE maintenance.counters;
DROP TABLE maintenance.plans;
DROP TABLE maintenance.vendors;
DROP TABLE maintenance.assets;
DROP TABLE maintenance.work_orders;
