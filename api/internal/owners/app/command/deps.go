// Package command holds the owners context's write side. Each handler checks the permission and
// villa scope, takes the owners lock, applies the domain rules, saves with a version check, and
// appends its events and audit line in one transaction.
package command

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/clock"
	"github.com/syabanf/wit-hospitality/api/internal/platform/db"
	"github.com/syabanf/wit-hospitality/api/internal/platform/errs"
	"github.com/syabanf/wit-hospitality/api/internal/platform/outbox"
	"github.com/syabanf/wit-hospitality/api/internal/platform/rbac"
)

// Repository is the owners schema. Single loads lock the row for the transaction.
type Repository interface {
	Lock(ctx context.Context) error
	Next(ctx context.Context, key string) (int64, error)

	Owners(ctx context.Context) ([]domain.VillaOwner, error)
	Owner(ctx context.Context, id string) (domain.VillaOwner, error)
	InsertOwner(ctx context.Context, o *domain.VillaOwner) error
	UpdateOwner(ctx context.Context, o *domain.VillaOwner) error

	Contracts(ctx context.Context) ([]domain.Contract, error)
	Contract(ctx context.Context, id string) (domain.Contract, error)
	InsertContract(ctx context.Context, c *domain.Contract) error
	UpdateContract(ctx context.Context, c *domain.Contract) error

	Statements(ctx context.Context) ([]domain.Statement, error)
	Statement(ctx context.Context, id string) (domain.Statement, error)
	StatementByPayout(ctx context.Context, ref, transactionID string) (domain.Statement, bool, error)
	InsertStatement(ctx context.Context, st *domain.Statement) error
	UpdateStatement(ctx context.Context, st *domain.Statement) error
	DeleteStatement(ctx context.Context, id string) error

	StayRequests(ctx context.Context) ([]domain.StayRequest, error)
	StayRequest(ctx context.Context, id string) (domain.StayRequest, error)
	InsertStay(ctx context.Context, r *domain.StayRequest) error
	UpdateStay(ctx context.Context, r *domain.StayRequest) error

	Villa(ctx context.Context, id string) (domain.Villa, error)
	Unit(ctx context.Context, id string) (domain.Unit, error)
	Units(ctx context.Context) ([]domain.Unit, error)
	Blocks(ctx context.Context) ([]domain.Block, error)
	Holder(ctx context.Context, unitID, from, to string) (domain.Holder, bool, error)
}

// Deps is what every owners command needs.
type Deps struct {
	DB      *db.DB
	Repo    Repository
	Results owners.Results
	Authz   rbac.Authorizer
	Audit   audit.Recorder
	Clock   clock.Clock
}

// Permission sets, from the allow() calls in src/application/owners.ts.
var (
	financePost    = []rbac.Need{{Module: "finance", Action: "post"}}
	financeApprove = []rbac.Need{{Module: "finance", Action: "approve"}}
	bookingApprove = []rbac.Need{{Module: "booking", Action: "approve"}}
	portalCreate   = []rbac.Need{{Module: "portal", Action: "create"}}
)

const investor = "investor"

// assertOperator is the mock's assertOperator: a villa owner never acts for the operator.
func assertOperator(p auth.Principal, action string) error {
	if p.Role == investor {
		return errs.Forbidden("A villa owner cannot " + action + ".")
	}
	return nil
}

func inScope(p auth.Principal, v domain.Villa) error {
	if p.Scope().AllowedVilla(v.ID, v.LocationID) {
		return nil
	}
	return errs.Forbidden(fmt.Sprintf("%s is outside the villas you work with.", v.Name))
}

func (d Deps) record(ctx context.Context, p auth.Principal, l audit.Line) error {
	return d.Audit.Record(ctx, audit.Actor{ID: p.UserID, Name: p.Name, Role: string(p.Role)}, l)
}

func (d Deps) today() string { return clock.Today(d.Clock) }

func (d Deps) emit(ctx context.Context, eventType, aggregateType, aggregateID string, version int64, payload any) error {
	return outbox.Append(ctx, d.DB.Q(ctx), d.Clock.Now(), outbox.Event{Type: eventType, AggregateType: aggregateType, AggregateID: aggregateID, AggregateVersion: version, Payload: payload})
}

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return raw
}

// OwnedBy is the owner record behind an investor login: nil and true for an investor without one,
// nil and false for operator staff.
func OwnedBy(list []domain.VillaOwner, p auth.Principal) (*domain.VillaOwner, bool) {
	if p.Role != investor {
		return nil, false
	}
	for i := range list {
		if list[i].UserID != nil && *list[i].UserID == p.UserID {
			return &list[i], true
		}
	}
	return nil, true
}

// Draft is a contract's month from the books: the figures a close would write, the settlement
// against the month before, and the villa's entries still waiting.
type Draft struct {
	domain.Draft
	Settlement domain.Settlement
	Pending    int
}

// draft reads finance's villa results and owners' owner blocks for the month.
func (d Deps) draft(ctx context.Context, c domain.Contract, month string, statements []domain.Statement) (Draft, error) {
	res, err := d.Results.VillaResults(ctx, c.VillaID, month)
	if err != nil {
		return Draft{}, err
	}
	units, err := d.Repo.Units(ctx)
	if err != nil {
		return Draft{}, err
	}
	blocks, err := d.Repo.Blocks(ctx)
	if err != nil {
		return Draft{}, err
	}
	mine := map[string]bool{}
	for _, u := range units {
		if u.VillaID == c.VillaID {
			mine[u.ID] = true
		}
	}
	books := domain.Books{Payroll: res.Payroll}
	books.OwnerNights, books.OwnerStays = domain.OwnerNightsIn(blocks, mine, month+"-01", clock.AddDays(domain.MonthEnd(month), 1))
	for _, s := range res.Stays {
		books.Stays = append(books.Stays, domain.StatementStay(s))
	}
	for _, e := range res.Entries {
		books.Entries = append(books.Entries, domain.BookEntry{
			StatementEntry: domain.StatementEntry{TransactionID: e.TransactionID, Number: e.Number, Date: e.Date, Description: e.Description, Category: e.Category, Role: e.Role, Amount: e.Amount},
			CategoryID:     e.CategoryID, Origin: e.Origin,
		})
	}
	dr := domain.StatementDraft(c.ContractInput, books)
	return Draft{Draft: dr, Settlement: domain.Settle(dr.Figures.NetPayable, domain.PreviousStatement(statements, c.ID, month)), Pending: res.Pending}, nil
}
