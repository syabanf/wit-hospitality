package command

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// accountFor is accountFor: cash lands in the cashbox of the stay's location, the rest in the bank.
func accountFor(accounts []CashAccount, pl Place, method string) *CashAccount {
	var box, bank *CashAccount
	for i := range accounts {
		a := &accounts[i]
		if box == nil && a.Kind == "cashbox" && a.LocationID != nil && *a.LocationID == pl.LocationID {
			box = a
		}
		if bank == nil && a.Kind == "bank" {
			bank = a
		}
	}
	if bank == nil && len(accounts) > 0 {
		bank = &accounts[0]
	}
	if method == "cash" && box != nil {
		return box
	}
	return bank
}

// deskShift is the shift open at the stay's cashbox when the desk takes or gives back money; the
// guest and the gateway take none.
func (d Deps) deskShift(ctx context.Context, actor auth.Principal, pl Place) (string, error) {
	if actor.UserID == GuestActor.UserID || actor.UserID == GatewayActor.UserID {
		return "", nil
	}
	accounts, err := d.Finance.CashAccounts(ctx)
	if err != nil {
		return "", err
	}
	box := accountFor(accounts, pl, "cash")
	if box == nil {
		return "", nil
	}
	shifts, err := docs[domain.Shift](d.Store.ByRef(ctx, Shifts, box.ID))
	if err != nil {
		return "", err
	}
	if s := domain.OpenShiftOn(shifts, box.ID); s != nil {
		return s.ID, nil
	}
	return "", nil
}

// newPayment numbers and saves a payment on b: an order payment records what it pays per order.
func (d Deps) newPayment(ctx context.Context, actor auth.Principal, b domain.Booking, pl Place, p domain.Payment) (domain.Payment, error) {
	shift, err := d.deskShift(ctx, actor, pl)
	if err != nil {
		return p, err
	}
	n, err := d.Store.Next(ctx, "payment")
	if err != nil {
		return p, err
	}
	p.ID, p.Number, p.BookingID, p.ShiftID = fmt.Sprintf("pay-%d-%s", n, b.ID), fmt.Sprintf("PAY-%d", 5000+n), b.ID, shift
	p.CreatedBy, p.CreatedOn = actor.Name, d.today()
	p.History = append([]domain.PaymentEvent{{Kind: "created", By: actor.Name, At: d.stamp()}}, p.History...)
	if len(p.OrderIDs) > 0 && p.Kind != "refund" && p.OrderAmounts == nil {
		orders, err := d.orders(ctx, b.ID)
		if err != nil {
			return p, err
		}
		postings, err := d.postings(ctx, b.ID)
		if err != nil {
			return p, err
		}
		for _, id := range p.OrderIDs {
			for _, o := range orders {
				if o.ID == id {
					p.OrderAmounts = append(p.OrderAmounts, orderDue(o, postings))
				}
			}
		}
	}
	return p, d.savePayment(ctx, p, pl)
}

func (d Deps) savePayment(ctx context.Context, p domain.Payment, pl Place) error {
	ref := ""
	if p.RefundOf != nil {
		ref = *p.RefundOf
	}
	return d.Store.Put(ctx, Payments, Row{ID: p.ID, BookingID: p.BookingID, VillaID: pl.VillaID, LocationID: pl.LocationID, Ref: ref, Doc: p})
}

// revenueOf splits an order payment over the income categories of its orders; a rebate before the
// payment leaves less than the charge, and each category takes its share.
func revenueOf(p domain.Payment, orders []domain.Order) []billing.Revenue {
	var keys []string
	split := map[string]int64{}
	for _, id := range p.OrderIDs {
		for _, o := range orders {
			if o.ID != id {
				continue
			}
			for _, r := range domain.RevenueSplit(o) {
				if _, ok := split[r.Key]; !ok {
					keys = append(keys, r.Key)
				}
				split[r.Key] += r.Amount
			}
		}
	}
	var charged int64
	for _, k := range keys {
		charged += split[k]
	}
	if charged != p.Amount && charged > 0 {
		var given int64
		for _, k := range keys {
			split[k] = int64(math.Floor(float64(split[k]*p.Amount) / float64(charged)))
			given += split[k]
		}
		split[keys[0]] += p.Amount - given
	}
	out := []billing.Revenue{}
	for _, k := range keys {
		if split[k] > 0 {
			out = append(out, billing.Revenue{CategoryID: k, Amount: split[k]})
		}
	}
	return out
}

