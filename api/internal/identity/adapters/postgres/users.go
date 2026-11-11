// Package postgres implements identity's repositories, read store, projections and seed loader on
// the identity schema.
package postgres

import (
	"context"
	"embed"
	"io/fs"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is identity's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "identity", FS: sub}
}

// Users is the write repository.
type Users struct{ DB *db.DB }

const userColumns = `id, name, email, role, status, location_ids, villa_ids, employee_id,
	to_char(last_login_on, 'YYYY-MM-DD'), to_char(created_on, 'YYYY-MM-DD'), password_hash, notify_arrivals, notify_approvals, version`

func scanUser(row pgx.Row) (domain.User, error) {
	var u domain.User
	err := row.Scan(&u.ID, &u.Name, &u.Email, &u.Role, &u.Status, &u.LocationIDs, &u.VillaIDs, &u.EmployeeID,
		&u.LastLoginOn, &u.CreatedOn, &u.PasswordHash, &u.NotifyArrivals, &u.NotifyApprovals, &u.Version)
	return u, err
}

// ByEmail finds a login by lowercased email; nil when there is none.
func (r Users) ByEmail(ctx context.Context, email string) (*domain.User, error) {
	u, err := scanUser(r.DB.Q(ctx).QueryRow(ctx, `SELECT `+userColumns+` FROM identity.users WHERE lower(email) = lower($1)`, email))
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// ByID loads a login for update.
func (r Users) ByID(ctx context.Context, id string) (domain.User, error) {
	u, err := scanUser(r.DB.Q(ctx).QueryRow(ctx, `SELECT `+userColumns+` FROM identity.users WHERE id = $1`, id))
	if db.NoRows(err) {
		return u, errs.NotFound("user", id)
	}
	return u, err
}

// EmailTaken reports whether another login uses the email.
func (r Users) EmailTaken(ctx context.Context, email, excludeID string) (bool, error) {
	var taken bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM identity.users WHERE lower(email) = lower($1) AND id <> $2)`, email, excludeID).Scan(&taken)
	return taken, err
}

// Insert adds a login.
func (r Users) Insert(ctx context.Context, u domain.User) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO identity.users (id, name, email, role, status, location_ids, villa_ids, employee_id, password_hash, last_login_on, created_on, notify_arrivals, notify_approvals, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12, $13, $14)`,
		u.ID, u.Name, u.Email, u.Role, u.Status, u.LocationIDs, u.VillaIDs, u.EmployeeID, u.PasswordHash, u.LastLoginOn, u.CreatedOn, u.NotifyArrivals, u.NotifyApprovals, u.Version)
	if _, dup := db.UniqueViolation(err); dup {
		return errs.Invalid("email", u.Email+" already has a login.")
	}
	return err
}

// Update saves the editable fields when the version still matches.
func (r Users) Update(ctx context.Context, u *domain.User) error {
	tag, err := r.DB.Q(ctx).Exec(ctx, `
		UPDATE identity.users SET name = $2, email = $3, role = $4, status = $5, location_ids = $6, villa_ids = $7,
			employee_id = $8, notify_arrivals = $9, notify_approvals = $10, version = version + 1
		WHERE id = $1 AND version = $11`,
		u.ID, u.Name, u.Email, u.Role, u.Status, u.LocationIDs, u.VillaIDs, u.EmployeeID, u.NotifyArrivals, u.NotifyApprovals, u.Version)
	if _, dup := db.UniqueViolation(err); dup {
		return errs.Invalid("email", u.Email+" already has a login.")
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errs.New(errs.CodeConflict, "Someone else changed this login. Reload and try again.")
	}
	u.Version++
	return nil
}

// SetPassword stores a new hash.
func (r Users) SetPassword(ctx context.Context, id, hash string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `UPDATE identity.users SET password_hash = $2 WHERE id = $1`, id, hash)
	return err
}

// TouchLogin records the sign-in date.
func (r Users) TouchLogin(ctx context.Context, id, date string) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `UPDATE identity.users SET last_login_on = $2::date WHERE id = $1`, id, date)
	return err
}

// Sessions is the session store.
type Sessions struct{ DB *db.DB }

// Create opens a session.
func (r Sessions) Create(ctx context.Context, id, userID, userAgent string, at time.Time) error {
	if len(userAgent) > 300 {
		userAgent = userAgent[:300]
	}
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO identity.sessions (id, user_id, user_agent, created_at) VALUES ($1, $2, $3, $4)`, id, userID, userAgent, at)
	return err
}

// InsertToken stores a refresh token hash.
func (r Sessions) InsertToken(ctx context.Context, t domain.RefreshToken) error {
	_, err := r.DB.Q(ctx).Exec(ctx, `INSERT INTO identity.refresh_tokens (id, session_id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
		t.ID, t.SessionID, t.UserID, t.Hash, t.ExpiresAt)
	return err
}

// TokenByHash finds a refresh token; nil when unknown.
func (r Sessions) TokenByHash(ctx context.Context, hash string) (*domain.RefreshToken, error) {
	var t domain.RefreshToken
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT id, session_id, user_id, token_hash, expires_at, rotated_at, revoked_at FROM identity.refresh_tokens WHERE token_hash = $1`, hash).
		Scan(&t.ID, &t.SessionID, &t.UserID, &t.Hash, &t.ExpiresAt, &t.RotatedAt, &t.RevokedAt)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// MarkRotated retires a token unless a concurrent request already did.
func (r Sessions) MarkRotated(ctx context.Context, tokenID, replacedBy string, at time.Time) (bool, error) {
	tag, err := r.DB.Q(ctx).Exec(ctx, `UPDATE identity.refresh_tokens SET rotated_at = $2, replaced_by = $3 WHERE id = $1 AND rotated_at IS NULL`, tokenID, at, replacedBy)
	return tag.RowsAffected() == 1, err
}

// RevokeSession ends a session and its tokens.
func (r Sessions) RevokeSession(ctx context.Context, sessionID string, at time.Time) error {
	q := r.DB.Q(ctx)
	if _, err := q.Exec(ctx, `UPDATE identity.sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, sessionID, at); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `UPDATE identity.refresh_tokens SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`, sessionID, at)
	return err
}

// RevokeUserSessions ends every session of a user but one.
func (r Sessions) RevokeUserSessions(ctx context.Context, userID, exceptSessionID string, at time.Time) error {
	q := r.DB.Q(ctx)
	if _, err := q.Exec(ctx, `UPDATE identity.sessions SET revoked_at = $3 WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, userID, exceptSessionID, at); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `UPDATE identity.refresh_tokens SET revoked_at = $3 WHERE user_id = $1 AND session_id <> $2 AND revoked_at IS NULL`, userID, exceptSessionID, at)
	return err
}

// SessionActive reports whether the session is still open.
func (r Sessions) SessionActive(ctx context.Context, sessionID string) (bool, error) {
	var ok bool
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM identity.sessions WHERE id = $1 AND revoked_at IS NULL)`, sessionID).Scan(&ok)
	return ok, err
}
