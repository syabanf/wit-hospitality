package command_test

import (
	"context"
	"slices"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func TestASectionGoesToOneAttendantForTheDayAndLaterTasksFollow(t *testing.T) {
	t.Parallel()
	e := setup(t)
	// The seed's own floor sections and attendants stand aside for this test's section.
	if _, err := e.db.Pool.Exec(context.Background(), `DELETE FROM housekeeping.section_assignments; DELETE FROM housekeeping.cat_sections`); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Pool.Exec(context.Background(), `INSERT INTO housekeeping.cat_sections (id, villa_id, name, unit_ids, version)
		VALUES ('sec-ground-floor-1', 'vil-saka', 'Ground floor', '["unit-sk-02", "unit-sk-03", "unit-sk-04"]', 1)`); err != nil {
		t.Fatal(err)
	}
	staff, _ := e.staff.Day(context.Background(), today)
	var other domain.Attendant
	for _, a := range domain.AttendantsOnShift(staff, today) {
		if a.ID != "emp-003" {
			other = a
			break
		}
	}
	if other.ID == "" {
		t.Fatal("the seed has a second attendant on shift")
	}
	name, _ := staff.Employee(other.ID)
	assign := command.AssignSection{Deps: e.deps}
	if _, err := assign.Handle(as(kadek), kadek, domain.SectionInput{SectionID: "sec-nope", Date: today, AttendantID: ptr(other.ID)}); code(err) != errs.CodeNotFound {
		t.Fatalf("unknown section: %v", err)
	}
	if _, err := assign.Handle(as(kadek), kadek, domain.SectionInput{SectionID: "sec-ground-floor-1", Date: "today", AttendantID: ptr(other.ID)}); code(err) != errs.CodeValidation {
		t.Fatalf("a day that is not a date: %v", err)
	}
	_, err := assign.Handle(as(kadek), kadek, domain.SectionInput{SectionID: "sec-ground-floor-1", Date: today, AttendantID: ptr("emp-002")})
	if code(err) != "NOT_ON_SHIFT" || err.(*errs.Error).Message != "That attendant is not on shift on "+today+"." {
		t.Fatalf("off shift: %v", err)
	}
	lumbung := sari
	lumbung.VillaIDs = []string{"vil-lumbung"}
	if _, err := assign.Handle(as(lumbung), lumbung, domain.SectionInput{SectionID: "sec-ground-floor-1", Date: today, AttendantID: ptr(other.ID)}); code(err) != errs.CodeForbidden {
		t.Fatalf("a section outside the scope: %v", err)
	}

	given, err := assign.Handle(as(kadek), kadek, domain.SectionInput{SectionID: "sec-ground-floor-1", Date: today, AttendantID: ptr(other.ID)})
	if err != nil {
		t.Fatal(err)
	}
	ids := func(ts []domain.RoomTask) []string {
		var out []string
		for _, t := range ts {
			out = append(out, t.ID)
		}
		return out
	}
	if !slices.Equal(ids(given), []string{"hkt-75", "hkt-76"}) {
		t.Fatalf("the pending rooms of the section change hands, the done stayover stays: %v", ids(given))
	}
	for _, task := range given {
		last := task.History[len(task.History)-1]
		if *task.AttendantID != other.ID || last.Kind != "assigned" || last.Note != "Ground floor: "+name.Name {
			t.Fatalf("%s: %v %+v", task.ID, *task.AttendantID, last)
		}
	}
	added, err := command.AddTask{Deps: e.deps}.Handle(as(kadek), kadek, domain.TaskInput{UnitID: "unit-sk-03", Date: today, Type: domain.Inspection})
	if err != nil || added.AttendantID == nil || *added.AttendantID != other.ID {
		t.Fatalf("a task added later starts with the section's attendant: %v %+v", err, added.AttendantID)
	}
	elsewhere, err := command.AddTask{Deps: e.deps}.Handle(as(kadek), kadek, domain.TaskInput{UnitID: "unit-sk-06", Date: today, Type: domain.Inspection})
	if err != nil || elsewhere.AttendantID != nil {
		t.Fatalf("a room outside the section starts unassigned: %v %+v", err, elsewhere.AttendantID)
	}
	held, err := e.queries.SectionAssignments(as(kadek))
	if err != nil || len(held) != 1 || held[0] != (domain.SectionAssignment{SectionID: "sec-ground-floor-1", Date: today, AttendantID: other.ID}) {
		t.Fatalf("assignments %v %+v", err, held)
	}

	freed, err := assign.Handle(as(kadek), kadek, domain.SectionInput{SectionID: "sec-ground-floor-1", Date: today})
	if err != nil || !slices.Equal(ids(freed), []string{"hkt-75", "hkt-76", added.ID}) {
		t.Fatalf("clearing frees what the attendant held: %v %v", err, ids(freed))
	}
	if last := freed[0].History[len(freed[0].History)-1]; freed[0].AttendantID != nil || last.Note != "Ground floor: unassigned" {
		t.Fatalf("freed %+v", last)
	}
	if held, _ := e.queries.SectionAssignments(as(kadek)); len(held) != 0 {
		t.Fatalf("the day is cleared: %+v", held)
	}
	var summary string
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT summary FROM platform.audit_log WHERE entity = 'housekeeping-section' ORDER BY recorded_at DESC, id DESC LIMIT 1`).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if summary != "Cleared Ground floor on "+today+": 3 tasks back to unassigned" {
		t.Fatalf("audit %q", summary)
	}
}

func TestARoomMoveLeavesTheOldRoomDirty(t *testing.T) {
	t.Parallel()
	e := setup(t)
	if _, err := (command.SetState{Deps: e.deps}).Handle(as(kadek), kadek, "unit-sk-05", "dirty", ""); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"cleaning", "inspected", "ready"} {
		if _, err := (command.SetState{Deps: e.deps}).Handle(as(kadek), kadek, "unit-sk-05", s, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := (command.MovedOut{Deps: e.deps}).Handle(context.Background(), "unit-sk-05", "BK-1310", "unit-sk-06", "Front desk"); err != nil {
		t.Fatal(err)
	}
	var state, note, by string
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT state, doc->>'note', doc->>'updatedBy' FROM housekeeping.board WHERE unit_id = 'unit-sk-05'`).Scan(&state, &note, &by); err != nil {
		t.Fatal(err)
	}
	if state != domain.Dirty || note != "BK-1310 moved to SK-06" || by != "Front desk" {
		t.Fatalf("board %s %q %s", state, note, by)
	}
}
