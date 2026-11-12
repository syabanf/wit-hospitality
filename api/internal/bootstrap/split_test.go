package bootstrap_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
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
// changes nothing, and the monolith catches up the same copies in process.
func TestSplitServicesCatchUpTheirCopies(t *testing.T) {
	s := start(t)
	root := s.url[:len(s.url)-len("/api/v1/")]
	for _, env := range []string{"PROPERTY_URL", "CHANNEL_URL", "SERVICES_URL"} {
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
	}
	forget := func() {
		if _, err := s.db.Pool.Exec(ctx, `TRUNCATE owners.rm_groups, billing.cat_groups, billing.cat_accounts, billing.rm_requests;
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
	check(func(ctx context.Context) error { return errors.Join(owners(ctx), billing(ctx)) })
	forget()
	check(build(bootstrap.All...).Fill)
}