// paymentFact is the payment.recorded payload for p on b.
func (d Deps) paymentFact(ctx context.Context, actor auth.Principal, b domain.Booking, pl Place, p domain.Payment, attachmentIDs []string) (billing.PaymentRecorded, error) {
	accounts, err := d.Finance.CashAccounts(ctx)
	if err != nil {
		return billing.PaymentRecorded{}, err
	}
	fact := billing.PaymentRecorded{
		Where:     billing.Where{BookingID: b.ID, VillaID: pl.VillaID, LocationID: pl.LocationID, Date: d.today()},
		PaymentID: p.ID, Number: p.Number, BookingCode: b.Code, UnitID: b.UnitID, Kind: p.Kind, Method: p.Method, Code: domain.MethodCode(p.Method),
		Amount: p.Amount, Fee: p.GatewayFee, CategoryID: "cat-room", Revenue: []billing.Revenue{}, OrderIDs: p.OrderIDs, OrderAmounts: p.OrderAmounts,
		GroupID: p.GroupID, Batch: p.Batch, ShiftID: p.ShiftID, Origin: "payment", Reference: p.Reference, Payer: p.Payer,
		AttachmentIDs: attachmentIDs, RecordedBy: actor.Name,
	}
	if fact.AttachmentIDs == nil {
		fact.AttachmentIDs = []string{}
	}
	if acc := accountFor(accounts, pl, p.Method); acc != nil {
		fact.CashAccountID, fact.AccountKind = acc.ID, acc.Kind
	}
	if domain.IsGateway(p.Method) {
		fact.AccountKind = "gateway"
	}
	if p.Method == "cash" {
		fact.Origin = "front_desk"
	}
	switch {
	case p.Kind == "refund":
		fact.CategoryID = "cat-other"
	case p.Method == "airbnb_payout":
		fact.CategoryID = "cat-airbnb"
	case p.ForOrders():
		orders, err := d.orders(ctx, b.ID)
		if err != nil {
			return fact, err
		}
		fact.Revenue = revenueOf(p, orders)
		if len(fact.Revenue) > 0 {
			fact.CategoryID = fact.Revenue[0].CategoryID
		}
	}
	paid, status, err := d.summary(ctx, b)
	fact.Stay = billing.StayPaid{PaidAmount: paid, PaymentStatus: status}
	return fact, err
}

// recorded publishes payment.recorded for a paid payment.
func (d Deps) recorded(ctx context.Context, actor auth.Principal, b domain.Booking, pl Place, p domain.Payment, attachmentIDs []string) error {
	fact, err := d.paymentFact(ctx, actor, b, pl, p, attachmentIDs)
	if err != nil {
		return err
	}
	return d.emit(ctx, billing.EventPaymentRecorded, "payment", p.ID, fact)
}

// linkPart is one payment a link asks for.
type linkPart struct {
	kind     string
	amount   int64
	orderIDs []string
	stay     *domain.Booking
	groupID  string
	batch    string
}

// settleLink makes a link pay further parts with the same token; with checkOut it closes the stay once paid.
type settleLink struct {
	also     []linkPart
	checkOut *domain.CheckOut
}

