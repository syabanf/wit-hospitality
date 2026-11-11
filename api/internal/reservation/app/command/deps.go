// Package command holds the reservation context's write side: one handler per command. Each
// handler checks the permission and villa scope, loads with a row lock, applies the domain rules,
// saves with a version check, and appends its events and audit line in one transaction.
package command

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// Repository is the write model on the reservation schema. Loads lock the row for the transaction.
type Repository interface {
	// LockAvailability serialises commands that read and change what holds the units.
	LockAvailability(ctx context.Context) error
	Next(ctx context.Context, key string) (int64, error)

	Booking(ctx context.Context, id string) (domain.Booking, error)
	BookingByToken(ctx context.Context, token string) (domain.Booking, error)
	InsertBooking(ctx context.Context, b *domain.Booking) error
	UpdateBooking(ctx context.Context, b *domain.Booking) error
	// Holdings lists the confirmed and checked-in stays that overlap [from, to).
	Holdings(ctx context.Context, from, to string) ([]domain.Holding, error)
	GroupStays(ctx context.Context, groupID string) ([]domain.Booking, error)

	Group(ctx context.Context, id string) (domain.BookingGroup, error)
	InsertGroup(ctx context.Context, g *domain.BookingGroup) error
	UpdateGroup(ctx context.Context, g *domain.BookingGroup) error

	Restrictions(ctx context.Context) ([]domain.Restriction, error)
	Restriction(ctx context.Context, id string) (domain.Restriction, error)
	InsertRestriction(ctx context.Context, r *domain.Restriction) error
	UpdateRestriction(ctx context.Context, r *domain.Restriction) error
	DeleteRestriction(ctx context.Context, id string) error

	Policies(ctx context.Context) ([]domain.OverbookPolicy, error)
	// SetPolicy saves the limit and returns the policy's new version.
	SetPolicy(ctx context.Context, p domain.OverbookPolicy) (int64, error)

	InsertWalk(ctx context.Context, w domain.Walk) error

	PreCheckIn(ctx context.Context, bookingID string) (*domain.PreCheckIn, error)
	SavePreCheckIn(ctx context.Context, p *domain.PreCheckIn) error
}

// Catalog reads reservation's copy of the property catalog.
type Catalog interface {
	Catalog(ctx context.Context) (domain.Catalog, error)
}

// Deps is what every reservation command needs.
type Deps struct {
	DB       *db.DB
	Repo     Repository
	Catalog  Catalog
	Clients  Clients
	Authz    rbac.Authorizer
	Audit    audit.Recorder
	Clock    clock.Clock
	Settings Settings
}

// Permission sets the commands check, taken from the application services' allow() calls. The
// services check nothing before a lifecycle step, a move, new dates, notes or the payment summary;
// the API asks booking/edit there so a portal-only or read-only role cannot change a stay.
var (
	bookingCreate  = []rbac.Need{{Module: "booking", Action: "create"}}
	bookingEdit    = []rbac.Need{{Module: "booking", Action: "edit"}}
	propertyEdit   = []rbac.Need{{Module: "property", Action: "edit"}}
	paymentsCreate = []rbac.Need{{Module: "payments", Action: "create"}}
)

func actorOf(p auth.Principal) audit.Actor {
	return audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}
}

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, actorOf(p), l)
}

func (d Deps) today() string { return clock.Today(d.Clock) }

func (d Deps) stamp() string { return clock.Stamp(d.Clock) }

func (d Deps) emit(ctx context.Context, eventType, aggregateType, aggregateID string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: aggregateID, AggregateVersion: version, Payload: payload})
}

// place is where a unit sits.
type place struct {
	unit     domain.Unit
	villa    domain.Villa
	group    domain.UnitGroup
	hasGroup bool
}

func placeOf(c domain.Catalog, unitID string) (place, error) {
	u, ok := c.Unit(unitID)
	if !ok {
		return place{}, errs.NotFound("unit", unitID)
	}
	v, _ := c.Villa(u.VillaID)
	g, hasGroup := c.Group(u.Group())
	return place{unit: u, villa: v, group: g, hasGroup: hasGroup}, nil
}

