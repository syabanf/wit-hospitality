// Package domain holds the guest messaging rules ported from src/domain/messaging.ts: channels,
// languages, templates in English and Bahasa Indonesia, placeholders, the status and time
// triggers, the signed guest-site links, and the simulated provider's timing. Errors carry the
// TypeScript codes and wording.
package domain

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Channels.
const (
	WhatsApp = "whatsapp"
	Email    = "email"
)

// ChannelLabel is CHANNEL_LABEL.
var ChannelLabel = map[string]string{WhatsApp: "WhatsApp", Email: "Email"}

// Languages and their labels.
var (
	Languages     = []string{"en", "id"}
	LanguageLabel = map[string]string{"en": "English", "id": "Bahasa Indonesia"}
)

// Message statuses.
const (
	Queued    = "queued"
	Sent      = "sent"
	Delivered = "delivered"
	Read      = "read"
	Failed    = "failed"
)

// SystemSender names the sender of a trigger.
const SystemSender = "System"

// Template is MessageTemplate.
type Template struct {
	Key     string            `json:"key"`
	Name    string            `json:"name"`
	Channel string            `json:"channel"`
	Enabled bool              `json:"enabled"`
	Subject map[string]string `json:"subject"`
	Body    map[string]string `json:"body"`
}

// Settings is MessagingSettings.
type Settings struct {
	PreArrivalDays int               `json:"preArrivalDays"`
	Wifi           map[string]string `json:"wifi"`
	Templates      []Template        `json:"templates"`
}

// Template finds a template by key.
func (s Settings) Template(key string) (Template, bool) {
	for _, t := range s.Templates {
		if t.Key == key {
			return t, true
		}
	}
	return Template{}, false
}

// CityLedgerRef marks a city ledger invoice sent to a company or agent.
type CityLedgerRef struct {
	AccountID string `json:"accountId"`
	InvoiceID string `json:"invoiceId"`
}

// Message is Message.
type Message struct {
	ID          string         `json:"id"`
	Number      string         `json:"number"`
	BookingID   string         `json:"bookingId"`
	GuestID     string         `json:"guestId"`
	To          string         `json:"to"`
	Channel     string         `json:"channel"`
	TemplateKey *string        `json:"templateKey"`
	Language    string         `json:"language"`
	Subject     string         `json:"subject"`
	Body        string         `json:"body"`
	Status      string         `json:"status"`
	SentBy      string         `json:"sentBy"`
	SentByID    *string        `json:"sentById"`
	QueuedAt    string         `json:"queuedAt"`
	SentAt      *string        `json:"sentAt"`
	DeliveredAt *string        `json:"deliveredAt"`
	ReadAt      *string        `json:"readAt"`
	FailedAt    *string        `json:"failedAt"`
	Error       string         `json:"error"`
	Attempts    int            `json:"attempts"`
	CityLedger  *CityLedgerRef `json:"cityLedger,omitempty"`
	Version     int64          `json:"-"`
}

// SendInput is SendMessageInput.
type SendInput struct {
	BookingID   string  `json:"bookingId"`
	Channel     string  `json:"channel"`
	TemplateKey *string `json:"templateKey"`
	Language    string  `json:"language"`
	Body        string  `json:"body"`
}

// ValidateSend is validateSend.
func ValidateSend(in SendInput) error {
	var f errs.Fields
	if in.BookingID == "" {
		f.Add("bookingId", "Pick the booking.")
	}
	if in.Channel != WhatsApp && in.Channel != Email {
		f.Add("channel", "Pick WhatsApp or email.")
	}
	if !slices.Contains(Languages, in.Language) {
		f.Add("language", "Pick the language.")
	}
	body := ""
	if in.TemplateKey == nil && len([]rune(strings.TrimSpace(in.Body))) < 2 {
		body = "Write the message."
	}
	if len([]rune(in.Body)) > 2000 {
		body = "Keep it under 2,000 characters."
	}
	if body != "" {
		f.Add("body", body)
	}
	return f.Err()
}

