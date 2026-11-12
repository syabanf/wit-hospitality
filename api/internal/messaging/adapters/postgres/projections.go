package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/messaging"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// Consumers.
const (
	ConsumerCatalog     = "messaging.catalog"
	ConsumerGuest       = "messaging.guest"
	ConsumerReservation = "messaging.reservation"
	ConsumerBilling     = "messaging.billing"
)

// Triggers are the reactions that queue messages; nil skips them (seed).
type Triggers interface {
	OnStatus(ctx context.Context, bookingID, status string) error
	OnLink(ctx context.Context, bookingID, token string, amount int64) error
	OnPaid(ctx context.Context, bookingID string, amount int64) error
}

// Projections keeps messaging's copies of the catalog, guests, stays and payment links, and runs
// the triggers. Upserts keep a row that already holds a newer version.
type Projections struct {
	DB       *db.DB
	Triggers Triggers
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
	p.On(ConsumerGuest, guest.EventGuestCreated, pr.guest)
	p.On(ConsumerGuest, guest.EventGuestUpdated, pr.guest)
	p.On(ConsumerGuest, guest.EventGuestMerged, pr.guestMerged)
	p.On(ConsumerReservation, reservation.EventBookingSaved, pr.bookingSaved)
	p.On(ConsumerReservation, reservation.EventBookingStatusChanged, pr.statusChanged)
	p.On(ConsumerBilling, messaging.EventPaymentLinkCreated, pr.linkCreated)
	p.On(ConsumerBilling, messaging.EventPaymentLinkUpdated, pr.linkUpdated)
	p.On(ConsumerBilling, billing.EventPaymentRecorded, pr.paid)
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
		INSERT INTO messaging.cat_villas (id, location_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE messaging.cat_villas.version < EXCLUDED.version`, e.Villa.ID, e.Villa.LocationID, e.Villa.Name, m.AggregateVersion)
	return err
}

func (pr Projections) group(ctx context.Context, m bus.Message) error {
	e, err := decode[property.GroupEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO messaging.cat_unit_groups (id, name, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version
		WHERE messaging.cat_unit_groups.version < EXCLUDED.version`, e.Group.ID, e.Group.Name, m.AggregateVersion)
	return err
}

func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	u := e.Unit
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO messaging.cat_units (id, villa_id, group_id, code, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, group_id = EXCLUDED.group_id, code = EXCLUDED.code, version = EXCLUDED.version
		WHERE messaging.cat_units.version < EXCLUDED.version`, u.ID, u.VillaID, u.GroupID, u.Code, m.AggregateVersion)
	return err
}

func (pr Projections) guest(ctx context.Context, m bus.Message) error {
	e, err := decode[guest.GuestEvent](m)
	if err != nil {
		return err
	}
	g := e.Guest
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO messaging.guests (id, name, email, phone, nationality, version) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, phone = EXCLUDED.phone, nationality = EXCLUDED.nationality, version = EXCLUDED.version
		WHERE messaging.guests.version < EXCLUDED.version`, g.ID, g.Name, g.Email, g.Phone, g.Nationality, m.AggregateVersion)
	return err
}

// guestMerged points the dropped profile's stays and messages at the kept one; running it twice
// finds nothing to move.
func (pr Projections) guestMerged(ctx context.Context, m bus.Message) error {
	e, err := decode[guest.GuestMerged](m)
	if err != nil {
		return err
	}
	q := pr.DB.Q(ctx)
	if _, err := q.Exec(ctx, `UPDATE messaging.stays SET guest_id = $1 WHERE guest_id = $2`, e.KeepID, e.DropID); err != nil {
		return err
	}
	_, err = q.Exec(ctx, `
		UPDATE messaging.messages SET guest_id = $1, doc = jsonb_set(doc, '{guestId}', to_jsonb($1::text)), version = version + 1
		WHERE guest_id = $2`, e.KeepID, e.DropID)
	return err
}

