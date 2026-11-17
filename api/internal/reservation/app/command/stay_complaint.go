package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// StayComplaintInput is the body of POST /stay/{token}/complaints.
type StayComplaintInput struct {
	Category    string `json:"category"`
	Description string `json:"description"`
}

// complaintLabel names the complaint categories as the stay page offers them.
var complaintLabel = map[string]string{
	"room": "Room", "cleanliness": "Cleanliness", "noise": "Noise", "service": "Service", "food": "Food and drinks",
	"billing": "Billing", "staff": "Staff", "facility": "Facilities", "other": "Other",
}

// Complain is POST /stay/{token}/complaints: guest files it as an open complaint, which checks the
// category and the description, and the stay keeps the guest action.
func (h StayPage) Complain(ctx context.Context, token string, in StayComplaintInput) (GuestStay, error) {
	return h.answer(ctx, token, domain.GuestComplaint, func(ctx context.Context, b *domain.Booking, _ domain.Catalog) (guestChange, error) {
		if h.Clients.Complaints == nil {
			return guestChange{}, NotAvailable("Guest relations")
		}
		filed, err := h.Clients.Complaints.FileFromStay(ctx, guest.StayComplaint{BookingID: b.ID, Category: in.Category, Description: in.Description})
		if err != nil {
			return guestChange{}, err
		}
		return guestChange{summary: fmt.Sprintf("Told us something went wrong: %s (%s)", complaintLabel[in.Category], filed.Number)}, nil
	})
}
