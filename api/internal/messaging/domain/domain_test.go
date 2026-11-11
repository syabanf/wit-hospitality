package domain_test

import (
	"reflect"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func TestRenderFillsPlaceholdersAndLeavesUnknownOnes(t *testing.T) {
	got := domain.Render("Hi {guest}, {amount} for {code} {nope}", domain.Vars{"guest": "Ana", "amount": int64(1_500_000), "code": "BK-1"})
	if got != "Hi Ana, Rp 1.500.000 for BK-1 {nope}" {
		t.Fatalf("render %q", got)
	}
	if got := domain.Render("{checkIn} to {checkOut}{link}", domain.Vars{"checkIn": "2026-10-08", "checkOut": "2026-10-10"}); got != "Oct 8 to Oct 10" {
		t.Fatalf("dates %q", got)
	}
}

func TestTimeTriggers(t *testing.T) {
	stay := domain.TriggerStay{Status: "confirmed", CheckIn: "2026-10-08", CheckOut: "2026-10-10"}
	for now, want := range map[string][]string{
		"2026-10-04T12:00:00": nil,
		"2026-10-05T09:00:00": nil,
		"2026-10-05T10:00:00": {"pre_arrival"},
	} {
		if got := domain.DueTimeTriggers(stay, now, 3); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %v", now, got)
		}
	}
	stay.Status = "checked_in"
	if got := domain.DueTimeTriggers(stay, "2026-10-09T17:59:00", 3); got != nil {
		t.Fatalf("before the evening: %v", got)
	}
	if got := domain.DueTimeTriggers(stay, "2026-10-09T18:00:00", 3); !reflect.DeepEqual(got, []string{"checkout_reminder"}) {
		t.Fatalf("reminder: %v", got)
	}
}

func TestValidationLanguageAndTokens(t *testing.T) {
	err := domain.ValidateSend(domain.SendInput{BookingID: "bk-1", Channel: "email", Language: "en", Body: " "})
	if e, _ := errs.As(err); e == nil || e.Fields[0].Field != "body" || e.Message != "Write the message." {
		t.Fatalf("empty free message: %v", err)
	}
	key := "welcome"
	if err := domain.ValidateSend(domain.SendInput{BookingID: "bk-1", Channel: "whatsapp", Language: "id", TemplateKey: &key}); err != nil {
		t.Fatalf("template send: %v", err)
	}
	s := domain.DefaultSettings()
	s.PreArrivalDays = 0
	s.Templates[0].Body["id"] = "short"
	if e, _ := errs.As(domain.ValidateSettings(s)); e == nil || len(e.Fields) != 2 || e.Fields[1].Message != "Write the Bahasa Indonesia text of Booking confirmation." {
		t.Fatalf("settings: %+v", e)
	}
	if domain.LanguageFor(" Indonesia ") != "id" || domain.LanguageFor("AU") != "en" {
		t.Fatal("language")
	}
	if domain.InvoiceToken("bk-1000") != "ivbk10000grxf1j" {
		t.Fatalf("token %s", domain.InvoiceToken("bk-1000"))
	}
}

func TestProviderTimingAndResend(t *testing.T) {
	q := "2026-10-05T10:00:00"
	for now, want := range map[string]string{"2026-10-05T10:00:00": "queued", "2026-10-05T10:00:01": "sent", "2026-10-05T10:00:05": "delivered"} {
		if got := domain.ProviderStatus("queued", q, now); got != want {
			t.Fatalf("%s: %s", now, got)
		}
	}
	m := domain.Message{Number: "MSG-0001", Status: "sent", Channel: "whatsapp"}
	if err := domain.AssertResend(m); err == nil || err.(*errs.Error).Code != "MESSAGE_NOT_FAILED" || err.(*errs.Error).Message != "MSG-0001 is sent; only a failed message goes again." {
		t.Fatalf("resend: %v", err)
	}
	domain.Deliver(&m, q)
	if m.Status != "failed" || m.Error != "No WhatsApp number on the guest profile" || m.Attempts != 1 {
		t.Fatalf("no address: %+v", m)
	}
}
