package people_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/people"
)

// The HTTP client reads a staff member, and NOT_FOUND as not found, with the internal token.
func TestStaffMemberOverHTTP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Header.Get("X-Internal-Token") != "secret":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"code":"UNAUTHENTICATED","message":"no"}}`))
		case r.URL.Path == "/internal/v1/people/staff/emp-002":
			_, _ = w.Write([]byte(`{"data":{"id":"emp-002","name":"Wayan Sudiarta","status":"active","villaIds":["vil-saka"]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"No employee"}}`))
		}
	}))
	defer srv.Close()
	c := people.HTTPClient{BaseURL: srv.URL, Token: "secret"}
	m, found, err := c.StaffMember(context.Background(), "emp-002")
	if err != nil || !found || m.Name != "Wayan Sudiarta" || !m.AllocatedTo("vil-saka") || m.AllocatedTo("vil-karang") {
		t.Fatalf("staff member %+v %v %v", m, found, err)
	}
	if _, found, err := c.StaffMember(context.Background(), "emp-404"); err != nil || found {
		t.Fatalf("unknown employee: %v %v", found, err)
	}
	if (people.StaffMember{Status: "inactive", VillaIDs: []string{"vil-saka"}}).AllocatedTo("vil-saka") {
		t.Fatal("an inactive employee hosts nothing")
	}
}
