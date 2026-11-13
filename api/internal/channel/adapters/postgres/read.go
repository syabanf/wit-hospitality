package postgres

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/channel/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/property"
)

// ReadStore reads the channel schema: write tables, the v_listings view and the projected
// property catalog.
type ReadStore struct{ DB *db.DB }

// inScope is the allowedVilla rule in SQL: $1 villa ids, $2 location ids; empty lists allow all.
const inScope = `((cardinality($1::text[]) > 0 AND villa_id = ANY($1)) OR
	(cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR location_id = ANY($2))))`

func args(s rbac.Scope) []any {
	vil, loc := s.VillaIDs, s.LocationIDs
	if vil == nil {
		vil = []string{}
	}
	if loc == nil {
		loc = []string{}
	}
	return []any{vil, loc}
}

func collect[T any](rows pgx.Rows, err error, scan func(r pgx.CollectableRow) (T, error)) ([]T, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, scan)
}

// Accounts returns every host account in the order they were added.
func (s ReadStore) Accounts(ctx context.Context) ([]domain.Account, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT id, name, email, status, slot FROM channel.airbnb_accounts ORDER BY seq`)
	return collect(rows, err, func(r pgx.CollectableRow) (domain.Account, error) {
		var a domain.Account
		err := r.Scan(&a.ID, &a.Name, &a.Email, &a.Status, &a.Slot)
		return a, err
	})
}

// Listings returns the listings of units in scope.
func (s ReadStore) Listings(ctx context.Context, sc rbac.Scope) ([]domain.Listing, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT id, account_id, unit_id, title, airbnb_id, status, date_rates FROM channel.v_listings
		WHERE `+inScope+` ORDER BY seq`, args(sc)...)
	return collect(rows, err, func(r pgx.CollectableRow) (domain.Listing, error) {
		var l domain.Listing
		var rates []byte
		if err := r.Scan(&l.ID, &l.AccountID, &l.UnitID, &l.Title, &l.AirbnbID, &l.Status, &rates); err != nil {
			return l, err
		}
		return l, json.Unmarshal(rates, &l.DateRates)
	})
}

// UnitListing returns the unit's listing with the unit's nightly rate as its base rate.
func (s ReadStore) UnitListing(ctx context.Context, unitID string) (*channel.UnitListing, error) {
	var l channel.UnitListing
	var rates []byte
	var base *int64
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT id, account_id, unit_id, status, date_rates, nightly_rate FROM channel.v_listings WHERE unit_id = $1`, unitID).
		Scan(&l.ListingID, &l.AccountID, &l.UnitID, &l.Status, &rates, &base)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if base == nil {
		// Property has not published the unit yet, so the listing has no base rate to sell at.
		return nil, nil
	}
	l.BaseRate = *base
	return &l, json.Unmarshal(rates, &l.DateRates)
}

// Enquiries returns owner notes and enquiries about villas in scope, newest first.
func (s ReadStore) Enquiries(ctx context.Context, sc rbac.Scope) ([]domain.Enquiry, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT `+enquiryColumns+` FROM (
			SELECT e.*, e.villa_id AS scope_villa, coalesce(v.location_id, '') AS location_id
			FROM channel.enquiries e LEFT JOIN channel.rm_villas v ON v.id = e.villa_id
		) e
		WHERE e.topic = 'owner' OR ((cardinality($1::text[]) > 0 AND e.scope_villa = ANY($1)) OR
			(cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR e.location_id = ANY($2))))
		ORDER BY e.pos DESC`, args(sc)...)
	return collect(rows, err, func(r pgx.CollectableRow) (domain.Enquiry, error) { return scanEnquiry(r) })
}

