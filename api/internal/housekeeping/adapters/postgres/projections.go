package postgres

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
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
	// ConsumerCashOuts keeps finance's answer on the laundry bills.
	ConsumerCashOuts = "housekeeping.cash-outs"
	// ConsumerNightAudit plans the business date billing's night audit opens.
	ConsumerNightAudit = "housekeeping.night-audit"
)

// CheckOutDesk names the board's updater after a check-out; the event carries no actor.
const CheckOutDesk = "Front desk"

// Projections applies other contexts' events: the catalog, the stays, the people and finance's
// answers on laundry bills. Upserts keep a row that already holds a newer version, so a late
// redelivery cannot roll it back.
type Projections struct {
	DB *db.DB
	// CheckedOut marks the unit dirty after a stay checks out; nil skips the reaction (seed).
	CheckedOut func(ctx context.Context, unitID, code, by string) error
	// Audited plans the business date a night audit opened; nil skips the reaction (seed).
	Audited func(ctx context.Context, date string) error
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
	pr.registerPeople(p)
	p.On(ConsumerReservation, reservation.EventBookingSaved, pr.stay)
	p.On(ConsumerReservation, reservation.EventBookingStatusChanged, pr.statusChanged)
	p.On(ConsumerCashOuts, housekeeping.EventCashOutDecided, pr.decided)
	if pr.Audited != nil {
		p.On(ConsumerNightAudit, billing.EventNightAudited, pr.audited)
	}
}

// decided puts finance's answer on the laundry batch its cash-out pays; other sources are ignored.
func (pr Projections) decided(ctx context.Context, m bus.Message) error {
	e, err := decode[housekeeping.CashOutDecided](m)
	if err != nil || e.SourceType != housekeeping.SourceLaundry {
		return err
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		UPDATE housekeeping.laundry_batches
		SET doc = doc || jsonb_build_object('transactionId', $2::text, 'transactionStatus', $3::text, 'rejectionReason', NULLIF($4::text, '')),
			finance_version = $5, version = version + 1
		WHERE id = $1 AND finance_version < $5`, e.SourceID, e.TransactionID, e.Status, e.RejectionReason, e.Version)
	return err
}

// audited plans the business date the night audit opened.
func (pr Projections) audited(ctx context.Context, m bus.Message) error {
	e, err := decode[billing.NightAudited](m)
	if err != nil {
		return err
	}
	return pr.Audited(ctx, e.NextBusinessDate)
}

func decode[T any](m bus.Message) (T, error) {
	var v T
	err := json.Unmarshal(m.Payload, &v)
	return v, err
}

// villa keeps a villa and how it operates. An event from before villas had an operation leaves it
// NULL (read as a villa without stayovers); a replay of the same version from the snapshot
// catch-up fills it in.
func (pr Projections) villa(ctx context.Context, m bus.Message) error {
	e, err := decode[property.VillaEvent](m)
	if err != nil {
		return err
	}
	v := e.Villa
	var operation *string
	var every *int
	if v.Operation != "" {
		operation, every = &v.Operation, &v.StayoverEvery
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.cat_villas (id, location_id, name, operation, stayover_every, version) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, name = EXCLUDED.name, operation = EXCLUDED.operation,
			stayover_every = EXCLUDED.stayover_every, version = EXCLUDED.version
		WHERE housekeeping.cat_villas.version < EXCLUDED.version
			OR (housekeeping.cat_villas.version = EXCLUDED.version AND housekeeping.cat_villas.operation IS NULL AND EXCLUDED.operation IS NOT NULL)`,
		v.ID, v.LocationID, v.Name, operation, every, m.AggregateVersion)
	return err
}

// group keeps a room type and its kind; like villa, an event without a kind leaves it NULL (villa)
// until a replay of the same version fills it in.
func (pr Projections) group(ctx context.Context, m bus.Message) error {
	e, err := decode[property.GroupEvent](m)
	if err != nil {
		return err
	}
	var kind *string
	if e.Group.Kind != "" {
		kind = &e.Group.Kind
	}
	_, err = pr.DB.Q(ctx).Exec(ctx, `
		INSERT INTO housekeeping.cat_unit_groups (id, villa_id, name, kind, version) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET villa_id = EXCLUDED.villa_id, name = EXCLUDED.name, kind = EXCLUDED.kind, version = EXCLUDED.version
		WHERE housekeeping.cat_unit_groups.version < EXCLUDED.version
			OR (housekeeping.cat_unit_groups.version = EXCLUDED.version AND housekeeping.cat_unit_groups.kind IS NULL AND EXCLUDED.kind IS NOT NULL)`,
		e.Group.ID, e.Group.VillaID, e.Group.Name, kind, m.AggregateVersion)
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

// bookingFacts is the part of a Booking housekeeping keeps. ServiceWindow is nil on an event from
// before stays had one.
type bookingFacts struct {
	ID            string                `json:"id"`
	Code          string                `json:"code"`
	UnitID        string                `json:"unitId"`
	UnitAssigned  bool                  `json:"unitAssigned"`
	Status        string                `json:"status"`
	CheckIn       string                `json:"checkIn"`
	CheckOut      string                `json:"checkOut"`
	ServiceWindow *domain.ServiceWindow `json:"serviceWindow"`
}

// upsertStay keeps the stay. A row at the same version without a window was written before
// 00005_service_window, so a replay of that version from the snapshot catch-up fills it in. A new
// window goes onto the stay's open tasks that serve the guest in house.
func (pr Projections) upsertStay(ctx context.Context, r reservation.Record, version int64) (bookingFacts, error) {
	var b bookingFacts
	if err := json.Unmarshal(r.Data, &b); err != nil {
		return b, err
	}
	q := pr.DB.Q(ctx)
	tag, err := q.Exec(ctx, `
		INSERT INTO housekeeping.stays (id, code, unit_id, unit_assigned, status, check_in, check_out, service_window, version)
		VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9)
		ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, unit_id = EXCLUDED.unit_id, unit_assigned = EXCLUDED.unit_assigned, status = EXCLUDED.status,
			check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out, service_window = EXCLUDED.service_window, version = EXCLUDED.version
		WHERE housekeeping.stays.version < EXCLUDED.version
			OR (housekeeping.stays.version = EXCLUDED.version AND housekeeping.stays.service_window IS NULL AND EXCLUDED.service_window IS NOT NULL)`,
		b.ID, b.Code, b.UnitID, b.UnitAssigned, b.Status, b.CheckIn, b.CheckOut, b.ServiceWindow, version)
	if err != nil || tag.RowsAffected() == 0 || b.ServiceWindow == nil {
		return b, err
	}
	_, err = q.Exec(ctx, `
		UPDATE housekeeping.tasks SET doc = jsonb_set(doc, '{serviceWindow}', $2::jsonb), version = version + 1
		WHERE doc->>'bookingId' = $1 AND status IN ('pending', 'in_progress', 'paused') AND doc->>'type' <> 'departure'
			AND doc->'serviceWindow' IS DISTINCT FROM $2::jsonb`, b.ID, b.ServiceWindow)
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
