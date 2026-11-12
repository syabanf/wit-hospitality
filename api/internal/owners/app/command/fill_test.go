package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/owners/adapters/postgres"
	reservationpg "github.com/syabanf/wit-hospitality/api/internal/reservation/adapters/postgres"
)

// A database seeded before owners' 00002_groups migration has reservation's groups and an empty
// copy, or a copy holding only the groups saved since. FillGroups brings it level with
// reservation, keeps a newer row an event wrote, and changes nothing on a second run.
func TestFillGroupsCatchesUpWithReservation(t *testing.T) {
	e := setup(t)
	ctx := context.Background()
	src := reservationpg.Groups{DB: e.db}
	store := postgres.Store{DB: e.db}
	fill := postgres.Projections{DB: e.db}.FillGroups

	want, err := src.GroupSources(ctx)
	if err != nil || len(want) < 2 {
		t.Fatalf("reservation's groups: %v %v", want, err)
	}
	// The copy holds one group, saved after the migration at a newer version than reservation's
	// answer shows; every other group is missing.
	newer := want[0]
	if _, err := e.db.Pool.Exec(ctx, `TRUNCATE owners.rm_groups`); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Pool.Exec(ctx, `INSERT INTO owners.rm_groups (id, source, version) VALUES ($1, 'wedding', $2)`, newer.ID, newer.Version+1); err != nil {
		t.Fatal(err)
	}
	n, err := fill(ctx, src)
	if err != nil || n != len(want)-1 {
		t.Fatalf("first fill copied %d of %d: %v", n, len(want)-1, err)
	}
	got, err := store.GroupSources(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range want {
		source := g.Source
		if g.ID == newer.ID {
			source = "wedding"
		}
		if got[g.ID] != source {
			t.Fatalf("group %s: got %q, want %q", g.ID, got[g.ID], source)
		}
	}
	if n, err := fill(ctx, src); err != nil || n != 0 {
		t.Fatalf("second fill changed %d rows: %v", n, err)
	}
}