// SiteCatalog returns the projected property catalog and what prices each listed unit.
func (s ReadStore) SiteCatalog(ctx context.Context) (query.SiteCatalog, error) {
	var c query.SiteCatalog
	q := s.DB.Q(ctx)
	rows, err := q.Query(ctx, `SELECT id, name, area FROM channel.rm_locations ORDER BY seq`)
	if c.Locations, err = collect(rows, err, func(r pgx.CollectableRow) (property.Location, error) {
		var l property.Location
		err := r.Scan(&l.ID, &l.Name, &l.Area)
		return l, err
	}); err != nil {
		return c, err
	}
	rows, err = q.Query(ctx, `SELECT id, location_id, code, name, description, facilities, site FROM channel.rm_villas ORDER BY seq`)
	if c.Villas, err = collect(rows, err, func(r pgx.CollectableRow) (property.Villa, error) {
		var v property.Villa
		var site []byte
		if err := r.Scan(&v.ID, &v.LocationID, &v.Code, &v.Name, &v.Description, &v.Facilities, &site); err != nil || site == nil {
			v.Photos = []property.Photo{}
			return v, err
		}
		return v, json.Unmarshal(site, &v)
	}); err != nil {
		return c, err
	}
	rows, err = q.Query(ctx, `SELECT id, villa_id, name, interchangeable, operator_assigns FROM channel.rm_unit_groups ORDER BY seq`)
	if c.Groups, err = collect(rows, err, func(r pgx.CollectableRow) (property.Group, error) {
		var g property.Group
		err := r.Scan(&g.ID, &g.VillaID, &g.Name, &g.Interchangeable, &g.OperatorAssigns)
		return g, err
	}); err != nil {
		return c, err
	}
	rows, err = q.Query(ctx, `SELECT id, villa_id, group_id, code, name, bedrooms, nightly_rate, status, amenities, site FROM channel.rm_units ORDER BY seq`)
	if c.Units, err = collect(rows, err, func(r pgx.CollectableRow) (property.Unit, error) {
		var u property.Unit
		var site []byte
		if err := r.Scan(&u.ID, &u.VillaID, &u.GroupID, &u.Code, &u.Name, &u.Bedrooms, &u.NightlyRate, &u.Status, &u.Amenities, &site); err != nil || site == nil {
			u.Beds, u.Photos = []property.Bed{}, []property.Photo{}
			return u, err
		}
		return u, json.Unmarshal(site, &u)
	}); err != nil {
		return c, err
	}
	rows, err = q.Query(ctx, `SELECT group_id, weekday_rate, weekend_rate, seasons FROM channel.rm_rate_plans ORDER BY seq`)
	if c.RatePlans, err = collect(rows, err, func(r pgx.CollectableRow) (property.RatePlan, error) {
		var p property.RatePlan
		var seasons []byte
		if err := r.Scan(&p.GroupID, &p.WeekdayRate, &p.WeekendRate, &seasons); err != nil {
			return p, err
		}
		return p, json.Unmarshal(seasons, &p.Seasons)
	}); err != nil {
		return c, err
	}
	rows, err = q.Query(ctx, `SELECT unit_id, status, date_rates FROM channel.listings ORDER BY seq`)
	c.Listings, err = collect(rows, err, func(r pgx.CollectableRow) (query.SiteListing, error) {
		var l query.SiteListing
		var rates []byte
		if err := r.Scan(&l.UnitID, &l.Status, &rates); err != nil {
			return l, err
		}
		return l, json.Unmarshal(rates, &l.DateRates)
	})
	return c, err
}

// Blocks returns the unit blocks holding a night in [from, to).
func (s ReadStore) Blocks(ctx context.Context, from, to string) ([]domain.Hold, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT unit_id, from_date, to_date FROM channel.rm_unit_blocks
		WHERE NOT removed AND from_date < $2 AND $1 < to_date ORDER BY seq`, from, to)
	return collect(rows, err, func(r pgx.CollectableRow) (domain.Hold, error) {
		h := domain.Hold{UnitAssigned: true}
		err := r.Scan(&h.UnitID, &h.From, &h.To)
		return h, err
	})
}

var _ query.ReadStore = ReadStore{}
