package bootstrap_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

// A channel service on its own reads the public site's menu from services over
// /internal/v1/site-menu (SERVICES_URL), the same menu the monolith prints.
func TestSplitChannelReadsTheSiteMenuFromServices(t *testing.T) {
	s := start(t)
	root := s.url[:len(s.url)-len("/api/v1/")]
	t.Setenv("SERVICES_URL", root)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	cfg := config.Config{
		Service: "channel", Version: "test", Bus: "inproc", OutboxRelay: "off", BusinessTZ: makassar,
		JWTSecret: []byte("test-secret-test-secret-test-secret"), AccessTTL: 15 * time.Minute, RefreshTTL: 24 * time.Hour,
		IdentityURL: root, InternalToken: "internal",
	}
	app, err := bootstrap.Build(context.Background(), cfg, logging.Discard(), s.db, bootstrap.Options{Contexts: []string{bootstrap.Channel}, Bus: bus.NewInProcess(), Clock: movable{s.now}})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(app.Handler)
	t.Cleanup(srv.Close)
	menuOf := func(base string) string {
		c := server{url: base}.client(t)
		r := c.do("GET", "public/site/inventory", nil)
		if r.status != http.StatusOK {
			t.Fatalf("inventory at %s: %d %+v", base, r.status, r.Error)
		}
		return string(decode[map[string]json.RawMessage](t, r)["menu"])
	}
	want, got := menuOf(s.url), menuOf(srv.URL+"/api/v1/")
	if want == "[]" || want == "null" || got != want {
		t.Fatalf("split menu %s, monolith menu %s", got, want)
	}
}

// A housekeeping service on its own reads stock items from inventory over
// /internal/v1/stock/items (INVENTORY_URL): a linen par refuses a minibar item and takes a linen
// item created after the service started.
func TestSplitHousekeepingReadsStockItemsFromInventory(t *testing.T) {
	s := start(t)
	root := s.url[:len(s.url)-len("/api/v1/")]
	t.Setenv("INVENTORY_URL", root)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	cfg := config.Config{
		Service: "housekeeping", Version: "test", Bus: "inproc", OutboxRelay: "off", BusinessTZ: makassar,
		JWTSecret: []byte("test-secret-test-secret-test-secret"), AccessTTL: 15 * time.Minute, RefreshTTL: 24 * time.Hour,
		IdentityURL: root, InternalToken: "internal",
	}
	app, err := bootstrap.Build(context.Background(), cfg, logging.Discard(), s.db, bootstrap.Options{Contexts: []string{bootstrap.Housekeeping}, Bus: bus.NewInProcess(), Clock: movable{s.now}})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(app.Handler)
	t.Cleanup(srv.Close)

	res, err := http.Get(root + "/internal/v1/stock/items")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("the item list needs the internal token: %d", res.StatusCode)
	}
	mono := s.client(t)
	mono.login("kadek")
	hk := &client{t: t, base: srv.URL + "/api/v1/", http: mono.http}
	par := func(item string) reply {
		return hk.do("PUT", "linen/pars/grp-saka-standard", map[string]any{"sets": 3, "lines": []map[string]any{{"itemId": item, "quantity": 1}}})
	}
	refused(t, par("stk-mb-bintang-l"), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	r := mono.do("POST", "stock/items", map[string]any{"code": "LN-ROBE", "name": "Bath robe", "kind": "linen", "unit": "piece", "reorderLevel": 2, "par": 0, "active": true})
	if r.status != http.StatusCreated {
		t.Fatalf("create item: %d %+v", r.status, r.Error)
	}
	robe := decode[struct {
		ID string `json:"id"`
	}](t, r)
	if r := par(robe.ID); r.status != http.StatusOK {
		t.Fatalf("par with the new linen item: %d %+v", r.status, r.Error)
	}
}

