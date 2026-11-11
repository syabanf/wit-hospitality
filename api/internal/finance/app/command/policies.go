package command

import (
	"context"
	"encoding/json"
	"fmt"
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
		if err := d.decided(ctx, out); err != nil {
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
	for _, v := range e.ByVilla {
		if err := p.Repo.SavePayrollCost(ctx, e.Month, v.VillaID, v.Amount); err != nil {
			return err
		}
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
	room, err := p.roomAccount(ctx)
	if err != nil {
		return err
	}
	draft, err := domain.UnstayedJournal(domain.StayRef{BookingID: s.ID, Code: s.Code, VillaID: s.VillaID}, room, held, p.today())
	if err != nil {
		return err
	}
	return p.writeOnce(ctx, draft, System)
}

// CashOutRequest is a cash-out maintenance or inventory asks for (maintenance.CashOut and
// inventory.CashOut share the shape). TransactionID is the id the asking context gave it; finance
// keeps that id, so the asking context's records keep pointing at the entry, and numbers the entry
// itself from its own sequence.
type CashOutRequest struct {
	TransactionID string              `json:"transactionId"`
	Number        string              `json:"number"`
	Origin        string              `json:"origin"`
	SourceID      string              `json:"sourceId"`
	Kind          string              `json:"kind"`
	CategoryID    string              `json:"categoryId"`
	Method        string              `json:"method"`
	Amount        int64               `json:"amount"`
	Date          string              `json:"date"`
	LocationID    string              `json:"locationId"`
	VillaID       string              `json:"villaId"`
	UnitID        *string             `json:"unitId"`
	Description   string              `json:"description"`
	Reference     string              `json:"reference"`
	Attachments   []domain.Attachment `json:"attachments"`
	CreatedByID   string              `json:"createdById"`
	CreatedBy     string              `json:"createdBy"`
	Note          string              `json:"note"`
}

// Source types of the cash-outs other contexts ask for; finance.cash_out.decided.v1 answers them.
const (
	SourceExpense  = "maintenance_expense"
	SourcePurchase = "stock_purchase"
)

func decidedFor(src *Source) bool {
	return src != nil && (src.Type == SourceExpense || src.Type == SourcePurchase)
}

// CashOutDecided is the payload of finance.cash_out.decided.v1, the shape maintenance and
// inventory read (maintenance.CashOutDecided, inventory.CashOutDecided).
type CashOutDecided struct {
	TransactionID   string `json:"transactionId"`
	Number          string `json:"number"`
	Status          string `json:"status"`
	RejectionReason string `json:"rejectionReason"`
	Version         int64  `json:"version"`
}

// decided tells the asking context where its cash-out stands; Version is the entry's version, so
// a late event never rolls a status back.
func (d Deps) decided(ctx context.Context, t domain.Transaction) error {
	src, err := d.Repo.SourceOf(ctx, t.ID)
	if err != nil || !decidedFor(src) {
		return err
	}
	reason := ""
	if t.RejectionReason != nil {
		reason = *t.RejectionReason
	}
	return d.emit(ctx, finance.EventCashOutDecided, "transaction", t.ID, t.Version, CashOutDecided{TransactionID: t.ID, Number: t.Number, Status: t.Status, RejectionReason: reason, Version: t.Version})
}

// CashOutSubmitted books a work order expense or a stock purchase as a cash-out for approval
// (maintenance.expense.submitted.v1, inventory.purchase.submitted.v1). Without its receipt it is
// kept rejected with the PROOF_REQUIRED wording.
func (p Policies) CashOutSubmitted(srcType string) func(context.Context, CashOutRequest) error {
	return func(ctx context.Context, r CashOutRequest) error {
		if _, err := p.Repo.Transaction(ctx, r.TransactionID); err == nil {
			return nil
		}
		t, err := p.cashOutFields(ctx, r)
		if err != nil || t.AccountID == "" {
			return err
		}
		t.ID = r.TransactionID
		src := Source{Type: srcType, ID: r.SourceID}
		_, err = p.askFor(ctx, t, Entry{By: domain.Signer{ID: r.CreatedByID, Name: r.CreatedBy, Role: "manager"}, Source: &src})
		return err
	}
}

func (p Policies) cashOutFields(ctx context.Context, r CashOutRequest) (domain.Transaction, error) {
	location := r.LocationID
	if location == "" {
		places, err := p.Repo.Places(ctx)
		if err != nil {
			return domain.Transaction{}, err
		}
		v, _ := places.Villa(r.VillaID)
		location = v.LocationID
	}
	a, err := p.accountFor(ctx, location, r.Method, true)
	if err != nil || a == nil {
		return domain.Transaction{}, err
	}
	date := r.Date
	if date == "" {
		date = p.today()
	}
	attachments := r.Attachments
	if attachments == nil {
		attachments = []domain.Attachment{}
	}
	t := domain.Transaction{AccountID: a.ID, Kind: domain.CashOut, CategoryID: r.CategoryID, Amount: r.Amount, Date: date, LocationID: location,
		UnitID: r.UnitID, Description: r.Description, Reference: r.Reference, Attachments: attachments, Origin: r.Origin}
	if r.VillaID != "" {
		villa := r.VillaID
		t.VillaID = &villa
	}
	return t, nil
}

// CashOutResubmitted puts the corrected fields on a rejected cash-out and sends it back to the
// first approval level, as the mock's resubmit does; still without its receipt it stays rejected.
func (p Policies) CashOutResubmitted(ctx context.Context, r CashOutRequest) error {
	t, err := p.Repo.Transaction(ctx, r.TransactionID)
	if err != nil || t.Status != domain.Rejected {
		return nil
	}
	fields, err := p.cashOutFields(ctx, r)
	if err != nil || fields.AccountID == "" {
		return err
	}
	t.AccountID, t.CategoryID, t.Amount, t.Date, t.LocationID, t.VillaID, t.UnitID = fields.AccountID, fields.CategoryID, fields.Amount, fields.Date, fields.LocationID, fields.VillaID, fields.UnitID
	t.Description, t.Reference, t.Attachments = fields.Description, fields.Reference, fields.Attachments
	if domain.AssertFiles(t.Attachments) == nil && p.assertProof(ctx, t) == nil {
		by := domain.Signer{ID: r.CreatedByID, Name: r.CreatedBy, Role: "manager"}
		domain.Approvable{Number: t.Number, Status: &t.Status, Approvals: &t.Approvals, History: &t.History, RejectionReason: &t.RejectionReason, CreatedByID: t.CreatedByID, Noun: "entry"}.Submit(by, p.today(), r.Note)
	}
	if err := p.Repo.UpdateTransaction(ctx, &t); err != nil {
		return err
	}
	return p.decided(ctx, t)
}

// PurchaseCancelled closes a rejected purchase for good: its entry stays rejected and cannot be
// resubmitted from the ledger.
func (p Policies) PurchaseCancelled(ctx context.Context, r CashOutRequest) error {
	l, err := p.Repo.Link(ctx, r.TransactionID)
	if err != nil {
		return err
	}
	if l == nil {
		l = &domain.EntryLink{TransactionID: r.TransactionID}
	}
	l.Cancelled = true
	return p.Repo.SaveLink(ctx, *l)
}
