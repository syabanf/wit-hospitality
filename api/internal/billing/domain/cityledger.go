package domain

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// City ledger kinds, instructions and methods.
var (
	CityLedgerKinds           = []string{"company", "travel_agent"}
	BillingInstructions       = []string{"all", "room", "room_breakfast"}
	InstructionLabel          = map[string]string{"all": "All charges", "room": "Room only", "room_breakfast": "Room and breakfast"}
	CityLedgerMethods         = []string{"bank_transfer", "cash"}
	WriteOffLimit       int64 = 500_000
)

// Account is CityLedgerAccount.
type Account struct {
	ID            string   `json:"id"`
	Code          string   `json:"code"`
	Name          string   `json:"name"`
	Kind          string   `json:"kind"`
	Contact       string   `json:"contact"`
	BillingEmail  string   `json:"billingEmail"`
	Phone         string   `json:"phone"`
	Address       string   `json:"address"`
	NPWP          string   `json:"npwp"`
	CreditLimit   int64    `json:"creditLimit"`
	TermsDays     int      `json:"termsDays"`
	CommissionPct float64  `json:"commissionPct"`
	Active        bool     `json:"active"`
	VillaIDs      []string `json:"villaIds"`
	CreatedOn     string   `json:"createdOn"`
}

// AccountInput is CityLedgerAccountInput.
type AccountInput struct {
	Name          string   `json:"name"`
	Kind          string   `json:"kind"`
	Contact       string   `json:"contact"`
	BillingEmail  string   `json:"billingEmail"`
	Phone         string   `json:"phone"`
	Address       string   `json:"address"`
	NPWP          string   `json:"npwp"`
	CreditLimit   float64  `json:"creditLimit"`
	TermsDays     float64  `json:"termsDays"`
	CommissionPct float64  `json:"commissionPct"`
	Active        bool     `json:"active"`
	VillaIDs      []string `json:"villaIds"`
}

var emailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// ValidateAccount is validateCityLedgerAccount.
func ValidateAccount(in AccountInput, accounts []Account, id string) error {
	var f errs.Fields
	name := strings.TrimSpace(in.Name)
	if len([]rune(name)) < 3 {
		f.Add("name", "Name the company or agent.")
	} else {
		for _, a := range accounts {
			if strings.EqualFold(a.Name, name) && a.ID != id {
				f.Add("name", name+" already has an account.")
				break
			}
		}
	}
	if !slices.Contains(CityLedgerKinds, in.Kind) {
		f.Add("kind", "Pick company or travel agent.")
	}
	if len([]rune(strings.TrimSpace(in.Contact))) < 2 {
		f.Add("contact", "Name the person who handles the bills.")
	}
	if !emailPattern.MatchString(strings.TrimSpace(in.BillingEmail)) {
		f.Add("billingEmail", "Enter the billing email.")
	}
	if !whole(in.CreditLimit) || in.CreditLimit < 0 {
		f.Add("creditLimit", "Enter the credit limit in whole rupiah.")
	}
	if !intIn(in.TermsDays, 0, 120) {
		f.Add("termsDays", "0 to 120 days.")
	}
	switch {
	case !(in.CommissionPct >= 0 && in.CommissionPct <= 50):
		f.Add("commissionPct", "0 to 50 percent.")
	case in.Kind == "company" && in.CommissionPct > 0:
		f.Add("commissionPct", "A company earns no commission.")
	}
	return f.Err()
}

// Override is who booked past the credit limit.
type Override struct {
	By     string `json:"by"`
	Reason string `json:"reason"`
}

// Billing is CityLedgerBilling: who pays a direct stay or a group.
type Billing struct {
	AccountID   string    `json:"accountId"`
	Instruction string    `json:"instruction"`
	Override    *Override `json:"override"`
}

// BillingInput is CityLedgerBillingInput.
type BillingInput struct {
	AccountID      string `json:"accountId"`
	Instruction    string `json:"instruction"`
	OverrideReason string `json:"overrideReason"`
}

