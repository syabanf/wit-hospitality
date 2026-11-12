package command

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// The billing policies book what billing publishes ("Billing to finance events" in
// ARCHITECTURE.md): the cash entries the mock's bookMoney, closeStay and city ledger create, and
// the journals of ledger.ts. Each fact is keyed by its own id in finance.refs, which also answers
// billing's ApprovalStatus.

var paymentKindLabel = map[string]string{"deposit": "Deposit", "balance": "Balance", "full": "Full payment", "extra": "Extras", "refund": "Refund", "payout": "Airbnb payout"}

var methodLabel = map[string]string{"cash": "Cash", "bank_transfer": "Bank transfer", "card": "Card", "qris": "QRIS", "virtual_account": "Virtual account", "airbnb_payout": "Airbnb payout"}

func ptrOr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func splitOf(amount int64, taxes []billing.TaxLine) domain.TaxSplit {
	s := domain.TaxSplit{Net: amount}
	for _, t := range taxes {
		if t.Code == domain.ServiceCode {
			s.Service += t.Amount
		} else {
			s.PB1 += t.Amount
		}
	}
	return s
}

func (d Deps) roomAccount(ctx context.Context) (string, error) {
	codes, err := d.Repo.Codes(ctx)
	return domain.CodeAccount(codes, domain.RoomCode), err
}

// cashAccount is the account billing named, or the one accountFor picks when it named none.
func (d Deps) cashAccount(ctx context.Context, id, locationID, method string) (*domain.CashAccount, error) {
	if id != "" {
		if a, err := d.Repo.Account(ctx, id, false); err == nil {
			return &a, nil
		}
	}
	return d.accountFor(ctx, locationID, method, false)
}

func signerNamed(name, role string) domain.Signer {
	if name == "" {
		return System
	}
	return domain.Signer{Name: name, Role: role}
}

// PaymentRecorded is bookMoney and bookBatch: the cash-in (per revenue category for room service
// money, one entry for the shares of a batch) and the gateway fee, submitted for approval.
func (p Policies) PaymentRecorded(ctx context.Context, f billing.PaymentRecorded) error {
	if ok, err := p.seen(ctx, f.PaymentID); err != nil || ok {
		return err
	}
	a, err := p.cashAccount(ctx, f.CashAccountID, f.LocationID, f.Method)
	if err != nil || a == nil {
		return err
	}
	by := signerNamed(f.RecordedBy, "reservation")
	date := f.Date
	if date == "" {
		date = p.today()
	}
	origin := f.Origin
	if origin == "" {
		origin = "payment"
		if f.Method == "cash" {
			origin = "front_desk"
		}
	}
	base := domain.Transaction{AccountID: a.ID, Date: date, LocationID: f.LocationID, VillaID: ptrOr(f.VillaID), UnitID: ptrOr(f.UnitID), BookingID: ptrOr(f.BookingID),
		Reference: f.Number, Attachments: []domain.Attachment{}, Origin: origin}
	if f.ShiftID != "" {
		base.SetShift(f.ShiftID)
	}
	if f.Batch != "" {
		return p.batchShare(ctx, f, base, by)
	}
	src := Source{Type: "payment", ID: f.PaymentID}
	parts := []billing.Revenue{{CategoryID: f.CategoryID, Amount: f.Amount}}
	description := fmt.Sprintf("%s %s, %s %s", paymentKindLabel[f.Kind], f.Number, f.BookingCode, f.Payer)
	if parts[0].CategoryID == "" {
		parts[0].CategoryID = "cat-room"
	}
	receipts, err := p.receipts(ctx, f.AttachmentIDs)
	if err != nil {
		return err
	}
	forOrders := len(f.OrderIDs) > 0
	if forOrders && len(f.Revenue) > 0 {
		parts = f.Revenue
		description = fmt.Sprintf("Room service %s, %s %s", strings.Join(f.OrderIDs, ", "), f.BookingCode, f.Payer)
	}
	for i, part := range parts {
		if part.Amount <= 0 {
			continue
		}
		t := base
		t.Kind, t.CategoryID, t.Amount, t.Description = domain.CashIn, part.CategoryID, part.Amount, description
		link := &domain.EntryLink{Shares: []domain.Share{{BookingID: f.BookingID, Amount: f.Amount}}, OrderMoney: forOrders}
		if i > 0 {
			link = &domain.EntryLink{OrderMoney: forOrders}
		} else {
			t.Attachments = receipts
		}
		saved, err := p.newEntry(ctx, t, Entry{Submit: true, By: by, Source: &src, Link: link})
		if err != nil {
			return err
		}
		if i == 0 {
			if err := p.Repo.SaveRef(ctx, f.PaymentID, RefTransaction, saved.ID); err != nil {
				return err
			}
		}
	}
	return p.fee(ctx, base, f.Fee, f.Method, f.Number, Source{Type: "payment_fee", ID: f.PaymentID}, by)
}

