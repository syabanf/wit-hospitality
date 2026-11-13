// Package domain holds the housekeeping rules ported from src/domain/housekeeping.ts and the board
// half of src/domain/maintenance.ts: task types and standards, the attendant's state machine and
// checklist, the day plan, attendants on shift and auto-assign, the do-not-disturb streak, linen
// pars and laundry batches, and the board's states and inspection. Errors carry the TypeScript
// codes and wording.
package domain

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// Task types.
const (
	Departure  = "departure"
	Stayover   = "stayover"
	Turndown   = "turndown"
	Deep       = "deep"
	Inspection = "inspection"
)

// TaskTypes lists the types in the console's order.
var TaskTypes = []string{Departure, Stayover, Turndown, Deep, Inspection}

// TaskTypeLabel is TASK_TYPE_LABEL.
var TaskTypeLabel = map[string]string{Departure: "Departure clean", Stayover: "Stayover service", Turndown: "Turndown", Deep: "Deep clean", Inspection: "Inspection"}

// Standard weighs a task against the daily quota (credits) and productivity (minutes).
type Standard struct {
	Credits float64 `json:"credits"`
	Minutes int     `json:"minutes"`
}

// Settings is HousekeepingSettings.
type Settings struct {
	DailyQuota float64             `json:"dailyQuota"`
	Turndown   bool                `json:"turndown"`
	Standards  map[string]Standard `json:"standards"`
}

// DefaultSettings is DEFAULT_HOUSEKEEPING_SETTINGS.
func DefaultSettings() Settings {
	return Settings{DailyQuota: 8, Standards: map[string]Standard{
		Departure: {1, 45}, Stayover: {0.5, 25}, Turndown: {0.25, 10}, Deep: {2, 120}, Inspection: {0.25, 10},
	}}
}

// ValidateSettings is validateHousekeepingSettings.
func ValidateSettings(s Settings) error {
	var f errs.Fields
	if !(s.DailyQuota >= 1 && s.DailyQuota <= 20) {
		f.Add("dailyQuota", "A daily quota from 1 to 20 credits.")
	}
	for _, t := range TaskTypes {
		st, ok := s.Standards[t]
		if !ok || !(st.Credits > 0 && st.Credits <= 8) || math.Round(st.Credits*4) != st.Credits*4 {
			f.Add("standards."+t+".credits", "Credits in quarters, above 0 and up to 8.")
		}
		if !ok || st.Minutes < 5 || st.Minutes > 480 {
			f.Add("standards."+t+".minutes", "Whole minutes from 5 to 480.")
		}
	}
	return f.Err()
}

// Task statuses.
const (
	Pending    = "pending"
	InProgress = "in_progress"
	Paused     = "paused"
	Done       = "done"
	DND        = "dnd"
	Refused    = "refused"
	Cancelled  = "cancelled"
)

var statusLabel = map[string]string{Pending: "To do", InProgress: "In progress", Paused: "Paused", Done: "Done", DND: "Do not disturb", Refused: "Service refused", Cancelled: "Cancelled"}

// ActionLabel is TASK_ACTION_LABEL.
var ActionLabel = map[string]string{"start": "Start", "pause": "Pause", "resume": "Resume", "done": "Done", "dnd": "Do not disturb", "refused": "Service refused", "cancel": "Cancel"}

var actionFrom = map[string][]string{
	"start": {Pending}, "pause": {InProgress}, "resume": {Paused}, "done": {InProgress, Paused},
	"dnd": {Pending}, "refused": {Pending}, "cancel": {Pending, Paused},
}

var actionTo = map[string]string{"start": InProgress, "pause": Paused, "resume": InProgress, "done": Done, "dnd": DND, "refused": Refused, "cancel": Cancelled}

// IsOpen is isOpenTask.
func IsOpen(status string) bool { return status == Pending || status == InProgress || status == Paused }

