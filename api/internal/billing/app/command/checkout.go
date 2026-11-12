package command

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// maxAttachments is MAX_ATTACHMENTS.
const maxAttachments = 10

// Checkout serves the public payment page at /pay/{token} and stands in for the gateway's
// callback in the demo: the guest pays, the link fails, or the guest uploads a transfer receipt.
type Checkout struct{ Deps }

// view is checkoutOf: what the guest's page shows for a link.
func (h Checkout) view(ctx context.Context, l domain.PaymentLink) (domain.PublicCheckout, error) {
	b, pl, err := h.placeOfStay(ctx, l.BookingID)
	if err != nil {
		return domain.PublicCheckout{}, err
	}
	pays, err := h.linkPayments(ctx, l)
	if err != nil {
		return domain.PublicCheckout{}, err
	}
	p := pays[0]
	out := domain.PublicCheckout{Link: l, PaymentNumber: p.Number, PaymentStatus: p.Status, Kind: p.Kind, GuestName: h.guestName(ctx, b.GuestID),
		VillaName: pl.VillaName, LocationName: pl.LocationName, UnitCode: pl.UnitCode, UnitName: pl.UnitName, CheckIn: b.CheckIn, CheckOut: b.CheckOut,
		Nights: domain.DaysBetween(b.CheckIn, b.CheckOut), BookingCode: b.Code, PaidOn: p.PaidOn, Reference: p.Reference}
	group, err := h.group(ctx, p.GroupID)
	if err != nil {
		return out, err
	}
	if group != nil {
		out.BookingCode = group.Code + " " + group.Name
	}
	tax, err := h.tax(ctx)
	if err != nil {
		return out, err
	}
	stayTax := domain.StayTaxOf(b, &tax)
	switch {
	case l.CheckOut != nil || group != nil:
		out.Total = l.Amount
	case p.ForOrders():
		out.Total = p.Amount
	default:
		out.Total = stayTax.Total
		paid, _, err := h.summary(ctx, b)
		if err != nil {
			return out, err
		}
		out.PaidBefore = paid
		if p.Status == "paid" {
			out.PaidBefore -= p.Amount
		}
	}
	if p.ForOrders() {
		orders, err := h.orders(ctx, b.ID)
		if err != nil {
			return out, err
		}
		out.OrderNumbers = []string{}
		for _, id := range p.OrderIDs {
			for _, o := range orders {
				if o.ID == id {
					out.OrderNumbers = append(out.OrderNumbers, o.Number)
				}
			}
		}
	} else {
		out.TaxNote = ptr(domain.TaxNote(stayTax))
	}
	if l.CheckOut != nil {
		if out.Lines, err = h.settleLines(ctx, b, pays, int64(l.CheckOut.Details.ExtraCharges), l.CheckOut.FolioCharges); err != nil {
			return out, err
		}
	}
	return out, nil
}

// settleLines is settleLinesOf: what a set of payments covers, as the check-out bill reads.
func (d Deps) settleLines(ctx context.Context, b domain.Booking, pays []domain.Payment, charges, folioCharges int64) ([]domain.SettleLine, error) {
	orders, err := d.orders(ctx, b.ID)
	if err != nil {
		return nil, err
	}
	postings, err := d.postings(ctx, b.ID)
	if err != nil {
		return nil, err
	}
	var room int64
	var bills []domain.OrderBill
	for _, p := range pays {
		if !p.ForOrders() {
			room += p.Amount
			continue
		}
		for i, id := range p.OrderIDs {
			for _, o := range orders {
				if o.ID != id {
					continue
				}
				amount := orderDue(o, postings)
				if i < len(p.OrderAmounts) {
					amount = p.OrderAmounts[i]
				}
				bills = append(bills, domain.OrderBill{Number: o.Number, Items: domain.OrderSummary(o.Lines), Amount: amount})
			}
		}
	}
	return domain.SettlementLines(room, bills, charges, folioCharges), nil
}

func (h Checkout) link(ctx context.Context, token string) (domain.PaymentLink, error) {
	if err := h.expire(ctx); err != nil {
		return domain.PaymentLink{}, err
	}
	return get[domain.PaymentLink](ctx, h.Deps, Links, token, "payment link")
}

// View is GET /pay/{token}.
func (h Checkout) View(ctx context.Context, token string) (domain.PublicCheckout, error) {
	var out domain.PublicCheckout
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		l, err := h.link(ctx, token)
		if err != nil {
			return err
		}
		out, err = h.view(ctx, l)
		return err
	})
	return out, err
}

// Simulate is POST /pay/{token}/simulate: the demo gateway confirms or declines the link. A paid
// settle link checks the stay out through reservation.
func (h Checkout) Simulate(ctx context.Context, token, outcome string) (domain.PublicCheckout, error) {
	var out domain.PublicCheckout
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		l, err := h.link(ctx, token)
		if err != nil {
			return err
		}
		if l.Status != "pending" {
			return errs.Newf("PAYMENT_INVALID_STATE", "This link is %s.", l.Status)
		}
		pays, err := h.linkPayments(ctx, l)
		if err != nil {
			return err
		}
		if outcome == "failed" {
			if err := h.declined(ctx, &l, pays); err != nil {
				return err
			}
		} else if err := h.paidLink(ctx, &l, pays); err != nil {
			return err
		}
		out, err = h.view(ctx, l)
		return err
	})
	return out, err
}