func (p Policies) fee(ctx context.Context, base domain.Transaction, amount int64, method, number string, src Source, by domain.Signer) error {
	if amount <= 0 {
		return nil
	}
	fee := base
	fee.Kind, fee.CategoryID, fee.Amount, fee.Origin = domain.CashOut, "cat-fees", amount, "payment"
	fee.Description = fmt.Sprintf("%s fee on %s", methodLabel[method], number)
	_, err := p.newEntry(ctx, fee, Entry{Submit: true, By: by, Source: &src})
	return err
}

// batchShare adds one share of a group payment to the batch's single cash-in and fee entry.
func (p Policies) batchShare(ctx context.Context, f billing.PaymentRecorded, base domain.Transaction, by domain.Signer) error {
	key := "batch:" + f.Batch
	share := domain.Share{BookingID: f.BookingID, Amount: f.Amount}
	if kind, id, ok, err := p.Repo.Ref(ctx, key); err != nil {
		return err
	} else if ok && kind == RefTransaction {
		t, err := p.Repo.Transaction(ctx, id)
		if err != nil {
			return err
		}
		if t.Status == domain.Draft || t.Status == domain.Submitted {
			l, err := p.Repo.Link(ctx, t.ID)
			if err != nil {
				return err
			}
			if l == nil {
				l = &domain.EntryLink{TransactionID: t.ID}
			}
			l.Shares = append(l.Shares, share)
			t.Amount += f.Amount
			t.Description += ", " + f.BookingCode
			if err := p.Repo.UpdateTransaction(ctx, &t); err != nil {
				return err
			}
			if err := p.Repo.SaveLink(ctx, *l); err != nil {
				return err
			}
		}
		if err := p.Repo.SaveRef(ctx, f.PaymentID, RefTransaction, t.ID); err != nil {
			return err
		}
		return p.batchFee(ctx, f, base, by)
	}
	src := Source{Type: "payment", ID: f.Batch}
	t := base
	t.UnitID = nil
	t.Kind, t.CategoryID, t.Amount, t.Reference = domain.CashIn, "cat-room", f.Amount, f.Batch
	t.Description = fmt.Sprintf("Group %s %s: %s", strings.ToLower(paymentKindLabel[f.Kind]), f.Batch, f.BookingCode)
	saved, err := p.newEntry(ctx, t, Entry{Submit: true, By: by, Source: &src, Link: &domain.EntryLink{Shares: []domain.Share{share}}})
	if err != nil {
		return err
	}
	if err := p.Repo.SaveRef(ctx, key, RefTransaction, saved.ID); err != nil {
		return err
	}
	if err := p.Repo.SaveRef(ctx, f.PaymentID, RefTransaction, saved.ID); err != nil {
		return err
	}
	return p.batchFee(ctx, f, base, by)
}

