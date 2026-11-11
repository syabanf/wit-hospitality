package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// Consumer names.
const (
	ConsumerCatalog  = "inventory.catalog"
	ConsumerCashOuts = "inventory.cash-outs"
	ConsumerSales    = "inventory.minibar-sales"
)

// Projections keeps the property and menu references and the cash-out statuses. Upserts keep a
// row that already holds a newer version.
type Projections struct{ DB *db.DB }

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	p.On(ConsumerCatalog, property.EventVillaCreated, pr.villa)
	p.On(ConsumerCatalog, property.EventVillaUpdated, pr.villa)
	p.On(ConsumerCatalog, property.EventGroupCreated, pr.group)
	p.On(ConsumerCatalog, property.EventGroupUpdated, pr.group)
	p.On(ConsumerCatalog, property.EventUnitCreated, pr.unit)
	p.On(ConsumerCatalog, property.EventUnitUpdated, pr.unit)
	p.On(ConsumerCatalog, services.EventMenuItemSaved, pr.menuItem)
	p.On(ConsumerCatalog, reservation.EventBookingSaved, pr.stay)
	p.On(ConsumerCatalog, reservation.EventBookingStatusChanged, pr.stay)
	p.On(ConsumerCashOuts, inventory.EventCashOutDecided, pr.decided)
}

// Decode reads an event payload.
func Decode[T any](m bus.Message) (T, error) {
	var v T
	err := json.Unmarshal(m.Payload, &v)
	return v, err
}

func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	e, err := Decode[property.VillaEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO inventory.ref_villas (id, location_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE inventory.ref_villas.version < EXCLUDED.version`, e.Villa.ID, e.Villa.LocationID, e.Villa.Name, m.AggregateVersion)
	return err
}

func (pr Projections) group(ctx context.Context, m bus.Message) error {
	e, err := Decode[property.GroupEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO inventory.ref_groups (id, villa_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE inventory.ref_groups.version < EXCLUDED.version`, e.Group.ID, e.Group.VillaID, e.Group.Name, m.AggregateVersion)
	return err
}

func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := Decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO inventory.ref_units (id, villa_id, group_id, code, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, group_id = EXCLUDED.group_id, code = EXCLUDED.code, version = EXCLUDED.version
		WHERE inventory.ref_units.version < EXCLUDED.version`, e.Unit.ID, e.Unit.VillaID, e.Unit.GroupID, e.Unit.Code, m.AggregateVersion)
	return err
}

func (pr Projections) menuItem(ctx context.Context, m bus.Message) error {
	e, err := Decode[services.MenuItemSaved](m)
	if err != nil {
		return err
	}
	var item inventory.MenuItem
	if err := json.Unmarshal(e.Item, &item); err != nil {
		return err
	}
	return UpsertMenuItem(ctx, pr.DB, item, m.AggregateVersion)
}

// UpsertMenuItem stores a menu item reference unless a newer version is already there.
func UpsertMenuItem(ctx context.Context, d *db.DB, i inventory.MenuItem, version int64) error {
	_, err := d.Q(ctx).Exec(ctx, `
		INSERT INTO inventory.ref_menu_items (id, villa_id, category, name, unit, price, active, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, category = EXCLUDED.category, name = EXCLUDED.name, unit = EXCLUDED.unit,
			price = EXCLUDED.price, active = EXCLUDED.active, version = EXCLUDED.version
		WHERE inventory.ref_menu_items.version < EXCLUDED.version`, i.ID, i.VillaID, i.Category, i.Name, i.Unit, i.Price, i.Active, version)
	return err
}

// stay keeps the booking's code, status and unit. A status change carries the version of the save
// it follows, so an equal version still applies.
func (pr Projections) stay(ctx context.Context, m bus.Message) error {
	r, err := Decode[reservation.Record](m)
	if err != nil {
		return err
	}
	var b struct {
		Code   string `json:"code"`
		Status string `json:"status"`
		UnitID string `json:"unitId"`
	}
	if err := json.Unmarshal(r.Data, &b); err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO inventory.ref_stays (id, code, status, unit_id, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, status = EXCLUDED.status, unit_id = EXCLUDED.unit_id, version = EXCLUDED.version
		WHERE inventory.ref_stays.version <= EXCLUDED.version`, r.ID, b.Code, b.Status, b.UnitID, m.AggregateVersion)
	return err
}

func (pr Projections) decided(ctx context.Context, m bus.Message) error {
	e, err := Decode[inventory.CashOutDecided](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		UPDATE inventory.cash_outs SET status = $2, finance_version = $3, version = version + 1
		WHERE id = $1 AND finance_version < $3`, e.TransactionID, e.Status, e.Version)
	return err
}
