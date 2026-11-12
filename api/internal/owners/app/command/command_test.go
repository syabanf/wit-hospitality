package command_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/owners/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/owners/adapters/results"
	"github.com/syabanf/wit-hospitality/api/internal/owners/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/owners/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
)

var (
	ida    = auth.Principal{UserID: "usr-ida", Name: "Ida Bagus Rai", Role: "finance", LocationIDs: []string{}, VillaIDs: []string{}}
	rama   = auth.Principal{UserID: "usr-rama", Name: "Rama Wijaya", Role: "owner", LocationIDs: []string{}, VillaIDs: []string{}}
	kadek  = auth.Principal{UserID: "usr-kadek", Name: "Kadek Ariani", Role: "manager", LocationIDs: []string{}, VillaIDs: []string{}}
	hendra = auth.Principal{UserID: "usr-hendra", Name: "Hendra Gunawan", Role: "investor", LocationIDs: []string{}, VillaIDs: []string{"vil-karang", "vil-pandawa"}}
	sophie = auth.Principal{UserID: "usr-sophie", Name: "Sophie Laurent", Role: "investor", LocationIDs: []string{}, VillaIDs: []string{"vil-lumbung"}}
)

type env struct {
	db      *db.DB
	deps    command.Deps
	queries query.Queries
}

// setup seeds every context on a fresh database, as cmd/seed does, and wires owners' commands with
// the stub villa results the monolith uses before finance exists.
func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	if err := bootstrap.Seed(context.Background(), d, logging.Discard(), clk); err != nil {
		t.Fatal(err)
	}
	store := postgres.Store{DB: d}
	authz := rbac.Authorizer{Source: rbac.Static(rbac.DefaultPermissions())}
	return env{
		db:      d,
		deps:    command.Deps{DB: d, Repo: store, Results: results.Stub{Store: store}, Authz: authz, Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk},
		queries: query.Queries{Store: store, Authz: authz, Clock: clk},
	}
}

func as(p auth.Principal) context.Context { return auth.WithPrincipal(context.Background(), p) }

