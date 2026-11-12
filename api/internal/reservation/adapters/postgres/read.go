package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/app/query"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

// CatalogStore reads reservation's copy of the property catalog.
type CatalogStore struct{ DB *db.DB }

// Catalog loads every location, villa, room type, unit, rate plan and live block.
func (s CatalogStore) Catalog(ctx context.Context) (domain.Catalog, error) {
	q := s.DB.Q(ctx)
	var c domain.Catalog
	var err error
	collect := func(sql string, scan func(pgx.CollectableRow) error) {
		if err != nil {
			return
		}
		var rows pgx.Rows
		if rows, err = q.Query(ctx, sql); err != nil {
			return
		}
		_, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (struct{}, error) { return struct{}{}, scan(r) })
	}
	collect(`SELECT id, name FROM reservation.cat_locations ORDER BY seq`, func(r pgx.CollectableRow) error {
		var l domain.Location
		e := r.Scan(&l.ID, &l.Name)
		c.Locations = append(c.Locations, l)
		return e
	})
	collect(`SELECT id, location_id, name FROM reservation.cat_villas ORDER BY seq`, func(r pgx.CollectableRow) error {
		var v domain.Villa
		e := r.Scan(&v.ID, &v.LocationID, &v.Name)
		c.Villas = append(c.Villas, v)
		return e
	})
	collect(`SELECT id, villa_id, name, interchangeable, operator_assigns FROM reservation.cat_unit_groups ORDER BY seq`, func(r pgx.CollectableRow) error {
		var g domain.UnitGroup
		e := r.Scan(&g.ID, &g.VillaID, &g.Name, &g.Interchangeable, &g.OperatorAssigns)
		c.Groups = append(c.Groups, g)
		return e
	})
	collect(`SELECT id, villa_id, group_id, code, name, nightly_rate, status FROM reservation.cat_units ORDER BY seq`, func(r pgx.CollectableRow) error {
		var u domain.Unit
		e := r.Scan(&u.ID, &u.VillaID, &u.GroupID, &u.Code, &u.Name, &u.NightlyRate, &u.Status)
		c.Units = append(c.Units, u)
		return e
	})
	collect(`SELECT plan FROM reservation.cat_rate_plans`, func(r pgx.CollectableRow) error {
		var raw []byte
		if e := r.Scan(&raw); e != nil {
			return e
		}
		var p domain.RatePlan
		e := json.Unmarshal(raw, &p)
		c.RatePlans = append(c.RatePlans, p)
		return e
	})
	collect(`SELECT id, unit_id, from_date, to_date, reason FROM reservation.cat_blocks WHERE NOT removed ORDER BY from_date, id`, func(r pgx.CollectableRow) error {
		var b domain.UnitBlock
		e := r.Scan(&b.ID, &b.UnitID, &b.From, &b.To, &b.Reason)
		c.Blocks = append(c.Blocks, b)
		return e
	})
	return c, err
}

// ReadStore reads the projected rm_* tables.
type ReadStore struct{ DB *db.DB }

// readTables maps each read model to its order, the mock's array order. The mock appends a new
// booking with the next number, so bookings go by the number in their id; restrictions keep the
// write model's order (position); the rest go in projection order. id breaks any tie.
var readTables = map[string]string{
	query.Bookings:     `(substring(id from '[0-9]+$'))::bigint, id`,
	query.Groups:       `seq, id`,
	query.Restrictions: `position, seq, id`,
	query.Overbooking:  `seq, id`,
	query.Walks:        `seq, id`,
	query.PreCheckIns:  `seq, id`,
}

// inScope is the allowedVilla rule for rows that may sit in several villas: $1 villa ids, $2
// location ids; empty lists allow all.
const inScope = `((cardinality($1::text[]) > 0 AND villa_ids && $1) OR
	(cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR location_ids && $2)))`

// Docs returns one read model's rows in scope, oldest first.
func (s ReadStore) Docs(ctx context.Context, table string, sc rbac.Scope) ([]json.RawMessage, error) {
	order, ok := readTables[table]
	if !ok {
		return nil, fmt.Errorf("unknown read model %q", table)
	}
	vil, loc := sc.VillaIDs, sc.LocationIDs
	if vil == nil {
		vil = []string{}
	}
	if loc == nil {
		loc = []string{}
	}
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT doc FROM reservation.`+table+` WHERE NOT removed AND `+inScope+` ORDER BY `+order, vil, loc)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (json.RawMessage, error) {
		var raw []byte
		err := r.Scan(&raw)
		return raw, err
	})
}

// Site answers channel's questions about stays: the booking an enquiry became, the stays the
// public site shows as held nights, and the stay restrictions it prices against.
type Site struct{ DB *db.DB }

// BookingCode returns the code of a booking.
func (s Site) BookingCode(ctx context.Context, id string) (string, bool, error) {
	var code string
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT code FROM reservation.bookings WHERE id = $1`, id).Scan(&code)
	if db.NoRows(err) {
		return "", false, nil
	}
	return code, err == nil, err
}

// Holds lists the confirmed and checked-in stays overlapping [from, to).
func (s Site) Holds(ctx context.Context, from, to string) ([]domain.Holding, error) {
	return Repo(s).Holdings(ctx, from, to)
}

// Restrictions lists every stay restriction as SiteRestriction, oldest first: without who made it,
// when, or the internal note.
func (s Site) Restrictions(ctx context.Context) ([]json.RawMessage, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT doc - 'createdBy' - 'createdOn' - 'note' FROM reservation.restrictions ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (json.RawMessage, error) {
		var raw []byte
		err := r.Scan(&raw)
		return raw, err
	})
}

// Stays answers property's questions about stays from the booking write table, so a unit block or
// a unit change sees a stay the moment it is saved. It satisfies property's command.Stays.
type Stays struct{ DB *db.DB }

// OverlappingStay returns the code of a confirmed or checked-in stay on the unit in [from, to).
func (s Stays) OverlappingStay(ctx context.Context, unitID, from, to string) (string, bool, error) {
	var code string
	err := s.DB.Q(ctx).QueryRow(ctx, `
		SELECT code FROM reservation.bookings
		WHERE unit_id = $1 AND status IN ('confirmed', 'checked_in') AND check_in < $3::date AND $2::date < check_out
		ORDER BY seq LIMIT 1`, unitID, from, to).Scan(&code)
	if db.NoRows(err) {
		return "", false, nil
	}
	return code, err == nil, err
}

// HasUpcomingStays reports confirmed or checked-in stays with the unit assigned that leave after today.
func (s Stays) HasUpcomingStays(ctx context.Context, unitID, today string) (bool, error) {
	var found bool
	err := s.DB.Q(ctx).QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM reservation.bookings
		WHERE unit_id = $1 AND unit_assigned AND status IN ('confirmed', 'checked_in') AND check_out > $2::date)`, unitID, today).Scan(&found)
	return found, err
}

// WaitingForRoom lists the codes of draft and confirmed stays booked against the room type that
// still wait for a room.
func (s Stays) WaitingForRoom(ctx context.Context, groupID string) ([]string, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT b.code FROM reservation.bookings b JOIN reservation.cat_units u ON u.id = b.unit_id
		WHERE NOT b.unit_assigned AND b.status IN ('draft', 'confirmed') AND u.group_id = $1
		ORDER BY b.seq`, groupID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
