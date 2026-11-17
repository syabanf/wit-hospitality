-- +goose Up
-- A villa's early check-in fee and whether check-in waits for a signed registration card, copied
-- from property's events. NULL means the copy has not seen an event that carries them yet: read as
-- the operation's default (500000 and asked where rooms are sold, 0 and not asked in a villa) until
-- the snapshot catch-up fills them. The registration card, early check-in, keys and wake-up calls
-- live in the booking document and need no column.
ALTER TABLE reservation.cat_villas
    ADD COLUMN early_checkin_fee bigint,
    ADD COLUMN require_registration_card boolean;

-- +goose Down
ALTER TABLE reservation.cat_villas DROP COLUMN require_registration_card, DROP COLUMN early_checkin_fee;