// AssertAction is assertTaskAction: the status the action leads to, or TASK_INVALID_STATE.
func AssertAction(t RoomTask, action string) (string, error) {
	from, ok := actionFrom[action]
	if !ok {
		return "", errs.Invalid("action", "Pick start, pause, resume, done, dnd, refused or cancel.")
	}
	if !slices.Contains(from, t.Status) {
		return "", errs.Newf("TASK_INVALID_STATE", "%s is %s; it cannot %s now.", t.Number, strings.ToLower(statusLabel[t.Status]), strings.ToLower(ActionLabel[action]))
	}
	if (action == "dnd" || action == "refused") && t.Type != Stayover && t.Type != Turndown {
		return "", errs.Newf("TASK_INVALID_STATE", "%s has no guest to answer the door.", TaskTypeLabel[t.Type])
	}
	return actionTo[action], nil
}

// Checklist is TASK_CHECKLIST.
var Checklist = map[string][]string{
	Departure:  {"Strip the beds and bag the linen", "Make the beds with fresh linen", "Clean the bathroom and replace towels", "Dust, vacuum and mop", "Restock amenities and minibar", "Empty the bins"},
	Stayover:   {"Make the bed", "Replace used towels", "Tidy the bathroom", "Empty the bins"},
	Turndown:   {"Turn down the bed", "Close the curtains", "Fresh water by the bed"},
	Deep:       {"Move the furniture and clean behind it", "Wash the curtains and cushions", "Descale the bathroom", "Clean the fans and AC grilles", "Polish the floors"},
	Inspection: {"Bed made, linen fresh", "Bathroom clean, water hot", "Minibar stocked and cold", "Amenities and towels in place", "No damage or broken fittings"},
}

// Tick is ChecklistTick.
type Tick struct {
	Item string `json:"item"`
	OK   bool   `json:"ok"`
}

// TaskEvent is one line of a task's history.
type TaskEvent struct {
	Kind string `json:"kind"`
	By   string `json:"by"`
	At   string `json:"at"`
	Note string `json:"note"`
}

// LostFoundNote is a find on a task, linked to the lost and found record.
type LostFoundNote struct {
	Note string  `json:"note"`
	Ref  *string `json:"ref"`
	By   string  `json:"by"`
	At   string  `json:"at"`
}

// RoomTask is RoomTask.
type RoomTask struct {
	ID              string          `json:"id"`
	Number          string          `json:"number"`
	Date            string          `json:"date"`
	UnitID          string          `json:"unitId"`
	VillaID         string          `json:"villaId"`
	Type            string          `json:"type"`
	BookingID       *string         `json:"bookingId"`
	AttendantID     *string         `json:"attendantId"`
	Status          string          `json:"status"`
	Credits         float64         `json:"credits"`
	StandardMinutes int             `json:"standardMinutes"`
	StartedAt       *string         `json:"startedAt"`
	FinishedAt      *string         `json:"finishedAt"`
	RunningSince    *string         `json:"runningSince"`
	WorkedMinutes   int             `json:"workedMinutes"`
	Checklist       []Tick          `json:"checklist"`
	WorkOrderIDs    []string        `json:"workOrderIds"`
	LostFound       []LostFoundNote `json:"lostFound"`
	Note            string          `json:"note"`
	History         []TaskEvent     `json:"history"`
	Version         int64           `json:"-"`
}

// Normalize turns absent lists into empty ones, so the JSON matches the console's arrays.
func (t *RoomTask) Normalize() {
	if t.Checklist == nil {
		t.Checklist = []Tick{}
	}
	if t.WorkOrderIDs == nil {
		t.WorkOrderIDs = []string{}
	}
	if t.LostFound == nil {
		t.LostFound = []LostFoundNote{}
	}
	if t.History == nil {
		t.History = []TaskEvent{}
	}
}

// TaskInput is TaskInput.
type TaskInput struct {
	UnitID      string  `json:"unitId"`
	Date        string  `json:"date"`
	Type        string  `json:"type"`
	AttendantID *string `json:"attendantId"`
	Note        string  `json:"note"`
}

var isoDay = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// ValidateTask is validateTask.
func ValidateTask(in TaskInput) error {
	var f errs.Fields
	if in.UnitID == "" {
		f.Add("unitId", "Pick the unit.")
	}
	if !isoDay.MatchString(in.Date) {
		f.Add("date", "Pick the day.")
	}
	if !slices.Contains(TaskTypes, in.Type) {
		f.Add("type", "Pick the task.")
	}
	return f.Err()
}

