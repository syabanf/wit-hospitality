// Package postgres implements the guest context's write repository, read store, projections and
// seed loader on the guest schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/guest/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the guest context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "guest", FS: sub}
}

// Repo is the write repository. Loads lock the row for the transaction.
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

// Next is the mock's seq(key): 1, 2, 3, ... per kind of record.
func (r Repo) Next(ctx context.Context, key string) (int64, error) {
	var n int64
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO guest.counters (key, next) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET next = guest.counters.next + 1
		RETURNING next - 1`, key).Scan(&n)
	return n, err
}

// loadDoc scans a doc and version into v.
func loadDoc[T any](row pgx.Row, v *T, version *int64) error {
	var raw []byte
	if err := row.Scan(&raw, version); err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

// Guest loads and locks a guest.
func (r Repo) Guest(ctx context.Context, id string) (domain.Guest, error) {
	var g domain.Guest
	err := loadDoc(r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM guest.guests WHERE id = $1 FOR UPDATE`, id), &g, &g.Version)
	return g, notFound(err, "guest", id)
}

// InsertGuest adds a guest at version 1.
func (r Repo) InsertGuest(ctx context.Context, g *domain.Guest) error {
	g.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO guest.guests (id, name, doc, version) VALUES ($1, $2, $3, 1)`, g.ID, g.Name, g)
	return err
}

// UpdateGuest saves when the version matches.
func (r Repo) UpdateGuest(ctx context.Context, g *domain.Guest) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE guest.guests SET name = $2, doc = $3, version = version + 1 WHERE id = $1 AND version = $4`, g.ID, g.Name, g, g.Version)
	if err := stale(tag, err, "guest"); err != nil {
		return err
	}
	g.Version++
	return nil
}

// DeleteGuest removes a guest.
func (r Repo) DeleteGuest(ctx context.Context, id string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM guest.guests WHERE id = $1`, id)
	return err
}

// Companion loads and locks a companion.
func (r Repo) Companion(ctx context.Context, id string) (domain.Companion, error) {
	var c domain.Companion
	err := loadDoc(r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM guest.companions WHERE id = $1 FOR UPDATE`, id), &c, &c.Version)
	return c, notFound(err, "companion", id)
}

// CompanionsOf lists the companions registered on a stay, in order.
func (r Repo) CompanionsOf(ctx context.Context, bookingID string) ([]domain.Companion, error) {
	return companionsOf(ctx, r.DB, bookingID)
}

func companionsOf(ctx context.Context, d *db.DB, bookingID string) ([]domain.Companion, error) {
	rows, err := d.Q(ctx).Query(ctx, `SELECT doc FROM guest.companions WHERE booking_id = $1 ORDER BY seq`, bookingID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, docRow[domain.Companion])
}

func docRow[T any](row pgx.CollectableRow) (T, error) {
	var v T
	var raw []byte
	if err := row.Scan(&raw); err != nil {
		return v, err
	}
	err := json.Unmarshal(raw, &v)
	return v, err
}

// InsertCompanion adds a companion at version 1.
func (r Repo) InsertCompanion(ctx context.Context, c *domain.Companion) error {
	c.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO guest.companions (id, booking_id, doc, version) VALUES ($1, $2, $3, 1)`, c.ID, c.BookingID, c)
	return err
}

// UpdateCompanion saves when the version matches.
func (r Repo) UpdateCompanion(ctx context.Context, c *domain.Companion) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE guest.companions SET doc = $2, version = version + 1 WHERE id = $1 AND version = $3`, c.ID, c, c.Version)
	if err := stale(tag, err, "companion"); err != nil {
		return err
	}
	c.Version++
	return nil
}

// DeleteCompanion removes a companion.
func (r Repo) DeleteCompanion(ctx context.Context, id string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `DELETE FROM guest.companions WHERE id = $1`, id)
	return err
}

// ReportedPeople lists who on the stay was already reported.
func (r Repo) ReportedPeople(ctx context.Context, bookingID string) ([]string, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT person_id FROM guest.foreign_reports WHERE booking_id = $1 ORDER BY seq`, bookingID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// InsertReport adds a report line.
func (r Repo) InsertReport(ctx context.Context, f domain.ForeignReport) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO guest.foreign_reports (id, booking_id, person_id, reported_at, reported_by, reference) VALUES ($1, $2, $3, $4, $5, $6)`,
		f.ID, f.BookingID, f.PersonID, f.ReportedAt, f.ReportedBy, f.Reference)
	return err
}