// stayFacts is the part of a Booking messaging keeps.
type stayFacts struct {
	ID             string `json:"id"`
	Code           string `json:"code"`
	GuestID        string `json:"guestId"`
	UnitID         string `json:"unitId"`
	UnitAssigned   bool   `json:"unitAssigned"`
	Status         string `json:"status"`
	CheckIn        string `json:"checkIn"`
	CheckOut       string `json:"checkOut"`
	BookingGroupID string `json:"bookingGroupId"`
}

// upsertStay saves the stay and reports whether this event created it.
func (pr Projections) upsertStay(ctx context.Context, r reservation.Record, version int64) (stayFacts, bool, error) {
	var b stayFacts
	if err := json.Unmarshal(r.Data, &b); err != nil {
		return b, false, err
	}
	var inserted bool
	err := pr.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO messaging.stays (id, code, guest_id, unit_id, unit_assigned, status, check_in, check_out, group_id, invoice_token, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11)
		ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, guest_id = EXCLUDED.guest_id, unit_id = EXCLUDED.unit_id, unit_assigned = EXCLUDED.unit_assigned,
			status = EXCLUDED.status, check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out, group_id = EXCLUDED.group_id, version = EXCLUDED.version
		WHERE messaging.stays.version < EXCLUDED.version
		RETURNING (xmax = 0)`, b.ID, b.Code, b.GuestID, b.UnitID, b.UnitAssigned, b.Status, b.CheckIn, b.CheckOut, b.BookingGroupID,
		domain.InvoiceToken(b.ID), version).Scan(&inserted)
	if db.NoRows(err) {
		return b, false, nil
	}
	return b, inserted, err
}

// bookingSaved keeps the stay; a booking created confirmed sends its confirmation, as the mock's
// create does.
func (pr Projections) bookingSaved(ctx context.Context, m bus.Message) error {
	r, err := decode[reservation.Record](m)
	if err != nil {
		return err
	}
	b, created, err := pr.upsertStay(ctx, r, m.AggregateVersion)
	if err != nil || !created || pr.Triggers == nil {
		return err
	}
	return pr.Triggers.OnStatus(ctx, b.ID, b.Status)
}

func (pr Projections) statusChanged(ctx context.Context, m bus.Message) error {
	e, err := decode[reservation.StatusChanged](m)
	if err != nil {
		return err
	}
	if _, _, err := pr.upsertStay(ctx, e.Record, m.AggregateVersion); err != nil || pr.Triggers == nil {
		return err
	}
	return pr.Triggers.OnStatus(ctx, e.ID, e.To)
}

func (pr Projections) upsertLink(ctx context.Context, l messaging.PaymentLink, version int64) error {
	_, err := pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO messaging.payment_links (token, booking_id, amount, status, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (token) DO UPDATE SET booking_id = EXCLUDED.booking_id, amount = EXCLUDED.amount, status = EXCLUDED.status, version = EXCLUDED.version
		WHERE messaging.payment_links.version < EXCLUDED.version`, l.Token, l.BookingID, l.Amount, l.Status, version)
	return err
}

func (pr Projections) linkCreated(ctx context.Context, m bus.Message) error {
	e, err := decode[messaging.PaymentLinkEvent](m)
	if err != nil {
		return err
	}
	if err := pr.upsertLink(ctx, e.Link, m.AggregateVersion); err != nil || pr.Triggers == nil || !e.Notify {
		return err
	}
	return pr.Triggers.OnLink(ctx, e.Link.BookingID, e.Link.Token, e.Link.Amount)
}

func (pr Projections) linkUpdated(ctx context.Context, m bus.Message) error {
	e, err := decode[messaging.PaymentLinkEvent](m)
	if err != nil {
		return err
	}
	return pr.upsertLink(ctx, e.Link, m.AggregateVersion)
}

func (pr Projections) paid(ctx context.Context, m bus.Message) error {
	e, err := decode[billing.PaymentRecorded](m)
	if err != nil || pr.Triggers == nil || e.BookingID == "" || e.Kind == "payout" {
		return err
	}
	return pr.Triggers.OnPaid(ctx, e.BookingID, e.Amount)
}
