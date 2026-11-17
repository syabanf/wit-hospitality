-- +goose Up
-- Sections: a named set of rooms of one hotel or mixed property, for housekeeping to hand a run of
-- rooms to one attendant. Reads come from this table joined to the villa for the scope.
CREATE TABLE property.sections (
    seq      bigint GENERATED ALWAYS AS IDENTITY,
    id       text PRIMARY KEY,
    villa_id text NOT NULL REFERENCES property.villas (id),
    name     text NOT NULL,
    unit_ids jsonb NOT NULL DEFAULT '[]',
    version  bigint NOT NULL DEFAULT 1
);
CREATE INDEX sections_villa ON property.sections (villa_id);

-- Rate packages of a room type's plan: breakfast, fixed and percent rates. Plans saved before
-- packages have none.
ALTER TABLE property.rate_plans ADD COLUMN packages jsonb NOT NULL DEFAULT '[]';
ALTER TABLE property.rm_rate_plans ADD COLUMN packages jsonb NOT NULL DEFAULT '[]';

-- +goose Down
ALTER TABLE property.rm_rate_plans DROP COLUMN packages;
ALTER TABLE property.rate_plans DROP COLUMN packages;
DROP TABLE property.sections;
