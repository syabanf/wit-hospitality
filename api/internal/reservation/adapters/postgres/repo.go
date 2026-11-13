// Package postgres implements the reservation context's write repository, catalog copy, read
// store, projections, stays answers and seed loader on the reservation schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/reservation/domain"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the reservation context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "reservation", FS: sub}
}

// Repo is the write repository.
type Repo struct{ DB *db.DB }

func notFound(err error, what, id string) error {
	if db.NoRows(err) {
		return errs.NotFound(what, id)
	}
	return err
}

func stale(tag pgconn.CommandTag, err error, what string) error {
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errs.Newf(errs.CodeConflict, "Someone else changed this %s. Reload and try again.", what)
	}
	return nil
}

// LockAvailability takes a transaction lock that every command changing what holds a unit takes
// first, so two bookings never pass the same availability check.
func (r Repo) LockAvailability(ctx context.Context) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('reservation.availability'))`)
	return err
}

// Next returns the next number of a sequence: booking, bookingGroup, walk, restriction.
func (r Repo) Next(ctx context.Context, key string) (int64, error) {
	var n int64
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO reservation.counters (key, n) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET n = reservation.counters.n + 1
		RETURNING n - 1`, key).Scan(&n)
	return n, err
}

func scanDoc[T any](row pgx.Row, version *int64) (T, error) {
	var v T
	var raw []byte
	if err := row.Scan(&raw, version); err != nil {
		return v, err
	}
	err := json.Unmarshal(raw, &v)
	return v, err
}

// Booking loads and locks a booking.
func (r Repo) Booking(ctx context.Context, id string) (domain.Booking, error) {
	var version int64
	b, err := scanDoc[domain.Booking](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM reservation.bookings WHERE id = $1 FOR UPDATE`, id), &version)
	b.Version = version
	return b, notFound(err, "booking", id)
}

// BookingByToken loads and locks the booking behind a check-in link.
func (r Repo) BookingByToken(ctx context.Context, token string) (domain.Booking, error) {
	var version int64
	b, err := scanDoc[domain.Booking](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM reservation.bookings WHERE checkin_token = $1 FOR UPDATE`, token), &version)
	b.Version = version
	return b, notFound(err, "online check-in", token)
}

func groupOf(b *domain.Booking) *string {
	if b.BookingGroupID == "" {
		return nil
	}
	return &b.BookingGroupID
}

// InsertBooking adds a booking at version 1.
func (r Repo) InsertBooking(ctx context.Context, b *domain.Booking) error {
	b.Version = 1
	doc, err := json.Marshal(b)
	if err != nil {
		return err
	}
	_, err = r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO reservation.bookings (id, code, unit_id, unit_assigned, status, check_in, check_out, group_id, checkin_token, doc, version)
		VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11)`,
		b.ID, b.Code, b.UnitID, b.UnitAssigned, b.Status, b.CheckIn, b.CheckOut, groupOf(b), domain.CheckinToken(b.ID), doc, b.Version)
	return err
}

// UpdateBooking saves when the version matches.
func (r Repo) UpdateBooking(ctx context.Context, b *domain.Booking) error {
	doc, err := json.Marshal(b)
	if err != nil {
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `
		UPDATE reservation.bookings SET unit_id = $2, unit_assigned = $3, status = $4, check_in = $5::date, check_out = $6::date, group_id = $7,
			doc = $8, version = version + 1
		WHERE id = $1 AND version = $9`,
		b.ID, b.UnitID, b.UnitAssigned, b.Status, b.CheckIn, b.CheckOut, groupOf(b), doc, b.Version)
	if err := stale(tag, err, "booking"); err != nil {
		return err
	}
	b.Version++
	return nil
}

// Holdings lists the confirmed and checked-in stays overlapping [from, to).
func (r Repo) Holdings(ctx context.Context, from, to string) ([]domain.Holding, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `
		SELECT id, code, unit_id, unit_assigned, status, to_char(check_in, 'YYYY-MM-DD'), to_char(check_out, 'YYYY-MM-DD')
		FROM reservation.bookings
		WHERE status IN ('confirmed', 'checked_in') AND check_in < $2::date AND $1::date < check_out
		ORDER BY seq`, from, to)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Holding, error) {
		var h domain.Holding
		err := row.Scan(&h.ID, &h.Code, &h.UnitID, &h.UnitAssigned, &h.Status, &h.CheckIn, &h.CheckOut)
		return h, err
	})
}

// GroupStays lists a group's stays in booking order.
func (r Repo) GroupStays(ctx context.Context, groupID string) ([]domain.Booking, error) {
	return r.bookings(ctx, `SELECT doc, version FROM reservation.bookings WHERE group_id = $1 ORDER BY seq`, groupID)
}

// Arrivals lists the confirmed stays assigned to the unit that check in on date.
func (r Repo) Arrivals(ctx context.Context, unitID, date string) ([]domain.Booking, error) {
	return r.bookings(ctx, `SELECT doc, version FROM reservation.bookings
		WHERE unit_id = $1 AND unit_assigned AND status = 'confirmed' AND check_in = $2::date ORDER BY seq`, unitID, date)
}

func (r Repo) bookings(ctx context.Context, sql string, args ...any) ([]domain.Booking, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Booking, error) {
		var version int64
		b, err := scanDoc[domain.Booking](row, &version)
		b.Version = version
		return b, err
	})
}

// Group loads and locks a group.
func (r Repo) Group(ctx context.Context, id string) (domain.BookingGroup, error) {
	var version int64
	g, err := scanDoc[domain.BookingGroup](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM reservation.booking_groups WHERE id = $1 FOR UPDATE`, id), &version)
	g.Version = version
	return g, notFound(err, "group", id)
}

