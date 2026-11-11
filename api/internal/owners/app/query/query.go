// Package query holds the owners context's read side. Operator staff read the records of the villas
// in their scope; a villa owner reads their own records only, and a statement once the Owner
// approved it, as the mock adapter serves them.
package query

import (
	"context"
	"slices"

	"github.com/syabanf/wit-hospitality/api/internal/owners/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Store is what the reads need from the owners schema.
type Store interface {
	Owners(ctx context.Context) ([]domain.VillaOwner, error)
	Contracts(ctx context.Context) ([]domain.Contract, error)
	Statements(ctx context.Context) ([]domain.Statement, error)
	StayRequests(ctx context.Context) ([]domain.StayRequest, error)
	Villas(ctx context.Context) ([]domain.Villa, error)
	Units(ctx context.Context) ([]domain.Unit, error)
	Blocks(ctx context.Context) ([]domain.Block, error)
	Stays(ctx context.Context, unitIDs []string) ([]domain.Stay, error)
	AccountNames(ctx context.Context) (map[string]string, error)
}

// Queries bundles the read handlers.
type Queries struct {
	Store Store
	Authz rbac.Authorizer
	Clock clock.Clock
}

// viewer is who reads: an investor's owner id, or the operator's villa scope.
type viewer struct {
	investor bool
	ownerID  string
	villas   map[string]bool
}

func (q Queries) viewer(ctx context.Context) (viewer, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return viewer{}, err
	}
	list, err := q.Store.Owners(ctx)
	if err != nil {
		return viewer{}, err
	}
	if owner, isInvestor := command.OwnedBy(list, p); isInvestor {
		v := viewer{investor: true}
		if owner != nil {
			v.ownerID = owner.ID
		}
		return v, nil
	}
	villas, err := q.Store.Villas(ctx)
	if err != nil {
		return viewer{}, err
	}
	v := viewer{villas: map[string]bool{}}
	for _, x := range villas {
		if p.Scope().AllowedVilla(x.ID, x.LocationID) {
			v.villas[x.ID] = true
		}
	}
	return v, nil
}

// sees reports a record of ownerID on villaID the viewer may read.
func (v viewer) sees(ownerID, villaID string) bool {
	if v.investor {
		return v.ownerID != "" && ownerID == v.ownerID
	}
	return v.villas[villaID]
}

// Owners is GET /villa-owners: every owner for the operator, a villa owner's own record.
func (q Queries) Owners(ctx context.Context) ([]domain.VillaOwner, error) {
	v, err := q.viewer(ctx)
	if err != nil {
		return nil, err
	}
	list, err := q.Store.Owners(ctx)
	if err != nil || !v.investor {
		return list, err
	}
	return slices.DeleteFunc(list, func(o domain.VillaOwner) bool { return o.ID != v.ownerID }), nil
}

// Contracts is GET /management-contracts.
func (q Queries) Contracts(ctx context.Context) ([]domain.Contract, error) {
	v, err := q.viewer(ctx)
	if err != nil {
		return nil, err
	}
	list, err := q.Store.Contracts(ctx)
	return slices.DeleteFunc(list, func(c domain.Contract) bool { return !v.sees(c.OwnerID, c.VillaID) }), err
}

// Statements is GET /owner-statements: a villa owner sees a statement once it is approved.
func (q Queries) Statements(ctx context.Context) ([]domain.Statement, error) {
	v, err := q.viewer(ctx)
	if err != nil {
		return nil, err
	}
	list, err := q.Store.Statements(ctx)
	return slices.DeleteFunc(list, func(s domain.Statement) bool {
		return !v.sees(s.OwnerID, s.VillaID) || (v.investor && s.Status != domain.StatementApproved)
	}), err
}

// StayRequests is GET /owner-stays.
func (q Queries) StayRequests(ctx context.Context) ([]domain.StayRequest, error) {
	v, err := q.viewer(ctx)
	if err != nil {
		return nil, err
	}
	list, err := q.Store.StayRequests(ctx)
	return slices.DeleteFunc(list, func(r domain.StayRequest) bool { return !v.sees(r.OwnerID, r.VillaID) }), err
}

