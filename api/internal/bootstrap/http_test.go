package bootstrap_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/config"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
)

type movable struct{ t *time.Time }

func (m movable) Now() time.Time { return *m.t }

type server struct {
	url string
	db  *db.DB
	now *time.Time
	app *bootstrap.App
}

// start runs the monolith over a fresh seeded database with the relay publishing on the
// in-process bus, as cmd/monolith does.
func start(t *testing.T) server {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)
	clk := movable{&now}
	log := logging.Discard()
	if err := bootstrap.Seed(context.Background(), d, log, clk); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Service: "monolith", Version: "test", Bus: "inproc", OutboxRelay: "embedded", BusinessTZ: makassar,
		JWTSecret: []byte("test-secret-test-secret-test-secret"), AccessTTL: 15 * time.Minute, RefreshTTL: 24 * time.Hour,
		CORSOrigins: []string{"http://localhost:5173"}, InternalToken: "internal",
	}
	app, err := bootstrap.Build(context.Background(), cfg, log, d, bootstrap.Options{Bus: bus.NewInProcess(), Clock: clk})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = app.Relay.Run(ctx) }()
	srv := httptest.NewServer(app.Handler)
	t.Cleanup(func() {
		srv.Close()
		cancel()
	})
	return server{url: srv.URL + "/api/v1/", db: d, now: &now, app: app}
}

type client struct {
	t    *testing.T
	base string
	http *http.Client
}

func (s server) client(t *testing.T) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: s.url, http: &http.Client{Jar: jar}}
}

