package domain

import (
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Notes are the rupiah notes in a drawer, largest first.
var Notes = []int64{100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000}

// DrawerCount is DrawerCount: pieces per note (keyed by the note's value) and the coins in rupiah.
type DrawerCount struct {
	Notes map[string]float64 `json:"notes"`
	Coins float64            `json:"coins"`
}

func noteKey(n int64) string { return strconv.FormatInt(n, 10) }

// CountTotal is countTotal.
func CountTotal(c DrawerCount) int64 {
	var s int64
	for _, n := range Notes {
		s += n * int64(c.Notes[noteKey(n)])
	}
	return s + int64(c.Coins)
}

// ValidateCount is validateCount.
func ValidateCount(c DrawerCount) error {
	for _, n := range Notes {
		v := c.Notes[noteKey(n)]
		if !whole(v) || v < 0 {
			return errs.New(errs.CodeValidation, "Count each note in whole pieces, zero or more.")
		}
	}
	if !whole(c.Coins) || c.Coins < 0 {
		return errs.New(errs.CodeValidation, "Enter the coins in whole rupiah, zero or more.")
	}
	return nil
}

// CountFor is countFor: an amount split into notes, the rest as coins.
func CountFor(amount int64) DrawerCount {
	out := DrawerCount{Notes: map[string]float64{}}
	left := amount
	for _, n := range Notes {
		if pieces := left / n; pieces > 0 {
			out.Notes[noteKey(n)] = float64(pieces)
			left -= pieces * n
		}
	}
	out.Coins = float64(left)
	return out
}

// Shift statuses.
const (
	ShiftOpen     = "open"
	ShiftAwaiting = "awaiting_signoff"
	ShiftClosed   = "closed"
)

var shiftLabel = map[string]string{ShiftOpen: "open", ShiftAwaiting: "awaiting sign-off", ShiftClosed: "closed"}

// ShiftSignOff is ShiftSignOff.
type ShiftSignOff struct {
	By   string `json:"by"`
	At   string `json:"at"`
	Note string `json:"note"`
}

// Shift is CashierShift.
type Shift struct {
	ID                string        `json:"id"`
	Number            string        `json:"number"`
	AccountID         string        `json:"accountId"`
	LocationID        string        `json:"locationId"`
	CashierID         string        `json:"cashierId"`
	CashierName       string        `json:"cashierName"`
	BusinessDate      string        `json:"businessDate"`
	OpenedAt          string        `json:"openedAt"`
	OpeningCount      DrawerCount   `json:"openingCount"`
	Float             int64         `json:"float"`
	HandOverID        *string       `json:"handOverId"`
	Status            string        `json:"status"`
	ClosedAt          *string       `json:"closedAt"`
	ClosingCount      *DrawerCount  `json:"closingCount"`
	Counted           *int64        `json:"counted"`
	Expected          *int64        `json:"expected"`
	Difference        *int64        `json:"difference"`
	Reason            string        `json:"reason"`
	SignOff           *ShiftSignOff `json:"signOff"`
	ReconciliationID  *string       `json:"reconciliationId"`
	Dropped           int64         `json:"dropped"`
	DropTransactionID *string       `json:"dropTransactionId"`
	HandedOverID      *string       `json:"handedOverId"`
}

// HandOver is HandOver.
type HandOver struct {
	ID          string `json:"id"`
	AccountID   string `json:"accountId"`
	FromShiftID string `json:"fromShiftId"`
	ToShiftID   string `json:"toShiftId"`
	Amount      int64  `json:"amount"`
	At          string `json:"at"`
	From        string `json:"from"`
	To          string `json:"to"`
}

// ShiftPolicy is ShiftPolicy.
type ShiftPolicy struct {
	Tolerance float64 `json:"tolerance"`
}

// DefaultShiftPolicy is DEFAULT_SHIFT_POLICY.
var DefaultShiftPolicy = ShiftPolicy{Tolerance: 10_000}

// ValidateShiftPolicy is validateShiftPolicy.
func ValidateShiftPolicy(p ShiftPolicy) error {
	if whole(p.Tolerance) && p.Tolerance >= 0 {
		return nil
	}
	return errs.Invalid("tolerance", "Enter the tolerance in whole rupiah, zero or more.")
}

// OpenShiftInput is OpenShiftInput.
type OpenShiftInput struct {
	AccountID    string      `json:"accountId"`
	Count        DrawerCount `json:"count"`
	HandOverFrom *string     `json:"handOverFrom"`
}

// CloseShiftInput is CloseShiftInput.
type CloseShiftInput struct {
	Count  DrawerCount `json:"count"`
	Reason string      `json:"reason"`
}

// DropInput is DropInput.
type DropInput struct {
	ToAccountID string  `json:"toAccountId"`
	Amount      float64 `json:"amount"`
	Note        string  `json:"note"`
}

// ShiftManagerRoles are SHIFT_MANAGER_ROLES.
var ShiftManagerRoles = []string{"owner", "management", "manager"}

// IsShiftManager is isShiftManager.
func IsShiftManager(role string) bool { return contains(ShiftManagerRoles, role) }

// CanSignOffShift is canSignOffShift.
func CanSignOffShift(role string, approvesFinance bool) bool {
	return approvesFinance || IsShiftManager(role)
}

// OpenShiftOn is openShiftOn.
func OpenShiftOn(shifts []Shift, accountID string) *Shift {
	for i := range shifts {
		if shifts[i].AccountID == accountID && shifts[i].Status == ShiftOpen {
			return &shifts[i]
		}
	}
	return nil
}

// HandOverAmount is handOverAmount.
func HandOverAmount(s Shift) int64 {
	var counted int64
	if s.Counted != nil {
		counted = *s.Counted
	}
	return counted - s.Dropped
}

// NeedsSignOff is needsSignOff.
func NeedsSignOff(difference int64, p ShiftPolicy) bool {
	if difference < 0 {
		difference = -difference
	}
	return float64(difference) > p.Tolerance
}

// OpenProblem is openProblem.
func OpenProblem(accountID string, shifts []Shift, rostered, manager bool, handOver *Shift) error {
	if open := OpenShiftOn(shifts, accountID); open != nil {
		return errs.Newf("SHIFT_ALREADY_OPEN", "%s is still open on this cashbox with %s; close it first.", open.Number, open.CashierName)
	}
	if !rostered && !manager {
		return errs.New("SHIFT_NOT_ROSTERED", "You are not on today’s roster; ask a manager to open the shift.")
	}
	if h := handOver; h != nil {
		if h.AccountID != accountID || h.Status == ShiftOpen || h.Counted == nil {
			return errs.Newf("SHIFT_HANDOVER_INVALID", "%s is not a counted shift on this cashbox.", h.Number)
		}
		if h.HandedOverID != nil {
			return errs.Newf("SHIFT_HANDED_OVER", "%s has already handed its drawer over.", h.Number)
		}
	}
	return nil
}

// CloseProblem is closeProblem.
func CloseProblem(s Shift, difference int64, reason string, p ShiftPolicy) error {
	if s.Status != ShiftOpen {
		return errs.Newf("SHIFT_NOT_OPEN", "%s is %s.", s.Number, shiftLabel[s.Status])
	}
	if NeedsSignOff(difference, p) && len([]rune(strings.TrimSpace(reason))) < 5 {
		way := "short"
		if difference > 0 {
			way = "over"
		}
		return errs.Newf("SHIFT_REASON_REQUIRED", "The drawer is %s by more than the tolerance; say why.", way)
	}
	return nil
}

// SignOffProblem is signOffProblem.
func SignOffProblem(s Shift, userID string) error {
	if s.Status != ShiftAwaiting {
		return errs.Newf("SHIFT_NOT_AWAITING", "%s does not wait for a sign-off.", s.Number)
	}
	if s.CashierID == userID {
		return errs.New("SHIFT_SELF_SIGNOFF", "Another manager signs off your own drawer.")
	}
	return nil
}

// DropProblem is dropProblem.
func DropProblem(s Shift, amount float64) error {
	if s.Status == ShiftOpen || s.Counted == nil {
		return errs.Newf("SHIFT_NOT_CLOSED", "Count and close %s before the cash leaves the drawer.", s.Number)
	}
	if s.HandedOverID != nil {
		return errs.Newf("SHIFT_HANDED_OVER", "%s has already handed its drawer over.", s.Number)
	}
	if s.DropTransactionID != nil {
		return errs.Newf("SHIFT_ALREADY_DROPPED", "The cash of %s has already been dropped.", s.Number)
	}
	if !whole(amount) || amount <= 0 || int64(amount) > *s.Counted {
		return errs.Newf(errs.CodeValidation, "Drop a whole rupiah amount up to the %s counted.", Rupiah(*s.Counted))
	}
	return nil
}

// Money is the console's money(): Rp 1.250.000, with the no-break space Intl puts after Rp.
func Money(v int64) string {
	if v < 0 {
		return "-Rp " + Rupiah(-v)
	}
	return "Rp " + Rupiah(v)
}
