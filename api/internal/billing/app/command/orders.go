package command

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// OrderPayments is billing's view of a stay's room service money for services.
func (h Desk) OrderPayments(ctx context.Context, bookingID string) (billing.OrderPayments, error) {
	out := billing.OrderPayments{Status: map[string]string{}, Rebated: map[string]int64{}}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.expire(ctx); err != nil {
			return err
		}
		pays, err := h.stayPayments(ctx, bookingID)
		if err != nil {
			return err
		}
		for _, p := range pays {
			out.Status[p.ID] = p.Status
		}
		postings, err := h.postings(ctx, bookingID)
		if err != nil {
			return err
		}
		for _, p := range postings {
			if (p.Kind == domain.KindRebate || p.Kind == domain.KindTransfer) && p.OrderID != nil {
				out.Rebated[*p.OrderID] += p.Gross()
			}
		}
		link, err := h.orderLink(ctx, bookingID, pays)
		if link != nil {
			out.PayToken = link.Token
		}
		return err
	})
	return out, err
}

// orderLink is the stay's pending link that pays room service, nil when none is open.
func (d Deps) orderLink(ctx context.Context, bookingID string, pays []domain.Payment) (*domain.PaymentLink, error) {
	links, err := docs[domain.PaymentLink](d.Store.ByBooking(ctx, Links, bookingID))
	if err != nil {
		return nil, err
	}
	for _, l := range links {
		if l.Status != "pending" {
			continue
		}
		for _, p := range pays {
			if p.ID == l.PaymentID && p.ForOrders() {
				return &l, nil
			}
		}
	}
	return nil, nil
}

// BusinessDate is the day the night audit has not closed yet.
func (h Desk) BusinessDate(ctx context.Context) (string, error) { return h.businessDate(ctx) }

// PayOrders is the mock's guestPay: the open room service link, else a QRIS link for every
// delivered order the stay still owes, opened by the guest.
func (h Desk) PayOrders(ctx context.Context, bookingID, payer string) (json.RawMessage, error) {
	var out json.RawMessage
	err := h.inTx(ctx, func(ctx context.Context) error {
		if err := h.expire(ctx); err != nil {
			return err
		}
		b, pl, err := h.placeOfStay(ctx, bookingID)
		if err != nil {
			return err
		}
		pays, err := h.stayPayments(ctx, b.ID)
		if err != nil {
			return err
		}
		open, err := h.orderLink(ctx, b.ID, pays)
		if err != nil || open != nil {
			out = mustJSON(open)
			return err
		}
		unpaid, dues, err := h.unpaidOrders(ctx, b, "unpaid")
		if err != nil {
			return err
		}
		if len(unpaid) == 0 {
			return errs.New("ORDER_NOT_BILLABLE", "Nothing delivered is waiting to be paid.")
		}
		var amount int64
		ids := make([]string, len(unpaid))
		for i, o := range unpaid {
			amount += dues[i]
			ids[i] = o.ID
		}
		l, _, err := h.openLink(ctx, GuestActor, b, pl, linkPart{kind: "extra", amount: amount, orderIDs: ids}, "qris", strings.TrimSpace(payer), nil)
		out = mustJSON(l)
		return err
	})
	return out, err
}
