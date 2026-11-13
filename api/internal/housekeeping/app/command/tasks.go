package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// SaveSettings replaces the quota and standards; supervisors only.
type SaveSettings struct{ Deps }

// Handle saves the settings.
func (h SaveSettings) Handle(ctx context.Context, p auth.Principal, s domain.Settings) (domain.Settings, error) {
	if err := h.need(ctx, p, "edit"); err != nil {
		return s, err
	}
	if err := domain.ValidateSettings(s); err != nil {
		return s, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		before, version, err := h.Store.Settings(ctx)
		if err != nil {
			return err
		}
		if _, err := h.Store.SaveSettings(ctx, s, version); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "housekeeping-settings", EntityID: "housekeeping", Summary: "Changed the housekeeping quota and standards",
			Before: map[string]any{"dailyQuota": before.DailyQuota, "turndown": before.Turndown}, After: map[string]any{"dailyQuota": s.DailyQuota, "turndown": s.Turndown}})
	})
	return s, err
}

// newTask numbers and inserts a planned task.
func (d Deps) newTask(ctx context.Context, p auth.Principal, pl domain.Planned, date string, s domain.Settings, note string) (domain.RoomTask, error) {
	n, err := d.Store.Next(ctx, "roomTask")
	if err != nil {
		return domain.RoomTask{}, err
	}
	t := domain.NewTask(n, pl, date, s, d.event("created", p, note))
	if err := d.takeWindow(ctx, &t); err != nil {
		return t, err
	}
	return t, d.Store.InsertTask(ctx, &t)
}

// takeWindow copies the service window of the stay in house a task serves onto it.
func (d Deps) takeWindow(ctx context.Context, t *domain.RoomTask) error {
	if t.BookingID == nil || !domain.CarriesWindow(t.Type) {
		return nil
	}
	stay, err := d.Store.Stay(ctx, *t.BookingID)
	if err != nil || stay == nil {
		return err
	}
	t.ServiceWindow = stay.ServiceWindow
	return nil
}

func (d Deps) inScope(p auth.Principal, v domain.Villa) bool {
	return p.Scope().AllowedVilla(v.ID, v.LocationID)
}

// PlanDay adds the day's missing departure, stayover and turndown tasks.
type PlanDay struct{ Deps }

// Planner signs the tasks housekeeping plans by itself, after a night audit or on start.
var Planner = auth.Principal{Name: "Day plan"}

// Handle plans the day and returns the new tasks.
func (h PlanDay) Handle(ctx context.Context, p auth.Principal, date string) ([]domain.RoomTask, error) {
	if err := h.need(ctx, p, "edit"); err != nil {
		return nil, err
	}
	if err := domain.ValidateTask(domain.TaskInput{UnitID: "-", Date: date, Type: domain.Departure}); err != nil {
		return nil, err
	}
	var created []domain.RoomTask
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if _, err := h.Store.ClaimDay(ctx, date); err != nil {
			return err
		}
		var err error
		created, err = h.plan(ctx, p, date)
		return err
	})
	return created, err
}

// Once plans every villa's date as Planner unless a plan already ran for it: the reaction to
// billing's night audit and the start-up plan of the current business date. It returns the new
// tasks, none when the day had a plan.
func (h PlanDay) Once(ctx context.Context, date string) ([]domain.RoomTask, error) {
	var created []domain.RoomTask
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		claimed, err := h.Store.ClaimDay(ctx, date)
		if err != nil || !claimed {
			return err
		}
		created, err = h.plan(ctx, Planner, date)
		return err
	})
	return created, err
}

