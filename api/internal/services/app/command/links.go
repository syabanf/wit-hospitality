package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

// OrdersLinked follows billing's payment_link.created: an open link points each order it asks for
// at the pending payment that carries it, as the mock's openLink does, so the board reads it
// pending. As in the mock the order keeps that payment afterwards: payment.recorded adds the paid
// step, and a link that fails, expires or is cancelled leaves the payment in that status, which
// reads unpaid. It runs in the projector's transaction; an order services does not hold is skipped.
type OrdersLinked struct{ Deps }

// Handle points the link's orders at their payments.
func (h OrdersLinked) Handle(ctx context.Context, e billing.PaymentLinkSaved) error {
	if e.Link.Status != "pending" {
		return nil
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		for i, id := range e.OrderIDs {
			if i >= len(e.OrderPaymentIDs) {
				break
			}
			o, err := h.Repo.Order(ctx, id)
			if errs.HasCode(err, errs.CodeNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			if domain.MarkPending(&o, e.OrderPaymentIDs[i]) {
				if err := h.Repo.UpdateOrder(ctx, &o); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
