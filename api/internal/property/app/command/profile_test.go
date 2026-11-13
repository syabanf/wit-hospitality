package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"

	propertypg "github.com/syabanf/wit-hospitality/api/internal/property/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/property/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/property/domain"
)

// fakeUploads stands in for the files context: id to content type.
type fakeUploads map[string]string

func (f fakeUploads) Upload(_ context.Context, id string) (command.Upload, bool, error) {
	kind, ok := f[id]
	return command.Upload{ID: id, Name: id + ".bin", Type: kind}, ok, nil
}

func villaForm(v domain.Villa) domain.VillaInput {
	return domain.VillaInput{LocationID: v.LocationID, Code: v.Code, Name: v.Name, Description: v.Description, Facilities: v.Facilities,
		VillaProfile: v.VillaProfile, DepositValue: float64(v.DepositValue), Photos: v.Photos}
}

func TestVillaProfileAndPhotos(t *testing.T) {
	e := setup(t, fakeStays{})
	e.deps.Uploads = fakeUploads{"file-pool": "image/jpeg", "file-front": "image/webp", "file-menu": "application/pdf"}
	ctx := context.Background()
	saka, err := propertypg.Repo{DB: e.db}.Villa(ctx, "vil-saka")
	if err != nil {
		t.Fatal(err)
	}
	if saka.CheckInTime != "14:00" || saka.CheckOutTime != "12:00" || saka.CancellationPolicy != "moderate" || saka.DepositKind != "none" || len(saka.Photos) != 0 {
		t.Fatalf("seeded villa defaults: %+v", saka.VillaProfile)
	}
	in := villaForm(saka)
	lat, lng := -8.65, 115.13
	in.Address, in.Lat, in.Lng, in.Email = "Jl. Pantai Batu Bolong 12", &lat, &lng, "stay@saka.id"
	in.DepositKind, in.DepositValue, in.BankAccountNo = "percent", 30, "1234567890"
	in.Photos = []domain.Photo{{FileID: "file-pool", Caption: " Pool "}, {FileID: "file-front"}}
	update := command.UpdateVilla{Deps: e.deps}
	v, err := update.Handle(as(rama), rama, saka.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if v.DepositValue != 30 || len(v.Photos) != 2 || v.Photos[0].Caption != "Pool" || *v.Lat != lat {
		t.Fatalf("got %+v", v)
	}
	e.drain(t)
	villas, _ := e.queries.Villas(as(rama))
	for _, got := range villas {
		if got.ID == saka.ID && (got.Address != in.Address || len(got.Photos) != 2 || got.BankAccountNo != "1234567890") {
			t.Fatalf("read model %+v", got)
		}
	}

	bad := in
	bad.Lng, bad.CheckOutTime, bad.DepositValue, bad.BankAccountNo = nil, "15:00", 120, "12-34"
	want := map[string]string{
		"lat":           "Enter both latitude and longitude, or neither.",
		"checkOutTime":  "Check-out must be earlier than check-in.",
		"bankAccountNo": "The account number is digits only.",
		"depositValue":  "A deposit percentage is a whole number from 1 to 100.",
	}
	_, err = update.Handle(as(rama), rama, saka.ID, bad)
	for field, msg := range want {
		if got := fieldOf(err, field); got != msg {
			t.Errorf("%s: %q, want %q", field, got, msg)
		}
	}

	pdf := in
	pdf.Photos = append(pdf.Photos, domain.Photo{FileID: "file-menu"})
	if _, err := update.Handle(as(rama), rama, saka.ID, pdf); code(err) != "PHOTO_NOT_IMAGE" {
		t.Fatalf("pdf photo: %v", err)
	}
	unknown := in
	unknown.Photos = []domain.Photo{{FileID: "file-gone"}}
	if _, err := update.Handle(as(rama), rama, saka.ID, unknown); code(err) != "PHOTO_UNKNOWN" {
		t.Fatalf("unknown photo: %v", err)
	}
	many := in
	many.Photos = make([]domain.Photo, 21)
	for i := range many.Photos {
		many.Photos[i] = domain.Photo{FileID: "file-pool"}
	}
	if _, err := update.Handle(as(rama), rama, saka.ID, many); code(err) != "PHOTO_LIMIT" {
		t.Fatalf("21 photos: %v", err)
	}
	// A form without photos keeps them.
	keep := in
	keep.Photos = nil
	if v, err := update.Handle(as(rama), rama, saka.ID, keep); err != nil || len(v.Photos) != 2 {
		t.Fatalf("got %+v, %v", v.Photos, err)
	}
}

func fieldOf(err error, field string) string {
	if e, ok := errs.As(err); ok {
		return errs.Fields(e.Fields).Map()[field]
	}
	return ""
}

func unitForm(u domain.Unit) domain.UnitInput {
	adults, children := float64(u.MaxAdults), float64(u.MaxChildren)
	return domain.UnitInput{VillaID: u.VillaID, GroupID: u.GroupID, Code: u.Code, Name: u.Name, Bedrooms: float64(u.Bedrooms),
		NightlyRate: float64(u.NightlyRate), Status: u.Status, Amenities: u.Amenities, MaxAdults: &adults, MaxChildren: &children,
		Beds: u.Beds, View: u.View, ExtraBeds: float64(u.ExtraBeds), ExtraBedRate: float64(u.ExtraBedRate), Photos: u.Photos}
}

func TestUnitCapacityAndStatusHistory(t *testing.T) {
	e := setup(t, fakeStays{})
	ctx := context.Background()
	repo := propertypg.Repo{DB: e.db}
	kr, err := repo.Unit(ctx, "unit-kr-03")
	if err != nil {
		t.Fatal(err)
	}
	if kr.MaxAdults != kr.Bedrooms*2 || kr.MaxChildren != kr.Bedrooms {
		t.Fatalf("seeded capacity %d/%d for %d bedrooms", kr.MaxAdults, kr.MaxChildren, kr.Bedrooms)
	}
	update := command.UpdateUnit{Deps: e.deps}
	in := unitForm(kr)
	in.Beds = []domain.Bed{{Type: "king", Count: 1}, {Type: "king", Count: 1}}
	in.ExtraBeds = 2
	if _, err := update.Handle(as(kadek), kadek, kr.ID, in); fieldOf(err, "beds.1.type") != "List each bed type once." || fieldOf(err, "extraBedRate") == "" {
		t.Fatalf("got %v", err)
	}
	in.Beds, in.ExtraBedRate = []domain.Bed{{Type: "king", Count: 1}, {Type: "twin", Count: 2}}, 350_000
	in.Status = domain.UnitMaintenance
	if _, err := update.Handle(as(kadek), kadek, kr.ID, in); fieldOf(err, "statusReason") != "Say why the unit is out of service." {
		t.Fatalf("maintenance without a reason: %v", err)
	}
	until := "2026-11-20"
	in.StatusReason, in.StatusUntil = "Pool pump replaced", &until
	u, err := update.Handle(as(kadek), kadek, kr.ID, in)
	if err != nil {
		t.Fatal(err)
	}
	if u.Status != domain.UnitMaintenance || u.StatusReason != "Pool pump replaced" || *u.StatusUntil != until || u.ExtraBeds != 2 || len(u.Beds) != 2 {
		t.Fatalf("got %+v", u)
	}
	// Editing the name keeps the status, its reason and adds no history.
	same := unitForm(u)
	same.Name = "Karang cliff villa three"
	if _, err := update.Handle(as(kadek), kadek, kr.ID, same); err != nil {
		t.Fatal(err)
	}
	back := unitForm(u)
	back.Status = domain.UnitActive
	if u, err = update.Handle(as(kadek), kadek, kr.ID, back); err != nil || u.StatusReason != "" || u.StatusUntil != nil {
		t.Fatalf("got %+v, %v", u, err)
	}
	history, err := e.queries.StatusHistory(as(kadek), domain.HistoryFilter{UnitID: kr.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 2 || history[0].To != domain.UnitActive || history[1].From != domain.UnitActive || history[1].To != domain.UnitMaintenance ||
		history[1].Reason != "Pool pump replaced" || *history[1].Until != until || history[1].By != kadek.Name {
		t.Fatalf("history %+v", history)
	}
	if out, _ := e.queries.StatusHistory(as(kadek), domain.HistoryFilter{VillaID: "vil-saka"}); len(out) != 0 {
		t.Fatalf("another villa's history: %+v", out)
	}
	if out, _ := e.queries.StatusHistory(as(kadek), domain.HistoryFilter{From: "2026-11-12"}); len(out) != 0 {
		t.Fatalf("history after today: %+v", out)
	}

	// A unit created out of service carries its reason and opens its history.
	created, err := command.CreateUnit{Deps: e.deps}.Handle(as(rama), rama, domain.UnitInput{VillaID: "vil-saka", Code: "SK-09", Name: "Saka 9",
		Bedrooms: 1, NightlyRate: 1_000_000, Status: domain.UnitInactive, StatusReason: "Fit-out not finished"})
	if err != nil || created.StatusReason != "Fit-out not finished" {
		t.Fatalf("got %+v, %v", created, err)
	}
	opened, _ := e.queries.StatusHistory(as(rama), domain.HistoryFilter{UnitID: created.ID})
	if len(opened) != 1 || opened[0].From != "" || opened[0].To != domain.UnitInactive || opened[0].Reason != "Fit-out not finished" {
		t.Fatalf("first history row %+v", opened)
	}
}

func TestStatusFollowsHousekeepingAndMaintenance(t *testing.T) {
	e := setup(t, fakeStays{})
	ctx := context.Background()
	repo := propertypg.Repo{DB: e.db}
	rooms := command.FollowRoomState{Deps: e.deps}
	if err := rooms.Handle(ctx, "unit-sk-02", "cleaning", ""); err != nil {
		t.Fatal(err)
	}
	if u, _ := repo.Unit(ctx, "unit-sk-02"); u.Status != domain.UnitCleaning {
		t.Fatalf("cleaning: %s", u.Status)
	}
	if err := rooms.Handle(ctx, "unit-sk-02", "ready", ""); err != nil {
		t.Fatal(err)
	}
	id, err := command.HoldBlock{Deps: e.deps}.Handle(ctx, "unit-sk-02", "2026-11-11", "2026-11-14", "WO-7 Leaking roof")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := repo.Unit(ctx, "unit-sk-02")
	if u.Status != domain.UnitMaintenance || u.StatusReason != "WO-7 Leaking roof" || *u.StatusUntil != "2026-11-14" {
		t.Fatalf("held: %+v", u)
	}
	if err := (command.ReleaseBlock{Deps: e.deps}).Handle(ctx, id, "2026-11-12"); err != nil {
		t.Fatal(err)
	}
	if u, _ := repo.Unit(ctx, "unit-sk-02"); u.Status != domain.UnitActive {
		t.Fatalf("released: %s", u.Status)
	}
	history, _ := e.queries.StatusHistory(as(rama), domain.HistoryFilter{UnitID: "unit-sk-02"})
	var by []string
	for _, h := range history {
		by = append(by, h.By+":"+h.To)
	}
	want := []string{"Maintenance:active", "Maintenance:maintenance", "Housekeeping:active", "Housekeeping:cleaning"}
	if len(by) != len(want) {
		t.Fatalf("history %v", by)
	}
	for i := range want {
		if by[i] != want[i] {
			t.Fatalf("history %v, want %v", by, want)
		}
	}
}
