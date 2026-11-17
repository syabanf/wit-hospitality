package bootstrap_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// signCard signs a stay's registration card on paper, as the desk does before a hotel check-in.
func signCard(t *testing.T, c *client, bookingID string) {
	t.Helper()
	if r := c.do("POST", "bookings/"+bookingID+"/registration-card", map[string]any{"method": "paper", "cardNumber": "RC-" + bookingID}); r.status != http.StatusOK {
		t.Fatalf("sign the card of %s: %d %+v", bookingID, r.status, r.Error)
	}
}

type deskStay struct {
	ID               string `json:"id"`
	Status           string `json:"status"`
	RegistrationCard *struct {
		Method    string `json:"method"`
		Where     string `json:"where"`
		By        string `json:"by"`
		Signature *struct {
			ID string `json:"id"`
		} `json:"signature"`
	} `json:"registrationCard"`
	Keys []struct {
		ID     string `json:"id"`
		Number string `json:"number"`
		Status string `json:"status"`
		Charge int64  `json:"charge"`
	} `json:"keys"`
	WakeUpCalls []struct {
		ID     string `json:"id"`
		Date   string `json:"date"`
		Status string `json:"status"`
	} `json:"wakeUpCalls"`
}

// folioHas waits for billing to post a line with the description on the stay's folio.
func folioHas(t *testing.T, c *client, bookingID, description string) {
	t.Helper()
	for range 50 {
		for _, p := range decode[[]map[string]any](t, c.do("GET", "bookings/"+bookingID+"/folio", nil)) {
			if p["description"] == description {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("no folio line %q on %s", description, bookingID)
}

// The desk's four steps over HTTP: a hotel check-in waits for the card signed with an uploaded
// signature and records the key card; a lost key's fee and an early check-in reach the folio from
// their events; a wake-up call rolls on and check-out closes what is left. The guest signs and books
// from the online check-in and the stay page without a session.
func TestFrontDeskSteps(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	guest := s.client(t)

	b := created[deskStay](t, c.do("POST", "bookings", stay("unit-sk-08", "", "2027-03-01", "2027-03-04")), "stay")
	refused(t, c.do("POST", "bookings/"+b.ID+"/check-in", nil), http.StatusConflict, "REGISTRATION_CARD_UNSIGNED")
	sig := decode[struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	}](t, c.upload("signature.png", "image/png", pngBytes))
	signed := created[deskStay](t, c.do("POST", "bookings/"+b.ID+"/registration-card", map[string]any{"method": "screen", "signature": map[string]any{"id": sig.ID, "type": sig.Type, "name": "signature.png"}}), "card")
	if signed.RegistrationCard == nil || signed.RegistrationCard.Signature == nil || signed.RegistrationCard.Signature.ID != sig.ID || signed.RegistrationCard.Where != "desk" {
		t.Fatalf("card %+v", signed.RegistrationCard)
	}
	refused(t, c.do("POST", "bookings/"+b.ID+"/registration-card", map[string]any{"method": "paper", "cardNumber": "RC-1"}), http.StatusConflict, "CARD_ALREADY_SIGNED")
	refused(t, c.do("POST", "bookings/"+b.ID+"/check-in", map[string]any{"idVerified": true, "adults": 2, "deposit": 0}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	in := created[deskStay](t, c.do("POST", "bookings/"+b.ID+"/check-in", map[string]any{"idVerified": true, "adults": 2, "deposit": 0, "keys": []map[string]string{{"number": "C-0801", "kind": "card"}}}), "check in")
	if in.Status != "checked_in" || len(in.Keys) != 1 || in.Keys[0].Status != "out" {
		t.Fatalf("checked in %+v", in)
	}

	replaced := created[deskStay](t, c.do("POST", "bookings/"+b.ID+"/keys", map[string]any{"number": "C-0802", "kind": "card", "reason": "replacement", "replacesKeyId": "key-1", "fee": 100000}), "replacement")
	if replaced.Keys[0].Status != "lost" || replaced.Keys[0].Charge != 100000 {
		t.Fatalf("replaced %+v", replaced.Keys)
	}
	folioHas(t, c, b.ID, "Lost key C-0801")
	refused(t, c.do("POST", "bookings/"+b.ID+"/keys/key-1/return", map[string]any{"returned": true}), http.StatusConflict, "KEY_NOT_OUT")

	booked := created[deskStay](t, c.do("POST", "bookings/"+b.ID+"/wake-up-calls", map[string]any{"date": "2027-03-02", "time": "06:30", "note": "", "repeatDaily": true}), "wake-up")
	done := created[deskStay](t, c.do("POST", "bookings/"+b.ID+"/wake-up-calls/"+booked.WakeUpCalls[0].ID, map[string]any{"outcome": "done"}), "done")
	if done.WakeUpCalls[0].Date != "2027-03-03" || done.WakeUpCalls[0].Status != "pending" {
		t.Fatalf("rolled %+v", done.WakeUpCalls)
	}

	// The next guest in SK-08 comes in early once the stay leaves: the fee reaches their folio.
	next := created[deskStay](t, c.do("POST", "bookings", stay("unit-sk-08", "", "2027-03-04", "2027-03-06")), "next")
	refused(t, c.do("POST", "bookings/"+next.ID+"/early-checkin", map[string]any{"from": "10:00"}), http.StatusConflict, "EARLY_CHECKIN_TAKEN")
	early := decode[struct {
		Charge int64 `json:"charge"`
	}](t, c.do("POST", "bookings/"+next.ID+"/early-checkin", map[string]any{"from": "12:30"}))
	if early.Charge != 500000 {
		t.Fatalf("early charge %d", early.Charge)
	}
	folioHas(t, c, next.ID, "Early check-in from 12:30")

	out := created[deskStay](t, c.do("POST", "bookings/"+b.ID+"/check-out", nil), "check out")
	if out.Keys[1].Status != "not_returned" || out.WakeUpCalls[0].Status != "cancelled" {
		t.Fatalf("after check-out %+v %+v", out.Keys, out.WakeUpCalls)
	}

	// The guest signs on the online check-in of the next stay and books a call on the stay page.
	token := domain.CheckinToken(next.ID)
	if r := guest.do("POST", "checkin/"+token+"/registration-card", map[string]any{"signature": map[string]any{"id": sig.ID, "type": "image/png"}}); r.status != http.StatusOK || !decode[struct {
		CardSigned bool `json:"cardSigned"`
	}](t, r).CardSigned {
		t.Fatalf("online check-in card: %d %+v", r.status, r.Error)
	}
	view := decode[struct {
		WakeUpCalls []struct {
			Time string `json:"time"`
		} `json:"wakeUpCalls"`
		CardSigned bool `json:"cardSigned"`
	}](t, guest.do("POST", "stay/"+villaStayToken+"/wake-up-calls", map[string]any{"date": "2026-11-12", "time": "07:00", "note": "", "repeatDaily": false}))
	if len(view.WakeUpCalls) != 1 || view.WakeUpCalls[0].Time != "07:00" || view.CardSigned {
		t.Fatalf("stay page %+v", view)
	}
}