// Owners and billing services on their own catch up copies that a later migration added, as on a
// database seeded before it: they read the source contexts' current state over
// /internal/v1/snapshots/{eventType} and replay it through their own handlers. A second run
// changes nothing, and the monolith catches up the same copies in process. Housekeeping and
// payroll catch their staff copies up from people the same way.
func TestSplitServicesCatchUpTheirCopies(t *testing.T) {
	s := start(t)
	root := s.url[:len(s.url)-len("/api/v1/")]
	for _, env := range []string{"PROPERTY_URL", "CHANNEL_URL", "SERVICES_URL", "PEOPLE_URL"} {
		t.Setenv(env, root)
	}
	makassar, _ := time.LoadLocation("Asia/Makassar")
	ctx := context.Background()
	build := func(contexts ...string) *bootstrap.App {
		cfg := config.Config{
			Service: "split", Version: "test", Bus: "inproc", OutboxRelay: "off", BusinessTZ: makassar,
			JWTSecret: []byte("test-secret-test-secret-test-secret"), AccessTTL: 15 * time.Minute, RefreshTTL: 24 * time.Hour,
			IdentityURL: root, ReservationURL: root, InternalToken: "internal",
		}
		app, err := bootstrap.Build(ctx, cfg, logging.Discard(), s.db, bootstrap.Options{Contexts: contexts, Bus: bus.NewInProcess(), Clock: movable{s.now}})
		if err != nil {
			t.Fatal(err)
		}
		if app.Fill == nil {
			t.Fatalf("%v catches up its copies", contexts)
		}
		return app
	}
	count := func(query string) (n int) {
		if err := s.db.Pool.QueryRow(ctx, query).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	copies := []struct{ copy, source string }{
		{`SELECT count(*) FROM owners.rm_groups`, `SELECT count(*) FROM reservation.booking_groups`},
		{`SELECT count(*) FROM billing.cat_groups`, `SELECT count(*) FROM property.unit_groups`},
		{`SELECT count(*) FROM billing.cat_units WHERE group_id IS NOT NULL`, `SELECT count(*) FROM property.units WHERE group_id IS NOT NULL`},
		{`SELECT count(*) FROM billing.cat_accounts`, `SELECT count(*) FROM channel.airbnb_accounts`},
		{`SELECT count(*) FROM billing.rm_requests`, `SELECT count(*) FROM services.requests`},
		{`SELECT count(*) FROM housekeeping.staff_employees`, `SELECT count(*) FROM people.employees`},
		{`SELECT count(*) FROM payroll.rm_employees`, `SELECT count(*) FROM people.employees`},
		{`SELECT count(*) FROM payroll.rm_loans`, `SELECT count(*) FROM people.loans`},
	}
	forget := func() {
		if _, err := s.db.Pool.Exec(ctx, `TRUNCATE owners.rm_groups, billing.cat_groups, billing.cat_accounts, billing.rm_requests,
			housekeeping.staff_employees, payroll.rm_employees, payroll.rm_loans;
			UPDATE billing.cat_units SET group_id = NULL`); err != nil {
			t.Fatal(err)
		}
		for _, c := range copies {
			if count(c.copy) != 0 {
				t.Fatalf("%s is not empty", c.copy)
			}
		}
	}
	check := func(fill func(context.Context) error) {
		t.Helper()
		for range 2 {
			if err := fill(ctx); err != nil {
				t.Fatal(err)
			}
			for _, c := range copies {
				if got, want := count(c.copy), count(c.source); got != want || want == 0 {
					t.Fatalf("%s: %d, source has %d", c.copy, got, want)
				}
			}
		}
	}

	forget()
	owners, billing := build(bootstrap.Owners).Fill, build(bootstrap.Billing).Fill
	housekeeping, payroll := build(bootstrap.Housekeeping).Fill, build(bootstrap.Payroll).Fill
	check(func(ctx context.Context) error {
		return errors.Join(owners(ctx), billing(ctx), housekeeping(ctx), payroll(ctx))
	})
	forget()
	check(build(bootstrap.All...).Fill)
}

// splitApp serves the named contexts as a split service beside the monolith at root (identity
// and guest URLs included), signed in as user through the monolith's cookie jar.
func splitApp(t *testing.T, s server, root, user string, contexts ...string) *client {
	t.Helper()
	makassar, _ := time.LoadLocation("Asia/Makassar")
	cfg := config.Config{
		Service: "split", Version: "test", Bus: "inproc", OutboxRelay: "off", BusinessTZ: makassar,
		JWTSecret: []byte("test-secret-test-secret-test-secret"), AccessTTL: 15 * time.Minute, RefreshTTL: 24 * time.Hour,
		IdentityURL: root, GuestURL: root, InternalToken: "internal",
	}
	app, err := bootstrap.Build(context.Background(), cfg, logging.Discard(), s.db, bootstrap.Options{Contexts: contexts, Bus: bus.NewInProcess(), Clock: movable{s.now}})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(app.Handler)
	t.Cleanup(srv.Close)
	mono := s.client(t)
	mono.login(user)
	return &client{t: t, base: srv.URL + "/api/v1/", http: mono.http}
}

// needsToken checks that an internal route refuses a call without INTERNAL_TOKEN.
func needsToken(t *testing.T, method, url string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader("{}"))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("%s %s without the internal token: %d", method, url, res.StatusCode)
	}
}

