// Package http maps the billing context onto the contract paths the TypeScript HTTP adapter calls
// for the folio, payment, audit, cashier, city ledger and ledger settings ports, and serves the
// billing client to other services under /internal/v1/billing.
package http

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the billing write handlers.
type Commands struct {
	Folio         command.FolioPostings
	PostCharge    command.PostCharge
	PostRebate    command.PostRebate
	RecordPayment command.RecordPayment
	CreateLink    command.CreateLink
	CancelLink    command.CancelLink
	Refund        command.Refund
	Checkout      command.Checkout
	SavePolicy    command.SavePolicy
	RunAudit      command.RunAudit
	Cashier       command.Cashier
	SaveShift     command.SaveShiftPolicy
	SaveAccount   command.SaveAccount
	SetBilling    command.SetBilling
	Transfer      command.Transfer
	TransferGroup command.TransferGroup
	IssueInvoice  command.IssueInvoice
	SendInvoice   command.SendInvoice
	LedgerPayment command.RecordLedgerPayment
	ApplyCredit   command.ApplyCredit
	WriteOff      command.WriteOff
	SaveTax       command.SaveTax
	SaveCode      command.SaveCode
	Desk          command.Desk
}

// Handler serves the billing routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Clock    clock.Clock
	Log      *slog.Logger
}

// write decodes the body, runs the command as the signed-in user and answers with status.
func write[In, Out any](log *slog.Logger, status int, run func(r *http.Request, p auth.Principal, in In) (Out, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		var in In
		if _, empty := any(in).(none); !empty {
			if err := httpx.Decode(r, &in); err != nil {
				return err
			}
		}
		out, err := run(r, p, in)
		if err != nil {
			return err
		}
		httpx.JSON(w, status, out)
		return nil
	})
}

// read answers a read as the signed-in user.
func read[Out any](log *slog.Logger, run func(r *http.Request, p auth.Principal) (Out, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		out, err := run(r, p)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	})
}

// public answers without a session: the guest's payment page.
func public[In, Out any](log *slog.Logger, run func(r *http.Request, in In) (Out, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		var in In
		if r.Method != http.MethodGet {
			if err := httpx.Decode(r, &in); err != nil {
				return err
			}
		}
		out, err := run(r, in)
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	})
}

