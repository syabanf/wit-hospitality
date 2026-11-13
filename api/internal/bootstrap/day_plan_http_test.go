package bootstrap_test

import (
	"context"
	"net/http"
	"testing"
)

// dayTasks counts the housekeeping tasks on day by type.
func dayTasks(t *testing.T, c *client, day string) map[string]int {
	t.Helper()
	out := map[string]int{}
	for _, task := range decode[[]map[string]any](t, c.do("GET", "housekeeping/tasks", nil)) {
		if task["date"] == day {
			out[task["type"].(string)]++
		}
	}
	return out
}

// Closing the business date plans the new one: its departures and stayovers are on the board
// without anyone planning the day.
func TestNightAuditPlansTheNewDay(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	if before := dayTasks(t, c, "2026-11-12"); len(before) != 0 {
		t.Fatalf("the seed has tasks on the next day: %v", before)
	}
	r := c.do("POST", "night-audits", map[string]any{"date": "2026-11-11", "checks": map[string]int{"arrivals": 0}, "noShows": []string{}})
	if r.status != http.StatusCreated {
		t.Fatalf("audit: %d %+v", r.status, r.Error)
	}
	planned := dayTasks(t, c, "2026-11-12")
	if planned["departure"] == 0 && planned["stayover"] == 0 {
		t.Fatalf("the new business date has no tasks: %v", planned)
	}
	if again := c.do("POST", "housekeeping/tasks/plan", map[string]string{"date": "2026-11-12"}); len(decode[[]map[string]any](t, again)) != 0 {
		t.Fatalf("a plan after the audit finds the day planned: %s", again.Data)
	}
}

// Start-up plans the current business date once: a deployment without the day's tasks gets them,
// and a second start adds nothing.
func TestStartPlansTheBusinessDayOnce(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	ctx := context.Background()
	if _, err := s.db.Pool.Exec(ctx, `DELETE FROM housekeeping.tasks WHERE day = '2026-11-11' AND doc->>'type' IN ('departure', 'stayover')`); err != nil {
		t.Fatal(err)
	}
	before := dayTasks(t, c, "2026-11-11")
	if err := s.app.PlanBusinessDay(ctx); err != nil {
		t.Fatal(err)
	}
	var planned bool
	if err := s.db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM housekeeping.planned_days WHERE day = '2026-11-11')`).Scan(&planned); err != nil || !planned {
		t.Fatalf("start-up did not plan the business date: %v", err)
	}
	first := dayTasks(t, c, "2026-11-11")
	if first["stayover"] <= before["stayover"] && first["departure"] <= before["departure"] && first["turndown"] <= before["turndown"] {
		t.Fatalf("start-up added no task: before %v, after %v", before, first)
	}
	if err := s.app.PlanBusinessDay(ctx); err != nil {
		t.Fatal(err)
	}
	if second := dayTasks(t, c, "2026-11-11"); len(second) != len(first) || second["stayover"] != first["stayover"] || second["departure"] != first["departure"] {
		t.Fatalf("a second start planned again: %v then %v", first, second)
	}
}
