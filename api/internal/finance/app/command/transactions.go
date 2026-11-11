package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Entry is what newEntry needs besides the fields of the entry.
type Entry struct {
	Submit bool
	By     domain.Signer
	// Source is the record another context asked the entry for.
	Source *Source
	// Link is what the posting rules read about the entry later.
	Link *domain.EntryLink
}

// newEntry is the mock's newTransaction: files checked, proof asked on submit, the open shift on
// the cashbox stamped (a count's own adjustment stays off it), numbered, stored and audited.
func (d Deps) newEntry(ctx context.Context, t domain.Transaction, e Entry) (domain.Transaction, error) {
	if err := domain.AssertFiles(t.Attachments); err != nil {
		return t, err
	}
	if e.Submit {
		if err := d.assertProof(ctx, t); err != nil {
			return t, err
		}
	}
	if t.ShiftID == nil && t.Origin != "reconciliation" {
		shifts, err := d.Repo.Shifts(ctx, false)
		if err != nil {
			return t, err
		}
		if open := domain.OpenShiftOn(shifts, t.AccountID); open != nil {
			t.SetShift(open.ID)
		}
	}
	n, err := d.Repo.Next(ctx, "transaction")
	if err != nil {
		return t, err
	}
	on := d.today()
	if t.ID == "" {
		t.ID = fmt.Sprintf("tx-%d", n)
	}
	t.Number = fmt.Sprintf("TX-%d", 2400+n)
	t.Status = domain.Draft
	t.History = []domain.TransactionEvent{domain.Event("created", e.By, on, "")}
	if e.Submit {
		t.Status = domain.Submitted
		t.History = append(t.History, domain.Event("submitted", e.By, on, ""))
	}
	t.Approvals, t.RejectionReason, t.ReversalOf, t.ReversedBy = []domain.ApprovalGrant{}, nil, nil, nil
	t.CreatedBy, t.CreatedByID, t.CreatedOn = e.By.Name, e.By.ID, on
	if t.Attachments == nil {
		t.Attachments = []domain.Attachment{}
	}
	if err := d.Repo.InsertTransaction(ctx, &t, e.Source); err != nil {
		return t, err
	}
	if e.Link != nil {
		l := *e.Link
		l.TransactionID = t.ID
		if err := d.Repo.SaveLink(ctx, l); err != nil {
			return t, err
		}
	}
	verb := "Drafted"
	if e.Submit {
		verb = "Submitted"
	}
	return t, d.record(ctx, e.By, audit.Line{Action: audit.Create, Entity: "transaction", EntityID: t.Number,
		Summary: fmt.Sprintf("%s %s, %s", verb, t.Number, t.Description), After: map[string]any{"amount": t.Amount, "kind": t.Kind}})
}

// assertProof is the mock's assertProof: large hand-written cash-outs and every petty cash spend
// go for approval only with a receipt attached.
func (d Deps) assertProof(ctx context.Context, t domain.Transaction) error {
	policy, err := d.ProofPolicy(ctx)
	if err != nil {
		return err
	}
	a, err := d.Repo.Account(ctx, t.AccountID, false)
	petty := err == nil && a.Kind == domain.Petty
	if domain.NeedsProof(t.Kind, t.Amount, t.Origin, len(t.Attachments), policy, petty) {
		return domain.ProofRequired(policy, petty)
	}
	return nil
}

// entryOf is the entry as other contexts see it.
func entryOf(t domain.Transaction, src *Source) finance.Entry {
	return finance.Entry{TransactionID: t.ID, Number: t.Number, Status: t.Status, Kind: t.Kind, CategoryID: t.CategoryID, AccountID: t.AccountID, Amount: t.Amount,
		Date: t.Date, LocationID: t.LocationID, VillaID: t.VillaID, BookingID: t.BookingID, Reference: t.Reference, RejectionReason: t.RejectionReason,
		ReversalOf: t.ReversalOf, ReversedBy: t.ReversedBy, Source: src}
}

