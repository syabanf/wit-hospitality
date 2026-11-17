package domain

import (
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Pool, garden and fogging upkeep, ported from src/domain/upkeep.ts
// (villa-operations-contract.md section 4).

// UpkeepTemplates is UPKEEP_TEMPLATES.
var UpkeepTemplates = []string{"pool", "garden", "fogging"}

// UpkeepTemplateLabel is UPKEEP_TEMPLATE_LABEL.
var UpkeepTemplateLabel = map[string]string{"pool": "Pool", "garden": "Garden", "fogging": "Fogging"}

// UpkeepJob is one plan a template gives.
type UpkeepJob struct {
	Key, Title, Category string
	Every                int
	Unit                 string
	Checklist            []string
	Readings             bool
	OutsideWindow        bool
	NotifyStay           bool
}

// UpkeepJobs is UPKEEP_JOBS.
var UpkeepJobs = map[string][]UpkeepJob{
	"pool": {
		{Key: "pool_daily", Title: "Pool skim and chemical check", Category: "pool", Every: 1, Unit: "days", Checklist: []string{"Skim the surface", "Empty the skimmer baskets", "Test pH and chlorine", "Dose chemicals when out of range"}, Readings: true},
		{Key: "pool_weekly", Title: "Pool vacuum", Category: "pool", Every: 7, Unit: "days", Checklist: []string{"Brush the walls and steps", "Vacuum the floor", "Check the pump pressure"}},
		{Key: "pool_monthly", Title: "Pool filter backwash", Category: "pool", Every: 1, Unit: "months", Checklist: []string{"Backwash the filter", "Rinse the filter", "Top up the water level", "Log the pressure after"}},
	},
	"garden": {
		{Key: "garden_weekly", Title: "Garden mowing and trimming", Category: "garden", Every: 7, Unit: "days", Checklist: []string{"Mow the lawn", "Trim the hedges and edges", "Clear the cuttings"}},
		{Key: "garden_monthly", Title: "Garden fertilising", Category: "garden", Every: 1, Unit: "months", Checklist: []string{"Fertilise the lawn and beds", "Water in after feeding"}},
	},
	"fogging": {
		{Key: "fogging_monthly", Title: "Mosquito fogging", Category: "pest", Every: 1, Unit: "months", Checklist: []string{"Fog the garden and drains", "Treat standing water", "Air the terrace afterwards"}, OutsideWindow: true, NotifyStay: true},
	},
}

// PlanUpkeep marks a plan an upkeep template made.
type PlanUpkeep struct {
	Template      string `json:"template"`
	Key           string `json:"key"`
	Readings      bool   `json:"readings"`
	OutsideWindow bool   `json:"outsideWindow"`
	NotifyStay    bool   `json:"notifyStay"`
}

// PoolReadings is the pool chemistry a task recorded.
type PoolReadings struct {
	PH       float64  `json:"ph"`
	Chlorine float64  `json:"chlorine"`
	Flags    []string `json:"flags"`
}

// UpkeepNotice is the message a fogging task owes the stay in house.
type UpkeepNotice struct {
	BookingID   string  `json:"bookingId"`
	BookingCode string  `json:"bookingCode"`
	Text        string  `json:"text"`
	SentOn      *string `json:"sentOn"`
}

// ChecklistTick is one checklist line of an upkeep task.
type ChecklistTick struct {
	Item string `json:"item"`
	Done bool   `json:"done"`
}

// TimeWindow is a guest's service window.
type TimeWindow struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// WorkOrderUpkeep is a pool, garden or fogging task's checklist, chemistry and guest window.
type WorkOrderUpkeep struct {
	Key              string          `json:"key"`
	Checklist        []ChecklistTick `json:"checklist"`
	ReadingsRequired bool            `json:"readingsRequired"`
	Readings         *PoolReadings   `json:"readings"`
	Window           *TimeWindow     `json:"window"`
	OutsideWindow    bool            `json:"outsideWindow"`
	Notice           *UpkeepNotice   `json:"notice"`
}

// ApplyTemplateInput is ApplyTemplateInput.
type ApplyTemplateInput struct {
	VillaID  string  `json:"villaId"`
	UnitID   *string `json:"unitId"`
	Template string  `json:"template"`
	StartOn  string  `json:"startOn"`
}

func sameUnit(a, b *string) bool {
	if a == nil || *a == "" {
		return b == nil || *b == ""
	}
	return b != nil && *a == *b
}

// ValidateApplyTemplate is validateApplyTemplate: field errors, then UPKEEP_APPLIED when an
// active plan of the template sits on that villa and unit.
func ValidateApplyTemplate(in ApplyTemplateInput, villaName string, unitVilla func(string) string, plans []Plan) error {
	var f errs.Fields
	if !slices.Contains(UpkeepTemplates, in.Template) {
		f.Add("template", "Pick pool, garden or fogging.")
	}
	if !ValidDate(in.StartOn) {
		f.Add("startOn", "Pick the first day.")
	}
	if in.UnitID != nil && *in.UnitID != "" && unitVilla(*in.UnitID) != in.VillaID {
		f.Add("unitId", "Pick a unit of this villa.")
	}
	if err := f.Err(); err != nil {
		return err
	}
	for _, p := range plans {
		if p.Active && p.Upkeep != nil && p.Upkeep.Template == in.Template && p.VillaID == in.VillaID && sameUnit(p.UnitID, in.UnitID) {
			return errs.Newf("UPKEEP_APPLIED", "%s already has the %s plans.", villaName, UpkeepTemplateLabel[in.Template])
		}
	}
	return nil
}

// TemplatePlans is templatePlans: the plans a template gives a villa, without ids.
func TemplatePlans(in ApplyTemplateInput) []Plan {
	jobs := UpkeepJobs[in.Template]
	out := make([]Plan, 0, len(jobs))
	for _, j := range jobs {
		out = append(out, Plan{
			Title: j.Title, Category: j.Category, VillaID: in.VillaID, UnitID: emptyToNil(in.UnitID), Every: j.Every, Unit: j.Unit, NextDue: in.StartOn,
			Checklist: slices.Clone(j.Checklist), Active: true,
			Upkeep: &PlanUpkeep{Template: in.Template, Key: j.Key, Readings: j.Readings, OutsideWindow: j.OutsideWindow, NotifyStay: j.NotifyStay},
		})
	}
	return out
}

// ServiceWindow is a stay's service window as the booking keeps it.
type ServiceWindow struct {
	Mode string `json:"mode"`
	From string `json:"from"`
	To   string `json:"to"`
}

// UpkeepStay is the stay in house on a plan's unit.
type UpkeepStay struct {
	BookingID   string
	BookingCode string
	Window      ServiceWindow
}

// UpkeepTask is upkeepTask: nil when the guest asked not to be disturbed, else the task's upkeep
// and the line its description ends with.
func UpkeepTask(p Plan, stay *UpkeepStay, villaName, date string) (*WorkOrderUpkeep, string) {
	if stay != nil && stay.Window.Mode == "dnd" {
		return nil, ""
	}
	var window *TimeWindow
	note := ""
	if stay != nil && stay.Window.Mode == "window" {
		window = &TimeWindow{From: stay.Window.From, To: stay.Window.To}
		side := "Within"
		if p.Upkeep.OutsideWindow {
			side = "Outside"
		}
		note = fmt.Sprintf("%s the guest's service window %s to %s.", side, window.From, window.To)
	}
	var notice *UpkeepNotice
	if stay != nil && p.Upkeep.NotifyStay {
		text := fmt.Sprintf("%s at %s on %s.", p.Title, villaName, date)
		if window != nil {
			text = fmt.Sprintf("%s at %s on %s, outside your service window (%s to %s). Please keep doors and windows closed for 30 minutes afterwards.", p.Title, villaName, date, window.From, window.To)
		}
		notice = &UpkeepNotice{BookingID: stay.BookingID, BookingCode: stay.BookingCode, Text: text}
	}
	checklist := make([]ChecklistTick, 0, len(p.Checklist))
	for _, item := range p.Checklist {
		checklist = append(checklist, ChecklistTick{Item: item})
	}
	return &WorkOrderUpkeep{Key: p.Upkeep.Key, Checklist: checklist, ReadingsRequired: p.Upkeep.Readings, Window: window, OutsideWindow: p.Upkeep.OutsideWindow, Notice: notice}, note
}

// Pool ranges, POOL_RANGE.
const (
	PHLow, PHHigh             = 7.2, 7.8
	ChlorineLow, ChlorineHigh = 1.0, 3.0
)

// PoolFlags is poolFlags.
func PoolFlags(ph, chlorine float64) []string {
	flags := []string{}
	if ph < PHLow {
		flags = append(flags, "pH low")
	} else if ph > PHHigh {
		flags = append(flags, "pH high")
	}
	if chlorine < ChlorineLow {
		flags = append(flags, "Chlorine low")
	} else if chlorine > ChlorineHigh {
		flags = append(flags, "Chlorine high")
	}
	return flags
}

// UpkeepInput is the body of PUT /work-orders/{id}/upkeep.
type UpkeepInput struct {
	Checklist []bool `json:"checklist"`
	Readings  *struct {
		PH       *float64 `json:"ph"`
		Chlorine *float64 `json:"chlorine"`
	} `json:"readings"`
	NoticeSent bool `json:"noticeSent"`
}

func inRange(v *float64, lo, hi float64) bool {
	return v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) && *v >= lo && *v <= hi
}

