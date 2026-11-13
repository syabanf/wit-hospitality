// Package module wires the housekeeping context: store, commands, queries, HTTP routes and the
// projections of property, reservation and people events. It reaches inventory, maintenance and
// guest through command.Clients, which the composition root fills.
package module

import (
	"context"
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
	// Clients reach inventory, maintenance and guest. A nil People reads housekeeping's copy of
	// people's records, a nil Stock and WorkOrders answer NOT_AVAILABLE, a nil LostFound refuses
	// to log a find.
	Clients command.Clients
	// BusinessDate is billing's current business date, the day the start-up plan covers; nil reads
	// the clock's date.
	BusinessDate func(ctx context.Context) (string, error)
	// NoReactions skips the check-out and night audit reactions, for the seed, which loads the
	// board as exported.
	NoReactions bool
}

// Module is the wired context.
type Module struct {
	db           *db.DB
	http         housekeepinghttp.Handler
	checkedOut   command.CheckedOut
	plan         command.PlanDay
	businessDate func(ctx context.Context) (string, error)
	reactions    bool
}

// New wires the housekeeping context.
func New(d Deps) *Module {
	cl := d.Clients
	if cl.People == nil {
		cl.People = postgres.Staff{DB: d.DB}
	}
	if cl.Stock == nil {
		cl.Stock = clients.Stock{}
	}
	if cl.WorkOrders == nil {
		cl.WorkOrders = clients.WorkOrders{}
	}
	if cl.LostFound == nil {
		cl.LostFound = clients.LostFound{}
	}
	deps := command.Deps{DB: d.DB, Store: postgres.Repo{DB: d.DB}, Clients: cl, Authz: rbac.Authorizer{Source: d.Permissions},
		Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock}
	businessDate := d.BusinessDate
	if businessDate == nil {
		businessDate = func(context.Context) (string, error) { return clock.Today(d.Clock), nil }
	}
	return &Module{db: d.DB, checkedOut: command.CheckedOut{Deps: deps}, plan: command.PlanDay{Deps: deps}, businessDate: businessDate, reactions: !d.NoReactions, http: housekeepinghttp.Handler{
		Commands: housekeepinghttp.Commands{
			SaveSettings: command.SaveSettings{Deps: deps}, PlanDay: command.PlanDay{Deps: deps}, AddTask: command.AddTask{Deps: deps},
			Assign: command.Assign{Deps: deps}, AutoAssign: command.AutoAssign{Deps: deps}, WorkTask: command.WorkTask{Deps: deps},
			ReportIssue: command.ReportIssue{Deps: deps}, NoteLostFound: command.NoteLostFound{Deps: deps},
			SetState: command.SetState{Deps: deps}, Inspect: command.Inspect{Deps: deps},
			SaveLinenPar: command.SaveLinenPar{Deps: deps}, DiscardLinen: command.DiscardLinen{Deps: deps},
			SendLaundry: command.SendLaundry{Deps: deps}, ReturnLaundry: command.ReturnLaundry{Deps: deps},
			RequestClean: command.RequestClean{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}},
		Log:     d.Log,
	}}
}

// Migrations is the housekeeping context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Project registers the catalog, stay and staff copies and the check-out and night audit
// reactions.
func (m *Module) Project(p *projector.Projector) {
	pr := postgres.Projections{DB: m.db}
	if m.reactions {
		pr.CheckedOut = m.checkedOut.Handle
		pr.Audited = func(ctx context.Context, date string) error {
			_, err := m.plan.Once(ctx, date)
			return err
		}
	}
	pr.Register(p)
}

// PlanBusinessDay plans the current business date unless a plan already ran for it, so a fresh
// deployment has its stayover and departure tasks before a supervisor plans the day.
func (m *Module) PlanBusinessDay(ctx context.Context) error {
	date, err := m.businessDate(ctx)
	if err != nil {
		return err
	}
	_, err = m.plan.Once(ctx, date)
	return err
}
