package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// Consumers.
const (
	// ConsumerCatalog keeps owners' copy of villas, units, blocks and Airbnb accounts.
	ConsumerCatalog = "owners.catalog"
	// ConsumerStays keeps owners' copy of reservation's bookings.
	ConsumerStays = "owners.stays"
)

// Projections keeps the cat_* and rm_stays tables. Every upsert keeps a row that holds a newer
// version, so a late redelivery cannot roll it back.
type Projections struct{ DB *db.DB }

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	on := func(eventType string, h projector.Handler) { p.On(ConsumerCatalog, eventType, h) }
	on(property.EventLocationCreated, pr.location)
	on(property.EventLocationUpdated, pr.location)
	on(property.EventVillaCreated, pr.villa)
	on(property.EventVillaUpdated, pr.villa)
	on(property.EventUnitCreated, pr.unit)
	on(property.EventUnitUpdated, pr.unit)
	on(property.EventBlockAdded, pr.blockAdded)
	on(property.EventBlockRemoved, pr.blockRemoved)
	on(channel.EventAccountCreated, pr.account)
	on(channel.EventAccountUpdated, pr.account)
	p.On(ConsumerStays, reservation.EventBookingSaved, pr.stay)
	p.On(ConsumerStays, reservation.EventBookingStatusChanged, pr.stay)
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
		INSERT INTO owners.cat_locations (id, name, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version
		WHERE owners.cat_locations.version < EXCLUDED.version`, e.Location.ID, e.Location.Name, m.AggregateVersion)
	return err
}

func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	e, err := decode[property.VillaEvent](m)
	if err != nil {
		return err
	}
	v := e.Villa
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO owners.cat_villas (id, location_id, code, name, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, code = EXCLUDED.code, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE owners.cat_villas.version < EXCLUDED.version`, v.ID, v.LocationID, v.Code, v.Name, m.AggregateVersion)
	return err
}

func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	u := e.Unit
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO owners.cat_units (id, villa_id, code, status, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, code = EXCLUDED.code, status = EXCLUDED.status, version = EXCLUDED.version
		WHERE owners.cat_units.version < EXCLUDED.version`, u.ID, u.VillaID, u.Code, u.Status, m.AggregateVersion)
	return err
}

func (pr Projections) blockAdded(ctx context.Context, m bus.Message) error {
	e, err := decode[property.BlockAdded](m)
	if err != nil {
		return err
	}
	b := e.Block
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO owners.cat_blocks (id, unit_id, from_date, to_date, reason, version) VALUES ($1, $2, $3, $4, $5, $6)
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
		INSERT INTO owners.cat_blocks (id, unit_id, from_date, to_date, reason, removed, version) VALUES ($1, $2, '', '', '', true, $3)
		ON CONFLICT (id) DO UPDATE SET removed = true, version = EXCLUDED.version`, e.ID, e.UnitID, m.AggregateVersion)
	return err
}

func (pr Projections) account(ctx context.Context, m bus.Message) error {
	e, err := decode[channel.AccountEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO owners.cat_accounts (id, name, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version
		WHERE owners.cat_accounts.version < EXCLUDED.version`, e.Account.ID, e.Account.Name, m.AggregateVersion)
	return err
}

func (pr Projections) stay(ctx context.Context, m bus.Message) error {
	r, err := decode[reservation.Record](m)
	if err != nil {
		return err
	}
	var b struct {
		UnitID string `json:"unitId"`
	}
	if err := json.Unmarshal(r.Data, &b); err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO owners.rm_stays (id, unit_id, doc, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET unit_id = EXCLUDED.unit_id, doc = EXCLUDED.doc, version = EXCLUDED.version
		WHERE owners.rm_stays.version < EXCLUDED.version`, r.ID, b.UnitID, []byte(r.Data), m.AggregateVersion)
	return err
}