// openLink is openLink: pending payments and the gateway link the guest pays at /pay/{token}.
func (d Deps) openLink(ctx context.Context, actor auth.Principal, b domain.Booking, pl Place, first linkPart, method, payer string, settle *settleLink) (domain.PaymentLink, []domain.Payment, error) {
	policy, err := d.policy(ctx)
	if err != nil {
		return domain.PaymentLink{}, nil, err
	}
	n, err := d.Store.Next(ctx, "link")
	if err != nil {
		return domain.PaymentLink{}, nil, err
	}
	token := domain.LinkToken(n, b.ID)
	var charges int64
	parts := []linkPart{first}
	if settle != nil {
		parts = append(parts, settle.also...)
		if settle.checkOut != nil {
			charges = int64(settle.checkOut.Details.ExtraCharges) + settle.checkOut.FolioCharges
		}
	}
	link := domain.PaymentLink{Token: token, BookingID: b.ID, Method: method, CreatedAt: d.stamp(), ExpiresAt: d.stampIn(policy.LinkExpiryHours), Status: "pending",
		Proofs: []json.RawMessage{}}
	var payments []domain.Payment
	for i, part := range parts {
		chargeOn := part.amount
		if i == 0 {
			chargeOn += charges
		}
		stay, stayPlace := b, pl
		if part.stay != nil && part.stay.ID != b.ID {
			stay = *part.stay
			if stayPlace, err = d.Store.Place(ctx, stay.UnitID); err != nil {
				return link, nil, err
			}
		}
		due := d.today()
		if part.kind == "balance" && settle == nil {
			due = domain.BalanceDueOn(b.CheckIn, policy)
		}
		ref := ""
		if method == "virtual_account" {
			ref = domain.VANumberFor(token)
		}
		p, err := d.newPayment(ctx, actor, stay, stayPlace, domain.Payment{Kind: part.kind, Method: method, Amount: part.amount, Status: "pending",
			Reference: ref, Payer: strings.TrimSpace(payer), DueOn: ptr(due), GatewayFee: domain.GatewayFee(method, chargeOn, policy), OrderIDs: part.orderIDs,
			GroupID: part.groupID, Batch: part.batch, History: []domain.PaymentEvent{{Kind: "link_sent", By: actor.Name, At: d.stamp(), Note: "/pay/" + token}}})
		if err != nil {
			return link, nil, err
		}
		payments = append(payments, p)
		link.Amount += part.amount
		link.GatewayFee += p.GatewayFee
	}
	link.Amount += charges
	link.PaymentID = payments[0].ID
	if method == "virtual_account" {
		link.VABank, link.VANumber = "BCA", domain.VANumberFor(token)
	}
	if method == "qris" {
		link.QRPayload = domain.QRPayloadFor(token, link.Amount)
	}
	if settle != nil {
		link.Bundle = []string{}
		for _, p := range payments[1:] {
			link.Bundle = append(link.Bundle, p.ID)
		}
		link.CheckOut = settle.checkOut
	}
	if err := d.saveLink(ctx, link, pl); err != nil {
		return link, nil, err
	}
	return link, payments, d.record(ctx, actor, audit.Line{Action: audit.Create, Entity: "payment", EntityID: payments[0].Number,
		Summary: fmt.Sprintf("Sent a %s link for %s on %s", domain.MethodLabel[method], payments[0].Number, b.Code)})
}

func (d Deps) saveLink(ctx context.Context, l domain.PaymentLink, pl Place) error {
	return d.Store.Put(ctx, Links, Row{ID: l.Token, BookingID: l.BookingID, VillaID: pl.VillaID, LocationID: pl.LocationID, Ref: l.PaymentID, Doc: l})
}

// linkPayments is every payment a link pays: its own, then those bundled into it.
func (d Deps) linkPayments(ctx context.Context, l domain.PaymentLink) ([]domain.Payment, error) {
	out := []domain.Payment{}
	for _, id := range append([]string{l.PaymentID}, l.Bundle...) {
		p, err := get[domain.Payment](ctx, d, Payments, id, "payment")
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// placeOfStay loads billing's copy of a stay with the place its unit sits in.
func (d Deps) placeOfStay(ctx context.Context, bookingID string) (domain.Booking, Place, error) {
	b, err := d.stay(ctx, bookingID)
	if err != nil {
		return b, Place{}, err
	}
	pl, err := d.Store.Place(ctx, b.UnitID)
	return b, pl, err
}

// ExpireLinks turns pending links past their expiry, and their payments, expired. Reads run it
// first, as the mock's expireLinks does.
type ExpireLinks struct{ Deps }

// Handle expires what is due.
func (h ExpireLinks) Handle(ctx context.Context) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error { return h.expire(ctx) })
}

func (d Deps) expire(ctx context.Context) error {
	now := d.stamp()
	rows, err := d.Store.All(ctx, Links)
	if err != nil {
		return err
	}
	for _, r := range rows {
		l, err := decode[domain.PaymentLink](r.Doc)
		if err != nil {
			return err
		}
		if l.Status != "pending" || l.ExpiresAt > now {
			continue
		}
		l.Status = "expired"
		pays, err := d.linkPayments(ctx, l)
		if err != nil {
			return err
		}
		for _, p := range pays {
			if p.Status != "pending" {
				continue
			}
			p.Status = "expired"
			p.History = append(p.History, domain.PaymentEvent{Kind: "expired", By: GatewayActor.Name, At: now, Note: "Link expired unpaid"})
			if err := d.savePayment(ctx, p, Place{VillaID: r.VillaID, LocationID: r.LocationID}); err != nil {
				return err
			}
		}
		if err := d.saveLink(ctx, l, Place{VillaID: r.VillaID, LocationID: r.LocationID}); err != nil {
			return err
		}
	}
	return nil
}