const stampLayout = "2006-01-02T15:04:05"

// MinutesBetween is minutesBetween: whole minutes between two local date-times, never negative.
func MinutesBetween(from, to string) int {
	a, err1 := time.Parse(stampLayout, from)
	b, err2 := time.Parse(stampLayout, to)
	if err1 != nil || err2 != nil {
		return 0
	}
	return max(0, int(math.Round(b.Sub(a).Minutes())))
}

// Planned is PlannedTask.
type Planned struct {
	UnitID    string
	VillaID   string
	Type      string
	BookingID *string
}

// PlanUnit is a unit as the plan reads it; StayoverEvery is the days between its stayover cleans,
// 0 for none (see StayoverEvery).
type PlanUnit struct {
	ID            string
	VillaID       string
	Status        string
	StayoverEvery int
}

// StayoverDue reports whether a guest who checked in on checkIn gets a stayover clean on day: every
// `every` days after arrival, never on the arrival day.
func StayoverDue(checkIn, day string, every int) bool {
	if every <= 0 {
		return false
	}
	n := clock.DaysBetween(checkIn, day)
	return n > 0 && n%every == 0
}

// PlanStay is a stay that occupies a room.
type PlanStay struct {
	ID       string
	UnitID   string
	CheckIn  string
	CheckOut string
}

// PlanInput is planTasks' input. Existing holds unit|type pairs already on the day.
type PlanInput struct {
	Date     string
	Units    []PlanUnit
	Stays    []PlanStay
	Dirty    map[string]bool
	Turndown bool
	Existing map[string]bool
}

// PlanTasks is planTasks: a departure clean after each check-out or dirty room, stayover service
// for a stay in house on the days its property's schedule falls due (and turndown every night in
// house); a unit never gets the same task twice on a day.
func PlanTasks(in PlanInput) []Planned {
	var planned []Planned
	has := func(unitID, typ string) bool {
		if in.Existing[unitID+"|"+typ] {
			return true
		}
		return slices.ContainsFunc(planned, func(p Planned) bool { return p.UnitID == unitID && p.Type == typ })
	}
	for _, u := range in.Units {
		if u.Status == "inactive" {
			continue
		}
		var leaving, staying *PlanStay
		for i := range in.Stays {
			b := &in.Stays[i]
			if leaving == nil && b.UnitID == u.ID && b.CheckOut == in.Date {
				leaving = b
			}
			if staying == nil && b.UnitID == u.ID && b.CheckIn < in.Date && in.Date < b.CheckOut {
				staying = b
			}
		}
		if (leaving != nil || in.Dirty[u.ID]) && !has(u.ID, Departure) {
			var id *string
			if leaving != nil {
				id = &leaving.ID
			}
			planned = append(planned, Planned{UnitID: u.ID, VillaID: u.VillaID, Type: Departure, BookingID: id})
		}
		if staying != nil && StayoverDue(staying.CheckIn, in.Date, u.StayoverEvery) && !has(u.ID, Stayover) {
			planned = append(planned, Planned{UnitID: u.ID, VillaID: u.VillaID, Type: Stayover, BookingID: &staying.ID})
		}
		if staying != nil && in.Turndown && !has(u.ID, Turndown) {
			planned = append(planned, Planned{UnitID: u.ID, VillaID: u.VillaID, Type: Turndown, BookingID: &staying.ID})
		}
	}
	return planned
}

// Employee is the part of an employee housekeeping reads from people.
type Employee struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Department string   `json:"department"`
	Position   string   `json:"position"`
	Status     string   `json:"status"`
	VillaIDs   []string `json:"villaIds"`
}

// RosterDay is one employee's shift on one day; ShiftID nil is a day off.
type RosterDay struct {
	EmployeeID string  `json:"employeeId"`
	Date       string  `json:"date"`
	ShiftID    *string `json:"shiftId"`
	VillaID    string  `json:"villaId"`
}

