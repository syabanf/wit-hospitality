// Package http maps the finance context onto the contract paths the TypeScript HTTP adapter calls
// for the finance, ledger, cashier and budget ports, and serves the finance client's internal routes.
package http

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/finance/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// Commands are the finance write handlers.
type Commands struct {
	CreateTransaction       command.CreateTransaction
	Transition              command.Transition
	Reverse                 command.Reverse
	Transfer                command.Transfer
	Adjust                  command.Adjust
	Reconcile               command.Reconcile
	Attach                  command.Attach
	Detach                  command.Detach
	SaveAccount             command.SaveAccount
	SaveCategory            command.SaveCategory
	SaveRule                command.SaveRule
	DeleteRule              command.DeleteRule
	SaveProofPolicy         command.SaveProofPolicy
	MapCategory             command.MapCategory
	SaveCode                command.SaveCode
	SetCodeActive           command.SetCodeActive
	SaveTax                 command.SaveTax
	SaveBudget              command.SaveBudget
	CreateManualJournal     command.CreateManualJournal
	TransitionManualJournal command.TransitionManualJournal
	ClosePeriod             command.ClosePeriod
	ReopenPeriod            command.ReopenPeriod
	SaveShiftPolicy         command.SaveShiftPolicy
	OpenShift               command.OpenShift
	CloseShift              command.CloseShift
	SignOffShift            command.SignOffShift
	DropShift               command.DropShift
}

// Handler serves the finance routes.
type Handler struct {
	Commands Commands
	Queries  query.Queries
	Client   query.Client
	Log      *slog.Logger
}

func read[T any](log *slog.Logger, get func(ctx context.Context) (T, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := get(r.Context())
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	})
}

func write[In, Out any](log *slog.Logger, status int, run func(r *http.Request, p auth.Principal, in In) (Out, error)) http.HandlerFunc {
	return httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		var in In
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		out, err := run(r, p, in)
		if err != nil {
			return err
		}
		httpx.JSON(w, status, out)
		return nil
	})
}

