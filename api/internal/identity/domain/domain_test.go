package domain

import (
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

func message(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Message
	}
	return ""
}

func TestValidateUser(t *testing.T) {
	in := UserInput{Name: "Nyoman", Email: "nyoman@balivillas.id", Role: "staff", Status: StatusActive}
	if err := ValidateUser(in, false); err != nil {
		t.Fatal(err)
	}
	if got := message(ValidateUser(in, true)); got != "nyoman@balivillas.id already has a login." {
		t.Fatalf("got %q", got)
	}
	bad := UserInput{Name: "N", Email: "nope", Role: "boss", Status: StatusActive}
	e, _ := errs.As(ValidateUser(bad, false))
	m := errs.Fields(e.Fields).Map()
	if m["name"] != "Enter the person’s name." || m["email"] != "Enter a valid email address." || m["role"] != "Pick a role." {
		t.Fatalf("got %v", m)
	}
}

func TestSelfRules(t *testing.T) {
	u := User{ID: "usr-admin", Role: "admin"}
	if err := u.CheckUpdate("usr-admin", UserInput{Role: "owner"}); !errs.HasCode(err, "ACCESS_SELF") {
		t.Fatalf("got %v", err)
	}
	if err := u.CheckUpdate("usr-rama", UserInput{Role: "owner"}); err != nil {
		t.Fatal(err)
	}
	if err := u.CheckSetActive("usr-admin", false); !errs.HasCode(err, "ACCESS_SELF") {
		t.Fatalf("got %v", err)
	}
	if err := CheckPermissionEdit("admin", "owner"); !errs.HasCode(err, "ACCESS_OWNER") {
		t.Fatalf("got %v", err)
	}
	if err := CheckPermissionEdit("owner", "owner"); err != nil {
		t.Fatal(err)
	}
}

func TestPasswordChange(t *testing.T) {
	cases := map[string]PasswordChange{
		"Enter the current password.":        {Current: "", Next: "longenough", Confirm: "longenough"},
		"Use at least 8 characters.":         {Current: "villa123", Next: "short", Confirm: "short"},
		"Pick a password you have not used.": {Current: "villa1234", Next: "villa1234", Confirm: "villa1234"},
		"The two passwords differ.":          {Current: "villa123", Next: "longenough", Confirm: "different"},
	}
	for want, in := range cases {
		if got := message(ValidatePasswordChange(in)); got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
}

func TestNormalizeRolePermissions(t *testing.T) {
	row, err := NormalizeRolePermissions("staff", map[rbac.Module][]rbac.Action{"services": {"comp", "view"}, "booking": {"catalog", "view"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(row) != len(rbac.Modules) || len(row["finance"]) != 0 {
		t.Fatal("every module must be present")
	}
	if got := row["services"]; len(got) != 2 || got[0] != "view" || got[1] != "comp" {
		t.Fatalf("services = %v", got)
	}
	if got := row["booking"]; len(got) != 1 || got[0] != "view" {
		t.Fatalf("catalog only exists in services, got %v", got)
	}
	if _, err := NormalizeRolePermissions("staff", map[rbac.Module][]rbac.Action{"spaceship": {"view"}}); !errs.HasCode(err, errs.CodeValidation) {
		t.Fatalf("got %v", err)
	}
}

func TestRefreshDecision(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	fresh := RefreshToken{ExpiresAt: now.Add(time.Hour)}
	if fresh.Decide(now) != Rotate {
		t.Fatal("fresh token must rotate")
	}
	just := now.Add(-5 * time.Second)
	if (RefreshToken{ExpiresAt: now.Add(time.Hour), RotatedAt: &just}).Decide(now) != Reuse {
		t.Fatal("sibling request inside the grace window must reuse")
	}
	old := now.Add(-time.Minute)
	if (RefreshToken{ExpiresAt: now.Add(time.Hour), RotatedAt: &old}).Decide(now) != Theft {
		t.Fatal("old token after the grace window is theft")
	}
	if (RefreshToken{ExpiresAt: now}).Decide(now) != Reject {
		t.Fatal("expired token must be rejected")
	}
}
