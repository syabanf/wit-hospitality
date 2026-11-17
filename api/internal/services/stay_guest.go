package services

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
)

// GuestStay is what services shows the guest's stay page: the villa's menu without costs or
// partners, the stay's orders and its requests, each in the console's JSON (GuestMenuItem[],
// GuestOrder[], GuestRequest[]).
type GuestStay struct {
	Menu     json.RawMessage `json:"menu"`
	Orders   json.RawMessage `json:"orders"`
	Requests json.RawMessage `json:"requests"`
}

// StayGuests is what reservation's stay page asks services. Reservation has checked the stay
// token; services runs its own rules (hours, villaOnRequest, menu prices) in the guest's name. The
// composition root hands reservation the in-process answer (services/module) in the monolith and
// StayGuestsHTTP in split mode.
type StayGuests interface {
	GuestStay(ctx context.Context, bookingID string) (GuestStay, error)
	// GuestOrder places the order (OrderInput) at menu prices on the stay's folio and returns what
	// was ordered, "2 × Nasi goreng (SO-715)".
	GuestOrder(ctx context.Context, bookingID string, input json.RawMessage) (string, error)
	// GuestRequest logs the request for the desk, or the villa host on a villa stay, and returns its
	// number.
	GuestRequest(ctx context.Context, bookingID, kind, note string) (string, error)
}

// StayGuestCall is the body of the /internal/v1/services/stay routes.
type StayGuestCall struct {
	BookingID string          `json:"bookingId"`
	Input     json.RawMessage `json:"input,omitempty"`
	Kind      string          `json:"kind,omitempty"`
	Note      string          `json:"note,omitempty"`
}

// StayGuestsHTTP calls the services service's /internal/v1/services/stay routes with INTERNAL_TOKEN.
type StayGuestsHTTP struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func (h StayGuestsHTTP) post(ctx context.Context, path string, in StayGuestCall, out any) error {
	return httpx.InternalPost(ctx, h.Client, h.BaseURL+"/internal/v1/services/stay"+path, h.Token, in, out)
}

// GuestStay calls POST /internal/v1/services/stay.
func (h StayGuestsHTTP) GuestStay(ctx context.Context, bookingID string) (GuestStay, error) {
	var out GuestStay
	err := h.post(ctx, "", StayGuestCall{BookingID: bookingID}, &out)
	return out, err
}

// GuestOrder calls POST /internal/v1/services/stay/orders.
func (h StayGuestsHTTP) GuestOrder(ctx context.Context, bookingID string, input json.RawMessage) (string, error) {
	var out struct {
		Summary string `json:"summary"`
	}
	err := h.post(ctx, "/orders", StayGuestCall{BookingID: bookingID, Input: input}, &out)
	return out.Summary, err
}

// GuestRequest calls POST /internal/v1/services/stay/requests.
func (h StayGuestsHTTP) GuestRequest(ctx context.Context, bookingID, kind, note string) (string, error) {
	var out struct {
		Number string `json:"number"`
	}
	err := h.post(ctx, "/requests", StayGuestCall{BookingID: bookingID, Kind: kind, Note: note}, &out)
	return out.Number, err
}