// plan adds the missing tasks of the units in p's scope.
func (h PlanDay) plan(ctx context.Context, p auth.Principal, date string) ([]domain.RoomTask, error) {
	created := []domain.RoomTask{}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		settings, _, err := h.Store.Settings(ctx)
		if err != nil {
			return err
		}
		day, err := h.Store.DayTasks(ctx, date)
		if err != nil {
			return err
		}
		existing := map[string]bool{}
		for _, t := range day {
			if t.Status != domain.Cancelled {
				existing[t.UnitID+"|"+t.Type] = true
			}
		}
		units, err := h.Store.Units(ctx)
		if err != nil {
			return err
		}
		var mine []domain.PlanUnit
		for _, u := range units {
			v, err := h.Store.Villa(ctx, u.VillaID)
			if err != nil || !h.inScope(p, v) {
				continue
			}
			every, err := h.stayoverEvery(ctx, u, v)
			if err != nil {
				return err
			}
			mine = append(mine, domain.PlanUnit{ID: u.ID, VillaID: u.VillaID, Status: u.Status, StayoverEvery: every})
		}
		stays, err := h.Store.PlanStays(ctx)
		if err != nil {
			return err
		}
		dirty := map[string]bool{}
		if date == h.today() {
			if dirty, err = h.Store.DirtyUnits(ctx); err != nil {
				return err
			}
		}
		for _, pl := range domain.PlanTasks(domain.PlanInput{Date: date, Units: mine, Stays: stays, Dirty: dirty, Turndown: settings.Turndown, Existing: existing}) {
			if pl.Type == domain.Stayover {
				// One planned stayover per unit per day, even when two plans of the day race.
				claimed, err := h.Store.ClaimStayover(ctx, pl.UnitID, date)
				if err != nil {
					return err
				}
				if !claimed {
					continue
				}
			}
			t, err := h.newTask(ctx, p, pl, date, settings, "")
			if err != nil {
				return err
			}
			created = append(created, t)
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "housekeeping-task", EntityID: date, Summary: fmt.Sprintf("Planned %d housekeeping tasks for %s", len(created), date)})
	})
	return created, err
}

// stayoverEvery is the days between the unit's stayover cleans, from its villa and room type.
func (d Deps) stayoverEvery(ctx context.Context, u domain.Unit, v domain.Villa) (int, error) {
	var group *domain.Group
	if u.GroupID != nil {
		g, err := d.Store.Group(ctx, *u.GroupID)
		if err != nil && !errs.HasCode(err, errs.CodeNotFound) {
			return 0, err
		}
		if err == nil {
			group = &g
		}
	}
	return domain.StayoverEvery(v, domain.UnitKind(v, group)), nil
}

// AddTask adds one task by hand, optionally to an attendant on shift.
type AddTask struct{ Deps }

// Handle adds the task.
func (h AddTask) Handle(ctx context.Context, p auth.Principal, in domain.TaskInput) (domain.RoomTask, error) {
	var t domain.RoomTask
	if err := h.need(ctx, p, "edit"); err != nil {
		return t, err
	}
	if err := domain.ValidateTask(in); err != nil {
		return t, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		unit, err := h.Store.Unit(ctx, in.UnitID)
		if err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, unit.VillaID); err != nil {
			return err
		}
		if in.AttendantID != nil && *in.AttendantID != "" {
			staff, err := h.Clients.People.Day(ctx, in.Date)
			if err != nil {
				return err
			}
			if !domain.OnShift(staff, in.Date, *in.AttendantID) {
				return errs.New("NOT_ON_SHIFT", "That attendant is not on shift that day.")
			}
		}
		stay, err := h.Store.InHouse(ctx, unit.ID, in.Date)
		if err != nil {
			return err
		}
		var bookingID *string
		if stay != nil {
			bookingID = &stay.ID
		}
		settings, _, err := h.Store.Settings(ctx)
		if err != nil {
			return err
		}
		n, err := h.Store.Next(ctx, "roomTask")
		if err != nil {
			return err
		}
		note := strings.TrimSpace(in.Note)
		t = domain.NewTask(n, domain.Planned{UnitID: unit.ID, VillaID: unit.VillaID, Type: in.Type, BookingID: bookingID}, in.Date, settings, h.event("created", p, note))
		if in.AttendantID != nil && *in.AttendantID != "" {
			t.AttendantID = ptr(*in.AttendantID)
		}
		if err := h.takeWindow(ctx, &t); err != nil {
			return err
		}
		if err := h.Store.InsertTask(ctx, &t); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "housekeeping-task", EntityID: t.Number,
			Summary: fmt.Sprintf("Added %s for %s on %s", strings.ToLower(domain.TaskTypeLabel[t.Type]), unit.Code, t.Date)})
	})
	return t, err
}

// StayRequest is the body of POST /bookings/{id}/service-requests.
type StayRequest struct {
	Kind string `json:"kind"`
	Note string `json:"note"`
}

// RequestClean is the guest asking for a clean of their stay in house, which is how a villa stay
// without scheduled stayovers gets one: a stayover task for today on the stay's unit, carrying its
// service window. Asked twice in a day, it answers the open stayover already there. It needs
// booking/edit or maintenance/create.
type RequestClean struct{ Deps }

