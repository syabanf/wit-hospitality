package domain

import (
	"fmt"
	"net/mail"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Photo is an uploaded image (POST /files); the first in a list is the cover.
type Photo struct {
	FileID  string `json:"fileId"`
	Caption string `json:"caption"`
}

// MaxPhotos is the most photos a villa or unit keeps.
const MaxPhotos = 20

// PhotoTypes are the upload types a photo may have.
var PhotoTypes = []string{"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}

// CheckPhotoCount is the PHOTO_LIMIT rule; a photo without a file id is PHOTO_UNKNOWN.
func CheckPhotoCount(photos []Photo) error {
	if len(photos) > MaxPhotos {
		return errs.Newf("PHOTO_LIMIT", "Keep it to %d photos or fewer.", MaxPhotos)
	}
	for _, p := range photos {
		if strings.TrimSpace(p.FileID) == "" {
			return ErrPhotoUnknown("")
		}
	}
	return nil
}

// ErrPhotoUnknown refuses a file id no upload has.
func ErrPhotoUnknown(fileID string) error {
	return errs.Newf("PHOTO_UNKNOWN", "No uploaded file with id %q. Upload the photo again.", fileID)
}

// CheckPhotoType is the PHOTO_NOT_IMAGE rule for one uploaded file.
func CheckPhotoType(name, contentType string) error {
	if slices.Contains(PhotoTypes, strings.ToLower(contentType)) {
		return nil
	}
	return errs.Newf("PHOTO_NOT_IMAGE", "%s is not a photo. Upload a JPEG, PNG, WebP or HEIC image.", name)
}

// NewPhotoIDs lists the file ids in next that are not in current: the uploads to check.
func NewPhotoIDs(current, next []Photo) []string {
	var out []string
	for _, p := range next {
		known := slices.ContainsFunc(current, func(c Photo) bool { return c.FileID == p.FileID })
		if !known && !slices.Contains(out, p.FileID) {
			out = append(out, p.FileID)
		}
	}
	return out
}

func photos(p []Photo) []Photo {
	out := make([]Photo, 0, len(p))
	for _, x := range p {
		out = append(out, Photo{FileID: strings.TrimSpace(x.FileID), Caption: strings.TrimSpace(x.Caption)})
	}
	return out
}

// Cancellation policies.
const (
	PolicyFlexible      = "flexible"
	PolicyModerate      = "moderate"
	PolicyStrict        = "strict"
	PolicyNonRefundable = "non_refundable"
)

// CancellationPolicies lists the policies a villa may take.
var CancellationPolicies = []string{PolicyFlexible, PolicyModerate, PolicyStrict, PolicyNonRefundable}

// Deposit kinds.
const (
	DepositNone    = "none"
	DepositPercent = "percent"
	DepositFixed   = "fixed"
)

// DepositKinds lists the deposit kinds.
var DepositKinds = []string{DepositNone, DepositPercent, DepositFixed}

// Villa profile defaults.
const (
	DefaultCheckIn  = "14:00"
	DefaultCheckOut = "12:00"
)

// VillaProfile is what a guest needs to know about a villa and where its money goes.
type VillaProfile struct {
	Address            string   `json:"address"`
	Lat                *float64 `json:"lat"`
	Lng                *float64 `json:"lng"`
	Phone              string   `json:"phone"`
	Email              string   `json:"email"`
	CheckInTime        string   `json:"checkInTime"`
	CheckOutTime       string   `json:"checkOutTime"`
	LicenseNo          string   `json:"licenseNo"`
	BankName           string   `json:"bankName"`
	BankAccountNo      string   `json:"bankAccountNo"`
	BankAccountName    string   `json:"bankAccountName"`
	HouseRules         string   `json:"houseRules"`
	CancellationPolicy string   `json:"cancellationPolicy"`
	DepositKind        string   `json:"depositKind"`
}

// withDefaults trims the text and fills the times, policy and deposit kind left empty.
func (p VillaProfile) withDefaults() VillaProfile {
	for _, s := range []*string{&p.Address, &p.Phone, &p.Email, &p.CheckInTime, &p.CheckOutTime, &p.LicenseNo, &p.BankName, &p.BankAccountNo, &p.BankAccountName, &p.HouseRules, &p.CancellationPolicy, &p.DepositKind} {
		*s = strings.TrimSpace(*s)
	}
	if p.CheckInTime == "" {
		p.CheckInTime = DefaultCheckIn
	}
	if p.CheckOutTime == "" {
		p.CheckOutTime = DefaultCheckOut
	}
	if p.CancellationPolicy == "" {
		p.CancellationPolicy = PolicyModerate
	}
	if p.DepositKind == "" {
		p.DepositKind = DepositNone
	}
	return p
}

var (
	clockTime = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	digits    = regexp.MustCompile(`^\d*$`)
)

// MaxHouseRules is the longest house rules text in characters.
const MaxHouseRules = 4000

// profileFields checks a villa's profile; deposit is the deposit value as sent.
func profileFields(p VillaProfile, deposit float64, f *errs.Fields) {
	p = p.withDefaults()
	switch {
	case (p.Lat == nil) != (p.Lng == nil):
		f.Add("lat", "Enter both latitude and longitude, or neither.")
	case p.Lat != nil:
		if *p.Lat < -90 || *p.Lat > 90 {
			f.Add("lat", "Latitude is between -90 and 90.")
		}
		if *p.Lng < -180 || *p.Lng > 180 {
			f.Add("lng", "Longitude is between -180 and 180.")
		}
	}
	if p.Email != "" {
		if a, err := mail.ParseAddress(p.Email); err != nil || a.Address != p.Email {
			f.Add("email", "Enter a valid email address, or leave it empty.")
		}
	}
	checkIn, checkOut := clockTime.MatchString(p.CheckInTime), clockTime.MatchString(p.CheckOutTime)
	if !checkIn {
		f.Add("checkInTime", "Enter the check-in time as HH:MM, for example 14:00.")
	}
	if !checkOut {
		f.Add("checkOutTime", "Enter the check-out time as HH:MM, for example 12:00.")
	} else if checkIn && p.CheckOutTime >= p.CheckInTime {
		f.Add("checkOutTime", "Check-out must be earlier than check-in.")
	}
	if !digits.MatchString(p.BankAccountNo) {
		f.Add("bankAccountNo", "The account number is digits only.")
	}
	if utf8.RuneCountInString(p.HouseRules) > MaxHouseRules {
		f.Add("houseRules", fmt.Sprintf("Keep the house rules to %d characters.", MaxHouseRules))
	}
	if !slices.Contains(CancellationPolicies, p.CancellationPolicy) {
		f.Add("cancellationPolicy", "Pick a cancellation policy.")
	}
	switch p.DepositKind {
	case DepositNone:
	case DepositPercent:
		if !whole(deposit) || deposit < 1 || deposit > 100 {
			f.Add("depositValue", "A deposit percentage is a whole number from 1 to 100.")
		}
	case DepositFixed:
		if !whole(deposit) || deposit <= 0 {
			f.Add("depositValue", "Enter the deposit in whole rupiah.")
		}
	default:
		f.Add("depositKind", "Pick a deposit kind.")
	}
}

// Bed types.
var BedTypes = []string{"king", "queen", "double", "twin", "single", "sofa_bed", "bunk"}

// Views a unit may have; empty is none given.
var Views = []string{"", "garden", "pool", "ocean", "rice_field", "jungle", "mountain", "city"}

// Bed is a bed type in a unit and how many of it.
type Bed struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

// MaxExtraBeds is the most extra beds a unit offers.
const MaxExtraBeds = 4

// capacityFields checks a unit's sleeping and room details.
func capacityFields(in UnitInput, f *errs.Fields) {
	if in.MaxAdults != nil && (!whole(*in.MaxAdults) || *in.MaxAdults < 1) {
		f.Add("maxAdults", "At least one adult.")
	}
	if in.MaxChildren != nil && (!whole(*in.MaxChildren) || *in.MaxChildren < 0) {
		f.Add("maxChildren", "Children cannot be negative.")
	}
	var seen []string
	for i, b := range in.Beds {
		key := fmt.Sprintf("beds.%d.", i)
		switch {
		case !slices.Contains(BedTypes, b.Type):
			f.Add(key+"type", "Pick a bed type.")
		case slices.Contains(seen, b.Type):
			f.Add(key+"type", "List each bed type once.")
		}
		seen = append(seen, b.Type)
		if b.Count < 1 {
			f.Add(key+"count", "At least one bed.")
		}
	}
	if in.SizeSqm != nil && (!whole(*in.SizeSqm) || *in.SizeSqm <= 0) {
		f.Add("sizeSqm", "Enter the size in whole square metres, or leave it empty.")
	}
	if !slices.Contains(Views, in.View) {
		f.Add("view", "Pick a view.")
	}
	if !whole(in.ExtraBeds) || in.ExtraBeds < 0 || in.ExtraBeds > MaxExtraBeds {
		f.Add("extraBeds", fmt.Sprintf("Extra beds are 0 to %d.", MaxExtraBeds))
	} else if in.ExtraBeds > 0 && (!whole(in.ExtraBedRate) || in.ExtraBedRate <= 0) {
		f.Add("extraBedRate", "Enter the extra bed rate per night in whole rupiah.")
	}
}

// OutOfService reports the statuses that need a reason.
func OutOfService(status string) bool { return status == UnitMaintenance || status == UnitInactive }

// CheckStatusChange checks the reason and expected return a status change carries; a form that
// keeps the status needs neither. today is the business day.
func (u Unit) CheckStatusChange(in UnitInput, today string) error {
	if in.Status == u.Status || !OutOfService(in.Status) {
		return nil
	}
	var f errs.Fields
	if short(in.StatusReason) {
		f.Add("statusReason", "Say why the unit is out of service.")
	}
	if in.StatusUntil != nil && *in.StatusUntil != "" {
		if !isoDate.MatchString(*in.StatusUntil) {
			f.Add("statusUntil", "Pick the expected return date.")
		} else if *in.StatusUntil < today {
			f.Add("statusUntil", "The expected return cannot be in the past.")
		}
	}
	return f.Err()
}

// SetStatus moves the unit to a new status with its reason and expected return; until applies only
// to a unit out of service. It reports whether the status changed.
func (u *Unit) SetStatus(status, reason string, until *string) bool {
	if status == u.Status {
		return false
	}
	u.Status, u.StatusReason, u.StatusUntil = status, strings.TrimSpace(reason), nil
	if OutOfService(status) && until != nil && *until != "" {
		d := *until
		u.StatusUntil = &d
	}
	return true
}

// StatusChange is one row of a unit's status history.
type StatusChange struct {
	ID     string  `json:"id"`
	UnitID string  `json:"unitId"`
	From   string  `json:"from"`
	To     string  `json:"to"`
	Reason string  `json:"reason"`
	Until  *string `json:"until"`
	By     string  `json:"by"`
	At     string  `json:"at"`
}

// HistoryFilter narrows GET /unit-status-history; empty fields do not narrow. From and To are
// business days, both inclusive.
type HistoryFilter struct {
	UnitID, VillaID, From, To string
}

// Who changes a unit's status besides a signed-in user.
const (
	ByHousekeeping = "Housekeeping"
	ByMaintenance  = "Maintenance"
)

// FillDefaults gives a villa loaded without a profile (a seed record) what the migration gave
// existing villas.
func (v *Villa) FillDefaults() {
	v.VillaProfile = v.VillaProfile.withDefaults()
	if v.Photos == nil {
		v.Photos = []Photo{}
	}
}

// FillDefaults gives a unit loaded without capacity what the migration gave existing units:
// two adults and one child per bedroom.
func (u *Unit) FillDefaults() {
	if u.MaxAdults == 0 {
		u.MaxAdults, u.MaxChildren = u.Bedrooms*2, u.Bedrooms
	}
	if u.Beds == nil {
		u.Beds = []Bed{}
	}
	if u.Photos == nil {
		u.Photos = []Photo{}
	}
}
