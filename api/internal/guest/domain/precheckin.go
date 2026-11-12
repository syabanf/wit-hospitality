package domain

import (
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
)

// profileVisa is PROFILE_VISA: the profile's visa type for the one the guest picked online;
// "other" and "not needed" leave it for the desk.
var profileVisa = map[string]string{"visa_free": "free", "voa": "voa", "evisa": "evoa", "kitas": "kitas"}

// CountryCode is countryCode: the ISO code a code or a country name stands for, else "".
func CountryCode(text string) string {
	t := strings.TrimSpace(text)
	if _, ok := Countries[strings.ToUpper(t)]; ok {
		return strings.ToUpper(t)
	}
	for code, name := range Countries {
		if strings.EqualFold(name, t) {
			return code
		}
	}
	return ""
}

// document is the traveller's document in the profile's fields; the nationality is fallback
// when the text names no known country.
func document(t guest.Traveller, fallback string) TravelDocument {
	nationality := CountryCode(t.Nationality)
	if nationality == "" {
		nationality = fallback
	}
	var visa *string
	if v, ok := profileVisa[t.VisaType]; ok {
		visa = &v
	}
	return TravelDocument{
		Nationality: nationality, IDType: t.DocumentType, IDNumber: strings.TrimSpace(t.DocumentNumber),
		IDExpiry: emptyToNil(&t.DocumentExpiry), BirthDate: emptyToNil(&t.DateOfBirth), Sex: emptyToNil(&t.Sex),
		EntryDate: emptyToNil(&t.EntryDate), EntryPort: strings.TrimSpace(t.PortOfEntry), VisaType: visa,
	}
}

// ApplyLead is guestFieldsFrom: the lead traveller's contact, document, birth and entry fields
// onto the profile. Place of birth and the address in Indonesia stay as the desk set them.
func (g *Guest) ApplyLead(lead guest.Traveller, email, phone string) {
	d := document(lead, g.Nationality)
	d.BirthPlace, d.AddressInIndonesia = g.BirthPlace, g.AddressInIndonesia
	g.TravelDocument = d
	if e := strings.TrimSpace(email); e != "" {
		g.Email = e
	}
	g.Phone = strings.TrimSpace(phone)
}

// MatchCompanion is the companion on the stay with the traveller's document number, the match
// companionFieldsFrom makes; nil when none has it.
func MatchCompanion(existing []Companion, t guest.Traveller) *Companion {
	number := strings.ToUpper(strings.TrimSpace(t.DocumentNumber))
	for i, c := range existing {
		if n := strings.ToUpper(strings.TrimSpace(c.IDNumber)); n != "" && n == number {
			return &existing[i]
		}
	}
	return nil
}

// ApplyTraveller is companionFieldsFrom for one traveller after the lead: an adult with the
// traveller's name and document; place of birth and the address stay as the desk set them.
func (c *Companion) ApplyTraveller(t guest.Traveller) {
	d := document(t, strings.TrimSpace(t.Nationality))
	d.BirthPlace, d.AddressInIndonesia = c.BirthPlace, c.AddressInIndonesia
	c.Name, c.Adult, c.TravelDocument = strings.TrimSpace(t.Name), true, d
}
