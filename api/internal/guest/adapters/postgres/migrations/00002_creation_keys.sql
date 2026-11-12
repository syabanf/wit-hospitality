-- +goose Up
-- The profile another context created under a request key, so a retried booking with a new guest
-- finds the profile its first attempt made instead of adding a second one.
CREATE TABLE guest.creation_keys (
    key        text        PRIMARY KEY,
    guest_id   text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE guest.creation_keys;
