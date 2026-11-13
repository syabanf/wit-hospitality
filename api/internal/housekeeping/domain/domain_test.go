package domain_test

import (
	"reflect"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func code(err error) string {
	if e, ok := errs.As(err); ok {
		return e.Code
	}
	return ""
}

func ptr(s string) *string { return &s }

func TestAutoAssignKeepsAVillaWithOneAttendantAndStopsAtTheQuota(t *testing.T) {
	tasks := []domain.Assignable{
		{ID: "a1", VillaID: "vil-a", LocationID: "loc-1", UnitCode: "A-02", Type: domain.Stayover, Credits: 0.5},
		{ID: "a2", VillaID: "vil-a", LocationID: "loc-1", UnitCode: "A-01", Type: domain.Departure, Credits: 1},
		{ID: "b1", VillaID: "vil-b", LocationID: "loc-1", UnitCode: "B-01", Type: domain.Deep, Credits: 2},
		{ID: "c1", VillaID: "vil-c", LocationID: "loc-2", UnitCode: "C-01", Type: domain.Departure, Credits: 1},
	}
	attendants := []domain.Load{
		{ID: "emp-1", VillaIDs: []string{"vil-a"}, LocationIDs: []string{"loc-1"}},
		{ID: "emp-2", VillaIDs: []string{"vil-a", "vil-b"}, LocationIDs: []string{"loc-1"}, Credits: 1},
	}
	got := domain.AutoAssign(tasks, attendants, 3)
	// Villa B has the most work and goes first to its only attendant; villa A then fits whole on
	// emp-1 in unit order; villa C has nobody in its location and stays for the supervisor.
	want := []domain.Given{{TaskID: "b1", AttendantID: "emp-2"}, {TaskID: "a2", AttendantID: "emp-1"}, {TaskID: "a1", AttendantID: "emp-1"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	if got := domain.AutoAssign(tasks, attendants, 1); len(got) != 1 || got[0].TaskID != "a2" {
		t.Fatalf("a quota of one credit: %+v", got)
	}
}

func TestAutoAssignSpillsOverToTheNextAttendantWithRoom(t *testing.T) {
	tasks := []domain.Assignable{
		{ID: "t1", VillaID: "v", UnitCode: "U-01", Type: domain.Departure, Credits: 1},
		{ID: "t2", VillaID: "v", UnitCode: "U-02", Type: domain.Departure, Credits: 1},
		{ID: "t3", VillaID: "v", UnitCode: "U-03", Type: domain.Departure, Credits: 1},
	}
	attendants := []domain.Load{{ID: "x", VillaIDs: []string{"v"}}, {ID: "y", VillaIDs: []string{"v"}}}
	got := domain.AutoAssign(tasks, attendants, 2)
	want := []domain.Given{{"t1", "x"}, {"t2", "x"}, {"t3", "y"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestTaskActions(t *testing.T) {
	task := domain.RoomTask{Number: "HK-4001", Type: domain.Departure, Status: domain.Pending}
	if to, err := domain.AssertAction(task, "start"); err != nil || to != domain.InProgress {
		t.Fatalf("start: %v %v", to, err)
	}
	_, err := domain.AssertAction(task, "dnd")
	if code(err) != "TASK_INVALID_STATE" || err.(*errs.Error).Message != "Departure clean has no guest to answer the door." {
		t.Fatalf("dnd on a departure: %v", err)
	}
	task.Status = domain.Done
	_, err = domain.AssertAction(task, "pause")
	if err == nil || err.(*errs.Error).Message != "HK-4001 is done; it cannot pause now." {
		t.Fatalf("pause a done task: %v", err)
	}
	stay := domain.RoomTask{Type: domain.Stayover, Status: domain.Pending}
	if to, err := domain.AssertAction(stay, "refused"); err != nil || to != domain.Refused {
		t.Fatalf("refused: %v %v", to, err)
	}
}

func TestPlanTasks(t *testing.T) {
	units := []domain.PlanUnit{{ID: "u1", VillaID: "v", StayoverEvery: 1}, {ID: "u2", VillaID: "v", StayoverEvery: 1}, {ID: "u3", VillaID: "v"}, {ID: "u4", VillaID: "v", Status: "inactive"}}
	stays := []domain.PlanStay{{ID: "b1", UnitID: "u1", CheckIn: "2026-10-28", CheckOut: "2026-10-30"}, {ID: "b2", UnitID: "u2", CheckIn: "2026-10-29", CheckOut: "2026-11-02"}}
	got := domain.PlanTasks(domain.PlanInput{Date: "2026-10-30", Units: units, Stays: stays, Dirty: map[string]bool{"u3": true, "u4": true}, Turndown: true, Existing: map[string]bool{"u2|turndown": true}})
	var kinds []string
	for _, p := range got {
		kinds = append(kinds, p.UnitID+" "+p.Type)
	}
	if !reflect.DeepEqual(kinds, []string{"u1 departure", "u2 stayover", "u3 departure"}) {
		t.Fatalf("plan %v", kinds)
	}
	if *got[0].BookingID != "b1" || got[2].BookingID != nil {
		t.Fatal("a departure after a stay names it; a dirty room names none")
	}
}

func TestStayoverSchedule(t *testing.T) {
	hotel := domain.Villa{Operation: domain.OperationHotel, StayoverEvery: 2}
	mixed := domain.Villa{Operation: domain.OperationMixed, StayoverEvery: 1}
	villa := domain.Villa{Operation: "villa", StayoverEvery: 0}
	room, villaKind := &domain.Group{Kind: domain.KindRoom}, &domain.Group{Kind: domain.KindVilla}
	for name, c := range map[string]struct{ got, want int }{
		"hotel room without a type":   {domain.StayoverEvery(hotel, domain.UnitKind(hotel, nil)), 2},
		"mixed room":                  {domain.StayoverEvery(mixed, domain.UnitKind(mixed, room)), 1},
		"mixed villa":                 {domain.StayoverEvery(mixed, domain.UnitKind(mixed, villaKind)), 0},
		"mixed unit without a type":   {domain.StayoverEvery(mixed, domain.UnitKind(mixed, nil)), 0},
		"villa without stayovers":     {domain.StayoverEvery(villa, domain.UnitKind(villa, villaKind)), 0},
		"villa with a stayover gap 3": {domain.StayoverEvery(domain.Villa{Operation: "villa", StayoverEvery: 3}, domain.KindVilla), 3},
	} {
		if c.got != c.want {
			t.Errorf("%s: every %d, want %d", name, c.got, c.want)
		}
	}
	due := func(day string, every int) bool { return domain.StayoverDue("2026-11-10", day, every) }
	if due("2026-11-10", 1) || !due("2026-11-11", 1) || due("2026-11-11", 2) || !due("2026-11-12", 2) || due("2026-11-12", 0) {
		t.Fatal("a stayover falls every n days after arrival, never on arrival, never with a gap of 0")
	}
	stays := []domain.PlanStay{{ID: "b1", UnitID: "u1", CheckIn: "2026-11-10", CheckOut: "2026-11-14"}}
	plan := func(day string) []domain.Planned {
		return domain.PlanTasks(domain.PlanInput{Date: day, Units: []domain.PlanUnit{{ID: "u1", VillaID: "v", StayoverEvery: 2}}, Stays: stays})
	}
	if len(plan("2026-11-11")) != 0 || len(plan("2026-11-12")) != 1 || len(plan("2026-11-14")) != 1 || plan("2026-11-14")[0].Type != domain.Departure {
		t.Fatal("every second day in house, and a departure clean, not a stayover, on the day out")
	}
}

func TestAttendantsOnShiftAndTheDNDStreak(t *testing.T) {
	staff := domain.StaffDay{
		Employees: []domain.Employee{
			{ID: "e1", Name: "Sari", Department: "housekeeping", VillaIDs: []string{"vil-b"}},
			{ID: "e2", Name: "Made", Department: "front_office", Position: "Room attendant"},
			{ID: "e3", Name: "Ketut", Department: "housekeeping"},
			{ID: "e4", Name: "Wayan", Department: "maintenance", Position: "Technician"},
		},
		Roster: []domain.RosterDay{{EmployeeID: "e1", Date: "2026-10-30", ShiftID: ptr("s1"), VillaID: "vil-a"}, {EmployeeID: "e2", Date: "2026-10-30", ShiftID: ptr("s1"), VillaID: "vil-a"},
			{EmployeeID: "e3", Date: "2026-10-30", ShiftID: ptr("s1"), VillaID: "vil-a"}, {EmployeeID: "e4", Date: "2026-10-30", ShiftID: ptr("s1"), VillaID: "vil-a"}},
		Leaves: []domain.Leave{{EmployeeID: "e3", Status: "approved", From: "2026-10-29", To: "2026-10-31"}},
	}
	on := domain.AttendantsOnShift(staff, "2026-10-30")
	if len(on) != 2 || on[0].ID != "e1" || !reflect.DeepEqual(on[0].VillaIDs, []string{"vil-a", "vil-b"}) || on[1].ID != "e2" {
		t.Fatalf("on shift %+v", on)
	}
	tasks := []domain.RoomTask{
		{BookingID: ptr("b"), Type: domain.Stayover, Date: "2026-10-27", Status: domain.Done},
		{BookingID: ptr("b"), Type: domain.Stayover, Date: "2026-10-28", Status: domain.DND},
		{BookingID: ptr("b"), Type: domain.Stayover, Date: "2026-10-29", Status: domain.DND},
		{BookingID: ptr("b"), Type: domain.Stayover, Date: "2026-10-30", Status: domain.DND},
		{BookingID: ptr("b"), Type: domain.Stayover, Date: "2026-10-31", Status: domain.Pending},
	}
	if n := domain.DNDStreak(tasks, "b", "2026-10-30"); n != domain.DNDAlertDays {
		t.Fatalf("streak %d", n)
	}
	if n := domain.DNDStreak(tasks, "b", "2026-10-31"); n != 0 {
		t.Fatalf("streak after a served day %d", n)
	}
}

func TestValidatorsAndTheBoard(t *testing.T) {
	s := domain.DefaultSettings()
	s.DailyQuota = 0
	st := s.Standards[domain.Deep]
	st.Credits = 0.3
	s.Standards[domain.Deep] = st
	err := domain.ValidateSettings(s)
	if e, _ := errs.As(err); e == nil || len(e.Fields) != 2 || e.Message != "A daily quota from 1 to 20 credits." || e.Fields[1].Field != "standards.deep.credits" {
		t.Fatalf("settings: %+v", err)
	}
	if err := domain.ValidatePar(domain.ParInput{Sets: 3, Lines: []domain.Line{{"a", 1}, {"a", 2}}}); err == nil || err.(*errs.Error).Message != "Add each item once." {
		t.Fatalf("par: %v", err)
	}
	batch := domain.LaundryBatch{SentOn: "2026-10-29", Lines: []domain.LaundryLine{{ItemID: "towel", Sent: 4}}}
	if err := domain.ValidateReturn(batch, domain.ReturnInput{ReturnedOn: "2026-10-28", Lines: []domain.ReturnLine{{ItemID: "towel", Returned: 5}}, Method: "cash"}); err == nil || len(err.(*errs.Error).Fields) != 2 {
		t.Fatalf("return: %v", err)
	}
	lost := domain.ApplyReturn(&batch, domain.ReturnInput{Lines: []domain.ReturnLine{{ItemID: "towel", Returned: 2, Damaged: 1}}})
	if !reflect.DeepEqual(lost, []domain.Line{{ItemID: "towel", Quantity: 2}}) {
		t.Fatalf("lost %v", lost)
	}
	rec := domain.Record{UnitID: "u", State: domain.Dirty}
	if err := domain.AssertMove(rec, "SK-01", domain.Ready); code(err) != "HOUSEKEEPING_INVALID_STATE" || err.(*errs.Error).Message != "SK-01 is dirty; it cannot become ready directly." {
		t.Fatalf("skip a stage: %v", err)
	}
	if err := domain.Inspect(&rec, "SK-01", []domain.InspectionResult{{Item: "bed", OK: true}}, "2026-10-30", "Kadek"); code(err) != "HOUSEKEEPING_INVALID_STATE" {
		t.Fatalf("inspect a dirty room: %v", err)
	}
	rec.State = domain.Cleaning
	if err := domain.Inspect(&rec, "SK-01", []domain.InspectionResult{{Item: "bed", OK: true}, {Item: "bathroom", OK: false}}, "2026-10-30", "Kadek"); err != nil || rec.State != domain.Dirty || rec.Note != "Failed: Bathroom clean, water hot" {
		t.Fatalf("failed inspection: %v %+v", err, rec)
	}
}
