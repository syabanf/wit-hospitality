package command_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/housekeeping/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

func TestTheRoomReportFindsASleeperAndTheDeskResolvesIt(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	if _, err := e.db.Pool.Exec(ctx, `DELETE FROM housekeeping.room_checks`); err != nil {
		t.Fatal(err)
	}
	var inHouse, code_, empty string
	var persons *int
	if err := e.db.Pool.QueryRow(ctx, `SELECT unit_id, code, persons FROM housekeeping.stays WHERE status = 'checked_in' AND unit_assigned AND check_in <= $1::date
		AND unit_id IN (SELECT id FROM housekeeping.cat_units WHERE villa_id = 'vil-saka') ORDER BY seq LIMIT 1`, today).Scan(&inHouse, &code_, &persons); err != nil {
		t.Fatal(err)
	}
	if err := e.db.Pool.QueryRow(ctx, `SELECT id FROM housekeeping.cat_units u WHERE villa_id = 'vil-saka'
		AND NOT EXISTS (SELECT 1 FROM housekeeping.stays s WHERE s.unit_id = u.id AND s.status = 'checked_in') ORDER BY seq LIMIT 1`).Scan(&empty); err != nil {
		t.Fatal(err)
	}
	if persons == nil {
		t.Fatal("the stays copy keeps the party in the room")
	}
	record := command.RecordRoomCheck{Deps: e.deps}
	resolve := command.ResolveDiscrepancy{Deps: e.deps}
	open := command.OpenDiscrepancies{Deps: e.deps}

	if _, err := record.Handle(as(ida), ida, domain.RoomCheckInput{UnitID: inHouse, Date: today, Found: domain.FoundVacant}); code(err) != errs.CodeForbidden {
		t.Fatalf("finance reads housekeeping only: %v", err)
	}
	if _, err := record.Handle(as(kadek), kadek, domain.RoomCheckInput{UnitID: "unit-nope", Date: today, Found: domain.FoundVacant}); code(err) != errs.CodeNotFound {
		t.Fatalf("unknown unit: %v", err)
	}
	sleep, err := record.Handle(as(sari), sari, domain.RoomCheckInput{UnitID: inHouse, Date: today, Found: domain.FoundVacant, Note: " Bed not slept in "})
	if err != nil {
		t.Fatal(err)
	}
	if sleep.ID != "rc-"+today+"-"+inHouse || sleep.FrontOffice != domain.FoundOccupied || sleep.BookingCode == nil || *sleep.BookingCode != code_ ||
		sleep.Discrepancy == nil || *sleep.Discrepancy != domain.DiscrepancySleep || sleep.Note != "Bed not slept in" || sleep.CheckedBy != sari.Name {
		t.Fatalf("a sleeper: %+v", sleep)
	}
	more := *persons + 1
	skip, err := record.Handle(as(kadek), kadek, domain.RoomCheckInput{UnitID: empty, Date: today, Found: domain.FoundOccupied, Persons: &more})
	if err != nil || skip.Discrepancy == nil || *skip.Discrepancy != domain.DiscrepancySkip || skip.BookingID != nil {
		t.Fatalf("a skip: %+v %v", skip, err)
	}
	if n, err := open.Count(ctx, today); err != nil || n != 2 {
		t.Fatalf("two open: %d %v", n, err)
	}
	if n, _ := open.Count(ctx, "2026-11-10"); n != 0 {
		t.Fatalf("none open before today: %d", n)
	}

	if _, err := resolve.Handle(as(ida), ida, sleep.ID, domain.ResolveInput{Action: "guest_out", Note: "Stayed out"}); code(err) != errs.CodeForbidden {
		t.Fatalf("finance cannot resolve: %v", err)
	}
	if _, err := resolve.Handle(as(kadek), kadek, sleep.ID, domain.ResolveInput{Action: "checked_in", Note: "Stayed out"}); code(err) != errs.CodeValidation {
		t.Fatalf("an action that does not fit: %v", err)
	}
	done, err := resolve.Handle(as(kadek), kadek, sleep.ID, domain.ResolveInput{Action: "guest_out", Note: " Guest stayed in Ubud "})
	if err != nil || done.Resolution == nil || done.Resolution.By != kadek.Name || done.Resolution.Note != "Guest stayed in Ubud" {
		t.Fatalf("resolved: %+v %v", done, err)
	}
	if _, err := record.Handle(as(kadek), kadek, domain.RoomCheckInput{UnitID: inHouse, Date: today, Found: domain.FoundOccupied}); code(err) != "ROOM_CHECK_RESOLVED" {
		t.Fatalf("a resolved check stays: %v", err)
	}
	if n, _ := open.Count(ctx, today); n != 1 {
		t.Fatalf("one open left: %d", n)
	}
	// A check recorded again before it is resolved replaces the first.
	again, err := record.Handle(as(kadek), kadek, domain.RoomCheckInput{UnitID: empty, Date: today, Found: domain.FoundVacant})
	if err != nil || again.Discrepancy != nil || again.ID != skip.ID {
		t.Fatalf("recorded again: %+v %v", again, err)
	}
	if _, err := resolve.Handle(as(kadek), kadek, again.ID, domain.ResolveInput{Action: "housekeeping_error", Note: "Counted the wrong door"}); code(err) != "DISCREPANCY_NONE" {
		t.Fatalf("nothing to resolve: %v", err)
	}
	rows, err := e.queries.RoomChecks(as(kadek))
	if err != nil || len(rows) != 2 {
		t.Fatalf("the report: %d %v", len(rows), err)
	}
	var first domain.RoomCheck
	_ = json.Unmarshal(rows[0], &first)
	if first.Date != today {
		t.Fatalf("newest first: %+v", first)
	}
}