// none is the body of an action that takes none; it is not read.
type none struct{}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }
	list := func(table string) http.HandlerFunc {
		return read(log, func(r *http.Request, p auth.Principal) ([]json.RawMessage, error) {
			return q.List(r.Context(), p, table)
		})
	}
	setting := func(key string) http.HandlerFunc {
		return read(log, func(r *http.Request, _ auth.Principal) (any, error) { return q.Setting(r.Context(), key) })
	}

	// Folio.
	r.Get("/bookings/{id}/folio", read(log, func(r *http.Request, p auth.Principal) ([]domain.Posting, error) {
		out, err := c.Folio.Handle(r.Context(), p, id(r))
		if out == nil {
			out = []domain.Posting{}
		}
		return out, err
	}))
	r.Post("/bookings/{id}/folio/charges", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.ChargeInput) (domain.Posting, error) {
		return c.PostCharge.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/bookings/{id}/folio/rebates", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.RebateInput) (domain.Posting, error) {
		return c.PostRebate.Handle(r.Context(), p, id(r), in)
	}))

	// City ledger billing and transfers.
	r.Put("/bookings/{id}/city-ledger-billing", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.BillingBody) (*domain.Billing, error) {
		return c.SetBilling.Booking(r.Context(), p, id(r), in)
	}))
	r.Put("/booking-groups/{id}/city-ledger-billing", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in command.BillingBody) (*domain.Billing, error) {
		return c.SetBilling.Group(r.Context(), p, id(r), in)
	}))
	r.Post("/bookings/{id}/folio/city-ledger", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.TransferInput) ([]domain.Posting, error) {
		return c.Transfer.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/booking-groups/{id}/city-ledger", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.TransferInput) ([]domain.Posting, error) {
		return c.TransferGroup.Handle(r.Context(), p, id(r), in.AccountID)
	}))
	r.Get("/city-ledger/accounts", list(command.Accounts))
	r.Post("/city-ledger/accounts", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.AccountInput) (domain.Account, error) {
		return c.SaveAccount.Handle(r.Context(), p, "", in)
	}))
	r.Patch("/city-ledger/accounts/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.AccountInput) (domain.Account, error) {
		return c.SaveAccount.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/city-ledger/accounts/{id}/apply-credit", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, _ none) ([]domain.LedgerPayment, error) {
		return c.ApplyCredit.Handle(r.Context(), p, id(r))
	}))
	r.Post("/city-ledger/accounts/{id}/invoices", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in struct {
		Through string `json:"through"`
	}) (domain.Invoice, error) {
		return c.IssueInvoice.Handle(r.Context(), p, id(r), in.Through)
	}))
	r.Get("/city-ledger/invoices", list(command.Invoices))
	r.Post("/city-ledger/invoices/{id}/send", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, _ none) (domain.Invoice, error) {
		return c.SendInvoice.Handle(r.Context(), p, id(r))
	}))
	r.Get("/city-ledger/payments", list(command.LedgerPayments))
	r.Post("/city-ledger/payments", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.LedgerPaymentInput) (domain.LedgerPayment, error) {
		return c.LedgerPayment.Handle(r.Context(), p, in)
	}))
	r.Get("/city-ledger/transfers", read(log, func(r *http.Request, p auth.Principal) ([]json.RawMessage, error) { return q.Transfers(r.Context(), p) }))
	r.Get("/city-ledger/write-offs", list(command.WriteOffs))
	r.Post("/city-ledger/write-offs", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.WriteOffInput) (domain.WriteOff, error) {
		return c.WriteOff.Handle(r.Context(), p, in)
	}))

	// Payments and links.
	r.Get("/payments", list(command.Payments))
	r.Post("/payments", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.PaymentInput) (domain.Payment, error) {
		return c.RecordPayment.Handle(r.Context(), p, in)
	}))
	r.Get("/payments/policy", setting(command.SettingPaymentPolicy))
	r.Put("/payments/policy", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.Policy) (domain.Policy, error) {
		return c.SavePolicy.Handle(r.Context(), p, in)
	}))
	r.Post("/payments/{id}/refund", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.RefundInput) (domain.Payment, error) {
		return c.Refund.Handle(r.Context(), p, id(r), in)
	}))
	r.Get("/payment-links", list(command.Links))
	r.Post("/payment-links", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in command.NewLink) (domain.PaymentLink, error) {
		return c.CreateLink.Handle(r.Context(), p, in)
	}))
	r.Post("/payment-links/{id}/cancel", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, _ none) (domain.PaymentLink, error) {
		return c.CancelLink.Handle(r.Context(), p, id(r))
	}))
	r.Get("/pay/{id}", public(log, func(r *http.Request, _ none) (domain.PublicCheckout, error) {
		return c.Checkout.View(r.Context(), id(r))
	}))
	r.Post("/pay/{id}/simulate", public(log, func(r *http.Request, in struct {
		Outcome string `json:"outcome"`
	}) (domain.PublicCheckout, error) {
		return c.Checkout.Simulate(r.Context(), id(r), in.Outcome)
	}))
	r.Post("/pay/{id}/proof", public(log, func(r *http.Request, in struct {
		AttachmentID string `json:"attachmentId"`
	}) (domain.PublicCheckout, error) {
		return c.Checkout.Proof(r.Context(), id(r), in.AttachmentID)
	}))

	// Night audit.
	r.Get("/night-audits", list(command.Audits))
	r.Get("/night-audits/business-date", read(log, func(r *http.Request, _ auth.Principal) (map[string]string, error) {
		date, err := q.BusinessDate(r.Context(), clock.Today(h.Clock))
		return map[string]string{"date": date}, err
	}))
	r.Post("/night-audits", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.AuditRunInput) (domain.NightAudit, error) {
		return c.RunAudit.Handle(r.Context(), p, in)
	}))

	// Cashier shifts.
	r.Get("/cashier-shifts", list(command.Shifts))
	r.Get("/cashier-shifts/hand-overs", list(command.HandOvers))
	r.Get("/cashier-shifts/policy", setting(command.SettingShiftPolicy))
	r.Put("/cashier-shifts/policy", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.ShiftPolicy) (domain.ShiftPolicy, error) {
		return c.SaveShift.Handle(r.Context(), p, in)
	}))
	r.Post("/cashier-shifts", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.OpenShiftInput) (domain.Shift, error) {
		return c.Cashier.Open(r.Context(), p, in)
	}))
	r.Post("/cashier-shifts/{id}/close", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.CloseShiftInput) (domain.Shift, error) {
		return c.Cashier.Close(r.Context(), p, id(r), in)
	}))
	r.Post("/cashier-shifts/{id}/sign-off", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in struct {
		Note string `json:"note"`
	}) (domain.Shift, error) {
		return c.Cashier.SignOff(r.Context(), p, id(r), in.Note)
	}))
	r.Post("/cashier-shifts/{id}/drop", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.DropInput) (domain.Shift, error) {
		return c.Cashier.Drop(r.Context(), p, id(r), in)
	}))

	// Ledger settings billing owns.
	r.Get("/ledger/tax-settings", setting(command.SettingTax))
	r.Put("/ledger/tax-settings", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.TaxSettingsInput) (domain.TaxSettings, error) {
		return c.SaveTax.Handle(r.Context(), p, in)
	}))
	r.Get("/ledger/transaction-codes", read(log, func(r *http.Request, _ auth.Principal) ([]json.RawMessage, error) { return q.Codes(r.Context()) }))
	r.Post("/ledger/transaction-codes", write(log, http.StatusCreated, func(r *http.Request, p auth.Principal, in domain.TransactionCodeInput) (domain.TransactionCode, error) {
		return c.SaveCode.Create(r.Context(), p, in)
	}))
	r.Put("/ledger/transaction-codes/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in domain.TransactionCodeInput) (domain.TransactionCode, error) {
		return c.SaveCode.Update(r.Context(), p, id(r), in)
	}))
	r.Patch("/ledger/transaction-codes/{id}", write(log, http.StatusOK, func(r *http.Request, p auth.Principal, in struct {
		Active bool `json:"active"`
	}) (domain.TransactionCode, error) {
		return c.SaveCode.SetActive(r.Context(), p, id(r), in.Active)
	}))
}

