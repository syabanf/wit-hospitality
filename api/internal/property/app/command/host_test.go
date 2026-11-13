package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/people"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	propertypg "github.com/syabanf/wit-hospitality/api/internal/property/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

type staffStub map[string]people.StaffMember

func (s staffStub) StaffMember(_ context.Context, id string) (people.StaffMember, bool, error) {
	m, ok := s[id]
	return m, ok, nil
}

// A villa unit takes a host allocated to its villa, keeps it through other edits and lets it go
// with null; a host elsewhere is HOST_NOT_ALLOCATED, a room takes none, and a hotel starts with
// the late check-out fee.
func TestUnitHostAndLateCheckoutFee(t *testing.T) {
	e := setup(t, fakeStays{})
	e.deps.Staff = staffStub{
		"emp-002": {ID: "emp-002", Name: "Made Wirawan", Status: "active", VillaIDs: []string{"vil-karang"}},
		"emp-004": {ID: "emp-004", Name: "Ketut Sari", Status: "active", VillaIDs: []string{"vil-saka"}},
		"emp-009": {ID: "emp-009", Name: "Gede Arta", Status: "inactive", VillaIDs: []string{"vil-karang"}},
	}
	ctx := context.Background()
	repo := propertypg.Repo{DB: e.db}
	kr, err := repo.Unit(ctx, "unit-kr-03")
	if err != nil {
		t.Fatal(err)
	}
	update := command.UpdateUnit{Deps: e.deps}
	in := unitForm(kr)
	for host, msg := range map[string]string{"emp-004": "Ketut Sari is not allocated to ", "emp-009": "Gede Arta is not allocated to ", "emp-404": "emp-404 is not allocated to "} {
		in.HostID = domain.HostInput{Set: true, ID: host}
		_, err := update.Handle(as(rama), rama, kr.ID, in)
		if e, ok := errs.As(err); !ok || e.Code != domain.CodeHostNotAllocated || len(e.Message) < len(msg) || e.Message[:len(msg)] != msg {
			t.Fatalf("%s: %v", host, err)
		}
	}
	in.HostID = domain.HostInput{Set: true, ID: "emp-002"}
	u, err := update.Handle(as(rama), rama, kr.ID, in)
	if err != nil || u.HostID == nil || *u.HostID != "emp-002" {
		t.Fatalf("host: %v %v", err, u.HostID)
	}
	e.deps.Staff = staffStub{}
	in = unitForm(u)
	in.Name = "Karang Tiga"
	if u, err = (command.UpdateUnit{Deps: e.deps}).Handle(as(rama), rama, kr.ID, in); err != nil || *u.HostID != "emp-002" {
		t.Fatalf("an edit without hostId keeps the host unchecked: %v %v", err, u.HostID)
	}
	in.HostID = domain.HostInput{Set: true}
	if u, err = (command.UpdateUnit{Deps: e.deps}).Handle(as(rama), rama, kr.ID, in); err != nil || u.HostID != nil {
		t.Fatalf("null clears the host: %v %v", err, u.HostID)
	}
	e.drain(t)
	units, _ := e.queries.Units(as(rama))
	for _, x := range units {
		if x.ID == kr.ID && x.HostID != nil {
			t.Fatalf("read model host %v", x.HostID)
		}
	}

	saka, err := repo.Villa(ctx, "vil-saka")
	if err != nil {
		t.Fatal(err)
	}
	hotel := villaForm(saka)
	hotel.Operation = domain.OperationHotel
	v, err := command.UpdateVilla{Deps: e.deps}.Handle(as(rama), rama, saka.ID, hotel)
	if err != nil || v.LateCheckoutFee != 500_000 {
		t.Fatalf("a hotel charges late check-out: %v %d", err, v.LateCheckoutFee)
	}
	sk, err := repo.Unit(ctx, "unit-sk-01")
	if err != nil {
		t.Fatal(err)
	}
	room := unitForm(sk)
	room.HostID = domain.HostInput{Set: true, ID: "emp-004"}
	if _, err := (command.UpdateUnit{Deps: e.deps}).Handle(as(rama), rama, sk.ID, room); fieldOf(err, "hostId") == "" {
		t.Fatalf("a hotel room took a host: %v", err)
	}
}