// AssertBookable is assertBookable.
func AssertBookable(a Account, villaID, villaName string) error {
	if !a.Active {
		return errs.Newf("CITY_LEDGER_INACTIVE", "%s is closed for new business.", a.Name)
	}
	if len(a.VillaIDs) > 0 && !slices.Contains(a.VillaIDs, villaID) {
		return errs.Newf("CITY_LEDGER_VILLA", "%s may not book %s.", a.Name, villaName)
	}
	return nil
}

// CreditCheck is creditCheck: past the limit only someone allowed overrides, with a reason.
func CreditCheck(a Account, used, adding int64, may bool, reason, by string) (*Override, error) {
	if used+adding <= a.CreditLimit {
		return nil, nil
	}
	over := used + adding - a.CreditLimit
	if !may {
		return nil, errs.Newf("CREDIT_LIMIT", "%s would pass its credit limit of Rp %s by Rp %s. Finance or a villa manager may book it with a reason.", a.Name, Rupiah(a.CreditLimit), Rupiah(over))
	}
	if len([]rune(strings.TrimSpace(reason))) < 3 {
		return nil, errs.Newf("CREDIT_LIMIT", "%s would pass its credit limit by Rp %s. Give the reason to book it anyway.", a.Name, Rupiah(over))
	}
	return &Override{By: by, Reason: strings.TrimSpace(reason)}, nil
}

// TransferPart is one slice of a stay's bill moving to the account.
type TransferPart struct {
	Part    string  `json:"part"`
	OrderID *string `json:"orderId"`
	Amount  int64   `json:"amount"`
	Service int64   `json:"service"`
	PB1     int64   `json:"pb1"`
}

func slice(lines []FolioLine, part string, orderID *string, amount int64) []TransferPart {
	if amount <= 0 {
		return nil
	}
	on := func(pick func(string) bool) int64 {
		return net(lines, func(l FolioLine) bool { return chargeSide(l) && pick(l.Code) })
	}
	gross := on(func(string) bool { return true })
	service := on(func(c string) bool { return c == ServiceCode })
	pb1 := on(func(c string) bool { return c == PB1Code })
	share := func(tax int64) int64 {
		if gross <= 0 {
			return 0
		}
		return RoundHalfUp(float64(tax*min(amount, gross)) / float64(gross))
	}
	return []TransferPart{{Part: part, OrderID: orderID, Amount: amount, Service: share(service), PB1: share(pb1)}}
}

func breakfastCharge(o Order) int64 {
	var s int64
	for _, l := range o.Lines {
		if l.Category == "breakfast" && !l.Comp {
			s += LineAmount(l)
		}
	}
	return jsRound(float64(s) * (1 - o.DiscountPct/100))
}

func filterLines(lines []FolioLine, keep func(FolioLine) bool) []FolioLine {
	var out []FolioLine
	for _, l := range lines {
		if keep(l) {
			out = append(out, l)
		}
	}
	return out
}

// TransferParts is transferParts: what a transfer under the instruction moves off the folio.
func TransferParts(f GuestFolio, orders []Order, instruction string, skip map[string]bool) []TransferPart {
	room := slice(filterLines(f.Lines, func(l FolioLine) bool { return l.Part == PartRoom }), PartRoom, nil, f.Due.Room)
	if instruction == "room" {
		return room
	}
	var perOrder []TransferPart
	for _, o := range f.Due.Orders {
		if skip[o.OrderID] {
			continue
		}
		amount := o.Amount
		if instruction != "all" {
			var charge int64
			for _, x := range orders {
				if x.ID == o.OrderID {
					charge = breakfastCharge(x)
				}
			}
			amount = min(o.Amount, charge)
		}
		id := o.OrderID
		perOrder = append(perOrder, slice(filterLines(f.Lines, func(l FolioLine) bool { return l.OrderID != nil && *l.OrderID == id }), PartOrders, &id, amount)...)
	}
	out := append(room, perOrder...)
	if instruction == "room_breakfast" {
		return out
	}
	return append(out, slice(filterLines(f.Lines, func(l FolioLine) bool { return l.Part == PartCharges }), PartCharges, nil, f.Due.Charges)...)
}