// Handle adds or finds the stayover task.
func (h RequestClean) Handle(ctx context.Context, p auth.Principal, bookingID string, in StayRequest) (domain.RoomTask, error) {
	var t domain.RoomTask
	if err := h.Authz.Require(ctx, p.Role, rbac.Need{Module: "booking", Action: "edit"}, rbac.Need{Module: "maintenance", Action: "create"}); err != nil {
		return t, err
	}
	if in.Kind != domain.ExtraClean {
		return t, errs.Invalid("kind", "Ask for a clean.")
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		stay, err := h.Store.Stay(ctx, bookingID)
		if err != nil {
			return err
		}
		if stay == nil {
			return errs.NotFound("booking", bookingID)
		}
		if stay.Status != "checked_in" {
			return errs.Newf("TASK_INVALID_STATE", "%s is not in house; a clean is asked during the stay.", stay.Code)
		}
		unit, err := h.Store.Unit(ctx, stay.UnitID)
		if err != nil {
			return err
		}
		villa, err := h.villaInScope(ctx, p, unit.VillaID)
		if err != nil {
			return err
		}
		today := h.today()
		day, err := h.Store.DayTasks(ctx, today)
		if err != nil {
			return err
		}
		for _, existing := range day {
			if existing.UnitID == unit.ID && existing.Type == domain.Stayover && domain.IsOpen(existing.Status) {
				t = existing
				return nil
			}
		}
		settings, _, err := h.Store.Settings(ctx)
		if err != nil {
			return err
		}
		note := joinNonEmpty(" · ", "Guest asked for a clean", strings.TrimSpace(in.Note))
		if t, err = h.newTask(ctx, p, domain.Planned{UnitID: unit.ID, VillaID: unit.VillaID, Type: domain.Stayover, BookingID: &stay.ID}, today, settings, note); err != nil {
			return err
		}
		if err := h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "housekeeping-task", EntityID: t.Number,
			Summary: fmt.Sprintf("%s asked for a clean of %s: %s", stay.Code, unit.Code, t.Number)}); err != nil {
			return err
		}
		return h.emit(ctx, housekeeping.EventCleanRequested, "housekeeping_task", t.ID, t.Version, housekeeping.CleanRequested{
			BookingID: stay.ID, UnitID: unit.ID, VillaID: villa.ID, LocationID: villa.LocationID, TaskID: t.ID, TaskNumber: t.Number, Note: note})
	})
	return t, err
}

// Assign gives tasks to an attendant on shift, or back to unassigned with nil.
type Assign struct{ Deps }

// Handle assigns the tasks.
func (h Assign) Handle(ctx context.Context, p auth.Principal, taskIDs []string, attendantID *string) ([]domain.RoomTask, error) {
	if err := h.need(ctx, p, "edit"); err != nil {
		return nil, err
	}
	if len(taskIDs) == 0 {
		return nil, errs.New(errs.CodeValidation, "Pick at least one task.")
	}
	if attendantID != nil && *attendantID == "" {
		attendantID = nil
	}
	var list []domain.RoomTask
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		staff := map[string]domain.StaffDay{}
		for _, id := range taskIDs {
			t, err := h.Store.Task(ctx, id)
			if err != nil {
				return err
			}
			if _, err := h.villaInScope(ctx, p, t.VillaID); err != nil {
				return err
			}
			list = append(list, t)
		}
		for _, t := range list {
			if !domain.IsOpen(t.Status) {
				return errs.Newf("TASK_INVALID_STATE", "%s is closed; it keeps its attendant.", t.Number)
			}
			if attendantID == nil {
				continue
			}
			day, ok := staff[t.Date]
			if !ok {
				var err error
				if day, err = h.Clients.People.Day(ctx, t.Date); err != nil {
					return err
				}
				staff[t.Date] = day
			}
			if !domain.OnShift(day, t.Date, *attendantID) {
				return errs.Newf("NOT_ON_SHIFT", "That attendant is not on shift on %s.", t.Date)
			}
		}
		name := "unassigned"
		if attendantID != nil {
			e, ok := staff[list[0].Date].Employee(*attendantID)
			if !ok {
				return errs.NotFound("employee", *attendantID)
			}
			name = e.Name
		}
		numbers := make([]string, len(list))
		for i := range list {
			list[i].AttendantID = attendantID
			list[i].History = append(list[i].History, h.event("assigned", p, name))
			if err := h.Store.UpdateTask(ctx, &list[i]); err != nil {
				return err
			}
			numbers[i] = list[i].Number
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "housekeeping-task", EntityID: strings.Join(numbers, ", "), Summary: fmt.Sprintf("Gave %d tasks to %s", len(list), name)})
	})
	return list, err
}

