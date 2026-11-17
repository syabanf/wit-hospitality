package clients

import (
	"context"
	"encoding/json"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/services"
)

// Housekeeping asks housekeeping for the guest's clean through its published client. Client
// returns the client once the composition root has built it, nil while no housekeeping runs; the
// call then answers NOT_AVAILABLE.
type Housekeeping struct {
	Client func() housekeeping.GuestCleaner
}

// GuestClean adds or finds today's stayover in the guest's name.
func (h Housekeeping) GuestClean(ctx context.Context, bookingID, note string) error {
	if h.Client == nil || h.Client() == nil {
		return command.NotAvailable("Housekeeping")
	}
	return h.Client().GuestClean(ctx, bookingID, note)
}

// Services asks services for the stay page's menu, orders and requests through its published
// client; nil answers NOT_AVAILABLE, which the page reads as no menu.
type Services struct {
	Client func() services.StayGuests
}

func (s Services) client() services.StayGuests {
	if s.Client == nil {
		return nil
	}
	return s.Client()
}

// GuestStay is the menu, orders and requests the guest sees.
func (s Services) GuestStay(ctx context.Context, bookingID string) (command.GuestServices, error) {
	c := s.client()
	if c == nil {
		return command.GuestServices{}, command.NotAvailable("Room service")
	}
	out, err := c.GuestStay(ctx, bookingID)
	return command.GuestServices{Menu: out.Menu, Orders: out.Orders, Requests: out.Requests}, err
}

// GuestOrder places the guest's order.
func (s Services) GuestOrder(ctx context.Context, bookingID string, input json.RawMessage) (string, error) {
	c := s.client()
	if c == nil {
		return "", command.NotAvailable("Room service")
	}
	return c.GuestOrder(ctx, bookingID, input)
}

// GuestRequest logs the guest's request.
func (s Services) GuestRequest(ctx context.Context, bookingID, kind, note string) (string, error) {
	c := s.client()
	if c == nil {
		return "", command.NotAvailable("Service requests")
	}
	return c.GuestRequest(ctx, bookingID, kind, note)
}
