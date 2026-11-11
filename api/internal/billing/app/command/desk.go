package command

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Desk answers reservation and services in process; it is billing.Client. Each answer runs in
// the caller's transaction when there is one, so a check-out and its bill commit together.
type Desk struct{ Deps }

var _ billing.Client = Desk{}

func (h Desk) inTx(ctx context.Context, fn func(ctx context.Context) error) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		return fn(ctx)
	})
}

// Owed is the room a direct stay still owes.
func (h Desk) Owed(ctx context.Context, stay json.RawMessage) (int64, error) {
	b, err := h.stayOf(ctx, stay)
	if err != nil {
		return 0, err
	}
	return h.owed(ctx, b)
}

// CheckOutHold refuses a plain check-out the folio holds.
func (h Desk) CheckOutHold(ctx context.Context, stay json.RawMessage) error {
	b, err := h.stayOf(ctx, stay)
	if err != nil {
		return err
	}
	return h.checkOutHold(ctx, b)
}

// Policy is the payment policy and today's tax rates.
func (h Desk) Policy(ctx context.Context) (billing.Policy, error) {
	policy, err := h.policy(ctx)
	if err != nil {
		return billing.Policy{}, err
	}
	tax, err := h.tax(ctx)
	if err != nil {
		return billing.Policy{}, err
	}
	out := billing.Policy{DepositPct: policy.DepositPct, FreeCancelDays: int(policy.FreeCancelDays), DiscountLimitPct: policy.DiscountLimitPct, DirectMode: tax.DirectMode}
	if r := domain.RatesOn(&tax, h.today()); r != nil {
		out.ServicePct, out.PB1Pct, out.PB1OnService = r.ServicePct, r.PB1Pct, r.PB1OnService
	}
	return out, nil
}

// SettleInput is SettleInput.
type SettleInput struct {
	Details     domain.Departure `json:"details"`
	Method      string           `json:"method"`
	Reference   string           `json:"reference"`
	Attachments []Attachment     `json:"attachments"`
}

// Settle takes the bill at check-out: the room balance, unpaid room service and the open charges.
// A gateway method returns a link that closes the stay once paid; a desk method takes the money
// now, stamps the charges paid and returns null for reservation to close the stay.
func (h Desk) Settle(ctx context.Context, p auth.Principal, stay, raw json.RawMessage) (json.RawMessage, error) {
	var in SettleInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, errs.New(errs.CodeValidation, "The request body is not valid JSON.")
	}
	out := json.RawMessage("null")
	err := h.inTx(ctx, func(ctx context.Context) error {
		b, err := h.stayOf(ctx, stay)
		if err != nil {
			return err
		}
		pl, err := h.Store.Place(ctx, b.UnitID)
		if err != nil {
			return err
		}
		link, err := h.pendingSettle(ctx, b.ID)
		if err != nil {
			return err
		}
		if link != nil {
			return errs.Newf("SETTLEMENT_PENDING", "%s already has a check-out link waiting for the guest.", b.Code)
		}
		if err := h.masterOpen(ctx, b); err != nil {
			return err
		}
		waiting, _, err := h.unpaidOrders(ctx, b, "pending")
		if err != nil {
			return err
		}
		if len(waiting) > 0 {
			numbers := make([]string, len(waiting))
			for i, o := range waiting {
				numbers[i] = o.Number
			}
			return errs.Newf("SETTLEMENT_PENDING", "%s has a payment link open; cancel it or wait for the guest.", strings.Join(numbers, ", "))
		}
		f, err := h.folio(ctx, b, false)
		if err != nil {
			return err
		}
		unpaid, dues, err := h.unpaidOrders(ctx, b, "unpaid")
		if err != nil {
			return err
		}
		var ordersDue int64
		bills := make([]domain.OrderBill, len(unpaid))
		orderIDs := make([]string, len(unpaid))
		for i, o := range unpaid {
			ordersDue += dues[i]
			bills[i] = domain.OrderBill{Number: o.Number, Amount: dues[i]}
			orderIDs[i] = o.ID
		}
		lines := domain.SettlementLines(f.Due.Room, bills, int64(in.Details.ExtraCharges), f.Due.Charges)
		for _, l := range lines {
			if l.Kind != domain.PartCharges {
				if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
					return err
				}
				break
			}
		}
		if err := domain.ValidateSettle(in.Method, in.Reference, lines); err != nil {
			return err
		}
		payer := h.guestName(ctx, b.GuestID)
		var parts []linkPart
		if len(unpaid) > 0 {
			parts = append(parts, linkPart{kind: "extra", amount: ordersDue, orderIDs: orderIDs})
		}
		if f.Due.Room > 0 {
			parts = append(parts, linkPart{kind: "balance", amount: f.Due.Room})
		}
		if len(parts) > 0 && domain.IsGateway(in.Method) {
			details := in.Details
			details.Notes = strings.TrimSpace(details.Notes)
			l, _, err := h.openLink(ctx, p, b, pl, parts[0], in.Method, payer, &settleLink{also: parts[1:],
				checkOut: &domain.CheckOut{Details: details, By: p.UserID, FolioCharges: f.Due.Charges}})
			if err != nil {
				return err
			}
			out = mustJSON(l)
			return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "booking", EntityID: b.Code, Summary: fmt.Sprintf("Sent a check-out link for %s: %d", b.Code, l.Amount)})
		}
		for i, part := range parts {
			pay, err := h.newPayment(ctx, p, b, pl, domain.Payment{Kind: part.kind, Method: in.Method, Amount: part.amount, Status: "paid",
				Reference: strings.TrimSpace(in.Reference), Payer: payer, Note: "Settled at check-out", PaidOn: ptr(h.today()), OrderIDs: part.orderIDs,
				History: []domain.PaymentEvent{{Kind: "paid", By: p.Name, At: h.stamp(), Note: domain.MethodLabel[in.Method]}}})
			if err != nil {
				return err
			}
			var attached []string
			if i == 0 {
				attached = attachmentIDs(in.Attachments)
			}
			if err := h.recorded(ctx, p, b, pl, pay, attached); err != nil {
				return err
			}
			if err := h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "payment", EntityID: pay.Number,
				Summary: fmt.Sprintf("Recorded %s %s on %s at check-out: %d", strings.ToLower(domain.PaymentKindLabel[pay.Kind]), pay.Number, b.Code, pay.Amount)}); err != nil {
				return err
			}
		}
		return h.markChargesPaid(ctx, b, pl, in.Method)
	})
	return out, err
}

