package guest

import (
	"context"
	"net/http"
)

// StayComplaint is what a guest tells the stay page went wrong; reservation has checked the token.
type StayComplaint struct {
	BookingID   string `json:"bookingId"`
	Category    string `json:"category"`
	Description string `json:"description"`
}

// Filed is the complaint the stay page filed.
type Filed struct {
	Number string `json:"number"`
}

// Complaints files a complaint from the guest's stay page as an open complaint by "Guest".
// Reservation calls it in process, or StayComplaints over HTTP in split mode.
type Complaints interface {
	FileFromStay(ctx context.Context, in StayComplaint) (Filed, error)
}

// FileFromStay calls POST /internal/v1/complaints/stay.
func (h HTTPClient) FileFromStay(ctx context.Context, in StayComplaint) (Filed, error) {
	var out Filed
	err := h.call(ctx, http.MethodPost, "/internal/v1/complaints/stay", in, &out)
	return out, err
}
