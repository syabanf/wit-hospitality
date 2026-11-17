-- +goose Up
-- Charges other contexts ask billing to post on a stay's folio, one row per source reference: a
-- damaged item an inventory check found (`<checkId>:<itemId>`) or a long stay's utility usage (the
-- reading id). A redelivered or replayed event finds the row and posts nothing.
CREATE TABLE billing.stay_charges (
    source_ref text PRIMARY KEY,
    posting_id text NOT NULL
);

-- UTIL, the code a long stay's guest-paid electricity, water and gas posts on. A database that
-- keeps its own codes gains it; an empty table serves the defaults, which list it. It carries no
-- service charge or PB1.
INSERT INTO billing.transaction_codes (id, doc)
SELECT 'tc-util', '{"id": "tc-util", "code": "UTIL", "name": "Electricity, water and gas", "kind": "charge", "department": "other", "accountId": "gl-4900", "active": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM billing.transaction_codes)
  AND NOT EXISTS (SELECT 1 FROM billing.transaction_codes WHERE doc->>'code' = 'UTIL');

-- +goose Down
DELETE FROM billing.transaction_codes WHERE id = 'tc-util';
DROP TABLE billing.stay_charges;