func (h Checkout) declined(ctx context.Context, l *domain.PaymentLink, pays []domain.Payment) error {
	l.Status = "failed"
	for _, p := range pays {
		p.Status = "failed"
		p.History = append(p.History, domain.PaymentEvent{Kind: "failed", By: GatewayActor.Name, At: h.stamp(), Note: "Declined at the gateway"})
		_, pl, err := h.placeOfStay(ctx, p.BookingID)
		if err != nil {
			return err
		}
		if err := h.savePayment(ctx, p, pl); err != nil {
			return err
		}
		if err := h.record(ctx, GatewayActor, audit.Line{Action: audit.Status, Entity: "payment", EntityID: p.Number, Summary: "Gateway declined " + p.Number,
			Before: map[string]any{"status": "pending"}, After: map[string]any{"status": "failed"}}); err != nil {
			return err
		}
	}
	_, pl, err := h.placeOfStay(ctx, l.BookingID)
	if err != nil {
		return err
	}
	return h.saveLink(ctx, *l, pl)
}

func (h Checkout) paidLink(ctx context.Context, l *domain.PaymentLink, pays []domain.Payment) error {
	// A group link pays a share on each stay; each share must still fit what its stay owes.
	var stays []string
	room := map[string]int64{}
	for _, p := range pays {
		if !contains(stays, p.BookingID) {
			stays = append(stays, p.BookingID)
		}
		if !p.ForOrders() {
			room[p.BookingID] += p.Amount
		}
	}
	for _, id := range stays {
		b, err := h.stay(ctx, id)
		if err != nil {
			return err
		}
		owed, err := h.owed(ctx, b)
		if err != nil {
			return err
		}
		if room[id] > owed {
			return errs.Newf("PAYMENT_OVERPAID", "%s is already paid.", b.Code)
		}
	}
	l.Status = "paid"
	proofs := []string{}
	for _, raw := range l.Proofs {
		var a Attachment
		if json.Unmarshal(raw, &a) == nil && a.ID != "" {
			proofs = append(proofs, a.ID)
		}
	}
	for i, p := range pays {
		b, pl, err := h.placeOfStay(ctx, p.BookingID)
		if err != nil {
			return err
		}
		p.Status, p.PaidOn = "paid", ptr(h.today())
		if p.Reference == "" {
			p.Reference = "GW-" + strings.ToUpper(l.Token[max(0, len(l.Token)-6):])
		}
		p.History = append(p.History, domain.PaymentEvent{Kind: "paid", By: GatewayActor.Name, At: h.stamp(), Note: domain.MethodLabel[p.Method]})
		if err := h.savePayment(ctx, p, pl); err != nil {
			return err
		}
		var attached []string
		if i == 0 {
			attached = proofs
		}
		if err := h.recorded(ctx, GatewayActor, b, pl, p, attached); err != nil {
			return err
		}
		if err := h.record(ctx, GatewayActor, audit.Line{Action: audit.Status, Entity: "payment", EntityID: p.Number,
			Summary: fmt.Sprintf("Gateway confirmed %s on %s: %d", p.Number, b.Code, p.Amount),
			Before:  map[string]any{"status": "pending"}, After: map[string]any{"status": "paid"}}); err != nil {
			return err
		}
	}
	b, pl, err := h.placeOfStay(ctx, l.BookingID)
	if err != nil {
		return err
	}
	if err := h.saveLink(ctx, *l, pl); err != nil {
		return err
	}
	// A settle link closes the stay as the desk asked, the money landing in the bank.
	if l.CheckOut == nil || b.Status != domain.CheckedIn {
		return nil
	}
	if err := h.markChargesPaid(ctx, b, pl, l.Method); err != nil {
		return err
	}
	return h.Reservation.CheckOut(ctx, GatewayActor, b.ID, l.CheckOut.Details)
}

// Proof is POST /pay/{token}/proof: the guest uploads a transfer receipt for a pending link.
func (h Checkout) Proof(ctx context.Context, token, attachmentID string) (domain.PublicCheckout, error) {
	var out domain.PublicCheckout
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		l, err := h.link(ctx, token)
		if err != nil {
			return err
		}
		if l.Status != "pending" {
			return errs.Newf("PAYMENT_INVALID_STATE", "This link is %s.", l.Status)
		}
		if strings.TrimSpace(attachmentID) == "" {
			return errs.Invalid("attachmentId", "Attach the transfer receipt.")
		}
		if len(l.Proofs) >= maxAttachments {
			return errs.Newf("ATTACHMENT_COUNT", "Attach at most %d files.", maxAttachments)
		}
		l.Proofs = append(l.Proofs, mustJSON(map[string]string{"id": attachmentID, "uploadedBy": GuestActor.Name}))
		p, err := get[domain.Payment](ctx, h.Deps, Payments, l.PaymentID, "payment")
		if err != nil {
			return err
		}
		p.History = append(p.History, domain.PaymentEvent{Kind: "proof", By: "Guest", At: h.stamp(), Note: "Uploaded " + attachmentID})
		_, pl, err := h.placeOfStay(ctx, l.BookingID)
		if err != nil {
			return err
		}
		if err := h.savePayment(ctx, p, pl); err != nil {
			return err
		}
		if err := h.saveLink(ctx, l, pl); err != nil {
			return err
		}
		if err := h.record(ctx, GuestActor, audit.Line{Action: audit.Update, Entity: "payment", EntityID: p.Number, Summary: fmt.Sprintf("Guest uploaded %s for %s", attachmentID, p.Number)}); err != nil {
			return err
		}
		out, err = h.view(ctx, l)
		return err
	})
	return out, err
}