// GroupPaymentInput is GroupPaymentInput.
type GroupPaymentInput struct {
	Kind        string       `json:"kind"`
	Method      string       `json:"method"`
	Amount      float64      `json:"amount"`
	Reference   string       `json:"reference"`
	Note        string       `json:"note"`
	Attachments []Attachment `json:"attachments"`
}

// GroupPayment splits one payment over the stays reservation passes, in order, each share up to
// what its stay owes; a gateway method sends one link for every share.
func (h Desk) GroupPayment(ctx context.Context, p auth.Principal, groupRaw json.RawMessage, staysRaw []json.RawMessage, raw json.RawMessage) (json.RawMessage, error) {
	var in GroupPaymentInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, errs.New(errs.CodeValidation, "The request body is not valid JSON.")
	}
	g, err := decode[domain.Group](groupRaw)
	if err != nil {
		return nil, err
	}
	var out json.RawMessage
	err = h.inTx(ctx, func(ctx context.Context) error {
		stays := make([]domain.Booking, 0, len(staysRaw))
		var owed int64
		dues := make([]int64, 0, len(staysRaw))
		for _, r := range staysRaw {
			b, err := h.stayOf(ctx, r)
			if err != nil {
				return err
			}
			due, err := h.owed(ctx, b)
			if err != nil {
				return err
			}
			stays = append(stays, b)
			dues = append(dues, due)
			owed += max(0, due)
		}
		first := ""
		if len(stays) > 0 {
			first = stays[0].ID
		}
		if err := domain.ValidatePayment(domain.PaymentInput{BookingID: first, Kind: in.Kind, Method: in.Method, Amount: in.Amount, Reference: in.Reference, Note: in.Note}, owed, 0); err != nil {
			return err
		}
		n, err := h.Store.Next(ctx, "groupPayment")
		if err != nil {
			return err
		}
		batch := fmt.Sprintf("GP-%d", 2000+n)
		payer := h.guestName(ctx, g.LeadGuestID)
		left := int64(in.Amount)
		var parts []linkPart
		for i := range stays {
			share := min(left, max(0, dues[i]))
			left -= share
			if share > 0 {
				parts = append(parts, linkPart{kind: in.Kind, amount: share, stay: &stays[i], groupID: g.ID, batch: batch})
			}
		}
		verb := "Took"
		if domain.IsGateway(in.Method) {
			verb = "Sent a link for"
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "booking-group", EntityID: g.Code,
			Summary: fmt.Sprintf("%s group %s %s on %s by %s: %d", verb, strings.ToLower(domain.PaymentKindLabel[in.Kind]), batch, g.Code, domain.MethodLabel[in.Method], int64(in.Amount))}); err != nil {
			return err
		}
		if domain.IsGateway(in.Method) {
			if len(parts) == 0 {
				return errs.New(errs.CodeValidation, "Nothing is owed on the group.")
			}
			b := *parts[0].stay
			pl, err := h.Store.Place(ctx, b.UnitID)
			if err != nil {
				return err
			}
			l, pays, err := h.openLink(ctx, p, b, pl, parts[0], in.Method, payer, &settleLink{also: parts[1:]})
			if err != nil {
				return err
			}
			out = mustJSON(map[string]any{"payments": pays, "link": l})
			return nil
		}
		pays := []domain.Payment{}
		note := strings.TrimSpace(in.Note)
		if note == "" {
			note = "Group " + g.Code
		}
		for i, part := range parts {
			b := *part.stay
			pl, err := h.Store.Place(ctx, b.UnitID)
			if err != nil {
				return err
			}
			pay, err := h.newPayment(ctx, p, b, pl, domain.Payment{Kind: in.Kind, Method: in.Method, Amount: part.amount, Status: "paid",
				Reference: strings.TrimSpace(in.Reference), Payer: payer, Note: note, PaidOn: ptr(h.today()), GroupID: g.ID, Batch: batch,
				History: []domain.PaymentEvent{{Kind: "paid", By: p.Name, At: h.stamp(), Note: domain.MethodLabel[in.Method]}}})
			if err != nil {
				return err
			}
			var attached []string
			if i == 0 {
				attached = attachmentIDs(in.Attachments)
			}
			if err := h.recorded(ctx, p, b, pl, pay, attached); err != nil {
				return err
			}
			pays = append(pays, pay)
		}
		out = mustJSON(map[string]any{"payments": pays, "link": nil})
		return nil
	})
	return out, err
}

