// Package command holds the guest context's write side: one handler per command. Each handler
// checks the permission and villa scope, loads, applies the domain rules, saves, and appends its
// events and audit line in one transaction. The checks follow src/application/guests.ts (allow)
// and src/infrastructure/mock/guests.ts (the rules), in that order.
package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Repository is the write model on the guest schema, plus guest's copies of the villas, units
// and stays other contexts own. Loads of guest's own rows lock them for the transaction.
type Repository interface {
	Next(ctx context.Context, key string) (int64, error)

	Guest(ctx context.Context, id string) (domain.Guest, error)
	InsertGuest(ctx context.Context, g *domain.Guest) error
	UpdateGuest(ctx context.Context, g *domain.Guest) error
	DeleteGuest(ctx context.Context, id string) error
	// MoveGuestReferences re-points guest's copies of stays and group leads and counts them.
	MoveGuestReferences(ctx context.Context, dropID, keepID string) (stays, groups int64, err error)

	Companion(ctx context.Context, id string) (domain.Companion, error)
	CompanionsOf(ctx context.Context, bookingID string) ([]domain.Companion, error)
	InsertCompanion(ctx context.Context, c *domain.Companion) error
	UpdateCompanion(ctx context.Context, c *domain.Companion) error
	DeleteCompanion(ctx context.Context, id string) error

	ReportedPeople(ctx context.Context, bookingID string) ([]string, error)
	InsertReport(ctx context.Context, f domain.ForeignReport) error
	MoveReports(ctx context.Context, dropID, keepID string) ([]string, error)

	LostItem(ctx context.Context, id string) (domain.LostItem, error)
	InsertLostItem(ctx context.Context, i *domain.LostItem) error
	UpdateLostItem(ctx context.Context, i *domain.LostItem) error
	MoveLostItems(ctx context.Context, dropID, keepID string) ([]string, error)

	Settings(ctx context.Context) (domain.LostFoundSettings, error)
	SaveSettings(ctx context.Context, s domain.LostFoundSettings) (int64, error)

	Villa(ctx context.Context, id string) (domain.VillaRef, error)
	Unit(ctx context.Context, id string) (domain.UnitRef, error)
	Stay(ctx context.Context, id string) (domain.Stay, error)
}

// Deps is what every guest command needs.
type Deps struct {
	DB    *db.DB
	Repo  Repository
	Authz rbac.Authorizer
	Audit audit.Recorder
	Clock clock.Clock
}

// Permission sets, from the allow() calls in src/application/guests.ts. Creating and editing a
// profile carry no allow() call there because the booking form creates guests too; the API asks
// for guest or booking rights.
var (
	guestCreate   = []rbac.Need{{Module: "guest", Action: "create"}}
	guestEdit     = []rbac.Need{{Module: "guest", Action: "edit"}}
	profileCreate = []rbac.Need{{Module: "guest", Action: "create"}, {Module: "booking", Action: "create"}}
	profileEdit   = []rbac.Need{{Module: "guest", Action: "edit"}, {Module: "booking", Action: "edit"}}
)

func actorOf(p auth.Principal) audit.Actor {
	return audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}
}

// requireApprove is the mock's requireApprove: blacklisting, merging and the holding period need
// approve in the guest module.
func (d Deps) requireApprove(ctx context.Context, p auth.Principal, what string) error {
	matrix, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return fmt.Errorf("load permissions: %w", err)
	}
	if rbac.Can(matrix, p.Role, "guest", "approve") {
		return nil
	}
	return errs.Forbidden(fmt.Sprintf("Only someone who may approve in the guest module can %s.", what))
}

// villaInScope refuses a villa outside the principal's scope.
func (d Deps) villaInScope(ctx context.Context, p auth.Principal, villaID string) (domain.VillaRef, error) {
	v, err := d.Repo.Villa(ctx, villaID)
	if err != nil {
		return v, err
	}
	if !p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return v, errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", v.Name))
	}
	return v, nil
}

// stayInScope loads a stay and refuses one in a villa outside the principal's scope.
func (d Deps) stayInScope(ctx context.Context, p auth.Principal, bookingID string) (domain.Stay, domain.VillaRef, error) {
	s, err := d.Repo.Stay(ctx, bookingID)
	if err != nil {
		return s, domain.VillaRef{}, err
	}
	v, err := d.villaInScope(ctx, p, s.VillaID)
	return s, v, err
}

func (d Deps) emit(ctx context.Context, eventType, aggregateType, aggregateID string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: aggregateID, AggregateVersion: version, Payload: payload})
}

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, actorOf(p), l)
}

func (d Deps) today() string { return clock.Today(d.Clock) }
func (d Deps) now() string   { return clock.Stamp(d.Clock) }
