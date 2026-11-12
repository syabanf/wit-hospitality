// Package postgres implements the billing context's store, its copies of reservation and the
// property catalog, the projections that keep them, and the seed loader, on the billing schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/syabanf/wit-hospitality/api/internal/billing/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/billing/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the billing context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "billing", FS: sub}
}

// Store is the billing store over the billing schema; it satisfies command.Store.
type Store struct{ DB *db.DB }

var _ command.Store = Store{}

// tables are the record tables command handlers name; nothing else reaches the SQL.
var tables = map[string]bool{
	command.Postings: true, command.Payments: true, command.Links: true, command.Audits: true, command.Shifts: true,
	command.HandOvers: true, command.Codes: true, command.Accounts: true, command.Invoices: true,
	command.LedgerPayments: true, command.WriteOffs: true, command.CashAccounts: true,
}

func table(name string) string {
	if !tables[name] {
		panic("billing: unknown table " + name)
	}
	return "billing." + name
}

// Lock serialises billing's money commands for the transaction.
func (s Store) Lock(ctx context.Context) error {
	_, err := s.DB.Q(ctx).Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('billing.money'))`)
	return err
}

// Next returns the next number of a sequence.
func (s Store) Next(ctx context.Context, key string) (int64, error) {
	var n int64
	err := s.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO billing.counters (key, n) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET n = billing.counters.n + 1
		RETURNING n - 1`, key).Scan(&n)
	return n, err
}

// Setting reads a setting; nil when it was never saved.
func (s Store) Setting(ctx context.Context, key string) (json.RawMessage, error) {
	var raw []byte
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM billing.settings WHERE key = $1`, key).Scan(&raw)
	if db.NoRows(err) {
		return nil, nil
	}
	return raw, err
}

// PutSetting saves a setting.
func (s Store) PutSetting(ctx context.Context, key string, doc any) error {
	raw, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	_, err = s.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.settings (key, doc) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, version = billing.settings.version + 1`, key, raw)
	return err
}

// Get loads and locks one record; NOT_FOUND names it as `what`.
func (s Store) Get(ctx context.Context, name, id, what string) (json.RawMessage, error) {
	var raw []byte
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM `+table(name)+` WHERE id = $1 FOR UPDATE`, id).Scan(&raw)
	if db.NoRows(err) {
		return nil, errs.NotFound(what, id)
	}
	return raw, err
}

// Put inserts or replaces a record.
func (s Store) Put(ctx context.Context, name string, r command.Row) error {
	raw, err := json.Marshal(r.Doc)
	if err != nil {
		return err
	}
	_, err = s.DB.Q(ctx).Exec(ctx, `
		INSERT INTO `+table(name)+` (id, booking_id, villa_id, location_id, ref, doc) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET booking_id = EXCLUDED.booking_id, villa_id = EXCLUDED.villa_id,
			location_id = EXCLUDED.location_id, ref = EXCLUDED.ref, doc = EXCLUDED.doc, version = `+table(name)+`.version + 1`,
		r.ID, r.BookingID, r.VillaID, r.LocationID, r.Ref, raw)
	return err
}

func (s Store) rows(ctx context.Context, sql string, args ...any) ([]command.Stored, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []command.Stored
	for rows.Next() {
		var r command.Stored
		var raw []byte
		if err := rows.Scan(&r.VillaID, &r.LocationID, &raw); err != nil {
			return nil, err
		}
		r.Doc = raw
		out = append(out, r)
	}
	return out, rows.Err()
}

// All lists a table in insertion order with each record's scope.
func (s Store) All(ctx context.Context, name string) ([]command.Stored, error) {
	return s.rows(ctx, `SELECT villa_id, location_id, doc FROM `+table(name)+` ORDER BY seq`)
}

// ByBooking lists a stay's records in insertion order.
func (s Store) ByBooking(ctx context.Context, name, bookingID string) ([]command.Stored, error) {
	return s.rows(ctx, `SELECT villa_id, location_id, doc FROM `+table(name)+` WHERE booking_id = $1 ORDER BY seq`, bookingID)
}

// ByRef lists the records carrying a reference in insertion order.
func (s Store) ByRef(ctx context.Context, name, ref string) ([]command.Stored, error) {
	return s.rows(ctx, `SELECT villa_id, location_id, doc FROM `+table(name)+` WHERE ref = $1 ORDER BY seq`, ref)
}

// Stay reads billing's copy of a booking.
func (s Store) Stay(ctx context.Context, id string) (json.RawMessage, error) {
	var raw []byte
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM billing.rm_stays WHERE id = $1`, id).Scan(&raw)
	if db.NoRows(err) {
		return nil, errs.NotFound("booking", id)
	}
	return raw, err
}