// AutoAssign spreads the day's unassigned pending tasks over the attendants on shift.
type AutoAssign struct{ Deps }

// Handle runs auto-assign and returns the tasks it gave out.
func (h AutoAssign) Handle(ctx context.Context, p auth.Principal, date string) ([]domain.RoomTask, error) {
	if err := h.need(ctx, p, "edit"); err != nil {
		return nil, err
	}
	changed := []domain.RoomTask{}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		settings, _, err := h.Store.Settings(ctx)
		if err != nil {
			return err
		}
		day, err := h.Store.DayTasks(ctx, date)
		if err != nil {
			return err
		}
		staff, err := h.Clients.People.Day(ctx, date)
		if err != nil {
			return err
		}
		location := func(villaID string) string {
			v, _ := h.Store.Villa(ctx, villaID)
			return v.LocationID
		}
		credits := domain.CreditsByAttendant(day)
		var loads []domain.Load
		for _, a := range domain.AttendantsOnShift(staff, date) {
			locs := make([]string, len(a.VillaIDs))
			for i, v := range a.VillaIDs {
				locs[i] = location(v)
			}
			loads = append(loads, domain.Load{ID: a.ID, VillaIDs: a.VillaIDs, LocationIDs: locs, Credits: credits[a.ID]})
		}
		var open []domain.Assignable
		for _, t := range day {
			if t.AttendantID != nil || t.Status != domain.Pending {
				continue
			}
			v, err := h.Store.Villa(ctx, t.VillaID)
			if err != nil || !h.inScope(p, v) {
				continue
			}
			u, err := h.Store.Unit(ctx, t.UnitID)
			if err != nil {
				return err
			}
			open = append(open, domain.Assignable{ID: t.ID, VillaID: t.VillaID, LocationID: v.LocationID, UnitCode: u.Code, Type: t.Type, Credits: t.Credits})
		}
		for _, g := range domain.AutoAssign(open, loads, settings.DailyQuota) {
			i := slices.IndexFunc(day, func(t domain.RoomTask) bool { return t.ID == g.TaskID })
			t := day[i]
			e, _ := staff.Employee(g.AttendantID)
			t.AttendantID = ptr(g.AttendantID)
			t.History = append(t.History, h.event("assigned", p, "Auto-assigned to "+e.Name))
			if err := h.Store.UpdateTask(ctx, &t); err != nil {
				return err
			}
			changed = append(changed, t)
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "housekeeping-task", EntityID: date, Summary: fmt.Sprintf("Auto-assigned %d of %d open tasks for %s", len(changed), len(open), date)})
	})
	return changed, err
}

// WorkInput is the body of POST housekeeping/tasks/{id}/{action}.
type WorkInput struct {
	Checklist []domain.Tick `json:"checklist"`
	Note      *string       `json:"note"`
	// OverrideReason is a supervisor's reason to start a task on a do not disturb stay.
	OverrideReason string `json:"overrideReason"`
}

// WorkTask is the attendant's start, pause, resume, done, dnd, refused or cancel.
type WorkTask struct{ Deps }

