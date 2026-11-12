package bootstrap_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/channel/adapters/sources"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/httpx"
	reservationclients "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/clients"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/seed"
)

var chris = map[string]any{"name": "Chris Hall", "email": "", "phone": "", "nationality": "AU", "idType": "passport", "idNumber": "PB1112223"}

// keyed posts body with an Idempotency-Key header.
func (c *client) keyed(path, key string, body any) reply {
	c.t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", c.base+path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	out := reply{status: res.StatusCode, header: res.Header}
	data, _ := io.ReadAll(res.Body)
	if err := json.Unmarshal(data, &out); err != nil {
		c.t.Fatalf("POST %s: %d %s", path, res.StatusCode, data)
	}
	return out
}

func guestCount(t *testing.T, c *client) int {
	t.Helper()
	return len(decode[[]map[string]any](t, c.do("GET", "guests", nil)))
}

// A booking with a new guest creates the profile, then the stay; the same request retried under its
// Idempotency-Key answers the first booking and adds no second profile.
func TestBookingWithANewGuest(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("dian")
	before := guestCount(t, c)
	body := stay("unit-kr-03", "", "2027-01-10", "2027-01-12")
	body["guestId"], body["newGuest"] = nil, chris
	r := c.keyed("bookings", "new-guest-1", body)
	if r.status != http.StatusCreated {
		t.Fatalf("create: %d %+v", r.status, r.Error)
	}
	b := decode[struct {
		ID      string `json:"id"`
		GuestID string `json:"guestId"`
	}](t, r)
	if b.GuestID != "g-27" {
		t.Fatalf("the stay names the new profile: %+v", b)
	}
	if n := guestCount(t, c); n != before+1 {
		t.Fatalf("guests: %d, want %d", n, before+1)
	}
	again := c.keyed("bookings", "new-guest-1", body)
	if again.status != http.StatusCreated || again.header.Get("Idempotent-Replay") != "true" || decode[bookingRow](t, again).ID != b.ID {
		t.Fatalf("retry: %d %s %+v", again.status, again.header.Get("Idempotent-Replay"), again.Error)
	}
	if n := guestCount(t, c); n != before+1 {
		t.Fatalf("a retry adds no profile: %d guests", n)
	}
}

// In split mode reservation creates the profile over guest's /internal/v1 route; the key derived
// from the request's Idempotency-Key makes a retry that reaches guest again find the first profile.
func TestGuestProfileOverHTTPOncePerKey(t *testing.T) {
	t.Parallel()
	s := start(t)
	base := strings.TrimSuffix(s.url, "/api/v1/")
	g := reservationclients.Guests{Client: func() guest.Client { return guest.HTTPClient{BaseURL: base, Token: "internal"} }}
	dian := auth.Principal{UserID: "usr-dian", Name: "Dian Permata", Role: "reservation"}
	input, _ := json.Marshal(chris)
	ctx := httpx.WithIdempotencyKey(context.Background(), "split-1")
	first, err := g.Create(ctx, dian, input)
	if err != nil || first != "g-27" {
		t.Fatalf("create: %q %v", first, err)
	}
	if again, err := g.Create(ctx, dian, input); err != nil || again != first {
		t.Fatalf("retry: %q %v", again, err)
	}
	if other, err := g.Create(httpx.WithIdempotencyKey(context.Background(), "split-2"), dian, input); err != nil || other != "g-28" {
		t.Fatalf("another request: %q %v", other, err)
	}
	investor := auth.Principal{UserID: "usr-hendra", Name: "Hendra Gunawan", Role: "investor"}
	if _, err := g.Create(ctx, investor, input); !errs.HasCode(err, errs.CodeForbidden) {
		t.Fatalf("the principal travels with the call: %v", err)
	}
	bad, _ := json.Marshal(map[string]any{"name": "C", "nationality": "AU"})
	if _, err := g.Create(context.Background(), dian, bad); !errs.HasCode(err, errs.CodeValidation) {
		t.Fatalf("guest's validation: %v", err)
	}
}

