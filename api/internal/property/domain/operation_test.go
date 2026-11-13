package domain

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func TestGroupKindFitsTheOperation(t *testing.T) {
	room := GroupInput{VillaID: "v1", Name: "Deluxe", Kind: KindRoom}
	villa := GroupInput{VillaID: "v1", Name: "Pool villa", Kind: KindVilla}
	for name, c := range map[string]struct {
		in        GroupInput
		operation string
		code, msg string
	}{
		"villa in a hotel": {villa, OperationHotel, CodeGroupKind, "A Hotel only has rooms."},
		"room in a villa":  {room, OperationVilla, CodeGroupKind, "A Villa only has villas."},
		"room in mixed":    {room, OperationMixed, "", ""},
		"villa in mixed":   {villa, OperationMixed, "", ""},
		"unknown kind":     {GroupInput{VillaID: "v1", Name: "Odd", Kind: "suite"}, OperationMixed, errs.CodeValidation, "Pick rooms or villas."},
	} {
		err := ValidateGroup(c.in, c.operation)
		e, _ := errs.As(err)
		switch {
		case c.code == "" && err != nil:
			t.Errorf("%s: %v", name, err)
		case c.code != "" && (e == nil || e.Code != c.code || fieldOf(err, "kind") != c.msg):
			t.Errorf("%s: got %v", name, err)
		}
	}
	if got := (GroupInput{}).WithKind("", OperationHotel).Kind; got != KindRoom {
		t.Fatalf("a new hotel room type is a room type, got %q", got)
	}
	if got := (GroupInput{}).WithKind(KindRoom, OperationMixed).Kind; got != KindRoom {
		t.Fatalf("an edit without a kind keeps it, got %q", got)
	}
}

func TestOperationDefaultsAndRules(t *testing.T) {
	yes, zero := true, 0.0
	in := VillaInput{LocationID: "loc", Code: "HT", Name: "Hotel Tirta", OperatingInput: OperatingInput{Operation: OperationHotel, WholeRental: &yes}}
	if fieldOf(ValidateVilla(in, false), "wholeRental") != "A hotel is not rented whole." {
		t.Fatal("a hotel rented whole was accepted")
	}
	in.WholeRental = nil
	v := NewVilla("vil-ht", in)
	if v.StayoverEvery != 1 || v.DepositOnCheckIn || v.WholeRental {
		t.Fatalf("hotel defaults %+v", v.Operating)
	}
	villa := NewVilla("vil-x", VillaInput{LocationID: "loc", Code: "VX", Name: "Villa X"})
	if villa.Operation != OperationVilla || villa.StayoverEvery != 0 || !villa.DepositOnCheckIn {
		t.Fatalf("villa defaults %+v", villa.Operating)
	}
	mixed := NewVilla("vil-m", VillaInput{LocationID: "loc", Code: "MX", Name: "Mixed", OperatingInput: OperatingInput{Operation: OperationMixed, StayoverEvery: &zero}})
	if mixed.StayoverEvery != 0 || !mixed.DepositOnCheckIn {
		t.Fatalf("mixed keeps a stayover gap of 0 when sent: %+v", mixed.Operating)
	}
	eight, half := 8.0, 1.5
	bad := VillaInput{LocationID: "loc", Code: "VX", Name: "Villa X", OperatingInput: OperatingInput{Operation: "resort", StayoverEvery: &eight, WholeNightlyRate: &half}}
	err := ValidateVilla(bad, false)
	for _, field := range []string{"operation", "stayoverEvery", "wholeNightlyRate"} {
		if fieldOf(err, field) == "" {
			t.Errorf("%s accepted", field)
		}
	}
	kept := OperatingInput{}.Keeping(Operating{Operation: OperationHotel, StayoverEvery: 2})
	if kept.Operation != OperationHotel || *kept.StayoverEvery != 2 || *kept.DepositOnCheckIn {
		t.Fatalf("an edit that leaves the operation out keeps it: %+v", kept)
	}
	if switched := (OperatingInput{Operation: OperationVilla}).Keeping(Operating{Operation: OperationHotel, StayoverEvery: 2}); switched.StayoverEvery != nil {
		t.Fatal("a new operation takes its own stayover default")
	}
	if FitKind(KindRoom, OperationVilla) != KindVilla || FitKind(KindVilla, OperationHotel) != KindRoom || FitKind(KindRoom, OperationMixed) != KindRoom {
		t.Fatal("a property's room types take the kind its operation allows")
	}
	if fieldOf(ValidateUnit(UnitInput{VillaID: "v", Code: "HT-201", Name: "Room 201", Bedrooms: 1, NightlyRate: 1, Status: UnitActive, Floor: "Mezzanine 2"}, false, nil), "floor") == "" {
		t.Fatal("a floor over 10 characters was accepted")
	}
}

func TestWizardRoomAndVillaDefaults(t *testing.T) {
	zero, one, three, yes := 0, 1, 3.0, true
	in := PropertyInput{
		Villa: VillaInput{LocationID: "loc", Code: "MX", Name: "Mixed", OperatingInput: OperatingInput{Operation: OperationMixed, WholeRental: &yes}},
		Groups: []WizardGroup{
			{Name: "Deluxe", Kind: KindRoom},
			{Name: "Pool villas", Kind: KindVilla, MinStay: &three},
		},
		Rooms: []WizardRoom{
			{Code: "MX-201", Name: "Room 201", Bedrooms: 1, NightlyRate: 900_000, GroupIndex: &zero, Floor: "2"},
			{Code: "MX-01", Name: "Villa Satu", Bedrooms: 2, NightlyRate: 3_000_000, GroupIndex: &one},
		},
	}
	types := WizardTypes(in)
	if !types[0].Interchangeable || !types[0].OperatorAssigns || types[0].MinStay != 1 || types[1].OperatorAssigns || types[1].MinStay != 3 {
		t.Fatalf("got %+v", types)
	}
	if fieldOf(ValidateProperty(in, false, func(string) bool { return false }), "villa.wholeRental") == "" {
		t.Fatal("whole rental with one villa was accepted")
	}
	in.Rooms = append(in.Rooms, WizardRoom{Code: "MX-02", Name: "Villa Dua", Bedrooms: 2, NightlyRate: 3_000_000})
	if err := ValidateProperty(in, false, func(string) bool { return false }); err != nil {
		t.Fatal(err)
	}
	if types = WizardTypes(in); types[2].Kind != KindVilla || types[2].MinStay != 2 {
		t.Fatalf("a mixed property's room without a type is a villa: %+v", types[2])
	}
	in.Villa.Operation, in.Villa.WholeRental = OperationHotel, nil
	e, _ := errs.As(ValidateProperty(in, false, func(string) bool { return false }))
	if e == nil || e.Code != CodeGroupKind || errs.Fields(e.Fields).Map()["groups.1.kind"] != "A Hotel only has rooms." {
		t.Fatalf("got %v", e)
	}
}
