// Package domain holds the owners context's rules, ported from src/domain/owner.ts: villa owners,
// management contracts, the monthly statement and its settlement, and owner stays. Errors carry the
// TypeScript RuleError codes and wording.
package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// BankAccount is where an owner is paid.
type BankAccount struct {
	Bank          string `json:"bank"`
	AccountName   string `json:"accountName"`
	AccountNumber string `json:"accountNumber"`
}

// OwnerInput is VillaOwnerInput.
type OwnerInput struct {
	Name   string      `json:"name"`
	Email  string      `json:"email"`
	Phone  string      `json:"phone"`
	Bank   BankAccount `json:"bank"`
	NPWP   string      `json:"npwp"`
	UserID *string     `json:"userId"`
}

// VillaOwner is an investor who hands a villa to the operator.
type VillaOwner struct {
	ID string `json:"id"`
	OwnerInput
	Version int64 `json:"-"`
}

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// CleanOwner validates an owner as the mock's saveOwner does and trims the text fields.
func CleanOwner(in OwnerInput) (OwnerInput, error) {
	var f errs.Fields
	if len([]rune(strings.TrimSpace(in.Name))) < 2 {
		f.Add("name", "Enter the owner’s name.")
	}
	if !emailPattern.MatchString(in.Email) {
		f.Add("email", "Enter a valid email address.")
	}
	if strings.TrimSpace(in.Bank.AccountNumber) == "" {
		f.Add("bank", "Enter the payout bank account.")
	}
	if err := f.Err(); err != nil {
		return in, err
	}
	in.Name, in.Email, in.NPWP = strings.TrimSpace(in.Name), strings.TrimSpace(in.Email), strings.TrimSpace(in.NPWP)
	return in, nil
}

// Fee bases, charged costs, owner stay pricing and shortfall rules.
const (
	FeeRoom  = "room"
	FeeGross = "gross"
	FeeGOP   = "gop"

	ChargedOperating   = "operating"
	ChargedMaintenance = "maintenance"
	ChargedAll         = "all"

	StayFree     = "free"
	StayCleaning = "cleaning"
	StayRate     = "rate"

	ShortfallCarry = "carry"
	ShortfallTopUp = "topup"
)

// ContractInput is ContractInput. Whole-rupiah fields stay numbers so a fraction can be refused.
type ContractInput struct {
	VillaID              string          `json:"villaId"`
	OwnerID              string          `json:"ownerId"`
	Start                string          `json:"start"`
	End                  string          `json:"end"`
	FeeBasis             string          `json:"feeBasis"`
	FeePct               float64         `json:"feePct"`
	FixedMonthlyFee      float64         `json:"fixedMonthlyFee"`
	Charged              string          `json:"charged"`
	MaintenanceThreshold float64         `json:"maintenanceThreshold"`
	OwnerNightsPerYear   float64         `json:"ownerNightsPerYear"`
	OwnerStayPricing     string          `json:"ownerStayPricing"`
	OwnerStayPrice       float64         `json:"ownerStayPrice"`
	ReservePct           float64         `json:"reservePct"`
	PayoutDay            float64         `json:"payoutDay"`
	Shortfall            string          `json:"shortfall"`
	Document             json.RawMessage `json:"document"`
}

// Contract is ManagementContract.
type Contract struct {
	ContractInput
	ID        string `json:"id"`
	Number    string `json:"number"`
	CreatedOn string `json:"createdOn"`
	Version   int64  `json:"-"`
}

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func whole(v float64) bool { return v == math.Trunc(v) && !math.IsInf(v, 0) }

