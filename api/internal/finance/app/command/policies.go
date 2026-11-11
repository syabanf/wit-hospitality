package command

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/payroll"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// Policies turn other contexts' facts into cash entries for approval and journal entries. Each
// runs inside the projector's inbox transaction, so a redelivered event is skipped; each also
// checks by source that it has not written its entry yet, so a replay outside the inbox is safe.
// An event finance cannot book (an unknown account, a closed month for a journal) is skipped
// rather than retried, so it never blocks the consumer.
type Policies struct{ Deps }

// Actor is who acted in another context, as its events name them.
type Actor struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

func (a *Actor) signer(fallbackRole string) domain.Signer {
	if a == nil || a.Name == "" {
		return System
	}
	s := domain.Signer{ID: a.ID, Name: a.Name, Role: a.Role}
	if s.Role == "" {
		s.Role = fallbackRole
	}
	return s
}

// accountFor picks the account another context's money moves through: cash through the
// location's cashbox, anything else through the bank. preferBox falls back to the cashbox when no
// bank exists (expenses), else to the first account (guest money).
func (d Deps) accountFor(ctx context.Context, locationID, method string, preferBox bool) (*domain.CashAccount, error) {
	accounts, err := d.Repo.Accounts(ctx)
	if err != nil || len(accounts) == 0 {
		return nil, err
	}
	var box, bank *domain.CashAccount
	for i := range accounts {
		a := &accounts[i]
		if box == nil && a.Kind == domain.Cashbox && a.Location() == locationID {
			box = a
		}
		if bank == nil && a.Kind == domain.Bank {
			bank = a
		}
	}
	if method == "cash" {
		if box != nil {
			return box, nil
		}
		return bank, nil
	}
	if bank != nil {
		return bank, nil
	}
	if preferBox {
		return box, nil
	}
	return &accounts[0], nil
}

// written reports entries already written for a source.
func (d Deps) written(ctx context.Context, src Source) (bool, error) {
	have, err := d.Repo.BySource(ctx, src)
	return len(have) > 0, err
}

// askFor writes an entry another context asked for, submitted for approval. A hand-written
// cash-out without its receipt cannot go for approval: it is kept rejected with the PROOF_REQUIRED
// wording, and finance.entry.rejected.v1 tells the asking context to attach the receipt.
func (d Deps) askFor(ctx context.Context, t domain.Transaction, e Entry) (domain.Transaction, error) {
	e.Submit = true
	if err := d.assertProof(ctx, t); err != nil {
		e.Submit = false
		out, err2 := d.newEntry(ctx, t, e)
		if err2 != nil {
			return out, err2
		}
		reason := err.Error()
		if x, ok := errs.As(err); ok {
			reason = x.Message
		}
		out.Status, out.RejectionReason = domain.Rejected, &reason
		out.History = append(out.History, domain.Event("rejected", System, d.today(), reason))
		if err := d.Repo.UpdateTransaction(ctx, &out); err != nil {
			return out, err
		}
		return out, d.entryEvent(ctx, finance.EventEntryRejected, out, System)
	}
	return d.newEntry(ctx, t, e)
}

