package bootstrap_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

type guestRow struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedOn string `json:"createdOn"`
	Blacklist *struct {
		Reason string `json:"reason"`
		SetBy  string `json:"setBy"`
	} `json:"blacklist"`
}

type lostItem struct {
	ID      string `json:"id"`
	Number  string `json:"number"`
	Status  string `json:"status"`
	History []struct {
		Status string `json:"status"`
	} `json:"history"`
}

func TestGuestCreateReachesTheListAndTheTrail(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("dian")
	r := c.do("POST", "guests", map[string]any{"name": "Chris Hall", "email": "chris.hall@example.com", "phone": "+61 400 111 222", "nationality": "AU", "idType": "passport", "idNumber": "PB1112223", "notes": ""})
	if r.status != http.StatusCreated || decode[guestRow](t, r).ID != "g-27" {
		t.Fatalf("create guest: %d %+v %s", r.status, r.Error, r.Data)
	}
	guests := decode[[]guestRow](t, c.do("GET", "guests", nil))
	if len(guests) != 27 || guests[26].Name != "Chris Hall" || guests[26].CreatedOn != "2026-11-11" {
		t.Fatalf("guests after create: %d", len(guests))
	}
	bad := c.do("POST", "guests", map[string]any{"name": "C", "email": "", "phone": "", "nationality": "AU", "idType": "passport", "idNumber": "", "notes": ""})
	if bad.status != http.StatusUnprocessableEntity || bad.Error.Message != "Enter the guest name." {
		t.Fatalf("invalid guest: %d %+v", bad.status, bad.Error)
	}
	owner := s.client(t)
	owner.login("rama")
	trail := decode[[]map[string]any](t, owner.do("GET", "audit", nil))
	if trail[1]["summary"] != "Added guest Chris Hall" || trail[1]["userId"] != "usr-dian" {
		t.Fatalf("audit line before Rama's login: %v", trail[1])
	}
}

func TestBlacklistRefusalAndApproval(t *testing.T) {
	t.Parallel()
	s := start(t)
	staff := s.client(t)
	staff.login("wayan")
	r := staff.do("PUT", "guests/g-02/blacklist", map[string]string{"reason": "Smoked indoors twice"})
	if r.status != http.StatusForbidden || r.Error.Code != "FORBIDDEN" || r.Error.Message != "Only someone who may approve in the guest module can change the blacklist." {
		t.Fatalf("staff blacklisting: %d %+v", r.status, r.Error)
	}
	manager := s.client(t)
	manager.login("kadek")
	if r := manager.do("PUT", "guests/g-02/blacklist", map[string]string{"reason": "no"}); r.status != http.StatusUnprocessableEntity || r.Error.Message != "Say why the guest is blacklisted." {
		t.Fatalf("short reason: %d %+v", r.status, r.Error)
	}
	g := decode[guestRow](t, manager.do("PUT", "guests/g-02/blacklist", map[string]string{"reason": "Smoked indoors twice"}))
	if g.Blacklist == nil || g.Blacklist.SetBy != "Kadek Ariani" {
		t.Fatalf("blacklisted: %+v", g)
	}
	if g := decode[guestRow](t, manager.do("DELETE", "guests/g-02/blacklist", nil)); g.Blacklist != nil {
		t.Fatalf("cleared: %+v", g)
	}
}

func TestMergePublishesTheEventFromTheOutbox(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	r := c.do("POST", "guests/g-16/merge", map[string]string{"dropId": "g-26"})
	if r.status != http.StatusOK || decode[guestRow](t, r).ID != "g-16" {
		t.Fatalf("merge: %d %+v", r.status, r.Error)
	}
	if guests := decode[[]guestRow](t, c.do("GET", "guests", nil)); len(guests) != 25 {
		t.Fatalf("guests after merge: %d", len(guests))
	}
	s.published(t, guest.EventGuestMerged, "g-26")
	var payload []byte
	if err := s.db.Pool.QueryRow(context.Background(), `SELECT payload FROM platform.outbox WHERE event_type = $1`, guest.EventGuestMerged).Scan(&payload); err != nil {
		t.Fatalf("guest.merged in the outbox: %v", err)
	}
	var merged guest.GuestMerged
	_ = json.Unmarshal(payload, &merged)
	if merged.KeepID != "g-16" || merged.DropID != "g-26" || merged.Guest.Name != "Sarah Cohen" {
		t.Fatalf("payload %+v", merged)
	}
	if r := c.do("POST", "guests/g-16/merge", map[string]string{"dropId": "g-26"}); r.status != http.StatusNotFound {
		t.Fatalf("merging a dropped profile again: %d %+v", r.status, r.Error)
	}
}