// PartsTotal is partsTotal.
func PartsTotal(parts []TransferPart) int64 {
	var s int64
	for _, p := range parts {
		s += p.Amount
	}
	return s
}

// InvoiceLine is CityLedgerInvoiceLine.
type InvoiceLine struct {
	PostingIDs []string `json:"postingIds"`
	BookingID  string   `json:"bookingId"`
	Code       string   `json:"code"`
	Guest      string   `json:"guest"`
	Villa      string   `json:"villa"`
	CheckIn    string   `json:"checkIn"`
	CheckOut   string   `json:"checkOut"`
	Covers     string   `json:"covers"`
	Gross      int64    `json:"gross"`
	Service    int64    `json:"service"`
	PB1        int64    `json:"pb1"`
}

// Invoice is CityLedgerInvoice.
type Invoice struct {
	ID            string        `json:"id"`
	Number        string        `json:"number"`
	AccountID     string        `json:"accountId"`
	IssuedOn      string        `json:"issuedOn"`
	DueOn         string        `json:"dueOn"`
	Lines         []InvoiceLine `json:"lines"`
	Gross         int64         `json:"gross"`
	Service       int64         `json:"service"`
	PB1           int64         `json:"pb1"`
	CommissionPct float64       `json:"commissionPct"`
	Commission    int64         `json:"commission"`
	Net           int64         `json:"net"`
	MessageID     *string       `json:"messageId"`
	SentAt        *string       `json:"sentAt"`
	JournalID     *string       `json:"journalId"`
	IssuedBy      string        `json:"issuedBy"`
}

// InvoiceNumber is invoiceNumber: CL-YYYY-MM-NNN within the month.
func InvoiceNumber(issuedOn string, existing []Invoice) string {
	month := issuedOn[:7]
	n := 1
	for _, i := range existing {
		if i.IssuedOn[:7] == month {
			n++
		}
	}
	return fmt.Sprintf("CL-%s-%03d", month, n)
}

// SetFigures is invoiceFigures: gross with the tax as billed, the commission on the charges before it, the net due.
func (i *Invoice) SetFigures(commissionPct float64) {
	i.Gross, i.Service, i.PB1 = 0, 0, 0
	for _, l := range i.Lines {
		i.Gross += l.Gross
		i.Service += l.Service
		i.PB1 += l.PB1
	}
	i.CommissionPct = commissionPct
	i.Commission = RoundHalfUp(float64(i.Gross-i.Service-i.PB1) * commissionPct / 100)
	i.Net = i.Gross - i.Commission
}

// Allocation is one invoice a payment pays.
type Allocation struct {
	InvoiceID string `json:"invoiceId"`
	Amount    int64  `json:"amount"`
}

// LedgerPayment is CityLedgerPayment.
type LedgerPayment struct {
	ID            string       `json:"id"`
	Number        string       `json:"number"`
	AccountID     string       `json:"accountId"`
	Date          string       `json:"date"`
	Method        string       `json:"method"`
	Amount        int64        `json:"amount"`
	Reference     string       `json:"reference"`
	Note          string       `json:"note"`
	Allocations   []Allocation `json:"allocations"`
	TransactionID string       `json:"transactionId"`
	CreatedBy     string       `json:"createdBy"`
}

// Unapplied is unapplied: what the payment has not spread yet, a credit on the account.
func (p LedgerPayment) Unapplied() int64 {
	s := p.Amount
	for _, a := range p.Allocations {
		s -= a.Amount
	}
	return s
}

// AllocationInput is one allocation as the console sends it.
type AllocationInput struct {
	InvoiceID string  `json:"invoiceId"`
	Amount    float64 `json:"amount"`
}

// LedgerPaymentInput is CityLedgerPaymentInput.
type LedgerPaymentInput struct {
	AccountID     string             `json:"accountId"`
	Method        string             `json:"method"`
	CashAccountID string             `json:"cashAccountId"`
	Amount        float64            `json:"amount"`
	Reference     string             `json:"reference"`
	Note          string             `json:"note"`
	Allocations   *[]AllocationInput `json:"allocations"`
}

