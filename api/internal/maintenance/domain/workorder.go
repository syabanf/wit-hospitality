// Package domain holds the maintenance rules ported from src/domain/maintenance.ts: work orders and
// their lifecycle, itemised expenses, assets, vendors and preventive plans. It is pure: no
// database, no HTTP. Messages and codes match the TypeScript RuleError text.
package domain

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Categories is MAINTENANCE_CATEGORIES.
var Categories = []string{"ac", "plumbing", "electrical", "pool", "appliance", "structure", "garden", "pest", "other"}

// Priorities is WORK_ORDER_PRIORITIES.
var Priorities = []string{"low", "normal", "high", "urgent"}

// Work order statuses.
const (
	Open       = "open"
	Scheduled  = "scheduled"
	InProgress = "in_progress"
	OnHold     = "on_hold"
	Done       = "done"
	Verified   = "verified"
	Cancelled  = "cancelled"
)

// StatusLabel is WORK_ORDER_STATUS_LABEL.
var StatusLabel = map[string]string{
	Open: "Open", Scheduled: "Scheduled", InProgress: "In progress", OnHold: "On hold",
	Done: "Done", Verified: "Verified", Cancelled: "Cancelled",
}

// Transitions is WORK_ORDER_TRANSITIONS.
var Transitions = map[string][]string{
	Open:       {Scheduled, InProgress, Cancelled},
	Scheduled:  {InProgress, OnHold, Cancelled},
	InProgress: {Done, OnHold, Cancelled},
	OnHold:     {InProgress, Cancelled},
	Done:       {Verified, InProgress},
	Verified:   {},
	Cancelled:  {},
}

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// ValidDate reports whether s is an IsoDate.
func ValidDate(s string) bool { return isoDate.MatchString(s) }

// Part is one spare part on a job.
type Part struct {
	Name     string `json:"name"`
	Qty      int64  `json:"qty"`
	UnitCost int64  `json:"unitCost"`
}

// Event is WorkOrderEvent: one line of a job's history.
type Event struct {
	Kind string `json:"kind"`
	By   string `json:"by"`
	On   string `json:"on"`
	Note string `json:"note"`
}

// Attachment is a stored file reference. The files context owns the bytes; maintenance keeps the
// reference the client sends.
type Attachment struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	URL        string `json:"url"`
	UploadedBy string `json:"uploadedBy"`
	UploadedAt string `json:"uploadedAt"`
}

// WorkOrder is a repair or service job on a unit, or on a villa's shared equipment when UnitID is nil.
type WorkOrder struct {
	ID          string    `json:"id"`
	Number      string    `json:"number"`
	VillaID     string    `json:"villaId"`
	UnitID      *string   `json:"unitId"`
	AssetID     *string   `json:"assetId"`
	PlanID      *string   `json:"planId"`
	Source      string    `json:"source"`
	Category    string    `json:"category"`
	Priority    string    `json:"priority"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	ReportedBy  string    `json:"reportedBy"`
	AssigneeID  *string   `json:"assigneeId"`
	VendorID    *string   `json:"vendorId"`
	Status      string    `json:"status"`
	CreatedOn   string    `json:"createdOn"`
	ScheduledOn *string   `json:"scheduledOn"`
	StartedOn   *string   `json:"startedOn"`
	FinishedOn  *string   `json:"finishedOn"`
	VerifiedOn  *string   `json:"verifiedOn"`
	Before      []string  `json:"beforePhotos"`
	After       []string  `json:"afterPhotos"`
	Parts       []Part    `json:"parts"`
	LabourCost  int64     `json:"labourCost"`
	VendorCost  int64     `json:"vendorCost"`
	BlockID     *string   `json:"blockId"`
	Expenses    []Expense `json:"expenses"`
	History     []Event   `json:"history"`
	Version     int64     `json:"-"`
}

// Input is WorkOrderInput.
type Input struct {
	VillaID     string   `json:"villaId"`
	UnitID      *string  `json:"unitId"`
	AssetID     *string  `json:"assetId"`
	Category    string   `json:"category"`
	Priority    string   `json:"priority"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	AssigneeID  *string  `json:"assigneeId"`
	VendorID    *string  `json:"vendorId"`
	ScheduledOn *string  `json:"scheduledOn"`
	Parts       []Part   `json:"parts"`
	LabourCost  float64  `json:"labourCost"`
	VendorCost  float64  `json:"vendorCost"`
	Before      []string `json:"beforePhotos"`
	After       []string `json:"afterPhotos"`
}

