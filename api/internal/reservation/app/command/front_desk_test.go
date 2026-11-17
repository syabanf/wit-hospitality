package command_test

import (
	"encoding/json"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/reservation"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// charges reads the front desk fees reservation appended for billing, oldest first.
func (e env) charges(t *testing.T, eventType string) []reservation.StayCharged {
	t.Helper()
	rows, err := e.db.Pool.Query(ctx, `SELECT payload FROM platform.outbox WHERE event_type = $1 ORDER BY id`, eventType)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []reservation.StayCharged
	for rows.Next() {
		var raw []byte
		var c reservation.StayCharged
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &c); err != nil {
			t.Fatal(err)
		}
		out = append(out, c)
	}
	return out
}

var cardKey = []domain.KeyHanded{{Number: "C-0801", Kind: domain.KeyCard}}

func arrival(keys []domain.KeyHanded) domain.CheckInDetails {
	return domain.CheckInDetails{IDVerified: true, Adults: 2, Keys: keys}
}

// roomInHouse books a Saka room, signs its card on paper and checks it in with one key card.
func (e env) roomInHouse(t *testing.T, unit, in, out string) domain.Booking {
	t.Helper()
	b, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct(unit, "", in, out))
	if err != nil {
		t.Fatal(err)
	}
	desk := command.NewFrontDesk(e.deps)
	if _, err := desk.SignCard.Handle(ctx, dian, b.ID, domain.CardInput{Method: domain.CardPaper, CardNumber: "RC-1"}); err != nil {
		t.Fatal(err)
	}
	if b, err = (command.CheckIn{Deps: e.deps}).Handle(ctx, dian, b.ID, arrival(cardKey)); err != nil {
		t.Fatal(err)
	}
	return b
}

// Saka is a hotel: its check-in waits for the signed card, takes it once, and records the key card
// instead of the old tick.
func TestHotelCheckInNeedsTheRegistrationCard(t *testing.T) {
	e := setup(t)
	desk := command.NewFrontDesk(e.deps)
	b, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-sk-08", "", "2027-03-01", "2027-03-03"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (command.Transition{Deps: e.deps}).Handle(ctx, dian, b.ID, domain.CheckedIn); code(err) != "REGISTRATION_CARD_UNSIGNED" {
		t.Fatalf("plain check-in: %v", err)
	}
	if _, err := (command.CheckIn{Deps: e.deps}).Handle(ctx, dian, b.ID, arrival(nil)); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("no key: %v", err)
	}
	if _, err := (command.CheckIn{Deps: e.deps}).Handle(ctx, dian, b.ID, arrival(cardKey)); code(err) != "REGISTRATION_CARD_UNSIGNED" {
		t.Fatalf("no card: %v", err)
	}
	if _, err := desk.SignCard.Handle(ctx, dian, b.ID, domain.CardInput{Method: domain.CardScreen}); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("no signature: %v", err)
	}
	signed, err := desk.SignCard.Handle(ctx, dian, b.ID, domain.CardInput{Method: domain.CardScreen, Signature: &domain.Attachment{ID: "file-9", Type: "image/png", Name: "signature.png"}})
	if err != nil || signed.RegistrationCard == nil || signed.RegistrationCard.By != "Dian Permata" || signed.RegistrationCard.Where != domain.CardDesk {
		t.Fatalf("signed %v %+v", err, signed.RegistrationCard)
	}
	if _, err := desk.SignCard.Handle(ctx, dian, b.ID, domain.CardInput{Method: domain.CardPaper, CardNumber: "RC-2"}); code(err) != "CARD_ALREADY_SIGNED" {
		t.Fatalf("second card: %v", err)
	}
	in, err := (command.CheckIn{Deps: e.deps}).Handle(ctx, dian, b.ID, arrival(cardKey))
	if err != nil {
		t.Fatal(err)
	}
	if !in.Arrival.KeysHanded || len(in.Keys) != 1 || in.Keys[0].ID != "key-1" || in.Keys[0].Status != domain.KeyOut || in.Keys[0].IssuedBy != "Dian Permata" {
		t.Fatalf("keys %+v arrival %+v", in.Keys, in.Arrival)
	}
	// A villa property does not ask for the card by default.
	e.checkedIn(t, direct("unit-kr-03", "", "2027-03-01", "2027-03-04"))
}

// Early check-in mirrors late check-out: refused while the departing guest holds the room, the fee
// for a room once it is free, free for a villa nobody left, and early_checkin.granted carries it.
func TestEarlyCheckin(t *testing.T) {
	e := setup(t)
	desk := command.NewFrontDesk(e.deps)
	e.roomInHouse(t, "unit-sk-08", "2027-03-01", "2027-03-03")
	next, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-sk-08", "", "2027-03-03", "2027-03-05"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := desk.EarlyCheckIn.Handle(ctx, dian, next.ID, command.EarlyCheckinInput{From: "10:00"}); code(err) != "EARLY_CHECKIN_TAKEN" {
		t.Fatalf("taken: %v", err)
	}
	if _, err := desk.EarlyCheckIn.Handle(ctx, dian, next.ID, command.EarlyCheckinInput{From: "15:00"}); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("after check-in time: %v", err)
	}
	got, err := desk.EarlyCheckIn.Handle(ctx, dian, next.ID, command.EarlyCheckinInput{From: "12:30"})
	if err != nil || got.Charge != 500_000 || got.Booking.EarlyCheckin == nil || got.Booking.EarlyCheckin.From != "12:30" {
		t.Fatalf("early %v %+v", err, got)
	}
	if _, err := desk.EarlyCheckIn.Handle(ctx, dian, next.ID, command.EarlyCheckinInput{From: "12:45"}); code(err) != "BOOKING_INVALID_STATE" {
		t.Fatalf("twice: %v", err)
	}
	villa, err := command.CreateBooking{Deps: e.deps}.Handle(ctx, dian, direct("unit-kr-03", "", "2027-03-10", "2027-03-13"))
	if err != nil {
		t.Fatal(err)
	}
	if free, err := desk.EarlyCheckIn.Handle(ctx, dian, villa.ID, command.EarlyCheckinInput{From: "11:00"}); err != nil || free.Charge != 0 {
		t.Fatalf("villa %v %d", err, free.Charge)
	}
	events := e.charges(t, reservation.EventEarlyCheckinGranted)
	if len(events) != 1 || events[0].BookingID != next.ID || events[0].Code != "EARLY" || events[0].Charge != 500_000 || events[0].ChargeKey() != "early:"+next.ID {
		t.Fatalf("events %+v", events)
	}
}

