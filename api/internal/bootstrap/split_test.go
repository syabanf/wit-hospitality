package bootstrap_test

import (
	"context"
	"encoding/json"
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
	r := mono.do("POST", "stock/items", map[string]any{"code": "LN-ROBE", "name": "Bath robe", "kind": "linen", "unit": "piece", "reorderLevel": 2, "par": 10, "active": true})
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

// An owners service on its own fills an emptied copy of the booking group sources from
// reservation over /internal/v1/booking-groups/sources (RESERVATION_URL), and a second fill
// changes nothing.
func TestSplitOwnersFillsGroupSourcesFromReservation(t *testing.T) {
	s := start(t)
	root := s.url[:len(s.url)-len("/api/v1/")]
	makassar, _ := time.LoadLocation("Asia/Makassar")
	cfg := config.Config{
		Service: "owners", Version: "test", Bus: "inproc", OutboxRelay: "off", BusinessTZ: makassar,
		JWTSecret: []byte("test-secret-test-secret-test-secret"), AccessTTL: 15 * time.Minute, RefreshTTL: 24 * time.Hour,
		IdentityURL: root, ReservationURL: root, InternalToken: "internal",
	}
	app, err := bootstrap.Build(context.Background(), cfg, logging.Discard(), s.db, bootstrap.Options{Contexts: []string{bootstrap.Owners}, Bus: bus.NewInProcess(), Clock: movable{s.now}})
	if err != nil {
		t.Fatal(err)
	}
	if app.Fill == nil {
		t.Fatal("an owners service with RESERVATION_URL fills its group copy")
	}
	ctx := context.Background()
	count := func() (n int) {
		if err := s.db.Pool.QueryRow(ctx, `SELECT count(*) FROM owners.rm_groups`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	seeded := count()
	if seeded == 0 {
		t.Fatal("the seed drain fills owners.rm_groups")
	}
	if _, err := s.db.Pool.Exec(ctx, `TRUNCATE owners.rm_groups`); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := app.Fill(ctx); err != nil {
			t.Fatal(err)
		}
		if got := count(); got != seeded {
			t.Fatalf("filled %d groups, reservation has %d", got, seeded)
		}
	}
}
