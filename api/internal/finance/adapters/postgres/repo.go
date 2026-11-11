// Package postgres implements the finance context's repository, read store, event consumers and
// seed loader on the finance schema.
package postgres

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"

	"github.com/jackc/pgx/v5"

	"github.com/syabanf/wit-hospitality/api/internal/finance/app/command"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/migrations"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migrations is the finance context's migration set.
func Migrations() migrations.Set {
	sub, _ := fs.Sub(migrationFS, "migrations")
	return migrations.Set{Schema: "finance", FS: sub}
}

// Repo is the write repository. Every load with lock takes the row for the transaction.
type Repo struct{ DB *db.DB }

var _ command.Repository = Repo{}

func notFound(err error, what, id string) error {
	if db.NoRows(err) {
		return errs.NotFound(what, id)
	}
	return err
}

func lockSQL(lock bool) string {
	if lock {
		return " FOR UPDATE"
	}
	return ""
}

func collect[T any](rows pgx.Rows, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (T, error) {
		var v T
		var raw []byte
		if err := r.Scan(&raw); err != nil {
			return v, err
		}
		return v, json.Unmarshal(raw, &v)
	})
}

func one[T any](ctx context.Context, r Repo, sql, what, id string) (T, int64, error) {
	var v T
	var raw []byte
	var version int64
	err := r.DB.Q(ctx).QueryRow(ctx, sql, id).Scan(&raw, &version)
	if err != nil {
		return v, 0, notFound(err, what, id)
	}
	return v, version, json.Unmarshal(raw, &v)
}

func (r Repo) exec(ctx context.Context, sql string, args ...any) error {
	_, err := r.DB.Q(ctx).Exec(ctx, sql, args...)
	return err
}

func mustJSON(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}

// Next returns the next number of a sequence: transaction, journal, manualJournal, ...
func (r Repo) Next(ctx context.Context, key string) (int64, error) {
	var n int64
	err := r.DB.Q(ctx).QueryRow(ctx, `
		INSERT INTO finance.counters (key, n) VALUES ($1, 2)
		ON CONFLICT (key) DO UPDATE SET n = finance.counters.n + 1
		RETURNING n - 1`, key).Scan(&n)
	return n, err
}

// Accounts lists the cash accounts in the order they were opened.
func (r Repo) Accounts(ctx context.Context) ([]domain.CashAccount, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.cash_accounts ORDER BY seq`)
	return collect[domain.CashAccount](rows, err)
}

// Account loads one cash account.
func (r Repo) Account(ctx context.Context, id string, lock bool) (domain.CashAccount, error) {
	a, _, err := one[domain.CashAccount](ctx, r, `SELECT doc, version FROM finance.cash_accounts WHERE id = $1`+lockSQL(lock), "account", id)
	return a, err
}

// SaveAccount inserts or replaces a cash account.
func (r Repo) SaveAccount(ctx context.Context, a domain.CashAccount) error {
	return r.exec(ctx, `INSERT INTO finance.cash_accounts (id, doc) VALUES ($1, $2)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = finance.cash_accounts.version + 1`, a.ID, mustJSON(a))
}

// Categories lists the categories in catalog order.
func (r Repo) Categories(ctx context.Context) ([]domain.Category, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.categories ORDER BY seq`)
	return collect[domain.Category](rows, err)
}

// Category loads and locks one category.
func (r Repo) Category(ctx context.Context, id string) (domain.Category, error) {
	c, _, err := one[domain.Category](ctx, r, `SELECT doc, version FROM finance.categories WHERE id = $1 FOR UPDATE`, "category", id)
	return c, err
}

// SaveCategory inserts or replaces a category.
func (r Repo) SaveCategory(ctx context.Context, c domain.Category) error {
	return r.exec(ctx, `INSERT INTO finance.categories (id, doc) VALUES ($1, $2)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = finance.categories.version + 1`, c.ID, mustJSON(c))
}