func (p Policies) batchFee(ctx context.Context, f billing.PaymentRecorded, base domain.Transaction, by domain.Signer) error {
	if f.Fee <= 0 {
		return nil
	}
	key := "batchfee:" + f.Batch
	if kind, id, ok, err := p.Repo.Ref(ctx, key); err != nil {
		return err
	} else if ok && kind == RefTransaction {
		t, err := p.Repo.Transaction(ctx, id)
		if err != nil || (t.Status != domain.Draft && t.Status != domain.Submitted) {
			return err
		}
		t.Amount += f.Fee
		return p.Repo.UpdateTransaction(ctx, &t)
	}
	base.UnitID, base.Reference = nil, f.Batch
	src := Source{Type: "payment_fee", ID: f.Batch}
	if err := p.fee(ctx, base, f.Fee, f.Method, f.Batch, src, by); err != nil {
		return err
	}
	have, err := p.Repo.BySource(ctx, src)
	if err != nil || len(have) == 0 {
		return err
	}
	return p.Repo.SaveRef(ctx, key, RefTransaction, have[len(have)-1].ID)
}

// PaymentRefunded books money going back as a cash-out for approval; a refund of room service
// money keeps paying back the receivable its orders were billed on.
func (p Policies) PaymentRefunded(ctx context.Context, f billing.PaymentRefunded) error {
	if ok, err := p.seen(ctx, f.PaymentID); err != nil || ok {
		return err
	}
	a, err := p.cashAccount(ctx, f.CashAccountID, f.LocationID, f.Method)
	if err != nil || a == nil {
		return err
	}
	date := f.Date
	if date == "" {
		date = p.today()
	}
	category := f.CategoryID
	if category == "" {
		category = "cat-other"
	}
	origin := f.Origin
	if origin == "" {
		origin = "payment"
		if f.Method == "cash" {
			origin = "front_desk"
		}
	}
	receipts, err := p.receipts(ctx, f.AttachmentIDs)
	if err != nil {
		return err
	}
	orderMoney := len(f.OrderIDs) > 0
	if _, id, ok, err := p.Repo.Ref(ctx, f.RefundOf); err == nil && ok {
		if l, err := p.Repo.Link(ctx, id); err == nil && l != nil {
			orderMoney = orderMoney || l.OrderMoney
		}
	}
	t := domain.Transaction{AccountID: a.ID, Kind: domain.CashOut, CategoryID: category, Amount: f.Amount, Date: date, LocationID: f.LocationID, VillaID: ptrOr(f.VillaID),
		UnitID: ptrOr(f.UnitID), BookingID: ptrOr(f.BookingID), Description: fmt.Sprintf("Refund %s, %s %s", f.Number, f.BookingCode, f.Payer), Reference: f.Number,
		Attachments: receipts, Origin: origin}
	if f.ShiftID != "" {
		t.SetShift(f.ShiftID)
	}
	src := Source{Type: "refund", ID: f.PaymentID}
	saved, err := p.newEntry(ctx, t, Entry{Submit: true, By: signerNamed(f.RecordedBy, "reservation"), Source: &src,
		Link: &domain.EntryLink{Shares: []domain.Share{{BookingID: f.BookingID, Amount: f.Amount}}, OrderMoney: orderMoney}})
	if err != nil {
		return err
	}
	return p.Repo.SaveRef(ctx, f.PaymentID, RefTransaction, saved.ID)
}

func stayRef(bookingID, code, villaID string) domain.StayRef {
	return domain.StayRef{BookingID: bookingID, Code: code, VillaID: ptrOr(villaID)}
}

// FolioLinePosted is recordCharge: a charge or rebate on its code's account and the stay's
// receivable. A transfer is booked when city_ledger.transferred arrives with every part.
func (p Policies) FolioLinePosted(ctx context.Context, f billing.FolioLinePosted) error {
	if f.Kind == "transfer" || p.assertOpen(ctx, f.Date) != nil {
		return nil
	}
	if ok, err := p.seen(ctx, f.PostingID); err != nil || ok {
		return err
	}
	account := f.Account
	if account == "" {
		codes, err := p.Repo.Codes(ctx)
		if err != nil {
			return err
		}
		account = domain.CodeAccount(codes, f.Code)
	}
	draft, err := domain.ChargeJournal(stayRef(f.BookingID, f.BookingCode, f.VillaID), f.Kind, f.Code, account, f.Description, f.Date, domain.TaxSplit{Net: f.Amount, Service: f.Service, PB1: f.PB1})
	if err != nil {
		return err
	}
	e, err := p.writeJournal(ctx, draft, signerNamed(f.PostedBy, "reservation"))
	if err != nil {
		return err
	}
	return p.Repo.SaveRef(ctx, f.PostingID, RefJournal, e.ID)
}

