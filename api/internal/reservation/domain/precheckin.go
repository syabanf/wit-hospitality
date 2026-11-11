package domain

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// TravellerDocument is one adult's identity document.
type TravellerDocument struct {
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

// PreCheckInInput is what the guest fills in on /checkin/:token. ID photos are files records the
// files context owns; they pass through as sent.
type PreCheckInInput struct {
	Email         string              `json:"email"`
	Phone         string              `json:"phone"`
	ArrivalTime   string              `json:"arrivalTime"`
	Flight        string              `json:"flight"`
	Adults        float64             `json:"adults"`
	Children      float64             `json:"children"`
	Travellers    []TravellerDocument `json:"travellers"`
	IDPhotos      []map[string]any    `json:"idPhotos"`
	RulesName     string              `json:"rulesName"`
	RulesAccepted bool                `json:"rulesAccepted"`
}

// PreCheckIn is a sent or verified online check-in.
type PreCheckIn struct {
	BookingID     string              `json:"bookingId"`
	Email         string              `json:"email"`
	Phone         string              `json:"phone"`
	ArrivalTime   string              `json:"arrivalTime"`
	Flight        string              `json:"flight"`
	Adults        int                 `json:"adults"`
	Children      int                 `json:"children"`
	Travellers    []TravellerDocument `json:"travellers"`
	IDPhotos      []json.RawMessage   `json:"idPhotos"`
	RulesName     string              `json:"rulesName"`
	RulesAccepted bool                `json:"rulesAccepted"`
	Status        string              `json:"status"`
	SubmittedAt   string              `json:"submittedAt"`
	VerifiedBy    *string             `json:"verifiedBy"`
	VerifiedByID  *string             `json:"verifiedById"`
	VerifiedAt    *string             `json:"verifiedAt"`
	Version       int64               `json:"-"`
}

// HouseRules is HOUSE_RULES.
var HouseRules = []string{
	"Check-in from 14:00, check-out by 12:00.",
	"Quiet hours from 22:00 to 07:00.",
	"No smoking inside the rooms; use the garden.",
	"No glass by the pool, and children swim with an adult.",
	"Visitors register at the front desk; no parties without the manager’s approval.",
	"Damage and missing items are charged at check-out.",
}

var (
	indonesian  = regexp.MustCompile(`(?i)^(indonesia|indonesian|id)$`)
	emailRe     = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	phoneRe     = regexp.MustCompile(`^\+?[\d\s-]{7,}$`)
	clockTimeRe = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

// IsIndonesian is isIndonesian.
func IsIndonesian(nationality string) bool { return indonesian.MatchString(Trim(nationality)) }

// ValidatePreCheckIn is validatePreCheckIn; keys follow the form, travellers.0.documentNumber.
func ValidatePreCheckIn(in PreCheckInInput, checkIn, checkOut string) error {
	var f errs.Fields
	short := func(s string, n int) bool { return len([]rune(Trim(s))) < n }
	if in.Email != "" && !emailRe.MatchString(in.Email) {
		f.Add("email", "Enter a valid email address.")
	}
	if !phoneRe.MatchString(in.Phone) {
		f.Add("phone", "Enter a mobile number with the country code.")
	}
	if !clockTimeRe.MatchString(in.ArrivalTime) {
		f.Add("arrivalTime", "Enter the time you expect to arrive.")
	}
	if !whole(in.Adults) || in.Adults < 1 || in.Adults > 12 {
		f.Add("adults", "1 to 12 adults.")
	}
	if !whole(in.Children) || in.Children < 0 || in.Children > 12 {
		f.Add("children", "0 to 12 children.")
	}
	if float64(len(in.Travellers)) != in.Adults {
		f.Add("travellers", "Add the ID of every adult.")
	}
	for i, t := range in.Travellers {
		at := func(field, text string) { f.Add(fmt.Sprintf("travellers.%d.%s", i, field), text) }
		if short(t.Name, 2) {
			at("name", "Enter the name as on the document.")
		}
		if Trim(t.Nationality) == "" {
			at("nationality", "Enter the nationality.")
		}
		if short(t.DocumentNumber, 5) {
			at("documentNumber", "Enter the document number.")
		}
		if !isoDate.MatchString(t.DateOfBirth) || t.DateOfBirth >= checkIn {
			at("dateOfBirth", "Enter the date of birth.")
		}
		if t.DocumentType == "passport" {
			if !isoDate.MatchString(t.DocumentExpiry) {
				at("documentExpiry", "Enter the expiry date.")
			} else if t.DocumentExpiry <= checkOut {
				at("documentExpiry", "The passport expires before the stay ends.")
			}
		}
		if !IsIndonesian(t.Nationality) {
			if !isoDate.MatchString(t.EntryDate) || t.EntryDate > checkIn {
				at("entryDate", "Enter the day you enter Indonesia, on or before arrival.")
			}
			if short(t.PortOfEntry, 3) {
				at("portOfEntry", "Enter the airport or port of entry.")
			}
			if t.VisaType == "none" {
				at("visaType", "Pick the visa you enter on.")
			}
		}
	}
	if len(in.IDPhotos) == 0 {
		f.Add("idPhotos", "Upload a photo of the lead guest’s ID.")
	}
	if short(in.RulesName, 2) {
		f.Add("rulesName", "Type your full name to sign.")
	}
	if !in.RulesAccepted {
		f.Add("rulesAccepted", "Accept the house rules.")
	}
	return f.Err()
}

// LinkExpired is linkExpired: the link stops once the stay is over or called off.
func LinkExpired(b Booking, today string) bool { return b.Over() || b.CheckOut < today }

// GuestCanEdit is guestCanEdit: until the desk verifies or checks the guest in.
func GuestCanEdit(b Booking, pre *PreCheckIn) bool {
	return (b.Status == Confirmed || b.Status == Draft) && (pre == nil || pre.Status != "verified")
}

var notAlnum = regexp.MustCompile(`[^a-zA-Z0-9]`)

// CheckinToken is checkinTokenFor: a deterministic token from the booking id, as the mock signs
// it so links the console prints work against the API.
func CheckinToken(bookingID string) string { return tokenFor("checkin", "ci", bookingID) }

func tokenFor(purpose, prefix, bookingID string) string {
	h := uint32(2166136261)
	for _, c := range purpose + ":" + bookingID + ":bali-villas" {
		h = (h ^ uint32(c)) * 16777619
	}
	sig := strconv.FormatUint(uint64(h), 36)
	if len(sig) < 7 {
		sig = strings.Repeat("0", 7-len(sig)) + sig
	}
	return prefix + strings.ToLower(notAlnum.ReplaceAllString(bookingID, "")) + sig
}
