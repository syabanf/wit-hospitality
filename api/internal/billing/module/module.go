// Package module wires the billing context: store, commands, queries, HTTP routes, projections and
// the billing client reservation and services call. It depends on identity through rbac.Source and
// on finance, guest, services, people and reservation through command's client interfaces.
package module

import (
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/adapters/clients"
	"github.com/syabanf/wit-hospitality/api/internal/billing/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/app/query"
	billinghttp "github.com/syabanf/wit-hospitality/api/internal/billing/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Deps is what the billing context needs from the process. A nil client takes the stand-in from
// adapters/clients.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	Finance     command.Finance
	Guests      command.Guests
	Orders      command.Orders
	Reservation command.Reservation
	Roster      command.Roster
}

// Module is the wired context.
type Module struct {
	db     *db.DB
	http   billinghttp.Handler
	closed command.StayClosed
	voided command.OrderVoided
}

// New wires the billing context.
func New(d Deps) *Module {
	store := postgres.Store{DB: d.DB}
	deps := command.Deps{DB: d.DB, Store: store, Authz: rbac.Authorizer{Source: d.Permissions}, Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock,
		Finance: d.Finance, Guests: d.Guests, Orders: d.Orders, Reservation: d.Reservation, Roster: d.Roster}
	if deps.Finance == nil {
		deps.Finance = clients.PendingFinance{Store: store}
	}
	if deps.Guests == nil {
		deps.Guests = clients.Guests{}
	}
	if deps.Orders == nil {
		deps.Orders = postgres.Orders{DB: d.DB}
	}
	if deps.Roster == nil {
		deps.Roster = clients.NoRoster{}
	}
	if deps.Reservation == nil {
		deps.Reservation = clients.Reservation{}
	}
	expire := command.ExpireLinks{Deps: deps}
	return &Module{db: d.DB, closed: command.StayClosed{Deps: deps}, voided: command.OrderVoided{Deps: deps}, http: billinghttp.Handler{
		Commands: billinghttp.Commands{
			Folio: command.FolioPostings{Deps: deps}, PostCharge: command.PostCharge{Deps: deps}, PostRebate: command.PostRebate{Deps: deps},
			RecordPayment: command.RecordPayment{Deps: deps}, CreateLink: command.CreateLink{Deps: deps}, CancelLink: command.CancelLink{Deps: deps},
			Refund: command.Refund{Deps: deps}, Checkout: command.Checkout{Deps: deps}, SavePolicy: command.SavePolicy{Deps: deps},
			RunAudit: command.RunAudit{Deps: deps}, Cashier: command.Cashier{Deps: deps}, SaveShift: command.SaveShiftPolicy{Deps: deps},
			SaveAccount: command.SaveAccount{Deps: deps}, SetBilling: command.SetBilling{Deps: deps}, Transfer: command.Transfer{Deps: deps},
			TransferGroup: command.TransferGroup{Deps: deps}, IssueInvoice: command.IssueInvoice{Deps: deps}, SendInvoice: command.SendInvoice{Deps: deps},
			LedgerPayment: command.RecordLedgerPayment{Deps: deps}, ApplyCredit: command.ApplyCredit{Deps: deps}, WriteOff: command.WriteOff{Deps: deps},
			SaveTax: command.SaveTax{Deps: deps}, SaveCode: command.SaveCode{Deps: deps}, Desk: command.Desk{Deps: deps},
		},
		Queries: query.Queries{Store: store, Authz: deps.Authz, Expire: expire.Handle},
		Clock:   d.Clock,
		Log:     d.Log,
	}}
}

// Migrations is the billing context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// InternalRoutes serves the billing client under /internal/v1/billing.
func (m *Module) InternalRoutes(r chi.Router) { m.http.InternalRoutes(r) }

// Project registers the catalog and reservation copies and the check-out reaction.
func (m *Module) Project(p *projector.Projector) {
	postgres.Projections{DB: m.db, CheckedOut: m.closed.Handle, Voided: m.voided.Handle}.Register(p)
}

// Client is billing.Client in process.
func (m *Module) Client() billing.Client { return m.http.Commands.Desk }