// ValidateLedgerPayment is validateCityLedgerPayment.
func ValidateLedgerPayment(in LedgerPaymentInput) error {
	var f errs.Fields
	if in.AccountID == "" {
		f.Add("accountId", "Pick the account that paid.")
	}
	if !slices.Contains(CityLedgerMethods, in.Method) {
		f.Add("method", "Bank transfer or cash.")
	}
	if in.CashAccountID == "" {
		f.Add("cashAccountId", "Pick where the money landed.")
	}
	if !whole(in.Amount) || in.Amount <= 0 {
		f.Add("amount", "Enter the amount in whole rupiah.")
	}
	if in.Method == "bank_transfer" && len([]rune(strings.TrimSpace(in.Reference))) < 3 {
		f.Add("reference", "Enter the bank reference.")
	}
	if in.Allocations != nil {
		var total float64
		bad := false
		for _, a := range *in.Allocations {
			if !whole(a.Amount) || a.Amount < 0 {
				bad = true
			}
			total += a.Amount
		}
		switch {
		case bad:
			f.Add("allocations", "Allocate whole rupiah.")
		case total > in.Amount:
			f.Add("allocations", "The invoices picked take more than the payment.")
		}
	}
	return f.Err()
}

// OpenInvoice is an invoice and what is still open on it for new allocations.
type OpenInvoice struct {
	InvoiceID string
	Open      int64
}

// OldestFirst is oldestFirst.
func OldestFirst(amount int64, open []OpenInvoice) []Allocation {
	left := amount
	var out []Allocation
	for _, i := range open {
		take := min(left, max(0, i.Open))
		left -= take
		if take > 0 {
			out = append(out, Allocation{InvoiceID: i.InvoiceID, Amount: take})
		}
	}
	return out
}

// WriteOff is CityLedgerWriteOff.
type WriteOff struct {
	ID              string  `json:"id"`
	Number          string  `json:"number"`
	AccountID       string  `json:"accountId"`
	InvoiceID       *string `json:"invoiceId"`
	Amount          int64   `json:"amount"`
	Reason          string  `json:"reason"`
	ManualJournalID string  `json:"manualJournalId"`
	CreatedBy       string  `json:"createdBy"`
	CreatedOn       string  `json:"createdOn"`
}

// WriteOffInput is what the console sends.
type WriteOffInput struct {
	AccountID string  `json:"accountId"`
	InvoiceID string  `json:"invoiceId"`
	Amount    float64 `json:"amount"`
	Reason    string  `json:"reason"`
}

// ValidateWriteOff is validateWriteOff.
func ValidateWriteOff(in WriteOffInput, open int64) error {
	var f errs.Fields
	switch {
	case !whole(in.Amount) || in.Amount <= 0:
		f.Add("amount", "Enter the amount in whole rupiah.")
	case int64(in.Amount) > open:
		f.Add("amount", fmt.Sprintf("Only %d is open.", open))
	}
	if len([]rune(strings.TrimSpace(in.Reason))) < 5 {
		f.Add("reason", "Say why the balance is written off.")
	}
	return f.Err()
}

// AssertWriteOffLimit is assertWriteOffLimit.
func AssertWriteOffLimit(amount int64) error {
	if amount > WriteOffLimit {
		return errs.Newf("WRITE_OFF_LIMIT", "Write-offs go up to Rp %s; send a bigger balance to collection.", Rupiah(WriteOffLimit))
	}
	return nil
}

// Ref is the reference finance keys the payment's cash-in by: the entry it made, else the payment.
func (p LedgerPayment) Ref() string {
	if p.TransactionID != "" {
		return p.TransactionID
	}
	return p.ID
}

// Ref is the reference finance keys the write-off's manual journal by.
func (w WriteOff) Ref() string {
	if w.ManualJournalID != "" {
		return w.ManualJournalID
	}
	return w.ID
}

var live = map[string]bool{"submitted": true, "approved": true, "posted": true}

