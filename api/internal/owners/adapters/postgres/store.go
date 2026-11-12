// Package postgres implements the owners context's store, projections and seed loader on the
// owners schema. One Store serves the commands and the queries: the records are few, and reads
// come from the write tables, so a save reads back at once.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the owners context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "owners", FS: sub}
}

// Store is the owners schema.
type Store struct{ DB *db.DB }

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

// Lock serialises owners' commands for the transaction: closes, payouts and stay decisions read
// every statement or request of a contract before they write.
func (s Store) Lock(ctx context.Context) error {
	_, err := s.DB.Q(ctx).Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('owners'))`)
	return err
}

// Next returns the next number of a sequence: villaOwner, contract, statement, ownerStay.
func (s Store) Next(ctx context.Context, key string) (int64, error) {
	var n int64
	err := s.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO owners.counters (key, n) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET n = owners.counters.n + 1
		RETURNING n - 1`, key).Scan(&n)
	return n, err
}

// docs reads doc and version of every row, in creation order.
func docs[T any](ctx context.Context, q db.Querier, sql string, set func(*T, int64), args ...any) ([]T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (T, error) {
		var v T
		var raw []byte
		var version int64
		if err := r.Scan(&raw, &version); err != nil {
			return v, err
		}
		err := json.Unmarshal(raw, &v)
		set(&v, version)
		return v, err
	})
}

func one[T any](ctx context.Context, q db.Querier, sql, what, id string, set func(*T, int64)) (T, error) {
	list, err := docs(ctx, q, sql, set, id)
	if err == nil && len(list) == 0 {
		err = errs.NotFound(what, id)
	}
	if err != nil {
		var zero T
		return zero, err
	}
	return list[0], nil
}

func setOwner(o *domain.VillaOwner, v int64)  { o.Version = v }
func setContract(c *domain.Contract, v int64) { c.Version = v }
func setStay(r *domain.StayRequest, v int64)  { r.Version = v }

func marshal(v any) []byte {
	raw, _ := json.Marshal(v)
	return raw
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Owners lists every villa owner.
func (s Store) Owners(ctx context.Context) ([]domain.VillaOwner, error) {
	return docs(ctx, s.DB.Q(ctx), `SELECT doc, version FROM owners.villa_owners ORDER BY seq`, setOwner)
}

// Owner loads and locks one owner.
func (s Store) Owner(ctx context.Context, id string) (domain.VillaOwner, error) {
	return one(ctx, s.DB.Q(ctx), `SELECT doc, version FROM owners.villa_owners WHERE id = $1 FOR UPDATE`, "villa owner", id, setOwner)
}

// InsertOwner adds an owner.
func (s Store) InsertOwner(ctx context.Context, o *domain.VillaOwner) error {
	o.Version = 1
	_, err := s.DB.Q(ctx).Exec(ctx, `INSERT INTO owners.villa_owners (id, user_id, doc) VALUES ($1, $2, $3)`, o.ID, o.UserID, marshal(o))
	return err
}

// UpdateOwner saves an owner with a version check.
func (s Store) UpdateOwner(ctx context.Context, o *domain.VillaOwner) error {
	tag, err := s.DB.Q(ctx).Exec(ctx, `UPDATE owners.villa_owners SET user_id = $2, doc = $3, version = version + 1 WHERE id = $1 AND version = $4`,
		o.ID, o.UserID, marshal(o), o.Version)
	if err = stale(tag, err, "owner"); err == nil {
		o.Version++
	}
	return err
}

// Contracts lists every contract.
func (s Store) Contracts(ctx context.Context) ([]domain.Contract, error) {
	return docs(ctx, s.DB.Q(ctx), `SELECT doc, version FROM owners.contracts ORDER BY seq`, setContract)
}

// Contract loads and locks one contract.
func (s Store) Contract(ctx context.Context, id string) (domain.Contract, error) {
	return one(ctx, s.DB.Q(ctx), `SELECT doc, version FROM owners.contracts WHERE id = $1 FOR UPDATE`, "contract", id, setContract)
}

// InsertContract adds a contract.
func (s Store) InsertContract(ctx context.Context, c *domain.Contract) error {
	c.Version = 1
	_, err := s.DB.Q(ctx).Exec(ctx, `INSERT INTO owners.contracts (id, villa_id, owner_id, doc) VALUES ($1, $2, $3, $4)`, c.ID, c.VillaID, c.OwnerID, marshal(c))
	return err
}

// UpdateContract saves a contract with a version check.
func (s Store) UpdateContract(ctx context.Context, c *domain.Contract) error {
	tag, err := s.DB.Q(ctx).Exec(ctx, `UPDATE owners.contracts SET villa_id = $2, owner_id = $3, doc = $4, version = version + 1 WHERE id = $1 AND version = $5`,
		c.ID, c.VillaID, c.OwnerID, marshal(c), c.Version)
	if err = stale(tag, err, "contract"); err == nil {
		c.Version++
	}
	return err
}

const statementSelect = `SELECT doc, version, payout_ref, payout_number, payout_status FROM owners.statements`

func (s Store) statements(ctx context.Context, where string, args ...any) ([]domain.Statement, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, statementSelect+" "+where, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Statement, error) {
		var st domain.Statement
		var raw []byte
		var ref *string
		var number, status string
		if err := r.Scan(&raw, &st.Version, &ref, &number, &status); err != nil {
			return st, err
		}
		version := st.Version
		if err := json.Unmarshal(raw, &st); err != nil {
			return st, err
		}
		st.Version = version
		if ref != nil {
			st.Payout = &domain.Payout{Ref: *ref, TransactionID: deref(st.PayoutTransactionID), Number: number, Status: status}
		}
		return st, nil
	})
}

