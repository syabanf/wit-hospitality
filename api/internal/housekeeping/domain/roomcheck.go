package domain

import (
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Room checks: housekeeping records what it found in each room on its round and the check keeps
// the front office side as it stood then. Contract: docs/contracts/front-office-controls-contract.md
// section 1.

// What housekeeping found.
const (
	FoundOccupied   = "occupied"
	FoundVacant     = "vacant"
	FoundOutOfOrder = "out_of_order"
)

// Discrepancy kinds.
const (
	DiscrepancySleep   = "sleep"
	DiscrepancySkip    = "skip"
	DiscrepancyPersons = "persons"
)

// Labels of what was found, of each discrepancy kind and of each resolving action.
var (
	FoundLabel   = map[string]string{FoundOccupied: "Occupied", FoundVacant: "Vacant", FoundOutOfOrder: "Out of order"}
	KindLabel    = map[string]string{DiscrepancySleep: "Sleep", DiscrepancySkip: "Skip", DiscrepancyPersons: "Person count"}
	ResolveLabel = map[string]string{
		"checked_out": "Checked out the guest", "checked_in": "Checked in the walk-in",
		"housekeeping_error": "Housekeeping error", "guest_out": "Guest out for the night",
	}
	// ResolveActions are the actions that settle each kind.
	ResolveActions = map[string][]string{
		DiscrepancySleep:   {"checked_out", "guest_out", "housekeeping_error"},
		DiscrepancySkip:    {"checked_in", "housekeeping_error"},
		DiscrepancyPersons: {"guest_out", "housekeeping_error"},
	}
)

// Resolution is how the desk settled a discrepancy.
type Resolution struct {
	Action string `json:"action"`
	Note   string `json:"note"`
	By     string `json:"by"`
	At     string `json:"at"`
}

// RoomCheck is one room on one day of housekeeping's round.
type RoomCheck struct {
	ID           string      `json:"id"`
	UnitID       string      `json:"unitId"`
	VillaID      string      `json:"villaId"`
	Date         string      `json:"date"`
	Found        string      `json:"found"`
	Persons      *int        `json:"persons"`
	Note         string      `json:"note"`
	CheckedBy    string      `json:"checkedBy"`
	CheckedAt    string      `json:"checkedAt"`
	FrontOffice  string      `json:"frontOffice"`
	BookingID    *string     `json:"bookingId"`
	BookingCode  *string     `json:"bookingCode"`
	FrontPersons *int        `json:"frontPersons"`
	Discrepancy  *string     `json:"discrepancy"`
	Resolution   *Resolution `json:"resolution"`
}

// RoomCheckInput is the body of PUT /housekeeping/room-checks.
type RoomCheckInput struct {
	UnitID  string `json:"unitId"`
	Date    string `json:"date"`
	Found   string `json:"found"`
	Persons *int   `json:"persons"`
	Note    string `json:"note"`
}

// ResolveInput is the body of POST /housekeeping/room-checks/{id}/resolve.
type ResolveInput struct {
	Action string `json:"action"`
	Note   string `json:"note"`
}

// RoomCheckID is the one check of a room on a day.
func RoomCheckID(date, unitID string) string { return "rc-" + date + "-" + unitID }

const maxCheckNote = 300

// ValidateRoomCheck checks the fields; persons is cleared unless the room was found occupied.
func ValidateRoomCheck(in *RoomCheckInput, today string) error {
	var f errs.Fields
	switch {
	case !isoDay.MatchString(in.Date):
		f.Add("date", "Pick the day.")
	case in.Date > today:
		f.Add("date", in.Date+" has not come yet.")
	}
	if FoundLabel[in.Found] == "" {
		f.Add("found", "Pick what housekeeping found.")
	}
	if in.Found != FoundOccupied {
		in.Persons = nil
	} else if in.Persons != nil && (*in.Persons < 1 || *in.Persons > 20) {
		f.Add("persons", "Enter the guests seen as a whole number from 1, or leave it empty.")
	}
	if len([]rune(strings.TrimSpace(in.Note))) > maxCheckNote {
		f.Add("note", "Keep the note under 300 characters.")
	}
	return f.Err()
}

// FrontOfficeStay is the stay that makes a unit occupied on date: assigned to it, checked in and
// arrived on or before the date; nil when the front office has it vacant.
func FrontOfficeStay(stays []Stay, unitID, date string) *Stay {
	for i, s := range stays {
		if s.UnitAssigned && s.UnitID == unitID && s.Status == "checked_in" && s.CheckIn <= date {
			return &stays[i]
		}
	}
	return nil
}

// DiscrepancyOf is discrepancyOf: what the room check and the front office disagree on, or "".
func DiscrepancyOf(found string, persons *int, frontOccupied bool, frontPersons *int) string {
	switch {
	case frontOccupied && (found == FoundVacant || found == FoundOutOfOrder):
		return DiscrepancySleep
	case !frontOccupied && found == FoundOccupied:
		return DiscrepancySkip
	case frontOccupied && found == FoundOccupied && persons != nil && frontPersons != nil && *persons != *frontPersons:
		return DiscrepancyPersons
	}
	return ""
}

// ValidateResolve checks a resolution against the check: DISCREPANCY_NONE, DISCREPANCY_RESOLVED,
// then the fields.
func ValidateResolve(c RoomCheck, unitCode string, in ResolveInput) error {
	if c.Discrepancy == nil {
		return errs.Newf("DISCREPANCY_NONE", "%s on %s matches the front office; nothing to resolve.", unitCode, c.Date)
	}
	if c.Resolution != nil {
		return errs.Newf("DISCREPANCY_RESOLVED", "%s on %s was resolved by %s.", unitCode, c.Date, c.Resolution.By)
	}
	var f errs.Fields
	switch {
	case ResolveLabel[in.Action] == "":
		f.Add("action", "Pick how the desk settled it.")
	case !slices.Contains(ResolveActions[*c.Discrepancy], in.Action):
		f.Add("action", fmt.Sprintf("%s does not settle a %s discrepancy.", ResolveLabel[in.Action], strings.ToLower(KindLabel[*c.Discrepancy])))
	}
	note := []rune(strings.TrimSpace(in.Note))
	switch {
	case len(note) < 3:
		f.Add("note", "Say what the desk found.")
	case len(note) > maxCheckNote:
		f.Add("note", "Keep the note under 300 characters.")
	}
	return f.Err()
}

// Open reports a discrepancy nobody resolved.
func (c RoomCheck) Open() bool { return c.Discrepancy != nil && c.Resolution == nil }

// CheckSummary is the audit line of a recorded check.
func CheckSummary(c RoomCheck, unitCode string) string {
	s := fmt.Sprintf("Recorded %s on %s: %s", unitCode, c.Date, FoundLabel[c.Found])
	if c.Persons != nil {
		guests := "guests"
		if *c.Persons == 1 {
			guests = "guest"
		}
		s += fmt.Sprintf(", %d %s", *c.Persons, guests)
	}
	if c.Discrepancy != nil {
		s += fmt.Sprintf(", %s discrepancy", KindLabel[*c.Discrepancy])
	}
	return s
}
