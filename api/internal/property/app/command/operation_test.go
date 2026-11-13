package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	propertypg "github.com/syabanf/wit-hospitality/api/internal/property/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// A seeded villa operates as a villa; turning it into a hotel turns its room types into rooms,
// and a room type of villas is then refused with GROUP_KIND.
func TestOperationChangeRekindsRoomTypes(t *testing.T) {
	e := setup(t, fakeStays{})
	ctx := context.Background()
	repo := propertypg.Repo{DB: e.db}
	saka, err := repo.Villa(ctx, "vil-saka")
	if err != nil {
		t.Fatal(err)
	}
	if saka.Operation != domain.OperationVilla || saka.StayoverEvery != 0 || !saka.DepositOnCheckIn {
		t.Fatalf("seeded operation %+v", saka.Operating)
	}
	in := villaForm(saka)
	in.Operation = domain.OperationHotel
	v, err := command.UpdateVilla{Deps: e.deps}.Handle(as(rama), rama, saka.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if v.StayoverEvery != 1 || v.DepositOnCheckIn {
		t.Fatalf("a new operation takes its defaults: %+v", v.Operating)
	}
	e.drain(t)
	g, _ := repo.Group(ctx, "grp-saka-standard")
	if g.Kind != domain.KindRoom {
		t.Fatalf("room type kind %q", g.Kind)
	}
	groups, _ := e.queries.Groups(as(rama))
	for _, x := range groups {
		if x.VillaID == saka.ID && x.Kind != domain.KindRoom {
			t.Fatalf("read model %+v", x)
		}
	}
	_, err = command.CreateGroup{Deps: e.deps}.Handle(as(rama), rama, domain.GroupInput{VillaID: saka.ID, Name: "Pool villas", Kind: domain.KindVilla})
	if !errs.HasCode(err, domain.CodeGroupKind) {
		t.Fatalf("got %v", err)
	}
	room, err := command.CreateGroup{Deps: e.deps}.Handle(as(rama), rama, domain.GroupInput{VillaID: saka.ID, Name: "Suites"})
	if err != nil || room.Kind != domain.KindRoom {
		t.Fatalf("a room type without a kind in a hotel: %+v %v", room, err)
	}
}
