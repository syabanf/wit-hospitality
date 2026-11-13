package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
)

// Housekeeping plans a day by itself once, as the day plan; a second run, or a day a supervisor
// already planned, adds nothing.
func TestPlanDayOncePlansEachDayOnce(t *testing.T) {
	e := setup(t)
	plan := command.PlanDay{Deps: e.deps}
	ctx := context.Background()
	created, err := plan.Once(ctx, "2026-11-12")
	if err != nil || len(created) == 0 {
		t.Fatalf("first plan: %v %d tasks", err, len(created))
	}
	for _, task := range created {
		if task.Date != "2026-11-12" || task.History[0].By != command.Planner.Name {
			t.Fatalf("planned task %+v", task)
		}
	}
	if again, err := plan.Once(ctx, "2026-11-12"); err != nil || len(again) != 0 {
		t.Fatalf("second plan: %v %d tasks", err, len(again))
	}
	if _, err := plan.Handle(as(kadek), kadek, "2026-11-13"); err != nil {
		t.Fatal(err)
	}
	if after, err := plan.Once(ctx, "2026-11-13"); err != nil || len(after) != 0 {
		t.Fatalf("a day a supervisor planned: %v %d tasks", err, len(after))
	}
}