// Stays lists the copies of bookings in one status, or every booking when status is empty.
func (s Store) Stays(ctx context.Context, status string) ([]json.RawMessage, error) {
	return s.docs(ctx, `SELECT doc FROM billing.rm_stays WHERE $1 = '' OR status = $1 ORDER BY code`, status)
}

// GroupStays lists the copies of a group's bookings.
func (s Store) GroupStays(ctx context.Context, groupID string) ([]json.RawMessage, error) {
	return s.docs(ctx, `SELECT doc FROM billing.rm_stays WHERE group_id = $1 ORDER BY code`, groupID)
}

func (s Store) docs(ctx context.Context, sql string, args ...any) ([]json.RawMessage, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []json.RawMessage
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		out = append(out, raw)
	}
	return out, rows.Err()
}

// Group reads billing's copy of a booking group.
func (s Store) Group(ctx context.Context, id string) (json.RawMessage, error) {
	var raw []byte
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM billing.rm_groups WHERE id = $1`, id).Scan(&raw)
	if db.NoRows(err) {
		return nil, errs.NotFound("group", id)
	}
	return raw, err
}

// Place reads where a unit sits from the catalog copy; an unknown unit has an empty place.
func (s Store) Place(ctx context.Context, unitID string) (command.Place, error) {
	p := command.Place{UnitID: unitID}
	err := s.DB.Q(ctx).QueryRow(ctx, `
		SELECT u.code, u.name, v.id, v.name, l.id, l.name, COALESCE(g.doc->>'name', ''), g.doc
		FROM billing.cat_units u
		JOIN billing.cat_villas v ON v.id = u.villa_id
		LEFT JOIN billing.cat_locations l ON l.id = v.location_id
		LEFT JOIN billing.cat_groups g ON g.id = u.group_id
		WHERE u.id = $1`, unitID).Scan(&p.UnitCode, &p.UnitName, &p.VillaID, &p.VillaName, &p.LocationID, &p.LocationName, &p.RoomType, &p.Group)
	if db.NoRows(err) {
		return p, nil
	}
	return p, err
}

// Account reads billing's copy of an Airbnb account; nil when billing has not seen it.
func (s Store) Account(ctx context.Context, id string) (json.RawMessage, error) {
	var raw []byte
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM billing.cat_accounts WHERE id = $1`, id).Scan(&raw)
	if db.NoRows(err) {
		return nil, nil
	}
	return raw, err
}

// Requests reads billing's copy of the service requests on a stay, oldest first.
func (s Store) Requests(ctx context.Context, bookingID string) ([]domain.Request, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT doc FROM billing.rm_requests WHERE booking_id = $1 ORDER BY length(doc->>'number'), doc->>'number'`, bookingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.Request
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var r domain.Request
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Villa reads a villa's name and location.
func (s Store) Villa(ctx context.Context, id string) (command.Place, error) {
	p := command.Place{VillaID: id}
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT name, location_id FROM billing.cat_villas WHERE id = $1`, id).Scan(&p.VillaName, &p.LocationID)
	if db.NoRows(err) {
		return p, nil
	}
	return p, err
}

// NightPosts reads the nights the audit posted on a stay.
func (s Store) NightPosts(ctx context.Context, bookingID string) ([]string, bool, error) {
	var raw []byte
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT dates FROM billing.night_posts WHERE booking_id = $1`, bookingID).Scan(&raw)
	if db.NoRows(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var dates []string
	err = json.Unmarshal(raw, &dates)
	return dates, true, err
}

// SetNightPosts saves the nights the audit posted on a stay.
func (s Store) SetNightPosts(ctx context.Context, bookingID string, dates []string) error {
	raw, err := json.Marshal(dates)
	if err != nil {
		return err
	}
	_, err = s.DB.Q(ctx).Exec(ctx, `
		INSERT INTO billing.night_posts (booking_id, dates) VALUES ($1, $2)
		ON CONFLICT (booking_id) DO UPDATE SET dates = EXCLUDED.dates`, bookingID, raw)
	return err
}
