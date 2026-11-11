package command

import (
	"context"

	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// orderDue is what an order still asks: its charge less the rebates and transfers posted on it.
func orderDue(o domain.Order, postings []domain.Posting) int64 {
	due := domain.OrderCharge(o)
	for _, p := range postings {
		if (p.Kind == domain.KindRebate || p.Kind == domain.KindTransfer) && p.OrderID != nil && *p.OrderID == o.ID {
			due -= p.Gross()
		}
	}
	return due
}

// payState is payState: the order is settled once the latest payment asked for it is paid.
func payState(o domain.Order, payments []domain.Payment) string {
	if o.Status != "delivered" {
		return "not_due"
	}
	if domain.OrderCharge(o) == 0 {
		return "free"
	}
	status := ""
	for _, p := range payments {
		if p.Kind != "refund" && slices.Contains(p.OrderIDs, o.ID) {
			status = p.Status
		}
	}
	switch status {
	case "paid":
		return "paid"
	case "pending":
		return "pending"
	}
	return "unpaid"
}

// folioStay is the mock's folioStay: postings go on a stay in house whose bill is not out on a
// check-out link.
func (d Deps) folioStay(ctx context.Context, b domain.Booking) error {
	if b.Status != domain.CheckedIn {
		return errs.Newf("BOOKING_INVALID_STATE", "%s is not in house; post to the folio during the stay.", b.Code)
	}
	link, err := d.pendingSettle(ctx, b.ID)
	if err != nil {
		return err
	}
	if link != nil {
		return errs.Newf("SETTLEMENT_PENDING", "%s has a check-out link waiting for the guest; cancel it before changing the bill.", b.Code)
	}
	return nil
}

func taxLinesOf(service, pb1 int64) []billing.TaxLine {
	out := []billing.TaxLine{}
	if service != 0 {
		out = append(out, billing.TaxLine{Code: domain.ServiceCode, Account: domain.AccountServicePayable, Amount: service})
	}
	if pb1 != 0 {
		out = append(out, billing.TaxLine{Code: domain.PB1Code, Account: domain.AccountPB1Payable, Amount: pb1})
	}
	return out
}

// addPosting saves a posting and publishes folio_line.posted.
func (d Deps) addPosting(ctx context.Context, b domain.Booking, pl Place, posting domain.Posting) error {
	if err := d.Finance.AssertOpen(ctx, posting.Date); err != nil {
		return err
	}
	ref := ""
	var ledger *billing.LedgerRef
	if posting.CityLedger != nil {
		ref = posting.CityLedger.AccountID
		ledger = &billing.LedgerRef{AccountID: posting.CityLedger.AccountID, Instruction: posting.CityLedger.Instruction}
	}
	if err := d.Store.Put(ctx, Postings, Row{ID: posting.ID, BookingID: b.ID, VillaID: pl.VillaID, LocationID: pl.LocationID, Ref: ref, Doc: posting}); err != nil {
		return err
	}
	account, err := d.gl(ctx, posting.Code)
	if err != nil {
		return err
	}
	service, pb1 := domain.Deref(posting.Service), domain.Deref(posting.PB1)
	if posting.CityLedger != nil {
		service, pb1 = posting.CityLedger.Service, posting.CityLedger.PB1
	}
	return d.emit(ctx, billing.EventFolioLinePosted, "folio_posting", posting.ID, billing.FolioLinePosted{
		Where:     billing.Where{BookingID: b.ID, VillaID: pl.VillaID, LocationID: pl.LocationID, Date: posting.Date},
		PostingID: posting.ID, BookingCode: b.Code, Kind: posting.Kind, Code: posting.Code, Account: account, Description: posting.Description,
		Amount: posting.Amount, Service: service, PB1: pb1, Gross: posting.Gross(), TaxLines: taxLinesOf(service, pb1), Part: posting.Part,
		LineID: posting.LineID, OrderID: posting.OrderID, ApprovedBy: posting.ApprovedBy, PostedBy: posting.PostedBy, PostedAt: posting.PostedAt, CityLedger: ledger,
	})
}

func (d Deps) newPosting(ctx context.Context, p auth.Principal, b domain.Booking, fields domain.Posting) (domain.Posting, error) {
	n, err := d.Store.Next(ctx, "folio")
	if err != nil {
		return fields, err
	}
	fields.ID, fields.BookingID, fields.Description = fmt.Sprintf("fp-%d", n), b.ID, strings.TrimSpace(fields.Description)
	fields.Date, fields.PostedBy, fields.PostedByID, fields.PostedAt = d.today(), p.Name, p.UserID, d.stamp()
	return fields, nil
}

// PostCharge posts a charge on the folio of a stay in house; the amount reads in the stay's price
// mode, so a net price gets service and PB1 on top. It needs booking/edit.
type PostCharge struct{ Deps }

// Handle posts the charge.
func (h PostCharge) Handle(ctx context.Context, p auth.Principal, bookingID string, in domain.ChargeInput) (domain.Posting, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return domain.Posting{}, err
	}
	var out domain.Posting
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		codes, err := h.codes(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateCharge(in, codes); err != nil {
			return err
		}
		b, pl, err := h.stayInScope(ctx, p, bookingID)
		if err != nil {
			return err
		}
		if err := h.folioStay(ctx, b); err != nil {
			return err
		}
		tax, err := h.tax(ctx)
		if err != nil {
			return err
		}
		split := domain.Split(int64(in.Amount), in.Code, domain.RatesOn(&tax, h.today()), domain.StayMode(b))
		if out, err = h.newPosting(ctx, p, b, domain.Posting{Kind: domain.KindCharge, Code: in.Code, Description: in.Description, Amount: split.Net,
			Service: ptr(split.Service), PB1: ptr(split.PB1), Part: domain.PartCharges}); err != nil {
			return err
		}
		if err := h.addPosting(ctx, b, pl, out); err != nil {
			return err
		}
		return h.postingAudit(ctx, p, b, out)
	})
	return out, err
}

