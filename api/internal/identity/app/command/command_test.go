package command_test

import (
	"context"
	"testing"
	"time"

	identitypg "github.com/syabanf/wit-hospitality/api/internal/identity/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/identity/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/identity/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
	"github.com/syabanf/wit-hospitality/api/seed"
)

// movable is a clock a test can move forward.
type movable struct{ t *time.Time }

func (m movable) Now() time.Time { return *m.t }

type env struct {
	deps    command.Deps
	queries query.Queries
	now     *time.Time
}

func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, identitypg.Migrations())
	raw, err := seed.FS.ReadFile("identity.json")
	if err != nil {
		t.Fatal(err)
	}
	data, err := identitypg.ParseSeed(raw)
	if err != nil {
		t.Fatal(err)
	}
	makassar, _ := time.LoadLocation("Asia/Makassar")
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)
	clk := movable{&now}
	if err := identitypg.Seed(context.Background(), d, data, clock.DaysBetween(data.BaseDate, clock.Today(clk))); err != nil {
		t.Fatal(err)
	}
	matrix := identitypg.Permissions{DB: d}
	authz := rbac.Authorizer{Source: matrix}
	return env{
		deps: command.Deps{
			DB: d, Users: identitypg.Users{DB: d}, Sessions: identitypg.Sessions{DB: d}, Permissions: matrix,
			Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk, Issuer: auth.Issuer{Secret: []byte("test-secret-test-secret-test-secret"), TTL: 15 * time.Minute},
			Authz: authz, RefreshTTL: 24 * time.Hour, InitialPassword: "welcome123",
		},
		queries: query.Queries{Store: identitypg.ReadStore{DB: d, Matrix: matrix}, Authz: authz},
		now:     &now,
	}
}

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	if err != nil {
		return err.Error()
	}
	return ""
}

func (e env) login(t *testing.T, email string) auth.Session {
	t.Helper()
	s, _, err := command.Login{Deps: e.deps}.Handle(context.Background(), domain.LoginInput{Email: email, Password: "villa123"}, "test")
	if err != nil {
		t.Fatalf("login %s: %v", email, err)
	}
	return s
}

func TestLogin(t *testing.T) {
	e := setup(t)
	s, u, err := command.Login{Deps: e.deps}.Handle(context.Background(), domain.LoginInput{Email: " Kadek@BaliVillas.id ", Password: "villa123"}, "test")
	if err != nil {
		t.Fatal(err)
	}
	if u.ID != "usr-kadek" || s.Principal.Role != "manager" || s.RefreshToken == "" || *u.LastLoginOn != "2026-11-11" {
		t.Fatalf("got %+v %+v", u, s.Principal)
	}
	if _, _, err := (command.Login{Deps: e.deps}).Handle(context.Background(), domain.LoginInput{Email: "kadek@balivillas.id", Password: "wrong"}, ""); code(err) != "INVALID_CREDENTIALS" {
		t.Fatalf("wrong password: %v", err)
	}
	if _, _, err := (command.Login{Deps: e.deps}).Handle(context.Background(), domain.LoginInput{Email: "agus@balivillas.id", Password: "villa123"}, ""); code(err) != "USER_INACTIVE" {
		t.Fatalf("inactive login: %v", err)
	}
	if _, _, err := (command.Login{Deps: e.deps}).Handle(context.Background(), domain.LoginInput{Email: "nobody", Password: ""}, ""); code(err) != errs.CodeValidation {
		t.Fatalf("empty form: %v", err)
	}
	var denied int
	_ = e.deps.DB.Pool.QueryRow(context.Background(), `SELECT count(*) FROM platform.audit_log WHERE action = 'denied' AND summary = 'Failed sign-in for kadek@balivillas.id'`).Scan(&denied)
	if denied != 1 {
		t.Fatalf("the failed sign-in must be audited, got %d", denied)
	}
}

func TestRefreshRotatesAndCatchesReuse(t *testing.T) {
	e := setup(t)
	s := e.login(t, "rama@balivillas.id")
	refresh := command.Refresh{Deps: e.deps}
	next, err := refresh.Refresh(context.Background(), s.RefreshToken)
	if err != nil || next.RefreshToken == "" || next.RefreshToken == s.RefreshToken {
		t.Fatalf("rotation: %+v %v", next, err)
	}
	// A sibling request with the old cookie inside the grace window gets an access token only.
	sibling, err := refresh.Refresh(context.Background(), s.RefreshToken)
	if err != nil || sibling.RefreshToken != "" || sibling.AccessToken == "" {
		t.Fatalf("grace reuse: %+v %v", sibling, err)
	}
	// The old token after the window means someone else holds it: the whole session ends.
	*e.now = e.now.Add(time.Minute)
	if _, err := refresh.Refresh(context.Background(), s.RefreshToken); code(err) != errs.CodeUnauthenticated {
		t.Fatalf("theft: %v", err)
	}
	if _, err := refresh.Refresh(context.Background(), next.RefreshToken); code(err) != errs.CodeUnauthenticated {
		t.Fatalf("the session must be revoked after theft: %v", err)
	}
	if _, err := refresh.Refresh(context.Background(), "made-up"); code(err) != errs.CodeUnauthenticated {
		t.Fatalf("unknown token: %v", err)
	}
}

