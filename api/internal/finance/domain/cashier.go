package domain

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Notes are the rupiah notes in a drawer, largest first.
var Notes = []int64{100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000}

// DrawerCount is a drawer counted by denomination: pieces per note, keyed by the note's value,
// plus the coins in rupiah.
type DrawerCount struct {
	Notes map[string]float64 `json:"notes"`
	Coins float64            `json:"coins"`
}

// Total is countTotal.
func (c DrawerCount) Total() int64 {
	var s int64
	for _, n := range Notes {
		s += n * int64(c.Notes[strconv.FormatInt(n, 10)])
	}
	return s + int64(c.Coins)
}

// ValidateCount is validateCount.
func ValidateCount(c DrawerCount) error {
	for _, n := range Notes {
		v := c.Notes[strconv.FormatInt(n, 10)]
		if !whole(v) || v < 0 {
			return errs.New(errs.CodeValidation, "Count each note in whole pieces, zero or more.")
		}
	}
	if !whole(c.Coins) || c.Coins < 0 {
		return errs.New(errs.CodeValidation, "Enter the coins in whole rupiah, zero or more.")
	}
	return nil
}

// CountFor is countFor: an amount split into notes, largest first, the rest as coins.
func CountFor(amount int64) DrawerCount {
	c := DrawerCount{Notes: map[string]float64{}}
	left := amount
	for _, n := range Notes {
		if pieces := left / n; pieces > 0 {
			c.Notes[strconv.FormatInt(n, 10)] = float64(pieces)
			left -= pieces * n
		}
	}
	c.Coins = float64(left)
	return c
}

// Shift statuses.
const (
	ShiftOpen     = "open"
	ShiftAwaiting = "awaiting_signoff"
	ShiftClosed   = "closed"
)

var shiftStatusLabel = map[string]string{ShiftOpen: "Open", ShiftAwaiting: "Awaiting sign-off", ShiftClosed: "Closed"}

// ShiftSignOff is the manager's signature on a difference.
type ShiftSignOff struct {
	By   string `json:"by"`
	At   string `json:"at"`
	Note string `json:"note"`
}

// CashierShift is a front desk drawer from its opening float to its counted close.
type CashierShift struct {
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
	Version           int64         `json:"-"`
}

// HandOver is the closing count of one shift accepted as the float of the next.
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

// ShiftPolicy is the tolerance past which a difference needs a sign-off.
type ShiftPolicy struct {
	Tolerance int64 `json:"tolerance"`
}

// DefaultShiftPolicy is DEFAULT_SHIFT_POLICY.
var DefaultShiftPolicy = ShiftPolicy{Tolerance: 10_000}

// ValidateShiftPolicy is validateShiftPolicy.
func ValidateShiftPolicy(tolerance float64) error {
	if whole(tolerance) && tolerance >= 0 {
		return nil
	}
	return errs.Invalid("tolerance", "Enter the tolerance in whole rupiah, zero or more.")
}

// OpenShiftInput opens a drawer on a cashbox, from a count or a hand-over.
type OpenShiftInput struct {
	AccountID    string      `json:"accountId"`
	Count        DrawerCount `json:"count"`
	HandOverFrom *string     `json:"handOverFrom"`
}

// CloseShiftInput closes a drawer on its count.
type CloseShiftInput struct {
	Count  DrawerCount `json:"count"`
	Reason string      `json:"reason"`
}

// DropInput takes counted cash to the safe or the bank.
type DropInput struct {
	ToAccountID string  `json:"toAccountId"`
	Amount      float64 `json:"amount"`
	Note        string  `json:"note"`
}

var shiftManagers = []string{"owner", "management", "manager"}

// IsShiftManager is isShiftManager.
func IsShiftManager(role string) bool { return slices.Contains(shiftManagers, role) }

// CanSignOffShift is canSignOffShift.
func CanSignOffShift(role string, approvesFinance bool) bool {
	return approvesFinance || IsShiftManager(role)
}

// OpenShiftOn is openShiftOn.
func OpenShiftOn(shifts []CashierShift, accountID string) *CashierShift {
	for i := range shifts {
		if shifts[i].AccountID == accountID && shifts[i].Status == ShiftOpen {
			return &shifts[i]
		}
	}
	return nil
}

