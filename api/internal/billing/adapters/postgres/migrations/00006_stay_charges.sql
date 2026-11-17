-- +goose Up
-- The folio postings of the front desk's fees, one per key: an early check-in per stay
-- ("early:<bookingId>"), a lost or unreturned key per key ("key:<bookingId>:<keyId>"). Billing
-- posts them from reservation's early_checkin.granted and key.charged, so a redelivered or replayed
-- event finds the row and posts nothing more.
CREATE TABLE billing.stay_charges (
    charge_key text PRIMARY KEY,
    posting_id text NOT NULL
);

-- EARLY, the code an early check-in posts on. A database that keeps its own codes gains it; an empty
-- table serves the defaults, which list it. The stored tax rates carry it wherever they carry LATE,
-- so early check-in takes the service charge and PB1 a late check-out does.
INSERT INTO billing.transaction_codes (id, doc)
SELECT 'tc-early', '{"id": "tc-early", "code": "EARLY", "name": "Early check-in", "kind": "charge", "department": "room", "accountId": "gl-4100", "active": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM billing.transaction_codes)
  AND NOT EXISTS (SELECT 1 FROM billing.transaction_codes WHERE doc->>'code' = 'EARLY');

UPDATE billing.settings
SET doc = jsonb_set(doc, '{rates}', (
        SELECT jsonb_agg(r || jsonb_build_object(
            'serviceCodes', CASE WHEN jsonb_exists(r->'serviceCodes', 'LATE') AND NOT jsonb_exists(r->'serviceCodes', 'EARLY')
                                 THEN r->'serviceCodes' || '["EARLY"]'::jsonb ELSE COALESCE(r->'serviceCodes', '[]'::jsonb) END,
            'pb1Codes', CASE WHEN jsonb_exists(r->'pb1Codes', 'LATE') AND NOT jsonb_exists(r->'pb1Codes', 'EARLY')
                             THEN r->'pb1Codes' || '["EARLY"]'::jsonb ELSE COALESCE(r->'pb1Codes', '[]'::jsonb) END) ORDER BY ord)
        FROM jsonb_array_elements(doc->'rates') WITH ORDINALITY AS t(r, ord))),
    version = version + 1
WHERE key = 'tax' AND jsonb_typeof(doc->'rates') = 'array' AND jsonb_array_length(doc->'rates') > 0;

-- +goose Down
DELETE FROM billing.transaction_codes WHERE id = 'tc-early';
DROP TABLE billing.stay_charges;
