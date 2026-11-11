package bootstrap_test

import (
	"net/http"
	"testing"
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