func (d Deps) entryEvent(ctx context.Context, eventType string, t domain.Transaction, by domain.Signer) error {
	src, err := d.Repo.SourceOf(ctx, t.ID)
	if err != nil {
		return err
	}
	return d.emit(ctx, eventType, "transaction", t.ID, t.Version, finance.EntryEvent{Entry: entryOf(t, src), By: by.Name, On: d.today()})
}

// visible loads the accounts and the scope and refuses an entry outside it.
func (d Deps) visible(ctx context.Context, p auth.Principal, t domain.Transaction) error {
	sc, err := d.scope(ctx, p)
	if err != nil {
		return err
	}
	accounts, err := d.Repo.Accounts(ctx)
	if err != nil {
		return err
	}
	byID := map[string]domain.CashAccount{}
	for _, a := range accounts {
		byID[a.ID] = a
	}
	if !sc.Transaction(t, byID) {
		return outside("entry")
	}
	return nil
}

// NewTransaction is POST /transactions: the cash entry form, drafted or submitted.
type NewTransaction struct {
	domain.TransactionInput
	Submit bool   `json:"submit"`
	Origin string `json:"origin"`
}

// CreateTransaction records a cash entry.
type CreateTransaction struct{ Deps }

// Handle needs finance/submit to submit, finance/create to draft; the account and location in scope.
func (h CreateTransaction) Handle(ctx context.Context, p auth.Principal, in NewTransaction) (domain.Transaction, error) {
	need := financeCreate
	if in.Submit {
		need = financeSubmit
	}
	if err := h.require(ctx, p, need); err != nil {
		return domain.Transaction{}, err
	}
	var out domain.Transaction
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		categories, err := h.Repo.Categories(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateTransaction(in.TransactionInput, categories); err != nil {
			return err
		}
		origin := in.Origin
		if origin == "" {
			origin = "manual"
		}
		if !slices.Contains(domain.Origins, origin) {
			return errs.Invalid("origin", "Pick where the entry comes from.")
		}
		t := domain.Transaction{AccountID: in.AccountID, Kind: in.Kind, CategoryID: in.CategoryID, Amount: int64(in.Amount), Date: in.Date, LocationID: in.LocationID,
			VillaID: in.VillaID, UnitID: in.UnitID, BookingID: in.BookingID, Description: strings.TrimSpace(in.Description), Reference: strings.TrimSpace(in.Reference),
			Attachments: slices.Clone(in.Attachments), Origin: origin}
		if _, err := h.Repo.Account(ctx, t.AccountID, false); err != nil {
			return err
		}
		if err := h.visible(ctx, p, t); err != nil {
			return err
		}
		out, err = h.newEntry(ctx, t, Entry{Submit: in.Submit, By: Signer(p)})
		return err
	})
	return out, err
}

// Transition is POST /transactions/{id}/{submit|approve|reject|post}.
type Transition struct{ Deps }

// Handle moves an entry along the chain; both halves of a transfer move together.
func (h Transition) Handle(ctx context.Context, p auth.Principal, id, to, note string) (domain.Transaction, error) {
	var need []rbac.Need
	switch to {
	case domain.Approved, domain.Rejected:
		need = approvalApprove
	case domain.Posted:
		need = financePost
	case domain.Submitted:
		need = financeSubmit
	}
	if err := h.require(ctx, p, need); err != nil {
		return domain.Transaction{}, err
	}
	var out domain.Transaction
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if to == domain.Posted {
			if err := h.Repo.LockPeriods(ctx); err != nil {
				return err
			}
		}
		t, err := h.Repo.Transaction(ctx, id)
		if err != nil {
			return err
		}
		if err := h.visible(ctx, p, t); err != nil {
			return err
		}
		out, err = h.move(ctx, t, to, note, Signer(p))
		return err
	})
	return out, err
}

