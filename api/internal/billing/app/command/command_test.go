package command_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/adapters/clients"
	billingpg "github.com/syabanf/wit-hospitality/api/internal/billing/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
)

var (
	kadek = auth.Principal{UserID: "usr-kadek", Name: "Kadek Ariani", Role: "manager", LocationIDs: []string{}, VillaIDs: []string{}}
	dian  = auth.Principal{UserID: "usr-dian", Name: "Dian Permata", Role: "reservation", LocationIDs: []string{}, VillaIDs: []string{}}
	ida   = auth.Principal{UserID: "usr-ida", Name: "Ida Bagus Rai", Role: "finance", LocationIDs: []string{}, VillaIDs: []string{}}
	wayan = auth.Principal{UserID: "usr-wayan", Name: "Wayan Sudiarta", Role: "staff", LocationIDs: []string{}, VillaIDs: []string{"vil-saka"}}
	sari  = auth.Principal{UserID: "usr-sari", Name: "Sari Dewi", Role: "staff", LocationIDs: []string{}, VillaIDs: []string{"vil-saka"}}
)

// setup seeds every context on one fresh database, as cmd/seed does, and wires billing's commands
// with the stand-ins the monolith uses before finance, services and people exist.
func setup(t *testing.T) command.Deps {
	t.Helper()
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	if err := bootstrap.Seed(context.Background(), d, logging.Discard(), clk); err != nil {
		t.Fatal(err)
	}
	store := billingpg.Store{DB: d}
	return command.Deps{DB: d, Store: store, Authz: rbac.Authorizer{Source: rbac.Static(rbac.DefaultPermissions())}, Audit: audit.Recorder{DB: d, Clock: clk},
		Clock: clk, Finance: clients.PendingFinance{Store: store}, Guests: clients.Guests{}, Orders: billingpg.Orders{DB: d}, Reservation: clients.Reservation{},
		Roster: clients.NoRoster{}}
}