func (d Deps) postingAudit(ctx context.Context, p auth.Principal, b domain.Booking, posting domain.Posting) error {
	against := ""
	if posting.LineID != nil {
		against = " against " + *posting.LineID
	}
	return d.record(ctx, p, audit.Line{Action: audit.Create, Entity: "folio", EntityID: b.Code,
		Summary: fmt.Sprintf("Posted a %s %s of %d on %s%s: %s", posting.Code, posting.Kind, posting.Amount, b.Code, against, posting.Description),
		After:   map[string]any{"amount": posting.Amount, "code": posting.Code}})
}

// PostRebate corrects one posted line on that line's code; past the discount limit share of the
// line it needs booking/approve (ALLOWANCE_LIMIT). It needs booking/edit.
type PostRebate struct{ Deps }

// Handle posts the rebate.
func (h PostRebate) Handle(ctx context.Context, p auth.Principal, bookingID string, in domain.RebateInput) (domain.Posting, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingEdit...); err != nil {
		return domain.Posting{}, err
	}
	var out domain.Posting
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		b, pl, err := h.stayInScope(ctx, p, bookingID)
		if err != nil {
			return err
		}
		if err := h.folioStay(ctx, b); err != nil {
			return err
		}
		// The whole folio: a master-billed stay's nights sit on the group's folio but are its lines.
		f, err := h.folio(ctx, b, true)
		if err != nil {
			return err
		}
		target := domain.TargetOf(f.Lines, in.LineID)
		if err := domain.ValidateRebate(in, target); err != nil {
			return err
		}
		policy, err := h.policy(ctx)
		if err != nil {
			return err
		}
		amount := int64(in.Amount)
		beyond := domain.RebateBeyondLimit(*target, amount, policy.DiscountLimitPct)
		var approvedBy *string
		if beyond {
			may, err := h.can(ctx, p, "booking", "approve")
			if err != nil {
				return err
			}
			if !may {
				return errs.Newf("ALLOWANCE_LIMIT", "Rebates past %s%% of a line on %s need a villa manager.", domain.Pct(policy.DiscountLimitPct), b.Code)
			}
			approvedBy = ptr(p.Name)
		}
		back := domain.RebateTax(f.Lines, *target, amount)
		line := target.Line
		if out, err = h.newPosting(ctx, p, b, domain.Posting{Kind: domain.KindRebate, Code: line.Code, Description: in.Reason, Amount: amount,
			Service: ptr(back.Service), PB1: ptr(back.PB1), ApprovedBy: approvedBy, Part: line.Part, LineID: ptr(line.ID), OrderID: line.OrderID}); err != nil {
			return err
		}
		if err := h.addPosting(ctx, b, pl, out); err != nil {
			return err
		}
		return h.postingAudit(ctx, p, b, out)
	})
	return out, err
}

