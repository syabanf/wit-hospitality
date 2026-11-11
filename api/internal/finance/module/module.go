// Package module wires the finance context: repository, commands, queries, policies, HTTP routes,
// the finance client and the projections of other contexts' events. It depends on identity only
// through rbac.Source.
package module

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/finance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/finance/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	financehttp "github.com/syabanf/wit-hospitality/api/internal/finance/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// Deps is what the finance context needs from the process.
type Deps struct {
	DB          *db.DB
	Clock       clock.Clock
	Permissions rbac.Source
	Log         *slog.Logger
	// BusinessDate is billing's business date; nil reads the calendar date.
	BusinessDate command.BusinessDate
	// Files resolves uploaded files by id; nil answers NOT_AVAILABLE until the files context runs.
	Files command.Files
}

// Module is the wired context.
type Module struct {
	db       *db.DB
	http     financehttp.Handler
	policies command.Policies
}

type calendar struct{ clock.Clock }

func (c calendar) BusinessDate(context.Context) (string, error) { return clock.Today(c.Clock), nil }

type noFiles struct{}

func (noFiles) Attachments(_ context.Context, ids []string) ([]domain.Attachment, error) {
	if len(ids) == 0 {
		return []domain.Attachment{}, nil
	}
	return nil, errs.New("NOT_AVAILABLE", "Uploaded files are not available yet; attach the receipt when you record the entry.")
}

// New wires the finance context.
func New(d Deps) *Module {
	deps := command.Deps{DB: d.DB, Repo: postgres.Repo{DB: d.DB}, Authz: rbac.Authorizer{Source: d.Permissions}, Audit: audit.Recorder{DB: d.DB, Clock: d.Clock}, Clock: d.Clock,
		Roster: postgres.Roster{DB: d.DB}, BusinessDate: d.BusinessDate, Files: d.Files}
	if deps.BusinessDate == nil {
		deps.BusinessDate = calendar{d.Clock}
	}
	if deps.Files == nil {
		deps.Files = noFiles{}
	}
	q := query.Queries{Deps: deps}
	return &Module{db: d.DB, policies: command.Policies{Deps: deps}, http: financehttp.Handler{
		Commands: financehttp.Commands{
			CreateTransaction: command.CreateTransaction{Deps: deps}, Transition: command.Transition{Deps: deps}, Reverse: command.Reverse{Deps: deps},
			Transfer: command.Transfer{Deps: deps}, Adjust: command.Adjust{Deps: deps}, Reconcile: command.Reconcile{Deps: deps},
			Attach: command.Attach{Deps: deps}, Detach: command.Detach{Deps: deps}, SaveAccount: command.SaveAccount{Deps: deps},
			SaveCategory: command.SaveCategory{Deps: deps}, SaveRule: command.SaveRule{Deps: deps}, DeleteRule: command.DeleteRule{Deps: deps},
			SaveProofPolicy: command.SaveProofPolicy{Deps: deps}, MapCategory: command.MapCategory{Deps: deps}, SaveCode: command.SaveCode{Deps: deps},
			SetCodeActive: command.SetCodeActive{Deps: deps}, SaveTax: command.SaveTax{Deps: deps}, SaveBudget: command.SaveBudget{Deps: deps},
			CreateManualJournal: command.CreateManualJournal{Deps: deps}, TransitionManualJournal: command.TransitionManualJournal{Deps: deps},
			ClosePeriod: command.ClosePeriod{Deps: deps}, ReopenPeriod: command.ReopenPeriod{Deps: deps}, SaveShiftPolicy: command.SaveShiftPolicy{Deps: deps},
			OpenShift: command.OpenShift{Deps: deps}, CloseShift: command.CloseShift{Deps: deps}, SignOffShift: command.SignOffShift{Deps: deps},
			DropShift: command.DropShift{Deps: deps},
		},
		Queries: q,
		Client:  query.Client{Queries: q},
		Log:     d.Log,
	}}
}

// Migrations is the finance context's migration set.
func Migrations() migrations.Set { return postgres.Migrations() }

// Routes registers the public routes.
func (m *Module) Routes(r chi.Router) { m.http.Routes(r) }

// InternalRoutes serves the finance client to services in other processes.
func (m *Module) InternalRoutes(r chi.Router) { m.http.InternalRoutes(r) }

// Client is the in-process finance client.
func (m *Module) Client() finance.Client { return m.http.Client }

// Consumers of other contexts' events.
const (
	ConsumerPayroll     = "finance.payroll"
	ConsumerReservation = "finance.reservation"
	ConsumerBilling     = "finance.billing"
	ConsumerMaintenance = "finance.maintenance"
	ConsumerInventory   = "finance.inventory"
)

func on[T any](p *projector.Projector, consumer, eventType string, h func(context.Context, T) error) {
	p.On(consumer, eventType, func(ctx context.Context, m bus.Message) error {
		var v T
		if err := json.Unmarshal(m.Payload, &v); err != nil {
			return err
		}
		return h(ctx, v)
	})
}

// Project registers the catalog copy, the roster and the policies on other contexts' events.
func (m *Module) Project(p *projector.Projector) {
	postgres.Catalog{DB: m.db}.Register(p)
	pol := m.policies
	on(p, ConsumerPayroll, payroll.EventPeriodClosed, pol.PayrollClosed)
	on(p, ConsumerReservation, reservation.EventBookingSaved, pol.BookingSaved)
	on(p, ConsumerReservation, reservation.EventBookingStatusChanged, pol.BookingStatusChanged)
	on(p, ConsumerReservation, reservation.EventWalkRecorded, pol.WalkRecorded)
	on(p, ConsumerBilling, command.EventPaymentRecorded, pol.PaymentRecorded)
	on(p, ConsumerBilling, command.EventPaymentRefunded, pol.PaymentRefunded)
	on(p, ConsumerBilling, command.EventFolioLinePosted, pol.FolioLinePosted)
	on(p, ConsumerBilling, command.EventFolioLineVoided, pol.FolioLineVoided)
	on(p, ConsumerBilling, command.EventNightAudited, pol.NightAudited)
	on(p, ConsumerBilling, command.EventStayCheckedOut, pol.StayCheckedOut)
	on(p, ConsumerBilling, command.EventCityLedgerTransferred, pol.CityLedgerTransferred)
	on(p, ConsumerBilling, command.EventCityLedgerInvoiced, pol.CityLedgerInvoiced)
	on(p, ConsumerBilling, command.EventCityLedgerPaid, pol.CityLedgerPaid)
	on(p, ConsumerBilling, command.EventCityLedgerWrittenOff, pol.CityLedgerWrittenOff)
	on(p, ConsumerBilling, command.EventTaxSettingsChanged, pol.TaxSettingsChanged)
	on(p, ConsumerMaintenance, command.EventMaintenanceExpense, pol.MaintenanceExpense)
	on(p, ConsumerInventory, command.EventStockPurchase, pol.StockPurchase)
}

// Seed loads seed/finance.json moved to today.
func Seed(ctx context.Context, d *db.DB, raw []byte, today string) (int, error) {
	data, err := postgres.ParseSeed(raw)
	if err != nil {
		return 0, err
	}
	return len(data.Transactions), postgres.Seed(ctx, d, data, today)
}
