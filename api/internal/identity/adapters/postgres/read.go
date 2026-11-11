package postgres

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/identity/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/bus"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Permissions stores role rows. A role without a row reads the default matrix, so a fresh
// database answers with DEFAULT_PERMISSIONS.
type Permissions struct{ DB *db.DB }

// All returns the full matrix.
func (r Permissions) All(ctx context.Context) (rbac.Permissions, error) {
	out := rbac.DefaultPermissions()
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT role, modules FROM identity.v_permissions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var role rbac.Role
		var raw []byte
		if err := rows.Scan(&role, &raw); err != nil {
			return nil, err
		}
		var mods map[rbac.Module][]rbac.Action
		if err := json.Unmarshal(raw, &mods); err != nil {
			return nil, err
		}
		if rbac.ValidRole(role) {
			out[role] = mods
		}
	}
	return out, rows.Err()
}

// Permissions implements rbac.Source, so contexts in the monolith read the matrix in process.
func (r Permissions) Permissions(ctx context.Context) (rbac.Permissions, error) { return r.All(ctx) }

// Save replaces one role's row.
func (r Permissions) Save(ctx context.Context, role rbac.Role, modules map[rbac.Module][]rbac.Action) error {
	raw, err := json.Marshal(modules)
	if err != nil {
		return err
	}
	_, err = r.DB.Q(ctx).Exec(ctx, `
		INSERT INTO identity.role_permissions (role, modules, updated_at) VALUES ($1, $2, now())
		ON CONFLICT (role) DO UPDATE SET modules = EXCLUDED.modules, updated_at = now()`, role, raw)
	return err
}

// ReadStore serves the query side.
type ReadStore struct {
	DB     *db.DB
	Matrix Permissions
}

const viewColumns = `id, name, email, role, status, location_ids, villa_ids, employee_id, last_login_on, created_on, notify_arrivals, notify_approvals`

func scanView(row pgx.Row) (domain.User, error) {
	var u domain.User
	err := row.Scan(&u.ID, &u.Name, &u.Email, &u.Role, &u.Status, &u.LocationIDs, &u.VillaIDs, &u.EmployeeID, &u.LastLoginOn, &u.CreatedOn, &u.NotifyArrivals, &u.NotifyApprovals)
	return u, err
}

// User reads one login; nil when absent.
func (s ReadStore) User(ctx context.Context, id string) (*domain.User, error) {
	u, err := scanView(s.DB.Q(ctx).QueryRow(ctx, `SELECT `+viewColumns+` FROM identity.v_users WHERE id = $1`, id))
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// Users reads every login in creation order.
func (s ReadStore) Users(ctx context.Context) ([]domain.User, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT `+viewColumns+` FROM identity.v_users ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.User, error) { return scanView(r) })
}

// Permissions reads the matrix.
func (s ReadStore) Permissions(ctx context.Context) (rbac.Permissions, error) {
	return s.Matrix.All(ctx)
}

// AuditTrail reads the trail newest first.
func (s ReadStore) AuditTrail(ctx context.Context) ([]audit.Entry, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `
		SELECT id, at, user_id, user_name, role, action, entity, entity_id, summary, before, after
		FROM identity.audit_trail ORDER BY seq DESC`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (audit.Entry, error) {
		var e audit.Entry
		var before, after []byte
		err := r.Scan(&e.ID, &e.At, &e.UserID, &e.UserName, &e.Role, &e.Action, &e.Entity, &e.EntityID, &e.Summary, &before, &after)
		if len(before) > 0 {
			_ = json.Unmarshal(before, &e.Before)
		}
		if len(after) > 0 {
			_ = json.Unmarshal(after, &e.After)
		}
		return e, err
	})
}

// InsertAuditEntry adds a line to the trail; a repeat of the same id is ignored.
func InsertAuditEntry(ctx context.Context, q db.Querier, e audit.Entry) error {
	before, _ := json.Marshal(e.Before)
	after, _ := json.Marshal(e.After)
	_, err := q.Exec(ctx, `
		INSERT INTO identity.audit_trail (id, at, user_id, user_name, role, action, entity, entity_id, summary, before, after)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
		e.ID, e.At, e.UserID, e.UserName, e.Role, e.Action, e.Entity, e.EntityID, e.Summary, before, after)
	return err
}

// ProjectAuditEntry is the handler of platform.audit.recorded.v1.
func ProjectAuditEntry(d *db.DB) func(ctx context.Context, m bus.Message) error {
	return func(ctx context.Context, m bus.Message) error {
		var e audit.Entry
		if err := json.Unmarshal(m.Payload, &e); err != nil {
			return err
		}
		return InsertAuditEntry(ctx, d.Q(ctx), e)
	}
}
