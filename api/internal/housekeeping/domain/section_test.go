package domain_test

import (
	"slices"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func TestASectionHandsOverOnlyItsPendingRoomsOfTheDay(t *testing.T) {
	if err := domain.ValidateSectionInput(domain.SectionInput{SectionID: "sec-1", Date: "11/11"}); code(err) != errs.CodeValidation {
		t.Fatalf("a day that is not a date: %v", err)
	}
	s := domain.Section{ID: "sec-1", Name: "Ground floor", UnitIDs: []string{"u1", "u2"}}
	task := func(unit, date, status string, attendant *string) domain.RoomTask {
		return domain.RoomTask{UnitID: unit, Date: date, Status: status, AttendantID: attendant}
	}
	tasks := []domain.RoomTask{
		task("u1", "2026-11-11", domain.Pending, nil),
		task("u2", "2026-11-11", domain.Pending, ptr("emp-1")),
		task("u2", "2026-11-11", domain.Pending, ptr("emp-2")),
		task("u1", "2026-11-11", domain.Done, nil),
		task("u1", "2026-11-12", domain.Pending, nil),
		task("u3", "2026-11-11", domain.Pending, nil),
	}
	if got := domain.SectionHandover(tasks, s, "2026-11-11", ptr("emp-2"), nil); !slices.Equal(got, []int{0, 1}) {
		t.Fatalf("giving the day to emp-2 moves the open rooms others or nobody hold: %v", got)
	}
	if got := domain.SectionHandover(tasks, s, "2026-11-11", nil, ptr("emp-2")); !slices.Equal(got, []int{2}) {
		t.Fatalf("clearing frees only what the section's attendant held: %v", got)
	}
	if got := domain.SectionHandover(tasks, s, "2026-11-11", nil, nil); len(got) != 0 {
		t.Fatalf("clearing a day nobody held moves nothing: %v", got)
	}
}
