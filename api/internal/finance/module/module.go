// Package module wires the finance context: repository, commands, queries, policies, HTTP routes,
// the finance client and the projections of other contexts' events. It depends on identity only
// through rbac.Source.
package module

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/finance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/finance/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	financehttp "github.com/syabanf/wit-hospitality/api/internal/finance/ports/http"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/inventory"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/owners"
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
	// Files resolves uploaded files by id; nil answers NOT_AVAILABLE until the files context runs.
	Files command.Files
}

// Module is the wired context.
type Module struct {
	db       *db.DB
	http     financehttp.Handler
	policies command.Policies
}

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
		Files: d.Files}
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
			SaveProofPolicy: command.SaveProofPolicy{Deps: deps}, MapCategory: command.MapCategory{Deps: deps},
			SaveBudget:          command.SaveBudget{Deps: deps},
			CreateManualJournal: command.CreateManualJournal{Deps: deps}, TransitionManualJournal: command.TransitionManualJournal{Deps: deps},
			ClosePeriod: command.ClosePeriod{Deps: deps}, ReopenPeriod: command.ReopenPeriod{Deps: deps},
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
	ConsumerPayroll      = "finance.payroll"
	ConsumerReservation  = "finance.reservation"
	ConsumerBilling      = "finance.billing"
	ConsumerMaintenance  = "finance.maintenance"
	ConsumerInventory    = "finance.inventory"
	ConsumerOwners       = "finance.owners"
	ConsumerHousekeeping = "finance.housekeeping"
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
	on(p, ConsumerBilling, billing.EventPaymentRecorded, pol.PaymentRecorded)
	on(p, ConsumerBilling, billing.EventPaymentRefunded, pol.PaymentRefunded)
	on(p, ConsumerBilling, billing.EventFolioLinePosted, pol.FolioLinePosted)
	on(p, ConsumerBilling, billing.EventFolioLineVoided, pol.FolioLineVoided)
	on(p, ConsumerBilling, billing.EventNightAudited, pol.NightAudited)
	on(p, ConsumerBilling, billing.EventStayCheckedOut, pol.StayCheckedOut)
	on(p, ConsumerBilling, billing.EventCityLedgerTransferred, pol.CityLedgerTransferred)
	on(p, ConsumerBilling, billing.EventCityLedgerInvoiceIssued, pol.CityLedgerInvoiced)
	on(p, ConsumerBilling, billing.EventCityLedgerPaymentRecvd, pol.CityLedgerPaid)
	on(p, ConsumerBilling, billing.EventCityLedgerWrittenOff, pol.CityLedgerWrittenOff)
	on(p, ConsumerBilling, billing.EventTaxSettingsChanged, pol.TaxSettingsChanged)
	on(p, ConsumerBilling, billing.EventTransactionCodeSaved, pol.TransactionCodeSaved)
	on(p, ConsumerBilling, billing.EventShiftClosed, pol.ShiftClosed)
	on(p, ConsumerBilling, billing.EventShiftDropped, pol.ShiftDropped)
	on(p, ConsumerOwners, owners.EventStatementClosed, pol.StatementClosed)
	on(p, ConsumerOwners, owners.EventStatementReopened, pol.StatementReopened)
	on(p, ConsumerOwners, owners.EventPayoutRequested, pol.PayoutRequested)
	on(p, ConsumerHousekeeping, housekeeping.EventLaundryBilled, pol.LaundryBilled)
	on(p, ConsumerMaintenance, maintenance.EventExpenseSubmitted, pol.CashOutSubmitted(command.SourceExpense))
	on(p, ConsumerMaintenance, maintenance.EventExpenseResubmitted, pol.CashOutResubmitted)
	on(p, ConsumerInventory, inventory.EventPurchaseSubmitted, pol.CashOutSubmitted(command.SourcePurchase))
	on(p, ConsumerInventory, inventory.EventPurchaseResubmitted, pol.CashOutResubmitted)
	on(p, ConsumerInventory, inventory.EventPurchaseCancelled, pol.PurchaseCancelled)
}

// Seed loads seed/finance.json moved to today.
func Seed(ctx context.Context, d *db.DB, raw []byte, today string) (int, error) {
	data, err := postgres.ParseSeed(raw)
	if err != nil {
		return 0, err
	}
	return len(data.Transactions), postgres.Seed(ctx, d, data, today)
}
