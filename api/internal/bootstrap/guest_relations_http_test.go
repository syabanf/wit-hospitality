package bootstrap_test

import (
	"net/http"
	"testing"
	"time"
)

type folioPosting struct {
	Kind        string  `json:"kind"`
	Code        string  `json:"code"`
	Description string  `json:"description"`
	Amount      int64   `json:"amount"`
	Service     *int64  `json:"service"`
	PB1         *int64  `json:"pb1"`
	LineID      *string `json:"lineId"`
	PostedBy    string  `json:"postedBy"`
}

func (p folioPosting) gross() int64 {
	g := p.Amount
	if p.Service != nil {
		g += *p.Service
	}
	if p.PB1 != nil {
		g += *p.PB1
	}
	return g
}

// postingsNamed waits for the folio postings of bk-1294 with that description, as billing posts
// them from guest's request.
func postingsNamed(t *testing.T, c *client, description string, want int) []folioPosting {
	t.Helper()
	var got []folioPosting
	for range 50 {
		got = got[:0]
		for _, p := range decode[[]folioPosting](t, c.do("GET", "bookings/bk-1294/folio", nil)) {
			if p.Description == description {
				got = append(got, p)
			}
		}
		if len(got) >= want {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	return got
}

type complaintReply struct {
	ID           string `json:"id"`
	Number       string `json:"number"`
	Status       string `json:"status"`
	Source       string `json:"source"`
	Compensation *struct {
		Status string `json:"status"`
	} `json:"compensation"`
}

// Guest relations over HTTP: a credit under the limit lands on the folio once, a larger one by
// staff waits for the manager, an incident's damage posts on DMG, a box closed without its key
// charges the fee, and the stay page files an open complaint.
func TestGuestRelations(t *testing.T) {
	t.Parallel()
	s := start(t)
	staff, manager, guest := s.client(t), s.client(t), s.client(t)
	staff.login("wayan")
	manager.login("kadek")

	complaint := map[string]any{"villaId": "vil-saka", "bookingId": "bk-1294", "category": "noise", "severity": "high",
		"description": "Music from the next room past midnight", "receivedBy": "Wayan", "receivedAt": "2026-11-11T08:30", "owner": "Wayan"}
	r := staff.do("POST", "complaints", complaint)
	if r.status != http.StatusCreated {
		t.Fatalf("log complaint: %d %+v", r.status, r.Error)
	}
	small := decode[complaintReply](t, r)
	r = staff.do("POST", "complaints/"+small.ID+"/resolve", map[string]any{"action": "Moved the guest",
		"compensation": map[string]any{"kind": "folio_credit", "amount": 300_000, "description": "Dinner on us"}})
	if got := decode[complaintReply](t, r); got.Status != "resolved" || got.Compensation.Status != "posted" {
		t.Fatalf("small credit %+v", got)
	}
	credit := postingsNamed(t, staff, "Compensation for "+small.Number+": Dinner on us", 1)
	if len(credit) != 1 || credit[0].Kind != "rebate" || credit[0].Code != "ROOM" || credit[0].gross() != 300_000 || credit[0].LineID != nil || credit[0].PostedBy != "Wayan Sudiarta" {
		t.Fatalf("credit on the folio %+v", credit)
	}

	big := decode[complaintReply](t, staff.do("POST", "complaints", complaint))
	r = staff.do("POST", "complaints/"+big.ID+"/resolve", map[string]any{"action": "Moved the guest",
		"compensation": map[string]any{"kind": "folio_credit", "amount": 900_000, "description": "A night off"}})
	if got := decode[complaintReply](t, r); got.Compensation.Status != "pending_approval" {
		t.Fatalf("large credit waits %+v", got)
	}
	refused(t, staff.do("POST", "complaints/"+big.ID+"/compensation", map[string]any{"approve": true}), http.StatusForbidden, "FORBIDDEN")
	r = manager.do("POST", "complaints/"+big.ID+"/compensation", map[string]any{"approve": true, "note": ""})
	if got := decode[complaintReply](t, r); got.Compensation.Status != "posted" {
		t.Fatalf("approved %+v", got)
	}
	if got := postingsNamed(t, staff, "Compensation for "+big.Number+": A night off", 1); len(got) != 1 || got[0].PostedBy != "Kadek Ariani" {
		t.Fatalf("approved credit %+v", got)
	}

	incident := map[string]any{"kind": "damage", "severity": "medium", "villaId": "vil-saka", "bookingId": "bk-1294", "occurredAt": "2026-11-11T07:00",
		"description": "Bathroom mirror cracked", "people": []any{map[string]any{"kind": "guest", "name": "The guest", "guestId": nil, "note": ""}}, "attachments": []any{}}
	r = staff.do("POST", "incidents", incident)
	if r.status != http.StatusCreated {
		t.Fatalf("log incident: %d %+v", r.status, r.Error)
	}
	inc := decode[struct {
		ID, Number string
	}](t, r)
	if r := staff.do("POST", "incidents/"+inc.ID+"/charge", map[string]any{"amount": 650_000, "reason": "Mirror"}); r.status != http.StatusOK {
		t.Fatalf("charge: %d %+v", r.status, r.Error)
	}
	if got := postingsNamed(t, staff, "Damage, "+inc.Number+": Mirror", 1); len(got) != 1 || got[0].Code != "DMG" || got[0].Kind != "charge" || got[0].gross() != 650_000 {
		t.Fatalf("damage %+v", got)
	}
	refused(t, staff.do("POST", "incidents/"+inc.ID+"/charge", map[string]any{"amount": 1, "reason": "again"}), http.StatusConflict, "INCIDENT_ALREADY_CHARGED")

	box := decode[struct{ ID string }](t, staff.do("POST", "safe-boxes", map[string]any{"villaId": "vil-saka", "number": "R9", "size": "small", "note": ""}))
	r = staff.do("POST", "safe-box-rentals", map[string]any{"boxId": box.ID, "bookingId": "bk-1294", "items": "Passport", "keyNumber": "K9", "signature": "paper", "signatureData": ""})
	if r.status != http.StatusCreated {
		t.Fatalf("open box: %d %+v", r.status, r.Error)
	}
	rental := decode[struct{ ID, Number string }](t, r)
	if r := staff.do("POST", "safe-box-rentals/"+rental.ID+"/close", map[string]any{"keyReturned": false, "keyFee": 200_000, "signature": "paper", "signatureData": "", "note": ""}); r.status != http.StatusOK {
		t.Fatalf("close box: %d %+v", r.status, r.Error)
	}
	if got := postingsNamed(t, staff, "Lost safe box key, box R9 ("+rental.Number+")", 1); len(got) != 1 || got[0].gross() != 200_000 {
		t.Fatalf("key fee %+v", got)
	}

	// The stay page: a field error, then an open complaint from the guest.
	refused(t, guest.do("POST", "stay/"+roomStayToken+"/complaints", map[string]string{"category": "noise", "description": "no"}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	if r := guest.do("POST", "stay/"+roomStayToken+"/complaints", map[string]string{"category": "noise", "description": "Drilling next door since 8"}); r.status != http.StatusOK {
		t.Fatalf("stay page complaint: %d %+v", r.status, r.Error)
	}
	var filed *complaintReply
	for _, c := range decode[[]complaintReply](t, staff.do("GET", "complaints", nil)) {
		if c.Source == "stay_page" {
			filed = &c
		}
	}
	if filed == nil || filed.Status != "open" {
		t.Fatalf("stay page complaint lands open: %+v", filed)
	}
}
