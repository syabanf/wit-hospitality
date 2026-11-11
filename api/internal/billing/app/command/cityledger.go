package command

import (
	"context"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func rp(v int64) string { return "Rp " + domain.Rupiah(v) }

// settlement reads what settles the invoices, with the status finance gives each entry.
func (d Deps) settlement(ctx context.Context) (domain.Settlement, error) {
	pays, err := docs[domain.LedgerPayment](d.Store.All(ctx, LedgerPayments))
	if err != nil {
		return domain.Settlement{}, err
	}
	offs, err := docs[domain.WriteOff](d.Store.All(ctx, WriteOffs))
	if err != nil {
		return domain.Settlement{}, err
	}
	status := map[string]string{}
	refs := make([]string, 0, len(pays)+len(offs))
	for _, p := range pays {
		refs = append(refs, p.Ref())
	}
	for _, w := range offs {
		refs = append(refs, w.Ref())
	}
	for _, ref := range refs {
		if status[ref], err = d.Finance.ApprovalStatus(ctx, ref); err != nil {
			return domain.Settlement{}, err
		}
	}
	return domain.Settlement{Payments: pays, WriteOffs: offs, Status: func(ref string) string { return status[ref] }}, nil
}

func (d Deps) transfers(ctx context.Context) ([]domain.Posting, error) {
	all, err := docs[domain.Posting](d.Store.All(ctx, Postings))
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, p := range all {
		if p.Kind == domain.KindTransfer {
			out = append(out, p)
		}
	}
	return out, nil
}

func (d Deps) invoices(ctx context.Context, accountID string) ([]domain.Invoice, error) {
	if accountID == "" {
		return docs[domain.Invoice](d.Store.All(ctx, Invoices))
	}
	return docs[domain.Invoice](d.Store.ByRef(ctx, Invoices, accountID))
}

// billedTo is who pays a stay: its own billing, else its group's.
func (d Deps) billedTo(ctx context.Context, b domain.Booking) (*domain.Billing, error) {
	raw := b.CityLedger
	if len(raw) == 0 || string(raw) == "null" {
		g, err := d.group(ctx, b.BookingGroupID)
		if err != nil || g == nil {
			return nil, err
		}
		raw = g.CityLedger
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	v, err := decode[domain.Billing](raw)
	return &v, err
}

func (d Deps) transferred(ctx context.Context, b domain.Booking) (int64, error) {
	postings, err := d.postings(ctx, b.ID)
	var s int64
	for _, p := range postings {
		if p.Kind == domain.KindTransfer {
			s += p.Amount
		}
	}
	return s, err
}

// toCome is what a stay still brings to its account: its total less what moved over.
func (d Deps) toCome(ctx context.Context, b domain.Booking) (int64, error) {
	total, err := d.stayTotal(ctx, b)
	if err != nil {
		return 0, err
	}
	moved, err := d.transferred(ctx, b)
	return max(0, total-moved), err
}

// creditUsed is the account's balance and the live stays billed to it, except some.
func (d Deps) creditUsed(ctx context.Context, accountID string, except []string) (int64, error) {
	raws, err := d.Store.Stays(ctx, "")
	if err != nil {
		return 0, err
	}
	var coming int64
	for _, raw := range raws {
		b, err := d.stayOf(ctx, raw)
		if err != nil {
			return 0, err
		}
		if !domain.LiveStay(b.Status) || slices.Contains(except, b.ID) {
			continue
		}
		v, err := d.billedTo(ctx, b)
		if err != nil {
			return 0, err
		}
		if v == nil || v.AccountID != accountID {
			continue
		}
		c, err := d.toCome(ctx, b)
		if err != nil {
			return 0, err
		}
		coming += c
	}
	src, err := d.settlement(ctx)
	if err != nil {
		return 0, err
	}
	transfers, err := d.transfers(ctx)
	if err != nil {
		return 0, err
	}
	invoices, err := d.invoices(ctx, accountID)
	if err != nil {
		return 0, err
	}
	return src.AccountBalance(accountID, transfers, invoices) + coming, nil
}

// billing is the mock's city ledger billing: the account open for the stays' villas, and within its
// credit unless someone allowed overrides with a reason. Staying on the account kept skips the check.
func (d Deps) billing(ctx context.Context, p auth.Principal, in *domain.BillingInput, stays []domain.Booking, source string, kept *domain.Billing) (*domain.Billing, error) {
	if in == nil || in.AccountID == "" {
		return nil, nil
	}
	if source != domain.Direct {
		return nil, errs.New("CITY_LEDGER_CHANNEL", "Only a direct stay bills a company or agent; Airbnb collects its own stays.")
	}
	a, err := get[domain.Account](ctx, d, Accounts, in.AccountID, "city ledger account")
	if err != nil {
		return nil, err
	}
	for _, b := range stays {
		pl, err := d.Store.Place(ctx, b.UnitID)
		if err != nil {
			return nil, err
		}
		if err := domain.AssertBookable(a, pl.VillaID, pl.VillaName); err != nil {
			return nil, err
		}
	}
	if kept != nil && kept.AccountID == a.ID && strings.TrimSpace(in.OverrideReason) == "" {
		return &domain.Billing{AccountID: a.ID, Instruction: in.Instruction, Override: kept.Override}, nil
	}
	may, err := d.mayOverrideCredit(ctx, p)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(stays))
	codes := make([]string, len(stays))
	var adding int64
	for i, b := range stays {
		ids[i], codes[i] = b.ID, b.Code
		c, err := d.toCome(ctx, b)
		if err != nil {
			return nil, err
		}
		adding += c
	}
	used, err := d.creditUsed(ctx, a.ID, ids)
	if err != nil {
		return nil, err
	}
	override, err := domain.CreditCheck(a, used, adding, may, in.OverrideReason, p.Name)
	if err != nil {
		return nil, err
	}
	if override != nil {
		if err := d.record(ctx, p, audit.Line{Action: audit.Update, Entity: "city-ledger-account", EntityID: a.Code,
			Summary: fmt.Sprintf("Booked past the credit limit of %s %s: %s", a.Code, a.Name, override.Reason),
			After:   map[string]any{"stays": strings.Join(codes, ", ")}}); err != nil {
			return nil, err
		}
	}
	return &domain.Billing{AccountID: a.ID, Instruction: in.Instruction, Override: override}, nil
}

func (d Deps) describe(ctx context.Context, v *domain.Billing) (string, map[string]any, error) {
	if v == nil {
		return "the guest", map[string]any{"account": nil}, nil
	}
	a, err := get[domain.Account](ctx, d, Accounts, v.AccountID, "city ledger account")
	if err != nil {
		return "", nil, err
	}
	var reason any
	if v.Override != nil {
		reason = v.Override.Reason
	}
	return fmt.Sprintf("%s %s, %s", a.Code, a.Name, strings.ToLower(domain.InstructionLabel[v.Instruction])),
		map[string]any{"account": a.Code, "instruction": v.Instruction, "override": reason}, nil
}

// SaveAccount opens or edits a company or agent account: finance/create or finance/edit.
type SaveAccount struct{ Deps }

// Handle saves the account; id is empty for a new one.
func (h SaveAccount) Handle(ctx context.Context, p auth.Principal, id string, in domain.AccountInput) (domain.Account, error) {
	need := financeCreate
	if id != "" {
		need = financeEdit
	}
	if err := h.Authz.Require(ctx, p.Role, need...); err != nil {
		return domain.Account{}, err
	}
	var out domain.Account
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		accounts, err := docs[domain.Account](h.Store.All(ctx, Accounts))
		if err != nil {
			return err
		}
		if err := domain.ValidateAccount(in, accounts, id); err != nil {
			return err
		}
		villas := slices.Clone(in.VillaIDs)
		if villas == nil {
			villas = []string{}
		}
		fields := domain.Account{Name: strings.TrimSpace(in.Name), Kind: in.Kind, Contact: strings.TrimSpace(in.Contact), BillingEmail: strings.TrimSpace(in.BillingEmail),
			Phone: strings.TrimSpace(in.Phone), Address: strings.TrimSpace(in.Address), NPWP: strings.TrimSpace(in.NPWP), CreditLimit: int64(in.CreditLimit),
			TermsDays: int(in.TermsDays), CommissionPct: in.CommissionPct, Active: in.Active, VillaIDs: villas}
		line := audit.Line{Action: audit.Create, Entity: "city-ledger-account"}
		if id != "" {
			a, err := get[domain.Account](ctx, h.Deps, Accounts, id, "city ledger account")
			if err != nil {
				return err
			}
			line.Action, line.Before = audit.Update, map[string]any{"creditLimit": a.CreditLimit, "termsDays": a.TermsDays, "active": a.Active}
			fields.ID, fields.Code, fields.CreatedOn = a.ID, a.Code, a.CreatedOn
			line.Summary = fmt.Sprintf("Edited city ledger account %s %s", a.Code, fields.Name)
			line.After = map[string]any{"creditLimit": fields.CreditLimit, "termsDays": fields.TermsDays, "active": fields.Active}
		} else {
			n, err := h.Store.Next(ctx, "entity")
			if err != nil {
				return err
			}
			fields.ID, fields.Code, fields.CreatedOn = fmt.Sprintf("cl-%d", n), fmt.Sprintf("CL-%03d", len(accounts)+1), h.today()
			line.Summary = fmt.Sprintf("Opened city ledger account %s %s", fields.Code, fields.Name)
			line.After = map[string]any{"creditLimit": fields.CreditLimit, "termsDays": fields.TermsDays}
		}
		line.EntityID = fields.Code
		if err := h.Store.Put(ctx, Accounts, Row{ID: fields.ID, Doc: fields}); err != nil {
			return err
		}
		out = fields
		return h.record(ctx, p, line)
	})
	return out, err
}

