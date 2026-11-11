package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// ConsumerReadModel keeps the rm_* tables.
const ConsumerReadModel = "property.read-model"

// Projections applies property events to the read models. Every upsert keeps the row when it
// already holds a newer version, so a late redelivery cannot roll a row back.
type Projections struct{ DB *db.DB }

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	on := func(eventType string, h projector.Handler) { p.On(ConsumerReadModel, eventType, h) }
	on(property.EventLocationCreated, pr.location)
	on(property.EventLocationUpdated, pr.location)
	on(property.EventVillaCreated, pr.villa)
	on(property.EventVillaUpdated, pr.villa)
	on(property.EventGroupCreated, pr.group)
	on(property.EventGroupUpdated, pr.group)
	on(property.EventUnitCreated, pr.unit)
	on(property.EventUnitUpdated, pr.unit)
	on(property.EventRatePlanSaved, pr.ratePlan)
	on(property.EventBlockAdded, pr.blockAdded)
	on(property.EventBlockRemoved, pr.blockRemoved)
}

func decode[T any](m bus.Message) (T, error) {
	var v T
	err := json.Unmarshal(m.Payload, &v)
	return v, err
}

func list(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (pr Projections) location(ctx context.Context, m bus.Message) error {
	e, err := decode[property.LocationEvent](m)
	if err != nil {
		return err
	}
	l := e.Location
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO property.rm_locations (id, name, area, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, area = EXCLUDED.area, version = EXCLUDED.version
		WHERE property.rm_locations.version < EXCLUDED.version`, l.ID, l.Name, l.Area, m.AggregateVersion)
	return err
}

func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	e, err := decode[property.VillaEvent](m)
	if err != nil {
		return err
	}
	v := e.Villa
	q := pr.DB.Q(ctx)
	tag, err := q.Exec(ctx, `
		INSERT INTO property.rm_villas (id, location_id, code, name, description, facilities, version) VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, code = EXCLUDED.code, name = EXCLUDED.name,
			description = EXCLUDED.description, facilities = EXCLUDED.facilities, version = EXCLUDED.version
		WHERE property.rm_villas.version < EXCLUDED.version`, v.ID, v.LocationID, v.Code, v.Name, v.Description, list(v.Facilities), m.AggregateVersion)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	// A villa that moved location takes its room types, units, plans and blocks along.
	for _, table := range []string{"rm_unit_groups", "rm_units", "rm_rate_plans", "rm_unit_blocks"} {
		if _, err := q.Exec(ctx, `UPDATE property.`+table+` SET location_id = $2 WHERE villa_id = $1 AND location_id <> $2`, v.ID, v.LocationID); err != nil {
			return err
		}
	}
	return nil
}

func (pr Projections) group(ctx context.Context, m bus.Message) error {
	e, err := decode[property.GroupEvent](m)
	if err != nil {
		return err
	}
	g := e.Group
	q := pr.DB.Q(ctx)
	tag, err := q.Exec(ctx, `
		INSERT INTO property.rm_unit_groups (id, villa_id, location_id, name, interchangeable, operator_assigns, version) VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, location_id = EXCLUDED.location_id, name = EXCLUDED.name,
			interchangeable = EXCLUDED.interchangeable, operator_assigns = EXCLUDED.operator_assigns, version = EXCLUDED.version
		WHERE property.rm_unit_groups.version < EXCLUDED.version`, g.ID, g.VillaID, e.LocationID, g.Name, g.Interchangeable, g.OperatorAssigns, m.AggregateVersion)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	_, err = q.Exec(ctx, `UPDATE property.rm_rate_plans SET villa_id = $2, location_id = $3 WHERE group_id = $1`, g.ID, g.VillaID, e.LocationID)
	return err
}

func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	u := e.Unit
	q := pr.DB.Q(ctx)
	tag, err := q.Exec(ctx, `
		INSERT INTO property.rm_units (id, villa_id, location_id, group_id, code, name, bedrooms, nightly_rate, status, amenities, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, location_id = EXCLUDED.location_id, group_id = EXCLUDED.group_id,
			code = EXCLUDED.code, name = EXCLUDED.name, bedrooms = EXCLUDED.bedrooms, nightly_rate = EXCLUDED.nightly_rate,
			status = EXCLUDED.status, amenities = EXCLUDED.amenities, version = EXCLUDED.version
		WHERE property.rm_units.version < EXCLUDED.version`,
		u.ID, u.VillaID, e.LocationID, u.GroupID, u.Code, u.Name, u.Bedrooms, u.NightlyRate, u.Status, list(u.Amenities), m.AggregateVersion)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	_, err = q.Exec(ctx, `UPDATE property.rm_unit_blocks SET villa_id = $2, location_id = $3 WHERE unit_id = $1`, u.ID, u.VillaID, e.LocationID)
	return err
}

func (pr Projections) ratePlan(ctx context.Context, m bus.Message) error {
	e, err := decode[property.RatePlanSaved](m)
	if err != nil {
		return err
	}
	p := e.Plan
	if p.Seasons == nil {
		p.Seasons = []property.Season{}
	}
	seasons, err := json.Marshal(p.Seasons)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO property.rm_rate_plans (group_id, villa_id, location_id, weekday_rate, weekend_rate, seasons, version) VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (group_id) DO UPDATE SET villa_id = EXCLUDED.villa_id, location_id = EXCLUDED.location_id, weekday_rate = EXCLUDED.weekday_rate,
			weekend_rate = EXCLUDED.weekend_rate, seasons = EXCLUDED.seasons, version = EXCLUDED.version
		WHERE property.rm_rate_plans.version < EXCLUDED.version`, p.GroupID, e.VillaID, e.LocationID, p.WeekdayRate, p.WeekendRate, seasons, m.AggregateVersion)
	return err
}

func (pr Projections) blockAdded(ctx context.Context, m bus.Message) error {
	e, err := decode[property.BlockAdded](m)
	if err != nil {
		return err
	}
	b := e.Block
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO property.rm_unit_blocks (id, unit_id, villa_id, location_id, from_date, to_date, reason, note, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (id) DO NOTHING`, b.ID, b.UnitID, e.VillaID, e.LocationID, b.From, b.To, b.Reason, b.Note, m.AggregateVersion)
	return err
}

// blockRemoved keeps a tombstone, so an add redelivered after the removal stays removed.
func (pr Projections) blockRemoved(ctx context.Context, m bus.Message) error {
	e, err := decode[property.BlockRemoved](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO property.rm_unit_blocks (id, unit_id, villa_id, location_id, from_date, to_date, reason, note, removed, version)
		VALUES ($1, $2, '', '', '', '', '', '', true, $3)
		ON CONFLICT (id) DO UPDATE SET removed = true, version = EXCLUDED.version`, e.ID, e.UnitID, m.AggregateVersion)
	return err
}