// PayrollClosed posts a closed payroll's salary cash-out and its payroll journal, as the TS
// payroll close does: the entry recorded posted with the payroll approval, wages and employer BPJS
// against the bank, BPJS payable, PPh 21 payable and employee loans. A closed ledger month keeps
// the entry approved until someone reopens the month and posts it.
func (p Policies) PayrollClosed(ctx context.Context, e payroll.PeriodClosed) error {
	src := Source{Type: "payroll", ID: e.PeriodID}
	if done, err := p.written(ctx, src); err != nil || done {
		return err
	}
	a, err := p.Repo.Account(ctx, e.AccountID, false)
	if err != nil {
		return nil
	}
	location, err := p.accountLocation(ctx, a)
	if err != nil {
		return err
	}
	totals := domain.PayrollTotals{PeriodID: e.PeriodID, Month: e.Month}
	for _, l := range e.Lines {
		totals.EmployeeBpjs += l.BPJSHealth + l.BPJSEmployment
		totals.CompanyBpjs += l.CompanyBPJS
		totals.Pph21 += l.PPh21
		totals.Loans += l.LoanDeduction
		totals.ServiceCharge += l.ServiceCharge
	}
	by := domain.Signer{Name: e.ClosedBy, Role: "finance"}
	if by.Name == "" {
		by = System
	}
	category := e.CategoryID
	if category == "" {
		category = "cat-payroll"
	}
	reference := e.Reference
	if reference == "" {
		reference = "PAY-" + e.Month
	}
	t, err := p.newEntry(ctx, domain.Transaction{AccountID: a.ID, Kind: domain.CashOut, CategoryID: category, Amount: e.Totals.Net, Date: p.today(), LocationID: location,
		Description: fmt.Sprintf("Salaries %s, %d employees", e.Month, e.Totals.Employees), Reference: reference, Attachments: []domain.Attachment{}, Origin: "payroll"},
		Entry{Submit: true, By: by, Source: &src})
	if err != nil {
		return err
	}
	if err := p.Repo.SavePayroll(ctx, t.ID, totals); err != nil {
		return err
	}
	on := p.today()
	t.Status = domain.Approved
	t.History = append(t.History, domain.Event("approved", by, on, "Payroll approval"))
	if closed := p.assertOpen(ctx, on); closed == nil {
		t.Status = domain.Posted
		t.History = append(t.History, domain.Event("posted", by, on, ""))
	}
	if err := p.Repo.UpdateTransaction(ctx, &t); err != nil {
		return err
	}
	if t.Status != domain.Posted {
		return p.entryEvent(ctx, finance.EventEntryApproved, t, by)
	}
	if err := p.recordPosting(ctx, t, by); err != nil {
		return err
	}
	return p.entryEvent(ctx, finance.EventEntryPosted, t, by)
}

// walk is the part of reservation's Walk finance reads.
type walk struct {
	ID          string `json:"id"`
	Number      string `json:"number"`
	Cost        int64  `json:"cost"`
	Method      string `json:"method"`
	Destination string `json:"destination"`
	Property    string `json:"property"`
	BookingID   string `json:"bookingId"`
	BookingCode string `json:"bookingCode"`
	FromUnitID  string `json:"fromUnitId"`
	By          string `json:"by"`
	ByID        string `json:"byId"`
}

func first(list []string) string {
	if len(list) == 0 {
		return ""
	}
	return list[0]
}

// WalkRecorded books a walk's relocation cost as a Guest relocation cash-out from the overbooked
// villa's cashbox (cash) or the bank, for approval, as the mock's relocationCost does.
func (p Policies) WalkRecorded(ctx context.Context, r reservation.Record) error {
	var w walk
	if err := json.Unmarshal(r.Data, &w); err != nil {
		return err
	}
	src := Source{Type: "walk", ID: w.ID}
	if w.Cost <= 0 {
		return nil
	}
	if done, err := p.written(ctx, src); err != nil || done {
		return err
	}
	location := first(r.LocationIDs)
	a, err := p.accountFor(ctx, location, w.Method, true)
	if err != nil || a == nil {
		return err
	}
	to := "another villa of ours"
	if w.Destination == "outside" {
		to = strings.TrimSpace(w.Property)
	}
	villa := first(r.VillaIDs)
	t := domain.Transaction{AccountID: a.ID, Kind: domain.CashOut, CategoryID: "cat-relocation", Amount: w.Cost, Date: p.today(), LocationID: location,
		UnitID: domain.Ptr(w.FromUnitID), BookingID: domain.Ptr(w.BookingID), Description: fmt.Sprintf("Guest relocation %s to %s", w.BookingCode, to),
		Reference: w.Number, Attachments: []domain.Attachment{}, Origin: "front_desk"}
	if villa != "" {
		t.VillaID = &villa
	}
	_, err = p.askFor(ctx, t, Entry{By: domain.Signer{ID: w.ByID, Name: w.By, Role: "reservation"}, Source: &src})
	return err
}

