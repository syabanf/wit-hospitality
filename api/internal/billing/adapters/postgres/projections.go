package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// Consumers.
const (
	// ConsumerCatalog keeps billing's copy of the units, villas and locations.
	ConsumerCatalog = "billing.catalog"
	// ConsumerReservation keeps billing's copy of the bookings and groups and reacts to check-outs.
	ConsumerReservation = "billing.reservation"
	// ConsumerServices keeps billing's copy of the orders that reached the bill and reacts to voids.
	ConsumerServices = "billing.services"
	// ConsumerGuest follows guest merges on the payments' payer and the copies.
	ConsumerGuest = "billing.guest"
	// ConsumerChannel keeps billing's copy of the Airbnb accounts the e-invoice names.
	ConsumerChannel = "billing.channel"
)

// Projections applies other contexts' events to billing's copies. Every upsert keeps a row that
// holds a newer version, so a late redelivery cannot roll it back.
type Projections struct {
	DB *db.DB
	// CheckedOut publishes stay.checked_out once reservation checks a stay out.
	CheckedOut func(ctx context.Context, b domain.Booking) error
	// Voided publishes folio_line.voided for an order services voided, as it stood delivered.
	Voided func(ctx context.Context, o domain.Order, reason, date string) error
}

// Register adds the handlers to p.
func (pr Projections) Register(p *projector.Projector) {
	cat := func(eventType string, h projector.Handler) { p.On(ConsumerCatalog, eventType, h) }
	cat(property.EventLocationCreated, pr.location)
	cat(property.EventLocationUpdated, pr.location)
	cat(property.EventVillaCreated, pr.villa)
	cat(property.EventVillaUpdated, pr.villa)
	cat(property.EventUnitCreated, pr.unit)
	cat(property.EventUnitUpdated, pr.unit)
	cat(property.EventGroupCreated, pr.roomType)
	cat(property.EventGroupUpdated, pr.roomType)
	p.On(ConsumerChannel, channel.EventAccountCreated, pr.account)
	p.On(ConsumerChannel, channel.EventAccountUpdated, pr.account)
	p.On(ConsumerReservation, reservation.EventBookingSaved, pr.booking)
	p.On(ConsumerReservation, reservation.EventBookingStatusChanged, pr.statusChanged)
	p.On(ConsumerReservation, reservation.EventGroupSaved, pr.group)
	p.On(ConsumerGuest, guest.EventGuestMerged, pr.guestMerged)
	p.On(ConsumerServices, services.EventOrderDelivered, pr.delivered)
	p.On(ConsumerServices, services.EventOrderVoided, pr.voided)
	p.On(ConsumerServices, services.EventRequestSaved, pr.request)
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
		INSERT INTO billing.cat_locations (id, name, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version
		WHERE billing.cat_locations.version < EXCLUDED.version`, e.Location.ID, e.Location.Name, m.AggregateVersion)
	return err
}

func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	e, err := decode[property.VillaEvent](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.cat_villas (id, location_id, name, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, version = EXCLUDED.version
		WHERE billing.cat_villas.version < EXCLUDED.version`, e.Villa.ID, e.Villa.LocationID, e.Villa.Name, m.AggregateVersion)
	return err
}

// unit keeps a unit. A row at the same version without a room type was written before
// 00003_invoice_names added group_id, so a replay of that version fills it in.
func (pr Projections) unit(ctx context.Context, m bus.Message) error {
	e, err := decode[property.UnitEvent](m)
	if err != nil {
		return err
	}
	u := e.Unit
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.cat_units (id, villa_id, group_id, code, name, version) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, group_id = EXCLUDED.group_id, code = EXCLUDED.code, name = EXCLUDED.name,
			version = EXCLUDED.version
		WHERE billing.cat_units.version < EXCLUDED.version
			OR (billing.cat_units.version = EXCLUDED.version AND billing.cat_units.group_id IS NULL AND EXCLUDED.group_id IS NOT NULL)`,
		u.ID, u.VillaID, u.GroupID, u.Code, u.Name, m.AggregateVersion)
	return err
}

// roomType keeps a room type, which an invoice prints for a stay with no room yet.
func (pr Projections) roomType(ctx context.Context, m bus.Message) error {
	e, err := decode[property.GroupEvent](m)
	if err != nil {
		return err
	}
	doc, err := json.Marshal(e.Group)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.cat_groups (id, doc, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = EXCLUDED.version
		WHERE billing.cat_groups.version < EXCLUDED.version`, e.Group.ID, doc, m.AggregateVersion)
	return err
}

