// Package postgres implements the messaging context's store, read store, projections and seed
// loader on the messaging schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/messaging"
	"github.com/syabanf/wit-hospitality/api/internal/messaging/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the messaging context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "messaging", FS: sub}
}

// Repo is the write store.
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

// Next returns the next number of a sequence.
func (r Repo) Next(ctx context.Context, key string) (int64, error) {
	var n int64
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO messaging.counters (key, n) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET n = messaging.counters.n + 1
		RETURNING n - 1`, key).Scan(&n)
	return n, err
}

// LockSweep takes the transaction lock the sweep holds.
func (r Repo) LockSweep(ctx context.Context) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('messaging.sweep'))`)
	return err
}

// Settings reads the settings, the defaults until someone saves them.
func (r Repo) Settings(ctx context.Context) (domain.Settings, int64, error) {
	var raw []byte
	var version int64
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM messaging.settings WHERE id = 'messaging'`).Scan(&raw, &version)
	if db.NoRows(err) {
		return domain.DefaultSettings(), 0, nil
	}
	if err != nil {
		return domain.Settings{}, 0, err
	}
	var s domain.Settings
	err = json.Unmarshal(raw, &s)
	return s, version, err
}

// SaveSettings writes the settings when the version matches (0 for the first save).
func (r Repo) SaveSettings(ctx context.Context, s domain.Settings, version int64) (int64, error) {
	doc, err := json.Marshal(s)
	if err != nil {
		return 0, err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO messaging.settings (id, doc, version) VALUES ('messaging', $1, 1)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = messaging.settings.version + 1
		WHERE messaging.settings.version = $2`, doc, version)
	return version + 1, stale(tag, err, "setting")
}

func scanMessage(row pgx.Row) (domain.Message, error) {
	var m domain.Message
	var raw []byte
	if err := row.Scan(&raw, &m.Version); err != nil {
		return m, err
	}
	version := m.Version
	err := json.Unmarshal(raw, &m)
	m.Version = version
	return m, err
}

// Message loads and locks a message.
func (r Repo) Message(ctx context.Context, id string) (domain.Message, error) {
	m, err := scanMessage(r.DB.Q(ctx).QueryRow(ctx, `SELECT doc, version FROM messaging.messages WHERE id = $1 FOR UPDATE`, id))
	return m, notFound(err, "message", id)
}

// InsertMessage adds a message at version 1.
func (r Repo) InsertMessage(ctx context.Context, m *domain.Message, villaID string) error {
	m.Version = 1
	doc, err := json.Marshal(m)
	if err != nil {
		return err
	}
	_, err = r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO messaging.messages (id, booking_id, guest_id, villa_id, template_key, system, status, doc, version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)`,
		m.ID, m.BookingID, m.GuestID, villaID, m.TemplateKey, m.SentByID == nil, m.Status, doc)
	return err
}

// UpdateMessage saves when the version matches.
func (r Repo) UpdateMessage(ctx context.Context, m *domain.Message) error {
	doc, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE messaging.messages SET status = $2, doc = $3, version = version + 1 WHERE id = $1 AND version = $4`, m.ID, m.Status, doc, m.Version)
	if err := stale(tag, err, "message"); err != nil {
		return err
	}
	m.Version++
	return nil
}

// Moving lists queued and sent messages, locked, oldest first.
func (r Repo) Moving(ctx context.Context) ([]domain.Message, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc, version FROM messaging.messages WHERE status IN ('queued', 'sent') ORDER BY seq FOR UPDATE`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Message, error) { return scanMessage(row) })
}

// Triggered reports a system message of the template on the stay.
func (r Repo) Triggered(ctx context.Context, bookingID, key string) (bool, error) {
	var found bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messaging.messages WHERE booking_id = $1 AND template_key = $2 AND system)`, bookingID, key).Scan(&found)
	return found, err
}

const stayColumns = `SELECT id, code, guest_id, unit_id, unit_assigned, status, to_char(check_in, 'YYYY-MM-DD'), to_char(check_out, 'YYYY-MM-DD'), group_id FROM messaging.stays`