func TestUserAdministration(t *testing.T) {
	e := setup(t)
	admin := e.login(t, "admin@balivillas.id").Principal
	ctx := auth.WithPrincipal(context.Background(), admin)
	in := domain.UserInput{Name: " Nyoman Putra ", Email: "nyoman@balivillas.id", Role: "staff", Status: "active", VillaIDs: []string{"vil-saka"}}
	u, err := command.CreateUser{Deps: e.deps}.Handle(ctx, admin, in)
	if err != nil || u.Name != "Nyoman Putra" || u.CreatedOn != "2026-11-11" {
		t.Fatalf("got %+v %v", u, err)
	}
	if _, err := (command.CreateUser{Deps: e.deps}).Handle(ctx, admin, in); code(err) != errs.CodeValidation {
		t.Fatalf("duplicate email: %v", err)
	}
	if _, _, err := (command.Login{Deps: e.deps}).Handle(context.Background(), domain.LoginInput{Email: "nyoman@balivillas.id", Password: "welcome123"}, ""); err != nil {
		t.Fatalf("new login uses the initial password: %v", err)
	}
	self := domain.UserInput{Name: "System administrator", Email: "admin@balivillas.id", Role: "owner", Status: "active"}
	if _, err := (command.UpdateUser{Deps: e.deps}).Handle(ctx, admin, admin.UserID, self); code(err) != "ACCESS_SELF" {
		t.Fatalf("own role: %v", err)
	}
	if _, err := (command.SetUserActive{Deps: e.deps}).Handle(ctx, admin, admin.UserID, false); code(err) != "ACCESS_SELF" {
		t.Fatalf("deactivate self: %v", err)
	}
	off, err := command.SetUserActive{Deps: e.deps}.Handle(ctx, admin, u.ID, false)
	if err != nil || off.Status != "inactive" {
		t.Fatalf("got %+v %v", off, err)
	}
	if _, err := (command.SavePermissions{Deps: e.deps}).Handle(ctx, admin, "owner", nil); code(err) != "ACCESS_OWNER" {
		t.Fatalf("admin editing owner: %v", err)
	}
	row := rbac.DefaultPermissions()["staff"]
	row["reports"] = []rbac.Action{"view"}
	all, err := command.SavePermissions{Deps: e.deps}.Handle(ctx, admin, "staff", row)
	if err != nil || !rbac.Can(all, "staff", "reports", "view") {
		t.Fatalf("got %v", err)
	}
	staff := e.login(t, "wayan@balivillas.id").Principal
	if _, err := (command.CreateUser{Deps: e.deps}).Handle(ctx, staff, in); code(err) != errs.CodeForbidden {
		t.Fatalf("staff creating users: %v", err)
	}
	if _, err := e.queries.Users(auth.WithPrincipal(context.Background(), staff)); code(err) != errs.CodeForbidden {
		t.Fatalf("staff listing users: %v", err)
	}
	users, err := e.queries.Users(ctx)
	if err != nil || len(users) != 15 {
		t.Fatalf("got %d users, %v", len(users), err)
	}
}

func TestChangePasswordEndsOtherSessions(t *testing.T) {
	e := setup(t)
	first := e.login(t, "dian@balivillas.id")
	second := e.login(t, "dian@balivillas.id")
	change := command.ChangePassword{Deps: e.deps}
	if err := change.Handle(context.Background(), second.Principal, domain.PasswordChange{Current: "wrong", Next: "newpass123", Confirm: "newpass123"}); code(err) != "INVALID_CREDENTIALS" {
		t.Fatalf("wrong current: %v", err)
	}
	if err := change.Handle(context.Background(), second.Principal, domain.PasswordChange{Current: "villa123", Next: "newpass123", Confirm: "newpass123"}); err != nil {
		t.Fatal(err)
	}
	refresh := command.Refresh{Deps: e.deps}
	if _, err := refresh.Refresh(context.Background(), first.RefreshToken); code(err) != errs.CodeUnauthenticated {
		t.Fatalf("other session survived: %v", err)
	}
	if _, err := refresh.Refresh(context.Background(), second.RefreshToken); err != nil {
		t.Fatalf("own session ended: %v", err)
	}
}
