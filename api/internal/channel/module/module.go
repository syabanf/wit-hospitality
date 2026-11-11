// Package module wires the channel context: repository, commands, queries, HTTP routes, the
// projection of property's catalog and the in-process price lookup. It depends on identity only
// through rbac.Source and on reservation and the other owners of site data through the
// command.Bookings and query.SiteSources interfaces, which default to adapters/sources.None.
package module

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/channel/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/channel/adapters/sources"
	"github.com/syabanf/wit-hospitality/api/internal/channel/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/channel/app/query"
	channelhttp "github.com/syabanf/wit-hospitality/api/internal/channel/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Deps is what the channel context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Bookings answers the code of a booking; nil uses sources.None until reservation is wired in.
	Bookings command.Bookings
	// Sources reads the site data other contexts own; nil uses sources.None.
	Sources query.SiteSources
}

// Module is the wired context.
type Module struct {
	db      *db.DB
	http    channelhttp.Handler
	queries query.Queries
}

// New wires the channel context.
func New(d Deps) *Module {
	bookings, src := d.Bookings, d.Sources
	if bookings == nil {
		bookings = sources.None{}
	}
	if src == nil {
		src = sources.None{}
	}
	repo := postgres.Repo{DB: d.DB}
	deps := command.Deps{
		DB: d.DB, Repo: repo, Catalog: repo, Bookings: bookings, Authz: rbac.Authorizer{Source: d.Permissions},
		Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock,
	}
	q := query.Queries{Store: postgres.ReadStore{DB: d.DB}, Sources: src, Permissions: d.Permissions}
	return &Module{db: d.DB, queries: q, http: channelhttp.Handler{
		Commands: channelhttp.Commands{
			CreateAccount: command.CreateAccount{Deps: deps}, UpdateAccount: command.UpdateAccount{Deps: deps},
			CreateListing: command.CreateListing{Deps: deps}, UpdateListing: command.UpdateListing{Deps: deps},
			SetListingStatus: command.SetListingStatus{Deps: deps}, SetListingPrices: command.SetListingPrices{Deps: deps},
			SubmitEnquiry: command.SubmitEnquiry{Deps: deps}, SetEnquiryStatus: command.SetEnquiryStatus{Deps: deps},
			ConvertEnquiry: command.ConvertEnquiry{Deps: deps},
		},
		Queries: q,
		Log:     d.Log,
	}}
}

// Migrations is the channel context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// InternalRoutes registers the service-to-service routes.
func (m *Module) InternalRoutes(r chi.Router) { m.http.InternalRoutes(r) }

// Project registers the projection of property's catalog.
func (m *Module) Project(p *projector.Projector) { postgres.Projections{DB: m.db}.Register(p) }

// Prices answers listing price lookups in process.
func (m *Module) Prices() channel.Prices { return m.queries }