// FolioPostings is GET /bookings/{id}/folio: the postings on the stay.
type FolioPostings struct{ Deps }

// Handle lists the postings.
func (h FolioPostings) Handle(ctx context.Context, p auth.Principal, bookingID string) ([]domain.Posting, error) {
	if _, _, err := h.stayInScope(ctx, p, bookingID); err != nil {
		return nil, err
	}
	return h.postings(ctx, bookingID)
}

// masterOpen is assertMasterSettled: the last stay of a master-billed group leaves only once the
// master folio is paid.
func (d Deps) masterOpen(ctx context.Context, b domain.Booking) error {
	g, err := d.group(ctx, b.BookingGroupID)
	if err != nil || g == nil || g.Billing != "master" {
		return err
	}
	stays, err := d.groupStays(ctx, g.ID)
	if err != nil {
		return err
	}
	stays = withStay(stays, b)
	if !domain.ClosesGroup(stays, b.ID) {
		return nil
	}
	m, err := d.master(ctx, stays)
	if err != nil {
		return err
	}
	if m.Due > 0 {
		return errs.Newf("GROUP_MASTER_OPEN", "%s is the last stay of %s; the master folio still has Rp %s to pay. Take it on the group page first.", b.Code, g.Code, domain.Rupiah(m.Due))
	}
	return nil
}

// withStay puts the caller's copy of b in place of billing's, or adds it.
func withStay(stays []domain.Booking, b domain.Booking) []domain.Booking {
	for i := range stays {
		if stays[i].ID == b.ID {
			stays[i] = b
			return stays
		}
	}
	return append(stays, b)
}

func (d Deps) master(ctx context.Context, stays []domain.Booking) (domain.MasterFolio, error) {
	pays, err := d.payments(ctx)
	if err != nil {
		return domain.MasterFolio{}, err
	}
	list := make([]domain.StayFolio, 0, len(stays))
	for _, s := range stays {
		f, err := d.folioWith(ctx, s, pays, true)
		if err != nil {
			return domain.MasterFolio{}, err
		}
		list = append(list, domain.StayFolio{Booking: s, Folio: f})
	}
	return domain.Master(list, pays), nil
}