func refused(t *testing.T, err error, code string) {
	t.Helper()
	if !errs.HasCode(err, code) {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func ok(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func events(t *testing.T, d command.Deps, eventType string) int {
	t.Helper()
	var n int
	ok(t, d.DB.Pool.QueryRow(context.Background(), `SELECT count(*) FROM platform.outbox WHERE event_type = $1`, eventType).Scan(&n))
	return n
}

func stay(t *testing.T, d command.Deps, id string) json.RawMessage {
	t.Helper()
	raw, err := d.Store.Stay(context.Background(), id)
	ok(t, err)
	return raw
}

// One seeded database carries the cases in order; each leaves what the next reads.
func TestBillingHandlers(t *testing.T) {
	d := setup(t)
	ctx := context.Background()

	t.Run("tax settings start today or later and publish the change", func(t *testing.T) {
		save := command.SaveTax{Deps: d}
		rates := domain.DefaultTaxRates()
		rates.EffectiveFrom, rates.ServicePct = "2026-11-01", 11
		_, err := save.Handle(ctx, ida, domain.TaxSettingsInput{Rates: rates, DirectMode: domain.ModeNet, Regencies: map[string]string{}})
		refused(t, err, "TAX_RATES_BACKDATED")
		_, err = save.Handle(ctx, dian, domain.TaxSettingsInput{Rates: rates, DirectMode: domain.ModeNet})
		refused(t, err, errs.CodeForbidden)
		rates.EffectiveFrom = "2026-12-01"
		out, err := save.Handle(ctx, ida, domain.TaxSettingsInput{Rates: rates, DirectMode: domain.ModeNet, Regencies: map[string]string{"loc-ubud": "Gianyar"}})
		ok(t, err)
		if len(out.Rates) != 2 || out.Rates[1].ServicePct != 11 || out.Regencies["loc-ubud"] != "Gianyar" {
			t.Fatalf("settings %+v", out)
		}
		if events(t, d, billing.EventTaxSettingsChanged) != 1 {
			t.Fatal("tax_settings.changed not published")
		}
	})

	t.Run("transaction codes keep ROOM and the payment codes", func(t *testing.T) {
		codes := command.SaveCode{Deps: d}
		_, err := codes.SetActive(ctx, ida, "tc-room", false)
		refused(t, err, "CODE_IN_USE")
		_, err = codes.Update(ctx, ida, "tc-cash", domain.TransactionCodeInput{Code: "TUNAI", Name: "Cash", Kind: "payment", Department: "payment", Active: true})
		refused(t, err, "CODE_IN_USE")
		account := "gl-4270"
		_, err = codes.Create(ctx, ida, domain.TransactionCodeInput{Code: "FNB", Name: "Food again", Kind: "charge", Department: "fnb", AccountID: &account, Active: true})
		refused(t, err, errs.CodeValidation)
		c, err := codes.Create(ctx, ida, domain.TransactionCodeInput{Code: "bike", Name: "Bicycle hire", Kind: "charge", Department: "extras", AccountID: &account, Active: true})
		ok(t, err)
		if c.Code != "BIKE" || c.ID == "" {
			t.Fatalf("code %+v", c)
		}
		off, err := codes.SetActive(ctx, ida, c.ID, false)
		ok(t, err)
		if off.Active {
			t.Fatal("still active")
		}
	})

	t.Run("charges go on a stay in house, on an active charge code", func(t *testing.T) {
		charge := command.PostCharge{Deps: d}
		_, err := charge.Handle(ctx, dian, "bk-1309", domain.ChargeInput{Code: "MINI", Description: "Water", Amount: 20000})
		refused(t, err, "BOOKING_INVALID_STATE")
		_, err = charge.Handle(ctx, dian, "bk-1296", domain.ChargeInput{Code: "ROOM", Description: "Night", Amount: 20000})
		refused(t, err, errs.CodeValidation)
		_, err = charge.Handle(ctx, wayan, "bk-1296", domain.ChargeInput{Code: "MINI", Description: "Water", Amount: 20000})
		refused(t, err, errs.CodeForbidden)
		p, err := charge.Handle(ctx, dian, "bk-1296", domain.ChargeInput{Code: "LDRY", Description: "Laundry bag", Amount: 220000})
		ok(t, err)
		if p.Amount != 200000 || *p.Service != 0 || *p.PB1 != 20000 {
			t.Fatalf("laundry carries PB1 only: %+v", p)
		}
	})

	t.Run("a plain check-out waits for the folio and settle takes it", func(t *testing.T) {
		desk := command.Desk{Deps: d}
		refused(t, desk.CheckOutHold(ctx, stay(t, d, "bk-1296")), "FOLIO_UNSETTLED")
		owed, err := desk.Owed(ctx, stay(t, d, "bk-1309"))
		ok(t, err)
		if owed != 5958000-1790000 { // 6,620,000 list less its 10% discount, less the deposit paid
			t.Fatalf("owed %d", owed)
		}
		policy, err := desk.Policy(ctx)
		ok(t, err)
		if policy.DepositPct != 30 || policy.ServicePct != 10 || policy.DirectMode != domain.ModeNet {
			t.Fatalf("policy %+v", policy)
		}
		input, _ := json.Marshal(map[string]any{"details": map[string]any{"roomInspected": true}, "method": "bank_transfer", "reference": "", "attachments": []any{}})
		_, err = desk.Settle(ctx, dian, stay(t, d, "bk-1296"), input)
		refused(t, err, errs.CodeValidation)
		input, _ = json.Marshal(map[string]any{"details": map[string]any{"roomInspected": true}, "method": "bank_transfer", "reference": "TRF-9", "attachments": []any{}})
		link, err := desk.Settle(ctx, dian, stay(t, d, "bk-1296"), input)
		ok(t, err)
		if string(link) != "null" {
			t.Fatalf("a desk method takes the money at once: %s", link)
		}
		_, err = desk.PayBalance(ctx, stay(t, d, "bk-1296"), "qris")
		refused(t, err, "PAYMENT_OVERPAID")
	})

	t.Run("a desk payment and a link refuse what the stay does not owe", func(t *testing.T) {
		record := command.RecordPayment{Deps: d}
		in := command.PaymentInput{PaymentInput: domain.PaymentInput{BookingID: "bk-1309", Kind: "balance", Method: "cash", Amount: 99_000_000}}
		_, err := record.Handle(ctx, dian, in)
		refused(t, err, errs.CodeValidation)
		in.Amount, in.Method = 500000, "qris"
		_, err = record.Handle(ctx, dian, in)
		refused(t, err, errs.CodeValidation)
		in.Method = "cash"
		p, err := record.Handle(ctx, wayan, command.PaymentInput{PaymentInput: domain.PaymentInput{BookingID: "bk-1302", Kind: "balance", Method: "cash", Amount: 1}})
		refused(t, err, errs.CodeValidation)
		p, err = record.Handle(ctx, dian, in)
		ok(t, err)
		if p.Number == "" || p.Status != "paid" || p.ShiftID != "" {
			t.Fatalf("payment %+v", p)
		}
		_, err = command.CancelLink{Deps: d}.Handle(ctx, dian, "demo-expired")
		refused(t, err, "PAYMENT_INVALID_STATE")
		l, err := command.CancelLink{Deps: d}.Handle(ctx, dian, "demo-card")
		ok(t, err)
		if l.Status != "cancelled" {
			t.Fatalf("link %+v", l)
		}
	})

	t.Run("cash the desk takes on a stay of the shift's location carries the open shift", func(t *testing.T) {
		p, err := command.RecordPayment{Deps: d}.Handle(ctx, wayan, command.PaymentInput{PaymentInput: domain.PaymentInput{BookingID: "bk-1322", Kind: "balance", Method: "cash", Amount: 100000}})
		ok(t, err)
		if p.ShiftID != "cs-8" {
			t.Fatalf("shift %q", p.ShiftID)
		}
	})

	t.Run("shifts: one per cashbox, the roster or a manager, counted close", func(t *testing.T) {
		cashier := command.Cashier{Deps: d}
		count := domain.CountFor(1_000_000)
		_, err := cashier.Open(ctx, kadek, domain.OpenShiftInput{AccountID: "cb-canggu", Count: count})
		refused(t, err, "SHIFT_ALREADY_OPEN")
		_, err = cashier.Open(ctx, sari, domain.OpenShiftInput{AccountID: "cb-ubud", Count: count})
		refused(t, err, "SHIFT_NOT_ROSTERED")
		_, err = cashier.Open(ctx, kadek, domain.OpenShiftInput{AccountID: "bank-bca", Count: count})
		refused(t, err, errs.CodeValidation)
		s, err := cashier.Open(ctx, kadek, domain.OpenShiftInput{AccountID: "cb-ubud", Count: count})
		ok(t, err)
		if s.Float != 1_000_000 || s.Status != domain.ShiftOpen {
			t.Fatalf("shift %+v", s)
		}
		_, err = cashier.Close(ctx, sari, s.ID, domain.CloseShiftInput{Count: count})
		refused(t, err, "SHIFT_NOT_YOURS")
		_, err = cashier.Close(ctx, kadek, s.ID, domain.CloseShiftInput{Count: domain.CountFor(900_000)})
		refused(t, err, "SHIFT_REASON_REQUIRED")
		closed, err := cashier.Close(ctx, kadek, s.ID, domain.CloseShiftInput{Count: domain.CountFor(900_000), Reason: "Change given twice"})
		ok(t, err)
		if closed.Status != domain.ShiftAwaiting || *closed.Difference != -100_000 {
			t.Fatalf("closed %+v", closed)
		}
		_, err = cashier.SignOff(ctx, kadek, s.ID, "")
		refused(t, err, "SHIFT_SELF_SIGNOFF")
		_, err = cashier.SignOff(ctx, ida, s.ID, "Checked the slips")
		ok(t, err)
		dropped, err := cashier.Drop(ctx, kadek, s.ID, domain.DropInput{ToAccountID: "bank-bca", Amount: 500_000})
		ok(t, err)
		if dropped.Dropped != 500_000 {
			t.Fatalf("drop %+v", dropped)
		}
		_, err = cashier.Drop(ctx, kadek, s.ID, domain.DropInput{ToAccountID: "bank-bca", Amount: 1})
		refused(t, err, "SHIFT_ALREADY_DROPPED")
		next, err := cashier.Open(ctx, kadek, domain.OpenShiftInput{AccountID: "cb-ubud", HandOverFrom: &s.ID})
		ok(t, err)
		if next.Float != 400_000 || next.HandOverID == nil {
			t.Fatalf("hand-over %+v", next)
		}
		if events(t, d, billing.EventShiftClosed) != 1 || events(t, d, billing.EventShiftDropped) != 1 {
			t.Fatal("shift facts not published")
		}
	})

	t.Run("city ledger: credit limit, transfers, invoice with commission, payments and write-offs", func(t *testing.T) {
		save := command.SaveAccount{Deps: d}
		input := domain.AccountInput{Name: "Tiny Tours", Kind: "travel_agent", Contact: "Ketut", BillingEmail: "ap@tiny.id", CreditLimit: 1_000_000, TermsDays: 14,
			CommissionPct: 10, Active: true}
		_, err := save.Handle(ctx, dian, "", input)
		refused(t, err, errs.CodeForbidden)
		bad := input
		bad.Kind, bad.CommissionPct = "company", 5
		_, err = save.Handle(ctx, ida, "", bad)
		refused(t, err, errs.CodeValidation)
		a, err := save.Handle(ctx, ida, "", input)
		ok(t, err)
		if a.Code != "CL-005" {
			t.Fatalf("account %+v", a)
		}
		bill := command.SetBilling{Deps: d}
		who := &domain.BillingInput{AccountID: a.ID, Instruction: "room"}
		_, err = bill.Booking(ctx, dian, "bk-1321", command.BillingBody{CityLedger: who})
		refused(t, err, "CREDIT_LIMIT")
		who.OverrideReason = "Agent prepaid by wire"
		v, err := bill.Booking(ctx, kadek, "bk-1321", command.BillingBody{CityLedger: who})
		ok(t, err)
		if v.Override == nil || v.Override.By != "Kadek Ariani" {
			t.Fatalf("billing %+v", v)
		}
		_, err = bill.Booking(ctx, kadek, "bk-1294", command.BillingBody{CityLedger: &domain.BillingInput{AccountID: a.ID, Instruction: "room"}})
		refused(t, err, "CITY_LEDGER_CHANNEL")
		_, err = command.IssueInvoice{Deps: d}.Handle(ctx, ida, a.ID, "2026-11-11")
		refused(t, err, "CITY_LEDGER_NOTHING")
		_, err = command.TransferGroup{Deps: d}.Handle(ctx, dian, "bg-2", a.ID)
		refused(t, err, "GROUP_NOT_MASTER")
		inv, err := command.IssueInvoice{Deps: d}.Handle(ctx, ida, "cl-jaya", "2026-11-11")
		ok(t, err)
		if inv.Gross != 33_290_000 || len(inv.Lines) != 3 || inv.Commission == 0 || inv.Net != inv.Gross-inv.Commission || inv.Number != "CL-2026-11-001" {
			t.Fatalf("invoice %+v", inv)
		}
		_, err = command.IssueInvoice{Deps: d}.Handle(ctx, ida, "cl-jaya", "2026-11-11")
		refused(t, err, "CITY_LEDGER_NOTHING")
		_, err = command.RecordLedgerPayment{Deps: d}.Handle(ctx, ida, domain.LedgerPaymentInput{AccountID: "cl-jaya", Method: "cash", CashAccountID: "bank-bca", Amount: 1000})
		refused(t, err, errs.CodeValidation)
		p, err := command.RecordLedgerPayment{Deps: d}.Handle(ctx, ida, domain.LedgerPaymentInput{AccountID: "cl-jaya", Method: "bank_transfer", CashAccountID: "bank-bca", Amount: 1000, Reference: "TRF-1"})
		ok(t, err)
		if len(p.Allocations) != 1 || p.Allocations[0].InvoiceID != inv.ID || events(t, d, billing.EventCityLedgerPaymentRecvd) != 1 {
			t.Fatalf("payment %+v", p)
		}
		_, err = command.WriteOff{Deps: d}.Handle(ctx, ida, domain.WriteOffInput{AccountID: "cl-consulate", InvoiceID: "cli-1", Amount: 600_000, Reason: "Bank charges"})
		refused(t, err, "WRITE_OFF_LIMIT")
		w, err := command.WriteOff{Deps: d}.Handle(ctx, ida, domain.WriteOffInput{AccountID: "cl-consulate", InvoiceID: "cli-1", Amount: 250_000, Reason: "Bank charges"})
		ok(t, err)
		if w.Number != "CLW-0001" || events(t, d, billing.EventCityLedgerWrittenOff) != 1 {
			t.Fatalf("write-off %+v", w)
		}
	})

	t.Run("the night audit refuses a date other than the business date", func(t *testing.T) {
		_, err := command.RunAudit{Deps: d}.Handle(ctx, kadek, domain.AuditRunInput{Date: "2026-11-10"})
		refused(t, err, "AUDIT_ALREADY_RUN")
		_, err = command.RunAudit{Deps: d}.Handle(ctx, kadek, domain.AuditRunInput{Date: "2026-11-09"})
		refused(t, err, "AUDIT_ALREADY_RUN")
		_, err = command.RunAudit{Deps: d}.Handle(ctx, dian, domain.AuditRunInput{Date: "2026-11-12"})
		refused(t, err, "AUDIT_DATE")
	})

	t.Run("a delivered order bills with tax, services sees its money and the guest pays by QRIS", func(t *testing.T) {
		orders := billingpg.Orders{DB: d.DB}
		today := "2026-11-11"
		minute := 12 * 60
		order := domain.Order{ID: "so-x", Number: "SO-900", BookingID: "bk-1305", Status: "delivered", DeliveredOn: &today, DeliveredAt: &minute,
			Lines: []domain.OrderLine{{Name: "Nasi goreng", Category: "food", Price: 121000, Quantity: 1}}, Codes: []domain.CodeAmount{{Code: "FNB", Amount: 121000}}}
		ok(t, orders.PutOrder(ctx, order))
		desk := command.Desk{Deps: d}
		date, err := desk.BusinessDate(ctx)
		ok(t, err)
		if date != "2026-11-11" {
			t.Fatalf("business date %s", date)
		}
		refused(t, desk.CheckOutHold(ctx, stay(t, d, "bk-1305")), "SERVICE_UNPAID")
		raw, err := desk.PayOrders(ctx, "bk-1305", "Guest")
		ok(t, err)
		var link domain.PaymentLink
		ok(t, json.Unmarshal(raw, &link))
		if link.Amount != 121000 || link.Method != "qris" {
			t.Fatalf("link %+v", link)
		}
		again, err := desk.PayOrders(ctx, "bk-1305", "Guest")
		ok(t, err)
		if !strings.Contains(string(again), link.Token) {
			t.Fatalf("the open link comes back: %s", again)
		}
		pm, err := desk.OrderPayments(ctx, "bk-1305")
		ok(t, err)
		if pm.PayToken != link.Token || pm.Status[link.PaymentID] != "pending" {
			t.Fatalf("order payments %+v", pm)
		}
		ok(t, command.OrderVoided{Deps: d}.Handle(ctx, order, "Wrong villa", today))
		if events(t, d, billing.EventFolioLineVoided) != 1 {
			t.Fatal("folio_line.voided not published")
		}
	})
}