// BillingBody is { cityLedger } as the console sends it; null makes the guest pay again.
type BillingBody struct {
	CityLedger *domain.BillingInput `json:"cityLedger"`
}

func checkBillingInput(in *domain.BillingInput) error {
	if in == nil {
		return nil
	}
	var f errs.Fields
	if in.AccountID == "" {
		f.Add("accountId", "Pick the account the bill goes to.")
	}
	if !slices.Contains(domain.BillingInstructions, in.Instruction) {
		f.Add("instruction", "Pick what the account pays.")
	}
	return f.Err()
}

// SetBilling sets, changes or removes who pays a booking or a group; transfers already posted stay
// where they are. Reservation keeps the billing on the record from stay_billing.set. It needs
// booking/edit.
type SetBilling struct{ Deps }

// Booking is PUT /bookings/{id}/city-ledger-billing.
func (h SetBilling) Booking(ctx context.Context, p auth.Principal, bookingID string, in BillingBody) (*domain.Billing, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return nil, err
	}
	if err := checkBillingInput(in.CityLedger); err != nil {
		return nil, err
	}
	var next *domain.Billing
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		b, _, err := h.stayInScope(ctx, p, bookingID)
		if err != nil {
			return err
		}
		if !domain.LiveStay(b.Status) {
			return errs.Newf("BOOKING_INVALID_STATE", "%s is %s; change who pays only before check-out.", b.Code, strings.Replace(b.Status, "_", " ", 1))
		}
		var before *domain.Billing
		if len(b.CityLedger) > 0 && string(b.CityLedger) != "null" {
			v, err := decode[domain.Billing](b.CityLedger)
			if err != nil {
				return err
			}
			before = &v
		}
		if next, err = h.billing(ctx, p, in.CityLedger, []domain.Booking{b}, b.Source, before); err != nil {
			return err
		}
		if err := h.emit(ctx, billing.EventStayBillingSet, "booking", b.ID, billing.StayBillingSet{BookingID: b.ID, Billing: mustJSON(next)}); err != nil {
			return err
		}
		return h.billingAudit(ctx, p, "booking", b.Code, before, next)
	})
	return next, err
}

