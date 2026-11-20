package command_test

import (
	"context"
	"strings"
	"testing"

	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
)

type openCount int

func (n openCount) OpenDiscrepancies(context.Context, string) (int, error) { return int(n), nil }

func TestFrontOfficeControls(t *testing.T) {
	d := setup(t)
	ctx := context.Background()

	t.Run("a follow-up done before anyone read it is acknowledged with it", func(t *testing.T) {
		book := command.LogBook{Deps: d}
		_, err := book.Write(ctx, dian, domain.LogInput{Category: "guest", Text: "ok", VillaID: ptr("vil-nope")})
		if e, _ := errs.As(err); e == nil || errs.Fields(e.Fields).Map()["villaId"] != "Pick a property." || errs.Fields(e.Fields).Map()["text"] == "" {
			t.Fatalf("fields: %v", err)
		}
		e, err := book.Write(ctx, dian, domain.LogInput{Category: "maintenance", Text: "AC in SK-04 drips", VillaID: ptr("vil-saka"), Link: &domain.LogLink{Kind: "unit", ID: "unit-sk-04"}, FollowUp: true})
		ok(t, err)
		if e.Link == nil || e.Link.Label != "SK-04" {
			t.Fatalf("link %+v", e.Link)
		}
		done, err := book.Done(ctx, dian, e.ID, " Technician came ")
		ok(t, err)
		if done.AcknowledgedBy == nil || *done.AcknowledgedBy != dian.Name || done.DoneNote != "Technician came" {
			t.Fatalf("done %+v", done)
		}
		_, err = book.Done(ctx, dian, e.ID, strings.Repeat("x", 301))
		refused(t, err, "LOG_DONE")
	})

	t.Run("a handover past 1000 characters keeps the shift open", func(t *testing.T) {
		_, err := command.Cashier{Deps: d}.Close(ctx, wayan, "cs-8", domain.CloseShiftInput{Count: domain.DrawerCount{Notes: map[string]float64{"100000": 10}}, Handover: strings.Repeat("x", 1001)})
		if e, _ := errs.As(err); e == nil || errs.Fields(e.Fields).Map()["handover"] != "Keep an entry under 1000 characters." {
			t.Fatalf("handover: %v", err)
		}
	})

	t.Run("a hold on a stay that left is refused", func(t *testing.T) {
		_, err := command.CardHolds{Deps: d}.Create(ctx, dian, domain.PreAuthInput{BookingID: "bk-1000", Amount: 1000000, Brand: "jcb", Last4: "1234", ExpiresOn: "2026-11-12"})
		if !errs.HasCode(err, "PREAUTH_STAY") {
			t.Fatalf("a stay that left: %v", err)
		}
	})

	t.Run("the audit closes over open discrepancies only with a manager's reason", func(t *testing.T) {
		blocked := d
		blocked.Discrepancies = openCount(3)
		run := command.RunAudit{Deps: blocked}
		_, err := run.Handle(ctx, dian, domain.AuditRunInput{Date: "2026-11-11", Override: &domain.AuditOverride{Reason: "Phoned the guests"}})
		refused(t, err, "AUDIT_DISCREPANCIES")
		a, err := run.Handle(ctx, kadek, domain.AuditRunInput{Date: "2026-11-11", Override: &domain.AuditOverride{Reason: "Phoned the guests"}})
		ok(t, err)
		if a.Override == nil || a.Override.By != kadek.Name {
			t.Fatalf("override %+v", a.Override)
		}
	})
}

func ptr[T any](v T) *T { return &v }
