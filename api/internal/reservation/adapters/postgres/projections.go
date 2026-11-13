package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/query"
)

// Consumers.
const (
	// ConsumerCatalog keeps reservation's copy of the property catalog from property events.
	ConsumerCatalog = "reservation.catalog"
	// ConsumerReadModel keeps the rm_* tables from reservation events.
	ConsumerReadModel = "reservation.read-model"
)

// Projections applies events to the catalog copy and the read models. Every upsert keeps the row
// when it already holds a newer version, so a late redelivery cannot roll a row back.
type Projections struct{ DB *db.DB }

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	cat := func(eventType string, h projector.Handler) { p.On(ConsumerCatalog, eventType, h) }
	cat(property.EventLocationCreated, pr.location)
	cat(property.EventLocationUpdated, pr.location)
	cat(property.EventVillaCreated, pr.villa)
	cat(property.EventVillaUpdated, pr.villa)
	cat(property.EventGroupCreated, pr.group)
	cat(property.EventGroupUpdated, pr.group)
	cat(property.EventUnitCreated, pr.unit)
	cat(property.EventUnitUpdated, pr.unit)
	cat(property.EventRatePlanSaved, pr.ratePlan)
	cat(property.EventBlockAdded, pr.blockAdded)
	cat(property.EventBlockRemoved, pr.blockRemoved)

	rm := func(eventType, table string) { p.On(ConsumerReadModel, eventType, pr.upsert(table)) }
	rm(reservation.EventBookingSaved, query.Bookings)
	rm(reservation.EventBookingStatusChanged, query.Bookings)
	rm(reservation.EventGroupSaved, query.Groups)
	rm(reservation.EventRestrictionSaved, query.Restrictions)
	rm(reservation.EventOverbookingSet, query.Overbooking)
	rm(reservation.EventWalkRecorded, query.Walks)
	rm(reservation.EventPreCheckInSaved, query.PreCheckIns)
	p.On(ConsumerReadModel, reservation.EventRestrictionRemoved, pr.restrictionRemoved)
	p.On(ConsumerGuest, guest.EventGuestMerged, pr.guestMerged)
}

// ConsumerGuest follows guest merges.
const ConsumerGuest = "reservation.guest"

// guestMerged moves the bookings and group leads of the dropped profile to the kept one, in the
// write model and the read models at the same version. Running it twice finds nothing to move.
func (pr Projections) guestMerged(ctx context.Context, m bus.Message) error {
	e, err := decode[guest.GuestMerged](m)
	if err != nil {
		return err
	}
	q := pr.DB.Q(ctx)
	for _, t := range []struct{ write, read, field string }{
		{"bookings", "rm_bookings", "guestId"},
		{"booking_groups", "rm_booking_groups", "leadGuestId"},
	} {
		if _, err := q.Exec(ctx, `
			UPDATE reservation.`+t.read+` r SET doc = jsonb_set(r.doc, '{`+t.field+`}', to_jsonb($1::text)), version = r.version + 1
			WHERE r.doc->>'`+t.field+`' = $2`, e.KeepID, e.DropID); err != nil {
			return err
		}
		if _, err := q.Exec(ctx, `
			UPDATE reservation.`+t.write+` SET doc = jsonb_set(doc, '{`+t.field+`}', to_jsonb($1::text)), version = version + 1
			WHERE doc->>'`+t.field+`' = $2`, e.KeepID, e.DropID); err != nil {
			return err
		}
	}
	return nil
}

func decode[T any](m bus.Message) (T, error) {
	var v T
	err := json.Unmarshal(m.Payload, &v)
	return v, err
}