// Settlement is what settles invoices: payments and write-offs with the status finance gives them.
type Settlement struct {
	Payments  []LedgerPayment
	WriteOffs []WriteOff
	// Status is the approval status of the entry finance made for a payment or write-off id.
	Status func(ref string) string
}

func (s Settlement) posted(ref string) bool { return s.Status(ref) == "posted" }
func (s Settlement) live(ref string) bool   { return live[s.Status(ref)] }

// InvoiceSettlement is invoiceSettlement.
type InvoiceSettlement struct {
	Paid       int64
	WrittenOff int64
	Pending    int64
	Open       int64
}

// Of is invoiceSettlement.
func (s Settlement) Of(inv Invoice) InvoiceSettlement {
	allocated := func(pick func(LedgerPayment) bool) int64 {
		var t int64
		for _, p := range s.Payments {
			if !pick(p) {
				continue
			}
			for _, a := range p.Allocations {
				if a.InvoiceID == inv.ID {
					t += a.Amount
				}
			}
		}
		return t
	}
	written := func(pick func(WriteOff) bool) int64 {
		var t int64
		for _, w := range s.WriteOffs {
			if w.InvoiceID != nil && *w.InvoiceID == inv.ID && pick(w) {
				t += w.Amount
			}
		}
		return t
	}
	out := InvoiceSettlement{
		Paid:       allocated(func(p LedgerPayment) bool { return s.posted(p.Ref()) }),
		WrittenOff: written(func(w WriteOff) bool { return s.posted(w.Ref()) }),
		Pending: allocated(func(p LedgerPayment) bool { return s.live(p.Ref()) && !s.posted(p.Ref()) }) +
			written(func(w WriteOff) bool { return s.live(w.Ref()) && !s.posted(w.Ref()) }),
	}
	out.Open = inv.Net - out.Paid - out.WrittenOff
	return out
}

// Allocatable is allocatable: open on each invoice, oldest first, less what waits for approval.
func (s Settlement) Allocatable(invoices []Invoice) []OpenInvoice {
	sorted := slices.Clone(invoices)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].IssuedOn != sorted[j].IssuedOn {
			return sorted[i].IssuedOn < sorted[j].IssuedOn
		}
		return sorted[i].Number < sorted[j].Number
	})
	out := make([]OpenInvoice, len(sorted))
	for i, inv := range sorted {
		st := s.Of(inv)
		out[i] = OpenInvoice{InvoiceID: inv.ID, Open: st.Open - st.Pending}
	}
	return out
}

// PaymentLive reports a payment finance has not rejected or reversed.
func (s Settlement) PaymentLive(p LedgerPayment) bool { return s.live(p.Ref()) }

// AccountBalance is accountBalance: transfers less commissions, posted payments and posted write-offs.
func (s Settlement) AccountBalance(accountID string, transfers []Posting, invoices []Invoice) int64 {
	var bal int64
	for _, p := range transfers {
		if p.Kind == KindTransfer && p.CityLedger != nil && p.CityLedger.AccountID == accountID {
			bal += p.Amount
		}
	}
	for _, i := range invoices {
		if i.AccountID == accountID {
			bal -= i.Commission
		}
	}
	for _, p := range s.Payments {
		if p.AccountID == accountID && s.posted(p.Ref()) {
			bal -= p.Amount
		}
	}
	for _, w := range s.WriteOffs {
		if w.AccountID == accountID && s.posted(w.Ref()) {
			bal -= w.Amount
		}
	}
	return bal
}

// OpenTransfers is openTransfers: transfers on no invoice yet.
func OpenTransfers(accountID string, transfers []Posting, invoices []Invoice) []Posting {
	invoiced := map[string]bool{}
	for _, i := range invoices {
		for _, l := range i.Lines {
			for _, id := range l.PostingIDs {
				invoiced[id] = true
			}
		}
	}
	var out []Posting
	for _, p := range transfers {
		if p.Kind == KindTransfer && p.CityLedger != nil && p.CityLedger.AccountID == accountID && !invoiced[p.ID] {
			out = append(out, p)
		}
	}
	return out
}
