package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
)

// A damage charge or a long stay's utility usage lands on the folio once per source reference, as
// whoever asked; the seeded ones are already claimed, so a replay of them posts nothing.
func TestStayChargesPostOnce(t *testing.T) {
	d := setup(t)
	ctx := context.Background()
	post := command.StayChargePosted{Deps: d}
	codes := func(code string) int {
		t.Helper()
		postings, err := command.FolioPostings{Deps: d}.Handle(ctx, kadek, "bk-1296")
		ok(t, err)
		n := 0
		for _, p := range postings {
			if p.Code == code {
				n++
			}
		}
		return n
	}
	damage := command.StayCharge{SourceRef: "ick-9:uit-1", BookingID: "bk-1296", Code: "DMG", Description: "Damaged Wine glass (1): Chipped", Amount: 120_000, By: dian.Name, ByID: dian.UserID}
	ok(t, d.DB.InTx(ctx, func(ctx context.Context) error { return post.Handle(ctx, damage) }))
	ok(t, d.DB.InTx(ctx, func(ctx context.Context) error { return post.Handle(ctx, damage) }))
	utility := command.StayCharge{SourceRef: "mrd-99", BookingID: "bk-1296", Code: "UTIL", Description: "Electricity 20 kWh at 1700 per kWh, meter PLN-KR-03", Amount: 34_000, By: dian.Name, ByID: dian.UserID}
	ok(t, d.DB.InTx(ctx, func(ctx context.Context) error { return post.Handle(ctx, utility) }))
	if codes("DMG") != 1 || codes("UTIL") != 1 {
		t.Fatalf("DMG %d, UTIL %d", codes("DMG"), codes("UTIL"))
	}
	seeded := command.StayCharge{SourceRef: "mrd-20", BookingID: "bk-1296", Code: "UTIL", Amount: 1, By: dian.Name, ByID: dian.UserID}
	ok(t, d.DB.InTx(ctx, func(ctx context.Context) error { return post.Handle(ctx, seeded) }))
	if codes("UTIL") != 1 {
		t.Fatal("a seeded reading posted again")
	}
}