// inScope refuses a villa outside the principal's villa or location scope.
func inScope(p auth.Principal, v domain.Villa) error {
	if p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return nil
	}
	return errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", v.Name))
}

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}

func recordOf(id string, villas []domain.Villa, data any) reservation.Record {
	r := reservation.Record{ID: id, VillaIDs: []string{}, LocationIDs: []string{}, Data: mustJSON(data)}
	for _, v := range villas {
		if v.ID != "" && !slices.Contains(r.VillaIDs, v.ID) {
			r.VillaIDs = append(r.VillaIDs, v.ID)
		}
		if v.LocationID != "" && !slices.Contains(r.LocationIDs, v.LocationID) {
			r.LocationIDs = append(r.LocationIDs, v.LocationID)
		}
	}
	return r
}

// world is the catalog, the stays that hold units and the overbooking policies, for one command.
type world struct {
	cat   domain.Catalog
	avail domain.Availability
	rules []domain.Restriction
}

// load reads what availability needs over [from, to). Commands that change what holds a unit
// take the availability lock first.
func (d Deps) load(ctx context.Context, from, to string) (world, error) {
	if err := d.Repo.LockAvailability(ctx); err != nil {
		return world{}, err
	}
	cat, err := d.Catalog.Catalog(ctx)
	if err != nil {
		return world{}, err
	}
	holdings, err := d.Repo.Holdings(ctx, from, to)
	if err != nil {
		return world{}, err
	}
	policies, err := d.Repo.Policies(ctx)
	if err != nil {
		return world{}, err
	}
	rules, err := d.Repo.Restrictions(ctx)
	if err != nil {
		return world{}, err
	}
	return world{cat: cat, avail: domain.Availability{Catalog: cat, Bookings: holdings, Policies: policies}, rules: rules}, nil
}

// booking loads a stay with a lock, with its place, refusing one outside the caller's scope.
func (d Deps) booking(ctx context.Context, p auth.Principal, c domain.Catalog, id string) (domain.Booking, place, error) {
	b, err := d.Repo.Booking(ctx, id)
	if err != nil {
		return b, place{}, err
	}
	pl, err := placeOf(c, b.UnitID)
	if err != nil {
		return b, pl, err
	}
	return b, pl, inScope(p, pl.villa)
}

// saveBooking writes the stay and appends booking.saved.
func (d Deps) saveBooking(ctx context.Context, b *domain.Booking, c domain.Catalog) error {
	if err := d.Repo.UpdateBooking(ctx, b); err != nil {
		return err
	}
	return d.bookingEvent(ctx, *b, c)
}

func (d Deps) bookingEvent(ctx context.Context, b domain.Booking, c domain.Catalog) error {
	pl, _ := placeOf(c, b.UnitID)
	return d.emit(ctx, reservation.EventBookingSaved, "booking", b.ID, b.Version, recordOf(b.ID, []domain.Villa{pl.villa}, b))
}

// stayCheck is who sells, for the restriction rules.
func (d Deps) stayCheck(ctx context.Context, p auth.Principal) (domain.StayCheck, error) {
	perms, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return domain.StayCheck{}, err
	}
	return domain.StayCheck{By: p.Name, Today: d.today(), MayOverride: domain.MayOverrideRestrictions(perms, p.Role), RoleLabel: rbac.RoleLabel[p.Role]}, nil
}

// mayApprove reports booking/approve, which lets a price past the discount limit.
func (d Deps) mayApprove(ctx context.Context, p auth.Principal) (bool, error) {
	perms, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return false, err
	}
	return rbac.Can(perms, p.Role, "booking", "approve"), nil
}

func actor(p auth.Principal) domain.Actor { return domain.Actor{ID: p.UserID, Name: p.Name} }

// overrideAudit is the second audit line when a stay sold past the restrictions.
func (d Deps) overrideAudit(ctx context.Context, p auth.Principal, code, summary string, note *domain.RestrictionNote) error {
	if note == nil || note.Kind != "override" {
		return nil
	}
	return d.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: code, Summary: summary, After: map[string]any{"rules": strings.Join(note.Rules, ", ")}})
}
