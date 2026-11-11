package domain

import (
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// InDrawer is inDrawer: the money that went through a cashier's drawer, everything but drafts and
// rejected entries. Billing owns the shifts and asks finance for the cash stamped with one.
func InDrawer(status string) bool { return status != Draft && status != Rejected }

// BudgetMonth is one month of a villa's budget.
type BudgetMonth struct {
	RoomNights   float64 `json:"roomNights"`
	ADR          float64 `json:"adr"`
	OtherRevenue float64 `json:"otherRevenue"`
	Expenses     float64 `json:"expenses"`
}

// Budget is a villa's budget for one year.
type Budget struct {
	VillaID   string        `json:"villaId"`
	Year      float64       `json:"year"`
	Months    []BudgetMonth `json:"months"`
	UpdatedBy string        `json:"updatedBy"`
	UpdatedOn string        `json:"updatedOn"`
}

// BudgetInput is the budget form.
type BudgetInput struct {
	VillaID string        `json:"villaId"`
	Year    float64       `json:"year"`
	Months  []BudgetMonth `json:"months"`
}

// ValidateBudget is validateBudget, with fields keyed the way the form names them.
func ValidateBudget(in BudgetInput) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick a villa.")
	}
	if !whole(in.Year) || in.Year < 2000 || in.Year > 2100 {
		f.Add("year", "Pick a year.")
	}
	if len(in.Months) != 12 {
		f.Add("months", "A budget has twelve months.")
	}
	for i, m := range in.Months {
		for _, field := range []struct {
			key, label string
			v          float64
		}{{"roomNights", "Room nights", m.RoomNights}, {"adr", "ADR", m.ADR}, {"otherRevenue", "Other revenue", m.OtherRevenue}, {"expenses", "Expenses", m.Expenses}} {
			if !whole(field.v) || field.v < 0 {
				f.Add(fmt.Sprintf("months.%d.%s", i, field.key), field.label+": a whole number, zero or more.")
			}
		}
	}
	return f.Err()
}
