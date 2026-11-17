-- +goose Up
-- The folio posting each guest request made (a complaint's credit, an incident's damage, a lost
-- safe box key), one per source. Billing posts it from guest's folio_posting.requested, so a
-- redelivered or replayed request finds the row and posts nothing more.
CREATE TABLE billing.guest_postings (
    source_id  text PRIMARY KEY,
    posting_id text NOT NULL
);

-- +goose Down
DROP TABLE billing.guest_postings;
