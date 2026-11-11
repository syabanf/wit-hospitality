// Package command holds the property context's write side: one handler per command. Each handler
// checks the permission and villa scope, loads, applies the domain rules, saves, and appends its
// events and audit line in one transaction.
package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/property"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// Repository is the write model on the property schema. Loads lock the row for the transaction.
type Repository interface {
	Location(ctx context.Context, id string) (domain.Location, error)
	InsertLocation(ctx context.Context, l *domain.Location) error
	UpdateLocation(ctx context.Context, l *domain.Location) error

	Villa(ctx context.Context, id string) (domain.Villa, error)
	VillaCodeTaken(ctx context.Context, code, excludeID string) (bool, error)
	InsertVilla(ctx context.Context, v *domain.Villa) error
	UpdateVilla(ctx context.Context, v *domain.Villa) error

	Group(ctx context.Context, id string) (domain.UnitGroup, error)
	FindGroup(ctx context.Context, id string) (*domain.UnitGroup, error)
	InsertGroup(ctx context.Context, g *domain.UnitGroup) error
	UpdateGroup(ctx context.Context, g *domain.UnitGroup) error

	Unit(ctx context.Context, id string) (domain.Unit, error)
	UnitCodeTaken(ctx context.Context, code, excludeID string) (bool, error)
	UnitIDTaken(ctx context.Context, id string) (bool, error)
	InsertUnit(ctx context.Context, u *domain.Unit) error
	UpdateUnit(ctx context.Context, u *domain.Unit) error

	RatePlan(ctx context.Context, groupID string) (*domain.RatePlan, error)
	// SaveRatePlan inserts or replaces the plan and bumps its version.
	SaveRatePlan(ctx context.Context, p *domain.RatePlan) error

	Block(ctx context.Context, id string) (domain.UnitBlock, error)
	InsertBlock(ctx context.Context, b domain.UnitBlock) error
	DeleteBlock(ctx context.Context, id string) error
}

// Stays answers what property needs to know about stays, which the booking context owns. In
// phase 0 no booking context runs, so the adapter answers that no stays exist; phase 1 swaps in a
// client of the booking context (in process in the monolith, HTTP in split mode).
type Stays interface {
	// OverlappingStay returns the code of a stay holding the unit on a night in [from, to).
	OverlappingStay(ctx context.Context, unitID, from, to string) (string, bool, error)
	// HasUpcomingStays reports confirmed stays with the unit assigned that check out after today.
	HasUpcomingStays(ctx context.Context, unitID, today string) (bool, error)
	// WaitingForRoom lists codes of open stays booked against the room type without a unit yet.
	WaitingForRoom(ctx context.Context, groupID string) ([]string, error)
}

// Deps is what every property command needs.
type Deps struct {
	DB    *db.DB
	Repo  Repository
	Stays Stays
	Authz rbac.Authorizer
	Audit audit.Recorder
	Clock clock.Clock
}

// Permission sets the commands check, taken from the application services' allow() calls.
var (
	masterCreate    = []rbac.Need{{Module: "master", Action: "create"}}
	masterEdit      = []rbac.Need{{Module: "master", Action: "edit"}}
	propertyEdit    = []rbac.Need{{Module: "property", Action: "edit"}}
	groupOrUnitEdit = []rbac.Need{{Module: "master", Action: "edit"}, {Module: "property", Action: "edit"}}
	blockAdd        = []rbac.Need{{Module: "booking", Action: "create"}, {Module: "property", Action: "edit"}}
	blockRemove     = []rbac.Need{{Module: "booking", Action: "edit"}, {Module: "property", Action: "edit"}}
)

func actorOf(p auth.Principal) audit.Actor {
	return audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}
}

// inScope refuses a villa outside the principal's villa or location scope.
func inScope(p auth.Principal, v domain.Villa) error {
	if p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return nil
	}
	return errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", v.Name))
}

func (d Deps) emit(ctx context.Context, eventType, aggregateType, aggregateID string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: aggregateID, AggregateVersion: version, Payload: payload})
}

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, actorOf(p), l)
}

func locationState(l domain.Location) property.Location {
	return property.Location{ID: l.ID, Name: l.Name, Area: l.Area}
}

func villaState(v domain.Villa) property.Villa {
	return property.Villa{ID: v.ID, LocationID: v.LocationID, Code: v.Code, Name: v.Name, Description: v.Description, Facilities: v.Facilities}
}

func groupState(g domain.UnitGroup) property.Group {
	return property.Group{ID: g.ID, VillaID: g.VillaID, Name: g.Name, Interchangeable: g.Interchangeable, OperatorAssigns: g.OperatorAssigns}
}

func unitState(u domain.Unit) property.Unit {
	return property.Unit{ID: u.ID, VillaID: u.VillaID, GroupID: u.GroupID, Code: u.Code, Name: u.Name, Bedrooms: u.Bedrooms, NightlyRate: u.NightlyRate, Status: u.Status, Amenities: u.Amenities}
}

func planState(p domain.RatePlan) property.RatePlan {
	out := property.RatePlan{GroupID: p.GroupID, WeekdayRate: p.WeekdayRate, WeekendRate: p.WeekendRate, Seasons: []property.Season{}}
	for _, s := range p.Seasons {
		out.Seasons = append(out.Seasons, property.Season{Name: s.Name, From: s.From, To: s.To, Kind: s.Kind, Value: s.Value})
	}
	return out
}

func (d Deps) groupEvent(ctx context.Context, eventType string, g domain.UnitGroup, locationID string) error {
	return d.emit(ctx, eventType, "unit_group", g.ID, g.Version, property.GroupEvent{Group: groupState(g), LocationID: locationID})
}

func (d Deps) unitEvent(ctx context.Context, eventType string, u domain.Unit, locationID string) error {
	return d.emit(ctx, eventType, "unit", u.ID, u.Version, property.UnitEvent{Unit: unitState(u), LocationID: locationID})
}

func (d Deps) planEvent(ctx context.Context, p domain.RatePlan, villa domain.Villa) error {
	return d.emit(ctx, property.EventRatePlanSaved, "rate_plan", p.GroupID, p.Version, property.RatePlanSaved{Plan: planState(p), VillaID: villa.ID, LocationID: villa.LocationID})
}

// planSummary is what the audit line keeps of a plan.
func planSummary(p *domain.RatePlan) map[string]any {
	if p == nil {
		return nil
	}
	return map[string]any{"weekdayRate": p.WeekdayRate, "weekendRate": p.WeekendRate, "seasons": len(p.Seasons)}
}

// startPlan is the mock's startPlan: a unit that joins a room type without a rate plan starts one
// from its base price.
func (d Deps) startPlan(ctx context.Context, p auth.Principal, u domain.Unit, villa domain.Villa) error {
	if u.GroupID == nil {
		return nil
	}
	existing, err := d.Repo.RatePlan(ctx, *u.GroupID)
	if err != nil || existing != nil {
		return err
	}
	group, err := d.Repo.Group(ctx, *u.GroupID)
	if err != nil {
		return err
	}
	plan := domain.DefaultRatePlan(float64(u.NightlyRate)).Plan(group.ID)
	if err := d.Repo.SaveRatePlan(ctx, &plan); err != nil {
		return err
	}
	if err := d.planEvent(ctx, plan, villa); err != nil {
		return err
	}
	return d.record(ctx, p, audit.Line{Action: audit.Create, Entity: "rate_plan", EntityID: group.ID, Summary: fmt.Sprintf("Started the %s rate plan from %s's base price", group.Name, u.Code)})
}
