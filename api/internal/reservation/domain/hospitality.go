package domain

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Setups a guest may ask for before arrival. Each becomes a service request to the villa's host,
// priced by the host, never an automatic charge.
var Setups = []string{"bbq", "floating_breakfast", "private_chef", "romantic_dinner", "airport_pickup", "baby_cot"}

// Preferences are what the guest asks for before arrival. A room stay keeps only ArrivalTime and
// Notes; times are HH:MM or empty.
type Preferences struct {
	BreakfastTime string   `json:"breakfastTime"`
	Dietary       string   `json:"dietary"`
	Setups        []string `json:"setups"`
	ArrivalTime   string   `json:"arrivalTime"`
	Notes         string   `json:"notes"`
}

// Longest free texts on the preferences.
const (
	MaxDietary = 200
	MaxNotes   = 1000
)

// ValidatePreferences checks the preferences for a stay of the unit kind: times on the clock, known
// setups, and on a room only the arrival time and notes.
func ValidatePreferences(p Preferences, kind string) error {
	var f errs.Fields
	if p.BreakfastTime != "" && !clockTimeRe.MatchString(p.BreakfastTime) {
		f.Add("breakfastTime", "Enter breakfast time as HH:MM, or leave it empty.")
	}
	if utf8.RuneCountInString(p.Dietary) > MaxDietary {
		f.Add("dietary", fmt.Sprintf("Keep dietary needs to %d characters.", MaxDietary))
	}
	for _, s := range p.Setups {
		if !slices.Contains(Setups, s) {
			f.Add("setups", "Pick setups from the list.")
			break
		}
	}
	if p.ArrivalTime != "" && !clockTimeRe.MatchString(p.ArrivalTime) {
		f.Add("arrivalTime", "Enter the arrival time as HH:MM, or leave it empty.")
	}
	if utf8.RuneCountInString(p.Notes) > MaxNotes {
		f.Add("notes", fmt.Sprintf("Keep the notes to %d characters.", MaxNotes))
	}
	if kind == KindRoom && (p.BreakfastTime != "" || strings.TrimSpace(p.Dietary) != "" || len(p.Setups) > 0) {
		f.Add("setups", "A room stay takes only the arrival time and notes.")
	}
	return f.Err()
}

// Clean trims the texts and keeps each setup once, in the list's order.
func (p Preferences) Clean() Preferences {
	out := Preferences{BreakfastTime: p.BreakfastTime, Dietary: strings.TrimSpace(p.Dietary), ArrivalTime: p.ArrivalTime,
		Notes: strings.TrimSpace(p.Notes), Setups: []string{}}
	for _, s := range Setups {
		if slices.Contains(p.Setups, s) {
			out.Setups = append(out.Setups, s)
		}
	}
	return out
}

// Service window modes: the housekeeping schedule, a window the guest picked, or do not disturb.
const (
	WindowScheduled = "scheduled"
	WindowWindow    = "window"
	WindowDND       = "dnd"
)

// ServiceWindow is when housekeeping may service a stay; From and To are HH:MM for a window and
// empty otherwise.
type ServiceWindow struct {
	Mode string `json:"mode"`
	From string `json:"from"`
	To   string `json:"to"`
}

// DefaultServiceWindow is a new stay's window: the schedule for a room, 10:00 to 12:00 for a villa.
func DefaultServiceWindow(kind string) ServiceWindow {
	if kind == KindRoom {
		return ServiceWindow{Mode: WindowScheduled}
	}
	return ServiceWindow{Mode: WindowWindow, From: "10:00", To: "12:00"}
}

// ValidateServiceWindow checks the mode and, for a window, a start before the end.
func ValidateServiceWindow(w ServiceWindow) error {
	var f errs.Fields
	switch w.Mode {
	case WindowScheduled, WindowDND:
	case WindowWindow:
		if !clockTimeRe.MatchString(w.From) {
			f.Add("from", "Enter the start as HH:MM.")
		}
		if !clockTimeRe.MatchString(w.To) {
			f.Add("to", "Enter the end as HH:MM.")
		} else if clockTimeRe.MatchString(w.From) && w.To <= w.From {
			f.Add("to", "The window ends after it starts.")
		}
	default:
		f.Add("mode", "Pick scheduled, a window, or do not disturb.")
	}
	return f.Err()
}

