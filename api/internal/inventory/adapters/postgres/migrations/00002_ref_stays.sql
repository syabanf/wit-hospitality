-- +goose Up
-- The booking facts a minibar check needs, projected from reservation's booking events.
CREATE TABLE inventory.ref_stays (
    id      text   PRIMARY KEY,
    code    text   NOT NULL,
    status  text   NOT NULL,
    unit_id text   NOT NULL,
    version bigint NOT NULL
);

-- +goose Down
DROP TABLE inventory.ref_stays;