// PayBalance opens the gateway link for the room balance from the public check-in page, or returns
// the one already open.
func (h Desk) PayBalance(ctx context.Context, stay json.RawMessage, method string) (json.RawMessage, error) {
	var out json.RawMessage
	err := h.inTx(ctx, func(ctx context.Context) error {
		b, err := h.stayOf(ctx, stay)
		if err != nil {
			return err
		}
		var owed int64
		if b.Source == domain.Direct {
			if owed, err = h.owed(ctx, b); err != nil {
				return err
			}
		}
		if owed <= 0 {
			return errs.Newf("PAYMENT_OVERPAID", "Nothing is left to pay on %s.", b.Code)
		}
		if err := h.expire(ctx); err != nil {
			return err
		}
		links, err := docs[domain.PaymentLink](h.Store.ByBooking(ctx, Links, b.ID))
		if err != nil {
			return err
		}
		for _, l := range links {
			if l.Status == "pending" && l.CheckOut == nil && l.Bundle == nil {
				out = mustJSON(l)
				return nil
			}
		}
		pl, err := h.Store.Place(ctx, b.UnitID)
		if err != nil {
			return err
		}
		l, _, err := h.openLink(ctx, GuestActor, b, pl, linkPart{kind: "balance", amount: owed}, method, h.guestName(ctx, b.GuestID), nil)
		out = mustJSON(l)
		return err
	})
	return out, err
}

