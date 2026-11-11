// Package module wires the property context: repository, commands, queries, HTTP routes and
// projections. It depends on identity only through rbac.Source and on reservation only through
// command.Stays, which the composition root supplies (in process in the monolith, HTTP in split
// mode).
package module

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/property/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/query"
	propertyhttp "github.com/syabanf/wit-hospitality/api/internal/property/ports/http"
)

// Deps is what the property context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Stays answers questions about stays from the reservation context.
	Stays command.Stays
}

// Module is the wired context.
type Module struct {
	db     *db.DB
	http   propertyhttp.Handler
	follow command.FollowListingBaseRate
	owner  command.AddOwnerBlock
	holds  propertyhttp.Holds
}

// ConsumerListingBaseRate applies channel's listing base prices to units.
const ConsumerListingBaseRate = "property.listing-base-rate"

// ConsumerOwnerStays adds the owner block of an approved owner stay.
const ConsumerOwnerStays = "property.owner-stays"

// New wires the property context.
func New(d Deps) *Module {
	deps := command.Deps{
		DB: d.DB, Repo: postgres.Repo{DB: d.DB}, Stays: d.Stays, Authz: rbac.Authorizer{Source: d.Permissions},
		Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock,
	}
	holds := propertyhttp.Holds{Hold: command.HoldBlock{Deps: deps}, Release: command.ReleaseBlock{Deps: deps}, Log: d.Log}
	return &Module{db: d.DB, follow: command.FollowListingBaseRate{Deps: deps}, owner: command.AddOwnerBlock{Deps: deps}, holds: holds, http: propertyhttp.Handler{
		Commands: propertyhttp.Commands{
			CreateLocation: command.CreateLocation{Deps: deps}, UpdateLocation: command.UpdateLocation{Deps: deps},
			CreateVilla: command.CreateVilla{Deps: deps}, UpdateVilla: command.UpdateVilla{Deps: deps},
			CreateProperty: command.CreateProperty{Deps: deps},
			CreateGroup:    command.CreateGroup{Deps: deps}, UpdateGroup: command.UpdateGroup{Deps: deps},
			CreateUnit: command.CreateUnit{Deps: deps}, UpdateUnit: command.UpdateUnit{Deps: deps},
			SaveRatePlan: command.SaveRatePlan{Deps: deps},
			AddBlock:     command.AddBlock{Deps: deps}, RemoveBlock: command.RemoveBlock{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}},
		Log:     d.Log,
	}}
}

// Migrations is the property context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// InternalRoutes registers the service-to-service routes: unit holds for other contexts' jobs.
func (m *Module) InternalRoutes(r chi.Router) { m.holds.InternalRoutes(r) }

// Blocks places and frees unit holds in process; maintenance uses it for work orders.
func (m *Module) Blocks() Blocks { return Blocks{holds: m.holds} }

// Blocks is the in-process unit hold client. It runs inside the caller's transaction.
type Blocks struct{ holds propertyhttp.Holds }

// Hold blocks the unit for maintenance on [from, to) and returns the block id.
func (b Blocks) Hold(ctx context.Context, unitID, from, to, note string) (string, error) {
	return b.holds.Hold.Handle(ctx, unitID, from, to, note)
}

// Release frees the unit from today on.
func (b Blocks) Release(ctx context.Context, blockID, today string) error {
	return b.holds.Release.Handle(ctx, blockID, today)
}

// Project registers the read model handlers, the policy that keeps a unit's nightly rate equal
// to the base price set on its Airbnb listing, and the one that blocks a unit for an approved
// owner stay.
func (m *Module) Project(p *projector.Projector) {
	postgres.Projections{DB: m.db}.Register(p)
	p.On(ConsumerListingBaseRate, channel.EventListingPriced, func(ctx context.Context, msg bus.Message) error {
		var e channel.ListingPriced
		if err := json.Unmarshal(msg.Payload, &e); err != nil {
			return err
		}
		return m.follow.Handle(ctx, e.Listing.UnitID, e.BaseRate)
	})
	p.On(ConsumerOwnerStays, owners.EventStayDecided, func(ctx context.Context, msg bus.Message) error {
		var e owners.StayDecided
		if err := json.Unmarshal(msg.Payload, &e); err != nil || e.Block == nil {
			return err
		}
		return m.owner.Handle(ctx, *e.Block)
	})
}
