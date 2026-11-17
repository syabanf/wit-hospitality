package housekeeping

import (
	"context"
	"net/http"

	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// GuestCleaner adds, or finds, today's stayover task for a stay in house when the guest asks for a
// clean from the stay page, and tells services so it logs one cleaning request for the task. The
// composition root hands reservation the in-process answer (housekeeping/module) in the monolith
// and GuestCleanHTTP in split mode.
type GuestCleaner interface {
	GuestClean(ctx context.Context, bookingID, note string) error
}

// GuestCleanHTTP calls the housekeeping service's POST /internal/v1/housekeeping/guest-clean with
// INTERNAL_TOKEN.
type GuestCleanHTTP struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

// GuestCleanCall is the body of POST /internal/v1/housekeeping/guest-clean.
type GuestCleanCall struct {
	BookingID string `json:"bookingId"`
	Note      string `json:"note"`
}

// GuestClean calls POST /internal/v1/housekeeping/guest-clean.
func (h GuestCleanHTTP) GuestClean(ctx context.Context, bookingID, note string) error {
	return httpx.InternalPost(ctx, h.Client, h.BaseURL+"/internal/v1/housekeeping/guest-clean", h.Token, GuestCleanCall{BookingID: bookingID, Note: note}, nil)
}
