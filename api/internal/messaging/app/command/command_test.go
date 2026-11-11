package command_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	messagingpg "github.com/syabanf/wit-hospitality/api/internal/messaging/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/adapters/provider"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/module"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/projector"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

var (
	kadek = auth.Principal{UserID: "usr-kadek", Name: "Kadek Ariani", Role: "manager"}
	dian  = auth.Principal{UserID: "usr-dian", Name: "Dian Permata", Role: "reservation"}
	ida   = auth.Principal{UserID: "usr-ida", Name: "Ida Ayu", Role: "finance"}
)

type movable struct{ t *time.Time }

func (m movable) Now() time.Time { return *m.t }

type env struct {
	db      *db.DB
	deps    command.Deps
	queries query.Queries
	bus     *bus.InProcess
	now     *time.Time
}

func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)
	clk := movable{&now}
	if err := bootstrap.Seed(context.Background(), d, logging.Discard(), clk); err != nil {
		t.Fatal(err)
	}
	perms := rbac.Static(rbac.DefaultPermissions())
	authz := rbac.Authorizer{Source: perms}
	proj := projector.New(d, logging.Discard())
	module.New(module.Deps{DB: d, Clock: clk, Permissions: perms, Log: logging.Discard()}).Project(proj)
	b := bus.NewInProcess()
	if err := proj.Attach(b); err != nil {
		t.Fatal(err)
	}
	return env{db: d, bus: b, now: &now, queries: query.Queries{Store: messagingpg.ReadStore{DB: d}, Authz: authz}, deps: command.Deps{
		DB: d, Store: messagingpg.Repo{DB: d}, Provider: provider.Simulated{}, Billing: module.PendingBilling{}, Authz: authz,
		Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk,
	}}
}

func as(p auth.Principal) context.Context { return auth.WithPrincipal(context.Background(), p) }

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	return ""
}

func key(s string) *string { return &s }

