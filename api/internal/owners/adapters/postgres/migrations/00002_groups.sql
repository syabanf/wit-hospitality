-- +goose Up
-- Reservation's booking groups, their source only, from booking_group.saved: a stay in a corporate
-- group counts in the corporate segment of the portal's figures.
CREATE TABLE owners.rm_groups (
    id      text   PRIMARY KEY,
    source  text   NOT NULL,
    version bigint NOT NULL
);

-- +goose Down
DROP TABLE owners.rm_groups;