// CityLedger checks who pays new stays and returns the billing they carry.
func (h Desk) CityLedger(ctx context.Context, p auth.Principal, input json.RawMessage, source string, staysRaw []json.RawMessage) (json.RawMessage, error) {
	var in *domain.BillingInput
	if err := json.Unmarshal(input, &in); err != nil {
		return nil, errs.New(errs.CodeValidation, "The request body is not valid JSON.")
	}
	var out json.RawMessage
	err := h.inTx(ctx, func(ctx context.Context) error {
		stays := make([]domain.Booking, 0, len(staysRaw))
		for _, r := range staysRaw {
			b, err := h.stayOf(ctx, r)
			if err != nil {
				return err
			}
			stays = append(stays, b)
		}
		v, err := h.billing(ctx, p, in, stays, source, nil)
		if err != nil || v == nil {
			out = json.RawMessage("null")
			return err
		}
		out = mustJSON(v)
		return nil
	})
	return out, err
}

// VoidDelivery checks a void of a delivered order and publishes the folio lines it takes off:
// only on the business day of the delivery (VOID_DAY_CLOSED) and while nothing paid, linked or
// rebated it (ORDER_VOID_PAID).
func (h Desk) VoidDelivery(ctx context.Context, p auth.Principal, raw json.RawMessage, reason string) error {
	o, err := decode[domain.Order](raw)
	if err != nil {
		return err
	}
	if len([]rune(strings.TrimSpace(reason))) < 3 {
		return errs.New(errs.CodeValidation, "Say why the delivery is voided.")
	}
	return h.inTx(ctx, func(ctx context.Context) error {
		date, err := h.businessDate(ctx)
		if err != nil {
			return err
		}
		delivered := ""
		if o.DeliveredOn != nil {
			delivered = *o.DeliveredOn
		}
		if delivered != date {
			return errs.Newf("VOID_DAY_CLOSED", "%s was delivered on %s, a business day already closed; post a rebate on its line instead.", o.Number, delivered)
		}
		b, pl, err := h.placeOfStay(ctx, o.BookingID)
		if err != nil {
			return err
		}
		pays, err := h.stayPayments(ctx, o.BookingID)
		if err != nil {
			return err
		}
		switch payState(o, pays) {
		case "paid":
			return errs.Newf("ORDER_VOID_PAID", "%s is paid; post a rebate and refund the guest instead.", o.Number)
		case "pending":
			return errs.Newf("ORDER_VOID_PAID", "%s is on a payment link; post a rebate and refund the guest instead.", o.Number)
		}
		postings, err := h.postings(ctx, o.BookingID)
		if err != nil {
			return err
		}
		for _, x := range postings {
			if x.OrderID != nil && *x.OrderID == o.ID {
				return errs.Newf("ORDER_VOID_PAID", "%s already has a rebate; post another rebate instead.", o.Number)
			}
		}
		tax, err := h.tax(ctx)
		if err != nil {
			return err
		}
		f := domain.Folio(domain.FolioSources{Booking: b, Orders: []domain.Order{o}, Tax: &tax})
		fact := billing.FolioLineVoided{Where: billing.Where{BookingID: b.ID, VillaID: pl.VillaID, LocationID: pl.LocationID, Date: date},
			OrderID: o.ID, OrderNumber: o.Number, BookingCode: b.Code, Reason: strings.TrimSpace(reason), Lines: []billing.VoidedLine{}}
		for _, l := range f.Lines {
			if l.OrderID == nil || *l.OrderID != o.ID || l.Kind != domain.KindRoomService {
				continue
			}
			var service, pb1, off int64
			for _, t := range f.Lines {
				if t.Of == nil || *t.Of != l.ID {
					continue
				}
				switch {
				case t.Kind == domain.KindTax && t.Code == domain.ServiceCode:
					service = t.Debit
				case t.Kind == domain.KindTax:
					pb1 = t.Debit
				default:
					off += t.Credit
				}
			}
			account, err := h.gl(ctx, l.Code)
			if err != nil {
				return err
			}
			fact.Lines = append(fact.Lines, billing.VoidedLine{LineID: l.ID, Code: l.Code, Account: account, Amount: l.Debit - off, TaxLines: taxLinesOf(service, pb1)})
		}
		return h.emit(ctx, billing.EventFolioLineVoided, "service_order", o.ID, fact)
	})
}

// mayOverrideCredit is finance/approve or booking/approve: who books past a credit limit.
func (d Deps) mayOverrideCredit(ctx context.Context, p auth.Principal) (bool, error) {
	perms, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return false, err
	}
	return rbac.Can(perms, p.Role, "finance", "approve") || rbac.Can(perms, p.Role, "booking", "approve"), nil
}