func (e env) messages(t *testing.T) []domain.Message {
	t.Helper()
	if err := (command.Sweep{Deps: e.deps}).Handle(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, err := e.queries.Messages(as(kadek))
	if err != nil {
		t.Fatal(err)
	}
	out := make([]domain.Message, len(rows))
	for i, r := range rows {
		if err := json.Unmarshal(r, &out[i]); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func (e env) forBooking(t *testing.T, bookingID string) []domain.Message {
	var out []domain.Message
	for _, m := range e.messages(t) {
		if m.BookingID == bookingID {
			out = append(out, m)
		}
	}
	return out
}

// publish delivers a reservation event to messaging's projections, as the relay does.
func (e env) publish(t *testing.T, eventType string, version int64, payload any) {
	t.Helper()
	raw, _ := json.Marshal(payload)
	if err := e.bus.Publish(context.Background(), bus.Message{ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", version), Type: eventType, AggregateType: "booking", AggregateID: "bk-test", AggregateVersion: version, Payload: raw}); err != nil {
		t.Fatal(err)
	}
}

func stay(status string) reservation.Record {
	data, _ := json.Marshal(map[string]any{"id": "bk-test", "code": "BK-3001", "guestId": "g-01", "unitId": "unit-kr-01", "unitAssigned": true, "status": status,
		"checkIn": "2026-12-21", "checkOut": "2026-12-24"})
	return reservation.Record{ID: "bk-test", VillaIDs: []string{"vil-karang"}, LocationIDs: []string{"loc-uluwatu"}, Data: data}
}

func TestSeededHistoryHasEveryTriggerAndOneFailure(t *testing.T) {
	t.Parallel()
	e := setup(t)
	list := e.messages(t)
	if len(list) <= 20 {
		t.Fatalf("history %d", len(list))
	}
	failed := 0
	keys := map[string]bool{}
	for _, m := range list {
		if m.Status == domain.Failed {
			failed++
		}
		if m.TemplateKey != nil {
			keys[*m.TemplateKey] = true
		}
	}
	for _, k := range []string{"booking_confirmed", "payment_received", "pre_arrival", "welcome", "checkout_reminder", "post_stay"} {
		if !keys[k] {
			t.Fatalf("no %s in the seed", k)
		}
	}
	if failed != 1 {
		t.Fatalf("failed messages %d", failed)
	}
}

func TestConfirmingSendsTheConfirmationThenTemplatesFreeMessagesAndResend(t *testing.T) {
	t.Parallel()
	e := setup(t)
	e.publish(t, reservation.EventBookingSaved, 1, stay("draft"))
	if got := e.forBooking(t, "bk-test"); len(got) != 0 {
		t.Fatalf("a draft sends nothing: %d", len(got))
	}
	e.publish(t, reservation.EventBookingStatusChanged, 2, reservation.StatusChanged{Record: stay("confirmed"), From: "draft", To: "confirmed"})
	e.publish(t, reservation.EventBookingStatusChanged, 2, reservation.StatusChanged{Record: stay("confirmed"), From: "draft", To: "confirmed"})
	got := e.forBooking(t, "bk-test")
	if len(got) != 1 || *got[0].TemplateKey != "booking_confirmed" || !strings.Contains(got[0].Body, "BK-3001") || got[0].SentBy != "System" {
		t.Fatalf("confirmation once: %+v", got)
	}
	send := command.Send{Deps: e.deps}
	sent, err := send.Handle(as(dian), dian, domain.SendInput{BookingID: "bk-test", Channel: "whatsapp", TemplateKey: key("pre_arrival"), Language: "id"})
	if err != nil || !strings.Contains(sent.Body, domain.CheckinToken("bk-test")) || sent.SentBy != "Dian Permata" || sent.Status != domain.Queued {
		t.Fatalf("template: %v %+v", err, sent)
	}
	if _, err := send.Handle(as(dian), dian, domain.SendInput{BookingID: "bk-test", Channel: "email", Language: "en", Body: " "}); code(err) != errs.CodeValidation || err.(*errs.Error).Message != "Write the message." {
		t.Fatalf("empty: %v", err)
	}
	free, err := send.Handle(as(dian), dian, domain.SendInput{BookingID: "bk-test", Channel: "email", Language: "en", Body: "Hi {guest}, the pool is open again."})
	if err != nil || !strings.HasSuffix(free.Body, ", the pool is open again.") || strings.Contains(free.Body, "{guest}") {
		t.Fatalf("free: %v %q", err, free.Body)
	}
	resend := command.Resend{Deps: e.deps}
	if _, err := resend.Handle(as(dian), dian, free.ID); code(err) != "MESSAGE_NOT_FAILED" {
		t.Fatalf("resend a queued message: %v", err)
	}
	var failed domain.Message
	for _, m := range e.messages(t) {
		if m.Status == domain.Failed {
			failed = m
		}
	}
	again, err := resend.Handle(as(dian), dian, failed.ID)
	if err != nil || again.Status != domain.Queued || again.Attempts != 2 {
		t.Fatalf("resend: %v %+v", err, again)
	}
	*e.now = e.now.Add(6 * time.Second)
	for _, m := range e.forBooking(t, "bk-test") {
		if m.Status != domain.Delivered || m.DeliveredAt == nil {
			t.Fatalf("the simulated provider delivers after five seconds: %s %s", m.Number, m.Status)
		}
	}
}

func TestATemplateSwitchedOffStaysQuietAndFinanceCannotSend(t *testing.T) {
	t.Parallel()
	e := setup(t)
	s, _, _ := e.deps.Store.Settings(context.Background())
	for i := range s.Templates {
		if s.Templates[i].Key == "booking_confirmed" {
			s.Templates[i].Enabled = false
		}
	}
	if _, err := (command.SaveSettings{Deps: e.deps}).Handle(as(kadek), kadek, s); err != nil {
		t.Fatal(err)
	}
	e.publish(t, reservation.EventBookingSaved, 1, stay("confirmed"))
	if got := e.forBooking(t, "bk-test"); len(got) != 0 {
		t.Fatalf("switched off: %d", len(got))
	}
	if _, err := (command.Send{Deps: e.deps}).Handle(as(ida), ida, domain.SendInput{BookingID: "bk-test", Channel: "email", Language: "en", Body: "Hello there"}); code(err) != errs.CodeForbidden {
		t.Fatalf("finance sending: %v", err)
	}
}

func TestTheEInvoiceLinkWaitsForBilling(t *testing.T) {
	t.Parallel()
	e := setup(t)
	var bookingID string
	for _, m := range e.messages(t) {
		if m.TemplateKey != nil && *m.TemplateKey == "post_stay" {
			bookingID = m.BookingID
		}
	}
	inv := command.Invoice{Deps: e.deps}
	if _, err := inv.Handle(context.Background(), domain.InvoiceToken(bookingID)); code(err) != command.CodeNotAvailable {
		t.Fatalf("a real link: %v", err)
	}
	if _, err := inv.Handle(context.Background(), "iv-forged"); code(err) != errs.CodeNotFound {
		t.Fatalf("a forged link: %v", err)
	}
}