// Leave is an approved leave, both days inclusive.
type Leave struct {
	EmployeeID string `json:"employeeId"`
	Status     string `json:"status"`
	From       string `json:"from"`
	To         string `json:"to"`
}

// StaffDay is what people answers for one day: employees, that day's roster and the leaves.
type StaffDay struct {
	Employees []Employee  `json:"employees"`
	Roster    []RosterDay `json:"roster"`
	Leaves    []Leave     `json:"leaves"`
}

// Employee finds an employee by id.
func (s StaffDay) Employee(id string) (Employee, bool) {
	for _, e := range s.Employees {
		if e.ID == id {
			return e, true
		}
	}
	return Employee{}, false
}

// Attendant is a room attendant on shift.
type Attendant struct {
	ID       string
	Name     string
	VillaIDs []string
	ShiftID  string
}

var attendantPosition = regexp.MustCompile(`(?i)housekeep|room attendant`)

func isAttendant(e Employee) bool {
	return e.Status != "inactive" && (e.Department == "housekeeping" || attendantPosition.MatchString(e.Position))
}

// AttendantsOnShift is attendantsOnShift: housekeeping staff the roster puts on a shift that day,
// less anyone on approved leave. Each serves the roster's villa and their allocations.
func AttendantsOnShift(s StaffDay, date string) []Attendant {
	var out []Attendant
	for _, e := range s.Employees {
		if !isAttendant(e) {
			continue
		}
		var shift *RosterDay
		for i := range s.Roster {
			if s.Roster[i].EmployeeID == e.ID && s.Roster[i].Date == date {
				shift = &s.Roster[i]
				break
			}
		}
		if shift == nil || shift.ShiftID == nil || *shift.ShiftID == "" {
			continue
		}
		onLeave := slices.ContainsFunc(s.Leaves, func(l Leave) bool {
			return l.EmployeeID == e.ID && l.Status == "approved" && l.From <= date && date <= l.To
		})
		if onLeave {
			continue
		}
		villas := []string{shift.VillaID}
		for _, v := range e.VillaIDs {
			if !slices.Contains(villas, v) {
				villas = append(villas, v)
			}
		}
		out = append(out, Attendant{ID: e.ID, Name: e.Name, VillaIDs: villas, ShiftID: *shift.ShiftID})
	}
	return out
}

// OnShift reports whether the employee is an attendant on shift that day.
func OnShift(s StaffDay, date, employeeID string) bool {
	return slices.ContainsFunc(AttendantsOnShift(s, date), func(a Attendant) bool { return a.ID == employeeID })
}

// Assignable is AssignableTask.
type Assignable struct {
	ID         string
	VillaID    string
	LocationID string
	UnitCode   string
	Type       string
	Credits    float64
}

// Load is AttendantLoad.
type Load struct {
	ID          string
	VillaIDs    []string
	LocationIDs []string
	Credits     float64
}

// Given is one auto-assign decision.
type Given struct {
	TaskID      string
	AttendantID string
}

var typeOrder = map[string]int{Departure: 0, Deep: 1, Stayover: 2, Turndown: 3, Inspection: 4}