// Keys go out and come back during the stay; a replaced key carries its fee to billing; check-out
// closes the keys still out and cancels the pending wake-up calls.
func TestKeysAndWakeUpCalls(t *testing.T) {
	e := setup(t)
	desk := command.NewFrontDesk(e.deps)
	b := e.roomInHouse(t, "unit-sk-08", "2027-03-01", "2027-03-04")
	if _, err := desk.IssueKey.Handle(ctx, dian, b.ID, domain.IssueKeyInput{Number: "C-0801", Kind: domain.KeyCard, Reason: domain.KeyExtra}); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("same number: %v", err)
	}
	fee := 100_000.0
	b, err := desk.IssueKey.Handle(ctx, dian, b.ID, domain.IssueKeyInput{Number: "C-0802", Kind: domain.KeyCard, Reason: domain.KeyReplacement, ReplacesKeyID: ptr("key-1"), Fee: &fee})
	if err != nil || b.Keys[0].Status != domain.KeyLost || b.Keys[0].Charge != 100_000 || b.Keys[1].Replaces == nil {
		t.Fatalf("replacement %v %+v", err, b.Keys)
	}
	if b, err = desk.IssueKey.Handle(ctx, dian, b.ID, domain.IssueKeyInput{Number: "C-0803", Kind: domain.KeyCard, Reason: domain.KeyExtra}); err != nil {
		t.Fatal(err)
	}
	if b, err = desk.ReturnKey.Handle(ctx, dian, b.ID, "key-3", domain.ReturnKeyInput{Returned: true}); err != nil || b.Keys[2].Status != domain.KeyReturned {
		t.Fatalf("return %v", err)
	}
	if _, err := desk.ReturnKey.Handle(ctx, dian, b.ID, "key-3", domain.ReturnKeyInput{Returned: true}); code(err) != "KEY_NOT_OUT" {
		t.Fatalf("twice: %v", err)
	}
	keyFees := e.charges(t, reservation.EventKeyCharged)
	if len(keyFees) != 1 || keyFees[0].KeyID != "key-1" || keyFees[0].Code != "DMG" || keyFees[0].Description != "Lost key C-0801" {
		t.Fatalf("key fees %+v", keyFees)
	}

	if _, err := desk.BookWakeUp.Handle(ctx, dian, b.ID, domain.WakeUpInput{Date: "2027-03-05", Time: "06:00"}); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("after the stay: %v", err)
	}
	if b, err = desk.BookWakeUp.Handle(ctx, dian, b.ID, domain.WakeUpInput{Date: "2027-03-02", Time: "06:30", Note: " Taxi ", RepeatDaily: true}); err != nil {
		t.Fatal(err)
	}
	if b, err = desk.WakeUpOutcome.Handle(ctx, dian, b.ID, "wk-1", domain.OutcomeInput{Outcome: domain.WakeDone}); err != nil || b.WakeUpCalls[0].Date != "2027-03-03" {
		t.Fatalf("rolled %v %+v", err, b.WakeUpCalls)
	}
	if b, err = (command.Transition{Deps: e.deps}).Handle(ctx, dian, b.ID, domain.CheckedOut); err != nil {
		t.Fatal(err)
	}
	if b.Keys[1].Status != domain.KeyNotReturned || b.WakeUpCalls[0].Status != domain.WakeCancelled {
		t.Fatalf("after check-out %+v %+v", b.Keys, b.WakeUpCalls)
	}
	if _, err := desk.WakeUpOutcome.Handle(ctx, dian, b.ID, "wk-1", domain.OutcomeInput{Outcome: domain.WakeDone}); code(err) != "BOOKING_INVALID_STATE" {
		t.Fatalf("closed stay: %v", err)
	}
}

// The guest signs the card and books a wake-up call from the stay page, each a guest action.
func TestGuestSignsAndBooksOnTheStayPage(t *testing.T) {
	e := setup(t)
	token := "st7c2e9b41a05d8f63e1b4c9a72d06f5e8"
	page := command.StayPage{Deps: e.deps}
	view, err := page.SignCard(ctx, token, &domain.Attachment{ID: "file-2", Type: "image/png"})
	if err != nil || !view.CardSigned {
		t.Fatalf("sign %v %v", err, view.CardSigned)
	}
	if _, err := page.SignCard(ctx, token, &domain.Attachment{ID: "file-3", Type: "image/png"}); code(err) != "CARD_ALREADY_SIGNED" {
		t.Fatalf("twice: %v", err)
	}
	if view, err = page.BookWakeUp(ctx, token, domain.WakeUpInput{Date: "2026-11-12", Time: "07:00"}); err != nil || len(view.WakeUpCalls) != 1 || view.WakeUpCalls[0].Time != "07:00" {
		t.Fatalf("wake-up %v %+v", err, view.WakeUpCalls)
	}
}