// unpaidOrders lists the stay's delivered orders still owed, with what each owes.
func (d Deps) unpaidOrders(ctx context.Context, b domain.Booking, states ...string) ([]domain.Order, []int64, error) {
	orders, err := d.orders(ctx, b.ID)
	if err != nil {
		return nil, nil, err
	}
	pays, err := d.stayPayments(ctx, b.ID)
	if err != nil {
		return nil, nil, err
	}
	postings, err := d.postings(ctx, b.ID)
	if err != nil {
		return nil, nil, err
	}
	var out []domain.Order
	var dues []int64
	for _, o := range orders {
		state := payState(o, pays)
		if contains(states, state) && orderDue(o, postings) > 0 {
			out = append(out, o)
			dues = append(dues, orderDue(o, postings))
		}
	}
	return out, dues, nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// checkOutHold is the mock's checkOut guards: no settle link waiting, room service paid, the
// master folio paid, nothing left on the folio.
func (d Deps) checkOutHold(ctx context.Context, b domain.Booking) error {
	link, err := d.pendingSettle(ctx, b.ID)
	if err != nil {
		return err
	}
	if link != nil {
		return errs.Newf("SETTLEMENT_PENDING", "%s waits for the guest to pay the check-out link; the stay closes as soon as it is paid.", b.Code)
	}
	owed, dues, err := d.unpaidOrders(ctx, b, "unpaid", "pending")
	if err != nil {
		return err
	}
	if len(owed) > 0 {
		var total int64
		numbers := make([]string, len(owed))
		for i, o := range owed {
			total += dues[i]
			numbers[i] = o.Number
		}
		return errs.Newf("SERVICE_UNPAID", "Room service of Rp %s is unpaid on %s (%s). Take the payment before check-out.", domain.Rupiah(total), b.Code, strings.Join(numbers, ", "))
	}
	if err := d.masterOpen(ctx, b); err != nil {
		return err
	}
	f, err := d.folio(ctx, b, false)
	if err != nil {
		return err
	}
	if due := f.Owed(); due > 0 {
		return errs.Newf("FOLIO_UNSETTLED", "The folio of %s still has Rp %s to pay. Settle the bill at check-out.", b.Code, domain.Rupiah(due))
	}
	return nil
}

// StayClosed reacts to reservation checking a stay out: the charges a settle took are marked on
// their postings already, and billing publishes stay.checked_out for finance with what the
// departure moved and the nights no audit reached.
type StayClosed struct{ Deps }

// Handle publishes stay.checked_out for b, which reservation has just checked out.
func (h StayClosed) Handle(ctx context.Context, b domain.Booking) error {
	pl, err := h.Store.Place(ctx, b.UnitID)
	if err != nil {
		return err
	}
	f, err := h.folio(ctx, b, true)
	if err != nil {
		return err
	}
	postings, err := h.postings(ctx, b.ID)
	if err != nil {
		return err
	}
	date := h.today()
	if b.CheckedOutOn != nil {
		date = *b.CheckedOutOn
	}
	fact := billing.StayCheckedOut{Where: billing.Where{BookingID: b.ID, VillaID: pl.VillaID, LocationID: pl.LocationID, Date: date},
		BookingCode: b.Code, UnitID: b.UnitID, Method: "cash", ChargePostingIDs: []string{}, RoomLines: []billing.AuditLine{},
		Balance: f.Balance, RefundDue: f.RefundDue, Taxes: billing.Taxes(f.Taxes)}
	if b.Departure != nil {
		fact.DepositReturned, fact.ExtraCharges = int64(b.Departure.DepositReturned), int64(b.Departure.ExtraCharges)
	}
	for _, p := range postings {
		if p.Part != domain.PartCharges || p.Kind == domain.KindTransfer || p.TransactionID == nil || *p.TransactionID != checkOutRef(b.ID) {
			continue
		}
		fact.ChargePostingIDs = append(fact.ChargePostingIDs, p.ID)
		if p.Kind == domain.KindCharge {
			fact.FolioCharges += p.Gross()
		} else {
			fact.FolioCharges -= p.Gross()
		}
		if p.PaidBy != nil {
			fact.Method = *p.PaidBy
		}
	}
	accounts, err := h.Finance.CashAccounts(ctx)
	if err != nil {
		return err
	}
	if acc := accountFor(accounts, pl, fact.Method); acc != nil {
		fact.CashAccountID = acc.ID
	}
	account, err := h.gl(ctx, domain.RoomCode)
	if err != nil {
		return err
	}
	for _, l := range f.Lines {
		if l.Kind == domain.KindRoom && l.PostedBy == "Check-out" {
			var service, pb1 int64
			for _, t := range f.Lines {
				if t.Of != nil && *t.Of == l.ID && t.Kind == domain.KindTax {
					if t.Code == domain.ServiceCode {
						service = t.Debit
					} else {
						pb1 = t.Debit
					}
				}
			}
			var night int
			_, _ = fmt.Sscanf(strings.TrimPrefix(l.ID, b.ID+"-night-"), "%d", &night)
			fact.RoomLines = append(fact.RoomLines, billing.AuditLine{Night: night, Code: domain.RoomCode, Account: account, Amount: l.Debit, TaxLines: taxLinesOf(service, pb1)})
		}
	}
	return h.emit(ctx, billing.EventStayCheckedOut, "booking", b.ID, fact)
}

// checkOutRef is the reference of the money a check-out takes for the folio charges.
func checkOutRef(bookingID string) string { return "checkout-" + bookingID }

// markChargesPaid stamps the open charges and rebates of a stay as taken at check-out by method.
func (d Deps) markChargesPaid(ctx context.Context, b domain.Booking, pl Place, method string) error {
	postings, err := d.postings(ctx, b.ID)
	if err != nil {
		return err
	}
	for _, p := range postings {
		if p.Part != domain.PartCharges || p.Kind == domain.KindTransfer || p.TransactionID != nil {
			continue
		}
		p.TransactionID, p.PaidBy = ptr(checkOutRef(b.ID)), ptr(method)
		if err := d.Store.Put(ctx, Postings, Row{ID: p.ID, BookingID: b.ID, VillaID: pl.VillaID, LocationID: pl.LocationID, Doc: p}); err != nil {
			return err
		}
	}
	return nil
}