// ValidateSettings is validateMessagingSettings.
func ValidateSettings(s Settings) error {
	var f errs.Fields
	if s.PreArrivalDays < 1 || s.PreArrivalDays > 14 {
		f.Add("preArrivalDays", "1 to 14 days.")
	}
	for _, t := range s.Templates {
		for _, lang := range Languages {
			if len([]rune(strings.TrimSpace(t.Body[lang]))) < 10 {
				f.Add(t.Key+"."+lang, fmt.Sprintf("Write the %s text of %s.", LanguageLabel[lang], t.Name))
			}
		}
		if t.Channel != WhatsApp && t.Channel != Email {
			f.Add(t.Key+".channel", "Pick WhatsApp or email.")
		}
	}
	return f.Err()
}

// Vars are the values a template can name: guest, villa, unit, code, checkIn, checkOut, link,
// amount (rupiah), wifi, due. A name left out renders as an empty string.
type Vars map[string]any

// Placeholders is PLACEHOLDERS.
var Placeholders = []string{"guest", "villa", "unit", "code", "checkIn", "checkOut", "link", "amount", "wifi", "due"}

var placeholder = regexp.MustCompile(`\{(\w+)\}`)

// Render is renderTemplate: fills {guest}, {checkIn} and the rest; unknown names stay as typed so
// staff see the mistake.
func Render(text string, vars Vars) string {
	return placeholder.ReplaceAllStringFunc(text, func(whole string) string {
		name := whole[1 : len(whole)-1]
		if !slices.Contains(Placeholders, name) {
			return whole
		}
		v, ok := vars[name]
		if !ok || v == nil {
			return ""
		}
		switch name {
		case "amount":
			return "Rp " + Rupiah(toInt(v))
		case "checkIn", "checkOut", "due":
			return ShortDay(fmt.Sprint(v))
		}
		return fmt.Sprint(v)
	})
}

func toInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	return 0
}

// Rupiah formats whole rupiah the way toLocaleString('id-ID') does: dots between thousands.
func Rupiah(n int64) string {
	sign := ""
	if n < 0 {
		sign, n = "-", -n
	}
	s := strconv.FormatInt(n, 10)
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte('.')
		}
		b.WriteRune(c)
	}
	return sign + b.String()
}

// ShortDay is shortDay: "Oct 8".
func ShortDay(d string) string {
	t, err := time.Parse(time.DateOnly, d)
	if err != nil {
		return d
	}
	return t.Format("Jan 2")
}

var indonesian = regexp.MustCompile(`(?i)^(indonesia|indonesian|id)$`)

// LanguageFor is languageFor: Indonesian guests read Bahasa Indonesia, everyone else English.
func LanguageFor(nationality string) string {
	if indonesian.MatchString(strings.TrimSpace(nationality)) {
		return "id"
	}
	return "en"
}

// AddressFor is addressFor: the phone for WhatsApp, the email for email, trimmed.
func AddressFor(phone, email, channel string) string {
	if channel == WhatsApp {
		return strings.TrimSpace(phone)
	}
	return strings.TrimSpace(email)
}

// Guest-site links.
const (
	GuestSite  = "https://stay.balivillas.id"
	ReviewLink = "https://g.page/r/balivillas/review"
)

var notAlnum = regexp.MustCompile(`[^a-zA-Z0-9]`)

// tokenFor is the mock's deterministic signed token from a booking id and a purpose.
func tokenFor(purpose, prefix, bookingID string) string {
	h := uint32(2166136261)
	for _, c := range purpose + ":" + bookingID + ":bali-villas" {
		h = (h ^ uint32(c)) * 16777619
	}
	sig := strconv.FormatUint(uint64(h), 36)
	if len(sig) < 7 {
		sig = strings.Repeat("0", 7-len(sig)) + sig
	}
	return prefix + strings.ToLower(notAlnum.ReplaceAllString(bookingID, "")) + sig
}

