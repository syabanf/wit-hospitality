package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
)

// A guest in house asks for a clean: one stayover task today carrying the stay's window. On a do
// not disturb stay the task starts only with a supervisor's reason.
func TestGuestCleanRequestAndDoNotDisturb(t *testing.T) {
	e := setup(t)
	if _, err := e.db.Pool.Exec(context.Background(), `
		INSERT INTO housekeeping.stays (id, code, unit_id, unit_assigned, status, check_in, check_out, service_window, version)
		VALUES ('bk-t1', 'BK-T1', 'unit-lb-03', true, 'checked_in', '2026-11-10', '2026-11-14', '{"mode": "dnd", "from": "", "to": ""}', 1),
		       ('bk-t2', 'BK-T2', 'unit-lb-04', true, 'confirmed', '2026-11-12', '2026-11-14', NULL, 1)`); err != nil {
		t.Fatal(err)
	}
	clean := command.RequestClean{Deps: e.deps}
	if _, err := clean.Handle(context.Background(), kadek, "bk-t1", command.StayRequest{Kind: "towels"}); code(err) != "VALIDATION_ERROR" {
		t.Fatalf("unknown kind: %v", err)
	}
	if _, err := clean.Handle(context.Background(), kadek, "bk-t2", command.StayRequest{Kind: "clean"}); code(err) != "TASK_INVALID_STATE" {
		t.Fatalf("a stay not in house: %v", err)
	}
	if _, err := clean.Handle(context.Background(), ida, "bk-t1", command.StayRequest{Kind: "clean"}); code(err) != "FORBIDDEN" {
		t.Fatalf("finance asking for a clean: %v", err)
	}
	task, err := clean.Handle(context.Background(), kadek, "bk-t1", command.StayRequest{Kind: "clean", Note: "After lunch"})
	if err != nil {
		t.Fatal(err)
	}
	if task.Type != domain.Stayover || task.Date != today || task.BookingID == nil || *task.BookingID != "bk-t1" ||
		task.ServiceWindow == nil || task.ServiceWindow.Mode != domain.WindowDND || task.Note != "Guest asked for a clean · After lunch" {
		t.Fatalf("task %+v", task)
	}
	again, err := clean.Handle(context.Background(), kadek, "bk-t1", command.StayRequest{Kind: "clean"})
	if err != nil || again.ID != task.ID {
		t.Fatalf("asked twice: %v %s", err, again.ID)
	}
	work := command.WorkTask{Deps: e.deps}
	if _, err := work.Handle(context.Background(), kadek, task.ID, "start", command.WorkInput{}); code(err) != domain.CodeTaskDND {
		t.Fatalf("start on dnd: %v", err)
	}
	started, err := work.Handle(context.Background(), kadek, task.ID, "start", command.WorkInput{OverrideReason: "Water leak reported below"})
	if err != nil || started.Status != domain.InProgress {
		t.Fatalf("supervisor override: %v %+v", err, started)
	}
	last := started.History[len(started.History)-2]
	if last.Kind != "dnd_override" || last.Note != "Water leak reported below" {
		t.Fatalf("history %+v", started.History)
	}
}
