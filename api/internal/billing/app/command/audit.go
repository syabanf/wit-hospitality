package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/billing"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// RunAudit closes the business date: it posts the night's room, and the nights a late check-in
// missed, on every stay in house and rolls the date forward. The console marks the arrivals that
// never came as no-shows through reservation first and sends their codes. It needs booking/post.
type RunAudit struct{ Deps }

// Handle runs the audit.
func (h RunAudit) Handle(ctx context.Context, p auth.Principal, in domain.AuditRunInput) (domain.NightAudit, error) {
	if err := h.Authz.Require(ctx, p.Role, bookingPost...); err != nil {
		return domain.NightAudit{}, err
	}
	var out domain.NightAudit
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Store.Lock(ctx); err != nil {
			return err
		}
		date, err := h.businessDate(ctx)
		if err != nil {
			return err
		}
		audits, err := docs[domain.NightAudit](h.Store.All(ctx, Audits))
		if err != nil {
			return err
		}
		ran := make([]string, len(audits))
		for i, a := range audits {
			ran[i] = a.Date
		}
		if err := domain.AuditProblem(in.Date, date, h.today(), ran); err != nil {
			return err
		}
		if err := h.Finance.AssertOpen(ctx, in.Date); err != nil {
			return err
		}
		tax, err := h.tax(ctx)
		if err != nil {
			return err
		}
		account, err := h.gl(ctx, domain.RoomCode)
		if err != nil {
			return err
		}
		raws, err := h.Store.Stays(ctx, domain.CheckedIn)
		if err != nil {
			return err
		}
		n, err := h.Store.Next(ctx, "nightAudit")
		if err != nil {
			return err
		}
		out = domain.NightAudit{ID: fmt.Sprintf("na-%d", n), Date: in.Date, RanAt: h.stamp(), RanBy: p.Name, Checks: domain.EmptyChecks(), NoShows: []string{}, Stays: []domain.AuditStay{}}
		for k, v := range in.Checks {
			out.Checks[k] = v
		}
		out.NoShows = append(out.NoShows, in.NoShows...)
		fact := billing.NightAudited{Where: billing.Where{Date: in.Date}, AuditID: out.ID, RanBy: p.Name, RanAt: out.RanAt, NextBusinessDate: domain.AddDays(in.Date, 1),
			NoShows: out.NoShows, Stays: []billing.AuditedStay{}}
		for _, raw := range raws {
			b, err := h.stayOf(ctx, raw)
			if err != nil {
				return err
			}
			nights := domain.NightsToPost(b, in.Date)
			if len(nights) == 0 {
				continue
			}
			posted := append([]string{}, b.Posted()...)
			for range nights {
				posted = append(posted, in.Date)
			}
			if err := h.Store.SetNightPosts(ctx, b.ID, posted); err != nil {
				return err
			}
			b.NightsPosted = &posted
			amount := domain.NightsAmount(b, nights)
			out.Stays = append(out.Stays, domain.AuditStay{BookingID: b.ID, Code: b.Code, Nights: len(nights), Amount: amount})
			out.Nights += len(nights)
			out.RoomRevenue += amount
			pl, err := h.Store.Place(ctx, b.UnitID)
			if err != nil {
				return err
			}
			splits := domain.NightSplits(b, &tax)
			stay := billing.AuditedStay{BookingID: b.ID, Code: b.Code, VillaID: pl.VillaID, LocationID: pl.LocationID, Nights: len(nights), NightsPosted: posted}
			for _, i := range nights {
				s := splits[i]
				stay.Lines = append(stay.Lines, billing.AuditLine{Night: i + 1, Code: domain.RoomCode, Account: account, Amount: s.Net, TaxLines: taxLinesOf(s.Service, s.PB1)})
			}
			fact.Stays = append(fact.Stays, stay)
		}
		fact.Nights, fact.RoomRevenue = out.Nights, out.RoomRevenue
		if err := h.Store.Put(ctx, Audits, Row{ID: out.ID, Ref: out.Date, Doc: out}); err != nil {
			return err
		}
		if err := h.Store.PutSetting(ctx, SettingBusinessDate, fact.NextBusinessDate); err != nil {
			return err
		}
		if err := h.emit(ctx, billing.EventNightAudited, "night_audit", out.ID, fact); err != nil {
			return err
		}
		return h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "night-audit", EntityID: in.Date,
			Summary: fmt.Sprintf("Closed business date %s: %d nights posted, %d no-shows", in.Date, out.Nights, len(out.NoShows)),
			Before:  map[string]any{"businessDate": in.Date}, After: map[string]any{"businessDate": fact.NextBusinessDate, "roomRevenue": out.RoomRevenue}})
	})
	return out, err
}
