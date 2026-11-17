package command

import (
	"context"
	"log/slog"

	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// GuestPostingRequested is the reaction to guest's folio_posting.requested: a complaint's credit,
// an incident's damage or a lost safe box key on the stay's folio, as whoever asked. It runs in
// the projector's transaction and posts once per source, so a redelivered or replayed request
// adds nothing. A stay no longer in house is skipped: guest checked it, so only a check-out that
// raced the request lands here, and retrying would never post.
type GuestPostingRequested struct{ Deps }

// Handle posts the credit or the charge.
func (h GuestPostingRequested) Handle(ctx context.Context, e guest.FolioPostingRequested) error {
	if e.Amount <= 0 {
		return nil
	}
	if err := h.Store.Lock(ctx); err != nil {
		return err
	}
	b, err := h.stay(ctx, e.BookingID)
	if err != nil {
		return err
	}
	if b.Status != "checked_in" {
		slog.Default().WarnContext(ctx, "guest folio posting skipped: stay not in house", "source", e.SourceID, "booking", e.BookingID, "status", b.Status)
		return nil
	}
	pl, err := h.Store.Place(ctx, b.UnitID)
	if err != nil {
		return err
	}
	tax, err := h.tax(ctx)
	if err != nil {
		return err
	}
	rates := domain.RatesOn(&tax, h.today())
	fields := domain.Posting{Kind: domain.KindCharge, Code: domain.OtherCode, Description: e.Description, Part: domain.PartCharges}
	split := domain.Split(e.Amount, fields.Code, rates, domain.StayMode(b))
	if e.Kind == guest.FolioPostingCredit {
		// A credit corrects no line, and the folio adds the tax of a lineless rebate as a charge, so it
		// carries none: the whole amount comes off the bill on the room code.
		fields.Kind, fields.Code = domain.KindRebate, domain.RoomCode
		split = domain.TaxSplit{Net: e.Amount}
	}
	fields.Amount, fields.Service, fields.PB1 = split.Net, ptr(split.Service), ptr(split.PB1)
	by := auth.Principal{UserID: e.ByID, Name: e.By}
	posting, err := h.newPosting(ctx, by, b, fields)
	if err != nil {
		return err
	}
	if claimed, err := h.Store.ClaimGuestPosting(ctx, e.SourceID, posting.ID); err != nil || !claimed {
		return err
	}
	if err := h.addPosting(ctx, b, pl, posting); err != nil {
		return err
	}
	return h.postingAudit(ctx, by, b, posting)
}