// move applies one step of the chain as by, syncs the transfer's other half, writes the journal on
// posting, and appends the audit line and the entry events.
func (d Deps) move(ctx context.Context, t domain.Transaction, to, note string, by domain.Signer) (domain.Transaction, error) {
	if !domain.CanTransition(t.Status, to) {
		if t.Status == domain.Posted || t.Status == domain.Reversed {
			return t, errs.Newf("TRANSACTION_ALREADY_POSTED", "%s is %s; reverse it instead of editing it.", t.Number, t.Status)
		}
		return t, errs.Newf("TRANSACTION_INVALID_STATE", "A %s entry cannot become %s.", t.Status, to)
	}
	before := t.Status
	on := d.today()
	a := domain.Approvable{Number: t.Number, Status: &t.Status, Approvals: &t.Approvals, History: &t.History, RejectionReason: &t.RejectionReason, CreatedByID: t.CreatedByID, Noun: "entry"}
	switch to {
	case domain.Submitted:
		if l, err := d.Repo.Link(ctx, t.ID); err != nil {
			return t, err
		} else if l != nil && l.Cancelled {
			return t, errs.Newf("TRANSACTION_INVALID_STATE", "The stock receipt behind %s was cancelled, so %s stays rejected. Receive the stock again instead.", t.Number, t.Number)
		}
		if err := d.assertProof(ctx, t); err != nil {
			return t, err
		}
		a.Submit(by, on, note)
	case domain.Approved:
		rules, err := d.Repo.Rules(ctx)
		if err != nil {
			return t, err
		}
		if err := a.Approve(domain.RequiredLevels(rules, t.Kind, t.Villa(), t.Amount), by, on, note); err != nil {
			return t, err
		}
	case domain.Rejected:
		if err := a.Reject(by, on, note); err != nil {
			return t, err
		}
	case domain.Posted:
		if err := d.assertOpen(ctx, t.Date); err != nil {
			return t, err
		}
		t.Status = domain.Posted
		t.History = append(t.History, domain.Event("posted", by, on, note))
	}
	if err := d.Repo.UpdateTransaction(ctx, &t); err != nil {
		return t, err
	}
	changed := []domain.Transaction{t}
	if t.TransferID != nil {
		halves, err := d.Repo.Transfer(ctx, *t.TransferID)
		if err != nil {
			return t, err
		}
		for _, twin := range halves {
			if twin.ID == t.ID {
				continue
			}
			twin.Status, twin.Approvals, twin.History, twin.RejectionReason = t.Status, slices.Clone(t.Approvals), slices.Clone(t.History), t.RejectionReason
			if err := d.Repo.UpdateTransaction(ctx, &twin); err != nil {
				return t, err
			}
			changed = append(changed, twin)
		}
	}
	if to == domain.Posted {
		if err := d.recordPosting(ctx, t, by); err != nil {
			return t, err
		}
	}
	action, verb := audit.Status, strings.ToUpper(to[:1])+to[1:]
	switch {
	case to == domain.Approved:
		action = audit.Approve
		if t.Status != domain.Approved {
			verb = "Signed"
		}
	case to == domain.Rejected:
		action = audit.Reject
	}
	if err := d.record(ctx, by, audit.Line{Action: action, Entity: "transaction", EntityID: t.Number, Summary: fmt.Sprintf("%s %s, %s", verb, t.Number, t.Description),
		Before: map[string]any{"status": before}, After: map[string]any{"status": t.Status}}); err != nil {
		return t, err
	}
	for _, x := range changed {
		if err := d.decided(ctx, x); err != nil {
			return t, err
		}
	}
	event := map[string]string{domain.Approved: finance.EventEntryApproved, domain.Rejected: finance.EventEntryRejected, domain.Posted: finance.EventEntryPosted}[t.Status]
	if event != "" && t.Status != before {
		for _, x := range changed {
			if err := d.entryEvent(ctx, event, x, by); err != nil {
				return t, err
			}
		}
	}
	return t, nil
}

