package command_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
	guestmodule "github.com/syabanf/wit-hospitality/api/internal/guest/module"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/services"
	"github.com/syabanf/wit-hospitality/api/internal/services/adapters/clients"
	servicespg "github.com/syabanf/wit-hospitality/api/internal/services/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/services/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/services/domain"
)

var (
	kadek = auth.Principal{UserID: "usr-kadek", Name: "Kadek Ariani", Role: "manager", LocationIDs: []string{}, VillaIDs: []string{}}
	wayan = auth.Principal{UserID: "usr-wayan", Name: "Wayan Sudiarta", Role: "staff", LocationIDs: []string{}, VillaIDs: []string{"vil-saka"}}
	hr    = auth.Principal{UserID: "usr-hr", Name: "HR", Role: "hr", LocationIDs: []string{}, VillaIDs: []string{}}
	ctx   = context.Background()
)

const (
	today    = "2026-11-11"
	tomorrow = "2026-11-12"
	// saka is Mia Tan's stay in SK-04, in house until 2026-11-14.
	saka = "bk-1305"
)

type env struct {
	db      *db.DB
	deps    command.Deps
	queries query.Queries
}

// setup seeds every context on a fresh database, as cmd/seed does, at 10:00 on 2026-11-11 in
// Makassar, and wires services with reservation's stays and guest's client in process.
func setup(t *testing.T) env {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	if err := bootstrap.Seed(ctx, d, logging.Discard(), clk); err != nil {
		t.Fatal(err)
	}
	perms := rbac.Static(rbac.DefaultPermissions())
	guests := guestmodule.New(guestmodule.Deps{DB: d, Clock: clk, Permissions: perms, Log: logging.Discard()}).Client()
	return env{
		db: d,
		deps: command.Deps{
			DB: d, Repo: servicespg.Repo{DB: d}, Catalog: servicespg.CatalogStore{DB: d}, Stays: reservationpg.StayLookup{DB: d},
			Guests: clients.Guests{Client: func() guest.Client { return guests }}, Billing: clients.PendingBilling{},
			Authz: rbac.Authorizer{Source: perms}, Audit: audit.Recorder{DB: d, Clock: clk}, Clock: clk,
		},
		queries: query.Queries{Store: servicespg.ReadStore{DB: d}},
	}
}

func list[T any](t *testing.T, e env, p auth.Principal, table string) []T {
	t.Helper()
	rows, err := e.queries.List(auth.WithPrincipal(ctx, p), table)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]T, len(rows))
	for i, r := range rows {
		if err := json.Unmarshal(r, &out[i]); err != nil {
			t.Fatal(err)
		}
	}
	return out
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

func message(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Message
	}
	return ""
}

// item finds a Saka menu item by name.
func item(t *testing.T, e env, name string) domain.MenuItem {
	t.Helper()
	for _, m := range list[domain.MenuItem](t, e, kadek, query.MenuItems) {
		if m.VillaID == "vil-saka" && m.Name == name {
			return m
		}
	}
	t.Fatalf("no Saka item %s", name)
	return domain.MenuItem{}
}

func orderFor(booking string, lines ...domain.OrderLineInput) domain.OrderInput {
	return domain.OrderInput{BookingID: booking, Lines: lines, RequestedOn: tomorrow, RequestedAt: 12 * 60, Priority: "normal"}
}