// act runs a command whose body may be empty.
func act[Out any](log *slog.Logger, run func(r *http.Request, p auth.Principal) (Out, error)) http.HandlerFunc {
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

type note struct {
	Note string `json:"note"`
}

type reason struct {
	Reason string `json:"reason"`
}

var transactionAction = map[string]string{"submit": domain.Submitted, "approve": domain.Approved, "reject": domain.Rejected, "post": domain.Posted}

// Routes registers the routes under /api/v1.
func (h Handler) Routes(r chi.Router) {
	c, q, log := h.Commands, h.Queries, h.Log
	id := func(r *http.Request) string { return chi.URLParam(r, "id") }
	created, ok := http.StatusCreated, http.StatusOK

	r.Get("/cash-accounts", read(log, q.Accounts))
	r.Post("/cash-accounts", write(log, created, func(r *http.Request, p auth.Principal, in domain.CashAccountInput) (domain.CashAccount, error) {
		return c.SaveAccount.Handle(r.Context(), p, "", in)
	}))
	r.Patch("/cash-accounts/{id}", write(log, ok, func(r *http.Request, p auth.Principal, in domain.CashAccountInput) (domain.CashAccount, error) {
		return c.SaveAccount.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/categories", read(log, q.Categories))
	r.Post("/categories", write(log, created, func(r *http.Request, p auth.Principal, in domain.CategoryInput) (domain.Category, error) {
		return c.SaveCategory.Handle(r.Context(), p, "", in)
	}))
	r.Patch("/categories/{id}", write(log, ok, func(r *http.Request, p auth.Principal, in domain.CategoryInput) (domain.Category, error) {
		return c.SaveCategory.Handle(r.Context(), p, id(r), in)
	}))

	r.Get("/transactions", read(log, q.Transactions))
	r.Post("/transactions", write(log, created, func(r *http.Request, p auth.Principal, in command.NewTransaction) (domain.Transaction, error) {
		return c.CreateTransaction.Handle(r.Context(), p, in)
	}))
	r.Post("/transactions/transfers", write(log, created, func(r *http.Request, p auth.Principal, in domain.TransferInput) (domain.Transaction, error) {
		return c.Transfer.Handle(r.Context(), p, in)
	}))
	r.Post("/transactions/adjustments", write(log, created, func(r *http.Request, p auth.Principal, in domain.AdjustmentInput) (domain.Transaction, error) {
		return c.Adjust.Handle(r.Context(), p, in)
	}))
	for action, to := range transactionAction {
		r.Post("/transactions/{id}/"+action, write(log, ok, func(r *http.Request, p auth.Principal, in note) (domain.Transaction, error) {
			return c.Transition.Handle(r.Context(), p, id(r), to, in.Note)
		}))
		r.Post("/ledger/manual-journals/{id}/"+action, write(log, ok, func(r *http.Request, p auth.Principal, in note) (domain.ManualJournal, error) {
			return c.TransitionManualJournal.Handle(r.Context(), p, id(r), to, in.Note)
		}))
	}
	r.Post("/transactions/{id}/reverse", write(log, ok, func(r *http.Request, p auth.Principal, in reason) (domain.Transaction, error) {
		return c.Reverse.Handle(r.Context(), p, id(r), in.Reason)
	}))
	r.Post("/transactions/{id}/attachments", write(log, ok, func(r *http.Request, p auth.Principal, in struct {
		AttachmentIDs []string `json:"attachmentIds"`
	}) (domain.Transaction, error) {
		return c.Attach.Handle(r.Context(), p, id(r), in.AttachmentIDs)
	}))
	r.Delete("/transactions/{id}/attachments/{attachmentId}", act(log, func(r *http.Request, p auth.Principal) (domain.Transaction, error) {
		return c.Detach.Handle(r.Context(), p, id(r), chi.URLParam(r, "attachmentId"))
	}))

	r.Get("/reconciliations", read(log, q.Reconciliations))
	r.Post("/reconciliations", write(log, created, func(r *http.Request, p auth.Principal, in domain.ReconciliationInput) (domain.Reconciliation, error) {
		return c.Reconcile.Handle(r.Context(), p, in)
	}))

	r.Get("/approval-rules", read(log, q.Rules))
	r.Post("/approval-rules", write(log, created, func(r *http.Request, p auth.Principal, in domain.ApprovalRuleInput) (domain.ApprovalRule, error) {
		return c.SaveRule.Handle(r.Context(), p, "", in)
	}))
	r.Patch("/approval-rules/{id}", write(log, ok, func(r *http.Request, p auth.Principal, in domain.ApprovalRuleInput) (domain.ApprovalRule, error) {
		return c.SaveRule.Handle(r.Context(), p, id(r), in)
	}))
	r.Delete("/approval-rules/{id}", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		if err := c.DeleteRule.Handle(r.Context(), p, id(r)); err != nil {
			return err
		}
		httpx.NoContent(w)
		return nil
	}))

	r.Get("/settings/proof-policy", read(log, q.ProofPolicy))
	r.Put("/settings/proof-policy", write(log, ok, func(r *http.Request, p auth.Principal, in struct {
		Threshold float64 `json:"threshold"`
	}) (domain.ProofPolicy, error) {
		return c.SaveProofPolicy.Handle(r.Context(), p, in.Threshold)
	}))

	r.Get("/ledger/accounts", read(log, q.Chart))
	r.Get("/ledger/category-accounts", read(log, q.CategoryAccounts))
	r.Put("/ledger/category-accounts/{id}", write(log, ok, func(r *http.Request, p auth.Principal, in struct {
		AccountID string `json:"accountId"`
	}) (map[string]string, error) {
		return c.MapCategory.Handle(r.Context(), p, id(r), in.AccountID)
	}))
	r.Get("/ledger/transaction-codes", read(log, q.Codes))
	r.Post("/ledger/transaction-codes", write(log, created, func(r *http.Request, p auth.Principal, in domain.TransactionCodeInput) (domain.TransactionCode, error) {
		return c.SaveCode.Handle(r.Context(), p, "", in)
	}))
	r.Put("/ledger/transaction-codes/{id}", write(log, ok, func(r *http.Request, p auth.Principal, in domain.TransactionCodeInput) (domain.TransactionCode, error) {
		return c.SaveCode.Handle(r.Context(), p, id(r), in)
	}))
	r.Patch("/ledger/transaction-codes/{id}", write(log, ok, func(r *http.Request, p auth.Principal, in struct {
		Active *bool `json:"active"`
	}) (domain.TransactionCode, error) {
		if in.Active == nil {
			return domain.TransactionCode{}, errs.Invalid("active", "Say whether the code is active.")
		}
		return c.SetCodeActive.Handle(r.Context(), p, id(r), *in.Active)
	}))
	r.Get("/ledger/journals", read(log, q.Journals))
	r.Get("/ledger/manual-journals", read(log, q.ManualJournals))
	r.Post("/ledger/manual-journals", write(log, created, func(r *http.Request, p auth.Principal, in command.NewManualJournal) (domain.ManualJournal, error) {
		return c.CreateManualJournal.Handle(r.Context(), p, in)
	}))
	r.Get("/ledger/periods", read(log, q.Periods))
	r.Post("/ledger/periods/{month}/close", write(log, ok, func(r *http.Request, p auth.Principal, in note) (domain.PeriodClose, error) {
		return c.ClosePeriod.Handle(r.Context(), p, chi.URLParam(r, "month"), in.Note)
	}))
	r.Post("/ledger/periods/{month}/reopen", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		p, err := auth.Require(r.Context())
		if err != nil {
			return err
		}
		var in reason
		if err := httpx.Decode(r, &in); err != nil {
			return err
		}
		if err := c.ReopenPeriod.Handle(r.Context(), p, chi.URLParam(r, "month"), in.Reason); err != nil {
			return err
		}
		httpx.NoContent(w)
		return nil
	}))
	r.Get("/ledger/tax-settings", read(log, q.Tax))
	r.Put("/ledger/tax-settings", write(log, ok, func(r *http.Request, p auth.Principal, in domain.TaxSettingsInput) (domain.TaxSettings, error) {
		return c.SaveTax.Handle(r.Context(), p, in)
	}))

	r.Get("/budgets", read(log, q.Budgets))
	r.Put("/budgets/{villaId}/{year}", write(log, ok, func(r *http.Request, p auth.Principal, in domain.BudgetInput) (domain.Budget, error) {
		in.VillaID = chi.URLParam(r, "villaId")
		if y, err := strconv.Atoi(chi.URLParam(r, "year")); err == nil {
			in.Year = float64(y)
		}
		return c.SaveBudget.Handle(r.Context(), p, in)
	}))

	r.Get("/cashier-shifts", read(log, q.Shifts))
	r.Get("/cashier-shifts/hand-overs", read(log, q.HandOvers))
	r.Get("/cashier-shifts/policy", read(log, q.ShiftPolicy))
	r.Put("/cashier-shifts/policy", write(log, ok, func(r *http.Request, p auth.Principal, in struct {
		Tolerance float64 `json:"tolerance"`
	}) (domain.ShiftPolicy, error) {
		return c.SaveShiftPolicy.Handle(r.Context(), p, in.Tolerance)
	}))
	r.Post("/cashier-shifts", write(log, created, func(r *http.Request, p auth.Principal, in domain.OpenShiftInput) (domain.CashierShift, error) {
		return c.OpenShift.Handle(r.Context(), p, in)
	}))
	r.Post("/cashier-shifts/{id}/close", write(log, ok, func(r *http.Request, p auth.Principal, in domain.CloseShiftInput) (domain.CashierShift, error) {
		return c.CloseShift.Handle(r.Context(), p, id(r), in)
	}))
	r.Post("/cashier-shifts/{id}/sign-off", write(log, ok, func(r *http.Request, p auth.Principal, in note) (domain.CashierShift, error) {
		return c.SignOffShift.Handle(r.Context(), p, id(r), in.Note)
	}))
	r.Post("/cashier-shifts/{id}/drop", write(log, ok, func(r *http.Request, p auth.Principal, in domain.DropInput) (domain.CashierShift, error) {
		return c.DropShift.Handle(r.Context(), p, id(r), in)
	}))
}

// InternalRoutes serves the finance client under /internal/v1/finance, guarded by INTERNAL_TOKEN.
func (h Handler) InternalRoutes(r chi.Router) {
	cl, log := h.Client, h.Log
	r.Get("/finance/entries", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		out, err := cl.Entries(r.Context(), finance.Source{Type: q.Get("sourceType"), ID: q.Get("sourceId")})
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Get("/finance/proof-policy", read(log, cl.ProofPolicy))
	r.Get("/finance/open-shift", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		out, err := cl.OpenShift(r.Context(), r.URL.Query().Get("locationId"))
		if err != nil {
			return err
		}
		httpx.OK(w, out)
		return nil
	}))
	r.Get("/finance/service-charge", httpx.Handle(log, func(w http.ResponseWriter, r *http.Request) error {
		n, err := cl.BilledServiceCharge(r.Context(), r.URL.Query().Get("month"))
		if err != nil {
			return err
		}
		httpx.OK(w, map[string]int64{"amount": n})
		return nil
	}))
}
