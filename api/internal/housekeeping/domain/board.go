package domain

import (
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Board states.
const (
	Dirty      = "dirty"
	Cleaning   = "cleaning"
	Inspected  = "inspected"
	Ready      = "ready"
	OutOfOrder = "out_of_order"
)

// States lists the board states in the console's order.
var States = []string{Dirty, Cleaning, Inspected, Ready, OutOfOrder}

// transitions is HOUSEKEEPING_TRANSITIONS: forward moves; a failed inspection sends the room back
// to dirty.
var transitions = map[string][]string{
	Dirty:      {Cleaning},
	Cleaning:   {Inspected, Dirty},
	Inspected:  {Ready, Dirty},
	Ready:      {Dirty},
	OutOfOrder: {Dirty},
}

// CanMove is canMoveHousekeeping.
func CanMove(from, to string) bool { return slices.Contains(transitions[from], to) }

// InspectionItems is INSPECTION_ITEMS.
var InspectionItems = []string{"bed", "bathroom", "minibar", "amenities", "damage"}

// InspectionLabel is INSPECTION_LABEL.
var InspectionLabel = map[string]string{
	"bed": "Bed made, linen fresh", "bathroom": "Bathroom clean, water hot", "minibar": "Minibar stocked and cold",
	"amenities": "Amenities and towels in place", "damage": "No damage or broken fittings",
}

// InspectionCategory is INSPECTION_CATEGORY: the trade a failed item's work order goes to.
var InspectionCategory = map[string]string{"bed": "other", "bathroom": "plumbing", "minibar": "appliance", "amenities": "other", "damage": "structure"}

// InspectionResult is one ticked check.
type InspectionResult struct {
	Item string `json:"item"`
	OK   bool   `json:"ok"`
}

// LastInspection is the latest inspection of a unit.
type LastInspection struct {
	On      string             `json:"on"`
	By      string             `json:"by"`
	Results []InspectionResult `json:"results"`
}

// Record is HousekeepingRecord: where a unit stands for the next guest.
type Record struct {
	UnitID         string          `json:"unitId"`
	State          string          `json:"state"`
	UpdatedOn      string          `json:"updatedOn"`
	UpdatedBy      string          `json:"updatedBy"`
	Note           string          `json:"note"`
	LastInspection *LastInspection `json:"lastInspection"`
	Version        int64           `json:"-"`
}

// AssertMove is the board's rule: staying put is allowed, else the move must be a transition.
func AssertMove(r Record, unitCode, to string) error {
	if !slices.Contains(States, to) {
		return errs.Invalid("state", "Pick a housekeeping state.")
	}
	if r.State != to && !CanMove(r.State, to) {
		return errs.Newf("HOUSEKEEPING_INVALID_STATE", "%s is %s; it cannot become %s directly.", unitCode, r.State, to)
	}
	return nil
}

// Failed lists the failed checks of an inspection.
func Failed(results []InspectionResult) []InspectionResult {
	var out []InspectionResult
	for _, r := range results {
		if !r.OK {
			out = append(out, r)
		}
	}
	return out
}

// Inspect applies an inspection: cleaning or inspected only; a failure sends the room to dirty.
func Inspect(r *Record, unitCode string, results []InspectionResult, on, by string) error {
	if len(results) == 0 {
		return errs.Invalid("results", "Tick the checklist.")
	}
	for _, res := range results {
		if _, ok := InspectionLabel[res.Item]; !ok {
			return errs.Invalid("results", "Tick the checklist.")
		}
	}
	if r.State != Cleaning && r.State != Inspected {
		return errs.Newf("HOUSEKEEPING_INVALID_STATE", "%s is %s; inspect it after cleaning.", unitCode, r.State)
	}
	failed := Failed(results)
	r.State, r.Note = Inspected, "Passed inspection"
	if len(failed) > 0 {
		labels := make([]string, len(failed))
		for i, f := range failed {
			labels[i] = InspectionLabel[f.Item]
		}
		r.State, r.Note = Dirty, "Failed: "+strings.Join(labels, ", ")
	}
	r.UpdatedOn, r.UpdatedBy = on, by
	r.LastInspection = &LastInspection{On: on, By: by, Results: slices.Clone(results)}
	return nil
}
