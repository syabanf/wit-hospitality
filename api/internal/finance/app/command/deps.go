// Package command holds the finance context's write side: one handler per command, and the
// policies that turn other contexts' events into cash entries and journal entries. Each handler
// checks the permission and villa scope, loads with a row lock, applies the domain rules, saves,
// and appends its events and audit line in one transaction.
package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/finance"
	"github.com/syabanf/wit-hospitality/api/internal/finance/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Source names the record another context asked an entry for.
type Source = finance.Source

// Repository is the write model on the finance schema.
type Repository interface {
	Next(ctx context.Context, key string) (int64, error)

	Accounts(ctx context.Context) ([]domain.CashAccount, error)
	Account(ctx context.Context, id string, lock bool) (domain.CashAccount, error)
	SaveAccount(ctx context.Context, a domain.CashAccount) error

	Categories(ctx context.Context) ([]domain.Category, error)
	Category(ctx context.Context, id string) (domain.Category, error)
	SaveCategory(ctx context.Context, c domain.Category) error

	Transactions(ctx context.Context) ([]domain.Transaction, error)
	Transaction(ctx context.Context, id string) (domain.Transaction, error)
	Transfer(ctx context.Context, transferID string) ([]domain.Transaction, error)
	BySource(ctx context.Context, src Source) ([]domain.Transaction, error)
	SourceOf(ctx context.Context, transactionID string) (*Source, error)
	InsertTransaction(ctx context.Context, t *domain.Transaction, src *Source) error
	UpdateTransaction(ctx context.Context, t *domain.Transaction) error
	Link(ctx context.Context, transactionID string) (*domain.EntryLink, error)
	SaveLink(ctx context.Context, l domain.EntryLink) error
	Payroll(ctx context.Context, transactionID string) (*domain.PayrollTotals, error)
	SavePayroll(ctx context.Context, transactionID string, p domain.PayrollTotals) error

	Reconciliations(ctx context.Context) ([]domain.Reconciliation, error)
	InsertReconciliation(ctx context.Context, r domain.Reconciliation) error

	Rules(ctx context.Context) ([]domain.ApprovalRule, error)
	Rule(ctx context.Context, id string) (domain.ApprovalRule, error)
	SaveRule(ctx context.Context, r domain.ApprovalRule) error
	DeleteRule(ctx context.Context, id string) error

	Setting(ctx context.Context, key string, v any) (bool, error)
	LockSetting(ctx context.Context, key string, def any) error
	SaveSetting(ctx context.Context, key string, v any) error

	Codes(ctx context.Context) ([]domain.TransactionCode, error)
	SaveCode(ctx context.Context, c domain.TransactionCode) error

	Journals(ctx context.Context) ([]domain.JournalEntry, error)
	JournalsOf(ctx context.Context, source, sourceID string) ([]domain.JournalEntry, error)
	InsertJournal(ctx context.Context, e domain.JournalEntry) error
	DepositsHeld(ctx context.Context, bookingID string) (int64, error)

	ManualJournals(ctx context.Context) ([]domain.ManualJournal, error)
	ManualJournal(ctx context.Context, id string) (domain.ManualJournal, error)
	SaveManualJournal(ctx context.Context, m *domain.ManualJournal) error

	LockPeriods(ctx context.Context) error
	PeriodCloses(ctx context.Context) ([]domain.PeriodClose, error)
	ClosedMonths(ctx context.Context) ([]string, error)
	InsertClose(ctx context.Context, c domain.PeriodClose) error
	DeleteClose(ctx context.Context, month string) error

	Budgets(ctx context.Context) ([]domain.Budget, error)
	SaveBudget(ctx context.Context, b domain.Budget) (bool, error)

	SavePayrollCost(ctx context.Context, month, villaID string, amount int64) error
	PayrollCost(ctx context.Context, month, villaID string) (int64, error)

	// SaveRef keys a record finance made by the id of the fact another context published.
	SaveRef(ctx context.Context, ref, kind, id string) error
	Ref(ctx context.Context, ref string) (kind, id string, ok bool, err error)

	Stays(ctx context.Context, ids []string) (map[string]domain.Stay, error)
	SaveStay(ctx context.Context, s domain.Stay) error
	Places(ctx context.Context) (domain.Places, error)
}

// Files resolves uploaded files by id. The files context owns uploads; in a process that reaches no
// files service, a call that sends only ids answers NOT_AVAILABLE.
type Files interface {
	Attachments(ctx context.Context, ids []string) ([]domain.Attachment, error)
}

// Deps is what every finance command needs.
type Deps struct {
	DB    *db.DB
	Repo  Repository
	Authz rbac.Authorizer
	Audit audit.Recorder
	Clock clock.Clock
	Files Files
}

