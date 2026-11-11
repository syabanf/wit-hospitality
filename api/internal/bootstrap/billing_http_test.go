package bootstrap_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
)

type posting struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Code    string `json:"code"`
	Amount  int64  `json:"amount"`
	Service int64  `json:"service"`
	PB1     int64  `json:"pb1"`
	Part    string `json:"part"`
}

type payment struct {
	ID        string `json:"id"`
	Number    string `json:"number"`
	BookingID string `json:"bookingId"`
	Kind      string `json:"kind"`
	Amount    int64  `json:"amount"`
	Status    string `json:"status"`
	Batch     string `json:"batch"`
}

type paidStay struct {
	ID            string    `json:"id"`
	Status        string    `json:"status"`
	PaidAmount    int64     `json:"paidAmount"`
	PaymentStatus string    `json:"paymentStatus"`
	NightsPosted  *[]string `json:"nightsPosted"`
}

// facts reads the payloads billing appended for an event type, oldest first.
func facts[T any](t *testing.T, s server, eventType string) []T {
	t.Helper()
	rows, err := s.db.Pool.Query(context.Background(), `SELECT payload FROM platform.outbox WHERE event_type = $1 ORDER BY id`, eventType)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []T
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var v T
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

func stayOf(t *testing.T, c *client, id string) paidStay {
	t.Helper()
	for _, b := range decode[[]paidStay](t, c.do("GET", "bookings", nil)) {
		if b.ID == id {
			return b
		}
	}
	t.Fatalf("no booking %s", id)
	return paidStay{}
}

var departure = map[string]any{"depositReturned": 0, "extraCharges": 0, "roomInspected": true, "keysReturned": true, "notes": ""}

// A charge on an inclusive stay splits into its net with service and PB1, holds a plain check-out,
// and settle-check-out takes it in cash and closes the stay for reservation.
func TestFolioChargeWithTaxThenSettleAndCheckOut(t *testing.T) {
	t.Parallel()
	s := start(t)
	desk := s.client(t)
	desk.login("dian")
	r := desk.do("POST", "bookings/bk-1296/folio/charges", map[string]any{"code": "MINI", "description": "2 × Bintang", "amount": 121000})
	if r.status != http.StatusCreated {
		t.Fatalf("charge: %d %+v", r.status, r.Error)
	}
	p := decode[posting](t, r)
	if p.Amount != 100000 || p.Service != 10000 || p.PB1 != 11000 || p.Part != "charges" {
		t.Fatalf("posting %+v", p)
	}
	if list := decode[[]posting](t, desk.do("GET", "bookings/bk-1296/folio", nil)); len(list) != 1 || list[0].ID != p.ID {
		t.Fatalf("folio postings %+v", list)
	}
	posted := facts[billing.FolioLinePosted](t, s, billing.EventFolioLinePosted)
	if len(posted) != 1 || posted[0].Account != "gl-4220" || len(posted[0].TaxLines) != 2 || posted[0].TaxLines[1].Account != "gl-2330" || posted[0].VillaID != "vil-karang" {
		t.Fatalf("folio_line.posted %+v", posted)
	}
	refused(t, desk.do("POST", "bookings/bk-1296/check-out", departure), http.StatusConflict, "FOLIO_UNSETTLED")
	r = desk.do("POST", "bookings/bk-1296/settle-check-out", map[string]any{"details": departure, "method": "qris", "reference": "", "attachments": []any{}})
	refused(t, r, http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	if r.Error.Message != "Only charges are left; take them in cash or by transfer." {
		t.Fatalf("message %q", r.Error.Message)
	}
	r = desk.do("POST", "bookings/bk-1296/settle-check-out", map[string]any{"details": departure, "method": "cash", "reference": "", "attachments": []any{}})
	if r.status != http.StatusOK {
		t.Fatalf("settle: %d %+v", r.status, r.Error)
	}
	settled := decode[struct {
		Booking paidStay        `json:"booking"`
		Link    json.RawMessage `json:"link"`
	}](t, r)
	if settled.Booking.Status != "checked_out" || string(settled.Link) != "null" {
		t.Fatalf("settled %+v %s", settled.Booking, settled.Link)
	}
	out := facts[billing.StayCheckedOut](t, s, billing.EventStayCheckedOut)
	if len(out) != 1 || out[0].FolioCharges != 121000 || out[0].Method != "cash" || len(out[0].ChargePostingIDs) != 1 || len(out[0].RoomLines) != 3 {
		t.Fatalf("stay.checked_out %+v", out)
	}
}

// A rebate on a posted night of a stay paid in full owes the guest its credit back; the refund
// pays that much and no more, and past the discount limit the desk needs a manager.
func TestRebateThenRefund(t *testing.T) {
	t.Parallel()
	s := start(t)
	desk := s.client(t)
	desk.login("dian")
	refused(t, desk.do("POST", "bookings/bk-1302/folio/rebates", map[string]any{"lineId": "bk-1302-night-1", "amount": 400000, "reason": "Pool closed"}), http.StatusConflict, "ALLOWANCE_LIMIT")
	manager := s.client(t)
	manager.login("kadek")
	r := manager.do("POST", "bookings/bk-1302/folio/rebates", map[string]any{"lineId": "bk-1302-night-1", "amount": 100000, "reason": "Pool closed"})
	if r.status != http.StatusCreated {
		t.Fatalf("rebate: %d %+v", r.status, r.Error)
	}
	rebate := decode[posting](t, r)
	if rebate.Kind != "rebate" || rebate.Code != "ROOM" || rebate.Part != "room" || rebate.Service == 0 || rebate.PB1 == 0 {
		t.Fatalf("rebate %+v", rebate)
	}
	credit := rebate.Amount + rebate.Service + rebate.PB1
	finance := s.client(t)
	finance.login("ida")
	r = finance.do("POST", "payments/pay-303/refund", map[string]any{"amount": credit + 1, "reason": "Pool closed", "attachmentIds": []string{}})
	refused(t, r, http.StatusConflict, "REFUND_EXCEEDS_CREDIT")
	r = finance.do("POST", "payments/pay-303/refund", map[string]any{"amount": credit, "reason": "Pool closed", "attachmentIds": []string{}})
	if r.status != http.StatusCreated {
		t.Fatalf("refund: %d %+v", r.status, r.Error)
	}
	if back := decode[payment](t, r); back.Kind != "refund" || back.Amount != credit || back.Status != "paid" {
		t.Fatalf("refund %+v", back)
	}
	refunded := facts[billing.PaymentRefunded](t, s, billing.EventPaymentRefunded)
	if len(refunded) != 1 || refunded[0].RefundOf != "pay-303" || refunded[0].CategoryID != "cat-other" || refunded[0].Method != "bank_transfer" {
		t.Fatalf("payment.refunded %+v", refunded)
	}
	refused(t, finance.do("POST", "payments/pay-303/refund", map[string]any{"amount": 1, "reason": "Again", "attachmentIds": []string{}}), http.StatusConflict, "REFUND_EXCEEDS_CREDIT")
	if b := stayOf(t, desk, "bk-1302"); b.PaidAmount != 5550000-credit {
		t.Fatalf("reservation keeps what the stay paid: %+v", b)
	}
}

// The audit posts tonight's room on every stay in house, rolls the business date, and refuses a
// rerun and a day not started.
func TestNightAuditRunAndRerun(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	if d := decode[map[string]string](t, c.do("GET", "night-audits/business-date", nil)); d["date"] != "2026-11-11" {
		t.Fatalf("business date %+v", d)
	}
	r := c.do("POST", "night-audits", map[string]any{"date": "2026-11-11", "checks": map[string]int{"arrivals": 0}, "noShows": []string{}})
	if r.status != http.StatusCreated {
		t.Fatalf("audit: %d %+v", r.status, r.Error)
	}
	audit := decode[struct {
		Nights      int   `json:"nights"`
		RoomRevenue int64 `json:"roomRevenue"`
	}](t, r)
	if audit.Nights == 0 || audit.RoomRevenue == 0 {
		t.Fatalf("audit %+v", audit)
	}
	refused(t, c.do("POST", "night-audits", map[string]any{"date": "2026-11-11", "checks": map[string]int{}, "noShows": []string{}}), http.StatusConflict, "AUDIT_ALREADY_RUN")
	refused(t, c.do("POST", "night-audits", map[string]any{"date": "2026-11-12", "checks": map[string]int{}, "noShows": []string{}}), http.StatusConflict, "AUDIT_TOO_EARLY")
	if d := decode[map[string]string](t, c.do("GET", "night-audits/business-date", nil)); d["date"] != "2026-11-12" {
		t.Fatalf("business date after the audit %+v", d)
	}
	ran := facts[billing.NightAudited](t, s, billing.EventNightAudited)
	if len(ran) != 1 || ran[0].Nights != audit.Nights || len(ran[0].Stays) == 0 || len(ran[0].Stays[0].Lines) == 0 || ran[0].Stays[0].Lines[0].Account != "gl-4100" {
		t.Fatalf("night.audited %+v", ran)
	}
	if b := stayOf(t, c, "bk-1296"); b.NightsPosted == nil || len(*b.NightsPosted) != 5 {
		t.Fatalf("reservation keeps the posted nights: %+v", b)
	}
	staff := s.client(t)
	staff.login("wayan")
	refused(t, staff.do("POST", "night-audits", map[string]any{"date": "2026-11-12", "checks": map[string]int{}, "noShows": []string{}}), http.StatusForbidden, "FORBIDDEN")
}

// A QRIS link the guest pays on the demo gateway lands as a paid payment with its fee, and the
// booking's paid amount follows; a declined link stays unpaid and refuses a second outcome.
func TestPaymentLinkThroughTheDemoGateway(t *testing.T) {
	t.Parallel()
	s := start(t)
	desk := s.client(t)
	desk.login("dian")
	r := desk.do("POST", "payment-links", map[string]any{"bookingId": "bk-1309", "kind": "balance", "method": "qris", "amount": 1000000, "payer": "Guest"})
	if r.status != http.StatusCreated {
		t.Fatalf("link: %d %+v", r.status, r.Error)
	}
	link := decode[struct {
		Token      string `json:"token"`
		Status     string `json:"status"`
		GatewayFee int64  `json:"gatewayFee"`
		QRPayload  string `json:"qrPayload"`
	}](t, r)
	if link.Status != "pending" || link.GatewayFee != 7000 || !strings.Contains(link.QRPayload, strings.ToUpper(link.Token)) {
		t.Fatalf("link %+v", link)
	}
	guest := s.client(t)
	view := decode[struct {
		PaymentStatus string `json:"paymentStatus"`
		BookingCode   string `json:"bookingCode"`
		Total         int64  `json:"total"`
		PaidBefore    int64  `json:"paidBefore"`
	}](t, guest.do("GET", "pay/"+link.Token, nil))
	if view.PaymentStatus != "pending" || view.BookingCode != "BK-1309" || view.PaidBefore != 1790000 {
		t.Fatalf("checkout %+v", view)
	}
	r = guest.do("POST", "pay/"+link.Token+"/simulate", map[string]string{"outcome": "paid"})
	if r.status != http.StatusOK || decode[struct {
		PaymentStatus string `json:"paymentStatus"`
	}](t, r).PaymentStatus != "paid" {
		t.Fatalf("simulate: %d %+v %s", r.status, r.Error, r.Data)
	}
	recorded := facts[billing.PaymentRecorded](t, s, billing.EventPaymentRecorded)
	if len(recorded) != 1 || recorded[0].AccountKind != "gateway" || recorded[0].Fee != 7000 || recorded[0].Stay.PaidAmount != 2790000 || recorded[0].ShiftID != "" {
		t.Fatalf("payment.recorded %+v", recorded)
	}
	if b := stayOf(t, desk, "bk-1309"); b.PaidAmount != 2790000 || b.PaymentStatus != "partial" {
		t.Fatalf("booking after the gateway paid: %+v", b)
	}
	r = guest.do("POST", "pay/demo-qris/simulate", map[string]string{"outcome": "failed"})
	if r.status != http.StatusOK || decode[struct {
		PaymentStatus string `json:"paymentStatus"`
	}](t, r).PaymentStatus != "failed" {
		t.Fatalf("decline: %d %+v", r.status, r.Error)
	}
	refused(t, guest.do("POST", "pay/demo-qris/simulate", map[string]string{"outcome": "paid"}), http.StatusConflict, "PAYMENT_INVALID_STATE")
}

// A transfer moves the open charges of a stay to a company account with their tax as billed.
func TestCityLedgerTransfer(t *testing.T) {
	t.Parallel()
	s := start(t)
	desk := s.client(t)
	desk.login("dian")
	if r := desk.do("POST", "bookings/bk-1296/folio/charges", map[string]any{"code": "SPA", "description": "Massage for two", "amount": 1210000}); r.status != http.StatusCreated {
		t.Fatalf("charge: %d %+v", r.status, r.Error)
	}
	refused(t, desk.do("POST", "bookings/bk-1296/folio/city-ledger", map[string]any{"accountId": "cl-nusa", "instruction": "room"}), http.StatusConflict, "CITY_LEDGER_NOTHING")
	r := desk.do("POST", "bookings/bk-1296/folio/city-ledger", map[string]any{"accountId": "cl-nusa", "instruction": "all"})
	if r.status != http.StatusCreated {
		t.Fatalf("transfer: %d %+v", r.status, r.Error)
	}
	moved := decode[[]struct {
		Kind       string `json:"kind"`
		Code       string `json:"code"`
		Amount     int64  `json:"amount"`
		CityLedger struct {
			AccountID string `json:"accountId"`
			Service   int64  `json:"service"`
			PB1       int64  `json:"pb1"`
		} `json:"cityLedger"`
	}](t, r)
	if len(moved) != 1 || moved[0].Kind != "transfer" || moved[0].Code != "CL" || moved[0].Amount != 1210000 || moved[0].CityLedger.Service != 100000 || moved[0].CityLedger.PB1 != 110000 {
		t.Fatalf("transfer %+v", moved)
	}
	finance := s.client(t)
	finance.login("ida")
	transfers := decode[[]json.RawMessage](t, finance.do("GET", "city-ledger/transfers", nil))
	facts := facts[billing.CityLedgerTransferred](t, s, billing.EventCityLedgerTransferred)
	if len(facts) != 1 || facts[0].AccountCode != "CL-001" || facts[0].Total != 1210000 || len(transfers) == 0 {
		t.Fatalf("city_ledger.transferred %+v, %d transfers", facts, len(transfers))
	}
	refused(t, desk.do("GET", "city-ledger/transfers", nil), http.StatusForbidden, "FORBIDDEN")
}

// Reservation's group payment, which answered NOT_AVAILABLE before billing, takes one payment over
// the stays in order.
func TestGroupPaymentThroughBilling(t *testing.T) {
	t.Parallel()
	s := start(t)
	desk := s.client(t)
	desk.login("dian")
	r := desk.do("POST", "booking-groups/bg-2/payments", map[string]any{"kind": "balance", "method": "bank_transfer", "amount": 1000000, "reference": "TRF-77", "note": "", "attachments": []any{}})
	if r.status != http.StatusOK && r.status != http.StatusCreated {
		t.Fatalf("group payment: %d %+v", r.status, r.Error)
	}
	paid := decode[struct {
		Payments []payment        `json:"payments"`
		Link     *json.RawMessage `json:"link"`
	}](t, r)
	if len(paid.Payments) != 1 || paid.Payments[0].BookingID != "bk-2104" || paid.Payments[0].Batch == "" {
		t.Fatalf("group payment %+v", paid)
	}
	if b := stayOf(t, desk, "bk-2104"); b.PaidAmount != 3620000 {
		t.Fatalf("the share lands on the stay: %+v", b)
	}
}
