package command_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/guest"
)

// A complaint's credit comes off the bill by exactly its amount on ROOM, an incident's damage
// posts on DMG, each once per source however often the request arrives, and a stay that left
// before the request arrived is skipped.
func TestGuestPostingsOnce(t *testing.T) {
	d := setup(t)
	ctx := context.Background()
	h := command.GuestPostingRequested{Deps: d}
	credit := guest.FolioPostingRequested{SourceID: "complaint:cpl-9", BookingID: "bk-1296", Kind: guest.FolioPostingCredit, Amount: 300_000,
		Description: "Compensation for CP-009: one night's dinner", By: kadek.Name, ByID: kadek.UserID}
	damage := guest.FolioPostingRequested{SourceID: "incident:inc-9", BookingID: "bk-1296", Kind: guest.FolioPostingCharge, Amount: 750_000,
		Description: "Damage, IN-009: broken lamp", By: dian.Name, ByID: dian.UserID}
	for range 2 {
		for _, e := range []guest.FolioPostingRequested{credit, damage} {
			ok(t, d.DB.InTx(ctx, func(ctx context.Context) error { return h.Handle(ctx, e) }))
		}
	}
	postings, err := command.FolioPostings{Deps: d}.Handle(ctx, kadek, "bk-1296")
	ok(t, err)
	var got []domain.Posting
	for _, p := range postings {
		if p.Description == credit.Description || p.Description == damage.Description {
			got = append(got, p)
		}
	}
	if len(got) != 2 {
		t.Fatalf("want one posting per source, got %+v", got)
	}
	for _, p := range got {
		switch p.Kind {
		case domain.KindRebate:
			if p.Code != "ROOM" || p.Gross() != 300_000 || p.LineID != nil || p.Part != domain.PartCharges || p.PostedBy != kadek.Name {
				t.Fatalf("credit %+v", p)
			}
		case domain.KindCharge:
			if p.Code != "DMG" || p.Gross() != 750_000 || p.PostedBy != dian.Name {
				t.Fatalf("damage %+v", p)
			}
		default:
			t.Fatalf("unexpected %+v", p)
		}
	}

	stays, err := d.Store.Stays(ctx, "checked_out")
	ok(t, err)
	var gone struct {
		ID string `json:"id"`
	}
	ok(t, json.Unmarshal(stays[0], &gone))
	left := damage
	left.SourceID, left.BookingID = "incident:inc-10", gone.ID
	ok(t, d.DB.InTx(ctx, func(ctx context.Context) error { return h.Handle(ctx, left) }))
	var n int
	ok(t, d.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM billing.guest_postings WHERE source_id = 'incident:inc-10'`).Scan(&n))
	if n != 0 {
		t.Fatal("a stay no longer in house takes no posting")
	}
}
