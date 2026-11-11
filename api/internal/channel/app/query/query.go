// Package query holds the channel context's read side: host accounts, listings scoped to the
// user's villas, web enquiries, the public site's inventory and holds, and the listing price
// lookups other contexts call. Handlers hold no domain logic beyond the price list fallback.
package query

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// SiteListing is what the website may read of a listing: only what prices a night.
type SiteListing struct {
	UnitID    string           `json:"unitId"`
	Status    string           `json:"status"`
	DateRates map[string]int64 `json:"dateRates"`
}

// SiteCatalog is the property side of the inventory, projected into the channel schema.
type SiteCatalog struct {
	Locations []property.Location
	Villas    []property.Villa
	Groups    []property.Group
	Units     []property.Unit
	RatePlans []property.RatePlan
	Listings  []SiteListing
}

// ReadStore reads the channel schema.
type ReadStore interface {
	Accounts(ctx context.Context) ([]domain.Account, error)
	Listings(ctx context.Context, s rbac.Scope) ([]domain.Listing, error)
	// UnitListing returns the unit's listing with its unit's base rate, or nil.
	UnitListing(ctx context.Context, unitID string) (*channel.UnitListing, error)
	// Enquiries returns owner notes and the enquiries about villas in scope, newest first.
	Enquiries(ctx context.Context, s rbac.Scope) ([]domain.Enquiry, error)
	SiteCatalog(ctx context.Context) (SiteCatalog, error)
	// Blocks returns the unit blocks holding a night in [from, to).
	Blocks(ctx context.Context, from, to string) ([]domain.Hold, error)
}

// SiteSources reads the public parts of contexts channel does not own: stay rules and stays
// (reservation), tax (finance), the menu (services) and the team (people). adapters/sources.None
// answers with the defaults until those contexts exist; each later phase swaps in a client.
type SiteSources interface {
	Restrictions(ctx context.Context) ([]json.RawMessage, error)
	Tax(ctx context.Context) (json.RawMessage, error)
	Menu(ctx context.Context) ([]json.RawMessage, error)
	Team(ctx context.Context) ([]json.RawMessage, error)
	// Stays returns the stays holding a night in [from, to), with no guest, code or price.
	Stays(ctx context.Context, from, to string) ([]domain.Hold, error)
}

// Contact is SiteContact. The console keeps no public contact yet; the website shows placeholders.
type Contact struct {
	WhatsApp *string `json:"whatsapp"`
	Email    *string `json:"email"`
}

// SiteInventory is what the public website reads: property, prices and stay rules, never who
// stays, what they paid or who changed what.
type SiteInventory struct {
	Locations    []property.Location `json:"locations"`
	Villas       []property.Villa    `json:"villas"`
	Groups       []property.Group    `json:"groups"`
	Units        []property.Unit     `json:"units"`
	Listings     []SiteListing       `json:"listings"`
	RatePlans    []property.RatePlan `json:"ratePlans"`
	Restrictions []json.RawMessage   `json:"restrictions"`
	Tax          json.RawMessage     `json:"tax"`
	Menu         []json.RawMessage   `json:"menu"`
	Contact      Contact             `json:"contact"`
	Team         []json.RawMessage   `json:"team"`
}

// Queries bundles the read handlers.
type Queries struct {
	Store   ReadStore
	Sources SiteSources
	// Permissions reads the matrix for the enquiry list's own refusal wording.
	Permissions rbac.Source
}

func scope(ctx context.Context) (rbac.Scope, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return rbac.Scope{}, err
	}
	return p.Scope(), nil
}

// Accounts is GET /airbnb-accounts. Every signed-in user reads them: bookings name their source.
func (q Queries) Accounts(ctx context.Context) ([]domain.Account, error) {
	if _, err := auth.Require(ctx); err != nil {
		return nil, err
	}
	return q.Store.Accounts(ctx)
}

// Listings is GET /airbnb-listings: the listings of units in the user's scope.
func (q Queries) Listings(ctx context.Context) ([]domain.Listing, error) {
	s, err := scope(ctx)
	if err != nil {
		return nil, err
	}
	return q.Store.Listings(ctx, s)
}

// Enquiries is GET /enquiries; it needs booking/view.
func (q Queries) Enquiries(ctx context.Context) ([]domain.Enquiry, error) {
	p, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	perms, err := q.Permissions.Permissions(ctx)
	if err != nil {
		return nil, fmt.Errorf("load permissions: %w", err)
	}
	if !rbac.Can(perms, p.Role, "booking", "view") {
		return nil, errs.Forbidden(fmt.Sprintf("%s cannot view web enquiries.", rbac.RoleLabel[p.Role]))
	}
	return q.Store.Enquiries(ctx, p.Scope())
}

// Inventory is GET /public/site/inventory. It needs no session.
func (q Queries) Inventory(ctx context.Context) (SiteInventory, error) {
	c, err := q.Store.SiteCatalog(ctx)
	if err != nil {
		return SiteInventory{}, err
	}
	out := SiteInventory{Locations: c.Locations, Villas: c.Villas, Groups: c.Groups, Units: c.Units, Listings: c.Listings, RatePlans: c.RatePlans}
	if out.Restrictions, err = q.Sources.Restrictions(ctx); err != nil {
		return SiteInventory{}, err
	}
	if out.Tax, err = q.Sources.Tax(ctx); err != nil {
		return SiteInventory{}, err
	}
	if out.Menu, err = q.Sources.Menu(ctx); err != nil {
		return SiteInventory{}, err
	}
	if out.Team, err = q.Sources.Team(ctx); err != nil {
		return SiteInventory{}, err
	}
	return out, nil
}

// Holds is GET /public/site/holds: every stay and block holding a night in [from, to), stays
// first, without who or what it is. It needs no session.
func (q Queries) Holds(ctx context.Context, from, to string) ([]domain.Hold, error) {
	if stay := domain.ValidateStay(from, to); stay == "Pick both dates." {
		return nil, errs.Invalid("from", stay)
	}
	stays, err := q.Sources.Stays(ctx, from, to)
	if err != nil {
		return nil, err
	}
	blocks, err := q.Store.Blocks(ctx, from, to)
	if err != nil {
		return nil, err
	}
	return append(stays, blocks...), nil
}

// ActiveListing implements channel.Prices: the unit's listing when it is live.
func (q Queries) ActiveListing(ctx context.Context, unitID string) (*channel.UnitListing, error) {
	l, err := q.Store.UnitListing(ctx, unitID)
	if err != nil || l == nil || l.Status != domain.StatusActive {
		return nil, err
	}
	return l, nil
}

// NightlyPrices implements channel.Prices: each night in [from, to) at the live listing's date
// price or the base rate.
func (q Queries) NightlyPrices(ctx context.Context, unitID, from, to string) ([]channel.NightPrice, bool, error) {
	l, err := q.ActiveListing(ctx, unitID)
	if err != nil || l == nil {
		return nil, false, err
	}
	nights := domain.Nights(l.BaseRate, l.DateRates, from, to)
	out := make([]channel.NightPrice, len(nights))
	for i, n := range nights {
		out[i] = channel.NightPrice{Date: n.Date, Rate: n.Rate, Custom: n.Custom}
	}
	return out, true, nil
}

var _ channel.Prices = Queries{}
