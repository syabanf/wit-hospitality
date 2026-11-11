package domain

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Enquiry statuses.
const (
	EnquiryNew       = "new"
	EnquiryContacted = "contacted"
	EnquiryConverted = "converted"
	EnquiryClosed    = "closed"
)

// EnquiryStatusLabel is ENQUIRY_STATUS_LABEL.
var EnquiryStatusLabel = map[string]string{EnquiryNew: "New", EnquiryContacted: "Contacted", EnquiryConverted: "Converted", EnquiryClosed: "Closed"}

// enquiryTransitions is ENQUIRY_TRANSITIONS: converted is the end; a closed enquiry can be picked
// up again.
var enquiryTransitions = map[string][]string{
	EnquiryNew:       {EnquiryContacted, EnquiryConverted, EnquiryClosed},
	EnquiryContacted: {EnquiryConverted, EnquiryClosed},
	EnquiryConverted: {},
	EnquiryClosed:    {EnquiryContacted},
}

// TopicOwner marks a villa owner asking about management; owners send no dates or party.
const TopicOwner = "owner"

// MaxParty is MAX_PARTY.
const MaxParty = 16

// MaxNights is MAX_NIGHTS in booking.ts.
const MaxNights = 90

// Countries holds the ISO codes of COUNTRIES in guest.ts, the nationalities a guest can pick.
var Countries = []string{"AE", "AT", "AU", "BE", "BR", "CA", "CH", "CN", "DE", "DK", "ES", "FI", "FR", "GB", "HK", "ID", "IE", "IL", "IN", "IT", "JP", "KR", "MY", "NG", "NL", "NO", "NZ", "PH", "PL", "PT", "RU", "SA", "SE", "SG", "TH", "TW", "US", "VN", "ZA"}

// EnquiryInput is the public request form. Guests stays a float until validation checks it is a
// whole number.
type EnquiryInput struct {
	Name     string  `json:"name"`
	Email    string  `json:"email"`
	WhatsApp string  `json:"whatsapp"`
	Country  string  `json:"country"`
	CheckIn  string  `json:"checkIn"`
	CheckOut string  `json:"checkOut"`
	Guests   float64 `json:"guests"`
	VillaID  string  `json:"villaId"`
	GroupID  *string `json:"groupId"`
	Note     string  `json:"note"`
	// Topic is empty for a stay, as every enquiry was before owners could write.
	Topic string `json:"topic,omitempty"`
}

// Owner reports a villa owner's note.
func (in EnquiryInput) Owner() bool { return in.Topic == TopicOwner }

// Enquiry is a request to book from the public website, or an owner's note.
type Enquiry struct {
	Name       string  `json:"name"`
	Email      string  `json:"email"`
	WhatsApp   string  `json:"whatsapp"`
	Country    string  `json:"country"`
	CheckIn    string  `json:"checkIn"`
	CheckOut   string  `json:"checkOut"`
	Guests     int     `json:"guests"`
	VillaID    string  `json:"villaId"`
	GroupID    *string `json:"groupId"`
	Note       string  `json:"note"`
	Topic      string  `json:"topic,omitempty"`
	ID         string  `json:"id"`
	Number     string  `json:"number"`
	Status     string  `json:"status"`
	BookingID  *string `json:"bookingId"`
	CreatedOn  string  `json:"createdOn"`
	CreatedAt  string  `json:"createdAt"`
	HandledBy  *string `json:"handledBy"`
	StatusNote string  `json:"statusNote"`
	Seq        int64   `json:"-"`
	Version    int64   `json:"-"`
}

// Owner reports a villa owner's note.
func (e Enquiry) Owner() bool { return e.Topic == TopicOwner }

// Receipt is what the website tells the guest after sending: no copy of their data.
type Receipt struct {
	Number    string `json:"number"`
	VillaName string `json:"villaName"`
	CheckIn   string `json:"checkIn"`
	CheckOut  string `json:"checkOut"`
}

// EnquiryNumber is enquiryNumber: ENQ-0001.
func EnquiryNumber(seq int64) string { return fmt.Sprintf("ENQ-%04d", seq) }

var whatsAppRe = regexp.MustCompile(`^\+?[\d\s-]{7,}$`)