// Span is PortalCalendarSpan: dates and source of a stay, never the guest.
type Span struct {
	ID       string `json:"id"`
	UnitID   string `json:"unitId"`
	UnitCode string `json:"unitCode"`
	From     string `json:"from"`
	To       string `json:"to"`
	Kind     string `json:"kind"`
	Label    string `json:"label"`
}

// Calendar is the owner portal's calendar.
type Calendar struct {
	From   string         `json:"from"`
	To     string         `json:"to"`
	Days   int            `json:"days"`
	Villas []domain.Villa `json:"villas"`
	Units  []CalendarUnit `json:"units"`
	Spans  []Span         `json:"spans"`
	Today  string         `json:"today"`
}

// CalendarUnit is a unit row of the calendar.
type CalendarUnit struct {
	ID      string `json:"id"`
	Code    string `json:"code"`
	VillaID string `json:"villaId"`
}

// Calendar is GET /owner-portal/calendar, portal.calendar in src/application/owners.ts: stays, owner
// stays and blocks on the owner's units over [from, from+days). A villa owner reads stays here
// because every operational read, bookings included, refuses them.
func (q Queries) Calendar(ctx context.Context, from string, days int) (Calendar, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return Calendar{}, err
	}
	if err := q.Authz.Require(ctx, p.Role, rbac.Need{Module: "portal", Action: "view"}); err != nil {
		return Calendar{}, err
	}
	if _, err := clock.ParseDate(from); err != nil || days < 1 || days > 366 {
		return Calendar{}, errs.New(errs.CodeValidation, "Pick a start date and from 1 to 366 days.")
	}
	contracts, err := q.Contracts(ctx)
	if err != nil {
		return Calendar{}, err
	}
	if len(contracts) == 0 {
		if owners, err := q.Owners(ctx); err != nil || len(owners) == 0 {
			return Calendar{}, firstErr(err, errs.Forbidden("No villa owner is linked to this login."))
		}
	}
	to := clock.AddDays(from, days)
	out := Calendar{From: from, To: to, Days: days, Villas: []domain.Villa{}, Units: []CalendarUnit{}, Spans: []Span{}, Today: clock.Today(q.Clock)}
	villas, err := q.Store.Villas(ctx)
	if err != nil {
		return out, err
	}
	mine := map[string]bool{}
	for _, c := range contracts {
		mine[c.VillaID] = true
	}
	for _, c := range contracts {
		for _, v := range villas {
			if v.ID == c.VillaID {
				out.Villas = append(out.Villas, v)
			}
		}
	}
	units, err := q.Store.Units(ctx)
	if err != nil {
		return out, err
	}
	code := map[string]string{}
	var ids []string
	for _, u := range units {
		if mine[u.VillaID] {
			out.Units = append(out.Units, CalendarUnit{ID: u.ID, Code: u.Code, VillaID: u.VillaID})
			code[u.ID] = u.Code
			ids = append(ids, u.ID)
		}
	}
	stays, err := q.Store.Stays(ctx, ids)
	if err != nil {
		return out, err
	}
	accounts, err := q.Store.AccountNames(ctx)
	if err != nil {
		return out, err
	}
	for _, b := range stays {
		if !b.UnitAssigned || !b.Earns() || b.CheckIn >= to || b.CheckOut <= from {
			continue
		}
		label := domain.SourceLabel[b.Source]
		if b.AirbnbAccountID != nil {
			label = "Airbnb"
			if name := accounts[*b.AirbnbAccountID]; name != "" {
				label += ", " + name
			}
		}
		out.Spans = append(out.Spans, Span{ID: b.ID, UnitID: b.UnitID, UnitCode: code[b.UnitID], From: b.CheckIn, To: b.CheckOut, Kind: "stay", Label: label})
	}
	blocks, err := q.Store.Blocks(ctx)
	if err != nil {
		return out, err
	}
	for _, k := range blocks {
		if _, ok := code[k.UnitID]; !ok || k.From >= to || k.To <= from {
			continue
		}
		kind, label := "block", "Closed"
		if k.Reason == "owner" {
			kind, label = "owner", "Owner stay"
		}
		out.Spans = append(out.Spans, Span{ID: k.ID, UnitID: k.UnitID, UnitCode: code[k.UnitID], From: k.From, To: k.To, Kind: kind, Label: label})
	}
	return out, nil
}

func firstErr(err, otherwise error) error {
	if err != nil {
		return err
	}
	return otherwise
}