// booking is the part of reservation's Booking the guest money rules read.
type booking struct {
	ID           string   `json:"id"`
	Code         string   `json:"code"`
	Status       string   `json:"status"`
	CheckedOutOn *string  `json:"checkedOutOn"`
	NightsPosted []string `json:"nightsPosted"`
}

func (p Policies) stayFrom(r reservation.Record) (domain.Stay, error) {
	var b booking
	if err := json.Unmarshal(r.Data, &b); err != nil {
		return domain.Stay{}, err
	}
	s := domain.Stay{ID: b.ID, Code: b.Code, Status: b.Status, BilledOn: b.CheckedOutOn}
	if len(b.NightsPosted) > 0 {
		s.BilledOn = &b.NightsPosted[0]
	}
	if v := first(r.VillaIDs); v != "" {
		s.VillaID = &v
	}
	return s, nil
}

// BookingSaved keeps finance's copy of a stay: its state and the day its room was first billed.
func (p Policies) BookingSaved(ctx context.Context, r reservation.Record) error {
	s, err := p.stayFrom(r)
	if err != nil {
		return err
	}
	return p.Repo.SaveStay(ctx, s)
}

// BookingStatusChanged keeps the copy and, for a stay that ends unstayed, keeps the room money
// it holds on Guest deposits as room revenue (the ledger's recordStay).
func (p Policies) BookingStatusChanged(ctx context.Context, e reservation.StatusChanged) error {
	s, err := p.stayFrom(e.Record)
	if err != nil {
		return err
	}
	if err := p.Repo.SaveStay(ctx, s); err != nil {
		return err
	}
	if e.To != "cancelled" && e.To != "no_show" {
		return nil
	}
	return p.endUnstayed(ctx, s)
}

func (p Policies) endUnstayed(ctx context.Context, s domain.Stay) error {
	if p.assertOpen(ctx, p.today()) != nil {
		return nil
	}
	held, err := p.Repo.DepositsHeld(ctx, s.ID)
	if err != nil {
		return err
	}
	codes, err := p.Repo.Codes(ctx)
	if err != nil {
		return err
	}
	draft, err := domain.UnstayedJournal(domain.StayRef{BookingID: s.ID, Code: s.Code, VillaID: s.VillaID}, held, p.today(), codes)
	if err != nil {
		return err
	}
	return p.writeOnce(ctx, draft, System)
}

// Billing events finance consumes. Billing documents the payloads in ARCHITECTURE.md under
// "Billing to finance events"; these types read the fields finance needs and ignore the rest.
const (
	EventFolioLinePosted       = "billing.folio_line.posted.v1"
	EventFolioLineVoided       = "billing.folio_line.voided.v1"
	EventPaymentRecorded       = "billing.payment.recorded.v1"
	EventPaymentRefunded       = "billing.payment.refunded.v1"
	EventNightAudited          = "billing.night.audited.v1"
	EventStayCheckedOut        = "billing.stay.checked_out.v1"
	EventCityLedgerTransferred = "billing.city_ledger.transferred.v1"
	EventCityLedgerInvoiced    = "billing.city_ledger.invoice_issued.v1"
	EventCityLedgerPaid        = "billing.city_ledger.payment_received.v1"
	EventCityLedgerWrittenOff  = "billing.city_ledger.written_off.v1"
	EventTaxSettingsChanged    = "billing.tax_settings.changed.v1"
	EventMaintenanceExpense    = "maintenance.expense.submitted.v1"
	EventStockPurchase         = "inventory.purchase.submitted.v1"
)

// CategoryAmount is one category's part of a payment.
type CategoryAmount struct {
	CategoryID string `json:"categoryId"`
	Amount     int64  `json:"amount"`
}

