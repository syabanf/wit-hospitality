package domain

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func fieldMessage(err error, field string) string {
	e, ok := errs.As(err)
	if !ok {
		return ""
	}
	for _, f := range e.Fields {
		if f.Field == field {
			return f.Message
		}
	}
	return ""
}

func TestPreferencesByKind(t *testing.T) {
	villa := Preferences{BreakfastTime: "08:00", Dietary: " vegan ", Setups: []string{"bbq", "baby_cot", "bbq"}, ArrivalTime: "15:30", Notes: "Honeymoon"}
	if err := ValidatePreferences(villa, KindVilla); err != nil {
		t.Fatalf("villa preferences: %v", err)
	}
	if got := villa.Clean(); got.Dietary != "vegan" || len(got.Setups) != 2 || got.Setups[0] != "bbq" || got.Setups[1] != "baby_cot" {
		t.Fatalf("clean %+v", got)
	}
	if fieldMessage(ValidatePreferences(villa, KindRoom), "setups") != "A room stay takes only the arrival time and notes." {
		t.Fatal("a room took villa preferences")
	}
	if err := ValidatePreferences(Preferences{ArrivalTime: "21:00", Notes: "Late flight"}, KindRoom); err != nil {
		t.Fatalf("room preferences: %v", err)
	}
	bad := ValidatePreferences(Preferences{BreakfastTime: "8am", Setups: []string{"helicopter"}, ArrivalTime: "25:00"}, KindVilla)
	for _, f := range []string{"breakfastTime", "setups", "arrivalTime"} {
		if fieldMessage(bad, f) == "" {
			t.Errorf("%s not refused", f)
		}
	}
	if (Preferences{}).Clean().Setups == nil {
		t.Fatal("setups read as a list")
	}
}

func TestServiceWindow(t *testing.T) {
	if w := DefaultServiceWindow(KindRoom); w != (ServiceWindow{Mode: WindowScheduled}) {
		t.Fatalf("room default %+v", w)
	}
	if w := DefaultServiceWindow(KindVilla); w != (ServiceWindow{Mode: WindowWindow, From: "10:00", To: "12:00"}) {
		t.Fatalf("villa default %+v", w)
	}
	if fieldMessage(ValidateServiceWindow(ServiceWindow{Mode: WindowWindow, From: "12:00", To: "10:00"}), "to") == "" {
		t.Fatal("a window ending before it starts")
	}
	if ValidateServiceWindow(ServiceWindow{Mode: "never"}) == nil {
		t.Fatal("unknown mode")
	}
	if w := (ServiceWindow{Mode: WindowDND, From: "10:00", To: "11:00"}).Clean(); w.From != "" || w.To != "" {
		t.Fatalf("dnd keeps no times: %+v", w)
	}
}

func TestFillStayTakesTheVillaHost(t *testing.T) {
	host := "emp-002"
	var villa Booking
	villa.FillStay(KindVilla, &host)
	if villa.HostID == nil || *villa.HostID != host || villa.ServiceWindow.Mode != WindowWindow || villa.Preferences.Setups == nil {
		t.Fatalf("villa stay %+v", villa)
	}
	var room Booking
	room.FillStay(KindRoom, &host)
	if room.HostID != nil || room.ServiceWindow.Mode != WindowScheduled {
		t.Fatalf("room stay %+v", room)
	}
}

func TestLateCheckoutCharge(t *testing.T) {
	base := LateCheckoutRequest{Until: "15:00", CheckOutTime: "12:00", Fee: 500_000}
	for name, c := range map[string]struct {
		req    LateCheckoutRequest
		charge int64
		code   string
	}{
		"room pays the fee":                {withKind(base, KindRoom, "hotel", nil), 500_000, ""},
		"villa without arrival is free":    {withKind(base, KindVilla, "villa", nil), 0, ""},
		"villa with a later arrival pays":  {withKind(base, KindVilla, "villa", &Arrival{Code: "BK-2", Time: "16:00"}), 500_000, ""},
		"mixed charges rooms only":         {withKind(base, KindVilla, "mixed", &Arrival{Code: "BK-2", Time: "16:00"}), 0, ""},
		"arrival before until takes it":    {withKind(base, KindRoom, "hotel", &Arrival{Code: "BK-2", Time: "14:00"}), 0, CodeLateCheckoutTaken},
		"until not after house check-out":  {LateCheckoutRequest{Until: "11:00", CheckOutTime: "12:00", Kind: KindRoom}, 0, errs.CodeValidation},
		"until not a time":                 {LateCheckoutRequest{Until: "late", Kind: KindRoom}, 0, errs.CodeValidation},
		"house default check-out is 12:00": {LateCheckoutRequest{Until: "12:00", Kind: KindVilla}, 0, errs.CodeValidation},
	} {
		charge, err := LateCheckoutCharge(c.req)
		e, _ := errs.As(err)
		switch {
		case c.code == "" && (err != nil || charge != c.charge):
			t.Errorf("%s: %d %v", name, charge, err)
		case c.code != "" && (e == nil || e.Code != c.code):
			t.Errorf("%s: got %v", name, err)
		}
	}
}

func withKind(r LateCheckoutRequest, kind, operation string, arrival *Arrival) LateCheckoutRequest {
	r.Kind, r.Operation, r.Arrival = kind, operation, arrival
	return r
}
