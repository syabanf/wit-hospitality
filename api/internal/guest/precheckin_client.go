package guest

import (
	"context"
	"net/http"

	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// Traveller is one adult's document from the online check-in, under the names of
// TravellerDocument in src/domain/precheckin.ts.
type Traveller struct {
	Name           string `json:"name"`
	Nationality    string `json:"nationality"`
	DocumentType   string `json:"documentType"`
	DocumentNumber string `json:"documentNumber"`
	DocumentExpiry string `json:"documentExpiry"`
	DateOfBirth    string `json:"dateOfBirth"`
	Sex            string `json:"sex"`
	EntryDate      string `json:"entryDate"`
	PortOfEntry    string `json:"portOfEntry"`
	VisaType       string `json:"visaType"`
}

// PreCheckIn is the part of a verified online check-in that belongs to guest: the stay, its lead
// guest, the contact the guest gave and one document per adult, the lead guest first.
type PreCheckIn struct {
	BookingID  string      `json:"bookingId"`
	GuestID    string      `json:"guestId"`
	Email      string      `json:"email"`
	Phone      string      `json:"phone"`
	Travellers []Traveller `json:"travellers"`
}

// AppliedPreCheckIn is the body of POST /internal/v1/pre-checkins.
type AppliedPreCheckIn struct {
	Principal  auth.Principal `json:"principal"`
	PreCheckIn PreCheckIn     `json:"preCheckIn"`
}

// ApplyPreCheckIn calls POST /internal/v1/pre-checkins.
func (h HTTPClient) ApplyPreCheckIn(ctx context.Context, p auth.Principal, pre PreCheckIn) ([]string, error) {
	var out []string
	err := h.call(ctx, http.MethodPost, "/internal/v1/pre-checkins", AppliedPreCheckIn{Principal: p, PreCheckIn: pre}, &out)
	return out, err
}
