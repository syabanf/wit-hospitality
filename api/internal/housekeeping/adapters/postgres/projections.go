package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// Consumers.
const (
	// ConsumerCatalog keeps housekeeping's copy of villas, room types and units.
	ConsumerCatalog = "housekeeping.catalog"
	// ConsumerReservation keeps the stays and turns a checked-out room dirty.
	ConsumerReservation = "housekeeping.reservation"
)

// CheckOutDesk names the board's updater after a check-out; the event carries no actor.
const CheckOutDesk = "Front desk"

// Projections applies other contexts' events. Upserts keep a row that already holds a newer
// version, so a late redelivery cannot roll it back.
type Projections struct {
	DB *db.DB
	// CheckedOut marks the unit dirty after a stay checks out; nil skips the reaction (seed).
	CheckedOut func(ctx context.Context, unitID, code, by string) error
}

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	cat := func(eventType string, h projector.Handler) { p.On(ConsumerCatalog, eventType, h) }
	cat(property.EventVillaCreated, pr.villa)
	cat(property.EventVillaUpdated, pr.villa)
	cat(property.EventGroupCreated, pr.group)
	cat(property.EventGroupUpdated, pr.group)
	cat(property.EventUnitCreated, pr.unit)
	cat(property.EventUnitUpdated, pr.unit)
	p.On(ConsumerReservation, reservation.EventBookingSaved, pr.stay)
	p.On(ConsumerReservation, reservation.EventBookingStatusChanged, pr.statusChanged)
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
		INSERT INTO housekeeping.cat_villas (id, location_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE housekeeping.cat_villas.version < EXCLUDED.version`, e.Villa.ID, e.Villa.LocationID, e.Villa.Name, m.AggregateVersion)
	return err
}

func (pr Projections) group(ctx context.Context, m bus.Message) error {
	e, err := decode[property.GroupEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.cat_unit_groups (id, villa_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE housekeeping.cat_unit_groups.version < EXCLUDED.version`, e.Group.ID, e.Group.VillaID, e.Group.Name, m.AggregateVersion)
	return err
}

func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	u := e.Unit
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.cat_units (id, villa_id, group_id, code, status, version) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, group_id = EXCLUDED.group_id, code = EXCLUDED.code, status = EXCLUDED.status, version = EXCLUDED.version
		WHERE housekeeping.cat_units.version < EXCLUDED.version`, u.ID, u.VillaID, u.GroupID, u.Code, u.Status, m.AggregateVersion)
	return err
}

// bookingFacts is the part of a Booking housekeeping keeps.
type bookingFacts struct {
	ID           string `json:"id"`
	Code         string `json:"code"`
	UnitID       string `json:"unitId"`
	UnitAssigned bool   `json:"unitAssigned"`
	Status       string `json:"status"`
	CheckIn      string `json:"checkIn"`
	CheckOut     string `json:"checkOut"`
}

func (pr Projections) upsertStay(ctx context.Context, r reservation.Record, version int64) (bookingFacts, error) {
	var b bookingFacts
	if err := json.Unmarshal(r.Data, &b); err != nil {
		return b, err
	}
	_, err := pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.stays (id, code, unit_id, unit_assigned, status, check_in, check_out, version) VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8)
		ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, unit_id = EXCLUDED.unit_id, unit_assigned = EXCLUDED.unit_assigned, status = EXCLUDED.status,
			check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out, version = EXCLUDED.version
		WHERE housekeeping.stays.version < EXCLUDED.version`, b.ID, b.Code, b.UnitID, b.UnitAssigned, b.Status, b.CheckIn, b.CheckOut, version)
	return b, err
}

func (pr Projections) stay(ctx context.Context, m bus.Message) error {
	r, err := decode[reservation.Record](m)
	if err != nil {
		return err
	}
	_, err = pr.upsertStay(ctx, r, m.AggregateVersion)
	return err
}

func (pr Projections) statusChanged(ctx context.Context, m bus.Message) error {
	e, err := decode[reservation.StatusChanged](m)
	if err != nil {
		return err
	}
	b, err := pr.upsertStay(ctx, e.Record, m.AggregateVersion)
	if err != nil || e.To != "checked_out" || pr.CheckedOut == nil {
		return err
	}
	return pr.CheckedOut(ctx, b.UnitID, b.Code, CheckOutDesk)
}
