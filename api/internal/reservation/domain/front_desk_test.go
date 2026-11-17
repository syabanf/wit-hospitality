package domain

import (
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// said is an error as "CODE: message", or "ok".
func said(err error) string {
	if err == nil {
		return "ok"
	}
	if e, ok := errs.As(err); ok {
		return e.Code + ": " + e.Message
	}
	return err.Error()
}

func TestRegistrationCardRules(t *testing.T) {
	png := &Attachment{ID: "file-1", Name: "signature.png", Type: "image/png"}
	cases := []struct {
		in   CardInput
		want string
	}{
		{CardInput{Method: CardScreen, Signature: png}, "ok"},
		{CardInput{Method: CardScreen}, "VALIDATION_ERROR: Ask the guest to sign on the screen."},
		{CardInput{Method: CardScreen, Signature: &Attachment{ID: "f", Type: "application/pdf"}}, "VALIDATION_ERROR: The signature must be an image."},
		{CardInput{Method: CardPaper, CardNumber: "  "}, "VALIDATION_ERROR: Enter the number printed on the paper card."},
		{CardInput{Method: "fax"}, "VALIDATION_ERROR: Pick signed on screen or on paper."},
	}
	for _, c := range cases {
		if got := said(ValidateRegistrationCard(c.in)); got != c.want {
			t.Errorf("%+v: %s, want %s", c.in, got, c.want)
		}
	}
	b := Booking{Code: "BK-1", Status: Confirmed}
	if got := said(b.CheckCardSigned(true)); got != "REGISTRATION_CARD_UNSIGNED: Have the guest sign the registration card before check-in." {
		t.Error(got)
	}
	if err := b.SignCard(CardInput{Method: CardPaper, CardNumber: " RC-1 "}, "Wayan", CardDesk, "2026-11-11T14:00:00"); err != nil || b.RegistrationCard.CardNumber != "RC-1" {
		t.Fatal(err, b.RegistrationCard)
	}
	if got := said(b.SignCard(CardInput{Method: CardScreen, Signature: png}, "Guest", CardStay, "x")); got != "CARD_ALREADY_SIGNED: BK-1 already has a signed registration card." {
		t.Error(got)
	}
	over := Booking{Code: "BK-2", Status: CheckedOut}
	if got := said(over.SignCard(CardInput{Method: CardScreen, Signature: png}, "Guest", CardStay, "x")); got != "BOOKING_INVALID_STATE: This stay is over; its registration card no longer changes." {
		t.Error(got)
	}
}

func TestEarlyCheckinCharge(t *testing.T) {
	room := EarlyCheckinRequest{From: "10:00", CheckInTime: "14:00", Kind: KindRoom, Operation: OperationHotel, Fee: 500_000, UnitCode: "SK-01"}
	leaving := &Departure{Code: "BK-9", LeavesBy: "12:00"}
	cases := []struct {
		name string
		req  EarlyCheckinRequest
		want int64
		err  string
	}{
		{"a room pays", room, 500_000, "ok"},
		{"a villa nobody left comes in free", EarlyCheckinRequest{From: "10:00", CheckInTime: "14:00", Kind: KindVilla, Operation: "villa", Fee: 300_000}, 0, "ok"},
		{"a villa after a departure pays", EarlyCheckinRequest{From: "13:00", CheckInTime: "14:00", Kind: KindVilla, Operation: "villa", Fee: 300_000, Departure: leaving}, 300_000, "ok"},
		{"a mixed property never charges its villas", EarlyCheckinRequest{From: "13:00", CheckInTime: "14:00", Kind: KindVilla, Operation: OperationMixed, Fee: 300_000, Departure: leaving}, 0, "ok"},
		{"not a time", EarlyCheckinRequest{From: "9am", CheckInTime: "14:00"}, 0, "VALIDATION_ERROR: Enter the time the guest arrives as HH:MM."},
		{"not early", EarlyCheckinRequest{From: "14:00", CheckInTime: "14:00"}, 0, "VALIDATION_ERROR: Check-in is from 14:00 anyway; early check-in comes before it."},
		{"the departing guest holds the room", EarlyCheckinRequest{From: "10:00", CheckInTime: "14:00", Kind: KindRoom, UnitCode: "SK-01", Departure: leaving}, 0, "EARLY_CHECKIN_TAKEN: BK-9 still holds SK-01 until 12:00."},
	}
	for _, c := range cases {
		got, err := EarlyCheckinCharge(c.req)
		if said(err) != c.err || (err == nil && got != c.want) {
			t.Errorf("%s: %d %s, want %d %s", c.name, got, said(err), c.want, c.err)
		}
	}
	b := Booking{Code: "BK-2", Status: CheckedIn, UnitAssigned: true}
	if got := said(b.CheckEarlyCheckinOpen()); got != "BOOKING_INVALID_STATE: BK-2 is checked in; early check-in is set before arrival." {
		t.Error(got)
	}
	stays := []Booking{{ID: "a", Code: "BK-9", UnitID: "u", UnitAssigned: true, CheckOut: "2026-11-12", Status: CheckedIn, LateCheckout: &LateCheckout{Until: "15:00"}}}
	if d := DepartureOf(Booking{ID: "b", UnitID: "u", CheckIn: "2026-11-12"}, stays, "12:00"); d == nil || d.LeavesBy != "15:00" {
		t.Errorf("departure %+v", d)
	}
}

func TestKeys(t *testing.T) {
	if got := CheckInKeysProblem(nil, false, KindRoom); got != "Record the room key card handed over." {
		t.Error(got)
	}
	if got := CheckInKeysProblem(nil, true, KindRoom); got != "" {
		t.Error(got)
	}
	if got := CheckInKeysProblem([]KeyHanded{{"C-1", KeyCard}, {"c-1", KeyCard}}, false, KindRoom); got != "c-1 is already out on this stay." {
		t.Error(got)
	}
	b := Booking{Code: "BK-3", Status: CheckedIn}
	key := b.AddKey(KeyHanded{" C-0101 ", KeyCard}, KeyAtCheckIn, nil, "Wayan", "t1")
	if key.ID != "key-1" || key.Number != "C-0101" || key.Status != KeyOut {
		t.Fatalf("%+v", key)
	}
	err := b.ValidateIssueKey(IssueKeyInput{Number: "", Kind: "badge", Reason: KeyReplacement, ReplacesKeyID: ptr("key-9"), Fee: ptr(-1.0)})
	e, _ := errs.As(err)
	if e == nil || len(e.Fields) != 4 {
		t.Fatalf("%v", err)
	}
	if _, err := b.CloseKey("key-1", KeyLost, 100_000, "Wayan", "t2"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.CloseKey("key-1", KeyReturned, 0, "Wayan", "t3"); said(err) != "KEY_NOT_OUT: C-0101 is not out." {
		t.Error(said(err))
	}
	if b.Keys[0].KeyChargeDescription() != "Lost key C-0101" {
		t.Error(b.Keys[0].KeyChargeDescription())
	}
	b.AddKey(KeyHanded{"C-0102", KeyCard}, KeyReplacement, ptr("key-1"), "Wayan", "t2")
	if back := b.EndStay("Wayan", "t4", true); back || b.Keys[1].Status != KeyNotReturned {
		t.Errorf("end stay %v %+v", back, b.Keys[1])
	}
}

func TestWakeUpCalls(t *testing.T) {
	b := Booking{Code: "BK-4", Status: CheckedIn, CheckIn: "2026-11-10", CheckOut: "2026-11-13"}
	if got := said(b.ValidateWakeUp(WakeUpInput{Date: "2026-11-10", Time: "06:00"}, "2026-11-11")); got != "VALIDATION_ERROR: Pick today or a later day." {
		t.Error(got)
	}
	if got := said(b.ValidateWakeUp(WakeUpInput{Date: "2026-11-14", Time: "6"}, "2026-11-11")); got != "VALIDATION_ERROR: Pick a day of the stay, from 2026-11-10 to 2026-11-13." {
		t.Error(got)
	}
	call := b.AddWakeUp(WakeUpInput{Date: "2026-11-12", Time: "06:00", RepeatDaily: true}, "Wayan", "t")
	if _, err := b.WakeUpAfter(call.ID, WakeDone, "Wayan", "t"); err != nil || b.WakeUpCalls[0].Date != "2026-11-13" || b.WakeUpCalls[0].Status != WakePending {
		t.Fatalf("%v %+v", err, b.WakeUpCalls[0])
	}
	if _, err := b.WakeUpAfter(call.ID, WakeNoAnswer, "Wayan", "t"); err != nil || b.WakeUpCalls[0].Status != WakePending {
		t.Fatal(err)
	}
	if _, err := b.WakeUpAfter(call.ID, WakeDone, "Wayan", "t"); err != nil || b.WakeUpCalls[0].Status != WakeDone {
		t.Fatal(err)
	}
	if _, err := b.WakeUpAfter(call.ID, WakeCancelled, "Wayan", "t"); said(err) != "WAKE_UP_CLOSED: This wake-up call is done already." {
		t.Error(said(err))
	}
	if _, err := b.WakeUpAfter(call.ID, "snooze", "Wayan", "t"); said(err) != "VALIDATION_ERROR: Pick done, no answer or cancel." {
		t.Error(said(err))
	}
	next := b.AddWakeUp(WakeUpInput{Date: "2026-11-13", Time: "07:00"}, "Guest", "t")
	b.EndStay("Wayan", "t", true)
	if c := b.WakeUpCalls[1]; c.ID != next.ID || c.Status != WakeCancelled || c.Log[0].By != SystemActor {
		t.Errorf("%+v", c)
	}
}