// FolioLineVoided is recordVoid: the order's lines turned around on the day of the void.
func (p Policies) FolioLineVoided(ctx context.Context, f billing.FolioLineVoided) error {
	date := f.Date
	if date == "" {
		date = p.today()
	}
	if p.assertOpen(ctx, date) != nil {
		return nil
	}
	have, err := p.Repo.JournalsOf(ctx, domain.SourceOrder, f.OrderID)
	if err != nil || len(have) > 0 {
		return err
	}
	lines := make([]domain.CodeLine, 0, len(f.Lines))
	for _, l := range f.Lines {
		lines = append(lines, domain.CodeLine{Code: l.Code, Account: l.Account, TaxSplit: splitOf(l.Amount, l.TaxLines)})
	}
	draft, err := domain.VoidJournal(stayRef(f.BookingID, f.BookingCode, f.VillaID), f.OrderID, f.OrderNumber, date, lines)
	if err != nil {
		return err
	}
	_, err = p.writeJournal(ctx, draft, System)
	return err
}

// NightAudited is recordNights for every stay the audit posted: room revenue on its receivable,
// the first posting billing the room and moving the deposits held over.
func (p Policies) NightAudited(ctx context.Context, n billing.NightAudited) error {
	if ok, err := p.seen(ctx, "audit:"+n.AuditID); err != nil || ok {
		return err
	}
	date := n.Date
	for _, s := range n.Stays {
		if len(s.Lines) == 0 {
			continue
		}
		var net int64
		var taxes []billing.TaxLine
		for _, l := range s.Lines {
			net += l.Amount
			taxes = append(taxes, l.TaxLines...)
		}
		to := len(s.NightsPosted)
		from := max(0, to-len(s.Lines))
		if len(s.NightsPosted) > 0 {
			if err := p.billed(ctx, s.BookingID, s.NightsPosted[0]); err != nil {
				return err
			}
		}
		var held int64
		if from == 0 {
			var err error
			if held, err = p.Repo.DepositsHeld(ctx, s.BookingID); err != nil {
				return err
			}
		}
		draft, err := domain.NightJournal(stayRef(s.BookingID, s.Code, s.VillaID), s.Lines[0].Account, splitOf(net, taxes), from, to, s.Nights, held, date)
		if err != nil {
			return err
		}
		if _, err := p.writeJournal(ctx, draft, signerNamed(n.RanBy, "reservation")); err != nil {
			return err
		}
	}
	return p.Repo.SaveRef(ctx, "audit:"+n.AuditID, RefJournal, n.AuditID)
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

// StayCheckedOut is closeStay and recordStay: the folio charges taken at a settled check-out as a
// cash-in for approval, then the departure charges on the other income code, and the room nights
// no audit posted with the deposits held on the receivable.
func (p Policies) StayCheckedOut(ctx context.Context, e billing.StayCheckedOut) error {
	if err := p.billed(ctx, e.BookingID, e.Date); err != nil {
		return err
	}
	have, err := p.Repo.JournalsOf(ctx, domain.SourceFolio, e.BookingID)
	if err != nil || len(have) > 0 {
		return err
	}
	if e.FolioCharges > 0 {
		if ok, err := p.seen(ctx, "checkout:"+e.BookingID); err != nil {
			return err
		} else if !ok {
			a, err := p.cashAccount(ctx, e.CashAccountID, e.LocationID, e.Method)
			if err != nil {
				return err
			}
			if a != nil {
				origin := "front_desk"
				if a.Kind == domain.Bank {
					origin = "payment"
				}
				t, err := p.newEntry(ctx, domain.Transaction{AccountID: a.ID, Kind: domain.CashIn, CategoryID: "cat-extra", Amount: e.FolioCharges, Date: p.today(), LocationID: e.LocationID,
					VillaID: ptrOr(e.VillaID), UnitID: ptrOr(e.UnitID), BookingID: ptrOr(e.BookingID), Description: "Folio charges, " + e.BookingCode, Reference: e.BookingCode,
					Attachments: []domain.Attachment{}, Origin: origin}, Entry{Submit: true, By: System, Source: &Source{Type: "checkout", ID: e.BookingID}})
				if err != nil {
					return err
				}
				if err := p.Repo.SaveRef(ctx, "checkout:"+e.BookingID, RefTransaction, t.ID); err != nil {
					return err
				}
			}
		}
	}
	if p.assertOpen(ctx, e.Date) != nil {
		return nil
	}
	codes, err := p.Repo.Codes(ctx)
	if err != nil {
		return err
	}
	ref := stayRef(e.BookingID, e.BookingCode, e.VillaID)
	if e.ExtraCharges > 0 {
		d, err := domain.ChargeJournal(ref, "charge", domain.OtherCode, domain.CodeAccount(codes, domain.OtherCode), "Departure charges", e.Date, domain.TaxSplit{Net: e.ExtraCharges})
		if err != nil {
			return err
		}
		if _, err := p.writeJournal(ctx, d, System); err != nil {
			return err
		}
	}
	var net int64
	var taxes []billing.TaxLine
	account := domain.CodeAccount(codes, domain.RoomCode)
	for _, l := range e.RoomLines {
		net += l.Amount
		taxes = append(taxes, l.TaxLines...)
		if l.Account != "" {
			account = l.Account
		}
	}
	held, err := p.Repo.DepositsHeld(ctx, e.BookingID)
	if err != nil {
		return err
	}
	draft, err := domain.StayJournal(ref, account, splitOf(net, taxes), 0, held, e.Date)
	if err != nil {
		return err
	}
	_, err = p.writeJournal(ctx, draft, System)
	return err
}

// CityLedgerTransferred is recordTransfer for each part: the bill leaves the stay's receivable for
// City ledger receivable.
func (p Policies) CityLedgerTransferred(ctx context.Context, f billing.CityLedgerTransferred) error {
	if p.assertOpen(ctx, f.Date) != nil {
		return nil
	}
	for _, part := range f.Parts {
		if ok, err := p.seen(ctx, "transfer:"+part.PostingID); err != nil || ok {
			if err != nil {
				return err
			}
			continue
		}
		draft, err := domain.CityTransferJournal(stayRef(f.BookingID, f.BookingCode, f.VillaID), f.AccountID, "Transfer to city ledger "+f.AccountCode, f.Date, part.Amount)
		if err != nil {
			return err
		}
		e, err := p.writeJournal(ctx, draft, System)
		if err != nil {
			return err
		}
		if err := p.Repo.SaveRef(ctx, "transfer:"+part.PostingID, RefJournal, e.ID); err != nil {
			return err
		}
	}
	return nil
}

// CityLedgerInvoiced is recordCommission: an agent's commission off what the agent owes.
func (p Policies) CityLedgerInvoiced(ctx context.Context, f billing.CityLedgerInvoiceIssued) error {
	if p.assertOpen(ctx, f.Date) != nil {
		return nil
	}
	if ok, err := p.seen(ctx, f.InvoiceID); err != nil || ok {
		return err
	}
	draft, err := domain.CommissionJournal(f.AccountID, f.Number, f.Date, f.Commission)
	if err != nil || draft == nil {
		return err
	}
	e, err := p.writeJournal(ctx, draft, System)
	if err != nil {
		return err
	}
	return p.Repo.SaveRef(ctx, f.InvoiceID, RefJournal, e.ID)
}

// CityLedgerPaid books an account's payment as a City ledger cash-in for approval.
func (p Policies) CityLedgerPaid(ctx context.Context, f billing.CityLedgerPaymentReceived) error {
	if ok, err := p.seen(ctx, f.PaymentID); err != nil || ok {
		return err
	}
	a, err := p.cashAccount(ctx, f.CashAccountID, f.LocationID, f.Method)
	if err != nil || a == nil {
		return err
	}
	location := f.LocationID
	if location == "" {
		if location, err = p.accountLocation(ctx, *a); err != nil {
			return err
		}
	}
	category := f.CategoryID
	if category == "" {
		category = "cat-city-ledger"
	}
	origin := f.Origin
	if origin == "" {
		origin = "payment"
	}
	src := Source{Type: "city_ledger_payment", ID: f.PaymentID}
	t, err := p.newEntry(ctx, domain.Transaction{AccountID: a.ID, Kind: domain.CashIn, CategoryID: category, Amount: f.Amount, Date: p.today(), LocationID: location,
		Description: fmt.Sprintf("City ledger payment %s from %s", f.Number, f.AccountID), Reference: strings.TrimSpace(f.Reference), Attachments: []domain.Attachment{}, Origin: origin},
		Entry{Submit: true, By: signerNamed(f.RecordedBy, "reservation"), Source: &src})
	if err != nil {
		return err
	}
	return p.Repo.SaveRef(ctx, f.PaymentID, RefTransaction, t.ID)
}

// CityLedgerWrittenOff asks for the write-off as a submitted manual journal: bad debt against the
// city ledger receivable, signed like any journal.
func (p Policies) CityLedgerWrittenOff(ctx context.Context, f billing.CityLedgerWrittenOff) error {
	if ok, err := p.seen(ctx, f.WriteOffID); err != nil || ok {
		return err
	}
	debit, credit := f.DebitAccount, f.CreditAccount
	if debit == "" {
		debit = domain.GLBadDebt
	}
	if credit == "" {
		credit = domain.GLCityLedger
	}
	m, err := p.newManualJournal(ctx, domain.ManualJournalInput{Date: p.today(), Memo: fmt.Sprintf("Write-off on %s, %s: %s", f.InvoiceNumber, f.AccountID, strings.TrimSpace(f.Reason)),
		Lines: []domain.JournalLine{{AccountID: debit, Debit: f.Amount}, {AccountID: credit, Credit: f.Amount}}}, true, signerNamed(f.CreatedBy, "finance"))
	if err != nil {
		return err
	}
	return p.Repo.SaveRef(ctx, f.WriteOffID, RefManualJournal, m.ID)
}

// TaxSettingsChanged keeps finance's copy of billing's tax settings.
func (p Policies) TaxSettingsChanged(ctx context.Context, e billing.TaxSettingsChanged) error {
	var t domain.TaxSettings
	if err := json.Unmarshal(e.Settings, &t); err != nil || t.Rates == nil {
		return err
	}
	if t.Regencies == nil {
		t.Regencies = map[string]string{}
	}
	return p.Repo.SaveSetting(ctx, KeyTax, t)
}

// TransactionCodeSaved keeps finance's copy of a transaction code: the revenue account a guest
// revenue category books to from then on.
func (p Policies) TransactionCodeSaved(ctx context.Context, e billing.TransactionCodeSaved) error {
	var c domain.TransactionCode
	if err := json.Unmarshal(e.Code, &c); err != nil || c.ID == "" {
		return err
	}
	return p.Repo.SaveCode(ctx, c)
}

// ShiftClosed takes a counted drawer to the books through the cash count, the difference as an
// adjustment for approval.
func (p Policies) ShiftClosed(ctx context.Context, e billing.ShiftClosed) error {
	if ok, err := p.seen(ctx, "shift:"+e.ShiftID); err != nil || ok {
		return err
	}
	a, err := p.Repo.Account(ctx, e.AccountID, false)
	if err != nil {
		return nil
	}
	var shift struct {
		CashierName string `json:"cashierName"`
	}
	_ = json.Unmarshal(e.Shift, &shift)
	date := e.Date
	if date == "" {
		date = p.today()
	}
	r, err := p.recordCount(ctx, a, Count{Date: date, Expected: e.Expected, Counted: e.Counted, Note: e.Note, Adjust: true, By: shift.CashierName, ShiftID: e.ShiftID},
		signerNamed(shift.CashierName, "reservation"))
	if err != nil {
		return err
	}
	return p.Repo.SaveRef(ctx, "shift:"+e.ShiftID, RefReconciliation, r.ID)
}

// ShiftDropped takes cash out of a counted drawer through the transfer path, off every shift.
func (p Policies) ShiftDropped(ctx context.Context, e billing.ShiftDropped) error {
	if ok, err := p.seen(ctx, "drop:"+e.ShiftID); err != nil || ok {
		return err
	}
	date := e.Date
	if date == "" {
		date = p.today()
	}
	out, err := p.transferCash(ctx, domain.TransferInput{FromAccountID: e.FromAccountID, ToAccountID: e.ToAccountID, Amount: float64(e.Amount), Date: date,
		Description: e.Description, Reference: e.Reference}, System, true)
	if err != nil {
		return nil
	}
	return p.Repo.SaveRef(ctx, "drop:"+e.ShiftID, RefTransaction, out.ID)
}

// shiftCash is the cash in and out the entries stamped with a shift moved through its cashbox.
func shiftCash(txs []domain.Transaction, shiftID, accountID string) (in, out int64) {
	for _, t := range txs {
		if t.Shift() != shiftID || t.AccountID != accountID || !domain.InDrawer(t.Status) {
			continue
		}
		if t.Kind == domain.CashIn {
			in += t.Amount
		} else {
			out += t.Amount
		}
	}
	return in, out
}

// ShiftCash answers billing: the cash in and out finance holds on a shift's cashbox.
func (d Deps) ShiftCash(ctx context.Context, shiftID, accountID string) (int64, int64, error) {
	txs, err := d.Repo.Transactions(ctx)
	in, out := shiftCash(txs, shiftID, accountID)
	return in, out, err
}

// seen reports a fact already booked.
// receipts resolves the files billing attached to a payment or refund, as bookMoney carries them
// onto the cash entry. A file the files context no longer has, or a process without files, leaves
// the entry without receipts rather than holding the event back.
func (d Deps) receipts(ctx context.Context, ids []string) ([]domain.Attachment, error) {
	if len(ids) == 0 {
		return []domain.Attachment{}, nil
	}
	list, err := d.Files.Attachments(ctx, ids)
	if errs.HasCode(err, errs.CodeNotFound) || errs.HasCode(err, "NOT_AVAILABLE") {
		return []domain.Attachment{}, nil
	}
	return list, err
}

func (d Deps) seen(ctx context.Context, ref string) (bool, error) {
	_, _, ok, err := d.Repo.Ref(ctx, ref)
	return ok, err
}

// Ref kinds.
const (
	RefTransaction    = "transaction"
	RefJournal        = "journal"
	RefManualJournal  = "manual_journal"
	RefReconciliation = "reconciliation"
)

// ApprovalStatus answers billing and owners: where the record finance made from the fact named ref
// stands. A fact finance has not booked yet reads as submitted.
func (d Deps) ApprovalStatus(ctx context.Context, ref string) (string, error) {
	kind, id, ok, err := d.Repo.Ref(ctx, ref)
	if err != nil || !ok {
		return domain.Submitted, err
	}
	switch kind {
	case RefTransaction:
		t, err := d.Repo.Transaction(ctx, id)
		return t.Status, err
	case RefManualJournal:
		m, err := d.Repo.ManualJournal(ctx, id)
		return m.Status, err
	}
	return domain.Posted, nil
}