// recordPosting writes the journal of a posted entry, once per source: a transfer writes once for
// both halves, a salary payment writes the payroll entry.
func (d Deps) recordPosting(ctx context.Context, t domain.Transaction, by domain.Signer) error {
	b, err := d.books(ctx, t)
	if err != nil {
		return err
	}
	draft, err := domain.JournalFor(t, b)
	if err != nil {
		return err
	}
	return d.writeOnce(ctx, draft, by)
}

// books gathers what JournalFor reads for one entry.
func (d Deps) books(ctx context.Context, t domain.Transaction) (domain.Books, error) {
	var b domain.Books
	var err error
	if b.Map, err = d.CategoryMap(ctx); err != nil {
		return b, err
	}
	if b.Categories, err = d.Repo.Categories(ctx); err != nil {
		return b, err
	}
	if b.Codes, err = d.Repo.Codes(ctx); err != nil {
		return b, err
	}
	if t.TransferID != nil {
		halves, err := d.Repo.Transfer(ctx, *t.TransferID)
		if err != nil {
			return b, err
		}
		for _, o := range halves {
			if o.ID != t.ID && domain.Counts(o.Status) {
				b.Twin = &o
			}
		}
	}
	if b.Payroll, err = d.Repo.Payroll(ctx, t.ID); err != nil {
		return b, err
	}
	if b.Self, err = d.Repo.Link(ctx, t.ID); err != nil {
		return b, err
	}
	if t.ReversalOf != nil {
		if b.Origin, err = d.Repo.Link(ctx, *t.ReversalOf); err != nil {
			return b, err
		}
	}
	ids := []string{t.Booking()}
	if b.Self != nil {
		for _, s := range b.Self.Shares {
			ids = append(ids, s.BookingID)
		}
	}
	b.Stays, err = d.Repo.Stays(ctx, ids)
	return b, err
}

// Reverse is POST /transactions/{id}/reverse.
type Reverse struct{ Deps }

// Handle needs finance/post; a posted entry gets a posted compensating entry dated today.
func (h Reverse) Handle(ctx context.Context, p auth.Principal, id, reason string) (domain.Transaction, error) {
	if err := h.require(ctx, p, financePost); err != nil {
		return domain.Transaction{}, err
	}
	reason = strings.TrimSpace(reason)
	if runes(reason) < 3 {
		return domain.Transaction{}, errs.Invalid("reason", "Say why the entry is reversed.")
	}
	var out domain.Transaction
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.LockPeriods(ctx); err != nil {
			return err
		}
		t, err := h.Repo.Transaction(ctx, id)
		if err != nil {
			return err
		}
		if err := h.visible(ctx, p, t); err != nil {
			return err
		}
		if t.Status != domain.Posted {
			return errs.Newf("TRANSACTION_INVALID_STATE", "Only posted entries can be reversed; %s is %s.", t.Number, t.Status)
		}
		if err := h.assertOpen(ctx, h.today()); err != nil {
			return err
		}
		n, err := h.Repo.Next(ctx, "transaction")
		if err != nil {
			return err
		}
		by, on := Signer(p), h.today()
		r := t
		r.ID, r.Number = fmt.Sprintf("tx-%d", n), fmt.Sprintf("TX-%d", 2400+n)
		r.Kind = domain.CashIn
		if t.Kind == domain.CashIn {
			r.Kind = domain.CashOut
		}
		r.Date, r.Description, r.Attachments, r.Origin, r.Status = on, fmt.Sprintf("Reversal of %s: %s", t.Number, reason), []domain.Attachment{}, "reversal", domain.Posted
		r.Approvals = []domain.ApprovalGrant{}
		r.History = []domain.TransactionEvent{domain.Event("created", by, on, reason), domain.Event("posted", by, on, "")}
		r.RejectionReason, r.TransferID, r.ReversalOf, r.ReversedBy = nil, nil, &t.ID, nil
		r.CreatedBy, r.CreatedByID, r.CreatedOn = by.Name, by.ID, on
		if err := h.Repo.InsertTransaction(ctx, &r, nil); err != nil {
			return err
		}
		t.Status, t.ReversedBy = domain.Reversed, &r.ID
		t.History = append(t.History, domain.Event("reversed", by, on, reason))
		if err := h.Repo.UpdateTransaction(ctx, &t); err != nil {
			return err
		}
		if err := h.recordPosting(ctx, r, by); err != nil {
			return err
		}
		if err := h.record(ctx, by, audit.Line{Action: audit.Status, Entity: "transaction", EntityID: t.Number, Summary: fmt.Sprintf("Reversed %s with %s: %s", t.Number, r.Number, reason),
			Before: map[string]any{"status": "posted"}, After: map[string]any{"status": "reversed"}}); err != nil {
			return err
		}
		if err := h.decided(ctx, t); err != nil {
			return err
		}
		if err := h.entryEvent(ctx, finance.EventEntryReversed, t, by); err != nil {
			return err
		}
		out = r
		return h.entryEvent(ctx, finance.EventEntryPosted, r, by)
	})
	return out, err
}