// A billing service on its own checks a cashier's roster with people over
// /internal/v1/people/rostered (PEOPLE_URL): staff the roster puts on a shift today may open one.
func TestSplitBillingReadsTheRosterFromPeople(t *testing.T) {
	s := start(t)
	root := s.url[:len(s.url)-len("/api/v1/")]
	t.Setenv("PEOPLE_URL", root)
	needsToken(t, "GET", root+"/internal/v1/people/rostered?employeeId=emp-002&date=2026-11-12")
	roster := people.HTTPClient{BaseURL: root, Token: "internal"}
	for date, want := range map[string]bool{"2026-11-12": true, "2026-11-11": false} {
		if got, err := roster.Rostered(context.Background(), "emp-002", date); err != nil || got != want {
			t.Fatalf("emp-002 on %s: %v %v", date, got, err)
		}
	}

	*s.now = s.now.AddDate(0, 0, 1)
	billing := splitApp(t, s, root, "wayan", bootstrap.Billing)
	r := billing.do("POST", "cashier-shifts", map[string]any{"accountId": "cb-ubud", "count": map[string]any{"notes": map[string]any{"100000": 10}}})
	if r.status != http.StatusCreated {
		t.Fatalf("wayan is rostered on %s: %d %+v", s.now.Format("2006-01-02"), r.status, r.Error)
	}
}

// A reservation service on its own copies a verified online check-in onto the guest profile and
// the companions through guest over /internal/v1/pre-checkins (GUEST_URL).
func TestSplitReservationAppliesThePreCheckInThroughGuest(t *testing.T) {
	s := start(t)
	root := s.url[:len(s.url)-len("/api/v1/")]
	needsToken(t, "POST", root+"/internal/v1/pre-checkins")

	reservation := splitApp(t, s, root, "dian", bootstrap.Reservation)
	if r := reservation.do("POST", "bookings/bk-1308/pre-checkin/verify", nil); r.status != http.StatusOK {
		t.Fatalf("verify: %d %+v", r.status, r.Error)
	}
	mono := s.client(t)
	mono.login("dian")
	// The seed's profile has another birth date and expiry; the place of birth stays the desk's.
	type profile struct {
		ID         string `json:"id"`
		BirthDate  string `json:"birthDate"`
		IDExpiry   string `json:"idExpiry"`
		BirthPlace string `json:"birthPlace"`
	}
	var lead profile
	for _, g := range decode[[]profile](t, mono.do("GET", "guests", nil)) {
		if g.ID == "g-15" {
			lead = g
		}
	}
	if lead.BirthDate != "1984-03-10" || lead.IDExpiry != "2029-04-29" || lead.BirthPlace != "Hamburg" {
		t.Fatalf("lead guest %+v", lead)
	}
	r := mono.do("GET", "stay-companions", nil)
	found := false
	for _, c := range decode[[]struct {
		BookingID   string `json:"bookingId"`
		Name        string `json:"name"`
		Nationality string `json:"nationality"`
	}](t, r) {
		found = found || (c.BookingID == "bk-1308" && c.Name == "Daniel Brooks" && c.Nationality == "AU")
	}
	if !found {
		t.Fatalf("Daniel Brooks is not a companion on bk-1308: %s", r.Data)
	}
}