func (d Deps) billingAudit(ctx context.Context, p auth.Principal, entity, code string, before, next *domain.Billing) error {
	was, wasDesc, err := d.describe(ctx, before)
	if err != nil {
		return err
	}
	now, nowDesc, err := d.describe(ctx, next)
	if err != nil {
		return err
	}
	return d.record(ctx, p, audit.Line{Action: audit.Update, Entity: entity, EntityID: code, Summary: fmt.Sprintf("Billed %s to %s, before %s", code, now, was),
		Before: wasDesc, After: nowDesc})
}

// Group is PUT /booking-groups/{id}/city-ledger-billing: a stay billed on its own keeps its account.
func (h SetBilling) Group(ctx context.Context, p auth.Principal, groupID string, in BillingBody) (*domain.Billing, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return nil, err
	}
	if err := checkBillingInput(in.CityLedger); err != nil {
		return nil, err
	}
	var next *domain.Billing
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		g, err := h.group(ctx, groupID)
		if err != nil {
			return err
		}
		if g == nil {
			return errs.NotFound("group", groupID)
		}
		stays, err := h.groupStays(ctx, g.ID)
		if err != nil {
			return err
		}
		var live, own []domain.Booking
		for _, b := range stays {
			if domain.LiveStay(b.Status) {
				live = append(live, b)
				if len(b.CityLedger) == 0 || string(b.CityLedger) == "null" {
					own = append(own, b)
				}
			}
		}
		if len(live) == 0 {
			return errs.Newf("BOOKING_INVALID_STATE", "Every stay of %s has checked out or gone; change who pays only before check-out.", g.Code)
		}
		var before *domain.Billing
		if len(g.CityLedger) > 0 && string(g.CityLedger) != "null" {
			v, err := decode[domain.Billing](g.CityLedger)
			if err != nil {
				return err
			}
			before = &v
		}
		if next, err = h.billing(ctx, p, in.CityLedger, own, domain.Direct, before); err != nil {
			return err
		}
		if err := h.emit(ctx, billing.EventStayBillingSet, "booking_group", g.ID, billing.StayBillingSet{GroupID: g.ID, Billing: mustJSON(next)}); err != nil {
			return err
		}
		return h.billingAudit(ctx, p, "booking-group", g.Code, before, next)
	})
	return next, err
}

