package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/channel"
	"github.com/syabanf/wit-hospitality/api/internal/channel/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
	"github.com/syabanf/wit-hospitality/api/internal/platform/ids"
)

type accountAudit struct {
	Name   string `json:"name"`
	Email  string `json:"email"`
	Status string `json:"status"`
}

func accountAuditOf(a domain.Account) accountAudit {
	return accountAudit{Name: a.Name, Email: a.Email, Status: a.Status}
}

// CreateAccount adds an Airbnb host account; it needs airbnb/create. Host accounts span villas,
// so no villa scope applies.
type CreateAccount struct{ Deps }

// Handle creates the account.
func (h CreateAccount) Handle(ctx context.Context, p auth.Principal, in domain.AccountInput) (domain.Account, error) {
	if err := h.Authz.Require(ctx, p.Role, airbnbCreate...); err != nil {
		return domain.Account{}, err
	}
	var a domain.Account
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.AccountNameTaken(ctx, in.Name, "")
		if err != nil {
			return err
		}
		if err := domain.ValidateAccount(in, taken); err != nil {
			return err
		}
		n, err := h.Repo.CountAccounts(ctx)
		if err != nil {
			return err
		}
		a = domain.NewAccount(ids.New("acc", in.Name), in, n)
		if err := h.Repo.InsertAccount(ctx, &a); err != nil {
			return err
		}
		if err := h.accountEvent(ctx, channel.EventAccountCreated, a); err != nil {
			return err
		}
		return h.record(ctx, actorOf(p), audit.Line{Action: audit.Create, Entity: "airbnb_account", EntityID: a.ID, Summary: fmt.Sprintf("Added the Airbnb account %s", a.Name)})
	})
	return a, err
}

// UpdateAccount edits a host account; it needs airbnb/edit.
type UpdateAccount struct{ Deps }

// Handle edits the account.
func (h UpdateAccount) Handle(ctx context.Context, p auth.Principal, id string, in domain.AccountInput) (domain.Account, error) {
	if err := h.Authz.Require(ctx, p.Role, airbnbEdit...); err != nil {
		return domain.Account{}, err
	}
	var a domain.Account
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		taken, err := h.Repo.AccountNameTaken(ctx, in.Name, id)
		if err != nil {
			return err
		}
		if err := domain.ValidateAccount(in, taken); err != nil {
			return err
		}
		if a, err = h.Repo.Account(ctx, id); err != nil {
			return err
		}
		before := accountAuditOf(a)
		a.Apply(in)
		if err := h.Repo.UpdateAccount(ctx, &a); err != nil {
			return err
		}
		if err := h.accountEvent(ctx, channel.EventAccountUpdated, a); err != nil {
			return err
		}
		return h.record(ctx, actorOf(p), audit.Line{Action: audit.Update, Entity: "airbnb_account", EntityID: a.ID, Summary: fmt.Sprintf("Edited the Airbnb account %s", a.Name), Before: before, After: accountAuditOf(a)})
	})
	return a, err
}