// ValidateContract is validateContract, plus the enum fields the TypeScript types fix.
func ValidateContract(in ContractInput, contracts []Contract, excludeID string) error {
	var f errs.Fields
	pct := func(v float64) bool { return v >= 0 && v <= 100 }
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if in.OwnerID == "" {
		f.Add("ownerId", "Pick the owner.")
	}
	startOK := isoDate.MatchString(in.Start)
	if !startOK {
		f.Add("start", "Pick the start date.")
	}
	endOK := isoDate.MatchString(in.End) && in.End > in.Start
	if !endOK {
		f.Add("end", "End after the start.")
	}
	if !pct(in.FeePct) {
		f.Add("feePct", "A fee between 0 and 100 percent.")
	}
	if !pct(in.ReservePct) {
		f.Add("reservePct", "A reserve between 0 and 100 percent.")
	}
	if !whole(in.FixedMonthlyFee) || in.FixedMonthlyFee < 0 {
		f.Add("fixedMonthlyFee", "Whole rupiah, zero or more.")
	}
	if !whole(in.MaintenanceThreshold) || in.MaintenanceThreshold < 0 {
		f.Add("maintenanceThreshold", "Whole rupiah, zero or more.")
	}
	if !whole(in.OwnerNightsPerYear) || in.OwnerNightsPerYear < 0 || in.OwnerNightsPerYear > 365 {
		f.Add("ownerNightsPerYear", "Nights from 0 to 365.")
	}
	if !whole(in.OwnerStayPrice) || in.OwnerStayPrice < 0 {
		f.Add("ownerStayPrice", "Whole rupiah, zero or more.")
	}
	if !whole(in.PayoutDay) || in.PayoutDay < 1 || in.PayoutDay > 28 {
		f.Add("payoutDay", "A day from 1 to 28.")
	}
	if !slices.Contains([]string{FeeRoom, FeeGross, FeeGOP}, in.FeeBasis) {
		f.Add("feeBasis", "Pick what the fee is taken from.")
	}
	if !slices.Contains([]string{ChargedOperating, ChargedMaintenance, ChargedAll}, in.Charged) {
		f.Add("charged", "Pick the costs the owner bears.")
	}
	if !slices.Contains([]string{StayFree, StayCleaning, StayRate}, in.OwnerStayPricing) {
		f.Add("ownerStayPricing", "Pick how owner stays are priced.")
	}
	if !slices.Contains([]string{ShortfallCarry, ShortfallTopUp}, in.Shortfall) {
		f.Add("shortfall", "Pick what happens to a shortfall.")
	}
	if startOK && endOK && !f.Has("villaId") {
		for _, c := range contracts {
			if c.ID != excludeID && c.VillaID == in.VillaID && c.Start <= in.End && in.Start <= c.End {
				f.Add("villaId", "Another contract covers this villa on some of those dates.")
				break
			}
		}
	}
	return f.Err()
}

// MonthEnd is monthEnd: the last day of "YYYY-MM".
func MonthEnd(month string) string {
	return clock.AddDays(AddMonths(month+"-01", 1), -1)
}