// Statements lists every closed statement.
func (s Store) Statements(ctx context.Context) ([]domain.Statement, error) {
	return s.statements(ctx, `ORDER BY seq`)
}

// Statement loads and locks one statement.
func (s Store) Statement(ctx context.Context, id string) (domain.Statement, error) {
	list, err := s.statements(ctx, `WHERE id = $1 FOR UPDATE`, id)
	if err == nil && len(list) == 0 {
		err = errs.NotFound("owner statement", id)
	}
	if err != nil {
		return domain.Statement{}, err
	}
	return list[0], nil
}

// StatementByPayout finds the statement whose payout request carried ref, or, for a seeded payout,
// whose payout is the transaction.
func (s Store) StatementByPayout(ctx context.Context, ref, transactionID string) (domain.Statement, bool, error) {
	list, err := s.statements(ctx, `WHERE payout_ref = $1 OR ($2 <> '' AND doc->>'payoutTransactionId' = $2) ORDER BY payout_ref = $1 DESC LIMIT 1 FOR UPDATE`, ref, transactionID)
	if err != nil || len(list) == 0 {
		return domain.Statement{}, false, err
	}
	return list[0], true, nil
}

func payoutColumns(st *domain.Statement) (ref *string, number, status string) {
	if st.Payout == nil {
		return nil, "", ""
	}
	return nullable(st.Payout.Ref), st.Payout.Number, st.Payout.Status
}

// InsertStatement adds a closed statement.
func (s Store) InsertStatement(ctx context.Context, st *domain.Statement) error {
	st.Version = 1
	ref, number, status := payoutColumns(st)
	_, err := s.DB.Q(ctx).Exec(ctx, `
		INSERT INTO owners.statements (id, contract_id, villa_id, owner_id, month, status, doc, payout_ref, payout_number, payout_status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		st.ID, st.ContractID, st.VillaID, st.OwnerID, st.Month, st.Status, marshal(st), ref, number, status)
	return err
}

// UpdateStatement saves a statement with a version check.
func (s Store) UpdateStatement(ctx context.Context, st *domain.Statement) error {
	ref, number, status := payoutColumns(st)
	tag, err := s.DB.Q(ctx).Exec(ctx, `
		UPDATE owners.statements SET status = $2, doc = $3, payout_ref = $4, payout_number = $5, payout_status = $6, version = version + 1
		WHERE id = $1 AND version = $7`, st.ID, st.Status, marshal(st), ref, number, status, st.Version)
	if err = stale(tag, err, "statement"); err == nil {
		st.Version++
	}
	return err
}

// DeleteStatement removes a reopened statement; its month reads as open again.
func (s Store) DeleteStatement(ctx context.Context, id string) error {
	_, err := s.DB.Q(ctx).Exec(ctx, `DELETE FROM owners.statements WHERE id = $1`, id)
	return err
}

// StayRequests lists every owner stay request.
func (s Store) StayRequests(ctx context.Context) ([]domain.StayRequest, error) {
	return docs(ctx, s.DB.Q(ctx), `SELECT doc, version FROM owners.stay_requests ORDER BY seq`, setStay)
}

// StayRequest loads and locks one request.
func (s Store) StayRequest(ctx context.Context, id string) (domain.StayRequest, error) {
	return one(ctx, s.DB.Q(ctx), `SELECT doc, version FROM owners.stay_requests WHERE id = $1 FOR UPDATE`, "owner stay", id, setStay)
}

// InsertStay adds a request.
func (s Store) InsertStay(ctx context.Context, r *domain.StayRequest) error {
	r.Version = 1
	_, err := s.DB.Q(ctx).Exec(ctx, `INSERT INTO owners.stay_requests (id, contract_id, villa_id, owner_id, doc) VALUES ($1, $2, $3, $4, $5)`,
		r.ID, r.ContractID, r.VillaID, r.OwnerID, marshal(r))
	return err
}

// UpdateStay saves a request with a version check.
func (s Store) UpdateStay(ctx context.Context, r *domain.StayRequest) error {
	tag, err := s.DB.Q(ctx).Exec(ctx, `UPDATE owners.stay_requests SET doc = $2, version = version + 1 WHERE id = $1 AND version = $3`, r.ID, marshal(r), r.Version)
	if err = stale(tag, err, "owner stay"); err == nil {
		r.Version++
	}
	return err
}

// Villas lists owners' copy of the villas.
func (s Store) Villas(ctx context.Context) ([]domain.Villa, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT id, location_id, code, name FROM owners.cat_villas ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Villa, error) {
		var v domain.Villa
		return v, r.Scan(&v.ID, &v.LocationID, &v.Code, &v.Name)
	})
}

// Villa reads one villa.
func (s Store) Villa(ctx context.Context, id string) (domain.Villa, error) {
	var v domain.Villa
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT id, location_id, code, name FROM owners.cat_villas WHERE id = $1`, id).Scan(&v.ID, &v.LocationID, &v.Code, &v.Name)
	return v, notFound(err, "villa", id)
}

