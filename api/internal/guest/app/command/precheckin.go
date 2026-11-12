package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// ApplyPreCheckIn copies an online check-in the front desk verified onto the lead guest's profile
// and the stay's companions, the guest half of the mock's precheckin.verify. Reservation calls it
// through guest.Client and writes the one audit line for the verification, so this records none.
// It needs guest/edit or booking/edit and an open stay in scope.
type ApplyPreCheckIn struct{ Deps }

// Handle applies the travellers and returns the names of the companions it registered.
func (h ApplyPreCheckIn) Handle(ctx context.Context, p auth.Principal, pre guest.PreCheckIn) ([]string, error) {
	if err := h.Authz.Require(ctx, p.Role, profileEdit...); err != nil {
		return nil, err
	}
	names := []string{}
	if len(pre.Travellers) == 0 {
		return names, nil
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		_, villa, err := h.openStay(ctx, p, pre.BookingID)
		if err != nil {
			return err
		}
		g, err := h.Repo.Guest(ctx, pre.GuestID)
		if err != nil {
			return err
		}
		g.ApplyLead(pre.Travellers[0], pre.Email, pre.Phone)
		if err := h.Repo.UpdateGuest(ctx, &g); err != nil {
			return err
		}
		if err := h.guestEvent(ctx, guest.EventGuestUpdated, g); err != nil {
			return err
		}
		existing, err := h.Repo.CompanionsOf(ctx, pre.BookingID)
		if err != nil {
			return err
		}
		for _, t := range pre.Travellers[1:] {
			if known := domain.MatchCompanion(existing, t); known != nil {
				known.ApplyTraveller(t)
				if err := h.Repo.UpdateCompanion(ctx, known); err != nil {
					return err
				}
				if err := h.companionEvent(ctx, guest.EventCompanionUpdated, *known, villa.ID); err != nil {
					return err
				}
				names = append(names, known.Name)
				continue
			}
			n, err := h.Repo.Next(ctx, "companion")
			if err != nil {
				return err
			}
			c := domain.Companion{ID: fmt.Sprintf("cmp-%d", n), BookingID: pre.BookingID}
			c.ApplyTraveller(t)
			if err := h.Repo.InsertCompanion(ctx, &c); err != nil {
				return err
			}
			if err := h.companionEvent(ctx, guest.EventCompanionAdded, c, villa.ID); err != nil {
				return err
			}
			names = append(names, c.Name)
		}
		return nil
	})
	return names, err
}