// InvoiceToken is invoiceTokenFor.
func InvoiceToken(bookingID string) string { return tokenFor("invoice", "iv", bookingID) }

// CheckinToken is checkinTokenFor.
func CheckinToken(bookingID string) string { return tokenFor("checkin", "ci", bookingID) }

// InvoiceURL is invoiceUrl.
func InvoiceURL(bookingID string) string { return GuestSite + "/invoice/" + InvoiceToken(bookingID) }

// CheckinURL is checkinUrl.
func CheckinURL(bookingID string) string { return GuestSite + "/checkin/" + CheckinToken(bookingID) }

// PayURL is payUrl.
func PayURL(token string) string { return GuestSite + "/pay/" + token }

// Trigger hours: pre-arrival in the morning, the reminder in the evening.
const (
	PreArrivalHour = 10
	ReminderHour   = 18
)

// TriggerStay is a stay as the time triggers read it.
type TriggerStay struct {
	Status   string
	CheckIn  string
	CheckOut string
}

func addDays(d string, n int) string {
	t, err := time.Parse(time.DateOnly, d)
	if err != nil {
		return d
	}
	return t.AddDate(0, 0, n).Format(time.DateOnly)
}

// DueTimeTriggers is dueTimeTriggers: pre-arrival from `days` before arrival up to the day itself,
// the checkout reminder on the evening before departure. now is a local date-time.
func DueTimeTriggers(b TriggerStay, now string, days int) []string {
	today := now[:10]
	hour, _ := strconv.Atoi(now[11:13])
	var due []string
	from := addDays(b.CheckIn, -days)
	if b.Status == "confirmed" && (today > from || (today == from && hour >= PreArrivalHour)) && today <= b.CheckIn {
		due = append(due, "pre_arrival")
	}
	if b.Status == "checked_in" && today == addDays(b.CheckOut, -1) && hour >= ReminderHour {
		due = append(due, "checkout_reminder")
	}
	return due
}

// StatusTrigger is STATUS_TRIGGER: the template a booking status fires.
var StatusTrigger = map[string]string{"confirmed": "booking_confirmed", "checked_in": "welcome", "checked_out": "post_stay"}

const stampLayout = "2006-01-02T15:04:05"

// ProviderStatus is providerStatus: the simulated provider moves a queued message to sent after a
// second and to delivered after five.
func ProviderStatus(status, queuedAt, now string) string {
	if status != Queued && status != Sent {
		return status
	}
	q, err1 := time.Parse(stampLayout, queuedAt)
	n, err2 := time.Parse(stampLayout, now)
	if err1 != nil || err2 != nil {
		return status
	}
	age := n.Sub(q).Seconds()
	switch {
	case age >= 5:
		return Delivered
	case age >= 1:
		return Sent
	}
	return status
}

// AssertResend is canResend: only a failed message goes again.
func AssertResend(m Message) error {
	if m.Status != Failed {
		return errs.Newf("MESSAGE_NOT_FAILED", "%s is %s; only a failed message goes again.", m.Number, m.Status)
	}
	return nil
}

// Deliver is the mock's deliver: stamps the attempt and fails a message without an address the
// way a gateway would. The provider takes it from queued.
func Deliver(m *Message, now string) {
	m.QueuedAt = now
	m.Attempts++
	m.SentAt, m.DeliveredAt, m.ReadAt, m.FailedAt, m.Error = nil, nil, nil, nil, ""
	if m.To != "" {
		m.Status = Queued
		return
	}
	m.Status, m.FailedAt = Failed, &now
	m.Error = "No email address on the guest profile"
	if m.Channel == WhatsApp {
		m.Error = "No WhatsApp number on the guest profile"
	}
}

// MessageNumber is the mock's id and number for sequence n.
func MessageNumber(n int64) (id, number string) {
	return fmt.Sprintf("msg-%d", n), fmt.Sprintf("MSG-%04d", n)
}

// FirstName is the first word of a name, as the templates greet the guest.
func FirstName(name string) string {
	first, _, _ := strings.Cut(name, " ")
	return first
}