// Units lists owners' copy of the units.
func (s Store) Units(ctx context.Context) ([]domain.Unit, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT id, villa_id, code, status FROM owners.cat_units ORDER BY seq`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Unit, error) {
		var u domain.Unit
		return u, r.Scan(&u.ID, &u.VillaID, &u.Code, &u.Status)
	})
}

// Unit reads one unit.
func (s Store) Unit(ctx context.Context, id string) (domain.Unit, error) {
	var u domain.Unit
	err := s.DB.Q(ctx).QueryRow(ctx, `SELECT id, villa_id, code, status FROM owners.cat_units WHERE id = $1`, id).Scan(&u.ID, &u.VillaID, &u.Code, &u.Status)
	return u, notFound(err, "unit", id)
}

// Blocks lists the unit blocks in place.
func (s Store) Blocks(ctx context.Context) ([]domain.Block, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT id, unit_id, from_date, to_date, reason FROM owners.cat_blocks WHERE NOT removed ORDER BY from_date, id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Block, error) {
		var b domain.Block
		return b, r.Scan(&b.ID, &b.UnitID, &b.From, &b.To, &b.Reason)
	})
}

// AccountNames maps Airbnb host account ids to their names.
func (s Store) AccountNames(ctx context.Context) (map[string]string, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT id, name FROM owners.cat_accounts`)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	_, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (struct{}, error) {
		var id, name string
		err := r.Scan(&id, &name)
		out[id] = name
		return struct{}{}, err
	})
	return out, err
}

// GroupSources maps booking group ids to their source (corporate, agent, wedding and so on).
func (s Store) GroupSources(ctx context.Context) (map[string]string, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT id, source FROM owners.rm_groups`)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	_, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (struct{}, error) {
		var id, source string
		err := r.Scan(&id, &source)
		out[id] = source
		return struct{}{}, err
	})
	return out, err
}

// Stays lists the bookings on the given units, as reservation published them.
func (s Store) Stays(ctx context.Context, unitIDs []string) ([]domain.Stay, error) {
	rows, err := s.DB.Q(ctx).Query(ctx, `SELECT doc FROM owners.rm_stays WHERE unit_id = ANY($1) ORDER BY seq`, unitIDs)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Stay, error) {
		var raw []byte
		var b domain.Stay
		if err := r.Scan(&raw); err != nil {
			return b, err
		}
		return b, json.Unmarshal(raw, &b)
	})
}

var blockLabel = map[string]string{"maintenance": "Maintenance", "owner": "Owner stay", "cleaning": "Deep clean", "other": "Other"}

// Holder is the first stay or block that holds the unit on some night of [from, to), as
// findConflicts orders them; ok is false when the nights are free.
func (s Store) Holder(ctx context.Context, unitID, from, to string) (domain.Holder, bool, error) {
	var h domain.Holder
	err := s.DB.Q(ctx).QueryRow(ctx, `
		SELECT label, from_date, to_date FROM (
			SELECT doc->>'code' AS label, doc->>'checkIn' AS from_date, doc->>'checkOut' AS to_date FROM owners.rm_stays
			WHERE unit_id = $1 AND (doc->>'unitAssigned')::boolean AND doc->>'status' IN ('confirmed', 'checked_in')
				AND doc->>'checkIn' < $3 AND $2 < doc->>'checkOut'
			UNION ALL
			SELECT reason, from_date, to_date FROM owners.cat_blocks WHERE unit_id = $1 AND NOT removed AND from_date < $3 AND $2 < to_date
		) held ORDER BY from_date LIMIT 1`, unitID, from, to).Scan(&h.Label, &h.From, &h.To)
	if db.NoRows(err) {
		return h, false, nil
	}
	if l, ok := blockLabel[h.Label]; ok {
		h.Label = l
	}
	return h, err == nil, err
}
