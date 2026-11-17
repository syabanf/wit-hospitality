package domain

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Front office controls: card holds as the security deposit, the desk's log book and the night
// audit's block on open room discrepancies. Contract: docs/contracts/front-office-controls-contract.md.

// BookingStatusLabel is BOOKING_STATUS_LABEL.
var BookingStatusLabel = map[string]string{
	"draft": "Draft", "confirmed": "Confirmed", "checked_in": "Checked in", "checked_out": "Checked out", "cancelled": "Cancelled", "no_show": "No show",
}

// Card holds.

// BrandLabel is CARD_BRAND_LABEL.
var BrandLabel = map[string]string{"visa": "Visa", "mastercard": "Mastercard", "amex": "American Express", "jcb": "JCB", "unionpay": "UnionPay"}

// Hold states.
const (
	HoldActive   = "active"
	HoldCaptured = "captured"
	HoldReleased = "released"
)

// PreAuth is a card pre-authorization held as a stay's security deposit. Only the brand and the
// last four digits of the card are kept.
type PreAuth struct {
	ID           string  `json:"id"`
	Number       string  `json:"number"`
	BookingID    string  `json:"bookingId"`
	Amount       int64   `json:"amount"`
	Brand        string  `json:"brand"`
	Last4        string  `json:"last4"`
	ApprovalCode string  `json:"approvalCode"`
	ExpiresOn    string  `json:"expiresOn"`
	Status       string  `json:"status"`
	TakenBy      string  `json:"takenBy"`
	TakenAt      string  `json:"takenAt"`
	Captured     int64   `json:"captured"`
	PaymentID    *string `json:"paymentId"`
	ClosedBy     *string `json:"closedBy"`
	ClosedAt     *string `json:"closedAt"`
}

// PreAuthInput is the body of POST /pre-auths.
type PreAuthInput struct {
	BookingID    string  `json:"bookingId"`
	Amount       float64 `json:"amount"`
	Brand        string  `json:"brand"`
	Last4        string  `json:"last4"`
	ApprovalCode string  `json:"approvalCode"`
	ExpiresOn    string  `json:"expiresOn"`
}

var (
	lastFour     = regexp.MustCompile(`^\d{4}$`)
	approvalCode = regexp.MustCompile(`^[A-Za-z0-9]{4,12}$`)
)

// MaxHoldDays is how long a card hold may stand.
const MaxHoldDays = 30

// ValidatePreAuth is validatePreAuth.
func ValidatePreAuth(in PreAuthInput, today string) error {
	var f errs.Fields
	if !whole(in.Amount) || in.Amount <= 0 {
		f.Add("amount", "Enter the hold in whole rupiah.")
	}
	if BrandLabel[in.Brand] == "" {
		f.Add("brand", "Pick the card brand.")
	}
	if !lastFour.MatchString(in.Last4) {
		f.Add("last4", "Enter the last four digits of the card.")
	}
	if code := strings.TrimSpace(in.ApprovalCode); code != "" && !approvalCode.MatchString(code) {
		f.Add("approvalCode", "An approval code is 4 to 12 letters or digits.")
	}
	switch {
	case !isoDate.MatchString(in.ExpiresOn) || in.ExpiresOn < today:
		f.Add("expiresOn", "The hold must stand until today at least.")
	case in.ExpiresOn > AddDays(today, MaxHoldDays):
		f.Add("expiresOn", "A card hold stands at most 30 days.")
	}
	return f.Err()
}

// GatewayApprovalCode is the code the demo gateway gives a hold taken without one.
func GatewayApprovalCode(n int64) string { return fmt.Sprintf("A%05d", (n*7919)%100000) }

