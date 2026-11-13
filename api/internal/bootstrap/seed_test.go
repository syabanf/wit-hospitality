package bootstrap_test

import (
	"context"
	"testing"
	"time"

	"github.com/syabanf/wit-hospitality/api/internal/bootstrap"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/logging"
	"github.com/syabanf/wit-hospitality/api/internal/platform/testdb"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
	seedfiles "github.com/syabanf/wit-hospitality/api/seed"
)

func count(t *testing.T, d *db.DB, query string) int {
	t.Helper()
	var n int
	if err := d.Pool.QueryRow(context.Background(), query).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

// The seed carries the profile, hospitality and history fields, a second run adds nothing, and a
// context emptied since gets its data back with its copies of the contexts left as they were.
func TestSeedFillsOnlyEmptyContexts(t *testing.T) {
	d := testdb.New(t, bootstrap.MigrationSets(bootstrap.All)[1:]...)
	ctx := context.Background()
	makassar, _ := time.LoadLocation("Asia/Makassar")
	clk := clock.Fixed{T: time.Date(2026, 11, 11, 10, 0, 0, 0, makassar)}
	seed := func() {
		t.Helper()
		if err := bootstrap.Seed(ctx, d, logging.Discard(), clk); err != nil {
			t.Fatal(err)
		}
	}
	seed()

	fixture, err := seedfiles.FS.ReadFile("reservation.json")
	if err != nil {
		t.Fatal(err)
	}
	stays, err := reservationpg.ParseSeed(fixture)
	if err != nil {
		t.Fatal(err)
	}
	hosted := 0
	for _, b := range stays.Bookings {
		if b.HostID != nil {
			hosted++
		}
	}
	for query, want := range map[string]int{
		`SELECT count(*) FROM reservation.bookings WHERE doc->>'hostId' IS NOT NULL`:                                               hosted,
		`SELECT count(*) FROM property.unit_status_history`:                                                                        4,
		`SELECT count(*) FROM property.unit_status_history WHERE id = 'ush-4' AND until = '2026-11-09' AND on_date = '2026-11-05'`: 1,
	} {
		if got := count(t, d, query); got != want {
			t.Errorf("%s = %d, want %d", query, got, want)
		}
	}
	for _, query := range []string{
		`SELECT count(*) FROM property.villas WHERE address <> '' AND late_checkout_fee > 0`,
		`SELECT count(*) FROM property.units WHERE host_id IS NOT NULL`,
		`SELECT count(*) FROM reservation.bookings WHERE doc->'serviceWindow'->>'mode' = 'window'`,
		`SELECT count(*) FROM services.menu_items WHERE (doc->>'villaOnRequest')::boolean`,
		`SELECT count(*) FROM people.employees`,
		`SELECT count(*) FROM housekeeping.staff_employees`,
	} {
		if count(t, d, query) == 0 {
			t.Errorf("%s = 0", query)
		}
	}

	tables := []string{"identity.users", "property.unit_status_history", "reservation.bookings", "services.requests", "people.employees", "finance.transactions", "platform.outbox"}
	before := map[string]int{}
	for _, table := range tables {
		before[table] = count(t, d, `SELECT count(*) FROM `+table)
	}
	seed()
	for _, table := range tables {
		if got := count(t, d, `SELECT count(*) FROM `+table); got != before[table] {
			t.Errorf("second seed: %s has %d rows, had %d", table, got, before[table])
		}
	}

	if _, err := d.Pool.Exec(ctx, `TRUNCATE people.employees, people.shifts, people.shift_assignments, people.attendance, people.leave_requests,
		people.overtime_requests, people.loans, people.announcements, people.kpi_reviews, people.counters, people.rm_villas`); err != nil {
		t.Fatal(err)
	}
	seed()
	if got := count(t, d, `SELECT count(*) FROM people.employees`); got != before["people.employees"] {
		t.Errorf("people reseeded with %d employees, want %d", got, before["people.employees"])
	}
	if got := count(t, d, `SELECT count(*) FROM people.rm_villas`); got != count(t, d, `SELECT count(*) FROM property.villas`) {
		t.Errorf("people's villa copy has %d rows, want every villa", got)
	}
	if got := count(t, d, `SELECT count(*) FROM reservation.bookings`); got != before["reservation.bookings"] {
		t.Errorf("reservation changed to %d bookings, had %d", got, before["reservation.bookings"])
	}
}