// TransferInput is what the console sends for a transfer.
type TransferInput struct {
	AccountID   string `json:"accountId"`
	Instruction string `json:"instruction"`
}

// Transfer moves a stay's bill, or the part its instruction covers, to an account. It needs
// booking/edit.
type Transfer struct{ Deps }

func (d Deps) transferable(ctx context.Context, b domain.Booking, pl Place, a domain.Account) error {
	if b.Source != domain.Direct {
		return errs.Newf("CITY_LEDGER_CHANNEL", "%s came through Airbnb, which collects the stay; only a direct stay moves to the city ledger.", b.Code)
	}
	link, err := d.pendingSettle(ctx, b.ID)
	if err != nil {
		return err
	}
	if link != nil {
		return errs.Newf("SETTLEMENT_PENDING", "%s has a check-out link waiting for the guest; cancel it before moving the bill.", b.Code)
	}
	return domain.AssertBookable(a, pl.VillaID, pl.VillaName)
}

// post saves each part as a transfer posting and publishes the transfer.
func (d Deps) postTransfer(ctx context.Context, p auth.Principal, b domain.Booking, pl Place, a domain.Account, instruction string, parts []domain.TransferPart) ([]domain.Posting, error) {
	var out []domain.Posting
	fact := billing.CityLedgerTransferred{Where: billing.Where{BookingID: b.ID, VillaID: pl.VillaID, LocationID: pl.LocationID, Date: d.today()},
		AccountID: a.ID, AccountCode: a.Code, BookingCode: b.Code, Instruction: instruction, Code: domain.CityLedgerCode}
	for _, part := range parts {
		posting, err := d.newPosting(ctx, p, b, domain.Posting{Kind: domain.KindTransfer, Code: domain.CityLedgerCode, Description: fmt.Sprintf("Transfer to city ledger %s %s", a.Code, a.Name),
			Amount: part.Amount, Part: part.Part, OrderID: part.OrderID, CityLedger: &domain.PostingCityLedger{AccountID: a.ID, Instruction: instruction, Service: part.Service, PB1: part.PB1}})
		if err != nil {
			return nil, err
		}
		if err := d.addPosting(ctx, b, pl, posting); err != nil {
			return nil, err
		}
		out = append(out, posting)
		fact.Parts = append(fact.Parts, billing.TransferredPart{PostingID: posting.ID, Part: part.Part, OrderID: part.OrderID, Amount: part.Amount, Service: part.Service, PB1: part.PB1})
		fact.Total += part.Amount
	}
	paid, status, err := d.summary(ctx, b)
	if err != nil {
		return nil, err
	}
	fact.Stay = billing.StayPaid{PaidAmount: paid, PaymentStatus: status}
	return out, d.emit(ctx, billing.EventCityLedgerTransferred, "booking", b.ID, fact)
}

// Handle transfers the stay's bill.
func (h Transfer) Handle(ctx context.Context, p auth.Principal, bookingID string, in TransferInput) ([]domain.Posting, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return nil, err
	}
	if in.AccountID == "" {
		return nil, errs.Invalid("accountId", "Pick the account the bill goes to.")
	}
	var out []domain.Posting
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		b, pl, err := h.stayInScope(ctx, p, bookingID)
		if err != nil {
			return err
		}
		if b.Status != domain.CheckedIn {
			return errs.Newf("BOOKING_INVALID_STATE", "%s is not in house; transfer the bill during the stay or at check-out.", b.Code)
		}
		a, err := get[domain.Account](ctx, h.Deps, Accounts, in.AccountID, "city ledger account")
		if err != nil {
			return err
		}
		if err := h.transferable(ctx, b, pl, a); err != nil {
			return err
		}
		// Orders waiting on a payment link stay with the guest until the link is paid or cancelled.
		waiting, _, err := h.unpaidOrders(ctx, b, "pending")
		if err != nil {
			return err
		}
		skip := map[string]bool{}
		for _, o := range waiting {
			skip[o.ID] = true
		}
		f, err := h.folio(ctx, b, false)
		if err != nil {
			return err
		}
		orders, err := h.orders(ctx, b.ID)
		if err != nil {
			return err
		}
		parts := domain.TransferParts(f, orders, in.Instruction, skip)
		total := domain.PartsTotal(parts)
		label := strings.ToLower(domain.InstructionLabel[in.Instruction])
		if total <= 0 {
			return errs.Newf("CITY_LEDGER_NOTHING", "%s has nothing %s to transfer.", b.Code, label)
		}
		if out, err = h.postTransfer(ctx, p, b, pl, a, in.Instruction, parts); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "city-ledger", EntityID: a.Code,
			Summary: fmt.Sprintf("Transferred %s of %s to %s %s, %s", rp(total), b.Code, a.Code, a.Name, label),
			After:   map[string]any{"amount": total, "bookingId": b.Code}})
	})
	return out, err
}