// HoldProblem refuses a hold on a stay that is not arriving or in house, or that holds one already.
func HoldProblem(b Booking, holds []PreAuth) error {
	if b.Status != "confirmed" && b.Status != CheckedIn {
		return errs.Newf("PREAUTH_STAY", "%s is %s; a card hold is for a stay arriving or in house.", b.Code, strings.ToLower(BookingStatusLabel[b.Status]))
	}
	for _, h := range holds {
		if h.BookingID == b.ID && h.Status == HoldActive {
			return errs.Newf("PREAUTH_ACTIVE", "%s already holds %s; capture or release it first.", b.Code, h.Number)
		}
	}
	return nil
}

// Expired is preAuthExpired: an active hold past its last day.
func (h PreAuth) Expired(today string) bool { return h.Status == HoldActive && h.ExpiresOn < today }

// ClosedProblem refuses to capture or release a hold that is no longer active.
func (h PreAuth) ClosedProblem() error {
	if h.Status != HoldActive {
		return errs.Newf("PREAUTH_CLOSED", "%s is %s.", h.Number, h.Status)
	}
	return nil
}

// CaptureProblem is the rule on a capture: closed, expired, then the amount against the hold and
// the room balance.
func (h PreAuth) CaptureProblem(amount float64, roomDue int64, today string) error {
	if err := h.ClosedProblem(); err != nil {
		return err
	}
	if h.Expired(today) {
		return errs.Newf("PREAUTH_EXPIRED", "The hold on %s lapsed on %s; take the money another way.", h.Number, h.ExpiresOn)
	}
	switch {
	case !whole(amount) || amount <= 0:
		return errs.Invalid("amount", "Enter the amount to capture in whole rupiah.")
	case int64(amount) > h.Amount:
		return errs.Invalid("amount", fmt.Sprintf("Only %s is held.", Rupiah(h.Amount)))
	case int64(amount) > roomDue:
		return errs.Invalid("amount", fmt.Sprintf("The room balance is %s; capture at most that.", Rupiah(roomDue)))
	}
	return nil
}

// Log book.

// Log categories and shifts.
var (
	LogCategoryLabel = map[string]string{"handover": "Handover", "guest": "Guest", "maintenance": "Maintenance", "cash": "Cash", "security": "Security", "other": "Other"}
	LogShiftLabel    = map[string]string{"morning": "Morning", "afternoon": "Afternoon", "night": "Night"}
)

// LogLink points an entry at a booking, a room or a guest.
type LogLink struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Label string `json:"label"`
}

// LogEntry is one note in the front office log book.
type LogEntry struct {
	ID             string   `json:"id"`
	At             string   `json:"at"`
	Date           string   `json:"date"`
	Shift          string   `json:"shift"`
	Author         string   `json:"author"`
	AuthorID       string   `json:"authorId"`
	Category       string   `json:"category"`
	Text           string   `json:"text"`
	VillaID        *string  `json:"villaId"`
	Link           *LogLink `json:"link"`
	FollowUp       bool     `json:"followUp"`
	AcknowledgedBy *string  `json:"acknowledgedBy"`
	AcknowledgedAt *string  `json:"acknowledgedAt"`
	DoneBy         *string  `json:"doneBy"`
	DoneAt         *string  `json:"doneAt"`
	DoneNote       string   `json:"doneNote"`
	ShiftID        *string  `json:"shiftId"`
}

// LogInput is the body of POST /log-book.
type LogInput struct {
	Category string   `json:"category"`
	Text     string   `json:"text"`
	VillaID  *string  `json:"villaId"`
	Link     *LogLink `json:"link"`
	FollowUp bool     `json:"followUp"`
}

// MaxLogText is the longest entry.
const MaxLogText = 1000

// LogTextProblem is the message for an entry's text, "" when it is fine.
func LogTextProblem(text string) string {
	n := len([]rune(strings.TrimSpace(text)))
	switch {
	case n < 3:
		return "Write what the next shift needs to know."
	case n > MaxLogText:
		return "Keep an entry under 1000 characters."
	}
	return ""
}

