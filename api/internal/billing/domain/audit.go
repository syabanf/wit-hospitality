package domain

import "github.com/syabanf/wit-hospitality/api/internal/platform/errs"

// AuditChecks is AUDIT_CHECKS.
var AuditChecks = []string{"arrivals", "departures", "links", "orders", "unassigned", "cashCount", "shiftsOpen"}

// AuditStay is AuditStay.
type AuditStay struct {
	BookingID string `json:"bookingId"`
	Code      string `json:"code"`
	Nights    int    `json:"nights"`
	Amount    int64  `json:"amount"`
}

// NightAudit is NightAudit.
type NightAudit struct {
	ID          string           `json:"id"`
	Date        string           `json:"date"`
	RanAt       string           `json:"ranAt"`
	RanBy       string           `json:"ranBy"`
	Checks      map[string]int64 `json:"checks"`
	NoShows     []string         `json:"noShows"`
	Stays       []AuditStay      `json:"stays"`
	Nights      int              `json:"nights"`
	RoomRevenue int64            `json:"roomRevenue"`
}

// AuditRunInput is AuditRunInput.
type AuditRunInput struct {
	Date    string           `json:"date"`
	Checks  map[string]int64 `json:"checks"`
	NoShows []string         `json:"noShows"`
}

// NightsToPost is nightsToPost: every night not posted yet up to and including `date`.
func NightsToPost(b Booking, date string) []int {
	if b.Status != CheckedIn {
		return nil
	}
	var out []int
	for i := len(b.Posted()); i < len(b.ListRates) && AddDays(b.CheckIn, i) <= date; i++ {
		out = append(out, i)
	}
	return out
}

// NightsAmount is nightsAmount.
func NightsAmount(b Booking, nights []int) int64 {
	charges := NightCharges(b)
	var s int64
	for _, i := range nights {
		if i < len(charges) {
			s += charges[i]
		}
	}
	return s
}

// AuditProblem is auditProblem: a rerun, a date other than the business date, or a day not started.
func AuditProblem(date, businessDate, today string, ran []string) error {
	for _, d := range ran {
		if d == date {
			return errs.Newf("AUDIT_ALREADY_RUN", "The night audit for %s has run; the business date is %s.", date, businessDate)
		}
	}
	if date != businessDate {
		return errs.Newf("AUDIT_DATE", "The business date is %s; the audit closes that day only.", businessDate)
	}
	if date > today {
		return errs.Newf("AUDIT_TOO_EARLY", "%s has not started yet; run its audit on that day or later.", date)
	}
	return nil
}

// EmptyChecks is emptyChecks.
func EmptyChecks() map[string]int64 {
	out := map[string]int64{}
	for _, k := range AuditChecks {
		out[k] = 0
	}
	return out
}