// TransferGroup moves the room of a master-billed group's stays to an account. It needs booking/edit.
type TransferGroup struct{ Deps }

// Handle transfers the master folio.
func (h TransferGroup) Handle(ctx context.Context, p auth.Principal, groupID, accountID string) ([]domain.Posting, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return nil, err
	}
	if accountID == "" {
		return nil, errs.Invalid("accountId", "Pick the account the bill goes to.")
	}
	out := []domain.Posting{}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		g, err := h.group(ctx, groupID)
		if err != nil {
			return err
		}
		if g == nil {
			return errs.NotFound("group", groupID)
		}
		if g.Billing != "master" {
			return errs.Newf("GROUP_NOT_MASTER", "%s bills each stay on its own; transfer each stay from its folio.", g.Code)
		}
		a, err := get[domain.Account](ctx, h.Deps, Accounts, accountID, "city ledger account")
		if err != nil {
			return err
		}
		stays, err := h.groupStays(ctx, g.ID)
		if err != nil {
			return err
		}
		var total int64
		for _, b := range stays {
			if b.Status != domain.CheckedIn && b.Status != domain.CheckedOut {
				continue
			}
			pl, err := h.Store.Place(ctx, b.UnitID)
			if err != nil {
				return err
			}
			f, err := h.folio(ctx, b, true)
			if err != nil {
				return err
			}
			parts := domain.TransferParts(f, nil, "room", nil)
			if domain.PartsTotal(parts) <= 0 {
				continue
			}
			if err := h.transferable(ctx, b, pl, a); err != nil {
				return err
			}
			posted, err := h.postTransfer(ctx, p, b, pl, a, "room", parts)
			if err != nil {
				return err
			}
			out = append(out, posted...)
			total += domain.PartsTotal(parts)
		}
		if total <= 0 {
			return errs.Newf("CITY_LEDGER_NOTHING", "The master folio of %s has nothing to transfer.", g.Code)
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "city-ledger", EntityID: a.Code,
			Summary: fmt.Sprintf("Transferred the master folio of %s to %s %s: %s", g.Code, a.Code, a.Name, rp(total)),
			After:   map[string]any{"amount": total, "group": g.Code}})
	})
	return out, err
}

// IssueInvoice invoices an account's open transfers up to a date, the agent's commission off. It
// needs finance/create.
type IssueInvoice struct{ Deps }

