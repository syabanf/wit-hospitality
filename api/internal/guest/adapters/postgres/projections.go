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

// ConsumerProperty keeps guest's copy of the villas, units and locations.
const ConsumerProperty = "guest.property"

// Projections applies other contexts' events to guest's rm_* tables. Every upsert keeps the row
// when it already holds a newer version, so a late redelivery cannot roll it back.
type Projections struct{ DB *db.DB }

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	on := func(eventType string, h projector.Handler) { p.On(ConsumerProperty, eventType, h) }
	on(property.EventLocationCreated, pr.location)
	on(property.EventLocationUpdated, pr.location)
	on(property.EventVillaCreated, pr.villa)
	on(property.EventVillaUpdated, pr.villa)
	on(property.EventUnitCreated, pr.unit)
	on(property.EventUnitUpdated, pr.unit)
	pr.RegisterReservation(p)
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
	l := e.Location
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO guest.rm_locations (id, name, area, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, area = EXCLUDED.area, version = EXCLUDED.version
		WHERE guest.rm_locations.version < EXCLUDED.version`, l.ID, l.Name, l.Area, m.AggregateVersion)
	return err
}

func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	e, err := decode[property.VillaEvent](m)
	if err != nil {
		return err
	}
	v := e.Villa
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO guest.rm_villas (id, location_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE guest.rm_villas.version < EXCLUDED.version`, v.ID, v.LocationID, v.Name, m.AggregateVersion)
	return err
}

func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	u := e.Unit
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO guest.rm_units (id, villa_id, code, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, code = EXCLUDED.code, version = EXCLUDED.version
		WHERE guest.rm_units.version < EXCLUDED.version`, u.ID, u.VillaID, u.Code, m.AggregateVersion)
	return err
}

// ConsumerReservation keeps guest's copy of booking facts and group leads from reservation events.
const ConsumerReservation = "guest.reservation"

// RegisterReservation adds the handlers for reservation's booking and group events.
func (pr Projections) RegisterReservation(p *projector.Projector) {
	p.On(ConsumerReservation, reservation.EventBookingSaved, pr.stay)
	p.On(ConsumerReservation, reservation.EventBookingStatusChanged, pr.stay)
	p.On(ConsumerReservation, reservation.EventGroupSaved, pr.groupLead)
}

// stay keeps rm_stays from the booking in the event: lead guest, unit, villa, status, dates,
// arrival time and adults (the arrival record first, then the party booked).
func (pr Projections) stay(ctx context.Context, m bus.Message) error {
	r, err := decode[reservation.Record](m)
	if err != nil {
		return err
	}
	var b struct {
		Code         string  `json:"code"`
		GuestID      string  `json:"guestId"`
		UnitID       string  `json:"unitId"`
		Status       string  `json:"status"`
		CheckIn      string  `json:"checkIn"`
		CheckOut     string  `json:"checkOut"`
		CheckedInOn  *string `json:"checkedInOn"`
		CheckedOutOn *string `json:"checkedOutOn"`
		Arrival      *struct {
			ArrivalTime string  `json:"arrivalTime"`
			Adults      float64 `json:"adults"`
		} `json:"arrival"`
		PartySize *struct {
			Adults int `json:"adults"`
		} `json:"partySize"`
	}
	if err := json.Unmarshal(r.Data, &b); err != nil {
		return err
	}
	arrival, villa := "", ""
	var adults *int
	if b.PartySize != nil {
		adults = &b.PartySize.Adults
	}
	if b.Arrival != nil {
		n := int(b.Arrival.Adults)
		arrival, adults = b.Arrival.ArrivalTime, &n
	}
	if len(r.VillaIDs) > 0 {
		villa = r.VillaIDs[0]
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO guest.rm_stays (`+stayColumns+`, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, guest_id = EXCLUDED.guest_id, unit_id = EXCLUDED.unit_id, villa_id = EXCLUDED.villa_id,
			status = EXCLUDED.status, check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out, checked_in_on = EXCLUDED.checked_in_on,
			checked_out_on = EXCLUDED.checked_out_on, arrival_time = EXCLUDED.arrival_time, adults = EXCLUDED.adults, version = EXCLUDED.version
		WHERE guest.rm_stays.version < EXCLUDED.version`,
		r.ID, b.Code, b.GuestID, b.UnitID, villa, b.Status, b.CheckIn, b.CheckOut, b.CheckedInOn, b.CheckedOutOn, arrival, adults, m.AggregateVersion)
	return err
}

// groupLead keeps rm_group_leads from the group in the event.
func (pr Projections) groupLead(ctx context.Context, m bus.Message) error {
	r, err := decode[reservation.Record](m)
	if err != nil {
		return err
	}
	var g struct {
		LeadGuestID string `json:"leadGuestId"`
	}
	if err := json.Unmarshal(r.Data, &g); err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO guest.rm_group_leads (id, lead_guest_id, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET lead_guest_id = EXCLUDED.lead_guest_id, version = EXCLUDED.version
		WHERE guest.rm_group_leads.version < EXCLUDED.version`, r.ID, g.LeadGuestID, m.AggregateVersion)
	return err
}