// transferCash is the mock's transferCash: two linked entries submitted together; it returns the
// cash-out half. keepOff stamps both halves off any open shift.
func (d Deps) transferCash(ctx context.Context, in domain.TransferInput, by domain.Signer, keepOff bool) (domain.Transaction, error) {
	accounts, err := d.Repo.Accounts(ctx)
	if err != nil {
		return domain.Transaction{}, err
	}
	if err := domain.ValidateTransfer(in, accounts); err != nil {
		return domain.Transaction{}, err
	}
	from, err := d.Repo.Account(ctx, in.FromAccountID, false)
	if err != nil {
		return domain.Transaction{}, err
	}
	to, err := d.Repo.Account(ctx, in.ToAccountID, false)
	if err != nil {
		return domain.Transaction{}, err
	}
	n, err := d.Repo.Next(ctx, "transfer")
	if err != nil {
		return domain.Transaction{}, err
	}
	location := from.Location()
	if location == "" {
		location = to.Location()
	}
	if location == "" {
		places, err := d.Repo.Places(ctx)
		if err != nil {
			return domain.Transaction{}, err
		}
		location = places.FirstLocation()
	}
	base := domain.Transaction{Amount: int64(in.Amount), Date: in.Date, LocationID: location, Description: strings.TrimSpace(in.Description), Reference: strings.TrimSpace(in.Reference),
		Attachments: []domain.Attachment{}, Origin: "transfer", TransferID: domain.Ptr(fmt.Sprintf("trf-%d", n))}
	if keepOff {
		base.SetShift("")
	}
	out := base
	out.AccountID, out.Kind, out.CategoryID = from.ID, domain.CashOut, "cat-transfer-out"
	if out, err = d.newEntry(ctx, out, Entry{Submit: true, By: by}); err != nil {
		return out, err
	}
	back := base
	back.AccountID, back.Kind, back.CategoryID = to.ID, domain.CashIn, "cat-transfer-in"
	_, err = d.newEntry(ctx, back, Entry{Submit: true, By: by})
	return out, err
}

// Transfer is POST /transactions/transfers.
type Transfer struct{ Deps }

// Handle needs finance/submit.
func (h Transfer) Handle(ctx context.Context, p auth.Principal, in domain.TransferInput) (domain.Transaction, error) {
	if err := h.require(ctx, p, financeSubmit); err != nil {
		return domain.Transaction{}, err
	}
	var out domain.Transaction
	err := h.DB.InTx(ctx, func(ctx context.Context) (err error) {
		out, err = h.transferCash(ctx, in, Signer(p), false)
		return err
	})
	return out, err
}

// Adjust is POST /transactions/adjustments: a balance correction through the approval chain.
type Adjust struct{ Deps }