// Handle issues the invoice.
func (h IssueInvoice) Handle(ctx context.Context, p auth.Principal, accountID, through string) (domain.Invoice, error) {
	if err := h.Authz.Require(ctx, p.Role, financeCreate...); err != nil {
		return domain.Invoice{}, err
	}
	if !isoDay(through) {
		return domain.Invoice{}, errs.Invalid("through", "Pick the last transfer date to include.")
	}
	var inv domain.Invoice
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		a, err := get[domain.Account](ctx, h.Deps, Accounts, accountID, "city ledger account")
		if err != nil {
			return err
		}
		if through > h.today() {
			return errs.New(errs.CodeValidation, "Invoice transfers up to today at the latest.")
		}
		transfers, err := h.transfers(ctx)
		if err != nil {
			return err
		}
		all, err := h.invoices(ctx, "")
		if err != nil {
			return err
		}
		var open []domain.Posting
		for _, t := range domain.OpenTransfers(a.ID, transfers, all) {
			if t.Date <= through {
				open = append(open, t)
			}
		}
		if len(open) == 0 {
			return errs.Newf("CITY_LEDGER_NOTHING", "%s has no transfer up to %s left to invoice.", a.Name, through)
		}
		var lines []domain.InvoiceLine
		for _, t := range open {
			i := slices.IndexFunc(lines, func(l domain.InvoiceLine) bool { return l.BookingID == t.BookingID })
			if i < 0 {
				b, pl, err := h.placeOfStay(ctx, t.BookingID)
				if err != nil {
					return err
				}
				lines = append(lines, domain.InvoiceLine{PostingIDs: []string{}, BookingID: b.ID, Code: b.Code, Guest: h.guestName(ctx, b.GuestID), Villa: pl.VillaName,
					CheckIn: b.CheckIn, CheckOut: b.CheckOut, Covers: t.CityLedger.Instruction})
				i = len(lines) - 1
			}
			l := &lines[i]
			l.PostingIDs = append(l.PostingIDs, t.ID)
			l.Gross += t.Amount
			l.Service += t.CityLedger.Service
			l.PB1 += t.CityLedger.PB1
		}
		issued := h.today()
		if err := h.Finance.AssertOpen(ctx, issued); err != nil {
			return err
		}
		n, err := h.Store.Next(ctx, "clInvoice")
		if err != nil {
			return err
		}
		inv = domain.Invoice{ID: fmt.Sprintf("cli-%d", n), Number: domain.InvoiceNumber(issued, all), AccountID: a.ID, IssuedOn: issued,
			DueOn: domain.AddDays(issued, a.TermsDays), Lines: lines, IssuedBy: p.Name}
		inv.SetFigures(a.CommissionPct)
		if err := h.Store.Put(ctx, Invoices, Row{ID: inv.ID, Ref: a.ID, Doc: inv}); err != nil {
			return err
		}
		if err := h.emit(ctx, billing.EventCityLedgerInvoiceIssued, "city_ledger_invoice", inv.ID, billing.CityLedgerInvoiceIssued{
			Where: billing.Where{Date: issued}, InvoiceID: inv.ID, Number: inv.Number, AccountID: a.ID, Invoice: mustJSON(inv), Gross: inv.Gross, Service: inv.Service,
			PB1: inv.PB1, CommissionPct: inv.CommissionPct, Commission: inv.Commission, Net: inv.Net, CommissionAccount: domain.AccountAgentCommission,
			ReceivableAccount: domain.AccountCityLedger}); err != nil {
			return err
		}
		after := ""
		if inv.Commission > 0 {
			after = " after " + rp(inv.Commission) + " commission"
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "city-ledger-invoice", EntityID: inv.Number,
			Summary: fmt.Sprintf("Issued %s to %s: %s%s, due %s", inv.Number, a.Name, rp(inv.Net), after, inv.DueOn),
			After:   map[string]any{"gross": inv.Gross, "commission": inv.Commission, "net": inv.Net}})
	})
	return inv, err
}

func isoDay(s string) bool {
	if len(s) != 10 {
		return false
	}
	for i, c := range s {
		if (i == 4 || i == 7) != (c == '-') || (c != '-' && (c < '0' || c > '9')) {
			return false
		}
	}
	return true
}

// SendInvoice marks an invoice sent to the account's billing email. It needs finance/edit.
type SendInvoice struct{ Deps }

// Handle sends the invoice.
func (h SendInvoice) Handle(ctx context.Context, p auth.Principal, invoiceID string) (domain.Invoice, error) {
	if err := h.Authz.Require(ctx, p.Role, financeEdit...); err != nil {
		return domain.Invoice{}, err
	}
	var inv domain.Invoice
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if inv, err = get[domain.Invoice](ctx, h.Deps, Invoices, invoiceID, "invoice"); err != nil {
			return err
		}
		a, err := get[domain.Account](ctx, h.Deps, Accounts, inv.AccountID, "city ledger account")
		if err != nil {
			return err
		}
		inv.SentAt = ptr(h.stamp())
		if err := h.Store.Put(ctx, Invoices, Row{ID: inv.ID, Ref: a.ID, Doc: inv}); err != nil {
			return err
		}
		to := a.BillingEmail
		if to == "" {
			to = a.Name
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "city-ledger-invoice", EntityID: inv.Number, Summary: fmt.Sprintf("Emailed %s to %s", inv.Number, to)})
	})
	return inv, err
}

// RecordLedgerPayment books money an account sent, spread over its invoices oldest first unless
// the console picks them; what is not spread stays a credit. It needs finance/submit.
type RecordLedgerPayment struct{ Deps }