// ordersToSettle is ordersToSettle: delivered, unpaid orders of the stay, taken for exactly what they owe.
func (d Deps) ordersToSettle(ctx context.Context, b domain.Booking, ids []string, amount int64) ([]domain.Order, error) {
	orders, err := d.orders(ctx, b.ID)
	if err != nil {
		return nil, err
	}
	pays, err := d.stayPayments(ctx, b.ID)
	if err != nil {
		return nil, err
	}
	postings, err := d.postings(ctx, b.ID)
	if err != nil {
		return nil, err
	}
	var list []domain.Order
	var due int64
	for _, id := range ids {
		i := slices.IndexFunc(orders, func(o domain.Order) bool { return o.ID == id })
		if i < 0 {
			return nil, errs.NotFound("order", id)
		}
		o := orders[i]
		if o.BookingID != b.ID {
			return nil, errs.Newf(errs.CodeValidation, "%s belongs to another stay.", o.Number)
		}
		state := payState(o, pays)
		if state != "unpaid" || orderDue(o, postings) <= 0 {
			msg := map[string]string{"not_due": "%s is not delivered yet.", "paid": "%s is already paid.", "pending": "%s already has a payment link open."}[state]
			if msg == "" {
				msg = "%s has nothing to pay."
			}
			return nil, errs.Newf("ORDER_NOT_BILLABLE", msg, o.Number)
		}
		list = append(list, o)
		due += orderDue(o, postings)
	}
	if amount != due {
		return nil, errs.Newf(errs.CodeValidation, "The orders come to %d; take that amount.", due)
	}
	return list, nil
}

// Attachment is a file the console attached; billing keeps its id for finance.
type Attachment struct {
	ID string `json:"id"`
}

func attachmentIDs(list []Attachment) []string {
	out := []string{}
	for _, a := range list {
		if a.ID != "" {
			out = append(out, a.ID)
		}
	}
	return out
}

// PaymentInput is PaymentInput with the attachments as the console sends them.
type PaymentInput struct {
	domain.PaymentInput
	Attachments []Attachment `json:"attachments"`
}

// RecordPayment takes money at the desk (cash, transfer, Airbnb payout); gateway methods go
// through a link. It needs payments/create.
type RecordPayment struct{ Deps }

// Handle records the payment.
func (h RecordPayment) Handle(ctx context.Context, p auth.Principal, in PaymentInput) (domain.Payment, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return domain.Payment{}, err
	}
	var out domain.Payment
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		b, pl, err := h.stayInScope(ctx, p, in.BookingID)
		if err != nil {
			return err
		}
		amount := int64(in.Amount)
		var orders []domain.Order
		if len(in.OrderIDs) > 0 {
			if orders, err = h.ordersToSettle(ctx, b, in.OrderIDs, amount); err != nil {
				return err
			}
		}
		paid, err := h.paid(ctx, b)
		if err != nil {
			return err
		}
		if orders != nil {
			check := in.PaymentInput
			check.Kind = "extra"
			err = domain.ValidatePayment(check, amount, paid)
		} else {
			expected, xerr := h.expected(ctx, b)
			if xerr != nil {
				return xerr
			}
			err = domain.ValidatePayment(in.PaymentInput, expected-paid, paid)
		}
		if err != nil {
			return err
		}
		if in.Kind == "refund" {
			return errs.New(errs.CodeValidation, "Use refund on the payment that brought the money in.")
		}
		if domain.IsGateway(in.Method) {
			return errs.Newf(errs.CodeValidation, "%s goes through a payment link.", domain.MethodLabel[in.Method])
		}
		kind := in.Kind
		var ids []string
		if orders != nil {
			kind = "extra"
			for _, o := range orders {
				ids = append(ids, o.ID)
			}
		}
		if out, err = h.newPayment(ctx, p, b, pl, domain.Payment{Kind: kind, Method: in.Method, Amount: amount, Status: "paid",
			Reference: strings.TrimSpace(in.Reference), Payer: strings.TrimSpace(in.Payer), Note: strings.TrimSpace(in.Note), PaidOn: ptr(h.today()), OrderIDs: ids,
			History: []domain.PaymentEvent{{Kind: "paid", By: p.Name, At: h.stamp(), Note: domain.MethodLabel[in.Method]}}}); err != nil {
			return err
		}
		if err := h.recorded(ctx, p, b, pl, out, attachmentIDs(in.Attachments)); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "payment", EntityID: out.Number,
			Summary: fmt.Sprintf("Recorded %s %s on %s: %d", strings.ToLower(domain.PaymentKindLabel[out.Kind]), out.Number, b.Code, out.Amount)})
	})
	return out, err
}