func scanTransactions(rows pgx.Rows, err error) ([]domain.Transaction, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.Transaction, error) {
		var t domain.Transaction
		var raw []byte
		if err := r.Scan(&raw, &t.Version); err != nil {
			return t, err
		}
		v := t.Version
		err := json.Unmarshal(raw, &t)
		t.Version = v
		return t, err
	})
}

// Transactions lists every cash entry in the order recorded.
func (r Repo) Transactions(ctx context.Context) ([]domain.Transaction, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc, version FROM finance.transactions ORDER BY seq`)
	return scanTransactions(rows, err)
}

// Transaction loads and locks one cash entry.
func (r Repo) Transaction(ctx context.Context, id string) (domain.Transaction, error) {
	t, version, err := one[domain.Transaction](ctx, r, `SELECT doc, version FROM finance.transactions WHERE id = $1 FOR UPDATE`, "transaction", id)
	t.Version = version
	return t, err
}

// Transfer loads and locks both halves of a transfer.
func (r Repo) Transfer(ctx context.Context, transferID string) ([]domain.Transaction, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc, version FROM finance.transactions WHERE transfer_id = $1 ORDER BY seq FOR UPDATE`, transferID)
	return scanTransactions(rows, err)
}

// BySource lists the entries written for another context's record, oldest first.
func (r Repo) BySource(ctx context.Context, src command.Source) ([]domain.Transaction, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc, version FROM finance.transactions WHERE source_type = $1 AND source_id = $2 ORDER BY seq FOR UPDATE`, src.Type, src.ID)
	return scanTransactions(rows, err)
}

// SourceOf is the record an entry was written for; nil for an entry recorded by hand.
func (r Repo) SourceOf(ctx context.Context, transactionID string) (*command.Source, error) {
	var t, id *string
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT source_type, source_id FROM finance.transactions WHERE id = $1`, transactionID).Scan(&t, &id)
	if err != nil || t == nil {
		return nil, notFound(err, "transaction", transactionID)
	}
	return &command.Source{Type: *t, ID: deref(id)}, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// InsertTransaction adds an entry at version 1, with the record it was written for.
func (r Repo) InsertTransaction(ctx context.Context, t *domain.Transaction, src *command.Source) error {
	t.Version = 1
	var st, sid *string
	if src != nil {
		st, sid = &src.Type, &src.ID
	}
	return r.exec(ctx, `INSERT INTO finance.transactions (id, number, account_id, status, date, transfer_id, source_type, source_id, doc)
		VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)`, t.ID, t.Number, t.AccountID, t.Status, t.Date, t.TransferID, st, sid, mustJSON(t))
}

// UpdateTransaction saves an entry loaded with a lock.
func (r Repo) UpdateTransaction(ctx context.Context, t *domain.Transaction) error {
	err := r.exec(ctx, `UPDATE finance.transactions SET account_id = $2, status = $3, date = $4::date, doc = $5, version = version + 1 WHERE id = $1`,
		t.ID, t.AccountID, t.Status, t.Date, mustJSON(t))
	if err == nil {
		t.Version++
	}
	return err
}

// Link returns what the posting rules know about an entry; nil when nothing.
func (r Repo) Link(ctx context.Context, transactionID string) (*domain.EntryLink, error) {
	var raw []byte
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM finance.entry_links WHERE transaction_id = $1`, transactionID).Scan(&raw)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var l domain.EntryLink
	return &l, json.Unmarshal(raw, &l)
}

// SaveLink stores an entry's link.
func (r Repo) SaveLink(ctx context.Context, l domain.EntryLink) error {
	return r.exec(ctx, `INSERT INTO finance.entry_links (transaction_id, doc) VALUES ($1, $2)
		ON CONFLICT (transaction_id) DO UPDATE SET doc = EXCLUDED.doc`, l.TransactionID, mustJSON(l))
}

// Payroll returns the payroll totals behind a salary payment; nil for any other entry.
func (r Repo) Payroll(ctx context.Context, transactionID string) (*domain.PayrollTotals, error) {
	var raw []byte
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM finance.payroll_postings WHERE transaction_id = $1`, transactionID).Scan(&raw)
	if db.NoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p domain.PayrollTotals
	return &p, json.Unmarshal(raw, &p)
}