// Handle records the payment.
func (h RecordLedgerPayment) Handle(ctx context.Context, p auth.Principal, in domain.LedgerPaymentInput) (domain.LedgerPayment, error) {
	if err := h.Authz.Require(ctx, p.Role, financeSubmit...); err != nil {
		return domain.LedgerPayment{}, err
	}
	if err := domain.ValidateLedgerPayment(in); err != nil {
		return domain.LedgerPayment{}, err
	}
	var out domain.LedgerPayment
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		a, err := get[domain.Account](ctx, h.Deps, Accounts, in.AccountID, "city ledger account")
		if err != nil {
			return err
		}
		accounts, err := h.Finance.CashAccounts(ctx)
		if err != nil {
			return err
		}
		i := slices.IndexFunc(accounts, func(c CashAccount) bool { return c.ID == in.CashAccountID })
		if i < 0 {
			return errs.NotFound("cash account", in.CashAccountID)
		}
		box := accounts[i]
		if (in.Method == "cash") != (box.Kind == "cashbox") {
			msg := "A transfer lands in the bank."
			if in.Method == "cash" {
				msg = "Cash lands in a cashbox."
			}
			return errs.Invalid("cashAccountId", msg)
		}
		src, err := h.settlement(ctx)
		if err != nil {
			return err
		}
		invoices, err := h.invoices(ctx, a.ID)
		if err != nil {
			return err
		}
		open := src.Allocatable(invoices)
		amount := int64(in.Amount)
		var allocations []domain.Allocation
		if in.Allocations == nil {
			allocations = domain.OldestFirst(amount, open)
		} else {
			for _, x := range *in.Allocations {
				allocations = append(allocations, domain.Allocation{InvoiceID: x.InvoiceID, Amount: int64(x.Amount)})
			}
		}
		for _, x := range allocations {
			j := slices.IndexFunc(open, func(o domain.OpenInvoice) bool { return o.InvoiceID == x.InvoiceID })
			if j < 0 {
				return errs.Invalid("allocations", "Pick invoices of this account.")
			}
			if x.Amount > open[j].Open {
				number := x.InvoiceID
				for _, inv := range invoices {
					if inv.ID == x.InvoiceID {
						number = inv.Number
					}
				}
				return errs.Invalid("allocations", fmt.Sprintf("%s has only %s open.", number, rp(open[j].Open)))
			}
		}
		n, err := h.Store.Next(ctx, "clPayment")
		if err != nil {
			return err
		}
		out = domain.LedgerPayment{ID: fmt.Sprintf("clp-%d", n), Number: fmt.Sprintf("CLP-%04d", n), AccountID: a.ID, Date: h.today(), Method: in.Method, Amount: amount,
			Reference: strings.TrimSpace(in.Reference), Note: strings.TrimSpace(in.Note), Allocations: []domain.Allocation{}, CreatedBy: p.Name}
		for _, x := range allocations {
			if x.Amount > 0 {
				out.Allocations = append(out.Allocations, x)
			}
		}
		if err := h.Store.Put(ctx, LedgerPayments, Row{ID: out.ID, Ref: a.ID, Doc: out}); err != nil {
			return err
		}
		origin := "payment"
		if in.Method == "cash" {
			origin = "front_desk"
		}
		location := ""
		if box.LocationID != nil {
			location = *box.LocationID
		}
		if err := h.emit(ctx, billing.EventCityLedgerPaymentRecvd, "city_ledger_payment", out.ID, billing.CityLedgerPaymentReceived{
			Where: billing.Where{LocationID: location, Date: out.Date}, PaymentID: out.ID, Number: out.Number, AccountID: a.ID, Method: out.Method, CashAccountID: box.ID,
			Amount: out.Amount, Reference: out.Reference, Note: out.Note, Allocations: allocationsOf(out.Allocations), Unapplied: out.Unapplied(),
			CategoryID: "cat-city-ledger", Origin: origin, RecordedBy: p.Name}); err != nil {
			return err
		}
		credit := ""
		if out.Unapplied() > 0 {
			credit = fmt.Sprintf(", %s kept as credit", rp(out.Unapplied()))
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "city-ledger-payment", EntityID: out.Number,
			Summary: fmt.Sprintf("Recorded %s from %s: %s%s", out.Number, a.Name, rp(out.Amount), credit), After: map[string]any{"amount": out.Amount}})
	})
	return out, err
}

func allocationsOf(list []domain.Allocation) []billing.Allocation {
	out := make([]billing.Allocation, len(list))
	for i, a := range list {
		out[i] = billing.Allocation(a)
	}
	return out
}

// ApplyCredit spreads what an account's payments have not spread over its open invoices. It needs
// finance/edit.
type ApplyCredit struct{ Deps }

