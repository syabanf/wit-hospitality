package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/inventory/domain"
)

// Turnovers books the stock housekeeping moves: the amenity kit a room takes when it turns ready
// and the linen it discards. It runs inside the projector's transaction for
// housekeeping.room.released.v1 and housekeeping.linen.discarded.v1.
type Turnovers struct{ Deps }

// Released is the mock's issueKit: the room type's kit leaves the villa store, as much as the
// store holds; a short store issues what is there and never blocks the room.
func (h Turnovers) Released(ctx context.Context, e housekeeping.RoomReleased) error {
	if e.GroupID == nil {
		return nil
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		kit, ok, err := h.Repo.Kit(ctx, *e.GroupID)
		if err != nil || !ok {
			return err
		}
		b, err := h.open(ctx, e.By)
		if err != nil {
			return err
		}
		issue, _ := domain.KitIssue(kit, func(itemID string) int { return b.Held(e.VillaID, itemID) })
		for _, l := range issue {
			if _, err := b.Push(ctx, domain.Movement{VillaID: e.VillaID, ItemID: l.ItemID, Kind: domain.Issue, Quantity: -l.Quantity, On: e.On,
				UnitID: ptr(e.UnitID), Reason: "Amenity kit, " + e.UnitCode + " ready"}); err != nil {
				return err
			}
		}
		return b.Close(ctx)
	})
}

// Discarded is the mock's writeOff for linen discards and laundry losses. The pieces are gone
// already, so a short store does not refuse it: the write-off is booked in full and the next
// count puts the store right.
func (h Turnovers) Discarded(ctx context.Context, e housekeeping.LinenDiscarded) error {
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		b, err := h.open(ctx, e.By)
		if err != nil {
			return err
		}
		for _, l := range e.Lines {
			if _, err := b.Item(l.ItemID); err != nil {
				continue
			}
			if _, err := b.Push(ctx, domain.Movement{VillaID: e.VillaID, ItemID: l.ItemID, Kind: domain.WriteOff, Quantity: -l.Quantity, On: e.On, Reason: e.Reason}); err != nil {
				return err
			}
		}
		return b.Close(ctx)
	})
}