// ValidateStay is validateStay in booking.ts.
func ValidateStay(checkIn, checkOut string) string {
	_, inErr := clock.ParseDate(checkIn)
	_, outErr := clock.ParseDate(checkOut)
	if !isoDateRe.MatchString(checkIn) || !isoDateRe.MatchString(checkOut) || inErr != nil || outErr != nil {
		return "Pick both dates."
	}
	n := clock.DaysBetween(checkIn, checkOut)
	if n < 1 {
		return "Check-out must be after check-in."
	}
	if n > MaxNights {
		return fmt.Sprintf("A stay is at most %d nights.", MaxNights)
	}
	return ""
}

// ValidateEnquiry is validateEnquiry plus the site service's room type check: groupVilla is the
// villa of the room type asked for, empty when the room type is unknown.
func ValidateEnquiry(in EnquiryInput, today, groupVilla string) error {
	var f errs.Fields
	if utf8.RuneCountInString(strings.TrimSpace(in.Name)) < 2 {
		f.Add("name", "Enter your name.")
	}
	if !emailRe.MatchString(strings.TrimSpace(in.Email)) {
		f.Add("email", "Enter an email address we can reply to.")
	}
	if !whatsAppRe.MatchString(strings.TrimSpace(in.WhatsApp)) {
		f.Add("whatsapp", "Enter a WhatsApp number with the country code.")
	}
	if !slices.Contains(Countries, in.Country) {
		f.Add("country", "Pick your country.")
	}
	note := utf8.RuneCountInString(in.Note)
	if in.Owner() {
		if utf8.RuneCountInString(strings.TrimSpace(in.Note)) < 10 {
			f.Add("note", "Tell us where the villa is and how many rooms it has.")
		} else if note > 1000 {
			f.Add("note", "Keep the note under 1,000 characters.")
		}
		return f.Err()
	}
	if stay := ValidateStay(in.CheckIn, in.CheckOut); stay != "" {
		f.Add("checkOut", stay)
	} else if in.CheckIn < today {
		f.Add("checkIn", "Pick a check-in date from today on.")
	}
	if in.Guests != math.Trunc(in.Guests) || in.Guests < 1 || in.Guests > MaxParty {
		f.Add("guests", fmt.Sprintf("Enter from 1 to %d guests.", MaxParty))
	}
	if in.VillaID == "" {
		f.Add("villaId", "Pick a villa.")
	}
	if note > 1000 {
		f.Add("note", "Keep the note under 1,000 characters.")
	}
	if in.GroupID != nil && *in.GroupID != "" && !f.Has("villaId") && groupVilla != in.VillaID {
		f.Add("groupId", "Pick a room type of this villa.")
	}
	return f.Err()
}

// NewEnquiry files the request as New. An owner's note keeps no villa, room type, dates or party.
func NewEnquiry(seq int64, in EnquiryInput, today, now string) Enquiry {
	e := Enquiry{
		Name: strings.TrimSpace(in.Name), Email: strings.TrimSpace(in.Email), WhatsApp: strings.TrimSpace(in.WhatsApp),
		Country: in.Country, CheckIn: in.CheckIn, CheckOut: in.CheckOut, Guests: int(in.Guests), VillaID: in.VillaID,
		GroupID: in.GroupID, Note: strings.TrimSpace(in.Note), Topic: in.Topic,
		ID: fmt.Sprintf("enq-%d", seq), Number: EnquiryNumber(seq), Status: EnquiryNew, CreatedOn: today, CreatedAt: now, Seq: seq,
	}
	if e.GroupID != nil && *e.GroupID == "" {
		e.GroupID = nil
	}
	if in.Owner() {
		e.VillaID, e.GroupID, e.CheckIn, e.CheckOut, e.Guests = "", nil, "", "", 0
	}
	return e
}

// Move is the adapter's move: it checks the transition and stamps who moved it and why.
func (e *Enquiry) Move(to, note, by string) error {
	if !slices.Contains(enquiryTransitions[e.Status], to) {
		return errs.Newf("ENQUIRY_INVALID_STATE", "%s is %s and cannot move to %s.", e.Number, EnquiryStatusLabel[e.Status], EnquiryStatusLabel[to])
	}
	e.Status, e.HandledBy, e.StatusNote = to, &by, strings.TrimSpace(note)
	return nil
}

// ValidateStatusChange checks the console's status form: contacted or closed, and a reason to
// close.
func ValidateStatusChange(status, note string) error {
	if status != EnquiryContacted && status != EnquiryClosed {
		return errs.Invalid("status", "Pick contacted or closed.")
	}
	if status == EnquiryClosed && utf8.RuneCountInString(strings.TrimSpace(note)) < 3 {
		return errs.Invalid("note", "Say why it is closed.")
	}
	return nil
}