// events lists the payloads of one event type in the outbox, oldest first.
func events[T any](t *testing.T, e env, eventType string) []T {
	t.Helper()
	rows, err := e.db.Pool.Query(ctx, `SELECT payload FROM platform.outbox WHERE event_type = $1 ORDER BY id`, eventType)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []T
	for rows.Next() {
		var raw []byte
		var v T
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

func TestSeedLoadsTheMenuOrdersAndRequestsInScope(t *testing.T) {
	t.Parallel()
	e := setup(t)
	if n := len(list[domain.MenuItem](t, e, kadek, query.MenuItems)); n != 166 {
		t.Fatalf("menu: %d items", n)
	}
	if n := len(list[domain.ServicePartner](t, e, wayan, query.Partners)); n != 3 {
		t.Fatalf("partners: %d", n)
	}
	all := list[domain.ServiceOrder](t, e, kadek, query.Orders)
	if len(all) != 14 || all[0].Number != "SO-701" {
		t.Fatalf("orders: %d", len(all))
	}
	for _, o := range list[domain.ServiceOrder](t, e, wayan, query.Orders) {
		if o.VillaID != "vil-saka" {
			t.Fatalf("staff of Saka sees %s in %s", o.Number, o.VillaID)
		}
	}
	for _, r := range list[domain.ServiceRequest](t, e, wayan, query.Requests) {
		if !strings.HasPrefix(r.UnitID, "unit-sk-") {
			t.Fatalf("staff of Saka sees %s on %s", r.Number, r.UnitID)
		}
	}
	if _, err := e.queries.List(ctx, query.Orders); code(err) != errs.CodeUnauthenticated {
		t.Fatalf("anonymous: %v", err)
	}
}

func TestDeskOrderChargesTheMenuPriceAndPublishesIt(t *testing.T) {
	t.Parallel()
	e := setup(t)
	nasi, laundry := item(t, e, "Nasi goreng ayam"), item(t, e, "Wash and fold")
	o, err := command.PlaceOrder{Deps: e.deps}.Handle(ctx, kadek, orderFor(saka, domain.OrderLineInput{ItemID: nasi.ID, Quantity: 2}, domain.OrderLineInput{ItemID: laundry.ID, Quantity: 2.5}))
	if err != nil {
		t.Fatal(err)
	}
	if o.Number != "SO-715" || o.Status != domain.OrderNew || o.PlacedBy != "staff" || o.Totals().Charge != 2*75_000+112_500 || o.VillaID != "vil-saka" {
		t.Fatalf("order %+v", o)
	}
	placed := events[services.OrderRecord](t, e, services.EventOrderPlaced)
	if len(placed) != 1 || placed[0].ID != o.ID || placed[0].LocationID != "loc-canggu" || placed[0].BookingID != saka {
		t.Fatalf("placed events %+v", placed)
	}
	var trail string
	if err := e.db.Pool.QueryRow(ctx, `SELECT summary FROM platform.audit_log WHERE entity_id = 'SO-715'`).Scan(&trail); err != nil || trail != "Ordered 2 × Nasi goreng ayam, 2.5 × Wash and fold for BK-1305" {
		t.Fatalf("audit %q %v", trail, err)
	}
	_, err = command.PlaceOrder{Deps: e.deps}.Handle(ctx, hr, orderFor(saka, domain.OrderLineInput{ItemID: nasi.ID, Quantity: 1}))
	if code(err) != errs.CodeForbidden {
		t.Fatalf("hr: %v", err)
	}
}

func TestOrdersRefuseOutsideHoursNoticeAndStay(t *testing.T) {
	t.Parallel()
	e := setup(t)
	place := command.PlaceOrder{Deps: e.deps}
	breakfast := item(t, e, "Balinese breakfast")
	in := orderFor(saka, domain.OrderLineInput{ItemID: breakfast.ID, Quantity: 1})
	in.RequestedAt = 15 * 60
	if _, err := place.Handle(ctx, kadek, in); code(err) != domain.CodeItemUnavailable || message(err) != "Balinese breakfast is served 06:30 to 10:30." {
		t.Fatalf("hours: %v", err)
	}
	floating := item(t, e, "Floating breakfast")
	in = orderFor(saka, domain.OrderLineInput{ItemID: floating.ID, Quantity: 1})
	in.RequestedOn, in.RequestedAt = today, 9*60+59
	if _, err := place.Handle(ctx, kadek, in); code(err) != domain.CodeItemLeadTime || message(err) != "Floating breakfast needs 12 h notice; pick 22:00 or later." {
		t.Fatalf("lead time: %v", err)
	}
	nasi := item(t, e, "Nasi goreng ayam")
	if _, err := place.Handle(ctx, kadek, orderFor("bk-1325", domain.OrderLineInput{ItemID: nasi.ID, Quantity: 1})); code(err) != domain.CodeOrderNoStay ||
		message(err) != "BK-1325 is not in house or arriving within 3 days; room service is for staying guests." {
		t.Fatalf("no stay: %v", err)
	}
	in = orderFor(saka, domain.OrderLineInput{ItemID: nasi.ID, Quantity: 1})
	in.RequestedOn = "2026-11-15"
	if _, err := place.Handle(ctx, kadek, in); code(err) != domain.CodeOrderNoStay || message(err) != "BK-1305 checks out on 2026-11-14; pick a time during the stay." {
		t.Fatalf("after check-out: %v", err)
	}
	if _, err := place.Handle(ctx, kadek, orderFor("bk-1296", domain.OrderLineInput{ItemID: nasi.ID, Quantity: 1})); code(err) != domain.CodeItemUnavailable ||
		message(err) != "Nasi goreng ayam is not on the Villa Karang menu." {
		t.Fatalf("other villa's item: %v", err)
	}
	if _, err := place.Handle(ctx, wayan, orderFor("bk-1296", domain.OrderLineInput{ItemID: nasi.ID, Quantity: 1})); code(err) != errs.CodeForbidden {
		t.Fatalf("out of scope: %v", err)
	}
}

func TestCompsNeedPermissionAndDiscountsStayInsideTheLimit(t *testing.T) {
	t.Parallel()
	e := setup(t)
	place := command.PlaceOrder{Deps: e.deps}
	coconut := item(t, e, "Fresh young coconut")
	free := orderFor(saka, domain.OrderLineInput{ItemID: coconut.ID, Quantity: 1, Comp: true})
	free.CompReason = "Welcome drink"
	if _, err := place.Handle(ctx, wayan, free); code(err) != domain.CodeCompForbidden || message(err) != "Staff cannot give items for free. Ask a villa manager." {
		t.Fatalf("comp: %v", err)
	}
	off := orderFor(saka, domain.OrderLineInput{ItemID: coconut.ID, Quantity: 1})
	off.DiscountPct, off.DiscountReason = 25, "Complaint"
	if _, err := place.Handle(ctx, wayan, off); code(err) != domain.CodeDiscountLimit || message(err) != "25% off is past the 10% limit. Ask a villa manager to give it." {
		t.Fatalf("discount: %v", err)
	}
	o, err := place.Handle(ctx, kadek, free)
	if err != nil || o.Totals().Charge != 0 || o.CompReason != "Welcome drink" {
		t.Fatalf("manager comp: %+v %v", o, err)
	}
}

func TestDeliveryPublishesTheLinesForBillingInventoryAndFinance(t *testing.T) {
	t.Parallel()
	e := setup(t)
	massage, bintang := item(t, e, "Balinese massage, 60 minutes"), item(t, e, "Bintang large")
	in := orderFor(saka, domain.OrderLineInput{ItemID: massage.ID, Quantity: 2}, domain.OrderLineInput{ItemID: bintang.ID, Quantity: 2})
	in.RequestedAt, in.DiscountPct, in.DiscountReason = 15*60, 10, "Booked two treatments"
	o, err := command.PlaceOrder{Deps: e.deps}.Handle(ctx, kadek, in)
	if err != nil {
		t.Fatal(err)
	}
	step := command.StepOrder{Deps: e.deps}
	if _, err := step.Handle(ctx, kadek, o.ID, domain.OrderDelivered, ""); code(err) != domain.CodeOrderState || message(err) != "A new order cannot become delivered." {
		t.Fatalf("skip a step: %v", err)
	}
	if _, err := step.Handle(ctx, wayan, o.ID, domain.OrderCancelled, "no"); message(err) != "Say why the order is cancelled." {
		t.Fatalf("cancel without reason: %v", err)
	}
	for _, to := range []string{domain.OrderConfirmed, domain.OrderPreparing, domain.OrderDelivered} {
		if o, err = step.Handle(ctx, wayan, o.ID, to, ""); err != nil {
			t.Fatalf("%s: %v", to, err)
		}
	}
	if o.DeliveredOn == nil || *o.DeliveredOn != today || *o.DeliveredAt != 600 || len(o.History) != 4 || o.History[3].By != "Wayan Sudiarta" {
		t.Fatalf("delivered %+v", o)
	}
	delivered := events[services.OrderBilled](t, e, services.EventOrderDelivered)
	if len(delivered) != 1 {
		t.Fatalf("delivered events: %d", len(delivered))
	}
	b := delivered[0]
	if b.Totals.Charge != 639_000 || b.Totals.Cost != 360_000 || b.On != today || b.BookingID != saka || b.LocationID != "loc-canggu" {
		t.Fatalf("billed totals %+v", b)
	}
	if len(b.Codes) != 2 || b.Codes[0] != (services.CodeAmount{Code: "SPA", Amount: 540_000}) || b.Codes[1] != (services.CodeAmount{Code: "MINI", Amount: 99_000}) {
		t.Fatalf("codes %+v", b.Codes)
	}
	if b.Lines[1].TransactionCode != "MINI" || b.Lines[1].Category != "minibar" || b.Lines[1].Amount != 110_000 {
		t.Fatalf("minibar line %+v", b.Lines[1])
	}
	if len(b.PartnerCosts) != 1 || b.PartnerCosts[0].PartnerName != "Taksu Mobile Spa" || b.PartnerCosts[0].Amount != 360_000 || b.PartnerCosts[0].CategoryID != "cat-svc-partner" {
		t.Fatalf("partner costs %+v", b.PartnerCosts)
	}
	if changed := events[services.OrderStatusChanged](t, e, services.EventOrderStatusChanged); len(changed) != 3 || changed[2].From != domain.OrderPreparing || changed[2].To != domain.OrderDelivered {
		t.Fatalf("status events %+v", changed)
	}

	if _, err := step.Handle(ctx, kadek, o.ID, domain.OrderVoided, "Wrong room"); err != nil {
		t.Fatalf("void: %v", err)
	}
	if voided := events[services.OrderBilled](t, e, services.EventOrderVoided); len(voided) != 1 || voided[0].Reason != "Wrong room" || voided[0].Totals.Charge != 639_000 {
		t.Fatalf("voided %+v", voided)
	}
	// SO-702 was delivered yesterday: the business day is closed.
	if _, err := step.Handle(ctx, kadek, "so-2", domain.OrderVoided, "Wrong room"); code(err) != domain.CodeVoidDayClosed {
		t.Fatalf("closed day: %v", err)
	}
}

func TestAssignNamesWhoTakesTheOrder(t *testing.T) {
	t.Parallel()
	e := setup(t)
	assign := command.AssignOrder{Deps: e.deps}
	if _, err := assign.Handle(ctx, kadek, "so-6", "x"); message(err) != "Enter who takes it." {
		t.Fatalf("short: %v", err)
	}
	o, err := assign.Handle(ctx, kadek, "so-6", " Ketut ")
	if err != nil || o.Assignee != "Ketut" || o.History[len(o.History)-1].Kind != "assigned" {
		t.Fatalf("assign %+v %v", o, err)
	}
	if _, err := assign.Handle(ctx, wayan, "so-1", "Ketut"); code(err) != errs.CodeForbidden {
		t.Fatalf("out of scope: %v", err)
	}
}

func TestBillingsPaymentMarksTheOrdersPaidOnce(t *testing.T) {
	t.Parallel()
	e := setup(t)
	paid := command.OrdersPaid{Deps: e.deps}
	fact := billing.PaymentRecorded{PaymentID: "pay-90-bk-1305", Number: "PAY-5090", Kind: "extra", Method: "qris", RecordedBy: "Payment gateway",
		OrderIDs: []string{"so-6", "so-gone"}}
	before, err := e.deps.Repo.Order(ctx, "so-6")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := paid.Handle(ctx, fact); err != nil {
			t.Fatal(err)
		}
	}
	o, err := e.deps.Repo.Order(ctx, "so-6")
	if err != nil {
		t.Fatal(err)
	}
	last := o.History[len(o.History)-1]
	if o.PaymentID == nil || *o.PaymentID != fact.PaymentID || len(o.History) != len(before.History)+1 || last.Kind != "paid" ||
		last.Note != "PAY-5090, QRIS" || last.By != "Payment gateway" {
		t.Fatalf("paid order %+v", o)
	}
	refund := billing.PaymentRecorded{PaymentID: "pay-91-bk-1305", Kind: "refund", Method: "cash", OrderIDs: []string{"so-6"}}
	if err := paid.Handle(ctx, refund); err != nil {
		t.Fatal(err)
	}
	if o, _ = e.deps.Repo.Order(ctx, "so-6"); *o.PaymentID != fact.PaymentID {
		t.Fatalf("a refund moves nothing: %+v", o.PaymentID)
	}
}

func TestGuestOrdersFromTheQRCard(t *testing.T) {
	t.Parallel()
	e := setup(t)
	room := command.Room{Deps: e.deps}
	token := domain.OrderToken("SK-04")
	menu, err := room.View(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	if menu.Stay == nil || menu.Stay.BookingCode != "BK-1305" || menu.Stay.GuestName != "Mia" || menu.VillaName != "Villa Saka" || menu.Today != today {
		t.Fatalf("menu %+v", menu.Stay)
	}
	for _, i := range menu.Items {
		if i.VillaID != "vil-saka" || !i.Active {
			t.Fatalf("item %s of %s", i.Name, i.VillaID)
		}
	}
	breakfast := item(t, e, "Balinese breakfast")
	after, err := room.Place(ctx, token, domain.OrderInput{Lines: []domain.OrderLineInput{{ItemID: breakfast.ID, Quantity: 2, Comp: true}}, Note: "Coffee black", RequestedOn: tomorrow, RequestedAt: 8 * 60})
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Orders) != 1 || after.Orders[0].Status != domain.OrderNew || after.Orders[0].Charge != 240_000 || after.Orders[0].PayState != domain.PayNotDue {
		t.Fatalf("guest order %+v", after.Orders)
	}
	orders := list[domain.ServiceOrder](t, e, kadek, query.Orders)
	placed := orders[len(orders)-1]
	if placed.PlacedBy != "guest" || placed.History[0].By != "Guest" || placed.Lines[0].Comp {
		t.Fatalf("placed %+v", placed)
	}
	if _, err := room.Pay(ctx, token); code(err) != domain.CodeOrderNotBillable {
		t.Fatalf("nothing delivered: %v", err)
	}
	step := command.StepOrder{Deps: e.deps}
	for _, to := range []string{domain.OrderConfirmed, domain.OrderDelivered} {
		if _, err := step.Handle(ctx, kadek, placed.ID, to, ""); err != nil {
			t.Fatal(err)
		}
	}
	if menu, _ := room.View(ctx, token); menu.Outstanding != 240_000 || menu.Orders[0].PayState != domain.PayUnpaid {
		t.Fatalf("outstanding %d", menu.Outstanding)
	}
	if _, err := room.Pay(ctx, token); code(err) != command.CodeNotAvailable {
		t.Fatalf("pay without billing: %v", err)
	}
	if _, err := room.View(ctx, "sk-04-wrong"); code(err) != errs.CodeNotFound {
		t.Fatalf("wrong token: %v", err)
	}
	// PD-01 has nobody in house and no arrival within three days.
	if _, err := room.Place(ctx, domain.OrderToken("PD-01"), domain.OrderInput{Lines: []domain.OrderLineInput{{ItemID: breakfast.ID, Quantity: 1}}, RequestedOn: tomorrow, RequestedAt: 8 * 60}); code(err) != domain.CodeOrderNoStay {
		t.Fatalf("empty room: %v", err)
	}
}

func TestMenuAndPartnersNeedTheCatalogPermission(t *testing.T) {
	t.Parallel()
	e := setup(t)
	bintang := item(t, e, "Bintang large")
	in := domain.MenuItemInput{VillaID: bintang.VillaID, Category: bintang.Category, Name: bintang.Name, Description: bintang.Description, Photo: bintang.Photo,
		Price: 60_000, Unit: bintang.Unit, AvailableFrom: float64(bintang.AvailableFrom), AvailableTo: float64(bintang.AvailableTo), LeadMinutes: float64(bintang.LeadMinutes), Active: true}
	save := command.SaveMenuItem{Deps: e.deps}
	if _, err := save.Handle(ctx, wayan, bintang.ID, in); code(err) != errs.CodeForbidden || message(err) != "Staff cannot edit the room service menu." {
		t.Fatalf("staff: %v", err)
	}
	saved, err := save.Handle(ctx, kadek, bintang.ID, in)
	if err != nil || saved.Price != 60_000 || string(saved.Photo) != string(bintang.Photo) {
		t.Fatalf("manager: %+v %v", saved, err)
	}
	in.Name, in.PartnerID, in.CostPrice = "Sunset cruise", ptr("ptn-none"), 100_000
	if _, err := save.Handle(ctx, kadek, "", in); code(err) != errs.CodeNotFound {
		t.Fatalf("unknown partner: %v", err)
	}
	in.PartnerID = ptr("ptn-hidden-bali")
	created, err := save.Handle(ctx, kadek, "", in)
	if err != nil || !strings.HasPrefix(created.ID, "mi-sunset-cruise-") {
		t.Fatalf("create: %+v %v", created, err)
	}
	if saved := events[services.MenuItemSaved](t, e, services.EventMenuItemSaved); len(saved) != 166+2 {
		t.Fatalf("menu events: %d", len(saved))
	}
	partner, err := command.SavePartner{Deps: e.deps}.Handle(ctx, kadek, "", domain.PartnerInput{Name: " Bali Sea Cruises ", Kind: "tours", Phone: "+62 811 222 333", Active: true})
	if err != nil || partner.Name != "Bali Sea Cruises" {
		t.Fatalf("partner %+v %v", partner, err)
	}
}

func TestServiceRequestsWalkTheBoard(t *testing.T) {
	t.Parallel()
	e := setup(t)
	create := command.CreateRequest{Deps: e.deps}
	r, err := create.Handle(ctx, kadek, domain.ServiceRequestInput{UnitID: "unit-sk-04", BookingID: ptr(saka), Kind: "laundry", Priority: "normal", Note: " Four shirts ", Charge: 120_000})
	if err != nil {
		t.Fatal(err)
	}
	if r.Number != "RQ-113" || r.Status != domain.RequestOpen || r.Note != "Four shirts" || r.RequestedOn != today || r.RequestedAt != 600 {
		t.Fatalf("request %+v", r)
	}
	if _, err := create.Handle(ctx, kadek, domain.ServiceRequestInput{UnitID: "unit-sk-04", BookingID: ptr("bk-none"), Kind: "towels"}); code(err) != errs.CodeNotFound {
		t.Fatalf("unknown stay: %v", err)
	}
	if _, err := create.Handle(ctx, wayan, domain.ServiceRequestInput{UnitID: "unit-kr-03", Kind: "towels"}); code(err) != errs.CodeForbidden {
		t.Fatalf("out of scope: %v", err)
	}
	update := command.UpdateRequest{Deps: e.deps}
	edited, err := update.Handle(ctx, kadek, r.ID, command.RequestPatch{Input: &domain.ServiceRequestInput{UnitID: "unit-sk-04", BookingID: ptr(saka), Kind: "laundry", Priority: "urgent", Note: "By 18:00", Charge: 150_000}})
	if err != nil || edited.Priority != "urgent" || edited.Charge != 150_000 {
		t.Fatalf("edit %+v %v", edited, err)
	}
	assignee := "Wayan"
	if r, err = update.Handle(ctx, kadek, r.ID, command.RequestPatch{Assignee: &assignee}); err != nil || r.Assignee != "Wayan" {
		t.Fatalf("assign %+v %v", r, err)
	}
	step := command.StepRequest{Deps: e.deps}
	if _, err := step.Handle(ctx, kadek, r.ID, domain.RequestInProgress); err != nil {
		t.Fatal(err)
	}
	done, err := step.Handle(ctx, kadek, r.ID, domain.RequestDone)
	if err != nil || done.DoneOn == nil || *done.DoneOn != today {
		t.Fatalf("done %+v %v", done, err)
	}
	if _, err := step.Handle(ctx, kadek, r.ID, domain.RequestInProgress); code(err) != domain.CodeRequestState {
		t.Fatalf("back: %v", err)
	}
	if _, err := update.Handle(ctx, kadek, r.ID, command.RequestPatch{Input: &domain.ServiceRequestInput{UnitID: "unit-sk-04", Kind: "towels"}}); code(err) != domain.CodeRequestState {
		t.Fatalf("edit done: %v", err)
	}
	if saved := events[services.RequestSaved](t, e, services.EventRequestSaved); len(saved) != 5 || saved[0].VillaID != "vil-saka" {
		t.Fatalf("request events: %d", len(saved))
	}
}

func ptr[T any](v T) *T { return &v }
