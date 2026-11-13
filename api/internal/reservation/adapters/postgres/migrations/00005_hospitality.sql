-- +goose Up
-- A unit's default villa host and a villa's late check-out fee, copied from property's events. A
-- NULL fee means the copy has not seen an event that carries it yet: read as the operation's
-- default (500000 where rooms are sold, 0 in a villa) until the snapshot catch-up fills it.
ALTER TABLE reservation.cat_units
    ADD COLUMN host_id text;

ALTER TABLE reservation.cat_villas
    ADD COLUMN late_checkout_fee bigint;

-- Existing stays have no host and no preferences, and take their unit kind's service window: the
-- schedule for a room, 10:00 to 12:00 for a villa.
-- +goose StatementBegin
CREATE FUNCTION reservation.stay_defaults(p_unit text) RETURNS jsonb LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'hostId', NULL,
        'lateCheckout', NULL,
        'preferences', jsonb_build_object('breakfastTime', '', 'dietary', '', 'setups', '[]'::jsonb, 'arrivalTime', '', 'notes', ''),
        'serviceWindow', CASE
            WHEN COALESCE(g.kind, CASE WHEN v.operation = 'hotel' THEN 'room' ELSE 'villa' END) = 'room'
                THEN '{"mode": "scheduled", "from": "", "to": ""}'::jsonb
            ELSE '{"mode": "window", "from": "10:00", "to": "12:00"}'::jsonb
        END)
    FROM (SELECT 1) one
    LEFT JOIN reservation.cat_units u ON u.id = p_unit
    LEFT JOIN reservation.cat_unit_groups g ON g.id = u.group_id
    LEFT JOIN reservation.cat_villas v ON v.id = u.villa_id
$$;
-- +goose StatementEnd

UPDATE reservation.bookings SET doc = doc || reservation.stay_defaults(doc->>'unitId') WHERE NOT doc ? 'serviceWindow';
UPDATE reservation.rm_bookings SET doc = doc || reservation.stay_defaults(doc->>'unitId') WHERE NOT doc ? 'serviceWindow';

DROP FUNCTION reservation.stay_defaults(text);

-- The host's list of stays reads bookings by host.
CREATE INDEX rm_bookings_host ON reservation.rm_bookings ((doc->>'hostId')) WHERE doc->>'hostId' IS NOT NULL;

-- +goose Down
DROP INDEX reservation.rm_bookings_host;
UPDATE reservation.rm_bookings SET doc = doc - 'hostId' - 'preferences' - 'serviceWindow' - 'lateCheckout';
UPDATE reservation.bookings SET doc = doc - 'hostId' - 'preferences' - 'serviceWindow' - 'lateCheckout';
ALTER TABLE reservation.cat_villas DROP COLUMN late_checkout_fee;
ALTER TABLE reservation.cat_units DROP COLUMN host_id;