// PaymentFact is billing.payment.recorded and billing.payment.refunded: guest money that reached
// the desk or the gateway. Entries splits room service money per revenue category; Shares names
// each stay's part of a group payment.
type PaymentFact struct {
	PaymentID   string              `json:"paymentId"`
	Number      string              `json:"number"`
	Kind        string              `json:"kind"`
	Method      string              `json:"method"`
	Amount      int64               `json:"amount"`
	GatewayFee  int64               `json:"gatewayFee"`
	Date        string              `json:"date"`
	BookingID   string              `json:"bookingId"`
	BookingCode string              `json:"bookingCode"`
	GuestName   string              `json:"guestName"`
	VillaID     *string             `json:"villaId"`
	LocationID  string              `json:"locationId"`
	UnitID      *string             `json:"unitId"`
	Description string              `json:"description"`
	Reference   string              `json:"reference"`
	ForOrders   bool                `json:"forOrders"`
	Entries     []CategoryAmount    `json:"entries"`
	Shares      []domain.Share      `json:"shares"`
	ShiftID     *string             `json:"shiftId"`
	Attachments []domain.Attachment `json:"attachments"`
	RecordedBy  *Actor              `json:"recordedBy"`
}

var methodLabel = map[string]string{"cash": "Cash", "bank_transfer": "Bank transfer", "card": "Card", "qris": "QRIS", "virtual_account": "Virtual account", "airbnb_payout": "Airbnb payout"}

// PaymentRecorded is bookMoney and bookBatch: a cash-in (per category for order money), the
// gateway fee as a cash-out, both submitted for approval.
func (p Policies) PaymentRecorded(ctx context.Context, f PaymentFact) error {
	return p.bookMoney(ctx, f, false)
}

// PaymentRefunded books a refund as a cash-out for approval.
func (p Policies) PaymentRefunded(ctx context.Context, f PaymentFact) error {
	return p.bookMoney(ctx, f, true)
}

func (p Policies) bookMoney(ctx context.Context, f PaymentFact, refund bool) error {
	srcType := "payment"
	if refund {
		srcType = "refund"
	}
	src := Source{Type: srcType, ID: f.PaymentID}
	if done, err := p.written(ctx, src); err != nil || done {
		return err
	}
	a, err := p.accountFor(ctx, f.LocationID, f.Method, false)
	if err != nil || a == nil {
		return err
	}
	date := f.Date
	if date == "" {
		date = p.today()
	}
	origin := "payment"
	if f.Method == "cash" {
		origin = "front_desk"
	}
	by := f.RecordedBy.signer("reservation")
	base := domain.Transaction{AccountID: a.ID, Date: date, LocationID: f.LocationID, VillaID: f.VillaID, UnitID: f.UnitID, BookingID: domain.Ptr(f.BookingID),
		Reference: f.Number, Attachments: []domain.Attachment{}, Origin: origin}
	if f.Reference != "" {
		base.Reference = f.Reference
	}
	if f.ShiftID != nil {
		base.SetShift(*f.ShiftID)
	}
	if len(f.Shares) > 1 {
		base.UnitID = nil
	}
	link := &domain.EntryLink{Shares: f.Shares, OrderMoney: f.ForOrders}
	if len(link.Shares) == 0 {
		link.Shares = []domain.Share{{BookingID: f.BookingID, Amount: f.Amount}}
	}
	parts := []CategoryAmount{{CategoryID: "cat-room", Amount: f.Amount}}
	kind := domain.CashIn
	switch {
	case refund:
		kind, parts = domain.CashOut, []CategoryAmount{{CategoryID: "cat-other", Amount: f.Amount}}
	case f.ForOrders && len(f.Entries) > 0:
		parts = f.Entries
	case f.Method == "airbnb_payout":
		parts[0].CategoryID = "cat-airbnb"
	}
	description := f.Description
	if description == "" {
		description = fmt.Sprintf("%s %s, %s %s", f.Kind, f.Number, f.BookingCode, f.GuestName)
	}
	for i, part := range parts {
		t := base
		t.Kind, t.CategoryID, t.Amount, t.Description = kind, part.CategoryID, part.Amount, description
		if i == 0 {
			t.Attachments = slices.Clone(f.Attachments)
		}
		l := link
		if i > 0 {
			l = &domain.EntryLink{OrderMoney: f.ForOrders}
		}
		if _, err := p.newEntry(ctx, t, Entry{Submit: true, By: by, Source: &src, Link: l}); err != nil {
			return err
		}
	}
	if f.GatewayFee > 0 {
		fee := base
		fee.Kind, fee.CategoryID, fee.Amount, fee.Origin = domain.CashOut, "cat-fees", f.GatewayFee, "payment"
		fee.Description = fmt.Sprintf("%s fee on %s", methodLabel[f.Method], f.Number)
		feeSrc := Source{Type: "payment_fee", ID: f.PaymentID}
		if _, err := p.newEntry(ctx, fee, Entry{Submit: true, By: by, Source: &feeSrc}); err != nil {
			return err
		}
	}
	return nil
}

