// Package clock gives handlers an injectable "now" in the business time zone, so tests pin the
// day and the demo reads dates the way the front end does (`YYYY-MM-DD`).
package clock

import "time"

// Clock tells the time.
type Clock interface {
	Now() time.Time
}

// System reads the wall clock in a fixed location.
type System struct{ Loc *time.Location }

// Now is the current time in the business time zone.
func (s System) Now() time.Time { return time.Now().In(s.Loc) }

// Fixed always answers T; tests use it.
type Fixed struct{ T time.Time }

// Now returns the pinned time.
func (f Fixed) Now() time.Time { return f.T }

// DateLayout is the front end's IsoDate.
const DateLayout = "2006-01-02"

// StampLayout is the audit trail's local date-time, without a zone, as the mock writes it.
const StampLayout = "2006-01-02T15:04:05"

// Today is the business date.
func Today(c Clock) string { return c.Now().Format(DateLayout) }

// Stamp is the local date-time for audit lines.
func Stamp(c Clock) string { return c.Now().Format(StampLayout) }

// ParseDate reads an IsoDate.
func ParseDate(s string) (time.Time, error) { return time.Parse(DateLayout, s) }

// AddDays shifts an IsoDate by n days.
func AddDays(date string, n int) string {
	t, err := ParseDate(date)
	if err != nil {
		return date
	}
	return t.AddDate(0, 0, n).Format(DateLayout)
}

// DaysBetween counts days from a to b, as lib/dates daysBetween does.
func DaysBetween(a, b string) int {
	ta, errA := ParseDate(a)
	tb, errB := ParseDate(b)
	if errA != nil || errB != nil {
		return 0
	}
	return int(tb.Sub(ta).Hours() / 24)
}