// SavePayroll stores the payroll totals behind a salary payment.
func (r Repo) SavePayroll(ctx context.Context, transactionID string, p domain.PayrollTotals) error {
	return r.exec(ctx, `INSERT INTO finance.payroll_postings (transaction_id, doc) VALUES ($1, $2)
		ON CONFLICT (transaction_id) DO UPDATE SET doc = EXCLUDED.doc`, transactionID, mustJSON(p))
}

// Reconciliations lists the cash counts in the order made.
func (r Repo) Reconciliations(ctx context.Context) ([]domain.Reconciliation, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.reconciliations ORDER BY seq`)
	return collect[domain.Reconciliation](rows, err)
}

// InsertReconciliation adds a cash count.
func (r Repo) InsertReconciliation(ctx context.Context, x domain.Reconciliation) error {
	return r.exec(ctx, `INSERT INTO finance.reconciliations (id, doc) VALUES ($1, $2)`, x.ID, mustJSON(x))
}

// Rules lists the approval rules.
func (r Repo) Rules(ctx context.Context) ([]domain.ApprovalRule, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.approval_rules ORDER BY seq`)
	return collect[domain.ApprovalRule](rows, err)
}

// Rule loads and locks one approval rule.
func (r Repo) Rule(ctx context.Context, id string) (domain.ApprovalRule, error) {
	x, _, err := one[domain.ApprovalRule](ctx, r, `SELECT doc, version FROM finance.approval_rules WHERE id = $1 FOR UPDATE`, "approval rule", id)
	return x, err
}

// SaveRule inserts or replaces an approval rule.
func (r Repo) SaveRule(ctx context.Context, x domain.ApprovalRule) error {
	return r.exec(ctx, `INSERT INTO finance.approval_rules (id, doc) VALUES ($1, $2)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = finance.approval_rules.version + 1`, x.ID, mustJSON(x))
}

// DeleteRule removes an approval rule.
func (r Repo) DeleteRule(ctx context.Context, id string) error {
	return r.exec(ctx, `DELETE FROM finance.approval_rules WHERE id = $1`, id)
}

// Setting reads one setting into v; false when it was never saved.
func (r Repo) Setting(ctx context.Context, key string, v any) (bool, error) {
	var raw []byte
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT doc FROM finance.settings WHERE key = $1`, key).Scan(&raw)
	if db.NoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(raw, v)
}

// LockSetting takes one setting's row for the transaction, creating it from def when absent.
func (r Repo) LockSetting(ctx context.Context, key string, def any) error {
	if err := r.exec(ctx, `INSERT INTO finance.settings (key, doc) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, key, mustJSON(def)); err != nil {
		return err
	}
	return r.exec(ctx, `SELECT 1 FROM finance.settings WHERE key = $1 FOR UPDATE`, key)
}

// SaveSetting writes one setting.
func (r Repo) SaveSetting(ctx context.Context, key string, v any) error {
	return r.exec(ctx, `INSERT INTO finance.settings (key, doc) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, version = finance.settings.version + 1`, key, mustJSON(v))
}

// Codes lists the transaction codes.
func (r Repo) Codes(ctx context.Context) ([]domain.TransactionCode, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.transaction_codes ORDER BY seq`)
	return collect[domain.TransactionCode](rows, err)
}

// SaveCode inserts or replaces a transaction code.
func (r Repo) SaveCode(ctx context.Context, c domain.TransactionCode) error {
	return r.exec(ctx, `INSERT INTO finance.transaction_codes (id, doc) VALUES ($1, $2)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = finance.transaction_codes.version + 1`, c.ID, mustJSON(c))
}

// Journals lists every journal entry in the order written.
func (r Repo) Journals(ctx context.Context) ([]domain.JournalEntry, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.journals ORDER BY seq`)
	return collect[domain.JournalEntry](rows, err)
}

