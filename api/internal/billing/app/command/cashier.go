package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Cashier runs the front desk shifts: open on a counted float, close on a counted drawer, sign off
// a difference past the tolerance, drop cash to the safe or the bank. Finance books the count and
// the drop on cashier_shift.closed and cashier_shift.dropped. Opening, closing and dropping need
// payments/create.
type Cashier struct{ Deps }

func (h Cashier) shift(ctx context.Context, id string) (domain.Shift, error) {
	return get[domain.Shift](ctx, h.Deps, Shifts, id, "cashier shift")
}

func (h Cashier) save(ctx context.Context, s domain.Shift) error {
	return h.Store.Put(ctx, Shifts, Row{ID: s.ID, LocationID: s.LocationID, Ref: s.AccountID, Doc: s})
}

// signer is canSignOffShift: a manager role or someone who approves finance.
func (h Cashier) signer(ctx context.Context, p auth.Principal) (bool, error) {
	approves, err := h.can(ctx, p, "finance", "approve")
	return domain.CanSignOffShift(string(p.Role), approves), err
}

func (h Cashier) mine(ctx context.Context, p auth.Principal, s domain.Shift) error {
	if s.CashierID == p.UserID {
		return nil
	}
	ok, err := h.signer(ctx, p)
	if err != nil || ok {
		return err
	}
	return errs.Newf("SHIFT_NOT_YOURS", "%s belongs to %s.", s.Number, s.CashierName)
}

func (h Cashier) account(ctx context.Context, id string) (CashAccount, error) {
	accounts, err := h.Finance.CashAccounts(ctx)
	if err != nil {
		return CashAccount{}, err
	}
	i := slices.IndexFunc(accounts, func(a CashAccount) bool { return a.ID == id })
	if i < 0 {
		return CashAccount{}, errs.NotFound("account", id)
	}
	return accounts[i], nil
}

// Open opens a shift on a location cashbox, from a counted float or the rest of a closed shift.
func (h Cashier) Open(ctx context.Context, p auth.Principal, in domain.OpenShiftInput) (domain.Shift, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return domain.Shift{}, err
	}
	var out domain.Shift
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		acc, err := h.account(ctx, in.AccountID)
		if err != nil {
			return err
		}
		if acc.Kind != "cashbox" || acc.LocationID == nil || *acc.LocationID == "" {
			return errs.New(errs.CodeValidation, "A shift opens on a location cashbox.")
		}
		var from *domain.Shift
		if in.HandOverFrom != nil && *in.HandOverFrom != "" {
			s, err := h.shift(ctx, *in.HandOverFrom)
			if err != nil {
				return err
			}
			from = &s
		} else if err := domain.ValidateCount(in.Count); err != nil {
			return err
		}
		shifts, err := docs[domain.Shift](h.Store.ByRef(ctx, Shifts, acc.ID))
		if err != nil {
			return err
		}
		rostered := false
		if p.EmployeeID != nil && h.Roster != nil {
			if rostered, err = h.Roster.Rostered(ctx, *p.EmployeeID, h.today()); err != nil {
				return err
			}
		}
		if err := domain.OpenProblem(acc.ID, shifts, rostered, domain.IsShiftManager(string(p.Role)), from); err != nil {
			return err
		}
		date, err := h.businessDate(ctx)
		if err != nil {
			return err
		}
		n, err := h.Store.Next(ctx, "cashierShift")
		if err != nil {
			return err
		}
		float := domain.CountTotal(in.Count)
		opening := in.Count
		if from != nil {
			float = domain.HandOverAmount(*from)
			// A drop leaves no note-by-note record of what stayed, so the rest is split into notes.
			opening = domain.CountFor(float)
			if from.Dropped == 0 && from.ClosingCount != nil {
				opening = *from.ClosingCount
			}
		}
		if opening.Notes == nil {
			opening.Notes = map[string]float64{}
		}
		out = domain.Shift{ID: fmt.Sprintf("cs-%d", n), Number: fmt.Sprintf("SH-%04d", n), AccountID: acc.ID, LocationID: *acc.LocationID, CashierID: p.UserID,
			CashierName: p.Name, BusinessDate: date, OpenedAt: h.stamp(), OpeningCount: opening, Float: float, Status: domain.ShiftOpen}
		summary := fmt.Sprintf("Opened %s on %s with %s", out.Number, acc.Name, domain.Money(float))
		if from != nil {
			m, err := h.Store.Next(ctx, "handOver")
			if err != nil {
				return err
			}
			ho := domain.HandOver{ID: fmt.Sprintf("ho-%d", m), AccountID: acc.ID, FromShiftID: from.ID, ToShiftID: out.ID, Amount: float, At: out.OpenedAt, From: from.CashierName, To: p.Name}
			if err := h.Store.Put(ctx, HandOvers, Row{ID: ho.ID, LocationID: out.LocationID, Ref: acc.ID, Doc: ho}); err != nil {
				return err
			}
			from.HandedOverID, out.HandOverID = ptr(ho.ID), ptr(ho.ID)
			if err := h.save(ctx, *from); err != nil {
				return err
			}
			summary += " handed over from " + from.Number
		}
		if err := h.save(ctx, out); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "cashier-shift", EntityID: out.Number, Summary: summary,
			After: map[string]any{"float": float, "rostered": rostered}})
	})
	return out, err
}

