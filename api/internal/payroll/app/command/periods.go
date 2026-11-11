package command

import (
	"context"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/payroll/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// SaveSettings replaces the payroll settings; it needs payroll/edit.
type SaveSettings struct{ Deps }

// Handle saves the settings.
func (h SaveSettings) Handle(ctx context.Context, p auth.Principal, s domain.Settings) (domain.Settings, error) {
	if err := h.Authz.Require(ctx, p.Role, payrollEdit...); err != nil {
		return domain.Settings{}, err
	}
	if err := domain.ValidateSettings(s); err != nil {
		return domain.Settings{}, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		before, version, err := h.Repo.Settings(ctx)
		if err != nil {
			return err
		}
		v, err := h.Repo.SaveSettings(ctx, s, version)
		if err != nil {
			return err
		}
		if err := h.emitSettings(ctx, s, v); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "payroll-settings", EntityID: "settings", Summary: "Changed the payroll settings", Before: before, After: s})
	})
	return s, err
}

func (d Deps) emitSettings(ctx context.Context, s domain.Settings, version int64) error {
	return appendEvent(ctx, d, payroll.EventSettingsSaved, "payroll_settings", "settings", version, payroll.SettingsSaved{Settings: s})
}

// CreatePeriod opens a month's payroll and computes its lines; it needs payroll/create.
type CreatePeriod struct{ Deps }

// Handle opens the period.
func (h CreatePeriod) Handle(ctx context.Context, p auth.Principal, month string) (domain.Period, error) {
	if err := h.Authz.Require(ctx, p.Role, payrollCreate...); err != nil {
		return domain.Period{}, err
	}
	if err := domain.ValidateMonth(month); err != nil {
		return domain.Period{}, err
	}
	var period domain.Period
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.MonthTaken(ctx, month)
		if err != nil {
			return err
		}
		if taken {
			return errs.Newf("PAYROLL_EXISTS", "Payroll for %s already exists.", month)
		}
		period = domain.Period{ID: "pay-" + month, Month: month, Status: domain.Draft, History: []domain.History{{Kind: "created", By: p.Name, On: h.today()}}}
		if err := h.compute(ctx, &period, nil); err != nil {
			return err
		}
		if err := h.savePeriod(ctx, period, 0); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "payroll", EntityID: period.ID, Summary: "Opened payroll " + month})
	})
	return period, err
}

// Calculate recomputes every line from the current people data, keeping adjustments; it needs
// payroll/edit and a draft or calculated period.
type Calculate struct{ Deps }

// Handle recalculates the period.
func (h Calculate) Handle(ctx context.Context, p auth.Principal, id string) (domain.Period, error) {
	if err := h.Authz.Require(ctx, p.Role, payrollEdit...); err != nil {
		return domain.Period{}, err
	}
	var period domain.Period
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var version int64
		var err error
		if period, version, err = h.Repo.Period(ctx, id); err != nil {
			return err
		}
		if err := domain.Editable(period, "; reopen it to recalculate."); err != nil {
			return err
		}
		if err := h.compute(ctx, &period, period.Lines); err != nil {
			return err
		}
		period.Status = domain.Calculated
		period.History = append(period.History, domain.History{Kind: "calculated", By: p.Name, On: h.today(), Note: fmt.Sprintf("%d payslips", len(period.Lines))})
		if err := h.savePeriod(ctx, period, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "payroll", EntityID: period.ID, Summary: fmt.Sprintf("Calculated payroll %s: %d net", period.Month, domain.PeriodTotals(period.Lines).Net)})
	})
	return period, err
}

// AddAdjustment adds a bonus, reimbursement, deduction or other change to one payslip with its
// reason; it needs payroll/edit and a draft or calculated period.
type AddAdjustment struct{ Deps }

// Handle adds the adjustment and recomputes the period.
func (h AddAdjustment) Handle(ctx context.Context, p auth.Principal, id, employeeID string, in domain.AdjustmentInput) (domain.Period, error) {
	if err := h.Authz.Require(ctx, p.Role, payrollEdit...); err != nil {
		return domain.Period{}, err
	}
	var period domain.Period
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var version int64
		var err error
		if period, version, err = h.Repo.Period(ctx, id); err != nil {
			return err
		}
		if err := domain.Editable(period, "; reopen it to adjust a payslip."); err != nil {
			return err
		}
		if err := domain.ValidateAdjustment(in); err != nil {
			return err
		}
		i, ok := domain.LineOf(period, employeeID)
		if !ok {
			return errs.New(errs.CodeValidation, "That employee is not on this payroll.")
		}
		n, err := h.Repo.Next(ctx, "adjustment")
		if err != nil {
			return err
		}
		line := &period.Lines[i]
		line.Adjustments = append(append([]domain.Adjustment{}, line.Adjustments...), domain.NewAdjustment(fmt.Sprintf("adj-%d", n), in, p.Name, h.today()))
		name := line.EmployeeName
		if err := h.compute(ctx, &period, period.Lines); err != nil {
			return err
		}
		if err := h.savePeriod(ctx, period, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "payroll", EntityID: period.ID, Summary: fmt.Sprintf("%s of %d for %s: %s", in.Kind, in.Amount, name, in.Reason)})
	})
	return period, err
}

