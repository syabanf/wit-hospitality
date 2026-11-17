package domain

import (
	"encoding/hex"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// The guest's page during the stay, /stay/{token}: one link per stay, open from check-in, read only
// after check-out and gone a day later. The rules mirror src/domain/stay.ts, code for code.

var stayTokenRe = regexp.MustCompile(`^st[0-9a-f]{32}$`)

// StayToken is stayTokenFrom: a token from 16 random bytes, so it cannot be guessed or walked.
func StayToken(random [16]byte) string { return "st" + hex.EncodeToString(random[:]) }

// IsStayToken reports a string shaped like a stay token.
func IsStayToken(token string) bool { return stayTokenRe.MatchString(token) }

// StayLinkGraceDays is how long after check-out the page still opens, read only.
const StayLinkGraceDays = 1

// Rate limits per stay token: writes and reads in each window, as GUEST_ACTION_LIMIT,
// GUEST_READ_LIMIT and GUEST_RATE_WINDOW_SECONDS.
const (
	GuestActionLimit       = 10
	GuestReadLimit         = 60
	GuestRateWindowSeconds = 60
)

// Stay link states.
const (
	StayLinkOpen     = "open"
	StayLinkReadOnly = "read_only"
	StayLinkExpired  = "expired"
)

// StayLinkState is stayLinkState: open while the guest is in house, read only once checked out,
// expired a day after the check-out date or when the stay never happened.
func StayLinkState(b Booking, today string) string {
	switch {
	case today > AddDays(b.CheckOut, StayLinkGraceDays):
		return StayLinkExpired
	case b.Status == CheckedIn:
		return StayLinkOpen
	case b.Status == CheckedOut:
		return StayLinkReadOnly
	}
	return StayLinkExpired
}

// Codes of the stay page.
const (
	CodeStayLinkExpired   = "STAY_LINK_EXPIRED"
	CodeStayReadOnly      = "STAY_READ_ONLY"
	CodeCleanAlreadyAsked = "CLEAN_ALREADY_ASKED"
)

// ErrStayLinkExpired is STAY_LINK_EXPIRED.
func ErrStayLinkExpired(code string) error {
	return errs.Newf(CodeStayLinkExpired, "This stay page closed after %s ended.", code)
}

// ErrStayReadOnly is STAY_READ_ONLY.
func ErrStayReadOnly() error {
	return errs.New(CodeStayReadOnly, "Your stay has ended, so this page is read only now.")
}

// ErrCleanAlreadyAsked is CLEAN_ALREADY_ASKED.
func ErrCleanAlreadyAsked() error {
	return errs.New(CodeCleanAlreadyAsked, "Cleaning is already asked for today.")
}

// CheckLinkable refuses a stay link for a stay that is not in house.
func CheckLinkable(b Booking) error {
	if b.Status != CheckedIn {
		return ErrInvalidState(fmt.Sprintf("%s is not in house; the stay page opens at check-in.", b.Code))
	}
	return nil
}

// Guest action kinds.
const (
	GuestClean        = "clean"
	GuestWindow       = "service_window"
	GuestOrder        = "order"
	GuestRequest      = "request"
	GuestLateCheckout = "late_checkout"
	GuestPreferences  = "preferences"
	GuestComplaint    = "complaint"
	GuestWakeUp       = "wake_up"
	GuestCard         = "card"
)

// GuestAction is one thing the guest did on the stay page, kept on the stay for the team to read.
type GuestAction struct {
	Kind    string `json:"kind"`
	At      string `json:"at"`
	Summary string `json:"summary"`
}

// GuestActionsKept is how many actions the stay keeps; older ones stay on the audit trail.
const GuestActionsKept = 50

// AddGuestAction is withGuestAction.
func (b *Booking) AddGuestAction(a GuestAction) {
	b.GuestActions = append(b.GuestActions, a)
	if n := len(b.GuestActions); n > GuestActionsKept {
		b.GuestActions = b.GuestActions[n-GuestActionsKept:]
	}
}

// CleanAskedAt is cleanAskedAt: when the guest asked for a clean on date, or "".
func (b Booking) CleanAskedAt(date string) string {
	for i := len(b.GuestActions) - 1; i >= 0; i-- {
		if a := b.GuestActions[i]; a.Kind == GuestClean && strings.HasPrefix(a.At, date) {
			return a.At
		}
	}
	return ""
}

// MaxGuestNote is the longest note a guest sends with a clean or a request.
const MaxGuestNote = 500

// GuestNoteProblem is guestNoteProblem.
func GuestNoteProblem(note string) string {
	if utf8.RuneCountInString(strings.TrimSpace(note)) > MaxGuestNote {
		return fmt.Sprintf("Keep the note to %d characters.", MaxGuestNote)
	}
	return ""
}

// ValidateGuestNote refuses a note past MaxGuestNote.
func ValidateGuestNote(note string) error {
	if problem := GuestNoteProblem(note); problem != "" {
		return errs.Invalid("note", problem)
	}
	return nil
}

// ValidateGuestWindow is guestWindowProblem on top of the window's own rules: a villa guest picks a
// window or do not disturb, a room follows the housekeeping schedule or do not disturb.
func ValidateGuestWindow(kind string, w ServiceWindow) error {
	if err := ValidateServiceWindow(w); err != nil {
		return err
	}
	switch {
	case kind == KindVilla && w.Mode == WindowScheduled:
		return errs.Invalid("mode", "Pick a time window or Do not disturb.")
	case kind == KindRoom && w.Mode == WindowWindow:
		return errs.Invalid("mode", "Pick the housekeeping schedule or Do not disturb.")
	}
	return nil
}

// GuestWindowSummary words a window change on the stay's guest actions.
func GuestWindowSummary(w ServiceWindow) string {
	switch w.Mode {
	case WindowDND:
		return "Asked not to be disturbed"
	case WindowWindow:
		return fmt.Sprintf("Set the service window to %s to %s", w.From, w.To)
	}
	return "Went back to the housekeeping schedule"
}

// GuestRequestKinds is GUEST_REQUEST_KINDS: what a guest may ask for from the page; cleaning has
// its own button.
var GuestRequestKinds = []string{"towels", "laundry", "minibar", "maintenance", "transfer", "other"}

// GuestRequestLabel is GUEST_REQUEST_LABEL.
var GuestRequestLabel = map[string]string{
	"towels": "Extra towels and amenities", "laundry": "Laundry pickup", "minibar": "Minibar refill",
	"maintenance": "Something needs fixing", "transfer": "Airport transfer", "other": "Something else",
}

// GuestRequestInput is the body of POST /stay/{token}/requests.
type GuestRequestInput struct {
	Kind string `json:"kind"`
	Note string `json:"note"`
}

// ValidateGuestRequest is validateGuestRequest.
func ValidateGuestRequest(in GuestRequestInput) error {
	var f errs.Fields
	if !slices.Contains(GuestRequestKinds, in.Kind) {
		f.Add("kind", "Pick what you need.")
	}
	if problem := GuestNoteProblem(in.Note); problem != "" {
		f.Add("note", problem)
	} else if in.Kind == "other" && utf8.RuneCountInString(strings.TrimSpace(in.Note)) < 3 {
		f.Add("note", "Tell us what you need.")
	}
	return f.Err()
}

// FirstName is firstName: the first word of a name.
func FirstName(name string) string {
	if parts := strings.Fields(name); len(parts) > 0 {
		return parts[0]
	}
	return ""
}
