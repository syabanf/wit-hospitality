-- +goose Up
-- Write model. On hand is the sum of the movements; an item's average cost is the replay's,
-- stored on the item by the command that changed the movements.
CREATE TABLE inventory.items (
    seq           bigserial,
    id            text    PRIMARY KEY,
    code          text    NOT NULL UNIQUE,
    name          text    NOT NULL,
    kind          text    NOT NULL,
    unit          text    NOT NULL,
    reorder_level integer NOT NULL,
    par           integer NOT NULL,
    average_cost  bigint  NOT NULL DEFAULT 0,
    active        boolean NOT NULL,
    version       bigint  NOT NULL DEFAULT 1
);

CREATE TABLE inventory.movements (
    seq            bigserial,
    id             text    PRIMARY KEY,
    number         text    NOT NULL,
    villa_id       text    NOT NULL,
    item_id        text    NOT NULL,
    kind           text    NOT NULL,
    quantity       integer NOT NULL,
    unit_cost      bigint  NOT NULL,
    on_date        text    NOT NULL,
    by_name        text    NOT NULL,
    unit_id        text,
    booking_id     text,
    order_id       text,
    receipt_id     text,
    count_id       text,
    transfer_id    text,
    other_villa_id text,
    reason         text    NOT NULL DEFAULT ''
);
CREATE INDEX movements_receipt ON inventory.movements (receipt_id) WHERE receipt_id IS NOT NULL;

CREATE TABLE inventory.receipts (
    seq      bigserial,
    id       text   PRIMARY KEY,
    number   text   NOT NULL UNIQUE,
    villa_id text   NOT NULL,
    doc      jsonb  NOT NULL,
    version  bigint NOT NULL DEFAULT 1
);

CREATE TABLE inventory.counts (
    seq      bigserial,
    id       text  PRIMARY KEY,
    villa_id text  NOT NULL,
    doc      jsonb NOT NULL
);

-- Saving a kit or a link replaces the row, so the list keeps the mock's order: latest save last.
CREATE TABLE inventory.kits (
    seq      bigserial,
    group_id text  PRIMARY KEY,
    lines    jsonb NOT NULL
);

CREATE TABLE inventory.minibar_links (
    seq           bigserial,
    menu_item_id  text PRIMARY KEY,
    stock_item_id text NOT NULL
);

-- Minibar checks waiting for services to adopt them as delivered orders.
CREATE TABLE inventory.minibar_checks (
    id  text  PRIMARY KEY,
    doc jsonb NOT NULL
);

-- Counters keep the mock's numbering (sm-412 / SM-1412, srx-9 / SR-309, scx-3 / SC-103, ...).
CREATE TABLE inventory.counters (
    key  text   PRIMARY KEY,
    next bigint NOT NULL
);

-- Cash-outs this context asked finance for, with the status finance last reported.
CREATE TABLE inventory.cash_outs (
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

-- References projected from property (villas, room types, units) and services (menu items).
CREATE TABLE inventory.ref_villas (
    id          text   PRIMARY KEY,
    location_id text   NOT NULL,
    name        text   NOT NULL,
    version     bigint NOT NULL
);

CREATE TABLE inventory.ref_groups (
    id       text   PRIMARY KEY,
    villa_id text   NOT NULL,
    name     text   NOT NULL,
    version  bigint NOT NULL
);

CREATE TABLE inventory.ref_units (
    id       text   PRIMARY KEY,
    villa_id text   NOT NULL,
    group_id text,
    code     text   NOT NULL,
    version  bigint NOT NULL
);

CREATE TABLE inventory.ref_menu_items (
    id       text    PRIMARY KEY,
    villa_id text    NOT NULL,
    category text    NOT NULL,
    name     text    NOT NULL,
    unit     text    NOT NULL,
    price    bigint  NOT NULL,
    active   boolean NOT NULL,
    version  bigint  NOT NULL
);

-- Read side: views carry the villa's location for the scope filter.
CREATE VIEW inventory.v_movements AS
    SELECT m.*, coalesce(v.location_id, '') AS location_id
    FROM inventory.movements m LEFT JOIN inventory.ref_villas v ON v.id = m.villa_id;

CREATE VIEW inventory.v_receipts AS
    SELECT r.seq, r.doc, r.villa_id, coalesce(v.location_id, '') AS location_id
    FROM inventory.receipts r LEFT JOIN inventory.ref_villas v ON v.id = r.villa_id;

CREATE VIEW inventory.v_counts AS
    SELECT c.seq, c.doc, c.villa_id, coalesce(v.location_id, '') AS location_id
    FROM inventory.counts c LEFT JOIN inventory.ref_villas v ON v.id = c.villa_id;

CREATE VIEW inventory.v_kits AS
    SELECT k.seq, k.group_id, k.lines, coalesce(g.villa_id, '') AS villa_id, coalesce(v.location_id, '') AS location_id
    FROM inventory.kits k LEFT JOIN inventory.ref_groups g ON g.id = k.group_id LEFT JOIN inventory.ref_villas v ON v.id = g.villa_id;

CREATE VIEW inventory.v_links AS
    SELECT l.seq, l.menu_item_id, l.stock_item_id, coalesce(m.villa_id, '') AS villa_id, coalesce(v.location_id, '') AS location_id
    FROM inventory.minibar_links l LEFT JOIN inventory.ref_menu_items m ON m.id = l.menu_item_id LEFT JOIN inventory.ref_villas v ON v.id = m.villa_id;

-- +goose Down
DROP VIEW inventory.v_links;
DROP VIEW inventory.v_kits;
DROP VIEW inventory.v_counts;
DROP VIEW inventory.v_receipts;
DROP VIEW inventory.v_movements;
DROP TABLE inventory.ref_menu_items;
DROP TABLE inventory.ref_units;
DROP TABLE inventory.ref_groups;
DROP TABLE inventory.ref_villas;
DROP TABLE inventory.cash_outs;
DROP TABLE inventory.counters;
DROP TABLE inventory.minibar_checks;
DROP TABLE inventory.minibar_links;
DROP TABLE inventory.kits;
DROP TABLE inventory.counts;
DROP TABLE inventory.receipts;
DROP TABLE inventory.movements;
DROP TABLE inventory.items;