// Clean drops the times of a mode without a window.
func (w ServiceWindow) Clean() ServiceWindow {
	if w.Mode != WindowWindow {
		w.From, w.To = "", ""
	}
	return w
}

// FillStay gives a stay of the unit kind what a new stay starts with: no preferences, the kind's
// service window, and for a villa the unit's host. A stay that has them keeps them.
func (b *Booking) FillStay(kind string, unitHost *string) {
	if b.Preferences.Setups == nil {
		b.Preferences.Setups = []string{}
	}
	if b.ServiceWindow.Mode == "" {
		b.ServiceWindow = DefaultServiceWindow(kind)
	}
	b.TakeHost(kind, unitHost)
}

// TakeHost sets the stay's host to the unit's on a villa and clears it on a room.
func (b *Booking) TakeHost(kind string, unitHost *string) {
	b.HostID = nil
	if kind == KindVilla && unitHost != nil {
		host := *unitHost
		b.HostID = &host
	}
}

// CodeHostNotAllocated refuses a host who is not an active employee allocated to the stay's villa.
const CodeHostNotAllocated = "HOST_NOT_ALLOCATED"

// ErrHostNotAllocated is HOST_NOT_ALLOCATED; name is the employee's, or their id when unknown.
func ErrHostNotAllocated(name, villa string) error {
	return errs.Newf(CodeHostNotAllocated, "%s is not allocated to %s.", name, villa)
}

// LateCheckout is a granted late check-out: the time the guest leaves by and what the folio was
// charged for it.
type LateCheckout struct {
	Until  string `json:"until"`
	Charge int64  `json:"charge"`
	By     string `json:"by"`
	At     string `json:"at"`
}

// CodeLateCheckoutTaken refuses a late check-out the unit's next arrival needs the unit for.
const CodeLateCheckoutTaken = "LATE_CHECKOUT_TAKEN"

// DefaultCheckOutTime and DefaultCheckInTime are the house times when the villa has none.
const (
	DefaultCheckOutTime = "12:00"
	DefaultCheckInTime  = "14:00"
)

// Arrival is the next stay arriving in the unit on the departure day, with the time it is expected.
type Arrival struct {
	Code string
	Time string
}

// LateCheckoutRequest is what the late check-out rule reads.
type LateCheckoutRequest struct {
	Until        string
	CheckOutTime string
	Kind         string
	Operation    string
	Fee          int64
	// Arrival is the unit's arrival that day, nil when none.
	Arrival *Arrival
}

// LateCheckoutCharge is what the late check-out costs, or why it cannot be given. The guest leaves
// after the house check-out time; an arrival before Until takes the unit back (LATE_CHECKOUT_TAKEN).
// A villa leaves late for free when nobody arrives that day, and otherwise pays the property's fee
// unless the property is mixed, which charges rooms only; a room always pays the fee.
func LateCheckoutCharge(r LateCheckoutRequest) (int64, error) {
	if !clockTimeRe.MatchString(r.Until) {
		return 0, errs.Invalid("until", "Enter the time the guest leaves by as HH:MM.")
	}
	house := r.CheckOutTime
	if house == "" {
		house = DefaultCheckOutTime
	}
	if r.Until <= house {
		return 0, errs.Invalid("until", fmt.Sprintf("Check-out is by %s already; pick a later time.", house))
	}
	if r.Arrival != nil && r.Arrival.Time < r.Until {
		return 0, errs.Newf(CodeLateCheckoutTaken, "%s arrives at %s; the unit is needed before %s.", r.Arrival.Code, r.Arrival.Time, r.Until)
	}
	switch {
	case r.Kind == KindRoom:
		return r.Fee, nil
	case r.Arrival == nil || r.Operation == OperationMixed:
		return 0, nil
	}
	return r.Fee, nil
}
