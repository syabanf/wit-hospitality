package domain

import (
	"reflect"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func fieldsOf(err error) map[string]string {
	if e, ok := errs.As(err); ok {
		return errs.Fields(e.Fields).Map()
	}
	return map[string]string{}
}

func TestVillaProfileDefaultsAndRules(t *testing.T) {
	in := VillaInput{LocationID: "l1", Code: "SK", Name: "Saka"}
	if err := ValidateVilla(in, false); err != nil {
		t.Fatalf("empty profile takes defaults: %v", err)
	}
	v := NewVilla("v1", in)
	if v.CheckInTime != "14:00" || v.CheckOutTime != "12:00" || v.CancellationPolicy != PolicyModerate || v.DepositKind != DepositNone || v.Photos == nil {
		t.Fatalf("got %+v", v)
	}
	lat, lng := 91.0, 200.0
	in.Lat, in.Lng = &lat, &lng
	in.Email, in.CheckInTime, in.HouseRules = "not an email", "2pm", string(make([]rune, 4001))
	in.CancellationPolicy, in.DepositKind = "lenient", "fixed"
	want := map[string]string{
		"lat":                "Latitude is between -90 and 90.",
		"lng":                "Longitude is between -180 and 180.",
		"email":              "Enter a valid email address, or leave it empty.",
		"checkInTime":        "Enter the check-in time as HH:MM, for example 14:00.",
		"houseRules":         "Keep the house rules to 4000 characters.",
		"cancellationPolicy": "Pick a cancellation policy.",
		"depositValue":       "Enter the deposit in whole rupiah.",
	}
	if got := fieldsOf(ValidateVilla(in, false)); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	ok := VillaInput{LocationID: "l1", Code: "SK", Name: "Saka", VillaProfile: VillaProfile{DepositKind: DepositNone}, DepositValue: 500}
	if v := NewVilla("v1", ok); v.DepositValue != 0 {
		t.Fatalf("a deposit of kind none is zero, got %d", v.DepositValue)
	}
}

func TestUnitCapacityFields(t *testing.T) {
	g := &UnitGroup{ID: "g1", VillaID: "v1"}
	grp := "g1"
	base := UnitInput{VillaID: "v1", GroupID: &grp, Code: "SK-01", Name: "Saka 1", Bedrooms: 2, NightlyRate: 1_000_000, Status: UnitActive}
	u := NewUnit("u1", base)
	if u.MaxAdults != 4 || u.MaxChildren != 2 || u.Beds == nil {
		t.Fatalf("a new unit without capacity sleeps two adults and a child per bedroom: %+v", u)
	}
	zero, size := 0.0, -3.0
	bad := base
	bad.MaxAdults, bad.Beds, bad.SizeSqm, bad.View, bad.ExtraBeds = &zero, []Bed{{Type: "hammock", Count: 1}, {Type: "twin", Count: 0}}, &size, "volcano", 5
	want := map[string]string{
		"maxAdults":    "At least one adult.",
		"beds.0.type":  "Pick a bed type.",
		"beds.1.count": "At least one bed.",
		"sizeSqm":      "Enter the size in whole square metres, or leave it empty.",
		"view":         "Pick a view.",
		"extraBeds":    "Extra beds are 0 to 4.",
	}
	if got := fieldsOf(ValidateUnit(bad, false, g)); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	// An update without capacity keeps the unit's.
	u.Version = 3
	u.MaxAdults = 6
	u.Apply(base)
	if u.MaxAdults != 6 {
		t.Fatalf("got %d", u.MaxAdults)
	}
}

func TestStatusChangeNeedsAReason(t *testing.T) {
	u := Unit{Status: UnitActive}
	in := UnitInput{Status: UnitInactive}
	if fieldsOf(u.CheckStatusChange(in, "2026-11-11"))["statusReason"] != "Say why the unit is out of service." {
		t.Fatal("inactive without a reason accepted")
	}
	past := "2026-11-10"
	in.StatusReason, in.StatusUntil = "Renovation", &past
	if fieldsOf(u.CheckStatusChange(in, "2026-11-11"))["statusUntil"] == "" {
		t.Fatal("a return date in the past accepted")
	}
	if err := (Unit{Status: UnitInactive}).CheckStatusChange(UnitInput{Status: UnitInactive}, "2026-11-11"); err != nil {
		t.Fatalf("a form that keeps the status needs no reason: %v", err)
	}
	until := "2026-12-01"
	if !u.SetStatus(UnitCleaning, "Deep clean", &until) || u.StatusUntil != nil || u.StatusReason != "Deep clean" {
		t.Fatalf("a unit in service has no return date: %+v", u)
	}
}

func TestPhotoRules(t *testing.T) {
	if err := CheckPhotoType("menu.pdf", "application/pdf"); !errs.HasCode(err, "PHOTO_NOT_IMAGE") {
		t.Fatalf("got %v", err)
	}
	if err := CheckPhotoType("pool.heic", "image/heic"); err != nil {
		t.Fatal(err)
	}
	if err := CheckPhotoCount(make([]Photo, 21)); !errs.HasCode(err, "PHOTO_LIMIT") {
		t.Fatalf("got %v", err)
	}
	got := NewPhotoIDs([]Photo{{FileID: "a"}}, []Photo{{FileID: "a"}, {FileID: "b"}, {FileID: "b"}})
	if !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("got %v", got)
	}
}
