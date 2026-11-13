-- +goose Up
-- The folio posting that charged a stay's late check-out, one per stay. Billing posts it from
-- reservation's late_checkout.granted, so a redelivered or replayed grant finds the row and posts
-- nothing more.
CREATE TABLE billing.late_checkouts (
    booking_id text PRIMARY KEY,
    posting_id text NOT NULL
);

-- +goose Down
DROP TABLE billing.late_checkouts;
