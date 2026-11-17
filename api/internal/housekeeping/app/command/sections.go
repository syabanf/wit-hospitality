package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

// AssignSection gives a section's rooms to an attendant on shift for a day, or clears the day with
// a nil attendant, and moves the day's pending tasks on those rooms with it.
type AssignSection struct{ Deps }

// Handle saves the section's attendant and returns the tasks that changed hands.
func (h AssignSection) Handle(ctx context.Context, p auth.Principal, in domain.SectionInput) ([]domain.RoomTask, error) {
	if err := h.need(ctx, p, "edit"); err != nil {
		return nil, err
	}
	if err := domain.ValidateSectionInput(in); err != nil {
		return nil, err
	}
	if in.AttendantID != nil && *in.AttendantID == "" {
		in.AttendantID = nil
	}
	changed := []domain.RoomTask{}
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		section, err := h.Store.Section(ctx, in.SectionID)
		if err != nil {
			return err
		}
		if _, err := h.villaInScope(ctx, p, section.VillaID); err != nil {
			return err
		}
		name := "unassigned"
		if in.AttendantID != nil {
			staff, err := h.Clients.People.Day(ctx, in.Date)
			if err != nil {
				return err
			}
			if !domain.OnShift(staff, in.Date, *in.AttendantID) {
				return errs.Newf("NOT_ON_SHIFT", "That attendant is not on shift on %s.", in.Date)
			}
			e, ok := staff.Employee(*in.AttendantID)
			if !ok {
				return errs.NotFound("employee", *in.AttendantID)
			}
			name = e.Name
		}
		held, err := h.Store.SectionAttendant(ctx, section.ID, in.Date)
		if err != nil {
			return err
		}
		if err := h.Store.SaveSectionAttendant(ctx, section.ID, in.Date, in.AttendantID); err != nil {
			return err
		}
		day, err := h.Store.DayTasks(ctx, in.Date)
		if err != nil {
			return err
		}
		for _, i := range domain.SectionHandover(day, section, in.Date, in.AttendantID, held) {
			t := day[i]
			t.AttendantID = in.AttendantID
			t.History = append(t.History, h.event("assigned", p, section.Name+": "+name))
			if err := h.Store.UpdateTask(ctx, &t); err != nil {
				return err
			}
			changed = append(changed, t)
		}
		summary := fmt.Sprintf("Gave %s to %s on %s: %d tasks", section.Name, name, in.Date, len(changed))
		if in.AttendantID == nil {
			summary = fmt.Sprintf("Cleared %s on %s: %d tasks back to unassigned", section.Name, in.Date, len(changed))
		}
		return h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "housekeeping-section", EntityID: section.ID, Summary: summary})
	})
	return changed, err
}
