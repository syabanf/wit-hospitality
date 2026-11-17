package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// StayCharge is a charge another context asks billing to put on a stay's folio: a damaged item an
// inventory check found, or a long stay's utility usage (villa-operations-contract.md).
type StayCharge struct {
	// SourceRef names the charge in the asking context; billing posts each once.
	SourceRef   string
	BookingID   string
	Code        string
	Description string
	Amount      int64
	By, ByID    string
}

// StayChargePosted is the reaction to inventory.damage.charged and maintenance.utility.billed: it
// posts the charge in the name of whoever asked, inside the projector's transaction, once per
// source reference, so a redelivered or replayed event adds nothing.
type StayChargePosted struct{ Deps }

// Handle posts the charge.
func (h StayChargePosted) Handle(ctx context.Context, c StayCharge) error {
	if c.Amount <= 0 {
		return nil
	}
	if err := h.Store.Lock(ctx); err != nil {
		return err
	}
	b, err := h.stay(ctx, c.BookingID)
	if err != nil {
		return err
	}
	pl, err := h.Store.Place(ctx, b.UnitID)
	if err != nil {
		return err
	}
	tax, err := h.tax(ctx)
	if err != nil {
		return err
	}
	by := auth.Principal{UserID: c.ByID, Name: c.By}
	split := domain.Split(c.Amount, c.Code, domain.RatesOn(&tax, h.today()), domain.StayMode(b))
	posting, err := h.newPosting(ctx, by, b, domain.Posting{Kind: domain.KindCharge, Code: c.Code, Description: c.Description, Amount: split.Net,
		Service: ptr(split.Service), PB1: ptr(split.PB1), Part: domain.PartCharges})
	if err != nil {
		return err
	}
	if claimed, err := h.Store.ClaimStayCharge(ctx, c.SourceRef, posting.ID); err != nil || !claimed {
		return err
	}
	if err := h.addPosting(ctx, b, pl, posting); err != nil {
		return err
	}
	return h.postingAudit(ctx, by, b, posting)
}
