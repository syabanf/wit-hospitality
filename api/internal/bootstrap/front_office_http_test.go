package bootstrap_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

type roomCheck struct {
	ID          string  `json:"id"`
	FrontOffice string  `json:"frontOffice"`
	BookingCode *string `json:"bookingCode"`
	Discrepancy *string `json:"discrepancy"`
	Resolution  *struct {
		Action string `json:"action"`
		By     string `json:"by"`
	} `json:"resolution"`
}

// seededDiscrepancies is the manager's reason other tests close the seeded day with: the seed
// leaves a room discrepancy open on its business date.
var seededDiscrepancies = map[string]any{"reason": "Seeded discrepancy checked by the manager"}

// clearFrontOffice drops the seeded room checks, card holds and log entries so a test reads its
// own.
func clearFrontOffice(t *testing.T, s server) {
	t.Helper()
	if _, err := s.db.Pool.Exec(context.Background(), `DELETE FROM housekeeping.room_checks; DELETE FROM billing.pre_auths; DELETE FROM billing.log_entries`); err != nil {
		t.Fatal(err)
	}
}

// Housekeeping's round finds a sleeper and a skip; the night audit refuses to close over them
// until the desk resolves one and a manager closes the day over the other with a reason.
func TestRoomDiscrepanciesBlockTheNightAuditUntilResolvedOrOverridden(t *testing.T) {
	t.Parallel()
	s := start(t)
	clearFrontOffice(t, s)
	hk := s.client(t)
	hk.login("sari")
	refused(t, hk.do("PUT", "housekeeping/room-checks", map[string]any{"unitId": "unit-sk-07", "date": "2026-11-12", "found": "vacant"}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	// BK-1294 is in house on SK-07; SK-01 has nobody checked in.
	sleep := created[roomCheck](t, hk.do("PUT", "housekeeping/room-checks", map[string]any{"unitId": "unit-sk-07", "date": "2026-11-11", "found": "vacant", "persons": nil, "note": "Bed not slept in"}), "sleep")
	if sleep.ID != "rc-2026-11-11-unit-sk-07" || sleep.FrontOffice != "occupied" || sleep.BookingCode == nil || *sleep.BookingCode != "BK-1294" || sleep.Discrepancy == nil || *sleep.Discrepancy != "sleep" {
		t.Fatalf("sleep %+v", sleep)
	}
	var free string
	if err := s.db.Pool.QueryRow(context.Background(), `SELECT u.id FROM housekeeping.cat_units u WHERE u.villa_id = 'vil-saka'
		AND NOT EXISTS (SELECT 1 FROM housekeeping.stays s WHERE s.unit_id = u.id AND s.status = 'checked_in') ORDER BY u.code LIMIT 1`).Scan(&free); err != nil {
		t.Fatal(err)
	}
	skip := created[roomCheck](t, hk.do("PUT", "housekeeping/room-checks", map[string]any{"unitId": free, "date": "2026-11-11", "found": "occupied", "persons": 2}), "skip")
	if skip.Discrepancy == nil || *skip.Discrepancy != "skip" {
		t.Fatalf("skip %+v", skip)
	}
	if list := decode[[]roomCheck](t, hk.do("GET", "housekeeping/room-checks", nil)); len(list) != 2 {
		t.Fatalf("the report holds the two checks: %+v", list)
	}

	desk := s.client(t)
	desk.login("dian")
	audit := func(c *client, override any) reply {
		return c.do("POST", "night-audits", map[string]any{"date": "2026-11-11", "checks": map[string]int{"discrepancies": 2}, "noShows": []string{}, "override": override})
	}
	r := audit(desk, nil)
	refused(t, r, http.StatusConflict, "AUDIT_DISCREPANCIES")
	if r.Error.Message != "2 room discrepancies are still open; resolve them before closing the day." {
		t.Fatal(r.Error.Message)
	}
	refused(t, audit(desk, map[string]any{"reason": "Guest confirmed by phone"}), http.StatusConflict, "AUDIT_DISCREPANCIES")
	r = desk.do("POST", "housekeeping/room-checks/"+skip.ID+"/resolve", map[string]any{"action": "guest_out", "note": "Counted"})
	if r.status != http.StatusUnprocessableEntity || r.Error.Fields["action"] != "Guest out for the night does not settle a skip discrepancy." {
		t.Fatalf("an action that does not fit: %d %+v", r.status, r.Error)
	}
	done := created[roomCheck](t, desk.do("POST", "housekeeping/room-checks/"+skip.ID+"/resolve", map[string]any{"action": "housekeeping_error", "note": "Wrong door on the round"}), "resolve")
	if done.Resolution == nil || done.Resolution.By != "Dian Permata" {
		t.Fatalf("resolved %+v", done)
	}
	refused(t, desk.do("POST", "housekeeping/room-checks/"+skip.ID+"/resolve", map[string]any{"action": "housekeeping_error", "note": "Again"}), http.StatusConflict, "DISCREPANCY_RESOLVED")
	refused(t, hk.do("PUT", "housekeeping/room-checks", map[string]any{"unitId": free, "date": "2026-11-11", "found": "vacant"}), http.StatusConflict, "ROOM_CHECK_RESOLVED")

	manager := s.client(t)
	manager.login("kadek")
	r = audit(manager, map[string]any{"reason": "  "})
	if r.Error == nil || r.Error.Message != "Give the reason to close the day over open discrepancies." {
		t.Fatalf("a blank reason: %+v", r.Error)
	}
	closed := created[struct {
		Override *struct{ By, Reason string } `json:"override"`
	}](t, audit(manager, map[string]any{"reason": " Guest confirmed by phone "}), "audit")
	if closed.Override == nil || closed.Override.By != "Kadek Ariani" || closed.Override.Reason != "Guest confirmed by phone" {
		t.Fatalf("override %+v", closed.Override)
	}
	var summary string
	if err := s.db.Pool.QueryRow(context.Background(), `SELECT summary FROM platform.audit_log WHERE entity = 'night-audit' ORDER BY at DESC LIMIT 1`).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(summary, ", over 1 open discrepancies") {
		t.Fatal(summary)
	}
}

type preAuth struct {
	ID           string  `json:"id"`
	Number       string  `json:"number"`
	Status       string  `json:"status"`
	ApprovalCode string  `json:"approvalCode"`
	Captured     int64   `json:"captured"`
	PaymentID    *string `json:"paymentId"`
}

// A card hold on a stay arriving: the gateway declines a card ending 0000, one hold stands per
// stay, a capture inside the hold and the room balance makes a paid card payment, and a closed
// hold takes nothing more.
func TestACardHoldIsTakenCapturedAndReleased(t *testing.T) {
	t.Parallel()
	s := start(t)
	clearFrontOffice(t, s)
	c := s.client(t)
	c.login("dian")
	b := created[struct {
		ID string `json:"id"`
	}](t, c.do("POST", "bookings", stay("unit-kr-03", "", "2027-01-10", "2027-01-12")), "stay")
	hold := func(last4, code string) reply {
		return c.do("POST", "pre-auths", map[string]any{"bookingId": b.ID, "amount": 2000000, "brand": "visa", "last4": last4, "approvalCode": code, "expiresOn": "2026-11-20"})
	}
	r := hold("0000", "")
	refused(t, r, http.StatusConflict, "PREAUTH_DECLINED")
	if r.Error.Message != "The gateway declined the hold on Visa ending 0000." {
		t.Fatal(r.Error.Message)
	}
	r = c.do("POST", "pre-auths", map[string]any{"bookingId": b.ID, "amount": 2000000, "brand": "visa", "last4": "4242", "cardNumber": "4242424242424242", "approvalCode": "", "expiresOn": "2026-12-31"})
	if r.status != http.StatusUnprocessableEntity || r.Error.Fields["expiresOn"] != "A card hold stands at most 30 days." {
		t.Fatalf("a hold past 30 days: %d %+v", r.status, r.Error)
	}
	first := created[preAuth](t, hold("4242", ""), "hold")
	if first.Status != "active" || !strings.HasPrefix(first.ApprovalCode, "A") || len(first.ApprovalCode) != 6 {
		t.Fatalf("hold %+v", first)
	}
	refused(t, hold("4242", "AB1234"), http.StatusConflict, "PREAUTH_ACTIVE")
	r = c.do("POST", "pre-auths/"+first.ID+"/capture", map[string]any{"amount": 2500000})
	if r.status != http.StatusUnprocessableEntity || r.Error.Fields["amount"] != "Only 2.000.000 is held." {
		t.Fatalf("past the hold: %d %+v", r.status, r.Error)
	}
	got := created[struct {
		PreAuth preAuth `json:"preAuth"`
		Payment struct {
			ID, Kind, Method, Status, Note, Reference string
			Amount, GatewayFee                        int64
		} `json:"payment"`
	}](t, c.do("POST", "pre-auths/"+first.ID+"/capture", map[string]any{"amount": 1500000}), "capture")
	if got.PreAuth.Status != "captured" || got.PreAuth.Captured != 1500000 || got.PreAuth.PaymentID == nil || *got.PreAuth.PaymentID != got.Payment.ID {
		t.Fatalf("captured hold %+v", got.PreAuth)
	}
	if got.Payment.Kind != "balance" || got.Payment.Method != "card" || got.Payment.Status != "paid" || got.Payment.Amount != 1500000 ||
		got.Payment.Note != "Captured from "+first.Number || got.Payment.Reference != first.ApprovalCode || got.Payment.GatewayFee <= 0 {
		t.Fatalf("payment %+v", got.Payment)
	}
	refused(t, c.do("POST", "pre-auths/"+first.ID+"/release", nil), http.StatusConflict, "PREAUTH_CLOSED")
	second := created[preAuth](t, hold("1111", "AB1234"), "second hold")
	if second.ApprovalCode != "AB1234" {
		t.Fatalf("the desk's approval code stays: %+v", second)
	}
	if released := created[preAuth](t, c.do("POST", "pre-auths/"+second.ID+"/release", nil), "release"); released.Status != "released" {
		t.Fatalf("released %+v", released)
	}
	if list := decode[[]preAuth](t, c.do("GET", "pre-auths", nil)); len(list) != 2 || list[0].ID != first.ID {
		t.Fatalf("holds oldest first: %+v", list)
	}
	hr := s.client(t)
	hr.login("nia")
	refused(t, hr.do("POST", "pre-auths", map[string]any{"bookingId": b.ID}), http.StatusForbidden, "FORBIDDEN")
}

type logEntry struct {
	ID             string  `json:"id"`
	Shift          string  `json:"shift"`
	Date           string  `json:"date"`
	Author         string  `json:"author"`
	Category       string  `json:"category"`
	VillaID        *string `json:"villaId"`
	FollowUp       bool    `json:"followUp"`
	AcknowledgedBy *string `json:"acknowledgedBy"`
	DoneBy         *string `json:"doneBy"`
	ShiftID        *string `json:"shiftId"`
	Link           *struct {
		Kind, ID, Label string
	} `json:"link"`
}

// The desk writes a follow-up; the next shift acknowledges it, anyone marks it done, and a
// cashier's shift close writes its handover into the log book.
func TestTheLogBookCarriesFollowUpsAndTheCashierHandover(t *testing.T) {
	t.Parallel()
	s := start(t)
	clearFrontOffice(t, s)
	dian := s.client(t)
	dian.login("dian")
	r := dian.do("POST", "log-book", map[string]any{"category": "gossip", "text": "x", "villaId": nil, "link": map[string]any{"kind": "booking", "id": "bk-nope"}, "followUp": false})
	if r.status != http.StatusUnprocessableEntity || r.Error.Fields["category"] != "Pick a category." || r.Error.Fields["text"] != "Write what the next shift needs to know." || r.Error.Fields["link"] != "That booking, room or guest was not found." {
		t.Fatalf("fields %d %+v", r.status, r.Error)
	}
	note := created[logEntry](t, dian.do("POST", "log-book", map[string]any{"category": "guest", "text": "Guest of KR-03 asks for an airport car at 05:00", "villaId": "vil-karang",
		"link": map[string]any{"kind": "booking", "id": "bk-1296"}, "followUp": true}), "note")
	if note.Shift != "morning" || note.Date != "2026-11-11" || note.Author != "Dian Permata" || note.Link == nil || note.Link.Label != "BK-1296" || !note.FollowUp {
		t.Fatalf("note %+v", note)
	}
	plain := created[logEntry](t, dian.do("POST", "log-book", map[string]any{"category": "other", "text": "Printer paper restocked", "villaId": nil, "link": nil, "followUp": false}), "plain")
	refused(t, dian.do("POST", "log-book/"+plain.ID+"/acknowledge", nil), http.StatusConflict, "LOG_NO_FOLLOW_UP")
	refused(t, dian.do("POST", "log-book/"+note.ID+"/acknowledge", nil), http.StatusConflict, "LOG_OWN_ENTRY")
	kadek := s.client(t)
	kadek.login("kadek")
	if ack := created[logEntry](t, kadek.do("POST", "log-book/"+note.ID+"/acknowledge", nil), "acknowledge"); ack.AcknowledgedBy == nil || *ack.AcknowledgedBy != "Kadek Ariani" {
		t.Fatalf("acknowledged %+v", ack)
	}
	r = kadek.do("POST", "log-book/"+note.ID+"/acknowledge", nil)
	if r.Error == nil || r.Error.Code != "LOG_ACKNOWLEDGED" || r.Error.Message != "Kadek Ariani acknowledged it at 10:00." {
		t.Fatalf("acknowledged twice: %+v", r.Error)
	}
	if done := created[logEntry](t, dian.do("POST", "log-book/"+note.ID+"/done", map[string]any{"note": "Car booked"}), "done"); done.DoneBy == nil {
		t.Fatalf("done %+v", done)
	}
	refused(t, dian.do("POST", "log-book/"+note.ID+"/done", map[string]any{"note": ""}), http.StatusConflict, "LOG_DONE")
	if list := decode[[]logEntry](t, dian.do("GET", "log-book", nil)); len(list) != 2 || list[0].ID != plain.ID {
		t.Fatalf("newest first: %+v", list)
	}
	wayan := s.client(t)
	wayan.login("wayan")
	if list := decode[[]logEntry](t, wayan.do("GET", "log-book", nil)); len(list) != 1 || list[0].ID != plain.ID {
		t.Fatalf("Saka's staff do not see Karang's note: %+v", list)
	}
	ida := s.client(t)
	ida.login("ida")
	refused(t, ida.do("POST", "log-book", map[string]any{"category": "cash", "text": "Float topped up", "followUp": false}), http.StatusForbidden, "FORBIDDEN")

	closed := created[struct {
		LogEntryID *string `json:"logEntryId"`
	}](t, wayan.do("POST", "cashier-shifts/cs-8/close", map[string]any{"count": map[string]any{"notes": map[string]any{"100000": 10}}, "reason": "Counted with the night cashier", "handover": " Two guests pay at check-out tomorrow "}), "close")
	if closed.LogEntryID == nil {
		t.Fatal("the close links its handover entry")
	}
	for _, e := range decode[[]logEntry](t, wayan.do("GET", "log-book", nil)) {
		if e.ID == *closed.LogEntryID {
			if e.Category != "handover" || e.ShiftID == nil || *e.ShiftID != "cs-8" || e.Author != "Wayan Sudiarta" || e.VillaID != nil {
				t.Fatalf("handover entry %+v", e)
			}
			return
		}
	}
	t.Fatal("the handover entry is in the log book")
}
