package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/maintenance"
	"github.com/syabanf/wit-hospitality/api/internal/maintenance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// withPayee is the application's withPayee: a vendor line without a typed payee pays the vendor.
func (d Deps) withPayee(ctx context.Context, in domain.ExpenseInput) (domain.ExpenseInput, error) {
	if strings.TrimSpace(in.Payee) != "" || in.VendorID == nil || *in.VendorID == "" {
		return in, nil
	}
	v, err := d.Repo.Vendor(ctx, *in.VendorID)
	if errs.HasCode(err, errs.CodeNotFound) {
		return in, nil
	}
	in.Payee = v.Name
	return in, err
}

// cashOut is expenseFields: the cash-out that pays one expense line, mapped to the job's unit.
func cashOut(w domain.WorkOrder, villa Villa, line int, in domain.ExpenseInput) maintenance.CashOut {
	attachments := make([]maintenance.Attachment, 0, len(in.Receipts))
	for _, a := range in.Receipts {
		attachments = append(attachments, maintenance.Attachment(a))
	}
	return maintenance.CashOut{
		Origin: "maintenance", SourceID: w.ID, Kind: "cash_out", CategoryID: "cat-maint", Method: in.Method,
		Amount: int64(in.Amount), Date: in.PaidOn, LocationID: villa.LocationID, VillaID: w.VillaID, UnitID: w.UnitID,
		Description: domain.ExpenseDescription(w.Number, in), Reference: domain.ExpenseReference(w.Number, line), Attachments: attachments,
	}
}

// AddExpense pays for part of a job: one submitted cash-out per line, through finance's approval
// chain. It needs maintenance/submit; the work must have started.
type AddExpense struct{ Deps }

// Handle adds the expense line and submits its cash-out.
func (h AddExpense) Handle(ctx context.Context, p auth.Principal, id string, in domain.ExpenseInput) (domain.WorkOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, needSubmit); err != nil {
		return domain.WorkOrder{}, err
	}
	var w domain.WorkOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if w, err = h.Repo.WorkOrder(ctx, id); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, w.VillaID)
		if err != nil {
			return err
		}
		if err := w.CheckCanAddExpense(); err != nil {
			return err
		}
		if in, err = h.withPayee(ctx, in); err != nil {
			return err
		}
		if err := domain.ValidateExpense(in); err != nil {
			return err
		}
		if in.VendorID != nil && *in.VendorID != "" {
			if _, err := h.Repo.Vendor(ctx, *in.VendorID); err != nil {
				return err
			}
		}
		line := w.NextLine()
		t, err := h.CashOuts.Submit(ctx, p, cashOut(w, villa, line, in))
		if err != nil {
			return err
		}
		w.Expenses = append(w.Expenses, domain.NewExpense(w, line, in, t.ID, p.Name, h.today()))
		w.Log("cost", p.Name, h.today(), fmt.Sprintf("%s: %s %d", t.Number, domain.ExpenseKindLabel[in.Kind], int64(in.Amount)))
		if err := h.Repo.UpdateWorkOrder(ctx, &w); err != nil {
			return err
		}
		return h.saved(ctx, w, villa.LocationID)
	})
	return w, err
}

// CorrectExpense fixes an expense whose cash-out finance rejected and sends it back for approval.
// It needs maintenance/submit.
type CorrectExpense struct{ Deps }

// Handle corrects the line and resubmits its cash-out.
func (h CorrectExpense) Handle(ctx context.Context, p auth.Principal, id, expenseID string, in domain.ExpenseInput) (domain.WorkOrder, error) {
	if err := h.Authz.Require(ctx, p.Role, needSubmit); err != nil {
		return domain.WorkOrder{}, err
	}
	var w domain.WorkOrder
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if w, err = h.Repo.WorkOrder(ctx, id); err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, w.VillaID)
		if err != nil {
			return err
		}
		e, err := w.Expense(expenseID)
		if err != nil {
			return err
		}
		t, err := h.CashOuts.Status(ctx, e.TransactionID)
		if err != nil {
			return err
		}
		if t.Status != "rejected" {
			return errs.Newf("TRANSACTION_INVALID_STATE", "%s is %s; only a rejected expense can be corrected.", t.Number, t.Status)
		}
		if in, err = h.withPayee(ctx, in); err != nil {
			return err
		}
		if err := domain.ValidateExpense(in); err != nil {
			return err
		}
		before := map[string]any{"amount": e.Amount}
		req := cashOut(w, villa, e.Line, in)
		if _, err := h.CashOuts.Correct(ctx, p, t.ID, req, "Corrected from the work order"); err != nil {
			return err
		}
		w.CorrectExpense(expenseID, in)
		w.Log("cost", p.Name, h.today(), t.Number+" corrected and resubmitted")
		if err := h.Repo.UpdateWorkOrder(ctx, &w); err != nil {
			return err
		}
		if err := h.saved(ctx, w, villa.LocationID); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{
			Action: audit.Update, Entity: "transaction", EntityID: t.Number, Summary: fmt.Sprintf("Corrected %s on %s and resubmitted it", t.Number, w.Number),
			Before: before, After: map[string]any{"amount": req.Amount, "description": req.Description},
		})
	})
	return w, err
}