// Handle spreads the credit.
func (h ApplyCredit) Handle(ctx context.Context, p auth.Principal, accountID string) ([]domain.LedgerPayment, error) {
	if err := h.Authz.Require(ctx, p.Role, financeEdit...); err != nil {
		return nil, err
	}
	var changed []domain.LedgerPayment
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		a, err := get[domain.Account](ctx, h.Deps, Accounts, accountID, "city ledger account")
		if err != nil {
			return err
		}
		invoices, err := h.invoices(ctx, a.ID)
		if err != nil {
			return err
		}
		src, err := h.settlement(ctx)
		if err != nil {
			return err
		}
		order := make([]int, 0, len(src.Payments))
		for i, x := range src.Payments {
			if x.AccountID == a.ID && src.PaymentLive(x) && x.Unapplied() > 0 {
				order = append(order, i)
			}
		}
		sort.SliceStable(order, func(i, j int) bool { return src.Payments[order[i]].Date < src.Payments[order[j]].Date })
		for _, i := range order {
			x := &src.Payments[i]
			add := domain.OldestFirst(x.Unapplied(), src.Allocatable(invoices))
			if len(add) == 0 {
				continue
			}
			x.Allocations = append(x.Allocations, add...)
			if err := h.Store.Put(ctx, LedgerPayments, Row{ID: x.ID, Ref: a.ID, Doc: *x}); err != nil {
				return err
			}
			changed = append(changed, *x)
		}
		if len(changed) == 0 {
			return errs.Newf("CITY_LEDGER_NOTHING", "%s has no credit to spread, or no invoice open.", a.Name)
		}
		numbers := make([]string, len(changed))
		for i, x := range changed {
			numbers[i] = x.Number
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "city-ledger-payment", EntityID: a.Code,
			Summary: fmt.Sprintf("Spread the credit of %s over its open invoices: %s", a.Name, strings.Join(numbers, ", "))})
	})
	return changed, err
}

// WriteOff puts a small open balance up for write-off; finance books it through a manual journal
// for approval. It needs finance/submit.
type WriteOff struct{ Deps }

// Handle asks for the write-off.
func (h WriteOff) Handle(ctx context.Context, p auth.Principal, in domain.WriteOffInput) (domain.WriteOff, error) {
	if err := h.Authz.Require(ctx, p.Role, financeSubmit...); err != nil {
		return domain.WriteOff{}, err
	}
	var out domain.WriteOff
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		a, err := get[domain.Account](ctx, h.Deps, Accounts, in.AccountID, "city ledger account")
		if err != nil {
			return err
		}
		inv, err := get[domain.Invoice](ctx, h.Deps, Invoices, in.InvoiceID, "invoice")
		if err != nil {
			return err
		}
		if inv.AccountID != a.ID {
			return errs.Newf(errs.CodeValidation, "%s is not on %s.", inv.Number, a.Name)
		}
		src, err := h.settlement(ctx)
		if err != nil {
			return err
		}
		open := src.Allocatable([]domain.Invoice{inv})[0].Open
		if err := domain.ValidateWriteOff(in, open); err != nil {
			return err
		}
		amount := int64(in.Amount)
		if err := domain.AssertWriteOffLimit(amount); err != nil {
			return err
		}
		if err := h.Finance.AssertOpen(ctx, h.today()); err != nil {
			return err
		}
		n, err := h.Store.Next(ctx, "clWriteOff")
		if err != nil {
			return err
		}
		out = domain.WriteOff{ID: fmt.Sprintf("clw-%d", n), Number: fmt.Sprintf("CLW-%04d", n), AccountID: a.ID, InvoiceID: ptr(inv.ID), Amount: amount,
			Reason: strings.TrimSpace(in.Reason), CreatedBy: p.Name, CreatedOn: h.today()}
		if err := h.Store.Put(ctx, WriteOffs, Row{ID: out.ID, Ref: a.ID, Doc: out}); err != nil {
			return err
		}
		if err := h.emit(ctx, billing.EventCityLedgerWrittenOff, "city_ledger_write_off", out.ID, billing.CityLedgerWrittenOff{
			Where: billing.Where{Date: out.CreatedOn}, WriteOffID: out.ID, Number: out.Number, AccountID: a.ID, InvoiceID: inv.ID, InvoiceNumber: inv.Number,
			Amount: amount, Reason: out.Reason, DebitAccount: domain.AccountBadDebt, CreditAccount: domain.AccountCityLedger, CreatedBy: p.Name}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "city-ledger-write-off", EntityID: out.Number,
			Summary: fmt.Sprintf("Asked to write off %s on %s: %s", rp(amount), inv.Number, out.Reason), After: map[string]any{"amount": amount}})
	})
	return out, err
}