// ValidateUpkeep is validateUpkeep.
func (w WorkOrder) ValidateUpkeep(in UpkeepInput) error {
	u := w.Upkeep
	if u == nil {
		return errs.New("UPKEEP_NONE", w.Number+" is not an upkeep task.")
	}
	if w.Status == Verified || w.Status == Cancelled {
		return errs.Newf("WORK_ORDER_INVALID_STATE", "%s is %s; its checklist is closed.", w.Number, strings.ToLower(StatusLabel[w.Status]))
	}
	var f errs.Fields
	if len(in.Checklist) != len(u.Checklist) {
		f.Add("checklist", "Tick the checklist as listed.")
	}
	if in.Readings != nil {
		if !u.ReadingsRequired {
			f.Add("readings", "This task records no readings.")
		} else {
			if !inRange(in.Readings.PH, 0, 14) {
				f.Add("ph", "pH from 0 to 14.")
			}
			if !inRange(in.Readings.Chlorine, 0, 20) {
				f.Add("chlorine", "Chlorine in ppm, from 0 to 20.")
			}
		}
	}
	return f.Err()
}

// RecordUpkeep is recordUpkeep, after a valid recording.
func (w *WorkOrder) RecordUpkeep(in UpkeepInput, today string) {
	u := w.Upkeep
	for i := range u.Checklist {
		u.Checklist[i].Done = i < len(in.Checklist) && in.Checklist[i]
	}
	if in.Readings != nil {
		ph, cl := *in.Readings.PH, *in.Readings.Chlorine
		u.Readings = &PoolReadings{PH: ph, Chlorine: cl, Flags: PoolFlags(ph, cl)}
	}
	if u.Notice != nil && in.NoticeSent && u.Notice.SentOn == nil {
		day := today
		u.Notice.SentOn = &day
	}
}

// AssertReadingsBeforeDone is assertReadingsBeforeDone.
func (w WorkOrder) AssertReadingsBeforeDone(to string) error {
	if to == Done && w.Upkeep != nil && w.Upkeep.ReadingsRequired && w.Upkeep.Readings == nil {
		return errs.Newf("READINGS_REQUIRED", "Record the pH and chlorine on %s before closing it.", w.Number)
	}
	return nil
}
