package domain

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func ptr[T any](v T) *T { return &v }

func codeOf(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	return ""
}

func fields(err error) map[string]string {
	e, ok := errs.As(err)
	if !ok {
		return nil
	}
	return errs.Fields(e.Fields).Map()
}

// registered is a foreign document with every APOA field, as in guests.test.ts.
func registered() TravelDocument {
	return TravelDocument{Nationality: "AU", IDType: "passport", IDNumber: "PB1112223", IDExpiry: ptr("2031-01-01"), BirthDate: ptr("1990-01-01"), Sex: ptr("male"), BirthPlace: "Sydney", EntryDate: ptr("2026-10-05"), EntryPort: "Ngurah Rai (DPS)", VisaType: ptr("voa")}
}

func TestValidateGuestFollowsTheFormOrder(t *testing.T) {
	in := GuestInput{Name: " C ", Email: "chris@", Phone: "12", Nationality: "XX", IDType: "passport", VipLevel: Optional[int]{Set: true, Value: 2}, BirthDate: Optional[*string]{Set: true, Value: ptr("05/10/1990")}}
	err := ValidateGuest(in)
	e, _ := errs.As(err)
	if e == nil || e.Code != errs.CodeValidation || e.Message != "Enter the guest name." {
		t.Fatalf("got %v", err)
	}
	want := []string{"name", "email", "phone", "nationality", "vipReason", "birthDate"}
	var got []string
	for _, f := range e.Fields {
		got = append(got, f.Field)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("fields %v, want %v", got, want)
	}
	if fields(err)["phone"] != "Enter a phone number with the country code." || fields(err)["vipReason"] != "Say why the guest is a VIP." {
		t.Fatalf("messages %v", fields(err))
	}
	ok := GuestInput{Name: "Chris Hall", Email: "chris.hall@example.com", Phone: "+61 400 111 222", Nationality: "AU", IDType: "passport", IDNumber: "PB1112223"}
	if err := ValidateGuest(ok); err != nil {
		t.Fatalf("valid guest refused: %v", err)
	}
}

func TestApplyKeepsWhatTheInputLeavesOut(t *testing.T) {
	var in GuestInput
	if err := json.Unmarshal([]byte(`{"name":" Chris Hall ","email":"c@x.io","phone":"","nationality":"AU","idType":"passport","idNumber":" PB1 ","notes":"","tags":[" VIP ","VIP",""," Surfer"]}`), &in); err != nil {
		t.Fatal(err)
	}
	g := NewGuest("g-27", "2026-11-11", in)
	if g.Name != "Chris Hall" || g.IDNumber != "PB1" || !slices.Equal(g.Tags, []string{"VIP", "Surfer"}) || g.CreatedOn != "2026-11-11" || g.Blacklist != nil {
		t.Fatalf("new guest %+v", g)
	}
	g.BirthPlace, g.VipLevel, g.VipReason = "Perth", 2, "Press"
	var edit GuestInput
	_ = json.Unmarshal([]byte(`{"name":"Chris Hall","email":"","phone":"","nationality":"AU","idType":"passport","idNumber":"PB1","notes":"","idExpiry":null}`), &edit)
	g.IDExpiry = ptr("2030-01-01")
	g.Apply(edit)
	if g.BirthPlace != "Perth" || g.VipLevel != 2 || g.IDExpiry != nil || !slices.Equal(g.Tags, []string{"VIP", "Surfer"}) {
		t.Fatalf("left-out fields must stay, null clears: %+v", g)
	}
}

func TestForeignDataMissing(t *testing.T) {
	if got := ForeignDataMissing(TravelDocument{Nationality: "ID", IDType: "ktp", IDNumber: "5171"}); len(got) != 0 {
		t.Fatalf("an Indonesian needs nothing, got %v", got)
	}
	got := ForeignDataMissing(TravelDocument{Nationality: "AU", IDType: "ktp"})
	want := []string{"a passport or stay permit", "document number", "document expiry", "date of birth", "sex", "date of entry", "port of entry", "visa type"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v", got)
	}
	if got := ForeignDataMissing(registered()); len(got) != 0 {
		t.Fatalf("a registered guest lacks %v", got)
	}
}

