// Package module wires the messaging context: store, provider, commands, queries, HTTP routes, the
// projections of property, guest, reservation and billing events, and the triggers.
package module

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/messaging/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/adapters/provider"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/app/query"
	messaginghttp "github.com/syabanf/wit-hospitality/api/internal/messaging/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Deps is what the messaging context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// Provider sends the messages; nil is the simulated provider.
	Provider command.Provider
	// Billing renders the e-invoice; nil answers NOT_AVAILABLE until billing runs.
	Billing command.Billing
	// NoTriggers keeps the copies without queueing messages, for the seed.
	NoTriggers bool
}

// PendingBilling answers for billing until it runs.
type PendingBilling struct{}

// Invoice refuses.
func (PendingBilling) Invoice(context.Context, string) (json.RawMessage, error) {
	return nil, command.NotAvailable("The e-invoice")
}

// Module is the wired context.
type Module struct {
	db       *db.DB
	http     messaginghttp.Handler
	triggers postgres.Triggers
}

// New wires the messaging context.
func New(d Deps) *Module {
	if d.Provider == nil {
		d.Provider = provider.Simulated{}
	}
	if d.Billing == nil {
		d.Billing = PendingBilling{}
	}
	authz := rbac.Authorizer{Source: d.Permissions}
	deps := command.Deps{DB: d.DB, Store: postgres.Repo{DB: d.DB}, Provider: d.Provider, Billing: d.Billing, Authz: authz,
		Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock}
	m := &Module{db: d.DB, http: messaginghttp.Handler{
		Commands: messaginghttp.Commands{
			Send: command.Send{Deps: deps}, Resend: command.Resend{Deps: deps}, SaveSettings: command.SaveSettings{Deps: deps},
			Sweep: command.Sweep{Deps: deps}, Invoice: command.Invoice{Deps: deps},
		},
		Queries: query.Queries{Store: postgres.ReadStore{DB: d.DB}, Authz: authz},
		Log:     d.Log,
	}}
	if !d.NoTriggers {
		m.triggers = command.Triggers{Deps: deps}
	}
	return m
}

// Migrations is the messaging context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// Project registers the copies and the triggers.
func (m *Module) Project(p *projector.Projector) {
	postgres.Projections{DB: m.db, Triggers: m.triggers}.Register(p)
}
