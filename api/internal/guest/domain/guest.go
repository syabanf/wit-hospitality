// Package domain holds the guest context's rules, ported from src/domain/guest.ts and
// src/domain/lostFound.ts with the same codes and wording: guest profiles and their travel
// documents, the APOA fields Immigration asks of a foreign guest, stay companions, duplicates and
// merge, the blacklist, and lost and found.
package domain

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// HomeCountry is Indonesia; a guest of any other nationality is foreign.
const HomeCountry = "ID"

// Countries are the ISO 3166-1 alpha-2 codes the console offers.
var Countries = map[string]string{
	"AE": "United Arab Emirates", "AT": "Austria", "AU": "Australia", "BE": "Belgium", "BR": "Brazil",
	"CA": "Canada", "CH": "Switzerland", "CN": "China", "DE": "Germany", "DK": "Denmark", "ES": "Spain",
	"FI": "Finland", "FR": "France", "GB": "United Kingdom", "HK": "Hong Kong", "ID": "Indonesia",
	"IE": "Ireland", "IL": "Israel", "IN": "India", "IT": "Italy", "JP": "Japan", "KR": "South Korea",
	"MY": "Malaysia", "NG": "Nigeria", "NL": "Netherlands", "NO": "Norway", "NZ": "New Zealand",
	"PH": "Philippines", "PL": "Poland", "PT": "Portugal", "RU": "Russia", "SA": "Saudi Arabia",
	"SE": "Sweden", "SG": "Singapore", "TH": "Thailand", "TW": "Taiwan", "US": "United States",
	"VN": "Vietnam", "ZA": "South Africa",
}

// CountryName is countryName: the name for a code, else the code.
func CountryName(code string) string {
	if n, ok := Countries[code]; ok {
		return n
	}
	return code
}

// IDTypeLabel names the travel documents.
var IDTypeLabel = map[string]string{"passport": "Passport", "kitas": "KITAS", "kitap": "KITAP", "ktp": "KTP"}

// SexLabel names the sexes.
var SexLabel = map[string]string{"male": "Male", "female": "Female"}

// VisaTypeLabel names the visa types.
var VisaTypeLabel = map[string]string{"voa": "Visa on arrival", "evoa": "e-VOA", "b211": "B211", "kitas": "KITAS", "free": "Visa free"}

// TravelDocument is what Immigration asks of a foreign guest. Guests and companions carry it under
// the same names; dates are ISO days.
type TravelDocument struct {
	Nationality        string  `json:"nationality"`
	IDType             string  `json:"idType"`
	IDNumber           string  `json:"idNumber"`
	IDExpiry           *string `json:"idExpiry"`
	BirthDate          *string `json:"birthDate"`
	Sex                *string `json:"sex"`
	BirthPlace         string  `json:"birthPlace"`
	EntryDate          *string `json:"entryDate"`
	EntryPort          string  `json:"entryPort"`
	VisaType           *string `json:"visaType"`
	AddressInIndonesia string  `json:"addressInIndonesia"`
}

// Preferences are what the guest asked for before.
type Preferences struct {
	Pillow       string `json:"pillow"`
	BedSetup     string `json:"bedSetup"`
	Dietary      string `json:"dietary"`
	Allergies    string `json:"allergies"`
	RoomLocation string `json:"roomLocation"`
	Celebrations string `json:"celebrations"`
}

// Blacklist is a guest the operator refuses.
type Blacklist struct {
	Reason string `json:"reason"`
	SetBy  string `json:"setBy"`
	SetOn  string `json:"setOn"`
}

// Guest is a guest profile.
type Guest struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
	Phone string `json:"phone"`
	TravelDocument
	Notes       string      `json:"notes"`
	Preferences Preferences `json:"preferences"`
	VipLevel    int         `json:"vipLevel"`
	VipReason   string      `json:"vipReason"`
	Tags        []string    `json:"tags"`
	Blacklist   *Blacklist  `json:"blacklist"`
	CreatedOn   string      `json:"createdOn"`
	Version     int64       `json:"-"`
}

// Optional is a field the input may leave out: Set is false when the key is absent, so the saved
// value stays; a JSON null sets the zero value.
type Optional[T any] struct {
	Set   bool
	Value T
}

// UnmarshalJSON runs only when the key is present.
func (o *Optional[T]) UnmarshalJSON(raw []byte) error {
	o.Set = true
	if string(raw) == "null" {
		var zero T
		o.Value = zero
		return nil
	}
	return json.Unmarshal(raw, &o.Value)
}