// Channel in split mode reads bookings, held nights and stay restrictions from reservation's
// /internal/v1/site routes; the answers match the in-process ones.
func TestChannelReadsReservationOverHTTP(t *testing.T) {
	t.Parallel()
	s := start(t)
	ctx := context.Background()
	base := strings.TrimSuffix(s.url, "/api/v1/")
	r := sources.Reservation{BaseURL: base, Token: "internal"}
	if code, found, err := r.BookingCode(ctx, "bk-1000"); err != nil || !found || code != "BK-1000" {
		t.Fatalf("booking code: %q %v %v", code, found, err)
	}
	if _, found, err := r.BookingCode(ctx, "bk-none"); err != nil || found {
		t.Fatalf("unknown booking: %v %v", found, err)
	}
	site := reservationpg.Site{DB: s.db}
	want, _ := site.Restrictions(ctx)
	got, err := r.Restrictions(ctx)
	if err != nil || len(got) != 20 || len(got) != len(want) || !bytes.Equal(canonicalJSON(t, got[0]), canonicalJSON(t, want[0])) {
		t.Fatalf("restrictions: %d of %d %v", len(got), len(want), err)
	}
	held, _ := site.Holds(ctx, "2026-11-11", "2026-11-25")
	stays, err := r.Stays(ctx, "2026-11-11", "2026-11-25")
	if err != nil || len(stays) == 0 || len(stays) != len(held) {
		t.Fatalf("stays: %d of %d %v", len(stays), len(held), err)
	}
	if h := held[0]; stays[0].UnitID != h.UnitID || stays[0].UnitAssigned != h.UnitAssigned || stays[0].From != h.CheckIn || stays[0].To != h.CheckOut {
		t.Fatalf("first stay %+v, want %+v", stays[0], h)
	}
	if _, err := (sources.Reservation{BaseURL: base, Token: "wrong"}).Restrictions(ctx); !errs.HasCode(err, errs.CodeForbidden) {
		t.Fatalf("internal routes need the token: %v", err)
	}
}

func canonicalJSON(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(v)
	return out
}

// The bookings and stay restrictions lists follow the mock's array order whatever order the
// projector saw the rows in: bookings by number, restrictions as the write model added them.
func TestReservationListsKeepTheMockOrder(t *testing.T) {
	t.Parallel()
	s := start(t)
	ctx := context.Background()
	// Reverse the projection order, as two relays draining one outbox can.
	for _, table := range []string{"rm_bookings", "rm_restrictions"} {
		if _, err := s.db.Pool.Exec(ctx, `UPDATE reservation.`+table+` SET seq = -seq`); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := seed.FS.ReadFile("reservation.json")
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := reservationpg.ParseSeed(raw)
	if err != nil {
		t.Fatal(err)
	}
	c := s.client(t)
	c.login("kadek")
	if r := c.do("POST", "bookings", stay("unit-kr-03", "", "2027-02-01", "2027-02-03")); r.status != http.StatusCreated {
		t.Fatalf("create booking: %d %+v", r.status, r.Error)
	}
	rule := map[string]any{"groupId": "grp-lumbung-loft", "unitId": nil, "rule": "stop_sell", "nights": nil, "yearly": false, "from": "2027-03-01", "to": "2027-03-02", "weekdays": []int{}, "note": ""}
	if r := c.do("POST", "stay-restrictions", rule); r.status != http.StatusCreated {
		t.Fatalf("create restriction: %d %+v", r.status, r.Error)
	}
	bookings := decode[[]bookingRow](t, c.do("GET", "bookings", nil))
	if len(bookings) != len(fixture.Bookings)+1 {
		t.Fatalf("bookings: %d", len(bookings))
	}
	for i, b := range fixture.Bookings {
		if bookings[i].ID != b.ID {
			t.Fatalf("booking %d is %s, want %s", i, bookings[i].ID, b.ID)
		}
	}
	if last := bookings[len(bookings)-1]; last.Code != "BK-3001" {
		t.Fatalf("the new booking comes last: %s", last.Code)
	}
	restrictions := decode[[]struct {
		ID string `json:"id"`
	}](t, c.do("GET", "stay-restrictions", nil))
	if len(restrictions) != len(fixture.Restrictions)+1 {
		t.Fatalf("restrictions: %d", len(restrictions))
	}
	for i, r := range fixture.Restrictions {
		if restrictions[i].ID != r.ID {
			t.Fatalf("restriction %d is %s, want %s", i, restrictions[i].ID, r.ID)
		}
	}
	if last := restrictions[len(restrictions)-1]; last.ID != "rst-1" {
		t.Fatalf("the new restriction comes last: %s", last.ID)
	}
}