// NewLink is NewPaymentLink.
type NewLink struct {
	BookingID string   `json:"bookingId"`
	Kind      string   `json:"kind"`
	Method    string   `json:"method"`
	Amount    float64  `json:"amount"`
	Payer     string   `json:"payer"`
	OrderIDs  []string `json:"orderIds"`
}

// CreateLink opens a gateway link for a stay. It needs payments/create.
type CreateLink struct{ Deps }

// Handle opens the link.
func (h CreateLink) Handle(ctx context.Context, p auth.Principal, in NewLink) (domain.PaymentLink, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return domain.PaymentLink{}, err
	}
	var out domain.PaymentLink
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		b, pl, err := h.stayInScope(ctx, p, in.BookingID)
		if err != nil {
			return err
		}
		if !domain.IsGateway(in.Method) {
			return errs.New(errs.CodeValidation, "Links are for QRIS, virtual account or card.")
		}
		amount := int64(in.Amount)
		if len(in.OrderIDs) > 0 {
			if _, err := h.ordersToSettle(ctx, b, in.OrderIDs, amount); err != nil {
				return err
			}
		} else {
			paid, err := h.paid(ctx, b)
			if err != nil {
				return err
			}
			expected, err := h.expected(ctx, b)
			if err != nil {
				return err
			}
			if err := domain.ValidatePayment(domain.PaymentInput{BookingID: in.BookingID, Kind: in.Kind, Method: in.Method, Amount: in.Amount}, expected-paid, paid); err != nil {
				return err
			}
		}
		out, _, err = h.openLink(ctx, p, b, pl, linkPart{kind: in.Kind, amount: amount, orderIDs: in.OrderIDs}, in.Method, in.Payer, nil)
		return err
	})
	return out, err
}

// CancelLink cancels a pending link and its payments. It needs payments/create.
type CancelLink struct{ Deps }

// Handle cancels the link.
func (h CancelLink) Handle(ctx context.Context, p auth.Principal, token string) (domain.PaymentLink, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsCreate...); err != nil {
		return domain.PaymentLink{}, err
	}
	var l domain.PaymentLink
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		if err := h.expire(ctx); err != nil {
			return err
		}
		var err error
		if l, err = get[domain.PaymentLink](ctx, h.Deps, Links, token, "payment link"); err != nil {
			return err
		}
		_, pl, err := h.stayInScope(ctx, p, l.BookingID)
		if err != nil {
			return err
		}
		if l.Status != "pending" {
			return errs.Newf("PAYMENT_INVALID_STATE", "The link is %s.", l.Status)
		}
		l.Status = "cancelled"
		pays, err := h.linkPayments(ctx, l)
		if err != nil {
			return err
		}
		for _, x := range pays {
			x.Status = "cancelled"
			x.History = append(x.History, domain.PaymentEvent{Kind: "cancelled", By: p.Name, At: h.stamp()})
			_, xpl, err := h.placeOfStay(ctx, x.BookingID)
			if err != nil {
				return err
			}
			if err := h.savePayment(ctx, x, xpl); err != nil {
				return err
			}
		}
		return h.saveLink(ctx, l, pl)
	})
	return l, err
}

// RefundInput is the refund the console sends.
type RefundInput struct {
	Amount        float64  `json:"amount"`
	Reason        string   `json:"reason"`
	AttachmentIDs []string `json:"attachmentIds"`
}

// Refund gives money back against the payment that brought it in, up to the credit in its part
// of the bill on a stay that is not cancelled (REFUND_EXCEEDS_CREDIT). It needs payments/edit.
type Refund struct{ Deps }

