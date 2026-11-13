-- +goose Up
-- A menu item may be served to a villa stay outside its hours on request; existing items keep
-- their hours. Each setup a guest asks for before arrival becomes one service request to the host,
-- once per stay and setup.
UPDATE services.menu_items SET doc = doc || '{"villaOnRequest": false}'::jsonb WHERE NOT doc ? 'villaOnRequest';

CREATE TABLE services.setup_requests (
    booking_id text NOT NULL,
    setup      text NOT NULL,
    PRIMARY KEY (booking_id, setup)
);

-- +goose Down
DROP TABLE services.setup_requests;
UPDATE services.menu_items SET doc = doc - 'villaOnRequest';