// AutoAssign is autoAssign: villas with the most work go first. A villa's tasks go to the attendant
// who serves it with the most room under the quota, all of them when they fit, so one person keeps
// one villa; when they do not, the run carries on with the next attendant with room, in unit order.
// Attendants of the same location stand in when nobody serves the villa. Nobody passes the quota.
func AutoAssign(tasks []Assignable, attendants []Load, quota float64) []Given {
	load := map[string]float64{}
	for _, a := range attendants {
		load[a.ID] = a.Credits
	}
	room := func(id string) float64 { return quota - load[id] }
	var villaOrder []string
	byVilla := map[string][]Assignable{}
	for _, t := range tasks {
		if _, ok := byVilla[t.VillaID]; !ok {
			villaOrder = append(villaOrder, t.VillaID)
		}
		byVilla[t.VillaID] = append(byVilla[t.VillaID], t)
	}
	total := func(list []Assignable) float64 {
		s := 0.0
		for _, t := range list {
			s += t.Credits
		}
		return s
	}
	sort.SliceStable(villaOrder, func(i, j int) bool {
		a, b := villaOrder[i], villaOrder[j]
		if ta, tb := total(byVilla[a]), total(byVilla[b]); ta != tb {
			return ta > tb
		}
		return a < b
	})
	var result []Given
	for _, villaID := range villaOrder {
		sorted := slices.Clone(byVilla[villaID])
		sort.SliceStable(sorted, func(i, j int) bool {
			if sorted[i].UnitCode != sorted[j].UnitCode {
				return sorted[i].UnitCode < sorted[j].UnitCode
			}
			return typeOrder[sorted[i].Type] < typeOrder[sorted[j].Type]
		})
		var pool []Load
		for _, a := range attendants {
			if slices.Contains(a.VillaIDs, villaID) {
				pool = append(pool, a)
			}
		}
		if len(pool) == 0 {
			locationID := ""
			if len(sorted) > 0 {
				locationID = sorted[0].LocationID
			}
			for _, a := range attendants {
				if slices.Contains(a.LocationIDs, locationID) {
					pool = append(pool, a)
				}
			}
		}
		ranked := func() []Load {
			r := slices.Clone(pool)
			sort.SliceStable(r, func(i, j int) bool {
				if ri, rj := room(r[i].ID), room(r[j].ID); ri != rj {
					return ri > rj
				}
				return r[i].ID < r[j].ID
			})
			return r
		}
		firstWith := func(need float64) string {
			for _, a := range ranked() {
				if room(a.ID) >= need {
					return a.ID
				}
			}
			return ""
		}
		current := firstWith(total(sorted))
		if current == "" {
			if r := ranked(); len(r) > 0 {
				current = r[0].ID
			}
		}
		for _, t := range sorted {
			if current == "" || room(current) < t.Credits {
				current = firstWith(t.Credits)
			}
			if current == "" {
				continue
			}
			load[current] += t.Credits
			result = append(result, Given{TaskID: t.ID, AttendantID: current})
		}
	}
	return result
}

// CreditsByAttendant is creditsByAttendant: credits per attendant from every task not cancelled.
func CreditsByAttendant(tasks []RoomTask) map[string]float64 {
	out := map[string]float64{}
	for _, t := range tasks {
		if t.AttendantID != nil && t.Status != Cancelled {
			out[*t.AttendantID] += t.Credits
		}
	}
	return out
}

// DNDAlertDays is DND_ALERT_DAYS.
const DNDAlertDays = 3

// DNDStreak is dndStreak: days in a row, up to today, that a stay kept the door shut on its
// stayover service.
func DNDStreak(tasks []RoomTask, bookingID, today string) int {
	days := map[string]string{}
	latest := ""
	for _, t := range tasks {
		if t.BookingID == nil || *t.BookingID != bookingID || t.Type != Stayover || t.Date > today {
			continue
		}
		days[t.Date] = t.Status
		latest = max(latest, t.Date)
	}
	streak := 0
	for day := latest; day != "" && days[day] == DND; day = addDays(day, -1) {
		streak++
	}
	return streak
}

func addDays(day string, n int) string {
	t, err := time.Parse(time.DateOnly, day)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 0, n).Format(time.DateOnly)
}

// TaskNumber is the mock's task id and number for sequence n.
func TaskNumber(n int64) (id, number string) {
	return fmt.Sprintf("hkt-%d", n), fmt.Sprintf("HK-%d", 4000+n)
}

// NewTask is the mock's newTask: a pending task with the standard copied from the settings.
func NewTask(n int64, p Planned, date string, s Settings, created TaskEvent) RoomTask {
	id, number := TaskNumber(n)
	st := s.Standards[p.Type]
	t := RoomTask{ID: id, Number: number, Date: date, UnitID: p.UnitID, VillaID: p.VillaID, Type: p.Type, BookingID: p.BookingID,
		Status: Pending, Credits: st.Credits, StandardMinutes: st.Minutes, Note: created.Note, History: []TaskEvent{created}}
	t.Normalize()
	return t
}