// NewInput is NewWorkOrder: a work order form plus where it came from and an optional block.
type NewInput struct {
	Input
	Source    string  `json:"source"`
	PlanID    *string `json:"planId"`
	BlockFrom *string `json:"blockFrom"`
	BlockTo   *string `json:"blockTo"`
}

func whole(n float64) bool { return n == math.Trunc(n) && !math.IsInf(n, 0) }

// ValidateWorkOrder is validateWorkOrder.
func ValidateWorkOrder(in Input) error {
	var f errs.Fields
	if in.VillaID == "" {
		f.Add("villaId", "Pick the villa.")
	}
	if !slices.Contains(Categories, in.Category) {
		f.Add("category", "Pick the category.")
	}
	if !slices.Contains(Priorities, in.Priority) {
		f.Add("priority", "Pick the priority.")
	}
	if len([]rune(strings.TrimSpace(in.Title))) < 4 {
		f.Add("title", "Say what needs fixing.")
	}
	if in.ScheduledOn != nil && *in.ScheduledOn != "" && !ValidDate(*in.ScheduledOn) {
		f.Add("scheduledOn", "Pick the date.")
	}
	if !whole(in.LabourCost) || in.LabourCost < 0 {
		f.Add("labourCost", "Whole rupiah, zero or more.")
	}
	if !whole(in.VendorCost) || in.VendorCost < 0 {
		f.Add("vendorCost", "Whole rupiah, zero or more.")
	}
	for i, p := range in.Parts {
		if len([]rune(strings.TrimSpace(p.Name))) < 2 {
			f.Add(fmt.Sprintf("parts.%d.name", i), "Name the part.")
		}
		if p.Qty < 1 {
			f.Add(fmt.Sprintf("parts.%d.qty", i), "At least one.")
		}
		if p.UnitCost < 0 {
			f.Add(fmt.Sprintf("parts.%d.unitCost", i), "Whole rupiah.")
		}
	}
	return f.Err()
}

// CanTransition is canTransitionWorkOrder.
func CanTransition(from, to string) bool { return slices.Contains(Transitions[from], to) }

// IsOpen is isOpenWorkOrder: anything not closed still holds the unit or the team.
func IsOpen(status string) bool { return status != Done && status != Verified && status != Cancelled }

// CanAddExpense is canAddExpense: jobs carry expenses once work has started.
func CanAddExpense(status string) bool {
	return status == InProgress || status == OnHold || status == Done || status == Verified
}

// PartsCost is partsCost.
func (w WorkOrder) PartsCost() int64 {
	var s int64
	for _, p := range w.Parts {
		s += p.Qty * p.UnitCost
	}
	return s
}

// Cost is workOrderCost.
func (w WorkOrder) Cost() int64 { return w.PartsCost() + w.LabourCost + w.VendorCost }

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

func trimmedParts(parts []Part) []Part {
	out := make([]Part, 0, len(parts))
	for _, p := range parts {
		out = append(out, Part{Name: p.Name, Qty: p.Qty, UnitCost: p.UnitCost})
	}
	return out
}

