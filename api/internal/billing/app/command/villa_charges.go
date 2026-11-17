package command

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// VillaCharge is a charge villa operations ask billing to put on a stay's folio: a damaged item
// an inventory check found, or a long stay's utility usage (villa-operations-contract.md).
type VillaCharge struct {
	// Key names the charge in stay_charges: "damage:<checkId>:<itemId>" or "utility:<readingId>".
	Key         string
	BookingID   string
	Code        string
	Description string
	Amount      int64
	By, ByID    string
}

// VillaChargePosted is the reaction to inventory.damage.charged and a guest-paid
// maintenance.utility.billed: it posts the charge as whoever asked, once per key.
type VillaChargePosted struct{ Deps }

// Handle posts the charge.
func (h VillaChargePosted) Handle(ctx context.Context, c VillaCharge) error {
	return h.postFee(ctx, c.BookingID, auth.Principal{UserID: c.ByID, Name: c.By}, c.Code, c.Description, c.Amount, func(postingID string) (bool, error) {
		return h.Store.ClaimStayCharge(ctx, c.Key, postingID)
	})
}