// AddMonths is addMonths in src/lib/dates.ts: the same day of the month, clamped to its end.
func AddMonths(iso string, months int) string {
	d, err := clock.ParseDate(iso)
	if err != nil {
		return iso
	}
	target := time.Date(d.Year(), d.Month()+time.Month(months), 1, 0, 0, 0, 0, time.UTC)
	last := time.Date(target.Year(), target.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	return time.Date(target.Year(), target.Month(), min(d.Day(), last), 0, 0, 0, 0, time.UTC).Format(clock.DateLayout)
}

// CoversMonth reports a contract that runs at least one day of the month.
func (c Contract) CoversMonth(month string) bool {
	return c.Start <= MonthEnd(month) && month+"-01" <= c.End
}

// OverlapNights is overlapNights: nights of [aFrom, aTo) inside [bFrom, bTo).
func OverlapNights(aFrom, aTo, bFrom, bTo string) int {
	return max(0, clock.DaysBetween(max(aFrom, bFrom), min(aTo, bTo)))
}

// IsMaintenance is isMaintenance: work order expenses and the maintenance categories.
func IsMaintenance(origin, categoryID string) bool {
	return origin == "maintenance" || categoryID == "cat-maint" || categoryID == "cat-pool"
}

// StatementStay is one stay's share of the month, without the guest.
type StatementStay struct {
	BookingID string `json:"bookingId"`
	Code      string `json:"code"`
	UnitCode  string `json:"unitCode"`
	CheckIn   string `json:"checkIn"`
	CheckOut  string `json:"checkOut"`
	Source    string `json:"source"`
	Nights    int    `json:"nights"`
	Revenue   int64  `json:"revenue"`
	Fee       int64  `json:"fee"`
}

// Entry roles in the villa P&L.
const (
	RoleOther   = "other"
	RoleExpense = "expense"
)

// StatementEntry is one posted villa entry behind the figures.
type StatementEntry struct {
	TransactionID string `json:"transactionId"`
	Number        string `json:"number"`
	Date          string `json:"date"`
	Description   string `json:"description"`
	Category      string `json:"category"`
	Role          string `json:"role"`
	Amount        int64  `json:"amount"`
	Charged       bool   `json:"charged"`
}

// BookEntry is a villa entry as finance reports it, with what the maintenance rule reads.
type BookEntry struct {
	StatementEntry
	CategoryID string
	Origin     string
}

// StatementBase is the month's figures the books give, before the contract applies.
type StatementBase struct {
	RoomRevenue        int64 `json:"roomRevenue"`
	OtherRevenue       int64 `json:"otherRevenue"`
	AirbnbFees         int64 `json:"airbnbFees"`
	Expenses           int64 `json:"expenses"`
	Payroll            int64 `json:"payroll"`
	MaintenanceCharged int64 `json:"maintenanceCharged"`
	OwnerNights        int64 `json:"ownerNights"`
	OwnerStays         int64 `json:"ownerStays"`
}

// StatementFigures is the contract applied to the base.
type StatementFigures struct {
	StatementBase
	TotalRevenue    int64 `json:"totalRevenue"`
	Charged         int64 `json:"charged"`
	GOP             int64 `json:"gop"`
	ManagementFee   int64 `json:"managementFee"`
	Reserve         int64 `json:"reserve"`
	OwnerStayCharge int64 `json:"ownerStayCharge"`
	NetPayable      int64 `json:"netPayable"`
}

// jsRound is Math.round.
func jsRound(v float64) int64 { return int64(math.Floor(v + 0.5)) }

// Figures is statementFigures.
func Figures(c ContractInput, base StatementBase) StatementFigures {
	total := base.RoomRevenue + base.OtherRevenue
	var charged int64
	switch c.Charged {
	case ChargedMaintenance:
		charged = base.AirbnbFees + base.MaintenanceCharged
	case ChargedAll:
		charged = base.AirbnbFees + base.Expenses + base.Payroll
	default:
		charged = base.AirbnbFees + base.Expenses
	}
	gop := total - charged
	var feeBase int64
	switch c.FeeBasis {
	case FeeRoom:
		feeBase = base.RoomRevenue
	case FeeGross:
		feeBase = total
	default:
		feeBase = max(0, gop)
	}
	fee := jsRound(float64(feeBase)*c.FeePct/100) + int64(c.FixedMonthlyFee)
	reserve := jsRound(float64(total) * c.ReservePct / 100)
	var stay int64
	switch c.OwnerStayPricing {
	case StayCleaning:
		stay = base.OwnerStays * int64(c.OwnerStayPrice)
	case StayRate:
		stay = base.OwnerNights * int64(c.OwnerStayPrice)
	}
	return StatementFigures{StatementBase: base, TotalRevenue: total, Charged: charged, GOP: gop, ManagementFee: fee, Reserve: reserve, OwnerStayCharge: stay, NetPayable: gop - fee - reserve - stay}
}

// Block is a unit block as owners reads it.
type Block struct {
	ID     string
	UnitID string
	From   string
	To     string
	Reason string
}

// OwnerNightsIn is ownerNightsIn: owner stay nights inside [from, to) on the units, and the stays
// that start in it.
func OwnerNightsIn(blocks []Block, unitIDs map[string]bool, from, to string) (nights, stays int64) {
	for _, b := range blocks {
		if b.Reason != "owner" || !unitIDs[b.UnitID] {
			continue
		}
		nights += int64(OverlapNights(b.From, b.To, from, to))
		if b.From >= from && b.From < to {
			stays++
		}
	}
	return nights, stays
}

// Books is the month of one villa that a draft reads: stays and entries from finance's villa
// results, owner nights from the owner blocks.
type Books struct {
	Stays       []StatementStay
	Entries     []BookEntry
	Payroll     int64
	OwnerNights int64
	OwnerStays  int64
}

// Draft is the statement a close would write.
type Draft struct {
	Base    StatementBase
	Figures StatementFigures
	Stays   []StatementStay
	Entries []StatementEntry
}

// StatementDraft is statementDraft over the books finance reports: it keeps stays that earn in the
// month in check-in order, flags maintenance entries the contract charges, and adds up the base.
func StatementDraft(c ContractInput, b Books) Draft {
	stays := []StatementStay{}
	for _, s := range b.Stays {
		if s.Revenue > 0 || s.Fee > 0 {
			stays = append(stays, s)
		}
	}
	sort.SliceStable(stays, func(i, j int) bool { return stays[i].CheckIn < stays[j].CheckIn })
	entries := []StatementEntry{}
	for _, e := range b.Entries {
		if e.Role != RoleOther && e.Role != RoleExpense {
			continue
		}
		x := e.StatementEntry
		x.Charged = c.Charged == ChargedMaintenance && e.Role == RoleExpense && IsMaintenance(e.Origin, e.CategoryID) && float64(e.Amount) >= c.MaintenanceThreshold
		entries = append(entries, x)
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Date < entries[j].Date })
	base := StatementBase{Payroll: b.Payroll, OwnerNights: b.OwnerNights, OwnerStays: b.OwnerStays}
	for _, s := range stays {
		base.RoomRevenue += s.Revenue
		base.AirbnbFees += s.Fee
	}
	for _, e := range entries {
		switch e.Role {
		case RoleOther:
			base.OtherRevenue += e.Amount
		case RoleExpense:
			base.Expenses += e.Amount
		}
		if e.Charged {
			base.MaintenanceCharged += e.Amount
		}
	}
	return Draft{Base: base, Figures: Figures(c, base), Stays: stays, Entries: entries}
}