func TestCheckInReady(t *testing.T) {
	lead := Person{ID: "g-1", Name: "Chris Hall", Adult: true, Doc: registered()}
	partial := registered()
	partial.VisaType = nil
	alex := Person{ID: "cmp-1", Name: "Alex Hall", Adult: true, Doc: partial}
	err := CheckInReady([]Person{lead, alex}, "2026-10-05")
	if e, _ := errs.As(err); e == nil || e.Code != "FOREIGN_DATA_MISSING" || e.Message != "Immigration needs more for Alex Hall: visa type." {
		t.Fatalf("got %v", err)
	}
	expired := registered()
	expired.IDExpiry = ptr("2026-10-04")
	alex.Doc = expired
	err = CheckInReady([]Person{lead, alex}, "2026-10-05")
	if e, _ := errs.As(err); e == nil || e.Code != "DOCUMENT_EXPIRED" || e.Message != "Alex Hall's passport expired on 2026-10-04. Ask for a valid one before check-in." {
		t.Fatalf("got %v", err)
	}
	child := Person{ID: "cmp-2", Name: "Ruby", Adult: false, Doc: TravelDocument{Nationality: "AU", IDType: "passport"}}
	if err := CheckInReady([]Person{lead, child}, "2026-10-05"); err != nil {
		t.Fatalf("children are not reported: %v", err)
	}
	made := Person{Name: "Made Wira", Adult: true, Doc: TravelDocument{Nationality: "ID", IDType: "ktp", IDNumber: "5171010101900001"}}
	if err := CheckInReady([]Person{made}, "2026-10-05"); err != nil {
		t.Fatalf("Indonesians check in on a KTP alone: %v", err)
	}
	if got := UnregisteredAdults(ptr(3), 1); got != 2 {
		t.Fatalf("unregistered %d", got)
	}
	if got := UnregisteredAdults(nil, 2); got != 0 {
		t.Fatalf("unregistered without a party size %d", got)
	}
}

func TestReportDueAndApoaRow(t *testing.T) {
	if got := ReportDueAt("2026-11-10", ""); got != "2026-11-11T14:00" {
		t.Fatalf("due %s", got)
	}
	if !ReportOverdue("2026-11-09", "10:00", "2026-11-10T10:01") || ReportOverdue("2026-11-09", "10:00", "2026-11-10T09:59") {
		t.Fatal("overdue after 24 hours")
	}
	row := ApoaRow("Chris Hall", registered(), ApoaStay{CheckIn: "2026-10-05", CheckOut: "2026-10-07", Room: "KR-01", Address: "Villa Karang, Canggu, Badung"})
	if len(row) != len(ApoaColumns) || len(row) != 15 {
		t.Fatalf("row has %d columns", len(row))
	}
	want := []string{"Chris Hall", "M", "Sydney", "1990-01-01", "AU", "Passport", "PB1112223", "2031-01-01", "Visa on arrival", "2026-10-05", "Ngurah Rai (DPS)", "Villa Karang, Canggu, Badung", "2026-10-05", "2026-10-07", "KR-01"}
	if !slices.Equal(row, want) {
		t.Fatalf("row %v", row)
	}
}

func TestFindDuplicates(t *testing.T) {
	list := []Guest{
		{ID: "g-16", Email: "sarah.cohen@example.com", Phone: "+1 415 555 0134", TravelDocument: TravelDocument{IDNumber: "541234567"}},
		{ID: "g-24", Email: "grace.kim@example.com", Phone: "+1 212 555 0199", TravelDocument: TravelDocument{IDNumber: "598765432"}},
		{ID: "g-26", Email: "s.cohen@example.com", Phone: "+1 (415) 555-0134"},
		{ID: "g-30", Email: "GRACE.KIM@example.com"},
		{ID: "g-31", Email: "x@y.z", TravelDocument: TravelDocument{IDNumber: " pb1 "}},
		{ID: "g-32", Email: "a@b.c", TravelDocument: TravelDocument{IDNumber: "PB1"}},
	}
	got := FindDuplicates(list)
	if len(got) != 3 {
		t.Fatalf("pairs %+v", got)
	}
	matches := map[string]string{}
	for _, d := range got {
		matches[d.A.ID+"/"+d.B.ID] = d.Match
	}
	if matches["g-16/g-26"] != "phone" || matches["g-24/g-30"] != "email" || matches["g-31/g-32"] != "document" {
		t.Fatalf("matches %v", matches)
	}
}

func TestMergeFillsBlanksAndKeepsTheHigherVip(t *testing.T) {
	keep := Guest{ID: "g-16", Name: "Sarah Cohen", Phone: "+1 415 555 0134", Notes: "Travel writer", VipLevel: 2, VipReason: "Press", Tags: []string{"Press"}, CreatedOn: "2026-08-29",
		TravelDocument: TravelDocument{IDNumber: "541234567"}, Preferences: Preferences{Pillow: "Feather"}}
	drop := Guest{ID: "g-26", Name: "Sarah Cohen", Email: "s.cohen@example.com", Notes: "From an enquiry", VipLevel: 3, VipReason: "Owner friend", Tags: []string{"Press", "Enquiry"}, CreatedOn: "2026-11-02",
		TravelDocument: TravelDocument{IDNumber: "999", BirthPlace: "San Francisco"}, Preferences: Preferences{Pillow: "Firm", Dietary: "Vegan"},
		Blacklist: &Blacklist{Reason: "Party", SetBy: "Kadek Ariani", SetOn: "2026-11-01"}}
	keep.Merge(drop)
	if keep.Email != "s.cohen@example.com" || keep.IDNumber != "541234567" || keep.BirthPlace != "San Francisco" {
		t.Fatalf("blanks fill, values stay: %+v", keep)
	}
	if keep.Preferences.Pillow != "Feather" || keep.Preferences.Dietary != "Vegan" || !slices.Equal(keep.Tags, []string{"Press", "Enquiry"}) {
		t.Fatalf("preferences and tags: %+v", keep)
	}
	if keep.VipLevel != 3 || keep.VipReason != "Owner friend" || keep.Blacklist == nil || keep.Notes != "Travel writer\nFrom an enquiry" || keep.CreatedOn != "2026-08-29" {
		t.Fatalf("vip, blacklist, notes, created: %+v", keep)
	}
}