// MoveReports re-points the dropped guest's report lines at the kept guest and returns the stays
// they cover. A stay that already reports the kept guest keeps that line.
func (r Repo) MoveReports(ctx context.Context, dropID, keepID string) ([]string, error) {
	q := r.DB.Q(ctx)
	if _, err := q.Exec(ctx, `DELETE FROM guest.foreign_reports d WHERE d.person_id = $1
		AND EXISTS (SELECT 1 FROM guest.foreign_reports k WHERE k.booking_id = d.booking_id AND k.person_id = $2)`, dropID, keepID); err != nil {
		return nil, err
	}
	rows, err := q.Query(ctx, `UPDATE guest.foreign_reports SET person_id = $2 WHERE person_id = $1 RETURNING booking_id`, dropID, keepID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// LostItem loads and locks a lost item.
func (r Repo) LostItem(ctx context.Context, id string) (domain.LostItem, error) {
	var i domain.LostItem
	err := loadDoc(r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM guest.lost_items WHERE id = $1 FOR UPDATE`, id), &i, &i.Version)
	return i, notFound(err, "lost item", id)
}

// InsertLostItem adds an item at version 1.
func (r Repo) InsertLostItem(ctx context.Context, i *domain.LostItem) error {
	i.Version = 1
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO guest.lost_items (id, number, villa_id, guest_id, doc, version) VALUES ($1, $2, $3, $4, $5, 1)`, i.ID, i.Number, i.VillaID, i.GuestID, i)
	return err
}

// UpdateLostItem saves when the version matches.
func (r Repo) UpdateLostItem(ctx context.Context, i *domain.LostItem) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE guest.lost_items SET villa_id = $2, guest_id = $3, doc = $4, version = version + 1 WHERE id = $1 AND version = $5`, i.ID, i.VillaID, i.GuestID, i, i.Version)
	if err := stale(tag, err, "lost item"); err != nil {
		return err
	}
	i.Version++
	return nil
}

// MoveLostItems gives the dropped guest's items to the kept guest and returns their ids.
func (r Repo) MoveLostItems(ctx context.Context, dropID, keepID string) ([]string, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `
		UPDATE guest.lost_items SET guest_id = $2, doc = jsonb_set(doc, '{guestId}', to_jsonb($2::text)), version = version + 1
		WHERE guest_id = $1 RETURNING id`, dropID, keepID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

const lostFoundKey = "lost-found"

// Settings loads and locks the lost and found settings; the default when never saved.
func (r Repo) Settings(ctx context.Context) (domain.LostFoundSettings, error) {
	return settings(ctx, r.DB, " FOR UPDATE")
}

func settings(ctx context.Context, d *db.DB, lock string) (domain.LostFoundSettings, error) {
	var raw []byte
	err := d.Q(ctx).QueryRow(ctx, `SELECT value FROM guest.settings WHERE key = $1`+lock, lostFoundKey).Scan(&raw)
	if db.NoRows(err) {
		return domain.DefaultLostFound, nil
	}
	if err != nil {
		return domain.LostFoundSettings{}, err
	}
	var s domain.LostFoundSettings
	err = json.Unmarshal(raw, &s)
	return s, err
}

// SaveSettings stores the settings and returns the new version.
func (r Repo) SaveSettings(ctx context.Context, s domain.LostFoundSettings) (int64, error) {
	var version int64
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO guest.settings (key, value, version) VALUES ($1, $2, 1)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = guest.settings.version + 1
		RETURNING version`, lostFoundKey, s).Scan(&version)
	return version, err
}

// Villa reads a villa from the property projection.
func (r Repo) Villa(ctx context.Context, id string) (domain.VillaRef, error) {
	var v domain.VillaRef
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, location_id, name FROM guest.rm_villas WHERE id = $1`, id).Scan(&v.ID, &v.LocationID, &v.Name)
	return v, notFound(err, "villa", id)
}

// Unit reads a unit from the property projection.
func (r Repo) Unit(ctx context.Context, id string) (domain.UnitRef, error) {
	var u domain.UnitRef
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, code FROM guest.rm_units WHERE id = $1`, id).Scan(&u.ID, &u.VillaID, &u.Code)
	return u, notFound(err, "unit", id)
}

const stayColumns = `id, code, guest_id, unit_id, villa_id, status, check_in, check_out, checked_in_on, checked_out_on, arrival_time, adults`

func scanStay(row pgx.Row) (domain.Stay, error) {
	var s domain.Stay
	err := row.Scan(&s.ID, &s.Code, &s.GuestID, &s.UnitID, &s.VillaID, &s.Status, &s.CheckIn, &s.CheckOut, &s.CheckedInOn, &s.CheckedOutOn, &s.ArrivalTime, &s.Adults)
	return s, err
}

// Stay reads what guest knows of a booking.
func (r Repo) Stay(ctx context.Context, id string) (domain.Stay, error) {
	s, err := scanStay(r.DB.Q(ctx).QueryRow(ctx, `SELECT `+stayColumns+` FROM guest.rm_stays WHERE id = $1`, id))
	return s, notFound(err, "booking", id)
}

// MoveGuestReferences re-points guest's own copies of stays and group leads from the dropped
// guest to the kept one and counts them; reservation moves the bookings themselves when it
// consumes guest.merged.v1.
func (r Repo) MoveGuestReferences(ctx context.Context, dropID, keepID string) (stays, groups int64, err error) {
	q := r.DB.Q(ctx)
	tag, err := q.Exec(ctx, `UPDATE guest.rm_stays SET guest_id = $2 WHERE guest_id = $1`, dropID, keepID)
	if err != nil {
		return 0, 0, err
	}
	stays = tag.RowsAffected()
	tag, err = q.Exec(ctx, `UPDATE guest.rm_group_leads SET lead_guest_id = $2 WHERE lead_guest_id = $1`, dropID, keepID)
	if err != nil {
		return 0, 0, err
	}
	return stays, tag.RowsAffected(), nil
}