func (pr Projections) location(ctx context.Context, m bus.Message) error {
	e, err := decode[property.LocationEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO reservation.cat_locations (id, name, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version
		WHERE reservation.cat_locations.version < EXCLUDED.version`, e.Location.ID, e.Location.Name, m.AggregateVersion)
	return err
}

func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	e, err := decode[property.VillaEvent](m)
	if err != nil {
		return err
	}
	v := e.Villa
	// An event from before villas carried house times leaves them NULL; a replay of the same
	// version from the snapshot catch-up fills them in.
	var checkIn, checkOut *string
	if v.CheckInTime != "" {
		checkIn, checkOut = &v.CheckInTime, &v.CheckOutTime
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO reservation.cat_villas (id, location_id, name, check_in_time, check_out_time, version) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, check_in_time = EXCLUDED.check_in_time,
			check_out_time = EXCLUDED.check_out_time, version = EXCLUDED.version
		WHERE reservation.cat_villas.version < EXCLUDED.version
			OR (reservation.cat_villas.version = EXCLUDED.version AND reservation.cat_villas.check_in_time IS NULL AND EXCLUDED.check_in_time IS NOT NULL)`,
		v.ID, v.LocationID, v.Name, checkIn, checkOut, m.AggregateVersion)
	return err
}

func (pr Projections) group(ctx context.Context, m bus.Message) error {
	e, err := decode[property.GroupEvent](m)
	if err != nil {
		return err
	}
	g := e.Group
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO reservation.cat_unit_groups (id, villa_id, name, interchangeable, operator_assigns, version) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, name = EXCLUDED.name, interchangeable = EXCLUDED.interchangeable,
			operator_assigns = EXCLUDED.operator_assigns, version = EXCLUDED.version
		WHERE reservation.cat_unit_groups.version < EXCLUDED.version`, g.ID, g.VillaID, g.Name, g.Interchangeable, g.OperatorAssigns, m.AggregateVersion)
	return err
}

// unit keeps a unit and its capacity. An event from before capacity existed carries maxAdults 0,
// stored as NULL (unknown). A row at the same version without a capacity was written before
// 00003_catalog_profile, so a replay of that version fills it in.
func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	u := e.Unit
	var maxAdults, maxChildren, extraBeds *int
	if u.MaxAdults > 0 {
		maxAdults, maxChildren, extraBeds = &u.MaxAdults, &u.MaxChildren, &u.ExtraBeds
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO reservation.cat_units (id, villa_id, group_id, code, name, nightly_rate, status, max_adults, max_children, extra_beds, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, group_id = EXCLUDED.group_id, code = EXCLUDED.code, name = EXCLUDED.name,
			nightly_rate = EXCLUDED.nightly_rate, status = EXCLUDED.status, max_adults = EXCLUDED.max_adults,
			max_children = EXCLUDED.max_children, extra_beds = EXCLUDED.extra_beds, version = EXCLUDED.version
		WHERE reservation.cat_units.version < EXCLUDED.version
			OR (reservation.cat_units.version = EXCLUDED.version AND reservation.cat_units.max_adults IS NULL AND EXCLUDED.max_adults IS NOT NULL)`,
		u.ID, u.VillaID, u.GroupID, u.Code, u.Name, u.NightlyRate, u.Status, maxAdults, maxChildren, extraBeds, m.AggregateVersion)
	return err
}

func (pr Projections) ratePlan(ctx context.Context, m bus.Message) error {
	e, err := decode[property.RatePlanSaved](m)
	if err != nil {
		return err
	}
	if e.Plan.Seasons == nil {
		e.Plan.Seasons = []property.Season{}
	}
	plan, err := json.Marshal(e.Plan)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO reservation.cat_rate_plans (group_id, plan, version) VALUES ($1, $2, $3)
		ON CONFLICT (group_id) DO UPDATE SET plan = EXCLUDED.plan, version = EXCLUDED.version
		WHERE reservation.cat_rate_plans.version < EXCLUDED.version`, e.Plan.GroupID, plan, m.AggregateVersion)
	return err
}

func (pr Projections) blockAdded(ctx context.Context, m bus.Message) error {
	e, err := decode[property.BlockAdded](m)
	if err != nil {
		return err
	}
	b := e.Block
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO reservation.cat_blocks (id, unit_id, from_date, to_date, reason, version) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO NOTHING`, b.ID, b.UnitID, b.From, b.To, b.Reason, m.AggregateVersion)
	return err
}

// blockRemoved keeps a tombstone, so an add redelivered after the removal stays removed.
func (pr Projections) blockRemoved(ctx context.Context, m bus.Message) error {
	e, err := decode[property.BlockRemoved](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO reservation.cat_blocks (id, unit_id, from_date, to_date, reason, removed, version) VALUES ($1, $2, '', '', '', true, $3)
		ON CONFLICT (id) DO UPDATE SET removed = true, version = EXCLUDED.version`, e.ID, e.UnitID, m.AggregateVersion)
	return err
}

// upsert keeps one rm_* table from events that carry a reservation.Record. A new restriction row
// takes the write model's seq as its position, the order the list follows.
func (pr Projections) upsert(table string) projector.Handler {
	cols, vals := "", ""
	if table == query.Restrictions {
		cols, vals = ", position", ", (SELECT seq FROM reservation.restrictions WHERE id = $1)"
	}
	return func(ctx context.Context, m bus.Message) error {
		r, err := decode[reservation.Record](m)
		if err != nil {
			return err
		}
		_, err = pr.DB.Q(ctx).Exec(ctx, `
			INSERT INTO reservation.`+table+` (id, villa_ids, location_ids, doc, version`+cols+`) VALUES ($1, $2, $3, $4, $5`+vals+`)
			ON CONFLICT (id) DO UPDATE SET villa_ids = EXCLUDED.villa_ids, location_ids = EXCLUDED.location_ids, doc = EXCLUDED.doc,
				removed = false, version = EXCLUDED.version
			WHERE reservation.`+table+`.version < EXCLUDED.version`, r.ID, r.VillaIDs, r.LocationIDs, []byte(r.Data), m.AggregateVersion)
		return err
	}
}

// restrictionRemoved keeps a tombstone with the removal's version.
func (pr Projections) restrictionRemoved(ctx context.Context, m bus.Message) error {
	e, err := decode[reservation.Removed](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO reservation.rm_restrictions (id, villa_ids, location_ids, doc, removed, version) VALUES ($1, '{}', '{}', 'null', true, $2)
		ON CONFLICT (id) DO UPDATE SET removed = true, version = EXCLUDED.version
		WHERE reservation.rm_restrictions.version < EXCLUDED.version`, e.ID, m.AggregateVersion)
	return err
}