func TestBlacklistNeedsAReason(t *testing.T) {
	g := Guest{Name: "Liam"}
	if err := g.SetBlacklist(ptr(" no "), "Kadek Ariani", "2026-11-11"); codeOf(err) != errs.CodeValidation || err.(*errs.Error).Message != "Say why the guest is blacklisted." {
		t.Fatalf("got %v", err)
	}
	if err := g.SetBlacklist(ptr(" Smoked indoors twice "), "Kadek Ariani", "2026-11-11"); err != nil || g.Blacklist.Reason != "Smoked indoors twice" || g.Blacklist.SetBy != "Kadek Ariani" {
		t.Fatalf("got %+v %v", g.Blacklist, err)
	}
	_ = g.SetBlacklist(nil, "Kadek Ariani", "2026-11-11")
	if g.Blacklist != nil {
		t.Fatal("nil clears the blacklist")
	}
}

func TestValidateCompanion(t *testing.T) {
	err := ValidateCompanion(CompanionInput{Name: "A", TravelDocument: TravelDocument{Nationality: "", IDType: "passport", EntryDate: ptr("tomorrow")}})
	if got := fields(err); got["name"] != "Enter the companion’s name." || got["nationality"] != "Pick the nationality." || got["entryDate"] != "Enter a date." {
		t.Fatalf("got %v", got)
	}
	if err := ValidateCompanion(CompanionInput{Name: "Alex Hall", Adult: true, TravelDocument: registered()}); err != nil {
		t.Fatal(err)
	}
}

func TestLostItemRules(t *testing.T) {
	err := ValidateLostItem(LostItemInput{FoundOn: "2026-11-12", Where: "x", Description: "ab"}, "2026-11-11")
	if got := fields(err); got["villaId"] != "Pick the villa." || got["foundOn"] != "The day cannot be in the future." || got["description"] != "Describe the item." || got["where"] != "Say where it was found." {
		t.Fatalf("got %v", got)
	}
	settings := DefaultLostFound
	item := LostItem{FoundOn: "2026-11-11", Status: "found"}
	move := func(i LostItem, m LostMove, today string) string {
		if err := ValidateLostMove(i, m, today, settings); err != nil {
			if codeOf(err) != "LOST_ITEM_INVALID_STATE" {
				t.Fatalf("code %v", err)
			}
			return err.(*errs.Error).Message
		}
		return ""
	}
	courier := &LostReturn{Method: "courier", To: "Chris Hall", Courier: "JNE"}
	if got := move(item, LostMove{To: "returned", Returned: courier}, "2026-11-11"); got != "Enter the courier and the tracking number." {
		t.Fatalf("courier without tracking: %q", got)
	}
	if got := move(item, LostMove{To: "returned", Returned: &LostReturn{Method: "pickup", To: "C"}}, "2026-11-11"); got != "Say who received the item." {
		t.Fatalf("no receiver: %q", got)
	}
	stored := item
	stored.Move(LostMove{To: "stored", Note: " Front office drawer "}, "Wayan Sudiarta", "2026-11-11T10:00:00")
	if stored.Status != "stored" || len(stored.History) != 1 || stored.History[0].Note != "Front office drawer" {
		t.Fatalf("moved %+v", stored)
	}
	if got := move(stored, LostMove{To: "donated"}, "2026-11-11"); got != "Hold the item until 2027-02-09; the holding period is 90 days." {
		t.Fatalf("hold: %q", got)
	}
	if got := move(stored, LostMove{To: "donated"}, "2027-02-09"); got != "" {
		t.Fatalf("after the holding period: %q", got)
	}
	courier.Tracking = "JNE123"
	stored.Move(LostMove{To: "returned", Returned: courier}, "Dian Permata", "2026-11-12T09:00:00")
	if got := move(stored, LostMove{To: "stored"}, "2026-11-12"); got != "A returned item cannot become stored." {
		t.Fatalf("closed: %q", got)
	}
	if !IsClosedLost("returned") || IsClosedLost("contacted") || stored.Returned.Tracking != "JNE123" {
		t.Fatal("closed states")
	}
	if err := ValidateLostFoundSettings(LostFoundSettings{HoldDays: 6}); err == nil || !strings.Contains(err.Error(), "between 7 and 365") {
		t.Fatalf("got %v", err)
	}
}
