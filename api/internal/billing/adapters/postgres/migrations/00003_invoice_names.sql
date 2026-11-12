-- +goose Up
-- What the public e-invoice prints of other contexts: the room type of a unit (property's
-- unit_group events), the Airbnb account of a stay (channel's airbnb_account events) and the
-- service requests on a stay (services.request.saved.v1).
ALTER TABLE billing.cat_units ADD COLUMN group_id text;

CREATE TABLE billing.cat_groups (
    id      text   PRIMARY KEY,
    doc     jsonb  NOT NULL,
    version bigint NOT NULL
);

CREATE TABLE billing.cat_accounts (
    id      text   PRIMARY KEY,
    doc     jsonb  NOT NULL,
    version bigint NOT NULL
);

CREATE TABLE billing.rm_requests (
    id         text   PRIMARY KEY,
    booking_id text,
    doc        jsonb  NOT NULL,
    version    bigint NOT NULL
);
CREATE INDEX rm_requests_booking ON billing.rm_requests (booking_id);

-- +goose Down
DROP TABLE billing.rm_requests, billing.cat_accounts, billing.cat_groups;
ALTER TABLE billing.cat_units DROP COLUMN group_id;
