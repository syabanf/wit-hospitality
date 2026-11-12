// Package module wires the guest context: repository, commands, queries, HTTP routes, the
// projections of property events, and the in-process guest client. It depends on identity only
// through rbac.Source, which the composition root supplies.
package module

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/guest/app/query"
	guesthttp "github.com/syabanf/wit-hospitality/api/internal/guest/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Deps is what the guest context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
}

// Module is the wired context.
type Module struct {
	db   *db.DB
	http guesthttp.Handler
}

// New wires the guest context.
func New(d Deps) *Module {
	authz := rbac.Authorizer{Source: d.Permissions}
	deps := command.Deps{DB: d.DB, Repo: postgres.Repo{DB: d.DB}, Authz: authz, Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock}
	return &Module{db: d.DB, http: guesthttp.Handler{
		Commands: guesthttp.Commands{
			CreateGuest: command.CreateGuest{Deps: deps}, UpdateGuest: command.UpdateGuest{Deps: deps},
			SetBlacklist: command.SetBlacklist{Deps: deps}, MergeGuests: command.MergeGuests{Deps: deps},
			AddCompanion: command.AddCompanion{Deps: deps}, UpdateCompanion: command.UpdateCompanion{Deps: deps},
			RemoveCompanion: command.RemoveCompanion{Deps: deps}, MarkReported: command.MarkReported{Deps: deps},
			LogLostItem: command.LogLostItem{Deps: deps}, UpdateLostItem: command.UpdateLostItem{Deps: deps},
			MoveLostItem: command.MoveLostItem{Deps: deps}, SaveSettings: command.SaveLostFoundSettings{Deps: deps},
			ApplyPreCheckIn: command.ApplyPreCheckIn{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}, Authz: authz, Clock: d.Clock},
		Log:     d.Log,
	}}
}

// Migrations is the guest context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// InternalRoutes registers the guest client's service-to-service routes.
func (m *Module) InternalRoutes(r chi.Router) { m.http.InternalRoutes(r) }

// Project registers the projections of other contexts' events into guest's schema.
func (m *Module) Project(p *projector.Projector) { postgres.Projections{DB: m.db}.Register(p) }

// Client is the in-process guest client for contexts in the same process.
func (m *Module) Client() guest.Client { return m.http.Client() }

// LostFound is the in-process lost and found client for contexts in the same process.
func (m *Module) LostFound() guest.LostFound { return m.http.Finds() }