// Handle refunds.
func (h Refund) Handle(ctx context.Context, p auth.Principal, paymentID string, in RefundInput) (domain.Payment, error) {
	if err := h.Authz.Require(ctx, p.Role, paymentsEdit...); err != nil {
		return domain.Payment{}, err
	}
	if len([]rune(strings.TrimSpace(in.Reason))) < 3 {
		return domain.Payment{}, errs.Invalid("note", "Say why the money goes back.")
	}
	if in.Amount != math.Trunc(in.Amount) || in.Amount <= 0 {
		return domain.Payment{}, errs.Invalid("amount", "Enter a whole rupiah amount above zero.")
	}
	amount := int64(in.Amount)
	var out domain.Payment
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		original, err := get[domain.Payment](ctx, h.Deps, Payments, paymentID, "payment")
		if err != nil {
			return err
		}
		b, pl, err := h.stayInScope(ctx, p, original.BookingID)
		if err != nil {
			return err
		}
		if original.Status != "paid" && original.Status != "refunded" {
			return errs.Newf("PAYMENT_INVALID_STATE", "%s is %s; only paid money goes back.", original.Number, original.Status)
		}
		if original.Kind == "refund" {
			return errs.New("PAYMENT_INVALID_STATE", "A refund cannot be refunded.")
		}
		refunds, err := docs[domain.Payment](h.Store.ByRef(ctx, Payments, original.ID))
		if err != nil {
			return err
		}
		var already int64
		for _, r := range refunds {
			if r.Status == "paid" {
				already += r.Amount
			}
		}
		if err := domain.ValidatePayment(domain.PaymentInput{BookingID: b.ID, Kind: "refund", Method: original.Method, Amount: in.Amount, Reference: original.Number, Note: in.Reason},
			0, original.Amount-already); err != nil {
			return err
		}
		whole, err := h.folio(ctx, b, true)
		if err != nil {
			return err
		}
		if b.Status != domain.Cancelled && b.Status != domain.NoShow {
			if err := h.creditCheck(ctx, b, original, already, amount); err != nil {
				return err
			}
		}
		method := "bank_transfer"
		if original.Method == "cash" {
			method = "cash"
		}
		var orderIDs []string
		if original.ForOrders() {
			credit := func(orderID string) int64 {
				var s int64
				for _, l := range whole.Lines {
					if l.OrderID != nil && *l.OrderID == orderID {
						s += l.Debit - l.Credit
					}
				}
				return s
			}
			ids := slices.Clone(original.OrderIDs)
			sort.SliceStable(ids, func(i, j int) bool { return credit(ids[i]) < credit(ids[j]) })
			orderIDs = ids[:1]
		}
		if out, err = h.newPayment(ctx, p, b, pl, domain.Payment{Kind: "refund", Method: method, Amount: amount, Status: "paid", Reference: original.Number,
			Payer: h.guestName(ctx, b.GuestID), Note: strings.TrimSpace(in.Reason), PaidOn: ptr(h.today()), RefundOf: ptr(original.ID), OrderIDs: orderIDs}); err != nil {
			return err
		}
		if already+amount >= original.Amount {
			original.Status = "refunded"
		}
		original.History = append(original.History, domain.PaymentEvent{Kind: "refunded", By: p.Name, At: h.stamp(), Note: out.Number + ": " + strings.TrimSpace(in.Reason)})
		if err := h.savePayment(ctx, original, pl); err != nil {
			return err
		}
		fact, err := h.paymentFact(ctx, p, b, pl, out, in.AttachmentIDs)
		if err != nil {
			return err
		}
		if err := h.emit(ctx, billing.EventPaymentRefunded, "payment", out.ID, billing.PaymentRefunded{PaymentRecorded: fact, RefundOf: original.ID,
			OriginalNumber: original.Number, Reason: strings.TrimSpace(in.Reason)}); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "payment", EntityID: out.Number,
			Summary: fmt.Sprintf("Refunded %d of %s on %s: %s", amount, original.Number, b.Code, strings.TrimSpace(in.Reason))})
	})
	return out, err
}

// creditCheck is the folio's refund rule: a refund pays back the credit in the payment's part of the bill.
func (d Deps) creditCheck(ctx context.Context, b domain.Booking, original domain.Payment, refunded, amount int64) error {
	f, err := d.folio(ctx, b, false)
	if err != nil {
		return err
	}
	var refundable int64
	if f.RefundDue > 0 && original.Kind != "payout" {
		refundable = domain.Refundable(f, original, refunded)
	}
	if refundable <= 0 {
		return errs.New("REFUND_EXCEEDS_CREDIT", "Nothing on that payment is owed back; the folio has no credit in its part of the bill.")
	}
	if amount > refundable {
		return errs.Newf("REFUND_EXCEEDS_CREDIT", "Only %d of %s is owed back to the guest.", refundable, original.Number)
	}
	return nil
}