// RemoveAdjustment drops an adjustment from a payslip; it needs payroll/edit and a draft or
// calculated period.
type RemoveAdjustment struct{ Deps }

// Handle removes the adjustment and recomputes the period.
func (h RemoveAdjustment) Handle(ctx context.Context, p auth.Principal, id, employeeID, adjustmentID string) (domain.Period, error) {
	if err := h.Authz.Require(ctx, p.Role, payrollEdit...); err != nil {
		return domain.Period{}, err
	}
	var period domain.Period
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var version int64
		var err error
		if period, version, err = h.Repo.Period(ctx, id); err != nil {
			return err
		}
		if err := domain.Editable(period, "."); err != nil {
			return err
		}
		if i, ok := domain.LineOf(period, employeeID); ok {
			kept := []domain.Adjustment{}
			for _, a := range period.Lines[i].Adjustments {
				if a.ID != adjustmentID {
					kept = append(kept, a)
				}
			}
			period.Lines[i].Adjustments = kept
		}
		if err := h.compute(ctx, &period, period.Lines); err != nil {
			return err
		}
		return h.savePeriod(ctx, period, version)
	})
	return period, err
}

// Transition approves, closes or reopens a period. Approving needs payroll/approve and someone
// other than the calculator (the owner excepted); closing needs payroll/post and the account the
// salaries are paid from, and sends the salary payment through PayrollPosting; reopening needs
// payroll/edit and a reason.
type Transition struct{ Deps }

// Handle moves the period.
func (h Transition) Handle(ctx context.Context, p auth.Principal, id, to, note, accountID string) (domain.Period, error) {
	switch to {
	case domain.Approved:
		if err := h.Authz.Require(ctx, p.Role, payrollApprove...); err != nil {
			return domain.Period{}, err
		}
	case domain.Closed:
		if err := h.Authz.Require(ctx, p.Role, payrollPost...); err != nil {
			return domain.Period{}, err
		}
	case domain.Draft:
		if err := h.Authz.Require(ctx, p.Role, payrollEdit...); err != nil {
			return domain.Period{}, err
		}
	}
	note = strings.TrimSpace(note)
	var period domain.Period
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var version int64
		var err error
		if period, version, err = h.Repo.Period(ctx, id); err != nil {
			return err
		}
		if err := domain.CheckTransition(period, to, note, accountID); err != nil {
			return err
		}
		before := period.Status
		today := h.today()
		switch to {
		case domain.Draft:
			period.History = append(period.History, domain.History{Kind: "reopened", By: p.Name, On: today, Note: note})
		case domain.Approved:
			if err := domain.CheckApprover(period, p.Name, string(p.Role)); err != nil {
				return err
			}
			period.History = append(period.History, domain.History{Kind: "approved", By: p.Name, On: today, Note: note})
		case domain.Closed:
			totals := domain.PeriodTotals(period.Lines)
			txID, err := h.Posting.PostSalaryPayment(ctx, payroll.PeriodClosed{
				PeriodID: period.ID, Month: period.Month, AccountID: accountID, CategoryID: "cat-payroll", Reference: "PAY-" + period.Month,
				ClosedOn: today, ClosedBy: p.Name, Totals: totals, ByVilla: domain.CostByVilla(period.Lines),
				Statutory: domain.StatutoryOwed(period.Month, period.Lines), Lines: period.Lines,
			})
			if err != nil {
				return err
			}
			period.TransactionID, period.PaidFromAccountID = txID, &accountID
			period.History = append(period.History, domain.History{Kind: "closed", By: p.Name, On: today, Note: fmt.Sprintf("%d payslips", totals.Employees)})
		}
		period.Status = to
		if err := h.savePeriod(ctx, period, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "payroll", EntityID: period.ID, Summary: fmt.Sprintf("Payroll %s %s to %s", period.Month, before, to),
			Before: map[string]any{"status": before}, After: map[string]any{"status": to}})
	})
	return period, err
}

// Publish makes a closed period's payslips visible to employees; it needs payroll/edit.
type Publish struct{ Deps }

// Handle publishes the payslips.
func (h Publish) Handle(ctx context.Context, p auth.Principal, id string) (domain.Period, error) {
	if err := h.Authz.Require(ctx, p.Role, payrollEdit...); err != nil {
		return domain.Period{}, err
	}
	var period domain.Period
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var version int64
		var err error
		if period, version, err = h.Repo.Period(ctx, id); err != nil {
			return err
		}
		if period.Status != domain.Closed {
			return errs.New("PAYROLL_INVALID_STATE", "Close the payroll before publishing payslips.")
		}
		period.Published = true
		period.History = append(period.History, domain.History{Kind: "published", By: p.Name, On: h.today()})
		if err := h.savePeriod(ctx, period, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "payroll", EntityID: period.ID, Summary: "Published payslips for " + period.Month})
	})
	return period, err
}