// account keeps an Airbnb account, whose name an invoice prints as the stay's source.
func (pr Projections) account(ctx context.Context, m bus.Message) error {
	e, err := decode[channel.AccountEvent](m)
	if err != nil {
		return err
	}
	doc, err := json.Marshal(e.Account)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.cat_accounts (id, doc, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = EXCLUDED.version
		WHERE billing.cat_accounts.version < EXCLUDED.version`, e.Account.ID, doc, m.AggregateVersion)
	return err
}

// request keeps a service request, whose charge an invoice prints.
func (pr Projections) request(ctx context.Context, m bus.Message) error {
	e, err := decode[services.RequestSaved](m)
	if err != nil {
		return err
	}
	r, err := decodeRaw[domain.Request](e.Request)
	if err != nil {
		return err
	}
	var booking *string
	if r.BookingID != "" {
		booking = &r.BookingID
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.rm_requests (id, booking_id, doc, version) VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO UPDATE SET booking_id = EXCLUDED.booking_id, doc = EXCLUDED.doc, version = EXCLUDED.version
		WHERE billing.rm_requests.version <= EXCLUDED.version`, r.ID, booking, []byte(e.Request), m.AggregateVersion)
	return err
}

// stay keeps billing's copy of a booking from a reservation.Record.
func (pr Projections) stay(ctx context.Context, r reservation.Record, version int64) (domain.Booking, error) {
	b, err := decodeRaw[domain.Booking](r.Data)
	if err != nil {
		return b, err
	}
	villa, location := first(r.VillaIDs), first(r.LocationIDs)
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.rm_stays (id, code, unit_id, villa_id, location_id, group_id, status, doc, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, unit_id = EXCLUDED.unit_id, villa_id = EXCLUDED.villa_id, location_id = EXCLUDED.location_id,
			group_id = EXCLUDED.group_id, status = EXCLUDED.status, doc = EXCLUDED.doc, version = EXCLUDED.version
		WHERE billing.rm_stays.version <= EXCLUDED.version`, b.ID, b.Code, b.UnitID, villa, location, b.BookingGroupID, b.Status, []byte(r.Data), version)
	return b, err
}

func (pr Projections) booking(ctx context.Context, m bus.Message) error {
	r, err := decode[reservation.Record](m)
	if err != nil {
		return err
	}
	_, err = pr.stay(ctx, r, m.AggregateVersion)
	return err
}

// statusChanged keeps the copy and, on a check-out, publishes the departure for finance.
func (pr Projections) statusChanged(ctx context.Context, m bus.Message) error {
	e, err := decode[reservation.StatusChanged](m)
	if err != nil {
		return err
	}
	b, err := pr.stay(ctx, e.Record, m.AggregateVersion)
	if err != nil || e.To != domain.CheckedOut || pr.CheckedOut == nil {
		return err
	}
	return pr.CheckedOut(ctx, b)
}

func (pr Projections) group(ctx context.Context, m bus.Message) error {
	r, err := decode[reservation.Record](m)
	if err != nil {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.rm_groups (id, doc, version) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = EXCLUDED.version
		WHERE billing.rm_groups.version <= EXCLUDED.version`, r.ID, []byte(r.Data), m.AggregateVersion)
	return err
}

// guestMerged moves the dropped profile's stays and groups to the kept one in billing's copies;
// reservation republishes them too, so this only closes the gap until it does.
func (pr Projections) guestMerged(ctx context.Context, m bus.Message) error {
	e, err := decode[guest.GuestMerged](m)
	if err != nil {
		return err
	}
	q := pr.DB.Q(ctx)
	if _, err := q.Exec(ctx, `UPDATE billing.rm_stays SET doc = jsonb_set(doc, '{guestId}', to_jsonb($1::text)) WHERE doc->>'guestId' = $2`, e.KeepID, e.DropID); err != nil {
		return err
	}
	_, err = q.Exec(ctx, `UPDATE billing.rm_groups SET doc = jsonb_set(doc, '{leadGuestId}', to_jsonb($1::text)) WHERE doc->>'leadGuestId' = $2`, e.KeepID, e.DropID)
	return err
}

func decodeRaw[T any](raw json.RawMessage) (T, error) {
	var v T
	err := json.Unmarshal(raw, &v)
	return v, err
}

func first(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return list[0]
}

// delivered puts a delivered order on the bill.
func (pr Projections) delivered(ctx context.Context, m bus.Message) error {
	e, err := decode[services.OrderBilled](m)
	if err != nil {
		return err
	}
	return Orders{DB: pr.DB}.PutOrder(ctx, orderOf(e, "delivered"))
}

// voided takes a voided order off the bill, publishing the lines it carried first.
func (pr Projections) voided(ctx context.Context, m bus.Message) error {
	e, err := decode[services.OrderBilled](m)
	if err != nil {
		return err
	}
	orders := Orders{DB: pr.DB}
	o, ok, err := orders.Order(ctx, e.OrderID)
	if err != nil {
		return err
	}
	if !ok {
		o = orderOf(e, "delivered")
	}
	if o.Status != "voided" && pr.Voided != nil {
		if err := pr.Voided(ctx, o, e.Reason, e.On); err != nil {
			return err
		}
	}
	o.Status = "voided"
	return orders.PutOrder(ctx, o)
}
