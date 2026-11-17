package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// postFee posts a fee reservation gave on the stay's folio as whoever gave it, inside the
// projector's transaction. claim records the posting under the fee's own key and answers false when
// the fee was posted before, so a redelivered or replayed event adds nothing.
func (d Deps) postFee(ctx context.Context, bookingID string, by auth.Principal, code, description string, charge int64, claim func(postingID string) (bool, error)) error {
	if charge <= 0 {
		return nil
	}
	if err := d.Store.Lock(ctx); err != nil {
		return err
	}
	b, err := d.stay(ctx, bookingID)
	if err != nil {
		return err
	}
	pl, err := d.Store.Place(ctx, b.UnitID)
	if err != nil {
		return err
	}
	tax, err := d.tax(ctx)
	if err != nil {
		return err
	}
	split := domain.Split(charge, code, domain.RatesOn(&tax, d.today()), domain.StayMode(b))
	posting, err := d.newPosting(ctx, by, b, domain.Posting{Kind: domain.KindCharge, Code: code, Description: description, Amount: split.Net,
		Service: ptr(split.Service), PB1: ptr(split.PB1), Part: domain.PartCharges})
	if err != nil {
		return err
	}
	if claimed, err := claim(posting.ID); err != nil || !claimed {
		return err
	}
	if err := d.addPosting(ctx, b, pl, posting); err != nil {
		return err
	}
	return d.postingAudit(ctx, by, b, posting)
}

// StayCharged is the reaction to reservation's early_checkin.granted and key.charged: it posts an
// early check-in once per stay and a lost or unreturned key once per key.
type StayCharged struct{ Deps }

// Handle posts the charge.
func (h StayCharged) Handle(ctx context.Context, e reservation.StayCharged) error {
	return h.postFee(ctx, e.BookingID, auth.Principal{UserID: e.ByID, Name: e.By}, e.Code, e.Description, e.Charge, func(postingID string) (bool, error) {
		return h.Store.ClaimStayCharge(ctx, e.ChargeKey(), postingID)
	})
}
