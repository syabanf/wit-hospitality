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
