package command_test

import (
	"context"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/reservation"
)

// A late check-out's fee lands on the folio once, as whoever gave it; the same grant again, as a
// replay brings it, posts nothing, and a free one posts nothing at all.
func TestLateCheckoutChargedOnce(t *testing.T) {
	d := setup(t)
	ctx := context.Background()
	late := command.LateCheckoutCharged{Deps: d}
	grant := reservation.LateCheckoutGranted{BookingID: "bk-1296", Code: "LATE", Description: "Late check-out until 14:00", Charge: 500_000,
		By: dian.Name, ByID: dian.UserID}
	lates := func() []domain.Posting {
		t.Helper()
		var out []domain.Posting
		postings, err := command.FolioPostings{Deps: d}.Handle(ctx, kadek, "bk-1296")
		ok(t, err)
		for _, p := range postings {
			if p.Code == "LATE" {
				out = append(out, p)
			}
		}
		return out
	}
	before := events(t, d, billing.EventFolioLinePosted)
	ok(t, d.DB.InTx(ctx, func(ctx context.Context) error { return late.Handle(ctx, grant) }))
	ok(t, d.DB.InTx(ctx, func(ctx context.Context) error { return late.Handle(ctx, grant) }))
	got := lates()
	if len(got) != 1 || got[0].PostedBy != dian.Name || (got[0].Gross() != 500_000 && got[0].Amount != 500_000) {
		t.Fatalf("late postings %+v", got)
	}
	if n := events(t, d, billing.EventFolioLinePosted); n != before+1 {
		t.Fatalf("folio_line.posted went out %d times", n-before)
	}
	free := grant
	free.BookingID, free.Charge = "bk-1309", 0
	ok(t, late.Handle(ctx, free))
	if n := events(t, d, billing.EventFolioLinePosted); n != before+1 {
		t.Fatal("a free late check-out posts nothing")
	}
}
