-- +goose Up
-- The token of the guest's stay page, copied from reservation's booking events so a template can
-- carry the link ({stayLink}); empty until the stay checks in.
ALTER TABLE messaging.stays
    ADD COLUMN stay_token text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE messaging.stays DROP COLUMN stay_token;
