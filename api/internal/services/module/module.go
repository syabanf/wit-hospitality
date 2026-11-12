// Package module wires the services context: repository, catalog copy, commands, queries, HTTP
// routes and projections. It depends on identity only through rbac.Source, on reservation through
// reservation.Stays, and on guest and billing through the command's Guests and Billing.
package module

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/services/adapters/clients"
	"github.com/syabanf/wit-hospitality/api/internal/services/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/query"
	serviceshttp "github.com/syabanf/wit-hospitality/api/internal/services/ports/http"
)

// Deps is what the services context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Stays reads bookings from reservation, in process or over HTTP.
	Stays reservation.Stays
	// Guests reads guest names; nil answers NOT_AVAILABLE.
	Guests command.Guests
	// Billing reads order payments; nil uses clients.PendingBilling.
	Billing command.Billing
}

// Module is the wired context.
type Module struct {
	db   *db.DB
	read postgres.ReadStore
	http serviceshttp.Handler
	paid command.OrdersPaid
}

// New wires the services context.
func New(d Deps) *Module {
	if d.Guests == nil {
		d.Guests = clients.Guests{}
	}
	if d.Billing == nil {
		d.Billing = clients.PendingBilling{}
	}
	deps := command.Deps{
		DB: d.DB, Repo: postgres.Repo{DB: d.DB}, Catalog: postgres.CatalogStore{DB: d.DB}, Stays: d.Stays, Guests: d.Guests, Billing: d.Billing,
		Authz: rbac.Authorizer{Source: d.Permissions}, Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock,
	}
	read := postgres.ReadStore{DB: d.DB}
	return &Module{db: d.DB, read: read, paid: command.OrdersPaid{Deps: deps}, http: serviceshttp.Handler{
		Commands: serviceshttp.Commands{
			SaveMenuItem: command.SaveMenuItem{Deps: deps}, SavePartner: command.SavePartner{Deps: deps},
			PlaceOrder: command.PlaceOrder{Deps: deps}, StepOrder: command.StepOrder{Deps: deps}, AssignOrder: command.AssignOrder{Deps: deps},
			Room: command.Room{Deps: deps}, CreateRequest: command.CreateRequest{Deps: deps}, UpdateRequest: command.UpdateRequest{Deps: deps},
			StepRequest: command.StepRequest{Deps: deps},
		},
		Queries: query.Queries{Store: read},
		Log:     d.Log,
	}}
}

// Migrations is the services context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Project registers the catalog copy handlers and the paid orders reaction.
func (m *Module) Project(p *projector.Projector) {
	postgres.Projections{DB: m.db, Paid: m.paid.Handle}.Register(p)
}

// SiteMenu lists the active menu as the public site prints it, for channel's site inventory.
func (m *Module) SiteMenu(ctx context.Context) ([]json.RawMessage, error) {
	return m.read.SiteMenu(ctx)
}