// Handle needs finance/submit.
func (h Adjust) Handle(ctx context.Context, p auth.Principal, in domain.AdjustmentInput) (domain.Transaction, error) {
	if err := h.require(ctx, p, financeSubmit); err != nil {
		return domain.Transaction{}, err
	}
	var out domain.Transaction
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		accounts, err := h.Repo.Accounts(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateAdjustment(in, accounts); err != nil {
			return err
		}
		a, err := h.Repo.Account(ctx, in.AccountID, false)
		if err != nil {
			return err
		}
		kind, category := domain.CashOut, "cat-adjust-out"
		if in.Direction == "increase" {
			kind, category = domain.CashIn, "cat-adjust-in"
		}
		location, err := h.accountLocation(ctx, a)
		if err != nil {
			return err
		}
		out, err = h.newEntry(ctx, domain.Transaction{AccountID: a.ID, Kind: kind, CategoryID: category, Amount: int64(in.Amount), Date: in.Date, LocationID: location,
			Description: strings.TrimSpace(in.Reason), Attachments: []domain.Attachment{}, Origin: "adjustment"}, Entry{Submit: true, By: Signer(p)})
		return err
	})
	return out, err
}

// accountLocation is account.locationId ?? s.locations[0]?.id.
func (d Deps) accountLocation(ctx context.Context, a domain.CashAccount) (string, error) {
	if a.LocationID != nil {
		return *a.LocationID, nil
	}
	places, err := d.Repo.Places(ctx)
	return places.FirstLocation(), err
}

// Count is one cash count against what the account should hold.
type Count struct {
	Date     string
	Expected int64
	Counted  int64
	Note     string
	Adjust   bool
	By       string
	ShiftID  string
}

// recordCount is the mock's recordCount: the difference may go for approval as an adjustment.
func (d Deps) recordCount(ctx context.Context, a domain.CashAccount, c Count, signer domain.Signer) (domain.Reconciliation, error) {
	difference := c.Counted - c.Expected
	note := strings.TrimSpace(c.Note)
	r := domain.Reconciliation{AccountID: a.ID, Date: c.Date, Expected: c.Expected, Counted: c.Counted, Difference: difference, Note: note, By: c.By}
	if c.Adjust && difference != 0 {
		kind, category, dir := domain.CashOut, "cat-adjust-out", "short"
		if difference > 0 {
			kind, category, dir = domain.CashIn, "cat-adjust-in", "over"
		}
		description := fmt.Sprintf("Cash count %s on %s", dir, c.Date)
		if note != "" {
			description += ": " + note
		}
		location, err := d.accountLocation(ctx, a)
		if err != nil {
			return r, err
		}
		t, err := d.newEntry(ctx, domain.Transaction{AccountID: a.ID, Kind: kind, CategoryID: category, Amount: abs(difference), Date: c.Date, LocationID: location,
			Description: description, Attachments: []domain.Attachment{}, Origin: "reconciliation"}, Entry{Submit: true, By: signer})
		if err != nil {
			return r, err
		}
		r.AdjustmentID = &t.ID
	}
	n, err := d.Repo.Next(ctx, "reconciliation")
	if err != nil {
		return r, err
	}
	r.ID = fmt.Sprintf("rec-%d", n)
	if c.ShiftID != "" {
		r.ShiftID = &c.ShiftID
	}
	if err := d.Repo.InsertReconciliation(ctx, r); err != nil {
		return r, err
	}
	matched := "matched"
	if difference > 0 {
		matched = fmt.Sprintf("over by %d", difference)
	} else if difference < 0 {
		matched = fmt.Sprintf("short by %d", -difference)
	}
	return r, d.record(ctx, signer, audit.Line{Action: audit.Create, Entity: "reconciliation", EntityID: r.ID, Summary: fmt.Sprintf("Counted %s: %s", a.Name, matched)})
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

// Reconcile is POST /reconciliations.
type Reconcile struct{ Deps }

// Handle needs finance/submit; the expected cash is the book balance on the count date.
func (h Reconcile) Handle(ctx context.Context, p auth.Principal, in domain.ReconciliationInput) (domain.Reconciliation, error) {
	if err := h.require(ctx, p, financeSubmit); err != nil {
		return domain.Reconciliation{}, err
	}
	var out domain.Reconciliation
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		accounts, err := h.Repo.Accounts(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateReconciliation(in, accounts); err != nil {
			return err
		}
		a, err := h.Repo.Account(ctx, in.AccountID, true)
		if err != nil {
			return err
		}
		txs, err := h.Repo.Transactions(ctx)
		if err != nil {
			return err
		}
		out, err = h.recordCount(ctx, a, Count{Date: in.Date, Expected: domain.Balance(a, txs, in.Date), Counted: int64(in.Counted), Note: in.Note, Adjust: in.Adjust, By: p.Name}, Signer(p))
		return err
	})
	return out, err
}