type reply struct {
	status int
	header http.Header
	Data   json.RawMessage `json:"data"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *client) do(method, path string, body any) reply {
	c.t.Helper()
	var r io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	out := reply{status: res.StatusCode, header: res.Header}
	if res.StatusCode != http.StatusNoContent {
		raw, _ := io.ReadAll(res.Body)
		if err := json.Unmarshal(raw, &out); err != nil {
			c.t.Fatalf("%s %s: %d %s", method, path, res.StatusCode, raw)
		}
	}
	return out
}

func (c *client) login(name string) {
	c.t.Helper()
	r := c.do("POST", "auth/login", map[string]string{"email": name + "@balivillas.id", "password": "villa123"})
	if r.status != http.StatusOK {
		c.t.Fatalf("login %s: %d %+v", name, r.status, r.Error)
	}
}

func decode[T any](t *testing.T, r reply) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(r.Data, &v); err != nil {
		t.Fatalf("decode %s: %v", r.Data, err)
	}
	return v
}

type user struct {
	ID          string   `json:"id"`
	Role        string   `json:"role"`
	Status      string   `json:"status"`
	VillaIDs    []string `json:"villaIds"`
	LastLoginOn *string  `json:"lastLoginOn"`
}

type unit struct {
	ID      string `json:"id"`
	Code    string `json:"code"`
	VillaID string `json:"villaId"`
}

func TestLoginSessionAndLogout(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	if r := c.do("GET", "auth/session", nil); r.status != 200 || string(r.Data) != "null" {
		t.Fatalf("no session yet: %d %s", r.status, r.Data)
	}
	r := c.do("POST", "auth/login", map[string]string{"email": "kadek@balivillas.id", "password": "villa123"})
	if r.status != 200 || decode[user](t, r).ID != "usr-kadek" {
		t.Fatalf("login: %d %s", r.status, r.Data)
	}
	cookies := strings.Join(r.header.Values("Set-Cookie"), "\n")
	if !strings.Contains(cookies, "wit_access=") || !strings.Contains(cookies, "wit_refresh=") || !strings.Contains(cookies, "HttpOnly") || !strings.Contains(cookies, "SameSite=Lax") {
		t.Fatalf("session cookies: %s", cookies)
	}
	if u := decode[user](t, c.do("GET", "auth/session", nil)); u.ID != "usr-kadek" || u.Role != "manager" {
		t.Fatalf("session: %+v", u)
	}
	perms := decode[map[string]map[string][]string](t, c.do("GET", "permissions", nil))
	if len(perms) != 9 || len(perms["investor"]["portal"]) != 2 {
		t.Fatalf("permissions: %v", perms["investor"])
	}
	if r := c.do("POST", "auth/logout", nil); r.status != http.StatusNoContent {
		t.Fatalf("logout: %d", r.status)
	}
	if r := c.do("GET", "auth/session", nil); string(r.Data) != "null" {
		t.Fatalf("after logout: %s", r.Data)
	}
	bad := c.do("POST", "auth/login", map[string]string{"email": "kadek@balivillas.id", "password": "nope"})
	if bad.status != http.StatusUnauthorized || bad.Error == nil || bad.Error.Code != "INVALID_CREDENTIALS" || bad.Error.Message != "That email and password do not match." {
		t.Fatalf("wrong password: %d %+v", bad.status, bad.Error)
	}
	if r := c.do("GET", "units", nil); r.status != http.StatusUnauthorized || r.Error.Code != "UNAUTHENTICATED" {
		t.Fatalf("anonymous read: %d %+v", r.status, r.Error)
	}
}

func TestExpiredAccessTokenRenewsFromTheRefreshCookie(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	*s.now = s.now.Add(20 * time.Minute)
	r := c.do("GET", "units", nil)
	if r.status != 200 || len(decode[[]unit](t, r)) != 20 {
		t.Fatalf("read after expiry: %d %+v", r.status, r.Error)
	}
	if cookies := strings.Join(r.header.Values("Set-Cookie"), "\n"); !strings.Contains(cookies, "wit_refresh=") {
		t.Fatalf("the refresh token must rotate: %s", cookies)
	}
	if r := c.do("POST", "auth/refresh", nil); r.status != 200 || decode[user](t, r).ID != "usr-rama" {
		t.Fatalf("explicit refresh: %d %+v", r.status, r.Error)
	}
}

func TestForbiddenCalls(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("wayan")
	r := c.do("POST", "locations", map[string]string{"name": "Sanur", "area": "Denpasar, Bali"})
	if r.status != http.StatusForbidden || r.Error.Code != "FORBIDDEN" || r.Error.Message != "Staff cannot create in Master data." {
		t.Fatalf("staff creating a location: %d %+v", r.status, r.Error)
	}
	if r := c.do("GET", "users", nil); r.status != http.StatusForbidden {
		t.Fatalf("staff listing users: %d", r.status)
	}
	admin := s.client(t)
	admin.login("admin")
	if r := admin.do("PATCH", "users/usr-admin", map[string]string{"status": "inactive"}); r.status != http.StatusConflict || r.Error.Code != "ACCESS_SELF" {
		t.Fatalf("deactivate self: %d %+v", r.status, r.Error)
	}
	if u := decode[user](t, admin.do("PATCH", "users/usr-sari", map[string]string{"status": "inactive"})); u.Status != "inactive" {
		t.Fatalf("deactivate: %+v", u)
	}
}

func TestScopedLists(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("putu")
	units := decode[[]unit](t, c.do("GET", "units", nil))
	if len(units) != 4 {
		t.Fatalf("Putu sees Ubud only, got %d units", len(units))
	}
	for _, u := range units {
		if u.VillaID != "vil-tirta" {
			t.Fatalf("out of scope: %+v", u)
		}
	}
	investor := s.client(t)
	investor.login("hendra")
	villas := decode[[]map[string]any](t, investor.do("GET", "villas", nil))
	if len(villas) != 2 {
		t.Fatalf("Hendra owns two villas, got %d", len(villas))
	}
}

func TestPropertyCommandReachesTheOutboxAndTheReadModel(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("rama")
	r := c.do("POST", "units", map[string]any{"villaId": "vil-saka", "groupId": "grp-saka-standard", "code": "SK-09", "name": "Saka 9", "bedrooms": 1, "nightlyRate": 1850000, "status": "active", "amenities": []string{"ac"}})
	if r.status != http.StatusCreated || decode[unit](t, r).ID != "unit-sk-09" {
		t.Fatalf("create unit: %d %+v %s", r.status, r.Error, r.Data)
	}
	// The response waited for the projector, so the next read sees the unit.
	units := decode[[]unit](t, c.do("GET", "units", nil))
	if len(units) != 21 || units[20].Code != "SK-09" {
		t.Fatalf("read model after the command: %d units", len(units))
	}
	ctx := context.Background()
	s.published(t, "property.unit.created.v1", "unit-sk-09")
	var processed int
	_ = s.db.Pool.QueryRow(ctx, `SELECT count(*) FROM platform.processed_events WHERE consumer = 'property.read-model' AND event_type = 'property.unit.created.v1'`).Scan(&processed)
	if processed != 21 {
		t.Fatalf("inbox rows: %d", processed)
	}
	trail := decode[[]map[string]any](t, c.do("GET", "audit", nil))
	if trail[0]["summary"] != "Added unit SK-09" || trail[0]["userId"] != "usr-rama" {
		t.Fatalf("newest audit line: %v", trail[0])
	}
	bad := c.do("PUT", "unit-groups/grp-saka-standard/rate-plan", map[string]any{"weekdayRate": 0, "weekendRate": 2200000, "seasons": []any{}})
	if bad.status != http.StatusUnprocessableEntity || bad.Error.Code != "VALIDATION_ERROR" || bad.Error.Message != "Enter the weekday rate in whole rupiah." {
		t.Fatalf("invalid plan: %d %+v", bad.status, bad.Error)
	}
}

func TestHealthAndDocs(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	h := decode[map[string]any](t, c.do("GET", "health", nil))
	if h["ok"] != true || h["db"] != "ok" || h["version"] != "test" {
		t.Fatalf("health: %v", h)
	}
	res, err := http.Get(s.url + "docs/openapi.yaml")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("docs: %v", err)
	}
	res.Body.Close()
}
