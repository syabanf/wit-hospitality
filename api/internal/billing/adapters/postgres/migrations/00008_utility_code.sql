-- +goose Up
-- UTIL, the code a long stay's guest-paid electricity, water and gas posts on
-- (villa-operations-contract.md). A database that keeps its own codes gains it; an empty table
-- serves the defaults, which list it. It carries no service charge or PB1. Damage posts on DMG; both
-- claim their posting in stay_charges ("damage:<checkId>:<itemId>", "utility:<readingId>").
INSERT INTO billing.transaction_codes (id, doc)
SELECT 'tc-util', '{"id": "tc-util", "code": "UTIL", "name": "Electricity, water and gas", "kind": "charge", "department": "other", "accountId": "gl-4900", "active": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM billing.transaction_codes)
  AND NOT EXISTS (SELECT 1 FROM billing.transaction_codes WHERE doc->>'code' = 'UTIL');

-- +goose Down
DELETE FROM billing.transaction_codes WHERE id = 'tc-util';