// InDrawer is inDrawer: everything but drafts and rejected entries.
func InDrawer(status string) bool { return status != Draft && status != Rejected }

// HandOverAmount is handOverAmount.
func HandOverAmount(s CashierShift) int64 {
	var counted int64
	if s.Counted != nil {
		counted = *s.Counted
	}
	return counted - s.Dropped
}

// NeedsSignOff is needsSignOff.
func NeedsSignOff(difference int64, p ShiftPolicy) bool { return abs(difference) > p.Tolerance }

// ShiftExpected is shiftTotals' expected: the float plus the drawer's cash in less cash out.
func ShiftExpected(s CashierShift, txs []Transaction) int64 {
	expected := s.Float
	for _, t := range txs {
		if t.Shift() == s.ID && t.AccountID == s.AccountID && InDrawer(t.Status) {
			expected += Signed(t)
		}
	}
	return expected
}

// OpenProblem is openProblem.
func OpenProblem(accountID string, shifts []CashierShift, rostered, manager bool, handOver *CashierShift) error {
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
func CloseProblem(s CashierShift, difference int64, reason string, p ShiftPolicy) error {
	if s.Status != ShiftOpen {
		return errs.Newf("SHIFT_NOT_OPEN", "%s is %s.", s.Number, strings.ToLower(shiftStatusLabel[s.Status]))
	}
	if NeedsSignOff(difference, p) && runes(strings.TrimSpace(reason)) < 5 {
		dir := "short"
		if difference > 0 {
			dir = "over"
		}
		return errs.Newf("SHIFT_REASON_REQUIRED", "The drawer is %s by more than the tolerance; say why.", dir)
	}
	return nil
}

// SignOffProblem is signOffProblem.
func SignOffProblem(s CashierShift, userID string) error {
	if s.Status != ShiftAwaiting {
		return errs.Newf("SHIFT_NOT_AWAITING", "%s does not wait for a sign-off.", s.Number)
	}
	if s.CashierID == userID {
		return errs.New("SHIFT_SELF_SIGNOFF", "Another manager signs off your own drawer.")
	}
	return nil
}

// DropProblem is dropProblem.
func DropProblem(s CashierShift, amount float64) error {
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
		return errs.New(errs.CodeValidation, fmt.Sprintf("Drop a whole rupiah amount up to the %s counted.", Thousands(*s.Counted)))
	}
	return nil
}

// BudgetMonth is one month of a villa's budget.
type BudgetMonth struct {
	RoomNights   float64 `json:"roomNights"`
	ADR          float64 `json:"adr"`
	OtherRevenue float64 `json:"otherRevenue"`
	Expenses     float64 `json:"expenses"`
}

// Budget is a villa's budget for one year.
type Budget struct {
	VillaID   string        `json:"villaId"`
	Year      float64       `json:"year"`
	Months    []BudgetMonth `json:"months"`
	UpdatedBy string        `json:"updatedBy"`
	UpdatedOn string        `json:"updatedOn"`
}

// BudgetInput is the budget form.
type BudgetInput struct {
	VillaID string        `json:"villaId"`
	Year    float64       `json:"year"`
	Months  []BudgetMonth `json:"months"`
}

// ValidateBudget is validateBudget, with fields keyed the way the form names them.
func ValidateBudget(in BudgetInput) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick a villa.")
	}
	if !whole(in.Year) || in.Year < 2000 || in.Year > 2100 {
		f.Add("year", "Pick a year.")
	}
	if len(in.Months) != 12 {
		f.Add("months", "A budget has twelve months.")
	}
	for i, m := range in.Months {
		for _, field := range []struct {
			key, label string
			v          float64
		}{{"roomNights", "Room nights", m.RoomNights}, {"adr", "ADR", m.ADR}, {"otherRevenue", "Other revenue", m.OtherRevenue}, {"expenses", "Expenses", m.Expenses}} {
			if !whole(field.v) || field.v < 0 {
				f.Add(fmt.Sprintf("months.%d.%s", i, field.key), field.label+": a whole number, zero or more.")
			}
		}
	}
	return f.Err()
}