// expected is shiftTotals(...).expected: the float plus the cash in less the cash out on the shift.
// Finance holds the cash entries; until it answers, billing counts its own cash payments and refunds.
func (h Cashier) expected(ctx context.Context, s domain.Shift) (int64, error) {
	in, out, ok, err := h.Finance.ShiftCash(ctx, s.ID, s.AccountID)
	if err != nil {
		return 0, err
	}
	if !ok {
		pays, err := h.payments(ctx)
		if err != nil {
			return 0, err
		}
		for _, p := range pays {
			if p.ShiftID != s.ID || p.Method != "cash" || (p.Status != "paid" && p.Status != "refunded") {
				continue
			}
			if p.Kind == "refund" {
				out += p.Amount
			} else {
				in += p.Amount
			}
		}
	}
	return s.Float + in - out, nil
}

// closed publishes the count for finance to book its difference.
func (h Cashier) closed(ctx context.Context, s domain.Shift) error {
	note := fmt.Sprintf("Shift %s, %s", s.Number, s.CashierName)
	if s.Reason != "" {
		note += ": " + s.Reason
	}
	return h.emit(ctx, billing.EventShiftClosed, "cashier_shift", s.ID, billing.ShiftClosed{Where: billing.Where{LocationID: s.LocationID, Date: h.today()},
		ShiftID: s.ID, AccountID: s.AccountID, Expected: *s.Expected, Counted: *s.Counted, Difference: *s.Difference, Note: note, Shift: mustJSON(s)})
}

