package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// The cashier shift commands follow src/infrastructure/mock/cashier.ts. A shift's close goes to the
// books through the same cash count as a reconciliation, and its drop through the transfer path.
// The console asks no permission before a shift step; the rules themselves decide who acts.

func findShift(shifts []domain.CashierShift, id string) (*domain.CashierShift, error) {
	i := slices.IndexFunc(shifts, func(s domain.CashierShift) bool { return s.ID == id })
	if i < 0 {
		return nil, errs.NotFound("cashier shift", id)
	}
	return &shifts[i], nil
}

func (d Deps) signsOff(ctx context.Context, p auth.Principal) (bool, error) {
	approves, err := d.can(ctx, p.Role, "finance", "approve")
	return domain.CanSignOffShift(string(p.Role), approves), err
}

// assertMine lets the cashier work their own drawer; a manager or finance approver may step in.
func (d Deps) assertMine(ctx context.Context, s domain.CashierShift, p auth.Principal) error {
	if s.CashierID == p.UserID {
		return nil
	}
	ok, err := d.signsOff(ctx, p)
	if err != nil || ok {
		return err
	}
	return errs.Newf("SHIFT_NOT_YOURS", "%s belongs to %s.", s.Number, s.CashierName)
}

// postShift takes the difference to the books through the cash count, as an adjustment for approval.
func (d Deps) postShift(ctx context.Context, s *domain.CashierShift, by domain.Signer) error {
	a, err := d.Repo.Account(ctx, s.AccountID, false)
	if err != nil {
		return err
	}
	note := fmt.Sprintf("Shift %s, %s", s.Number, s.CashierName)
	if s.Reason != "" {
		note += ": " + s.Reason
	}
	r, err := d.recordCount(ctx, a, Count{Date: d.today(), Expected: *s.Expected, Counted: *s.Counted, Note: note, Adjust: true, By: s.CashierName, ShiftID: s.ID}, by)
	if err != nil {
		return err
	}
	s.ReconciliationID = &r.ID
	return nil
}

// SaveShiftPolicy is PUT /cashier-shifts/policy.
type SaveShiftPolicy struct{ Deps }

// Handle needs finance/edit.
func (h SaveShiftPolicy) Handle(ctx context.Context, p auth.Principal, tolerance float64) (domain.ShiftPolicy, error) {
	if err := h.require(ctx, p, financeEdit); err != nil {
		return domain.ShiftPolicy{}, err
	}
	if err := domain.ValidateShiftPolicy(tolerance); err != nil {
		return domain.ShiftPolicy{}, err
	}
	out := domain.ShiftPolicy{Tolerance: int64(tolerance)}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockSetting(ctx, KeyShift, domain.DefaultShiftPolicy); err != nil {
			return err
		}
		before, err := h.ShiftPolicy(ctx)
		if err != nil {
			return err
		}
		if err := h.Repo.SaveSetting(ctx, KeyShift, out); err != nil {
			return err
		}
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Update, Entity: "shift-policy", EntityID: "tolerance", Summary: "Shift tolerance set to " + domain.Money(out.Tolerance), Before: before, After: out})
	})
	return out, err
}

// OpenShift is POST /cashier-shifts.
type OpenShift struct{ Deps }

