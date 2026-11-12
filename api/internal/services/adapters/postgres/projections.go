package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// Consumers.
const (
	// ConsumerCatalog keeps services' copy of the property catalog from property events.
	ConsumerCatalog = "services.catalog"
	// ConsumerBilling marks orders paid from billing's payments.
	ConsumerBilling = "services.billing"
)

// Projections applies property events to the catalog copy and hands billing's payments to Paid.
// Every upsert keeps the row when it already holds a newer version, so a late redelivery cannot
// roll a row back.
type Projections struct {
	DB *db.DB
	// Paid marks the orders a payment settles paid.
	Paid func(ctx context.Context, e billing.PaymentRecorded) error
}

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	on := func(eventType string, h projector.Handler) { p.On(ConsumerCatalog, eventType, h) }
	on(property.EventLocationCreated, pr.location)
	on(property.EventLocationUpdated, pr.location)
	on(property.EventVillaCreated, pr.villa)
	on(property.EventVillaUpdated, pr.villa)
	on(property.EventUnitCreated, pr.unit)
	on(property.EventUnitUpdated, pr.unit)
	p.On(ConsumerBilling, billing.EventPaymentRecorded, pr.paid)
}

func (pr Projections) paid(ctx context.Context, m bus.Message) error {
	e, err := decode[billing.PaymentRecorded](m)
	if err != nil || len(e.OrderIDs) == 0 {
		return err
	}
	return pr.Paid(ctx, e)
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
		INSERT INTO services.cat_locations (id, name, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version
		WHERE services.cat_locations.version < EXCLUDED.version`, e.Location.ID, e.Location.Name, m.AggregateVersion)
	return err
}

func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	e, err := decode[property.VillaEvent](m)
	if err != nil {
		return err
	}
	v := e.Villa
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO services.cat_villas (id, location_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE services.cat_villas.version < EXCLUDED.version`, v.ID, v.LocationID, v.Name, m.AggregateVersion)
	return err
}

func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	u := e.Unit
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO services.cat_units (id, villa_id, code, name, status, version) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, code = EXCLUDED.code, name = EXCLUDED.name,
			status = EXCLUDED.status, version = EXCLUDED.version
		WHERE services.cat_units.version < EXCLUDED.version`, u.ID, u.VillaID, u.Code, u.Name, u.Status, m.AggregateVersion)
	return err
}
