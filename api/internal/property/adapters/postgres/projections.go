package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
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
	on(property.EventBlockTrimmed, pr.blockTrimmed)
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
		INSERT INTO property.rm_villas (`+villaColumns+`, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, code = EXCLUDED.code, name = EXCLUDED.name,
			description = EXCLUDED.description, facilities = EXCLUDED.facilities, address = EXCLUDED.address, lat = EXCLUDED.lat,
			lng = EXCLUDED.lng, phone = EXCLUDED.phone, email = EXCLUDED.email, check_in_time = EXCLUDED.check_in_time,
			check_out_time = EXCLUDED.check_out_time, license_no = EXCLUDED.license_no, bank_name = EXCLUDED.bank_name,
			bank_account_no = EXCLUDED.bank_account_no, bank_account_name = EXCLUDED.bank_account_name, house_rules = EXCLUDED.house_rules,
			cancellation_policy = EXCLUDED.cancellation_policy, deposit_kind = EXCLUDED.deposit_kind, deposit_value = EXCLUDED.deposit_value,
			photos = EXCLUDED.photos, version = EXCLUDED.version
		WHERE property.rm_villas.version < EXCLUDED.version`, append(villaValues(domain.VillaOf(v)), m.AggregateVersion)...)
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
		INSERT INTO property.rm_units (`+unitColumns+`, status_until, version, location_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, location_id = EXCLUDED.location_id, group_id = EXCLUDED.group_id,
			code = EXCLUDED.code, name = EXCLUDED.name, bedrooms = EXCLUDED.bedrooms, nightly_rate = EXCLUDED.nightly_rate,
			status = EXCLUDED.status, amenities = EXCLUDED.amenities, max_adults = EXCLUDED.max_adults, max_children = EXCLUDED.max_children,
			beds = EXCLUDED.beds, size_sqm = EXCLUDED.size_sqm, view = EXCLUDED.view, extra_beds = EXCLUDED.extra_beds,
			extra_bed_rate = EXCLUDED.extra_bed_rate, photos = EXCLUDED.photos, status_reason = EXCLUDED.status_reason,
			status_until = EXCLUDED.status_until, version = EXCLUDED.version
		WHERE property.rm_units.version < EXCLUDED.version`,
		append(unitValues(domain.UnitOf(u)), m.AggregateVersion, e.LocationID)...)

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

// blockTrimmed moves the end of a block that is still there.
func (pr Projections) blockTrimmed(ctx context.Context, m bus.Message) error {
	e, err := decode[property.BlockAdded](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		UPDATE property.rm_unit_blocks SET to_date = $2, version = $3 WHERE id = $1 AND NOT removed AND version < $3`,
		e.Block.ID, e.Block.To, m.AggregateVersion)
	return err
}