// AssertDrillDown is assertDrillDown: the lines must add up to the figures they explain.
func AssertDrillDown(base StatementBase, stays []StatementStay, entries []StatementEntry) error {
	var revenue, fees, other, expenses, maintenance int64
	for _, s := range stays {
		revenue += s.Revenue
		fees += s.Fee
	}
	for _, e := range entries {
		if e.Role == RoleOther {
			other += e.Amount
		}
		if e.Role == RoleExpense {
			expenses += e.Amount
		}
		if e.Charged {
			maintenance += e.Amount
		}
	}
	checks := []struct {
		name          string
		figure, lines int64
	}{
		{"Room revenue", base.RoomRevenue, revenue},
		{"Airbnb fees", base.AirbnbFees, fees},
		{"Other revenue", base.OtherRevenue, other},
		{"Expenses", base.Expenses, expenses},
		{"Maintenance charged", base.MaintenanceCharged, maintenance},
	}
	for _, c := range checks {
		if c.figure != c.lines {
			return errs.Newf("STATEMENT_MISMATCH", "%s of %d differs from its lines, which add up to %d.", c.name, c.figure, c.lines)
		}
	}
	return nil
}

// Statement statuses.
const (
	StatementClosed   = "closed"
	StatementApproved = "approved"
)

// Payout is the cash entry a statement asked finance for, as finance reports it back.
type Payout struct {
	// Ref is the sourceRef of the payout request; finance's events carry it back.
	Ref           string
	TransactionID string
	Number        string
	// Status is finance's transaction status: submitted until finance reports approved, posted or
	// rejected.
	Status string
}

// Statement is OwnerStatement.
type Statement struct {
	ID                  string           `json:"id"`
	Number              string           `json:"number"`
	ContractID          string           `json:"contractId"`
	OwnerID             string           `json:"ownerId"`
	VillaID             string           `json:"villaId"`
	Month               string           `json:"month"`
	Figures             StatementFigures `json:"figures"`
	Stays               []StatementStay  `json:"stays"`
	Entries             []StatementEntry `json:"entries"`
	Status              string           `json:"status"`
	BroughtFrom         *string          `json:"broughtFrom"`
	BroughtForward      int64            `json:"broughtForward"`
	Payable             int64            `json:"payable"`
	Shortfall           string           `json:"shortfall"`
	ClosedBy            string           `json:"closedBy"`
	ClosedByID          string           `json:"closedById"`
	ClosedOn            string           `json:"closedOn"`
	ApprovedBy          *string          `json:"approvedBy"`
	ApprovedOn          *string          `json:"approvedOn"`
	Note                string           `json:"note"`
	PayoutTransactionID *string          `json:"payoutTransactionId"`
	JournalID           *string          `json:"journalId"`
	Payout              *Payout          `json:"-"`
	Version             int64            `json:"-"`
}

// StatementNumber is statementNumber.
func StatementNumber(month, villaCode string) string { return "OS-" + month + "-" + villaCode }