func TestForeignCheckThroughTheGuestClient(t *testing.T) {
	t.Parallel()
	s := start(t)
	ctx := context.Background()
	if _, err := s.db.Pool.Exec(ctx, `INSERT INTO guest.rm_stays (id, code, guest_id, unit_id, villa_id, status, check_in, check_out, adults) VALUES ('bk-new', 'BK-9001', 'g-26', 'unit-kr-01', 'vil-karang', 'confirmed', '2026-11-11', '2026-11-13', 2)`); err != nil {
		t.Fatal(err)
	}
	base := strings.TrimSuffix(s.url, "/api/v1/")
	client := guest.HTTPClient{BaseURL: base, Token: "internal"}
	stay := guest.StayPeople{BookingID: "bk-new", GuestID: "g-26", On: "2026-11-11"}
	err := client.CheckRegistration(ctx, stay)
	if e, ok := errs.As(err); !ok || e.Code != "FOREIGN_DATA_MISSING" || e.Message != "Immigration needs more for Sarah Cohen: document number." {
		t.Fatalf("check over HTTP: %v", err)
	}
	reg, err := client.Registration(ctx, guest.StayPeople{BookingID: "bk-new", GuestID: "g-26", Adults: func() *int { n := 2; return &n }()})
	if err != nil || reg.RegisteredAdults != 1 || reg.Unregistered != 1 || reg.People[0].Missing[0] != "document number" {
		t.Fatalf("registration: %+v %v", reg, err)
	}
	status, err := client.BlacklistStatus(ctx, "g-25")
	if err != nil || !status.Blacklisted || status.Name != "Marco Bianchi" {
		t.Fatalf("blacklist status: %+v %v", status, err)
	}
	if _, err := client.Guest(ctx, "g-99"); !errs.HasCode(err, errs.CodeNotFound) {
		t.Fatalf("unknown guest: %v", err)
	}
	if err := (guest.HTTPClient{BaseURL: base, Token: "wrong"}).CheckRegistration(ctx, stay); !errs.HasCode(err, errs.CodeForbidden) {
		t.Fatalf("internal routes need the token: %v", err)
	}
	c := s.client(t)
	c.login("kadek")
	day := decode[struct {
		Rows []struct {
			Overdue bool `json:"overdue"`
		} `json:"rows"`
		Apoa [][]string `json:"apoa"`
	}](t, c.do("GET", "foreign-guests?date=2026-11-11", nil))
	if len(day.Rows) == 0 || len(day.Apoa[0]) != 15 {
		t.Fatalf("foreign list: %+v", day)
	}
}

func TestLostItemTransitionsOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("wayan")
	r := c.do("POST", "lost-found", map[string]any{"foundOn": "2026-11-11", "villaId": "vil-saka", "unitId": "unit-sk-06", "where": "Under the bed", "description": "Phone charger", "photos": []any{}, "guestId": nil, "bookingId": nil, "storage": ""})
	item := decode[lostItem](t, r)
	if r.status != http.StatusCreated || item.Number != "LF-007" || item.Status != "found" {
		t.Fatalf("log: %d %+v", r.status, r.Error)
	}
	courier := map[string]any{"method": "courier", "to": "Chris Hall", "courier": "JNE", "tracking": ""}
	if r := c.do("POST", "lost-found/"+item.ID+"/move", map[string]any{"to": "returned", "note": "", "returned": courier}); r.status != http.StatusConflict || r.Error.Code != "LOST_ITEM_INVALID_STATE" {
		t.Fatalf("courier without tracking: %d %+v", r.status, r.Error)
	}
	if item = decode[lostItem](t, c.do("POST", "lost-found/"+item.ID+"/move", map[string]any{"to": "stored", "note": "Front office drawer"})); item.Status != "stored" {
		t.Fatalf("stored: %+v", item)
	}
	if r := c.do("POST", "lost-found/"+item.ID+"/move", map[string]any{"to": "donated", "note": ""}); r.status != http.StatusConflict || r.Error.Message != "Hold the item until 2027-02-09; the holding period is 90 days." {
		t.Fatalf("donated early: %d %+v", r.status, r.Error)
	}
	courier["tracking"] = "JNE123"
	item = decode[lostItem](t, c.do("POST", "lost-found/"+item.ID+"/move", map[string]any{"to": "returned", "note": "", "returned": courier}))
	if item.Status != "returned" || len(item.History) != 3 {
		t.Fatalf("returned: %+v", item)
	}
	if r := c.do("PUT", "lost-found/settings", map[string]int{"holdDays": 30}); r.status != http.StatusForbidden {
		t.Fatalf("staff changing the holding period: %d", r.status)
	}
	items := decode[[]lostItem](t, c.do("GET", "lost-found", nil))
	for _, i := range items {
		if i.ID == "lf-2" {
			t.Fatal("Wayan works in Saka only; lf-2 is in Tirta")
		}
	}
}