// Handle works the task.
func (h WorkTask) Handle(ctx context.Context, p auth.Principal, id, action string, in WorkInput) (domain.RoomTask, error) {
	var t domain.RoomTask
	if err := h.need(ctx, p, "submit"); err != nil {
		return t, err
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if t, err = h.Store.Task(ctx, id); err != nil {
			return err
		}
		if err := h.worker(ctx, p, t); err != nil {
			return err
		}
		to, err := domain.AssertAction(t, action)
		if err != nil {
			return err
		}
		unit, err := h.Store.Unit(ctx, t.UnitID)
		if err != nil {
			return err
		}
		villa, err := h.Store.Villa(ctx, t.VillaID)
		if err != nil {
			return err
		}
		now := h.now()
		if action == "done" {
			items := domain.Checklist[t.Type]
			for _, item := range items {
				if !slices.ContainsFunc(in.Checklist, func(x domain.Tick) bool { return x.Item == item && x.OK }) {
					return errs.New(errs.CodeValidation, "Tick every line of the checklist, or report what is wrong.")
				}
			}
			t.Checklist = make([]domain.Tick, len(items))
			for i, item := range items {
				t.Checklist[i] = domain.Tick{Item: item, OK: true}
			}
		}
		if action == "start" && t.Type == domain.Departure {
			if err := h.startDeparture(ctx, p, t, unit, villa); err != nil {
				return err
			}
		}
		if action == "start" {
			if err := h.checkDND(ctx, p, &t, in.OverrideReason); err != nil {
				return err
			}
		}
		if (action == "dnd" || action == "refused") && t.BookingID == nil {
			return errs.Newf("TASK_INVALID_STATE", "%s has no guest in house.", unit.Code)
		}
		if t.RunningSince != nil && (action == "pause" || action == "done" || action == "cancel") {
			t.WorkedMinutes += domain.MinutesBetween(*t.RunningSince, now)
			t.RunningSince = nil
		}
		if action == "start" || action == "resume" {
			t.RunningSince = ptr(now)
		}
		if action == "start" {
			t.StartedAt = ptr(now)
		}
		if action == "done" || action == "dnd" || action == "refused" {
			t.FinishedAt = ptr(now)
		}
		if action == "done" && t.Type == domain.Departure {
			// The used set goes to the soiled bags; the board waits for the supervisor's inspection.
			if err := h.bagRoomSet(ctx, unit); err != nil {
				return err
			}
			rec, err := h.boardRecord(ctx, p, unit.ID)
			if err != nil {
				return err
			}
			if rec.State == domain.Cleaning {
				rec.UpdatedOn, rec.UpdatedBy, rec.Note = h.today(), p.Name, "Cleaned by "+p.Name+", waiting for inspection"
				if err := h.Store.SaveRecord(ctx, &rec, unit.VillaID); err != nil {
					return err
				}
			}
		}
		before := t.Status
		t.Status = to
		note := ""
		if in.Note != nil {
			note = strings.TrimSpace(*in.Note)
		}
		if note != "" {
			t.Note = joinNonEmpty(" · ", t.Note, note)
		}
		t.History = append(t.History, domain.TaskEvent{Kind: action, By: p.Name, At: now, Note: note})
		if err := h.Store.UpdateTask(ctx, &t); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Status, Entity: "housekeeping-task", EntityID: t.Number,
			Summary: fmt.Sprintf("%s %s: %s", t.Number, unit.Code, strings.ToLower(domain.ActionLabel[action])),
			Before:  map[string]any{"status": before}, After: map[string]any{"status": to}})
	})
	return t, err
}

// checkDND refuses starting a task while the stay it serves asks not to be disturbed, reading the
// stay's current window; a supervisor goes in with a reason, which the task's note and history and
// the audit trail keep.
func (d Deps) checkDND(ctx context.Context, p auth.Principal, t *domain.RoomTask, override string) error {
	if err := d.takeWindow(ctx, t); err != nil {
		return err
	}
	supervisor, err := d.can(ctx, p, "approve")
	if err != nil {
		return err
	}
	reason, err := domain.CheckDND(t.ServiceWindow, supervisor, override)
	if err != nil || reason == "" {
		return err
	}
	t.Note = joinNonEmpty(" · ", t.Note, "Do not disturb overridden: "+reason)
	t.History = append(t.History, d.event("dnd_override", p, reason))
	return d.record(ctx, p, audit.Line{Action: audit.Approve, Entity: "housekeeping-task", EntityID: t.Number,
		Summary: fmt.Sprintf("%s went in on do not disturb for %s: %s", p.Name, t.Number, reason)})
}

// startDeparture refuses while the stay is still in and takes a dirty room to cleaning.
func (d Deps) startDeparture(ctx context.Context, p auth.Principal, t domain.RoomTask, unit domain.Unit, villa domain.Villa) error {
	if t.BookingID != nil {
		stay, err := d.Store.Stay(ctx, *t.BookingID)
		if err != nil {
			return err
		}
		if stay != nil && stay.Status == "checked_in" {
			return errs.Newf("TASK_INVALID_STATE", "%s has not checked out of %s yet.", stay.Code, unit.Code)
		}
	}
	rec, err := d.boardRecord(ctx, p, unit.ID)
	if err != nil {
		return err
	}
	if rec.State != domain.Dirty {
		return nil
	}
	rec.State, rec.UpdatedOn, rec.UpdatedBy, rec.Note = domain.Cleaning, d.today(), p.Name, t.Number+" started"
	if err := d.saveMove(ctx, p, &rec, unit, villa, domain.Dirty); err != nil {
		return err
	}
	return d.record(ctx, p, audit.Line{Action: audit.Status, Entity: "housekeeping", EntityID: unit.Code, Summary: unit.Code + " dirty to cleaning",
		Before: map[string]any{"state": domain.Dirty}, After: map[string]any{"state": domain.Cleaning}})
}