// FolioLine is billing.folio_line.posted and billing.folio_line.voided: a charge or rebate on a
// stay's folio, already split into net, service and PB1 on its code; a delivered order also names
// the partner costs it owes.
type FolioLine struct {
	LineID       string               `json:"lineId"`
	Kind         string               `json:"kind"`
	BookingID    string               `json:"bookingId"`
	BookingCode  string               `json:"bookingCode"`
	VillaID      *string              `json:"villaId"`
	Date         string               `json:"date"`
	Code         string               `json:"code"`
	Description  string               `json:"description"`
	Amount       int64                `json:"amount"`
	Service      int64                `json:"service"`
	PB1          int64                `json:"pb1"`
	OrderID      string               `json:"orderId"`
	OrderNumber  string               `json:"orderNumber"`
	Lines        []domain.CodeSplit   `json:"lines"`
	PartnerCosts []domain.PartnerCost `json:"partnerCosts"`
}

func (f FolioLine) draft(codes []domain.TransactionCode) (*domain.JournalEntry, error) {
	if f.OrderID != "" && f.Kind == "charge" {
		splits := f.Lines
		if len(splits) == 0 {
			splits = []domain.CodeSplit{{Code: f.Code, TaxSplit: domain.TaxSplit{Net: f.Amount, Service: f.Service, PB1: f.PB1}}}
		}
		return domain.OrderJournal(domain.OrderRef{ID: f.OrderID, Number: f.OrderNumber, BookingID: f.BookingID, VillaID: f.VillaID, Date: f.Date}, splits, f.PartnerCosts, codes)
	}
	return domain.ChargeJournal(domain.StayRef{BookingID: f.BookingID, Code: f.BookingCode, VillaID: f.VillaID}, f.Kind, f.Code, f.Description, f.Date,
		domain.TaxSplit{Net: f.Amount, Service: f.Service, PB1: f.PB1}, codes)
}

// FolioLinePosted is recordCharge and recordOrder: the line's revenue on the stay's receivable.
func (p Policies) FolioLinePosted(ctx context.Context, f FolioLine) error {
	if p.assertOpen(ctx, f.Date) != nil {
		return nil
	}
	codes, err := p.Repo.Codes(ctx)
	if err != nil {
		return err
	}
	draft, err := f.draft(codes)
	if err != nil || draft == nil {
		return err
	}
	_, err = p.writeJournal(ctx, draft, System)
	return err
}

// FolioLineVoided is recordVoid: the line's entry turned around on the day of the void.
func (p Policies) FolioLineVoided(ctx context.Context, f FolioLine) error {
	today := p.today()
	if p.assertOpen(ctx, today) != nil {
		return nil
	}
	codes, err := p.Repo.Codes(ctx)
	if err != nil {
		return err
	}
	draft, err := f.draft(codes)
	if err != nil || draft == nil {
		return err
	}
	number := f.OrderNumber
	if number == "" {
		number = f.BookingCode + " " + f.Code
	}
	turned := domain.Turned(*draft, today, number+" voided: delivery reversed")
	_, err = p.writeJournal(ctx, &turned, System)
	return err
}

