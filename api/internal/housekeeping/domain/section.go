package domain

import (
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Section is a named set of rooms of one hotel or mixed property, from property's events.
type Section struct {
	ID      string   `json:"id"`
	VillaID string   `json:"villaId"`
	Name    string   `json:"name"`
	UnitIDs []string `json:"unitIds"`
}

// SectionAssignment gives a section's rooms to one attendant on a day.
type SectionAssignment struct {
	SectionID   string `json:"sectionId"`
	Date        string `json:"date"`
	AttendantID string `json:"attendantId"`
}

// SectionInput is the body of PUT /housekeeping/section-assignments; a nil attendant clears the
// day.
type SectionInput struct {
	SectionID   string  `json:"sectionId"`
	Date        string  `json:"date"`
	AttendantID *string `json:"attendantId"`
}

// ValidateSectionInput checks the day.
func ValidateSectionInput(in SectionInput) error {
	if !isoDay.MatchString(in.Date) {
		return errs.Invalid("date", "Pick the day.")
	}
	return nil
}

// SectionHandover picks the tasks that change hands when a section's day goes to an attendant
// (to) or back to unassigned (to nil): the pending tasks of the date on the section's rooms that
// another attendant or nobody holds, or, when clearing, the ones held holds. It returns their
// indexes in tasks.
func SectionHandover(tasks []RoomTask, s Section, date string, to, held *string) []int {
	var out []int
	for i, t := range tasks {
		if t.Date != date || t.Status != Pending || !slices.Contains(s.UnitIDs, t.UnitID) {
			continue
		}
		switch {
		case to != nil && (t.AttendantID == nil || *t.AttendantID != *to):
			out = append(out, i)
		case to == nil && held != nil && t.AttendantID != nil && *t.AttendantID == *held:
			out = append(out, i)
		}
	}
	return out
}
