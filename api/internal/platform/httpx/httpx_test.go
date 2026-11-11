package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
)

func TestStatusFor(t *testing.T) {
	cases := map[string]int{
		"VALIDATION_ERROR": 422, "UNAUTHENTICATED": 401, "INVALID_CREDENTIALS": 401, "FORBIDDEN": 403,
		"COMP_FORBIDDEN": 403, "NOT_FOUND": 404, "BOOKING_OVERLAP": 409, "ACCESS_SELF": 409, "INTERNAL": 500,
	}
	for code, want := range cases {
		if got := StatusFor(code); got != want {
			t.Errorf("%s: %d, want %d", code, got, want)
		}
	}
}

func TestWriteError(t *testing.T) {
	var f errs.Fields
	f.Add("code", "SK is already used.")
	w := httptest.NewRecorder()
	WriteError(w, httptest.NewRequest("POST", "/x", nil), logging.Discard(), f.Err())
	var body Problem
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != 422 || body.Error.Code != "VALIDATION_ERROR" || body.Error.Message != "SK is already used." || body.Error.Fields["code"] == "" {
		t.Fatalf("%d %+v", w.Code, body)
	}
	w = httptest.NewRecorder()
	WriteError(w, httptest.NewRequest("GET", "/x", nil), logging.Discard(), errors.New("db exploded"))
	if w.Code != 500 || strings.Contains(w.Body.String(), "exploded") {
		t.Fatalf("internal errors must not leak: %d %s", w.Code, w.Body.String())
	}
}

func TestLogsMaskSecretsAndCarryTheRequest(t *testing.T) {
	var buf bytes.Buffer
	log := logging.NewTo(&buf, "test", "info")
	ctx := logging.WithUserID(logging.WithRequestID(context.Background(), "req-1"), "usr-rama")
	log.InfoContext(ctx, "login", "password", "villa123", "refreshToken", "abc", "email", "rama@balivillas.id")
	out := buf.String()
	if strings.Contains(out, "villa123") || strings.Contains(out, `"abc"`) || !strings.Contains(out, `"request_id":"req-1"`) || !strings.Contains(out, `"user_id":"usr-rama"`) {
		t.Fatalf("got %s", out)
	}
}

func TestCORSAllowsTheDevOriginWithCredentials(t *testing.T) {
	h := CORS([]string{"http://localhost:5173"})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	req := httptest.NewRequest("OPTIONS", "/api/v1/units", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "PATCH")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("preflight: %d %v", w.Code, w.Header())
	}
	req = httptest.NewRequest("GET", "/api/v1/units", nil)
	req.Header.Set("Origin", "https://evil.example")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unknown origin allowed")
	}
}