// InternalRoutes serves billing.Client to services in split mode under /internal/v1/billing.
func (h Handler) InternalRoutes(r chi.Router) {
	d, log := h.Commands.Desk, h.Log
	call := func(run func(ctx context.Context, in billing.Call) (any, error)) http.HandlerFunc {
		return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
			var in billing.Call
			if err := httpx.Decode(r, &in); err != nil {
				return err
			}
			out, err := run(r.Context(), in)
			if err != nil {
				return err
			}
			if out == nil {
				httpx.NoContent(w)
				return nil
			}
			httpx.OK(w, out)
			return nil
		})
	}
	principal := func(in billing.Call) (auth.Principal, error) {
		if in.Principal == nil {
			return auth.Principal{}, errs.Unauthenticated()
		}
		return *in.Principal, nil
	}
	r.Post("/billing/owed", call(func(ctx context.Context, in billing.Call) (any, error) {
		owed, err := d.Owed(ctx, in.Stay)
		return map[string]int64{"owed": owed}, err
	}))
	r.Post("/billing/check-out-hold", call(func(ctx context.Context, in billing.Call) (any, error) { return nil, d.CheckOutHold(ctx, in.Stay) }))
	r.Post("/billing/settle", call(func(ctx context.Context, in billing.Call) (any, error) {
		p, err := principal(in)
		if err != nil {
			return nil, err
		}
		return d.Settle(ctx, p, in.Stay, in.Input)
	}))
	r.Post("/billing/group-payments", call(func(ctx context.Context, in billing.Call) (any, error) {
		p, err := principal(in)
		if err != nil {
			return nil, err
		}
		return d.GroupPayment(ctx, p, in.Group, in.Stays, in.Input)
	}))
	r.Post("/billing/pay-balance", call(func(ctx context.Context, in billing.Call) (any, error) { return d.PayBalance(ctx, in.Stay, in.Method) }))
	r.Post("/billing/city-ledger", call(func(ctx context.Context, in billing.Call) (any, error) {
		p, err := principal(in)
		if err != nil {
			return nil, err
		}
		return d.CityLedger(ctx, p, in.Input, in.Source, in.Stays)
	}))
	r.Post("/billing/policy", call(func(ctx context.Context, _ billing.Call) (any, error) { return d.Policy(ctx) }))
	r.Post("/billing/order-payments", call(func(ctx context.Context, in billing.Call) (any, error) { return d.OrderPayments(ctx, in.BookingID) }))
	r.Post("/billing/business-date", call(func(ctx context.Context, _ billing.Call) (any, error) {
		date, err := d.BusinessDate(ctx)
		return map[string]string{"date": date}, err
	}))
	r.Post("/billing/pay-orders", call(func(ctx context.Context, in billing.Call) (any, error) {
		return d.PayOrders(ctx, in.BookingID, in.Payer)
	}))
}