// GuestInput is GuestInput: contact and document fields are required, the rest keep their saved
// value when left out.
type GuestInput struct {
	Name               string                `json:"name"`
	Email              string                `json:"email"`
	Phone              string                `json:"phone"`
	Nationality        string                `json:"nationality"`
	IDType             string                `json:"idType"`
	IDNumber           string                `json:"idNumber"`
	Notes              string                `json:"notes"`
	IDExpiry           Optional[*string]     `json:"idExpiry"`
	BirthDate          Optional[*string]     `json:"birthDate"`
	Sex                Optional[*string]     `json:"sex"`
	BirthPlace         Optional[string]      `json:"birthPlace"`
	EntryDate          Optional[*string]     `json:"entryDate"`
	EntryPort          Optional[string]      `json:"entryPort"`
	VisaType           Optional[*string]     `json:"visaType"`
	AddressInIndonesia Optional[string]      `json:"addressInIndonesia"`
	Preferences        Optional[Preferences] `json:"preferences"`
	VipLevel           Optional[int]         `json:"vipLevel"`
	VipReason          Optional[string]      `json:"vipReason"`
	Tags               Optional[[]string]    `json:"tags"`
}

var (
	isoDay     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	emailShape = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	phoneShape = regexp.MustCompile(`^\+?[\d\s-]{7,}$`)
)

func badDay(d *string) bool { return d != nil && *d != "" && !isoDay.MatchString(*d) }

// documentEnums refuses values the TypeScript types rule out; the console never sends them.
func documentEnums(f *errs.Fields, idType string, sex, visa *string) {
	if _, ok := IDTypeLabel[idType]; !ok {
		f.Add("idType", "Pick the document type.")
	}
	if sex != nil && *sex != "" {
		if _, ok := SexLabel[*sex]; !ok {
			f.Add("sex", "Pick the sex.")
		}
	}
	if visa != nil && *visa != "" {
		if _, ok := VisaTypeLabel[*visa]; !ok {
			f.Add("visaType", "Pick the visa type.")
		}
	}
}

// ValidateGuest is validateGuest, in its field order.
func ValidateGuest(in GuestInput) error {
	var f errs.Fields
	if len([]rune(strings.TrimSpace(in.Name))) < 2 {
		f.Add("name", "Enter the guest name.")
	}
	if in.Email != "" && !emailShape.MatchString(in.Email) {
		f.Add("email", "Enter a valid email address.")
	}
	if in.Phone != "" && !phoneShape.MatchString(in.Phone) {
		f.Add("phone", "Enter a phone number with the country code.")
	}
	if _, ok := Countries[in.Nationality]; !ok {
		f.Add("nationality", "Pick the nationality.")
	}
	if in.VipLevel.Value != 0 && len([]rune(strings.TrimSpace(in.VipReason.Value))) < 3 {
		f.Add("vipReason", "Say why the guest is a VIP.")
	}
	for _, d := range []struct {
		field string
		value *string
	}{{"idExpiry", in.IDExpiry.Value}, {"birthDate", in.BirthDate.Value}, {"entryDate", in.EntryDate.Value}} {
		if badDay(d.value) {
			f.Add(d.field, "Enter a date.")
		}
	}
	documentEnums(&f, in.IDType, in.Sex.Value, in.VisaType.Value)
	if in.VipLevel.Value < 0 || in.VipLevel.Value > 3 {
		f.Add("vipLevel", "Pick a VIP level from 0 to 3.")
	}
	return f.Err()
}

// cleanTags is trimmed's tag rule: trimmed, without blanks or repeats, in order.
func cleanTags(tags []string) []string {
	out := []string{}
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t != "" && !slices.Contains(out, t) {
			out = append(out, t)
		}
	}
	return out
}