// Handle opens a drawer on a location cashbox: one open shift per cashbox, the cashier on today's
// roster or a manager, and a hand-over from a counted shift that has not handed over yet.
func (h OpenShift) Handle(ctx context.Context, p auth.Principal, in domain.OpenShiftInput) (domain.CashierShift, error) {
	var out domain.CashierShift
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockShifts(ctx); err != nil {
			return err
		}
		a, err := h.Repo.Account(ctx, in.AccountID, false)
		if err != nil {
			return err
		}
		if a.Kind != domain.Cashbox || a.LocationID == nil {
			return errs.New(errs.CodeValidation, "A shift opens on a location cashbox.")
		}
		shifts, err := h.Repo.Shifts(ctx, true)
		if err != nil {
			return err
		}
		var from *domain.CashierShift
		if in.HandOverFrom != nil && *in.HandOverFrom != "" {
			if from, err = findShift(shifts, *in.HandOverFrom); err != nil {
				return err
			}
		} else if err := domain.ValidateCount(in.Count); err != nil {
			return err
		}
		today := h.today()
		rostered := false
		if p.EmployeeID != nil {
			if rostered, err = h.Roster.Rostered(ctx, *p.EmployeeID, today); err != nil {
				return err
			}
		}
		if err := domain.OpenProblem(a.ID, shifts, rostered, domain.IsShiftManager(string(p.Role)), from); err != nil {
			return err
		}
		businessDate, err := h.BusinessDate.BusinessDate(ctx)
		if err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "cashierShift")
		if err != nil {
			return err
		}
		float := in.Count.Total()
		opening := in.Count
		if from != nil {
			float = domain.HandOverAmount(*from)
			opening = domain.CountFor(float)
			if from.Dropped == 0 && from.ClosingCount != nil {
				opening = *from.ClosingCount
			}
		}
		if opening.Notes == nil {
			opening.Notes = map[string]float64{}
		}
		s := domain.CashierShift{ID: fmt.Sprintf("cs-%d", n), Number: fmt.Sprintf("SH-%04d", n), AccountID: a.ID, LocationID: *a.LocationID, CashierID: p.UserID, CashierName: p.Name,
			BusinessDate: businessDate, OpenedAt: h.stamp(), OpeningCount: opening, Float: float, Status: domain.ShiftOpen}
		summary := fmt.Sprintf("Opened %s on %s with %s", s.Number, a.Name, domain.Money(float))
		if from != nil {
			hn, err := h.Repo.Next(ctx, "handOver")
			if err != nil {
				return err
			}
			ho := domain.HandOver{ID: fmt.Sprintf("ho-%d", hn), AccountID: a.ID, FromShiftID: from.ID, ToShiftID: s.ID, Amount: float, At: s.OpenedAt, From: from.CashierName, To: p.Name}
			if err := h.Repo.InsertHandOver(ctx, ho); err != nil {
				return err
			}
			from.HandedOverID, s.HandOverID = &ho.ID, &ho.ID
			if err := h.Repo.SaveShift(ctx, from); err != nil {
				return err
			}
			summary += " handed over from " + from.Number
		}
		if err := h.Repo.SaveShift(ctx, &s); err != nil {
			return err
		}
		out = s
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Create, Entity: "cashier-shift", EntityID: s.Number, Summary: summary, After: map[string]any{"float": float, "rostered": rostered}})
	})
	return out, err
}

// CloseShift is POST /cashier-shifts/{id}/close.
type CloseShift struct{ Deps }

// Handle counts the drawer against the float plus the drawer's cash; a difference within the
// tolerance posts through the cash count at once, past it the shift waits for a sign-off.
func (h CloseShift) Handle(ctx context.Context, p auth.Principal, id string, in domain.CloseShiftInput) (domain.CashierShift, error) {
	var out domain.CashierShift
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockShifts(ctx); err != nil {
			return err
		}
		shifts, err := h.Repo.Shifts(ctx, true)
		if err != nil {
			return err
		}
		s, err := findShift(shifts, id)
		if err != nil {
			return err
		}
		if err := h.assertMine(ctx, *s, p); err != nil {
			return err
		}
		if err := domain.ValidateCount(in.Count); err != nil {
			return err
		}
		txs, err := h.Repo.Transactions(ctx)
		if err != nil {
			return err
		}
		policy, err := h.ShiftPolicy(ctx)
		if err != nil {
			return err
		}
		counted := in.Count.Total()
		expected := domain.ShiftExpected(*s, txs)
		difference := counted - expected
		if err := domain.CloseProblem(*s, difference, in.Reason, policy); err != nil {
			return err
		}
		count := in.Count
		if count.Notes == nil {
			count.Notes = map[string]float64{}
		}
		s.ClosedAt, s.ClosingCount, s.Counted, s.Expected, s.Difference = domain.Ptr(h.stamp()), &count, &counted, &expected, &difference
		s.Reason, s.Status = strings.TrimSpace(in.Reason), domain.ShiftClosed
		if domain.NeedsSignOff(difference, policy) {
			s.Status = domain.ShiftAwaiting
		}
		if s.Status == domain.ShiftClosed {
			if err := h.postShift(ctx, s, Signer(p)); err != nil {
				return err
			}
		}
		if err := h.Repo.SaveShift(ctx, s); err != nil {
			return err
		}
		matched := "matched"
		if difference != 0 {
			dir := "short"
			if difference > 0 {
				dir = "over"
			}
			matched = fmt.Sprintf("%s by %s", dir, domain.Money(abs(difference)))
		}
		if s.Status == domain.ShiftAwaiting {
			matched += ", waits for sign-off"
		}
		out = *s
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Status, Entity: "cashier-shift", EntityID: s.Number, Summary: fmt.Sprintf("Closed %s: %s", s.Number, matched),
			Before: map[string]any{"status": "open"}, After: map[string]any{"status": s.Status, "counted": counted, "expected": expected}})
	})
	return out, err
}

