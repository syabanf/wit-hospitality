package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// Consumer names.
const (
	ConsumerCatalog  = "maintenance.catalog"
	ConsumerCashOuts = "maintenance.cash-outs"
)

// Projections keeps the property references and the cash-out statuses. Upserts keep a row that
// already holds a newer version, so a late redelivery cannot roll it back.
type Projections struct{ DB *db.DB }

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	p.On(ConsumerCatalog, property.EventVillaCreated, pr.villa)
	p.On(ConsumerCatalog, property.EventVillaUpdated, pr.villa)
	p.On(ConsumerCatalog, property.EventUnitCreated, pr.unit)
	p.On(ConsumerCatalog, property.EventUnitUpdated, pr.unit)
	p.On(ConsumerCashOuts, maintenance.EventCashOutDecided, pr.decided)
}

func decode[T any](m bus.Message) (T, error) {
	var v T
	err := json.Unmarshal(m.Payload, &v)
	return v, err
}

func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	e, err := decode[property.VillaEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO maintenance.ref_villas (id, location_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE maintenance.ref_villas.version < EXCLUDED.version`, e.Villa.ID, e.Villa.LocationID, e.Villa.Name, m.AggregateVersion)
	return err
}

func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO maintenance.ref_units (id, villa_id, code, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, code = EXCLUDED.code, version = EXCLUDED.version
		WHERE maintenance.ref_units.version < EXCLUDED.version`, e.Unit.ID, e.Unit.VillaID, e.Unit.Code, m.AggregateVersion)
	return err
}

// decided records finance's answer on a cash-out this context asked for; others are ignored.
func (pr Projections) decided(ctx context.Context, m bus.Message) error {
	e, err := decode[maintenance.CashOutDecided](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		UPDATE maintenance.cash_outs SET status = $2, finance_version = $3, version = version + 1
		WHERE id = $1 AND finance_version < $3`, e.TransactionID, e.Status, e.Version)
	return err
}