// JournalsOf lists the entries one record wrote, in the order written.
func (r Repo) JournalsOf(ctx context.Context, source, sourceID string) ([]domain.JournalEntry, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.journals WHERE source = $1 AND source_id = $2 ORDER BY seq`, source, sourceID)
	return collect[domain.JournalEntry](rows, err)
}

// InsertJournal adds a numbered entry.
func (r Repo) InsertJournal(ctx context.Context, e domain.JournalEntry) error {
	return r.exec(ctx, `INSERT INTO finance.journals (id, date, source, source_id, villa_id, doc) VALUES ($1, $2::date, $3, $4, $5, $6)`,
		e.ID, e.Date, e.Source, e.SourceID, e.VillaID, mustJSON(e))
}

// DepositsHeld is depositsHeld: what a stay's room money holds on Guest deposits.
func (r Repo) DepositsHeld(ctx context.Context, bookingID string) (int64, error) {
	var held int64
	err := r.DB.Q(ctx).QueryRow(ctx, `
		SELECT coalesce(sum((l->>'credit')::bigint - (l->>'debit')::bigint), 0)::bigint
		FROM finance.journals j, jsonb_array_elements(j.doc->'lines') l
		WHERE l->>'accountId' = $1 AND l->>'bookingId' = $2`, domain.GLDeposits, bookingID).Scan(&held)
	return held, err
}

func scanManual(rows pgx.Rows, err error) ([]domain.ManualJournal, error) {
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (domain.ManualJournal, error) {
		var m domain.ManualJournal
		var raw []byte
		var v int64
		if err := r.Scan(&raw, &v); err != nil {
			return m, err
		}
		err := json.Unmarshal(raw, &m)
		m.Version = v
		return m, err
	})
}

// ManualJournals lists the manual journals in the order written.
func (r Repo) ManualJournals(ctx context.Context) ([]domain.ManualJournal, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc, version FROM finance.manual_journals ORDER BY seq`)
	return scanManual(rows, err)
}

// ManualJournal loads and locks one manual journal.
func (r Repo) ManualJournal(ctx context.Context, id string) (domain.ManualJournal, error) {
	m, v, err := one[domain.ManualJournal](ctx, r, `SELECT doc, version FROM finance.manual_journals WHERE id = $1 FOR UPDATE`, "manual journal", id)
	m.Version = v
	return m, err
}

// SaveManualJournal inserts or replaces a manual journal.
func (r Repo) SaveManualJournal(ctx context.Context, m *domain.ManualJournal) error {
	err := r.exec(ctx, `INSERT INTO finance.manual_journals (id, doc) VALUES ($1, $2)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = finance.manual_journals.version + 1`, m.ID, mustJSON(m))
	if err == nil {
		m.Version++
	}
	return err
}

// PeriodCloses lists the closed months, oldest first.
func (r Repo) PeriodCloses(ctx context.Context) ([]domain.PeriodClose, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.period_closes ORDER BY month`)
	return collect[domain.PeriodClose](rows, err)
}

// LockPeriods serialises posting against closing and reopening a month.
func (r Repo) LockPeriods(ctx context.Context) error {
	return r.exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('finance.periods'))`)
}

// ClosedMonths lists the closed months.
func (r Repo) ClosedMonths(ctx context.Context) ([]string, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT month FROM finance.period_closes ORDER BY month`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// InsertClose closes a month.
func (r Repo) InsertClose(ctx context.Context, c domain.PeriodClose) error {
	return r.exec(ctx, `INSERT INTO finance.period_closes (month, doc) VALUES ($1, $2)`, c.Month, mustJSON(c))
}

// DeleteClose reopens a month.
func (r Repo) DeleteClose(ctx context.Context, month string) error {
	return r.exec(ctx, `DELETE FROM finance.period_closes WHERE month = $1`, month)
}

// Budgets lists the budgets in the order first saved.
func (r Repo) Budgets(ctx context.Context) ([]domain.Budget, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.budgets ORDER BY seq`)
	return collect[domain.Budget](rows, err)
}

