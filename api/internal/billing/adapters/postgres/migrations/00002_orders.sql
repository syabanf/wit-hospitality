-- +goose Up
-- Billing's copy of the room service orders that reached the bill: delivered orders from
-- services.order.delivered.v1 and the seed, voided ones kept with their status.
CREATE TABLE billing.rm_orders (
    id         text   PRIMARY KEY,
    booking_id text   NOT NULL,
    status     text   NOT NULL,
    doc        jsonb  NOT NULL,
    version    bigint NOT NULL DEFAULT 1
);
CREATE INDEX rm_orders_booking ON billing.rm_orders (booking_id);

-- +goose Down
DROP TABLE billing.rm_orders;
