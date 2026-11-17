package bootstrap

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	reservationcommand "github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
)

// lateComplaints is the guest relations client reservation's stay page files complaints through,
// read once guest is built: in process, or guest.HTTPClient to GUEST_URL. Without either the page
// answers NOT_AVAILABLE.
type lateComplaints struct{ client func() guest.Complaints }

func (l lateComplaints) FileFromStay(ctx context.Context, in guest.StayComplaint) (guest.Filed, error) {
	c := l.client()
	if c == nil {
		return guest.Filed{}, reservationcommand.NotAvailable("Guest relations")
	}
	return c.FileFromStay(ctx, in)
}
