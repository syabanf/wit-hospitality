package domain

import (
	"encoding/json"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/property"
)

func TestLateCheckoutFeeDefaults(t *testing.T) {
	for operation, want := range map[string]int64{OperationHotel: 500_000, OperationMixed: 500_000, OperationVilla: 0} {
		v := NewVilla("vil", VillaInput{LocationID: "loc", Code: "VX", Name: "Villa X", OperatingInput: OperatingInput{Operation: operation}})
		if v.LateCheckoutFee != want {
			t.Errorf("%s starts at %d, want %d", operation, v.LateCheckoutFee, want)
		}
	}
	fee, bad := 250_000.0, -1.0
	hotel := NewVilla("vil", VillaInput{LocationID: "loc", Code: "HT", Name: "Hotel", OperatingInput: OperatingInput{Operation: OperationHotel, LateCheckoutFee: &fee}})
	if hotel.LateCheckoutFee != 250_000 {
		t.Fatalf("a sent fee is kept: %d", hotel.LateCheckoutFee)
	}
	if kept := (OperatingInput{}).Keeping(hotel.Operating); kept.LateCheckoutFee == nil || *kept.LateCheckoutFee != fee {
		t.Fatalf("an edit without the fee keeps it: %+v", kept)
	}
	if switched := (OperatingInput{Operation: OperationVilla}).Keeping(hotel.Operating); switched.LateCheckoutFee != nil {
		t.Fatal("a new operation takes its own default fee")
	}
	in := VillaInput{LocationID: "loc", Code: "HT", Name: "Hotel", OperatingInput: OperatingInput{LateCheckoutFee: &bad}}
	if fieldOf(ValidateVilla(in, false), "lateCheckoutFee") == "" {
		t.Fatal("a negative fee was accepted")
	}
	// An event from before the fee reads as the operation's default.
	if v := VillaOf(property.Villa{ID: "vil", Operation: OperationHotel}); v.LateCheckoutFee != 500_000 {
		t.Fatalf("old hotel event: %d", v.LateCheckoutFee)
	}
	if s := VillaState(hotel); s.LateCheckoutFee == nil || *s.LateCheckoutFee != 250_000 {
		t.Fatalf("the event carries the fee: %v", s.LateCheckoutFee)
	}
}

func TestUnitHost(t *testing.T) {
	var in UnitInput
	if err := json.Unmarshal([]byte(`{"hostId": "emp-002"}`), &in); err != nil || !in.HostID.Set || in.HostID.ID != "emp-002" {
		t.Fatalf("hostId string: %+v %v", in.HostID, err)
	}
	u := Unit{Version: 1}
	u.Apply(in)
	if u.HostID == nil || *u.HostID != "emp-002" {
		t.Fatalf("host set: %v", u.HostID)
	}
	u.Apply(UnitInput{})
	if u.HostID == nil {
		t.Fatal("a form without hostId keeps the host")
	}
	var clear UnitInput
	_ = json.Unmarshal([]byte(`{"hostId": null}`), &clear)
	u.Apply(clear)
	if u.HostID != nil {
		t.Fatal("null clears the host")
	}
	host := "emp-002"
	if fieldOf(CheckHostKind(&host, KindRoom), "hostId") == "" {
		t.Fatal("a room took a host")
	}
	if CheckHostKind(&host, UnitKind(nil, OperationVilla)) != nil {
		t.Fatal("a villa unit without a room type takes a host")
	}
	if UnitKind(nil, OperationHotel) != KindRoom || UnitKind(&UnitGroup{Kind: KindVilla}, OperationMixed) != KindVilla {
		t.Fatal("unit kind")
	}
}