func scanStay(row pgx.Row) (domain.Stay, error) {
	var s domain.Stay
	err := row.Scan(&s.ID, &s.Code, &s.GuestID, &s.UnitID, &s.UnitAssigned, &s.Status, &s.CheckIn, &s.CheckOut, &s.GroupID)
	return s, err
}

// Stay reads a stay.
func (r Repo) Stay(ctx context.Context, id string) (domain.Stay, error) {
	s, err := scanStay(r.DB.Q(ctx).QueryRow(ctx, stayColumns+` WHERE id = $1`, id))
	return s, notFound(err, "booking", id)
}

// StayByInvoiceToken reads the stay behind an e-invoice link, nil for an unknown token.
func (r Repo) StayByInvoiceToken(ctx context.Context, token string) (*domain.Stay, error) {
	s, err := scanStay(r.DB.Q(ctx).QueryRow(ctx, stayColumns+` WHERE invoice_token = $1`, token))
	if db.NoRows(err) {
		return nil, nil
	}
	return &s, err
}

// Stays lists the stays in booking order.
func (r Repo) Stays(ctx context.Context) ([]domain.Stay, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, stayColumns+` ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Stay, error) { return scanStay(row) })
}

// Guest reads a guest's contact.
func (r Repo) Guest(ctx context.Context, id string) (domain.Guest, error) {
	var g domain.Guest
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, name, email, phone, nationality FROM messaging.guests WHERE id = $1`, id).Scan(&g.ID, &g.Name, &g.Email, &g.Phone, &g.Nationality)
	return g, notFound(err, "guest", id)
}

// Place reads a unit with its villa and room type.
func (r Repo) Place(ctx context.Context, unitID string) (domain.Place, error) {
	var p domain.Place
	err := r.DB.Q(ctx).QueryRow(ctx, `
		SELECT v.id, v.location_id, v.name, u.code, coalesce(g.name, '')
		FROM messaging.cat_units u JOIN messaging.cat_villas v ON v.id = u.villa_id LEFT JOIN messaging.cat_unit_groups g ON g.id = u.group_id
		WHERE u.id = $1`, unitID).Scan(&p.VillaID, &p.LocationID, &p.VillaName, &p.UnitCode, &p.GroupName)
	return p, notFound(err, "unit", unitID)
}

// PendingLink is the newest pending payment link of a stay, nil when it has none.
func (r Repo) PendingLink(ctx context.Context, bookingID string) (*messaging.PaymentLink, error) {
	var l messaging.PaymentLink
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT booking_id, token, amount, status FROM messaging.payment_links WHERE booking_id = $1 AND status = 'pending' ORDER BY seq DESC LIMIT 1`, bookingID).
		Scan(&l.BookingID, &l.Token, &l.Amount, &l.Status)
	if db.NoRows(err) {
		return nil, nil
	}
	return &l, err
}

// ReadStore reads the outbox narrowed to a scope.
type ReadStore struct{ DB *db.DB }

// Messages lists the messages of villas in scope, oldest first; cityLedger adds the city ledger
// invoices, which sit in no villa.
func (s ReadStore) Messages(ctx context.Context, sc rbac.Scope, cityLedger bool) ([]json.RawMessage, error) {
	vil, loc := sc.VillaIDs, sc.LocationIDs
	if vil == nil {
		vil = []string{}
	}
	if loc == nil {
		loc = []string{}
	}
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT m.doc FROM messaging.messages m LEFT JOIN messaging.cat_villas v ON v.id = m.villa_id
		WHERE (m.villa_id <> '' AND ((cardinality($1::text[]) > 0 AND m.villa_id = ANY($1))
		    OR (cardinality($1::text[]) = 0 AND (cardinality($2::text[]) = 0 OR v.location_id = ANY($2)))))
		   OR (m.villa_id = '' AND $3)
		ORDER BY m.seq`, vil, loc, cityLedger)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (json.RawMessage, error) {
		var raw []byte
		err := r.Scan(&raw)
		return raw, err
	})
}

// Settings reads the settings.
func (s ReadStore) Settings(ctx context.Context) (domain.Settings, int64, error) {
	return Repo(s).Settings(ctx)
}