// SaveBudget inserts or replaces a villa's budget for a year; true when it replaced one.
func (r Repo) SaveBudget(ctx context.Context, b domain.Budget) (bool, error) {
	var replaced bool
	err := r.DB.Q(ctx).QueryRow(ctx, `INSERT INTO finance.budgets (villa_id, year, doc) VALUES ($1, $2, $3)
		ON CONFLICT (villa_id, year) DO UPDATE SET doc = EXCLUDED.doc RETURNING xmax <> 0`, b.VillaID, int(b.Year), mustJSON(b)).Scan(&replaced)
	return replaced, err
}

// SavePayrollCost stores one villa's payroll cost for a closed month.
func (r Repo) SavePayrollCost(ctx context.Context, month, villaID string, amount int64) error {
	return r.exec(ctx, `INSERT INTO finance.payroll_costs (month, villa_id, amount) VALUES ($1, $2, $3)
		ON CONFLICT (month, villa_id) DO UPDATE SET amount = EXCLUDED.amount`, month, villaID, amount)
}

// PayrollCost is a villa's payroll cost for a closed month, zero when none.
func (r Repo) PayrollCost(ctx context.Context, month, villaID string) (int64, error) {
	var n int64
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT coalesce(sum(amount), 0)::bigint FROM finance.payroll_costs WHERE month = $1 AND villa_id = $2`, month, villaID).Scan(&n)
	return n, err
}

// SaveRef keys a record by the id of the fact another context published.
func (r Repo) SaveRef(ctx context.Context, ref, kind, id string) error {
	return r.exec(ctx, `INSERT INTO finance.refs (ref, kind, record_id) VALUES ($1, $2, $3) ON CONFLICT (ref) DO NOTHING`, ref, kind, id)
}

// Ref finds the record a fact's id keys.
func (r Repo) Ref(ctx context.Context, ref string) (string, string, bool, error) {
	var kind, id string
	err := r.DB.Q(ctx).QueryRow(ctx, `SELECT kind, record_id FROM finance.refs WHERE ref = $1`, ref).Scan(&kind, &id)
	if db.NoRows(err) {
		return "", "", false, nil
	}
	return kind, id, err == nil, err
}

// Stays returns the stays named, by id.
func (r Repo) Stays(ctx context.Context, ids []string) (map[string]domain.Stay, error) {
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT doc FROM finance.stays WHERE booking_id = ANY($1)`, ids)
	list, err := collect[domain.Stay](rows, err)
	out := map[string]domain.Stay{}
	for _, s := range list {
		out[s.ID] = s
	}
	return out, err
}

// SaveStay inserts or replaces a stay.
func (r Repo) SaveStay(ctx context.Context, s domain.Stay) error {
	return r.exec(ctx, `INSERT INTO finance.stays (booking_id, doc) VALUES ($1, $2)
		ON CONFLICT (booking_id) DO UPDATE SET doc = EXCLUDED.doc, version = finance.stays.version + 1`, s.ID, mustJSON(s))
}

// Places lists the villas and locations finance keeps from property's events.
func (r Repo) Places(ctx context.Context) (domain.Places, error) {
	var p domain.Places
	rows, err := r.DB.Q(ctx).Query(ctx, `SELECT id, name, area FROM finance.cat_locations ORDER BY seq`)
	if err != nil {
		return p, err
	}
	if p.Locations, err = pgx.CollectRows(rows, pgx.RowToStructByPos[domain.Location]); err != nil {
		return p, err
	}
	rows, err = r.DB.Q(ctx).Query(ctx, `SELECT id, location_id, name FROM finance.cat_villas ORDER BY seq`)
	if err != nil {
		return p, err
	}
	p.Villas, err = pgx.CollectRows(rows, pgx.RowToStructByPos[domain.Villa])
	return p, err
}