// SignOffShift is POST /cashier-shifts/{id}/sign-off.
type SignOffShift struct{ Deps }

// Handle lets a manager or someone who approves finance sign another cashier's difference.
func (h SignOffShift) Handle(ctx context.Context, p auth.Principal, id, note string) (domain.CashierShift, error) {
	var out domain.CashierShift
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockShifts(ctx); err != nil {
			return err
		}
		shifts, err := h.Repo.Shifts(ctx, true)
		if err != nil {
			return err
		}
		s, err := findShift(shifts, id)
		if err != nil {
			return err
		}
		ok, err := h.signsOff(ctx, p)
		if err != nil {
			return err
		}
		if !ok {
			return errs.New("SHIFT_SIGNOFF_DENIED", "A manager or someone who approves finance signs off a drawer difference.")
		}
		if err := domain.SignOffProblem(*s, p.UserID); err != nil {
			return err
		}
		s.SignOff = &domain.ShiftSignOff{By: p.Name, At: h.stamp(), Note: strings.TrimSpace(note)}
		s.Status = domain.ShiftClosed
		if err := h.postShift(ctx, s, Signer(p)); err != nil {
			return err
		}
		if err := h.Repo.SaveShift(ctx, s); err != nil {
			return err
		}
		out = *s
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Approve, Entity: "cashier-shift", EntityID: s.Number, Summary: fmt.Sprintf("Signed off %s, %s", s.Number, domain.Money(*s.Difference)),
			Before: map[string]any{"status": "awaiting_signoff"}, After: map[string]any{"status": "closed"}})
	})
	return out, err
}

// DropShift is POST /cashier-shifts/{id}/drop.
type DropShift struct{ Deps }

// Handle takes counted cash to the safe or the bank once, before the hand-over, through the
// transfer path kept off any open shift.
func (h DropShift) Handle(ctx context.Context, p auth.Principal, id string, in domain.DropInput) (domain.CashierShift, error) {
	var out domain.CashierShift
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockShifts(ctx); err != nil {
			return err
		}
		shifts, err := h.Repo.Shifts(ctx, true)
		if err != nil {
			return err
		}
		s, err := findShift(shifts, id)
		if err != nil {
			return err
		}
		if err := h.assertMine(ctx, *s, p); err != nil {
			return err
		}
		if err := domain.DropProblem(*s, in.Amount); err != nil {
			return err
		}
		to, err := h.Repo.Account(ctx, in.ToAccountID, false)
		if err != nil {
			return err
		}
		description := "Cash drop from " + s.Number
		if note := strings.TrimSpace(in.Note); note != "" {
			description += ": " + note
		}
		t, err := h.transferCash(ctx, domain.TransferInput{FromAccountID: s.AccountID, ToAccountID: to.ID, Amount: in.Amount, Date: h.today(), Description: description, Reference: s.Number}, Signer(p), true)
		if err != nil {
			return err
		}
		s.Dropped, s.DropTransactionID = int64(in.Amount), &t.ID
		if err := h.Repo.SaveShift(ctx, s); err != nil {
			return err
		}
		out = *s
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Update, Entity: "cashier-shift", EntityID: s.Number, Summary: fmt.Sprintf("Dropped %s from %s to %s", domain.Money(s.Dropped), s.Number, to.Name),
			After: map[string]any{"dropped": s.Dropped}})
	})
	return out, err
}
