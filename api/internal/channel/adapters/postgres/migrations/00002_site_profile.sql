-- +goose Up
-- The public site shows each villa's profile (address, house times, rules, policies, photos) and
-- each unit's capacity, beds, view and photos. site keeps that public part of the property
-- event as it arrived, without bank or licence details; NULL until an event carrying it (or the
-- snapshot catch-up) fills it.
ALTER TABLE channel.rm_villas ADD COLUMN site jsonb;
ALTER TABLE channel.rm_units ADD COLUMN site jsonb;

-- +goose Down
ALTER TABLE channel.rm_units DROP COLUMN site;
ALTER TABLE channel.rm_villas DROP COLUMN site;
