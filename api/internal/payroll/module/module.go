// Package module wires the payroll context: repository, commands, queries, HTTP routes and the
// projections of people events it computes payslips from. It depends on identity only through
// rbac.Source, on finance through command.PayrollPosting and on billing through
// command.ServicePool; both clients are in process until those contexts exist.
package module

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/payroll/adapters/billing"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/adapters/finance"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/app/query"
	payrollhttp "github.com/syabanf/wit-hospitality/api/internal/payroll/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Deps is what the payroll context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Posting posts the salary payment; nil records it in the outbox (finance.Outbox).
	Posting command.PayrollPosting
	// Pool answers the month's service charge pool; nil answers zero (billing.NoPool).
	Pool command.ServicePool
}

// Module is the wired context.
type Module struct {
	db   *db.DB
	http payrollhttp.Handler
}

// New wires the payroll context.
func New(d Deps) *Module {
	posting, pool := d.Posting, d.Pool
	if posting == nil {
		posting = finance.Outbox{DB: d.DB, Clock: d.Clock}
	}
	if pool == nil {
		pool = billing.NoPool{}
	}
	authz := rbac.Authorizer{Source: d.Permissions}
	repo := postgres.Repo{DB: d.DB}
	deps := command.Deps{DB: d.DB, Repo: repo, Inputs: repo, Pool: pool, Posting: posting, Authz: authz, Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock}
	return &Module{db: d.DB, http: payrollhttp.Handler{
		Commands: payrollhttp.Commands{
			SaveSettings: command.SaveSettings{Deps: deps}, CreatePeriod: command.CreatePeriod{Deps: deps}, Calculate: command.Calculate{Deps: deps},
			AddAdjustment: command.AddAdjustment{Deps: deps}, RemoveAdjustment: command.RemoveAdjustment{Deps: deps},
			Transition: command.Transition{Deps: deps}, Publish: command.Publish{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}, Authz: authz},
		Log:     d.Log,
	}}
}

// Migrations is the payroll context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Project registers the handlers that copy people records into payroll.
func (m *Module) Project(p *projector.Projector) { postgres.Projections{DB: m.db}.Register(p) }