// NightAudit is billing.night.audited: the room revenue billing worked out for nights From to To
// of a stay on its business date.
type NightAudit struct {
	BookingID   string          `json:"bookingId"`
	BookingCode string          `json:"bookingCode"`
	VillaID     *string         `json:"villaId"`
	Date        string          `json:"date"`
	From        int             `json:"from"`
	To          int             `json:"to"`
	Nights      int             `json:"nights"`
	Revenue     domain.TaxSplit `json:"revenue"`
}

// NightAudited is recordNights: the first posting bills the room and moves the deposits held.
func (p Policies) NightAudited(ctx context.Context, n NightAudit) error {
	if err := p.billed(ctx, n.BookingID, n.Date); err != nil {
		return err
	}
	var held int64
	if n.From == 0 {
		var err error
		if held, err = p.Repo.DepositsHeld(ctx, n.BookingID); err != nil {
			return err
		}
	}
	codes, err := p.Repo.Codes(ctx)
	if err != nil {
		return err
	}
	draft, err := domain.NightJournal(domain.StayRef{BookingID: n.BookingID, Code: n.BookingCode, VillaID: n.VillaID}, n.Revenue, n.From, n.To, n.Nights, held, n.Date, codes)
	if err != nil || draft == nil {
		return err
	}
	_, err = p.writeJournal(ctx, draft, System)
	return err
}

// billed sets a stay's first billed day when it has none.
func (p Policies) billed(ctx context.Context, bookingID, date string) error {
	stays, err := p.Repo.Stays(ctx, []string{bookingID})
	if err != nil {
		return err
	}
	s, ok := stays[bookingID]
	if !ok {
		s = domain.Stay{ID: bookingID, Status: "checked_in"}
	}
	if s.BilledOn != nil {
		return nil
	}
	s.BilledOn = &date
	return p.Repo.SaveStay(ctx, s)
}

// StayEnded is billing.stay.checked_out: the room nights no audit posted (Revenue), the channel
// fee taken off the receivable, the departure charges, or for a cancelled or no-show stay nothing
// but its status.
type StayEnded struct {
	BookingID   string          `json:"bookingId"`
	BookingCode string          `json:"bookingCode"`
	VillaID     *string         `json:"villaId"`
	Date        string          `json:"date"`
	Status      string          `json:"status"`
	Revenue     domain.TaxSplit `json:"revenue"`
	Fee         int64           `json:"fee"`
	Departure   *struct {
		Amount      int64  `json:"amount"`
		Description string `json:"description"`
	} `json:"departure"`
}

// StayCheckedOut is recordStay at check-out: departure charges on the other income code, then the
// nights left, the fee and the deposits held on the receivable.
func (p Policies) StayCheckedOut(ctx context.Context, e StayEnded) error {
	ref := domain.StayRef{BookingID: e.BookingID, Code: e.BookingCode, VillaID: e.VillaID}
	if e.Status == "cancelled" || e.Status == "no_show" {
		return p.endUnstayed(ctx, domain.Stay{ID: e.BookingID, Code: e.BookingCode, VillaID: e.VillaID, Status: e.Status})
	}
	if err := p.billed(ctx, e.BookingID, e.Date); err != nil {
		return err
	}
	if p.assertOpen(ctx, e.Date) != nil {
		return nil
	}
	have, err := p.Repo.JournalsOf(ctx, domain.SourceFolio, e.BookingID)
	if err != nil || len(have) > 0 {
		return err
	}
	codes, err := p.Repo.Codes(ctx)
	if err != nil {
		return err
	}
	if e.Departure != nil && e.Departure.Amount > 0 {
		description := e.Departure.Description
		if description == "" {
			description = "Departure charges"
		}
		d, err := domain.ChargeJournal(ref, "charge", domain.OtherCode, description, e.Date, domain.TaxSplit{Net: e.Departure.Amount}, codes)
		if err != nil {
			return err
		}
		if _, err := p.writeJournal(ctx, d, System); err != nil {
			return err
		}
	}
	held, err := p.Repo.DepositsHeld(ctx, e.BookingID)
	if err != nil {
		return err
	}
	draft, err := domain.StayJournal(ref, e.Revenue, e.Fee, held, e.Date, codes)
	if err != nil {
		return err
	}
	_, err = p.writeJournal(ctx, draft, System)
	return err
}