func refused(t *testing.T, err error, code string) {
	t.Helper()
	if !errs.HasCode(err, code) {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func (e env) statement(t *testing.T, contractID, month string) domain.Statement {
	t.Helper()
	list, err := e.queries.Statements(as(ida))
	if err != nil {
		t.Fatal(err)
	}
	for _, st := range list {
		if st.ContractID == contractID && st.Month == month {
			return st
		}
	}
	t.Fatalf("no %s statement for %s", month, contractID)
	return domain.Statement{}
}

// events lists the payloads of one event type in the outbox, oldest first.
func (e env) events(t *testing.T, eventType string) []json.RawMessage {
	t.Helper()
	rows, err := e.db.Pool.Query(context.Background(), `SELECT payload FROM platform.outbox WHERE event_type = $1 ORDER BY id`, eventType)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []json.RawMessage
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		out = append(out, raw)
	}
	return out
}

func TestPortalReadsOnlyTheInvestorsRecords(t *testing.T) {
	t.Parallel()
	e := setup(t)
	contracts, err := e.queries.Contracts(as(hendra))
	if err != nil || len(contracts) != 2 || contracts[0].ID != "ct-karang" || contracts[1].ID != "ct-pandawa" {
		t.Fatalf("hendra's contracts %v %+v", err, contracts)
	}
	sophies, _ := e.queries.Owners(as(sophie))
	if len(sophies) != 1 || sophies[0].ID != "own-sophie" {
		t.Fatalf("sophie record %+v", sophies)
	}
	if all, _ := e.queries.Owners(as(kadek)); len(all) != 2 {
		t.Fatalf("the operator reads every owner: %d", len(all))
	}
	stays, _ := e.queries.StayRequests(as(hendra))
	if len(stays) != 1 || stays[0].ID != "osr-1" {
		t.Fatalf("hendra's stays %+v", stays)
	}
	// Reopen and close Karang's October: the closed statement stays with the operator until approved.
	e.finance(t, owners0(e, t, "ct-karang"), owners.EventFinanceEntryRejected, "rejected")
	if _, err := (command.ReopenStatement{Deps: e.deps}).Handle(context.Background(), ida, owners0(e, t, "ct-karang").ID, "Fee to be checked"); err != nil {
		t.Fatal(err)
	}
	closed, err := (command.CloseStatement{Deps: e.deps}).Handle(context.Background(), ida, command.CloseInput{ContractID: "ct-karang", Month: "2026-10"})
	if err != nil {
		t.Fatal(err)
	}
	mine, _ := e.queries.Statements(as(hendra))
	for _, st := range mine {
		if st.ID == closed.ID || st.Status != domain.StatementApproved || st.OwnerID != "own-hendra" {
			t.Fatalf("hendra reads %s %s of %s", st.Number, st.Status, st.OwnerID)
		}
	}
	if len(mine) != 3 {
		t.Fatalf("hendra reads %d statements", len(mine))
	}
	cal, err := e.queries.Calendar(as(hendra), "2026-10-01", 31)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for _, s := range cal.Spans {
		kinds[s.Kind]++
		if s.UnitCode[:2] != "KR" && s.UnitCode[:2] != "PD" {
			t.Fatalf("span on %s", s.UnitCode)
		}
	}
	if kinds["stay"] == 0 || kinds["owner"] != 1 || len(cal.Villas) != 2 {
		t.Fatalf("calendar %+v %v", kinds, cal.Villas)
	}
	_, err = e.queries.Calendar(as(kadek), "2026-10-01", 31)
	refused(t, err, errs.CodeForbidden)

	facts, err := e.queries.Stays(as(hendra))
	if err != nil {
		t.Fatal(err)
	}
	units, _ := postgres.Store{DB: e.db}.Units(context.Background())
	villaOf := map[string]string{}
	for _, u := range units {
		villaOf[u.ID] = u.VillaID
	}
	segments := map[string]int{}
	for _, s := range facts.Stays {
		segments[s.Segment]++
		if v := villaOf[s.UnitID]; v != "vil-karang" && v != "vil-pandawa" {
			t.Fatalf("a stay on %s of %s", s.UnitID, v)
		}
		if s.CreatedOn == "" || len(s.ListRates) == 0 {
			t.Fatalf("stay facts %+v", s)
		}
	}
	if len(facts.Stays) == 0 || segments["airbnb"] == 0 || segments["direct"] == 0 || len(facts.Blocks) == 0 {
		t.Fatalf("hendra's stays %d by segment %v, %d blocks", len(facts.Stays), segments, len(facts.Blocks))
	}
	_, err = e.queries.Stays(as(kadek))
	refused(t, err, errs.CodeForbidden)
}

// owners0 is the contract's October statement.
func owners0(e env, t *testing.T, contractID string) domain.Statement {
	return e.statement(t, contractID, "2026-10")
}

// finance replays a finance entry event for the statement's payout through the policy.
func (e env) finance(t *testing.T, st domain.Statement, eventType, status string) {
	t.Helper()
	ev := owners.FinanceEntry{TransactionID: *st.PayoutTransactionID, Number: "TX-9", Status: status}
	if st.Payout != nil && st.Payout.Ref != "" {
		ev.SourceRef = st.Payout.Ref
	}
	if err := (command.FollowFinance{Deps: e.deps}).Handle(context.Background(), eventType, ev); err != nil {
		t.Fatal(err)
	}
}

func TestCloseApprovePayAndReopen(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	closeIt := command.CloseStatement{Deps: e.deps}
	approve := command.ApproveStatement{Deps: e.deps}
	pay := command.PayStatement{Deps: e.deps}
	reopen := command.ReopenStatement{Deps: e.deps}

	_, err := closeIt.Handle(ctx, ida, command.CloseInput{ContractID: "ct-karang", Month: "2026-11"})
	refused(t, err, "STATEMENT_MONTH_OPEN")
	_, err = closeIt.Handle(ctx, ida, command.CloseInput{ContractID: "ct-karang", Month: "2026-10"})
	refused(t, err, "STATEMENT_CLOSED")
	_, err = closeIt.Handle(ctx, ida, command.CloseInput{ContractID: "ct-karang", Month: "2026-08"})
	refused(t, err, "STATEMENT_ORDER")
	_, err = closeIt.Handle(ctx, hendra, command.CloseInput{ContractID: "ct-karang", Month: "2026-08"})
	refused(t, err, errs.CodeForbidden)

	seeded := owners0(e, t, "ct-karang")
	_, err = reopen.Handle(ctx, ida, seeded.ID, "Wrong fee")
	refused(t, err, "PAYOUT_OPEN")
	_, err = reopen.Handle(ctx, ida, e.statement(t, "ct-karang", "2026-09").ID, "Wrong fee")
	refused(t, err, "STATEMENT_ORDER")
	e.finance(t, seeded, owners.EventFinanceEntryRejected, "rejected")
	_, err = reopen.Handle(ctx, hendra, seeded.ID, "Mine")
	refused(t, err, errs.CodeForbidden)
	_, err = reopen.Handle(ctx, ida, seeded.ID, "")
	refused(t, err, errs.CodeValidation)
	if _, err := reopen.Handle(ctx, ida, seeded.ID, "Fee to be checked"); err != nil {
		t.Fatal(err)
	}
	if n := len(e.events(t, owners.EventStatementReopened)); n != 1 {
		t.Fatalf("reopened events %d", n)
	}

	closed, err := closeIt.Handle(ctx, ida, command.CloseInput{ContractID: "ct-karang", Month: "2026-10"})
	if err != nil {
		t.Fatal(err)
	}
	f := closed.Figures
	// The stub reads October's stays; owner nights come from the seeded owner block.
	if f.OwnerNights != 3 || f.OwnerStays != 1 || f.OwnerStayCharge != 350_000 || f.RoomRevenue <= 0 || f.RoomRevenue != seeded.Figures.RoomRevenue {
		t.Fatalf("figures %+v, seeded room revenue %d", f, seeded.Figures.RoomRevenue)
	}
	if closed.Number != "OS-2026-10-KR" || closed.ID != "os-7" || closed.Status != "closed" || closed.ClosedBy != "Ida Bagus Rai" {
		t.Fatalf("closed %+v", closed)
	}
	var ev struct {
		Statement domain.Statement `json:"statement"`
		Journal   domain.Journal   `json:"journal"`
	}
	if err := json.Unmarshal(e.events(t, owners.EventStatementClosed)[0], &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Statement.Figures != f || ev.Journal.Lines[0] != (domain.JournalLine{AccountID: "gl-5900", Debit: f.GOP}) || len(ev.Journal.Lines) != 5 {
		t.Fatalf("closed event %+v", ev.Journal)
	}

	_, err = approve.Handle(ctx, ida, closed.ID, "")
	refused(t, err, "APPROVAL_ROLE")
	_, err = pay.Handle(ctx, ida, closed.ID, "bank-bca")
	refused(t, err, "STATEMENT_NOT_APPROVED")
	approved, err := approve.Handle(ctx, rama, closed.ID, "Agreed")
	if err != nil || approved.Status != "approved" || *approved.ApprovedBy != "Rama Wijaya" || approved.Note != "Agreed" {
		t.Fatalf("approve %v %+v", err, approved)
	}
	_, err = approve.Handle(ctx, rama, closed.ID, "")
	refused(t, err, "STATEMENT_INVALID_STATE")

	paying, err := pay.Handle(ctx, ida, closed.ID, "bank-bca")
	if err != nil {
		t.Fatal(err)
	}
	_, err = pay.Handle(ctx, ida, closed.ID, "bank-bca")
	refused(t, err, "PAYOUT_OPEN")
	var req owners.PayoutRequested
	if err := json.Unmarshal(e.events(t, owners.EventPayoutRequested)[0], &req); err != nil {
		t.Fatal(err)
	}
	if req.Amount != f.NetPayable || req.Kind != "cash_out" || req.CategoryID != "cat-owner-payout" || req.Origin != "owner_payout" || req.Reference != "OS-2026-10-KR" || req.SourceRef != paying.Payout.Ref {
		t.Fatalf("payout request %+v", req)
	}
	if err := (command.FollowFinance{Deps: e.deps}).Handle(ctx, owners.EventFinanceEntryPosted, owners.FinanceEntry{TransactionID: "tx-900", Number: "TX-3001", Status: "posted", SourceRef: req.SourceRef}); err != nil {
		t.Fatal(err)
	}
	_, err = reopen.Handle(ctx, ida, closed.ID, "Too late")
	refused(t, err, "STATEMENT_PAID")
	if st := owners0(e, t, "ct-karang"); st.PayoutTransactionID == nil || *st.PayoutTransactionID != "tx-900" {
		t.Fatalf("payout transaction %+v", st.PayoutTransactionID)
	}

	// The closer cannot approve their own statement, even as the Owner.
	if err := mustReopenPandawa(t, e); err != nil {
		t.Fatal(err)
	}
	mine, err := closeIt.Handle(ctx, rama, command.CloseInput{ContractID: "ct-pandawa", Month: "2026-10"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = approve.Handle(ctx, rama, mine.ID, "")
	refused(t, err, "APPROVAL_SELF")
}

// mustReopenPandawa reopens Pandawa's October, which carried a shortfall and has no payout.
func mustReopenPandawa(t *testing.T, e env) error {
	t.Helper()
	st := owners0(e, t, "ct-pandawa")
	_, err := (command.PayStatement{Deps: e.deps}).Handle(context.Background(), ida, st.ID, "bank-bca")
	refused(t, err, "PAYOUT_NOTHING")
	_, err = (command.ReopenStatement{Deps: e.deps}).Handle(context.Background(), ida, st.ID, "Recheck the costs")
	return err
}

func TestOwnerStays(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	request := command.RequestStay{Deps: e.deps}
	decide := command.DecideStay{Deps: e.deps}
	_, err := request.Handle(ctx, sophie, domain.StayInput{ContractID: "ct-karang", CheckIn: "2026-12-01", CheckOut: "2026-12-03", Guests: 2})
	refused(t, err, errs.CodeForbidden)
	_, err = request.Handle(ctx, sophie, domain.StayInput{ContractID: "ct-lumbung", CheckIn: "2026-12-01", CheckOut: "2027-01-02", Guests: 2})
	refused(t, err, "OWNER_NIGHTS_EXCEEDED")
	_, err = request.Handle(ctx, kadek, domain.StayInput{ContractID: "ct-lumbung", CheckIn: "2026-12-01", CheckOut: "2026-12-04", Guests: 2})
	refused(t, err, errs.CodeForbidden)
	asked, err := request.Handle(ctx, sophie, domain.StayInput{ContractID: "ct-lumbung", CheckIn: "2027-02-10", CheckOut: "2027-02-13", Guests: 2, Note: " Christmas shopping "})
	if err != nil || asked.Status != "pending" || asked.Number != "OSR-003" || asked.Note != "Christmas shopping" {
		t.Fatalf("request %v %+v", err, asked)
	}
	_, err = decide.Handle(ctx, sophie, asked.ID, command.Decision{Approve: true, UnitID: "unit-lb-01"})
	refused(t, err, errs.CodeForbidden)
	_, err = decide.Handle(ctx, kadek, asked.ID, command.Decision{Approve: true, UnitID: "unit-kr-01"})
	refused(t, err, errs.CodeValidation)
	_, err = decide.Handle(ctx, kadek, asked.ID, command.Decision{Approve: false, Note: "no"})
	refused(t, err, errs.CodeValidation)
	var decided domain.StayRequest
	// Every Lumbung loft is booked over December 1 to 4, so take the stay in February.
	_, err = decide.Handle(ctx, kadek, asked.ID, command.Decision{Approve: true, UnitID: "unit-kr-01"})
	refused(t, err, errs.CodeValidation)
	for _, unit := range []string{"unit-lb-01", "unit-lb-02", "unit-lb-03", "unit-lb-04"} {
		if decided, err = decide.Handle(ctx, kadek, asked.ID, command.Decision{Approve: true, UnitID: unit}); err == nil {
			break
		}
		refused(t, err, "BOOKING_OVERLAP")
	}
	if decided.Status != "approved" || decided.BlockID == nil || decided.UnitID == nil || *decided.DecidedBy != "Kadek Ariani" {
		t.Fatalf("decided %+v", decided)
	}
	_, err = decide.Handle(ctx, kadek, asked.ID, command.Decision{Approve: false, Note: "Too late"})
	refused(t, err, "OWNER_STAY_DECIDED")
	var ev owners.StayDecided
	if err := json.Unmarshal(e.events(t, owners.EventStayDecided)[0], &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Block == nil || ev.Block.ID != *decided.BlockID || ev.Block.Reason != "owner" || ev.Block.Note != "Owner stay OSR-003, Sophie Laurent" {
		t.Fatalf("decided event %+v", ev.Block)
	}
}

func TestContractsAndOwners(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	saveOwner := command.SaveOwner{Deps: e.deps}
	_, err := saveOwner.Handle(ctx, ida, "", domain.OwnerInput{Name: "A", Email: "x"})
	refused(t, err, errs.CodeValidation)
	_, err = saveOwner.Handle(ctx, kadek, "", domain.OwnerInput{Name: "Made Putra", Email: "made@example.com", Bank: domain.BankAccount{AccountNumber: "1"}})
	refused(t, err, errs.CodeForbidden)
	o, err := saveOwner.Handle(ctx, ida, "", domain.OwnerInput{Name: " Made Putra ", Email: "made@example.com", Bank: domain.BankAccount{Bank: "BCA", AccountNumber: "123"}})
	if err != nil || o.ID != "own-3" || o.Name != "Made Putra" {
		t.Fatalf("owner %v %+v", err, o)
	}
	in := domain.ContractInput{VillaID: "vil-saka", OwnerID: o.ID, Start: "2027-01-01", End: "2029-12-31", FeeBasis: "gop", FeePct: 20, Charged: "operating",
		OwnerNightsPerYear: 14, OwnerStayPricing: "free", ReservePct: 3, PayoutDay: 10, Shortfall: "topup"}
	c, err := (command.SaveContract{Deps: e.deps}).Handle(ctx, ida, "", in)
	if err != nil || c.ID != "ct-4" || c.Number != "MC-2026-04" {
		t.Fatalf("contract %v %+v", err, c)
	}
	in.VillaID = "vil-karang"
	_, err = (command.SaveContract{Deps: e.deps}).Handle(ctx, ida, "", in)
	refused(t, err, errs.CodeValidation)
}
