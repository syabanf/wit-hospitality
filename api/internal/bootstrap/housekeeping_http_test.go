package bootstrap_test

import (
	"context"
	"net/http"
	"testing"
)

type taskRow struct {
	ID          string  `json:"id"`
	Number      string  `json:"number"`
	UnitID      string  `json:"unitId"`
	Status      string  `json:"status"`
	AttendantID *string `json:"attendantId"`
}

func TestHousekeepingAutoAssignGivesKarangToItsAttendant(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	r := c.do("POST", "housekeeping/tasks", map[string]any{"unitId": "unit-kr-02", "date": "2026-11-11", "type": "inspection", "attendantId": nil, "note": ""})
	if r.status != http.StatusCreated {
		t.Fatalf("add: %d %+v", r.status, r.Error)
	}
	added := decode[taskRow](t, r)
	given := decode[[]taskRow](t, c.do("POST", "housekeeping/tasks/auto-assign", map[string]string{"date": "2026-11-11"}))
	if len(given) != 2 {
		t.Fatalf("the deep clean and the inspection go out: %+v", given)
	}
	for _, task := range decode[[]taskRow](t, c.do("GET", "housekeeping/tasks", nil)) {
		if task.ID == added.ID && (task.AttendantID == nil || *task.AttendantID != "emp-012") {
			t.Fatalf("the read shows the assignment: %+v", task)
		}
	}
	refused(t, c.do("POST", "housekeeping/tasks/assign", map[string]any{"taskIds": []string{added.ID}, "attendantId": "emp-002"}), http.StatusConflict, "NOT_ON_SHIFT")
	finance := s.client(t)
	finance.login("ida")
	refused(t, finance.do("POST", "housekeeping/tasks/auto-assign", map[string]string{"date": "2026-11-11"}), http.StatusForbidden, "FORBIDDEN")
}

func TestAnAttendantFinishesADepartureOnThePhone(t *testing.T) {
	t.Parallel()
	s := start(t)
	sup := s.client(t)
	sup.login("kadek")
	if r := sup.do("PUT", "housekeeping/unit-sk-05", map[string]string{"state": "dirty", "note": ""}); r.status != http.StatusOK {
		t.Fatalf("board: %d %+v", r.status, r.Error)
	}
	task := decode[taskRow](t, sup.do("POST", "housekeeping/tasks", map[string]any{"unitId": "unit-sk-05", "date": "2026-11-11", "type": "departure", "attendantId": "emp-003", "note": ""}))
	sari := s.client(t)
	sari.login("sari")
	refused(t, sari.do("POST", "housekeeping/tasks/hkt-97/start", map[string]any{}), http.StatusConflict, "TASK_INVALID_STATE")
	refused(t, sari.do("POST", "housekeeping/tasks/hkt-105/start", map[string]any{}), http.StatusConflict, "TASK_NOT_YOURS")
	if r := sari.do("POST", "housekeeping/tasks/"+task.ID+"/start", map[string]any{}); r.status != http.StatusOK || decode[taskRow](t, r).Status != "in_progress" {
		t.Fatalf("start: %d %+v", r.status, r.Error)
	}
	checklist := []map[string]any{}
	for _, item := range []string{"Strip the beds and bag the linen", "Make the beds with fresh linen", "Clean the bathroom and replace towels", "Dust, vacuum and mop", "Restock amenities and minibar", "Empty the bins"} {
		checklist = append(checklist, map[string]any{"item": item, "ok": true})
	}
	refused(t, sari.do("POST", "housekeeping/tasks/"+task.ID+"/done", map[string]any{"checklist": checklist[1:]}), http.StatusUnprocessableEntity, "VALIDATION_ERROR")
	if r := sari.do("POST", "housekeeping/tasks/"+task.ID+"/done", map[string]any{"checklist": checklist, "note": "Fresh flowers"}); r.status != http.StatusOK || decode[taskRow](t, r).Status != "done" {
		t.Fatalf("done: %d %+v", r.status, r.Error)
	}
	for _, rec := range decode[[]struct {
		UnitID string `json:"unitId"`
		State  string `json:"state"`
		Note   string `json:"note"`
	}](t, sup.do("GET", "housekeeping", nil)) {
		if rec.UnitID == "unit-sk-05" && (rec.State != "cleaning" || rec.Note != "Cleaned by Ni Luh Putu Sari, waiting for inspection") {
			t.Fatalf("board after the clean: %+v", rec)
		}
	}
	for _, bag := range decode[[]struct {
		VillaID  string `json:"villaId"`
		ItemID   string `json:"itemId"`
		Quantity int    `json:"quantity"`
	}](t, sup.do("GET", "linen/soiled", nil)) {
		if bag.VillaID == "vil-saka" && bag.ItemID == "stk-ln-towel" && bag.Quantity != 4 {
			t.Fatalf("the used set goes to the soiled bags: %+v", bag)
		}
	}
}

func TestALaundryBatchComesBackShort(t *testing.T) {
	t.Parallel()
	s := start(t)
	c := s.client(t)
	c.login("kadek")
	r := c.do("POST", "laundry/batches", map[string]any{"villaId": "vil-saka", "vendor": "Bersih Laundry", "sentOn": "2026-11-11", "note": "", "lines": []map[string]any{{"itemId": "stk-ln-towel", "quantity": 2}}})
	if r.status != http.StatusCreated {
		t.Fatalf("send: %d %+v", r.status, r.Error)
	}
	batch := decode[struct {
		ID     string `json:"id"`
		Number string `json:"number"`
	}](t, r)
	back := c.do("POST", "laundry/batches/"+batch.ID+"/return", map[string]any{"returnedOn": "2026-11-11", "lines": []map[string]any{{"itemId": "stk-ln-towel", "returned": 1, "damaged": 0}}, "cost": 90000, "method": "cash", "reference": "", "attachments": []any{}})
	returned := decode[struct {
		Status    string   `json:"status"`
		WriteOffs []string `json:"writeOffs"`
	}](t, back)
	if back.status != http.StatusOK || returned.Status != "returned" || len(returned.WriteOffs) != 1 {
		t.Fatalf("return: %d %+v %+v", back.status, back.Error, returned)
	}
	refused(t, c.do("POST", "laundry/batches/"+batch.ID+"/return", map[string]any{"returnedOn": "2026-11-11", "lines": []any{}, "cost": 0, "method": "cash", "reference": "", "attachments": []any{}}), http.StatusConflict, "LAUNDRY_INVALID_STATE")
	var discarded, billed int
	ctx := context.Background()
	_ = s.db.Pool.QueryRow(ctx, `SELECT count(*) FROM platform.outbox WHERE event_type = 'housekeeping.linen.discarded.v1'`).Scan(&discarded)
	_ = s.db.Pool.QueryRow(ctx, `SELECT count(*) FROM platform.outbox WHERE event_type = 'housekeeping.laundry.billed.v1' AND payload->>'reference' = $1`, batch.Number).Scan(&billed)
	if discarded != 1 || billed != 1 {
		t.Fatalf("events: discarded %d, billed %d", discarded, billed)
	}
}