// Attach is POST /transactions/{id}/attachments.
type Attach struct{ Deps }

// Handle needs finance/create; a posted or reversed entry keeps its receipts.
func (h Attach) Handle(ctx context.Context, p auth.Principal, id string, attachmentIDs []string) (domain.Transaction, error) {
	if err := h.require(ctx, p, financeCreate); err != nil {
		return domain.Transaction{}, err
	}
	var out domain.Transaction
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		t, err := h.lockedOpen(ctx, p, id)
		if err != nil {
			return err
		}
		files, err := h.Files.Attachments(ctx, attachmentIDs)
		if err != nil {
			return err
		}
		all := append(slices.Clone(t.Attachments), files...)
		if err := domain.AssertFiles(all); err != nil {
			return err
		}
		t.Attachments = all
		if err := h.Repo.UpdateTransaction(ctx, &t); err != nil {
			return err
		}
		names := make([]string, len(files))
		for i, f := range files {
			names[i] = f.Name
		}
		out = t
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Update, Entity: "transaction", EntityID: t.Number, Summary: fmt.Sprintf("Attached %s to %s", strings.Join(names, ", "), t.Number)})
	})
	return out, err
}

// lockedOpen loads an entry in scope whose receipts may still change.
func (d Deps) lockedOpen(ctx context.Context, p auth.Principal, id string) (domain.Transaction, error) {
	t, err := d.Repo.Transaction(ctx, id)
	if err != nil {
		return t, err
	}
	if err := d.visible(ctx, p, t); err != nil {
		return t, err
	}
	if t.Status == domain.Posted || t.Status == domain.Reversed {
		return t, errs.Newf("ATTACHMENT_LOCKED", "%s is %s; its receipts are final.", t.Number, t.Status)
	}
	return t, nil
}

// Detach is DELETE /transactions/{id}/attachments/{attachmentId}.
type Detach struct{ Deps }

// Handle needs finance/create.
func (h Detach) Handle(ctx context.Context, p auth.Principal, id, attachmentID string) (domain.Transaction, error) {
	if err := h.require(ctx, p, financeCreate); err != nil {
		return domain.Transaction{}, err
	}
	var out domain.Transaction
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		t, err := h.lockedOpen(ctx, p, id)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(t.Attachments, func(a domain.Attachment) bool { return a.ID == attachmentID })
		if i < 0 {
			return errs.NotFound("attachment", attachmentID)
		}
		name := t.Attachments[i].Name
		t.Attachments = slices.Delete(slices.Clone(t.Attachments), i, i+1)
		if err := h.Repo.UpdateTransaction(ctx, &t); err != nil {
			return err
		}
		out = t
		return h.record(ctx, Signer(p), audit.Line{Action: audit.Update, Entity: "transaction", EntityID: t.Number, Summary: fmt.Sprintf("Removed %s from %s", name, t.Number)})
	})
	return out, err
}

func runes(s string) int { return len([]rune(s)) }