// CityLedgerFact is the city ledger events: a stay's bill moved to an account, an invoice issued
// with its agent commission, a payment received, a balance written off.
type CityLedgerFact struct {
	ID            string  `json:"id"`
	Number        string  `json:"number"`
	AccountID     string  `json:"accountId"`
	AccountName   string  `json:"accountName"`
	BookingID     string  `json:"bookingId"`
	BookingCode   string  `json:"bookingCode"`
	VillaID       *string `json:"villaId"`
	LocationID    string  `json:"locationId"`
	Date          string  `json:"date"`
	Description   string  `json:"description"`
	Amount        int64   `json:"amount"`
	Commission    int64   `json:"commission"`
	Method        string  `json:"method"`
	Reference     string  `json:"reference"`
	InvoiceNumber string  `json:"invoiceNumber"`
	Reason        string  `json:"reason"`
	By            *Actor  `json:"by"`
}

// CityLedgerTransferred is recordTransfer: the bill leaves the guest receivable for the city ledger.
func (p Policies) CityLedgerTransferred(ctx context.Context, f CityLedgerFact) error {
	if p.assertOpen(ctx, f.Date) != nil {
		return nil
	}
	draft, err := domain.CityTransferJournal(domain.StayRef{BookingID: f.BookingID, Code: f.BookingCode, VillaID: f.VillaID}, f.AccountID, f.Description, f.Date, f.Amount)
	if err != nil {
		return err
	}
	_, err = p.writeJournal(ctx, draft, System)
	return err
}

// CityLedgerInvoiced is recordCommission: an agent's commission off what the agent owes.
func (p Policies) CityLedgerInvoiced(ctx context.Context, f CityLedgerFact) error {
	if p.assertOpen(ctx, f.Date) != nil {
		return nil
	}
	draft, err := domain.CommissionJournal(f.AccountID, f.Number, f.Date, f.Commission)
	if err != nil || draft == nil {
		return err
	}
	_, err = p.writeJournal(ctx, draft, System)
	return err
}

// CityLedgerPaid books an account's payment as a City ledger cash-in for approval.
func (p Policies) CityLedgerPaid(ctx context.Context, f CityLedgerFact) error {
	src := Source{Type: "city_ledger_payment", ID: f.ID}
	if done, err := p.written(ctx, src); err != nil || done {
		return err
	}
	a, err := p.accountFor(ctx, f.LocationID, f.Method, true)
	if err != nil || a == nil {
		return err
	}
	location := f.LocationID
	if location == "" {
		if location, err = p.accountLocation(ctx, *a); err != nil {
			return err
		}
	}
	origin := "payment"
	if f.Method == "cash" {
		origin = "front_desk"
	}
	_, err = p.newEntry(ctx, domain.Transaction{AccountID: a.ID, Kind: domain.CashIn, CategoryID: "cat-city-ledger", Amount: f.Amount, Date: p.today(), LocationID: location,
		Description: fmt.Sprintf("City ledger payment %s from %s", f.Number, f.AccountName), Reference: strings.TrimSpace(f.Reference), Attachments: []domain.Attachment{}, Origin: origin},
		Entry{Submit: true, By: f.By.signer("reservation"), Source: &src})
	return err
}

// CityLedgerWrittenOff asks for the write-off as a submitted manual journal: bad debt against the
// city ledger receivable, signed like any journal.
func (p Policies) CityLedgerWrittenOff(ctx context.Context, f CityLedgerFact) error {
	memo := fmt.Sprintf("Write-off on %s, %s: %s", f.InvoiceNumber, f.AccountName, strings.TrimSpace(f.Reason))
	ms, err := p.Repo.ManualJournals(ctx)
	if err != nil {
		return err
	}
	if slices.ContainsFunc(ms, func(m domain.ManualJournal) bool { return m.Memo == memo }) {
		return nil
	}
	_, err = p.newManualJournal(ctx, domain.ManualJournalInput{Date: p.today(), Memo: memo,
		Lines: []domain.JournalLine{{AccountID: domain.GLBadDebt, Debit: f.Amount}, {AccountID: domain.GLCityLedger, Credit: f.Amount}}}, true, f.By.signer("finance"))
	return err
}

