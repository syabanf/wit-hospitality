package domain

import (
	"fmt"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// IsForeign reports a nationality other than Indonesian.
func (d TravelDocument) IsForeign() bool { return d.Nationality != HomeCountry }

func blank(s *string) bool { return s == nil || *s == "" }

// ForeignDataMissing is foreignDataMissing: the APOA fields a foreign adult still lacks, in words
// for the refusal. Indonesians need none.
func ForeignDataMissing(d TravelDocument) []string {
	if !d.IsForeign() {
		return []string{}
	}
	missing := []string{}
	if d.IDType == "ktp" {
		missing = append(missing, "a passport or stay permit")
	}
	if strings.TrimSpace(d.IDNumber) == "" {
		missing = append(missing, "document number")
	}
	if blank(d.IDExpiry) {
		missing = append(missing, "document expiry")
	}
	if blank(d.BirthDate) {
		missing = append(missing, "date of birth")
	}
	if blank(d.Sex) {
		missing = append(missing, "sex")
	}
	if blank(d.EntryDate) {
		missing = append(missing, "date of entry")
	}
	if strings.TrimSpace(d.EntryPort) == "" {
		missing = append(missing, "port of entry")
	}
	if blank(d.VisaType) {
		missing = append(missing, "visa type")
	}
	return missing
}

// DocumentExpired is documentExpired: the document ran out before on.
func DocumentExpired(d TravelDocument, on string) bool {
	return !blank(d.IDExpiry) && *d.IDExpiry < on
}

// UnregisteredAdults is unregisteredAdults: adults on the booking nobody registered yet.
func UnregisteredAdults(adults *int, registered int) int {
	n := 0
	if adults != nil {
		n = *adults
	}
	return max(0, n-registered)
}

// Person is one person on a stay with a name and a travel document.
type Person struct {
	ID    string
	Name  string
	Adult bool
	Doc   TravelDocument
}

// CheckInReady is assertCheckInReady: every foreign adult on the stay needs the APOA fields
// (FOREIGN_DATA_MISSING) and a document still valid on the day (DOCUMENT_EXPIRED).
func CheckInReady(people []Person, on string) error {
	var gaps []string
	for _, p := range people {
		if !p.Adult {
			continue
		}
		if missing := ForeignDataMissing(p.Doc); len(missing) > 0 {
			gaps = append(gaps, fmt.Sprintf("%s: %s", p.Name, strings.Join(missing, ", ")))
		}
	}
	if len(gaps) > 0 {
		return errs.Newf("FOREIGN_DATA_MISSING", "Immigration needs more for %s.", strings.Join(gaps, "; "))
	}
	for _, p := range people {
		if p.Adult && p.Doc.IsForeign() && DocumentExpired(p.Doc, on) {
			return errs.Newf("DOCUMENT_EXPIRED", "%s's %s expired on %s. Ask for a valid one before check-in.", p.Name, strings.ToLower(IDTypeLabel[p.Doc.IDType]), *p.Doc.IDExpiry)
		}
	}
	return nil
}

// ReportDueAt is reportDueAt: Immigration expects the report within 24 hours of check-in.
func ReportDueAt(checkedInOn, arrivalTime string) string {
	if arrivalTime == "" {
		arrivalTime = "14:00"
	}
	return clock.AddDays(checkedInOn, 1) + "T" + arrivalTime
}

// ReportOverdue is reportOverdue; now is `YYYY-MM-DDTHH:MM`.
func ReportOverdue(checkedInOn, arrivalTime, now string) bool {
	return now > ReportDueAt(checkedInOn, arrivalTime)
}

// ApoaColumns is APOA_COLUMNS, the column order of the export. See src/domain/guest.ts for the
// sources it was checked against; the operator confirms it against their APOA template.
var ApoaColumns = []string{"Full name", "Sex", "Place of birth", "Date of birth", "Nationality", "Document type", "Document number", "Document expiry", "Visa type", "Date of entry", "Port of entry", "Address in Indonesia", "Check-in date", "Planned check-out", "Room"}

// ApoaStay is the stay part of an APOA row.
type ApoaStay struct {
	CheckIn  string
	CheckOut string
	Room     string
	Address  string
}

func orEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ApoaRow is apoaRow: one person in the export's column order.
func ApoaRow(name string, d TravelDocument, stay ApoaStay) []string {
	sex := ""
	switch orEmpty(d.Sex) {
	case "male":
		sex = "M"
	case "female":
		sex = "F"
	}
	visa := ""
	if d.VisaType != nil {
		visa = VisaTypeLabel[*d.VisaType]
	}
	address := d.AddressInIndonesia
	if address == "" {
		address = stay.Address
	}
	return []string{name, sex, d.BirthPlace, orEmpty(d.BirthDate), d.Nationality, IDTypeLabel[d.IDType], d.IDNumber, orEmpty(d.IDExpiry), visa, orEmpty(d.EntryDate), d.EntryPort, address, stay.CheckIn, stay.CheckOut, stay.Room}
}

// ForeignReport is one person on one stay sent to Immigration. PersonID is a guest or companion id.
type ForeignReport struct {
	ID         string `json:"id"`
	BookingID  string `json:"bookingId"`
	PersonID   string `json:"personId"`
	ReportedAt string `json:"reportedAt"`
	ReportedBy string `json:"reportedBy"`
	Reference  string `json:"reference"`
}

// ReportInput is the body of POST /foreign-reports.
type ReportInput struct {
	BookingID string   `json:"bookingId"`
	PersonIDs []string `json:"personIds"`
	Reference string   `json:"reference"`
}

// Companion is another person staying with the lead guest.
type Companion struct {
	Name  string `json:"name"`
	Adult bool   `json:"adult"`
	TravelDocument
	ID        string `json:"id"`
	BookingID string `json:"bookingId"`
	Version   int64  `json:"-"`
}

// CompanionInput is CompanionInput.
type CompanionInput struct {
	Name  string `json:"name"`
	Adult bool   `json:"adult"`
	TravelDocument
}

// ValidateCompanion is validateCompanion, in its field order.
func ValidateCompanion(in CompanionInput) error {
	var f errs.Fields
	if len([]rune(strings.TrimSpace(in.Name))) < 2 {
		f.Add("name", "Enter the companion’s name.")
	}
	if _, ok := Countries[in.Nationality]; !ok {
		f.Add("nationality", "Pick the nationality.")
	}
	for _, d := range []struct {
		field string
		value *string
	}{{"idExpiry", in.IDExpiry}, {"birthDate", in.BirthDate}, {"entryDate", in.EntryDate}} {
		if badDay(d.value) {
			f.Add(d.field, "Enter a date.")
		}
	}
	documentEnums(&f, in.IDType, in.Sex, in.VisaType)
	return f.Err()
}

// Apply sets the trimmed input on the companion.
func (c *Companion) Apply(in CompanionInput) {
	c.Name, c.Adult, c.TravelDocument = strings.TrimSpace(in.Name), in.Adult, in.TravelDocument
	c.IDNumber = strings.TrimSpace(in.IDNumber)
	c.IDExpiry, c.BirthDate, c.Sex = emptyToNil(c.IDExpiry), emptyToNil(c.BirthDate), emptyToNil(c.Sex)
	c.EntryDate, c.VisaType = emptyToNil(c.EntryDate), emptyToNil(c.VisaType)
}

// Stay is what the guest context knows of a booking: enough to place people on it, check its
// state and report it to Immigration. The reservation context owns bookings.
type Stay struct {
	ID           string  `json:"id"`
	Code         string  `json:"code"`
	GuestID      string  `json:"guestId"`
	UnitID       string  `json:"unitId"`
	VillaID      string  `json:"villaId"`
	Status       string  `json:"status"`
	CheckIn      string  `json:"checkIn"`
	CheckOut     string  `json:"checkOut"`
	CheckedInOn  *string `json:"checkedInOn"`
	CheckedOutOn *string `json:"checkedOutOn"`
	ArrivalTime  string  `json:"arrivalTime"`
	Adults       *int    `json:"adults"`
}

// Closed reports a stay companions can no longer change.
func (s Stay) Closed() bool {
	return s.Status == "checked_out" || s.Status == "cancelled" || s.Status == "no_show"
}

// Started reports a stay that has checked in.
func (s Stay) Started() bool { return s.Status == "checked_in" || s.Status == "checked_out" }

// ErrStayClosed is openStay's refusal.
func ErrStayClosed(code string) error {
	return errs.Newf("BOOKING_INVALID_STATE", "%s is closed; companions cannot change.", code)
}

// VillaRef is what guest keeps of a villa, projected from property events.
type VillaRef struct {
	ID         string
	LocationID string
	Name       string
}

// UnitRef is what guest keeps of a unit, projected from property events.
type UnitRef struct {
	ID      string
	VillaID string
	Code    string
}

// StayPlace is a stay with the place it sits in, for the Immigration list.
type StayPlace struct {
	Stay
	LocationID   string
	VillaName    string
	LocationName string
	LocationArea string
	UnitCode     string
}

// CheckedIn is the day the stay checked in, else the booked arrival.
func (s Stay) CheckedIn() string {
	if s.CheckedInOn != nil {
		return *s.CheckedInOn
	}
	return s.CheckIn
}