// Permission sets, from the application services' allow() calls.
var (
	financeCreate   = []rbac.Need{{Module: "finance", Action: "create"}}
	financeEdit     = []rbac.Need{{Module: "finance", Action: "edit"}}
	financeSubmit   = []rbac.Need{{Module: "finance", Action: "submit"}}
	financePost     = []rbac.Need{{Module: "finance", Action: "post"}}
	approvalApprove = []rbac.Need{{Module: "approval", Action: "approve"}}
	approvalCreate  = []rbac.Need{{Module: "approval", Action: "create"}}
	approvalEdit    = []rbac.Need{{Module: "approval", Action: "edit"}}
	masterCreate    = []rbac.Need{{Module: "master", Action: "create"}}
	masterEdit      = []rbac.Need{{Module: "master", Action: "edit"}}
)

// Setting keys in finance.settings.
const (
	KeyProof      = "proof_policy"
	KeyTax        = "tax"
	KeyCategories = "category_accounts"
)

// Signer is who acts.
func Signer(p auth.Principal) domain.Signer {
	return domain.Signer{ID: p.UserID, Name: p.Name, Role: string(p.Role)}
}

// System signs entries another context asked for without naming who.
var System = domain.Signer{ID: "system", Name: "System", Role: "admin"}

func (d Deps) today() string { return clock.Today(d.Clock) }

func (d Deps) record(ctx context.Context, by domain.Signer, l audit.Line) error {
	return d.Audit.Record(ctx, audit.Actor{ID: by.ID, Name: by.Name, Role: by.Role}, l)
}

func (d Deps) emit(ctx context.Context, eventType, aggregateType, aggregateID string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: aggregateID, AggregateVersion: version, Payload: payload})
}

func (d Deps) require(ctx context.Context, p auth.Principal, needs []rbac.Need) error {
	return d.Authz.Require(ctx, p.Role, needs...)
}

func (d Deps) can(ctx context.Context, role rbac.Role, m rbac.Module, a rbac.Action) (bool, error) {
	perms, err := d.Authz.Source.Permissions(ctx)
	if err != nil {
		return false, err
	}
	return rbac.Can(perms, role, m, a), nil
}

// ProofPolicy reads the receipt rule.
func (d Deps) ProofPolicy(ctx context.Context) (domain.ProofPolicy, error) {
	p := domain.DefaultProofPolicy
	_, err := d.Repo.Setting(ctx, KeyProof, &p)
	return p, err
}

// Tax reads the tax settings.
func (d Deps) Tax(ctx context.Context) (domain.TaxSettings, error) {
	t := domain.TaxSettings{DirectMode: "net", Regencies: map[string]string{}}
	_, err := d.Repo.Setting(ctx, KeyTax, &t)
	return t, err
}

// CategoryMap reads the category to GL account mapping.
func (d Deps) CategoryMap(ctx context.Context) (map[string]string, error) {
	m := map[string]string{}
	_, err := d.Repo.Setting(ctx, KeyCategories, &m)
	return m, err
}

func (d Deps) scope(ctx context.Context, p auth.Principal) (domain.Scope, error) {
	places, err := d.Repo.Places(ctx)
	return domain.Scope{Scope: p.Scope(), Places: places}, err
}

// assertOpen refuses a date in a closed month.
func (d Deps) assertOpen(ctx context.Context, date string) error {
	closed, err := d.Repo.ClosedMonths(ctx)
	if err != nil {
		return err
	}
	return domain.AssertOpenPeriod(closed, date)
}

// writeJournal numbers a draft and stores it, posted today by the signer; it returns the entry.
func (d Deps) writeJournal(ctx context.Context, draft *domain.JournalEntry, by domain.Signer) (*domain.JournalEntry, error) {
	if draft == nil {
		return nil, nil
	}
	n, err := d.Repo.Next(ctx, "journal")
	if err != nil {
		return nil, err
	}
	e := draft.Numbered(n, d.today(), by.Name)
	return &e, d.Repo.InsertJournal(ctx, e)
}

// writeOnce writes a draft unless the record already wrote an entry from the same source.
func (d Deps) writeOnce(ctx context.Context, draft *domain.JournalEntry, by domain.Signer) error {
	if draft == nil {
		return nil
	}
	have, err := d.Repo.JournalsOf(ctx, draft.Source, draft.SourceID)
	if err != nil || len(have) > 0 {
		return err
	}
	_, err = d.writeJournal(ctx, draft, by)
	return err
}

func outside(what string) error {
	return errs.Forbidden(fmt.Sprintf("This %s belongs to a villa outside your access.", what))
}