// TaxSettingsChanged keeps billing's tax settings when billing saves them on its side.
func (p Policies) TaxSettingsChanged(ctx context.Context, t domain.TaxSettings) error {
	if t.Rates == nil {
		return nil
	}
	if t.Regencies == nil {
		t.Regencies = map[string]string{}
	}
	return p.Repo.SaveSetting(ctx, KeyTax, t)
}

// CashOutRequest is maintenance.expense.submitted and inventory.purchase.submitted: an expense
// paid for a villa, cash from its location's cashbox, anything else from the bank.
type CashOutRequest struct {
	ID          string              `json:"id"`
	Number      string              `json:"number"`
	VillaID     string              `json:"villaId"`
	LocationID  string              `json:"locationId"`
	UnitID      *string             `json:"unitId"`
	Method      string              `json:"method"`
	Amount      int64               `json:"amount"`
	Date        string              `json:"date"`
	CategoryID  string              `json:"categoryId"`
	Description string              `json:"description"`
	Reference   string              `json:"reference"`
	Attachments []domain.Attachment `json:"attachments"`
	By          *Actor              `json:"by"`
}

// MaintenanceExpense books a work order expense as a Maintenance cash-out for approval.
func (p Policies) MaintenanceExpense(ctx context.Context, r CashOutRequest) error {
	return p.cashOut(ctx, r, Source{Type: "maintenance_expense", ID: r.ID}, "cat-maint", "maintenance")
}

// StockPurchase books a stock receipt as a Stock purchase cash-out for approval.
func (p Policies) StockPurchase(ctx context.Context, r CashOutRequest) error {
	return p.cashOut(ctx, r, Source{Type: "stock_purchase", ID: r.ID}, "cat-house", "stock")
}

// cashOut writes the entry, or resubmits a rejected one with the corrected fields.
func (p Policies) cashOut(ctx context.Context, r CashOutRequest, src Source, category, origin string) error {
	if r.CategoryID != "" {
		category = r.CategoryID
	}
	location := r.LocationID
	if location == "" {
		places, err := p.Repo.Places(ctx)
		if err != nil {
			return err
		}
		v, _ := places.Villa(r.VillaID)
		location = v.LocationID
	}
	a, err := p.accountFor(ctx, location, r.Method, true)
	if err != nil || a == nil {
		return err
	}
	date := r.Date
	if date == "" {
		date = p.today()
	}
	attachments := r.Attachments
	if attachments == nil {
		attachments = []domain.Attachment{}
	}
	by := r.By.signer("manager")
	have, err := p.Repo.BySource(ctx, src)
	if err != nil {
		return err
	}
	if len(have) > 0 {
		t := have[len(have)-1]
		if t.Status != domain.Rejected {
			return nil
		}
		t.AccountID, t.Amount, t.Date, t.Description, t.Reference, t.Attachments = a.ID, r.Amount, date, r.Description, r.Reference, attachments
		if err := domain.AssertFiles(t.Attachments); err != nil {
			return nil
		}
		if p.assertProof(ctx, t) != nil {
			return nil
		}
		domain.Approvable{Number: t.Number, Status: &t.Status, Approvals: &t.Approvals, History: &t.History, RejectionReason: &t.RejectionReason, CreatedByID: t.CreatedByID, Noun: "entry"}.Submit(by, p.today(), "")
		return p.Repo.UpdateTransaction(ctx, &t)
	}
	villa := r.VillaID
	_, err = p.askFor(ctx, domain.Transaction{AccountID: a.ID, Kind: domain.CashOut, CategoryID: category, Amount: r.Amount, Date: date, LocationID: location, VillaID: &villa,
		UnitID: r.UnitID, Description: r.Description, Reference: r.Reference, Attachments: attachments, Origin: origin}, Entry{By: by, Source: &src})
	return err
}
