package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// FollowListingBaseRate is property's policy on channel.listing.priced: the base price set on a
// unit's Airbnb listing is the unit's nightly rate, which property owns, so the unit moves to it
// and publishes unit.updated. Channel already checked the permission and recorded the audit line.
// A unit already at the price, or one property does not know, is left alone, so a redelivery or a
// replay changes nothing.
type FollowListingBaseRate struct{ Deps }

// Handle applies the base rate inside the projector's transaction.
func (h FollowListingBaseRate) Handle(ctx context.Context, unitID string, baseRate int64) error {
	if baseRate <= 0 {
		return nil
	}
	return h.DB.InTx(ctx, func(ctx context.Context) error {
		u, err := h.Repo.Unit(ctx, unitID)
		if errs.HasCode(err, errs.CodeNotFound) {
			return nil
		}
		if err != nil || u.NightlyRate == baseRate {
			return err
		}
		villa, err := h.Repo.Villa(ctx, u.VillaID)
		if err != nil {
			return err
		}
		u.NightlyRate = baseRate
		if err := h.Repo.UpdateUnit(ctx, &u); err != nil {
			return err
		}
		return h.unitEvent(ctx, property.EventUnitUpdated, u, villa.LocationID)
	})
}