// ValidateLog checks the category, the text and the link's kind; the caller checks that the
// link and the villa exist.
func ValidateLog(in LogInput) errs.Fields {
	var f errs.Fields
	if LogCategoryLabel[in.Category] == "" {
		f.Add("category", "Pick a category.")
	}
	if msg := LogTextProblem(in.Text); msg != "" {
		f.Add("text", msg)
	}
	if in.Link != nil && in.Link.Kind != "booking" && in.Link.Kind != "unit" && in.Link.Kind != "guest" {
		f.Add("link", "That booking, room or guest was not found.")
	}
	return f
}

// ShiftOf is shiftOf: the shift and the shift's day of a local stamp. 07:00 to 14:59 is morning,
// 15:00 to 22:59 afternoon, the rest night; a night stamp before 07:00 belongs to the day before.
func ShiftOf(stamp string) (shift, date string) {
	date = stamp[:10]
	hour := 0
	if len(stamp) >= 13 {
		fmt.Sscanf(stamp[11:13], "%d", &hour)
	}
	switch {
	case hour >= 7 && hour < 15:
		return "morning", date
	case hour >= 15 && hour < 23:
		return "afternoon", date
	case hour < 7:
		return "night", AddDays(date, -1)
	}
	return "night", date
}

// hourMinute is the HH:MM of a stamp.
func hourMinute(stamp string) string {
	if len(stamp) >= 16 {
		return stamp[11:16]
	}
	return stamp
}

// AcknowledgeProblem refuses an entry that asks for no follow-up, was acknowledged, or is the
// caller's own.
func (e LogEntry) AcknowledgeProblem(userID string) error {
	if !e.FollowUp {
		return errs.New("LOG_NO_FOLLOW_UP", "That entry asks for no follow-up.")
	}
	if e.AcknowledgedBy != nil {
		return errs.Newf("LOG_ACKNOWLEDGED", "%s acknowledged it at %s.", *e.AcknowledgedBy, hourMinute(deref(e.AcknowledgedAt)))
	}
	if e.AuthorID == userID {
		return errs.New("LOG_OWN_ENTRY", "The next shift acknowledges this note; you wrote it.")
	}
	return nil
}

// DoneProblem refuses an entry that asks for no follow-up or is done, or a note too long.
func (e LogEntry) DoneProblem(note string) error {
	if !e.FollowUp {
		return errs.New("LOG_NO_FOLLOW_UP", "That entry asks for no follow-up.")
	}
	if e.DoneBy != nil {
		return errs.Newf("LOG_DONE", "%s marked it done at %s.", *e.DoneBy, hourMinute(deref(e.DoneAt)))
	}
	if len([]rune(strings.TrimSpace(note))) > 300 {
		return errs.Invalid("note", "Keep the note under 300 characters.")
	}
	return nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Night audit block.

// AuditOverride is the reason a manager closes the day over open discrepancies.
type AuditOverride struct {
	By     string `json:"by"`
	Reason string `json:"reason"`
}

// DiscrepancyBlock is discrepancyBlock: nil with no open discrepancy, else the refusal or the
// override the audit keeps.
func DiscrepancyBlock(open int, override *AuditOverride, mayOverride bool, by string) (*AuditOverride, error) {
	if open == 0 {
		return nil, nil
	}
	if override == nil {
		if open == 1 {
			return nil, errs.New("AUDIT_DISCREPANCIES", "1 room discrepancy is still open; resolve it before closing the day.")
		}
		return nil, errs.Newf("AUDIT_DISCREPANCIES", "%d room discrepancies are still open; resolve them before closing the day.", open)
	}
	reason := strings.TrimSpace(override.Reason)
	if len([]rune(reason)) < 3 {
		return nil, errs.New("AUDIT_DISCREPANCIES", "Give the reason to close the day over open discrepancies.")
	}
	if !mayOverride {
		return nil, errs.New("AUDIT_DISCREPANCIES", "Only a villa manager or someone who approves bookings may close the day over open discrepancies.")
	}
	return &AuditOverride{By: by, Reason: reason}, nil
}
