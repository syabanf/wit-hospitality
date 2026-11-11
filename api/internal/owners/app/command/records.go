package command

import (
	"context"
	"fmt"

	"github.com/syabanf/wit-hospitality/api/internal/owners"
	"github.com/syabanf/wit-hospitality/api/internal/owners/domain"
	"github.com/syabanf/wit-hospitality/api/internal/platform/audit"
	"github.com/syabanf/wit-hospitality/api/internal/platform/auth"
)

// SaveOwner adds a villa owner (id empty) or edits one; it needs finance/post.
type SaveOwner struct{ Deps }

// Handle saves the owner.
func (h SaveOwner) Handle(ctx context.Context, p auth.Principal, id string, in domain.OwnerInput) (domain.VillaOwner, error) {
	if err := h.Authz.Require(ctx, p.Role, financePost...); err != nil {
		return domain.VillaOwner{}, err
	}
	verb := "add owners"
	if id != "" {
		verb = "edit owners"
	}
	if err := assertOperator(p, verb); err != nil {
		return domain.VillaOwner{}, err
	}
	clean, err := domain.CleanOwner(in)
	if err != nil {
		return domain.VillaOwner{}, err
	}
	var o domain.VillaOwner
	err = h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.Lock(ctx); err != nil {
			return err
		}
		if id == "" {
			n, err := h.Repo.Next(ctx, "villaOwner")
			if err != nil {
				return err
			}
			o = domain.VillaOwner{ID: fmt.Sprintf("own-%d", n), OwnerInput: clean}
			if err := h.Repo.InsertOwner(ctx, &o); err != nil {
				return err
			}
			if err := h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "villa-owner", EntityID: o.ID, Summary: "Added villa owner " + o.Name}); err != nil {
				return err
			}
		} else {
			if o, err = h.Repo.Owner(ctx, id); err != nil {
				return err
			}
			before := map[string]any{"bank": o.Bank.AccountNumber, "email": o.Email}
			o.OwnerInput = clean
			if err := h.Repo.UpdateOwner(ctx, &o); err != nil {
				return err
			}
			after := map[string]any{"bank": o.Bank.AccountNumber, "email": o.Email}
			if err := h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "villa-owner", EntityID: id, Summary: "Edited villa owner " + o.Name, Before: before, After: after}); err != nil {
				return err
			}
		}
		return h.emit(ctx, owners.EventOwnerSaved, "villa_owner", o.ID, o.Version, owners.OwnerSaved{Owner: mustJSON(o)})
	})
	return o, err
}

// SaveContract adds a management contract (id empty) or edits one; it needs finance/post. Closed
// statements keep the figures they closed with.
type SaveContract struct{ Deps }

// Handle saves the contract.
func (h SaveContract) Handle(ctx context.Context, p auth.Principal, id string, in domain.ContractInput) (domain.Contract, error) {
	if err := h.Authz.Require(ctx, p.Role, financePost...); err != nil {
		return domain.Contract{}, err
	}
	verb := "add contracts"
	if id != "" {
		verb = "edit contracts"
	}
	if err := assertOperator(p, verb); err != nil {
		return domain.Contract{}, err
	}
	var c domain.Contract
	err := h.DB.InTx(ctx, func(ctx context.Context) error {
		if err := h.Repo.Lock(ctx); err != nil {
			return err
		}
		all, err := h.Repo.Contracts(ctx)
		if err != nil {
			return err
		}
		if err := domain.ValidateContract(in, all, id); err != nil {
			return err
		}
		villa, err := h.Repo.Villa(ctx, in.VillaID)
		if err != nil {
			return err
		}
		if err := inScope(p, villa); err != nil {
			return err
		}
		if _, err := h.Repo.Owner(ctx, in.OwnerID); err != nil {
			return err
		}
		terms := func(c domain.Contract) map[string]any {
			return map[string]any{"feeBasis": c.FeeBasis, "feePct": c.FeePct, "charged": c.Charged, "reservePct": c.ReservePct}
		}
		if id == "" {
			n, err := h.Repo.Next(ctx, "contract")
			if err != nil {
				return err
			}
			today := h.today()
			c = domain.Contract{ContractInput: in, ID: fmt.Sprintf("ct-%d", n), Number: fmt.Sprintf("MC-%s-%02d", today[:4], n), CreatedOn: today}
			if err := h.Repo.InsertContract(ctx, &c); err != nil {
				return err
			}
			if err := h.record(ctx, p, audit.Line{Action: audit.Create, Entity: "contract", EntityID: c.Number, Summary: fmt.Sprintf("Added contract %s for %s", c.Number, villa.Name),
				After: map[string]any{"feeBasis": c.FeeBasis, "feePct": c.FeePct}}); err != nil {
				return err
			}
		} else {
			if c, err = h.Repo.Contract(ctx, id); err != nil {
				return err
			}
			before := terms(c)
			c.ContractInput = in
			if err := h.Repo.UpdateContract(ctx, &c); err != nil {
				return err
			}
			if err := h.record(ctx, p, audit.Line{Action: audit.Update, Entity: "contract", EntityID: c.Number,
				Summary: fmt.Sprintf("Edited contract %s; closed statements keep their figures", c.Number), Before: before, After: terms(c)}); err != nil {
				return err
			}
		}
		return h.emit(ctx, owners.EventContractSaved, "contract", c.ID, c.Version, owners.ContractSaved{Contract: mustJSON(c), VillaID: villa.ID, LocationID: villa.LocationID})
	})
	return c, err
}