// bagRoomSet adds the unit's room set from its type's linen par to the villa's soiled bags.
func (d Deps) bagRoomSet(ctx context.Context, unit domain.Unit) error {
	if unit.GroupID == nil {
		return nil
	}
	par, err := d.Store.Par(ctx, *unit.GroupID)
	if err != nil || par == nil {
		return err
	}
	return d.Store.AddSoiled(ctx, unit.VillaID, par.Lines, 1)
}

func joinNonEmpty(sep string, parts ...string) string {
	var kept []string
	for _, s := range parts {
		if s != "" {
			kept = append(kept, s)
		}
	}
	return strings.Join(kept, sep)
}

// IssueInput is TaskIssueInput.
type IssueInput struct {
	Category    string `json:"category"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Urgent      bool   `json:"urgent"`
}

// IssueResult answers POST housekeeping/tasks/{id}/issues.
type IssueResult struct {
	Task        domain.RoomTask `json:"task"`
	WorkOrderID string          `json:"workOrderId"`
}

// ReportIssue opens a work order for a fault found during a task.
type ReportIssue struct{ Deps }

// Handle reports the issue.
func (h ReportIssue) Handle(ctx context.Context, p auth.Principal, id string, in IssueInput) (IssueResult, error) {
	var out IssueResult
	if err := h.need(ctx, p, "create"); err != nil {
		return out, err
	}
	title := strings.TrimSpace(in.Title)
	if len([]rune(title)) < 4 {
		return out, errs.Invalid("title", "Say what needs fixing.")
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		t, err := h.Store.Task(ctx, id)
		if err != nil {
			return err
		}
		if err := h.worker(ctx, p, t); err != nil {
			return err
		}
		unit, err := h.Store.Unit(ctx, t.UnitID)
		if err != nil {
			return err
		}
		priority := "normal"
		if in.Urgent {
			priority = "urgent"
		}
		w, err := h.Clients.WorkOrders.Open(ctx, p, NewWorkOrder{VillaID: t.VillaID, UnitID: t.UnitID, Source: "inspection", Category: in.Category, Priority: priority,
			Title: unit.Code + ": " + title, Description: joinNonEmpty(" · ", strings.TrimSpace(in.Description), "Found during "+t.Number)})
		if err != nil {
			return err
		}
		t.WorkOrderIDs = append(t.WorkOrderIDs, w.ID)
		t.History = append(t.History, h.event("issue", p, w.Number+" "+title))
		if err := h.Store.UpdateTask(ctx, &t); err != nil {
			return err
		}
		out = IssueResult{Task: t, WorkOrderID: w.ID}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "housekeeping-task", EntityID: t.Number, Summary: fmt.Sprintf("%s reported %s", t.Number, w.Number)})
	})
	return out, err
}

// LostFoundInput is the body of POST housekeeping/tasks/{id}/lost-found.
type LostFoundInput struct {
	Note string  `json:"note"`
	Ref  *string `json:"ref"`
}

// NoteLostFound records a find on a task; without a ref it logs a lost and found item first.
type NoteLostFound struct{ Deps }

// Handle notes the find.
func (h NoteLostFound) Handle(ctx context.Context, p auth.Principal, id string, in LostFoundInput) (domain.RoomTask, error) {
	var t domain.RoomTask
	if err := h.need(ctx, p, "submit"); err != nil {
		return t, err
	}
	note := strings.TrimSpace(in.Note)
	if len([]rune(note)) < 3 {
		return t, errs.Invalid("note", "Say what was found and where.")
	}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		var err error
		if t, err = h.Store.Task(ctx, id); err != nil {
			return err
		}
		if err := h.worker(ctx, p, t); err != nil {
			return err
		}
		ref := in.Ref
		if ref == nil || *ref == "" {
			item, err := h.Clients.LostFound.Log(ctx, p, LostFind{FoundOn: h.today(), VillaID: t.VillaID, UnitID: t.UnitID,
				Where: domain.TaskTypeLabel[t.Type] + ", " + t.Number, Description: in.Note, BookingID: t.BookingID})
			if err != nil {
				return err
			}
			ref = &item
		}
		t.LostFound = append(t.LostFound, domain.LostFoundNote{Note: note, Ref: ref, By: p.Name, At: h.now()})
		t.History = append(t.History, h.event("lost_found", p, note))
		if err := h.Store.UpdateTask(ctx, &t); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "housekeeping-task", EntityID: t.Number, Summary: fmt.Sprintf("%s found: %s", t.Number, note)})
	})
	return t, err
}
