// Package results answers owners.Results until finance does. Stub works out a villa's month from
// owners' own copy of reservation's stays, by the villa P&L rules for rooms: revenue night by
// night inside the month and the Airbnb fee of each arrival in it. It reports no other income, no
// expenses, no payroll and nothing pending, because owners holds no cash entries; a statement
// closed against it pays the owner the room result alone. bootstrap swaps it for finance's answer
// once finance runs.
package results

import (
	"context"

	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/owners/adapters/postgres"
	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
)

// Stub is the in-process stand-in for finance's villa results.
type Stub struct{ Store postgres.Store }

// VillaResults implements owners.Results.
func (s Stub) VillaResults(ctx context.Context, villaID, month string) (owners.VillaResult, error) {
	out := owners.VillaResult{Stays: []owners.ResultStay{}, Entries: []owners.ResultEntry{}}
	units, err := s.Store.Units(ctx)
	if err != nil {
		return out, err
	}
	codes := map[string]string{}
	var ids []string
	for _, u := range units {
		if u.VillaID == villaID {
			codes[u.ID] = u.Code
			ids = append(ids, u.ID)
		}
	}
	accounts, err := s.Store.AccountNames(ctx)
	if err != nil {
		return out, err
	}
	stays, err := s.Store.Stays(ctx, ids)
	if err != nil {
		return out, err
	}
	from, last := month+"-01", domain.MonthEnd(month)
	end := clock.AddDays(last, 1)
	for _, b := range stays {
		if !b.Earns() {
			continue
		}
		unitCode := "Unassigned"
		if b.UnitAssigned {
			unitCode = codes[b.UnitID]
		}
		source := domain.SourceLabel[b.Source]
		if b.AirbnbAccountID != nil {
			if name, ok := accounts[*b.AirbnbAccountID]; ok {
				source = name
			}
		}
		var fee int64
		if b.Source == "airbnb" && b.CheckIn >= from && b.CheckIn <= last {
			fee = int64(b.AirbnbFee)
		}
		out.Stays = append(out.Stays, owners.ResultStay{
			BookingID: b.ID, Code: b.Code, UnitCode: unitCode, CheckIn: b.CheckIn, CheckOut: b.CheckOut, Source: source,
			Nights: domain.OverlapNights(b.CheckIn, b.CheckOut, from, end), Revenue: b.ChargedBetween(from, end), Fee: fee,
		})
	}
	return out, nil
}