// PreviousStatement is previousStatement: the contract's latest statement before the month.
func PreviousStatement(statements []Statement, contractID, month string) *Statement {
	var last *Statement
	for i := range statements {
		s := &statements[i]
		if s.ContractID == contractID && s.Month < month && (last == nil || s.Month > last.Month) {
			last = s
		}
	}
	return last
}

// Settlement is settlement: what a carried shortfall takes off this month.
type Settlement struct {
	BroughtFrom    *string `json:"broughtFrom"`
	BroughtForward int64   `json:"broughtForward"`
	Payable        int64   `json:"payable"`
}

// Settle is settlement.
func Settle(net int64, previous *Statement) Settlement {
	if previous != nil && previous.Shortfall == ShortfallCarry && previous.Payable < 0 {
		from := previous.Month
		return Settlement{BroughtFrom: &from, BroughtForward: -previous.Payable, Payable: net + previous.Payable}
	}
	return Settlement{Payable: net}
}

// Payout states, read off the cash entry.
const (
	PayoutNone     = "none"
	PayoutWaiting  = "waiting"
	PayoutPaid     = "paid"
	PayoutRejected = "rejected"
)

// PayoutState is payoutState.
func PayoutState(p *Payout) string {
	switch {
	case p == nil:
		return PayoutNone
	case p.Status == "posted":
		return PayoutPaid
	case p.Status == "rejected" || p.Status == "reversed":
		return PayoutRejected
	default:
		return PayoutWaiting
	}
}

// TopsUp is topsUp: a negative payable the owner tops up in cash.
func (s Statement) TopsUp() bool { return s.Shortfall == ShortfallTopUp && s.Payable < 0 }

var monthPattern = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)

// AssertClosable is assertClosableStatement.
func AssertClosable(c Contract, month, today string, statements []Statement, pending int) error {
	if !monthPattern.MatchString(month) {
		return errs.New(errs.CodeValidation, "Pick a month as YYYY-MM.")
	}
	if month >= today[:7] {
		return errs.New("STATEMENT_MONTH_OPEN", "The month has not ended yet; close its statement from the 1st of the next month.")
	}
	if !c.CoversMonth(month) {
		return errs.Newf("CONTRACT_NOT_ACTIVE", "Contract %s does not run in %s.", c.Number, month)
	}
	for _, s := range statements {
		if s.ContractID == c.ID && s.Month == month {
			return errs.Newf("STATEMENT_CLOSED", "The %s statement of %s is already closed.", month, c.Number)
		}
	}
	for _, s := range statements {
		if s.ContractID == c.ID && s.Month > month {
			return errs.Newf("STATEMENT_ORDER", "%s is already closed; reopen it before closing an earlier month.", s.Number)
		}
	}
	if pending > 0 {
		if pending == 1 {
			return errs.Newf("STATEMENT_PENDING", "1 entry of the villa dated in %s still waits for approval or posting.", month)
		}
		return errs.Newf("STATEMENT_PENDING", "%d entries of the villa dated in %s still wait for approval or posting.", pending, month)
	}
	return nil
}

// AssertReopenable is assertReopenable.
func AssertReopenable(st Statement, statements []Statement, reason string) error {
	if len([]rune(strings.TrimSpace(reason))) < 3 {
		return errs.New(errs.CodeValidation, "Say why the statement reopens.")
	}
	for _, s := range statements {
		if s.ContractID == st.ContractID && s.Month > st.Month {
			return errs.Newf("STATEMENT_ORDER", "%s comes after %s; reopen it first.", s.Number, st.Number)
		}
	}
	switch PayoutState(st.Payout) {
	case PayoutPaid:
		return errs.Newf("STATEMENT_PAID", "%s is settled by %s; it no longer reopens.", st.Number, st.Payout.Label())
	case PayoutWaiting:
		return errs.Newf("PAYOUT_OPEN", "%s has %s waiting for approval; reject it before reopening.", st.Number, st.Payout.Label())
	}
	return nil
}

// Label names the payout: finance's number once known, else the request reference.
func (p *Payout) Label() string {
	if p.Number != "" {
		return p.Number
	}
	return p.Ref
}

// CanSignOwnerLevel is canSignLevel(role, 'owner').
func CanSignOwnerLevel(role string) bool { return role == "owner" || role == "admin" }