// InsertGroup adds a group at version 1.
func (r Repo) InsertGroup(ctx context.Context, g *domain.BookingGroup) error {
	g.Version = 1
	doc, err := json.Marshal(g)
	if err != nil {
		return err
	}
	_, err = r.DB.Q(ctx).Exec(ctx, `INSERT INTO reservation.booking_groups (id, code, doc, version) VALUES ($1, $2, $3, $4)`, g.ID, g.Code, doc, g.Version)
	return err
}

// UpdateGroup saves when the version matches.
func (r Repo) UpdateGroup(ctx context.Context, g *domain.BookingGroup) error {
	doc, err := json.Marshal(g)
	if err != nil {
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE reservation.booking_groups SET doc = $2, version = version + 1 WHERE id = $1 AND version = $3`, g.ID, doc, g.Version)
	if err := stale(tag, err, "group"); err != nil {
		return err
	}
	g.Version++
	return nil
}

// Restrictions lists every restriction in creation order.
func (r Repo) Restrictions(ctx context.Context) ([]domain.Restriction, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc, version FROM reservation.restrictions ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Restriction, error) {
		var version int64
		x, err := scanDoc[domain.Restriction](row, &version)
		x.Version = version
		return x, err
	})
}

// Restriction loads and locks a restriction.
func (r Repo) Restriction(ctx context.Context, id string) (domain.Restriction, error) {
	var version int64
	x, err := scanDoc[domain.Restriction](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM reservation.restrictions WHERE id = $1 FOR UPDATE`, id), &version)
	x.Version = version
	return x, notFound(err, "restriction", id)
}

// InsertRestriction adds a restriction at version 1.
func (r Repo) InsertRestriction(ctx context.Context, x *domain.Restriction) error {
	x.Version = 1
	doc, err := json.Marshal(x)
	if err != nil {
		return err
	}
	_, err = r.DB.Q(ctx).Exec(ctx, `INSERT INTO reservation.restrictions (id, group_id, doc, version) VALUES ($1, $2, $3, $4)`, x.ID, x.GroupID, doc, x.Version)
	return err
}

// UpdateRestriction saves when the version matches.
func (r Repo) UpdateRestriction(ctx context.Context, x *domain.Restriction) error {
	doc, err := json.Marshal(x)
	if err != nil {
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE reservation.restrictions SET group_id = $2, doc = $3, version = version + 1 WHERE id = $1 AND version = $4`, x.ID, x.GroupID, doc, x.Version)
	if err := stale(tag, err, "restriction"); err != nil {
		return err
	}
	x.Version++
	return nil
}

// DeleteRestriction removes a restriction.
func (r Repo) DeleteRestriction(ctx context.Context, id string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM reservation.restrictions WHERE id = $1`, id)
	return err
}

// Policies lists the overbooking policies.
func (r Repo) Policies(ctx context.Context) ([]domain.OverbookPolicy, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT group_id, lim FROM reservation.overbooking ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.OverbookPolicy, error) {
		var p domain.OverbookPolicy
		err := row.Scan(&p.GroupID, &p.Limit)
		return p, err
	})
}

// SetPolicy inserts or replaces a policy and returns its version.
func (r Repo) SetPolicy(ctx context.Context, p domain.OverbookPolicy) (int64, error) {
	var version int64
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO reservation.overbooking (group_id, lim) VALUES ($1, $2)
		ON CONFLICT (group_id) DO UPDATE SET lim = EXCLUDED.lim, version = reservation.overbooking.version + 1
		RETURNING version`, p.GroupID, p.Limit).Scan(&version)
	return version, err
}

// InsertWalk adds a walk.
func (r Repo) InsertWalk(ctx context.Context, w domain.Walk) error {
	doc, err := json.Marshal(w)
	if err != nil {
		return err
	}
	_, err = r.DB.Q(ctx).Exec(ctx, `INSERT INTO reservation.walks (id, booking_id, doc) VALUES ($1, $2, $3)`, w.ID, w.BookingID, doc)
	return err
}

// PreCheckIn loads and locks a stay's online check-in; nil when the guest has sent none.
func (r Repo) PreCheckIn(ctx context.Context, bookingID string) (*domain.PreCheckIn, error) {
	var version int64
	p, err := scanDoc[domain.PreCheckIn](r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM reservation.pre_checkins WHERE booking_id = $1 FOR UPDATE`, bookingID), &version)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.Version = version
	return &p, nil
}

// SavePreCheckIn inserts (Version 0) or replaces when the version matches.
func (r Repo) SavePreCheckIn(ctx context.Context, p *domain.PreCheckIn) error {
	doc, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if p.Version == 0 {
		p.Version = 1
		_, err = r.DB.Q(ctx).Exec(ctx, `INSERT INTO reservation.pre_checkins (booking_id, doc, version) VALUES ($1, $2, 1)`, p.BookingID, doc)
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE reservation.pre_checkins SET doc = $2, version = version + 1 WHERE booking_id = $1 AND version = $3`, p.BookingID, doc, p.Version)
	if err := stale(tag, err, "online check-in"); err != nil {
		return err
	}
	p.Version++
	return nil
}
