// Package module wires the maintenance context: repository, commands, queries, HTTP routes and
// projections. It reaches property through command.Blocks and finance through
// command.CashOutRequests, both chosen by the composition root.
package module

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/app/query"
	maintenancehttp "github.com/syabanf/wit-hospitality/api/internal/maintenance/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Deps is what the maintenance context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Blocks holds units through property: in process in the monolith, HTTP in split mode.
	Blocks command.Blocks
	// CashOuts asks finance to pay; nil records requests in this context's outbox until finance runs.
	CashOuts command.CashOutRequests
}

// Module is the wired context.
type Module struct {
	db   *db.DB
	http maintenancehttp.Handler
}

// New wires the maintenance context.
func New(d Deps) *Module {
	rec := audit.Recorder{DB: d.DB, Clock: d.Clock}
	cash := d.CashOuts
	if cash == nil {
		cash = postgres.CashOuts{DB: d.DB, Audit: rec, Clock: d.Clock}
	}
	deps := command.Deps{
		DB: d.DB, Repo: postgres.Repo{DB: d.DB}, Blocks: d.Blocks, CashOuts: cash,
		Authz: rbac.Authorizer{Source: d.Permissions}, Audit: rec, Clock: d.Clock,
	}
	return &Module{db: d.DB, http: maintenancehttp.Handler{
		Commands: maintenancehttp.Commands{
			CreateWorkOrder: command.CreateWorkOrder{Deps: deps}, UpdateWorkOrder: command.UpdateWorkOrder{Deps: deps},
			TransitionWorkOrder: command.TransitionWorkOrder{Deps: deps}, AddNote: command.AddNote{Deps: deps}, SetBlock: command.SetBlock{Deps: deps},
			AddExpense: command.AddExpense{Deps: deps}, CorrectExpense: command.CorrectExpense{Deps: deps},
			CreateAsset: command.CreateAsset{Deps: deps}, UpdateAsset: command.UpdateAsset{Deps: deps},
			CreateVendor: command.CreateVendor{Deps: deps}, UpdateVendor: command.UpdateVendor{Deps: deps},
			CreatePlan: command.CreatePlan{Deps: deps}, UpdatePlan: command.UpdatePlan{Deps: deps}, GenerateDue: command.GenerateDue{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}},
		Log:     d.Log,
	}}
}

// Migrations is the maintenance context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Project registers the property reference and cash-out status handlers.
func (m *Module) Project(p *projector.Projector) { postgres.Projections{DB: m.db}.Register(p) }