// emptyToNil keeps "" out of nullable fields.
func emptyToNil(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// NewGuest is createGuest: the defaults, then the trimmed input.
func NewGuest(id, today string, in GuestInput) Guest {
	g := Guest{ID: id, Tags: []string{}, CreatedOn: today}
	g.Apply(in)
	return g
}

// Apply is Object.assign(guest, trimmed(input)): required fields replace, optional ones replace
// only when present.
func (g *Guest) Apply(in GuestInput) {
	g.Name, g.Email, g.Phone = strings.TrimSpace(in.Name), strings.TrimSpace(in.Email), strings.TrimSpace(in.Phone)
	g.Nationality, g.IDType, g.IDNumber = in.Nationality, in.IDType, strings.TrimSpace(in.IDNumber)
	g.Notes = strings.TrimSpace(in.Notes)
	if in.IDExpiry.Set {
		g.IDExpiry = emptyToNil(in.IDExpiry.Value)
	}
	if in.BirthDate.Set {
		g.BirthDate = emptyToNil(in.BirthDate.Value)
	}
	if in.Sex.Set {
		g.Sex = emptyToNil(in.Sex.Value)
	}
	if in.BirthPlace.Set {
		g.BirthPlace = in.BirthPlace.Value
	}
	if in.EntryDate.Set {
		g.EntryDate = emptyToNil(in.EntryDate.Value)
	}
	if in.EntryPort.Set {
		g.EntryPort = in.EntryPort.Value
	}
	if in.VisaType.Set {
		g.VisaType = emptyToNil(in.VisaType.Value)
	}
	if in.AddressInIndonesia.Set {
		g.AddressInIndonesia = in.AddressInIndonesia.Value
	}
	if in.Preferences.Set {
		g.Preferences = in.Preferences.Value
	}
	if in.VipLevel.Set {
		g.VipLevel = in.VipLevel.Value
	}
	if in.VipReason.Set {
		g.VipReason = in.VipReason.Value
	}
	if in.Tags.Set {
		g.Tags = cleanTags(in.Tags.Value)
	}
	if g.Tags == nil {
		g.Tags = []string{}
	}
}

// ErrBlacklistReason refuses a blacklist without a reason.
var ErrBlacklistReason = errs.New(errs.CodeValidation, "Say why the guest is blacklisted.")

// SetBlacklist puts the guest on the blacklist, or takes them off when reason is nil.
func (g *Guest) SetBlacklist(reason *string, by, today string) error {
	if reason == nil {
		g.Blacklist = nil
		return nil
	}
	r := strings.TrimSpace(*reason)
	if len([]rune(r)) < 5 {
		return ErrBlacklistReason
	}
	g.Blacklist = &Blacklist{Reason: r, SetBy: by, SetOn: today}
	return nil
}

// Merge folds drop into g as the mock's merge does: blanks on the kept profile take the dropped
// profile's value, preferences fill per field, tags join, the higher VIP level stays, a blacklist
// carries over, notes join and the earlier creation date wins.
func (g *Guest) Merge(drop Guest) {
	fillString := func(keep *string, from string) {
		if *keep == "" && from != "" {
			*keep = from
		}
	}
	fillPtr := func(keep **string, from *string) {
		if (*keep == nil || **keep == "") && from != nil && *from != "" {
			*keep = from
		}
	}
	fillString(&g.Email, drop.Email)
	fillString(&g.Phone, drop.Phone)
	fillString(&g.IDNumber, drop.IDNumber)
	fillPtr(&g.IDExpiry, drop.IDExpiry)
	fillPtr(&g.BirthDate, drop.BirthDate)
	fillPtr(&g.Sex, drop.Sex)
	fillString(&g.BirthPlace, drop.BirthPlace)
	fillPtr(&g.EntryDate, drop.EntryDate)
	fillString(&g.EntryPort, drop.EntryPort)
	fillPtr(&g.VisaType, drop.VisaType)
	fillString(&g.AddressInIndonesia, drop.AddressInIndonesia)
	p, d := &g.Preferences, drop.Preferences
	fillString(&p.Pillow, d.Pillow)
	fillString(&p.BedSetup, d.BedSetup)
	fillString(&p.Dietary, d.Dietary)
	fillString(&p.Allergies, d.Allergies)
	fillString(&p.RoomLocation, d.RoomLocation)
	fillString(&p.Celebrations, d.Celebrations)
	for _, t := range drop.Tags {
		if !slices.Contains(g.Tags, t) {
			g.Tags = append(g.Tags, t)
		}
	}
	if drop.VipLevel > g.VipLevel {
		g.VipLevel, g.VipReason = drop.VipLevel, drop.VipReason
	}
	if g.Blacklist == nil {
		g.Blacklist = drop.Blacklist
	}
	var notes []string
	for _, n := range []string{g.Notes, drop.Notes} {
		if n != "" {
			notes = append(notes, n)
		}
	}
	g.Notes = strings.Join(notes, "\n")
	if drop.CreatedOn < g.CreatedOn {
		g.CreatedOn = drop.CreatedOn
	}
}

// Duplicate is a pair of profiles that are likely the same person.
type Duplicate struct {
	A     Guest  `json:"a"`
	B     Guest  `json:"b"`
	Match string `json:"match"`
}

var nonDigits = regexp.MustCompile(`\D`)

func normalPhone(phone string) string {
	return strings.TrimLeft(nonDigits.ReplaceAllString(phone, ""), "0")
}

// FindDuplicates is findDuplicates: the same email, then document number, then phone.
func FindDuplicates(list []Guest) []Duplicate {
	out := []Duplicate{}
	for i, a := range list {
		for _, b := range list[i+1:] {
			match := ""
			switch {
			case a.Email != "" && strings.EqualFold(a.Email, b.Email):
				match = "email"
			case a.IDNumber != "" && strings.EqualFold(strings.TrimSpace(a.IDNumber), strings.TrimSpace(b.IDNumber)):
				match = "document"
			case len(normalPhone(a.Phone)) >= 7 && normalPhone(a.Phone) == normalPhone(b.Phone):
				match = "phone"
			}
			if match != "" {
				out = append(out, Duplicate{A: a, B: b, Match: match})
			}
		}
	}
	return out
}
