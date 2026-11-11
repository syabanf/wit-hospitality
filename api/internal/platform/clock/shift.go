package clock

import (
	"fmt"
	"strconv"
	"time"
)

// Shift moves a seed fixture's dates from its base date to today: days by the day difference,
// months ("YYYY-MM") by the month difference and quarters ("YYYY-Qn") by the quarter difference.
type Shift struct{ Days, Months, Quarters int }

// ShiftFor is the shift that makes base become today.
func ShiftFor(base, today string) Shift {
	b, _ := time.Parse(DateLayout, base)
	t, _ := time.Parse(DateLayout, today)
	months := (t.Year()-b.Year())*12 + int(t.Month()) - int(b.Month())
	quarters := (t.Year()-b.Year())*4 + (int(t.Month())-1)/3 - (int(b.Month())-1)/3
	return Shift{Days: DaysBetween(base, today), Months: months, Quarters: quarters}
}

// Date moves a date.
func (s Shift) Date(d string) string { return AddDays(d, s.Days) }

// DatePtr moves an optional date.
func (s Shift) DatePtr(d *string) *string {
	if d == nil {
		return nil
	}
	v := s.Date(*d)
	return &v
}

// Month moves a "YYYY-MM".
func (s Shift) Month(m string) string {
	t, err := time.Parse("2006-01", m)
	if err != nil {
		return m
	}
	return t.AddDate(0, s.Months, 0).Format("2006-01")
}

// Quarter moves a "YYYY-Qn".
func (s Shift) Quarter(q string) string {
	if len(q) != 7 {
		return q
	}
	year, err1 := strconv.Atoi(q[:4])
	n, err2 := strconv.Atoi(q[6:])
	if err1 != nil || err2 != nil {
		return q
	}
	i := year*4 + n - 1 + s.Quarters
	return fmt.Sprintf("%d-Q%d", i/4, i%4+1)
}
