-- +goose Up
-- BKF, the code a rate package's breakfast posts on at the night audit. A database that keeps its
-- own codes gains it; an empty table serves the defaults, which list it. The stored tax rates
-- carry it wherever they carry FNB, so breakfast takes the service charge and PB1 food does.
INSERT INTO billing.transaction_codes (id, doc)
SELECT 'tc-bkf', '{"id": "tc-bkf", "code": "BKF", "name": "Breakfast", "kind": "charge", "department": "fnb", "accountId": "gl-4210", "active": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM billing.transaction_codes)
  AND NOT EXISTS (SELECT 1 FROM billing.transaction_codes WHERE doc->>'code' = 'BKF');

UPDATE billing.settings
SET doc = jsonb_set(doc, '{rates}', (
        SELECT jsonb_agg(r || jsonb_build_object(
            'serviceCodes', CASE WHEN jsonb_exists(r->'serviceCodes', 'FNB') AND NOT jsonb_exists(r->'serviceCodes', 'BKF')
                                 THEN r->'serviceCodes' || '["BKF"]'::jsonb ELSE COALESCE(r->'serviceCodes', '[]'::jsonb) END,
            'pb1Codes', CASE WHEN jsonb_exists(r->'pb1Codes', 'FNB') AND NOT jsonb_exists(r->'pb1Codes', 'BKF')
                             THEN r->'pb1Codes' || '["BKF"]'::jsonb ELSE COALESCE(r->'pb1Codes', '[]'::jsonb) END) ORDER BY ord)
        FROM jsonb_array_elements(doc->'rates') WITH ORDINALITY AS t(r, ord))),
    version = version + 1
WHERE key = 'tax' AND jsonb_typeof(doc->'rates') = 'array' AND jsonb_array_length(doc->'rates') > 0;

-- +goose Down
DELETE FROM billing.transaction_codes WHERE id = 'tc-bkf';