// AssertPayable refuses a payout the statement does not allow; it returns whether the owner tops up.
func AssertPayable(st Statement) (topUp bool, err error) {
	if st.Status != StatementApproved {
		return false, errs.Newf("STATEMENT_NOT_APPROVED", "%s needs the Owner’s approval before it is paid.", st.Number)
	}
	topUp = st.TopsUp()
	if st.Payable < 0 && !topUp {
		return false, errs.Newf("PAYOUT_NOTHING", "%s carries %d forward to the next statement; nothing is paid this month.", st.Number, -st.Payable)
	}
	if st.Payable == 0 {
		return false, errs.Newf("PAYOUT_NOTHING", "%s leaves nothing to pay the owner.", st.Number)
	}
	if s := PayoutState(st.Payout); s == PayoutWaiting || s == PayoutPaid {
		status := st.Payout.Status
		return false, errs.Newf("PAYOUT_OPEN", "%s already has payout %s, %s.", st.Number, st.Payout.Label(), status)
	}
	return topUp, nil
}

// Owner stay statuses.
const (
	StayPending   = "pending"
	StayApproved  = "approved"
	StayDeclined  = "declined"
	StayCancelled = "cancelled"
)

// StayInput is OwnerStayInput.
type StayInput struct {
	ContractID string  `json:"contractId"`
	CheckIn    string  `json:"checkIn"`
	CheckOut   string  `json:"checkOut"`
	Guests     float64 `json:"guests"`
	Note       string  `json:"note"`
}

// StayRequest is OwnerStayRequest.
type StayRequest struct {
	StayInput
	ID           string  `json:"id"`
	Number       string  `json:"number"`
	OwnerID      string  `json:"ownerId"`
	VillaID      string  `json:"villaId"`
	Status       string  `json:"status"`
	RequestedOn  string  `json:"requestedOn"`
	UnitID       *string `json:"unitId"`
	BlockID      *string `json:"blockId"`
	DecidedBy    *string `json:"decidedBy"`
	DecidedOn    *string `json:"decidedOn"`
	DecisionNote string  `json:"decisionNote"`
	Version      int64   `json:"-"`
}

// OwnerNightsUsed is ownerNightsUsed: nights of the year's approved and waiting stays.
func OwnerNightsUsed(requests []StayRequest, contractID, year, excludeID string) int {
	from := year + "-01-01"
	to := fmt.Sprintf("%d-01-01", atoi(year)+1)
	n := 0
	for _, r := range requests {
		if r.ContractID == contractID && r.ID != excludeID && (r.Status == StayApproved || r.Status == StayPending) {
			n += OverlapNights(r.CheckIn, r.CheckOut, from, to)
		}
	}
	return n
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// ValidateStay is validateOwnerStay.
func ValidateStay(in StayInput, c Contract, requests []StayRequest, today string) error {
	if !isoDate.MatchString(in.CheckIn) || !isoDate.MatchString(in.CheckOut) || in.CheckOut <= in.CheckIn {
		return errs.New("OWNER_STAY_DATES", "Pick an arrival and a later departure.")
	}
	if in.CheckIn < today {
		return errs.New("OWNER_STAY_DATES", "Pick an arrival from today on.")
	}
	if in.CheckIn < c.Start || in.CheckOut > clock.AddDays(c.End, 1) {
		return errs.Newf("OWNER_STAY_DATES", "The contract runs from %s to %s.", c.Start, c.End)
	}
	if !whole(in.Guests) || in.Guests < 1 {
		return errs.New(errs.CodeValidation, "At least one guest.")
	}
	last := atoi(clock.AddDays(in.CheckOut, -1)[:4])
	for y := atoi(in.CheckIn[:4]); y <= last; y++ {
		year := fmt.Sprintf("%d", y)
		asked := OverlapNights(in.CheckIn, in.CheckOut, year+"-01-01", fmt.Sprintf("%d-01-01", y+1))
		used := OwnerNightsUsed(requests, c.ID, year, "")
		allowed := int(c.OwnerNightsPerYear)
		if used+asked > allowed {
			return errs.Newf("OWNER_NIGHTS_EXCEEDED", "The contract allows %d owner nights in %s; %d are taken or asked for, so %d remain.", allowed, year, used, max(0, allowed-used))
		}
	}
	return nil
}

// PeriodLabel is periodLabel: "October 2026".
func PeriodLabel(month string) string {
	t, err := time.Parse("2006-01", month)
	if err != nil {
		return month
	}
	return t.Format("January 2006")
}
