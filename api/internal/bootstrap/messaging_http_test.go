package bootstrap_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	messagingdomain "github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
)

type messageRow struct {
	ID          string  `json:"id"`
	BookingID   string  `json:"bookingId"`
	TemplateKey *string `json:"templateKey"`
	Status      string  `json:"status"`
	Body        string  `json:"body"`
	SentBy      string  `json:"sentBy"`
}

func TestAMessageSendsAndAQueuedOneCannotGoAgain(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("dian")
	r := c.do("POST", "messages", map[string]any{"bookingId": "bk-1294", "channel": "whatsapp", "templateKey": nil, "language": "en", "body": "Hi {guest}, the pool is open again."})
	if r.status != http.StatusCreated {
		t.Fatalf("send: %d %+v", r.status, r.Error)
	}
	m := decode[messageRow](t, r)
	if m.Status != "queued" || m.SentBy != "Dian Permata" {
		t.Fatalf("sent %+v", m)
	}
	refused(t, c.do("POST", "messages/"+m.ID+"/resend", nil), http.StatusConflict, "MESSAGE_NOT_FAILED")
	finance := s.client(t)
	finance.login("ida")
	refused(t, finance.do("POST", "messages", map[string]any{"bookingId": "bk-1294", "channel": "email", "templateKey": nil, "language": "en", "body": "Hello there"}), http.StatusForbidden, "FORBIDDEN")
	if r := c.do("GET", "invoice/iv-forged", nil); r.status != http.StatusNotFound {
		t.Fatalf("forged invoice: %d", r.status)
	}
}

// The thank-you message's e-invoice link opens without a session and billing renders the stay.
func TestTheEInvoiceLinkRendersTheStayFromBilling(t *testing.T) {
	t.Parallel()
	s := start(t)
	desk := s.client(t)
	desk.login("kadek")
	var bookingID string
	for _, m := range decode[[]messageRow](t, desk.do("GET", "messages", nil)) {
		if m.TemplateKey != nil && *m.TemplateKey == "post_stay" {
			bookingID = m.BookingID
		}
	}
	if bookingID == "" {
		t.Fatal("no thank-you message in the seed")
	}
	r := s.client(t).do("GET", "invoice/"+messagingdomain.InvoiceToken(bookingID), nil)
	if r.status != http.StatusOK {
		t.Fatalf("invoice: %d %+v", r.status, r.Error)
	}
	inv := decode[struct {
		Booking struct {
			ID          string `json:"id"`
			Code        string `json:"code"`
			GuestName   string `json:"guestName"`
			SourceLabel string `json:"sourceLabel"`
			Total       int64  `json:"total"`
			Place       struct {
				Villa    struct{ Name string } `json:"villa"`
				Location struct{ Name string } `json:"location"`
			} `json:"place"`
			Taxes struct {
				Mode string `json:"mode"`
			} `json:"taxes"`
		} `json:"booking"`
		Lines []struct {
			Label  string `json:"label"`
			Amount int64  `json:"amount"`
		} `json:"lines"`
		Total       int64             `json:"total"`
		Expected    int64             `json:"expected"`
		Paid        int64             `json:"paid"`
		Outstanding int64             `json:"outstanding"`
		DueOn       string            `json:"dueOn"`
		Payments    []json.RawMessage `json:"payments"`
		Links       []json.RawMessage `json:"links"`
		Tax         *struct {
			Total int64 `json:"total"`
		} `json:"tax"`
	}](t, r)
	b := inv.Booking
	if b.ID != bookingID || b.Code == "" || b.GuestName == "" || b.SourceLabel == "" || b.Place.Villa.Name == "" || b.Place.Location.Name == "" || b.Taxes.Mode == "" {
		t.Fatalf("booking %+v", b)
	}
	if len(inv.Lines) == 0 || inv.Total != b.Total || inv.Expected <= 0 || inv.Outstanding != max(0, inv.Expected-inv.Paid) || inv.DueOn == "" ||
		inv.Tax == nil || inv.Tax.Total != inv.Total || inv.Payments == nil || inv.Links == nil {
		t.Fatalf("invoice %+v", inv)
	}
	// A split messaging service asks billing over /internal/v1/billing/invoice.
	raw, err := billing.HTTPClient{BaseURL: strings.TrimSuffix(s.url, "/api/v1/"), Token: "internal"}.Invoice(context.Background(), bookingID)
	var split struct {
		Booking struct {
			Code string `json:"code"`
		} `json:"booking"`
		Expected int64 `json:"expected"`
	}
	if err != nil || json.Unmarshal(raw, &split) != nil || split.Booking.Code != b.Code || split.Expected != inv.Expected {
		t.Fatalf("internal invoice: %v %s", err, raw)
	}
}

func TestConfirmingABookingFiresTheConfirmationMessage(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("dian")
	draft := stay("unit-kr-03", "", "2027-01-10", "2027-01-12")
	draft["confirm"] = false
	b := decode[bookingRow](t, c.do("POST", "bookings", draft))
	for _, m := range decode[[]messageRow](t, c.do("GET", "messages", nil)) {
		if m.BookingID == b.ID {
			t.Fatalf("a draft sends nothing: %+v", m)
		}
	}
	if r := c.do("POST", "bookings/"+b.ID+"/confirm", nil); r.status != http.StatusOK {
		t.Fatalf("confirm: %d %+v", r.status, r.Error)
	}
	var sent []messageRow
	for _, m := range decode[[]messageRow](t, c.do("GET", "messages", nil)) {
		if m.BookingID == b.ID {
			sent = append(sent, m)
		}
	}
	if len(sent) != 1 || *sent[0].TemplateKey != "booking_confirmed" || sent[0].SentBy != "System" {
		t.Fatalf("the confirmation follows the reservation event: %+v", sent)
	}
}
