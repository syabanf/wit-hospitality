package domain

import (
	"cmp"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// GL account ids of the base chart (GL in journal.ts).
const (
	GLTransit         = "gl-1090"
	GLReceivable      = "gl-1200"
	GLCityLedger      = "gl-1210"
	GLOwnerReceivable = "gl-1220"
	GLEmployeeLoans   = "gl-1300"
	GLDeposits        = "gl-2100"
	GLPartnerPayable  = "gl-2200"
	GLPayrollPayable  = "gl-2300"
	GLBpjsPayable     = "gl-2310"
	GLPph21Payable    = "gl-2320"
	GLPb1Payable      = "gl-2330"
	GLServicePayable  = "gl-2400"
	GLOwnerPayable    = "gl-2500"
	GLOwnerReserve    = "gl-2510"
	GLOwnerEquity     = "gl-3000"
	GLRetained        = "gl-3100"
	GLRoomRevenue     = "gl-4100"
	GLManagementFee   = "gl-4800"
	GLOtherIncome     = "gl-4900"
	GLPartnerCost     = "gl-5100"
	GLOwnerShare      = "gl-5900"
	GLWages           = "gl-6100"
	GLEmployerBpjs    = "gl-6110"
	GLFees            = "gl-6700"
	GLAgentCommission = "gl-6750"
	GLVariance        = "gl-6900"
	GLBadDebt         = "gl-6950"
	GLOtherExpense    = "gl-6990"
)

// GlAccount is one account of the chart.
type GlAccount struct {
	ID            string  `json:"id"`
	Code          string  `json:"code"`
	Name          string  `json:"name"`
	Type          string  `json:"type"`
	Normal        string  `json:"normal"`
	CashAccountID *string `json:"cashAccountId"`
}

func gl(id, code, name, typ string) GlAccount {
	normal := "credit"
	if typ == "asset" || typ == "expense" {
		normal = "debit"
	}
	return GlAccount{ID: id, Code: code, Name: name, Type: typ, Normal: normal}
}

// BaseChart is BASE_CHART, in the TypeScript order.
var BaseChart = []GlAccount{
	gl(GLTransit, "1090", "Cash in transit", "asset"),
	gl(GLReceivable, "1200", "Accounts receivable, guests", "asset"),
	gl(GLCityLedger, "1210", "City ledger receivable", "asset"),
	gl(GLOwnerReceivable, "1220", "Receivable from villa owners", "asset"),
	gl(GLEmployeeLoans, "1300", "Employee loans and advances", "asset"),
	gl(GLDeposits, "2100", "Guest deposits received in advance", "liability"),
	gl(GLPartnerPayable, "2200", "Payables to service partners", "liability"),
	gl(GLPayrollPayable, "2300", "Payroll payable", "liability"),
	gl(GLBpjsPayable, "2310", "BPJS payable", "liability"),
	gl(GLPph21Payable, "2320", "PPh 21 payable", "liability"),
	gl(GLPb1Payable, "2330", "PB1 payable", "liability"),
	gl(GLServicePayable, "2400", "Service charge payable", "liability"),
	gl(GLOwnerPayable, "2500", "Payable to villa owners", "liability"),
	gl(GLOwnerReserve, "2510", "FF&E reserve held for villa owners", "liability"),
	gl(GLOwnerEquity, "3000", "Owner equity", "equity"),
	gl(GLRetained, "3100", "Retained earnings", "equity"),
	gl(GLRoomRevenue, "4100", "Room revenue", "revenue"),
	gl("gl-4210", "4210", "Room service, food and drinks", "revenue"),
	gl("gl-4220", "4220", "Room service, minibar", "revenue"),
	gl("gl-4230", "4230", "Room service, laundry", "revenue"),
	gl("gl-4240", "4240", "Room service, transport", "revenue"),
	gl("gl-4250", "4250", "Room service, spa", "revenue"),
	gl("gl-4260", "4260", "Room service, tours", "revenue"),
	gl("gl-4270", "4270", "Room service, extras", "revenue"),
	gl(GLManagementFee, "4800", "Management fee income", "revenue"),
	gl(GLOtherIncome, "4900", "Other income", "revenue"),
	gl(GLPartnerCost, "5100", "Service partner costs", "expense"),
	gl(GLWages, "6100", "Salaries and wages", "expense"),
	gl(GLEmployerBpjs, "6110", "Employer BPJS", "expense"),
	gl("gl-6200", "6200", "Utilities", "expense"),
	gl("gl-6300", "6300", "Housekeeping supplies", "expense"),
	gl("gl-6350", "6350", "Minibar stock", "expense"),
	gl("gl-6400", "6400", "Maintenance and repairs", "expense"),
	gl("gl-6500", "6500", "Staff and transport", "expense"),
	gl("gl-6600", "6600", "Marketing", "expense"),
	gl(GLFees, "6700", "Payment and bank fees", "expense"),
	gl(GLAgentCommission, "6750", "Agent commission", "expense"),
	gl("gl-6800", "6800", "Guest activities", "expense"),
	gl(GLVariance, "6900", "Cash over and short", "expense"),
	gl(GLBadDebt, "6950", "Bad debt expense", "expense"),
	gl(GLOtherExpense, "6990", "Other expenses", "expense"),
	gl(GLOwnerShare, "5900", "Owner share of villa results", "expense"),
}

// CashGlID is cashGlId.
func CashGlID(cashAccountID string) string { return "gl-cash-" + cashAccountID }

// ChartOfAccounts is chartOfAccounts: one cash account per cash account, coded 1001 upward in the
// order opened, then the base chart, sorted by code.
func ChartOfAccounts(cash []CashAccount) []GlAccount {
	out := make([]GlAccount, 0, len(cash)+len(BaseChart))
	for i, a := range cash {
		g := gl(CashGlID(a.ID), strconv.Itoa(1001+i), a.Name, "asset")
		g.CashAccountID = Ptr(a.ID)
		out = append(out, g)
	}
	out = append(out, BaseChart...)
	slices.SortStableFunc(out, func(a, b GlAccount) int { return strings.Compare(a.Code, b.Code) })
	return out
}

func findAccount(chart []GlAccount, id string) (GlAccount, bool) {
	i := slices.IndexFunc(chart, func(a GlAccount) bool { return a.ID == id })
	if i < 0 {
		return GlAccount{}, false
	}
	return chart[i], true
}

// CategoryAccount is categoryAccount: a guest revenue category books to its code's account,
// any other to its mapping, else other income or other expenses.
func CategoryAccount(m map[string]string, categoryID, kind string, codes []TransactionCode) string {
	if code, ok := CategoryCode[categoryID]; ok {
		return CodeAccount(codes, code)
	}
	if a, ok := m[categoryID]; ok {
		return a
	}
	if kind == CashIn {
		return GLOtherIncome
	}
	return GLOtherExpense
}

// ValidateMapping is validateMapping.
func ValidateMapping(accountID string, chart []GlAccount, categoryID string) error {
	if code, ok := CategoryCode[categoryID]; ok {
		return errs.Newf("CATEGORY_FOLLOWS_CODE", "Guest revenue in this category books to the account of transaction code %s; change it on the Transaction codes page.", code)
	}
	a, ok := findAccount(chart, accountID)
	if !ok {
		return errs.New("LEDGER_ACCOUNT_INVALID", "Pick an account from the chart.")
	}
	if a.CashAccountID != nil {
		return errs.Newf("LEDGER_ACCOUNT_INVALID", "%s is a cash account; a category books against the cash account, not into it.", a.Name)
	}
	return nil
}

// JournalLine is one debit or credit; BookingID, PartnerID and Code tag receivable, deposit,
// payable and revenue lines.
type JournalLine struct {
	AccountID string `json:"accountId"`
	Debit     int64  `json:"debit"`
	Credit    int64  `json:"credit"`
	BookingID string `json:"bookingId,omitempty"`
	PartnerID string `json:"partnerId,omitempty"`
	Code      string `json:"code,omitempty"`
}

// Journal sources.
const (
	SourceOpening     = "opening"
	SourceTransaction = "transaction"
	SourceTransfer    = "transfer"
	SourcePayroll     = "payroll"
	SourceManual      = "manual"
	SourceFolio       = "folio"
	SourceAudit       = "audit"
	SourceCharge      = "charge"
	SourceOrder       = "order"
	SourceOwner       = "owner"
	SourceCityLedger  = "city_ledger"
)

// JournalEntry is a posted, numbered entry. Entries are written once and never edited.
type JournalEntry struct {
	Date         string        `json:"date"`
	VillaID      *string       `json:"villaId"`
	Memo         string        `json:"memo"`
	Source       string        `json:"source"`
	SourceID     string        `json:"sourceId"`
	SourceNumber string        `json:"sourceNumber"`
	Origin       *string       `json:"origin"`
	Lines        []JournalLine `json:"lines"`
	ID           string        `json:"id,omitempty"`
	Number       string        `json:"number,omitempty"`
	PostedOn     string        `json:"postedOn,omitempty"`
	PostedBy     string        `json:"postedBy,omitempty"`
}

// Numbered is numbered().
func (d JournalEntry) Numbered(n int64, postedOn, postedBy string) JournalEntry {
	d.ID, d.Number, d.PostedOn, d.PostedBy = fmt.Sprintf("je-%d", n), fmt.Sprintf("JE-%05d", n), postedOn, postedBy
	return d
}

func dr(account string, amount int64) JournalLine {
	return JournalLine{AccountID: account, Debit: amount}
}
func cr(account string, amount int64) JournalLine {
	return JournalLine{AccountID: account, Credit: amount}
}

// TotalDebits sums the debits.
func TotalDebits(lines []JournalLine) int64 {
	var s int64
	for _, l := range lines {
		s += l.Debit
	}
	return s
}

// TotalCredits sums the credits.
func TotalCredits(lines []JournalLine) int64 {
	var s int64
	for _, l := range lines {
		s += l.Credit
	}
	return s
}

// AssertBalanced is assertBalanced: whole rupiah, one side per line, debits equal credits.
func AssertBalanced(lines []JournalLine) error {
	if len(lines) < 2 {
		return errs.New("JOURNAL_UNBALANCED", "A journal entry needs at least two lines.")
	}
	for _, l := range lines {
		if l.Debit < 0 || l.Credit < 0 {
			return errs.New("JOURNAL_UNBALANCED", "Journal amounts are whole rupiah, zero or more.")
		}
		if (l.Debit > 0) == (l.Credit > 0) {
			return errs.New("JOURNAL_UNBALANCED", "Each journal line is either a debit or a credit.")
		}
	}
	d, c := TotalDebits(lines), TotalCredits(lines)
	if d != c {
		diff := d - c
		if diff < 0 {
			diff = -diff
		}
		return errs.Newf("JOURNAL_UNBALANCED", "Debits of %d and credits of %d differ by %d.", d, c, diff)
	}
	return nil
}

// balanced drops zero lines and checks the rest; optional returns nil when nothing is left.
func balanced(d JournalEntry, optional bool) (*JournalEntry, error) {
	lines := make([]JournalLine, 0, len(d.Lines))
	for _, l := range d.Lines {
		if l.Debit > 0 || l.Credit > 0 {
			lines = append(lines, l)
		}
	}
	if optional && len(lines) == 0 {
		return nil, nil
	}
	if err := AssertBalanced(lines); err != nil {
		return nil, err
	}
	d.Lines = lines
	return &d, nil
}

// Stay is what the guest money rules read of a booking: its state and the day its room was
// first billed (the first audited night, or the check-out when no audit reached it).
type Stay struct {
	ID       string  `json:"id"`
	Code     string  `json:"code"`
	VillaID  *string `json:"villaId"`
	Status   string  `json:"status"`
	BilledOn *string `json:"billedOn"`
}

// Share is one stay's part of a group payment.
type Share struct {
	BookingID string `json:"bookingId"`
	Amount    int64  `json:"amount"`
}

// EntryLink is what other contexts said about a cash entry when they asked for it: the payment
// shares, whether the money paid for room service orders, whether a service request took it, and
// the partner a bill pays.
type EntryLink struct {
	TransactionID string  `json:"transactionId"`
	Shares        []Share `json:"shares"`
	OrderMoney    bool    `json:"orderMoney"`
	Request       bool    `json:"request"`
	PartnerID     *string `json:"partnerId"`
	// Cancelled marks a rejected purchase its context gave up: it stays rejected.
	Cancelled bool `json:"cancelled,omitempty"`
}

// PayrollTotals is what a closed payroll withheld and owes beside the salaries paid.
type PayrollTotals struct {
	PeriodID      string `json:"periodId"`
	Month         string `json:"month"`
	EmployeeBpjs  int64  `json:"employeeBpjs"`
	CompanyBpjs   int64  `json:"companyBpjs"`
	Pph21         int64  `json:"pph21"`
	Loans         int64  `json:"loans"`
	ServiceCharge int64  `json:"serviceCharge"`
}

// Books is what JournalFor reads besides the entry.
type Books struct {
	Map        map[string]string
	Categories []Category
	Codes      []TransactionCode
	// Twin is the other half of a transfer when it counts.
	Twin *Transaction
	// Payroll is set for the salary payment of a closed payroll.
	Payroll *PayrollTotals
	// Self and Origin are the links of the entry and of the entry it reverses.
	Self, Origin *EntryLink
	// Stays answers the guest money rules; nil books every entry by its category.
	Stays map[string]Stay
}

func origin(t Transaction) *string { return Ptr(t.Origin) }

func fromTransaction(t Transaction, source string, lines []JournalLine) (*JournalEntry, error) {
	return balanced(JournalEntry{Date: t.Date, VillaID: t.VillaID, Memo: t.Description, Source: source, SourceID: t.ID, SourceNumber: t.Number, Origin: origin(t), Lines: lines}, false)
}

// side is a line of the other side before cashJournal puts it on its side.
type side struct {
	JournalLine
	amount int64
}

func (b Books) mapped(t Transaction) string {
	kind := t.Kind
	if i := slices.IndexFunc(b.Categories, func(c Category) bool { return c.ID == t.CategoryID }); i >= 0 {
		kind = b.Categories[i].Kind
	}
	return CategoryAccount(b.Map, t.CategoryID, kind, b.Codes)
}

func (b Books) byCategory(t Transaction, amount int64) side {
	return side{JournalLine: JournalLine{AccountID: b.mapped(t), Code: CategoryCode[t.CategoryID]}, amount: amount}
}

func cashJournal(t Transaction, others []side) (*JournalEntry, error) {
	cash := CashGlID(t.AccountID)
	lines := make([]JournalLine, 0, len(others)+1)
	if t.Kind == CashIn {
		lines = append(lines, dr(cash, t.Amount))
	}
	for _, o := range others {
		l := o.JournalLine
		if t.Kind == CashIn {
			l.Credit = o.amount
		} else {
			l.Debit = o.amount
		}
		lines = append(lines, l)
	}
	if t.Kind != CashIn {
		lines = append(lines, cr(cash, t.Amount))
	}
	return fromTransaction(t, SourceTransaction, lines)
}

func transferJournal(out, into Transaction) (*JournalEntry, error) {
	d, err := fromTransaction(out, SourceTransfer, []JournalLine{dr(CashGlID(into.AccountID), into.Amount), cr(CashGlID(out.AccountID), out.Amount)})
	if err != nil {
		return nil, err
	}
	d.Memo = fmt.Sprintf("%s (%s and %s)", out.Description, out.Number, into.Number)
	return d, nil
}

// PayrollJournal is payrollJournal from the payroll's totals.
func PayrollJournal(p PayrollTotals, paid Transaction) (*JournalEntry, error) {
	d, err := fromTransaction(paid, SourcePayroll, []JournalLine{
		dr(GLWages, paid.Amount+p.EmployeeBpjs+p.Pph21+p.Loans-p.ServiceCharge),
		dr(GLServicePayable, p.ServiceCharge),
		dr(GLEmployerBpjs, p.CompanyBpjs),
		cr(CashGlID(paid.AccountID), paid.Amount),
		cr(GLBpjsPayable, p.EmployeeBpjs+p.CompanyBpjs),
		cr(GLPph21Payable, p.Pph21),
		cr(GLEmployeeLoans, p.Loans),
	})
	if err != nil {
		return nil, err
	}
	d.Memo = fmt.Sprintf("Payroll %s: salaries paid with %s", PeriodLabel(p.Month), paid.Number)
	d.SourceID, d.SourceNumber = p.PeriodID, "PAY-"+p.Month
	return d, nil
}

// Categories behind the guest money rules.
var (
	billedCategories = []string{"cat-extra", "cat-svc-fnb", "cat-svc-laundry", "cat-svc-transport", "cat-svc-spa", "cat-svc-tours", "cat-svc-other"}
	guestCategories  = append([]string{"cat-room", "cat-airbnb", "cat-deposit", "cat-other"}, billedCategories...)
)

// PartnerCostCategory is PARTNER_COST_CATEGORY.
const PartnerCostCategory = "cat-svc-partner"

func (b Books) isGuestMoney(t Transaction) bool {
	if t.BookingID == nil || !slices.Contains(guestCategories, t.CategoryID) {
		return false
	}
	return !(b.Self != nil && b.Self.Request) && !(b.Origin != nil && b.Origin.Request)
}

func postedOn(t Transaction) string {
	for i := len(t.History) - 1; i >= 0; i-- {
		if t.History[i].Kind == "posted" {
			return t.History[i].On
		}
	}
	return t.Date
}

// guestAccount is guestAccount: "" books by the category.
func guestAccount(t Transaction, s *Stay, on string, orderMoney bool) string {
	if s == nil {
		return ""
	}
	if orderMoney || slices.Contains(billedCategories, t.CategoryID) {
		return GLReceivable
	}
	if s.Status == "cancelled" || s.Status == "no_show" {
		return ""
	}
	if s.BilledOn != nil && *s.BilledOn <= on {
		return GLReceivable
	}
	return GLDeposits
}

func (b Books) guestJournal(t Transaction) (*JournalEntry, error) {
	split := []Share{{BookingID: t.Booking(), Amount: t.Amount}}
	if b.Self != nil && len(b.Self.Shares) > 1 {
		var sum int64
		for _, s := range b.Self.Shares {
			sum += s.Amount
		}
		if sum == t.Amount {
			split = b.Self.Shares
		}
	}
	link := b.Self
	if t.ReversalOf != nil {
		link = b.Origin
	}
	orderMoney := link != nil && link.OrderMoney
	sides := make([]side, 0, len(split))
	for _, s := range split {
		var stay *Stay
		if st, ok := b.Stays[s.BookingID]; ok {
			stay = &st
		}
		if acc := guestAccount(t, stay, postedOn(t), orderMoney); acc != "" {
			sides = append(sides, side{JournalLine: JournalLine{AccountID: acc, BookingID: s.BookingID}, amount: s.Amount})
		} else {
			sides = append(sides, b.byCategory(t, s.Amount))
		}
	}
	return cashJournal(t, sides)
}

func (b Books) partnerBillJournal(t Transaction) (*JournalEntry, error) {
	acc := b.mapped(t)
	link := b.Self
	if t.ReversalOf != nil {
		link = b.Origin
	}
	l := JournalLine{AccountID: acc}
	if acc == GLPartnerPayable && link != nil && link.PartnerID != nil {
		l.PartnerID = *link.PartnerID
	}
	return cashJournal(t, []side{{JournalLine: l, amount: t.Amount}})
}

// JournalFor is journalFor: one entry for both halves of a transfer, the payroll entry for a
// salary payment, the guest money rules for a stay's money, a partner bill on the payable, else
// the category's account.
func JournalFor(t Transaction, b Books) (*JournalEntry, error) {
	if t.TransferID != nil && b.Twin != nil {
		if t.Kind == CashOut {
			return transferJournal(t, *b.Twin)
		}
		return transferJournal(*b.Twin, t)
	}
	if t.Origin == "payroll" && b.Payroll != nil {
		return PayrollJournal(*b.Payroll, t)
	}
	if b.Stays != nil && b.isGuestMoney(t) {
		return b.guestJournal(t)
	}
	if t.CategoryID == PartnerCostCategory {
		return b.partnerBillJournal(t)
	}
	return cashJournal(t, []side{b.byCategory(t, t.Amount)})
}

// OpeningJournal is openingJournals for one new account: its opening balance against owner equity.
func OpeningJournal(a CashAccount) (*JournalEntry, error) {
	if a.OpeningBalance <= 0 {
		return nil, nil
	}
	return balanced(JournalEntry{Date: a.OpenedOn, Memo: "Opening balances of " + a.Name, Source: SourceOpening, SourceID: "opening-" + a.OpenedOn, SourceNumber: "Opening",
		Lines: []JournalLine{dr(CashGlID(a.ID), a.OpeningBalance), cr(GLOwnerEquity, a.OpeningBalance)}}, false)
}

// TaxSplit is one charge as its net amount, service and PB1.
type TaxSplit struct {
	Net     int64 `json:"net"`
	Service int64 `json:"service"`
	PB1     int64 `json:"pb1"`
}

// Gross is grossOf.
func (s TaxSplit) Gross() int64 { return s.Net + s.Service + s.PB1 }

// Codes the folio puts service and PB1 on.
const (
	ServiceCode = "SVC"
	PB1Code     = "PB1"
)

// signedLine is one line on whichever side the sign puts it.
func signedLine(account string, amount int64, debitSide bool, tag JournalLine) JournalLine {
	tag.AccountID = account
	if (amount >= 0) == debitSide {
		tag.Debit = abs(amount)
	} else {
		tag.Credit = abs(amount)
	}
	return tag
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// move is two lines moving amount into one account out of another; negative moves it back.
func move(into, from string, amount int64, bookingID string) []JournalLine {
	if amount >= 0 {
		return []JournalLine{{AccountID: into, Debit: amount, BookingID: bookingID}, {AccountID: from, Credit: amount, BookingID: bookingID}}
	}
	return []JournalLine{{AccountID: from, Debit: -amount, BookingID: bookingID}, {AccountID: into, Credit: -amount, BookingID: bookingID}}
}

// Earned is earned(): the receivable for the gross against the line's revenue account for the
// net, and the service and PB1 payables for the tax. Negative amounts take it back off.
func Earned(account, code string, s TaxSplit, bookingID string) []JournalLine {
	return []JournalLine{
		signedLine(GLReceivable, s.Gross(), true, JournalLine{BookingID: bookingID}),
		signedLine(account, s.Net, false, JournalLine{Code: code}),
		signedLine(GLServicePayable, s.Service, false, JournalLine{Code: ServiceCode, BookingID: bookingID}),
		signedLine(GLPb1Payable, s.PB1, false, JournalLine{Code: PB1Code, BookingID: bookingID}),
	}
}

// StayRef names a stay on a folio entry.
type StayRef struct {
	BookingID string
	Code      string
	VillaID   *string
}

// ChargeJournal is chargeJournal: a folio charge on its code's account and the stay's
// receivable; a rebate posts as a negative charge.
func ChargeJournal(s StayRef, kind, code, account, description, date string, split TaxSplit) (*JournalEntry, error) {
	if kind != "charge" {
		split = TaxSplit{Net: -split.Net, Service: -split.Service, PB1: -split.PB1}
	}
	return balanced(JournalEntry{Date: date, VillaID: s.VillaID, Memo: fmt.Sprintf("%s %s %s: %s", s.Code, code, kind, description), Source: SourceCharge, SourceID: s.BookingID, SourceNumber: s.Code,
		Lines: Earned(account, code, split, s.BookingID)}, false)
}

// VoidJournal is voidJournal: a delivered order's revenue and tax turned around on the day of the
// void; lines are the order's folio lines.
func VoidJournal(s StayRef, orderID, orderNumber, date string, lines []CodeLine) (*JournalEntry, error) {
	var out []JournalLine
	for _, l := range lines {
		for _, x := range Earned(l.Account, l.Code, l.TaxSplit, s.BookingID) {
			x.Debit, x.Credit = x.Credit, x.Debit
			out = append(out, x)
		}
	}
	return balanced(JournalEntry{Date: date, VillaID: s.VillaID, Memo: orderNumber + " voided: delivery reversed", Source: SourceOrder, SourceID: orderID, SourceNumber: orderNumber, Lines: out}, true)
}

// PartnerCost is one partner's share of a delivered order.
type PartnerCost struct {
	PartnerID string
	Amount    int64
}

// OrderJournal is orderJournal: each code's charge of a delivered order as revenue on the stay's
// receivable with its service and PB1, then the partners' share as a cost against what the villa
// owes each partner, one payable line per partner. An order with neither writes nothing.
func OrderJournal(s StayRef, orderID, orderNumber, date string, revenue []CodeLine, costs []PartnerCost) (*JournalEntry, error) {
	var lines []JournalLine
	for _, l := range revenue {
		lines = append(lines, Earned(l.Account, l.Code, l.TaxSplit, s.BookingID)...)
	}
	var total int64
	for _, c := range costs {
		total += c.Amount
	}
	lines = append(lines, dr(GLPartnerCost, total))
	for _, c := range costs {
		lines = append(lines, JournalLine{AccountID: GLPartnerPayable, Credit: c.Amount, PartnerID: c.PartnerID})
	}
	return balanced(JournalEntry{Date: date, VillaID: s.VillaID, Memo: orderNumber + " delivered: revenue on the receivable, partner costs owed", Source: SourceOrder, SourceID: orderID, SourceNumber: orderNumber, Lines: lines}, true)
}

// CodeLine is one folio line on its code and revenue account.
type CodeLine struct {
	Code    string
	Account string
	TaxSplit
}

// Turned is an entry with debits and credits swapped.
func Turned(d JournalEntry, date, memo string) JournalEntry {
	lines := make([]JournalLine, len(d.Lines))
	for i, l := range d.Lines {
		l.Debit, l.Credit = l.Credit, l.Debit
		lines[i] = l
	}
	d.Date, d.Memo, d.Lines = date, memo, lines
	d.ID, d.Number, d.PostedOn, d.PostedBy = "", "", "", ""
	return d
}

// CityTransferJournal is cityTransferJournal: the bill leaves the stay's receivable for City
// ledger receivable.
func CityTransferJournal(s StayRef, accountID, description, date string, amount int64) (*JournalEntry, error) {
	return balanced(JournalEntry{Date: date, VillaID: s.VillaID, Memo: s.Code + " " + description, Source: SourceCityLedger, SourceID: accountID, SourceNumber: s.Code,
		Lines: []JournalLine{dr(GLCityLedger, amount), {AccountID: GLReceivable, Credit: amount, BookingID: s.BookingID}}}, false)
}

// CommissionJournal is commissionJournal; nil for a company invoice without commission.
func CommissionJournal(accountID, number, issuedOn string, commission int64) (*JournalEntry, error) {
	return balanced(JournalEntry{Date: issuedOn, Memo: number + " agent commission", Source: SourceCityLedger, SourceID: accountID, SourceNumber: number,
		Lines: []JournalLine{dr(GLAgentCommission, commission), cr(GLCityLedger, commission)}}, true)
}

// NightJournal is nightJournal from the nights billing posted (from up to to of total): the
// receivable against the ROOM code's account, and on the first posting the deposits held moved
// onto the receivable.
func NightJournal(s StayRef, account string, revenue TaxSplit, from, to, total int, held int64, date string) (*JournalEntry, error) {
	nights := fmt.Sprintf("nights %d to %d", from+1, to)
	if to-from == 1 {
		nights = fmt.Sprintf("night %d", to)
	}
	lines := append(Earned(account, RoomCode, revenue, s.BookingID), move(GLDeposits, GLReceivable, held, s.BookingID)...)
	return balanced(JournalEntry{Date: date, VillaID: s.VillaID, Memo: fmt.Sprintf("%s %s of %d posted at the night audit", s.Code, nights, total), Source: SourceAudit, SourceID: s.BookingID, SourceNumber: s.Code, Lines: lines}, true)
}

// StayJournal is stayJournal at check-out: the nights no audit posted, the channel fee taken off
// the receivable and any deposits held moved onto it.
func StayJournal(s StayRef, account string, revenue TaxSplit, fee, held int64, date string) (*JournalEntry, error) {
	lines := append(Earned(account, RoomCode, revenue, s.BookingID), dr(GLFees, fee), JournalLine{AccountID: GLReceivable, Credit: fee, BookingID: s.BookingID})
	lines = append(lines, move(GLDeposits, GLReceivable, held, s.BookingID)...)
	return balanced(JournalEntry{Date: date, VillaID: s.VillaID, Memo: s.Code + " checked out: the room nights left and the fees on the receivable", Source: SourceFolio, SourceID: s.BookingID, SourceNumber: s.Code, Lines: lines}, true)
}

// UnstayedJournal is stayJournal for a cancelled or no-show stay: the deposits held kept as room revenue.
func UnstayedJournal(s StayRef, roomAccount string, held int64, date string) (*JournalEntry, error) {
	return balanced(JournalEntry{Date: date, VillaID: s.VillaID, Memo: s.Code + " ended unstayed: deposits held kept as room revenue", Source: SourceFolio, SourceID: s.BookingID, SourceNumber: s.Code,
		Lines: move(GLDeposits, roomAccount, held, s.BookingID)}, true)
}

// OwnerJournal checks the close or reopen entry of an owner statement that owners wrote.
func OwnerJournal(d JournalEntry) (*JournalEntry, error) {
	d.Source = SourceOwner
	return balanced(d, false)
}

// PartyBalance is one account's debits and credits for one stay or partner.
type PartyBalance struct{ Debit, Credit int64 }

// PartyBalances is partyBalances over the lines that name a stay (byBooking) or a partner.
func PartyBalances(entries []JournalEntry, accountID string, byBooking bool) map[string]PartyBalance {
	out := map[string]PartyBalance{}
	for _, e := range entries {
		for _, l := range e.Lines {
			id := l.PartnerID
			if byBooking {
				id = l.BookingID
			}
			if l.AccountID != accountID || id == "" {
				continue
			}
			m := out[id]
			m.Debit += l.Debit
			m.Credit += l.Credit
			out[id] = m
		}
	}
	return out
}

// ManualJournalInput is an adjusting entry finance writes by hand.
type ManualJournalInput struct {
	Date        string        `json:"date"`
	VillaID     *string       `json:"villaId"`
	Memo        string        `json:"memo"`
	Lines       []JournalLine `json:"lines"`
	Attachments []Attachment  `json:"attachments"`
}

// ManualJournal signs through the approval chain like a cash-out of its total.
type ManualJournal struct {
	Date            string             `json:"date"`
	VillaID         *string            `json:"villaId"`
	Memo            string             `json:"memo"`
	Lines           []JournalLine      `json:"lines"`
	Attachments     []Attachment       `json:"attachments"`
	ID              string             `json:"id"`
	Number          string             `json:"number"`
	Status          string             `json:"status"`
	Approvals       []ApprovalGrant    `json:"approvals"`
	History         []TransactionEvent `json:"history"`
	RejectionReason *string            `json:"rejectionReason"`
	JournalID       *string            `json:"journalId"`
	CreatedBy       string             `json:"createdBy"`
	CreatedByID     string             `json:"createdById"`
	CreatedOn       string             `json:"createdOn"`
	Version         int64              `json:"-"`
}

// Villa is the villa id, or "".
func (m ManualJournal) Villa() string { return deref(m.VillaID) }

// ValidateManualJournal is validateManualJournal.
func ValidateManualJournal(in ManualJournalInput, chart []GlAccount) error {
	var f errs.Fields
	if !IsDate(in.Date) {
		f.Add("date", "Pick the date.")
	}
	if runes(strings.TrimSpace(in.Memo)) < 5 {
		f.Add("memo", "Say what the journal corrects.")
	}
	var used []JournalLine
	for _, l := range in.Lines {
		if l.AccountID != "" || l.Debit != 0 || l.Credit != 0 {
			used = append(used, l)
		}
	}
	switch {
	case len(used) < 2:
		f.Add("lines", "Enter at least two lines.")
	case slices.ContainsFunc(used, func(l JournalLine) bool { _, ok := findAccount(chart, l.AccountID); return !ok }):
		f.Add("lines", "Pick an account on every line.")
	case slices.ContainsFunc(used, func(l JournalLine) bool { a, _ := findAccount(chart, l.AccountID); return a.CashAccountID != nil }):
		f.Add("lines", "Cash and bank move through cash entries; use a cash entry or a balance adjustment.")
	}
	return f.Err()
}

// ManualJournalEntry is manualJournalEntry.
func ManualJournalEntry(m ManualJournal) (*JournalEntry, error) {
	return balanced(JournalEntry{Date: m.Date, VillaID: m.VillaID, Memo: m.Memo, Source: SourceManual, SourceID: m.ID, SourceNumber: m.Number, Lines: m.Lines}, false)
}

// PeriodClose is a month finance closed.
type PeriodClose struct {
	Month    string `json:"month"`
	ClosedOn string `json:"closedOn"`
	ClosedBy string `json:"closedBy"`
	Note     string `json:"note"`
}

// MonthOf is monthOf.
func MonthOf(date string) string {
	if len(date) < 7 {
		return date
	}
	return date[:7]
}

var monthNames = []string{"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}

// PeriodLabel is periodLabel: "2026-08" reads "August 2026".
func PeriodLabel(month string) string {
	parts := strings.SplitN(month, "-", 2)
	if len(parts) != 2 {
		return month
	}
	m, err := strconv.Atoi(parts[1])
	if err != nil || m < 1 || m > 12 {
		return "undefined " + parts[0]
	}
	return monthNames[m-1] + " " + parts[0]
}

// AssertOpenPeriod is assertOpenPeriod.
func AssertOpenPeriod(closed []string, date string) error {
	month := MonthOf(date)
	if slices.Contains(closed, month) {
		return errs.Newf("PERIOD_CLOSED", "%s is closed; reopen it before posting into it.", PeriodLabel(month))
	}
	return nil
}

// AssertClosable is assertClosable: the month has ended, is not closed, and nothing dated in it
// still waits for approval.
func AssertClosable(month, today string, closed []string, waiting int) error {
	if !isMonth(month) {
		return errs.New(errs.CodeValidation, "Pick a month as YYYY-MM.")
	}
	if month >= MonthOf(today) {
		return errs.Newf("PERIOD_NOT_ENDED", "%s has not ended yet.", PeriodLabel(month))
	}
	if slices.Contains(closed, month) {
		return errs.Newf("PERIOD_CLOSED", "%s is already closed.", PeriodLabel(month))
	}
	if waiting > 0 {
		noun, verb := "entries", "wait"
		if waiting == 1 {
			noun, verb = "entry", "waits"
		}
		return errs.Newf("PERIOD_PENDING", "%d %s dated in %s still %s for approval or posting.", waiting, noun, PeriodLabel(month), verb)
	}
	return nil
}

func isMonth(s string) bool {
	if len(s) != 7 || s[4] != '-' {
		return false
	}
	if _, err := strconv.Atoi(s[:4]); err != nil {
		return false
	}
	m, err := strconv.Atoi(s[5:])
	return err == nil && s[5] >= '0' && m >= 1 && m <= 12
}

// TrialBalanceRow is one account's closing balance on its debit or credit column.
type TrialBalanceRow struct {
	Account GlAccount
	Debit   int64
	Credit  int64
}

type movement struct{ debit, credit int64 }

func movements(entries []JournalEntry) map[string]movement {
	out := map[string]movement{}
	for _, e := range entries {
		for _, l := range e.Lines {
			m := out[l.AccountID]
			m.debit += l.Debit
			m.credit += l.Credit
			out[l.AccountID] = m
		}
	}
	return out
}

// UpTo keeps entries dated on or before to ("" keeps all).
func UpTo(entries []JournalEntry, to string) []JournalEntry {
	var out []JournalEntry
	for _, e := range entries {
		if to == "" || e.Date <= to {
			out = append(out, e)
		}
	}
	return out
}

// TrialBalance is trialBalance up to and including to.
func TrialBalance(chart []GlAccount, entries []JournalEntry, to string) (rows []TrialBalanceRow, debit, credit int64) {
	m := movements(UpTo(entries, to))
	for _, a := range chart {
		net := m[a.ID].debit - m[a.ID].credit
		r := TrialBalanceRow{Account: a, Debit: max(0, net), Credit: max(0, -net)}
		if r.Debit != 0 || r.Credit != 0 {
			rows = append(rows, r)
			debit += r.Debit
			credit += r.Credit
		}
	}
	return rows, debit, credit
}

func natural(a GlAccount, m movement) int64 {
	if a.Normal == "debit" {
		return m.debit - m.credit
	}
	return m.credit - m.debit
}

func total(chart []GlAccount, m map[string]movement, typ string, skip string) int64 {
	var s int64
	for _, a := range chart {
		if a.Type == typ && a.ID != skip {
			s += natural(a, m[a.ID])
		}
	}
	return s
}

// NetIncome is incomeStatement's net over the entries given.
func NetIncome(chart []GlAccount, entries []JournalEntry) int64 {
	m := movements(entries)
	return total(chart, m, "revenue", "") - total(chart, m, "expense", "")
}

// BalanceSheetTotals is balanceSheet's totals on asOf.
type BalanceSheetTotals struct {
	Assets, Liabilities, Equity, YearEarnings int64
}

// Balanced reports assets equal to liabilities plus equity.
func (b BalanceSheetTotals) Balanced() bool { return b.Assets == b.Liabilities+b.Equity }

// BalanceSheet is balanceSheet: earnings before the year start join retained earnings and this
// year's show as their own equity line.
func BalanceSheet(chart []GlAccount, entries []JournalEntry, asOf string) BalanceSheetTotals {
	scoped := UpTo(entries, asOf)
	yearStart := asOf[:4] + "-01-01"
	var prior, year []JournalEntry
	for _, e := range scoped {
		if e.Date < yearStart {
			prior = append(prior, e)
		} else {
			year = append(year, e)
		}
	}
	m := movements(scoped)
	retained, _ := findAccount(chart, GLRetained)
	yearEarnings := NetIncome(chart, year)
	return BalanceSheetTotals{
		Assets:       total(chart, m, "asset", ""),
		Liabilities:  total(chart, m, "liability", ""),
		Equity:       total(chart, m, "equity", GLRetained) + natural(retained, m[GLRetained]) + NetIncome(chart, prior) + yearEarnings,
		YearEarnings: yearEarnings,
	}
}

// SortEntries orders entries by date then number, as the ledgers read them.
func SortEntries(entries []JournalEntry) {
	slices.SortStableFunc(entries, func(a, b JournalEntry) int {
		return cmp.Or(strings.Compare(a.Date, b.Date), strings.Compare(a.Number, b.Number))
	})
}