// Close counts the drawer; past the tolerance it waits for a sign-off with a reason.
func (h Cashier) Close(ctx context.Context, p auth.Principal, id string, in domain.CloseShiftInput) (domain.Shift, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return domain.Shift{}, err
	}
	var s domain.Shift
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		var err error
		if s, err = h.shift(ctx, id); err != nil {
			return err
		}
		if err := h.mine(ctx, p, s); err != nil {
			return err
		}
		if err := domain.ValidateCount(in.Count); err != nil {
			return err
		}
		counted := domain.CountTotal(in.Count)
		expected, err := h.expected(ctx, s)
		if err != nil {
			return err
		}
		difference := counted - expected
		policy, err := h.shiftPolicy(ctx)
		if err != nil {
			return err
		}
		if err := domain.CloseProblem(s, difference, in.Reason, policy); err != nil {
			return err
		}
		count := in.Count
		if count.Notes == nil {
			count.Notes = map[string]float64{}
		}
		s.ClosedAt, s.ClosingCount, s.Counted, s.Expected, s.Difference = ptr(h.stamp()), &count, &counted, &expected, &difference
		s.Reason, s.Status = strings.TrimSpace(in.Reason), domain.ShiftClosed
		if domain.NeedsSignOff(difference, policy) {
			s.Status = domain.ShiftAwaiting
		}
		if s.Status == domain.ShiftClosed {
			if err := h.closed(ctx, s); err != nil {
				return err
			}
		}
		if err := h.save(ctx, s); err != nil {
			return err
		}
		result := "matched"
		switch {
		case difference > 0:
			result = "over by " + domain.Money(difference)
		case difference < 0:
			result = "short by " + domain.Money(-difference)
		}
		if s.Status == domain.ShiftAwaiting {
			result += ", waits for sign-off"
		}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "cashier-shift", EntityID: s.Number, Summary: fmt.Sprintf("Closed %s: %s", s.Number, result),
			Before: map[string]any{"status": domain.ShiftOpen}, After: map[string]any{"status": s.Status, "counted": counted, "expected": expected}})
	})
	return s, err
}

// SignOff closes a shift whose difference waits for a manager, never the cashier.
func (h Cashier) SignOff(ctx context.Context, p auth.Principal, id, note string) (domain.Shift, error) {
	var s domain.Shift
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		ok, err := h.signer(ctx, p)
		if err != nil {
			return err
		}
		if !ok {
			return errs.New("SHIFT_SIGNOFF_DENIED", "A manager or someone who approves finance signs off a drawer difference.")
		}
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		if s, err = h.shift(ctx, id); err != nil {
			return err
		}
		if err := domain.SignOffProblem(s, p.UserID); err != nil {
			return err
		}
		s.SignOff = &domain.ShiftSignOff{By: p.Name, At: h.stamp(), Note: strings.TrimSpace(note)}
		s.Status = domain.ShiftClosed
		if err := h.closed(ctx, s); err != nil {
			return err
		}
		if err := h.save(ctx, s); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Approve, Entity: "cashier-shift", EntityID: s.Number,
			Summary: fmt.Sprintf("Signed off %s, %s", s.Number, domain.Money(domain.Deref(s.Difference))),
			Before:  map[string]any{"status": domain.ShiftAwaiting}, After: map[string]any{"status": domain.ShiftClosed}})
	})
	return s, err
}

// Drop takes cash from a counted drawer to the safe or the bank, once and before the hand-over.
func (h Cashier) Drop(ctx context.Context, p auth.Principal, id string, in domain.DropInput) (domain.Shift, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return domain.Shift{}, err
	}
	var s domain.Shift
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		var err error
		if s, err = h.shift(ctx, id); err != nil {
			return err
		}
		if err := h.mine(ctx, p, s); err != nil {
			return err
		}
		if err := domain.DropProblem(s, in.Amount); err != nil {
			return err
		}
		to, err := h.account(ctx, in.ToAccountID)
		if err != nil {
			return err
		}
		amount := int64(in.Amount)
		description := "Cash drop from " + s.Number
		if note := strings.TrimSpace(in.Note); note != "" {
			description += ": " + note
		}
		s.Dropped, s.DropTransactionID = amount, ptr("drop-"+s.ID)
		if err := h.emit(ctx, billing.EventShiftDropped, "cashier_shift", s.ID, billing.ShiftDropped{Where: billing.Where{LocationID: s.LocationID, Date: h.today()},
			ShiftID: s.ID, FromAccountID: s.AccountID, ToAccountID: to.ID, Amount: amount, Description: description, Reference: s.Number}); err != nil {
			return err
		}
		if err := h.save(ctx, s); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "cashier-shift", EntityID: s.Number,
			Summary: fmt.Sprintf("Dropped %s from %s to %s", domain.Money(amount), s.Number, to.Name), After: map[string]any{"dropped": amount}})
	})
	return s, err
}
