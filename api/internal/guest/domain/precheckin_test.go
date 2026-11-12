package domain

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
)

func TestPreCheckInFields(t *testing.T) {
	if CountryCode(" australia ") != "AU" || CountryCode("de") != "DE" || CountryCode("Atlantis") != "" {
		t.Fatal("country codes")
	}
	g := Guest{Email: "old@example.com", TravelDocument: TravelDocument{Nationality: "FR", BirthPlace: "Lyon", AddressInIndonesia: "Canggu"}}
	g.ApplyLead(guest.Traveller{Nationality: "Atlantis", DocumentType: "passport", DocumentNumber: " P1 ", DateOfBirth: "1990-01-01", Sex: "male", VisaType: "other"}, " ", " +62 1 ")
	if g.Nationality != "FR" || g.IDNumber != "P1" || *g.BirthDate != "1990-01-01" || g.IDExpiry != nil || g.VisaType != nil ||
		g.BirthPlace != "Lyon" || g.AddressInIndonesia != "Canggu" || g.Email != "old@example.com" || g.Phone != "+62 1" {
		t.Fatalf("lead %+v", g)
	}
	existing := []Companion{{ID: "cmp-1", TravelDocument: TravelDocument{IDNumber: "pa930117", BirthPlace: "Perth"}}}
	c := MatchCompanion(existing, guest.Traveller{DocumentNumber: "PA930117 "})
	if c == nil || c.ID != "cmp-1" || MatchCompanion(existing, guest.Traveller{DocumentNumber: "X"}) != nil {
		t.Fatal("match by document number")
	}
	c.ApplyTraveller(guest.Traveller{Name: " Daniel ", Nationality: "Australia", VisaType: "evisa"})
	if existing[0].Name != "Daniel" || !existing[0].Adult || existing[0].Nationality != "AU" || *existing[0].VisaType != "evoa" || existing[0].BirthPlace != "Perth" {
		t.Fatalf("companion %+v", existing[0])
	}
}
