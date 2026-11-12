-- +goose Up
-- The version of finance's last answer on a batch's bill (finance.cash_out.decided.v1, consumer
-- housekeeping.cash-outs), so a late redelivery cannot roll the decision back.
ALTER TABLE housekeeping.laundry_batches ADD COLUMN finance_version bigint NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE housekeeping.laundry_batches DROP COLUMN finance_version;
