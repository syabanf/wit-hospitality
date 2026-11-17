-- +goose Up
-- A property's early check-in fee (a mixed property charges it on rooms only) and whether check-in
-- waits for a signed registration card. Existing hotels and mixed properties charge 500000 and ask
-- for the card; existing villas charge nothing and do not.
ALTER TABLE property.villas
    ADD COLUMN early_checkin_fee bigint NOT NULL DEFAULT 0 CHECK (early_checkin_fee >= 0),
    ADD COLUMN require_registration_card boolean NOT NULL DEFAULT false;
UPDATE property.villas SET early_checkin_fee = 500000, require_registration_card = true WHERE operation IN ('hotel', 'mixed');

ALTER TABLE property.rm_villas
    ADD COLUMN early_checkin_fee bigint NOT NULL DEFAULT 0,
    ADD COLUMN require_registration_card boolean NOT NULL DEFAULT false;
UPDATE property.rm_villas SET early_checkin_fee = 500000, require_registration_card = true WHERE operation IN ('hotel', 'mixed');

-- +goose Down
ALTER TABLE property.rm_villas DROP COLUMN require_registration_card, DROP COLUMN early_checkin_fee;
ALTER TABLE property.villas DROP COLUMN require_registration_card, DROP COLUMN early_checkin_fee;
