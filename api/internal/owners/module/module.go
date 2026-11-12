// Package module wires the owners context: store, commands, queries, HTTP routes, the catalog and
// stays copies, and the policy that follows finance's payout entries. It reads villa results
// through owners.Results, which finance answers; without finance it uses results.Stub.
package module

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/owners/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/owners/adapters/results"
	"github.com/syabanf/wit-hospitality/api/internal/owners/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/owners/app/query"
	ownershttp "github.com/syabanf/wit-hospitality/api/internal/owners/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// ConsumerFinance follows finance's entries for owner payouts.
const ConsumerFinance = "owners.finance"

// Deps is what the owners context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Results answers the villa results a statement reads; nil uses results.Stub.
	Results owners.Results
}

// Module is the wired context.
type Module struct {
	db     *db.DB
	http   ownershttp.Handler
	follow command.FollowFinance
}

// New wires the owners context.
func New(d Deps) *Module {
	store := postgres.Store{DB: d.DB}
	res := d.Results
	if res == nil {
		res = results.Stub{Store: store}
	}
	authz := rbac.Authorizer{Source: d.Permissions}
	deps := command.Deps{DB: d.DB, Repo: store, Results: res, Authz: authz, Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock}
	return &Module{db: d.DB, follow: command.FollowFinance{Deps: deps}, http: ownershttp.Handler{
		Commands: ownershttp.Commands{
			SaveOwner: command.SaveOwner{Deps: deps}, SaveContract: command.SaveContract{Deps: deps},
			Close: command.CloseStatement{Deps: deps}, Approve: command.ApproveStatement{Deps: deps},
			Pay: command.PayStatement{Deps: deps}, Reopen: command.ReopenStatement{Deps: deps},
			RequestStay: command.RequestStay{Deps: deps}, DecideStay: command.DecideStay{Deps: deps},
		},
		Queries: query.Queries{Store: store, Authz: authz, Clock: d.Clock},
		Log:     d.Log,
	}}
}

// Migrations is the owners context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Project registers the catalog and stays copies and the finance policy.
func (m *Module) Project(p *projector.Projector) {
	postgres.Projections{DB: m.db}.Register(p)
	for _, t := range []string{owners.EventFinanceEntryApproved, owners.EventFinanceEntryPosted, owners.EventFinanceEntryRejected} {
		p.On(ConsumerFinance, t, func(ctx context.Context, msg bus.Message) error {
			var e owners.FinanceEntry
			if err := json.Unmarshal(msg.Payload, &e); err != nil {
				return err
			}
			return m.follow.Handle(ctx, t, e)
		})
	}
}
