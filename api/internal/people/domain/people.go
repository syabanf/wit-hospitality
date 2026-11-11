package domain

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Records of the employee area.
type (
	Announcement = people.Announcement
	KpiItem      = people.KpiItem
	KpiReview    = people.KpiReview
)

// AnnouncementInput writes a notice.
type AnnouncementInput struct {
	Title   string  `json:"title"`
	Body    string  `json:"body"`
	Pinned  bool    `json:"pinned"`
	VillaID *string `json:"villaId"`
}

// ValidateAnnouncement is validateAnnouncement.
func ValidateAnnouncement(in AnnouncementInput) error {
	var f errs.Fields
	if length(in.Title) < 4 {
		set(&f, "title", "Give the notice a title.")
	}
	if length(in.Body) < 10 {
		set(&f, "body", "Write the notice.")
	}
	return f.Err()
}

// ApplyAnnouncement copies the form onto a notice, trimmed as the mock does.
func ApplyAnnouncement(a *Announcement, in AnnouncementInput) {
	a.Title, a.Body, a.Pinned = strings.TrimSpace(in.Title), strings.TrimSpace(in.Body), in.Pinned
	a.VillaID = in.VillaID
	if a.VillaID != nil && *a.VillaID == "" {
		a.VillaID = nil
	}
}

// KpiInput writes a scorecard.
type KpiInput struct {
	EmployeeID string    `json:"employeeId"`
	Period     string    `json:"period"`
	Items      []KpiItem `json:"items"`
	Status     string    `json:"status"`
	Note       string    `json:"note"`
}

var quarterPattern = regexp.MustCompile(`^\d{4}-Q[1-4]$`)

// ValidateKpi is validateKpi.
func ValidateKpi(in KpiInput) error {
	var f errs.Fields
	if in.EmployeeID == "" {
		set(&f, "employeeId", "Pick the employee.")
	}
	if !quarterPattern.MatchString(in.Period) {
		set(&f, "period", "The period is a quarter, for example 2026-Q4.")
	}
	if len(in.Items) == 0 {
		set(&f, "items", "Add at least one indicator.")
	}
	var weight float64
	for _, i := range in.Items {
		weight += i.Weight
	}
	if len(in.Items) > 0 && weight != 100 {
		set(&f, "items", fmt.Sprintf("The weights add up to %s, not 100%%.", pct(weight)))
	}
	for n, i := range in.Items {
		if length(i.Name) < 2 {
			set(&f, fmt.Sprintf("items.%d.name", n), "Name the indicator.")
		}
		if !(i.Target > 0) {
			set(&f, fmt.Sprintf("items.%d.target", n), "A target above zero.")
		}
		if i.Actual < 0 {
			set(&f, fmt.Sprintf("items.%d.actual", n), "Zero or more.")
		}
	}
	return f.Err()
}
