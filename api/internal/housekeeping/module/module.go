// Package module wires the housekeeping context: store, commands, queries, HTTP routes and the
// projections of property and reservation events. It reaches people, inventory, maintenance and
// guest through command.Clients, which the composition root fills.
package module

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/clients"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/query"
	housekeepinghttp "github.com/syabanf/wit-hospitality/api/internal/housekeeping/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Deps is what the housekeeping context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Clients reach people, inventory, maintenance and guest. A nil People finds nobody on shift,
	// a nil Stock and WorkOrders answer NOT_AVAILABLE, a nil LostFound refuses to log a find.
	Clients command.Clients
	// NoReactions skips the check-out reaction, for the seed, which loads the board as exported.
	NoReactions bool
}

// Module is the wired context.
type Module struct {
	db         *db.DB
	http       housekeepinghttp.Handler
	checkedOut command.CheckedOut
	reactions  bool
}

// New wires the housekeeping context.
func New(d Deps) *Module {
	cl := d.Clients
	if cl.People == nil {
		cl.People = clients.NoPeople{}
	}
	if cl.Stock == nil {
		cl.Stock = clients.NoStock{}
	}
	if cl.WorkOrders == nil {
		cl.WorkOrders = clients.PendingWorkOrders{}
	}
	if cl.LostFound == nil {
		cl.LostFound = clients.LostFound{}
	}
	deps := command.Deps{DB: d.DB, Store: postgres.Repo{DB: d.DB}, Clients: cl, Authz: rbac.Authorizer{Source: d.Permissions},
		Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock}
	return &Module{db: d.DB, checkedOut: command.CheckedOut{Deps: deps}, reactions: !d.NoReactions, http: housekeepinghttp.Handler{
		Commands: housekeepinghttp.Commands{
			SaveSettings: command.SaveSettings{Deps: deps}, PlanDay: command.PlanDay{Deps: deps}, AddTask: command.AddTask{Deps: deps},
			Assign: command.Assign{Deps: deps}, AutoAssign: command.AutoAssign{Deps: deps}, WorkTask: command.WorkTask{Deps: deps},
			ReportIssue: command.ReportIssue{Deps: deps}, NoteLostFound: command.NoteLostFound{Deps: deps},
			SetState: command.SetState{Deps: deps}, Inspect: command.Inspect{Deps: deps},
			SaveLinenPar: command.SaveLinenPar{Deps: deps}, DiscardLinen: command.DiscardLinen{Deps: deps},
			SendLaundry: command.SendLaundry{Deps: deps}, ReturnLaundry: command.ReturnLaundry{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}},
		Log:     d.Log,
	}}
}

// Migrations is the housekeeping context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Project registers the catalog and stay copies and the check-out reaction.
func (m *Module) Project(p *projector.Projector) {
	pr := postgres.Projections{DB: m.db}
	if m.reactions {
		pr.CheckedOut = m.checkedOut.Handle
	}
	pr.Register(p)
}