func emptyToNil(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// NewWorkOrder is the mock's newWorkOrder: scheduled when it has a date, else open. The history
// names who opened it (by), which differs from reportedBy for a job a plan opens.
func NewWorkOrder(id, number string, in NewInput, reportedBy, by, today string) WorkOrder {
	source := in.Source
	if source == "" {
		source = "manual"
	}
	status := Open
	if emptyToNil(in.ScheduledOn) != nil {
		status = Scheduled
	}
	w := WorkOrder{
		ID: id, Number: number, VillaID: in.VillaID, UnitID: emptyToNil(in.UnitID), AssetID: emptyToNil(in.AssetID), PlanID: emptyToNil(in.PlanID),
		Source: source, Category: in.Category, Priority: in.Priority, Title: strings.TrimSpace(in.Title), Description: strings.TrimSpace(in.Description),
		ReportedBy: reportedBy, AssigneeID: emptyToNil(in.AssigneeID), VendorID: emptyToNil(in.VendorID), Status: status, CreatedOn: today,
		ScheduledOn: emptyToNil(in.ScheduledOn), Before: nonNil(in.Before), After: nonNil(in.After), Parts: trimmedParts(in.Parts),
		LabourCost: int64(in.LabourCost), VendorCost: int64(in.VendorCost), Expenses: []Expense{},
	}
	w.History = []Event{{Kind: "created", By: by, On: today, Note: w.Description}}
	return w
}

// CheckEditable refuses to edit a verified or cancelled job.
func (w WorkOrder) CheckEditable() error {
	if w.Status == Verified || w.Status == Cancelled {
		return errs.Newf("WORK_ORDER_INVALID_STATE", "%s is %s; it can no longer change.", w.Number, w.Status)
	}
	return nil
}

// Apply is updateWorkOrder's edit of a valid form.
func (w *WorkOrder) Apply(in Input) {
	w.VillaID, w.UnitID, w.AssetID = in.VillaID, emptyToNil(in.UnitID), emptyToNil(in.AssetID)
	w.Category, w.Priority = in.Category, in.Priority
	w.Title, w.Description = strings.TrimSpace(in.Title), strings.TrimSpace(in.Description)
	w.AssigneeID, w.VendorID, w.ScheduledOn = emptyToNil(in.AssigneeID), emptyToNil(in.VendorID), emptyToNil(in.ScheduledOn)
	w.Parts, w.Before, w.After = trimmedParts(in.Parts), nonNil(in.Before), nonNil(in.After)
	w.LabourCost, w.VendorCost = int64(in.LabourCost), int64(in.VendorCost)
}

// Log appends a history line.
func (w *WorkOrder) Log(kind, by, on, note string) {
	w.History = append(w.History, Event{Kind: kind, By: by, On: on, Note: note})
}

// Transition is transitionWorkOrder's state change. It reports whether the job just finished
// (so the caller advances its plan and returns its asset to service) and whether the block must go.
func (w *WorkOrder) Transition(to, note, by, today string) (finished, release bool, err error) {
	if !CanTransition(w.Status, to) {
		return false, false, errs.Newf("WORK_ORDER_INVALID_STATE", "A %s job cannot become %s.", strings.ToLower(StatusLabel[w.Status]), strings.ToLower(StatusLabel[to]))
	}
	note = strings.TrimSpace(note)
	if (to == OnHold || to == Cancelled) && len([]rune(note)) < 3 {
		return false, false, errs.Invalid("note", "Say why.")
	}
	before := w.Status
	w.Status = to
	day := today
	if to == Scheduled && w.ScheduledOn == nil {
		w.ScheduledOn = &day
	}
	if to == InProgress && w.StartedOn == nil {
		w.StartedOn = &day
	}
	if to == Done {
		w.FinishedOn = &day
	}
	if to == InProgress && before == Done {
		w.FinishedOn = nil
	}
	if to == Verified {
		w.VerifiedOn = &day
	}
	w.Log(to, by, today, note)
	return to == Done, to == Done || to == Cancelled, nil
}

// CheckBlock is blockFor's own checks: only a job on a unit blocks it, with a start and a later end.
func (w WorkOrder) CheckBlock(from, to string) error {
	if w.UnitID == nil {
		return errs.New(errs.CodeValidation, "Only a job on a unit can block it.")
	}
	if !ValidDate(from) || !ValidDate(to) || to <= from {
		return errs.New(errs.CodeValidation, "The block needs a start and a later end.")
	}
	return nil
}

// CheckOpenForBlock refuses to block the unit for a closed job.
func (w WorkOrder) CheckOpenForBlock() error {
	if !IsOpen(w.Status) {
		return errs.Newf("WORK_ORDER_INVALID_STATE", "%s is closed; it cannot block the unit.", w.Number)
	}
	return nil
}

// ValidateNote is addNote's check.
func ValidateNote(note string) error {
	if len([]rune(strings.TrimSpace(note))) < 2 {
		return errs.Invalid("note", "Write the note.")
	}
	return nil
}

// AddDays shifts an IsoDate.
func AddDays(date string, n int) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date
	}
	return t.AddDate(0, 0, n).Format("2006-01-02")
}

// AddMonths is lib/dates addMonths: the same day of the month, clamped to the month's last day.
func AddMonths(date string, n int) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date
	}
	first := time.Date(t.Year(), t.Month()+time.Month(n), 1, 0, 0, 0, 0, time.UTC)
	last := first.AddDate(0, 1, -1).Day()
	return time.Date(first.Year(), first.Month(), min(t.Day(), last), 0, 0, 0, 0, time.UTC).Format("2006-01-02")
}
